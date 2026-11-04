/**
 * 微博动态轮询
 *
 * 用 weibo.com 的登录态接口：
 *   GET https://weibo.com/ajax/statuses/mymblog?uid=<uid>&page=1&feature=0
 *
 * 微博没有 B站 那种增量探测接口，只能每轮拉第一页、按 mblog.id 去重。
 * 好处是第一页只有 10~20 条，响应不大；代价是新增 > 20 条时会漏中间部分，
 * 实际场景里基本不会发生（除非订阅的是高频营销号）。
 */

import { getSubs, getMeta, setMeta, updateSubName } from './store.js'
import { reportHealth } from './alert.js'

const PATH_MYMBLOG = 'https://weibo.com/ajax/statuses/mymblog'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const DEFAULTS = {
  probeInterval: 120,
  maxBackoff: 15 * 60,
  minBackoff: 60,
  backoffCap: 15 * 60,
  maxPerRound: 3
}

export class WeiboPoller {
  constructor ({ onNotify, getCookie } = {}) {
    this.onNotify = onNotify
    this.getCookie = getCookie || defaultCookie
    this.failures = 0
    this.nextRun = 0
    this.stopped = false
    this.timer = null
    this.cfg = { ...DEFAULTS }
  }

  configure (partial = {}) {
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined && v !== null && v !== '') this.cfg[k] = v
    }
  }

  async start () {
    this.stopped = false
    this.nextRun = Date.now()
    this.schedule()
  }

  stop () {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  schedule () {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(0, this.nextRun - Date.now())
    this.timer = setTimeout(() => {
      this.pollOnce().catch(e => logger.error('[订阅推送] 微博轮询异常', e))
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  async pollOnce () {
    const subs = await getSubs('weibo', 'news')
    const uids = Object.keys(subs)
    if (!uids.length) {
      this.nextRun = Date.now() + this.cfg.probeInterval * 1000
      return this.schedule()
    }

    const cookie = await this.getCookie()
    if (!cookie) {
      logger.warn('[订阅推送] 微博未配置 Cookie，跳过本轮轮询')
      reportHealth('weibo', '动态', false, '未配置 Cookie').catch(() => {})
      this.nextRun = Date.now() + this.cfg.probeInterval * 1000
      return this.schedule()
    }

    const meta = await getMeta('weibo', 'news')
    let anyError = null

    for (const uid of uids) {
      let blogs
      try {
        blogs = await this.fetchBlogs(uid, cookie)
      } catch (err) {
        anyError = err
        continue
      }

      // 关键：微博接口返回的第一页**置顶优先**，list[0] 可能是几年前的置顶博。
      // 直接拿 list[0] 当「最新」会导致：基线记成旧博 → 每轮都认为后面的是新的
      // → 无限重复推送历史微博。
      // 所以必须按 created_at 挑出真正最新的那条当基线。
      const sorted = sortByCreatedAtDesc(blogs)
      const newest = sorted[0]
      const newestId = newest ? mblogIdOf(newest) : ''
      if (!newestId) continue

      const prev = meta[uid] || {}
      const lastId = prev.lastId

      // 首次见到这个博主：记基线，不推送
      if (!lastId) {
        await setMeta('weibo', 'news', uid, {
          lastId: newestId,
          name: newest?.user?.screen_name || ''
        })
        if (newest?.user?.screen_name) updateSubName('weibo', 'news', uid, newest.user.screen_name).catch(() => {})
        continue
      }

      // 按时间倒序，取比 lastId 更新的那些（遇到 lastId 就停）
      const fresh = []
      for (const b of sorted) {
        const id = mblogIdOf(b)
        if (!id || id === lastId) break
        fresh.push(b)
        if (fresh.length >= this.cfg.maxPerRound) break
      }

      if (!fresh.length) {
        // 没有新内容，但可能上次记的 lastId 落后了（比如置顶博当时排第一），
        // 这里顺手把基线推进到真正最新的一条，避免后面反复扫旧数据。
        if (newestId !== lastId) {
          await setMeta('weibo', 'news', uid, {
            lastId: newestId,
            name: newest?.user?.screen_name || prev.name || ''
          })
        }
        continue
      }

      await setMeta('weibo', 'news', uid, {
        lastId: newestId,
        name: newest?.user?.screen_name || ''
      })
      if (newest?.user?.screen_name) updateSubName('weibo', 'news', uid, newest.user.screen_name).catch(() => {})

      try {
        await this.onNotify({ site: 'weibo', type: 'news', uid, blogs: fresh })
      } catch (err) {
        logger.error('[订阅推送] 微博推送失败', err)
      }
    }

    if (anyError) {
      this.scheduleFailure(anyError)
      // 登录态失效（ok=-100）不会自愈，私聊告诉主人
      reportHealth('weibo', '动态', false, anyError?.message || String(anyError)).catch(() => {})
    } else {
      this.failures = 0
      this.nextRun = Date.now() + this.cfg.probeInterval * 1000
      reportHealth('weibo', '动态', true).catch(() => {})
    }
    return this.schedule()
  }

  async fetchBlogs (uid, cookie) {
    const url = new URL(PATH_MYMBLOG)
    url.searchParams.set('uid', uid)
    url.searchParams.set('page', '1')
    url.searchParams.set('feature', '0')

    // 微博的 ajax 接口要求 X-XSRF-TOKEN 头，值取自 Cookie 里的 XSRF-TOKEN。
    // 缺少时服务端直接返回 ok=-100（跳登录页），即使 SUB 完全有效。
    const xsrf = extractCookieValue(cookie, 'XSRF-TOKEN')

    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Cookie: cookie,
        Referer: `https://weibo.com/u/${uid}`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
        ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {})
      },
      signal: AbortSignal.timeout(15000)
    })

    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('微博返回非 JSON（可能登录态失效或触发风控）')
    }

    if (json.ok !== 1 && !json.data) {
      throw new Error(`微博接口异常：${json.message || 'ok=' + json.ok}`)
    }
    return json?.data?.list || []
  }

  scheduleFailure (err) {
    this.failures++

    // 登录态失效（ok=-100）是确定性失败：重试一万次也是 -100，
    // 只会把日志刷满。这种情况拉到最长间隔，等 CookieCloud 换了新 Cookie 自然恢复。
    const fatal = /ok=-100|-100|登录/.test(String(err?.message || ''))

    const backoff = fatal
      ? this.cfg.maxBackoff
      : Math.min(
        2 ** (this.failures - 1) * this.cfg.minBackoff,
        this.cfg.backoffCap,
        this.cfg.maxBackoff
      )

    this.nextRun = Date.now() + backoff * 1000
    logger.warn(
      `[订阅推送] 微博刷新失败（连续 ${this.failures} 次，${Math.round(backoff)}s 后重试）` +
      `${fatal ? '，登录态已失效，等待 Cookie 更新' : ''}：${err?.message || err}`
    )
  }
}

