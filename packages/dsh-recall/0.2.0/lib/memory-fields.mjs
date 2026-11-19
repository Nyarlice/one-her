// memory-fields.mjs —— 提炼记忆五个字段的「唯一口径」
//
// 2026-11-11 夜（记忆插件-08 第一批）：observed_at / valid_until / superseded_by / status / authority。
//
// 为什么要单独一个文件：两套检索链路（2-gram 的 recall-core、语义的 recall-semantic-core）
//   必须用同一套「这条还算不算数」的判据。上次两套口径各写一遍，改一边漏一边，事后没人发现。
//   规矩：以后加字段、改判据只改这里，调用方别各写一份。
//
// 缺字段的老条目按 active 处理 —— 这是故意的：990 条老数据迁移前没有 status，
//   要是把「没字段」当成「不可用」，一升级整个记忆库就空了。

export const STATUSES = ['active', 'superseded', 'retracted', 'pending']
export const AUTHORITIES = [
  'user_explicit',
  'user_correction',
  'system_policy',
  'external_information',
  'single_observation',
  'agent_inference',
]
export const PRECISIONS = ['day', 'month', 'year', 'unknown']

// 2026-11-12（第二批）：体状态机。category 只说「长期画像 / 事件」，分不出
//   「一直成立」和「当前状态」——「主人正在找工作」被塞进 stable_profile，于是渲染成
//   「一直：」，valid_until 也永远填不上（规则里 stable_profile 一律 null）。
//   aspect 三态就是把这个分清楚：
//     trait  一直成立（称呼、性格、约定、长期喜好）—— 不衰减、不失效
//     state  当前状态 / 进行中的事（正在找工作、在做什么项目）—— 有 deadline，到点降级标注
//     event  一次性发生（某天做成了什么、某天出了什么错）—— 按半衰期淡
export const ASPECTS = ['trait', 'state', 'event']

const STATUS_SET = new Set(STATUSES)
const AUTHORITY_SET = new Set(AUTHORITIES)
const PRECISION_SET = new Set(PRECISIONS)
const ASPECT_SET = new Set(ASPECTS)

// 参与检索的状态：active 和 pending 都算。
//   pending = 「我不确定它现在还算不算数」，它不是「它不成立」——藏起来等于假装没想过。
//   只有 retracted（撤回）和 superseded（被取代）真的不返回。
const USABLE_STATUS = new Set(['active', 'pending'])

export function isStatus(v) {
  return typeof v === 'string' && STATUS_SET.has(v.trim().toLowerCase())
}
export function isAuthority(v) {
  return typeof v === 'string' && AUTHORITY_SET.has(v.trim())
}
export function isPrecision(v) {
  return typeof v === 'string' && PRECISION_SET.has(v.trim().toLowerCase())
}

// 取状态；缺字段/空串 -> active
export function statusOf(m) {
  const s = m && typeof m.status === 'string' ? m.status.trim().toLowerCase() : ''
  return s || 'active'
}

// 被取代：新旧两种写法都算（老库是 null，新库是 ""）
export function isSuperseded(m) {
  const v = m && m.superseded_by
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  return Boolean(v)
}

// 失效时间：解析不出就当没有（宁可不拦，也别因为一个写坏的日期把整条藏掉）
export function expiryOf(m) {
  const v = m && m.valid_until
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function isExpired(m, now = Date.now()) {
  const t = expiryOf(m)
  return t !== null && t < now
}

// ---------- 体状态（aspect）与到期检查（deadline）----------
export function isAspect(v) {
  return typeof v === 'string' && ASPECT_SET.has(v.trim().toLowerCase())
}

// 取 aspect；缺字段按 category 推（老数据只能这么推，别拿关键词猜）：
//   stable_profile -> trait、event -> event。新蒸出来的会带真 aspect。
export function aspectOf(m) {
  const a = m && typeof m.aspect === 'string' ? m.aspect.trim().toLowerCase() : ''
  if (ASPECT_SET.has(a)) return a
  return m && m.category === 'stable_profile' ? 'trait' : 'event'
}

// deadline = 该重新确认了（软），跟 valid_until = 不成立了（硬）不是一回事
export function deadlineOf(m) {
  const v = m && m.deadline
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// 状态过期且没被新证据替代 —— 只降级标注，不隐藏
export function isStale(m, now = Date.now()) {
  if (aspectOf(m) !== 'state') return false
  const t = deadlineOf(m)
  return t !== null && t < now
}

// 为什么这条不参与检索；可用返回 null。测试和排查都靠它，别各处再猜。
export function excludeReason(m, now = Date.now()) {
  if (!m || typeof m.text !== 'string' || !m.text.trim()) return 'empty'
  const st = statusOf(m)
  if (!USABLE_STATUS.has(st)) return 'status:' + st
  if (isSuperseded(m)) return 'superseded'
  if (isExpired(m, now)) return 'expired'
  return null
}

export function isUsable(m, now = Date.now()) {
  return excludeReason(m, now) === null
}

export function filterUsable(list, now = Date.now()) {
  const arr = Array.isArray(list) ? list : []
  const out = []
  for (const m of arr) if (excludeReason(m, now) === null) out.push(m)
  return out
}

// 按 observed_at 的写法猜精度（模型没给或给错时的兜底，比默认 day 靠谱）
export function inferPrecision(observedAt) {
  const s = typeof observedAt === 'string' ? observedAt.trim() : ''
  if (!s) return 'unknown'
  if (/^\d{4}$/.test(s)) return 'year'
  if (/^\d{4}-\d{2}$/.test(s)) return 'month'
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'day'
  return 'unknown'
}

export default {
  STATUSES,
  AUTHORITIES,
  PRECISIONS,
  ASPECTS,
  isStatus,
  isAuthority,
  isPrecision,
  isAspect,
  statusOf,
  aspectOf,
  isSuperseded,
  expiryOf,
  isExpired,
  deadlineOf,
  isStale,
  excludeReason,
  isUsable,
  filterUsable,
  inferPrecision,
}
