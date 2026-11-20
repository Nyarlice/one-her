// 语义检索：把账本（记忆/events.jsonl）里每条对话用本地 bge-m3 变成向量，
// 查询时也变向量，按余弦找最近的 —— 用来补关键词检索的死穴：
// 人不会按原文的措辞来搜（「给别人发消息的脚本」不会命中文档里的「qq-say.ps1 直连 NapCat」）。
//
// 用法：
//   node tools/memory-semantic.mjs --build            # 建/更新索引（只补新的，慢一点无所谓）
//   node tools/memory-semantic.mjs "给别人发消息的脚本" [--as home|square] [--limit 5] [--days 60]
//
// 索引存在 记忆\向量索引.json，记着每条 event_id 的向量；events.jsonl 增加了就只补差额。
// 模型：本地 ollama 的 bge-m3（1024 维）。ollama 没起就先 `docker start ollama`。

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';

// 家目录：优先读 DSH_HOME，读不到才落到本机默认路径。
const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home';
const EVENTS_FILE = HOME + '\\记忆\\events.jsonl';
const INDEX_FILE = HOME + '\\记忆\\向量索引.json';
const BRIDGE_STATE_FILE = HOME + '\\im-bridge\\state.json';
const OLLAMA = 'http://localhost:11434';
const MODEL = 'bge-m3:latest';
const DIM = 1024;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const numOf = (name, fallback) => Number(flag(name, fallback)) || fallback;
const build = argv.includes('--build');
// 2026-11-09：--since 精确到天（跟 search-memory 同一套），给了它就不看 --days。
//   --session / --include-forgotten 也补上，让 search-memory --smart 能把条件原样透传过来。
const sinceArg = flag('--since', null);
const sessionPrefix = flag('--session', null) || null;
const includeForgotten = argv.includes('--include-forgotten');
const sinceMs = sinceArg
  ? new Date(String(sinceArg) + 'T00:00:00+08:00').getTime()
  : Date.now() - numOf('--days', 60) * 86400000;

// ---- 场次（跟 search-memory 同一套：先问桥的账，再退回 cwd 猜） ----
const bridgeSessions = (() => {
  const map = new Map();
  try {
    const saved = JSON.parse(readFileSync(HOME + '\\记忆\\入口映射.json', 'utf8'));
    for (const [sid, entry] of Object.entries(saved || {})) {
      if (entry === 'QQ群') map.set(sid.toLowerCase(), 'square');
      else if (entry === 'QQ私聊') map.set(sid.toLowerCase(), 'home');
    }
  } catch { /* 还没攒过 */ }
  try {
    const state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8'));
    for (const [chat, record] of Object.entries(state?.chats || {})) {
      const sid = record?.sessionId;
      if (typeof sid !== 'string' || !sid) continue;
      if (chat.startsWith('group:')) map.set(sid.trim().toLowerCase(), 'square');
      else if (chat.startsWith('private:')) map.set(sid.trim().toLowerCase(), 'home');
    }
  } catch { /* 桥不在 */ }
  return map;
})();

function isSquareSource(e) {
  // 2026-11-09 修：loadEvents 存的字段叫 sessionId，这里原来读 e.session_id —— 永远是空，
  //   桥的账一直没生效，等于只用 cwd 猜。补上 sessionId。
  const byBridge = bridgeSessions.get(String(e.sessionId ?? e.session_id ?? '').toLowerCase());
  if (byBridge) return byBridge === 'square';
  const cwd = String(e.cwd || '').toLowerCase();
  return cwd.includes('im-bridge') && cwd.includes('group');
}

// ---- 读账本 ----
// 2026-11-07 修：语义这路也得跳过已遗忘的，跟 search-memory/commit-scan 对齐，
// 否则 --smart 兜底会把「该忘的」又捞出来。
function forgottenIds() {
  const ids = new Set();
  try {
    const fp = HOME + '\\记忆\\forgotten.jsonl';
    if (existsSync(fp)) {
      for (const l of readFileSync(fp, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l); if (e?.event_id) ids.add(e.event_id); } catch {}
      }
    }
  } catch { /* 没有遗忘清单就不管 */ }
  return ids;
}

function loadEvents() {
  const forgotten = forgottenIds();
  const out = [];
  for (const line of readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
    if (!includeForgotten && forgotten.has(e.event_id)) continue;
    const text = String(e.text || '').trim();
    if (text.length < 8) continue;
    out.push({ id: e.event_id, text, time: e.time, sessionId: e.session_id, cwd: e.cwd, type: e.type });
  }
  return out;
}

async function embed(texts) {
  const res = await fetch(OLLAMA + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error('ollama 返回的向量条数不对');
  }
  return data.embeddings;
}

const toB64 = arr => Buffer.from(Float32Array.from(arr).buffer).toString('base64');
const fromB64 = s => new Float32Array(new Uint8Array(Buffer.from(s, 'base64')).buffer);

// 原子写：先写临时文件再改名，查询方永远读不到写到一半的索引。
function saveIndex(index) {
  writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(index), 'utf8');
  renameSync(INDEX_FILE + '.tmp', INDEX_FILE);
}

