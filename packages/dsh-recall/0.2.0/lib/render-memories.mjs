// render-memories.mjs —— 把选中的记忆渲染成注入文本（两条链路共用一份）
//
// 2026-11-12（第二批）：原来 recall-core.render() 和 recall-semantic-core.renderInject()
//   各写了一份几乎一样的渲染，连抬头都不完全一致。第二批要改渲染规则（aspect / deadline / pending），
//   再各改一遍必然又走岔 —— 抽成这一份，谁要渲染都调它。
//
// 渲染规则：
//   status=pending              -> 「（待确认）：…」        —— 不确定，但照常说
//   aspect=trait                -> 「一直：…」             —— 长期画像/约定
//   aspect=state 且 deadline 已过 -> 「（11-05 说的，可能已经变了）：…」 —— 到期降级
//   aspect=state                -> 「现在（11-05 说的）：…」
//   aspect=event 且有时间        -> 「3 天前：…」
//   aspect=event 没时间          -> 「…」
//
// 「说的」那个日期取 observed_at（事情发生时间）→ at → createdAt，都没有就写「之前」。
import { aspectOf, isStale, statusOf } from './memory-fields.mjs'

const DAY = 86400000

function relDays(now, iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const days = Math.floor((now - t) / DAY)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return days + ' 天前'
  return Math.floor(days / 30) + ' 个月前'
}

function shortDate(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

// 2026-11-12：场次标签。以前「场次」字段全是「家」、渲染也不带它，于是 B站 和 QQ私聊 的事
//   到了主会话里就被当成自己的事说（跨场次八道题全栽在这）。现在字段有真值了，只有不是
//   主会话的场次才标，标在行首让模型一眼看出「这话是在别处说的」。
function venueOf(m) {
  const v = String(m['场次'] || '').trim()
  if (!v || v === 'Web' || v === '家') return ''
  return '（' + v + '）'
}

export function saidAt(m) {
  return m.observed_at || m.at || m.createdAt || ''
}

export function renderLine(m, now = Date.now()) {
  const body = String(m.text || '').trim()
  if (!body) return ''
  const v = venueOf(m)
  if (statusOf(m) === 'pending') return `- ${v}（待确认）：` + body

  const asp = aspectOf(m)
  if (asp === 'trait') return `- ${v}一直：` + body

  if (asp === 'state') {
    if (isStale(m, now)) {
      const d = shortDate(saidAt(m))
      return `- ${v}（${d ? d + ' ' : ''}说的，可能已经变了）：` + body
    }
    const d = shortDate(saidAt(m))
    return `- ${v}现在（${d ? d + ' ' : ''}说的）：` + body
  }

  if (m.at) {
    // 2026-11-12：原来渲染成「12 天前：」，模型读成「这件事发生在 12 天前」——问电脑哪年买的，
    //   它把记录时间 10-31 当成了购买日期。m.at 记的是「这话什么时候说的」，不是「事情什么时候发生的」，
    //   所以改成跟 state 类一致的「（10-31 说的）」，只给日期、不给相对说法。
    const d = shortDate(m.at)
    if (d) return `- ${v}（${d} 说的）：` + body
  }
  return `- ${v}` + body
}

export const HEADER = [
  '【你记得的事】',
  '下面是你们过去真实发生过的事。有时间的事会写在前面；没写时间的，说明不知道是什么时候。',
  '有时间就按那个时间说（比如「今天早上」「10-31 说的」），但别把「说的日期」当成「事情发生的日期」；不知道就说不知道，别编。',
  '想不起来的事就说想不起来，不要编。',
  '几条记忆如果讲的不是同一台机器、同一个人、同一件事，别把它们的数字凑成一条；分不清是哪台就直说分不清。',
]

// memories：纯记忆对象数组（不是 [{m, score}]，调用方自己 map 一下）
export function renderBlock(memories, now = Date.now()) {
  const list = Array.isArray(memories) ? memories : []
  const lines = []
  for (const m of list) {
    const line = renderLine(m, now)
    if (line) lines.push(line)
  }
  if (!lines.length) return ''
  return [...HEADER, '', ...lines].join('\n')
}

export default { renderLine, renderBlock, saidAt, HEADER }
