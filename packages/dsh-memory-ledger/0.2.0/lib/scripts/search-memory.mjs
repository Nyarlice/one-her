#!/usr/bin/env node
// 检索脚本：从账本（记忆/events.jsonl）按需查历史对话。
// 用法：
//   node search-memory.mjs "关键词" [更多关键词...] [--days 30] [--since 2026-11-01] [--limit 40] [--session 前缀]
//
// 只查 user/message 和 assistant/message（对话本身，不含工具调用）。
// 多个关键词 = 全部命中（AND）。
// 输出按时间正序，每条：时间 · 会话/工作区 · 谁：内容。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home';
const EVENTS_FILE = join(HOME, '记忆', 'events.jsonl');
const NAMES_FILE = join(HOME, '记忆', 'session-names.json');
// 2026-11-07：光看 cwd 认场次会漏 —— QQ 私聊的会话本来建在 im-bridge-chats 底下，
// 后来被搬进「人格」工作区（搬家会改写 header 的 cwd），痕迹就没了。
// 桥自己的 state.json 记着「哪个聊天占着哪个 sessionId」，记账脚本还把认过的
// sessionId 攒进 `记忆\入口映射.json`（只增不减，换了会话也还认得老的）。
const BRIDGE_STATE_FILE = join(HOME, 'im-bridge', 'state.json');
const ENTRY_MAP_FILE = join(HOME, '记忆', '入口映射.json');
const bridgeSessions = (() => {
  const map = new Map();
  try {
    const saved = JSON.parse(readFileSync(ENTRY_MAP_FILE, 'utf8'));
    for (const [sid, entry] of Object.entries(saved || {})) {
      if (typeof sid !== 'string') continue;
      if (entry === 'QQ群') map.set(sid.toLowerCase(), 'square');
      else if (entry === 'QQ私聊') map.set(sid.toLowerCase(), 'home');
    }
  } catch { /* 还没攒过就跳过 */ }
  try {
    const state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8'));
    for (const [chat, record] of Object.entries(state?.chats || {})) {
      const sid = record?.sessionId;
      if (typeof sid !== 'string' || sid.trim() === '') continue;
      if (chat.startsWith('group:')) map.set(sid.trim().toLowerCase(), 'square');
      else if (chat.startsWith('private:')) map.set(sid.trim().toLowerCase(), 'home');
    }
  } catch { /* 桥不在就退回 cwd 猜 */ }
  return map;
})();

const args = process.argv.slice(2);
const keywords = [];
let days = 30;
let since = null;
let limit = 40;
let sessionPrefix = null;
// F6 权限前移：调用者场次。默认 'square'（最保守，只返回广场来源）；
// 家场次查历史必须显式传 --as home。
let asRole = 'square';
// F15：已遗忘的记录默认不返回；加 --include-forgotten 才显示（原文仍在 events.jsonl，留底）。
let includeForgotten = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--days') {
    // 2026-11-09：原来 `|| 30` 会把 --days 0 吞成 30，表达不了「不限时间」。
    const n = Number(args[++i]);
    days = Number.isFinite(n) && n >= 0 ? n : 30;
  }
  else if (a === '--since') since = args[++i];
  else if (a === '--limit') limit = Number(args[++i]) || 40;
  else if (a === '--session') sessionPrefix = args[++i];
  else if (a === '--as') asRole = args[++i];
  else if (a === '--include-forgotten') includeForgotten = true;
  else if (a === '--smart') { /* 见下面的语义补查 */ }
  else if (a.startsWith('--')) { console.error('未知参数: ' + a); process.exit(2); }
  else keywords.push(a);
}

if (keywords.length === 0) {
  console.error('用法：node search-memory.mjs "关键词" [更多关键词...] [--days 30] [--since YYYY-MM-DD] [--limit 40] [--session 前缀] [--as home|square] [--smart]');
  console.error('  --smart：关键词查不到 3 条时，自动用本地语义检索（bge-m3）补一趟');
  process.exit(2);
}

let sinceMs = 0;
if (since) {
  sinceMs = new Date(since + 'T00:00:00+08:00').getTime();
} else if (days > 0) {
  sinceMs = Date.now() - days * 86400000;
}

let names = {};
try { names = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); } catch {}

