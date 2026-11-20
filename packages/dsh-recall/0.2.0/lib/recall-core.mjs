// recall-core.mjs —— 每轮相关度检索的核心（吸收 fish-memory 设计，不搬代码）
//
// 干什么：给定这一轮的最后一句 user 消息（query）+ 提炼记忆库，按「证据 × 加权」打分，
// 选出 1-3 条相关记忆 + 长期事实常驻层，渲染成一段注入文本。
//
// 四个吸收来的设计：
//   1. 蒸馏打分 —— importance 0~1，stable_profile（长期事实）vs event（会淡的事件）
//   2. 每轮想起 —— 按 query 相关度每轮选几条
//   3. 长期事实分层 —— category === 'stable_profile' 固定带 factsMax 条，不占事件名额
//   4. 事实键 —— 「对象.方面」，同键只留最新（在 distill 入库时收敛，这里做一层防御）
//
// 用法：
//   node recall-core.mjs "查的话"            # CLI 自测，打印选中的记忆
//   node recall-core.mjs "查的话" --json     # 输出 JSON
//   import { recall, tokenize, render } from './recall-core.mjs'   # 插件进程内用
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { filterUsable, aspectOf } from './memory-fields.mjs'
import { renderBlock } from './render-memories.mjs'

// 默认策略（参数与 fish-memory 同源；maxItems 按项目需要改成 3）
export const DEFAULT_POLICY = {
  baselineWeight: 0.55, // 基础权重
  activationWeight: 0.25, // 鲜活度权重
  importanceWeight: 0.15, // 重要度权重
  emotionWeight: 0.05, // 情绪权重
  baseHalfLifeDays: 30, // 事件半衰期（天）
  emotionHalfLifeDays: 7, // 情绪半衰期（天）
  threshold: 0.3, // 门槛卡 C（证据），不卡 P
  maxItems: 3, // 事件每轮最多几条（项目需要 1-3 条）
  maxChars: 800, // 注入文本总字数上限
  factsMax: 0, // 常驻层关闭（项目选 A 方案：只上相关 1-3 条，画像/约定也走相关检索）
  unknownActivation: 0.5, // 没写时间 / 长期事实的鲜活度按几成算
  rarityK: 0.8, // C = s/(s+K) 的软化系数
}

const DAY = 86400000

// 单字虚词停用（2-gram 只对长度>=2 的串切，单字单独收时靠它过滤）
const STOP = new Set('的了是我你他她它们在有和就也不都而及或这那着过啊吧吗呢哦哈嗯哟嘛'.split(''))

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
}

// 分词：英文/数字按连续串，中文按相邻 2 字（2-gram）；单字只留非虚词。
// 不依赖 jieba 词表 —— 库小（几十~几百条），2-gram 够用且零依赖。
export function tokenize(s) {
  const clean = normalize(s)
  const out = new Set()
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) out.add(m[0])
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    const chars = [...run]
    if (chars.length === 1) {
      if (!STOP.has(chars[0])) out.add(chars[0])
      continue
    }
    if (chars.length === 2) {
      out.add(run)
      continue
    }
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return out
}

// 建 df 表：每个词出现在几条记忆里（稀有度分母）
function buildDf(memories) {
  const df = new Map()
  for (const m of memories) {
    const seen = new Set()
    for (const k of tokenize(m.text || '')) {
      if (seen.has(k)) continue
      seen.add(k)
      df.set(k, (df.get(k) || 0) + 1)
    }
    // 标签也算证据来源
    for (const t of m.tags || []) {
      for (const k of tokenize(t)) {
        if (seen.has(k)) continue
        seen.add(k)
        df.set(k, (df.get(k) || 0) + 1)
      }
    }
  }
  return df
}

// 稀有度：库越小，df 越不可信；用 1/(1+df) 平滑
function rarity(df, k) {
  const d = df.get(k) || 0
  return 1 / (1 + d)
}

// 鲜活度：半衰期衰减。trait（长期事实）/ 没时间戳 → unknownActivation（平着，不淡）
function activation(m, policy, now) {
  if (aspectOf(m) === 'trait') return policy.unknownActivation
  const atMs = m.at ? Date.parse(m.at) : null
  if (!atMs) return policy.unknownActivation
  const days = Math.max(0, (now - atMs) / DAY)
  const h = policy.baseHalfLifeDays * (1 + 2 * (typeof m.importance === 'number' ? m.importance : 0))
  return Math.pow(2, -days / h)
}

