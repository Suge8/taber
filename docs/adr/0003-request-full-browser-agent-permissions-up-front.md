# 上架版使用最小浏览器权限

Taber 上架版不再安装时申请完整浏览器 Agent 权限。默认权限只包含运行侧边栏、脚本注入、userScripts、导航事件、当前标签页和 offscreen AgentHost 所需能力：`storage`、`sidePanel`、`scripting`、`userScripts`、`webNavigation`、`activeTab`、`offscreen`。

站点访问通过 `optional_host_permissions` 请求 `http://*/*` 和 `https://*/*`。Browser Access onboarding 会解释用途，并提供一次性授权所有网站的低摩擦入口；用户拒绝后仍可在当前标签页或已授权网站使用 Taber。任务进入未授权网站时明确失败，提示授权后手动重试，不做后台静默授权或暂停恢复。

`debugger` 不属于上架版默认能力，只在 `TABER_ENABLE_DEBUGGER=1` 的本地/dev debug 构建中申请和暴露。这样减少 Chrome Web Store 权限警告和审核风险，并让产品承诺与最小权限原则一致。
