/**
 * 订阅数据存储（JSON 文件，不依赖 Redis）
 *
 * 为什么不用 Redis：TRSS 自带的 Redis 默认 `save ""` + `appendonly no`，
 * 完全没开持久化，进程一崩订阅数据全丢。订阅是用户手填的长期配置，
 * 不能放在一个不落盘的缓存里。
 *
 * 文件布局（都在插件 data/ 下，好备份好迁移）：
 *   data/subscriptions.json   订阅关系 + 每个博主的状态基线
 *   data/groups.json          群级开关（@全体、免打扰、按类型开关）
 *   data/backup/              每次写入前的上一版本（只留最近 N 份）
 *
 * 写入策略：先写临时文件 → fsync → rename 覆盖。
 * rename 在同一分区上是原子的，断电不会写出半个 JSON。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json')
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json')
const BACKUP_DIR = path.join(DATA_DIR, 'backup')

const SITES = ['bilibili', 'weibo']
const TYPES = ['news', 'live']
const MAX_BACKUPS = 10

/** 群级默认配置 */
export const GROUP_DEFAULTS = {
  /**
   * at：@特定成员（@全体失效时兜底）
   *   { "bilibili:253298645": ["10000", "10001"] }
   */
  at: null,
  /**
   * atAll：对指定对象 @全体
   *
   * key 带平台前缀，避免 B站 和微博 的 UID 撞号：
   *   { "bilibili:253298645": true, "weibo:2700162334": true }
   *
   * 同一个 B站 UP 订阅了直播+动态时共用一个 key——
   * 对用户来说「这个人的所有推送都 @全体」才是直觉行为。
   */
  atAll: null,
  /**
   * 下播推送：按 UP 单独开关，默认开
   *   { "253298645": false } = 这个 UP 下播不推
   */
  offlineNotify: null,
  /**
   * 改标题推送：按 UP 单独开关，默认开
   *   { "253298645": false } = 这个 UP 改标题不推
   */
  titleNotify: null,
  /**
   * filter：B站动态过滤，按 UP 单独配置
   *   { "253298645": { notType: ['转发'], text: [...], notText: [...] } }
   */
  filter: null
}

/**
 * @全体 名单的 key：平台 + 类型 + UID
 *
 * 为什么要带类型：
 *   1. B站 和微博 的 UID 都是纯数字，混存会撞号
 *   2. 直播和动态要**各自独立冷却**
 *
 * @param {string} site bilibili / weibo
 * @param {string} type live / news
 * @param {string} uid  对象 UID
 */
export function atAllKey (site, type, uid) {
  return `${site}:${type}:${uid}`
}

/**
 * 读「按 UP 开关」类配置，默认开
 *
 * offlineNotify / titleNotify 都是这种结构：没配过 = 开，
 * 只有显式设成 false 才关。
 */
export function notifySwitchOn (map, uid) {
  if (!map || typeof map !== 'object') return true
  const v = map[String(uid)]
  return v === undefined ? true : !!v
}

/** 写「按 UP 开关」类配置 */
export async function setNotifySwitch (group, key, uid, on) {
  const cfg = await getGroupConfig(group)
  const map = { ...(cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {}) }
  map[String(uid)] = !!on
  await setGroupConfig(group, key, map)
  return map
}

/** 动态类型中文名 */
export const DYNAMIC_TYPE_NAMES = ['转发', '投稿', '专栏', '文字', '图片', '音频', '直播分享']

let subs = null
let meta = null
let groupCfg = null
let writeTimer = null
const dirty = { subs: false, meta: false, groups: false }

function emptySubs () {
  const o = {}
  for (const s of SITES) {
    o[s] = {}
    for (const t of TYPES) o[s][t] = {}
  }
  return o
}

function emptyMeta () {
  return emptySubs()
}

/** 原子写：先写临时文件再 rename */
function writeJSONAtomic (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  if (fs.existsSync(file)) {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(file, path.join(BACKUP_DIR, `${path.basename(file, '.json')}-${stamp}.json`))
      const olds = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(path.basename(file, '.json') + '-'))
        .sort()
      while (olds.length > MAX_BACKUPS) {
        fs.unlinkSync(path.join(BACKUP_DIR, olds.shift()))
      }
    } catch {}
  }

  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

function readJSON (file, fallback) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    return obj && typeof obj === 'object' ? obj : fallback()
  } catch {
    return fallback()
  }
}

