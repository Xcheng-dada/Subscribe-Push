/**
 * 帮助页转图
 *
 * 用和订阅列表同一套 captureHTML，出图风格保持一致。
 * 分区块展示，每块有标题 + 命令行（命令高亮、说明灰字）。
 */

import { captureHTML } from './render/shot.js'

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 帮助数据结构
 *
 * 分成「所有人可用」和「仅主人」两大块，让用户一眼看出哪些能用。
 */
export const HELP_SECTIONS = [
  {
    title: '所有人可用',
    open: true,
    noBadge: true,
    items: [
      { cmd: '#订阅列表', desc: '查看本群订阅了谁（转图）' },
      { cmd: '#订阅帮助', desc: '显示这条帮助' },
      { cmd: '#直播间 1017', desc: '查直播间状态 + 在线人数 + 最近弹幕' }
    ]
  },
  {
    title: '订阅 / 取消',
    items: [
      { cmd: '#订阅动态 253298645', desc: '订阅 B站 UP 主动态' },
      { cmd: '#订阅直播 1017', desc: '订阅 B站直播（房间号或 UID 都行）' },
      { cmd: '#订阅微博 2700162334', desc: '订阅微博博主' },
      { cmd: '#取消订阅动态 253298645', desc: '取消对应订阅' },
      { cmd: '#取消订阅直播 1017', desc: '' },
      { cmd: '#取消订阅微博 2700162334', desc: '' }
    ]
  },
  {
    title: '推送开关（按 UP 单独设）',
    note: '默认开播、下播、改标题都推送',
    items: [
      { cmd: '#关闭下播推送 1017', desc: '这个 UP 下播不推' },
      { cmd: '#开启下播推送 1017', desc: '恢复' },
      { cmd: '#关闭改标题推送 1017', desc: '这个 UP 改标题不推' },
      { cmd: '#开启改标题推送 1017', desc: '恢复' }
    ]
  },
  {
    title: '@全体',
    note: '直播和动态可分开设，各自独立冷却 2 小时。需要机器人为群管理员',
    items: [
      { cmd: '#推送@全体 直播 1017', desc: '只对直播推送 @全体' },
      { cmd: '#推送@全体 动态 253298645', desc: '只对动态推送 @全体' },
      { cmd: '#推送@全体 1017', desc: '两类都 @（省事写法）' },
      { cmd: '#取消@全体 直播 1017', desc: '取消对应类型' },
      { cmd: '#查看@全体', desc: '看本群配了哪些' }
    ]
  },
  {
    title: '@指定成员',
    note: '@全体失效时兜底',
    items: [
      { cmd: '#@成员 1017 12345678', desc: '这个 UP 推送时 @ 指定的人' },
      { cmd: '#取消@成员 1017 12345678', desc: '取消' },
      { cmd: '#查看@成员', desc: '查看本群配置' }
    ]
  },
  {
    title: '动态过滤',
    note: '可用类型：转发 / 投稿 / 专栏 / 文字 / 图片 / 音频 / 直播分享',
    items: [
      { cmd: '#动态过滤 253298645 not_type 转发', desc: '不推转发' },
      { cmd: '#动态过滤 253298645 type 投稿 专栏', desc: '只推这两类' },
      { cmd: '#动态过滤 253298645 not_text 抽奖', desc: '不推含这个词的' },
      { cmd: '#动态过滤 253298645 show', desc: '查看当前规则' },
      { cmd: '#动态过滤 253298645 clear', desc: '清空规则' }
    ]
  },
  {
    title: '私聊用法',
    note: '所有命令后面加 -g 群号，就能在私聊里操作指定群',
    items: [
      { cmd: '#订阅直播 1017 -g 123456789', desc: '示例' }
    ]
  }
]

/** 生成帮助页 HTML */
export function helpHTML (title = '订阅推送 · 命令帮助') {
  let body = ''

  for (const sec of HELP_SECTIONS) {
    // noBadge 的区块（所有人可用）不显示徽章，避免和标题重复
    const badge = sec.noBadge
      ? ''
      : (sec.open ? '<span class="badge open">所有人</span>' : '<span class="badge">仅主人</span>')
    body += `<section class="sec">
<div class="sec-head"><h2>${esc(sec.title)}</h2>${badge}</div>`

    if (sec.note) body += `<div class="note">${esc(sec.note)}</div>`

    body += '<div class="rows">'
    for (const it of sec.items) {
      body += `<div class="row"><code>${esc(it.cmd)}</code>${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}</div>`
    }
    body += '</div></section>'
  }

  const d = new Date()
  const p2 = n => String(n).padStart(2, '0')
  const footer = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`

  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;background:#f7f8fa;color:#2c3e50;width:fit-content}
.wrap{padding:36px 44px;width:fit-content}
.title{text-align:center;font-size:34px;font-weight:800;color:#2c3e50;margin-bottom:8px;letter-spacing:1px}
.subtitle{text-align:center;font-size:15px;color:#95a5a6;margin-bottom:32px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start}
.sec{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.sec-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
h2{font-size:19px;font-weight:700;color:#34495e;margin:0}
.badge{font-size:12px;padding:2px 9px;border-radius:10px;background:#ecf0f1;color:#7f8c8d;font-weight:600}
.badge.open{background:#e8f8f5;color:#16a085}
.note{font-size:13px;color:#95a5a6;margin:4px 0 10px;line-height:1.5}
.rows{display:flex;flex-direction:column;gap:9px;margin-top:10px}
.row{display:flex;flex-direction:column;gap:3px;align-items:flex-start}
code{font-family:Consolas,"Courier New",monospace;font-size:14px;background:#f0f6ff;color:#2563eb;padding:4px 9px;border-radius:6px;white-space:nowrap;display:inline-block}
.desc{font-size:12.5px;color:#7f8c8d;padding-left:2px}
.footer{text-align:center;margin-top:30px;color:#bdc3c7;font-size:14px}
</style></head><body><div class="wrap">
<div class="title">${esc(title)}</div>
<div class="subtitle">除标注「所有人」的命令外，其余仅机器人主人可用</div>
<div class="grid">${body}</div>
<div class="footer">Subscribe-Push By 小橙c | ${footer}</div>
</div></body></html>`
}

/**
 * 渲染帮助页，返回 PNG Buffer
 */
export async function renderHelp (title) {
  return captureHTML(helpHTML(title), {
    width: 900,
    height: 100,
    dsf: 2,
    goFullPage: true
  })
}

export default renderHelp
