/**
 * 推送层：把发现的内容渲染成图，发到订阅了它的群
 *
 * 渲染直接调用内置的 lib/render/（原渲染模块），不走 HTTP、不落盘，
 * 少一次 PNG 写盘和之后的一小时清理：
 *   - B站直播   renderBiliLive(roomId, {...})
 *   - B站动态   renderBiliDynamicWeb(url, {...})
 *   - 微博动态  renderWeiboDynamic(url, {...})
 *
 * 一个博主被 N 个群订阅时，图只渲染一次，然后复用到每个群——
 * 这是关键优化，否则多群订阅会把服务器打爆。
 */

import { getSubs, getGroupConfig, patchSub, tryAcquireAtAll, getMeta, notifySwitchOn, atAllKey } from './store.js'
import { shouldPushDynamic, updateFilter, readFilter, describeFilter } from './filter.js'

/**
 * 推送入口（轮询器回调）
 */
export async function pushNotify (payload) {
  switch (payload.type) {
    case 'live':
      return pushLive(payload)
    case 'news':
      return payload.site === 'weibo' ? pushWeiboNews(payload) : pushBiliNews(payload)
    default:
      logger.warn(`[订阅推送] 未知推送类型：${payload.type}`)
  }
}

/**
 * 单个直播事件推送入口（WebSocket 回调）
 *
 * WS 一次只给一个事件，和轮询的批量 payload 结构不同，所以单独一个入口。
 * 内部复用 pushLive，把单事件包成 events 数组即可。
 */
export async function pushLiveEvent (evt) {
  return pushLive({ site: 'bilibili', type: 'live', events: [evt] })
}

/* ================= B站动态 ================= */

async function pushBiliNews ({ items }) {
  const subs = await getSubs('bilibili', 'news')
  if (!items?.length) return

  const { renderBiliDynamicWeb } = await import('./render/dynamic.js')

  // 按作者分组：同一 UP 的多条动态合成一条消息，避免刷屏
  const byUid = new Map()
  for (const item of items) {
    const author = item?.modules?.module_author
    const uid = String(author?.mid || '')
    const name = author?.name || uid
    const dynId = item.id_str
    if (!uid || !dynId) continue

    // 只有被订阅的 UP 才推送
    if (!subs[uid]) continue

    if (!byUid.has(uid)) byUid.set(uid, { name, items: [] })
    byUid.get(uid).items.push(item)
  }

  for (const [uid, group] of byUid) {
    const record = subs[uid]
    const targets = record.groups

    // 每个动态单独渲染（渲染层是按 URL 截网页的）
    const rendered = []
    for (const item of group.items.slice(0, 3)) { // 同一 UP 最多 3 条，防刷屏
      const url = `https://t.bilibili.com/${item.id_str}`
      try {
        const buf = await renderBiliDynamicWeb(url, { expand: true, atCard: true, linkQr: true })
        rendered.push({ item, buf })
      } catch (err) {
        logger.error(`[订阅推送] B站动态渲染失败 ${item.id_str}`, err)
        rendered.push({ item, buf: null })
      }
    }

    if (!rendered.length) continue

    for (const groupId of targets) {
      const cfg = await getGroupConfig(groupId)

      // @全体：只看这个 UP 的「动态」是否单独配过，不继承直播的配置。
      // 直播和动态是两类独立的推送，配置和冷却都各算各的。
      const key = atAllKey('bilibili', 'news', uid)
      const inAtAllList = !!(cfg.atAll && typeof cfg.atAll === 'object' && cfg.atAll[key])
      const shouldAtAll = inAtAllList ? await tryAcquireAtAll(groupId, key) : false
      const atList = cfg.at?.[key]

      // 动态过滤：按群 + 按 UP 单独配置
      const rule = cfg.filter?.[uid]
      for (const { item, buf } of rendered) {
        if (rule) {
          const { pass, reason } = shouldPushDynamic(item, rule)
          if (!pass) {
            logger.debug?.(`[订阅推送] 动态被过滤 ${item.id_str}：${reason}`)
            continue
          }
        }
        const { head, tail } = buildBiliNewsMessage(group.name, item)
        await sendToGroup(groupId, head, buf, { ...cfg, atAll: shouldAtAll, at: atList }, tail)
      }
    }
  }
}

