/**
 * B站直播 WebSocket 监听器
 *
 * 协议链路：
 *   1. GET /x/web-interface/nav       取 wbi_img 的 img_key / sub_key
 *   2. WBI 签名 getDanmuInfo          拿 token + 接入点
 *   3. 连 wss://<host>:<wss_port>/sub  发认证包（protover=3 brotli）
 *   4. 每 30s 发心跳，收帧后解压 brotli → 解析 cmd
 *
 * 关键事件：
 *   LIVE     开播
 *   PREPARING 下播
 *   （弹幕等其它事件全部忽略，不需要）
 *
 * 和轮询相比的差别：WS 是服务端推送，开播后 1~2 秒内就能收到。
 * 但 WS 有断线、风控、限流问题，所以保留轮询作为兜底——
 * 两者并行跑，谁先发现算谁的（去重靠 meta 里的 liveStatus）。
 */

import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { getSubs, getMeta, setMeta } from './store.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

/** 协议操作码 */
const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
}

/** WBI 混淆表（对齐 bilibili.go mixinKeyEncTab） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

const DEFAULTS = {
  enabled: true,
  heartbeatInterval: 30,   // 秒
  maxConnections: 30,      // 同时监听的房间上限（防开太多被限流）
  reconnectBase: 5,        // 重连基础退避（秒）
  reconnectMax: 300
}

/* ================= 工具 ================= */

const getMixinKey = orig =>
  MIXIN_KEY_ENC_TAB.map(i => orig[i] || '').join('').slice(0, 32)

const extractKeyFromUrl = url => {
  const path = String(url || '').split('/').pop() || ''
  return path.split('.')[0]
}

/** 打包协议帧（对齐 packLiveProtocolPacket） */
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

/**
 * 解帧（对齐 decodeLiveProtocolDepth）
 * v2 = zlib，v3 = brotli，递归深度上限 4
 */
function decodeFrames (payload, depth = 0) {
  const out = { cmds: [], authCode: null }
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
        out.cmds.push(...sub.cmds)
        if (sub.authCode !== null) out.authCode = sub.authCode
      } catch { /* 解压失败跳过该帧 */ }
    } else if (operation === OP.MESSAGE) {
      try {
        const j = JSON.parse(body.toString('utf8'))
        if (j.cmd) out.cmds.push(String(j.cmd).trim())
      } catch {}
    } else if (operation === OP.AUTH_REPLY) {
      try { out.authCode = JSON.parse(body.toString('utf8')).code } catch {}
    }

    offset += packLen
  }
  return out
}

/* ================= WBI ================= */

let wbiCache = { imgKey: '', subKey: '', mixinKey: '', at: 0 }

async function refreshWbi (force = false) {
  if (!force && wbiCache.mixinKey && Date.now() - wbiCache.at < 6 * 3600e3) {
    return wbiCache.mixinKey
  }
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(15000)
  })
  const j = await res.json()
  // 注意：未登录时 code 是 -101，但 wbi_img 仍然会返回，可以正常签名
  const imgKey = extractKeyFromUrl(j?.data?.wbi_img?.img_url)
  const subKey = extractKeyFromUrl(j?.data?.wbi_img?.sub_url)
  if (!imgKey || !subKey) throw new Error('获取 WBI key 失败')

  wbiCache = {
    imgKey,
    subKey,
    mixinKey: getMixinKey(imgKey + subKey),
    at: Date.now()
  }
  return wbiCache.mixinKey
}

/** WBI 签名（对齐 signWbi） */
function signWbi (params, mixinKey) {
  params.wts = String(Math.floor(Date.now() / 1000))
  const query = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
  params.w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
  return params
}

/* ================= 单房间连接 ================= */

class RoomConnection {
  constructor (roomId, manager) {
    this.roomId = Number(roomId)
    this.manager = manager
    this.ws = null
    this.heartbeatTimer = null
    this.retry = 0
    this.closed = false
    this.authenticated = false
  }

