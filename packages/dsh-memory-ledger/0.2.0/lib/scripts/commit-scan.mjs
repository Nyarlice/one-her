#!/usr/bin/env node
// 记账脚本 P0：扫会话文件（zstd 多帧），增量记账到 记忆/events.jsonl + 日记
// 幂等靠 scan-state.json 里每个文件的 maxSeq 与字节偏移。
// node: dsh-home\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 家目录：优先读 DSH_HOME，读不到才落到本机默认路径。
const HOME = process.env.DSH_HOME || 'E:\\ai_project\\DSH_Next\\dsh-home';
const SESSIONS_DIR = join(HOME, 'sessions');
const MEMORY_DIR = join(HOME, '记忆');
// 对话流水（每轮细账）单独放 记忆\对话流水\，别写进 日记\ —— 日记只留人读的短篇。
// 否则 dsh-wakeup 开局读最近三篇日记，会连流水一起灌进上下文（单篇上限 6 万字、总预算 14 万字）。
const FLOW_DIR = join(MEMORY_DIR, '对话流水');
const STATE_FILE = join(MEMORY_DIR, 'scan-state.json');
const EVENTS_FILE = join(MEMORY_DIR, 'events.jsonl');
const TASKS_FILE = join(MEMORY_DIR, 'tasks.jsonl');

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const TRUNC = 200;

mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(FLOW_DIR, { recursive: true });

let state = { files: {} };
if (existsSync(STATE_FILE)) {
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch (e) { console.error('state 解析失败，重置：', e.message); }
}
if (!state.files) state.files = {};

function walk(dir, out) {
  // 2026-11-17：新装的人可能还没聊过，sessions 目录根本不存在——那是正常状态，不是错。
  // 原来直接 readdirSync 会抛 ENOENT，整个记账脚本一起崩。
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name === 'session.v4.jsonl.zstd') out.push(p);
  }
}

function textOfUser(ev) {
  return (ev.data?.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
}
function textOfAssistant(ev) {
  return (ev.data?.message?.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
}
function isNoiseUser(text, ev) {
  if (ev.data?.source?.kind !== 'user') return true;
  if (!text) return true;
  if (text.startsWith('<dsh-wakeup>')) return true;
  if (text.startsWith('Current runtime context')) return true;
  if (text.startsWith('<system-reminder>')) return true;
  if (text.startsWith('Time sampled while preparing')) return true;
  return false;
}

function extract(ev, sessionId, cwd) {
  const base = { event_id: `${sessionId}:${ev.seq}`, session_id: sessionId, seq: ev.seq, time: ev.time, cwd };
  if (ev.type === 'user/message') {
    const text = textOfUser(ev);
    if (isNoiseUser(text, ev)) return null;
    return { ...base, type: 'user/message', text };
  }
  if (ev.type === 'assistant/message') {
    const text = textOfAssistant(ev);
    if (!text) return null;
    return { ...base, type: 'assistant/message', turn: ev.data?.turn, text };
  }
  if (ev.type === 'tool/call') {
    return { ...base, type: 'tool/call', turn: ev.data?.turn, name: ev.data?.name };
  }
  if (ev.type === 'turn/start') {
    return { ...base, type: 'turn/start', turn: ev.data?.turn };
  }
  if (ev.type === 'turn/end') {
    return { ...base, type: 'turn/end', turn: ev.data?.turn, reason: ev.data?.reason?.kind || '' };
  }
  return null;
}

const files = [];
walk(SESSIONS_DIR, files);

const newEvents = [];

// 幂等兜底（2026-11-07 修）：崩溃可能发生在「追加 events」与「写 state」之间，
// 下一次跑会把同一批又扫出来、双记。先把已存在的 event_id 收进集合，追加前按它去重。
const seenIds = new Set();
try {
  for (const l of readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); if (e?.event_id) seenIds.add(e.event_id); } catch {}
  }
} catch { /* 账本还不存在或读不了，交给后面 try */ }

// 2026-11-09：帧解压失败留痕。spawn 出去的进程 stdout 被忽略，只能写文件。
const WARN_FILE = join(MEMORY_DIR, 'scan-warnings.jsonl');
function noteBadFrame(file, start, end, err) {
  try {
    appendFileSync(
      WARN_FILE,
      JSON.stringify({
        at: Date.now(),
        file: basename(file),
        offset: start,
        end,
        error: String(err?.message ?? err).slice(0, 200),
        note: '这一帧没解开，已跳过（后面的帧照读）',
      }) + '\n',
      'utf8',
    );
  } catch { /* 写不进去不影响扫描 */ }
}