export async function initStore () {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  const disk = readJSON(SUBS_FILE, () => ({ subs: emptySubs(), meta: emptyMeta() }))
  subs = disk.subs || emptySubs()
  meta = disk.meta || emptyMeta()

  for (const s of SITES) {
    subs[s] = subs[s] || {}
    meta[s] = meta[s] || {}
    for (const t of TYPES) {
      subs[s][t] = subs[s][t] || {}
      meta[s][t] = meta[s][t] || {}
    }
  }

  groupCfg = readJSON(GROUPS_FILE, () => ({}))
  return { subs, meta, groupCfg }
}

function scheduleWrite () {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    flushSync()
  }, 500)
  if (writeTimer.unref) writeTimer.unref()
}

/** 立即落盘（进程退出前调用） */
export function flushSync () {
  if (!subs) return
  try {
    if (dirty.subs || dirty.meta) {
      writeJSONAtomic(SUBS_FILE, { subs, meta })
      dirty.subs = dirty.meta = false
    }
    if (dirty.groups) {
      writeJSONAtomic(GROUPS_FILE, groupCfg || {})
      dirty.groups = false
    }
  } catch (e) {
    if (typeof logger !== 'undefined') logger.error('[订阅推送] 订阅数据落盘失败', e)
  }
}

let hookRegistered = false
function registerExitHook () {
  if (hookRegistered) return
  hookRegistered = true
  const onExit = () => { try { flushSync() } catch {} }
  process.on('exit', onExit)
  process.on('SIGINT', () => { onExit(); process.exit(0) })
  process.on('SIGTERM', () => { onExit(); process.exit(0) })
}

export function allSites () {
  return SITES
}

export async function getSubs (site, type) {
  if (!subs) await initStore()
  return subs[site]?.[type] || {}
}

export async function getSiteSubs () {
  if (!subs) await initStore()
  return subs
}

/**
 * 新增订阅
 *
 * extra 用于直播：uid 是主播 UID（批量状态接口的主键），
 * roomId 是真实房间号（渲染卡片用），两者不是一回事。
 */
export async function addSub ({ site, type, uid, group, name = '', extra = {} }) {
  if (!subs) await initStore()
  registerExitHook()

  uid = String(uid).trim()
  if (!uid) throw new Error('订阅号不能为空')
  group = String(group)

  const bucket = subs[site][type]
  const existing = bucket[uid]

  if (existing && existing.groups.includes(group)) {
    const err = new Error('已订阅')
    err.code = 'DUPLICATE'
    throw err
  }

  const record = existing || { name: '', groups: [] }
  if (name && !record.name) record.name = name
  if (!record.groups.includes(group)) record.groups.push(group)
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') record[k] = v
  }

  bucket[uid] = record
  dirty.subs = true
  scheduleWrite()
  return record
}

/** 取消订阅；groups 空了就删整条记录（不再轮询） */
export async function removeSub ({ site, type, uid, group }) {
  if (!subs) await initStore()
  registerExitHook()

  uid = String(uid).trim()
  group = String(group)
  const bucket = subs[site][type]
  const record = bucket[uid]
  if (!record) return false

  const idx = record.groups.indexOf(group)
  if (idx === -1) return false

  record.groups.splice(idx, 1)
  if (record.groups.length === 0) {
    delete bucket[uid]
    if (meta[site]?.[type]) delete meta[site][type][uid]
  }
  dirty.subs = true
  dirty.meta = true
  scheduleWrite()
  return true
}

/** 回填博主显示名 */
export async function updateSubName (site, type, uid, name) {
  if (!name || !subs) return
  const record = subs[site]?.[type]?.[uid]
  if (!record || record.name === name) return
  record.name = name
  dirty.subs = true
  scheduleWrite()
}

/** 就地补充单条订阅的附加字段（比如迁移过来的直播订阅缺 roomId） */
export async function patchSub (site, type, uid, patch) {
  if (!subs) await initStore()
  registerExitHook()

  const record = subs[site]?.[type]?.[uid]
  if (!record) return false

  let changed = false
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null || v === '') continue
    if (record[k] !== v) { record[k] = v; changed = true }
  }
  if (changed) {
    dirty.subs = true
    scheduleWrite()
  }
  return changed
}

export async function getMeta (site, type) {
  if (!meta) await initStore()
  return meta[site]?.[type] || {}
}

