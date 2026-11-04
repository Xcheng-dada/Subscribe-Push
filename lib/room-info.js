/**
 * 直播间信息查询（含最近弹幕）
 *
 * 对应旧模板 `custom.command.group.直播间.tmpl`，但数据全部走 B站官方接口，
 * 不再依赖第三方聚合 API。
 *
 * 数据来源：
 *   - 房间基础信息   /room/v1/Room/get_info
 *   - 主播信息       /live_user/v1/Master/info
 *   - 在线人数       /xlive/web-room/v1/index/getRoomPlayInfo（或 WS 的 ONLINE_RANK_COUNT）
 *   - 最近弹幕       WebSocket 连一小会儿，收集 DANMU_MSG
 */

import crypto from 'node:crypto'
import zlib from 'node:zlib'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

/** WBI 混淆表 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

const OP = { HEARTBEAT: 2, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 }

/** 状态文案（对齐原模板） */
const STATUS_TEXT = {
  0: '未开播 🚫',
  1: '直播中 🟢',
  2: '轮播中 🟡'
}

/* ================= WBI ================= */

let wbiCache = { mixinKey: '', at: 0 }

const getMixinKey = orig =>
  MIXIN_KEY_ENC_TAB.map(i => orig[i] || '').join('').slice(0, 32)

const keyFromUrl = url => (String(url || '').split('/').pop() || '').split('.')[0]

async function getMixinKeyCached () {
  if (wbiCache.mixinKey && Date.now() - wbiCache.at < 6 * 3600e3) return wbiCache.mixinKey
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(15000)
  })
  const j = await res.json()
  const imgKey = keyFromUrl(j?.data?.wbi_img?.img_url)
  const subKey = keyFromUrl(j?.data?.wbi_img?.sub_url)
  if (!imgKey || !subKey) throw new Error('获取 WBI key 失败')
  wbiCache = { mixinKey: getMixinKey(imgKey + subKey), at: Date.now() }
  return wbiCache.mixinKey
}

/* ================= 协议帧 ================= */

function packPacket (operation, body = '') {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const header = Buffer.alloc(16)
  header.writeUInt32BE(16 + bodyBuf.length, 0)
  header.writeUInt16BE(16, 4)
  header.writeUInt16BE(1, 6)
  header.writeUInt32BE(operation, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, bodyBuf])
}

/** 解帧，返回原始 JSON 对象（这里需要弹幕体，不只是 cmd） */
function decodeFrames (payload, depth = 0) {
  const out = { messages: [], authCode: null }
  if (depth > 4) return out

  let offset = 0
  while (offset + 16 <= payload.length) {
    const packLen = payload.readUInt32BE(offset)
    if (packLen < 16 || offset + packLen > payload.length || packLen > 0x1000000) break

    const headerLen = payload.readUInt16BE(offset + 4)
    const version = payload.readUInt16BE(offset + 6)
    const operation = payload.readUInt32BE(offset + 8)
    const body = payload.subarray(offset + headerLen, offset + packLen)

    if (version > 1) {
      try {
        const raw = version === 2 ? zlib.inflateSync(body) : zlib.brotliDecompressSync(body)
        const sub = decodeFrames(raw, depth + 1)
        out.messages.push(...sub.messages)
        if (sub.authCode !== null) out.authCode = sub.authCode
      } catch {}
    } else if (operation === OP.MESSAGE) {
      try {
        const j = JSON.parse(body.toString('utf8'))
        if (j.cmd) out.messages.push(j)
      } catch {}
    } else if (operation === OP.AUTH_REPLY) {
      try { out.authCode = JSON.parse(body.toString('utf8')).code } catch {}
    }

    offset += packLen
  }
  return out
}

/* ================= 房间信息 ================= */

/**
 * 拉房间基础信息 + 主播信息
 */
