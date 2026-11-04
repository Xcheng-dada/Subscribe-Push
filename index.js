/**
 * 订阅推送插件
 *
 * 一个插件干完全部三件事，不需要额外进程：
 *   - B站动态：网页新版增量探测（feed/all/update 看 update_num）
 *   - B站直播：WebSocket 实时推送 + 批量状态轮询兜底
 *   - 微博动态：weibo.com 登录态接口轮询
 *   - 渲染：内置 lib/render/，直接出 Buffer 不落盘
 *   - 存储：data/subscriptions.json，不依赖 Redis
 *   - 推送：TRSS-Yunzai 原生 Bot API
 *
 * 命令全部中文，示例：
 *   #订阅动态 253298645
 *   #订阅直播 12345
 *   #订阅微博 2700162334
 *   #我的订阅
 */

import plugin from '../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

import {
  initStore, getSiteSubs, getSubs, addSub, removeSub, allSites,
  setGroupConfig, getGroupConfig, setNotifySwitch, atAllKey, DYNAMIC_TYPE_NAMES
} from './lib/store.js'
import { updateFilter, readFilter, describeFilter } from './lib/filter.js'
import { BiliDynamicPoller } from './lib/bili-dynamic.js'
import { BiliLivePoller } from './lib/bili-live.js'
import { LiveWebsocketManager } from './lib/bili-live-ws.js'
import { WeiboPoller } from './lib/weibo.js'
import { pushNotify, pushLiveEvent } from './lib/push.js'
import { CMD } from './lib/commands.js'

/** 站点名 → 中文显示名 */
const SITE_NAME = { bilibili: 'B站', weibo: '微博' }

/** 类型名 → 中文显示名 */
const TYPE_NAME = { news: '动态', live: '直播' }

const pollers = {}
let wsManager = null
let booted = false

/** 读取插件配置（缺文件就用轮询器内置默认值） */
function loadConfig () {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const file = path.join(dir, 'config', 'config.yaml')
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('[订阅推送] 配置读取失败，使用默认值', e.message)
    return {}
  }
}

/**
 * 启动全部轮询器（幂等）
 *
 * 注意：即使当前没有任何订阅也要启动。轮询器每轮会自己检查订阅表，
 * 没订阅就直接空转（只读一次 JSON），开销可以忽略。
 * 反过来，如果这里因为「加载时没订阅」就不起轮询器，
 * 用户之后发的 #订阅动态 就永远不会被推送——这是必须避免的坑。
 */
async function boot () {
  if (booted) return
  booted = true

  await initStore()

  const conf = loadConfig()

  pollers.dynamic = new BiliDynamicPoller({ onNotify: pushNotify })
  pollers.live = new BiliLivePoller({ onNotify: pushNotify })
  pollers.weibo = new WeiboPoller({ onNotify: pushNotify })

  pollers.dynamic.configure(conf.bilibiliNews)
  pollers.live.configure(conf.bilibiliLive)
  pollers.weibo.configure(conf.weiboNews)

  // 直播 WS：主力发现手段（开播 1~2 秒内到达）
  // 轮询降级为兜底（WS 断了也能发现，一分钟一次足够）
  wsManager = new LiveWebsocketManager({
    onEvent: evt => pushLiveEvent(evt)
  })
  wsManager.configure(conf.bilibiliLive?.websocket)

  for (const [key, poller] of Object.entries(pollers)) {
    poller.start().catch(e => logger.error(`[订阅推送] ${key} 轮询器启动失败`, e))
  }
  wsManager.start().catch(e => logger.error('[订阅推送] 直播WS 启动失败', e))

  const subs = await getSiteSubs()
  const total = Object.values(subs).reduce(
    (n, byType) => n + Object.values(byType).reduce((m, h) => m + Object.keys(h).length, 0), 0
  )
  logger.mark(`[订阅推送] 已启动（动态 ${pollers.dynamic.cfg.probeInterval}s / 直播WS+轮询兜底 ${pollers.live.cfg.probeInterval}s / 微博 ${pollers.weibo.cfg.probeInterval}s），订阅 ${total} 项`)
}

