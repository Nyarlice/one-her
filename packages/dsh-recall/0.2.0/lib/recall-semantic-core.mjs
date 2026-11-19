// recall-semantic-core.mjs —— 提炼记忆的语义检索（进程内版）
//
// 2026-11-08 夜：从 recall-semantic.mjs 的 CLI 里把「算」的部分拆出来，让插件进程直接调用。
// 原来 dsh-recall 每轮 spawnSync 开一个 node.exe 跑 CLI —— 起进程 + 读 5.4MB 索引 + 调 ollama，
// 每一轮都同步阻塞宿主事件循环。现在：索引常驻内存（mtime 变了才重读）、向量解一次缓存、
// 查询向量走一次本地 ollama HTTP（异步），插件那边用 system-prompt/assemble 这个异步瀑布接。
//
// CLI（recall-semantic.mjs）也用这一份，保证「插件里跑的」和「命令行查的」是同一套算法。
import { readFileSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tokenize } from './recall-core.mjs'
import { filterUsable } from './memory-fields.mjs'
import { renderBlock } from './render-memories.mjs'

// 2026-11-08：优先用宿主注入的 DSH_HOME，搬家也能跟着走；没有环境变量才回退默认路径。
export const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const MEM_FILE = join(HOME, '记忆', '提炼记忆.jsonl')
export const INDEX_FILE = join(HOME, '记忆', '提炼记忆向量索引.json')
export const OLLAMA = process.env.DSH_OLLAMA_URL || 'http://localhost:11434'
export const MODEL = 'bge-m3:latest'
export const DIM = 1024

const MAX_QUERY_CHARS = 2000

// ---------- 缓存：文件 mtime + size 变了才重读 ----------
// 2026-11-11 夜：过滤改用 memory-fields.filterUsable，跟 2-gram 那条链路口径一致
//   （status / superseded_by / valid_until）。valid_until 是随时间到期的，
//   所以 loadMemories 只管「文件内容变了才重读」，semanticSearch 每次再按当前时间过一遍。
let memCache = { key: '', list: [] }
export function loadMemories() {
  try {
    const st = statSync(MEM_FILE)
    const key = `${st.mtimeMs}:${st.size}`
    if (key === memCache.key) return memCache.list
    const out = []
    for (const l of readFileSync(MEM_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue
      try {
        const m = JSON.parse(l)
        if (m && m.text) out.push(m)
      } catch {}
    }
    memCache = { key, list: filterUsable(out) }
    return memCache.list
  } catch {
    memCache = { key: '', list: [] }
    return memCache.list
  }
}

let indexCache = { key: '', index: null, vecs: null }
export function loadIndex() {
  try {
    const st = statSync(INDEX_FILE)
    const key = `${st.mtimeMs}:${st.size}`
    if (key === indexCache.key) return indexCache.index
    const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))
    if (!index || typeof index !== 'object' || !index.items) return null
    if (index.model !== MODEL) return null
    // 换索引就把解好的向量一起换掉（vecs 懒解）
    indexCache = { key, index, vecs: null }
    return index
  } catch {
    indexCache = { key: '', index: null, vecs: null }
    return null
  }
}

// 向量解一次就留着；索引没换就一直用
function vectorOf(id, b64) {
  if (!indexCache.vecs) indexCache.vecs = new Map()
  const hit = indexCache.vecs.get(id)
  if (hit) return hit
  let v
  try {
    v = fromB64(b64)
  } catch {
    return null
  }
  const out = v.length === DIM ? v : null
  indexCache.vecs.set(id, out)
  return out
}

export const toB64 = arr => Buffer.from(Float32Array.from(arr).buffer).toString('base64')
export const fromB64 = s => new Float32Array(new Uint8Array(Buffer.from(s, 'base64')).buffer)

export function saveIndex(index) {
  writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(index), 'utf8')
  renameSync(INDEX_FILE + '.tmp', INDEX_FILE)
}

