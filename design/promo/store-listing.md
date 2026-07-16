# Chrome Web Store listing 文案

事实源：`README.md`、`docs/store-compliance.md`。提交时按商店字段粘贴；修改产品能力后同步更新此文件。

## 名称（≤75 字符）

- EN: `Taber — Browser Agent Side Panel`
- 中文: `Taber — 会动手的浏览器 Agent`

## 简述 Summary（≤132 字符）

- EN: `A browser agent that acts: reads pages, clicks, fills forms, works with documents — every step visible in your side panel.`
- 中文: `会动手的浏览器 Agent：读页面、点按钮、填表单、读写文档，每一步都在侧边栏里可见、可停。`

## 详细描述 — English

```
Taber is a browser agent that lives in your Chrome side panel. Give it a task and it works your browser the way you would: reading pages, clicking buttons, filling forms, opening tabs, collecting data, and producing documents.

WHAT YOU CAN ASK

• "Summarize this page and save it as summary.md"
• "Extract the pricing tables and compare the plans across these three tabs"
• "Turn the PDF I uploaded into a Word report"
• "Get today's top 10 Hacker News posts with titles and links"
• "Find the signup form, fill the basic fields, and stop before submitting"

EVERY STEP IS EVIDENCE

Each click, read, and navigation lands in an inspectable timeline. Watch it work live, stop it at any moment, and review exactly what it did afterwards. No raw chain-of-thought, no black box.

WHY TABER

• It acts, not just chats — most AI side panels reply with instructions; Taber does the work.
• Uses your logged-in sessions — works on sites you are already signed into, right in your browser.
• Documents in and out — upload PDF/Word/text; get Markdown, HTML, CSV, or Word back, downloadable from the panel.
• Site skills — flows that worked are saved locally as skills, so it gets faster on sites you use often. Ships with API shortcuts for Hacker News, Reddit, GitHub, Wikipedia, Stack Exchange, npm, PyPI, and arXiv.
• Bring your own model — OpenAI API key, any OpenAI-compatible endpoint, or sign in with your ChatGPT/Codex or xAI/Grok subscription.
• Local and least-privilege — sessions, credentials, files, and skills stay in the extension's local database. The store build requests no debugger permission and reads no cookies.

PRIVACY

To complete your tasks, page content, screenshots, documents, and prompts are sent only to the model provider you configure. Nothing else leaves your machine. Site access is optional and granted by you during onboarding.

Taber is open source: https://github.com/Suge8/taber
```

## 详细描述 — 中文

```
Taber 是长在 Chrome 侧边栏里的浏览器 Agent。任务发出去，它像你一样操作浏览器：读页面、点按钮、填表单、开标签页、抓取数据、生成文档。

你可以这样用

• "总结这个页面，存成 summary.md"
• "提取价格表，对比这三个标签页里的套餐"
• "把我上传的这份 PDF 整理成 Word 报告"
• "去 HN 抓今天前 10 条，给我标题和链接"
• "找到注册表单，填好基础字段，提交前停下让我确认"

每一步都是证据

每次点击、阅读、跳转都会进入可展开的时间线。全程可看、随时可停，事后可以逐步核查它做了什么。不展示原始思维链，也没有黑盒。

为什么选 Taber

• 会动手，不只会聊——多数 AI 侧边栏回你一段教程，Taber 直接把事做完。
• 用你已登录的账号——在你已经登录的网站上直接干活，不用重新登录云端浏览器。
• 文档进出——上传 PDF/Word/文本，产出 Markdown / HTML / CSV / Word，侧边栏一键下载。
• 站点技能——跑通的流程存成本地技能，常用网站越用越快；内置 HN、Reddit、GitHub、Wikipedia、Stack Exchange、npm、PyPI、arXiv 八条 API 捷径。
• 模型自由——OpenAI API key、OpenAI-compatible 端点、ChatGPT/Codex 订阅、xAI/Grok 订阅，任选一种。
• 本地与低权限——会话、凭证、文件、技能全存在扩展本地数据库；发布版不带 debugger 权限，不读 cookie。

隐私

为完成任务，页面内容、截图、文档和提示词只会发给你自己配置的模型供应商，除此之外不出本机。站点访问权限由你在引导流程中按需授予。

Taber 已开源：https://github.com/Suge8/taber
```

## 权限用途说明（审核问卷用）

| 权限 | 用途 |
|---|---|
| `activeTab` | 读取和操作用户当前选中的任务目标标签页 |
| `scripting` / `userScripts` | 在授权站点执行页面读取与交互（点击/填表），页面脚本需用户同意 |
| `storage` | 本地保存配置、会话、技能 |
| `sidePanel` | 产品主界面 |
| `webNavigation` | 跟踪任务目标页的导航状态 |
| `offscreen` | 在 offscreen document 中运行 Agent，任务不因侧边栏关闭而中断 |
| `identity` | ChatGPT/Codex、xAI/Grok 订阅 OAuth 登录 |
| optional host (`http/https`) | 站点访问按需授权，用户在引导流程中授予 |
| 固定 auth hosts | 仅用于 OpenAI/xAI 官方 OAuth 端点 |

## X / 推文草稿

EN:

> Taber is a browser agent that lives in your Chrome side panel. It reads pages, clicks, fills forms, and finishes web tasks — every step logged, stoppable any time.
>
> Open source. Bring your own model (API key or ChatGPT/Grok subscription).
>
> https://github.com/Suge8/taber

中文:

> 开源了：Taber，长在 Chrome 侧边栏的浏览器 Agent。
>
> 读页面、点按钮、填表单、跨页收集、读写文档。每一步都有证据、随时可停。跑通的网站流程存成技能，越用越快。
>
> 模型自由：API key 或 ChatGPT / Grok 订阅直连。
>
> https://github.com/Suge8/taber

配图：`design/promo/shots/og-twitter-1200x630.png`（或演示视频）。