for (const file of files) {
  const rec = state.files[file] || { offset: 0, maxSeq: -1 };
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) starts.push(i);
  }
  if (starts.length === 0) continue;

  const sessionId = basename(dirname(file));
  let lastEnd = rec.offset;
  let maxSeq = rec.maxSeq;
  let cwd = rec.cwd || '';

  for (let i = 0; i < starts.length; i++) {
    if (starts[i] < rec.offset) continue;
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    let dec;
    try {
      dec = zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8');
    } catch (e) {
      // 2026-11-09：原来这里直接 break —— 一个误报的 magic（正文里恰好出现那四个字节）会让这份
      //   文件后面的帧全不读，而且 offset 卡在同一点，下次还在同一点停：那个会话就永久哑了。
      //   现在改成跳过这一帧继续往后读；只在「不是最后一帧」时留痕（最后一帧没写完是正常的，
      //   每轮都写一条会把日志淹掉）。console.warn 在 spawn 里被吞，所以写进文件。
      if (i < starts.length - 1) noteBadFrame(file, starts[i], end, e);
      continue;
    }
    lastEnd = end;
    for (const line of dec.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      if (ev.type === 'session') cwd = ev.cwd || cwd;
      if (typeof ev.seq !== 'number' || ev.seq <= maxSeq) continue;
      maxSeq = ev.seq;
      const out = extract(ev, sessionId, cwd);
      if (out && !seenIds.has(out.event_id)) { seenIds.add(out.event_id); newEvents.push(out); }
    }
  }
  state.files[file] = { offset: lastEnd, maxSeq, sessionId, cwd };
}

// 写 events.jsonl（原子：先 .tmp 再 rename）
if (newEvents.length > 0) {
  appendFileSync(EVENTS_FILE, newEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`events 新增 ${newEvents.length} 条`);
} else {
  console.log('events 无新增');
}

// 对话流水聚合（只追加新事件，不碰原有内容）—— 写到 记忆\对话流水\，不进日记目录
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function trunc(s) {
  s = String(s).replace(/\n+/g, ' ');
  return s.length > TRUNC ? s.slice(0, TRUNC) + '…' : s;
}
function diaryLine(e) {
  const hhmm = localHHMM(e.time);
  if (e.type === 'user/message') return `- ${hhmm} 用户：${trunc(e.text)}`;
  if (e.type === 'assistant/message') return `- ${hhmm} 我：${trunc(e.text)}`;
  if (e.type === 'tool/call') return `- ${hhmm} [动作] ${e.name}`;
  if (e.type === 'turn/start') return `- ${hhmm} —— 回合开始`;
  if (e.type === 'turn/end') return `- ${hhmm} —— 回合结束（${e.reason || 'ok'}）`;
  return null;
}

const byDate = {};
for (const e of newEvents) {
  const d = localDate(e.time);
  (byDate[d] ||= []).push(e);
}
for (const [date, evs] of Object.entries(byDate)) {
  evs.sort((a, b) => a.time - b.time);
  const file = join(FLOW_DIR, `${date}.md`);
  const header = '## 对话流水（脚本记）';
  let prefix = '';
  if (!existsSync(file)) {
    prefix = `# ${date}\n\n${header}\n`;
  } else if (!readFileSync(file, 'utf8').includes(header)) {
    prefix = `\n---\n\n${header}\n`;
  }
  const body = evs.map(diaryLine).filter(Boolean).join('\n') + '\n';
  appendFileSync(file, prefix + body, 'utf8');
  console.log(`对话流水 ${date} 追加 ${evs.length} 条`);
}

// 空占位（本阶段不产出任务承诺，后续 evolve 再写）
if (!existsSync(TASKS_FILE)) writeFileSync(TASKS_FILE, '', 'utf8');

// 生成近况：按会话聚合最近一条活动，写两份 —— 家版（全量）与广场版（只含公开、脱敏）
// 家版给 Web/QQ私聊 读；广场版给 QQ群/B站 读，不含家会话的话，硬格式真实信息脱敏。
const RECENT_FILE = join(HOME, '近况.md');
const RECENT_PUBLIC_FILE = join(HOME, '近况-广场.md');
const NAMES_FILE = join(MEMORY_DIR, 'session-names.json');
const MAX_SESSIONS = 10;

