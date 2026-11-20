# dsh-memory-ledger

给 [DeepSeek Harness](https://github.com/anywhere-labs/dsh-desktop) 用的记账插件。每轮对话结束，它把这一轮写进账本，顺手生成一份「最近哪些会话在动」的近况。

属于 [一个她（one-her）](https://github.com/Nyarlice/one-her) 那套「让 AI 跨会话还是同一个她」的插件之一。四个包各管一段：这个管记账。

## 装了它会做什么

- **记流水**：每轮结束扫一遍会话文件，把问答写进 `DSH_HOME/记忆/events.jsonl`，同时按天分页写一份人能读的短篇到 `记忆/对话流水/`。
- **生成近况**：把最近 10 个会话的状态汇总成 `DSH_HOME/近况.md`，另一份只含公开会话的写到 `近况-广场.md`。
- **补会话标题**：从运行时拿会话标题，补进 `session-names.json`，让流水和近况里显示的是名字不是 id。
- **起一个本地网页**：`http://127.0.0.1:8720`，看每个会话、每次对话花了多少钱。端口被占就静默跳过。

数据长什么样，见 [`示例数据/README.md`](示例数据/README.md)。

## 装

这个包还没发到 npm，先从源码装：

```bash
git clone https://github.com/Nyarlice/one-her.git
dsh plugin --profile <你的 profile> add file:<你克隆到的路径>/packages/dsh-memory-ledger
```

装完重启 DSH。第一次跑会自动把需要的目录建出来，不需要手动准备。

## 配置

只认一个环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 数据目录。所有路径都从这里派生 |

换端口要改代码：`lib/index.js` 里 `startTokenServerFromHome(8720, logger)`。

## 它不做什么

- 不提炼记忆。那是 `dsh-recall` 的事，这个只负责把原始记录存下来。
- 不删东西。`events.jsonl` 只增不减，是所有派生数据的唯一事实来源。
- 不碰你的隐私。脱敏只在生成「广场版」时做（手机号、邮箱、银行卡、路径），家里那份不动。

## 附带的命令行工具

包里的 `lib/scripts/` 除了插件自己要用的记账脚本，还有几个可以直接手跑的工具：

| 脚本 | 干什么 |
|---|---|
| `search-memory.mjs` | 按关键词查账本里的历史对话，`--as home` 查家里的、`--as square` 查广场的 |
| `memory-semantic.mjs` | 纯语义检索（要本地 ollama + `bge-m3`），`--build` 重建索引增量 |
| `gen-token-page.mjs` | 生成 `DSH_HOME/token消耗.html`，按工作区/会话/日期看每轮花了多少 |
| `build-session-names.mjs` | 从运行时补会话标题到 `session-names.json` |
| `build-subagent-map.mjs` | 建子代理到父会话的映射 |
| `build-surf-letter.mjs` | 生成冲浪用的「家书」 |

都是 `node <本包>/lib/scripts/<脚本>` 跑，家路径读环境变量 `DSH_HOME`；没设就回落到 `~/.dsh`。

## 已知边界

- `记忆/scan-state.json` 记着每个会话文件扫到第几字节，手改会重扫，不会丢数据但会白烧 CPU。
- 「近况」里的状态（进行中/已完成/已取消/已失效）是关键词加时间间隔猜出来的，不是权威。
- 语义索引依赖本地 [ollama](https://ollama.com) 的 `bge-m3`。没装就没有向量检索，其他功能照常。

## 许可

MIT。改名再分发请保留原许可与来源。
