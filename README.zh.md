<p align="center">
  <img src="icon.svg" width="64" height="64" alt="Agent Scheduler logo">
</p>

<h1 align="center">Agent Scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">每条消息一个分身，每个领域一个 worker。</p>

Agent Scheduler 是 DeepSeek Harness（dsh）的开源插件。它把主会话变成调度台：每条消息由一个新分身派活，长期 worker 在各自的会话里干活。所有答复都回到 lead，你只需读 lead 的回复。

- **每条消息一个分身：** 调度打开时，lead 不会被输入卡住，每条消息交给自己的分身。
- **长期 worker：** 一个仓库或模块一个，各有会话、目录和模型。
- **拆分与合并：** worker 忙时遇到新任务就拆分，之后可以合回一个。
- **Agents 页：** 实时状态、未读圆点，以及可排序的 lead 收件箱。
- **worker 团队：** 开启「智能体团队」后，每个 worker 都能组建自己的团队。
- **8 种语言：** 界面跟随 dsh 的语言设置。

## 开始使用

### 前置要求

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`

### 安装插件

在 dsh 里打开 **插件 → 安装第三方插件**，输入 `dsh-agent-scheduler`。或在终端运行：

```bash
dsh plugin add dsh-agent-scheduler@next
```

重启 dsh，输入框旁会出现「调度」按钮。

### 使用

点「调度」或运行 `/schedule on`，再点旁边的按钮打开 Agents 页。`/schedule off` 把消息交还给 lead，worker 照常运行。

主要命令：`/schedule`、`/agents`、`/worker model`、`/role`。工具、工作方式、配置、重启恢复和已知限制见[使用指南](docs/guide.zh.md)。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm test
npm run contract       # 对照锁定版本的 dsh
npm run contract:next  # 对照 npm 上 next 版本的 dsh
```

## 许可

MIT。
