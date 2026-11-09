# Agent Scheduler 使用指南

[English](guide.md) · [简体中文](guide.zh.md) · [README](../README.zh.md)

## 概览

- **每条消息一个分身。** 调度打开时，消息一插入就离开 lead 的收件箱，lead 永远不会被一条输入
  卡住。分身继承 lead 已完成的轮次，只处理这一条，交完结论就归档；会话保留，可以从消息下的
  状态卡打开。
- **worker 是长期的。** `agent_create` 建一个长期 worker：自己的会话、role，可选目录、preset、
  模型和 `from`（接着另一个 worker 的对话）。首个 task 会成为它的第一条请求。两个活跃 worker 不能
  声明同一个 `cwd`。
- **请求有编号，也有回执。** 每次派活都是一条 `r-N` 请求。承接方每完成一轮，就回答这一轮领取到的
  请求，内容取它 `report` 的摘要，没有就取收尾文字，全部从它自己的会话日志读。答复以
  `[reply to r-N from name, asked by …]` 回到 lead。
- **一条管道，终点是 lead。** 分身的结论、worker 的答复、`report` 和失败的请求都直接到 lead，并
  注明是谁、为哪条输入派的活。不会为了转交结果再唤醒任何 agent。
- **先粗后细，撞上才拆。** 新领域先建一个管整个仓库或模块的 worker。跟进请求交给已经拿着它的
  worker，新任务在 owner 空闲时也直接交给它；owner 在跑或还有未回答的请求时，新任务就用
  `agent_split` 拆分：owner 改名为它手上那部分工作，再从它续出一个新 worker 去做新任务，用自己的
  worktree，两者共享同一个 area，并行而不是排队。分身不等 worker。
- **右侧栏一份名单。** Agents 页列出分身和 worker 的实时状态与在途请求，点一行就在名单旁边嵌入它的
  对话。页面和对话都保持挂载，切换标签不会让对话重新加载。
- **哪些该看一眼。** 上报之后、你还没点开的成员，行首是醒目的实心点：绿＝有新结论，红＝失败；
  有权限审批或提问等你时是黄点，处理前一直黄。点开即已读，已读记在会话里，重启不复活。正在屏幕上的那条会话不显示任何点：到达的内容就在眼前，本浏览器记为已读，切走也不会再亮。这条已读只存在浏览器里、不写进会话，所以不会在 lead 的对话里留下命令行；换个浏览器仍会看到点。
- **模型各归其位。** 分身始终用 lead 的模型，因此复用 lead 的提示缓存。worker 依次取：
  `agent_create` 的 `model` → `/worker model` 默认（Agents 页也能设）→ 插件配置 → 运行时默认；
  每个 worker 还能在它的对话里单独换。
- **重启不丢。** 被 dsh 重启打断的请求，按恢复策略要么判失败并汇报，要么在 worker 自己的会话里续跑。


**智能体团队（Agent Teams）。** 开了 DSH 的实验组合包「智能体团队」后，每个 worker 都是自己团队的 Team Lead：可以用 `spawn_teammate`、`send_message`、团队任务板和 `wait_agent`；它的 teammate 是它自己的子会话（共用它的工作目录），答复回到它。lead 交给这个 worker 的请求，要等它的 teammate 都停下、它汇总后才算答复。调度关时 lead 也可以自己组队；调度开时 lead 和分身不能组队（`spawn_teammate` 会被拒绝，已有的团队仍可发消息、改任务、中断）；worker 的 teammate 不能再组队。Agents 页在 worker 行下显示它的团队（▸ 团队），lead 的团队单独一个分区。Agent Teams 是实验包：插件只经一个适配层（`src/dsh/host/agent-team.ts`）接入，形状对不上就关掉这项能力并提示一次。

## 开始使用

界面和命令回复跟随 DeepSeek Harness 的语言设置（DSH 支持的全部语言：中文、English、日本語、Español、Français、Deutsch、Русский、Português，见 [docs/i18n.md](i18n.md)），切换后无需刷新；给模型看的提示词和工具描述保持英文。

