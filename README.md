<p align="center">
  <img src="src/asset/img/deepseek.png" width="96" alt="PengCodex 图标">
</p>

# PengCodex

[English](./README.en.md) | 简体中文

> PengCodex 是一个本地优先的桌面 AI 工作台：把代码协作、写作编辑、手机/IM 自动化、定时任务、Skill 与 MCP 工具统一在同一个可观察、可审批、可长期运行的 Agent 环境里。

[GitHub Releases](https://github.com/XingYu-Zhong/PengCodex/releases) | [原项目 DeepSeek-GUI](https://github.com/XingYu-Zhong/DeepSeek-GUI)

[![License](https://img.shields.io/github/license/XingYu-Zhong/PengCodex)](./LICENSE)

PengCodex 从 DeepSeek-GUI 与 Kun 本地运行时演进而来。新的品牌把项目从“DeepSeek 的桌面 GUI”推进为更通用的 AI 工作台：DeepSeek 仍然是默认且重点支持的模型/API 提供方，但应用的产品定位、打包命名、默认数据目录与文档叙事都转向 PengCodex。

项目继续保留本地优先、可审查改动、高 Token ROI、多工作台协作这些核心路线。内部仍有少量 `kun` 目录、CLI 和 `agents.kun` 设置键作为兼容层，避免旧用户数据、脚本和测试在品牌迁移中断裂；后续会逐步把这些内部代号收敛到 PengCodex Core。

---

<p align="center">
  <a href="src/asset/img/code.mp4">
    <img src="src/asset/img/code.gif" width="410" alt="PengCodex Code 模式演示">
  </a>
  <a href="src/asset/img/write.mp4">
    <img src="src/asset/img/write.gif" width="410" alt="PengCodex 写作模式演示">
  </a>
</p>

## 核心能力

- **Code 工作台**：选择本地项目目录，让 Agent 阅读、编辑、运行命令、生成计划并审查改动。
- **Write 写作台**：管理 Markdown 写作空间，支持 live 编辑/预览、写作建议、选区 inline agent 与文档导出。
- **连接手机**：通过飞书 / Lark / 微信等 IM 入口，让后台 Agent 处理消息、webhook 与移动端协作。
- **定时任务**：按一次性、每日、间隔或手动计划执行任务，并将结果沉淀到独立会话。
- **Skill / MCP / 外部工具**：在图形界面管理技能、外部工具连接和工具筛选策略。
- **开发工具编排**：按需开启 Browser Use、Computer Use、LSP、子 Agent DAG 与声明式 Extension；这些高权限能力默认关闭并沿用审批、工作区和白名单边界。
- **高 Token ROI**：稳定 prompt 前缀，跟踪模型缓存命中，按需压缩工具结果和历史上下文，把 token 留给需求、代码、决策和结果。
- **本地优先**：设置、会话、日志、运行时配置和写作空间默认保存在本机，模型调用使用你自己的 API Key。

## 从 DeepSeek-GUI 到 PengCodex

这次品牌升级不是简单改名，而是把项目方向重新整理成一个更清晰的产品：

- **品牌独立**：应用名、包名、打包产物、窗口标题、默认数据目录和 README 统一为 PengCodex。
- **模型提供方泛化**：默认支持 DeepSeek，同时保留 OpenAI-compatible Base URL、模型列表和端点格式配置。
- **运行时叙事升级**：原 Kun 本地 Agent 能力在新叙事中称为 PengCodex Core；现阶段保留 `kun` 作为内部兼容代号。
- **工作台整合**：Code、Write、连接手机、定时任务、Skill/MCP 共用同一套本地 Agent 能力，但在界面和数据上保持清晰分工。
- **可演进架构**：保留 HTTP/SSE 边界、append-only 会话日志、缓存优先循环、工具审批、上下文压缩和能力开关，为后续多模型、多工具、多端协作铺路。

## 工作台概览

### Code

面向真实代码库的开发工作台。你可以绑定一个本地目录，描述目标，观察 Agent 的推理、工具调用、命令执行和文件变更，并在需要时审批敏感操作。

<p align="center">
  <img src="src/asset/img/codemode.png" alt="PengCodex Code 模式" width="860">
</p>

常用能力包括 `/plan` 计划、需求草稿、线程 Todo、`/goal` 长期目标、`/review` 代码审查、旁支对话、会话压缩、会话分叉和归档恢复。

### Write

独立的 Markdown 写作工作台。它把文件树、编辑器、预览、写作建议、选区引用和写作助手从代码会话里拆出来，适合长期维护文档、方案和文章。

<p align="center">
  <img src="src/asset/img/writemode.png" alt="PengCodex Write 模式" width="860">
</p>

Write 支持 live/source/split/preview 视图，支持 `HTML / PDF / DOC / DOCX` 导出，并可通过轻量检索参考同一写作空间里的其他文档。

### 连接手机与定时任务

连接手机让 PengCodex 在桌面聊天之外处理 IM 消息、webhook 和自动化任务。定时任务可配置工作区、模型、推理强度和执行计划，让 Agent 在电脑唤醒时自动运行。

<p align="center">
  <img src="src/asset/img/clawmode.png" alt="PengCodex 连接手机" width="860">
</p>

## 安装与运行

### 下载预构建包

前往 [GitHub Releases](https://github.com/XingYu-Zhong/PengCodex/releases) 下载最新版本：

| 平台 | 安装包 |
| --- | --- |
| macOS | `.dmg` 或 `.zip`，支持 Intel 与 Apple Silicon |
| Windows | `.exe`，NSIS 安装器，x64 |
| Linux | `.AppImage`，x64 |

首次启动需要配置模型 API Key。默认使用 DeepSeek 官方 API；如果你使用兼容 OpenAI/DeepSeek 的服务，也可以在设置里修改 Base URL、模型和端点格式。

安装包会提供 `pengcodex` 命令：Windows 安装/卸载时同步用户 `PATH`，macOS 与 Ubuntu 在首次启动时创建用户级 launcher 并更新对应 shell profile。新开一个终端后可直接运行：

```bash
pengcodex --help
pengcodex runtime status --data-dir ~/.pengcodex/runtime
pengcodex extension list --data-dir ~/.pengcodex/runtime
```

旧的 `kun` 命令仍作为兼容别名保留。CLI 复用应用自带运行时，不要求用户另装 Node.js。

### 从源码运行

```bash
git clone https://github.com/XingYu-Zhong/PengCodex.git
cd PengCodex
npm install
npm run dev
```

环境要求：

- Node.js 20+
- 可用的模型 API Key
- 首次安装依赖时需要联网

中国大陆网络较慢时可使用 npm 镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

## 本地数据与兼容

PengCodex 新安装默认使用：

| 类型 | 默认路径 |
| --- | --- |
| 应用数据 | `PengCodex` 对应的系统应用数据目录 |
| 默认工作区 | `~/.pengcodex/default_workspace` |
| 默认写作空间 | `~/.pengcodex/write_workspace` |
| 本地运行时数据 | `~/.pengcodex/runtime` |
| 设置文件 | `pengcodex-settings.json` |

为了保护已有用户数据，应用会兼容读取旧的 `DeepSeek GUI` / `deepseek-gui` 应用数据目录和 `deepseek-gui-settings.json`。旧的 `~/.deepseekgui/kun` 默认运行时目录会迁移到新的默认目录；用户显式配置的自定义路径仍按原配置使用。

## 本地开发

```bash
npm run build           # 生产构建
npm run typecheck       # TypeScript 类型检查
npm run test            # 单元测试
npm run dist:mac        # macOS 安装包
npm run dist:win        # Windows 安装包 + portable 便携版
npm run dist:win:portable # 仅构建 Windows portable 便携版
npm run dist:linux      # Linux AppImage
```

需要从 GitHub 自行发布 Windows 测试包时，在 Actions 中运行 `Windows Release`。该 workflow 固定检出
`master`，可填写 `x.y.z` 版本号（留空则自动递增 patch 版本），并将安装版 EXE、portable EXE 和更新元数据
挂载到对应的 GitHub Release。测试发布建议保留默认的 prerelease 选项。

发布脚本现在优先读取 `PENGCODEX_*` 环境变量，并兼容旧的 `DEEPSEEK_GUI_*` 变量。

## 演进路线

- **品牌收口**：继续清理代码、文档、日志和发布流程中的旧 DeepSeek-GUI / Kun 外部露出，保留必要兼容迁移。
- **PengCodex Core**：把本地运行时的命名、CLI、配置和诊断逐步从内部 `kun` 代号迁移到 PengCodex Core。
- **多模型体验**：完善 DeepSeek、OpenAI-compatible、Responses/Messages 等端点配置，强化模型能力探测和默认路由。
- **工具生态**：增强 Skill 安装、Skill 选择、MCP 工具筛选、Web 访问和子 Agent 委派，让扩展能力更容易管理。
- **写作与项目流**：继续打磨需求草稿、计划、Todo、目标、代码审查和写作空间之间的闭环。
- **移动与自动化**：扩展 IM/手机连接、定时任务、webhook/relay 和后台任务可观测性。
- **发布质量**：完善跨平台打包、自动更新、迁移验证、错误日志和回归测试。

## 致谢

PengCodex 站在原项目和多个先行项目的肩膀上：

- **[DeepSeek-GUI](https://github.com/XingYu-Zhong/DeepSeek-GUI)**：感谢原项目提供桌面工作台、DeepSeek 接入、跨平台打包和 GUI 体验基础。PengCodex 是在此基础上的升级与产品演进。
- **Kun / Reasonix 设计原型**：感谢原本地运行时与 cache-first agent loop 的设计积累，包括稳定前缀、append-only 会话日志、上下文压缩、工具调用配对、用量统计和缓存命中观测。
- **[LobsterAI](https://github.com/netease-youdao/LobsterAI)**：IM 管理、扫码绑定、Agent 绑定和连接手机流程给了本项目重要启发。
- **OpenHanako**：Markdown live 编辑、写作空间和选区 inline agent 的交互方案为 Write 模式提供了参考。
- **[DeepSeek](https://github.com/deepseek-ai)**：提供模型与 API 能力。
- 所有提交 issue、建议、代码、文档和测试反馈的贡献者。

> [!NOTE]
> PengCodex 与 DeepSeek Inc. 无隶属关系。DeepSeek 是本项目默认支持的模型/API 提供方之一。

## 许可证

[MIT](./LICENSE)
