# 上架版使用最小浏览器权限

Taber 上架版不再安装时申请完整浏览器 Agent 权限。默认权限只包含运行侧边栏、脚本注入、userScripts、导航事件、当前标签页、offscreen AgentHost 和 ChatGPT/Codex 登录所需能力：`storage`、`sidePanel`、`scripting`、`userScripts`、`webNavigation`、`activeTab`、`offscreen`、`identity`。

站点访问通过 `optional_host_permissions` 请求 `http://*/*` 和 `https://*/*`。Browser Access onboarding 会解释用途，并提供一次性授权所有网站的低摩擦入口；开始浏览器任务前必须完成 Website access 与 User Scripts。用户拒绝授权时侧边栏保持阻塞，不暗示可跳过授权继续浏览器任务；任务遇到 `chrome://`、`file://` 等不可操作页时明确提示仅支持 `http/https`，不做后台静默授权或暂停恢复。

`debugger` 不属于上架版默认能力，只在 `TABER_ENABLE_DEBUGGER=1` 的本地/dev debug 构建中申请和暴露。这样减少 Chrome Web Store 权限警告和审核风险，并让产品承诺与最小权限原则一致。