/**
 * 动态消息拆成两段，严格对齐原模板 notify.group.bilibili.news.tmpl
 *
 * 原模板的分支（按 .dynamic.Type）：
 *   Type 8     视频：转发视频 / 动态视频 / 普通视频，链接优先取 bvid
 *   Type 4200/4308  直播：分享直播 / 发布直播信息，链接去掉 ?live_from
 *   Type 2/4/1 图文/文字动态：转发 or 发布
 *   其它       未知类型：转发 or 发布
 *
 * 输出格式（原模板 196-206 行）：
 *   {{ $msg }}
 *   发布时间：{{ .dynamic.Date }}      ← 你要求去掉这行
 *   {{ pic }}                         ← 有图才输出
 *   {{ $link }}
 *
 * 注意：原模板**没有标题**，只有 $msg 一行描述。之前我加的 title 是多出来的。
 */
function buildBiliNewsMessage (name, item) {
  const { msg, link } = describeDynamic(item, name)
  return { head: msg, tail: link }
}

/**
 * 把动态转成人话 —— 逐分支复刻原模板
 *
 * 返回 { msg, link }：
 *   msg  对应模板里的 $msg
 *   link 对应模板里的 $link（部分分支会改写，比如视频改成 bvid 链接）
 *
 * 原模板的判断依据是 **旧版 Card 的数字 Type**，而这里拿到的是新版
 * DYNAMIC_TYPE_xxx 字符串，所以先做一次映射（对齐 mapWebDynamicType）：
 *   8    → 视频（DYNAMIC_TYPE_AV / 带 archive 的 DRAW）
 *   4200 → DYNAMIC_TYPE_LIVE
 *   4308 → DYNAMIC_TYPE_LIVE_RCMD
 *   2/1  → DYNAMIC_TYPE_DRAW（图文）
 *   4    → DYNAMIC_TYPE_WORD（纯文字）
 */
function describeDynamic (item, selfName = '') {
  const typeNum = legacyTypeOf(item)
  const isForward = !!item?.orig
  const origName = item?.orig?.modules?.module_author?.name || ''
  const self = selfName || item?.modules?.module_author?.name || ''
  const dynUrl = `https://t.bilibili.com/${item?.id_str || ''}`

  /* ---- Type 8：视频 ---- */
  if (typeNum === 8) {
    const major = item?.modules?.module_dynamic?.major
    const archive = major?.archive
    const isDynamicVideo = isDynamicVideoPost(item)

    if (isForward) {
      if (isDynamicVideo) {
        return {
          msg: origName === self
            ? `${self} 转发了自己的动态视频`
            : `${self} 转发了 ${origName} 的动态视频`,
          link: dynUrl
        }
      }
      return {
        msg: origName === self
          ? `${self} 转发了自己的视频`
          : `${self} 转发了 ${origName} 的视频`,
        link: dynUrl
      }
    }

    if (isDynamicVideo) {
      return { msg: `${self} 发布了动态视频`, link: videoLink(archive, dynUrl) }
    }
    return { msg: `${self} 发布了新投稿视频`, link: videoLink(archive, dynUrl) }
  }

  /* ---- Type 4200 / 4308：直播 ---- */
  if (typeNum === 4200 || typeNum === 4308) {
    if (isForward) {
      if (origName === self) {
        return { msg: `${self} 分享了自己的直播`, link: stripQuery(liveJumpUrl(item?.orig)) || dynUrl }
      }
      return { msg: `${self} 分享了 ${origName} 的直播`, link: dynUrl }
    }
    return { msg: `${self} 发布了直播信息`, link: stripQuery(liveJumpUrl(item)) || dynUrl }
  }

  /* ---- Type 2 / 4 / 1：图文 / 文字动态 ---- */
  if (typeNum === 2 || typeNum === 4 || typeNum === 1) {
    if (isForward) {
      return {
        msg: origName === self
          ? `${self} 转发了自己的动态`
          : `${self} 转发了 ${origName} 的动态`,
        link: dynUrl
      }
    }
    return { msg: `${self} 发布了新动态`, link: dynUrl }
  }

  /* ---- 其它未知类型 ---- */
  if (isForward) {
    return {
      msg: origName === self
        ? `${self} 转发了自己的动态`
        : `${self} 转发了 ${origName} 的动态`,
      link: dynUrl
    }
  }
  return { msg: `${self} 发布了新动态`, link: dynUrl }
}

