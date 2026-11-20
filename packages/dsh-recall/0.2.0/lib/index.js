// dsh-recall · 每轮想起（提炼记忆层）
// 每轮取会话最后一句 user 消息当线索，从 提炼记忆.jsonl 里挑 1-3 条相关记忆注入上下文。
// 语义检索（本地 bge-m3）优先，2-gram 兜底；只注入「家」会话（Web / QQ私聊 / B站私聊），
// QQ群会话不注入 —— 防家话（含真实信息）外流到广场。
// 2026-11-08：收进包内，不再写死 dsh-home 绝对路径（家搬家也不会断）。
//
// 2026-11-08 夜（Kimi 审查第 1 号硬伤）：原来每轮 spawnSync 开一个 node.exe 跑 recall-semantic.mjs，
// 起进程 + 读 5.4MB 索引 + 调 ollama 全同步堵在宿主事件循环上。现在改成：
//   ① 语义检索在进程内做（recall-semantic-core.mjs），索引和向量都常驻、mtime 变了才重读；
//   ② 真正的注入走 system-prompt/assemble（异步瀑布），能等 ollama 那几十毫秒；
//   ③ 同步的 systemPrompt.context 只做兜底：本轮语义已经算好就直接用，没算好就 2-gram。
//      这样瀑布万一没派发到本会话，行为退回改之前的样子，不会一条都不注入。
import { recall } from './recall-core.mjs'
import { loadMemories, semanticSearch } from './recall-semantic-core.mjs'
import { appendRecallLog } from './recall-log.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-recall'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const ENTRY_MAP_FILE = join(DSH_HOME, '记忆', '入口映射.json')
const BRIDGE_STATE_FILE = join(DSH_HOME, 'im-bridge', 'state.json')

const SEMANTIC_TIMEOUT_MS = 20000 // 发出去的那一次请求给足：冷启动实测 11 秒
const WATERFALL_BUDGET_MS = 2500 // 但装配提示词只等这么久，超了就先走 2-gram
const MAX_INFLIGHT = 2 // 本机 ollama 是串行的，同时算两个以上只会互相排队
const SEMANTIC_COOLDOWN_MS = 60000 // 语义这边真失败后歇一分钟，别每轮都去撞
const RESULT_TTL_MS = 10 * 60000
const RESULT_MAX = 200

// ---------- 入口 & 广场：入口映射 + 桥 state，缓存 60 秒 ----------
// 2026-11-11 夜：召回日志要记「这话是从哪个入口来的」，和 dsh-wakeup / commit-scan 用同一本账
//   （记忆\入口映射.json + im-bridge\state.json）。cwd 只做最后的兜底，别拿它当权威。
let entryCache = { at: 0, square: new Set(), entry: new Map() }
function loadEntryIndex() {
  if (Date.now() - entryCache.at < 60000) return entryCache
  const square = new Set()
  const entry = new Map()
  const put = (sid, val) => {
    const id = String(sid || '').toLowerCase()
    if (!id || !val) return
    entry.set(id, val)
    if (val === 'qq_group') square.add(id)
  }
  try {
    const map = JSON.parse(readFileSync(ENTRY_MAP_FILE, 'utf8'))
    for (const [sid, v] of Object.entries(map)) {
      if (v === 'QQ群') put(sid, 'qq_group')
      else if (v === 'QQ私聊') put(sid, 'qq')
      else if (v === 'B站') put(sid, 'bili')
      else if (v === 'Web') put(sid, 'web')
    }
  } catch {}
  try {
    const st = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8'))
    for (const [chat, rec] of Object.entries(st?.chats || {})) {
      if (!rec?.sessionId) continue
      if (chat.startsWith('group:')) put(rec.sessionId, 'qq_group')
      else if (chat.startsWith('private:')) put(rec.sessionId, 'qq')
    }
  } catch {}
  entryCache = { at: Date.now(), square, entry }
  return entryCache
}

function isSquare(cwd, sessionId) {
  const id = String(sessionId || '').toLowerCase()
  if (id && loadEntryIndex().square.has(id)) return true
  const c = String(cwd || '').toLowerCase()
  return c.includes('im-bridge') && c.includes('group')
}

// 召回日志里的 entry 只留 web|qq|bili（群里不注入，理论上到不了这儿）
function entryOf(cwd, sessionId) {
  const id = String(sessionId || '').toLowerCase()
  const v = id ? loadEntryIndex().entry.get(id) : null
  if (v === 'bili') return 'bili'
  if (v === 'qq' || v === 'qq_group') return 'qq'
  if (v === 'web') return 'web'
  const c = String(cwd || '').toLowerCase()
  if (c.includes('im-bridge')) return 'qq'
  if (c.includes('whale-work') || id.includes('bili')) return 'bili'
  return 'web'
}

