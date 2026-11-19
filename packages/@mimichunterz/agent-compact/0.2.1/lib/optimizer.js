// @mimichunterz/agent-compact: 共享的优化器核心（零依赖）。
// patchEngine() 修补主机压缩引擎的 summarize()，使其尊重 agent 提供的检查点
// （_externalSummary，一次性、按会话 id 为键）：存在时直接返回该文本（不发
// LLM 请求）；不存在时转发原版实现，自动压缩行为保持不变。
// 压缩引擎是主机级单例（HMR 后存活），用带版本的守卫在每次修补时重新绑定
// summarize，使代码修改可以热生效。
export const PATCH_VERSION = 3;
export function patchEngine(engine) {
    if (!engine || typeof engine.summarize !== 'function')
        return false;
    if (engine.__ctxcOptimized === PATCH_VERSION)
        return true;
    const origSummarize = engine.summarize.bind(engine);
    engine.summarize = async function (input, agent, signal) {
        const a = agent;
        const sid = a && a.session && a.session.id ? a.session.id : undefined;
        const ext = this._externalSummary;
        if (sid && ext && typeof ext[sid] === 'string') {
            const text = ext[sid];
            delete ext[sid];
            // 与原版 summarizer 返回的运行时形状相同（文本摘要 + usage 信封）；
            // 引擎的 frameSummary 与大小检查仍然生效。
            return {
                summary: [{ type: 'text', text }],
                rawOutput: [],
                llmStreamCall: false,
                provider: 'agent',
                model: 'agent',
                maxTokens: 0,
            };
        }
        return origSummarize(input, agent, signal);
    };
    engine.__ctxcOptimized = PATCH_VERSION;
    return true;
}
