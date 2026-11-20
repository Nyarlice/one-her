#!/usr/bin/env node
// 生成 token 消耗网页：读 token 账本（实时 + 历史）+ events.jsonl（正文/工作区）+ session-names（标题），
// 拼成可折叠的「工作区 → 会话 → 日期 → 轮」层级，输出单个 index.html。
// 用法：node tools\gen-token-page.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home'
const MEMORY_DIR = join(HOME, '记忆')
const OUT_FILE = join(HOME, 'token消耗.html')

// ---------- 1. 读 chat 记录（实时 + 历史） ----------
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

// ---------- 2. 读标题 ----------
let names = {}
try { names = JSON.parse(readFileSync(join(MEMORY_DIR, 'session-names.json'), 'utf8')) } catch {}

// ---------- 3. 读 events.jsonl，建 sessionId -> cwd、sessionId:turn -> 摘要 ----------
const cwdBySid = new Map()
const turnText = new Map() // sid:turn -> { q, a, time }
let currentTurn = 0
try {
  for (const l of readFileSync(join(MEMORY_DIR, 'events.jsonl'), 'utf8').split('\n')) {
    if (!l.trim()) continue
    let e; try { e = JSON.parse(l) } catch { continue }
    const sid = e.session_id
    if (!sid) continue
    if (e.cwd && !cwdBySid.has(sid)) cwdBySid.set(sid, e.cwd)
    if (e.type === 'turn/start' && e.turn != null) currentTurn = e.turn
    else if (e.type === 'user/message') {
      const key = sid + ':' + currentTurn
      const cur = turnText.get(key) || { q: '', a: '', time: 0 }
      if (!cur.q) cur.q = String(e.text || '').slice(0, 100)
      turnText.set(key, cur)
    } else if (e.type === 'assistant/message' && e.turn != null) {
      currentTurn = e.turn
      const key = sid + ':' + e.turn
      const cur = turnText.get(key) || { q: '', a: '', time: 0 }
      if (!cur.a) cur.a = String(e.text || '').slice(0, 100)
      if (e.time) cur.time = e.time
      turnText.set(key, cur)
    }
  }
} catch {}

// ---------- 4. 聚合层级 ----------
// 2026-11-08：工作区按 DSH 自己的定义分（storages\workspace.json 的 sessionIds -> title），跟侧栏一致。
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
const wsMap = new Map() // 工作区名 -> Map(sid -> { sessions })
const sidCache = new Map()
function sidInfo(sid) {
  if (sidCache.has(sid)) return sidCache.get(sid)
  const ws = wsTitle.get(String(sid)) || '未分组'
  const name = names[sid] || sid.slice(0, 8)
  const info = { ws, name }
  sidCache.set(sid, info)
  return info
}

// 2026-11-08：子代理 → 父会话（tools\build-subagent-map.mjs 生成）。归到父会话下。
const saMap = new Map()
try {
  const j = JSON.parse(readFileSync(join(HOME, '记忆', '子代理映射.json'), 'utf8'))
  for (const [sid, v] of Object.entries(j)) {
    if (v && v.origin === 'subagent' && v.parentSession) saMap.set(String(sid), String(v.parentSession))
  }
} catch {}

for (const c of chats) {
  const sid = String(c.sessionId)
  const isSub = saMap.has(sid)
  const convSid = isSub ? saMap.get(sid) : sid
  const { ws, name } = sidInfo(convSid)
  if (!wsMap.has(ws)) wsMap.set(ws, new Map())
  const sessions = wsMap.get(ws)
  if (!sessions.has(convSid)) sessions.set(convSid, { id: convSid, name, days: new Map(), total: 0 })
  const session = sessions.get(convSid)
  const day = new Date(c.ts || 0).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
  if (!session.days.has(day)) session.days.set(day, { date: day, turns: [], subTurns: [], total: 0 })
  const d = session.days.get(day)
  const txt = turnText.get(sid + ':' + c.turn) || { q: '', a: '', time: 0 }
  const turn = {
    turn: c.turn,
    time: c.ts || txt.time || 0,
    inputTokens: c.inputTokens || 0,
    outputTokens: c.outputTokens || 0,
    totalTokens: c.totalTokens || 0,
    q: txt.q || '',
    a: txt.a || '',
    sub: isSub ? sid : null,
  }
  if (isSub) d.subTurns.push(turn); else d.turns.push(turn)
  d.total += c.totalTokens || 0
  session.total += c.totalTokens || 0
}

