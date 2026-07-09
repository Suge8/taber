<p align="center">
  <img src="public/brand/taber-logo.webp" width="112" alt="Taber logo">
</p>

<h1 align="center">Taber</h1>

<p align="center">
  <strong>A browser agent side panel for Chrome and Edge.</strong><br>
  Read pages → extract documents and images → use the browser → keep the trail local.<br>
  Chrome / Edge 侧边栏浏览器 Agent：读页面、提取文档和图片、操作浏览器，并在本机保留过程记录。
</p>

<p align="center">
  <a href="#english">🇺🇸 English</a> · <a href="#中文">🇨🇳 中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

---

## English

Taber gives you a browser agent inside the side panel. Open a page, describe the task, and let Taber read, extract, navigate, click, fill, and explain the result with a visible tool trail.

### Highlights

- **Read the current page**: articles, full pages, selections, tables, PDFs, and text files.
- **Work with visuals**: viewport screenshots, page images, canvas output, and background images.
- **Use the browser**: navigate, click, fill, scroll, wait, and inspect page state through a small fixed tool set.
- **Bring your model**: OpenAI API key, OpenAI-compatible endpoint, ChatGPT/Codex subscription login, or xAI/Grok subscription login.
- **Keep context local**: sessions, messages, credentials, and tool events stay in the extension database.
- **Low-permission release build**: no `debugger` permission; website access is granted during Browser Access setup.

### Install from GitHub Release

1. Download `taber-v0.2.1-chrome-mv3.zip` from the latest GitHub Release.
2. Unzip it. Chrome cannot load the zip directly.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder that contains `manifest.json`.
7. Open Taber from the browser side panel. Default shortcut: `Alt+E`, or `⌘E` on macOS.

### Start

1. Open a page you want Taber to work on.
2. Open the side panel.
3. Choose a provider in settings:
   - OpenAI API key
   - OpenAI-compatible endpoint
   - ChatGPT/Codex subscription login
   - xAI/Grok subscription login
4. Complete Browser Access setup when Taber asks for website access.
5. Ask a task:

```text
Summarize this page.
Extract the pricing table.
Find the signup form and fill the basic fields.
Compare the visible plans and list the tradeoffs.
```

### Privacy and permissions

- The release build does not request `debugger` and does not read cookies.
- Model credentials stay in IndexedDB. Taber uses them only for the provider you select.
- Page content, screenshots, documents, prompts, and tool results can be sent to the selected model provider to complete your task.
- `browserjs` page-script execution only runs after you enable it in Browser Access.

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

<details>
<summary>Advanced: build, package, test</summary>

#### Requirements

- Node.js `>= 22.19`
- pnpm `>= 10.23`
- Chrome or Edge `>= 135`

#### Build from source

```bash
git clone <your-repo-url> taber
cd taber
pnpm install
pnpm build:chrome
```

Load `.output/chrome-mv3` as an unpacked extension in `chrome://extensions`.

For Edge:

```bash
pnpm build:edge
```

Load `.output/edge-mv3` in `edge://extensions`.

#### Development

```bash
pnpm dev
pnpm dev:debug  # local debugger build
```

#### Package a Chrome release

```bash
pnpm run zip:chrome
```

Upload `.output/taber-v0.2.1-chrome-mv3.zip` to the GitHub Release.

#### Verify

```bash
pnpm run test:unit
pnpm run test:e2e
pnpm run test:ci
pnpm run test:ci:runtime  # optional real-browser smoke
```

#### Project docs

- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Module map: [`AGENTS.md`](AGENTS.md)
- Product and design context: [`PRODUCT.md`](PRODUCT.md), [`DESIGN.md`](DESIGN.md)
- Contributions: [`CONTRIBUTING.md`](CONTRIBUTING.md)

</details>

---

## 中文

Taber 把浏览器 Agent 放进侧边栏。打开页面，输入任务，Taber 可以阅读、提取、导航、点击、填写，并用可见的工具轨迹说明过程和结果。

### 亮点

- **读取当前页面**：文章、整页、选中文本、表格、PDF 和文本文件。
- **处理视觉内容**：当前视口截图、页面图片、canvas 和 background image。
- **操作浏览器**：导航、点击、填写、滚动、等待和页面检查，能力收在一组固定工具里。
- **连接你的模型**：OpenAI API key、OpenAI-compatible endpoint、ChatGPT/Codex 订阅登录、xAI/Grok 订阅登录。
- **本地保存上下文**：会话、消息、凭证和工具事件保存在扩展数据库里。
- **发布版低权限**：不带 `debugger` 权限；站点访问在 Browser Access 里授权。

### 从 GitHub Release 安装

1. 在最新 GitHub Release 下载 `taber-v0.2.1-chrome-mv3.zip`。
2. 解压。Chrome 不能直接加载 zip。
3. 打开 `chrome://extensions`。
4. 打开 **开发者模式**。
5. 点击 **加载已解压的扩展程序**。
6. 选择包含 `manifest.json` 的解压文件夹。
7. 从浏览器侧边栏打开 Taber。默认快捷键：`Alt+E`，macOS 是 `⌘E`。

### 开始使用

1. 打开你要让 Taber 处理的网页。
2. 打开侧边栏。
3. 在设置里选择供应商：
   - OpenAI API key
   - OpenAI-compatible endpoint
   - ChatGPT/Codex 订阅登录
   - xAI/Grok 订阅登录
4. 按提示完成 Browser Access 站点访问授权。
5. 输入任务：

```text
总结这个页面。
提取价格表。
找到注册表单，填写基础字段。
对比页面上的套餐，列出取舍。
```

### 隐私与权限

- 发布版不请求 `debugger`，不读取 cookie。
- 模型凭证保存在 IndexedDB，只用于调用你选择的供应商。
- 为完成任务，Taber 可能把页面内容、截图、文档、提示词和工具结果发给你选择的模型供应商。
- `browserjs` 页面脚本只在你在 Browser Access 里开启后运行。

漏洞报告见 [`SECURITY.md`](SECURITY.md)。

<details>
<summary>高级：源码构建、打包、测试</summary>

#### 环境要求

- Node.js `>= 22.19`
- pnpm `>= 10.23`
- Chrome 或 Edge `>= 135`

#### 从源码构建

```bash
git clone <你的仓库地址> taber
cd taber
pnpm install
pnpm build:chrome
```

在 `chrome://extensions` 里加载 `.output/chrome-mv3`。

Edge：

```bash
pnpm build:edge
```

在 `edge://extensions` 里加载 `.output/edge-mv3`。

#### 开发

```bash
pnpm dev
pnpm dev:debug  # 本地 debugger 构建
```

#### 打包 Chrome Release

```bash
pnpm run zip:chrome
```

把 `.output/taber-v0.2.1-chrome-mv3.zip` 上传到 GitHub Release。

#### 验证

```bash
pnpm run test:unit
pnpm run test:e2e
pnpm run test:ci
pnpm run test:ci:runtime  # 可选真实浏览器冒烟
```

#### 项目文档

- 更新日志：[`CHANGELOG.md`](CHANGELOG.md)
- 架构决策：[`docs/adr/`](docs/adr/)
- 模块地图：[`AGENTS.md`](AGENTS.md)
- 产品与设计背景：[`PRODUCT.md`](PRODUCT.md)、[`DESIGN.md`](DESIGN.md)
- 贡献指南：[`CONTRIBUTING.md`](CONTRIBUTING.md)

</details>

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).