// ---- 建索引 ----
if (build) {
  // 锁：记账脚本每轮都可能拉起一个构建，没这层会撞车。
  //
  // 2026-11-09 改：原来只比锁文件的年龄（5 分钟内就当有人在跑），构建崩了锁还堵五分钟。
  //   现在两条一起用：
  //     ① 探活——锁里记着 pid，问系统这个进程还在不在（ESRCH = 没了，EPERM = 还在但没权限，
  //        其他错误保守当「还在」）。
  //     ② 硬上限——探活说活着、但锁龄超过 12 分钟，也强行接管。防 pid 被系统回收复用后
  //        「假活着」把锁永久占住（那比五分钟超时更糟）。
  //   为什么是 12 分钟：全量重建 13K 条约 3–5 分钟（每批 12 条、每批 150–300ms），留两倍余量。
  const LOCK = INDEX_FILE + '.lock';
  const LOCK_MAX_MS = 12 * 60 * 1000;
  // 返回 null = 锁还成立（别动）；返回字符串 = 锁可接管，字符串是理由。
  function lockTakeoverReason() {
    let st;
    try { st = statSync(LOCK); } catch { return null; } // 没有锁文件 → 可接管（理由在下面另说）
    const age = Date.now() - st.mtimeMs;
    if (age > LOCK_MAX_MS) return `锁龄 ${Math.round(age / 60000)} 分钟，超过 ${LOCK_MAX_MS / 60000} 分钟上限`;
    let info = null;
    try { info = JSON.parse(readFileSync(LOCK, 'utf8')); } catch { info = null; } // 老格式（纯 pid 字符串）当没有 pid 信息
    const pid = info && Number.isFinite(Number(info.pid)) ? Number(info.pid) : null;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // 不杀，只探活
        return null; // 活着，锁成立
      } catch (e) {
        if (e && e.code === 'ESRCH') return `pid ${pid} 已经不在了`;
        // EPERM = 进程还在但没权限碰；其他怪错误也保守当「还在」
        return null;
      }
    }
    return null;
  }

  let hasLock = true;
  try { statSync(LOCK); } catch { hasLock = false; }
  if (hasLock) {
    const reason = lockTakeoverReason();
    if (reason === null) {
      console.log('已有另一个构建在跑，跳过');
      process.exit(0);
    }
    console.log(`锁已陈旧（${reason}），接管`);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

  try {
    const events = loadEvents();
    console.log(`账本对话 ${events.length} 条`);
    let index = { model: MODEL, dim: DIM, builtAt: 0, items: {} };
    if (existsSync(INDEX_FILE)) {
      try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')); } catch { /* 坏了就重建 */ }
      if (index.model !== MODEL) index = { model: MODEL, dim: DIM, builtAt: 0, items: {} };
    }
    const missing = events.filter(e => !index.items[e.id]);
    console.log(`已有 ${Object.keys(index.items).length} 条，需要补 ${missing.length} 条`);
    const BATCH = 12;
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const vectors = await embed(chunk.map(e => e.text.slice(0, 1500)));
      chunk.forEach((e, k) => { index.items[e.id] = toB64(vectors[k]); });
      done += chunk.length;
      if (done % 120 === 0 || done === missing.length) {
        process.stdout.write(`  已补 ${done}/${missing.length}\n`);
        saveIndex(index);   // 边跑边存，断了不用从头来
      }
    }
    // 清掉账本里已经没有的旧 id，别让索引一直长
    const alive = new Set(events.map(e => e.id));
    let dropped = 0;
    for (const id of Object.keys(index.items)) if (!alive.has(id)) { delete index.items[id]; dropped++; }
    index.builtAt = Date.now();
    saveIndex(index);
    console.log(`索引完成：${Object.keys(index.items).length} 条（清掉 ${dropped} 条过期的），${(statSync(INDEX_FILE).size / 1048576).toFixed(1)} MB`);
  } finally {
    try { rmSync(LOCK, { force: true }); } catch { /* 锁删不掉就算了 */ }
  }
  process.exit(0);
}

