# Contributing to Taber

> **Languages**: [English](#english) · [中文](#中文)

---

## English

Thanks for considering a contribution. Taber is a Chrome/Edge browser agent side panel; keeping the tool boundary narrow and the side panel calm is a hard constraint, not a nice-to-have.

### Before you start

- Open an issue first for anything beyond a typo or small bug fix. This avoids wasted work when the change conflicts with the project direction (see [`PRODUCT.md`](PRODUCT.md) and the ADRs in [`docs/adr/`](docs/adr/)).
- This project does **not** accept changes that widen the tool boundary, expose raw chain-of-thought, add anti-detection behavior, or request `debugger` / `<all_urls>` in the store build. See [`docs/store-compliance.md`](docs/store-compliance.md) for the published permission policy.

### Development setup

```bash
pnpm install
pnpm prepare          # generates WXT type stubs
pnpm dev              # hot-reload dev build; use pnpm dev:debug for debugger tool
```

### Verifying your change

The full CI pipeline is `pnpm run test:ci`. It builds Chrome + Edge, runs a manifest permission check, type checks, runs unit tests, then E2E scenarios, then DB integration. Run at least the parts your change touches:

```bash
pnpm run check                       # svelte-check / tsc
pnpm run test:unit                   # ~20 node --experimental-strip-types suites
pnpm run test:e2e                    # deterministic in-process scenarios
pnpm run test:database-integration   # fake-indexeddb backed
```

If your change touches permissions or `wxt.config.ts`, also run `pnpm build:chrome && node scripts/verify-build.mjs .output/chrome-mv3` — the manifest assertions there enforce the least-privilege policy.

### Code style

- Match existing style. No formatter config is checked in; do not reformat whole files.
- Keep files ≤ 400 lines, functions ≤ 50 lines. See `AGENTS.md` for module ownership.
- No new runtime dependencies without justification in the PR description — confirm the standard library or an existing dep cannot cover it.
- TypeScript: no `any` to silence errors; solve the root cause.

### Submitting a PR

1. Branch off `main`.
2. One logical change per PR. Each line of diff must relate to the PR goal.
3. Fill in the PR template: what changed, how verified, any permission/privacy impact.
4. Make sure `pnpm run test:ci` is green locally.

### Reporting bugs and security issues

- Bugs: use the GitHub issue tracker, **Bug report** template.
- Security: do **not** open a public issue. See [`SECURITY.md`](SECURITY.md) for the private disclosure address.

---

## 中文

感谢你考虑贡献 Taber。Taber 是 Chrome/Edge 侧边栏浏览器 Agent；保持工具边界狭窄、侧边栏安静是硬约束，不是可选项。

### 开始前先看

- 除错字或小 bug 之外的改动，先开 issue 沟通。避免和项目方向冲突做了无用功（见 [`PRODUCT.md`](PRODUCT.md) 与 [`docs/adr/`](docs/adr/) 里的 ADR）。
- 本项目**不接受**以下改动：扩大工具边界、暴露原始思维链、加反检测行为、在上架构建里请求 `debugger` 或 `<all_urls>`。上架权限策略见 [`docs/store-compliance.md`](docs/store-compliance.md)。

### 开发环境

```bash
pnpm install
pnpm prepare          # 生成 WXT 类型桩
pnpm dev              # 热重载 dev 构建；pnpm dev:debug 开启 debugger 工具
```

### 验证你的改动

完整 CI 流水线是 `pnpm run test:ci`：构建 Chrome + Edge、跑 manifest 权限校验、类型检查、单元、E2E、DB 集成。至少跑你改动涉及的子集：

```bash
pnpm run check                       # svelte-check / tsc
pnpm run test:unit                   # 约 20 个 node --experimental-strip-types 套件
pnpm run test:e2e                    # 进程内确定性场景
pnpm run test:database-integration   # fake-indexeddb 后端
```

改动涉及权限或 `wxt.config.ts` 时，再跑 `pnpm build:chrome && node scripts/verify-build.mjs .output/chrome-mv3`——这里的 manifest 断言强制最小权限策略。

### 代码风格

- 匹配现有风格。仓库没提交流程化格式配置，不要整文件重排格式。
- 文件 ≤ 400 行、函数 ≤ 50 行。模块归属见 `AGENTS.md`。
- 不新增生产依赖，除非 PR 描述里写清理由——标准库或现有依赖能覆盖的不要加。
- TypeScript：不要用 `any` 压报错；解决根因。

### 提交 PR

1. 从 `main` 拉分支。
2. 一个 PR 一个逻辑改动。每行 diff 都要和 PR 目标相关。
3. 填 PR 模板：改了什么、怎么验证、是否影响权限或隐私。
4. 本地 `pnpm run test:ci` 跑绿。

### 报 bug 与安全问题

- Bug：在 GitHub issue 里用 **Bug report** 模板。
- 安全：**不要**开公开 issue。披露渠道见 [`SECURITY.md`](SECURITY.md)。
