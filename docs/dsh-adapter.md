# DSH 适配层（adapter）设计

> 状态：**已实现**（第 7 节记实现情况和与设计的差异）。第 1 节的 `文件:行号` 是设计时的基线
> `main` @ 03ba296（含 feat/user-workers），实现后这些位置已搬进 `src/dsh/`。
> 宿主版本：已核对本机 DeepSeek Harness 0.2.1-rc.5（app.asar），并逐项探测 npm `@next` = 0.2.2-rc.1。

## 0. 为什么要做

插件对 DSH 的依赖现在散在 `scheduler.ts`、`rule-plugin.ts`、`rounds.ts`、`recovery.ts`、`forks-from.ts`、`member-model.ts`、`client/index.tsx`、`client/layout.ts`、`client/recovery-config.tsx`、`cordis.patch.yml`、`scripts/*` 各处。DSH 发新版时，我们没法回答「哪些地方可能坏」，只能整套手测。已经出过一次事：服务端把 `remote.commands.execute` 的返回从 `{ kind, text }` 改成了 `{ commandId, result: { kind, text } }`，结果 Agents 页把所有失败都当成功（修复见 fc1a627，`client/index.tsx:868-880`）。

目标：
1. 所有 DSH 耦合收进 `src/dsh/`，业务代码只调适配接口；
2. 每个依赖点都有契约测试，新 DSH 出来跑一遍就知道哪里坏；
3. 坏的时候按约定降级：可选能力安全 no-op 并 warn 一次；关键能力（例如分身的工具守卫）**失败即关闭**，不静默放过。

## 1. 依赖点清单

稳定性分级：

| 级别 | 含义 |
|---|---|
| **A 公开** | 有类型声明并从包入口导出，且 README 有文档。升级时一般以类型错误或明确的抛错暴露。 |
| **B 导出未文档化 / 行为约定** | 类型或运行时可以访问，但 README 没写，或者我们依赖的是某种具体行为（返回值形状、错误码、调用顺序）。 |
| **C 纯内部** | DOM 属性、CSS 类、宿主文案、就地修改宿主对象、内部布局结构、打包格式。升级时**静默**坏掉。 |

### 1.1 宿主服务 / 插件 API（host 侧）

| # | 依赖点 | 位置 | 级 | DSH 升级时坏掉的表现 |
|---|---|---|---|---|
| H1 | `ctx.subagents.startActivation({ provider: 'fork' \| 'spawn' \| 'fork-from', childId, delivery: 'parent', request: { parent, prompt, cwd, agentPreset, agentOptions } })`，依赖返回 `{ messageId }` | scheduler.ts:540, 753-758 | A | 签名变：编译失败；`messageId` 不再返回：请求永远匹配不到回合，lead 收不到回答 |
| H2 | `ctx.subagents.sendMessage(main, id, content, { signal })` 返回 messageId | scheduler.ts:840, 1091 | A | 同上 |
| H3 | `ctx.subagents.interrupt(id, { kind: 'ancestor', agent })` | scheduler.ts:873 | A | authority 形状变：中断被拒 |
| H4 | `ctx.subagents.drainChildren(main, ids)`；并假设对未知会话抛 "session … not found" | scheduler.ts:898, 1222；注释 893 | A / C | 归档或退役分身失败 |
| H5 | `ctx.subagents.registerProvider` + `SubagentProvider` 形状（`capabilities`、`inheritsParentContext`、`prepareContinuable → { seed }`）；seed 必须从 seq 0 连续、止于 `turn/end` | forks-from.ts:85-107 | A / B | `from:` 续写 worker 失败或拿到错位的上下文 |
| H6 | 容量错误：`code === 'ACTIVATION_LIMIT_REACHED'`，兜底匹配文案 `/subagent limit reached/` | scheduler.ts:159-163 | B / C | 容量拒绝被当成真失败：worker 直接 failed，不再排队重试 |
| H7b | lead 收件箱的交付：`followup()` 进 `next-turn`（lead 空闲时）、`steer()` 进 `next-step`（用户点「立即交给 lead」时），两者都是 `agent-message` relay，不是用户输入 | host/agent.ts `toLead` / `steerLead`；契约 host-api.spec.ts「the lead inbox hand-over」 | A | 交付落到别处：回报又出现在输入框上方的排队列表，或被当成用户消息交给分身 |
| H23 | Agent Teams（实验包，可选）：包一层私有的 `ctx.agentTeams.roster.tryMembership`，让我们的 worker 当自己团队的 Lead；只读 `listMembers` / `listTasks`；从 `session/event` 观察 `team/*` 记录；9 个 Team 工具名（守卫用） | host/agent-team.ts；契约 agent-team.spec.ts（AT1–AT4） | C（私有字段）/ B | 包不上：warn 一次，worker 不再能组队，调度不受影响；工具改名：守卫拦不住新名字 |
| H7 | `Agent` 字段：`session.header.parentSession`、`status`、`inbox.nextTurn/nextStep/remove/replace`、`followup()`、`ctx` | scheduler.ts:98-100, 519-534, 1251, 1288 | A | 编译失败；或主会话判断错（所有逻辑都以 `parentSession === undefined` 判 lead） |
| H8 | 事件 `agent/inbox/inserted`、`agent/pre-step`（waterfall + `PreStepDecision` enter/reject）、`agent/status`、`agent/created`（`source: 'resume'`）、`agent/disposed` | rule-plugin.ts:257-273；member-model.ts:179；scheduler.ts:1265-1293 | A / B | 首步只有上下文快照时会触发一次模型调用（这是 B 级行为假设，scheduler.ts:1255-1263）；`source` 取值变：重启恢复不触发 |
| H9 | `ctx.tools.register` + `defineTool({ parameters, output: { schema, render } })` | tools.ts:51-157；rule-plugin.ts:274 | A | 编译失败 |
| H10 | `ctx.tools.guard(exec => reason)`：守卫在全部 pre-execute 之后、工具体之前执行，`run_code` 的嵌套调用也过守卫 | rule-plugin.ts:276；fork-guard.ts:49-55 | A | **安全相关**：守卫失效时分身能跑 shell、改文件 |
| H10b | `FORK_TOOLS` 白名单里写死了其他插件的工具名（read、glob、grep、web_search、session_*、run_code…）；拒绝文案假设运行时会加 `Error: ` 前缀 | fork-guard.ts:20-31, 37 | C | 宿主改工具名：分身连读文件都被拒（偏安全，但不能路由） |
| H11 | `ctx.systemPrompt.section({ name, order, text })` | rule-plugin.ts:277 | A | 编译失败 |
| H12 | `ctx.commands.register`；`input.hint` 不能是空串（否则整个预设加载失败） | rule-plugin.ts:289-318, 307；member-model.ts:180 | A / B | 预设加载失败，所有会话不可用 |
| H13 | `ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })` + `using` + `inheritedEventCount` | rule-plugin.ts:235 | A | 读不到冷会话日志：重启恢复、结算失败 |
| H14 | `ctx.inject(['sessionTitle'])`，`get/rename`（可选） | rule-plugin.ts:247-255 | A | 会话不再自动取标题（已有降级） |
| H15 | `ctx.llm.resolveCallConfig` + `ReasoningEffortId` | rule-plugin.ts:286；member-model.ts:186 | A | `/worker model`、`/agent-model` 校验失败 |
| H16 | `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply, wire })`；假设注册表**只调用** `schema.parse`（我们用假 ZodType） | index.ts:44-54；projection.ts:305-330 | A / B | 注册表开始调用 `safeParse` 等其他方法：投影加载抛错，Agents 页一片空白 |
| H17 | `installModelSelection(agent.ctx, ref)` + `ModelSelectionRef { current, assembled }`；假设运行时自己的选择器拒绝子会话 | member-model.ts:14, 94-104 | B | 成员换模型不生效，或和宿主选择器打架 |
| H18 | `Session` 写入：`append(type, data, { surfaceOp: { op: 'replace', … }, sourceEventSeqs })`、`surface.nodes`、`eventAt`、`snapshotEvents`；格式规则「surface 第 0 个节点是 system/message」「developer message 只能出现在 step 内」 | scheduler.ts:121-151, 499 | A / B | 交接时写日志被拒：用户消息丢失，或 lead 看到被交接走的原文 |
| H19 | `appendPluginRecord` / `pluginRecordOf` + `PluginRecordMap` 模块扩充 | records.ts:5, 124-137；member-model.ts:17, 58 | A | 编译失败 |
| H20 | `finalAssistantOutput(events)`（取回合结尾文本） | rounds.ts:11, 64 | A | 回答变空，lead 收到 "(no closing message)" |
| H21 | 改写 `subagent-settled` 消息的 `source.summary`，用 `boundContextSummary` | scheduler.ts:1123-1138 | B | 宿主改了 settled 行的渲染：lead 那边的行标题错乱 |
| H22 | inject 清单：`['subagents','sessionProjections']`、`['subagents','agents','commands','tools','systemPrompt','sessionQuery','llm']` | index.ts:15；rule-plugin.ts:24 | A | 服务改名：插件根本不 apply |

