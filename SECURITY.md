# Security Policy

> **Languages**: [English](#english) · [中文](#中文)

---

## English

### Supported versions

Only the latest release line receives security fixes. The project is pre-1.0; treat each tagged release as the supported version.

### Reporting a vulnerability

**Do not open a public GitHub issue.** Email the maintainers privately with:

- a description of the issue and impact;
- reproduction steps or a proof of concept;
- any affected version or commit.

You should hear back within 3 business days. Please do not publicly disclose the issue until a fix or mitigation is published, or 90 days have passed since your report, whichever comes first.

### Scope

In scope:

- privilege escalation through the extension (e.g. breaking the least-privilege permission policy in `wxt.config.ts` / `scripts/verify-build.mjs`);
- leakage of model provider credentials stored in IndexedDB;
- the PKCE/OAuth flow in `lib/codex-auth.ts` / `lib/codex-oauth.ts` (token theft, redirect-uri confusion, state reuse);
- bypass of the `browserjs` page-script consent gate;
- escape of the browser REPL sandbox boundary.

Out of scope / explicitly not provided:

- the store build does not request `debugger`; the debug-only debugger tool running against attacker-controlled pages is expected behavior, not a vulnerability.
- Tampering with pages the user explicitly authorized the agent to act on — that is the product's intended function.

### Security-relevant architecture

- `docs/adr/0003-request-full-browser-agent-permissions-up-front.md` — permission posture.
- `docs/adr/0009-keep-debugger-tool-always-available.md` — debugger is debug-build only.
- `docs/store-compliance.md` — least-privilege policy for the published build.
- `lib/debugger-cookie-guard.ts` — even in the debug build, cookie reads are blocked by policy and tests.

### Reward

Taber does not run a paid bug bounty. We will credit reporters in release notes unless they prefer to remain anonymous.

---

## 中文

### 支持版本

只有最新发布线会收到安全修复。项目仍处于 1.0 之前；每个打过 tag 的版本视为当前支持版本。

### 报告漏洞

**不要开公开 GitHub issue。** 邮件私下联系维护者，附：

- 漏洞描述与影响；
- 复现步骤或 PoC；
- 受影响版本或 commit。

通常 3 个工作日内回复。请先勿公开披露，直到发布修复或缓解，或自报告起 90 天，以先到者为准。

### 范围

在范围内：

- 通过扩展提权（如破坏 `wxt.config.ts` / `scripts/verify-build.mjs` 里的最小权限策略）；
- 存在 IndexedDB 的模型供应商凭证泄露；
- `lib/codex-auth.ts` / `lib/codex-oauth.ts` 的 PKCE/OAuth 流程（token 被窃、redirect_uri 混淆、state 重用）；
- 绕过 `browserjs` 页面脚本同意门；
- 逃出浏览器 REPL 沙箱边界。

范围外 / 明确不修复：

- 上架版不请求 `debugger`；debug 构建的 debugger 工具运行在攻击者控制的页面上是预期行为，不是漏洞。
- 用户明确授权 Agent 操作的页面被"篡改"——那是产品本身要做的事。

### 与安全相关的架构

- `docs/adr/0003-request-full-browser-agent-permissions-up-front.md` — 权限姿态。
- `docs/adr/0009-keep-debugger-tool-always-available.md` — debugger 仅限 debug 构建。
- `docs/store-compliance.md` — 上架构建的最小权限策略。
- `lib/debugger-cookie-guard.ts` — 即便 debug 构建也按策略和测试阻断 cookie 读取。

### 奖励

Taber 不设付费漏洞赏金。除非希望匿名，会在发布说明里致谢报告者。