// 单条打分。返回 { C, A, E, I, P }
function evaluate(m, query, now, policy, df) {
  const I = typeof m.importance === 'number' ? m.importance : 0
  const mTokens = tokenize((m.text || '') + ' ' + (m.tags || []).join(' '))
  const qTokens = [...tokenize(query)]
  let s = 0
  for (const k of qTokens) {
    if (mTokens.has(k)) s += rarity(df, k)
  }
  const C = s / (s + policy.rarityK)
  // 整句原话出现在记忆里 = 强证据，顶到 0.85
  if (query.trim().length >= 6 && qTokens.length > 0 && (m.text || '').includes(query.trim())) {
    const _c = 0.85
    if (_c > C) return { C: _c, A: activation(m, policy, now), E: 0, I, P: _c * (policy.baselineWeight + policy.activationWeight * activation(m, policy, now) + policy.importanceWeight * I) }
  }
  const A = activation(m, policy, now)
  // 2026-11-08：emotion 在提炼记忆里可能是字符串（情绪词）或 null（见 distill.mjs:325）。
  //   原来直接相乘，字符串 × 数字 = NaN，P 变 NaN 后排序完全不可靠。只有正经正数才参与。
  const E =
    typeof m.emotion === 'number' && isFinite(m.emotion) && m.emotion > 0
      ? m.emotion * Math.pow(2, -Math.max(0, (m.at ? Date.parse(m.at) : now) - now) / DAY / policy.emotionHalfLifeDays)
      : 0
  const P = C * (policy.baselineWeight + policy.activationWeight * A + policy.importanceWeight * I + policy.emotionWeight * E)
  return { C, A, E, I, P }
}

// 两条记忆「像不像同一件事」：共词 ÷ 短的那条词数
function similarity(a, b) {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (!ta.size || !tb.size) return 0
  const small = ta.size <= tb.size ? ta : tb
  const big = small === ta ? tb : ta
  if (small.size < 3) return 0
  let inter = 0
  for (const x of small) if (big.has(x)) inter++
  return inter / small.size
}

// 事实键归一：去空白、全角，拿「对象.方面」两段
function normKey(k) {
  return String(k || '').replace(/\s+/g, '').trim()
}

// 渲染注入文本（规则在 render-memories.mjs，两条链路共用一份，别再各写一遍）
export function render(selected, now = Date.now()) {
  return renderBlock(selected, now)
}

// 一条记忆跟 query 有几个词重合（召回归因用；只算选中那几条，不额外遍历全库）
function hitWords(m, query) {
  const q = tokenize(query)
  if (!q.size) return 0
  const mt = tokenize((m.text || '') + ' ' + (m.tags || []).join(' '))
  let n = 0
  for (const t of q) if (mt.has(t)) n++
  return n
}

// 召回归因（写 召回日志.jsonl 用）：候选几条、选中哪几条、最高分、凭什么
function buildMeta(query, selected, candidates, topScore, collapsed) {
  let maxHit = 0
  for (const m of selected) maxHit = Math.max(maxHit, hitWords(m, query))
  const parts = []
  if (maxHit > 0) parts.push(`命中 ${maxHit} 词`)
  if (collapsed > 0) parts.push(`同键收敛 ${collapsed} 条`)
  if (!parts.length) parts.push('无共词')
  return {
    candidates: candidates || 0,
    topScore: Number.isFinite(topScore) ? Number(topScore.toFixed(3)) : 0,
    picked: selected.map((m) => m.id),
    reason: parts.join(' + '),
  }
}