/**
 * 新版 type 字符串 → 旧版 Card 数字 Type
 * 对齐 dynamic_lite.go 的 mapWebDynamicType
 */
function legacyTypeOf (item) {
  const t = item?.type || ''
  const major = item?.modules?.module_dynamic?.major

  switch (t) {
    case 'DYNAMIC_TYPE_AV': return 8
    case 'DYNAMIC_TYPE_DRAW': return major?.archive ? 8 : 2
    case 'DYNAMIC_TYPE_WORD': return 4
    case 'DYNAMIC_TYPE_ARTICLE': return 1
    case 'DYNAMIC_TYPE_MUSIC': return 1
    case 'DYNAMIC_TYPE_FORWARD': {
      // 转发的是视频 → 按视频模板走，其余按动态
      const orig = item?.orig
      if (!orig) return 2
      const origMajor = orig?.modules?.module_dynamic?.major
      if (orig?.type === 'DYNAMIC_TYPE_AV' || origMajor?.archive) return 8
      if (orig?.type === 'DYNAMIC_TYPE_LIVE' || orig?.type === 'DYNAMIC_TYPE_LIVE_RCMD') return 4200
      return 2
    }
    case 'DYNAMIC_TYPE_LIVE': return 4200
    case 'DYNAMIC_TYPE_LIVE_RCMD': return 4308
    default: return 0
  }
}

/**
 * 判断「动态视频」还是「投稿视频」
 *
 * 原模板看 .dynamic.Video.Action == "发布了动态"，
 * 新版里 opus + archive 同时存在就是动态视频，只有 archive 是投稿视频。
 */
function isDynamicVideoPost (item) {
  const major = item?.modules?.module_dynamic?.major
  return !!(major?.opus && major?.archive)
}

/** 视频链接优先用 bvid（对齐原模板 Detail.Archive.JumpUrl / bvid 逻辑） */
function videoLink (archive, fallback) {
  const jump = archive?.jump_url || ''
  if (jump) return jump.startsWith('//') ? 'https:' + jump : jump
  const bvid = archive?.bvid || ''
  if (bvid) return `https://www.bilibili.com/video/${bvid}`
  return fallback
}

/** 取直播跳转链接（跳转字段可能在 major.live 里） */
function liveJumpUrl (item) {
  const major = item?.modules?.module_dynamic?.major
  const live = major?.live || major?.live_rcmd
  if (!live) return ''
  let jump = live.jump_url || ''
  // live_rcmd 里是 JSON 字符串，需要解出来
  if (!jump && live.content) {
    try {
      jump = JSON.parse(live.content)?.live_play_info?.link || ''
    } catch {}
  }
  return jump
}

/** 去掉 ?live_from=xxx 这类追踪参数（对齐原模板 split "?" 逻辑） */
function stripQuery (url) {
  if (!url) return ''
  return String(url).split('?')[0]
}

/* ================= B站直播 ================= */

