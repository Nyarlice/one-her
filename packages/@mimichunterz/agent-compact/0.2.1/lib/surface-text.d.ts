export interface SurfaceNodeLike {
    type?: unknown;
    seq?: unknown;
    data?: unknown;
}
export interface AnyBlock {
    type?: unknown;
    text?: unknown;
    name?: unknown;
    arguments?: unknown;
    isError?: unknown;
    content?: unknown;
}
export interface BlockTextResult {
    text: string;
    chars: number;
}
export interface BlockTextOptions {
    /** 跳过 reasoning 块：文本与模型历史实际所见对齐。 */
    skipReasoning: boolean;
    /** 完全丢弃 image 块（连 `[image]` 占位符都不产生），而不仅仅是截断。 */
    dropImages?: boolean;
}
/** 取出一个 surface 节点承载的 content 块数组；非消息类节点返回 null。 */
export declare function nodeContent(n: SurfaceNodeLike): unknown;
/**
 * 单个 block 的文本，及其未截断的原始字符数。`remain` 是调用方还剩的截断
 * 预算（传 `Infinity` 表示不截断——锚点匹配走这条路）。
 */
export declare function blockText(b: unknown, depth: number, opts: BlockTextOptions, remain: number): BlockTextResult;
/** 拼接一个块数组的文本；`maxLen` 是总预算（传 `Infinity` 表示不截断）。 */
export declare function blocksText(blocks: unknown, depth: number, opts: BlockTextOptions, maxLen: number): BlockTextResult;
/** 一个 surface 节点的完整文本（锚点匹配用途：不截断，尾部换行已裁剪）。 */
export declare function nodeFlatText(n: SurfaceNodeLike, opts: BlockTextOptions): string;
