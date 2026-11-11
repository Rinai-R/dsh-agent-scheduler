# 调度 v2：router + 顶层 worker 会话（设计稿）

> 状态：**已拍板**（2026-11-11）：v2 是唯一模式，单向迁移；§2 用方案 B（worker 会话的 cwd = router 的工作区）。spike 证据在 `spike/`。
> 依据：仓库 `dsh-labs/dsh-agent-scheduler` 的 origin/main `d4579c4`；DSH 安装包 asar 里的 0.2.2-rc.1，以及本地 node_modules 里的 0.2.1-rc.5。
>
> 引用写法：
> - `asar:<包>/lib/index.js:<行>` 指 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 里 `dsh/node_modules/@deepseek-ai/<包>/…` 的行号，用 `node /tmp/dshasar/rd.mjs cat` 取出；
> - `asar:<包>/README.md:<行>` 同理；
> - `src/…:<行>` 指本仓库 origin/main。
>
> 没能亲手确认的，标 **〔未验证〕**。

---

## 0. 一句话

现在的 lead 改名叫 **router**，职责和工具基本不变。worker 不再是 router 的子智能体，而是**普通的顶层会话**：用户能在左栏点进去直接聊，审批、模型、权限都走 DSH 原生能力。

router 和 worker 之间、以及以后的飞书 / GitHub 等来源和 worker 之间，统一走一条**插件自持的持久化消息队列**，满足这几条：
- 可以有多个生产者往里写；
- 每个目标会话只有一个消费者，按目标保序；
- 至少投递一次，在目标端去重；
- 重启后能恢复。

---

## 1. 已确认的宿主事实