async function pushLive ({ events }) {
  const subs = await getSubs('bilibili', 'live')
  if (!events?.length) return

  const { renderBiliLive } = await import('./render/live.js')

  for (const evt of events) {
    const record = subs[evt.uid]
    if (!record) continue

    const room = evt.room
    let roomId = String(evt.roomId || room.room_id || record.roomId || '')

    // 迁移过来的老订阅可能只有 UID 没有房间号（当时主播没开播查不到），
    // 这里现查一次并回填，避免因为缺房间号永久跳过这个主播。
    if (!roomId) {
      roomId = await resolveRoomId(evt.uid)
      if (roomId) await patchSub('bilibili', 'live', evt.uid, { roomId })
    }
    if (!roomId) {
      logger.warn(`[订阅推送] 直播事件缺少房间号，跳过（uid=${evt.uid}）`)
      continue
    }
    const name = room.uname || record.name || evt.uid
    const targetGroups = record.groups
    if (!targetGroups.length) continue

    // 先看有没有群真的需要这条——不需要就不用渲染（省一次截图）
    const cfgs = {}
    let anyEnabled = false
    for (const g of targetGroups) {
      const c = await getGroupConfig(g)
      cfgs[g] = c
      if (evt.kind === 'stop' && !notifySwitchOn(c.offlineNotify, evt.uid)) continue
      if (evt.kind === 'retitle' && !notifySwitchOn(c.titleNotify, evt.uid)) continue
      anyEnabled = true
    }
    if (!anyEnabled) continue

    const isLive = evt.kind !== 'stop'

    // 下播卡片要显示「直播时长」，算法是：
    //   时长 = timestamp - info.StartTime（直播间接口给的开播时间）
    // 所以下播时 timestamp 必须传**当前时间**当作下播时刻（这个是对的），
    // 开播时间靠接口返回的 StartTime。
    //
    // 之前 bug：如果 StartTime 拿不到（接口返回空或 0000-00-00），
    // calculateLiveDuration 会退化成 timestamp - timestamp ≈ 0，显示「1 分钟」。
    // 修法：下播时优先用 meta 里 WS 记录的 liveTime（真实开播时刻）兜底。
    // 下播时长要用「真实开播时刻」，按可靠性依次取：
    //   1. meta.liveTime      —— WS 收到 LIVE 时记下的时间
    //   2. meta.lastLiveTime  —— 轮询拿到的接口 live_time（兜底）
    // 取不到就留空，渲染层会退回接口的 StartTime。
    // （之前 liveTime 在下播时被清零，导致这里永远拿不到 → 卡片显示「1 分钟」）
    let stopStartTime = ''
    if (!isLive) {
      const meta = await getMeta('bilibili', 'live')
      const rec = meta[evt.uid] || {}
      const candidate = rec.liveTime || rec.lastLiveTime || 0
      if (candidate && Number(candidate) > 0) {
        stopStartTime = String(candidate)
      }
    }

    let buf = null
    try {
      buf = await renderBiliLive(roomId, {
        liveState: isLive ? 0 : 1,
        timestamp: isLive ? '' : String(Math.floor(Date.now() / 1000)),
        startTimeOverride: stopStartTime,
        qr: isLive,
        content: true,
        ...pickLiveTemplate(isLive)
      })
    } catch (err) {
      logger.error(`[订阅推送] B站直播卡片渲染失败 ${roomId}`, err)
    }

    for (const groupId of targetGroups) {
      const cfg = cfgs[groupId]

      // 下播 / 改标题：按 UP 单独开关，默认开
      if (evt.kind === 'stop' && !notifySwitchOn(cfg.offlineNotify, evt.uid)) continue
      if (evt.kind === 'retitle' && !notifySwitchOn(cfg.titleNotify, evt.uid)) continue

      // @全体：只有【开播】才 @
      // 下播和改标题 @全体没有意义，只会打扰群员——这里直接排除。
      // 冷却仍然按 UP 单独算（对齐 DDBOT：同一主播每 2 小时只 @ 一次）
      const key = atAllKey('bilibili', 'live', evt.uid)
      const inAtAllList = !!(cfg.atAll && typeof cfg.atAll === 'object' && cfg.atAll[key])
      let shouldAtAll = false
      if (evt.kind === 'start' && inAtAllList) {
        shouldAtAll = await tryAcquireAtAll(groupId, key)
        if (!shouldAtAll) {
          logger.debug?.(`[订阅推送] @全体 冷却中，跳过（群 ${groupId} UP ${evt.uid}）`)
        }
      }

      // @特定成员：这个 UP 配了就给，作为 @全体 失效时的兜底
      const atList = cfg.at?.[key]

      const { head, tail } = buildLiveMessage(name, room, evt.kind, roomId)
      await sendToGroup(groupId, head, buf, { ...cfg, atAll: shouldAtAll, at: atList }, tail)
    }
  }
}