### 前置要求

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`，即 `engines.dsh` 要求的范围。
- 一个可安装插件的 dsh profile；桌面应用的默认 profile 即可。

### 安装插件

在 dsh 里打开 **插件 → 安装第三方插件**，输入 `dsh-agent-scheduler`。也可以在终端里装：

```bash
dsh plugin add dsh-agent-scheduler                   # npm 上的最新正式版
dsh plugin add dsh-agent-scheduler@next              # 最新预发布版
dsh plugin add ./dsh-agent-scheduler-0.1.0-rc.7.tgz  # Release 附带的 tgz
dsh plugin --profile web add dsh-agent-scheduler     # 装进指定 profile
```

重装 tgz 时换一个文件名：包管理器不会替换同名 tgz 的内容。装完或更新后重启 dsh（桌面应用则完全退出
再打开）。重启后每个会话都会出现「调度」chip，不论它用哪个预设。

### 打开调度

新会话关闭调度，和普通聊天一样。在输入框底栏的模式行里（access mode 和 Plan 旁边）点
「调度」；直接输入 `/schedule` 也会打开。chip 变蓝，旁边的 Agents 按钮显示最紧急的计数——`N 等你`、
`N 在跑`、`N 排队`、`N 失败`——没有的话显示 agent 数量。

再点一次 chip（悬停时分叉图标变成 ×）或执行 `/schedule off`。之后的消息回到 lead；已经开着的分身和
worker 继续跑，结果照常汇报。切换会改变 lead 的系统提示，所以 lead 的下一次请求不命中一次提示缓存。

开关只管一件事：用户消息是否自动交给一个新分身。关着时，用户直接和 lead 对话，lead 自己回答，但
worker 相关的工具照常可用——`agent_list`、`agent_create`、`agent_split`、`agent_send`、`agent_interrupt`、
`agent_archive`、`role_set`、`report`——派活锁和 `rosterVersion` 校验照样生效，worker 的回答、上报和
失败照样交给 lead。关着时中间没有分身，所以 lead 调 `agent_create`、`agent_split` 时 `for` 可以不填（填了 `fork-N`
或 `r-N` 仍会校验，每个仍只建一个 worker）；开着时 lead 照旧必须填。开调度时建的分身，关掉之后仍只能
路由。调度工具注册在每个会话里（工具列表不变才能命中缓存）；关着且还没有分身或 worker 的会话，
系统提示里没有调度段，建出第一个 worker 后多出一段只给 lead 的简短说明。

### Agents 页

从 Agents 按钮打开；主会话消息下的状态卡则直接打开那个分身（「查看」）。名单分「分身」「Worker」
「已交回」「已归档」。每行显示实时状态——在跑、在等你、空闲、已交回、排队中、失败、已归档——还欠着
的请求（`N 个请求待回答`），以及第二行：失败原因；否则最早一个未答请求；否则分身被问的话或 worker 的
职责（拆分后前面带 area）；worker 的目录在悬停提示里。已归档的行只占紧凑的一行，超过八个后其余收进
「再显示 N 个」。名单超出底部时，底部固定一条「下面还有 N 个 · M 个等你 · K 个未读」，点它滚到第一个
看不见的行。

点一行就在另一栏打开这个 agent 自己的原生对话，名单保留自己的一窄栏。右侧栏最多两个水平 pane，所以
页面按你手动会做的手势自己分栏：名单在左，agent 对话作为标签在右。Agents 页和 agent 对话都设了
`keepMounted`：切换标签或关掉旁边的对话，不会重新挂载、把对话从头加载一遍。

顶部的 **+** 打开一个小表单（名字、职责、可选目录），执行 `/agents new`；worker 行上的铅笔就地改名
（`/agents rename`，回车保存、Esc 取消）。改过名的 worker 旧名字保留，用旧名字仍能找到它。

悬停行时出现归档按钮；归档后的名字不再复用。「全部归档」（或 `/agents archive done`）归档所有已交回、
没有欠回答的分身。顶部的「Worker 默认模型」菜单改的就是 `/worker model`。

**待查看。** 成员上报（回答或失败、分身交回、启动失败）后，行首圆点变成带外圈的实心点，直到你点开它
（或在主会话点它的状态胶囊）：绿＝成功，红＝失败；黄＝它有权限审批或提问等你处理，不论读没读，处理前
一直黄。点开会发 `/agents seen`，记一条 `seen` 记录，重启后已读的不会再亮；顶部「全部已读」（`/agents seen all`）一次读完。没读的成员即使已归档也留在
「分身」「Worker」里，折叠组只收已读的；分组标题和输入框的 Agents 按钮带未读数。

**合并 worker。** `agent_split` 的反操作：`agent_merge`、`/agents merge`，或 worker 行上的「合并到…」。被合并方先写交接（已完成、进行中、决策、未决问题、改过的文件、分支/PR、未提交改动），代码必须先提交或在交接里交给保留方（调度器会在它的目录里查 `git status`）；然后它被归档，名字归保留方（之后按这些名字派的活都落到保留方），保留方可以改名（同一 area 内可改回 split 前的名字），并收到交接消息。写不了交接的被合并方，从它的日志生成。被合并方在跑或有未答请求时拒绝；重启后从最后记录的一步续上。详见 [docs/worker-merge.md](worker-merge.md)。

**lead 收件箱。** lead 忙的时候到的答复、报告、分身结论和失败通知，放在 Agents 页顶部的「待 lead 处理」一栏，不再挤进输入框上方的排队消息（那里只留你自己排的）。lead 空闲时一次合并交给它，排在你给它排的消息之后。可以拖动排序（或 Alt+↑/↓）、📌 置顶、⏸ 暂缓（取消前一直跳过）、⚡ 立即交给 lead（插进它当前回合），或「全部交给 lead」；点条目打开发件人的对话。有回报在等的成员行尾有 ✉，输入框旁的 Agents 按钮显示 ✉N。收件箱是插件记录，重启后还在；lead 的 `agent_list` 里有每条的摘要（发件人、请求号、时间、正文前 120 字）。

### 模型

**分身始终用 lead 的模型。** 分身重放 lead 的历史，用同一个模型，也就共享它的提示缓存。分身没有单独的模型：
`/fork` 会说明，`/agent-model` 对分身报错。要让一个任务用别的模型，交给 worker。

**worker 的默认模型**按顺序取：`agent_create` 给的 `model` → `/worker model` 默认（Agents 页也能
设）→ 插件配置 `worker` → 运行时默认。`/worker model <provider>/<model> [effort]` 设置，
`/worker model default` 清除。

**单个 worker 自己的模型**用 `/agent-model <name> <provider>/<model> [effort]`，或在它对话底栏的
模型菜单里选。下一次模型调用生效；重启或恢复后 worker 重新创建时，会从主会话日志读回；
`/agent-model <name> default` 回到它创建时的模型。

### 命令

以下命令都在主会话里运行。

| 命令 | 作用 |
|---|---|
| `/schedule [on \| off]` | 打开（不写参数就是打开）或关闭本会话的调度。 |
| `/agents new <name> [--cwd <dir>] [--model <provider>/<model>[:effort]] <role>` | 自己建一个起好名字的 worker，不带任务；在它的对话里直接聊，或由 lead 派活。Agents 页右上角的 **+** 等同。 |
| `/agents rename <name> <new-name>` | 给 worker 改名（分身、已归档的不能改）。旧名字保留、不再给别人用，用旧名字仍能找到它。worker 行上的铅笔按钮等同。 |
| `/agents archive <name>` | 归档一个分身或 worker；它还欠着的请求判失败并告诉 lead。 |
| `/agents archive done` | 归档所有已交回、没有欠回答的分身。 |
| `/agents seen <name>` | 把成员最近一次上报标为已读（在 Agents 页点开成员时自动发送）。 |
| `/agents inbox pin\|unpin\|hold\|release\|now <m-N>`、`/agents inbox now all`、`/agents inbox move <m-N> [<m-N>\|end]` | 调整 lead 的收件箱（Agents 页会发这些）。 |
| `/agents merge <被合并的> into <保留的> [--name <新名字>] [--role <职责>]` | 把一个 worker 合并到另一个（split 的反操作；`/agents merge <a> <b>` 自动挑保留方）。Agents 页的「合并到…」做同样的事。 |
| `/agents seen all` | 把所有未读上报标为已读（Agents 页顶部的「全部已读」）。有圆点之前的旧会话，过去的上报会先显示为未读一次。 |
| `/worker` | 查看之后新建 worker 的默认模型。 |
| `/worker model <provider>/<model> [effort]` | 设置之后新建 worker 的默认模型。 |
| `/worker model default` | 回到运行时默认。 |
| `/agent-model <name> <provider>/<model> [effort]` | 单个 worker 自己的模型，从下一次模型调用生效。 |
| `/agent-model <name> default` | 回到这个 worker 创建时的模型。 |
| `/role [text]` | 查看或设置 lead 的 role。下一次 step 生效，并对之后的分身生效。 |
| `/fork` | 说明分身始终用 lead 的模型；已经不能单独给分身设模型。 |

## 工具

| 工具 | 作用 |
|---|---|
| `agent_create` | 建 worker：`name`、`role`、`rosterVersion`（取自 `agent_list`），可选 `cwd`、`preset`、`model`、`from`（接着另一个 worker 的对话）、`task`；lead 还要传 `for`（它依据的 `fork-N` 或 `r-N`）；给了 `repo` + `branch`（+ `base`，默认 `origin/main`）会先把 `cwd` 建成新的 git worktree。 |
| `agent_split` | 拆分忙着的 worker 的领域：`owner`，`ownerName` + `ownerRole`（它保留的那部分工作），新 worker 的 `name` + `role` + `task`，`cwd`（或 `repo` + `branch`），`rosterVersion`，lead 还要传 `for`。owner 的改名和 `/agents rename` 是同一套（旧名字保留）；新 worker 接着 owner 的对话，owner 还没完成过一轮时则全新启动。两者带同一个 `area`，Agents 页把它们排在一起。 |
| `agent_send` | 给分身或 worker 派活，带 `rosterVersion`；回答以 `[reply to r-N from …]` 回来。只用于目标已经在做的工作的跟进，不用于新的并行任务。 |
| `agent_list` | 当前 worker（含 `createdFor`）与在途请求，带 `open` 计数和 `rosterVersion`；加 `forks: true` 才连一次性分身一起列出。 |
| `agent_interrupt` | 停当前这一轮；它待处理的收件箱保留。 |
| `agent_archive` | 归档一个 agent；会话保留，名字不再复用。 |
| `role_set` | 改 lead 或某个 worker 的 role，只在用户要求时用。 |
| `report` | 显式交这一轮的结论，替代最后一条消息。 |

### 派活锁

同一主会话里的 `agent_create` / `agent_send`（lead、分身、worker 都一样）按到达顺序逐个执行：读名单 → 校验 → 创建/投递 → 写记录都在锁内完成，异常也会释放。两者都必须带 `agent_list`（或上一次派活返回）的 `rosterVersion`；worker 增加或变状态、请求发出或结清时它就变，拿旧版本派活会被拒，并附上最新名单（worker、状态、积压、最近新建的成员及谁为哪条输入建的）。每条输入最多建一个 worker：分身只能为自己那条消息建一个；lead 建时用 `for` 指明依据的 `fork-N` 或 `r-N`，所以分身已建过的 worker 不会因其结论再被建一次。

## 工作方式

**输入规则。** 调度打开的主会话里，用户消息插入时会先为输入框记一次账——聊天里保留你的气泡，图片
也在——然后从 lead 的模型输入里遮蔽，并从收件箱移除。lead 的模型输入里没有你的原话；不在 step 内时
只留一行提示。lead 的分身继承它那一刻已完成的轮次（不含进行中的这一轮），把消息派出去，然后交结论；
结论以 `The user said: … / Its conclusion: …` 到 lead。分身交完就归档；在它的对话里说话会唤醒它，
它会再汇报一次。会话还没有标题时，用第一条输入命名。

**请求与结算。** 每次派活是一条带编号的请求（`r-N`）。承接方完成的每一轮，回答这一轮领取到的所有
未完成请求：取 `report` 给的摘要，没有就取收尾文字，从它自己的日志读。它一变空闲就结算并写下水位，
所以重启不丢，也不依赖原生的结束通知何时到达。归档一个还欠着回答的 agent，会把这些请求判为失败并
告诉 lead，不会有人一直等。宿主的驻留名额满了，启动或投递就按 FIFO 排队，有空位再试；分身的输入卡
（worker 则是名单行）显示「排队中」而不是失败。其他失败直接汇报，不重试。

**一条管道。** 每个分身和 worker 都是主会话的直接子会话，由主会话代所有人发送。分身的结论、worker
的答复、失败都止于 lead；分身派完活就交结论，不等 worker；不会为了转交结果再唤醒任何 agent。

**状态。** 插件写进主会话日志的记录是唯一持久状态。宿主侧的 ledger 和客户端的 `agentScheduler`
projection 是同一份 fold，所以侧栏画出来的和调度实际依据的不会漂移。子会话都是原生的；重启恢复读
它们的日志，而不是听 agent 自述。

**插件行与开关。** `cordis.patch.yml` 在 profile 顶层插入两行：宿主行和调度规则行。顶层的行对所有
预设的 agent 都生效，所以插件不改任何预设，dsh 升级也不受影响。关闭调度后，之后的消息回到 lead，
lead 仍能建 worker、派活；已有的分身和 worker 继续跑，结果照常汇报给 lead。

**DSH 适配层。** 所有依赖 DeepSeek Harness 本身的地方（服务、事件与消息格式、运行时文案、侧栏 DOM
和布局）都在 `src/dsh/`，插件其余部分只调这一层。dsh 缺少调度所需的服务（尤其是工具守卫）时，规则
不做任何调度，每条命令都会说明缺了什么。详见 [docs/dsh-adapter.md](dsh-adapter.md)。

## 配置

### 重启恢复

在插件页找到 Agent Scheduler，打开它的配置。两项设置都在插件的宿主行上，改完即时生效。

| 字段 | 含义 | 默认 |
|---|---|---|
| `recovery.onInterrupted` | `fail`：把重启打断的工作判失败并告诉 lead。`resume`：在 worker 自己的会话里续跑。 | `fail` |
| `recovery.maxResumes` | 选 `resume` 时，一条请求最多续跑几次，超过就判失败。 | `2` |

`fail` 时，lead 收到「interrupted by a DSH restart, not completed; resend it if it still matters」，
重启后不会为这条请求调用模型。`resume` 时只唤醒 worker：在它自己的会话里补一条提示，先检查
worktree、`git status` 和 `git log`、正在写的文件、已经启动的 job，核对已经对外做过的操作，不要重复；
然后把这条请求做完，照常回答。每条请求最多续跑 `maxResumes` 次（0–10），超过就按 `fail` 处理。分身
从不续跑——它只负责派活。

重启也会丢掉还在排队的活：一直没拿到名额的启动会失败（worker 则连同它的第一条请求）。从未送达
子会话的请求也判失败。重启前已经完成的轮次仍会正常结算。恢复只在主会话回来时运行，只读日志：未完成
的请求和成员状态来自本会话的插件记录，每一轮怎么结束的来自子会话自己的日志。

### 进阶配置

正常使用不需要改配置文件：`/worker model` 和 Agents 页会把 worker 默认模型记在会话里。profile
配置里的规则行（`agent-scheduler-rule`）仍接受 `worker`（`agent_create` 和 `/worker model` 都没指定
模型时，新建 worker 的后备默认模型）和 `workerPreset`（新 worker 的 preset；留空继承本会话的）。
`fork` 已停用并被忽略：分身始终用 lead 的模型。

## 已知限制

- 调度的工具、命令和开关出现在所有预设的会话里，不只 `standard`。调度关着且没有 worker 时，系统提示里
  没有调度段，也不会分身；但八个工具（`agent_*`、`role_set`、`report`）仍在每次请求的工具列表里（约
  8.6 KB 定义，例如极简模式从 3 个工具变成 11 个），而且开关只决定谁接用户消息，那里的 lead 也能用它们。
- 用已移除的「调度（旧会话）」预设建的会话（0.1.0-rc.3 之前的插件版本）不能再打开：这个预设随
  `standard` 覆盖一起删掉了。
- 开关会改变 lead 的系统提示（多出或去掉调度段），切换后 lead 的下一次请求不命中缓存。
- 分身只路由：工具守卫只放行读类工具（`read`、`glob`、`grep`、网页与会话检索）和 `agent_*`、`role_set`、
  `report`，执行命令、改文件、提交推送、开子任务一律拒绝；拒绝信息会让它交给 worker，或在结论里说明做不了。
- 分身只继承 fork 那一刻 lead 已完成的轮次，不包含进行中的这一轮。
- lead 看不到你的原话，只在结论里看到引用。
- 分身和 worker 不能直接问你问题：宿主会拒绝「被另一个 live agent 拥有的 agent」的人类交互；它需要
  的决定会写进结论，经 lead 提出来。
- 「worker 忙就另开一个 worktree」是系统提示和工具说明里的规则，不是硬拦截：`agent_send` 仍会把请求送给
  忙着的 worker，并把它并入当前这一轮，在这一轮结束时一并回答。只有给 `agent_create` 传了 `repo` 和
  `branch` 才会新建 worktree；`cwd` 必须还不存在，已有目录或分支会原样带着 git 的报错被拒绝。
- 运行时的分栏最多两个水平 pane。

## 开发

需要 Node.js `^22.19.0 || >=24`。

- `src/index.ts`：宿主行——`fork-from` provider、名单 projection 和恢复策略。
- `src/rule-plugin.ts`：规则行——命令、系统提示段和工具注册。
- `src/dsh/`：DSH 适配层，分宿主（`host/`）和浏览器（`client/`）两半，是唯一直接碰 DeepSeek Harness 的代码。
- `src/scheduler.ts`：输入规则、队列、请求、结算和重启恢复。
- `src/client/`：浏览器部分——输入卡、输入框开关、Agents 页和模型菜单。
- `tests/`：宿主与客户端两半的 vitest；`tests/contract/` 拿真实的 DSH 版本检查每个依赖点。

```bash
npm install
npm run build          # 编译宿主部分，打包 dist/client.js
npm run typecheck
npm test
npm run contract       # 对锁定版本的 dsh 跑契约测试（会下载它的浏览器包）
npm run contract:next  # 同样的测试对 npm `next` 的 dsh 跑（临时重装，结束后还原）
npm pack --dry-run
```

CI 在 Node 24 上跑 typecheck、build、test 和 `npm pack --dry-run`，并在每个 PR 和每周对锁定版本和
`next`（仅提示）跑契约测试。dsh 发新版时：跑 `npm run contract:next`，在 `src/dsh/` 里修失败项，再
同时放宽 `engines.dsh` 和 peer 范围（`src/dsh/host/version.ts` 的 `DSH_RANGE` 必须一致）。