| # | 事实 | 出处 |
|---|---|---|
| H1 | 跨会话投递现成可用：`toLead` = `main.followup(relayMessage(...))`（下一轮），`steerLead` = `main.steer(...)`（下一步） | `src/dsh/host/agent.ts:107-119` |
| H2 | 中继消息的来源是 `{ kind: 'agent-message', form: 'relay', senderSessionId }` | `src/dsh/host/session.ts:171-172` |
| H3 | **一轮只取一条 next-turn 消息**，外加全部 next-step（steer）消息；每条都会发 `agent/inbox/claimed { message, turn }`。0.2.1-rc.5 与 0.2.2-rc.1 两个版本完全相同 | `asar:dsh-agent-loop/lib/index.js:103-110`（rc.5 的 node_modules 同一行号） |
| H4 | 收件箱写入时追加 `agent/inbox/spliced`，并逐条发 `agent/inbox/inserted`；`inbox.remove(id)` 可以撤回 | `asar:dsh-agent-loop/lib/index.js:190-202, 145` |
| H5 | dsh-schedule 的投递流程：`agent.followup(msg)` 之后 `await ctx.sessions.flush(agent.session)`，flush 得到确认才写回执（messageId、targetSessionId） | `asar:dsh-schedule/lib/index.js:1382-1400` |
| H6 | dsh-schedule 重启恢复：读最后一条回执 → 激活目标 → 在 `inbox.nextTurn/nextStep` 里按 messageId 找到那条消息；目标空闲就先 `remove` 再 `followup`，把它唤醒 | `asar:dsh-schedule/lib/index.js:1348-1375` |
| H7 | 冷会话的激活顺序：先走 waterfall `schedule/resolve-agent`，没有结果再退回 `sessionController.resolveAgent` | `asar:dsh-schedule/lib/index.js:1496-1498, 2117-2124` |
| H8 | 建会话：`sessionController.create({ sessionId?, cwd?, agentPreset? })`；dsh-schedule 建完会话后，用 `workspaceRegistry.resolveByPath(cwd)?.attachSession(id)` 挂到工作区，用 `sessionTitle.rename` 起名 | `asar:dsh-schedule/lib/index.js:1500-1530` |
| H9 | `create` 对一个已命名的 sessionId：只在它还空白、属于同一目录、没被其他写者持有时复用；属于子智能体路由的会话返回 `session/agent-busy` | `asar:dsh-api-session-controller/README.md:48`，`lib/index.js:235-238, 666-700` |
| H10 | prompt 的去重：`hasPromptRequest` 同时扫收件箱和整个会话日志，只认 `source.kind === 'user'` 且 `rpcId === requestId` 的消息 | `asar:dsh-api-session-controller/lib/index.js:833, 1011-1021` |
| H11 | 会话控制器还提供 `selectModel` / `rename` / `fork`；`fork` 产出**不带 parentSession** 的独立会话 | `asar:dsh-api-session-controller/lib/index.js:704, 734, 756`，`README.md:67` |
| H12 | sessionController 由 **dsh-web-app** 挂载，dsh-schedule 也在那里挂；dsh-base 里没有 | `asar:dsh-web-app/cordis.patch.yml:117-118, 136` |
| H13 | 存储域：`defineDomain({ name, version, compatibleVersions?, tables })`，用 `ctx.storageDomain.open(spec)` 打开。读是同步的、以内存为准；每个域一条写链，`update` 不会交错；写操作在落盘确认后才返回 | `asar:dsh-storage-domain/README.md:36-58, 73, 88-89` |
| H14 | dsh-schedule 的域声明是 `name: 'schedule', version: 2, compatibleVersions: [1]` | `asar:dsh-schedule/lib/index.js:1672-1677` |
| H15 | dsh-base 把存储域路由到 json 后端，根目录是 `dshHomePath('storages')`，也就是 `<DSH_HOME>/storages/<域名>.json` | `asar:dsh-base/cordis.patch.yml:182-190` |
| H16 | json 后端每次写都是临时文件 → fsync → rename → 目录 fsync；有 `single` / `per-record` 两种布局，由域声明选择 | `asar:dsh-storage-json/README.md:32, 74-76` |
| H17 | 存储域**只在单进程内可见**：第二个宿主进程看不到这个进程的改动 | `asar:dsh-storage-domain/README.md:146` |
| H18 | 会话写者锁：同一后端内单写者，跨进程靠 `session.lock` 上的 `flock` 互斥 | `asar:dsh-session-persistence-jsonl/README.md:168` |
| H19 | 会话头的 cwd 不可改；运行目录由 `working-directory/change` 事件决定（`workingDirectory.set(agent, path)`） | `asar:dsh-working-directory/lib/index.js:117-143` |
| H20 | `attachSession` 要求会话头里的 cwd realpath 后**等于**工作区路径，否则报错。不属于任何工作区的会话落在左栏的「未分组」 | `asar:dsh-workspace/lib/index.js:111-129`，`asar:dsh-workspace/README.md:73, 168` |
| H21 | 现在的子智能体 worker 就是这个形态：头里的 cwd 是父会话的目录，之后用 `working-directory/change` 切到自己的 worktree | 用户会话 `session-9f346421…` 的头和第 4 / 704 / 950 个事件（只读核对） |
| H22 | 会话头部有插槽 `conversation.session.header.actions`（session 作用域的列表），另有 `.utilities`（列表）、`.corner`（单个） | `asar:dsh-client-ui-conversation/lib/client.js:20895-20903, 22917-22930` |
| H23 | 回答下方的操作条插槽是 `conversation.chat.assistant-actions`（session 作用域的列表） | `asar:dsh-client-ui-chat/lib/client.js:9041, 9337`（PR #39 已在契约测试里覆盖） |
| H24 | 投影状态版本当前是 12 | `src/index.ts:58` |
| H25 | `@deepseek-ai/dsh-storage-domain`、`dsh-api-session-controller`、`dsh-schedule` 在 npm 上都有 0.2.1-rc.5 和 0.2.2-rc.1 两个版本 | `npm view` |

〔未验证〕：
- 中继消息的 `source` 能否多带一个 `queueId` 字段（会话校验器可能很严格）。备选方案见 §3.4。
- 桌面版 profile 是否同样挂载了 dsh-web-app。我们的隔离运行都用 `--profile web`。
- rc.5 的会话头部插槽是否与 rc.2 相同。
- DSH 本身会不会阻止两个宿主进程共用同一个 DSH_HOME。

---

## 2. 创建 worker

### 2.0 写入边界（spike 结论，方案 B）

| 事实 | 证据 |
|---|---|
| `workspace-write` 的可写根是会话**头里不可变的 cwd**，不是之后 `workingDirectory.set` 的运行目录 | `asar:dsh-sandbox-policy/README.md:75`；spike：头 cwd = router 工作区，运行目录 = 工作区外的 worktree → 写 worktree **被拒**，写 router 工作区根**成功**（`spike/out.jsonl` 的 `say` 行） |
| 现在的子智能体 worker 能写自己的 worktree，只是因为 worktree 恰好在 lead 的 cwd（`~/project`）之下 | 用户会话 `session-9f346421…` 头 cwd `/Users/rinai/project`，worktree `~/project/worktrees/…` |