/**
 * 直播消息拆成两段：图片上方的文字 + 图片下方的链接
 *
 * 对齐原模板 notify.group.bilibili.live.tmpl：
 *   {{ .name }} 开播了
 *   {{ .title }}
 *   {{ pic $livePic }}
 *   {{ .url }}          ← 链接在图片下面
 */
function buildLiveMessage (name, room, kind, roomId) {
  // 措辞对齐原模板 notify.group.bilibili.live.tmpl：
  //   title_changed → 「改标题啦」
  //   living        → 「开播了」
  //   其他          → 「下播了」
  const map = { start: '开播了', stop: '下播了', retitle: '改标题啦' }
  const head = [`${name} ${map[kind] || '状态变化'}`]
  if (room.title) head.push(room.title)

  // 只有开播带直播间链接。
  // 原模板里改标题和下播的分支都不输出 {{ .url }}，这里保持一致。
  const tail = kind === 'start' && roomId ? `https://live.bilibili.com/${roomId}` : ''
  return { head: head.join('\n'), tail }
}

/**
 * 随机挑一个直播卡样式（还原原模板的 4 选 1）
 *
 * 原 notify.group.bilibili.live.tmpl 的逻辑：
 *   $apis := Live / Live2 / Live3 / Live4
 *   $idx  := roll 0 3          ← 随机 0~3
 *   $view := 0，仅 live4 时再 roll 0 1（横竖版）
 *
 * 这里保持一致：live1~live3 没有横竖版概念，view 固定 0；
 * 只有 live4 才随机横版/竖版。
 */
function pickLiveTemplate () {
  const templates = ['live1', 'live2', 'live3', 'live4']
  const idx = Math.floor(Math.random() * templates.length)
  const template = templates[idx]

  // 只有 live4 支持横竖版切换（竖版按实际内容宽收视口）
  const view = template === 'live4' ? Math.floor(Math.random() * 2) : 0

  logger.debug?.(`[订阅推送] 直播卡样式：${template}${template === 'live4' ? `（${view === 1 ? '竖版' : '横版'}）` : ''}`)
  return { template, view }
}

/* ================= 微博动态 ================= */

async function pushWeiboNews ({ uid, blogs }) {
  const subs = await getSubs('weibo', 'news')
  const record = subs[uid]
  if (!record || !blogs?.length) return

  const { renderWeiboDynamic } = await import('./render/weibo.js')

  for (const blog of blogs) {
    const mblogid = blog.mblogid || blog.id
    if (!mblogid) continue
    const url = `https://weibo.com/${uid}/${mblogid}`

    let buf = null
    try {
      buf = await renderWeiboDynamic(url, { expand: true })
    } catch (err) {
      logger.error(`[订阅推送] 微博渲染失败 ${mblogid}`, err)
    }

    const name = blog?.user?.screen_name || record.name || uid
    const { head, tail } = buildWeiboMessage(name, blog, uid)

    for (const groupId of record.groups) {
      const cfg = await getGroupConfig(groupId)

      // @全体：微博独立一份名单和冷却
      const key = atAllKey('weibo', 'news', uid)
      const inAtAllList = !!(cfg.atAll && typeof cfg.atAll === 'object' && cfg.atAll[key])
      const shouldAtAll = inAtAllList ? await tryAcquireAtAll(groupId, key) : false
      const atList = cfg.at?.[key]

      await sendToGroup(groupId, head, buf, { ...cfg, atAll: shouldAtAll, at: atList }, tail)
    }
  }
}

