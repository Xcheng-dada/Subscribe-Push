/**
 * 订阅列表转图
 *
 * 按平台分组 → 按首字母分组 → 每个博主显示头像 + UID + 订阅类型。
 * 出图用 lib/render/shot.js 的 captureHTML，和直播卡/动态卡共用同一个浏览器实例。
 */

import { captureHTML } from './render/shot.js'

const UA_LIST = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** 头像内存缓存（24 小时） */
const avatarCache = new Map()
const AVATAR_TTL = 24 * 3600 * 1000

/**
 * 组装分组数据：平台 → 首字母组 → 用户，组内按名称排序
 *
 * 同一个 UP 订阅了直播+动态时合并成一条，WatchType 显示「直播/动态」。
 */
export function groupSubscriptionData (subs, groupId) {
  const out = {}
  const gid = String(groupId)

  const PLATFORM_NAME = { bilibili: 'Bilibili', weibo: 'Weibo' }
  const TYPE_NAME = { live: '直播', news: '动态' }
  const TYPE_ORDER = ['live', 'news']

  for (const [site, byType] of Object.entries(subs || {})) {
    const merged = new Map()

    for (const type of TYPE_ORDER) {
      const bucket = byType?.[type] || {}
      for (const [uid, rec] of Object.entries(bucket)) {
        if (!Array.isArray(rec.groups) || !rec.groups.includes(gid)) continue

        const key = String(uid)
        if (!merged.has(key)) {
          merged.set(key, { Name: rec.name || key, UID: key, Pic: '', types: new Set() })
        }
        const m = merged.get(key)
        m.types.add(TYPE_NAME[type] || type)
        if ((!m.Name || m.Name === key) && rec.name) m.Name = rec.name
      }
    }

    if (!merged.size) continue

    const ids = [...merged.values()].map(m => ({
      Name: m.Name,
      UID: m.UID,
      Pic: m.Pic,
      WatchType: TYPE_ORDER.map(t => TYPE_NAME[t]).filter(n => m.types.has(n)).join('/')
    }))

    const groups = {}
    for (const item of ids) {
      let group = '#'
      const r = [...String(item.Name)][0]
      if (r && ((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'))) group = r.toUpperCase()
      ;(groups[group] = groups[group] || []).push(item)
    }
    for (const users of Object.values(groups)) {
      users.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0))
    }
    out[PLATFORM_NAME[site] || site] = groups
  }
  return out
}

/** B站头像：web-interface/card 免登录返回 face */
async function fetchBiliFace (uid) {
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(uid)}&photo=false`,
      {
        headers: { 'User-Agent': UA_LIST, Referer: 'https://space.bilibili.com/' },
        signal: AbortSignal.timeout(6000)
      }
    )
    const j = await res.json()
    return String(j?.data?.card?.face || '')
  } catch {
    return ''
  }
}

/** 微博头像：需要 Cookie，cookies.js 是异步拉的，所以先等一会儿 */
let weiboCookieWarmed = false

async function fetchWeiboFace (uid) {
  try {
    const { WEIBO_COOKIE } = await import('./render/cookies.js')

    if (!weiboCookieWarmed) {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (WEIBO_COOKIE()) { weiboCookieWarmed = true; break }
        await new Promise(r => setTimeout(r, 200))
      }
      weiboCookieWarmed = true
    }

    const cookie = WEIBO_COOKIE() || ''
    if (!cookie) return ''

    const res = await fetch(`https://weibo.com/ajax/profile/info?uid=${encodeURIComponent(uid)}`, {
      headers: {
        'User-Agent': UA_LIST,
        Cookie: cookie,
        Referer: `https://weibo.com/u/${uid}`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(8000)
    })
    const j = await res.json()
    const u = j?.data?.user
    return String(u?.avatar_large || u?.profile_image_url || '')
  } catch {
    return ''
  }
}

/**
 * 远程图片 → data URI
 *
 * 微博图床强制校验 Referer，而截图页面是 file:// 加载的、发不出 Referer，
 * 直接写 <img src="https://..."> 必然 403 破图。
 * 所以自己带 Referer 下载，再 base64 内嵌。
 */