**决定（用户，方案 B）**：worker 常常同时干好几个仓库和 worktree，不按 worktree 隔离。
- worker 会话头的 cwd = **router 的工作区**（对用户来说就是 `~/project`）；会话挂到这个工作区下。
- 写入边界 = router 的整个工作区，和现在的子智能体 worker 一样。**已知取舍：worker 之间没有隔离。**
- worker **不绑定单个 worktree**。`agent_create` 可以顺手建一个 worktree 并告诉 worker 在哪，但默认不 `workingDirectory.set` 把它钉死；worker 按任务需要在工作区里建或进别的 worktree。
- 名册里记录发给 worker 的 worktree **列表**（仅供参考），不作为它的身份。
- 请求的 worktree 路径（`cwd`）不在 router 工作区之内 → **拒绝**并说明原因（worker 写不进去）。

### 2.1 流程

| 步 | 动作 | 失败时 |
|---|---|---|
| 1 | 可选：建 worktree（沿用 `createWorktree`）；路径必须在 router 工作区之内 | 报错，什么都不留 |
| 2 | 预留 sessionId，在 router 会话记 `agent created { id, kind: 'session', worktrees: [..], preset, model }` | 记 `failed` |
| 3 | `sessionController.create({ sessionId, cwd: <router 工作区>, agentPreset })` | 记 `failed`，带原因 |
| 4 | 按需 `selectModel`；权限用 `src/dsh/host/access.ts` | 记警告，继续 |
| 5 | `rename` 为 `<名字> · <职责>` | 记警告 |
| 6 | `resolveByPath(router 工作区).attachSession(id)`（spike 证明可行） | 记警告，会话落在「未分组」 |
| 7 | 在 worker 会话写 `plugin:dsh-agent-scheduler/owner { router, name, role, worktrees }` | 重试一次，失败就靠 router 侧记录兜底 |
| 8 | 首个任务进队列（§3）；首条消息写明「你的 worktree 在 X，也可以按需进别的」 | 走队列语义 |

### 2.2 身份（谁是谁的 worker）

| 位置 | 内容 | 用途 |
|---|---|---|
| router 会话日志 | `agent created/renamed/archived`，`kind: 'session'`，`worktrees: string[]` | 名册的权威来源 |
| worker 会话日志 | `owner` 记录 + 小投影 `agentSchedulerOwner` | worker 侧冷读：头部按钮，以及 `report` 该发往哪个 router |
| 队列域 `workers` 表 | `sessionId → { router, name }` | 跨会话快速查找 |

### 2.3 左栏工作区树

worker 都挂在 router 的工作区下，和 router 会话并列，按时间排。DSH 的左栏不支持插件分组，所以按 router 分组交给指挥台（deck，P2）。不为 worktree 单独注册工作区。

## 3. 队列（核心）

### 3.1 存放位置：用 storageDomain

| 选项 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **storageDomain：`defineDomain({ name: 'agent-scheduler-queue', version: 1, tables })`** | 官方先例（H14，dsh-schedule）；原子写和单域写链现成（H13、H16）；跟随宿主选的后端（json / sqlite）；放在 `<DSH_HOME>/storages/` 下（H15） | 只在单进程内可见（H17）；没有二级索引，也没有跨表事务 | **采用** |
| 插件在 DSH_HOME 下自己管文件，加锁 + 原子写 | 不依赖宿主的服务 | 要自己写 fsync、rename 和锁（我们拿不到 flock 插件），重复造轮子 | 不用 |

布局：`messages` 表用 `per-record`（点写多），其余表用默认布局。〔未验证〕布局在 `defineDomain` 里的字段名，取自 `asar:dsh-storage-json/README.md:28-32`。

依赖：在 peer 和 dev 依赖里加 `@deepseek-ai/dsh-storage-domain`（两个版本都有，H25）。宿主没有 `ctx.storageDomain` 时，v2 不可用，回落到 v1。

### 3.2 数据模型