// 入口判断：广场 = QQ群（im-bridge group）；其余（workspaces、私聊、B站私聊）算家。
// 2026-11-06 项目定：B站对外算广场但不进账本，B站会话归家。
//
// 2026-11-07 修：光看 cwd 会认错 —— QQ 私聊那条会话本来建在
// `im-bridge-chats\<账号>\<聊天>`（桥的 index.js 写死的），后来被搬进
// `workspaces\<人格名>`，而搬会话会把 header 里的 cwd 一并改写 —— 痕迹就没了，
// 于是这条 36 条对话的 QQ 会话被记成了 [Web]。
// im-bridge 自己的 state.json 里记着「哪个聊天正占着哪个 sessionId」，那才是准的：
//   chats["private:2994589881"].sessionId = "session-fda1a1e8-…"
// 先查它，查不到再退回按 cwd 猜。桥没开、文件不在，就还是老办法。
//
// 但 state.json 只记「现在」占着谁：聊天一换 sessionId，老会话就没人认领了。
// 所以再落一本只增不减的映射账 `记忆\入口映射.json`，把认过的 sessionId 记死。
const BRIDGE_STATE_FILE = join(HOME, 'im-bridge', 'state.json');
const ENTRY_MAP_FILE = join(MEMORY_DIR, '入口映射.json');
// 2026-11-09：B站 会话的 id 是我们自己起的（`bili-whale`），不是 uuid；而它的 cwd 搬家后是
//   `workspaces\<人格名>`，`whale-work` 也匹配不上。原来 `entryOf` 靠 `id.includes('bili')` 认它，
//   一旦这个会话改名/换 id 就会掉进 [Web]。改成显式清单 + 写进入口映射，三处判定查同一本账。
const BILI_SESSIONS = ['bili-whale'];
const entryMapSaved = (() => {
  try { return JSON.parse(readFileSync(ENTRY_MAP_FILE, 'utf8')) } catch { return {} }
})();
const bridgeSessions = (() => {
  const map = new Map();
  for (const [sid, entry] of Object.entries(entryMapSaved || {})) {
    if (typeof sid === 'string' && (entry === 'QQ群' || entry === 'QQ私聊' || entry === 'B站')) map.set(sid.toLowerCase(), entry);
  }
  try {
    const state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8'));
    for (const [chat, record] of Object.entries(state?.chats || {})) {
      const sid = record?.sessionId;
      if (typeof sid !== 'string' || sid.trim() === '') continue;
      const entry = chat.startsWith('group:') ? 'QQ群' : (chat.startsWith('private:') ? 'QQ私聊' : null);
      if (entry) map.set(sid.trim().toLowerCase(), entry);
    }
  } catch { /* 桥不在就退回 cwd 猜 */ }
  // 2026-11-09：B站 的会话不归桥管，靠显式清单补进来（写在桥之后，覆盖不了桥的判定）
  for (const sid of BILI_SESSIONS) if (!map.has(sid)) map.set(sid, 'B站');
  // 新认到的写回账本（只增不减；键排序，diff 好读）
  const merged = {};
  for (const sid of [...map.keys()].sort()) merged[sid] = map.get(sid);
  try {
    if (JSON.stringify(merged) !== JSON.stringify(entryMapSaved)) {
      writeFileSync(ENTRY_MAP_FILE, JSON.stringify(merged, null, 2), 'utf8');
    }
  } catch { /* 写不进去就本回合用内存里这份 */ }
  return map;
})();

function isSquare(cwd, sessionId) {
  if (bridgeSessions.get(String(sessionId || '').toLowerCase()) === 'QQ群') return true;
  const c = String(cwd || '').toLowerCase();
  if (c.includes('im-bridge') && c.includes('group')) return true;
  return false;
}

// F11：跨入口识别——这条活动来自哪个入口（让「用户在别处活动过」一眼可见）。
function entryOf(cwd, sessionId) {
  const id = String(sessionId || '').toLowerCase();
  const byBridge = bridgeSessions.get(id);
  if (byBridge) return byBridge;
  const c = String(cwd || '').toLowerCase();
  if (c.includes('im-bridge') && c.includes('group')) return 'QQ群';
  if (c.includes('im-bridge')) return 'QQ私聊';
  if (id.includes('bili') || c.includes('whale-work')) return 'B站';
  return 'Web';
}