export class SubscribePush extends plugin {
  constructor () {
    super({
      name: '订阅推送',
      dsc: 'B站动态、B站直播、微博动态的订阅与推送（自带转图）',
      event: 'message',
      priority: 4000,
      rule: [
        // 除 #直播间 外全部限主人。
        // permission: 'master' 由 TRSS 框架统一校验（lib/plugins/loader.js filtPermission），
        // 非主人会收到「暂无权限，只有主人才能操作」。
        { reg: CMD.subBiliNews.pattern, fnc: 'subBiliNews', permission: 'master' },
        { reg: CMD.subBiliLive.pattern, fnc: 'subBiliLive', permission: 'master' },
        { reg: CMD.subWeibo.pattern, fnc: 'subWeibo', permission: 'master' },
        { reg: CMD.unsubBiliNews.pattern, fnc: 'unsubBiliNews', permission: 'master' },
        { reg: CMD.unsubBiliLive.pattern, fnc: 'unsubBiliLive', permission: 'master' },
        { reg: CMD.unsubWeibo.pattern, fnc: 'unsubWeibo', permission: 'master' },
        { reg: CMD.offlineNotify.pattern, fnc: 'offlineNotify', permission: 'master' },
        { reg: CMD.titleNotify.pattern, fnc: 'titleNotify', permission: 'master' },
        { reg: CMD.atAllAdd.pattern, fnc: 'atAllAdd', permission: 'master' },
        { reg: CMD.atAllDel.pattern, fnc: 'atAllDel', permission: 'master' },
        { reg: CMD.atAllShow.pattern, fnc: 'atAllShow', permission: 'master' },
        { reg: CMD.atAdd.pattern, fnc: 'atAdd', permission: 'master' },
        { reg: CMD.atDel.pattern, fnc: 'atDel', permission: 'master' },
        { reg: CMD.atShow.pattern, fnc: 'atShow', permission: 'master' },
        { reg: CMD.filterCmd.pattern, fnc: 'filterCmd', permission: 'master' },
        { reg: CMD.filterShow.pattern, fnc: 'filterShow', permission: 'master' },
        { reg: CMD.filterClear.pattern, fnc: 'filterClear', permission: 'master' },
        { reg: CMD.roomInfo.pattern, fnc: 'roomInfo' },
        { reg: CMD.listSubs.pattern, fnc: 'listSubs' },
        { reg: CMD.helpCmd.pattern, fnc: 'showHelp' }
      ]
    })
  }

  /* ================= 订阅 ================= */

  subBiliNews (e) { return doSubscribe(e, 'bilibili', 'news') }
  subBiliLive (e) { return doSubscribe(e, 'bilibili', 'live') }
  subWeibo (e) { return doSubscribe(e, 'weibo', 'news') }

  unsubBiliNews (e) { return doUnsubscribe(e, 'bilibili', 'news') }
  unsubBiliLive (e) { return doUnsubscribe(e, 'bilibili', 'live') }
  unsubWeibo (e) { return doUnsubscribe(e, 'weibo', 'news') }

  /* ================= 设置 ================= */

  /**
   * #推送@全体 [直播|动态] 1017
   *
   * 按「对象 + 类型」设置 @全体，直播和动态可以分开配：
   *   #推送@全体 直播 1017      只对直播 @全体
   *   #推送@全体 动态 1017      只对动态 @全体
   *   #推送@全体 1017           直播+动态都 @（省事写法）
   *
   * 冷却也是按类型独立算的，互不影响。
   */
  async atAllAdd (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const parsed = parseAtAllArgs(e.msg)
    if (!parsed) {
      return e.reply('用法：\n#推送@全体 直播 1017    只对直播\n#推送@全体 动态 1017    只对动态\n#推送@全体 1017         直播+动态都 @')
    }

    const sub = await resolveAtSubject(parsed.id)
    const keys = pickAtAllKeys(sub, parsed.type)

    // 微博没有直播，明确拒绝而不是静默写一个用不上的 key
    if (!keys.length) {
      return e.reply('微博没有直播推送，用「动态」即可：\n#推送@全体 动态 2700162334')
    }

    const cfg = await getGroupConfig(scope.gid)
    const list = { ...(typeof cfg.atAll === 'object' && cfg.atAll ? cfg.atAll : {}) }
    for (const k of keys) list[k] = true
    await setGroupConfig(scope.gid, 'atAll', list)

    const types = keys.map(k => typeTextOf(k, sub.site))
    return e.reply(`已设置：${sub.name} 的${types.join('、')}推送时 @全体成员\n（各类型冷却独立，2 小时内只会 @ 一次）`)
  }

