export interface SurfaceNode {
    seq: number;
    [key: string]: unknown;
}
export interface SessionLike {
    id: string;
    surface?: {
        nodes?: readonly number[];
    };
    events?: readonly unknown[];
    deriveEventMessage?: (event: any) => unknown;
    requestHeader?: () => {
        config?: {
            provider?: string;
            model?: string;
        };
    } | undefined;
}
export interface AgentLike {
    session?: SessionLike;
    options?: {
        provider?: string;
        model?: string;
    };
    ctx?: unknown;
}
/** 修补所依赖的引擎表面（结构化且防御性；真实引擎是 BasicCompactionEngine，
 * 携带这些成员）。 */
export interface OptimizedEngineLike {
    /**
     * agent 提供的检查点文本，按会话 id 为键（一次性：被该会话的下一次
     * summarize 消费）。存在时，被修补的 summarize() 直接把它作为摘要返回——
     * 执行中的 agent 自行编写替换检查点，因此不会发起 LLM 摘要调用。
     */
    _externalSummary?: Record<string, string>;
    summarize?: (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>;
    /** 补丁版本；修补行为变化时递增（见下文）。 */
    __ctxcOptimized?: number;
}
export declare const PATCH_VERSION = 3;
export declare function patchEngine(engine: OptimizedEngineLike): boolean;
