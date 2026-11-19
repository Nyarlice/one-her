// dsh-surf-persona —— 把某个会话的身份/人设放进 system prompt
//
// 起因：上游那种「每轮唤醒都把 ［身份］+［人设］ 拼进 user 消息」的做法（约 520 字）有两个毛病。
//   一天最多六次窗口，每次那一段都留在会话历史里、每一步工具调用都重读一遍。
//   更要命的是 dsh-recall 会把它当「最后一句人话」去搜记忆 —— 等于拿自己的身份提示词搜自己，
//   于是每次想起来的都是身份设定本身。
//
// 做法：会话建好时把同一段文字注册成 systemPrompt.context（整个会话有效，不占消息位）。
//   ⚠ 配套的另一半在消息投递那边：它要把消息里的 persona 置空。**两边必须一起生效** ——
//     只装这个插件不改那边，人设会出现两遍；只改那边不装这个插件，会话就没有人设了。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-surf-persona'
export const inject = []

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_FILE = join(HOME, 'bili-whale.config.json')
const PERSONA_FILE = join(process.env.USERPROFILE || process.env.HOME || homedir(), '.bili-ai', 'persona.md')

const ORDER = 50 // 排在 recall（900）前面：先人设，再记忆

function readSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function stamp(p) {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

// 缓存：配置和 persona.md 都没变就不重复读（一次装配会调好几遍 text()）
let cache = { key: '', text: '' }

export function buildPersonaText() {
  const key = stamp(CFG_FILE) + '|' + stamp(PERSONA_FILE)
  if (key === cache.key) return cache.text

  let cfg = {}
  try {
    cfg = JSON.parse(readSafe(CFG_FILE) || '{}')
  } catch {}
  const p = (cfg && cfg.persona) || {}
  const bits = []
  if (p.name) bits.push(`你是「${p.name}」`)
  if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
  if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
  const base = bits.length ? `［身份］${bits.join('，')}。（以此为准，别用别的称呼）` : ''

  const persona = readSafe(PERSONA_FILE).trim()
  const extra = persona
    ? `［她的人设］以下是她专属的设定，写日记 / 说话 / 选题都以它为准；与上面［身份］里的名字/称呼/自称冲突时，以这一份为准：\n${persona}`
    : ''

  const note = `人设依据：${PERSONA_FILE}；改了会自动重读，上下文缺失时以文件为准。`
  const text = [base, extra, note].filter(Boolean).join('\n\n')
  cache = { key, text }
  return text
}

// 哪个会话算「冲浪那间」：配置里的 sessionId 优先，其次固定的 bili-whale
export function isSurfSession(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return false
  let cfg = {}
  try {
    cfg = JSON.parse(readSafe(CFG_FILE) || '{}')
  } catch {}
  const want = String(cfg.sessionId || '').trim()
  if (want && sid === want) return true
  if (sid === 'bili-whale') return true
  return /^bili-/i.test(sid) // 轮换出来的 bili-xxx 也认（现在 sessionRotateDays=0，基本用不上）
}

export function apply(ctx) {
  const logger = ctx.logger(name)
  logger.info?.('[dsh-surf-persona] armed')
  const mounted = new Map()

  function mount(agent) {
    const session = agent?.session
    const sid = String(session?.id || '')
    if (!sid || !isSurfSession(sid)) return
    if (mounted.has(sid)) return
    try {
      const off = agent.ctx.systemPrompt.context({
        name: 'surf-persona',
        order: ORDER,
        interpolate: false,
        // 用函数：persona.md 改了下一轮就生效，不用重启
        text: () => {
          try {
            return buildPersonaText()
          } catch (err) {
            logger.warn?.('[dsh-surf-persona] 拼人设失败: %s', err?.message ?? err)
            return ''
          }
        },
      })
      mounted.set(sid, off)
      logger.info?.(`[dsh-surf-persona] 已注入 system prompt：${sid}（${buildPersonaText().length} 字）`)
    } catch (err) {
      logger.warn?.('[dsh-surf-persona] 挂载失败: %s', err?.message ?? err)
    }
  }

  function unmount(sid) {
    const off = mounted.get(sid)
    if (!off) return
    try {
      off?.()
    } catch {}
    mounted.delete(sid)
  }

  ctx.on('agent/created', async ({ agent } = {}) => {
    if (agent) mount(agent)
    return undefined // 串行事件：返回别的值会掐断后面的监听器
  })
  ctx.on('agent/session-start', ({ agent } = {}) => {
    if (agent) mount(agent)
  })
  ctx.on('agent/disposed', ({ agent } = {}) => {
    const sid = String(agent?.session?.id || '')
    if (sid) unmount(sid)
  })

  return () => {
    for (const sid of [...mounted.keys()]) unmount(sid)
  }
}

export default { name, inject, apply }
