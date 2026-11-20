#!/usr/bin/env node
// token 消耗 + 花费网页服务。两种视图：按会话（工作区/会话/天/轮）、按天（官方账）。
// 用法：node tools\token-server.mjs [端口]   （默认 8720）
//
// 2026-11-15 改版：
//   - 顶部余额条（读 .dshw-usage.json，挂件 25 秒一刷，是真钱）
//   - 每层加金额：轮级来自 记忆\turn-cost.json（三档分档算的）
//   - 轮级带模型名
//   - ?view=day 切到按天视图：官方 usage-export\official-usage.json + 近 14 天柱状图
//   - 轮级账是补算快照；比快照新的轮次只显示 token，标「待补算」，不瞎估钱
import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 家目录：优先读 DSH_HOME，读不到才落到本机默认路径。
const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home'
const MEMORY_DIR = join(HOME, '记忆')
const PROJCACHE_DIR = join(HOME, 'storages', 'session_projcache', 'sessions')
const USAGE_DIR = join(HOME, 'usage-export')
const BALANCE_FILE = join(HOME, '.dshw-usage.json')
const TURNCOST_FILE = join(MEMORY_DIR, 'turn-cost.json')
const OFFICIAL_FILE = join(USAGE_DIR, 'official-usage.json')
const KIMI_FILE = join(USAGE_DIR, 'official-kimi.json')
const PORT = Number(process.argv[2]) || 8720

