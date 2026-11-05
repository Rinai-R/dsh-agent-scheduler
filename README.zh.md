<p align="center">
  <img src="icon.svg" width="64" height="64" alt="Agent Scheduler logo">
</p>

<h1 align="center">Agent Scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">每条消息一个分身，每个领域一个常驻 worker。</p>

Agent Scheduler 是 DeepSeek Harness（dsh）的开源插件。它把主会话变成调度台：调度打开时，每条
用户消息一进收件箱就交给 lead 的新分身，长期 worker 各自拥有会话、目录和模型。分身负责派活，
worker 负责干活，每条请求、答复和结论都回到 lead——你只读 lead 的回复。

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
- **worker 忙，就另开一个。** 跟进请求交给已经拿着它的 worker；同一领域的新任务，如果那个 worker
  在跑或还有未回答的请求，就交给从它续出来的新 worker（`from`），并给它自己的 worktree 作为
  `cwd`，两条线并行，而不是排队。分身不等 worker。
- **右侧栏一份名单。** Agents 页列出分身和 worker 的实时状态与在途请求，点一行就在名单旁边嵌入它的
  对话。页面和对话都保持挂载，切换标签不会让对话重新加载。
- **模型各归其位。** 分身始终用 lead 的模型，因此复用 lead 的提示缓存。worker 依次取：
  `agent_create` 的 `model` → `/worker model` 默认（Agents 页也能设）→ 插件配置 → 运行时默认；
  每个 worker 还能在它的对话里单独换。
- **重启不丢。** 被 dsh 重启打断的请求，按恢复策略要么判失败并汇报，要么在 worker 自己的会话里续跑。

## 开始使用

### 前置要求

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`，即 `engines.dsh` 要求的范围。
- 一个可安装插件的 dsh profile；桌面应用的默认 profile 即可。

### 安装插件

在 dsh 里打开 **插件 → 安装第三方插件**，输入 `dsh-agent-scheduler`。也可以在终端里装：

```bash
dsh plugin add dsh-agent-scheduler                   # npm 上的最新正式版
dsh plugin add dsh-agent-scheduler@next              # 最新预发布版
dsh plugin add ./dsh-agent-scheduler-0.1.0-rc.2.tgz  # Release 附带的 tgz
dsh plugin --profile web add dsh-agent-scheduler     # 装进指定 profile
```

重装 tgz 时换一个文件名：包管理器不会替换同名 tgz 的内容。装完或更新后重启 dsh（桌面应用则完全退出
再打开）。安装前就已打开的会话仍用旧预设；重启后重新打开它或新建会话，才会出现「调度」chip。

### 打开调度

默认预设下的新会话关闭调度，和普通聊天一样。在输入框底栏的模式行里（access mode 和 Plan 旁边）点
「调度」；直接输入 `/schedule` 也会打开。chip 变蓝，旁边的 Agents 按钮显示最紧急的计数——`N 等你`、
`N 在跑`、`N 排队`、`N 失败`——没有的话显示 agent 数量。

再点一次 chip（悬停时分叉图标变成 ×）或执行 `/schedule off`。之后的消息回到 lead；已经开着的分身和
worker 继续跑，结果照常汇报。切换会改变 lead 的系统提示，所以 lead 的下一次请求不命中一次提示缓存。

调度工具注册在预设的每个会话里（工具列表不变才能命中缓存），关闭时调用会被拒绝。

### Agents 页

从 Agents 按钮打开；主会话消息下的状态卡则直接打开那个分身（「查看」）。名单分「分身」「Worker」
「已交回」「已归档」。每行显示实时状态——在跑、在等你、空闲、已交回、排队中、失败、已归档——还欠着
的请求（`N 个请求待回答`），worker 还显示目录和职责。

点一行就在另一栏打开这个 agent 自己的原生对话，名单保留自己的一窄栏。右侧栏最多两个水平 pane，所以
页面按你手动会做的手势自己分栏：名单在左，agent 对话作为标签在右。Agents 页和 agent 对话都设了
`keepMounted`：切换标签或关掉旁边的对话，不会重新挂载、把对话从头加载一遍。

悬停行时出现归档按钮；归档后的名字不再复用。「全部归档」（或 `/agents archive done`）归档所有已交回、
没有欠回答的分身。顶部的「Worker 默认模型」菜单改的就是 `/worker model`。

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
| `/agents archive <name>` | 归档一个分身或 worker；它还欠着的请求判失败并告诉 lead。 |
| `/agents archive done` | 归档所有已交回、没有欠回答的分身。 |
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

**预设与开关。** 插件覆盖内置的 `standard` 预设：原有各行不变，只多一行调度规则，所以每个新会话
都能调度。旧的「调度（旧会话）」预设只为让用它建的会话还能打开；这些会话默认是打开的。关闭调度后，
之后的消息回到 lead；已有的分身和 worker 继续跑，结果照常汇报给 lead。

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
配置里预设的规则行仍接受 `worker`（`agent_create` 和 `/worker model` 都没指定模型时，新建 worker
的后备默认模型）和 `workerPreset`（新 worker 的 preset；留空继承本会话的）。`fork` 已停用并被忽略：
分身始终用 lead 的模型。`defaultOn` 只属于已停用的 `scheduler` 预设。

## 已知限制

- 覆盖 `standard` 时复制的是生成 `cordis.patch.yml` 那一版 dsh（当前 `0.2.1-rc.5`）的预设行。dsh
  升级后用 `npm run gen:preset -- <dump.yml>` 重新生成，否则预设停在旧内容。别的插件也覆盖
  `standard` 时会冲突。
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
- `src/rule-plugin.ts`：预设行——命令、系统提示段和工具注册。
- `src/scheduler.ts`：输入规则、队列、请求、结算和重启恢复。
- `src/client/`：浏览器部分——输入卡、输入框开关、Agents 页和模型菜单。
- `tests/`：宿主与客户端两半的 vitest。

```bash
npm install
npm run build          # 编译宿主部分，打包 dist/client.js
npm run typecheck
npm test
npm pack --dry-run
```

`npm run gen:preset -- <dump.yml>` 从 `dsh --profile web --dump-default-config` 的输出重新生成
`cordis.patch.yml`；`standard` 的行来自产出这份 dump 的 dsh 版本。CI 在 Node 24 上跑 typecheck、
build、test 和 `npm pack --dry-run`。

## 许可

MIT。