export async function setMeta (site, type, uid, patch) {
  if (!subs) await initStore()
  registerExitHook()

  if (!subs[site]?.[type]?.[uid]) return

  const bucket = meta[site][type]
  bucket[uid] = { ...(bucket[uid] || {}), ...patch }
  dirty.meta = true
  scheduleWrite()
}

export async function delMeta (site, type, uid) {
  if (!meta) await initStore()
  if (meta[site]?.[type]?.[uid]) {
    delete meta[site][type][uid]
    dirty.meta = true
    scheduleWrite()
  }
}

export async function getGroupConfig (group) {
  if (!groupCfg) await initStore()
  const raw = groupCfg[String(group)] || {}
  return { ...GROUP_DEFAULTS, ...raw }
}

export async function setGroupConfig (group, key, value) {
  if (!groupCfg) await initStore()
  registerExitHook()

  if (!(key in GROUP_DEFAULTS)) return false
  const g = String(group)
  groupCfg[g] = { ...(groupCfg[g] || {}), [key]: value }
  dirty.groups = true
  scheduleWrite()
  return true
}

export async function getGroupConfigs (groups) {
  const out = {}
  await Promise.all(groups.map(async g => { out[g] = await getGroupConfig(g) }))
  return out
}

/* ================= @全体 限流 ================= */

/**
 * 同一群 + 同一 UP，2 小时内只 @全体一次
 *
 * 对齐 DDBOT 官方行为：`同一个主播每 2 小时内只会 @全体成员一次`。
 * 不限流的话，主播频繁上下播会把群员烦死，也容易被 QQ 判定滥用。
 *
 * 存在 groups.json 的 _atAllCooldown 字段里（跟群配置一起落盘，重启不丢）。
 */
const AT_ALL_COOLDOWN_MS = 2 * 3600 * 1000

/**
 * 判断这次推送能不能 @全体
 *
 * @returns {boolean} true = 可以 @（并且顺手记下时间）；false = 冷却中
 */
/**
 * 判断这次推送能不能 @全体，能就顺手占住冷却
 *
 * @param {string} group 群号
 * @param {string} key   atAllKey() 生成的三段式 key
 * @returns {boolean} true = 可以 @（并已占位）；false = 冷却中
 */
export async function tryAcquireAtAll (group, key) {
  if (!groupCfg) await initStore()
  registerExitHook()

  const g = String(group)
  const now = Date.now()

  const slot = cooldownSlot(key)

  const store = (groupCfg._atAllCooldown = groupCfg._atAllCooldown || {})
  const byGroup = (store[g] = store[g] || {})

  const last = Number(byGroup[slot] || 0)
  if (last && now - last < AT_ALL_COOLDOWN_MS) {
    return false
  }

  byGroup[slot] = now
  dirty.groups = true
  scheduleWrite()
  return true
}

/**
 * key → 冷却槽名
 *
 * bilibili:news:168598 → news:168598
 * 直播和动态各用各的槽，互不影响。
 */
function cooldownSlot (key) {
  const parts = String(key).split(':')
  if (parts.length < 3) return String(key)
  return `${parts[1]}:${parts[2]}`
}

/** 手滑配错想立刻重试时，清掉某个群的 @全体 冷却 */
export async function clearAtAllCooldown (group) {
  if (!groupCfg) await initStore()
  registerExitHook()
  const g = String(group)
  if (groupCfg._atAllCooldown?.[g]) {
    delete groupCfg._atAllCooldown[g]
    dirty.groups = true
    scheduleWrite()
    return true
  }
  return false
}

/** 查询冷却状态（给命令用，不写盘） */
export async function getAtAllCooldown (group, key) {
  if (!groupCfg) await initStore()
  const g = String(group)
  const slot = cooldownSlot(key)
  const last = Number(groupCfg._atAllCooldown?.[g]?.[slot] || 0)
  if (!last) return { cooling: false, remainMs: 0 }
  const remain = AT_ALL_COOLDOWN_MS - (Date.now() - last)
  return remain > 0 ? { cooling: true, remainMs: remain } : { cooling: false, remainMs: 0 }
}

/** 整批导入（供迁移脚本用） */
export async function bulkImport ({ subs: newSubs, meta: newMeta, groups: newGroups }) {
  await initStore()
  if (newSubs) subs = newSubs
  if (newMeta) meta = newMeta
  if (newGroups) groupCfg = newGroups
  dirty.subs = dirty.meta = dirty.groups = true
  flushSync()
}

export { DATA_DIR, SUBS_FILE, GROUPS_FILE }