// ---------- 5. 渲染 HTML ----------
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function renderTurn(t) {
  const out = []
  out.push('<details class="turn"><summary>第 ' + t.turn + ' 轮 · ' + fmt(t.totalTokens) + ' <span style="color:#999">(in ' + fmt(t.inputTokens) + ' / out ' + fmt(t.outputTokens) + ')</span></summary>')
  if (t.q) out.push('<div class="detail"><div class="q">问：' + esc(t.q) + '</div></div>')
  if (t.a) out.push('<div class="detail"><div class="a">答：' + esc(t.a) + '</div></div>')
  if (!t.q && !t.a) out.push('<div class="detail">（正文未记，只有消耗）</div>')
  out.push('</details>')
  return out.join('')
}

const html = []
html.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">')
html.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
html.push('<title>token 消耗</title><style>')
html.push('body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#f7f7f7}')
html.push('h1{font-size:18px;margin:0 0 12px}')
html.push('.meta{font-size:12px;color:#888;margin-bottom:16px}')
html.push('details{margin:2px 0;background:#fff;border-radius:6px;border:1px solid #e3e3e3}')
html.push('summary{cursor:pointer;padding:8px 10px;font-size:13px;user-select:none}')
html.push('summary:hover{background:#f0f6ff}')
html.push('.ws>summary{font-weight:700;background:#eef4fb}')
html.push('.session>summary{font-weight:600}')
html.push('.day>summary{color:#555}')
html.push('.tok{color:#b00;font-weight:600;font-size:12px;margin-left:6px}')
html.push('.detail{padding:4px 10px 8px 22px;font-size:12px;color:#444}')
html.push('.q{color:#1a6bb0}.a{color:#666;margin-top:2px}')
html.push('.turn>summary{font-size:12px;color:#666}')
html.push('</style></head><body>')

const totalAll = chats.reduce((s, c) => s + (c.totalTokens || 0), 0)
html.push('<h1>token 消耗</h1>')
html.push('<div class="meta">' + chats.length + ' 轮 · 合计 ' + fmt(totalAll) + ' token · 覆盖 10-25 起（缓存读取已计入输入）</div>')

const wsSorted = [...wsMap.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
for (const [ws, sessions] of wsSorted) {
  let wsTotal = 0
  for (const s of sessions.values()) wsTotal += s.total
  html.push('<details class="ws" open><summary>' + esc(ws) + ' <span class="tok">' + sessions.size + ' 会话 · ' + fmt(wsTotal) + '</span></summary>')
  const sessSorted = [...sessions.values()].sort((a, b) => b.total - a.total)
  for (const s of sessSorted) {
    html.push('<details class="session"><summary>' + esc(s.name) + ' <span class="tok">' + fmt(s.total) + '</span></summary>')
    const daysSorted = [...s.days.values()].sort((a, b) => a.date.localeCompare(b.date))
    for (const d of daysSorted) {
      html.push('<details class="day"><summary>' + d.date + ' <span class="tok">' + fmt(d.total) + '</span></summary>')
      for (const t of d.turns.sort((a, b) => (a.turn || 0) - (b.turn || 0))) html.push(renderTurn(t))
      if (d.subTurns.length) {
        const bySub = new Map()
        for (const t of d.subTurns) {
          if (!bySub.has(t.sub)) bySub.set(t.sub, [])
          bySub.get(t.sub).push(t)
        }
        const subSum = d.subTurns.reduce((s, t) => s + (t.totalTokens || 0), 0)
        html.push('<details class="day subagent"><summary>🤖 子代理 ' + bySub.size + ' 个 <span class="tok">' + fmt(subSum) + '</span></summary>')
        for (const [subId, subs] of bySub) {
          subs.sort((a, b) => (a.turn || 0) - (b.turn || 0))
          html.push('<details class="day"><summary>子代理 ' + esc(subId.slice(0, 8)) + ' · ' + fmt(subs.reduce((s, t) => s + (t.totalTokens || 0), 0)) + '</summary>')
          for (const t of subs) html.push(renderTurn(t))
          html.push('</details>')
        }
        html.push('</details>')
      }
      html.push('</details>')
    }
    html.push('</details>')
  }
  html.push('</details>')
}
html.push('</body></html>')

writeFileSync(OUT_FILE, html.join('\n'), 'utf8')
console.log('生成', OUT_FILE, '（', chats.length, '轮，', wsMap.size, '个工作区）')