  /**
   * #取消@全体 [直播|动态] 1017
   */
  async atAllDel (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const parsed = parseAtAllArgs(e.msg)
    if (!parsed) return e.reply('用法：#取消@全体 直播 1017')

    const sub = await resolveAtSubject(parsed.id)
    const keys = pickAtAllKeys(sub, parsed.type)
    if (!keys.length) return e.reply('微博没有直播推送，用「动态」即可：\n#取消@全体 动态 2700162334')

    const cfg = await getGroupConfig(scope.gid)
    const list = { ...(typeof cfg.atAll === 'object' && cfg.atAll ? cfg.atAll : {}) }

    const hit = keys.filter(k => list[k])
    if (!hit.length) return e.reply(`${sub.name} 不在 @全体 名单里`)
    for (const k of hit) delete list[k]
    await setGroupConfig(scope.gid, 'atAll', list)

    const types = hit.map(k => typeTextOf(k, sub.site))
    return e.reply(`已取消：${sub.name} 的${types.join('、')}推送不再 @全体`)
  }

  /**
   * #查看@全体
   *
   * 列出本群所有 @全体 配置，按平台和类型分好，一眼能看出哪个是直播哪个是动态。
   */
  async atAllShow (e) {
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const cfg = await getGroupConfig(scope.gid)
    const atAll = cfg.atAll && typeof cfg.atAll === 'object' ? cfg.atAll : {}
    const keys = Object.keys(atAll)

    if (!keys.length) {
      return e.reply('本群还没有配置 @全体\n用法：#推送@全体 直播 1017')
    }

    // 按对象聚合：同一个 UID 的直播/动态合并成一行
    const byUid = new Map()
    for (const k of keys) {
      const parts = String(k).split(':')
      if (parts.length < 3) continue
      const [site, type, uid] = parts
      const id = `${site}:${uid}`
      if (!byUid.has(id)) byUid.set(id, { site, uid, types: [] })
      byUid.get(id).types.push(type)
    }

    const lines = ['本群 @全体 名单：']
    for (const { site, uid, types } of byUid.values()) {
      const bucketSite = site
      const name = (await getSubs(bucketSite, 'live'))?.[uid]?.name ||
        (await getSubs(bucketSite, 'news'))?.[uid]?.name || uid
      const typeNames = types.map(t => (t === 'live' ? '直播' : (site === 'weibo' ? '微博' : '动态')))
      lines.push(`  ${name}（${uid}） → ${typeNames.join(' + ')}`)
    }

    lines.push('', '改法：#推送@全体 直播 1017 / #取消@全体 动态 1017')
    return e.reply(lines.join('\n'))
  }

  /* ================= @特定成员 ================= */

  /** #@成员 1017 12345678 */
  async atAdd (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    return setAtMembers(e, 'add')
  }

  /** #取消@成员 1017 12345678 */
  async atDel (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    return setAtMembers(e, 'remove')
  }

  /** #查看@成员 */
  async atShow (e) {
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const cfg = await getGroupConfig(scope.gid)
    const at = cfg.at && typeof cfg.at === 'object' ? cfg.at : {}
    const keys = Object.keys(at)
    if (!keys.length) return e.reply('本群还没有配置 @特定成员\n用法：#@成员 1017 12345678')

    const lines = ['本群 @特定成员：']
    for (const key of keys) {
      const name = await nameOfAtKey(key)
      lines.push(`  ${name} → ${at[key].join('、')}`)
    }
    return e.reply(lines.join('\n'))
  }

  /* ================= 动态过滤 ================= */

  /** #动态过滤 253298645 not_type 转发 */
  async filterCmd (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const m = e.msg.match(/动态过滤\s+(\d+)\s+(type|not_type|text|not_text)\s+(.+)$/)
    if (!m) return e.reply('格式不对\n用法：#动态过滤 253298645 not_type 转发')

    const [, uid, op, rest] = m
    const values = rest.trim().split(/\s+/).filter(Boolean)

    // 类型名做个校验，避免打错字后静默失效
    if (op === 'type' || op === 'not_type') {
      const bad = values.filter(v => !DYNAMIC_TYPE_NAMES.includes(v))
      if (bad.length) {
        return e.reply(`不认识的类型：${bad.join('、')}\n可用类型：${DYNAMIC_TYPE_NAMES.join('、')}`)
      }
    }

    try {
      await updateFilter(scope.gid, uid, op, values)
    } catch (err) {
      return e.reply(`设置失败：${err.message}`)
    }

    const label = { type: '只推类型', not_type: '不推类型', text: '只推含关键字', not_text: '不推含关键字' }[op]
    return e.reply(`已设置 ${uid} 的过滤：${label} → ${values.join('、')}`)
  }