/**
 * 微博消息
 *
 * 原模板 notify.group.weibo.news.tmpl 只有两种 $msg：
 *   有转发  → "{{ 用户 }} 转发了 {{ 原博主 }} 的微博"
 *   无转发  → "{{ 用户 }} 发布了新微博"
 *
 * 这里在保持原格式的基础上补一个「转自己」的判断：
 *   B站模板对 WithOrigin 做了 self/origName 区分，微博原模板漏了，
 *   会导致「_小橙c 转发了 _小橙c 的微博」这种重复。
 *
 * 输出：{{ $msg }} / 发布时间（已去掉） / {{ pic }} / 微博链接：xxx
 *
 * 注意和原模板一致的细节：
 *   1. 不输出正文（正文在卡片图里）
 *   2. 链接前面有「微博链接：」前缀
 */
function buildWeiboMessage (name, blog, uid) {
  const retweet = blog?.retweeted_status
  const self = name || blog?.user?.screen_name || uid || ''

  let msg
  if (retweet) {
    const origName = retweet?.user?.screen_name || ''
    if (!origName) {
      msg = `${self} 转发了微博`
    } else if (origName === self) {
      msg = `${self} 转发了自己的微博`
    } else {
      msg = `${self} 转发了 ${origName} 的微博`
    }
  } else {
    msg = `${self} 发布了新微博`
  }

  const mblogid = blog?.mblogid || blog?.id || ''
  const tail = `微博链接：https://weibo.com/${blog?.user?.id || uid || ''}/${mblogid}`
  return { head: msg, tail }
}

/* ================= 工具 ================= */

/**
 * 按 UID 查真实房间号（迁移过来的老订阅可能没存）
 */
async function resolveRoomId (uid) {
  try {
    const r = await fetch('https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        Referer: 'https://live.bilibili.com/'
      },
      body: JSON.stringify({ uids: [Number(uid)] }),
      signal: AbortSignal.timeout(10000)
    })
    const j = await r.json()
    const info = j?.data?.[uid]
    return info?.room_id ? String(info.room_id) : ''
  } catch {
    return ''
  }
}

/* ================= 发送 ================= */

/**
 * 发一条消息（@ → 文字 → 图片 → 链接）
 *
 * 顺序对齐原模板：
 *   {{ $msg }} / {{ pic $dyPic }} / {{ $link }}
 * 链接必须在图片之后，放在文字里会显得头重脚轻。
 *
 * @param {string} groupId 群号
 * @param {string} text    图片上方的文字
 * @param {Buffer|null} buf 图片（渲染失败时为 null，退化成纯文本）
 * @param {object} cfg     群配置（atAll / at）
 * @param {string} tail    图片下方的链接等收尾文字
 */
async function sendToGroup (groupId, text, buf, cfg = {}, tail = '') {
  try {
    const group = Bot.pickGroup(Number(groupId))
    if (!group) {
      logger.warn(`[订阅推送] 找不到群 ${groupId}`)
      return
    }

    const msg = []

    // @全体 / @成员 先放最前面
    const atSegs = []
    if (cfg.atAll) atSegs.push(segment.at('all'))

    // @特定成员：@全体没生效（或没配）时的兜底
    if (Array.isArray(cfg.at)) {
      for (const qq of cfg.at) {
        if (qq) atSegs.push(segment.at(String(qq)))
      }
    }

    msg.push(...atSegs)

    // QQ 会把相邻的文字段合并，所以换行必须拼进正文本身，
    // 不能单独发一个 '\n' 段——那样会变成「@全体成员逍遥散人 下播了」粘在一起。
    const body = text ? (atSegs.length ? `\n${text}` : text) : ''

    if (body) msg.push(body)
    if (buf) msg.push(segment.image(buf))
    if (tail) msg.push(tail)

    if (!msg.length) return
    await group.sendMsg(msg)
  } catch (err) {
    logger.error(`[订阅推送] 推送到群 ${groupId} 失败`, err)
  }
}

export default pushNotify
