// recall-log.mjs —— 召回日志（每轮注入后记「为什么想起这几条」）
//
// 2026-11-11 夜（记忆插件-08 第一批）：1575 个仓库里只有一家真做召回归因，
//   而我们每轮都注入，天生需要它：出了问题得能回答「这轮为什么是这几条」。
//
// 规矩：
//   - 只在真的注入了才写（调用方判 text 非空）；
//   - 写失败不影响注入（全部 try/catch，返回 false 不抛）；
//   - 不许拖慢注入：一次 appendFileSync，体积靠计数维护，不每条 statSync；
//   - 单文件超过 20MB 轮转成 召回日志.1.jsonl（只留一代）。
//   - 一轮最多两行：先走 2-gram 兜底注入了一行（channel=2gram），瀑布后来拿到语义结果把那段替换掉，
//     再记一行（channel=semantic）。两行的 query 一样、picked 可能不同 —— 这不是重复计数，
//     是「这一轮先兜底、后被替换」的痕迹，排查时按 at 顺序看。
import { appendFileSync, statSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_BYTES = 20 * 1024 * 1024 // 20MB

const NAME = '召回日志.jsonl'
const ROTATED = '召回日志.1.jsonl'

let knownBytes = -1 // -1 = 本进程还没量过；之后靠累加，不再 statSync

export function recallLogPath(home) {
  return join(home, '记忆', NAME)
}

function rotatedPath(home) {
  return join(home, '记忆', ROTATED)
}

// rec 字段固定，别偷偷加：at / session / entry / query / candidates / picked / channel / top_score / reason
export function appendRecallLog(home, rec) {
  try {
    const p = recallLogPath(home)
    if (knownBytes < 0) {
      try {
        knownBytes = statSync(p).size
      } catch {
        knownBytes = 0
      }
    }
    if (knownBytes >= MAX_BYTES) {
      try {
        renameSync(p, rotatedPath(home))
      } catch {}
      knownBytes = 0
    }
    const line = JSON.stringify(rec) + '\n'
    appendFileSync(p, line, 'utf8')
    knownBytes += Buffer.byteLength(line)
    return true
  } catch {
    return false
  }
}

// 给测试用：把「已量过的体积」清掉，下次重新 statSync
export function resetRecallLogSizeCache() {
  knownBytes = -1
}

export default { MAX_BYTES, recallLogPath, appendRecallLog, resetRecallLogSizeCache }
