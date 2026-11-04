/**
 * B站动态过滤
 *
 * 对齐 DDBOT 的 `/config filter`：
 *   filter type <id> <类型...>       只推这些类型
 *   filter not_type <id> <类型...>   不推这些类型
 *   filter text <id> <关键字...>      只推包含任一组关键字的
 *   filter not_text <id> <关键字...>  不推包含任一关键字的
 *   filter show <id>
 *   filter clear <id>
 *
 * master 分支上「同一时间只能设一种过滤器」，这里做了更宽松的处理：
 * 类型规则和关键字规则可以同时存在（多条之间 AND，同一条内 OR），
 * 和 next 分支行为一致。对用户更实用。
 */

import { DYNAMIC_TYPE_NAMES, getGroupConfig, setGroupConfig } from './store.js'

/** 把动态说成人话的类型名（对齐文档里的中文类型） */
export function dynamicTypeName (item) {
  const t = item?.type || ''
  const major = item?.modules?.module_dynamic?.major

  if (t === 'DYNAMIC_TYPE_FORWARD') return '转发'
  if (t === 'DYNAMIC_TYPE_AV') return '投稿'
  if (t === 'DYNAMIC_TYPE_ARTICLE') return '专栏'
  if (t === 'DYNAMIC_TYPE_WORD') return '文字'
  if (t === 'DYNAMIC_TYPE_LIVE' || t === 'DYNAMIC_TYPE_LIVE_RCMD') return '直播分享'
  if (t === 'DYNAMIC_TYPE_MUSIC') return '音频'
  if (t === 'DYNAMIC_TYPE_DRAW') {
    // 带 archive 的 DRAW 其实是投稿视频
    if (major?.archive) return '投稿'
    return major?.draw?.items?.length ? '图片' : '图文'
  }
  return '其他'
}

function contentTextOf (item) {
  const major = item?.modules?.module_dynamic?.major
  const opus = major?.opus
  const parts = [
    opus?.title,
    opus?.summary?.text,
    major?.text,
    item?.modules?.module_dynamic?.desc?.text
  ]
  // 转发的原动态内容也算进去
  const orig = item?.orig?.modules?.module_dynamic
  parts.push(orig?.major?.opus?.title, orig?.major?.opus?.summary?.text, orig?.major?.text)

  return parts.filter(Boolean).map(String).join(' ').toLowerCase()
}

/**
 * 判断这条动态该不该推
 *
 * @param {object} item    动态对象
 * @param {object} rule    filter 规则 { type, notType, text, notText }
 * @returns {{pass: boolean, reason: string}}
 */
export function shouldPushDynamic (item, rule) {
  if (!rule || typeof rule !== 'object') return { pass: true, reason: '' }

  const typeName = dynamicTypeName(item)

  // --- 类型白名单 ---
  if (Array.isArray(rule.type) && rule.type.length) {
    if (!rule.type.includes(typeName)) {
      return { pass: false, reason: `类型 ${typeName} 不在白名单` }
    }
  }

  // --- 类型黑名单 ---
  if (Array.isArray(rule.notType) && rule.notType.length) {
    if (rule.notType.includes(typeName)) {
      return { pass: false, reason: `类型 ${typeName} 在黑名单` }
    }
  }

  const text = contentTextOf(item)

  // --- 关键字白名单 ---
  if (Array.isArray(rule.text) && rule.text.length) {
    const hit = rule.text.some(k => text.includes(String(k).toLowerCase()))
    if (!hit) return { pass: false, reason: '不含要求的关键字' }
  }

  // --- 关键字黑名单 ---
  if (Array.isArray(rule.notText) && rule.notText.length) {
    const hit = rule.notText.find(k => text.includes(String(k).toLowerCase()))
    if (hit) return { pass: false, reason: `含屏蔽词「${hit}」` }
  }

  return { pass: true, reason: '' }
}

/**
 * 改某个群的过滤规则
 *
 * @param {string} group  群号
 * @param {string} uid    UP 的 UID
 * @param {string} op     操作：type / not_type / text / not_text / clear
 * @param {string[]} values 参数
 */
export async function updateFilter (group, uid, op, values = []) {
  const cfg = await getGroupConfig(group)
  const all = { ...(cfg.filter && typeof cfg.filter === 'object' ? cfg.filter : {}) }
  const cur = { ...(all[uid] || {}) }

  switch (op) {
    case 'type': cur.type = values; delete cur.notType; break
    case 'not_type': cur.notType = values; delete cur.type; break
    case 'text': cur.text = values; delete cur.notText; break
    case 'not_text': cur.notText = values; delete cur.text; break
    case 'clear':
      delete all[uid]
      await setGroupConfig(group, 'filter', all)
      return { cleared: true }
    default:
      throw new Error(`未知过滤操作：${op}`)
  }

  all[uid] = cur
  await setGroupConfig(group, 'filter', all)
  return { rule: cur }
}

/** 读某个群的过滤规则（给命令 show 用） */
export async function readFilter (group, uid) {
  const cfg = await getGroupConfig(group)
  const all = cfg.filter && typeof cfg.filter === 'object' ? cfg.filter : {}
  return all[uid] || null
}

/** 一条规则转成可读文本 */
export function describeFilter (rule) {
  if (!rule || !Object.keys(rule).length) return '（无过滤，全部推送）'
  const lines = []
  if (rule.type?.length) lines.push(`只推类型：${rule.type.join('、')}`)
  if (rule.notType?.length) lines.push(`不推类型：${rule.notType.join('、')}`)
  if (rule.text?.length) lines.push(`只推含：${rule.text.join('、')}`)
  if (rule.notText?.length) lines.push(`不推含：${rule.notText.join('、')}`)
  return lines.length ? lines.join('\n') : '（无过滤，全部推送）'
}

export { DYNAMIC_TYPE_NAMES }
