<p align="center">
  <img src="src/asset/img/deepseek.png" width="96" alt="PengCodex icon">
</p>

# PengCodex

[简体中文](./README.md) | English

> PengCodex is a local-first desktop AI workbench for code, writing, phone/IM automation, scheduled tasks, Skills, and MCP tools, all running through one observable and permission-aware agent environment.

[GitHub Releases](https://github.com/XingYu-Zhong/PengCodex/releases) | [Original DeepSeek-GUI project](https://github.com/XingYu-Zhong/DeepSeek-GUI)

[![License](https://img.shields.io/github/license/XingYu-Zhong/PengCodex)](./LICENSE)

PengCodex evolves from DeepSeek-GUI and the Kun local runtime. The new brand moves the project from "a DeepSeek desktop GUI" toward a more general AI workbench. DeepSeek remains the default and best-supported model/API provider, while the product name, packaging, default data paths, and documentation now center on PengCodex.

The project keeps the same local-first posture, inspectable changes, high token ROI, and multi-workbench collaboration model. Some internal `kun` folders, CLI names, and `agents.kun` settings keys remain as compatibility shims so existing data, scripts, and tests keep working during the transition. They will be gradually consolidated under PengCodex Core.

---

<p align="center">
  <a href="src/asset/img/code.mp4">
    <img src="src/asset/img/code.gif" width="410" alt="PengCodex Code mode demo">
  </a>
  <a href="src/asset/img/write.mp4">
    <img src="src/asset/img/write.gif" width="410" alt="PengCodex Write mode demo">
  </a>
</p>

## Core Capabilities

- **Code workbench**: point the agent at a local repo, then read, edit, run commands, plan, and review changes.
- **Write workbench**: manage Markdown writing spaces with live editing/preview, writing suggestions, selection-based inline agent actions, and export.
- **Connect phone**: use Feishu / Lark / WeChat and webhook flows so a background agent can handle messages and mobile workflows.
- **Scheduled tasks**: run one-time, daily, interval, or manual tasks with their own workspaces and threads.
- **Skills / MCP / external tools**: manage skills, external tool servers, and progressive tool selection from the UI.
- **High token ROI**: stabilize prompt prefixes, track model cache hits, compact tool results and history when useful, and keep context focused on requirements, code, decisions, and results.
- **Local-first storage**: settings, sessions, logs, runtime config, and writing spaces stay on your machine by default; model calls use your own API key.

## From DeepSeek-GUI To PengCodex

This is more than a rename:

- **Independent brand**: app name, package name, artifacts, window title, default data folders, and README now use PengCodex.
- **Provider-neutral direction**: DeepSeek stays first-class, while OpenAI-compatible Base URLs, model lists, and endpoint formats remain configurable.
- **Runtime narrative**: the former Kun local agent runtime is now described as PengCodex Core; `kun` remains an internal compatibility codename for now.
- **Workbench integration**: Code, Write, Connect phone, scheduled tasks, Skills, and MCP share the same local agent capability while keeping their own UI and data boundaries.
- **Evolvable architecture**: HTTP/SSE boundaries, append-only session logs, cache-first loops, approvals, context compaction, and capability flags remain the foundation.

## Workbenches

### Code

The development workbench for real codebases. Bind a local directory, describe a task, watch reasoning/tool calls/commands/file changes, and approve sensitive actions when needed.

<p align="center">
  <img src="src/asset/img/codemode.png" alt="PengCodex Code mode" width="860">
</p>

Code includes `/plan`, requirement drafts, thread todos, `/goal`, `/review`, side conversations, compaction, thread forks, archive, and restore.

### Write

A dedicated Markdown writing workbench that separates files, editor state, previews, writing suggestions, quoted selections, and the writing assistant from code conversations.

<p align="center">
  <img src="src/asset/img/writemode.png" alt="PengCodex Write mode" width="860">
</p>

Write supports live/source/split/preview views, `HTML / PDF / DOC / DOCX` export, and lightweight retrieval over documents in the same writing space.

### Connect Phone And Scheduled Tasks

Connect phone lets PengCodex handle IM messages, webhooks, and automation outside normal desktop chat. Scheduled tasks run while the computer is awake and store results in dedicated threads.

<p align="center">
  <img src="src/asset/img/clawmode.png" alt="PengCodex Connect phone" width="860">
</p>

## Install

### Download A Pre-built Package

Download the latest build from [GitHub Releases](https://github.com/XingYu-Zhong/PengCodex/releases):

| Platform | Package |
| --- | --- |
| macOS | `.dmg` or `.zip`, Intel and Apple Silicon |
| Windows | `.exe`, NSIS installer, x64 |
| Linux | `.AppImage`, x64 |

On first launch, configure a model API key. DeepSeek is the default provider; compatible OpenAI/DeepSeek services can be configured with custom Base URL, model, and endpoint format values.

### Run From Source

```bash
git clone https://github.com/XingYu-Zhong/PengCodex.git
cd PengCodex
npm install
npm run dev
```

Requirements:

- Node.js 20+
- A model API key
- Internet access for the first dependency install

For slower network access in mainland China:

```bash
npm install --registry=https://registry.npmmirror.com
```

## Local Data And Compatibility

New PengCodex installs use:

| Type | Default path |
| --- | --- |
| App data | the system app data directory for `PengCodex` |
| Default workspace | `~/.pengcodex/default_workspace` |
| Default writing space | `~/.pengcodex/write_workspace` |
| Local runtime data | `~/.pengcodex/runtime` |
| Settings file | `pengcodex-settings.json` |

To protect existing users, PengCodex can read old `DeepSeek GUI` / `deepseek-gui` app data folders and `deepseek-gui-settings.json`. The old default `~/.deepseekgui/kun` runtime path migrates to the new default; explicit custom paths remain unchanged.

## Development

```bash
npm run build           # production build
npm run typecheck       # TypeScript typecheck
npm run test            # unit tests
npm run dist:mac        # macOS packages
npm run dist:win        # Windows installer
npm run dist:linux      # Linux AppImage
```

Release scripts now prefer `PENGCODEX_*` environment variables and keep compatibility with older `DEEPSEEK_GUI_*` variables.

## Roadmap

- **Brand cleanup**: continue removing old DeepSeek-GUI / Kun public-facing names while preserving compatibility migrations.
- **PengCodex Core**: migrate local runtime naming, CLI, config, and diagnostics from the internal `kun` codename to PengCodex Core.
- **Multi-model experience**: improve DeepSeek, OpenAI-compatible, Responses, and Messages endpoint configuration with better capability detection and routing.
- **Tool ecosystem**: expand Skill installation, Skill selection, MCP filtering, web access, and delegated subagents.
- **Writing and project flow**: refine requirement drafts, plans, todos, goals, code review, and writing-space handoffs.
- **Mobile and automation**: improve IM/phone connections, scheduled tasks, webhook/relay flows, and background task observability.
- **Release quality**: harden cross-platform packaging, auto updates, migrations, logs, and regression tests.

## Thanks

PengCodex stands on the shoulders of earlier work:

- **[DeepSeek-GUI](https://github.com/XingYu-Zhong/DeepSeek-GUI)**: thank you to the original project for the desktop workbench, DeepSeek integration, cross-platform packaging, and GUI foundation. PengCodex is a brand upgrade and product evolution built on that base.
- **Kun / Reasonix design prototypes**: thank you for the local runtime and cache-first agent loop foundations, including stable prefixes, append-only session logs, context compaction, tool pairing, usage accounting, and cache-hit telemetry.
- **[LobsterAI](https://github.com/netease-youdao/LobsterAI)**: IM management, QR binding, agent binding, and phone-connection flows inspired this project's mobile automation.
- **OpenHanako**: Markdown live editing, writing spaces, and selection inline-agent patterns informed Write mode.
- **[DeepSeek](https://github.com/deepseek-ai)**: for the models and API.
- Everyone who contributes issues, ideas, code, docs, and testing feedback.

> [!NOTE]
> PengCodex is not affiliated with DeepSeek Inc. DeepSeek is one of the model/API providers supported by this project.

## License

[MIT](./LICENSE)