// ---------- 取一条消息的文字 ----------
function textOfMessage(p) {
  if (!p) return ''
  if (typeof p === 'string') return p.slice(0, 2000)
  if (typeof p.text === 'string') return p.text.slice(0, 2000)
  if (typeof p.content === 'string') return p.content.slice(0, 2000)
  if (Array.isArray(p.content)) {
    const parts = []
    for (const b of p.content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b.text === 'string') parts.push(b.text)
    }
    if (parts.length) return parts.join(' ').slice(0, 2000)
  }
  return ''
}

// ---------- 剥掉宿主夹进 user 消息的注入块 / 元信息，只留人真正说的话 ----------
// 2026-11-11 夜（重启后第一次看日志发现的）：宿主会把「运行上下文 + 上一轮注入的【你记得的事】」
//   拼成一条 user/message。cleanText 只把【...】标题行和元信息行剥了，后面的条目列表留着 ——
//   于是 lastUserText 拿到的「最后一句人话」是自己上一轮的输出，检索变成拿自己的影子当线索：
//   日志里 query 是「- 一直：用户正在做…」，命中 55 词、top_score 0.9，全是自己。
//   现在从第一个注入标记起整条砍掉，砍完没剩人话就继续往前找。
// 2026-11-12 补：`［身份］` / `［她的人设］` 是 bili-whale 拼的唤醒词（现在已搬进 system prompt，
//   但历史消息里还留着旧的），同样不是人话。
const INJECT_MARK = /Current runtime context|【你记得的事】|［身份］|［她的人设］/
function stripInjected(文) {
  const s = String(文 == null ? '' : 文)
  if (!s) return ''
  if (/^\s*<dsh-wakeup>/.test(s)) return '' // 起床包整条都不是人话
  const i = s.search(INJECT_MARK)
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

function cleanText(文) {
  const 原 = String(文 == null ? '' : 文)
  if (!原) return ''
  const 行们 = 原.split('\n')
  const 留 = []
  let 跳到空行 = false
  let 跳元信息 = false
  const 元信息行 = /^(Current runtime context|Current DSH|Current working directory|Current DeepSeek Harness|Browser time zone|Time sampled|Approval prompts)/i
  for (const 行 of 行们) {
    const 净 = 行.trim()
    if (跳到空行) {
      if (!净) { 跳到空行 = false; 留.push('') }
      continue
    }
    if (!净) { 留.push(''); 跳元信息 = false; continue }
    if (/^【[^】]{2,14}】/.test(净)) { 跳到空行 = true; continue }
    if (元信息行.test(净)) { 跳元信息 = true; continue }
    if (跳元信息) continue
    留.push(行)
  }
  return 留.join('\n').trim()
}

// ---------- 会话最后一条「真有人话」的 user 消息 ----------
function lastUserText(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const ev = session.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (!e || (e.type || e.kind) !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const txt = stripInjected(textOfMessage(p))
      if (!txt) continue
      const 净 = cleanText(txt)
      if (净) return 净
    }
  } catch {}
  return ''
}

// ---------- 结果缓存：同一句话一个回合里会问好几次（每一步都装配一次提示词） ----------
// 缓存里放的是 { text, meta }：text 拿来注入，meta 拿来写召回日志（channel/score/reason）
const resultCache = new Map() // 's:'/'g:' + query -> { data:{text,meta}, at }
const inflight = new Map() // query -> Promise<{text,meta}|null>
let semanticDownUntil = 0

function cacheGet(key) {
  const hit = resultCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > RESULT_TTL_MS) {
    resultCache.delete(key)
    return null
  }
  return hit.data
}

function cacheSet(key, data) {
  if (resultCache.size >= RESULT_MAX) {
    const oldest = resultCache.keys().next().value
    if (oldest !== undefined) resultCache.delete(oldest)
  }
  resultCache.set(key, { data, at: Date.now() })
}

// 2-gram 兜底（不需要网络，任何情况下都能出结果）
function gramInject(query) {
  const key = 'g:' + query
  const hit = cacheGet(key)
  if (hit) return hit
  try {
    const memories = loadMemories()
    if (!memories.length) return null
    const r = recall(query, memories)
    if (!r.text) return null
    const out = { text: r.text, meta: { ...r.meta, channel: '2gram' } }
    cacheSet(key, out)
    return out
  } catch {
    return null
  }
}

