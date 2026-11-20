// 生成「家书-冲浪版」：给 B站 冲浪那条会话每晚第一次投递时附上的一小段家里情况。
//
// 为什么单独一份，不用整份起床包：
//   · 冲浪会话一天好几轮，每轮都塞一万字的家书是烧钱；
//   · 她需要的是「最近家里在干什么、踩过哪些坑、广场上不能说什么」，不需要背整个人格——
//     人格冲浪插件自己有人设文件。
// 所以这份控制在一千字上下，只挑：近况前几条、判据集里跟广场/隐私有关的几条、错题集最近一条、长期记忆库最近一节。
//
// 用法：
//   node tools\build-surf-letter.mjs          # 生成 记忆\家书-冲浪版.md
//   也可以在别的脚本里 import { buildLetter } 直接调。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_CHARS = 1200

function read(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// 去掉 markdown 的星号反引号：这些内容是塞进提示词的，满屏 ** 和 ` 只是噪声
function plain(s) {
  return String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

// 从 markdown 里挑以「- 」开头的条目，最多 n 条，每条截断到 len 字
function bullets(text, n, len = 110) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*-\s+(.+)$/)
    if (!m) continue
    let s = plain(m[1])
    if (!s) continue
    if (s.length > len) s = s.slice(0, len) + '…'
    out.push('- ' + s)
    if (out.length >= n) break
  }
  return out
}

// 判据集里只挑跟「广场 / 真实信息 / 私聊」有关的条目 —— 冲浪时最要紧的就是这个
function privacyRules(text, n = 2, len = 140) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!/^\s*-\s+/.test(line)) continue
    if (!/广场|真实信息|私聊|不外流|群聊/.test(line)) continue
    let s = plain(line.replace(/^-\s+/, ''))
    if (s.length > len) s = s.slice(0, len) + '…'
    out.push('- ' + s)
    if (out.length >= n) break
  }
  return out
}

// 错题集最后一条：标题行 + 「下次怎么改」那一行（最值钱的是改法）
function lastMistake(text) {
  const lines = String(text).split('\n')
  const starts = []
  lines.forEach((l, i) => {
    if (/^\s*-\s+\*\*.+\*\*\s*$/.test(l)) starts.push(i)
  })
  if (!starts.length) return []
  const from = starts[starts.length - 1]
  const title = plain(lines[from].replace(/^-\s+/, ''))
  const next = lines.slice(from, from + 8).find((l) => /下次怎么改/.test(l))
  const out = ['- 最近这条错：' + title.slice(0, 110)]
  if (next) out.push('  改法：' + plain(next.replace(/.*下次怎么改[:：]\s*/, '')).slice(0, 140))
  return out
}

// 长期记忆库里最后一节
function lastMemoSection(text, n = 3) {
  const lines = String(text).split('\n')
  const idx = []
  lines.forEach((l, i) => {
    if (/^##\s+/.test(l)) idx.push(i)
  })
  if (!idx.length) return []
  const from = idx[idx.length - 1]
  const body = lines.slice(from + 1).filter((l) => l.trim()).slice(0, n)
  const head = plain(lines[from].replace(/^##\s+/, ''))
  return ['- ' + head, ...bullets(body.join('\n'), n, 130)]
}

export function buildLetter(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const recent = read(join(home, '近况.md'))
  const rules = read(join(home, '判据集.md'))
  const mistakes = read(join(home, '错题集.md'))
  const memo = read(join(home, '长期记忆库.md'))

  // 按「越稳越靠前」排：规矩 → 坑 → 账 → 近况。近况最易变也最长，放最后，
  // 万一超预算被截，截掉的是最新最可弃的那几条，而不是坑和规矩。
  const parts = []
  parts.push('【家里这几天的样子】以下是给你的背景，不是给你的任务；别在评论区或动态里复述这些内容。')

  const pr = privacyRules(rules, 2, 140)
  if (pr.length) {
    parts.push('')
    parts.push('广场上的死规矩：')
    parts.push(...pr)
  }

  const mm = lastMistake(mistakes)
  if (mm.length) {
    parts.push('')
    parts.push('刚踩过的坑：')
    parts.push(...mm)
  }

  const mo = lastMemoSection(memo, 2)
  if (mo.length) {
    parts.push('')
    parts.push('账上最近记的：')
    parts.push(...mo)
  }

  const re = bullets(recent, 5, 100)
  if (re.length) {
    parts.push('')
    parts.push('家里最近在动的事：')
    parts.push(...re)
  }

  let out = parts.join('\n').trim()
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + '\n…（太长，截断了）'
  return out
}

export function buildLetterFile(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const text = buildLetter(home)
  try {
    writeFileSync(join(home, '记忆', '家书-冲浪版.md'), text + '\n', 'utf8')
  } catch {}
  return text
}

// CLI
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/build-surf-letter.mjs')
if (isMain) {
  const text = buildLetterFile()
  console.log(text)
  console.log(`\n（${text.length} 字，已写入 记忆\\家书-冲浪版.md）`)
}