  /** #动态过滤 253298645 show */
  async filterShow (e) {
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const uid = e.msg.match(/动态过滤\s+(\d+)/)?.[1]
    const rule = await readFilter(scope.gid, uid)
    const subs = await getSubs('bilibili', 'news')
    const name = subs[uid]?.name || uid
    return e.reply(`${name}（${uid}）的过滤规则：\n${describeFilter(rule)}`)
  }

  /** #动态过滤 253298645 clear */
  async filterClear (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const uid = e.msg.match(/动态过滤\s+(\d+)/)?.[1]
    await updateFilter(scope.gid, uid, 'clear')
    return e.reply(`已清空 ${uid} 的过滤规则（恢复全部推送）`)
  }

  /* ================= 按 UP 开关 ================= */

  /**
   * #关闭下播推送 1017
   *
   * 按 UP 单独控制下播推送，默认开。
   * 删除这个 UP 的配置行就恢复默认（开）。
   */
  async offlineNotify (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    return switchNotify(e, 'offlineNotify', '下播推送')
  }

  /**
   * #关闭改标题推送 1017
   */
  async titleNotify (e) {
    if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
    return switchNotify(e, 'titleNotify', '改标题推送')
  }

  /* ================= 直播间查询 ================= */

  /**
   * #直播间 1017
   *
   * 输出直播间状态 + 最近弹幕（版式对齐旧模板）。
   * 弹幕靠临时连一次 WS 收集几秒，收完就断开，不常驻。
   */
  async roomInfo (e) {
    const roomId = e.msg.match(/(\d+)/)?.[1]
    if (!roomId) {
      return e.reply('请输入直播间号\n用法：#直播间 房间号\n例如：#直播间 1017')
    }

    const { fetchRoomInfo, collectDanmu, formatRoomReport } = await import('./lib/room-info.js')

    // 拿 Cookie（房间基础信息用得上；弹幕那步故意走匿名态）
    let cookie = ''
    try {
      const ck = await import('./lib/render/cookies.js')
      cookie = ck.BILI_COOKIE() || ''
    } catch {}

    let info
    try {
      info = await fetchRoomInfo(roomId, cookie)
    } catch (err) {
      logger.error('[订阅推送] 直播间查询失败', err)
      return e.reply(`查询失败：${err.message}`)
    }

    // 弹幕最多收 20 秒：不同直播间弹幕密度差异极大，冷清房间（哪怕在线千人）
    // 也可能一条都不发。热闹房间会因 earlyStop（收够 5 条 + 拿到人数）提前退出。
    const danmuResult = await collectDanmu(roomId, {
      duration: 20000,
      limit: 15,
      earlyStop: 5
    }).catch(() => ({ danmu: [], online: null, connected: false }))

    const { head, tail } = formatRoomReport(info, danmuResult)

    // 直播卡（复用渲染引擎，随机样式）—— 插在「封面：」后面
    let buf = null
    try {
      const { renderBiliLive } = await import('./lib/render/live.js')
      const isLive = info.status === 1
      buf = await renderBiliLive(info.roomId, {
        liveState: isLive ? 0 : 1,
        timestamp: isLive ? '' : String(Math.floor(Date.now() / 1000)),
        qr: isLive,
        content: true,
        ...pickLiveStyle()
      })
    } catch (err) {
      logger.warn('[订阅推送] 直播间卡片渲染失败，只发文字', err?.message)
    }

    if (!buf) return e.reply(`${head}\n${tail}`)
    return e.reply([`${head}\n`, segment.image(buf), `\n${tail}`])
  }

  /* ================= 订阅列表（所有人可用）================= */

  /**
   * #订阅列表
   *
   * 转图输出本群订阅。私聊要带 -g 群号。
   * 渲染失败退回纯文字，保证命令永远有响应。
   */
  async listSubs (e) {
    const scope = resolveGroupScope(e)
    if (!scope.ok) return e.reply(NEED_GROUP_HINT)

    const subs = await getSiteSubs()
    const gid = scope.gid

    try {
      const { renderSubscriptionList } = await import('./lib/list-render.js')
      const buf = await renderSubscriptionList(subs, gid)
      if (buf) return e.reply(segment.image(buf))
    } catch (err) {
      logger.error('[订阅推送] 订阅列表转图失败，退回文字', err)
    }

    // ---- 兜底：纯文字 ----
    const lines = []
    for (const site of allSites()) {
      for (const type of ['live', 'news']) {
        const bucket = subs[site]?.[type] || {}
        const mine = Object.entries(bucket)
          .filter(([, rec]) => Array.isArray(rec.groups) && rec.groups.includes(gid))
        if (!mine.length) continue
        lines.push(`【${SITE_NAME[site]}${TYPE_NAME[type]}】${mine.length} 个`)
        for (const [uid, rec] of mine) {
          lines.push(`  · ${rec.name || uid}${rec.name ? `（${uid}）` : ''}`)
        }
      }
    }

    if (!lines.length) return e.reply('本群还没有任何订阅')
    return e.reply(['本群订阅：', ...lines].join('\n'))
  }

