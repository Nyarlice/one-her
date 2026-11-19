// 提炼记忆的语义检索：给 提炼记忆.jsonl 建向量索引（bge-m3），查询按余弦召回。
// 用来补 recall-core 的 2-gram 死穴：整句口语 / 改述召回不到「求职」这类记忆。
//
// 用法：
//   node lib/recall-semantic.mjs --build                 # 建/更新索引
//   node lib/recall-semantic.mjs "求职" [--limit 5] [--json] [--inject]
//
// 索引存 记忆\提炼记忆向量索引.json；模型本地 ollama 的 bge-m3（1024 维）。
// ollama 没起就 `docker start ollama`。
//
// 2026-11-08 夜：算法搬到 recall-semantic-core.mjs，这份只剩命令行外壳；
//   dsh-recall 插件进程内直接用 core，不再 spawn 这个脚本。
import { readFileSync, existsSync, statSync } from 'node:fs'
import {
  MEM_FILE,
  INDEX_FILE,
  MODEL,
  DIM,
  loadMemories,
  loadIndex,
  embed,
  scoreAll,
  selectInject,
  renderInject,
  saveIndex,
  toB64,
} from './recall-semantic-core.mjs'

const argv = process.argv.slice(2)
const build = argv.includes('--build')
const wantJson = argv.includes('--json')
const limitIdx = argv.indexOf('--limit')
const limit = limitIdx >= 0 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : 5
const query = (() => {
  const parts = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit') { i++; continue }
    if (a.startsWith('--')) continue
    parts.push(a)
  }
  return parts.join(' ').trim()
})()

if (build) {
  // 建索引要读最新的盘上索引，不用缓存
  const memories = loadMemories()
  console.log(`提炼记忆 ${memories.length} 条`)
  let index = { model: MODEL, dim: DIM, builtAt: 0, items: {} }
  if (existsSync(INDEX_FILE)) {
    try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) } catch {}
    if (index.model !== MODEL) index = { model: MODEL, dim: DIM, builtAt: 0, items: {} }
  }
  const missing = memories.filter(m => !index.items[m.id])
  console.log(`已有 ${Object.keys(index.items).length} 条，需补 ${missing.length} 条`)
  const BATCH = 12
  let done = 0
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH)
    const vectors = await embed(chunk.map(m => m.text.slice(0, 400)), 60000)
    chunk.forEach((m, k) => { index.items[m.id] = toB64(vectors[k]) })
    done += chunk.length
    if (done % 120 === 0 || done === missing.length) {
      process.stdout.write(`  已补 ${done}/${missing.length}\n`)
      saveIndex(index)
    }
  }
  const alive = new Set(memories.map(m => m.id))
  let dropped = 0
  for (const id of Object.keys(index.items)) if (!alive.has(id)) { delete index.items[id]; dropped++ }
  index.builtAt = Date.now()
  saveIndex(index)
  console.log(`索引完成：${Object.keys(index.items).length} 条（清掉 ${dropped} 条过期），${(statSync(INDEX_FILE).size / 1048576).toFixed(1)} MB`)
  process.exit(0)
}

if (!query) {
  console.log('用法：node lib/recall-semantic.mjs --build')
  console.log('      node lib/recall-semantic.mjs "查的话" [--limit 5] [--json] [--inject]')
  process.exit(1)
}

const index = loadIndex()
if (!index) {
  if (!existsSync(INDEX_FILE)) {
    console.error(`还没有索引（${INDEX_FILE}），先跑 --build`)
  } else {
    console.error(`索引读不了或模型对不上（${INDEX_FILE}）`)
  }
  process.exit(1)
}

const memories = loadMemories()
if (!memories.length) {
  console.error(`读不到提炼记忆：${MEM_FILE}`)
  process.exit(1)
}
const byId = new Map(memories.map(m => [m.id, m]))
const [qv] = await embed([query], 30000)
const scored = scoreAll(qv, index, byId)

// --inject：语义召回 + 事实键去重 + importance 排序 + 渲染成注入文本（给 recall 插件用）
if (argv.includes('--inject')) {
  const out = renderInject(selectInject(query, scored))
  if (out) process.stdout.write(out)
  process.exit(0)
}

const top = scored.slice(0, limit)
if (wantJson) {
  process.stdout.write(JSON.stringify(top.map(({ m, score }) => ({
    score: Number(score.toFixed(4)),
    id: m.id,
    text: m.text,
    category: m.category,
    importance: m.importance,
    at: m.at,
    '事实键': m['事实键'],
  }))))
} else {
  for (const { m, score } of top) {
    console.log(`${score.toFixed(3)} · ${m['事实键'] || '无键'} · ${m.text.slice(0, 60)}`)
  }
}
process.exit(0)