export async function fetchRoomInfo (roomId, cookie = '') {
  roomId = String(roomId).match(/\d+/)?.[0] || ''
  if (!roomId) throw new Error('房间号不能为空')

  const headers = {
    'User-Agent': UA,
    Referer: 'https://live.bilibili.com/'
  }
  if (cookie) headers.Cookie = cookie

  const [infoRes, cover] = await Promise.all([
    fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
      headers,
      signal: AbortSignal.timeout(15000)
    }).then(r => r.json()).catch(() => null),
    Promise.resolve(null)
  ])

  const data = infoRes?.data
  if (!data?.room_id) throw new Error('房间不存在或接口异常')

  const uid = String(data.uid || '')
  const realRoomId = String(data.room_id)

  // 主播信息（粉丝数、头像、昵称、公告）
  let master = null
  if (uid) {
    try {
      const r = await fetch(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`, {
        headers: { ...headers, Referer: `https://live.bilibili.com/${realRoomId}` },
        signal: AbortSignal.timeout(10000)
      }).then(r => r.json())
      master = r?.data || null
    } catch {}
  }

  // 在线人数
  let online = 0
  try {
    const r = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomPlayInfo?room_id=${realRoomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=150&platform=web&ptype=8`, {
      headers: { ...headers, Referer: `https://live.bilibili.com/${realRoomId}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => r.json())
    online = Number(r?.data?.room?.online || 0) || 0
  } catch {}

  const parentArea = data.parent_area_name || ''
  const area = data.area_name || ''
  const areaText = parentArea && area ? `${parentArea}-${area}` : (parentArea || area)

  return {
    roomId: realRoomId,
    shortId: String(data.short_id || ''),
    uid,
    title: data.title || '',
    cover: data.user_cover || data.cover || '',
    coverUrl: data.user_cover || data.cover || '',
    status: Number(data.live_status) || 0,
    statusText: STATUS_TEXT[Number(data.live_status)] || '未知状态 ⚪',
    areaText,
    tags: String(data.tags || '').trim(),
    description: String(data.description || '').trim(),
    liveTime: data.live_time || '',
    online,
    attention: Number(master?.follower_num || 0),
    nickname: master?.info?.uname || '',
    avatar: master?.info?.face || '',
    announce: String(master?.room_news?.content || '').trim()
  }
}

/* ================= 弹幕收集 ================= */

/**
 * 连 WS 收集弹幕和在线人数
 *
 * @param {string} roomId
 * @param {object} opts
 * @param {number} opts.duration   最长收集时长（毫秒），默认 20000
 * @param {number} opts.limit      最多收多少条弹幕，默认 20
 * @param {number} opts.earlyStop  收到这么多弹幕就提前结束（默认 5）
 *
 * 关于时间：不同直播间弹幕密度差异极大——
 *   热闹房间 20 秒能收 30~50 条，
 *   冷清房间（哪怕在线上千人）20 秒可能一条都没有。
 * 历史上 B站有 /dM/gethistory 接口可以补历史弹幕，但现在已经返回空，
 * 所以只能靠延长窗口硬等。这里默认给到 20 秒，同时：
 *   1. 收到 earlyStop 条弹幕 + 拿到在线人数 → 立即返回
 *   2. 一条弹幕都没收到 → 等到上限，尽量捞到一条
 *
 * 注意：这里**故意不传 Cookie**，走匿名态。
 * 带上登录 Cookie 请求 getDanmuInfo 会拿到需要账号态鉴权的 token，
 * 而账号态要求握手包里带 uid + buvid3，缺了会直接认证失败。
 * 匿名态足够读公开弹幕，且不会因为 Cookie 失效而整条链路挂掉。
 */
