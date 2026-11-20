// dsh-memory-ledger · 记账层 P0
// 每轮对话结束（turn/end）时，触发一次 dsh-home\tools\commit-scan.mjs，
// 由那个脚本负责扫会话文件、增量记账（幂等靠它的 scan-state.json）。
// 本插件只做「触发」，不碰提取/幂等逻辑，也不读事件内容。
// 另外顺带起了 token 明细网页服务（127.0.0.1:8720），点鲸鱼娘消耗泡泡跳过去看明细。
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'

export const name = 'dsh-memory-ledger'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// 2026-11-17：脚本从「家目录下的 tools」搬进了本包 lib/scripts/。
// 先找包内的（这样别人装上也跑得起来），包内没有再回落到旧布局（本机升级期兼容）。
const SCRIPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'scripts')
const scriptPath = (n) => (existsSync(join(SCRIPTS_DIR, n)) ? join(SCRIPTS_DIR, n) : join(DSH_HOME, 'tools', n))
// 2026-11-09：这里原来写死绝对路径
//   import { startTokenServer } from 'file:///<家目录>/tools/token-server.mjs'
// 家一搬家，插件加载直接爆（审查点名的三个硬编码之一，recall 那个早改了，这个漏了）。
// 改成从 DSH_HOME 拼路径 + 动态 import：token 网页不是核心功能，文件不在也只是少个页面，
// 不该把整个记账插件带下来。
async function startTokenServerFromHome(port, logger) {
  const file = scriptPath('token-server.mjs')
  try {
    const mod = await import(pathToFileURL(file).href)
    if (typeof mod.startTokenServer !== 'function') throw new Error('token-server.mjs 里没有 startTokenServer')
    return mod.startTokenServer(port, (p) => logger.info?.('token 服务已起：http://127.0.0.1:' + p))
  } catch (err) {
    logger.warn?.('token 服务起不来（不影响记账）: %s', err?.message ?? err)
    return null
  }
}
const NODE_CANDIDATES = [
  join(DSH_HOME, 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
]
const SCRIPT = scriptPath('commit-scan.mjs')
// 会话 id -> 标题。标题只有运行时拿得到（DSH 的 sessionTitle 服务折叠日志得到），
// 离线脚本 commit-scan 拿不到；这里每轮结束时顺手记下，供它生成「近况」时补会话名。
const NAMES_FILE = join(DSH_HOME, '记忆', 'session-names.json')
const DEBOUNCE_MS = 2000 // 等会话事件落盘再扫；落盘晚也只会延后记，不会丢（脚本按 seq 补）

export function apply(ctx) {
  const logger = ctx.logger(name)
  logger.info?.('[dsh-memory-ledger] armed, watching turn/end')
  let timer = null

  // token 明细网页服务（127.0.0.1:8720）：随宿主起，点鲸鱼娘消耗泡泡跳过来看明细。
  // 端口被占（前一个实例还在）会静默，不吵。异步起，起不来只 warn 一句。
  let tokenServer = null
  startTokenServerFromHome(8720, logger).then((s) => { tokenServer = s }).catch(() => {})

  function pickNode() {
    for (const p of NODE_CANDIDATES) {
      if (existsSync(p)) return p
    }
    return process.execPath // 兜底：用宿主进程自己的可执行文件
  }

  function saveSessionName(session) {
    try {
      const sid = String(session?.id || '')
      if (!sid) return
      let name = ''
      const svc = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
      if (svc && typeof svc.get === 'function') {
        const snap = svc.get(session)
        name = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text)) || ''
      }
      if (!name) name = session.name || session.title || session.label || ''
      name = String(name || '').trim().slice(0, 120)
      if (!name) return
      let map = {}
      try { map = JSON.parse(readFileSync(NAMES_FILE, 'utf8')) } catch {}
      if (map[sid] === name) return
      map[sid] = name
      mkdirSync(join(DSH_HOME, '记忆'), { recursive: true })
      writeFileSync(NAMES_FILE, JSON.stringify(map, null, 2), 'utf8')
    } catch {
      // 标题收集失败不影响记账
    }
  }

  function runScan() {
    const node = pickNode()
    try {
      const child = spawn(node, [SCRIPT], { stdio: 'ignore', windowsHide: true })
      child.on('error', (err) => logger.warn?.('记账扫描启动失败: %s', err?.message ?? err))
      child.on('exit', (code) => {
        if (code !== 0) logger.warn?.('记账扫描退出码 %s', code)
      })
    } catch (err) {
      logger.warn?.('记账扫描触发失败: %s', err?.message ?? err)
    }
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      runScan()
    }, DEBOUNCE_MS)
  }

  // token 账本：按 (session, turn) 聚合 usage，turn/end 时写一条（跟 distill.mjs 同格式）
  const TOKEN_FILE = join(DSH_HOME, '记忆', 'token统计.jsonl')
  const turnAgg = new Map() // sessionId -> { turn, input, output, total, model }

  function flushToken(sid) {
    const agg = turnAgg.get(sid)
    if (!agg || agg.total <= 0) { turnAgg.delete(sid); return }
    try {
      const rec = {
        kind: 'chat',
        ts: Date.now(),
        model: agg.model || null,
        sessionId: sid,
        turn: agg.turn ?? null,
        inputTokens: agg.input,
        outputTokens: agg.output,
        totalTokens: agg.total,
        note: null,
      }
      appendFileSync(TOKEN_FILE, JSON.stringify(rec) + '\n', 'utf8')
    } catch {}
    turnAgg.delete(sid)
  }

  ctx.on('session/event', (session, event) => {
    if (!session?.id) return
    const sid = session.id
    if (event?.type === 'turn/end') {
      flushToken(sid)
      saveSessionName(session)
      schedule()
      return
    }
    if (event?.type === 'assistant/message') {
      const d = event?.data
      const usage = d && d.usage
      if (!usage || typeof usage !== 'object') return
      const turn = Number(d.turn)
      if (!isFinite(turn)) return
      let agg = turnAgg.get(sid)
      if (!agg || agg.turn !== turn) {
        if (agg) flushToken(sid)
        agg = { turn, input: 0, output: 0, total: 0, model: null }
        turnAgg.set(sid, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      agg.input += input + cache
      agg.output += output
      agg.total += input + cache + output
      const m = d.message && d.message.source ? d.message.source.model : ''
      if (m) agg.model = m
    }
  })

  // 启动先试跑一次：验证 spawn 链路，也把重启前最后几轮补进账本
  schedule()

  return () => {
    if (timer) clearTimeout(timer)
    try { tokenServer && tokenServer.close() } catch (err) {}
  }
}

export default { name, inject, apply }
