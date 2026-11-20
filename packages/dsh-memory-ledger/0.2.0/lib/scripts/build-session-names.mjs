#!/usr/bin/env node
// 生成会话标题：优先用 DSH 自己的真标题（storages\session_projcache\sessions\<sid>.json 的 record.rows.title.val），
// 没有真标题的用「未命名会话-HH.MM.SS（YY.MM.DD）」。写 记忆\session-names.json。
// 用法：node tools\build-session-names.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROJ = join(HOME, 'storages', 'session_projcache', 'sessions')
const namesFile = join(HOME, '记忆', 'session-names.json')

// 2026-11-09：子代理单独起名。以前它们没标题，全被叫「未命名会话-时间」，
//   还常常同名（批量子代理），主人看报告以为是自己的会话丢了。
const subMap = (() => {
  try {
    return JSON.parse(readFileSync(join(HOME, '记忆', '子代理映射.json'), 'utf8')) || {}
  } catch {
    return {}
  }
})()
function subInfo(sid) {
  const v = subMap[sid]
  if (!v) return null
  if (v.origin !== 'subagent' && !v.parentSession) return null
  return { parent: v.parentSession ? String(v.parentSession) : '' }
}

// 1. 读 projcache 里的真标题 + 创建时间
const real = new Map()
if (existsSync(PROJ)) {
  for (const f of readdirSync(PROJ)) {
    if (!f.endsWith('.json')) continue
    const sid = f.slice(0, -5)
    try {
      const j = JSON.parse(readFileSync(PROJ + '\\' + f, 'utf8'))
      const rows = (j && j.record && j.record.rows) || {}
      const identity = (j && j.record && j.record.identity) || {}
      const title = rows.title && rows.title.val
      real.set(sid, {
        title: typeof title === 'string' ? title.trim() : '',
        createdAt: Number(identity.createdAt) || 0,
      })
    } catch {}
  }
}

// 2. events.jsonl 兜底：每个会话最早一条消息的时间
const firstTime = new Map()
for (const l of readFileSync(HOME + '\\记忆\\events.jsonl', 'utf8').split('\n')) {
  if (!l.trim()) continue
  let e; try { e = JSON.parse(l) } catch { continue }
  if (e.type !== 'user/message' || !e.time) continue
  const sid = String(e.session_id)
  if (firstTime.has(sid)) continue
  firstTime.set(sid, Number(e.time))
}

function stamp(ts) {
  const bj = new Date(ts + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  const time = p(bj.getUTCHours()) + '.' + p(bj.getUTCMinutes()) + '.' + p(bj.getUTCSeconds())
  const date = String(bj.getUTCFullYear() % 100).padStart(2, '0') + '.' + p(bj.getUTCMonth() + 1) + '.' + p(bj.getUTCDate())
  return { time, date }
}

// 标题像不像一个「名字」：太长/带 markdown/整句话/像指令的，都不算。
function looksLikeName(t) {
  if (!t) return false
  const s = String(t).trim()
  if (!s || s.length > 30) return false
  if (/[*#`\[\]【】|<>\\\/]/.test(s)) return false
  if (/[。！？；，]/.test(s)) return false
  if (/^你/.test(s) && s.length > 10) return false
  return true
}

// 3. 合并
const out = {}
let realCount = 0, unnamedCount = 0, subCount = 0
const sids = new Set([...real.keys(), ...firstTime.keys()])
// 先算一遍"谁叫什么"，好让子代理能引用父会话的名字（父可能排在后面）
const baseName = new Map()
for (const sid of sids) {
  const r = real.get(sid)
  if (r && r.title && looksLikeName(r.title)) {
    baseName.set(sid, r.title)
    continue
  }
  const ts = (r && r.createdAt) || firstTime.get(sid) || 0
  if (!ts) continue
  const { time, date } = stamp(ts)
  baseName.set(sid, '未命名会话-' + time + '（' + date + '）')
}
for (const sid of sids) {
  const sub = subInfo(sid)
  if (sub) {
    const parentName = sub.parent ? (baseName.get(sub.parent) || sub.parent.slice(0, 8)) : '无父会话（孤儿）'
    out[sid] = '子代理·' + parentName
    subCount++
    continue
  }
  const name = baseName.get(sid)
  if (!name) continue
  out[sid] = name
  if (name.startsWith('未命名会话-')) unnamedCount++
  else realCount++
}

writeFileSync(namesFile, JSON.stringify(out, null, 2), 'utf8')
console.log('真标题', realCount, '· 未命名', unnamedCount, '· 子代理', subCount, '· 共', Object.keys(out).length, '个会话')
