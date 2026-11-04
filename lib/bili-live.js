/**
 * B站直播开播检测（轮询版，作为 WebSocket 的兜底）
 *
 * 主力是 lib/bili-live-ws.js 的 WebSocket 推送（开播 1~2 秒内到达）。
 * 本模块并行跑一个低频轮询，作用是：
 *   1. WS 万一断线/被限流，轮询还能发现开播
 *   2. WS 连不上（比如被风控）时，这里是唯一发现途径
 *   3. 定期校准状态，防止 WS 漏事件后状态永久错位
 *
 * 两者通过 meta.liveStatus 去重：谁先发现算谁的，后到的会被判为「已经是这个状态」而跳过。
 */

import { getSubs, getMeta, setMeta, updateSubName } from './store.js'

const PATH_STATUS = 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

const DEFAULTS = {
  // WS 正常工作时轮询只是兜底，可以放很宽；WS 挂了它会自动承担主力
  probeInterval: 60,       // 秒
  maxBackoff: 15 * 60,
  minBackoff: 60,
  backoffCap: 15 * 60,
  /** 连续多少次「未开播」才认定真的下播（防接口抖动误报下播） */
  offlineConfirmTimes: 2
}

/** live_status 枚举：0 未开播 / 1 直播中 / 2 轮播 */
const LIVE = 1

export class BiliLivePoller {
  constructor ({ onNotify } = {}) {
    this.onNotify = onNotify
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
      this.pollOnce().catch(e => logger.error('[订阅推送] B站直播轮询异常', e))
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  async pollOnce () {
    const subs = await getSubs('bilibili', 'live')
    const uids = Object.keys(subs)
    if (!uids.length) {
      this.nextRun = Date.now() + this.cfg.probeInterval * 1000
      return this.schedule()
    }

    let data
    try {
      data = await this.fetchStatus(uids)
    } catch (err) {
      this.scheduleFailure(err)
      return this.schedule()
    }

    const meta = await getMeta('bilibili', 'live')
    const events = []

    for (const uid of uids) {
      const sub = subs[uid] || {}
      const room = data[uid]
      if (!room) continue

      // 回填主播名
      if (room.uname) updateSubName('bilibili', 'live', uid, room.uname).catch(() => {})

      // 房间号优先用接口返回的，其次用订阅时存下的
      const roomId = String(room.room_id || sub.roomId || '')

      const prev = meta[uid] || {}
      const prevStatus = prev.liveStatus
      const nowStatus = Number(room.live_status) || 0
      const isLive = nowStatus === LIVE

      // 首次见到这个主播：只记录基线，不推送（避免订阅瞬间补发一条开播）
      if (prevStatus === undefined) {
        await setMeta('bilibili', 'live', uid, {
          liveStatus: nowStatus,
          roomId,
          title: room.title,
          offlineCount: 0,
          lastLiveTime: room.live_time || 0
        })
        continue
      }

      // 开播：未开播 → 直播中
      if (prevStatus !== LIVE && nowStatus === LIVE) {
        await setMeta('bilibili', 'live', uid, {
          liveStatus: nowStatus,
          roomId,
          title: room.title,
          liveTime: room.live_time || 0,
          offlineCount: 0,
          lastLiveTime: room.live_time || 0
        })
        events.push({ kind: 'start', uid, roomId, room })
        continue
      }

      // 下播：需要连续 N 次确认（对齐 DDBOT 的 notLiveConfirmTimes）
      if (prevStatus === LIVE && nowStatus !== LIVE) {
        const offlineCount = (prev.offlineCount || 0) + 1
        if (offlineCount < this.cfg.offlineConfirmTimes) {
          await setMeta('bilibili', 'live', uid, { offlineCount })
          continue
        }
        // 不要在这里清零 liveTime——下播推送要用它算直播时长。
        // 清掉之后只能退回接口的 StartTime，拿不到就显示「1 分钟」。
        await setMeta('bilibili', 'live', uid, {
          liveStatus: nowStatus,
          offlineCount: 0
        })
        events.push({ kind: 'stop', uid, roomId, room, prev })
        continue
      }

      // 直播中改标题
      if (prevStatus === LIVE && nowStatus === LIVE && prev.title && room.title && prev.title !== room.title) {
        await setMeta('bilibili', 'live', uid, { title: room.title })
        events.push({ kind: 'retitle', uid, roomId, room, prev })
        continue
      }

      // 稳定状态，清一下离线计数
      if (prev.offlineCount) {
        await setMeta('bilibili', 'live', uid, { offlineCount: 0 })
      }
    }

    this.failures = 0
    this.nextRun = Date.now() + this.cfg.probeInterval * 1000

    if (events.length) {
      try {
        await this.onNotify({ site: 'bilibili', type: 'live', events })
      } catch (err) {
        logger.error('[订阅推送] B站直播推送失败', err)
      }
    }
    return this.schedule()
  }

  async fetchStatus (uids) {
    const res = await fetch(PATH_STATUS, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Referer: 'https://live.bilibili.com/'
      },
      body: JSON.stringify({ uids: uids.map(Number).filter(n => n > 0) }),
      signal: AbortSignal.timeout(15000)
    })
    const json = await res.json().catch(() => null)
    if (!json) throw new Error('批量直播状态返回空响应')
    if (json.code !== 0) throw new Error(`批量直播状态API失败: code=${json.code} ${json.message || json.msg || ''}`)
    if (!json.data) throw new Error('批量直播状态返回空数据')

    // data 以 UID 字符串为键
    const out = {}
    for (const [uid, info] of Object.entries(json.data)) {
      if (!info) continue
      out[uid] = info
    }
    return out
  }

  scheduleFailure (err) {
    this.failures++
    const backoff = Math.min(
      2 ** (this.failures - 1) * this.cfg.minBackoff,
      this.cfg.backoffCap,
      this.cfg.maxBackoff
    )
    this.nextRun = Date.now() + backoff * 1000
    logger.warn(`[订阅推送] B站直播状态查询失败（连续 ${this.failures} 次，${Math.round(backoff)}s 后重试）：${err?.message || err}`)
  }
}

export default BiliLivePoller