const GEN_TOKEN = '\u0000GEN\u0000'
const cacheStore = new Map()
function stampOf(files) {
  let s = ''
  for (const f of files) {
    try {
      const st = statSync(f)
      s += st.mtimeMs + ':' + st.size + ';'
    } catch {
      s += '-;'
    }
  }
  return s
}
function nowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}
function projCacheFiles() {
  try {
    return readdirSync(PROJCACHE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(PROJCACHE_DIR, f))
  } catch {
    return []
  }
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

function loadChats() {
  const chats = []
  for (const f of ['token统计.jsonl', 'token统计-历史.jsonl']) {
    try {
      for (const l of readFileSync(join(MEMORY_DIR, f), 'utf8').split('\n')) {
        if (!l.trim()) continue
        let e; try { e = JSON.parse(l) } catch { continue }
        if (e.kind === 'chat' && e.sessionId && e.turn != null) chats.push(e)
      }
    } catch {}
  }
  return chats
}

function looksLikeName(t) {
  if (!t) return false
  const s = String(t).trim()
  if (!s || s.length > 30) return false
  if (/[*#`\[\]【】|<>\\\/]/.test(s)) return false
  if (/[。！？；，]/.test(s)) return false
  if (/^你/.test(s) && s.length > 10) return false
  return true
}
function loadNames(files) {
  const out = {}
  try { Object.assign(out, JSON.parse(readFileSync(join(MEMORY_DIR, 'session-names.json'), 'utf8'))) } catch {}
  for (const p of files) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const t = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val
      if (typeof t === 'string' && looksLikeName(t)) out[String(p).split(/[\\/]/).pop().slice(0, -5)] = t.trim()
    } catch {}
  }
  return out
}

function loadEvents() {
  const cwdBySid = new Map()
  const turnText = new Map()
  let cur = 0
  try {
    for (const l of readFileSync(join(MEMORY_DIR, 'events.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue
      let e; try { e = JSON.parse(l) } catch { continue }
      const sid = e.session_id
      if (!sid) continue
      if (e.cwd && !cwdBySid.has(sid)) cwdBySid.set(sid, e.cwd)
      if (e.type === 'turn/start' && e.turn != null) cur = e.turn
      else if (e.type === 'user/message') {
        const k = sid + ':' + cur
        const t = turnText.get(k) || { q: '', a: '', time: 0 }
        if (!t.q) t.q = String(e.text || '').slice(0, 100)
        turnText.set(k, t)
      } else if (e.type === 'assistant/message' && e.turn != null) {
        cur = e.turn
        const k = sid + ':' + e.turn
        const t = turnText.get(k) || { q: '', a: '', time: 0 }
        if (!t.a) t.a = String(e.text || '').slice(0, 100)
        if (e.time) t.time = e.time
        turnText.set(k, t)
      }
    }
  } catch {}
  return { cwdBySid, turnText }
}

function fmt(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}
function money(n) {
  const v = Number(n) || 0
  if (v === 0) return '¥0'
  if (v < 0.01) return '¥' + v.toFixed(4)
  if (v < 1) return '¥' + v.toFixed(3)
  return '¥' + v.toFixed(2)
}
function shortModel(m) {
  const s = String(m || '').toLowerCase()
  if (!s) return ''
  if (s.includes('kimi')) return 'kimi'
  if (s.includes('pro')) return 'pro'
  if (s.includes('vision')) return 'vision'
  if (s.includes('flash')) return 'flash'
  return s
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function loadWsTitle() {
  const wsTitle = new Map()
  try {
    const j = JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8'))
    const table = (j && j.tables && j.tables.workspaces) || {}
    for (const w of Object.values(table)) {
      if (!w || !Array.isArray(w.sessionIds)) continue
      const t = String(w.title || '').trim() || '未分组'
      for (const id of w.sessionIds) wsTitle.set(String(id), t)
    }
  } catch {}
  return wsTitle
}

function loadSubagentMap() {
  const saMap = new Map()
  try {
    const j = JSON.parse(readFileSync(join(MEMORY_DIR, '子代理映射.json'), 'utf8'))
    for (const [sid, v] of Object.entries(j)) {
      if (v && v.origin === 'subagent' && v.parentSession) saMap.set(String(sid), String(v.parentSession))
    }
  } catch {}
  return saMap
}

function loadBalance() {
  const j = readJson(BALANCE_FILE, null)
  if (!j) return null
  return {
    date: j.date || '',
    lastBalance: typeof j.lastBalance === 'number' ? j.lastBalance : null,
    todayUsage: typeof j.todayUsage === 'number' ? j.todayUsage : null,
    dayStart: typeof j.dayStart === 'number' ? j.dayStart : null,
    history: j.history && typeof j.history === 'object' ? j.history : {},
  }
}

function loadTurnCost() {
  const j = readJson(TURNCOST_FILE, null)
  if (!j || !j.sessions) return { sessions: {}, dayTotals: {}, generatedAt: null }
  return { sessions: j.sessions, dayTotals: j.dayTotals || {}, generatedAt: j.generatedAt || null }
}

function loadOfficial() {
  const j = readJson(OFFICIAL_FILE, null)
  if (!j || !Array.isArray(j.days)) return { days: [], generatedAt: null, source: '' }
  return { days: j.days, generatedAt: j.generatedAt || null, source: j.source || '' }
}

// 硅基流动导出的 kimi 真账：按天，钱是平台扣的，不是咱估的
function loadKimi() {
  const j = readJson(KIMI_FILE, null)
  if (!j || !Array.isArray(j.days)) return { days: [], byDay: {}, generatedAt: null, source: '', total: 0, unitPrice: {} }
  const byDay = {}
  for (const d of j.days) if (d && d.day) byDay[d.day] = d
  return {
    days: j.days,
    byDay,
    generatedAt: j.generatedAt || null,
    source: j.source || '',
    total: Number(j.total) || 0,
    unitPrice: j.unitPricePerMillion || {},
    platform: j.platform || '硅基流动',
  }
}

// 一份 HTML 的全部输入。任一文件的 mtime/size 变了，整页重建。
function inputFiles() {
  return [
    join(MEMORY_DIR, 'token统计.jsonl'),
    join(MEMORY_DIR, 'token统计-历史.jsonl'),
    join(MEMORY_DIR, 'session-names.json'),
    ...projCacheFiles(),
    join(MEMORY_DIR, 'events.jsonl'),
    join(HOME, 'storages', 'workspace.json'),
    join(MEMORY_DIR, '子代理映射.json'),
    TURNCOST_FILE,
    OFFICIAL_FILE,
    KIMI_FILE,
    BALANCE_FILE,
  ]
}

// 对外：有缓存就还缓存（只换生成时间），没缓存才重建。view 参与缓存键。
export function renderHtml(view) {
  const v = view === 'day' ? 'day' : 'by-session'
  const stamp = stampOf(inputFiles()) + '|' + v
  const key = 'html:' + v
  const hit = cacheStore.get(key)
  if (hit && hit.stamp === stamp) return hit.value.replace(GEN_TOKEN, nowStr())
  const value = buildHtml(v)
  cacheStore.set(key, { stamp, value })
  return value.replace(GEN_TOKEN, nowStr())
}

function buildHtml(view) {
  const chats = loadChats()
  const pcFiles = projCacheFiles()
  const names = loadNames(pcFiles)
  const { cwdBySid, turnText } = loadEvents()
  const wsTitle = loadWsTitle()
  const saMap = loadSubagentMap()
  const balance = loadBalance()
  const tc = loadTurnCost()
  const official = loadOfficial()
  const kimi = loadKimi()

  const sidCache = new Map()
  function info(sid) {
    if (sidCache.has(sid)) return sidCache.get(sid)
    const ws = wsTitle.get(String(sid)) || '未分组'
    const name = names[sid] || sid.slice(0, 8)
    const o = { ws, name }
    sidCache.set(sid, o)
    return o
  }

  // 轮级账本里的全部轮次，按会话索引
  const tcBySid = new Map()
  for (const [sid, s] of Object.entries(tc.sessions)) {
    if (s && s.turns) tcBySid.set(String(sid), s.turns)
  }
  // 账本里出现过的 (sid, turn)，用来判断 chats 里哪些是新轮次
  const tcTurnSet = new Set()
  for (const [sid, turns] of tcBySid) for (const t of Object.keys(turns)) tcTurnSet.add(sid + ':' + t)

  // 会话集合 = 轮级账本 ∪ 流水账本
  const sidSet = new Set([...tcBySid.keys()])
  for (const c of chats) sidSet.add(String(c.sessionId))

  const wsMap = new Map() // ws -> { sessions: Map(sid->session), last: 0, cost: 0 }
  function ensureWs(ws) {
    if (!wsMap.has(ws)) wsMap.set(ws, { sessions: new Map(), last: 0, cost: 0 })
    return wsMap.get(ws)
  }
  function ensureSession(W, convSid, name) {
    if (!W.sessions.has(convSid)) W.sessions.set(convSid, { id: convSid, name, days: new Map(), total: 0, cost: 0, models: new Set() })
    return W.sessions.get(convSid)
  }
  function ensureDay(session, day) {
    if (!session.days.has(day)) session.days.set(day, { date: day, turns: [], subTurns: [], total: 0, cost: 0 })
    return session.days.get(day)
  }

  // 1) 先把轮级账本铺进去（有分档金额，可以显示真钱）
  for (const [sid, turns] of tcBySid) {
    const isSub = saMap.has(sid)
    const convSid = isSub ? saMap.get(sid) : sid
    const { ws, name } = info(convSid)
    const W = ensureWs(ws)
    const session = ensureSession(W, convSid, name)
    for (const [turnKey, t] of Object.entries(turns)) {
      const day = t.day || new Date(t.ts || 0).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
      const d = ensureDay(session, day)
      const txt = turnText.get(sid + ':' + turnKey) || { q: '', a: '', time: 0 }
      const rec = {
        turn: Number(turnKey),
        time: t.ts || txt.time || 0,
        model: t.model || '',
        hit: t.hit || 0, miss: t.miss || 0, out: t.out || 0,
        totalTokens: (t.hit || 0) + (t.miss || 0) + (t.out || 0),
        cost: Number(t.cost) || 0,
        costKnown: true,
        q: txt.q || '', a: txt.a || '',
        sub: isSub ? sid : null,
      }
      if (isSub) d.subTurns.push(rec); else d.turns.push(rec)
      d.total += rec.totalTokens; d.cost += rec.cost
      session.total += rec.totalTokens; session.cost += rec.cost
      if (rec.time > W.last) W.last = rec.time
      if (rec.model) session.models.add(shortModel(rec.model))
    }
  }

  // 2) 流水账本里比轮级账本更新的轮次 → 只显示 token，标「待补算」
  for (const c of chats) {
    const sid = String(c.sessionId)
    const isSub = saMap.has(sid)
    const convSid = isSub ? saMap.get(sid) : sid
    if (tcTurnSet.has(sid + ':' + c.turn)) continue
    const { ws, name } = info(convSid)
    const W = ensureWs(ws)
    const session = ensureSession(W, convSid, name)
    const day = new Date(c.ts || 0).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const d = ensureDay(session, day)
    const txt = turnText.get(sid + ':' + c.turn) || { q: '', a: '', time: 0 }
    const rec = {
      turn: c.turn,
      time: c.ts || txt.time || 0,
      model: c.model || '',
      hit: 0, miss: 0, out: 0,
      totalTokens: c.totalTokens || 0,
      cost: 0,
      costKnown: false,
      q: txt.q || '', a: txt.a || '',
      sub: isSub ? sid : null,
    }
    if (isSub) d.subTurns.push(rec); else d.turns.push(rec)
    d.total += rec.totalTokens
    session.total += rec.totalTokens
    if (rec.time > W.last) W.last = rec.time
    if (rec.model) session.models.add(shortModel(rec.model))
  }

  const totalAll = [...wsMap.values()].reduce((s, W) => s + [...W.sessions.values()].reduce((a, x) => a + x.total, 0), 0)
  const costAll = [...wsMap.values()].reduce((s, W) => s + [...W.sessions.values()].reduce((a, x) => a + x.cost, 0), 0)
  const turnsAll = [...wsMap.values()].reduce((s, W) => s + [...W.sessions.values()].reduce((a, x) => a + [...x.days.values()].reduce((b, d) => b + d.turns.length + d.subTurns.length, 0), 0), 0)

  const h = []
  h.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
  h.push('<title>token 消耗</title><style>')
  h.push('*{box-sizing:border-box}')
  h.push('body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:0 16px 24px;color:#1a1a1a;background:#f7f7f7}')
  h.push('.top{position:sticky;top:0;z-index:10;background:#f7f7f7;padding:12px 0 10px;border-bottom:1px solid #e0e0e0;margin-bottom:12px}')
  h.push('.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}')
  h.push('h1{font-size:18px;margin:0}')
  h.push('button{cursor:pointer;border:1px solid #c8c8c8;background:#fff;border-radius:6px;padding:5px 14px;font-size:13px}')
  h.push('button:hover{background:#f0f6ff}')
  h.push('button.on{background:#1a6bb0;color:#fff;border-color:#1a6bb0}')
  h.push('.meta{font-size:12px;color:#888}')
  h.push('.bal{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;margin-top:8px;font-size:13px}')
  h.push('.bal b{font-size:17px;font-weight:700}')
  h.push('.bal .k{color:#888;font-size:12px;margin-right:4px}')
  h.push('.bal .warn{color:#b00;font-size:12px}')
  h.push('details{margin:2px 0;background:#fff;border-radius:6px;border:1px solid #e3e3e3}')
  h.push('summary{cursor:pointer;padding:8px 10px;font-size:13px;user-select:none}')
  h.push('summary:hover{background:#f0f6ff}')
  h.push('.ws>summary{font-weight:700;background:#eef4fb}')
  h.push('.session>summary{font-weight:600}')
  h.push('.day>summary{color:#555}')
  h.push('.tok{color:#b00;font-weight:600;font-size:12px;margin-left:6px}')
  h.push('.money{color:#0a7a3d;font-weight:600;font-size:12px;margin-left:6px}')
  h.push('.mdl{color:#7a5cc0;font-size:11px;margin-left:6px;font-weight:400}')
  h.push('.pending{color:#b8860b;font-size:11px;margin-left:4px}')
  h.push('.detail{padding:4px 10px 8px 22px;font-size:12px;color:#444}')
  h.push('.q{color:#1a6bb0}.a{color:#666;margin-top:2px}')
  h.push('.turn>summary{font-size:12px;color:#666}')
  h.push('.chart{display:flex;align-items:flex-end;gap:4px;height:180px;padding:12px 10px;background:#fff;border:1px solid #e3e3e3;border-radius:6px;margin-bottom:12px;overflow-x:auto}')
  h.push('.col{flex:1 0 28px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative}')
  h.push('.stack{width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:1px}')
  h.push('.seg{width:100%;border-radius:2px 2px 0 0}')
  h.push('.seg.flash{background:#5b9bd5}.seg.pro{background:#c05c9c}.seg.kimi{background:#3aa66b}.seg.other{background:#bbb}')
  h.push('.tip{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:#222;color:#fff;font-size:11px;padding:6px 9px;border-radius:5px;white-space:nowrap;z-index:20;line-height:1.55;pointer-events:none;margin-bottom:6px;text-align:left}')
  h.push('.col:hover .tip{display:block}')
  h.push('.hint{color:#999;font-size:10px;font-weight:400;margin-left:2px}')
  h.push('.est{color:#3aa66b}')
  h.push('.col .lbl{font-size:10px;color:#888;margin-top:4px;white-space:nowrap}')
  h.push('.col.today .lbl{color:#1a6bb0;font-weight:700}')
  h.push('.col .amt{font-size:9px;color:#666;margin-bottom:2px;white-space:nowrap}')
  h.push('table{border-collapse:collapse;width:100%;background:#fff;font-size:13px;border:1px solid #e3e3e3;border-radius:6px;overflow:hidden}')
  h.push('th,td{padding:7px 10px;text-align:right;border-bottom:1px solid #eee}')
  h.push('th{background:#eef4fb;font-weight:600;font-size:12px;color:#555}')
  h.push('td:first-child,th:first-child{text-align:left}')
  h.push('tr.today td{background:#f0f8ff;font-weight:600}')
  h.push('tr:last-child td{border-bottom:none}')
  h.push('</style></head><body>')

  // 顶部：余额条 + 视图切换
  h.push('<div class="top">')
  h.push('<div class="bar"><h1>token 消耗</h1>')
  h.push('<button class="' + (view === 'day' ? '' : 'on') + '" onclick="location.href=\'/\'">按会话</button>')
  h.push('<button class="' + (view === 'day' ? 'on' : '') + '" onclick="location.href=\'/?view=day\'">按天</button>')
  h.push('<button onclick="location.reload()">刷新</button>')
  h.push('<span class="meta">' + turnsAll + ' 轮 · 合计 ' + fmt(totalAll) + ' token · ' + money(costAll) + ' · 生成于 ' + GEN_TOKEN + '</span></div>')

  // 余额条
  const b = []
  if (balance && balance.lastBalance != null) {
    b.push('<span><span class="k">余额</span><b>¥' + balance.lastBalance.toFixed(2) + '</b></span>')
    if (balance.todayUsage != null) b.push('<span><span class="k">今日已用</span><b>¥' + balance.todayUsage.toFixed(2) + '</b></span>')
    if (balance.dayStart != null) b.push('<span><span class="k">今日零点</span>¥' + balance.dayStart.toFixed(2) + '</span>')
    // 对账：今日已用 vs 今天官方账
    const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const todayOff = official.days.find((d) => d.day === todayKey)
    if (todayOff && balance.todayUsage != null) {
      b.push('<span><span class="k">今日官方账</span>¥' + Number(todayOff.cost).toFixed(2) + '</span>')
    }
    const yrs = Object.keys(balance.history || {}).sort()
    const last7 = yrs.slice(-7)
    if (last7.length) {
      b.push('<span class="meta">近七天：' + last7.map((d) => d.slice(5) + ' ¥' + Number(balance.history[d]).toFixed(2)).join(' · ') + '</span>')
    }
  } else {
    b.push('<span class="warn">余额没读到（.dshw-usage.json 缺失或挂件没在写）</span>')
  }
  h.push('<div class="bal">' + b.join('') + '</div>')
  h.push('</div>')

  if (view === 'day') {
    renderDayView(h, official, balance, tc, kimi)
  } else {
    renderSessionView(h, wsMap)
  }

  h.push('</body></html>')
  return h.join('\n')
}

// ---------- 按会话视图 ----------
function renderSessionView(h, wsMap) {
  function renderTurn(t) {
    const out = []
    const m = t.model ? '<span class="mdl">' + esc(shortModel(t.model)) + '</span>' : ''
    const c = t.costKnown
      ? '<span class="money">' + money(t.cost) + '</span>'
      : '<span class="pending">待补算</span>'
    out.push('<details class="turn"><summary>第 ' + t.turn + ' 轮 · ' + fmt(t.totalTokens) + m + c + '</summary>')
    if (t.q) out.push('<div class="detail"><div class="q">问：' + esc(t.q) + '</div></div>')
    if (t.a) out.push('<div class="detail"><div class="a">答：' + esc(t.a) + '</div></div>')
    if (!t.q && !t.a) out.push('<div class="detail">（正文未记，只有消耗）</div>')
    out.push('</details>')
    return out.join('')
  }

  const wsSorted = [...wsMap.entries()].sort((a, b) => b[1].last - a[1].last || a[0].localeCompare(b[0]))

  for (let i = 0; i < wsSorted.length; i++) {
    const [ws, W] = wsSorted[i]
    let wsTotal = 0, wsCost = 0
    for (const s of W.sessions.values()) { wsTotal += s.total; wsCost += s.cost }
    const openAttr = i === 0 ? ' open' : ''
    h.push('<details class="ws"' + openAttr + '><summary>' + esc(ws) + ' <span class="tok">' + W.sessions.size + ' 会话 · ' + fmt(wsTotal) + '</span><span class="money">' + money(wsCost) + '</span></summary>')
    const sessSorted = [...W.sessions.values()].sort((a, b) => b.total - a.total)
    for (const s of sessSorted) {
      const mdl = [...s.models].slice(0, 3).map((m) => '<span class="mdl">' + esc(m) + '</span>').join('')
      h.push('<details class="session"><summary>' + esc(s.name) + ' <span class="tok">' + fmt(s.total) + '</span><span class="money">' + money(s.cost) + '</span>' + mdl + '</summary>')
      const daysSorted = [...s.days.values()].sort((a, b) => a.date.localeCompare(b.date))
      for (const d of daysSorted) {
        h.push('<details class="day"><summary>' + d.date + ' <span class="tok">' + fmt(d.total) + '</span><span class="money">' + money(d.cost) + '</span></summary>')
        for (const t of d.turns.sort((a, b) => (a.turn || 0) - (b.turn || 0))) h.push(renderTurn(t))
        if (d.subTurns.length) {
          const bySub = new Map()
          for (const t of d.subTurns) {
            if (!bySub.has(t.sub)) bySub.set(t.sub, [])
            bySub.get(t.sub).push(t)
          }
          const subSum = d.subTurns.reduce((s, t) => s + (t.totalTokens || 0), 0)
          const subCost = d.subTurns.reduce((s, t) => s + (t.cost || 0), 0)
          h.push('<details class="day subagent"><summary>🤖 子代理 ' + bySub.size + ' 个 <span class="tok">' + fmt(subSum) + '</span><span class="money">' + money(subCost) + '</span></summary>')
          for (const [subId, subs] of bySub) {
            subs.sort((a, b) => (a.turn || 0) - (b.turn || 0))
            const oneCost = subs.reduce((s, t) => s + (t.cost || 0), 0)
            h.push('<details class="day"><summary>子代理 ' + esc(subId.slice(0, 8)) + ' · ' + fmt(subs.reduce((s, t) => s + (t.totalTokens || 0), 0)) + '<span class="money">' + money(oneCost) + '</span></summary>')
            for (const t of subs) h.push(renderTurn(t))
            h.push('</details>')
          }
          h.push('</details>')
        }
        h.push('</details>')
      }
      h.push('</details>')
    }
    h.push('</details>')
  }
}

// ---------- 按天视图 ----------
function renderDayView(h, official, balance, tc, kimi) {
  const days = official.days.slice().sort((a, b) => a.day.localeCompare(b.day))
  if (!days.length) {
    h.push('<div class="meta">官方账还没导入（把导出的 CSV 放进 usage-export 再跑一遍解析就行）</div>')
    return
  }
  const todayKey = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const myDays = tc.dayTotals || {}
  // 我算的账按天×模型，用来补 kimi（官方 DeepSeek 账里没有它）
  const myModelByDay = {}
  for (const s of Object.values(tc.sessions || {})) {
    for (const t of Object.values(s.turns || {})) {
      if (!t.day) continue
      const m = shortModel(t.model) || 'other'
      myModelByDay[t.day] = myModelByDay[t.day] || {}
      myModelByDay[t.day][m] = (myModelByDay[t.day][m] || 0) + (Number(t.cost) || 0)
    }
  }
  // kimi 的钱优先用硅基流动账单（平台扣的），没有那天再退回我按单价算的
  function kimiOf(day) {
    const k = (kimi && kimi.byDay) ? kimi.byDay[day] : null
    if (k) return { cost: Number(k.cost) || 0, official: true, models: k.models || {} }
    const v = (myModelByDay[day] || {}).kimi || 0
    return { cost: v, official: false, models: {} }
  }
  const recent = days.slice(-14)
  const maxCost = Math.max(...recent.map((d) => Number(d.cost) || 0), 1e-9) * 1.12

  // 柱状图
  h.push('<div class="chart">')
  for (const d of recent) {
    const total = Number(d.cost) || 0
    const pct = (total / maxCost) * 100
    const segs = Object.entries(d.models || {})
      .map(([m, v]) => ({ m: shortModel(m), c: Number(v.cost) || 0 }))
      .sort((a, b) => b.c - a.c)
    const searchCost = Number(d.search) || 0
    const isToday = d.day === todayKey ? ' today' : ''
    // hover 弹窗内容
    const tipLines = segs.map((s) => s.m + ' ¥' + s.c.toFixed(3)).concat(searchCost > 0 ? ['搜索 ¥' + searchCost.toFixed(3) + '（' + (d.searchTimes || 0) + ' 次）'] : [])
    h.push('<div class="col' + isToday + '">')
    h.push('<div class="amt">' + (total > 0 ? '¥' + total.toFixed(1) : '') + '</div>')
    h.push('<div class="stack" style="height:' + pct.toFixed(1) + '%">')
    for (const s of segs) {
      const sub = total > 0 ? (s.c / total) * 100 : 0
      const cls = s.m === 'flash' ? 'flash' : s.m === 'pro' ? 'pro' : s.m === 'kimi' ? 'kimi' : 'other'
      h.push('<div class="seg ' + cls + '" style="height:' + sub.toFixed(1) + '%"></div>')
    }
    h.push('</div>')
    h.push('<div class="lbl">' + d.day.slice(5) + '</div>')
    h.push('<div class="tip"><b>' + d.day + '</b><br>' + tipLines.join('<br>') + '<br><b>合计 ¥' + total.toFixed(3) + '</b></div>')
    h.push('</div>')
  }
  h.push('</div>')

  // 表格：官方模型列 + kimi（我算）+ 搜索
  const offModels = [...new Set(days.flatMap((d) => Object.keys(d.models || {})))].sort()
  const hasKimi = days.some((d) => (myModelByDay[d.day] || {}).kimi)
  const hasSearch = days.some((d) => Number(d.search) > 0)
  h.push('<table><thead><tr><th>日期</th>')
  for (const m of offModels) h.push('<th>' + esc(shortModel(m)) + ' ¥</th>')
  if (hasKimi) h.push('<th>kimi ¥<span class="hint">硅基流动</span></th>')
  if (hasSearch) h.push('<th>搜索 ¥</th>')
  h.push('<th>合计 ¥</th><th>请求</th><th>我算 ¥</th><th>差</th></tr></thead><tbody>')
  let sum = 0, sumReq = 0, sumMyDs = 0, sumSearch = 0, sumKimi = 0
  for (const d of days) {
    const total = Number(d.cost) || 0
    sum += total
    sumReq += Number(d.requests) || 0
    const searchCost = Number(d.search) || 0
    sumSearch += searchCost
    const kk = kimiOf(d.day)
    const kimiCost = kk.cost
    sumKimi += kimiCost
    const mine = myDays[d.day] ? Number(myDays[d.day].cost) || 0 : 0
    // 官方合计是 DeepSeek 的钱，kimi 走 Moonshot 不在里面。
    // 比差时把我算里的 kimi 抠掉，否则那天会变成负数看着像账错了。
    const mineDs = mine - kimiCost
    const diff = total - mineDs
    sumMyDs += mineDs
    const cls = d.day === todayKey ? ' class="today"' : ''
    h.push('<tr' + cls + '><td>' + d.day + '</td>')
    for (const m of offModels) {
      const v = d.models && d.models[m] ? Number(d.models[m].cost) || 0 : 0
      h.push('<td>' + (v > 0 ? v.toFixed(2) : '') + '</td>')
    }
    if (hasKimi) h.push('<td>' + (kimiCost > 0 ? (kk.official ? kimiCost.toFixed(2) : '<span class="est">' + kimiCost.toFixed(2) + '</span>') : '') + '</td>')
    if (hasSearch) h.push('<td>' + (searchCost > 0 ? searchCost.toFixed(2) : '') + '</td>')
    h.push('<td><b>' + total.toFixed(2) + '</b></td>')
    h.push('<td>' + (d.requests || 0) + '</td>')
    h.push('<td>' + (mine > 0 ? mineDs.toFixed(2) : '') + '</td>')
    h.push('<td>' + (mine > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(2) : '') + '</td>')
    h.push('</tr>')
  }
  h.push('<tr><td><b>合计</b></td>')
  for (let i = 0; i < offModels.length; i++) h.push('<td></td>')
  if (hasKimi) h.push('<td><b>' + (sumKimi > 0 ? sumKimi.toFixed(2) : '') + '</b></td>')
  if (hasSearch) h.push('<td><b>' + sumSearch.toFixed(2) + '</b></td>')
  h.push('<td><b>' + sum.toFixed(2) + '</b></td><td>' + sumReq + '</td><td>' + sumMyDs.toFixed(2) + '</td><td>' + (sum - sumMyDs >= 0 ? '+' : '') + (sum - sumMyDs).toFixed(2) + '</td></tr>')
  h.push('</tbody></table>')
  const kimiNote = (kimi && kimi.days && kimi.days.length)
    ? 'kimi 那一列是硅基流动账单里的真数（平台扣的钱，单价输入 ¥' + (kimi.unitPrice['input-tokens'] || 6.5) + ' / 缓存 ¥' + (kimi.unitPrice['cached-input-tokens'] || 1.3) + ' / 输出 ¥' + (kimi.unitPrice['output-tokens'] || 27) + ' 每百万），取自「' + esc(String(kimi.source || '').split('\\').pop()) + '」，解析于 ' + esc(kimi.generatedAt || '') + '，但漏掉的日子是我按同单价估的（绿色）。kimi 走硅基流动、不在 DeepSeek 账里，所以不参与右边的「我算 / 差」。'
    : 'kimi 那一列是我按硅基流动单价估的（还没导入账单），不参与右边的「我算 / 差」。'
  h.push('<div class="meta" style="margin-top:8px">官方账来自 platform 导出的 CSV（' + esc(official.source || '') + '），解析于 ' + esc(official.generatedAt || '') + '。请求数含所有 key，我算的只统计本机 DSH 会话。' + kimiNote + '</div>')
}

export function startTokenServer(port, onReady) {
  const p = Number(port) || PORT
  const server = createServer((req, res) => {
    try {
      let view = 'by-session'
      try {
        const u = new URL(req.url || '/', 'http://localhost')
        if (u.searchParams.get('view') === 'day') view = 'day'
      } catch {}
      const html = renderHtml(view)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('渲染失败: ' + (e && e.message))
    }
  })
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') return
    try { console.error('token 服务出错:', err && err.message) } catch (e) {}
  })
  server.listen(p, '127.0.0.1', () => { try { onReady && onReady(p) } catch (e) {} })
  return server
}

// CLI：node tools\token-server.mjs [端口]
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/token-server.mjs')) {
  startTokenServer(PORT, (p) => console.log('token 服务已起：http://127.0.0.1:' + p))
}
