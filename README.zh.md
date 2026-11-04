# dsh-agent-scheduler（调度模式）

DeepSeek Harness 插件：一个会话一个 lead，每条输入 fork 一个分身，worker 是长期 agent，右侧栏
一份名单。调度是规则，不是模型的自觉：你的消息一进收件箱就被移出交给分身，所以 lead 永远不会被
一条输入卡住。

## 做什么

- **输入规则。** 调度模式会话里，每条用户消息立刻交给一个新分身；lead 不处理原话，稍后收到
  「The user said: … / Its conclusion: …」，历史里留下的是一张需求地图。
- **分身（fork）。** 原生 fork，继承 lead 已完成的轮次，只处理一条输入：分析、用 `agent_create` / `agent_send` 派活，然后马上交结论，不等 worker。
- **worker。** `agent_create` 建长期 agent：自己的会话、role、目录、模型。
- **一条管道，终点是 lead。** 分身的结论、worker 的回答、请求失败，都直接汇报给 lead，并注明是谁、为哪条输入派的活。不会为了转交结果再唤醒任何 agent，省一次模型调用和时间。
- **请求。** 每次派活是一条请求；承接方每完成一轮，就回答这一轮领取到的那些请求，内容取它 `report` 的摘要，没有就取收尾文字，全部从它自己的会话日志读，不靠自述。它一变空闲就结算并写下水位，重启不丢，也不依赖原生的结束通知何时（是否）到达 lead。
- **归档。** 归档一个还欠着回答的 agent，会把这些请求判为失败并告诉请求方，不会有人一直等。
- **右侧栏。** Agents 页列分身和 worker 的实时状态，点行在右侧栏嵌入它的对话（可分成两栏），
  输入框上方有一个 chip 显示在跑、在等你的数量。
- **队列。** 宿主的驻留名额满了，启动（或投递）就按顺序排队，有空位再试；输入卡显示「排队中」，不直接失败。其他失败直接告诉派活的 agent，不重试。

## 怎么启用

新建会话，在预设菜单里选 **调度模式**。普通聊天会话不受影响：插件的监听和工具只在这个 preset 里。

## 工具

| 工具 | 作用 |
|---|---|
| `agent_create` | 建 worker：`name`、`role`，可选 `cwd`、`preset`、`model`、`from`（接着另一个 worker 的对话）、`task`。 |
| `agent_send` | 给分身或 worker 派活；回答以 `[reply to r-N from …]` 回来。 |
| `agent_list` | 名单与在途请求。 |
| `agent_interrupt` | 停当前这一轮。 |
| `agent_archive` | 归档；名字不复用。 |
| `role_set` | 改 lead 或某个 worker 的 role。 |
| `report` | 显式交结论，替代最后一条消息。 |

## 命令

| 命令 | 作用 |
|---|---|
| `/fork model <provider>/<model> [effort]` | 之后的分身用这个模型（默认同 lead）。 |
| `/fork model default` | 回到默认。 |
| `/role [text]` | 查看或设置 lead 的 role。 |

## 配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `fork` | 分身的 `{ provider, model, reasoningEffort? }` | 同 lead |
| `worker` | worker 的 `{ provider, model, reasoningEffort? }` | 运行时默认 |
| `workerPreset` | 新 worker 的 preset | 本会话的 preset |

## 已知限制

- 会话的 preset 第一轮后固定，不能中途打开调度。
- 分身只继承 fork 那一刻 lead 已完成的轮次。
- lead 看不到你的原话，只在结论里看到引用。
- 分身和 worker 不能直接问你问题：宿主会拒绝「被另一个 live agent 拥有的 agent」的人类交互；它需要的决定会写进结论，经 lead 提出来。
- 本包的记录写在主会话日志里；子会话都是原生的。
- 运行时的分栏最多两栏水平 pane。

## 许可

MIT