  /* ================= 帮助（所有人可用）================= */

  /**
   * #订阅帮助
   *
   * 优先出图；渲染失败退回纯文字，保证命令永远有响应。
   */
  async showHelp (e) {
    try {
      const { renderHelp } = await import('./lib/help-render.js')
      const buf = await renderHelp()
      if (buf) return e.reply(segment.image(buf))
    } catch (err) {
      logger.error('[订阅推送] 帮助转图失败，退回文字', err)
    }

    return e.reply(buildHelpText())
  }
}

/* ================= 内部实现 ================= */

/**
 * 纯文字帮助（转图失败时的兜底）
 *
 * 内容和图片版保持一致，只是排版成文本。
 */
function buildHelpText () {
  return [
    '订阅推送命令（全中文）',
    '',
    '【所有人可用】',
    '#订阅列表        看本群订阅了谁（转图）',
    '#订阅帮助        这条命令本身',
    '#直播间 1017    查直播间状态 + 最近弹幕',
    '',
    '【订阅】',
    '#订阅动态 253298645     订阅B站UP主动态',
    '#订阅直播 1017          订阅B站直播（房间号或UID都行）',
    '#订阅微博 2700162334    订阅微博博主',
    '',
    '【取消】',
    '#取消订阅动态 253298645',
    '#取消订阅直播 1017',
    '#取消订阅微博 2700162334',
    '',
    '【推送开关】（按 UP 单独设，默认全部推送）',
    '#开启下播推送 / #关闭下播推送 1017',
    '#开启改标题推送 / #关闭改标题推送 1017',
    '',
    '【艾特全体】（直播/动态可分开设）',
    '#推送@全体 直播 1017        只对直播 @全体',
    '#推送@全体 动态 253298645   只对动态 @全体',
    '#推送@全体 1017             两类都 @',
    '#取消@全体 直播 1017        取消对应类型',
    '#查看@全体                  看本群配了哪些',
    '各类型冷却独立，2 小时内只 @ 一次；需要机器人为群管理员。',
    '',
    '【艾特指定成员】（@全体失效时兜底）',
    '#@成员 1017 12345678',
    '#取消@成员 1017 12345678',
    '#查看@成员',
    '',
    '【动态过滤】',
    '#动态过滤 253298645 not_type 转发    不推转发动态',
    '#动态过滤 253298645 type 投稿 专栏   只推这两类',
    '#动态过滤 253298645 not_text 抽奖 广告',
    '#动态过滤 253298645 show / clear',
    '可用类型：转发 投稿 专栏 文字 图片 音频 直播分享',
    '',
    '【私聊】所有命令后面加 -g 群号 即可操作指定群',
    '  例如：#订阅直播 1017 -g 123456789',
    '',
    '首次订阅只记录当前状态作为基线，不会补发历史内容。'
  ].join('\n')
}

/**
 * 解析「在哪个群操作」
 *
 * 群聊里就是当前群；私聊必须用 -g <群号> 指定，对齐 DDBOT 的做法。
 *
 * @returns {{ ok: boolean, gid?: string, needSpecify?: boolean }}
 */
function resolveGroupScope (e) {
  if (e.isGroup) return { ok: true, gid: String(e.group_id) }

  // 私聊：从消息里找 -g 群号
  const m = String(e.msg || '').match(/-g\s*(\d{5,})/)
  if (m) return { ok: true, gid: m[1] }

  return { ok: false, needSpecify: true }
}

/** 私聊没指定群号时的统一提示 */
const NEED_GROUP_HINT = '私聊使用需要指定群号\n在命令后面加 -g 群号\n例如：#订阅直播 1017 -g 123456789'

/**
 * 解析 #推送@全体 / #取消@全体 的参数
 *
 * 支持两种写法：
 *   #推送@全体 直播 1017   → { type: 'live', id: '1017' }
 *   #推送@全体 1017        → { type: null,   id: '1017' }（两类都设）
 */
function parseAtAllArgs (msg) {
  const m = String(msg || '').match(/@全体\s*(直播|动态)?\s*(\d+)/)
  if (!m) return null
  const typeMap = { 直播: 'live', 动态: 'news' }
  return {
    type: m[1] ? typeMap[m[1]] : null,
    id: m[2]
  }
}