### 1.2 数据格式

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| D1 | 会话日志事件：`turn/start`、`turn/end { reason.kind, reason.reason.kind }`、`user/message { id, content, source }`、`tool/call { name, arguments }`、`agent/inbox/spliced { target, start, removedCount, inserted }`、`step/start`、`step/end`、`system/message`、`developer/message` | rounds.ts:40-98；forks-from.ts:34-56；recovery.ts:98-111；scheduler.ts:144-151 | A（类型）/ B（语义） | 回合识别错：请求被重复回答或永远不答 |
| D1b | 中止原因语义：`interrupted`（崩溃后补的收尾）、`aborted` + cause `disposed` / `parent` 代表「宿主退出切断」 | rounds.ts:40-41 | B | 重启恢复把正常中断当成重启切断（或反过来） |
| D2 | 消息来源：`source.kind` = `user` / `subagent-settled { senderSessionId, summary }` / `agent-message { form: 'relay', senderSessionId }`；上下文快照 `form: 'snapshot'`；自定义 `HANDOFF_SOURCE` 用 `as never` 硬塞 | scheduler.ts:100, 103, 134, 139, 153, 1123, 1251；client/index.tsx:103 | A / C | 用户消息不交接；或运行时拒绝未知来源（我们的 cast 绕过了类型） |
| D3 | 投影 `stateVersion: 6`；注册表在版本不符时丢弃旧缓存并重新折叠 | index.ts:46-49 | B | 注册表语义变（例如版本不符直接抛错）：老会话打不开 |
| D4 | `subagentchat` 资源地址：`dsh-resource://subagentchat/session/<child>?parent=<p>&mode=<m>`；tab 的 `contentId` 里包含 `/session/<id>` | client/index.tsx:477-485；client/layout.ts:104 | B / C | 打不开成员对话；Agents 页的选中行不对 |
| D5 | `remote.commands.execute` 的结果：现在是 `{ commandId, result: { kind, text } }`，老版本是 `{ kind, text }` | client/index.tsx:868-880, 1371 | B | **已经坏过一次**：所有失败都显示成功 |
| D6 | `remote.commands.list` → `{ name }[]`；`remote.session.modelCatalog()` → `{ groups }` | client/index.tsx:1377, 1383 | B | 调度开关显示「不支持」；模型菜单为空 |
| D7 | 我们自己的记录类型 `plugin:dsh-agent-scheduler/*`（外层格式依赖 D1/H19） | records.ts:8-17 | A | — |

### 1.3 客户端服务 API（client 侧）

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| C1 | `ctx.uiConversation.events.register(def)`，def 的 `match / start / update / buildViewNode` 引擎契约，`location.kind === 'step'`、`step.step >= 2` 用来判断 steered | client/index.tsx:53-140, 1336-1337 | B | 交接卡片、请求卡片不显示，或者整个对话渲染报错 |
| C2 | slot 名：`conversation.chat.node`、`sidebar.right.pane.tab`、`conversation.input.left/right`、`plugins.bundle.config`；标准 props：`useProjection`、`useSessionStatus`、`useTabInfo`、`locked`、`inject(sessionId)` | client/index.tsx:1358-1359, 1387, 1395-1396, 726, 1090-1091；recovery-config.tsx:88-91 | B（`useTabInfo` 为 A） | 改名后对应 UI 直接消失，没有任何报错 |
| C3 | `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, keepMounted })` | client/index.tsx:1360-1366 | A | 编译不会报错（any），注册时抛错 |
| C4 | `sidebarRightTabs.get('subagentchat')` + `subscribe`，**就地改写**宿主 builtin 定义对象的 `keepMounted` | client/index.tsx:391-411 | C | 定义对象被冻结或换成不可变结构：切 tab 时子对话重新加载、滚动回顶部（无报错） |
| C5 | `ctx.sidebarRight.openTab / openResource / focus / isExpanded / toggleExpanded / mounted`，选项 `revealIfOpened / preferNewPane / paneId` | client/index.tsx:557-566, 613-640, 1350-1356 | A | 打不开 Agents 页或对话 |
| C6 | `sidebarRight.mountedSurface().layout`（`DockLayout`：`rootId / nodes / tabs / expanded`，pane `host: 'dock' \| 'float'`，split `axis / sizes`）+ `actionsFor(sid).dropTab / placeTab / resizeSplit` | client/index.tsx:557-640, 697-706, 1161；client/layout.ts:10-105 | C | Agents 页不再自动占左栏；位置乱放；`resizeSplit` 参数变了可能把布局弄坏 |
| C7 | `ctx.sessions.subagentAddress(id)` → `{ parentSessionId, mode }` | client/index.tsx:477-485, 1389, 1392 | B | 子会话里也显示调度开关；成员模型选择器消失 |
| C8 | `ctx.sessions.binding(id).session.projections.faceOf(key)` | client/index.tsx:1394 | B | 成员模型选择器拿不到 roster |
| C9 | `ctx.remote.commands`、`ctx.remote.session`（见 D5/D6） | client/index.tsx:1371-1385 | B | 同 D5/D6 |
| C10 | `ctx.uiWorkspace.openSession(address)`（侧栏不可用时的兜底） | client/index.tsx:1352 | B | 兜底失效 |
| C11 | `configForms.get(ns)` → `{ getSnapshot, subscribe, mutate }`；`whileServed` | recovery-config.tsx:85-92 | B | 插件页的「重启恢复」设置消失 |
| C12 | 会话状态行字段 `running / pendingInteraction / completionUnread` | client/index.tsx:45, 324, 348, 1185 | B | 「在跑 / 在等你」状态和黄点全错 |
| C13 | `modelDirectories.catalog`（dsh-client-ui-model-selection）：`store` 为 `{ value, status, error }` 快照 store，`value` 即 `remote.session.modelCatalog()` 的答复；`load()`；宿主在 `llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` 上刷新；composer 模型位就渲染这份 store | client/catalog-source.ts、dsh/client/catalog.ts | B | Worker 默认模型和 worker 底栏的模型菜单不再随模型列表实时更新（退回自取一份、按同样事件和每次打开菜单刷新） |

### 1.4 前端对宿主 DOM / CSS 的依赖

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| U1 | `[data-sidebar-right-session] [data-dockkit-strip-tabs]`（值 = pane id）、`[role=tab][aria-selected=true]`；用 `!important` 覆盖宿主的 `scroll-behavior: smooth` | client/index.tsx:425-470 | C | 关 tab 时 tab 栏又开始滑动（无报错） |
| U2 | `chatPlacement` 的 DOM 兜底：`[data-sidebar-right-session]:not([hidden]) [data-dockkit-pane]`、`dataset.dockkitPane` | client/index.tsx:496-501 | C | 对话盖到 Agents 页上 |
| U3 | 隐藏空回合：`[data-chat-flow-kind="turn-process"]` + `turn-tail` 相邻选择器 | client/index.tsx:192-193 | C | 每次交接在 lead 对话里多出一行空的「处理中」 |
| U4 | 模型菜单避让 `[data-composer-card]` | client/index.tsx:975 | C | 菜单压住输入框 |
| U5 | 主题 token：本插件用了 35 个 `--dsw-*`，外加 `--dsh-chat-content-width`、`--dsh-content-font-size/-delta`。其中 `--dsw-alias-accent`、`--dsw-alias-border-default`、`--dsw-alias-label-on-color` 在 rc.5 里**已经不存在**，现在靠 fallback 撑着 | client/index.tsx:153-268；model-menu.tsx:168-200；recovery-config.tsx:23-34 | C | 颜色和尺寸悄悄走样 |
| U6 | `window.__ModuleLoader__.load({ id, factory(require) })` 打包格式；external 为 react / cordis | scripts/build-client.mjs | B | 客户端 bundle 加载不起来 |

