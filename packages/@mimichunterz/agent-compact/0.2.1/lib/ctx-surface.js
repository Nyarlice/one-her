// @mimichunterz/agent-compact: ctx-surface 主机服务（Typert Remote）。
// 把会话的实时模型 surface 作为类型化 Remote（`ctxSurface/read`）暴露给
// 浏览器客户端，供「上下文」面板渲染。
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { blockText, blocksText, nodeContent } from './surface-text.js';
// ---- 线上类型（schema 为唯一源头，host/client 描述符直接复用；类型由 schema
// 推导。下面的 schema 定义区段会被 scripts/build-client.mjs 提取进浏览器 bundle，
// 勿在区段内引用本文件的其他运行时值）----
// ctx-surface wire schemas start
export const request$schema = z.object({
    sessionId: z.intersection(z.string(), z.unknown()).readonly(),
});
export const block$schema = z.object({
    kind: z.union([z.literal('text'), z.literal('reasoning'), z.literal('tool-call'), z.literal('tool-result'), z.literal('image'), z.literal('block')]).readonly(),
    label: z.string().readonly().optional(),
    text: z.string().readonly(),
    chars: z.number().readonly(),
});
export const row$schema = z.object({
    seq: z.number().readonly(),
    type: z.string().readonly(),
    text: z.string().readonly(),
    chars: z.number().readonly(),
    // 估算 token 数（chars/4+4 启发式，非真实计费值）。可选：宿主进程不热重载，
    // 客户端 bundle 会，两端存在更新窗口期。
    tokens: z.number().readonly().optional(),
    blocks: z.array(block$schema).readonly(),
    // 原始 `data.source.kind`，区分真实用户轮次与合成注入的 "context" 行。
    source: z.string().readonly().optional(),
});
export const result$schema = z.object({
    rows: z.array(row$schema).readonly(),
}).readonly();
const TEXT_MAX = 8000;
const BLOCKS_MAX = 20;
// 估算 token 的启发式常数，照抄 @deepseek-ai/dsh-token-meter（chars/4 + 每条
// 消息 +4），与宿主压缩提醒的口径一致。用未截断的 flat.chars 本地算即可。
const TOKEN_CHARS_PER_TOKEN = 4;
const TOKEN_MESSAGE_OVERHEAD = 4;
function estimateTokensFromChars(chars) {
    return Math.ceil(chars / TOKEN_CHARS_PER_TOKEN) + TOKEN_MESSAGE_OVERHEAD;
}
// nodeContent/blockText/blocksText 来自 ./surface-text.ts：与锚点匹配
// （src/index.ts）共用同一套 surface 节点→文本遍历逻辑，避免两处各自维护、
// 悄悄漂移。面板这里用 `{ skipReasoning: true, dropImages: true }` 且带截断
// 预算；锚点匹配那边用同一函数、不截断、且 dropImages 与 skipReasoning 同步。
function kindOf(b) {
    const blk = b;
    switch (blk.type) {
        case 'text': return 'text';
        case 'reasoning': return 'reasoning';
        case 'tool-call': return 'tool-call';
        case 'tool-result': return 'tool-result';
        case 'image': return 'image';
        default: return 'block';
    }
}
// 只有 `user/message` 事件携带 `data.source`（kind 由生产者自行声明）；
// 其他行类型返回 undefined，完全不上线。
function sourceKindOf(n) {
    if (n.type !== 'user/message')
        return undefined;
    const d = n.data ?? null;
    const kind = d && d.source && typeof d.source === 'object' ? d.source.kind : undefined;
    return typeof kind === 'string' ? kind : undefined;
}
function blockLabel(b) {
    const blk = b;
    if (blk.type === 'tool-call' || blk.type === 'tool-result') {
        const name = typeof blk.name === 'string' && blk.name ? blk.name : undefined;
        return name;
    }
    return undefined;
}
function rowOf(n) {
    const seq = n.seq;
    const type = n.type;
    if (typeof seq !== 'number' || !type)
        return null;
    const blocks = [];
    const content = nodeContent(n);
    if (Array.isArray(content)) {
        let remain = TEXT_MAX;
        for (const b of content) {
            if (blocks.length >= BLOCKS_MAX)
                break;
            const part = blockText(b, 0, { skipReasoning: true }, remain);
            if (part.chars === 0 && part.text.length === 0)
                continue;
            const label = blockLabel(b);
            const block = {
                kind: kindOf(b),
                text: part.text,
                chars: part.chars,
                ...(label !== undefined ? { label } : {}),
            };
            blocks.push(block);
            remain = Math.max(0, TEXT_MAX - blocks.reduce((acc, blk) => acc + blk.text.length, 0));
        }
    }
    const flat = blocksText(content, 0, { skipReasoning: true, dropImages: true }, TEXT_MAX);
    const source = sourceKindOf(n);
    return {
        seq,
        type,
        text: flat.text.replace(/\n+$/, ''),
        chars: flat.chars,
        tokens: estimateTokensFromChars(flat.chars),
        blocks,
        ...(source !== undefined ? { source } : {}),
    };
}
/**
 * 面向浏览器面板的实时 surface 读取器。纯消费者：读取折叠后的 surface 快照，
 * 绝不修改会话。
 */
let CtxSurfaceService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _read_decorators;
    return class CtxSurfaceService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _read_decorators = [Remote('read')];
            __esDecorate(this, null, _read_decorators, { kind: "method", name: "read", static: false, private: false, access: { has: obj => "read" in obj, get: obj => obj.read }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        /**
         * @param ctx - 携带 sessionQuery 的主机上下文。
         */
        constructor(ctx) {
            super(ctx, 'ctxSurface');
            __runInitializers(this, _instanceExtraInitializers);
        }
        /**
         * 读取某个会话当前的折叠 surface 行（已移除 shadowed 事件，按模型历史顺序，
         * 带 seq 标记）。
         * @param request - 要检查的会话。
         * @returns 折叠后的行，或显式失败。
         */
        async read(request) {
            const sessionQuery = this.ctx.get('sessionQuery');
            if (!sessionQuery) {
                throw new Error('session-query-unavailable');
            }
            let snap;
            try {
                snap = await sessionQuery.readSurface(request.sessionId);
            }
            catch (err) {
                const message = err && err.message ? err.message : String(err);
                this.ctx.logger.warn('[agent-compact] ctxSurface/read failed for %s: %s', request.sessionId, message);
                throw new Error(message);
            }
            const events = snap && Array.isArray(snap.events) ? snap.events : [];
            const rows = [];
            for (const ev of events) {
                if (!ev || typeof ev !== 'object')
                    continue;
                const row = rowOf(ev);
                if (row)
                    rows.push(row);
            }
            return { rows };
        }
    };
})();
export { CtxSurfaceService };