// 语义检索（这就是原来 spawnSync 干的事，现在在进程里等）
async function semanticText(query, logger) {
  const key = 's:' + query
  const hit = cacheGet(key)
  if (hit) return hit
  if (Date.now() < semanticDownUntil) return null
  const running = inflight.get(key)
  if (running) return running
  // 2026-11-09：本机 ollama 串行执行，同时压太多只会一起变慢（连着发几条不同的话就会排队）。
  //   到上限就不排队了，这一轮先走 2-gram。
  if (inflight.size >= MAX_INFLIGHT) return null
  const p = (async () => {
    try {
      const r = await semanticSearch(query, { timeoutMs: SEMANTIC_TIMEOUT_MS })
      if (!r.text) return null
      return {
        text: r.text,
        meta: {
          channel: 'semantic',
          candidates: r.candidates,
          topScore: r.topScore,
          reason: r.reason,
          picked: r.picked,
        },
      }
    } catch (err) {
      semanticDownUntil = Date.now() + SEMANTIC_COOLDOWN_MS
      logger?.warn?.('语义检索失败，这一分钟走 2-gram: %s', err?.message ?? err)
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  const out = await p
  if (out) cacheSet(key, out)
  return out
}

// 2026-11-09：给一次 await 加预算。共享的那个请求（只有一份）用长超时跑完并写缓存，
//   但装配提示词这一侧不能等它 —— 到点就先走 2-gram，结果到了下一轮自然用上。
//   不加这层的话，预热发起的冷启动请求会把「同 query 共用一次请求」变成让装配等 11 秒。
// 2026-11-11：返回值从 '' 改成 null，好让调用方区分「没结果」和「有结果但文本是空」。
function raceBudget(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, ms)
    promise
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value || null)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      })
  })
}

// 同步兜底：语义这一轮已经算好的就给它，没算好/算不出来就 2-gram
function recallSync(query, logger) {
  if (!query || query.length < 4) return null
  const hit = cacheGet('s:' + query)
  if (hit) return hit
  return gramInject(query)
}

// ---------- 召回日志：每轮注入成功后写一行；同一句话只记一次，别每一步都刷 ----------
const lastLogged = new Map()
let noteLeft = 3

// 返回 true = 这一轮新写了一行（日志里那句「语义注入 N 字」也靠它去重）
function recordInjection(sid, cwd, query, data) {
  try {
    if (!data || !data.text) return false
    const sig = query + '\u0000' + data.text.length
    if (lastLogged.get(sid) === sig) return false
    lastLogged.set(sid, sig)
    if (lastLogged.size > 200) lastLogged.clear()
    return appendRecallLog(DSH_HOME, {
      at: Date.now(),
      session: sid,
      entry: entryOf(cwd, sid),
      query: String(query).slice(0, 40),
      candidates: data.meta?.candidates ?? 0,
      picked: Array.isArray(data.meta?.picked) ? data.meta.picked : [],
      channel: data.meta?.channel || '2gram',
      top_score: Number.isFinite(data.meta?.topScore) ? Number(data.meta.topScore.toFixed(3)) : 0,
      reason: data.meta?.reason || '',
    })
  } catch {
    return false
  }
}

