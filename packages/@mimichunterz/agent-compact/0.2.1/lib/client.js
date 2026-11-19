window.__ModuleLoader__.load({
	id: "@mimichunterz/agent-compact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// 宿主共享的 zod 模块；schema 区段保留 `z.` 前缀。
		const { z } = require("zod");

		//#region ctx-surface wire schemas（自 lib/ctx-surface.js 提取）
		const _ctxSurface_read_request$schema = z.object({
  sessionId: z.intersection(z.string(), z.unknown()).readonly(),
})

const _ctxSurface_read_block$schema = z.object({
  kind: z.union([z.literal('text'), z.literal('reasoning'), z.literal('tool-call'), z.literal('tool-result'), z.literal('image'), z.literal('block')]).readonly(),
  label: z.string().readonly().optional(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
})

const _ctxSurface_read_row$schema = z.object({
  seq: z.number().readonly(),
  type: z.string().readonly(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
  // 估算 token 数（chars/4+4 启发式，非真实计费值）。可选：宿主进程不热重载，
  // 客户端 bundle 会，两端存在更新窗口期。
  tokens: z.number().readonly().optional(),
  blocks: z.array(_ctxSurface_read_block$schema).readonly(),
  // 原始 `data.source.kind`，区分真实用户轮次与合成注入的 "context" 行。
  source: z.string().readonly().optional(),
})

const _ctxSurface_read_result$schema = z.object({
  rows: z.array(_ctxSurface_read_row$schema).readonly(),
}).readonly()
		const TYPERT_REMOTE = {
			package: '@mimichunterz/agent-compact',
			descriptors: [{
				id: '@mimichunterz/agent-compact#ctxSurface/read',
				service: 'ctxSurface',
				namespace: 'ctxSurface',
				method: 'read',
				invocation: { kind: 'direct' },
				parameters: [{
					name: 'request',
					wire: 'request',
					source: 'json',
					codec: {
						mode: 'strict',
						typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadRequest',
						create: () => _ctxSurface_read_request$schema,
					},
				}],
				result: {
					mode: 'strict',
					typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadResult',
					create: () => _ctxSurface_read_result$schema,
				},
				sourceLocation: { file: 'src/ctx-surface.ts', line: 181, column: 3 },
			}],
		}
		//#endregion

		//#region ctx-surface 视图 bundle（esbuild 编译自 src/client/entry.tsx）
		const ctxSurfaceViewModule = (function () {
			var module = { exports: {} };
			var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/entry.tsx
var entry_exports = {};
__export(entry_exports, {
  CSS: () => CSS,
  CSS_TAG: () => CSS_TAG,
  CtxSurfaceView: () => CtxSurfaceView
});
module.exports = __toCommonJS(entry_exports);

// src/client/CtxSurfaceView.tsx
var React3 = __toESM(require("react"), 1);

// src/client/DetailPanel.tsx
var React2 = __toESM(require("react"), 1);

// src/client/JsonTree.tsx
var React = __toESM(require("react"), 1);
function isExpandable(value) {
  return typeof value === "object" && value !== null;
}
function entriesOf(value) {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v]);
  if (value !== null && typeof value === "object") return Object.entries(value);
  return [];
}
function previewOf(value) {
  if (Array.isArray(value)) return "[" + value.length + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).length + "}";
  return "";
}
function primitiveText(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
function JsonTree(props) {
  return React.createElement("div", { className: "cxpJsonHost", role: "tree" }, React.createElement(JsonNode, {
    field: null,
    value: props.data,
    depth: 0,
    initialDepth: props.initialDepth ?? 1
  }));
}
function JsonNode(props) {
  const { field, value, depth, initialDepth } = props;
  const [expanded, setExpanded] = React.useState(depth < initialDepth);
  const expandable = isExpandable(value);
  const entries = expandable ? entriesOf(value) : [];
  const label = field !== null ? React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, field + ": ") : null;
  if (!expandable) {
    return React.createElement("div", { role: "treeitem" }, label, React.createElement("span", null, primitiveText(value)));
  }
  return React.createElement(
    "div",
    { role: "treeitem", "aria-expanded": expanded },
    React.createElement("span", {
      "data-json-expander": true,
      onClick: () => setExpanded((e) => !e)
    }, expanded ? "\u25BE" : "\u25B8"),
    label,
    React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, previewOf(value)),
    expanded && entries.length > 0 ? React.createElement("ul", null, entries.map(([key, item]) => React.createElement("li", { key }, React.createElement(JsonNode, {
      field: Array.isArray(value) ? "[" + key + "]" : key,
      value: item,
      depth: depth + 1,
      initialDepth
    })))) : null
  );
}

// src/client/surface-utils.ts
function isToolRow(row) {
  return row.type === "tool/result";
}
function rowKind(row) {
  if (row.type === "tool/result") return "tool";
  if (row.type === "user/message") return row.source !== void 0 && row.source !== "user" ? "context" : "user";
  return "message";
}
function laneOf(row) {
  if (row.type === "tool/result") return 2;
  if (row.type === "assistant/message") return 1;
  return 0;
}
function isTurnStart(row) {
  const k = rowKind(row);
  return k === "user" || k === "context";
}
var KIND_LABEL = {
  user: "USER",
  context: "CONTEXT",
  message: "ASSISTANT",
  tool: "TOOL"
};
function rowLabel(row) {
  return KIND_LABEL[rowKind(row)];
}
function rowPreview(row) {
  if (isToolRow(row)) {
    const call = row.blocks.find((b) => b.kind === "tool-result");
    if (call && call.label) return call.label;
  }
  for (const b of row.blocks) if (b.kind === "tool-call") return b.text.slice(0, 40);
  if (row.text.slice(0, 120)) return row.text.slice(0, 120);
  if (row.blocks.some((b) => b.kind === "image")) return "[\u56FE\u7247]";
  return "(\u7A7A)";
}
var MIN_ANCHOR_LEN = 10;
var MAX_ANCHOR_LEN = 300;
function normAnchor(s) {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[\p{P}\p{S}]+/gu, "");
}
function uniqueAnchorPrefix(rows, idx) {
  const target = rows[idx];
  const flat = target.text;
  const normed = rows.map((r) => normAnchor(r.text));
  const targetNorm = normed[idx];
  let len = Math.min(MIN_ANCHOR_LEN, targetNorm.length);
  while (len < Math.min(MAX_ANCHOR_LEN, targetNorm.length)) {
    const prefix = targetNorm.slice(0, len);
    const collides = normed.some((n, i) => i !== idx && n.slice(0, len) === prefix);
    if (!collides) break;
    len += 1;
  }
  let rawEnd = 0;
  let produced = 0;
  while (rawEnd < flat.length && produced < len) {
    const ch = flat[rawEnd];
    rawEnd += 1;
    if (!/\s/.test(ch) && !/[\p{P}\p{S}]/u.test(ch)) produced += 1;
  }
  return flat.slice(0, Math.max(rawEnd, Math.min(len, flat.length))) || flat;
}
function compressPrompt(rows, startIdx, endIdx) {
  const start = uniqueAnchorPrefix(rows, startIdx);
  const end = uniqueAnchorPrefix(rows, endIdx);
  return "\u533A\u95F4\u8D77\u70B9\u8BE5\u6D88\u606F\u7684\u5F00\u5934\u6587\u672C\u662F:\u300C" + start + "\u300D\n\u533A\u95F4\u7EC8\u70B9\u8BE5\u6D88\u606F\u7684\u5F00\u5934\u6587\u672C\u662F:\u300C" + end + "\u300D\n\n\u8BF7\u8C03\u7528 context_compact \u538B\u7F29\u8FD9\u4E00\u6BB5\u533A\u95F4:startAnchor \u586B\u4E0A\u9762\u7684\u8D77\u70B9\u6587\u672C,endAnchor \u586B\u4E0A\u9762\u7684\u7EC8\u70B9\u6587\u672C;\u68C0\u67E5\u70B9(summary)\u7531\u4F60\u81EA\u5DF1\u7F16\u5199,\u5FC5\u987B\u662F Markdown \u4E14\u6BD4\u539F\u533A\u95F4\u5C0F,\u4FDD\u7559\u5173\u952E\u8DEF\u5F84/\u547D\u4EE4/ID \u4E0E\u539F\u59CB\u9700\u6C42\u3001\u65B9\u5411\u3002";
}

// src/client/DetailPanel.tsx
var TAB_LABEL = { summary: "\u603B\u89C8", content: "\u5185\u5BB9", raw: "\u539F\u59CB JSON" };
var TABS = ["summary", "content", "raw"];
function BlockView(props) {
  const { block } = props;
  if (block.kind === "text" || block.kind === "reasoning") {
    if (!block.text) return null;
    return React2.createElement(
      React2.Fragment,
      null,
      block.label ? React2.createElement("div", { className: "cxpBlockHeading" }, block.label) : null,
      React2.createElement("p", { className: "cxpBlockText" }, block.text)
    );
  }
  if (block.kind === "tool-call") {
    return React2.createElement(
      React2.Fragment,
      null,
      React2.createElement("div", { className: "cxpBlockHeading" }, "tool-call" + (block.label ? " \xB7 " + block.label : "")),
      React2.createElement("pre", { className: "cxpBlockCode" }, block.text)
    );
  }
  if (block.kind === "tool-result") {
    return React2.createElement(
      React2.Fragment,
      null,
      React2.createElement("div", { className: "cxpBlockHeading" }, "tool-result" + (block.label ? " \xB7 " + block.label : "")),
      React2.createElement("pre", { className: "cxpBlockCode" }, block.text || "(\u7A7A)")
    );
  }
  if (block.kind === "image") {
    return React2.createElement("div", { className: "cxpBlockHeading" }, "[image]");
  }
  return block.text ? React2.createElement("pre", { className: "cxpBlockCode" }, block.text) : null;
}
function DetailPanel(props) {
  const { row, onClose, width, onResizeStart } = props;
  const [tab, setTab] = React2.useState("content");
  if (row === null) return null;
  return React2.createElement(
    "div",
    { className: "cxpDetails", style: { width: width + "px" } },
    React2.createElement("button", { className: "cxpDetailsResizeHandle", onPointerDown: onResizeStart, "aria-hidden": true }),
    React2.createElement(
      "div",
      { className: "cxpDetailsHeader" },
      React2.createElement(
        "div",
        { className: "cxpDetailsTitle" },
        React2.createElement("span", { className: "cxpDetailsTitleSeq" }, "seq " + row.seq),
        React2.createElement("span", { className: "cxpKindTag", "data-kind": rowKind(row), title: row.type }, rowLabel(row)),
        React2.createElement("span", { className: "cxpDetailsTitleKind" }, row.type)
      ),
      React2.createElement("button", { className: "cxpClose", onClick: onClose, "aria-label": "\u5173\u95ED\u8BE6\u60C5" }, "\xD7")
    ),
    React2.createElement(
      "div",
      { className: "cxpDetailTabs", role: "tablist" },
      TABS.map((t) => React2.createElement("button", {
        key: t,
        role: "tab",
        className: "cxpDetailTab" + (tab === t ? " cxpDetailTabActive" : ""),
        "aria-selected": tab === t,
        onClick: () => setTab(t)
      }, TAB_LABEL[t]))
    ),
    React2.createElement(
      "div",
      { className: "cxpDetailBody" },
      tab === "summary" ? React2.createElement(
        "dl",
        { className: "cxpOverview" },
        React2.createElement("div", null, React2.createElement("dt", null, "seq"), React2.createElement("dd", null, String(row.seq))),
        React2.createElement("div", null, React2.createElement("dt", null, "\u7C7B\u578B"), React2.createElement("dd", null, row.type)),
        React2.createElement("div", null, React2.createElement("dt", null, "\u5B57\u7B26\u6570"), React2.createElement("dd", null, String(row.chars))),
        React2.createElement("div", null, React2.createElement("dt", null, "blocks"), React2.createElement("dd", null, String(row.blocks.length)))
      ) : null,
      tab === "content" ? row.blocks.length > 0 ? row.blocks.map((b, i) => React2.createElement(BlockView, { key: i, block: b })) : React2.createElement("p", { className: "cxpBlockText" }, row.text || "(\u7A7A)") : null,
      tab === "raw" ? React2.createElement(JsonTree, { data: row, initialDepth: 2 }) : null
    )
  );
}

// src/client/CtxSurfaceView.tsx
var EMPTY_ROWS = [];
var DEFAULT_DETAILS_WIDTH = 380;
var MIN_DETAILS_WIDTH = 320;
function CtxSurfaceView(props) {
  const { sessionId, readSurface, inputActions, useSession } = props;
  const [rows, setRows] = React3.useState(EMPTY_ROWS);
  const [loading, setLoading] = React3.useState(false);
  const [error, setError] = React3.useState(null);
  const [startIdx, setStartIdx] = React3.useState(null);
  const [endIdx, setEndIdx] = React3.useState(null);
  const [detailIdx, setDetailIdx] = React3.useState(null);
  const [searchQuery, setSearchQuery] = React3.useState("");
  const [detailsWidth, setDetailsWidth] = React3.useState(DEFAULT_DETAILS_WIDTH);
  const resizeStartRef = React3.useRef(null);
  const rowElRefs = React3.useRef(/* @__PURE__ */ new Map());
  const tablePaneRef = React3.useRef(null);
  const scrollInitialized = React3.useRef(false);
  const [actualWidth, setActualWidth] = React3.useState(false);
  const [turnsCollapsed, setTurnsCollapsed] = React3.useState(false);
  const [callsCollapsed, setCallsCollapsed] = React3.useState(false);
  const [expandedKeys, setExpandedKeys] = React3.useState(/* @__PURE__ */ new Set());
  const load = React3.useCallback(() => {
    if (!sessionId || !readSurface) {
      setRows(EMPTY_ROWS);
      setLoading(false);
      setError(!readSurface ? "readSurface prop \u672A\u4F20\u5165" : "sessionId prop \u672A\u4F20\u5165");
      return;
    }
    setLoading(true);
    readSurface({ sessionId }).then((result) => {
      if (result && result.ok === true) {
        setRows(result.value.rows || EMPTY_ROWS);
        setError(null);
      } else {
        setRows(EMPTY_ROWS);
        setError(result && result.error && result.error.message || "\u8BFB\u53D6 surface \u5931\u8D25");
      }
    }).catch((err) => {
      setRows(EMPTY_ROWS);
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setLoading(false));
  }, [sessionId, readSurface]);
  const surfaceGrowth = useSession((snapshot) => snapshot.chat?.order?.length ?? 0);
  React3.useEffect(() => {
    load();
  }, [load, surfaceGrowth]);
  const handleSelect = React3.useCallback((idx) => {
    setDetailIdx(idx);
    const row = rows[idx];
    if (row && isToolRow(row)) return;
    if (startIdx === null) {
      setStartIdx(idx);
      setEndIdx(null);
      return;
    }
    if (idx === startIdx) {
      setStartIdx(null);
      setEndIdx(null);
      return;
    }
    setEndIdx(idx);
  }, [rows, startIdx]);
  const handleCompress = React3.useCallback(() => {
    if (startIdx === null || endIdx === null || !inputActions || !inputActions.setDraft) return;
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    inputActions.setDraft(compressPrompt(rows, lo, hi));
    setStartIdx(null);
    setEndIdx(null);
  }, [startIdx, endIdx, rows, inputActions]);
  const clearSelection = React3.useCallback(() => {
    setStartIdx(null);
    setEndIdx(null);
  }, []);
  const toggleTurns = React3.useCallback(() => {
    setTurnsCollapsed((v) => !v);
    setExpandedKeys(/* @__PURE__ */ new Set());
  }, []);
  const toggleCalls = React3.useCallback(() => {
    setCallsCollapsed((v) => !v);
    setExpandedKeys(/* @__PURE__ */ new Set());
  }, []);
  const expandGroup = React3.useCallback((key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);
  const filtered = React3.useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) => r.text.toLowerCase().includes(q) || String(r.seq).includes(q));
  }, [rows, searchQuery]);
  const span = startIdx !== null && endIdx !== null ? { lo: Math.min(startIdx, endIdx), hi: Math.max(startIdx, endIdx) } : null;
  const selectedTokens = React3.useMemo(() => {
    if (span === null) return null;
    let total = 0;
    for (let i = span.lo; i <= span.hi; i += 1) total += rows[i]?.tokens ?? 0;
    return total;
  }, [span, rows]);
  const tlWidths = React3.useMemo(() => {
    const n = filtered.length;
    if (n === 0) return [];
    if (!actualWidth) return filtered.map(() => 100 / n);
    const total = filtered.reduce((a, r) => a + Math.max(1, r.chars), 0);
    return filtered.map((r) => Math.max(1, r.chars * 100 / total));
  }, [filtered, actualWidth]);
  let tlLeft = 0;
  const tlSpans = filtered.map((row, i) => {
    const globalIdx = rows.indexOf(row);
    const width = tlWidths[i];
    const selected = span !== null && globalIdx >= span.lo && globalIdx <= span.hi;
    const item = { globalIdx, row, left: tlLeft, width, selected };
    tlLeft += width;
    return item;
  });
  const turnBoundaries = tlSpans.filter((s, i) => i > 0 && isTurnStart(s.row)).map((s) => s.left);
  const { displayItems, domKeyOf } = React3.useMemo(() => {
    const items = [];
    const domKeyOf2 = /* @__PURE__ */ new Map();
    let i = 0;
    while (i < filtered.length) {
      const row = filtered[i];
      const globalIdx = rows.indexOf(row);
      if (turnsCollapsed && isTurnStart(row)) {
        items.push({ kind: "row", globalIdx, row });
        domKeyOf2.set(globalIdx, "row-" + globalIdx);
        i += 1;
        const key = "turn-" + globalIdx;
        const runStart = i;
        let count = 0;
        while (i < filtered.length && !isTurnStart(filtered[i])) {
          i += 1;
          count += 1;
        }
        if (count > 0) {
          if (expandedKeys.has(key)) {
            for (let j = runStart; j < runStart + count; j += 1) {
              const r = filtered[j];
              const gIdx = rows.indexOf(r);
              items.push({ kind: "row", globalIdx: gIdx, row: r });
              domKeyOf2.set(gIdx, "row-" + gIdx);
            }
          } else {
            items.push({ kind: "summary", key, count });
            for (let j = runStart; j < runStart + count; j += 1) domKeyOf2.set(rows.indexOf(filtered[j]), key);
          }
        }
        continue;
      }
      if (!turnsCollapsed && callsCollapsed && isToolRow(row)) {
        const key = "calls-" + globalIdx;
        const runStart = i;
        let count = 0;
        while (i < filtered.length && isToolRow(filtered[i])) {
          i += 1;
          count += 1;
        }
        if (expandedKeys.has(key)) {
          for (let j = runStart; j < runStart + count; j += 1) {
            const r = filtered[j];
            const gIdx = rows.indexOf(r);
            items.push({ kind: "row", globalIdx: gIdx, row: r });
            domKeyOf2.set(gIdx, "row-" + gIdx);
          }
        } else {
          items.push({ kind: "summary", key, count });
          for (let j = runStart; j < runStart + count; j += 1) domKeyOf2.set(rows.indexOf(filtered[j]), key);
        }
        continue;
      }
      items.push({ kind: "row", globalIdx, row });
      domKeyOf2.set(globalIdx, "row-" + globalIdx);
      i += 1;
    }
    return { displayItems: items, domKeyOf: domKeyOf2 };
  }, [filtered, rows, turnsCollapsed, callsCollapsed, expandedKeys]);
  React3.useLayoutEffect(() => {
    if (scrollInitialized.current) return;
    if (loading || rows.length === 0) return;
    const pane = tablePaneRef.current;
    if (!pane) return;
    scrollInitialized.current = true;
    pane.scrollTop = pane.scrollHeight;
  }, [loading, rows]);
  React3.useEffect(() => {
    if (detailIdx === null) return;
    const key = domKeyOf.get(detailIdx);
    if (!key) return;
    const el = rowElRefs.current.get(key);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [detailIdx, domKeyOf]);
  const onResizePointerDown = React3.useCallback((event) => {
    resizeStartRef.current = { startX: event.clientX, startWidth: detailsWidth };
    const onMove = (e) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const next = start.startWidth - (e.clientX - start.startX);
      setDetailsWidth(Math.max(MIN_DETAILS_WIDTH, next));
    };
    const onUp = () => {
      resizeStartRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [detailsWidth]);
  const detailRow = detailIdx !== null ? rows[detailIdx] ?? null : null;
  return React3.createElement(
    "div",
    { className: "cxpRoot", "data-conversation-composer-overlay": "" },
    React3.createElement(
      "div",
      { className: "cxpToolbar" },
      React3.createElement("button", {
        className: "cxpToolbarBtn",
        onClick: clearSelection,
        disabled: startIdx === null && endIdx === null
      }, "\u6E05\u9664\u9009\u62E9"),
      React3.createElement("button", {
        className: "cxpToolbarBtn" + (span !== null ? " cxpToolbarBtnActive" : ""),
        onClick: handleCompress,
        disabled: span === null
      }, "\u538B\u7F29\u6B64\u533A\u95F4"),
      React3.createElement(
        "span",
        { className: "cxpToolbarStats" },
        rows.length + " \u6761" + (span !== null ? " \xB7 \u5DF2\u9009 " + (span.hi - span.lo + 1) + " \u884C \xB7 \u7EA6 " + selectedTokens + " tok" : "")
      ),
      React3.createElement("input", {
        className: "cxpToolbarSearch",
        placeholder: "\u641C\u7D22",
        value: searchQuery,
        onChange: (e) => setSearchQuery(e.target.value)
      })
    ),
    React3.createElement(
      "div",
      { className: "cxpViewBar", role: "toolbar", "aria-label": "\u89C6\u56FE\u9009\u9879" },
      React3.createElement(
        "button",
        {
          type: "button",
          className: "cxpViewToggle",
          "aria-pressed": actualWidth,
          title: actualWidth ? "\u5207\u6362\u4E3A\u7B49\u5BBD\u663E\u793A" : "\u5207\u6362\u4E3A\u6309\u5B57\u7B26\u6570\u5BBD\u5EA6\u663E\u793A",
          onClick: () => setActualWidth((v) => !v)
        },
        React3.createElement(
          "svg",
          {
            className: "cxpViewToggleIcon",
            viewBox: "0 0 16 16",
            fill: "none",
            "aria-hidden": "true"
          },
          React3.createElement("circle", { cx: "8", cy: "8", r: "5.25" }),
          React3.createElement("path", { d: "M8 4.75V8l2.25 1.5" })
        ),
        "Duration"
      ),
      React3.createElement(
        "button",
        {
          type: "button",
          className: "cxpViewAction",
          "aria-pressed": turnsCollapsed,
          title: turnsCollapsed ? "\u5C55\u5F00\u5168\u90E8\u8F93\u5165\u8F6E\u6B21" : "\u6298\u53E0\u5168\u90E8\u8F93\u5165\u8F6E\u6B21",
          onClick: toggleTurns
        },
        React3.createElement("span", { className: "cxpViewActionIcon", "aria-hidden": "true" }, turnsCollapsed ? "\u229E" : "\u229F"),
        "Turns"
      ),
      React3.createElement(
        "button",
        {
          type: "button",
          className: "cxpViewAction",
          "aria-pressed": callsCollapsed,
          title: callsCollapsed ? "\u5C55\u5F00\u5168\u90E8\u5DE5\u5177\u8C03\u7528" : "\u6298\u53E0\u5168\u90E8\u5DE5\u5177\u8C03\u7528",
          onClick: toggleCalls
        },
        React3.createElement("span", { className: "cxpViewActionIcon", "aria-hidden": "true" }, callsCollapsed ? "\u229E" : "\u229F"),
        "Calls"
      )
    ),
    React3.createElement(
      "div",
      { className: "cxpTimeline" },
      React3.createElement(
        "div",
        { className: "cxpTlLabels" },
        React3.createElement("span", null, "\u8F93\u5165"),
        React3.createElement("span", null, "\u6A21\u578B"),
        React3.createElement("span", null, "\u5DE5\u5177")
      ),
      React3.createElement(
        "div",
        { className: "cxpTlTrack" },
        tlSpans.map((s) => React3.createElement("div", {
          key: s.globalIdx,
          className: "cxpTlSpan",
          "data-timeline-span": rowKind(s.row),
          "data-selected": span === null ? true : s.selected,
          "data-current": s.globalIdx === startIdx || s.globalIdx === endIdx,
          style: { left: s.left + "%", width: "max(2px, " + s.width + "%)", top: 5 + laneOf(s.row) * 14 + "px" },
          onClick: () => handleSelect(s.globalIdx),
          title: rowPreview(s.row)
        })),
        turnBoundaries.map((left, i) => React3.createElement("div", {
          key: "boundary-" + i,
          className: "cxpTlTurnBoundary",
          style: { left: left + "%" }
        }))
      )
    ),
    React3.createElement(
      "div",
      { className: "cxpLedger" },
      React3.createElement(
        "div",
        { className: "cxpTablePane", ref: tablePaneRef },
        loading && rows.length === 0 ? React3.createElement("div", { className: "cxpEmpty" }, "\u52A0\u8F7D\u4E2D\u2026") : error ? React3.createElement("div", { className: "cxpErr" }, error) : React3.createElement(
          "table",
          { className: "cxpTbl" },
          React3.createElement(
            "colgroup",
            null,
            React3.createElement("col", { className: "cxpColKind" }),
            React3.createElement("col", null)
          ),
          React3.createElement(
            "tbody",
            null,
            filtered.length === 0 ? React3.createElement("tr", null, React3.createElement("td", { colSpan: 2, className: "cxpEmpty" }, rows.length === 0 ? "\u6682\u65E0 surface \u6D88\u606F" : "\u65E0\u5339\u914D\u7ED3\u679C")) : displayItems.map((item) => {
              if (item.kind === "summary") {
                return React3.createElement(
                  "tr",
                  {
                    key: item.key,
                    className: "cxpSummaryRow",
                    ref: (el) => {
                      if (el) rowElRefs.current.set(item.key, el);
                      else rowElRefs.current.delete(item.key);
                    },
                    onClick: () => expandGroup(item.key),
                    title: "\u70B9\u51FB\u5C55\u5F00"
                  },
                  React3.createElement(
                    "td",
                    { colSpan: 2 },
                    React3.createElement("span", { className: "cxpSummaryEllipsis" }, "\u22EF"),
                    "\u5DF2\u6298\u53E0 " + item.count + " \u6761"
                  )
                );
              }
              const { globalIdx, row } = item;
              const isStart = globalIdx === startIdx;
              const isEnd = globalIdx === endIdx;
              const inSpan = span !== null && globalIdx >= span.lo && globalIdx <= span.hi;
              return React3.createElement(
                "tr",
                {
                  key: row.seq,
                  className: "cxpTblRow",
                  ref: (el) => {
                    const key = "row-" + globalIdx;
                    if (el) rowElRefs.current.set(key, el);
                    else rowElRefs.current.delete(key);
                  },
                  "data-selected": isStart || isEnd || inSpan || globalIdx === detailIdx,
                  onClick: () => handleSelect(globalIdx)
                },
                React3.createElement(
                  "td",
                  { className: "cxpKindCell" },
                  isStart ? React3.createElement("span", { className: "cxpSpanBadge" }, "\u8D77\u70B9") : null,
                  isEnd ? React3.createElement("span", { className: "cxpSpanBadge" }, "\u7EC8\u70B9") : null,
                  React3.createElement("span", { className: "cxpKindTag", "data-kind": rowKind(row), title: row.type }, rowLabel(row))
                ),
                React3.createElement("td", { className: "cxpContent" }, rowPreview(row))
              );
            })
          )
        )
      ),
      React3.createElement(DetailPanel, {
        row: detailRow,
        onClose: () => setDetailIdx(null),
        width: detailsWidth,
        onResizeStart: onResizePointerDown
      })
    )
  );
}

// src/client/styles.ts
var CSS_TAG = "@mimichunterz/agent-compact/ctx-surface.css";
var CSS = `
.cxpRoot{--dsh-trajectory-toolbar-height:34px;box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;display:flex;overflow:hidden}
.cxpToolbar{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:6px;height:var(--dsh-trajectory-toolbar-height);padding:0 10px;display:flex}
.cxpToolbarBtn{color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:4px}
.cxpToolbarBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.cxpToolbarBtnActive{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-state-business-primary);font-weight:600}
.cxpToolbarBtnActive:hover{background:var(--dsw-alias-state-business-primary);opacity:.92;color:var(--dsw-alias-bg-layer-1)}
.cxpToolbarBtn:disabled{opacity:.4;cursor:default;background:var(--dsw-alias-bg-module-platform)}
.cxpToolbarStats{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap;margin-left:6px}
.cxpToolbarSearch{margin-left:auto;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);height:24px;padding:0 8px;width:180px}
.cxpViewBar{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:center;gap:2px;height:26px;padding:0 6px;display:flex}
.cxpViewToggle{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 7px;display:inline-flex}
.cxpViewToggle:hover,.cxpViewToggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpViewToggleIcon{stroke:currentColor;stroke-width:1.25px;stroke-linecap:round;stroke-linejoin:round;flex:none;width:12px;height:12px}
.cxpViewAction{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 5px;display:inline-flex}
.cxpViewAction:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpViewActionIcon{color:var(--dsw-alias-label-tertiary);font:14px/14px var(--ds-font-family-code)}
.cxpTimeline{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);grid-template-columns:40px minmax(0,1fr);height:50px;display:grid;flex:none;overflow:hidden}
.cxpTlLabels{border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font:9px/1 var(--dsw-font-family);position:relative}
.cxpTlLabels span{text-align:right;justify-content:flex-end;align-items:center;height:12px;display:flex;position:absolute;right:4px}
.cxpTlLabels span:nth-child(1){top:5px}
.cxpTlLabels span:nth-child(2){top:19px}
.cxpTlLabels span:nth-child(3){top:33px}
.cxpTlTrack{position:relative;overflow:hidden}
.cxpTlSpan{position:absolute;height:10px;border-radius:1.5px;cursor:pointer;opacity:.88;transition:opacity .1s}
.cxpTlSpan:hover{opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent)}
.cxpTlSpan[data-timeline-span=user]{background:var(--dsw-alias-state-business-primary)}
.cxpTlSpan[data-timeline-span=context]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-label-secondary))}
.cxpTlSpan[data-timeline-span=message]{background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 60%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary)))}
.cxpTlSpan[data-timeline-span=tool]{background:var(--dsw-alias-state-warn-label)}
.cxpTlSpan[data-selected=false]{opacity:.22}
.cxpTlSpan[data-current=true]{opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px var(--dsw-alias-state-business-primary)}
.cxpTlTurnBoundary{position:absolute;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l1);pointer-events:none}
.cxpLedger{flex:1;min-width:0;min-height:0;display:flex;position:relative;overflow:hidden;container-type:inline-size;--dsh-trajectory-bottom-clearance:calc(var(--dsh-composer-height,152px) + 16px)}
.cxpTablePane{min-width:0;flex:1;position:relative;overflow:hidden auto;padding-bottom:var(--dsh-trajectory-bottom-clearance,0px)}
.cxpTbl{border-spacing:0;table-layout:fixed;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12)}
.cxpTbl col.cxpColKind{width:84px}
.cxpKindCell{text-align:right}
.cxpTbl td{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);height:28px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.cxpTblRow{cursor:pointer}
.cxpTblRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cxpTblRow[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}
.cxpSummaryRow{cursor:pointer}
.cxpSummaryRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cxpSummaryRow td{height:22px;color:var(--dsw-alias-label-tertiary)}
.cxpSummaryEllipsis{color:var(--dsw-alias-label-caption);font-weight:600;margin-right:6px}
.cxpKindTag{box-sizing:border-box;letter-spacing:.035em;border-radius:4px;font-size:10px;font-weight:650;line-height:16px;padding:0 5px;display:inline-flex}
.cxpKindTag[data-kind=user]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.cxpKindTag[data-kind=context]{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-success-tertiary)}
.cxpKindTag[data-kind=message]{color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 60%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary)));background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 55%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary))) 15%,var(--dsw-alias-bg-layer-1))}
.cxpKindTag[data-kind=tool]{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.cxpSpanBadge{color:var(--dsw-alias-state-business-primary);font:600 10px/16px var(--dsw-font-family);margin-right:4px}
.cxpContent{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px}
.cxpEmpty,.cxpErr{color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px;font:var(--dsw-font-xxs-12)}
.cxpErr{color:var(--dsw-alias-state-error-primary)}
.cxpDetails{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-direction:column;flex:none;width:clamp(320px,38%,440px);min-width:0;max-width:calc(100% - 240px);min-height:0;display:flex;position:relative}
.cxpDetailsResizeHandle{cursor:col-resize;touch-action:none;background:0 0;border:0;width:8px;padding:0;position:absolute;top:0;bottom:0;left:-4px;z-index:2}
.cxpDetailsHeader{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;height:40px;padding:0 8px 0 12px;display:flex}
.cxpDetailsTitle{min-width:0;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;display:flex;overflow:hidden}
.cxpDetailsTitleSeq{font:500 12px/16px var(--ds-font-family-code);flex:none}
.cxpDetailsTitleKind{color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis}
.cxpClose{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
.cxpClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpDetailTabs{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;flex:none;gap:2px;height:32px;padding:0 8px;display:flex;overflow:auto hidden}
.cxpDetailTab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;padding:0 9px;position:relative}
.cxpDetailTab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpDetailTabActive{color:var(--dsw-alias-state-business-primary)}
.cxpDetailTabActive:after{content:"";position:absolute;left:9px;right:9px;bottom:0;height:2px;border-radius:1px 1px 0 0;background:var(--dsw-alias-state-business-primary)}
.cxpDetailBody{flex:1;min-height:0;overflow:hidden auto;padding:10px 14px}
.cxpOverview>div{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;min-height:22px}
.cxpOverview dt{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.cxpOverview dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxpBlockHeading{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-strong-13,600 12px/18px var(--dsw-font-family));margin:12px 0 4px}
.cxpBlockHeading:first-child{margin-top:0}
.cxpBlockText{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13,13px/19px var(--dsw-font-family));white-space:pre-wrap;margin:0 0 8px}
.cxpBlockCode{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-module-platform));font:12px/19px var(--ds-font-family-code);white-space:pre-wrap;border-radius:4px;margin:0 0 8px;padding:8px}
.cxpJsonHost{font:12px/18px var(--ds-font-family-code)}
.cxpJsonHost [role=treeitem]{padding:1px 0}
.cxpJsonHost [data-json-expander]{display:inline-block;width:12px;color:var(--dsw-alias-label-caption);cursor:pointer;user-select:none}
.cxpJsonHost ul{list-style:none;margin:0;padding-left:14px;border-left:1px dotted var(--dsw-alias-border-l1)}
`;

			return module.exports;
		})();
		const CtxSurfaceView = ctxSurfaceViewModule.CtxSurfaceView;
		const CSS_TAG = ctxSurfaceViewModule.CSS_TAG;
		const CTX_SURFACE_CSS = ctxSurfaceViewModule.CSS;
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@mimichunterz/agent-compact";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CTX_SURFACE_CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region apply
		// 顶层 inject 不能包含 remote.ctxSurface（本 bundle 是唯一提供者，入口层
		// 声明会死锁启动）；改为先 $mount 命名空间，再从嵌套子插件中消费。
		const inject = ["slots", "remote"];
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			await ctx.plugin({
				inject: ["slots", "remote", "remote.ctxSurface"],
				apply(sub) {
					sub.slots.inject("conversation.view", () => sub.slots.register({
						name: "conversation.view",
						id: "ctx-surface",
						order: 20,
						label: () => "上下文",
						inject: () => ({
							readSurface: (request) => sub.remote.ctxSurface.read(request),
						}),
					}, CtxSurfaceView));
				},
			});
			return () => {};
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
