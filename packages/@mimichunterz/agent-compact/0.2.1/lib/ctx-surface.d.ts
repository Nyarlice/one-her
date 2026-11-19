import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
export declare const request$schema: z.ZodObject<{
    sessionId: z.ZodReadonly<z.ZodIntersection<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const block$schema: z.ZodObject<{
    kind: z.ZodReadonly<z.ZodUnion<readonly [z.ZodLiteral<"text">, z.ZodLiteral<"reasoning">, z.ZodLiteral<"tool-call">, z.ZodLiteral<"tool-result">, z.ZodLiteral<"image">, z.ZodLiteral<"block">]>>;
    label: z.ZodOptional<z.ZodReadonly<z.ZodString>>;
    text: z.ZodReadonly<z.ZodString>;
    chars: z.ZodReadonly<z.ZodNumber>;
}, z.core.$strip>;
export declare const row$schema: z.ZodObject<{
    seq: z.ZodReadonly<z.ZodNumber>;
    type: z.ZodReadonly<z.ZodString>;
    text: z.ZodReadonly<z.ZodString>;
    chars: z.ZodReadonly<z.ZodNumber>;
    tokens: z.ZodOptional<z.ZodReadonly<z.ZodNumber>>;
    blocks: z.ZodReadonly<z.ZodArray<z.ZodObject<{
        kind: z.ZodReadonly<z.ZodUnion<readonly [z.ZodLiteral<"text">, z.ZodLiteral<"reasoning">, z.ZodLiteral<"tool-call">, z.ZodLiteral<"tool-result">, z.ZodLiteral<"image">, z.ZodLiteral<"block">]>>;
        label: z.ZodOptional<z.ZodReadonly<z.ZodString>>;
        text: z.ZodReadonly<z.ZodString>;
        chars: z.ZodReadonly<z.ZodNumber>;
    }, z.core.$strip>>>;
    source: z.ZodOptional<z.ZodReadonly<z.ZodString>>;
}, z.core.$strip>;
export declare const result$schema: z.ZodReadonly<z.ZodObject<{
    rows: z.ZodReadonly<z.ZodArray<z.ZodObject<{
        seq: z.ZodReadonly<z.ZodNumber>;
        type: z.ZodReadonly<z.ZodString>;
        text: z.ZodReadonly<z.ZodString>;
        chars: z.ZodReadonly<z.ZodNumber>;
        tokens: z.ZodOptional<z.ZodReadonly<z.ZodNumber>>;
        blocks: z.ZodReadonly<z.ZodArray<z.ZodObject<{
            kind: z.ZodReadonly<z.ZodUnion<readonly [z.ZodLiteral<"text">, z.ZodLiteral<"reasoning">, z.ZodLiteral<"tool-call">, z.ZodLiteral<"tool-result">, z.ZodLiteral<"image">, z.ZodLiteral<"block">]>>;
            label: z.ZodOptional<z.ZodReadonly<z.ZodString>>;
            text: z.ZodReadonly<z.ZodString>;
            chars: z.ZodReadonly<z.ZodNumber>;
        }, z.core.$strip>>>;
        source: z.ZodOptional<z.ZodReadonly<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>>;
export type CtxSurfaceBlock = z.infer<typeof block$schema>;
export type CtxSurfaceRow = z.infer<typeof row$schema>;
export type CtxSurfaceReadRequest = z.infer<typeof request$schema>;
export type CtxSurfaceReadResult = z.infer<typeof result$schema>;
/**
 * 面向浏览器面板的实时 surface 读取器。纯消费者：读取折叠后的 surface 快照，
 * 绝不修改会话。
 */
export declare class CtxSurfaceService extends TypertRemoteService {
    /**
     * @param ctx - 携带 sessionQuery 的主机上下文。
     */
    constructor(ctx: Context);
    /**
     * 读取某个会话当前的折叠 surface 行（已移除 shadowed 事件，按模型历史顺序，
     * 带 seq 标记）。
     * @param request - 要检查的会话。
     * @returns 折叠后的行，或显式失败。
     */
    read(request: CtxSurfaceReadRequest): Promise<CtxSurfaceReadResult>;
}