// F15：已遗忘的记录默认不返回（原文仍在 events.jsonl，留底）；--include-forgotten 才显示
const forgottenIds = new Set();
try {
  const fp = join(HOME, '记忆', 'forgotten.jsonl');
  for (const l of readFileSync(fp, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { forgottenIds.add(JSON.parse(l).event_id); } catch {}
  }
} catch {}

let lines = [];
try { lines = readFileSync(EVENTS_FILE, 'utf8').split('\n'); } catch {
  console.error('读不到账本: ' + EVENTS_FILE);
  process.exit(1);
}

const lc = (s) => String(s || '').toLowerCase();
const kws = keywords.map(lc).filter(Boolean);
const wsName = (cwd) => (String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '');
const label = (e) => {
  const name = names[e.session_id] || '';
  const ws = wsName(e.cwd);
  if (name) return ws ? ws + '/' + name : name;
  const short = String(e.session_id || '').split('-')[1] || '';
  return ws ? ws + '/' + short : short;
};
const T = (e) => {
  const d = new Date(e.time);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

/**
 * F6：判断一条记录来自哪个场次。
 * 广场 = QQ群（cwd 含 im-bridge + group）。
 * 其余（Web 工作区、QQ私聊、B站私聊）算家。
 * 2026-11-06 项目定：B站对外（评论/公开）算广场，但「用户和 B 站那边的私聊」算家；
 * B站对外不经过DSH会话、不进账本，所以这里把 B站 会话归家。
 */
function isSquareSource(e) {
  const byBridge = bridgeSessions.get(String(e.session_id || '').toLowerCase());
  if (byBridge) return byBridge === 'square';
  const cwd = String(e.cwd || '').toLowerCase();
  if (cwd.includes('im-bridge') && cwd.includes('group')) return true;
  return false;
}

const hits = [];
let blocked = 0;
for (const line of lines) {
  const t = line.trim();
  if (!t) continue;
  let e;
  try { e = JSON.parse(t); } catch { continue; }
  if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
  if (e.time < sinceMs) continue;
  if (sessionPrefix && !String(e.session_id || '').startsWith(sessionPrefix)) continue;
  // F15：已遗忘的不返回（除非 --include-forgotten）
  if (!includeForgotten && forgottenIds.has(e.event_id)) continue;
  // F6 权限前移：广场场次只查广场来源，默认拒绝
  if (asRole !== 'home' && !isSquareSource(e)) { blocked++; continue; }
  const hay = lc(e.text || '');
  if (!kws.every((k) => hay.includes(k))) continue;
  hits.push(e);
}

hits.sort((a, b) => (a.time || 0) - (b.time || 0));
const picked = hits.slice(-limit);

// --smart：关键词查得不够（默认少于 3 条），再拿语义补一趟。
// 为什么这样配：关键词给你「那件具体的事」，语义给你「相关的话题」。
// 措辞记得住时关键词又快又准，只记得大概时才值得花一次 embedding。
const SMART_MIN = 3;
let smartRows = null;
let smartError = '';
if (args.includes('--smart') && hits.length < SMART_MIN) {
  try {
    const { fileURLToPath } = await import('node:url');
    const { execFileSync } = await import('node:child_process');
    const semantic = fileURLToPath(new URL('./memory-semantic.mjs', import.meta.url));
    // 2026-11-09：原来只透传了 --days，--session / --include-forgotten / 精确 --since 全丢了，
    //   补查会捞到范围外的、或者把该忘的又捞回来。现在原样透传。
    const semanticArgs = [semantic, keywords.join(' '), '--as', asRole, '--limit', String(limit), '--json'];
    if (since) semanticArgs.push('--since', since);
    else semanticArgs.push('--days', String(days));
    if (sessionPrefix) semanticArgs.push('--session', sessionPrefix);
    if (includeForgotten) semanticArgs.push('--include-forgotten');
    const raw = execFileSync(process.execPath, semanticArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
    const rows = JSON.parse(raw || '[]');
    if (rows.length > 0) smartRows = rows;
  } catch (error) {
    smartError = error?.message || String(error);
  }
}

console.log('命中 ' + hits.length + ' 条，显示最近 ' + picked.length + ' 条（关键词：' + keywords.join(' ') + '；范围：' + (since ? 'since ' + since : days > 0 ? days + ' 天' : '不限') + '；场次：' + asRole + (blocked ? '，权限过滤掉 ' + blocked + ' 条家来源' : '') + '）');
console.log('');
for (const e of picked) {
  const who = e.type === 'user/message' ? '用户' : '我';
  const txt = String(e.text || '').replace(/\s+/g, ' ').trim();
  const show = txt.length > 300 ? txt.slice(0, 300) + '…' : txt;
  console.log(T(e) + ' · ' + label(e) + ' · ' + who + '：' + show);
}

// 语义补的那几条摆在后面：关键词是「准的」，语义是「像的」，别抢前面的位置。
if (smartRows) {
  console.log('');
  console.log('—— 关键词不太够，下面这几条是语义补的（模型印象，不保证原文措辞）——');
  for (const r of smartRows) {
    const w = String(r.text || '').replace(/\s+/g, ' ').trim();
    console.log(r.score.toFixed(3) + ' · ' + T({ time: r.time }) + ' · ' + r.who + '：' + (w.length > 300 ? w.slice(0, 300) + '…' : w));
  }
} else if (smartError) {
  console.log('');
  console.log('（语义补查没跑起来：' + smartError + ' —— 先确认 ollama 起着、向量索引建过）');
}
