#!/usr/bin/env node
// 扫会话文件，把「子代理 → 父会话」关系抽出来，存 记忆\子代理映射.json。
// 用法：node tools\build-subagent-map.mjs
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// 家目录：优先读 DSH_HOME，读不到才落到本机默认路径。
const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home'
const SESSIONS = join(HOME, 'sessions')
const OUT = join(HOME, '记忆', '子代理映射.json')

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (name === 'session.v4.jsonl.zstd') out.push(p)
  }
}

const files = []
walk(SESSIONS, files)

const map = {}
for (const file of files) {
  let buf; try { buf = readFileSync(file) } catch { continue }
  const sid = basename(dirname(file))
  const starts = []
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i)
  }
  if (!starts.length) continue
  let found = null
  for (let i = 0; i < starts.length && !found; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    let dec; try { dec = zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8') } catch { continue }
    for (const line of dec.split('\n')) {
      const t = line.trim(); if (!t) continue
      let ev; try { ev = JSON.parse(t) } catch { continue }
      if (ev.type !== 'session') continue
      found = { origin: ev.origin || 'user', parentSession: ev.parentSession || null }
      break
    }
  }
  if (found) map[sid] = found
}

writeFileSync(OUT, JSON.stringify(map, null, 2), 'utf8')
const subs = Object.values(map).filter((v) => v.origin === 'subagent').length
console.log('会话数', Object.keys(map).length, '子代理数', subs, '写入', OUT)