| 表 | 键 | 记录 |
|---|---|---|
| `messages` | `qid` = `hash(producer.kind, producer.id, dedupeKey)` | `{ qid, target, seq, producer: { kind, id, session? }, dedupeKey, content, mode: 'turn' \| 'step', state, inboxMessageId?, claimedTurn?, attempts, createdAt, deliveredAt?, claimedAt?, settledAt?, answerRef?, error?, replyTo?: { kind: 'router-mail' \| 'producer', id } }` |
| `targets` | target sessionId | `{ nextSeq, delivering?: qid, paused?: true }` |
| `workers` | worker sessionId | `{ router, name }` |
| global | — | `{ host: { instance, pid, heartbeatAt } }` |

幂等：键就是 `hash(producer, dedupeKey)`。重复的 `enqueue` 在 `update` 里看到记录已存在就原样返回（H13：`update` 不交错），**不写第二份**。

### 3.3 状态机

```
queued ─deliver(flush 确认)─▶ delivered ─claimed(turn N)─▶ claimed ─turn/end N─▶ answered
   │                           │                            ├─ aborted/error ─▶ failed
   └─cancel─▶ cancelled        └─cancel(inbox.remove 成功)─▶ cancelled
                               └─重启时既不在收件箱也不在日志─▶ queued（重投）
claimed ─重启且该轮没有 turn/end─▶ failed("interrupted by restart")，或按 recovery 策略重投
```

### 3.4 投递（单个进程内）

| 情况 | 做法 |
|---|---|
| 并发 | 每个目标一条 Promise 串行链（`Map<target, Promise>`），同一目标严格按 `seq` 顺序处理；不同目标并行。域本身的写链保证记录不交错（H13） |
| 目标在跑 | 默认 `followup`：进 next-turn，本轮结束后单独成一轮（H3），**不打断用户正在进行的这一轮**。`mode: 'step'`（steer）只用于用户在收件箱里点「现在给」 |
| 目标空闲 | `followup` 会唤醒驱动 |
| 目标冷 | 先走 waterfall `agent-scheduler/resolve-agent`，再退回 `sessionController.resolveAgent`（照搬 H7） |
| 消息身份 | 先 `createUserMessage`（或沿用 `relayMessage`），拿到 `message.id` → 写 `inboxMessageId`（状态仍是 queued，`targets.delivering = qid`）→ `followup` → `await sessions.flush`（H5）→ 改为 `delivered` |
| 在目标端去重 | 投递前检查 `inbox.nextTurn/nextStep` 里有没有 id 等于 `inboxMessageId` 的消息（H6），再看目标会话的小投影 `agentSchedulerQueue`（折叠 `user/message.id`、`source.queueId`）里是否已落盘。命中就不再投，直接改状态 |
| 来源标记 | `source: { kind: 'agent-message', form: 'relay', senderSessionId, queueId }`。〔未验证〕多出来的字段能否通过校验；不行就把 `[q-<短 id>]` 写进正文首行，并且只靠 `inboxMessageId` 去重 |
| 背压 | 每个目标在收件箱里**最多 N 条**（默认 3）是 delivered 但还没 claimed 的；超出部分留在 queued。每个生产者在每个目标上最多 M 条（默认 20）queued，再多 `enqueue` 就返回 `queue/full`；router 工具把这个原样告诉模型 |
| 过期 | 可选的 `expiresAt`，过期的 queued 消息改为 cancelled |

### 3.5 崩溃窗口

| 崩溃发生在… | 重启后看到的 | 处理 |
|---|---|---|
| 写 queued 之后、`followup` 之前 | queued，有 `inboxMessageId`，收件箱和日志里都没有 | 重新投递（同一个 `inboxMessageId` 不能复用，就换新 id；去重靠 qid） |
| `followup` 之后、flush 之前 | 同上，或者收件箱已经落盘 | 先在收件箱里找 id（H6），找到就记为 delivered；找不到就重投 |
| flush 之后、记为 delivered 之前 | queued，但收件箱或日志里已经有这条 | 去重命中 → 补记 delivered |
| delivered 之后、被取走之前 | delivered，消息还在收件箱 | 目标空闲时照搬 H6，`remove` 再 `followup` 把它唤醒 |
| claimed 之后、`turn/end` 之前 | 日志里有 claimed，这一轮没有结束 | 和现在的 `cutByRestart` 一样（`src/recovery.ts`）：默认 failed 并通知生产者；用户可以选「重投」 |
| answered 之后、回复入队之前 | answered，但 `answerRef` 没有对应的回复消息 | 回复本身也有 qid（= `hash('reply', 原 qid)`），重新入队是幂等的 |