### 1.5 对运行时文案和行为的假设

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| T1 | 剥掉运行时附在子会话首条消息后的返回指引：`/^Your parent agent id is "/`（宿主是 `JSON.stringify(parentId)`，见 dsh-subagent `withContinuableReturnGuidance`） | scheduler.ts:58-59, 519-523 | C | worker 被指示 `send_message` 回父会话：结果重复，lead 被唤醒好几次 |
| T2 | 子会话收到的转发消息带前缀 `Agent <id> sent a message: `，恢复时去掉它再识别 `[request r-N …]` | recovery.ts:85-90 | C | 重启续跑的去重失效：续跑提示被重复发送 |
| T3 | 运行时会给深度为 1 的子会话注入 "…carry out the work directly."（dsh-tool-subagent 的委托深度提示）；FORK_NOTICE 和守卫拒绝文案专门对它做了反驳 | scheduler.ts:46；fork-guard.ts:1-9, 40；scheduler.ts:376-379 | C | 文案改了：反驳文字没有对象（守卫仍然拦截，属于偏安全的失效） |
| T4 | 容量错误文案 `subagent limit reached` | scheduler.ts:163 | C | 同 H6 |
| T5 | settled 行的宿主标签 "will do no further work"、drain 未知会话的报错文案 | scheduler.ts:1132-1133, 893 | C | 只影响注释里的假设，以及 H4 |
| T6 | 输入框只有在日志里看到带 request id 的 `user/message` 后才释放草稿（不写日志的话，带附件的草稿会被还原） | scheduler.ts:105-120 | C | 交接后输入框里又冒出刚发的内容和附件 |
| T7 | 会话沿用创建时的预设版本；客户端热更新、host 端要重启才生效，所以用 `commands.list` 探测 `/schedule`、`/agents`、`/worker` 在不在 | client/index.tsx:1377-1380 及各处 `has()` | B | 「不支持」误报或漏报 |

### 1.6 打包与版本

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| P1 | `types/rc5-type-shims.d.ts` 直接引用 `node_modules/@deepseek-ai/dsh-subagent/lib/types/projection.d.ts`，补 rc.5 的发包缺口（0.2.2-rc.1 仍未修复） | types/rc5-type-shims.d.ts:6 | C | 文件路径变：typecheck 失败；上游修好之后变成重复声明 |
| P2 | `engines.dsh: ">=0.2.1-rc.5 <0.3.0"`；peerDependencies 范围；devDependencies 锁死在 0.2.1-rc.5 | package.json | A | 范围和实际验证过的版本对不上 |
| P3 | `cordis.patch.yml` **整段覆盖** `preset-standard`：rc.5 默认预设的所有行原样拷贝一份，再插入我们的 rule 行（scripts/gen-preset.mjs 生成，版本号写死） | cordis.patch.yml:1-169；scripts/gen-preset.mjs | C | **最脆弱**：新版 DSH 改了标准预设，用户却还停在 rc.5 那份行列表上，新工具悄悄缺失；拷贝里引用的插件被删掉的话，预设加载失败，所有会话不可用 |
| P4 | `package.json` 里的 `dsh.client.inject`（9 个客户端包名）、`dsh.bundle.patch` | package.json | B | 包改名：客户端插件不 apply |

### 1.6b 语言（i18n）