// ---- 关键词（跟 search-memory 一样：AND 子串，不分大小写） ----
function keywordHits(words, pool) {
  const out = [];
  for (const e of pool) {
    if (e.time < sinceMs) continue;
    const hay = e.text.toLowerCase();
    if (words.every(w => hay.includes(String(w).toLowerCase()))) out.push(e);
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}

// ---- 混合：两路各取前 N，按 RRF（倒数名次融合）排 ----
function fuse(lists, k = 60) {
  const score = new Map();
  const byId = new Map();
  for (const list of lists) {
    list.forEach((item, i) => {
      const e = item.e ?? item;
      byId.set(e.id, e);
      score.set(e.id, (score.get(e.id) || 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id));
}

// ---- 评测：一组真问题，看三种查法谁先找到对的东西 ----
const EVAL = [
  { q: '给别人发消息的脚本', kw: ['qq-say'], want: ['qq-say', 'napcat'] },
  { q: '群里的消息为什么收不到', kw: ['拒收'], want: ['拒收', 'denied', '白名单'] },
  { q: '压缩之后忘了我自己是谁', kw: ['压缩', '人格'], want: ['rewake', '人格层', '压缩'] },
  { q: 'NapCat 连不上怎么办', kw: ['napcat', '连不上'], want: ['econnreset', 'restart napcat', 'socket closed'] },
  { q: '记账脚本把日记写爆了', kw: ['日记', '流水'], want: ['日记', '流水'] },
  { q: '跨会话共享记忆', kw: ['跨会话'], want: ['跨会话', '记忆插件'] },
];

if (argv.includes('--eval')) {
  // 评测默认按「家」场次看，范围 60 天；要测广场就 --as square
  const role = flag('--as', 'home');
  const inScope = e => e.time >= sinceMs && (role === 'home' || isSquareSource(e));
  const index0 = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
  const all = loadEvents();
  const semanticTop = async (text, n) => {
    const [v] = await embed([text]);
    return all
      .filter(inScope)
      .map(e => {
        const u = fromB64(index0.items[e.id] || '');
        if (!u.length) return { e, score: -1 };
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < DIM; i++) { dot += v[i] * u[i]; na += v[i] * v[i]; nb += u[i] * u[i]; }
        return { e, score: dot / Math.sqrt(na * nb) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map(x => x.e);
  };
  const has = (list, want) => list.some(e => want.some(w => e.text.toLowerCase().includes(w)));
  let kwOk = 0, semOk = 0, hybOk = 0;
  for (const item of EVAL) {
    const kw = keywordHits(item.kw, all).slice(0, 3);
    const sem = await semanticTop(item.q, 3);
    const hyb = fuse([keywordHits(item.kw, all).slice(0, 30), sem]).slice(0, 3);
    const a = has(kw, item.want), b = has(sem, item.want), c = has(hyb, item.want);
    if (a) kwOk++; if (b) semOk++; if (c) hybOk++;
    console.log(`\n「${item.q}」  关键词:${a ? '✓' : '✗'} 语义:${b ? '✓' : '✗'} 混合:${c ? '✓' : '✗'}`);
    if (!c) console.log(`   混合前 3：${hyb.map(e => e.text.slice(0, 40).replace(/\s+/g, ' ')).join(' ｜ ')}`);
  }
  console.log(`\n前 3 条里命中「该找到的那件事」：关键词 ${kwOk}/${EVAL.length} · 语义 ${semOk}/${EVAL.length} · 混合 ${hybOk}/${EVAL.length}`);
  process.exit(0);
}


const query = (() => {
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--as' || a === '--limit' || a === '--days' || a === '--since' || a === '--session') { i++; continue; }
    if (a.startsWith('--')) continue;
    parts.push(a);
  }
  return parts.join(' ').trim();
})();
if (!query) {
  console.log('用法：node tools/memory-semantic.mjs "要查的话" [--as home|square] [--limit 5] [--days 60 | --since YYYY-MM-DD] [--session 前缀] [--include-forgotten] [--json]');
  console.log('      node tools/memory-semantic.mjs --build');
  process.exit(1);
}
const asRole = flag('--as', 'square');
const limit = numOf('--limit', 5);
const days = numOf('--days', 60);
const since = sinceMs;

if (!existsSync(INDEX_FILE)) {
  console.log('还没有索引，先跑：node tools/memory-semantic.mjs --build');
  process.exit(1);
}
const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
const events = new Map(loadEvents().map(e => [e.id, e]));
const [qv] = await embed([query]);

const scored = [];
for (const [id, b64] of Object.entries(index.items)) {
  const e = events.get(id);
  if (!e || e.time < since) continue;
  if (sessionPrefix && !String(e.sessionId || '').startsWith(sessionPrefix)) continue;
  if (asRole !== 'home' && !isSquareSource(e)) continue;
  const v = fromB64(b64);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { dot += qv[i] * v[i]; na += qv[i] * qv[i]; nb += v[i] * v[i]; }
  scored.push({ e, score: dot / Math.sqrt(na * nb) });
}
scored.sort((a, b) => b.score - a.score);

// --json：给别的脚本（比如 search-memory --smart）当后端用
if (argv.includes('--json')) {
  const rows = scored.slice(0, limit).map(({ e, score }) => ({
    score: Number(score.toFixed(4)),
    id: e.id,
    time: e.time,
    who: e.type === 'user/message' ? '用户' : '我',
    text: e.text,
  }));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

console.log(`语义检索（${MODEL}）命中 ${scored.length} 条，显示最像的 ${Math.min(limit, scored.length)} 条；查询：${query}\n`);
for (const { e, score } of scored.slice(0, limit)) {
  const when = new Date(e.time).toLocaleString('zh-CN', { hour12: false }).slice(0, 16);
  const who = e.type === 'user/message' ? '用户' : '我';
  const text = e.text.replace(/\s+/g, ' ').slice(0, 120);
  console.log(`${score.toFixed(3)} · ${when} · ${who}：${text}`);
}