### 3.6 两个宿主进程共用一个 DSH_HOME

- 会话有 flock 互斥（H18），但存储域不跨进程（H17）。
- 打开队列时检查 global 里的 `host` 心跳：别的实例的心跳还新（默认 30 秒内），本进程就**不打开队列**，v2 显示「另一个 DSH 正在调度」并只读。
- 心跳由持有队列的进程每 10 秒写一次。
- 〔未验证〕桌面版和 `dsh web` 能否同时用同一个 DSH_HOME；不能的话这条只是保险。

---

## 4. 回复关联

| 场景 | 规则 |
|---|---|
| 一条 queued 消息被某一轮取走 | 在目标会话监听 `agent/inbox/claimed { message, turn }`（H3），按 `message.id` 找到 qid → 记 `claimedTurn = N`。第 N 轮 `turn/end` 时，取这一轮的收尾文字（复用 `completedRounds` 的切法，`src/scheduler.ts:1844`），记为 answered，再把回复入队 |
| 一轮取了好几条 | next-turn 一轮最多一条（H3），其余都是 steer 进来的。同一轮里取走的全部 qid **共用一个回答**；同一生产者的合成一条回复（「答 r-3、r-5」） |
| 用户自己的话和队列消息在同一轮 | 规则不变：只要这一轮取走了队列消息就回复，在回复上标 `mixed: true`，router 侧会看到「这一轮也回应了用户直接说的话」 |
| 轮次被中断或出错 | `turn/end.reason` 是 aborted 或 error → 标 failed，带原因，回复为「r-3 失败：…」。**不自动重跑**：「至少一次」只保证投递，不保证执行 |
| 用户直接和 worker 聊 | 没有 claimed 记录 → 什么都不推 |
| `report` 工具 | worker 保留它。本轮取走过队列消息 → 作为那条消息的答复（和现在一样）。没有 → 显式入队，`target = owner.router`，`kind: 'report'` |
| 「推送上下文」 | `report({ summary, share: 'context' })`：只发摘要和指针 `{ session, seqFrom, seqTo }`，router 需要细节时用 `agent_recall`（已有）去取，**不复制对话** |
| 回复的投递 | 目标是 router 时，消费者不是 followup，而是**写进 router 的 mail（lead 收件箱）记录**：现有的 `toLead` 和收件箱逻辑（`src/scheduler.ts:2084, 2137`）原样复用；投递成功的确认 = mail 记录写盘 |

---

## 5. router 的工具

| 工具 | v2 语义 | 结论 |
|---|---|---|
| `agent_list` | 名册加队列摘要（每个目标的 queued、delivered、claimed 数） | 保留 |
| `agent_send` | `enqueue(target = worker)`；返回 qid、r-N、排第几 | 保留 |
| `agent_create` | 按 §2 建顶层会话 worker；`from:` 改用 `sessionController.fork`（H11）从某个 worker 分叉出新的顶层会话 | 保留（`from` 的语义换实现） |
| `agent_recall` | 不变（按会话 id 读） | 保留 |
| `agent_model` / `agent_access` | 对顶层会话调 `selectModel` 和 access 适配器 | 保留 |
| `agent_interrupt` | 对顶层会话 `interrupt`（需要用 router 的身份）〔未验证：子智能体服务之外有没有对等的 API〕 | 保留，P1 验证 |
| `agent_archive` | 归档会话，并取消它的 queued 消息 | 保留 |
| `agent_split` | 原意是解决「worker 忙时来了新任务」。顶层会话有队列和 fork，这件事不再需要 | **v2 下移除** |
| `agent_merge` | 依赖父子关系和种子；在 v2 里两个顶层会话合不成一个 | **v2 下移除**（`agent_recall` 能读历史，就够了） |
| 队友（Agent Teams） | worker 成了顶层会话后，自己就能组原生队伍（team-guard 不再需要对 worker 特殊处理） | 去掉 worker 侧的改写，**保留** lead 侧的守卫 |
| 每条消息一个分身（fork-per-message） | 分身是一次性的只读分流，用子智能体最合适 | **建议暂时保留**：v2 的 router 默认关闭，开关不变 |

---

## 6. UI