  async connect () {
    if (this.closed) return

    let token, host
    try {
      const mixinKey = await refreshWbi()
      const params = signWbi({ id: String(this.roomId), type: '0', web_location: '444.8' }, mixinKey)
      const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')

      const res = await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Origin: 'https://live.bilibili.com',
          Referer: `https://live.bilibili.com/${this.roomId}`
        },
        signal: AbortSignal.timeout(15000)
      })
      const j = await res.json()
      if (j.code !== 0) throw new Error(`getDanmuInfo code=${j.code} ${j.message || j.msg || ''}`)

      token = j.data.token
      const hosts = j.data.host_list || []
      if (!hosts.length) throw new Error('getDanmuInfo 未返回接入点')
      // 优先官方广播节点，失败再换
      host = hosts.find(h => h.host === 'broadcastlv.chat.bilibili.com') || hosts[0]
    } catch (err) {
      return this.scheduleReconnect(err)
    }

    try {
      const ws = new WebSocket(`wss://${host.host}:${host.wss_port}/sub`)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        // 未登录态用 uid=0；登录态需要 Cookie 里带 buvid3，
        // 但账号态要求 Cookie 里必须有 buvid3，缺失会直接拒。这里先用匿名态，
        // 匿名态同样能收到 LIVE/PREPARING（服务端推给房间所有连接）。
        ws.send(packPacket(OP.AUTH, JSON.stringify({
          uid: 0,
          roomid: this.roomId,
          protover: 3,
          platform: 'web',
          type: 2,
          key: token
        })))
      }

      ws.onmessage = ev => this.handleMessage(Buffer.from(ev.data))

      ws.onerror = () => { /* onclose 会跟着来，在这里重复处理没意义 */ }

      ws.onclose = () => {
        this.stopHeartbeat()
        if (this.closed) return
        this.manager.release(this.roomId)
        this.scheduleReconnect(new Error('连接关闭'))
      }
    } catch (err) {
      return this.scheduleReconnect(err)
    }
  }

  handleMessage (buf) {
    let decoded
    try {
      decoded = decodeFrames(buf)
    } catch {
      return
    }

    if (decoded.authCode !== null) {
      if (decoded.authCode === 0) {
        this.authenticated = true
        this.retry = 0
        this.startHeartbeat()
        this.manager.onAuthenticated(this.roomId)
      } else {
        // 认证失败通常要换 token，直接断开重来
        this.close()
        this.scheduleReconnect(new Error(`认证失败 code=${decoded.authCode}`))
      }
      return
    }

    for (const cmd of decoded.cmds) {
      const base = cmd.split(':')[0]
      if (base === 'LIVE') {
        this.manager.emit({ kind: 'start', roomId: this.roomId, source: 'websocket' })
      } else if (base === 'PREPARING') {
        this.manager.emit({ kind: 'stop', roomId: this.roomId, source: 'websocket' })
      }
      // 其它事件（DANMU_MSG 等）一律忽略
    }
  }

  startHeartbeat () {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === 1) {
        this.ws.send(packPacket(OP.HEARTBEAT, ''))
      }
    }, this.manager.cfg.heartbeatInterval * 1000)
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
  }

  stopHeartbeat () {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  scheduleReconnect (err) {
    if (this.closed) return
    this.retry++
    // 5,10,20,40,80,160,300... 封顶
    const delay = Math.min(
      this.manager.cfg.reconnectBase * (2 ** (this.retry - 1)),
      this.manager.cfg.reconnectMax
    )
    logger.debug?.(`[订阅推送] 直播WS ${this.roomId} 重连中(${this.retry}) ${Math.round(delay)}s: ${err?.message || ''}`)

    setTimeout(() => {
      if (!this.closed) this.connect().catch(() => {})
    }, delay * 1000).unref?.()
  }

  close () {
    this.closed = true
    this.stopHeartbeat()
    try { this.ws?.close() } catch {}
    this.ws = null
  }
}

/* ================= 管理器 ================= */

export class LiveWebsocketManager {
  /**
   * @param {object} opts
   * @param {(event: {kind: string, roomId: number, source: string}) => Promise<void>} opts.onEvent
   */
  constructor ({ onEvent } = {}) {
    this.onEvent = onEvent
    this.cfg = { ...DEFAULTS }
    this.conns = new Map()      // roomId -> RoomConnection
    this.stopped = true
    this.syncTimer = null
    /** 最近一次认证成功的连接数，用于健康度判断 */
    this.authenticatedCount = 0
  }

