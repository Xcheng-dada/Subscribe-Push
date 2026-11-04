/**
 * B站动态增量探测
 *
 * 增量探测流程：
 *
 *   首轮  feed/all            → 存 update_baseline + 记录所有 id_str → 不推送
 *   之后  feed/all/update     → 看 update_num
 *           ├ == 0 且未到兜底周期 → 直接返回（只下了一个几百字节的小响应）
 *           └ >  0 或到兜底周期   → feed/all → 过滤已见 id_str → 推送
 *
 * 失败按 1/2/4/8/15 分钟退避，且**不推进基线**——这点很重要，
 * 否则一次网络抖动就会永久漏掉那段时间的动态。
 */

import { getSubs, getMeta, setMeta, updateSubName } from './store.js'
import { reportHealth } from './alert.js'

const PATH_FEED_ALL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all'
const PATH_FEED_UPDATE = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all/update'
const ORIGIN = 'https://t.bilibili.com'

const DEFAULTS = {
  probeInterval: 10,
  jitter: 0,
  reconcileInterval: 60,
  maxBackoff: 15 * 60,
  seenLimit: 5000,
  minBackoff: 60,
  backoffCap: 15 * 60
}

/** Chrome 143 UA */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const SEC_CH_UA = '"Google Chrome";v="143", "Chromium";v="143", "Not_A Brand";v="24"'

/**
 * 这几个头缺一个都可能 412，别随意精简。
 */
function buildHeaders (cookie = '') {
  const h = {
    'User-Agent': UA,
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    Origin: ORIGIN,
    Referer: ORIGIN + '/',
    'x-bili-device-req-json': JSON.stringify({ platform: 'web', device: 'pc' }),
    'x-bili-locale-json': JSON.stringify({ clocale: 'zh-CN', tlocale: 'zh-CN' })
  }
  if (cookie) h.Cookie = cookie
  return h
}

async function fetchFeed (offset = '', cookie = '') {
  const url = new URL(PATH_FEED_ALL)
  if (offset) url.searchParams.set('offset', offset)
  const res = await fetch(url, {
    headers: buildHeaders(cookie),
    signal: AbortSignal.timeout(15000)
  })
  const json = await res.json().catch(() => null)
  if (!json) throw new Error('B站动态API返回空响应')
  if (json.code !== 0) throw new Error(`B站动态API返回 ${json.code}: ${json.message || ''}`)
  return json
}

/**
 * 增量探测
 * 返回值只有 update_num 一个字段，不再回传基线。
 */
async function probeUpdate (baseline, cookie = '') {
  const url = new URL(PATH_FEED_UPDATE)
  url.searchParams.set('update_baseline', baseline)
  url.searchParams.set('type', 'all')
  const res = await fetch(url, {
    headers: buildHeaders(cookie),
    signal: AbortSignal.timeout(15000)
  })
  const json = await res.json().catch(() => null)
  if (!json) throw new Error('B站动态增量探测返回空响应')
  if (json.code !== 0) throw new Error(`B站动态增量探测返回 ${json.code}: ${json.message || ''}`)
  return json
}