// 硬格式脱敏：能高精度识别的真实信息抹成占位符（兜底；主力是家话不进广场版）
// 2026-11-09：银行卡从「16-19 位数字就抹」改成「还要过 Luhn」——原来订单号、微秒时间戳、
//   快递单号这类也被抹成 [银行卡]，看着像隐私其实只是噪声。真卡一定过 Luhn，所以不降安全。
function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redact(text) {
  let s = String(text || '');
  s = s.replace(/\b1[3-9]\d{9}\b/g, '[手机号]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱]');
  s = s.replace(/\b\d{16,19}\b/g, (m) => (luhnOk(m) ? '[银行卡]' : m));
  // 2026-11-07 修：旧正则 [\w\\\.\-]+ 拦不住中文/空格开头的路径（E:\记忆\… 首段是中文就不命中）。
  // 放宽成「盘符 + 冒号 + 斜杠 + 一串非空白、非引号尖括号竖线的字符」，中文和空格都能进。
  s = s.replace(/[A-Za-z]:[\\/][^\s"'<>|?*]+/g, '[路径]');
  return s;
}

// F10：人格文件哈希校验——只证明「文件被改过」，不证明「改得对」。
// 每次跑比对一次；变了就在近况顶部提示一次，然后更新记录（下次不重复提示）。
const PERSONA_FILES = ['灵魂设定.md', '说话的规矩.md', '判断标准.md', '错题集.md', '成长记录.md', '感官记忆.md', '操作手册.md'];
const PERSONA_HASH_FILE = join(MEMORY_DIR, '人格哈希.json');
function personaChanged() {
  const cur = {};
  for (const f of PERSONA_FILES) {
    try { cur[f] = createHash('sha256').update(readFileSync(join(HOME, f))).digest('hex').slice(0, 16); } catch {}
  }
  let prev = null;
  try { prev = JSON.parse(readFileSync(PERSONA_HASH_FILE, 'utf8')) } catch {}
  const hadPrev = prev && typeof prev === 'object' && Object.keys(prev).length > 0;
  writeFileSync(PERSONA_HASH_FILE, JSON.stringify(cur, null, 2), 'utf8');
  if (!hadPrev) return []; // 首次只记录，不提示
  const changed = Object.keys(cur).filter((f) => prev[f] && prev[f] !== cur[f]);
  const added = Object.keys(cur).filter((f) => !prev[f]);
  return [...changed, ...added];
}
{
  let names = {};
  try { names = JSON.parse(readFileSync(NAMES_FILE, 'utf8')) } catch {}
  // F15：读取遗忘清单，近况里跳过这些（原文仍在 events.jsonl，留底）
  const forgottenIds = new Set();
  try {
    const fp = join(MEMORY_DIR, 'forgotten.jsonl');
    if (existsSync(fp)) {
      for (const l of readFileSync(fp, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { forgottenIds.add(JSON.parse(l).event_id); } catch {}
      }
    }
  } catch {}
  let lines = [];
  try { lines = readFileSync(EVENTS_FILE, 'utf8').split('\n') } catch {}
  const latest = new Map();
  const recentBySession = new Map(); // F2：每会话最近 6 条（最新在前），用来判断状态
  const order = [];
  for (let i = lines.length - 1; i >= 0 && latest.size < MAX_SESSIONS; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t) } catch { continue }
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
    if (forgottenIds.has(e.event_id)) continue; // F15：已遗忘的不进近况
    const arr = recentBySession.get(e.session_id) || [];
    if (arr.length < 6) { arr.push(e); recentBySession.set(e.session_id, arr); }
    if (latest.has(e.session_id)) continue;
    latest.set(e.session_id, e);
    order.push(e.session_id);
  }
  const now = Date.now();
  const personaWarn = (() => {
    const ch = personaChanged();
    return ch.length ? `⚠ 人格文件有改动：${ch.join('、')}（哈希变了，只证明被改过，不证明改得对）` : '';
  })();
  const wsName = (cwd) => (String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '');
  const label = (e) => {
    const name = names[e.session_id] || '';
    const ws = wsName(e.cwd);
    if (name) return ws ? `${ws}/${name}` : name;
    const short = String(e.session_id || '').split('-')[1] || '';
    return ws ? `${ws}/${short}` : short;
  };
  const rel = (ms) => {
    const m = Math.round((now - ms) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  };
  const who = (e) => (e.type === 'user/message' ? '用户' : '我');
  const snippet = (e, isPublic) => {
    let txt = String(e.text || '').replace(/\s+/g, ' ').trim();
    if (isPublic) txt = redact(txt);
    return txt.length > 60 ? txt.slice(0, 60) + '…' : txt;
  };
  // F2：判断会话状态。启发式：超 3 天没动 = 已失效；最近 2 条里有明确取消语 = 已取消；
  // 有明确完成语（排除「没完成/未完成」这类否定）= 已完成；其余进行中。
  // 只看最近 2 条是为了减少「讨论这个词」造成的误判。
  const statusOf = (sid, lastTime) => {
    const DAY = 86400000;
    if (now - lastTime > 3 * DAY) return '已失效';
    const msgs = (recentBySession.get(sid) || []).slice(0, 2);
    const text = msgs.map((m) => String(m.text || '')).join(' ');
    if (/(取消了|不做了|不搞了|放弃吧|搁置了|先不搞了|算了不)/.test(text)) return '已取消';
    const hasDone = /(搞定了|做完了|完成了|弄好了|结束了|收工了|全部搞定)/.test(text);
    const hasNotDone = /(没|不|未)(有)?(搞定|完成|做完|弄好|结束)/.test(text);
    if (hasDone && !hasNotDone) return '已完成';
    return '进行中';
  };
  const rows = (isPublic) => order
    .filter((sid) => !isPublic || isSquare(latest.get(sid).cwd, sid))
    .map((sid) => {
      const e = latest.get(sid);
      // F14：来源可信度最小版——用户明说 = S1；我生成的 = S3（不自动升成 S1/S2）。
      const src = e.type === 'user/message' ? 'S1' : 'S3';
      return `- ${rel(e.time)} · [${entryOf(e.cwd, sid)}] ${label(e)} · 【${statusOf(sid, e.time)}】[${src}] ${who(e)}：${snippet(e, isPublic)}`;
    });
  const build = (isPublic, path) => {
    const r = rows(isPublic);
    const title = isPublic ? '# 近况 · 广场版（脚本记 · 自动生成）' : '# 近况（脚本记 · 自动生成）';
    const hint = isPublic
      ? '只含公开会话（QQ群）；家（私聊、B站私聊）的话不在这里；硬格式真实信息已脱敏。新的在前。'
      : '最近哪些会话在动、各会话最后在说什么。状态是脚本按「时间+关键词」启发式判断的，仅供参考。来源：[S1] 用户明说 / [S3] 我生成（推断，别当事实）。[入口] 标这条活动来自哪个入口。新的在前。';
    const body = [
      title, '', hint, ...(personaWarn ? [personaWarn, ''] : []), '',
      r.length ? r.join('\n') : '（还没有记到任何对话）', '',
    ].join('\n');
    writeFileSync(path, body, 'utf8');
    return r.length;
  };
  const homeN = build(false, RECENT_FILE);
  const pubN = build(true, RECENT_PUBLIC_FILE);
  console.log(`近况 更新（家版 ${homeN} 个会话，广场版 ${pubN} 个会话）`);
  // 2026-11-09：顺手刷「家书-冲浪版」——B站 冲浪会话投递时读它，内容跟着近况走才不馊。
  try {
    const { buildLetterFile } = await import('./build-surf-letter.mjs');
    buildLetterFile(HOME);
  } catch (e) { console.warn('家书生成失败（不影响记账）: ' + (e?.message ?? e)); }
}

// 写 state（2026-11-09：改原子写 —— 先写 .tmp 再改名。半截文件会让下一轮扫不到进度、
//   或者报 JSON 错然后从头扫，白烧 CPU。events 那边有 seenIds 兜底，state 这边没有。）
{
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, STATE_FILE)
}
console.log(`state 已更新（${Object.keys(state.files).length} 个文件）`);

// 后台补向量索引：新对话立刻能被语义检索到。不阻塞记账、不占主会话上下文；
// ollama 没起、或已经有另一个构建在跑，memory-semantic 自己会静默跳过。
try {
  const semantic = fileURLToPath(new URL('./memory-semantic.mjs', import.meta.url));
  const child = spawn(process.execPath, [semantic, '--build'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
} catch {
  // 补索引失败不影响记账本身
}

// 后台更新子代理映射：派了新子代理，token 页才能把它归到父会话下。不阻塞记账。
try {
  const subagentMap = fileURLToPath(new URL('./build-subagent-map.mjs', import.meta.url));
  const child = spawn(process.execPath, [subagentMap], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
} catch {
  // 映射更新失败不影响记账本身
}

// 后台更新会话标题：优先 DSH 真标题，没有的用「未命名会话-时间（日期）」。不阻塞记账。
try {
  const names = fileURLToPath(new URL('./build-session-names.mjs', import.meta.url));
  const child = spawn(process.execPath, [names], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
} catch {
  // 标题更新失败不影响记账本身
}