  configure (partial = {}) {
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined && v !== null && v !== '') this.cfg[k] = v
    }
  }

  async start () {
    if (!this.cfg.enabled) {
      logger.mark('[订阅推送] 直播WS 已禁用（config: bilibiliLive.websocket.enabled=false）')
      return
    }
    this.stopped = false
    await this.sync()
    // 订阅变化时同步连接（新增订阅要连上，取消订阅要断开）
    this.scheduleSync()
    logger.mark(`[订阅推送] 直播WS 已启动，监听 ${this.conns.size} 个房间`)
  }

  stop () {
    this.stopped = true
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    for (const c of this.conns.values()) c.close()
    this.conns.clear()
  }

  scheduleSync () {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = setInterval(() => {
      this.sync().catch(e => logger.error('[订阅推送] 直播WS 同步失败', e))
    }, 60 * 1000)
    if (this.syncTimer.unref) this.syncTimer.unref()
  }

  /**
   * 对齐订阅表：订阅有房间号就连接，取消订阅就断开
   */
  async sync () {
    if (this.stopped) return

    const subs = await getSubs('bilibili', 'live')
    const want = new Set()

    for (const [uid, rec] of Object.entries(subs)) {
      const roomId = Number(rec.roomId || 0)
      if (roomId > 0) want.add(roomId)
    }

    // 断了不再需要的
    for (const [roomId, conn] of this.conns) {
      if (!want.has(roomId)) {
        conn.close()
        this.conns.delete(roomId)
      }
    }

    // 补上新增的（受上限保护）
    const slots = this.cfg.maxConnections - this.conns.size
    const added = [...want].filter(r => !this.conns.has(r)).slice(0, Math.max(0, slots))
    for (const roomId of added) {
      const conn = new RoomConnection(roomId, this)
      this.conns.set(roomId, conn)
      conn.connect().catch(e => logger.error(`[订阅推送] 直播WS 连接失败 ${roomId}`, e))
    }

    if (added.length) {
      logger.debug?.(`[订阅推送] 直播WS 新增 ${added.length} 个房间监听`)
    }
  }

  onAuthenticated (roomId) {
    this.authenticatedCount++
  }

  /** 单个房间断开时调用，避免 Map 里堆积死连接 */
  release (roomId) {
    // 这里不删，因为 RoomConnection 自己会重连；保留占位即可
  }

  /**
   * 收到 LIVE / PREPARING，转成统一事件交给 push 层
   * 用 roomId 反查 uid（订阅表里存的是 uid → roomId）
   */
  async emit ({ kind, roomId, source }) {
    try {
      const subs = await getSubs('bilibili', 'live')
      let uid = null
      for (const [u, rec] of Object.entries(subs)) {
        if (Number(rec.roomId) === Number(roomId)) { uid = u; break }
      }
      if (!uid) return

      // 和轮询共用 meta 去重：谁先记下 liveStatus 谁生效
      const meta = await getMeta('bilibili', 'live')
      const prev = meta[uid] || {}
      const prevStatus = prev.liveStatus

      if (kind === 'start') {
        if (prevStatus === 1) return // 轮询已经推过了
        await setMeta('bilibili', 'live', uid, {
          liveStatus: 1,
          offlineCount: 0,
          liveTime: Math.floor(Date.now() / 1000)
        })
      } else if (kind === 'stop') {
        if (prevStatus === 0) return
        // 注意：**不要把 liveTime 清零**
        // 下播推送要用它算「直播时长」，清掉之后 push.js 读不到，
        // 只能退回接口的 StartTime；接口拿不到就显示「1 分钟」。
        // 留着不动，下次开播时会被覆盖成新的开始时间。
        await setMeta('bilibili', 'live', uid, { liveStatus: 0, offlineCount: 0 })
      }

      logger.mark(`[订阅推送] 直播WS 收到 ${kind}（uid=${uid} room=${roomId}）`)

      await this.onEvent?.({
        kind,
        uid,
        roomId: String(roomId),
        room: {
          room_id: roomId,
          title: prev.title || '',
          uname: (await getSubs('bilibili', 'live'))[uid]?.name || ''
        },
        source
      })
    } catch (err) {
      logger.error('[订阅推送] 直播WS 事件处理失败', err)
    }
  }

  /** 健康状态（给 #订阅状态 之类的命令用） */
  stats () {
    let authed = 0
    for (const c of this.conns.values()) if (c.authenticated) authed++
    return { total: this.conns.size, authenticated: authed, enabled: this.cfg.enabled }
  }
}

export default LiveWebsocketManager