| # | 依赖点 | 位置 | 级 | 坏掉的表现 |
|---|---|---|---|---|
| L1 | 客户端 `ctx.locale`（dsh-client-locale 的 `LocaleRuntime`）：`register(ns, { zh, en })` 返回 disposer、`bind(ns)` 返回 `t(key, params)`、`getSnapshot().revision`、`subscribe(fn)`（切换语言和注册词典都会通知） | dsh/client/locale.ts | B | 界面停在中文（warn once） |
| L2 | 模板占位符 `{name}`（`/\{(\w+)\}/g`，未知名字原样保留），与 src/i18n `format` 一致；复数由调用方选 `.one` / `.other` 键 | i18n/index.ts | C | 占位符原样显示 |
| L3 | 用户显式选择的语言是 Host 设置 `locale` 命名空间的 `preference` 字段（volatile）：`ctx.settings.describe()` 读当前值，写入后 `settings/document-updated(ns, revision)` | dsh/host/locale.ts | B | 命令回复停在中文（warn once）；未显式选择（DSH 跟随浏览器）时 host 看不到浏览器，也回中文 |
| L4 | 插件页显示名读 `locale/<lang>.json` 的 `meta.title` / `meta.description`（dsh-app-boot `readPluginMeta`） | locale/*.json | C | 插件页标题回落到 package.json 的英文 |

不翻译、保持英文的：给模型看的提示词与工具描述（FORK_NOTICE、LEAD_NOTICE、工具 schema、调度器抛出的工具错误）、命令的 description / hint（DSH 自己的命令也是英文，且注册时就被拷贝）。

### 1.7 统计

共 **60 项**（H 23 含 H10b，D 8 含 D1b，C 12，U 6，T 7，P 4；同时标了两档的按较脆弱的一档计）：

| 级别 | 数量 | 项 |
|---|---|---|
| A 公开 | 17 | H1, H2, H3, H7, H9, H10, H11, H13, H14, H15, H19, H20, H22, D7, C3, C5, P2 |
| B 导出未文档化 / 行为约定 | 25 | H5, H6, H8, H12, H16, H17, H18, H21, D1, D1b, D3, D5, D6, C1, C2, C7-C13, U6, T7, P4 |
| C 纯内部 | 19 | H4, H10b, D2, D4, C4, C6, U1-U5, T1-T6, P1, P3 |

已核对：rc.5 → 0.2.2-rc.1 期间，上述 B/C 级的锚点（sidebar 的 `mountedSurface / actionsFor / dropTab / placeTab / resizeSplit / keepMounted`、`subagentchat` 地址、`subagentAddress`、`data-dockkit-strip-tabs`、`turn-process / turn-tail`、T1/T3 文案、`ACTIVATION_LIMIT_REACHED`）在 @next 中都还在；D5 已经在这个区间内变过一次。

## 2. 适配层设计

### 2.1 原则

- `src/dsh/` 是唯一允许 import `@deepseek-ai/dsh-*` **运行时值**、读写宿主 ctx 服务、碰宿主 DOM / 文案的地方。业务代码只用 `src/dsh` 导出的函数和类型（类型统一从 `src/dsh/types.ts` 再导出）。
- host 侧与 client 侧分开目录：client bundle 不能引入 node 模块，host 代码不碰 DOM。
- 每个接口内部做**特性检测**，不比较版本号。特性只在安装时探测一次，结果记进 `features` 表，供诊断和测试使用。
- 降级分两档：
  - **required**（缺了调度就不可能正确）：H1, H2, H7, H8, H9, H10, H16, H18。缺失时 rule 插件不启用调度：`/schedule on` 返回「当前 DSH x.y.z 与 dsh-agent-scheduler 不兼容：缺少 <feature>」，并 `logger.error` 一次。**守卫（H10）缺失时绝不创建分身**，失败即关闭。
  - **optional**：其余项。缺失时安全 no-op，并且每个 feature key 只 `warn` 一次。

### 2.2 目录

```
src/dsh/
  version.ts          // 支持范围、宿主版本读取、features 表、warnOnce
  types.ts            // 业务需要的 DSH 类型统一再导出（Agent, Session, SessionEvent, UserMessage …）
  host/
    runtime.ts        // 子 agent：启动 fork/spawn/fork-from、送达、中断、drain、容量判定、fork-from provider
    agent.ts          // Agent 视图：isMain、mainIdOf、inbox 操作、toLead、status
    log.ts            // 日志读写：回合切分、结束原因归一化、inbox 折叠、交接写入、settled 改写、seed 切割
    hints.ts          // 宿主文案：剥返回指引、去转发前缀、委托深度提示、容量文案
    services.ts       // 安装钩子：事件、工具、守卫、system prompt、命令、日志查询、标题、模型校验、投影注册
    model.ts          // 成员模型：applyModelSelection
  client/
    services.ts       // 命令执行/探测、模型目录、子会话地址、roster face、打开对话
    sidebar.ts        // 布局快照归一化、tab 手势、keepMounted 保持
    dom.ts            // 所有宿主选择器、tab 栏稳定、DOM 兜底定位、隐藏空回合的 CSS
    ui.ts             // slot 名与注册、对话事件定义注册、配置表单
  index.ts            // host 入口再导出（client 有自己的 client/index.ts）
```

### 2.3 对外接口（业务代码只调这些）

```ts
// ---- version.ts
export const DSH_RANGE: string                         // 与 engines.dsh 同源（构建时从 package.json 注入）
export function hostVersion(): string | undefined      // createRequire 读 @deepseek-ai/dsh-agent/package.json
export type Feature = 'subagents.start' | 'subagents.send' | 'tools.guard' | 'projections' | 'session.title'
  | 'model.selection' | 'sidebar.layout' | 'sidebar.gestures' | 'tabs.keepMounted' | 'dom.stripTabs' | … 
export const features: { has(f: Feature): boolean; record(f: Feature, ok: boolean, why?: string): void; report(): Record<Feature, boolean> }
export function warnOnce(key: string, message: string, error?: unknown): void

// ---- host/runtime.ts
export interface SubagentPort {
  startFork(main: Agent, a: { childId: SessionId; label: string; prompt: ContentBlock[] }): Promise<void>
  startWorker(main: Agent, a: { childId: SessionId; label: string; prompt: ContentBlock[]; seed?: SessionEvent[];
    cwd?: string; preset?: string; model?: ModelChoice }): Promise<{ messageId: string }>
  send(main: Agent, to: SessionId, text: string): Promise<{ messageId: string }>
  interrupt(main: Agent, id: SessionId): void
  drain(main: Agent, ids: SessionId[]): Promise<void>
  isCapacity(error: unknown): boolean
}
export function subagentPort(ctx: Context): SubagentPort
export function installForkFrom(ctx: Context): void            // provider + seed 注册表收在这里
export function cutSeed(events: readonly SessionEvent[], source: string): SessionEvent[]  // 原 forkSeed，错误码不变

// ---- host/agent.ts
export const isMain: (a: Agent) => boolean
export const mainIdOf: (a: Agent) => string
export function inbox(a: Agent): { pending(): UserMessage[]; remove(id): boolean; replace(id, m): boolean; has(id): boolean }
export function toLead(main: Agent, text: string, sender: string): void
export function liveStatus(agents: AgentLookup, id: string): 'running' | 'idle' | undefined

// ---- host/log.ts
export interface RawRound { endSeq: number; claimed: Set<string>; closing: string; report?: string; end: EndReason }
export type EndReason = { kind: 'completed' } | { kind: 'aborted'; cause?: string } | { kind: 'interrupted' } | { kind: string }
export function rounds(events: readonly SessionEvent[], from: number, reportTool: string): RawRound[]
export function inboxFold(events): { pending: Set<string>; messages: { id: string; firstLine: string }[] }
export function admitHidden(session: Session, message: UserMessage, note: string): boolean
export function isUserInput(m: UserMessage): boolean
export function isContextOnly(m: UserMessage): boolean
export function settledSender(m: UserMessage): string | undefined
export function withSettledSummary(m: UserMessage, summary: string, text: string): UserMessage
export function readLog(ctx: Context, id: SessionId): Promise<{ events: SessionEvent[]; inherited: number }>
export function liveLog(a: Agent): { events: SessionEvent[]; inherited: number }

// ---- host/hints.ts
export function stripReturnGuidance(m: UserMessage): UserMessage | undefined   // T1
export function unwrapRelayed(text: string): string                            // T2
export const DELEGATION_DEPTH_HINT: string                                     // T3，供 FORK_NOTICE 引用
export function isCapacityText(message: string): boolean                       // T4

// ---- host/services.ts
export interface RuleHooks {
  onInserted(a: Agent, m: UserMessage): boolean
  preStep(p: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  onStatus(a: Agent, s: 'idle' | 'running'): void
  onResumed(a: Agent): void
  onCreated(a: Agent): void
  onDisposed(a: Agent): void
}
export function installRule(ctx: Context, hooks: RuleHooks): { compatible: boolean; missing: Feature[] }
export function registerTools(ctx: Context, tools: ToolSpec[]): void          // ToolSpec 是我们自己的描述，内部转 defineTool
export function installForkGuard(ctx: Context, refuse: (agent: Agent, tool: string) => string | undefined): boolean
export function promptSection(ctx: Context, name: string, order: number, text: (a: Agent) => string): void
export function registerCommand(ctx: Context, spec: { id: string; name: string; description: string; hint?: string;
  run(inv: { agent: Agent; raw: string }): CommandOutcome | Promise<CommandOutcome> }): void   // 空 hint 自动省略（H12）
export function titleSetter(ctx: Context): (session: Session, text: string) => void           // 无标题服务时 no-op
export function modelValidator(ctx: Context): (m: ModelChoice) => Promise<ModelChoice>
export function registerProjection<S, V>(ctx: Context, spec: ProjectionSpec<S, V>): void      // 内部包好 parse/safeParse

// ---- host/model.ts
export function applyModelSelection(agent: Agent, choice: ModelChoice | null): void

// ---- client/services.ts
export interface ClientHost {
  run(sessionId: string, line: string): Promise<string | null>     // D5 两种返回形状都在这里归一
  has(sessionId: string, command: string): Promise<boolean>
  catalog(): Promise<readonly CatalogGroup[]>
  childAddress(sessionId: string): { parent: string; mode: string } | undefined
  chatAddress(parent: string, child: string): string               // D4 唯一的拼装处
  childOfTab(contentId: string, ids: readonly string[]): string | undefined
  rosterFace(parent: string): Face
  openChat(parent: string, child: string, placement: Placement): void
}
export function clientHost(ctx: any): ClientHost

// ---- client/sidebar.ts
export interface SidebarPort {
  layout(): DockLayout | undefined                 // 结构校验不过就返回 undefined，并 warnOnce
  gestures(): { drop?; place?; resize? } | undefined
  openPage(kind: string, opts?: { paneId?: string }): void
  focus(tabId: string): void
  expanded(): boolean | undefined
  toggle(): void
}
export function sidebarPort(ctx: any): SidebarPort
export function keepChatsMounted(ctx: any): () => void            // C4，失败只 warn

// ---- client/dom.ts
export const SEL: { stripTabs; selectedTab; sidebarSession; dockPane; composerCard }
export function steadyTabStrips(doc?: Document): () => void
export function domPlacement(doc: Document, rosterPane?: string): Placement
export const HOST_CSS: string                     // U3 隐藏规则等宿主相关的 CSS 片段，和业务样式分开

// ---- client/ui.ts
export const SLOT: { chatNode; paneTab; inputLeft; inputRight; bundleConfig }
export function registerSlot(ctx: any, name: keyof typeof SLOT, spec, component): void
export function registerChatEvent(ctx: any, def: ChatEventDef): void
export function registerTabType(ctx: any, spec): void
export function configForm(ctx: any, ns: string, mount: (form: Form) => unknown): void
```

### 2.4 各接口内部的探测与降级

| 接口 | 探测方式 | 缺失 / 不符时 |
|---|---|---|
| `subagentPort` | `typeof ctx.subagents?.startActivation === 'function'` 等；`startActivation` 结果没有 `messageId` 时抛 `DshContractError('subagents.start: no messageId')` | required：`installRule` 报不兼容 |
| `isCapacity` | 先看 `error.code`，再看 `isCapacityText`；两者都没命中但 message 包含 `limit` 时 warnOnce | 按真失败处理（现状） |
| `installForkGuard` | `typeof ctx.tools?.guard === 'function'`，并在 dispose 时拿到 disposer | **返回 false → 调度禁用，分身不创建** |
| `stripReturnGuidance` | 匹配现有正则；子会话首条消息末尾的 text 块以 `Your parent agent id is` 开头但正则没命中时（例如改了引号）warnOnce('hint.return') | 不剥离，只告警；契约测试会先发现 |
| `unwrapRelayed` | 前缀正则；首行不以 `[` 开头且包含 ` sent a message` 时 warnOnce | 原样返回 |
| `rounds` / `EndReason` | 未知的 `reason.kind` 归入 `{ kind }`，当作「非正常结束」；未知 cause 记 warnOnce | 和现状一致：停止的回合不回答，请求标失败，不会卡死 |
| `admitHidden` | 写入前检查 `session.surface?.nodes`、`eventAt`；`append` 抛错时 catch，返回 false | 退回到「只移出 inbox，不写日志」（现有的 `logged: false` 分支） |
| `registerProjection` | 包一层 schema：同时提供 `parse` 和 `safeParse`，对付 H16 | — |
| `registerCommand` | hint 为空串时自动省略 | — |
| `titleSetter` | `ctx.inject(['sessionTitle'])` 可选 | no-op |
| `applyModelSelection` | `typeof installModelSelection === 'function'` | `/agent-model` 返回「当前 DSH 不支持单独换模型」 |
| `clientHost.run` | 同时识别 `{ kind, text }` 和 `{ result: { kind, text } }`；两种都不是时 warnOnce 并返回 `unexpected result` 错误，**不当作成功** | 失败可见 |
| `clientHost.childAddress` | `ctx.sessions?.subagentAddress` 存在；不存在时退回 `binding(id)?.parentSessionId` | 子会话判定失效时开关照常显示（现状） |
| `sidebarPort.layout` | 校验 `rootId / nodes / tabs` 和 pane、split 的字段 | 返回 undefined：不自动排布，对话用 `preferNewPane` 打开 |
| `sidebarPort.gestures` | `actionsFor` 和每个方法分别检测 | 只是不排布 |
| `keepChatsMounted` | `Object.isFrozen(def)`，写入后读回校验 | warnOnce，放弃（子对话切换时会重载） |
| `steadyTabStrips` | 启动后 5 秒内页面上一个 `SEL.stripTabs` 都没出现，但有 `[data-dockkit-pane]` | warnOnce('dom.stripTabs')，断开 observer |
| `domPlacement` | 选择器零命中 | `{ preferNewPane: true }` |
| `registerSlot` / `registerChatEvent` | 方法存在；slot 名未知无法检测，只能靠契约测试 | no-op + warn |

`features.report()` 通过 `/agents doctor`（新增的只读命令）和客户端的 `window.__dshAgentScheduler?.features` 暴露出来，用户报 bug 时一行就能贴出来。

### 2.5 依赖点 → 适配接口映射

| 依赖点 | 适配接口 |
|---|---|
| H1, H2, H3, H4, H6, T4 | `host/runtime.ts` `subagentPort`（`startFork / startWorker / send / interrupt / drain / isCapacity`） |
| H5 | `host/runtime.ts` `installForkFrom / cutSeed` |
| H7 | `host/agent.ts` |
| H8 | `host/services.ts` `installRule` |
| H9 | `host/services.ts` `registerTools` |
| H10, H10b | `host/services.ts` `installForkGuard`；白名单留在业务（fork-guard.ts），工具名常量移到 `host/hints.ts` 的 `HOST_TOOL_NAMES` |
| H11 | `promptSection` |
| H12 | `registerCommand` |
| H13 | `host/log.ts` `readLog / liveLog` |
| H14 | `titleSetter` |
| H15 | `modelValidator` |
| H16, D3 | `registerProjection` |
| H17 | `host/model.ts` `applyModelSelection` |
| H18, T6 | `host/log.ts` `admitHidden` |
| H19, D7 | 记录读写保留在 records.ts，只从 `src/dsh/host/log.ts` 拿 `appendRecord / recordOf` 两个薄包装 |
| H20, D1, D1b | `host/log.ts` `rounds / EndReason / inboxFold` |
| H21, D2 | `host/log.ts` `isUserInput / isContextOnly / settledSender / withSettledSummary`；`HANDOFF_SOURCE` 的 cast 收进 `admitHidden` |
| H22, P4 | 各 `apply` 的 inject 清单保留，常量移到 `version.ts` 的 `SERVICES` |
| T1, T2, T3, T5 | `host/hints.ts` |
| D4 | `client/services.ts` `chatAddress / childOfTab` |
| D5, D6, C9 | `client/services.ts` `run / has / catalog` |
| C1, C2, C3, C11 | `client/ui.ts` |
| C4 | `client/sidebar.ts` `keepChatsMounted` |
| C5, C6 | `client/sidebar.ts` `sidebarPort`；`client/layout.ts` 的纯计算（`nextRosterStep` 等）留在业务，只吃归一化后的 `DockLayout` |
| C7, C8, C10 | `client/services.ts` |
| C12 | `client/services.ts` `statusOf(row)` 归一为 `{ running, waiting }` |
| C13 | `client/catalog.ts` `composerCatalog / onCatalogChange`，经 `client/services.ts` 的 `composerCatalog / modelCatalog / onCatalogChange` 暴露 |
| U1-U4 | `client/dom.ts` `SEL / steadyTabStrips / domPlacement / HOST_CSS` |
| U5 | `client/dom.ts` 导出 `TOKENS` 清单，契约测试逐个检查；业务 CSS 照写，但只能用清单里的 token |
| U6 | scripts/build-client.mjs（不进 src，契约测试覆盖） |
| P1, P2, P3 | 不进 src，见第 3 节 |

## 3. 兼容策略

### 3.1 契约测试 `tests/contract/`

不 mock，直接对当前 `node_modules` 里真实的 DSH 包做断言。每个用例名带依赖点编号（如 `H6 capacity code`），失败时一眼能对到第 1 节。

1. **`host-api.spec.ts`**：运行时存在性 / 形状
   - `typeof finalAssistantOutput / installModelSelection / appendPluginRecord / pluginRecordOf / boundContextSummary / defineTool === 'function'`；
   - 用现有 testkit（tests/support/harness.ts）起一个真实 runtime，断言 `ctx.subagents` 有 `startActivation / sendMessage / interrupt / drainChildren / registerProvider`，`ctx.tools.guard` 存在，`sessionProjections.register` 接受我们的 spec。
2. **`host-behaviour.spec.ts`**：行为约定（H1/H6/H8/D1b/D2/H18），基于 testkit
   - `startActivation` fork 返回 `messageId`，子会话首条 `user/message.id` 与它一致；
   - 超出并发上限时抛出的错误满足 `isCapacity`；
   - 父会话收到的 settled 消息 `source.kind === 'subagent-settled'`，带 `senderSessionId`；
   - 中断子会话后 `turn/end.reason` 为 `{ kind: 'aborted', reason: { kind: 'parent' } }`；
   - `admitHidden` 在 step 内和 step 外各写一次，`snapshotEvents` 折叠出来的模型输入里看不到原文；
   - 首步只有上下文快照时 `pre-step` 返回 `reject` 不会触发模型调用。
3. **`host-text.spec.ts`**：文案探针（T1-T4）。这些字符串不是导出值，只能读包里的 `lib/index.js`：
   - `@deepseek-ai/dsh-subagent/lib/index.js` 包含 `Your parent agent id is ${encodedParentId}` 且 `encodedParentId = JSON.stringify(` —— 再用 testkit 实际起一个 continuable 子会话，验证 `stripReturnGuidance` 能剥掉；
   - 同包包含 `sent a message: `、`ACTIVATION_LIMIT_REACHED`；
   - `@deepseek-ai/dsh-tool-subagent` 包含 `carry out the work directly`（不在时提示去更新 FORK_NOTICE）。
4. **`client-probe.spec.ts`**：客户端内部（C4/C6/C7/D4/U1-U5）。新增 devDependencies（只用于测试，不进 peer）：`@deepseek-ai/dsh-client-ui-sidebar-right`、`dsh-client-ui-subagent`、`dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-api-session-controller`、`dsh-web-frontend`。对它们的 `lib/*.js` / `dist/assets/*` 做源码探针：
   - sidebar-right：`mountedSurface`、`actionsFor`、`dropTab`、`placeTab`、`resizeSplit`、`keepMounted`、`revealIfOpened`、`preferNewPane`、`data-sidebar-right-session`、`data-dockkit-pane`；
   - subagent：`dsh-resource://subagentchat/session/`，`parent` / `mode` 查询参数，mode 取值 `one-shot|continuable|unknown`；
   - session-controller：`subagentAddress(`、`faceOf`；
   - web-frontend：`data-dockkit-strip-tabs`、`role:"tab"` 与 `aria-selected`；
   - chat：`turn-process`、`turn-tail`、slot 名 `"conversation.chat.node"`；conversation：`data-composer-card`、`conversation.input.left/right`；
   - token：`client/dom.ts` 的 `TOKENS` 每个都要在 web-frontend 的 css 或任一客户端包里出现（现在就会报出那 3 个已失效的 token，第一步先清理掉）。
   - 源码探针粒度粗：命中不代表语义没变，但**没命中一定是坏了**。C6 另外用 `client/layout.ts` 的单测固定 `DockLayout` 形状。
5. **`packaging.spec.ts`**（P1/P3/U6）：
   - P1：`dsh-subagent` 入口的 d.ts 能否在不加 shim 的情况下 typecheck（能的话提示删掉 shim）；
   - P3：读 `@deepseek-ai/dsh-agent-preset`（或 dsh 包）导出的默认 standard 预设，和 `cordis.patch.yml` 里的拷贝逐行对比，**有差异就失败**，并给出 `npm run gen:preset` 的重生成命令；
   - U6：`dist/client.js` 能被一个最小的 `__ModuleLoader__` 桩加载，`apply` 是函数。
6. **`adapter.spec.ts`**：适配层自身的降级单测。用缺字段的假 ctx 逐项验证：optional 能力 no-op 且只 warn 一次；required 能力缺失时 `installRule` 返回 `compatible: false`；守卫缺失时 `/schedule on` 被拒；`run` 能识别两种结果形状。
7. **`boundary.spec.ts`**：扫描 `src/**`，`src/dsh/` 之外不允许出现 `from '@deepseek-ai/dsh-*'` 的值导入（`import type` 也必须走 `src/dsh/types.ts`），也不允许出现 `data-dockkit` / `data-sidebar-right` / `--dsw-` 之外的宿主选择器字面量。
8. **`locale.spec.ts`**（L1-L4）：dsh-client-locale、dsh-settings、dsh-app-boot 的源码探针（pinned 和 next 都跑）。

`npm run contract` = `vitest run tests/contract`。

### 3.2 CI

在 `.github/workflows/ci.yml` 里加一个 job：

```yaml
  contract:
    strategy:
      fail-fast: false
      matrix:
        dsh: [pinned, next]
    continue-on-error: ${{ matrix.dsh == 'next' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - if: matrix.dsh == 'next'
        run: node scripts/dsh-deps.mjs next | xargs npm i --no-save   # 把所有 @deepseek-ai/dsh-* devDeps 换成 @next
      - run: npm run typecheck        # 类型契约：A 级接口变化在这里暴露
      - run: npm run build
      - run: npm run contract
      - run: npm test
```

再加 `schedule: [{ cron: '0 2 * * 1' }]`，每周一跑一次，这样 DSH 发 next 不用等我们有 PR 才发现问题。next 失败不挡合并，但 job 会标黄，并自动开 issue（`gh issue create`，同一版本只开一次）。

本地：`npm run contract:next`（同一个脚本，装到临时目录，不改 lockfile）。

### 3.3 engines.dsh 怎么维护

- **下界** = CI 矩阵里 `pinned` 那一档的版本（devDependencies 锁定的版本）。只有在适配层删掉旧分支时才抬高。
- **上界** = 下一个 minor 的开区间（现在是 `<0.3.0`）。DSH 新 minor 发布时：`contract (next)` 绿 + 手动冒烟（见 3.4）都过了，才放宽上界，并把 pinned 升到新版本、重新生成 `cordis.patch.yml`。
- peerDependencies 的范围与 engines.dsh 始终同步（加一个 `packaging.spec.ts` 断言两者一致）。
- 兼容分支**按特性检测写，不按版本号写**：老版本的分支在下界抬过它之后整块删掉。每个分支上加 `// dsh-compat: <feature> until <version>` 注释，方便 grep。

### 3.4 新 DSH 发布时的检查清单

1. 等 `contract (next)` 跑完（或本地 `npm run contract:next`），失败项按编号对到第 1 节。
2. P3：`npx @deepseek-ai/dsh@<ver> --profile web --dump-default-config > dump.yml && npm run gen:preset dump.yml`，看 diff。
3. 冒烟（5 分钟）：开调度 → 发一条消息 → 分身创建 worker → worker 回答到 lead → 打开 Agents 页 → 点开 worker 对话 → 关一个 tab → 重启 DSH → 重启恢复提示。
4. 放宽 engines / peer，升 pinned，提交。

## 4. 迁移计划

### 4.1 时机

`feat/worker-split`（需求三）、`feat/roster-overflow`、`fix/create-lock`（#10）都在改 `src/scheduler.ts`、`src/tools.ts`、`src/rule-plugin.ts`、`src/client/index.tsx`，正好是迁移要动的文件。**等这三个合进 main 之后再开始，整套迁移一起做。**feat/user-workers 已经在 03ba296 合入，本稿已经以它为基线。

### 4.2 步骤（每步一个 commit，行为不变，现有测试只改 import 路径）

| 步 | 内容 | 改动文件 | 与在途分支的冲突 |
|---|---|---|---|
| 1 | 骨架：`src/dsh/version.ts`（`warnOnce / features`）、`types.ts`；`tests/contract/*` 里 host-text、client-probe、packaging 三组；新增客户端 devDeps；CI 的 `contract` job；清理 3 个失效 token | 新文件；package.json；package-lock.json；ci.yml；client/index.tsx、recovery-config.tsx 各一两行 token | 低：只有 package.json / lock 可能冲突，重新生成即可 |
| 2 | 日志与文案：`rounds.ts` 的事件解析、`recovery.ts` 的 `traceChild` 前缀、`forks-from.ts` 的 seed 切割与 provider、`scheduler.ts` 的 `admitHidden / openStep / isContextOnly / NATIVE_NOTICE / isCapacity / settled 改写` 移到 `host/log.ts`、`host/hints.ts`、`host/runtime.ts`；业务保留 `Round` 语义 | rounds.ts、recovery.ts、forks-from.ts、scheduler.ts（顶部约 160 行 + admit 段） | **高**：scheduler.ts 是 worker-split、create-lock 的主战场 |
| 3 | 服务安装：`rule-plugin.ts` 的 `ctx.on / tools / guard / systemPrompt / commands / sessionQuery / sessionTitle / llm`、`index.ts` 的投影注册、`member-model.ts` 的 `installModelSelection`；`SchedulerDeps.subagents` 换成 `SubagentPort`；`tools.ts` 改成 `ToolSpec` | rule-plugin.ts、index.ts、member-model.ts、scheduler.ts（startActivation / sendMessage 4 处）、tools.ts | **高**：rule-plugin.ts、tools.ts 与 worker-split、create-lock 重叠 |
| 4 | 客户端服务：`run / has / catalog / commandFailure / subagentAddress / rosterFace / open` 移到 `client/services.ts` | client/index.tsx（apply 段与 subagentAddress） | 中：与 roster-overflow 重叠在 index.tsx |
| 5 | 侧栏与 DOM：`retainChatTabs`、`steadyTabStrips`、`chatPlacement`、`SidebarFace`、`arrangeRoster / openAgentsPage / narrowRoster` 的宿主调用、STYLE 里的宿主选择器 → `client/sidebar.ts`、`client/dom.ts`；slot / 事件注册 → `client/ui.ts` | client/index.tsx、client/layout.ts、client/recovery-config.tsx | **高**：roster-overflow 正在改 Agents 页 |
| 6 | 收口：host-api、host-behaviour、adapter、boundary 四组契约测试；`/agents doctor`；README 加一节「兼容的 DSH 版本」 | tests/contract/*、rule-plugin.ts（一条命令）、README*.md | 低 |

已定：第 1-6 步**合成一个 PR**，等 worker-split / roster-overflow / create-lock 合进 main 后一次做完，每步一个 commit。估计 diff 以移动代码为主，±1200 行。

### 4.3 风险

- 搬代码时不小心改变行为：靠现有 16 个 spec 兜底，每步结束都必须全绿；host-behaviour 契约测试在第 2 步之前先写好，作为基准。
- 源码探针误报（宿主做了 minify 或改名）：探针只在 CI 的 next 档上不挡合并，并且每条都写明人工核对的方法。
- 客户端 devDeps 体积：6 个包，只在 CI / 开发时安装，不进发布包。

## 5. 待确认

1. ~~**P3 预设覆盖**~~ 已定并已实现：rule 改为 profile 顶层 `- insert:` 的行，不再拷贝 standard（第 6 节）；「调度（旧会话）」预设删除。
2. ~~关键能力缺失~~ 已定：**直接禁用调度**，不跑不兼容的组合（见 2.1）。
3. ~~客户端包~~ 已定：用于探针，但**不作为 devDependencies**，改由 `scripts/fetch-dsh.mjs` 按版本下载 tarball 只读（见 7.2），免得它们的依赖树进 lockfile。
4. ~~PR 拆分~~ 已定：**不拆**，第 1-6 步做成一个 PR，等在途分支合完后一起做（见 4.2）。

## 6. 调研：rule 怎么挂进 standard 预设（P3）

> 只读调研，结论待确认。DSH 源码以本机 0.2.1-rc.5 为准（`app.asar`，以及仓库 `node_modules` 里同版本的包）；对照版本 npm `@next` = 0.2.2-rc.1。
> 所有实测都在隔离的 `DSH_HOME=/tmp/dshhome-probe` 下做，没有碰 `~/.dsh`。

### 6.1 现状

- **挂法**：调度 rule 必须出现在每个普通会话里，现在靠 `cordis.patch.yml` 第 3–169 行 `- id: preset-standard` 把 standard 预设的 `config` **整段覆盖**。内容是 rc.5 standard 预设全部 22 行原样拷一份，再在最前面加一行 `agent-scheduler-rule`。第 170 行起，`- insert:` 插入 host 行 `dsh-agent-scheduler`，外加一份同样是整段拷贝的「调度（旧会话）」预设（rule 带 `defaultOn: true`）。
- **生成**：`scripts/gen-preset.mjs` 读 `dsh --profile web --dump-default-config` 的输出，截出 `- id: preset-standard` 那一段，去掉 `name / description`，插入 rule 行，再拼上 host 行和旧会话预设。版本号 `0.2.1-rc.5` 写死在生成文件的头注释里。
- **守门**：`tests/packaging.spec.ts` **目前不存在**，它是第 3.1 节提议的契约测试，还没写。现在没有任何东西会发现这份拷贝过时了。

### 6.2 DSH 现有能力逐条核对

| 设想 | 结论 | 证据 |
|---|---|---|
| `insert` 插进某个预设内部（某 id 之后或末尾） | **不行**。`insert` 带 `id` 时，只能往 `group: true` 的条目里 push，只能追加到末尾，没有「某 id 之后」。`preset-standard` 不是 group | `@deepseek-ai/cordis-plugin-include` `src/index.ts` `applyEntryPatches` 第 79–91 行。实测补丁 `- id: preset-standard` + `insert: [...]` 输出 `patch insert: entry "preset-standard" is not a group`，预设仍是 22 行 |
| id 覆盖时只追加 `plugins`，不整体替换 | **不行**。按 id 覆盖是浅赋值 `target[key] = value`，`config` 整个被换掉 | 同文件第 120–123 行。实测覆盖成只有 1 行 `plugins` 的 config，dump 出来 standard 只剩那 1 行 |
| 按 id 直接改预设里的某个子行 | **不行**。id 索引只会深入 `group && Array.isArray(config)` 的条目，预设内部的行不进索引；同名的 host 行会被误命中 | 同文件第 66–73 行。实测补丁 `- id: tool-todo` 改的是**顶层 host 行** `tool-todo`，预设里的 `tool-todo` 没变（与 DSH [#8547](https://github.com/deepseek-ai/deepseek-harness/discussions/8547) 描述一致） |
| `!!js` 在加载时读原 standard 的 plugins 再 concat | **不行**，有两个原因。① 预设行的插件类 `AgentPreset` 声明了 `EntryGroup.key`，Loader 对这种「树载体」的 config **不做插值**，`plugins: !!js …` 会原样变成 `{ __jsExpr }`，过不了 `z.array`。② 即使插值，`!!js` 的作用域是 `with (ctx) eval(expr)`，只有当前 fiber 的 ctx，拿不到被覆盖之前的那份行列表；patch 本身是在插值之前、对纯数据做的 | `@deepseek-ai/dsh-agent-preset` `lib/index.js` `static [EntryGroup.key] = true`；`@deepseek-ai/cordis-plugin-loader` `src/index.ts` 第 103–112 行（`if (plugin?.[EntryGroup.key]) return config`）、`src/config/utils.ts` 第 5–9 行（`evaluate`）。实测 dump 中 `config: !!js …` 保持字面量 |
| 预设注册表的运行时 API：往已注册的 standard 追加，或注册「继承 standard + 额外行」 | **没有**。`AgentPresetRegistry` 只有 `register(definition)`，同 id 重复注册直接抛 `Duplicate agent preset`；`PresetDefinition` 只有 `id / name / description / order / plugins`，没有 `extends`；`definitions` 是私有的；`readDocument` 只读，供查看用 | `@deepseek-ai/dsh-agent-preset-registry` `lib/types/index.d.ts` 第 22–136 行、`lib/types/definition.d.ts` 第 4–13 行、`lib/index.js` `register()` 第 470–493 行 |
| **rule 不进预设，作为 profile 顶层 host 行插入** | **可以**，这正是 DSH 官方 bundle 的做法。顶层注册的工具、守卫、事件监听对**所有** agent 生效，预设里同名的注册离得更近，优先 | `@deepseek-ai/dsh-scope` README：「Untagged listeners stay global」「Child scopes inherit ancestor contributions, with the nearest definition taking precedence」；registry README：「Plugin registrations inherit the preset scope, and the Agent scope's parent link controls visibility」。官方 bundle `dsh-experimental-tool-worktree`、`dsh-experimental-auto-review`（在 host 层挂 `tools/pre-execute`）、`dsh-experimental-badge-skill-bundle` 的 `cordis.patch.yml` 全部只有一句顶层 `- insert:`，不碰任何预设。我们自己的测试（tests/support/scheduler.ts 第 15–38 行）本来就把整套调度挂在根 ctx 上、不进预设，16 个 spec 全部通过 |

### 6.3 用户升级 DSH 后具体怎么坏（已实测对比）

把本机 rc.5 的 `dsh-web-app/presets/standard.patch.yml` 和 npm `@deepseek-ai/dsh-web-app@0.2.2-rc.1` 的同一个文件做 diff，我们这份拷贝在 0.2.2-rc.1 上会出现：

1. **预设加载失败**：0.2.2-rc.1 删掉了 `tool-subagent-list-agents` 这一行。`@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.1` 的 `exports` 只剩 `.`、`./src/*`，**没有 `./list-agents` 了**，而我们的拷贝第 132–133 行、第 306–307 行还引用 `'@deepseek-ai/dsh-tool-subagent-control/list-agents'`。预设注册表的规则是「Import failures … reject the mount. Failure prevents new bindings to that definition」（registry README），所以 **standard 预设整个不可用，默认预设下的所有新会话都起不来**。0.2.2-rc.1 在我们的 `engines.dsh`（`<0.3.0`）范围内，用户升级不会收到任何警告。
   - 在 rc.5 上复现：用同一份拷贝、只把这一行改成一个不存在的子路径，用 `--patch` 叠加启动 web profile，服务能起来，但注册表的 warn 只进 logger，没有输出到终端，所以这一步我只拿到了源码层面的证据。
2. **功能悄悄丢失**：
   - `tool-subagent` 的 `modelSelectionSettings: true` 在 0.2.2-rc.1 改名为 `modelSelection` / `modelDiscovery`。schemastery 会静默丢掉未知键，于是 subagent 工具的模型选择没了，也不报错。
   - `tool-fs` 新增的 `applyPatch` 配置、`tool-plugin-manager` 从 `disabled: true` 改为 `!!js "!ctx.get('profileContext')"`，这两处我们都拿不到。
3. **与其他插件冲突**：别的 bundle 也覆盖 `preset-standard` 时，后一个会把整段冲掉。

「调度（旧会话）」预设是同一份拷贝，问题完全相同，只是只影响旧会话。

### 6.4 结论与建议

**现有能力可以做到不再拷贝**：rule 不再挂在 standard 里，改成 profile 顶层的 host 行。

`cordis.patch.yml` 改成：

```yaml
- insert:
    - id: dsh-agent-scheduler
      name: dsh-agent-scheduler
      config: {}
    - id: agent-scheduler-rule
      name: dsh-agent-scheduler/rule
      config: {}
```

不再出现 `preset-standard`，也就不再需要 `gen-preset.mjs` 和对 DSH 版本的跟版。

需要处理的副作用：

1. **对所有预设生效**：ptc、minimal、cordis 和用户自定义的预设都会多出 `agent_*` 工具、`/schedule` 和调度开关。开关默认关，关着且无成员时 system prompt 段为空、不分身；但自 talk-to-lead（#15）起关着时 lead 的工具也能用，所以这些预设里 lead 可以建 worker，且每次请求多 8 个工具定义（实测约 8.6 KB，minimal 预设 3 → 11 个工具）。可选的收紧办法：在 `agent/created` 时用 `ctx.agentPresets.composedPreset(agent.ctx)`（公开 API）判断，不是 standard 的 agent 用 `tools.restrict(agent.ctx, …)` 去掉这些工具。这个办法需要原型验证。
2. **旧会话预设**：已定**删掉**。`cordis.patch.yml` 不再带 `preset-scheduler`（「调度（旧会话）」）。用它创建的会话（本机 7 个，1 主 6 子，均为 11 月 3–4 日）从此打不开，因为注册表找不到预设定义就拒绝恢复；新会话不受影响。随之可删：rule 的 `defaultOn` 配置项（rule-plugin.ts:32、49、240，只为这个预设存在）；`SchedulerDeps.defaultOn`（scheduler.ts:82、326）测试还在用（tests/support/scheduler.ts 默认开），保留为内部参数。`schedulingOn` 对「开关出现之前的老日志」的推断保留，它不依赖这个预设。
3. **防止重复挂载**：rule 加一个进程级单例保护。用户自己的 profile 补丁里如果还留着旧的 standard 覆盖，第二个实例自动 no-op 并 warn。
4. **prompt cache 不受影响**：lead 和分身看到的是同一套全局注册，工具列表和 system prompt 段依旧一致。

**迁移步骤**（并入第 4.2 节的同一个 PR，作为第 0 步，与在途分支冲突小：主要改 `cordis.patch.yml`、`scripts/`，以及 `rule-plugin.ts` / `scheduler.ts` 里 `defaultOn` 的几行）：

1. 原型验证（只用隔离 DSH_HOME）：把插件装进 `/tmp/dshhome-probe` 的 web profile，用上面的 patch 启动，确认以下几点：
   - standard 会话里 `agent_*` 工具可见、守卫生效、`agent/pre-step` 能交接用户消息；
   - ptc 和 minimal 预设里的表现；
2. `cordis.patch.yml` 只留顶层 `- insert:`（host 行 + rule 行），删掉 `preset-standard` 覆盖和 `preset-scheduler`；删 `scripts/gen-preset.mjs` 和 `npm run gen:preset`；删 rule 的 `defaultOn` 配置项；加单例保护。
3. 契约测试 `packaging.spec.ts` 改为断言：`cordis.patch.yml` 只含顶层 `insert`，不覆盖也不声明任何预设。
4. README 「Preset and switch」一节改写，发版说明写明：「调度（旧会话）」预设已移除，用它创建的旧会话无法再打开。

**如果原型发现 host 层挂不住**（例如某个钩子只在预设作用域内派发），就退回整段拷贝的方案。届时：

- **给 DSH 的需求**（届时再提，可参考已有的讨论帖 [#9431](https://github.com/deepseek-ai/deepseek-harness/discussions/9431)、[#8547](https://github.com/deepseek-ai/deepseek-harness/discussions/8547)）：让 `applyEntryPatches` 的 `insert` 可以以「插件类声明了 `EntryGroup.key`、config 里有数组 `plugins`」的条目为目标，按 row id 追加到 `config.plugins`，同 id 覆盖。最小改动点是 `@deepseek-ai/cordis-plugin-include` `src/index.ts` 第 66–91 行，`buildMap` 和 `insert` 分支各加一种情况。另一个办法是在 `dsh-agent-preset-registry` 的 `PresetDefinition` 上加 `extends`。
- **`packaging.spec.ts` 守门够不够**：**不够**。它只能在我们这边的 CI 里发现过时（`@next` 档），保护不了已经先升级 DSH 的用户；而且照 6.3 第 1 条，过时的后果是默认预设整个起不来。即便退回这个方案，也必须同时做两件事：
  - `engines.dsh` 的上界收紧到当前验证过的 patch 版本（例如 `<=0.2.1`），而不是 `<0.3.0`；
  - DSH 每次发版当天重新生成并发版。

## 7. 实现情况（第二阶段）

基线 `main` @ c34cf27（worker-split、roster-overflow、create-lock、talk-to-lead 都已合入）。

### 7.1 结构

| 目录 / 文件 | 内容 |
|---|---|
| `src/dsh/compat.ts` | 两半共用：`features`（探测结果表）、`warnOnce`、`DshContractError`、`hasFunction` |
| `src/dsh/types.ts` | 业务用到的全部 DSH 类型，只从这里导入 |
| `src/dsh/host/runtime.ts` | `subagentPort`（startFork / startWorker / send / interrupt / drain）、`fork-from` provider 与 seed 表、`agentOptionsOf` |
| `src/dsh/host/agent.ts` | `isMainSession / mainIdOf / cwdOf`、inbox 操作、`statusOf`、`toLead` |
| `src/dsh/host/session.ts` | 插件记录读写、事件访问器（`turnEndOf / userMessageOf / toolCallOf / inboxSpliceOf / closingText`）、消息来源判断、`admitHidden` |
| `src/dsh/host/hints.ts` | 宿主文案：返回指引、转发前缀、容量错误码、委托深度提示 |
| `src/dsh/host/model.ts` | 成员模型：0.2.2 的 `agent.model.select` 与 0.2.1 的 `installModelSelection(ctx, ref)` 两套 |
| `src/dsh/host/services.ts` | `missingRequired`、`claimOnce`、`onAgents`、工具 / 守卫 / prompt 段 / 命令 / 投影注册、标题、模型校验、日志读取 |
| `src/dsh/host/version.ts` | `DSH_RANGE`、`hostVersion()` |
| `src/dsh/host/augment.ts` | `PluginRecordMap` 和投影表的声明合并 |
| `src/dsh/client/services.ts` | `clientHost(ctx)`：命令执行（两种返回形状）、命令探测、模型目录、子会话地址、投影 face、打开会话；`commandFailure` |
| `src/dsh/client/sidebar.ts` | 布局类型和形状校验 `layoutOf`、手势 `gesturesOf`、`retainChatTabs` |
| `src/dsh/client/dom.ts` | `SEL` 选择器表、`HOST_CSS`、`injectStyle`、`steadyTabStrips`、DOM 兜底 `chatPlacement` |
| `src/dsh/client/ui.ts` | `SLOT` 名、`registerSlot / registerChatEvent / registerTabType / configPage` |

业务模块（scheduler、rule-plugin、rounds、recovery、forks-from、member-model、records、projection、tools、fork-guard、client/*）不再直接 import 任何 `@deepseek-ai/dsh-*`，也不再出现宿主 DOM 属性名；`tests/contract/boundary.spec.ts` 守住这条边界。原来从业务模块导出的名字（`admitHidden`、`isCapacity`、`retainChatTabs`、`commandFailure` 等）保留为再导出，现有测试一条没改。

与第 2 节设计的差异：
- 文件名按内容分得更细：设计里的 `host.ts` 拆为 runtime / agent / session / services 等，`log.ts` 叫 `session.ts`。
- `SchedulerDeps.subagents` 仍收 `ctx.subagents`，由 Scheduler 内部包成 `subagentPort`，所以测试夹具不用改。
- `defaultOn` 配置项随旧预设删除；`SchedulerDeps.defaultOn` 仍保留给测试用。
- 没有做 `/agents doctor`：`features.report()` 已在，命令留到需要时再加。

### 7.2 契约测试与 CI

- `tests/contract/`：host-api、host-text、client-probe、packaging、adapter（降级）、boundary，共 35 条。
- 浏览器包和 `dsh-tool-subagent` 不加 devDependencies，由 `scripts/fetch-dsh.mjs <版本|tag>` 下载 tarball 解到 `.cache/dsh/<版本>/` 只读。`npm test` 下没下载时跳过这部分；`npm run contract` 先下载，并要求它们必须跑。
- `scripts/contract.mjs [tag]`：给 tag 时，把所有 `@deepseek-ai/dsh-*` devDependencies 换成该 tag，把 cordis / schemastery 换成那一版 `@deepseek-ai/dsh` 自带的范围，全新安装后跑 typecheck 和全部测试，结束后还原 `package.json`、lockfile 和 `node_modules`。
- CI 新增 `contract` job：pinned / next 两档，next 不挡合并；另加每周一定时运行。

### 7.3 对 DSH 0.2.2-rc.1 跑出来的问题（都已在适配层里处理）

| 依赖点 | 0.2.2-rc.1 的变化 | 处理 |
|---|---|---|
| H17 成员模型 | `installModelSelection(ctx, ref)` 和 `ModelSelectionRef` 没了；改为 `agent.model.select(selection)`，选择写进成员自己的日志 | `model.ts` 两套都支持，按 API 形状探测；因为选择会持久化，成员每次被重建时都重新确认一次（包括「已恢复默认」），选择没变时不写日志 |
| H16 投影注册 | `register()` 改为返回 Promise 形式的 disposer | 适配层接受两种返回 |
| P2 peer 范围 | DSH 0.2.2 带 cordis ~4.1.0、schemastery ~3.19.0，原 peer 范围（~4.0.5 / ~3.18.5）装不上 | peer 放宽为 `~4.0.5 \|\| ~4.1.0`、`~3.18.5 \|\| ~3.19.0`，`packaging.spec.ts` 校验 |
| P3 预设拷贝 | 删了 `tool-subagent-control/list-agents` 模块 | 本次已不再拷贝预设，不受影响 |

修完后：pinned（0.2.1-rc.5）200/200 通过；next（0.2.2-rc.1）通过，其中 1 条 P2 范围检查按设计跳过。

**未解决（偶发，只在 0.2.2）**：`tests/recovery.spec.ts`「fails the cut-off request once … also across a second restart」在 next 上偶尔失败。第二次 resume 主会话时，0.2.2 的持久化报 `released v2 row 6 has seq gap (expected 6, got 5)`，拒绝打开日志；本地一次超时、一次 CI 失败，其余几次都通过。像是上一代主会话在 shutDown 之后还有一次延迟写入（结算或退役的定时器），0.2.1 对此宽容，0.2.2 会校验。这不在适配层范围内，留作单独排查：先确认 scheduler 在主会话 dispose 之后是否还会写入它。

### 7.4 真实 DSH 验证

在隔离的 `DSH_HOME=/tmp/dshhome-probe` 里，把构建好的插件装进 web profile，用宿主的 HTTP API 驱动（没有碰 `~/.dsh`）。在一个 `standard` 预设的会话里：
- `/schedule on` 成功；
- 一条用户消息被交给 `fork-1`，输入记录写进了日志；
- 分身有全部 `agent_*` 工具和 `# Agent Scheduler` 段；
- 分身的模型调用因没有 API key 失败后，照常结算。
这证明顶层行能拿到所有预设 agent 的事件和注册。