/**
 * 按类型挑出要操作的 key
 *
 * 关键：用户指定了类型就直接用，不拿「这个号订阅了哪些类型」去过滤。
 * 否则填房间号时（解析出来只有 live）配动态会被过滤成空。
 *
 *   指定了类型 → [site:type:uid]
 *   没指定     → 按订阅情况展开（见 atAllKeysFor）
 */
function pickAtAllKeys (sub, type) {
  if (type) {
    if (sub.site === 'weibo' && type === 'live') return []
    return [atAllKey(sub.site, type, sub.uid)]
  }
  return atAllKeysFor(sub)
}

/** key 里的类型 → 中文 */
function typeTextOf (key, site) {
  const t = String(key).split(':')[1]
  if (t === 'live') return '直播'
  return site === 'weibo' ? '微博' : '动态'
}

/**
 * 把一个对象展开成它的全部 @全体 key
 *
 * 直播和动态各自独立冷却，所以一个 B站 UID 可能对应两个 key。
 * 按「这个号实际订阅了什么」来决定展开几个：
 *   订阅了直播+动态 → ['bilibili:live:UID', 'bilibili:news:UID']
 *   只订阅直播     → ['bilibili:live:UID']
 *   只订阅动态     → ['bilibili:news:UID']
 *   都没订阅       → 两个都给（先把名单配好，等订阅生效自然起作用）
 */
function atAllKeysFor (sub) {
  const { site, uid } = sub

  if (site === 'weibo') return [atAllKey('weibo', 'news', uid)]

  const types = sub.types && sub.types.length ? sub.types : ['live', 'news']
  return types.map(t => atAllKey('bilibili', t, uid))
}

/**
 * 把用户输入的号解析成「@全体 名单」用的对象
 *
 * 顺序：
 *   1. 已在 B站 订阅表里（动态或直播）→ bilibili，types 记录订阅了哪几类
 *   2. 已在微博订阅表里 → weibo
 *   3. 都没订阅过 → 当直播间号查一下，查得到就是 bilibili
 *   4. 实在查不到 → 按 bilibili 存（让用户至少能先配上，之后订阅生效）
 *
 * @returns {{ site: string, uid: string, name: string, scopeText: string, types: string[] }}
 */
async function resolveAtSubject (raw) {
  const id = String(raw)

  // 1) B站 订阅表：可能同时订阅了直播和动态，两类都要记下来
  const liveBucket = await getSubs('bilibili', 'live')
  const newsBucket = await getSubs('bilibili', 'news')
  const hasLive = !!liveBucket?.[id]
  const hasNews = !!newsBucket?.[id]

  if (hasLive || hasNews) {
    const types = []
    if (hasLive) types.push('live')
    if (hasNews) types.push('news')
    const name = liveBucket?.[id]?.name || newsBucket?.[id]?.name || id
    const scopeText = types.map(t => (t === 'live' ? '直播' : '动态')).join('+')
    return { site: 'bilibili', uid: id, name, scopeText, types }
  }

  // 2) 微博订阅表
  const weibo = await getSubs('weibo', 'news')
  if (weibo?.[id]) {
    return { site: 'weibo', uid: id, name: weibo[id].name || id, scopeText: '微博', types: ['news'] }
  }

  // 3) 没订阅过，按直播间号试试（房间号 → UID）
  const r = await resolveLiveForAt(id)
  if (r.roomId) {
    const live = await getSubs('bilibili', 'live')
    const news = await getSubs('bilibili', 'news')
    const uid = r.uid

    // 房间号解析出 UID 后，这个 UID 可能也订阅了动态，类型要按实际订阅情况来
    const types = []
    if (live?.[uid]) types.push('live')
    if (news?.[uid]) types.push('news')
    if (!types.length) types.push('live')

    const name = live?.[uid]?.name || news?.[uid]?.name || r.name || `直播间 ${r.roomId}`
    const scopeText = types.map(t => (t === 'live' ? '直播' : '动态')).join('+')

    return { site: 'bilibili', uid, name, scopeText, types }
  }

  // 4) 兜底当 B站 UID：直播+动态都配上，订阅生效后自然起作用
  return { site: 'bilibili', uid: r.uid || id, name: id, scopeText: '', types: ['live', 'news'] }
}

/**
 * 按 UP 开关「下播推送 / 改标题推送」
 *
 * 命令形如：#关闭下播推送 1017
 * 状态存在群配置的同名字段里：{ "UP的UID": false }
 */