| 位置 | v2 |
|---|---|
| 右栏 Agents 页 | 缩成**名册 + 收件箱**：去掉拆分、合并和 fork 表单（v2 的 router 用不上）；点行 = 在左边打开那个会话（不再是右栏的子会话 tab） |
| 指挥台（deck，PR #47） | 按 router 分组，每组是 router 一行加它的 worker；行内显示队列徽标（queued、处理中） |
| 「返回 router」 | 挂在 `conversation.session.header.actions`（H22）。worker 投影里有 `owner` 时才渲染，点击用 `uiWorkspace.openSession(router)` 打开 router 会话 |
| 点（review dots）与未读 | 以 router 记录的 answered / failed 为准，和现在一样；用户在 worker 会话里直接看过 → 自动已读（沿用 `active-seen`，改成按左栏当前会话判断） |
| worker 会话里的「Fork 这个 worker」（PR #39） | 改为调用 `agent_create from`，也就是 `sessionController.fork` |

---

## 7. 迁移（单向）

| 项 | 方案 |
|---|---|
| 模式 | 没有开关。升级后 `agent_create` 一律建会话 worker |
| 现有子智能体 worker | 只把**已有**的未完成请求走完（旧路径）；不再给它们派新活（`agent_send` 拒绝，提示用 `/agents convert`）；从不自动归档或删除；worktree 原样保留 |
| `/agents convert <name>` | 用户显式触发：`sessionController.fork(child)` 产出顶层副本（spike 第二轮证实：子智能体会话可以被 fork，产物 `parentSession: null`，带上完整历史，见 `spike/out2.jsonl` 的 `forkchild`），失败则「归档 + 新建，并附交接摘要」；原 worker 标 `convertedTo`。注意：对子智能体会话调 `selectModel` 会返回 `session/agent-busy`，对 fork 出的顶层会话则成功 |
| 记录 | `split` / `merge` 的旧记录继续能折叠；工具移除 |
| 投影版本 | 12 → 13，加 `kind: 'session'`、`worktrees`、`convertedTo`；迁移测试用一份 v12 夹具日志 |
| 两个 DSH 版本 | 头部插槽在 rc.5 上存在（spike 已核对）；没有 sessionController → 无法建 worker，报错说明 |

## 8. 来源插件（飞书 / GitHub）的接口

由本插件提供一个 Cordis 服务 `agentSchedulerQueue`，在 `src/dsh/host/augment.ts` 声明类型：

```ts
interface QueueProducer { kind: string; id: string; session?: string }   // e.g. { kind: 'feishu', id: 'chat:oc_xxx' }
interface Enqueue {
  target: string | { router: string; worker: string }   // 会话 id，或「router 的某个 worker」
  producer: QueueProducer
  dedupeKey: string                                     // 来源侧的 message id / delivery id
  content: ContentBlock[]
  mode?: 'turn' | 'step'
  replyTo?: { kind: 'producer' } | { kind: 'router-mail' }   // 默认：producer
  expiresAt?: string
}
interface AgentSchedulerQueue {
  enqueue(e: Enqueue): Promise<{ qid: string; state: State; duplicate: boolean }>
  cancel(qid: string): Promise<boolean>
  status(qid: string): State | undefined
  /** 自己 kind 的回复：answered / failed / report。 */
  onReply(kind: string, listener: (r: { qid: string; state: State; text?: string; mixed?: boolean }) => void): Disposable
  resolveTarget(router: string, worker: string): string | undefined
}
```

约定：
- 来源插件只管用 `dedupeKey` 做幂等，并把回复送回自己的渠道；
- 不能直接写别人的会话；
- 背压错误 `queue/full` 由来源自己退避。

---

## 9. 分期

