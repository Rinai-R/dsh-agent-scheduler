<p align="center">
  <img src="icon.svg" width="64" height="64" alt="Agent Scheduler logo">
</p>

<h1 align="center">Agent Scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">Every message gets its own fork; every area gets its own worker.</p>

Agent Scheduler is an open source plugin for DeepSeek Harness (dsh). It turns the main conversation into a dispatcher: a fresh fork routes each message, and long-lived workers do the work in their own sessions. Every answer comes back to the lead, the only agent you read.

- **A fork per message:** With scheduling on, the lead is never blocked; each message gets its own fork.
- **Long-lived workers:** One per repository or module, with its own session, directory and model.
- **Split and merge:** A busy worker splits on a conflicting task, and the halves merge back later.
- **Agents page:** Live state, unread dots, and a lead inbox you can reorder.
- **Worker teams:** With Agent Teams on, each worker can lead a team of its own.
- **8 languages:** The interface follows dsh's language setting.

## Getting Started

### Prerequisites

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`

### Plugin

In dsh, open **Plugins → Install a third-party plugin** and enter `dsh-agent-scheduler`. Or from the terminal:

```bash
dsh plugin add dsh-agent-scheduler@next
```

Restart dsh. The 「调度」 (Scheduling) chip appears in the composer.

### Use

Click 「调度」 or run `/schedule on`. Open the Agents page from the button beside it. `/schedule off` hands messages back to the lead; workers keep running.

Main commands: `/schedule`, `/agents`, `/worker model`, `/role`. See the [guide](docs/guide.md) for everything else: tools, how it works, configuration, recovery and limitations.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm run contract       # against the pinned dsh
npm run contract:next  # against npm's next dsh
```

## License

MIT.