/* ================= 工具 ================= */

/** 从 Cookie 字符串里取某个字段的值（取不到返回空串） */
function extractCookieValue (cookie, name) {
  const m = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return m ? m[1] : ''
}

/** 取微博条目的稳定 id（优先 mblogid，其次 id/idstr） */
function mblogIdOf (blog) {
  return blog?.mblogid || String(blog?.id || blog?.idstr || '')
}

/**
 * 按发布时间倒序排列
 *
 * 微博的 created_at 格式：`Sun Mar 19 16:43:15 +0800 2023`
 * Date 能直接解析这种格式，但为了稳妥还是做一次兜底。
 */
function sortByCreatedAtDesc (blogs) {
  const ts = b => {
    const t = Date.parse(b?.created_at || '')
    return Number.isNaN(t) ? 0 : t
  }
  return [...blogs].sort((a, b) => ts(b) - ts(a))
}

/**
 * 从渲染层的 Cookie 链路取微博 Cookie
 *
 * 和 bili-dynamic.js 同样的坑：cookies.js 是模块加载时异步拉取的，
 * 而且开机时 CookieCloud 服务可能还没起来，首次拉取会失败。
 * 所以拿不到时要主动催一次刷新 + 等待，而不是只等一次就放弃。
 */
let cookieWarmed = false

async function defaultCookie () {
  const mod = await import('./render/cookies.js')

  const ready = mod.WEIBO_COOKIE && mod.WEIBO_COOKIE()
  if (ready) {
    cookieWarmed = true
    return ready
  }

  try {
    await mod.refreshCookiesNow?.()
  } catch {}

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const now = mod.WEIBO_COOKIE && mod.WEIBO_COOKIE()
    if (now) {
      cookieWarmed = true
      return now
    }
    await new Promise(r => setTimeout(r, 300))
  }

  cookieWarmed = true
  try {
    return mod.WEIBO_COOKIE() || ''
  } catch {
    return ''
  }
}

export default WeiboPoller