async function toDataURI (url, referer) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA_LIST,
        ...(referer ? { Referer: referer } : {}),
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return ''
    let type = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (!type.startsWith('image/')) type = 'image/jpeg'
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/** 补头像（缓存 24h，失败置空走无图样式，不拖慢下次） */
async function enrichAvatars (data) {
  const now = Date.now()
  const jobs = []

  for (const [platform, groups] of Object.entries(data)) {
    const isBili = /bilibili/i.test(platform)
    const isWeibo = /weibo/i.test(platform)
    if (!isBili && !isWeibo) continue

    for (const users of Object.values(groups)) {
      for (const u of users) {
        const key = `${isBili ? 'bilibili' : 'weibo'}:${u.UID}`
        const hit = avatarCache.get(key)
        if (hit && now - hit.ts < AVATAR_TTL) { u.Pic = hit.url; continue }
        if (hit && !hit.url) continue

        jobs.push((async () => {
          const remote = isBili
            ? await fetchBiliFace(u.UID).catch(() => '')
            : await fetchWeiboFace(u.UID).catch(() => '')

          const dataURI = remote
            ? await toDataURI(remote, isBili ? 'https://www.bilibili.com/' : 'https://weibo.com/')
            : ''

          avatarCache.set(key, { url: dataURI, ts: now })
          u.Pic = dataURI
        })())
      }
    }
  }

  await Promise.all(jobs)
}

const escList = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 生成列表 HTML */
export function subscriptionListHTML (data, title = '订阅列表') {
  let body = ''
  for (const p of Object.keys(data).sort()) {
    const groups = data[p]
    const total = Object.values(groups).reduce((n, us) => n + us.length, 0)
    body += `<div class="platform"><h2>${escList(p)} <span>${total}</span></h2><div class="user-list">`
    for (const k of Object.keys(groups).sort()) {
      for (const u of groups[k]) {
        const pic = u.Pic ? `<img src="${escList(u.Pic)}">` : ''
        let uidText = ''
        if (u.UID) {
          let uidStr = u.UID
          if (!uidStr.toUpperCase().startsWith('UID') && !uidStr.includes('(')) uidStr = 'UID: ' + uidStr
          uidText = `<div class="uid">${escList(uidStr)}</div>`
        }
        body += `<div class="user">
<div class="user-info">
${pic}
<div class="name-uid">
<div class="name ellipsis">${escList(u.Name)}</div>
${uidText}
</div>
</div>
<div class="user-meta">
<div class="letter">${escList(k)}</div>
<div class="watch-type">${escList(u.WatchType)}</div>
</div>
</div>`
      }
    }
    body += '</div></div>'
  }

  const d = new Date()
  const p2 = n => String(n).padStart(2, '0')
  const footer = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:"Microsoft YaHei",Arial,sans-serif;background:#ffffff;color:#333;width:fit-content}
.wrap{padding:28px 40px;display:flex;flex-direction:column;align-items:center;box-sizing:border-box;width:fit-content}
.title{text-align:center;font-size:32px;color:#555;margin-bottom:28px}
.cols{display:flex;flex-wrap:nowrap;gap:60px;justify-content:center;align-items:flex-start}
.platform{display:flex;flex-direction:column;min-width:280px}
h2{font-size:54px;font-style:italic;color:#f39c12;margin:0 0 30px 0;display:flex;justify-content:flex-start;align-items:baseline;gap:15px;font-weight:800}
h2 span{font-size:28px;color:#e74c3c;font-style:italic;font-weight:600}
.user-list{display:flex;flex-direction:column;gap:30px}
.user{display:flex;justify-content:space-between;align-items:center;gap:40px}
.user-info{display:flex;align-items:center;gap:15px}
.user-info img{width:48px;height:48px;border-radius:50%;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.name-uid{display:flex;flex-direction:column}
.name{font-size:18px;font-weight:bold;color:#333}
.uid{font-size:14px;color:#888;margin-top:4px}
.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.user-meta{display:flex;flex-direction:column;align-items:center;gap:8px}
.letter{font-size:32px;font-style:italic;color:#2ecc71;line-height:1;font-weight:800}
.watch-type{font-size:15px;color:#3498db;white-space:nowrap}
.footer{text-align:center;margin-top:36px;color:#aaa;font-size:16px}
</style></head><body><div class="wrap"><div class="title">${escList(title)}</div><div class="cols">${body}</div><div class="footer">Subscribe-Push By 小橙c | ${footer}</div></div></body></html>`
}

/**
 * 渲染订阅列表，返回 PNG Buffer
 *
 * @param {object} subs    插件订阅结构
 * @param {string} groupId 群号（只统计该群的订阅）
 * @returns {Promise<Buffer|null>} 无订阅时返回 null
 */
export async function renderSubscriptionList (subs, groupId) {
  const data = groupSubscriptionData(subs, groupId)
  if (!Object.keys(data).length) return null

  await enrichAvatars(data).catch(() => {})

  return captureHTML(subscriptionListHTML(data), {
    width: 1180,
    height: 100,
    dsf: 2,
    goFullPage: true
  })
}

export default renderSubscriptionList