async function switchNotify (e, key, label) {
  const scope = resolveGroupScope(e)
  if (!scope.ok) return e.reply(NEED_GROUP_HINT)

  const m = e.msg.match(/(开启|关闭)\S*?\s*(\d+)/) || e.msg.match(/(\d+)/)
  const on = /开启/.test(e.msg)
  const rawId = (e.msg.match(/(\d+)/) || [])[1]
  if (!rawId) return e.reply(`请指定 UP 主\n用法：#关闭${label} 1017`)

  const { uid } = await resolveLiveForAt(rawId)
  await setNotifySwitch(scope.gid, key, uid, on)

  const subs = await getSubs('bilibili', 'live')
  const name = subs[uid]?.name || uid
  return e.reply(`${name} 的${label}已${on ? '开启' : '关闭'}`)
}

/**
 * 把「@全体/@成员」的 key 还原成可读名字
 *
 * key 形如 bilibili:253298645 / weibo:2700162334
 */
async function nameOfAtKey (key) {
  const parts = String(key).split(':')
  if (parts.length < 3) {
    // 兼容旧格式 site:uid
    const [site, uid] = parts
    if (!uid) return key
    const live = await getSubs('bilibili', site === 'weibo' ? 'live' : 'live')
    const news = await getSubs(site, 'news')
    const name = live?.[uid]?.name || news?.[uid]?.name || uid
    return `${name}（${uid}）`
  }

  const [site, type, uid] = parts
  const bucket = await getSubs(site, type)
  const name = bucket?.[uid]?.name || uid
  const typeText = type === 'live' ? '直播' : (site === 'weibo' ? '微博' : '动态')
  return `${name}（${typeText} ${uid}）`
}

/**
 * 增删 @特定成员
 *
 * 存在群配置的 at 字段里：{ "bilibili:UP的UID": ["QQ号", ...] }
 * key 带平台前缀，和 @全体 保持一致。
 */
async function setAtMembers (e, mode) {
  const scope = resolveGroupScope(e)
  if (!scope.ok) return e.reply(NEED_GROUP_HINT)

  const m = e.msg.match(/(\d+)\s+((?:\d+\s*)+)$/)
  if (!m) {
    return e.reply('格式不对\n用法：#@成员 1017 12345678\n可以一次填多个 QQ： #@成员 1017 1111 2222')
  }

  const rawId = m[1]
  const qqs = m[2].trim().split(/\s+/).filter(v => /^\d{5,}$/.test(v))
  if (!qqs.length) return e.reply('请填写有效的 QQ 号')

  const sub = await resolveAtSubject(rawId)
  // @成员 也按类型分开存，和 @全体 的 key 格式保持一致
  const keys = atAllKeysFor(sub)

  const cfg = await getGroupConfig(scope.gid)
  const all = { ...(cfg.at && typeof cfg.at === 'object' ? cfg.at : {}) }

  for (const key of keys) {
    const cur = new Set(all[key] || [])
    if (mode === 'add') {
      for (const q of qqs) cur.add(q)
    } else {
      for (const q of qqs) cur.delete(q)
    }
    if (cur.size) all[key] = [...cur]
    else delete all[key]
  }
  await setGroupConfig(scope.gid, 'at', all)

  // 回显：列出主 key 上的人员
  const mainKey = keys[0]
  const list = all[mainKey] || []

  return e.reply(mode === 'add'
    ? `已设置：${sub.name} 推送时 @ ${list.join('、') || qqs.join('、')}`
    : (list.length ? `已更新：${sub.name} 推送时 @ ${list.join('、')}` : `已清空：${sub.name} 不再 @任何人`))
}

/**
 * 随机挑一个直播卡样式（4 选 1）
 *
 * 只有 live4 支持横竖版切换（竖版按实际内容宽收视口），其余固定 view=0。
 */
function pickLiveStyle () {
  const templates = ['live1', 'live2', 'live3', 'live4']
  const template = templates[Math.floor(Math.random() * templates.length)]
  const view = template === 'live4' ? Math.floor(Math.random() * 2) : 0
  return { template, view }
}