// ---------- ollama 嵌入 ----------
// 2026-11-09：两次请求之间隔久了，ollama 会把模型卸掉，重新加载实测要 **11 秒**（本机 CPU 跑 bge-m3）。
//   keep_alive 让它多留一会儿，把「冷启动」压成小概率事件；真冷的时候靠调用方给足超时（见 dsh-recall 的预热）。
const KEEP_ALIVE = '30m'

export async function embed(texts, timeoutMs = 2500) {
  const res = await fetch(OLLAMA + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts, keep_alive: KEEP_ALIVE }),
    signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 2500)),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  const data = await res.json()
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error('ollama 返回的向量条数不对')
  }
  return data.embeddings
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

// 算余弦分（索引里的向量按 id 对应回记忆）
export function scoreAll(qv, index, byId) {
  const scored = []
  for (const [id, b64] of Object.entries(index.items)) {
    const m = byId.get(id)
    if (!m) continue
    const v = vectorOf(id, b64)
    if (!v) continue
    scored.push({ m, score: cosine(qv, v) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored
}

// ---------- 选记忆 + 渲染注入文本（原来 recall-semantic.mjs --inject 的那套，原样搬过来） ----------
// selectPick 返回 { pick, considered }：pick 带 hit（跟 query 共几个词，召回归因要用），
//   considered 是「过了共词锚定、进了候选池」的条数 —— 召回日志里的 candidates 就是它。
//   —— 原来打算用「余弦 ≥ 0.3」数候选，实测 bge-m3 对 990 条几乎全在 0.3 以上（记出来是 990），
//      那个数不区分任何东西，等于没写。改成「进过终选池的条数」，才是真的可解释。
// selectInject 保持老形状 [{m, score}]，CLI 和 renderInject 还在用。
export function selectPick(query, scored) {
  // 15 → 30：多证据题的正解常在第 16~36 名（长记忆语义被稀释），池子太小够不着。
  const N = 30
  const seenKey = new Set()
  const seenText = new Set()
  const qTokens = tokenize(query)
  const dedup = []
  for (const { m, score } of scored.slice(0, N)) {
    const k = m['事实键'] || '__nokey_' + m.id
    if (seenKey.has(k)) continue
    // 2026-11-12：同一件事会被蒸成好几条，事实键还起得各不相同——实测「刷 B 站写两篇日记」在库里有
    //   9 条、6 种键（我.任务 / 我.任务职责 / 我.任务设定 / 约定.b站冲浪任务 / 我.日常任务），
    //   按事实键去重等于没去。跨场次 C4 就是三条一模一样的占了八条里的三个位置。
    //   加一道文本指纹：前 24 个非空白字相同就当同一件事，只留分最高的那条。
    const fp = String(m.text || '').replace(/\s+/g, '').slice(0, 24)
    if (fp && seenText.has(fp)) continue
    seenKey.add(k)
    if (fp) seenText.add(fp)
    // 关键词锚定：跟 query 无共同词（纯语义漂移）的过滤掉，别让 imp=1 的无关记忆混进来
    const mTokens = tokenize((m.text || '') + ' ' + (m.tags || []).join(' '))
    let hit = 0
    for (const t of qTokens) if (mTokens.has(t)) hit++
    // 2026-11-12：原来 hit===0 一律扔掉，把高分正解也扔了（问「电脑什么型号」，记忆写「移动工作站」
    //   +「P7750」，零共词，但语义 0.661 排第 2，照样被丢）。改成只扔低分的漂移项。
    if (hit === 0 && score < 0.6) continue
    dedup.push({ m, score, hit })
  }
  // 2026-11-12：改成按分数排。原来按 importance 优先，实测在「问具体事实」时会答错：
  //   问「我电脑内存多大」，importance 0.7 的「家里那台 32G」压过 score 0.782 的「你这台 127.6G」。
  //   真实账本三题对照：白名单题原选法三条全错，改后 denied / 群主不让进 两条关键证据都进前五。
  //   加权版（score×(0.7+0.3imp)）也试过，比纯 score 差，importance 会把低分旧记忆顶上来。
  // 2026-11-12：共词加权试过又退了。hit×0.04 加进排序后，主测试从 18 对掉到 15 对：
  //   问「家里那台什么配置」，共词多的「i9 + 3090」把带 32GB / Win11 的那条挤掉；
  //   问「模型存在哪个盘」，共词多的「一共装了四个模型」把 37.67 GB 那条挤掉。
  //   共词多的往往是短句、信息少；语义分才是「讲的是不是同一件事」的信号。排序只认 score。
  dedup.sort((a, b) => b.score - a.score)
  // 3 → 5：多证据题的第二个事实常落在第 4、5 位，3 条够不着。
  //   代价实测每轮多约 110 token（正文平均 45.7 字 × 2 条），一天 200 轮多 22k。
  // 2026-11-12：注入条数 5 → 8。跨场次 C4「每周日十二点要做什么」两条答案都在库
  //   （拷快照 / 写周记），5 条只装得下一条，另一条被挤掉；扩到 8 条让同类并列的都能进。
  // 2026-11-12：多证据题要两块证据，实测第二块常常正好排第 10（问「每天有哪些定时任务」，
  //   21:30 那条排 10）；但固定给 10 条会让单件事的题开始乱拼——问「家里那台什么配置」，
  //   十条时把 127.6 安到了那台机器上，主测试从 19 对掉到 17 对。
  //   所以按问法定条数：问「分别 / 各自 / 一共 / 加起来 / 各是」这种要多块的，给 10 条；
  //   问单件事的照旧 8 条。拆子句分头查试过，更差（3/10 对 5/10），别走那条路。
  const wantMulti = /分别|各自|加起来|总共|一共|都有哪些|各是/.test(String(query || ''))
  return { pick: dedup.slice(0, wantMulti ? 10 : 8), considered: dedup.length }
}

export function selectInject(query, scored) {
  return selectPick(query, scored).pick.map(({ m, score }) => ({ m, score }))
}

// 渲染注入文本（规则在 render-memories.mjs，跟 2-gram 链路共用一份）
export function renderInject(pick, now = Date.now()) {
  const arr = Array.isArray(pick) ? pick : []
  return renderBlock(arr.map((p) => (p && p.m ? p.m : p)), now)
}

// 一句话拿「注入文本 + 归因」。查不到、ollama 没起、索引没有 —— 一律返回空 text（不抛）。
// 2026-11-11 夜：从 semanticInject 里拆出来，多带 picked / candidates / topScore / reason，
//   给 召回日志.jsonl 用。semanticInject 仍只返回文本，老调用方不受影响。
export async function semanticSearch(query, opts = {}) {
  const empty = { text: '', picked: [], candidates: 0, topScore: 0, reason: '' }
  const q = String(query == null ? '' : query).trim()
  if (!q) return empty
  const index = loadIndex()
  if (!index) return empty
  const now = opts.now || Date.now()
  // 到期是随时间自己变的，缓存里的列表每次要按当前时间再过一遍
  const memories = filterUsable(loadMemories(), now)
  if (!memories.length) return empty
  const byId = new Map(memories.map(m => [m.id, m]))
  const [qv] = await embed([q.slice(0, MAX_QUERY_CHARS)], opts.timeoutMs)
  const scored = scoreAll(qv, index, byId)
  if (!scored.length) return empty
  const { pick, considered } = selectPick(q, scored)
  const topScore = scored[0].score
  let maxHit = 0
  for (const p of pick) maxHit = Math.max(maxHit, p.hit)
  const reason = pick.length ? `命中 ${maxHit} 词 + 语义 ${topScore.toFixed(2)}` : '无共词'
  return {
    text: renderInject(pick, now),
    picked: pick.map(p => p.m.id),
    candidates: considered,
    topScore,
    reason,
  }
}

export async function semanticInject(query, opts = {}) {
  return (await semanticSearch(query, opts)).text
}

export function indexExists() {
  return existsSync(INDEX_FILE)
}

export default { semanticInject, semanticSearch, selectPick, embed, loadMemories, loadIndex, selectInject, renderInject, scoreAll }
