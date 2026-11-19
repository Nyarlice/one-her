// @mimichunterz/agent-compact: surface 节点→文本提取的共享实现。
// 锚点匹配（src/index.ts）与浏览器上下文面板（src/ctx-surface.ts）曾各自维护一份
// 几乎相同的遍历逻辑（content 取值、block 展开、tool-call/tool-result 标记），
// 容易在演进中悄悄漂移——统一成一份，用参数表达两处真正不同的地方：
//   - 面板需要按预算截断长度、并按字符数统计 chars；锚点匹配不截断（预算传
//     Infinity），只要与模型历史实际所见对齐的纯文本。
//   - 面板的“扁平预览行”与“逐块展示”对图片的处理不同（预览行丢图片标记，
//     逐块展示保留 `[image]`）；锚点匹配则整体丢弃图片块（图片不是可比较的
//     文本，保留标记只会污染前缀匹配）。用独立的 dropImages 开关表达。
/** 取出一个 surface 节点承载的 content 块数组；非消息类节点返回 null。 */
export function nodeContent(n) {
    const d = n.data ?? null;
    if (!d)
        return null;
    const t = n.type;
    if (t === 'assistant/message' || t === 'tool/result') {
        const m = d.message;
        if (m && Array.isArray(m.content))
            return m.content;
        return null;
    }
    if (Array.isArray(d.content))
        return d.content;
    return null;
}
/**
 * 单个 block 的文本，及其未截断的原始字符数。`remain` 是调用方还剩的截断
 * 预算（传 `Infinity` 表示不截断——锚点匹配走这条路）。
 */
export function blockText(b, depth, opts, remain) {
    if (depth > 5 || !b || typeof b !== 'object')
        return { text: '', chars: 0 };
    const blk = b;
    if (opts.skipReasoning && blk.type === 'reasoning')
        return { text: '', chars: 0 };
    if (typeof blk.text === 'string')
        return { text: truncate(blk.text, remain), chars: blk.text.length };
    if (blk.type === 'tool-call') {
        const raw = '[tool-call ' + String(blk.name ?? '') + '] ' + (typeof blk.arguments === 'string' ? blk.arguments : '');
        return { text: truncate(raw, remain), chars: raw.length };
    }
    if (blk.type === 'tool-result') {
        const inner = blocksText(blk.content, depth + 1, opts, remain);
        const raw = '[tool-result' + (blk.isError ? ' error' : '') + '] ' + inner.text;
        return { text: truncate(raw, remain), chars: inner.chars + 1 };
    }
    if (blk.type === 'image')
        return opts.dropImages ? { text: '', chars: 0 } : { text: '[image]', chars: 7 };
    if (Array.isArray(blk.content))
        return blocksText(blk.content, depth + 1, opts, remain);
    return { text: '', chars: 0 };
}
/** 拼接一个块数组的文本；`maxLen` 是总预算（传 `Infinity` 表示不截断）。 */
export function blocksText(blocks, depth, opts, maxLen) {
    if (!Array.isArray(blocks))
        return { text: '', chars: 0 };
    let out = '';
    let chars = 0;
    let remain = maxLen;
    for (const b of blocks) {
        const part = blockText(b, depth, opts, remain);
        if (part.chars > 0) {
            chars += part.chars;
            if (part.text.length > 0) {
                out += part.text + '\n';
                remain = Math.max(0, maxLen - out.length);
            }
        }
    }
    return { text: out, chars };
}
function truncate(s, maxLen) {
    return s.length <= maxLen ? s : s.slice(0, maxLen);
}
/** 一个 surface 节点的完整文本（锚点匹配用途：不截断，尾部换行已裁剪）。 */
export function nodeFlatText(n, opts) {
    const blocks = nodeContent(n);
    if (!blocks)
        return '';
    return blocksText(blocks, 0, opts, Infinity).text.replace(/\n+$/, '');
}