// 主入口：query → 选中的记忆（按注入顺序，带 _omission 说明为什么没进/为什么进）
export function recall(query, memories, opts = {}) {
  const policy = { ...DEFAULT_POLICY, ...(opts.policy || {}) }
  const now = opts.now || Date.now()

  // ① 过滤：status / superseded_by / valid_until 三条统一走 memory-fields.mjs
  //    2026-11-11 夜：原来这里手写 `!m.superseded_by`，语义链路那边又写一遍 —— 两套口径迟早对不上。
  //    缺字段的老条目按 active 处理（不然一升级整个库就空了）。
  const alive = filterUsable(memories, now).filter((m) => !m.refinedSkip)

  // ② 事实键防御收敛：同键只留「最新」一条（正常应在 distill 入库时做）
  // 2026-11-08 夜：原来直接往记忆对象上写 superseded_by 当「本次标记」——但调用方要是把
  //   记忆列表缓存起来（dsh-recall 现在就这么干），这个写就会留在缓存对象上，下一轮
  //   真把这几条当成「已被取代」永久藏掉。改成只在本次用一个 Set 记，不碰对象。
  const byKey = new Map()
  const superseded = new Set()
  for (const m of alive) {
    const k = normKey(m.事实键)
    if (!k) continue
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, m)
      continue
    }
    const prevT = Date.parse(prev.at || prev.createdAt || 0) || 0
    const thisT = Date.parse(m.at || m.createdAt || 0) || 0
    if (thisT > prevT) {
      superseded.add(prev.id)
      byKey.set(k, m)
    } else {
      superseded.add(m.id)
    }
  }
  const memories2 = alive.filter((m) => !superseded.has(m.id))

  if (!memories2.length) return { selected: [], text: '', scored: [], gate: null, meta: buildMeta(query, [], 0, 0, 0) }

  const df = buildDf(memories2)

  // ③ 问句门槛：query 本身信息量太低（「在吗」「嗯」）就不翻记忆
  const qTokens = [...tokenize(query)]
  let gate = null
  if (qTokens.length === 0) {
    return { selected: [], text: '', scored: [], gate: { info: 0 }, meta: buildMeta(query, [], 0, 0, 0) }
  }

  // ④ 打分，门槛卡 C
  const scored = memories2.map((m) => ({ m, s: evaluate(m, query, now, policy, df) }))
  const picked = scored.filter((r) => r.s.C >= policy.threshold)

  // ⑤ 召回去重：像度 >= 0.8 只留分高的
  const dedup = []
  for (const row of picked.sort((a, b) => b.s.P - a.s.P)) {
    let dup = false
    for (const y of dedup) {
      if (similarity(row.m.text, y.m.text) >= 0.8) {
        dup = true
        break
      }
    }
    if (!dup) dedup.push(row)
  }

  // ⑥ 常驻层：stable_profile 固定 factsMax 条（按重要度 → 时间），不占事件名额
  const factsMax = Math.max(0, Math.floor(policy.factsMax || 0))
  const facts = memories2
    .filter((m) => m.category === 'stable_profile')
    .slice()
    .sort(
      (a, b) =>
        (Number(b.importance) || 0) - (Number(a.importance) || 0) ||
        (Date.parse(b.createdAt || b.at || 0) || 0) - (Date.parse(a.createdAt || a.at || 0) || 0),
    )
    .slice(0, factsMax)
    .map((m) => ({ m, s: { C: 1, P: 1 }, 常驻: true }))

  // ⑦ 相关记忆：按最高 C 分档给上限（不硬凑），再受 maxItems 约束。
  //    常驻层已关（factsMax=0），stable_profile 也走相关检索，不单独无条件注入
  const events = dedup
  const topC = events.length ? events[0].s.C : 0
  const tiers = [
    [0.6, policy.maxItems],
    [0.5, 4],
    [0.4, 3],
    [0, 1],
  ]
  const tripCap = events.length ? tiers.find(([line]) => topC >= line)[1] : 0
  const eventCap = Math.min(tripCap, policy.maxItems)
  const eventPicked = events.slice(0, eventCap)

  // ⑧ 常驻 + 事件，按字数预算截断
  const combined = facts.concat(eventPicked)
  const maxChars = policy.maxChars || 800
  const selected = []
  let used = 0
  for (const row of combined) {
    const n = String(row.m.text || '').length
    if (selected.length > 0 && used + n > maxChars) break
    selected.push(row.m)
    used += n
  }

  return {
    selected,
    text: render(selected, now),
    scored,
    gate,
    meta: buildMeta(query, selected, picked.length, topC, superseded.size),
  }
}

// ---------- CLI 自测 ----------
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/recall-core.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const query = args.filter((a) => !a.startsWith('--')).join(' ')
  if (!query) {
    console.error('用法: node recall-core.mjs "查的话" [--json]')
    process.exit(2)
  }
  // 2026-11-09：兜底路径改成从 homedir 拼，不再写死 E 盘（这个只是命令行自测用的分支，
  //   插件里走的是 recall-semantic-core 的 HOME，但留个写死的家路径迟早要踩）。
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const memPath = join(home, '记忆', '提炼记忆.jsonl')
  let memories = []
  try {
    memories = readFileSync(memPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (e) {
    console.error('读不到 ' + memPath + ': ' + e.message)
    process.exit(1)
  }
  const r = recall(query, memories)
  if (wantJson) {
    console.log(JSON.stringify({ query, count: r.selected.length, selected: r.selected }, null, 2))
  } else {
    console.log('query: ' + query + '  记忆库 ' + memories.length + ' 条，选中 ' + r.selected.length + ' 条\n')
    console.log(r.text || '（一条都没选上）')
  }
}

export default { recall, tokenize, render, DEFAULT_POLICY }
