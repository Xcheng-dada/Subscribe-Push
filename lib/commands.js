/**
 * 中文命令表
 *
 * 传统订阅机器人常用 `watch -s bilibili -t live 12345` 这种带参数形式，
 * 参数多、要记缩写、顺序还不能错。这里全部拍平成「动词 + 号」两段式。
 *
 * 正则统一用 ^#? 开头、$ 结尾，避免和 miao-plugin / DF-Plugin 等已有插件误撞。
 */

export const CMD = {
  /* ---- 订阅 ---- */
  subBiliNews: {
    pattern: '^#?订阅动态\\s*(\\d+)?$',
    desc: '#订阅动态 253298645'
  },
  subBiliLive: {
    pattern: '^#?订阅直播\\s*(\\d+)?$',
    desc: '#订阅直播 12345（房间号或UID均可）'
  },
  subWeibo: {
    pattern: '^#?订阅微博\\s*(\\d+)?$',
    desc: '#订阅微博 2700162334'
  },

  /* ---- 取消 ---- */
  unsubBiliNews: {
    pattern: '^#?取消订阅动态\\s*(\\d+)?$',
    desc: '#取消订阅动态 253298645'
  },
  unsubBiliLive: {
    pattern: '^#?取消订阅直播\\s*(\\d+)?$',
    desc: '#取消订阅直播 12345'
  },
  unsubWeibo: {
    pattern: '^#?取消订阅微博\\s*(\\d+)?$',
    desc: '#取消订阅微博 2700162334'
  },

  /* ---- 按 UP 开关：下播推送 / 改标题推送 ---- */
  offlineNotify: {
    pattern: '^#?(开启|关闭)下播推送\\s*(\\d+)(?:\\s+-g\\s*(\\d+))?$',
    desc: '#关闭下播推送 1017'
  },
  titleNotify: {
    pattern: '^#?(开启|关闭)改标题推送\\s*(\\d+)(?:\\s+-g\\s*(\\d+))?$',
    desc: '#关闭改标题推送 1017'
  },

  /* ---- @全体（按 UP + 类型指定）---- */
  atAllAdd: {
    pattern: '^#?推送@全体\\s*(直播|动态)?\\s*(\\d+)(?:\\s+-g\\s*(\\d+))?$',
    desc: '#推送@全体 直播 1017（这个UP开播时@）；动态 253298645（这个UP发动态时@）'
  },
  atAllDel: {
    pattern: '^#?取消@全体\\s*(直播|动态)?\\s*(\\d+)(?:\\s+-g\\s*(\\d+))?$',
    desc: '#取消@全体 直播 1017'
  },
  atAllShow: {
    pattern: '^#?查看@全体$',
    desc: '#查看@全体'
  },

  /* ---- @特定成员（@全体兜底）---- */
  atAdd: {
    pattern: '^#?@成员\\s*(\\d+)\\s+(\\d+(?:\\s+\\d+)*)$',
    desc: '#@成员 1017 12345678（这个 UP 推送时 @ 指定的人）'
  },
  atDel: {
    pattern: '^#?取消@成员\\s*(\\d+)\\s+(\\d+(?:\\s+\\d+)*)$',
    desc: '#取消@成员 1017 12345678'
  },
  atShow: {
    pattern: '^#?查看@成员$',
    desc: '#查看@成员'
  },

  /* ---- 动态过滤 ---- */
  filterCmd: {
    pattern: '^#?动态过滤\\s+(\\d+)\\s+(type|not_type|text|not_text)\\s+([^\\s]+(?:\\s+[^\\s]+)*)$',
    desc: '#动态过滤 253298645 not_type 转发（不推转发动态）'
  },
  filterShow: {
    pattern: '^#?动态过滤\\s+(\\d+)\\s+show$',
    desc: '#动态过滤 253298645 show'
  },
  filterClear: {
    pattern: '^#?动态过滤\\s+(\\d+)\\s+clear$',
    desc: '#动态过滤 253298645 clear'
  },

  /* ---- 查看（所有人可用）---- */
  listSubs: {
    pattern: '^#?订阅列表$',
    desc: '#订阅列表'
  },

  /* ---- 帮助（所有人可用）---- */
  helpCmd: {
    pattern: '^#?订阅帮助$',
    desc: '#订阅帮助'
  },

  /* ---- 直播间查询（所有人可用）---- */
  roomInfo: {
    pattern: '^#?直播间\\s*(\\d+)?$',
    desc: '#直播间 1017'
  }
}

export default CMD
