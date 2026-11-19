import type { SurfaceNode } from './optimizer.js';
/**
 * 恰好携带这一个 tool-call 的 assistant/message 节点（用于判断该调用所属的
 * 消息节点能否被 shadow，而不破坏同一条消息里的其他兄弟 tool-call）。
 */
export declare function soleToolCall(n: SurfaceNode, callId: string): boolean;
export declare function nodeText(n: SurfaceNode, skipReasoning?: boolean): string;
export declare function nodeErrorTag(n: SurfaceNode): string;
export declare function preview(text: unknown, max: number): string;
export declare function prefixHits(nodes: SurfaceNode[], anchor: string): number[];
export declare function resolveUniqueHit(nodes: SurfaceNode[], anchor: string, side: string): number;
export declare function snapStartBalanced(nodes: SurfaceNode[], si: number): number;
export declare function snapEndBalanced(nodes: SurfaceNode[], ei: number): number;
export interface BoundaryResolveResult {
    si: number;
    ei: number;
    startSeq: number;
    endSeq: number;
    method: string;
    detail: {
        startPos: number;
        endPos: number;
    };
}
export declare function resolveBoundaries(nodes: SurfaceNode[], args: {
    startAnchor?: unknown;
    endAnchor?: unknown;
}): BoundaryResolveResult;
export declare function spanText(nodes: SurfaceNode[], si: number, ei: number): string;