export async function collectDanmu (roomId, opts = {}) {
  const { duration = 20000, limit = 20, earlyStop = 5 } = opts
  roomId = String(roomId).match(/\d+/)?.[0] || ''
  if (!roomId) throw new Error('房间号不能为空')

  let token, host
  try {
    const mixinKey = await getMixinKeyCached()
    const params = { id: roomId, type: '0', web_location: '444.8' }
    params.wts = String(Math.floor(Date.now() / 1000))
    const query = Object.keys(params).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
    params.w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')

    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://live.bilibili.com',
      Referer: `https://live.bilibili.com/${roomId}`
    }

    const j = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`, {
      headers,
      signal: AbortSignal.timeout(12000)
    }).then(r => r.json())

    if (j.code !== 0) throw new Error(`getDanmuInfo code=${j.code}`)
    token = j.data.token
    const hosts = j.data.host_list || []
    if (!hosts.length) throw new Error('未返回接入点')
    host = hosts.find(h => h.host === 'broadcastlv.chat.bilibili.com') || hosts[0]
  } catch (err) {
    return { danmu: [], online: null, connected: false, error: err.message }
  }

  return await new Promise(resolve => {
    const danmu = []
    let online = null
    let authed = false
    let done = false

    const finish = () => {
      if (done) return
      done = true
      try { ws.close() } catch {}
      clearInterval(hb)
      clearTimeout(timer)
      resolve({ danmu, online, connected: authed })
    }

    let ws
    try {
      ws = new WebSocket(`wss://${host.host}:${host.wss_port}/sub`)
      ws.binaryType = 'arraybuffer'
    } catch (err) {
      return resolve({ danmu: [], online: null, connected: false, error: err.message })
    }

    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.send(packPacket(OP.HEARTBEAT, ''))
    }, 30000)
    const timer = setTimeout(finish, duration)

    ws.onopen = () => {
      ws.send(packPacket(OP.AUTH, JSON.stringify({
        uid: 0, roomid: Number(roomId), protover: 3, platform: 'web', type: 2, key: token
      })))
    }

    ws.onmessage = ev => {
      const r = decodeFrames(Buffer.from(ev.data))
      if (r.authCode === 0) authed = true

      for (const m of r.messages) {
        const cmd = String(m.cmd || '')

        if (cmd.startsWith('DANMU_MSG')) {
          const info = m.info
          if (!Array.isArray(info)) continue
          const text = String(info[1] || '').trim()
          const name = String(info?.[2]?.[1] || '').trim()
          const ts = Number(info?.[9]?.ts || 0)
          if (!text || !name) continue
          danmu.push({
            name,
            text,
            time: ts > 0 ? new Date(ts * 1000) : new Date()
          })
          if (danmu.length >= limit) return finish()
        } else if (cmd === 'ONLINE_RANK_COUNT') {
          // 实时在线人数。**未开播的房间也会推**（还有人在看回放/挂机），
          // 所以这是唯一可靠的在线人数来源。
          // 注意：心跳回包里的 popularity 字段现在恒为 1，已经废弃，不要用。
          const n = Number(m?.data?.count)
          if (n > 0) online = n
        }
      }

      // 提前结束：弹幕够多了，且在线人数也拿到了——没必要再等满 8 秒
      if (danmu.length >= earlyStop && online > 0) return finish()
    }

    ws.onerror = () => finish()
    ws.onclose = () => finish()
  })
}

/* ================= 格式化 ================= */

/**
 * 版式对齐旧模板，拆成上下两段，好把直播卡图片插在中间：
 *
 *   [上段]
 *   主播：xxx
 *   状态：未开播🚫
 *   标签：xxx
 *   封面：            ← 图片插在这行后面
 *
 *   [下段]
 *   -------------------
 *   🗣与此同时直播间：
 *   👥在线人数：588
 *   --🕐最新弹幕时间🕘--
 *   2025-11-24 23:39:23
 *   -------------------
 *   昵称：弹幕内容
 *   ...
 *
 * 标题、分区不单独输出——直播卡图片里已经有了。
 */
export function formatRoomReport (info, danmuResult) {
  const head = []

  if (info.nickname) head.push(`主播：${info.nickname}`)
  head.push(`状态：${info.statusText}`)
  if (info.tags) head.push(`标签：${info.tags}`)
  head.push('封面：')

  const tail = []
  tail.push('-------------------')
  tail.push('🗣与此同时直播间：')

  const onlineNum = danmuResult?.online ?? info.online
  if (onlineNum > 0) tail.push(`👥在线人数：${formatNum(onlineNum)}`)

  const { danmu = [], connected } = danmuResult || {}

  if (!connected) {
    tail.push('（弹幕连接失败，仅显示房间信息）')
  } else if (!danmu.length) {
    tail.push('（这段时间没有新弹幕）')
  } else {
    const latest = danmu[danmu.length - 1].time
    tail.push('--🕐最新弹幕时间🕘--')
    tail.push(fmtTime(latest))
    tail.push('-------------------')
    for (const d of danmu) {
      tail.push(`${d.name}：${d.text}`)
    }
  }

  return { head: head.join('\n'), tail: tail.join('\n') }
}

/** 兼容：只要纯文字时用这个 */
export function formatRoomReportText (info, danmuResult) {
  const { head, tail } = formatRoomReport(info, danmuResult)
  return `${head}\n${tail}`
}

/** 数字格式化：>=10000 显示 x.x万 */
function formatNum (n) {
  n = Number(n) || 0
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

function fmtTime (d) {
  if (!(d instanceof Date)) d = new Date(d)
  if (Number.isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export { formatNum, fmtTime }