async function doSubscribe (e, site, type) {
  const scope = resolveGroupScope(e)
  if (!scope.ok) return e.reply(NEED_GROUP_HINT)

  const raw = e.msg.match(/(\d+)/)?.[1]
  if (!raw) {
    return e.reply(`请带上要订阅的${SITE_NAME[site]}${TYPE_NAME[type]}号，例如：${CMD[`sub${site === 'weibo' ? 'Weibo' : (type === 'live' ? 'BiliLive' : 'BiliNews')}`].desc}`)
  }

  if (!booted) await boot()

  // 直播订阅：批量状态接口按 UID 查，所以主键必须是 UID，
  // 房间号（用户可能填短号）作为附加字段存起来供渲染使用。
  let uid = raw
  let extra = {}
  if (site === 'bilibili' && type === 'live') {
    const resolved = await resolveLive(raw)
    uid = resolved.uid
    extra = { roomId: resolved.roomId, ...(resolved.name ? { name: resolved.name } : {}) }
  }

  try {
    const rec = await addSub({
      site,
      type,
      uid,
      group: scope.gid,
      name: extra.name || '',
      extra
    })
    const shown = rec.name ? `${rec.name}（UID ${uid}）` : `UID ${uid}`
    return e.reply([
      `已订阅 ${SITE_NAME[site]}${TYPE_NAME[type]}：${shown}`,
      '首次订阅只建立基线，不会补发历史内容。'
    ].join('\n'))
  } catch (err) {
    if (err.code === 'DUPLICATE') return e.reply(`该群已经订阅过 ${uid} 了`)
    logger.error('[订阅推送] 订阅失败', err)
    return e.reply(`订阅失败：${err.message}`)
  }
}

async function doUnsubscribe (e, site, type) {
  const scope = resolveGroupScope(e)
  if (!scope.ok) return e.reply(NEED_GROUP_HINT)

  const id = e.msg.match(/(\d+)/)?.[1]
  if (!id) return e.reply(`请带上要取消的号，例如：${CMD[`unsub${site === 'weibo' ? 'Weibo' : (type === 'live' ? 'BiliLive' : 'BiliNews')}`].desc}`)

  const ok = await removeSub({ site, type, uid: id, group: scope.gid })
  return e.reply(ok
    ? `已取消订阅 ${SITE_NAME[site]}${TYPE_NAME[type]}：${id}`
    : `该群没有订阅过 ${id}`)
}

async function toggle (e, key, label) {
  if (!e.isMaster) return e.reply('只有主人可以修改推送设置')
  const scope = resolveGroupScope(e)
  if (!scope.ok) return e.reply(NEED_GROUP_HINT)

  const on = !/关闭/.test(e.msg)
  const ok = await setGroupConfig(scope.gid, key, on)
  return e.reply(ok ? `${label}已${on ? '开启' : '关闭'}` : '操作失败')
}

/**
 * 解析直播订阅参数，返回 { uid, roomId, name }
 *
 * 用户可能填直播间号，也可能填 UP 主 UID，这里统一换成 UID + 房间号：
 *   - 先按房间号查 get_info，能拿到房间信息就同时得到 uid 和 room_id
 *   - 查不到（说明填的可能就是 UID）就按 UID 反查直播间
 */
async function resolveLive (raw) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

  // 1) 当作房间号查
  try {
    const r = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(raw)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' },
      signal: AbortSignal.timeout(10000)
    })
    const j = await r.json()
    if (j?.code === 0 && j.data) {
      return {
        uid: String(j.data.uid || raw),
        roomId: String(j.data.room_id || raw),
        name: ''
      }
    }
  } catch {}

  // 2) 当作 UID，用批量接口反查房间
  try {
    const r = await fetch('https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://live.bilibili.com/' },
      body: JSON.stringify({ uids: [Number(raw)] }),
      signal: AbortSignal.timeout(10000)
    })
    const j = await r.json()
    const info = j?.data?.[raw]
    if (j?.code === 0 && info) {
      return {
        uid: String(info.uid || raw),
        roomId: String(info.room_id || ''),
        name: info.uname || ''
      }
    }
  } catch {}

  // 3) 都失败，原样当 UID 存
  return { uid: String(raw), roomId: '', name: '' }
}

/**
 * @全体 名单用的解析
 *
 * 和 resolveLive 是同一套逻辑，只是语义更明确：
 * 参数可能是房间号也可能是 UID，统一换成 UID（因为推送事件的 evt.uid 是 UID）。
 * 解析失败时返回 uid（原样），让调用方按 UID 处理，不会因为查不到就不让设置。
 */
async function resolveLiveForAt (raw) {
  const r = await resolveLive(raw)
  return { uid: r.uid || String(raw), roomId: r.roomId || '' }
}

// 插件加载即启动
boot().catch(e => logger.error('[订阅推送] 初始化失败', e))

export default SubscribePush