export class BiliDynamicPoller {
  constructor ({ onNotify, getCookie } = {}) {
    this.onNotify = onNotify
    this.getCookie = getCookie || defaultCookie

    this.baseline = ''
    this.initialized = false
    this.seen = new Map()
    this.seenSeq = 0
    this.lastFeedAt = 0
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

  nextDelay () {
    const d = this.nextRun - Date.now()
    return d < 0 ? 0 : d
  }

  schedule () {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.pollOnce().catch(e => logger.error('[订阅推送] B站动态轮询异常', e))
    }, this.nextDelay())
    if (this.timer.unref) this.timer.unref()
  }

  async pollOnce () {
    const cookie = await this.getCookie()

    // ---- 首轮：只建立基线，不推送历史 ----
    if (!this.initialized) {
      let feed
      try {
        feed = await fetchFeed('', cookie)
      } catch (err) {
        this.scheduleFailure(err)
        return this.schedule()
      }
      const baseline = feed?.data?.update_baseline || ''
      if (!baseline) {
        this.scheduleFailure(new Error('B站动态完整列表未返回 update_baseline'))
        return this.schedule()
      }
      this.baseline = baseline
      for (const item of feed.data.items || []) this.remember(item.id_str, item)
      this.initialized = true
      this.lastFeedAt = Date.now()
      this.scheduleSuccess()
      logger.mark(`[订阅推送] B站动态基线建立完成（${(feed.data.items || []).length} 条，不推送历史）`)
      return this.schedule()
    }

    // ---- 增量探测 ----
    let update
    try {
      update = await probeUpdate(this.baseline, cookie)
    } catch (err) {
      this.scheduleFailure(err)
      return this.schedule()
    }

    const updateNum = Number(update?.data?.update_num || 0)
    const reconcileDue = this.lastFeedAt > 0 &&
      Date.now() - this.lastFeedAt >= this.cfg.reconcileInterval * 1000

    if (updateNum === 0 && !reconcileDue) {
      this.scheduleSuccess()
      return this.schedule()
    }

    const trigger = updateNum > 0 ? 'increment' : 'reconcile'

    // ---- 拉完整列表并过滤 ----
    let feed
    try {
      feed = await fetchFeed('', cookie)
    } catch (err) {
      this.scheduleFailure(err)
      return this.schedule()
    }

    const newBaseline = feed?.data?.update_baseline || ''
    if (!newBaseline) {
      this.scheduleFailure(new Error('B站动态完整列表未返回 update_baseline'))
      return this.schedule()
    }

    const items = feed.data.items || []
    const unseen = []
    for (const item of items) {
      if (!item?.id_str) continue
      if (this.seen.has(item.id_str)) continue
      unseen.push(item)
    }

    this.baseline = newBaseline
    for (const item of unseen) this.remember(item.id_str, item)
    this.lastFeedAt = Date.now()
    this.scheduleSuccess()

    if (unseen.length) {
      logger.mark(`[订阅推送] B站动态发现 ${unseen.length} 条新动态（触发：${trigger}）`)
      try {
        await this.onNotify({
          site: 'bilibili',
          type: 'news',
          items: unseen,
          trigger
        })
      } catch (err) {
        logger.error('[订阅推送] B站动态推送失败', err)
      }
    }
    return this.schedule()
  }

  /**
   * 记录已见 id
   * 用 Map 的插入顺序天然做 FIFO 淘汰，比数组 shift 更快。
   */
  remember (idStr, item) {
    if (!idStr || this.seen.has(idStr)) return
    this.seen.set(idStr, ++this.seenSeq)
    const uid = item?.modules?.module_author?.mid
    const name = item?.modules?.module_author?.name
    if (uid && name) updateSubName('bilibili', 'news', String(uid), name).catch(() => {})

    while (this.seen.size > this.cfg.seenLimit) {
      const oldest = this.seen.keys().next().value
      this.seen.delete(oldest)
    }
  }

  scheduleSuccess () {
    let delay = this.cfg.probeInterval * 1000
    if (this.cfg.jitter > 0) {
      delay += Math.floor(Math.random() * this.cfg.jitter * 1000)
    }
    this.nextRun = Date.now() + delay
    this.failures = 0
    // 成功时上报，故障恢复会私聊通知主人
    reportHealth('bilibili', '动态', true).catch(() => {})
  }

  /**
   * 失败：保留原基线，1/2/4/8/15 分钟退避
   */
  scheduleFailure (err) {
    this.failures++

    // -101 账号未登录 / -352 风控 都是确定性失败，重试没用，
    // 直接拉到最长间隔，等 Cookie 更新后自然恢复。
    const fatal = /-101|-352|未登录|风控/.test(String(err?.message || ''))

    const backoff = fatal
      ? this.cfg.maxBackoff
      : Math.min(
        2 ** (this.failures - 1) * this.cfg.minBackoff,
        this.cfg.backoffCap,
        this.cfg.maxBackoff
      )

    this.nextRun = Date.now() + backoff * 1000
    logger.warn(
      `[订阅推送] B站动态刷新失败（连续 ${this.failures} 次，${Math.round(backoff)}s 后重试，基线已保留）` +
      `${fatal ? '，登录态可能已失效' : ''}：${err?.message || err}`
    )
    // Cookie 失效这类问题不会自愈，私聊告诉主人
    reportHealth('bilibili', '动态', false, err?.message || String(err)).catch(() => {})
  }
}

/**
 * 默认从渲染层的 Cookie 读取链路取（CookieCloud / 本地文件）
 *
 * 坑：cookies.js 在模块加载时**异步**触发 CookieCloud 拉取，
 * 加载后立刻调用 BILI_COOKIE() 会拿到空串，导致第一轮探测直接 -101。
 *
 * 而且开机时 CookieCloud 服务经常还没起来，第一次拉取就失败。
 * 原来的写法是「等 8 秒，不管成没成，之后都不再等」，结果一旦首次失败，
 * 后面每轮都拿空 Cookie 一直报 -101，直到 5 分钟后的定时刷新才恢复。
 *
 * 现在改成：**只要还拿不到 Cookie 就每次都等**，并且主动催一次刷新。
 */
let cookieWarmed = false

async function defaultCookie () {
  const mod = await import('./render/cookies.js')

  // 已经有 Cookie 了，直接返回（正常的稳态路径）
  const ready = mod.BILI_COOKIE && mod.BILI_COOKIE()
  if (ready) {
    cookieWarmed = true
    return ready
  }

  // 拿不到：先催一次立即刷新，再等一会儿
  try {
    await mod.refreshCookiesNow?.()
  } catch {}

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const now = mod.BILI_COOKIE && mod.BILI_COOKIE()
    if (now) {
      cookieWarmed = true
      return now
    }
    await new Promise(r => setTimeout(r, 300))
  }

  cookieWarmed = true
  try {
    return mod.BILI_COOKIE() || ''
  } catch {
    return ''
  }
}

export default BiliDynamicPoller