| 期 | 交付 | 动到的文件 | 规模 | 风险 |
|---|---|---|---|---|
| **P0 队列核心** | 存储域、状态机、去重、恢复、背压；只在 router 回复里用（v1 的 worker 回复改走队列做验证） | 新增 `src/queue/{domain,queue,deliver,recover}.ts`、`src/dsh/host/storage.ts`；改 `src/scheduler.ts`（`toLead` 改走队列）；契约测试 `tests/contract/queue.spec.ts` | 约 900 行，含测试 | 存储域布局字段、`source.queueId` 校验〔未验证〕 |
| **P1 会话 worker（最小可用）** | `/schedule mode session`；`agent_create` 建顶层会话（§2）；`agent_send` 走队列；按 claimed 和 turn/end 回复；worker 侧的 `report` 和 `owner` 投影 | `src/dsh/host/runtime.ts`（加 `sessionPort`：create、fork、resolve、rename、selectModel）、`src/scheduler.ts`、`src/tools.ts`、`src/records.ts`、`src/projection.ts`（v13）、`src/rule-plugin.ts` | 约 1200 行 | 「工作区内修改」根目录〔未验证〕；中断 API〔未验证〕；冷启动时序 |
| **P2 UI** | 「返回 router」按钮、deck 按 router 分组、精简 Agents 页、未读 | `src/client/{index,deck,deck-model}.tsx`、新增 `src/client/back-to-router.tsx`、`src/dsh/client/ui.ts`（加插槽）、i18n ×8 | 约 600 行 | 插槽在 rc.5 上是否存在 |
| **P3 收尾** | v2 router 下关掉 split、merge 和 worker 的队友改写；可选的「转成会话 worker」 | `src/tools.ts`、`src/team-guard.ts`、`src/merge.ts`（只做门控）、文档 | 约 300 行 | 老记录的兼容 |
| **P4 对外接口** | `agentSchedulerQueue` 服务、类型、示例来源插件（README） | `src/dsh/host/augment.ts`、`src/queue/service.ts`、文档 | 约 250 行 | 接口稳定性（先标 experimental） |

最小可用切片 = **P0 + P1**：用户能用 `/schedule mode session` 建会话 worker，在左栏点进去直接聊；router 派的活自动回报。

---

## 10. 已拍板

| # | 问题 | 决定 |
|---|---|---|
| 1 | worker 会话头的 cwd | **router 的工作区**（方案 B）；写入边界 = 整个工作区，不按 worker 隔离 |
| 2 | 队列存放位置 | **storageDomain**（spike 证明第三方插件可用：`layout: 'per-record'`，重启后能读回） |
| 3 | 目标在跑时 | **followup**；steer 只在用户点「现在给」时用 |
| 4 | 中断或出错的那一轮 | **不自动重投**，通知 router |
| 5 | 灰度 | **否**：v2 是唯一模式。现有子智能体 worker 只把未完成的请求走完；新建一律是会话 worker；`/agents convert` 由用户显式触发 |

## 11. 实现状态（PR feat/router-v2，P0 + P1）

| 项 | 实现 | 位置 |
|---|---|---|
| 队列状态机、去重、按目标保序、背压、恢复 | `MessageQueue`，每个目标一条串行链 | `src/queue.ts` |
| 存储 | 存储域 `agent_scheduler_queue`（`layout: 'per-record'`）。注意：域名只能是 `[a-z][a-z0-9_]*`，契约测试发现的；域在写入时不校验，所以我们在写入前自己校验 | `src/dsh/host/queue-store.ts` |
| 会话 worker 的创建、fork、改名、选模型、挂工作区 | `sessionController` 和 `workspaceRegistry`，都按可选服务注入 | `src/dsh/host/session-worker.ts` |
| 投递 | `followup`（或 `steer`）后 `flush`；重启后对空闲目标唤醒；在目标端按 `queueId` 和 inbox id 去重 | 同上，`queueHost` |
| 回复与 report | 回复写进 router 收件箱（`[reply to r-N from name]`）；本轮没取队列消息但调了 report 的，作为 `[report from name, not a request]` 送达；router 不在线时不标为已送达，下次 recover 再送 | `src/session-workers.ts` |
| 迁移 | 旧（子智能体）worker 只把手上的活做完，`agent_send` 拒绝新活并提示 `/agents convert`；convert 用 `sessionController.fork`，失败时退回交接摘要 | `src/scheduler.ts` `convert` |
| 工具 | 去掉 `agent_split` / `agent_merge`；`agent_create` 一律建会话 worker；`agent_list` 多了 `workerKind`、`worktrees`、`queue` | `src/tools.ts` |
| 来源插件接口 | `Symbol.for('dsh-agent-scheduler/queue')` 上的 `enqueue` / `cancel` / `status` / `onReply`（experimental） | `src/dsh/host/queue-service.ts` |

GUI 实测中额外发现并修复的问题：
- 规则行没有注入 `sessions`，直接读会抛错 → 改为读可选服务。
- 会话 worker 在线而 router 不在线时，会给 router 缓存一份空名册 → 现在只缓存在线 router 的名册。

已知取舍：写入边界是 router 的整个工作区（方案 B，`asar:dsh-sandbox-policy/README.md:75`），worker 之间没有隔离。
