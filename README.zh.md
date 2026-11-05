# dsh-agent-scheduler（调度）

DeepSeek Harness 插件：一个会话一个 lead，每条输入 fork 一个分身，worker 是长期 agent，右侧栏
一份名单。调度是规则，不是模型的自觉：你的消息一进收件箱就被移出交给分身，所以 lead 永远不会被
一条输入卡住。

## 做什么

- **输入规则。** 调度打开时，每条用户消息立刻交给一个新分身；lead 不处理原话，稍后收到
  「The user said: … / Its conclusion: …」，历史里留下的是一张需求地图。
- **分身（fork）。** 原生 fork，继承 lead 已完成的轮次，只处理一条输入：分析、用 `agent_create` / `agent_send` 派活，然后马上交结论，不等 worker。
- **worker。** `agent_create` 建长期 agent：自己的会话、role、目录、模型。
- **一条管道，终点是 lead。** 分身的结论、worker 的回答、请求失败，都直接汇报给 lead，并注明是谁、为哪条输入派的活。不会为了转交结果再唤醒任何 agent，省一次模型调用和时间。
- **请求。** 每次派活是一条请求；承接方每完成一轮，就回答这一轮领取到的那些请求，内容取它 `report` 的摘要，没有就取收尾文字，全部从它自己的会话日志读，不靠自述。它一变空闲就结算并写下水位，重启不丢，也不依赖原生的结束通知何时（是否）到达 lead。
- **归档。** 归档一个还欠着回答的 agent，会把这些请求判为失败并告诉 lead，不会有人一直等。
- **右侧栏。** Agents 页列分身和 worker 的实时状态，点行在右侧栏嵌入它的对话（可分成两栏），
  名单始终单独占左边一栏。
- **开关。** 输入框底栏「工作区内修改」右边的「调度」随时开关，也可以用 `/schedule on|off`。
  打开时是蓝色 chip，带在跑、等你的数量：点它打开 Agents 页，点前面的图标（悬停变 ×）关闭。
- **队列。** 宿主的驻留名额满了，启动（或投递）就按顺序排队，有空位再试；输入卡显示「排队中」，不直接失败。其他失败直接告诉 lead，不重试。

## 安装

需要 DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`（见 `engines.dsh`）。

```bash
dsh plugin add dsh-agent-scheduler            # npm 上的最新正式版
dsh plugin add dsh-agent-scheduler@next       # 最新预发布版
dsh plugin --profile web add dsh-agent-scheduler   # 装进指定 profile
```

每个 GitHub Release 也附带打好的 `.tgz`，可用 `dsh plugin add ./dsh-agent-scheduler-<版本>.tgz`
安装。重装 tgz 时换一个文件名：包管理器不会替换同名 tgz 的内容。装完重启 `dsh`（或桌面应用）。

## 怎么启用

插件覆盖了内置的 `standard` 预设：原有各行不变，只多一行调度规则，所以每个新会话都能调度。会话默认
关闭，和普通聊天完全一样；打开「调度」后，之后的每条消息交给分身。关闭后之后的消息回到 lead，已有的
分身和 worker 继续跑，结果照常汇报给 lead。调度工具在所有会话的工具列表里（列表不变才能命中缓存），
关闭时调用会被拒绝。

旧的 **调度（旧会话）** 预设只为让用它建的会话还能打开；这些会话默认是打开的。

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
| `/fork` | 说明分身始终和 lead 同模型（共享 lead 的提示缓存），不能单独设置。 |
| `/worker model <provider>/<model> [effort]` | 之后新建的 worker 在 lead 没指定模型时用这个模型（默认用运行时默认模型）。 |
| `/worker model default` | 回到默认。 |
| `/role [text]` | 查看或设置 lead 的 role。 |
| `/agents new <name> [--cwd <dir>] [--model <provider>/<model>[:effort]] <role>` | 自己建一个起好名字的 worker，不带任务；在它的对话里直接聊，或由 lead 派活。Agents 页右上角的 **+** 等同。 |
| `/agents rename <name> <new-name>` | 给 worker 改名（分身、已归档的不能改）。旧名字保留、不再给别人用，用旧名字仍能找到它。worker 行上的铅笔按钮等同。 |
| `/agents archive <name>` | 归档分身或 worker；对话保留，名字不复用。 |
| `/agents archive done` | 归档所有已交回、没有待回答请求的分身。 |

## 配置

| 字段 | 含义 | 默认 |
|---|---|---|
| `fork` | 已停用、被忽略：分身始终和 lead 同模型 | — |
| `worker` | worker 的 `{ provider, model, reasoningEffort? }` | 运行时默认 |
| `workerPreset` | 新 worker 的 preset | 本会话的 preset |

## 已知限制

- 覆盖 `standard` 时复制的是生成补丁那一版 dsh 的预设内容（`scripts/gen-preset.mjs`）；dsh 升级后要
  重新生成，否则预设停在旧内容。别的插件也覆盖 `standard` 时会冲突。
- 开关会改变 lead 的系统提示（多出或去掉调度段），切换后 lead 的下一次请求不命中缓存。
- 分身只继承 fork 那一刻 lead 已完成的轮次。
- lead 看不到你的原话，只在结论里看到引用。
- 分身和 worker 不能直接问你问题：宿主会拒绝「被另一个 live agent 拥有的 agent」的人类交互；它需要的决定会写进结论，经 lead 提出来。
- 本包的记录写在主会话日志里；子会话都是原生的。
- 运行时的分栏最多两栏水平 pane。

## 许可

MIT