export function apply(ctx) {
  const logger = ctx.logger(name)
  logger.info?.('[dsh-recall] armed')
  const mounted = new Map() // sessionId -> { agent, off, offAssemble }

  async function onAssemble(session, assembly, next) {
    const result = await next()
    let query = ''
    try {
      query = (lastUserText(session) || '').trim()
      if (query.length < 4) return result
      const got = await raceBudget(semanticText(query, logger), WATERFALL_BUDGET_MS)
      if (!got || !got.text) return result
      // 把同步兜底那条也一起摘掉，别同一轮塞两份
      const base = Array.isArray(result?.contexts) ? result.contexts : []
      const contexts = base.filter(c => c && c.name !== 'recall')
      contexts.push({ name: 'recall', order: 900, interpolate: false, text: got.text })
      const sid = String(session?.id || '')
      const cwd = String(session?.header?.cwd || session?.cwd || '')
      const fresh = recordInjection(sid, cwd, query, got)
      // 每个进程只吭三声：够确认「这条链活着」，又不至于每轮刷日志
      if (fresh && noteLeft > 0) {
        noteLeft--
        logger.info?.(`[dsh-recall] 语义注入 ${got.text.length} 字（${(got.text.match(/^\s*-\s/gm) || []).length} 条）`)
      }
      return { ...result, contexts }
    } catch (err) {
      logger.warn?.('recall 注入失败: %s', err?.message ?? err)
      return result
    }
  }

  function mount(agent) {
    const session = agent?.session
    const sid = String(session?.id || '')
    if (!sid) return
    const cwd = String(session?.header?.cwd || session?.cwd || '')
    if (isSquare(cwd, sid)) return // 广场不注入家话

    let off = null
    let offAssemble = null
    try {
      off = agent.ctx.systemPrompt.context({
        name: 'recall',
        order: 900,
        interpolate: false,
        text: () => {
          try {
            const query = (lastUserText(session) || '').trim()
            const got = recallSync(query, logger)
            if (!got || !got.text) return ''
            recordInjection(sid, cwd, query, got)
            return got.text
          } catch (err) {
            logger.warn?.('recall 兜底失败: %s', err?.message ?? err)
            return ''
          }
        },
      })
    } catch (err) {
      logger.warn?.('recall 挂载失败: %s', err?.message ?? err)
      return
    }
    // 异步那条：能等到 ollama 的结果，就不吃同步兜底那份
    try {
      if (typeof agent?.ctx?.on === 'function') {
        offAssemble = agent.ctx.on('system-prompt/assemble', (assembly, _context, next) =>
          onAssemble(session, assembly, next),
        )
      }
    } catch (err) {
      logger.warn?.('recall 瀑布没挂上（会退回 2-gram）: %s', err?.message ?? err)
    }
    mounted.set(sid, { agent, off, offAssemble })
  }

  function unmount(sid) {
    const cur = mounted.get(sid)
    if (!cur) return
    try { cur.off?.() } catch {}
    try { cur.offAssemble?.() } catch {}
    mounted.delete(sid)
    lastLogged.delete(sid)
  }

  // 2026-11-09 凌晨：不能碰 `ctx.agents`。它没写在 inject 里，Cordis 会直接抛
  //   cannot get property "agents" without inject
  // 旧代码把 ctx.agents.list() 包在 try/catch 里 —— 于是它一直在静默失败，一条都没挂上。
  // wakeup 在同一个宿主里的写法是：不碰服务，靠 agent/created 自己记一张表。照抄。
  const known = new Map() // sessionId -> agent
  function mountAgent(agent) {
    const sid = String(agent?.session?.id || '')
    if (!sid) return
    known.set(sid, agent)
    const cur = mounted.get(sid)
    if (cur && cur.agent === agent) return
    if (cur) unmount(sid)
    try { mount(agent) } catch (err) { logger.warn?.(`[dsh-recall] 挂载 %s 失败: %s`, sid, err?.message ?? err) }
  }

  ctx.on('agent/created', async ({ agent } = {}) => {
    if (agent) mountAgent(agent)
    return undefined // 串行事件：返回别的值会掐断后面的监听器
  })
  // 老版本（0.1.0-rc / 0.1.5）没有 agent/created 的完整参数，用这条补位
  ctx.on('agent/session-start', ({ agent } = {}) => {
    if (agent) mountAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent } = {}) => {
    const sid = String(agent?.session?.id || '')
    if (!sid) return
    known.delete(sid)
    unmount(sid)
  })

  // 预热：人话一落盘就先算，不等装配那一刻。
  // 这样即便 system-prompt/assemble 那条瀑布没派发到本会话，同步兜底路径（下一毫秒装配时读缓存）
  // 也已经拿得到语义结果，不至于退回 2-gram。跟瀑布是两条路，通哪条都行。
  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type || event?.kind
      if (type !== 'user/message') return
      const sid = String(session?.id || '')
      if (!sid || !mounted.has(sid)) return
      const p = event.payload !== undefined ? event.payload : event.data
      const query = cleanText(stripInjected(textOfMessage(p)))
      if (query.length < 4) return
      if (query.startsWith('<') || query.includes('dsh-wakeup')) return // 起床包不是人话，别拿它当线索
      // 已经有别的句子在算了，就别再压一条进 ollama 的队。等它算完，下一轮再补。
      if (inflight.size > 0) return
      semanticText(query, logger).catch(() => {})
    } catch (err) {
      logger.warn?.(`[dsh-recall] 事件处理挂了: ${err?.message ?? err}`)
    }
  })

  return () => {
    for (const sid of [...mounted.keys()]) unmount(sid)
    known.clear()
    resultCache.clear()
    inflight.clear()
  }
}

export default { name, inject, apply }
