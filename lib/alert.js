/**
 * 失效告警
 *
 * Cookie 失效、登录态过期这类问题不会自愈，必须人工处理。
 * 光打日志没人看得到，所以私聊推给机器人主人。
 *
 * 关键设计：
 *   1. **只在状态变化时告警**，不是每次失败都发（否则一路失败会刷屏）
 *   2. 恢复时也发一条，让人知道好了
 *   3. 同一个问题有冷却，避免反复抖动时重复打扰
 */

/** 平台 → 可读名字 */
const PLATFORM_NAME = {
  bilibili: 'B站',
  weibo: '微博'
}

/** 告警状态：key = 平台:类型，value = 'ok' | 'error' */
const healthMap = new Map()

/** 上一次实际发出告警的时间，用于冷却 */
const lastAlertAt = new Map()

/** 同一问题最短告警间隔（毫秒）：30 分钟 */
const ALERT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 拿主人 QQ 列表
 *
 * 优先 cfg.masterQQ（Yunzai 标准配置），拿不到就放弃——
 * 宁可静默也不要往错误的人发消息。
 */
function masterQQList () {
  try {
    const list = global.cfg?.masterQQ
    if (!Array.isArray(list)) return []
    return list.map(String).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 私聊发给所有主人
 *
 * @param {string} text 消息内容
 * @returns {Promise<boolean>} 是否至少成功发出一条
 */
async function sendToMasters (text) {
  const masters = masterQQList()
  if (!masters.length) {
    logger.warn('[订阅推送] 未配置 masterQQ，无法私聊告警')
    return false
  }

  let ok = false
  for (const qq of masters) {
    try {
      const friend = Bot.pickFriend(Number(qq))
      if (!friend) continue
      await friend.sendMsg(text)
      ok = true
    } catch (err) {
      logger.debug?.(`[订阅推送] 私聊告警失败 QQ${qq}：${err?.message || err}`)
    }
  }
  return ok
}

/**
 * 上报一次成功/失败，按需触发告警
 *
 * @param {string} platform bilibili / weibo
 * @param {string} scene    具体环节（动态 / 直播 / 微博），用于区分不同轮询器
 * @param {boolean} ok      true = 成功，false = 失败
 * @param {string} reason   失败原因（成功时忽略）
 */
export async function reportHealth (platform, scene, ok, reason = '') {
  const key = `${platform}:${scene}`
  const prev = healthMap.get(key)

  if (ok) {
    // 从「故障」恢复 → 发一条恢复通知
    if (prev === 'error') {
      healthMap.set(key, 'ok')
      lastAlertAt.delete(key)
      await sendToMasters(
        `[订阅推送] ${PLATFORM_NAME[platform] || platform}${scene} 已恢复正常`
      )
    } else {
      healthMap.set(key, 'ok')
    }
    return
  }

  // 失败：只有「首次失败」或「冷却已过」才告警，避免每轮都发
  const now = Date.now()
  const last = lastAlertAt.get(key) || 0
  const cooling = now - last < ALERT_COOLDOWN_MS

  healthMap.set(key, 'error')
  if (cooling) return

  lastAlertAt.set(key, now)

  const title = `${PLATFORM_NAME[platform] || platform}${scene} 出问题了`
  const hint = hintFor(platform, reason)

  const lines = [
    `[订阅推送] ${title}`,
    '',
    `原因：${reason || '未知'}`
  ]
  if (hint) lines.push('', hint)

  await sendToMasters(lines.join('\n'))
}

/**
 * 根据平台和错误原因给出处理建议
 *
 * 目的是让人收到消息就知道该做什么，不用再去翻文档。
 */
function hintFor (platform, reason) {
  const r = String(reason || '')

  if (platform === 'weibo') {
    if (r.includes('-100') || r.includes('登录')) {
      return '处理：浏览器打开 weibo.com 确认已登录，然后点 CookieCloud 扩展手动同步。'
    }
    return '处理：检查 CookieCloud 是否正常同步，或微博接口是否临时故障。'
  }

  if (platform === 'bilibili') {
    if (r.includes('-101') || r.includes('未登录')) {
      return '处理：B站 Cookie 过期了，在 CookieCloud 里重新同步一次。'
    }
    if (r.includes('-352') || r.includes('风控')) {
      return '处理：触发风控了，暂停一段时间会自动恢复，不用处理。'
    }
    return '处理：看日志里的详细信息，通常是网络或接口临时故障。'
  }

  return ''
}

/** 查询某环节当前健康状态（给命令用） */
export function getHealth (platform, scene) {
  return healthMap.get(`${platform}:${scene}`) || 'unknown'
}

/** 全部健康状态 */
export function getAllHealth () {
  const out = {}
  for (const [k, v] of healthMap) out[k] = v
  return out
}

export default { reportHealth, getHealth, getAllHealth }
