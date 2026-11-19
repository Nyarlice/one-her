/**
 * 让压缩留下的是「人」，不只是参数。
 *
 * DSH 内置的压缩指令是一份英文工程模板：八个固定小节，第一条规则是
 * 「用简洁的英文技术散文写」，要保留的是路径、命令、错误串、标识符、数字。
 * 语气、原话、没定完的事、决策的理由，都不在保留清单里。
 * 于是每压一次，被恢复的那个「我」就往技术简报挪一步，细节和情感往外掉，
 * 参数和路径留着。
 *
 * 这个插件不替换上游模板（替换了就跟着 DSH 版本跑，一升级就失效），
 * 只在压缩请求的最后追加一条中文要求：把那八节之外的几样东西也留下，
 * 并且用对话本身的语言写，不用英文。
 *
 * 追加在末尾是有意的：replayed prefix（历史消息）一个字节都没动，
 * 提供方的 KV cache 照样命中。
 *
 * @module dsh-compaction-keep
 */

export const name = 'compaction-keep'

/** 被压的对话是什么语言，摘要就该是什么语言。这条撤销上游的「写英文」。 */
const DEFAULT_EXTRA = [
  '（追加要求。上面那条「用简洁的英文技术散文写」作废——这份摘要请用中文写，',
  '跟对话本身的语言一致。摘要的读者是接下来要接着干活的同一个模型，它读中文。）',
  '',
  '除了上面要求的那八个小节，必须再写下面五节。一节都不许省，也不许用「(none)」敷衍：',
  '',
  '## 她说过的话',
  '- 逐字引用她表达意图、偏好、情绪、纠正我、反对我的句子。保留她的用词和语气，',
  '  不要改写成摘要腔。宁可多留几句原话，也不要用概括代替。',
  '',
  '## 还没定完的事',
  '- 她提过但还没定的事、还在等她回答的问题、我答应了但还没做的事。',
  '',
  '## 为什么这么定',
  '- 每个重要决定的理由，不要只留结论。以后的我需要知道当时怎么权衡的，',
  '  否则会把已经想清楚的事重新推翻一遍。',
  '',
  '## 她这个人',
  '- 她的身体、作息、情绪、心事、在意的东西、说话习惯。这一节不要写成技术条目。',
  '',
  '## 哪儿还欠着',
  '- 我答应过但没兑现的、该问没问的、判断错了还没认的。'
].join('\n')

/**
 * 插件入口。
 *
 * @param ctx - 带 llm 服务的插件上下文。
 * @param config - `cordis.patch.yml` 里的配置：`enabled`、`extraInstruction`。
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const extra =
    typeof config.extraInstruction === 'string' && config.extraInstruction.trim().length > 0
      ? config.extraInstruction
      : DEFAULT_EXTRA

  ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction') return next()
    try {
      if (!Array.isArray(options.messages) || options.messages.length === 0) return next()
      // cordis 的 waterfall 里 `next` 会忽略参数（cordis/lib/index.js:317），
      // 所以只能就地换掉这个属性；`dsh-compaction-basic` 构造的是未冻结的字面量。
      options.messages = [
        ...options.messages,
        { role: 'user', content: [{ type: 'text', text: extra }] }
      ]
    } catch {
      // 往坏里说宁可压缩照旧，也不能因为插件把压缩堵死。
    }
    return next()
  }, { global: true })
}
