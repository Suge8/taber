# Taber

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A supervised browser agent that runs in a Chrome/Edge side panel. It reads pages, extracts documents and images, navigates across tabs, fills ordinary forms, and explains page failures — while you watch from the side panel and can stop it anytime. Work continues in an offscreen host after the panel closes.

> **Languages**: [English](#english) · [中文](#中文)

---

## English

### Features

- **Supervised, interruptible** — tools run automatically, you pause or stop at any point; no per-step approval.
- **Offscreen AgentHost** — the agent loop lives in a hidden extension page, so tasks survive closing the side panel.
- **Narrow tool boundary** — a small fixed set of tools: document extraction, image extraction, navigation, and a controlled browser REPL. No open-ended Extension API bridge.
- **Local-first event log** — every message, tool call, and state change is persisted in Dexie (IndexedDB) and the UI is rebuilt from that log.
- **Provider-agnostic** — bring any OpenAI-compatible endpoint, or authenticate with a ChatGPT/Codex provider via PKCE. Credentials stay local.
- **Least-privilege store build** — no default `<all_urls>` host permission, no `debugger` permission in the shipped build. The debugger tool is only available in a local debug build.

### Requirements

- Node.js `>= 22.6` (tests use native type stripping)
- pnpm `>= 9`
- Chrome or Edge `>= 135`

### Install (development)

```bash
git clone <your-repo-url> taber
cd taber
pnpm install
pnpm build:chrome      # produces .output/chrome-mv3
```

Then load it as an unpacked extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`
4. Open the side panel (Alt+E on macOS: ⌘E)

For Edge, replace `build:chrome` with `build:edge` and load `.output/edge-mv3`.

For live reload during development:

```bash
pnpm dev                # WXT dev mode with hot reload
pnpm dev:debug          # same, with debugger tool enabled
```

### Usage

Open the side panel on any page, pick a model provider in settings, then describe a task — e.g. "summarize this page", "extract the pricing table", or "fill the contact form on this page". You can watch each tool call in the timeline and stop the task whenever you want.

### Testing

```bash
pnpm run test:unit     # ~20 unit suites via node --experimental-strip-types
pnpm run test:e2e      # deterministic in-process E2E scenarios
pnpm run test:ci       # full pipeline: build + typecheck + unit + e2e + DB integration
pnpm run test:ci:runtime  # optional real-browser smoke (requires local Chrome + secrets)
```

### Security notes

- The shipped (store) build never requests `debugger` and never reads cookies. Only a `TABER_ENABLE_DEBUGGER=1` local build exposes the debugger tool.
- Model provider credentials are stored locally in the extension's IndexedDB and never leave the device except to call the provider you configured.
- `browserjs` (page-script execution) runs only after you explicitly consent in **Browser Access** onboarding, and only on the page `MAIN` runtime.

See [`SECURITY.md`](SECURITY.md) for the disclosure policy.

### Architecture

Architectural decisions are recorded as ADRs in [`docs/adr/`](docs/adr/). Module map is in [`AGENTS.md`](AGENTS.md). Product and design context in [`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md).

### Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

### License

Apache License 2.0. See [`LICENSE`](LICENSE).

---

## 中文

### 功能

- **有人监督、可中断** — 工具默认自动执行，你随时暂停或停止；不做逐步审批。
- **Offscreen AgentHost** — Agent 主循环跑在隐藏的扩展页面里，关掉侧边栏后任务继续。
- **狭窄工具边界** — 一组小而固定的工具：文档提取、图片提取、导航、受控的浏览器 REPL。没有无边界 Extension API bridge。
- **本地优先事件日志** — 每条消息、工具调用、状态变更都用 Dexie（IndexedDB）持久化，UI 从日志重建。
- **供应商无关** — 接任意 OpenAI 兼容 endpoint，或通过 PKCE 登录 ChatGPT/Codex。凭证只存本地。
- **最小权限上架构建** — 上架版默认无 `<all_urls>` host 权限，无 `debugger` 权限。debugger 工具只在本地 debug 构建里。

### 环境要求

- Node.js `>= 22.6`（测试用原生 type stripping）
- pnpm `>= 9`
- Chrome 或 Edge `>= 135`

### 安装（开发）

```bash
git clone <你的仓库地址> taber
cd taber
pnpm install
pnpm build:chrome      # 产物在 .output/chrome-mv3
```

加载为未打包扩展：

1. 打开 `chrome://extensions`
2. 打开 **开发者模式**
3. **加载已解压的扩展程序** → 选 `.output/chrome-mv3`
4. 打开侧边栏（Alt+E，macOS 为 ⌘E）

Edge 把 `build:chrome` 换成 `build:edge`，加载 `.output/edge-mv3`。

开发热重载：

```bash
pnpm dev                # WXT dev 模式
pnpm dev:debug          # 同上，开启 debugger 工具
```

### 使用

在任意页面打开侧边栏，在设置里选好模型供应商，然后描述任务——比如"总结这个页面"、"提取价格表"、"填写本页的联系表单"。你可以在工具时间线上看每一步在做什么，随时停掉任务。

### 测试

```bash
pnpm run test:unit     # 约 20 个单元套件，用 node --experimental-strip-types
pnpm run test:e2e      # 进程内确定性 E2E 场景
pnpm run test:ci       # 全流水线：构建 + 类型检查 + 单元 + E2E + DB 集成
pnpm run test:ci:runtime  # 可选真实浏览器冒烟（需本地 Chrome 和密钥）
```

### 安全说明

- 上架版绝不请求 `debugger`、绝不读 cookie。只有 `TABER_ENABLE_DEBUGGER=1` 的本地构建才暴露 debugger 工具。
- 模型供应商凭证只存扩展的 IndexedDB，除调用你配置的供应商外不出本机。
- `browserjs`（页面脚本执行）只在你在 **Browser Access** 引导里明确同意后启用，且只在页面 `MAIN` runtime 运行。

披露流程见 [`SECURITY.md`](SECURITY.md)。

### 架构

架构决策以 ADR 形式记录在 [`docs/adr/`](docs/adr/)。模块地图在 [`AGENTS.md`](AGENTS.md)。产品与设计背景见 [`PRODUCT.md`](PRODUCT.md) 和 [`DESIGN.md`](DESIGN.md)。

### 贡献

欢迎贡献，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

### 许可证

Apache License 2.0，见 [`LICENSE`](LICENSE)。
