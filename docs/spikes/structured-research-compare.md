# 结构化调研与比较工作流 spike

日期：2026-07-14
基线：`7907907..e19d634` 及当前工作区

漂移检查发现 `lib/agent-event-projection.ts` 的线性化和因果排序改动，以及 `lib/sidepanel-view.ts` 的工作区变更识别。research/compare 仍生成普通 prompt；workspace 仍是普通会话文件；来源投影仍从成功工具输出收集 URL 并截取前 5 项。现有语义与计划基线一致，固定六工具和 Dexie workspace 边界未变。

## 用户任务

**调研**：用户围绕一个问题读取多个来源。结果要区分一致事实、冲突说法、缺失信息和未知项，不能用流畅总结填补证据空白。

**比较**：用户指定候选项和比较维度。结果要按相同字段对齐候选项；没有数据、无法访问或币种不可比时保留空缺并说明原因，不能强行补值或换算。

两类任务共同需要：

1. 一段短结论，明确覆盖了什么。
2. 可逐项检查的结构化主体。
3. 每条关键 claim 或字段关联一个或多个 source ID。
4. 生成时间、用户要求的 URL 范围、实际读取范围和部分失败。
5. 普通答案降级。结构化结果失败时，用户仍能看到 Agent 最终文本和工具证据。

当前产品已支持跨页读取和文件产出，但没有上述结果契约，也没有专用结果状态。

## 事实与缺口

| 当前能力 | 能证明 | 不能证明 | 证据 |
|---|---|---|---|
| research / compare 快捷入口 | 用户选了 topic 和标签页后，Composer 提交一段本地化文本 | 独立意图状态、输出字段、缺失值、来源关系或 artifact 预期 | `lib/sidepanel-view.ts:238-250`、`lib/sidepanel-i18n.ts:116-125,484-493`、`entrypoints/sidepanel/Composer.svelte:232-266` |
| Agent 最终文本 | 模型给用户输出了一段回答 | 回答是否覆盖全部字段，或每条 claim 来自哪里 | Agent 事件日志中的 message / `task.completed` |
| 工具时间线 | 本任务调用过哪些工具、输入输出和失败 | 某个比较单元格是否由某次工具结果支撑 | `lib/agent-event-projection.ts`、`lib/agent-tool-projection.ts` |
| 通用 SourcesBar | 成功 `tool.completed` 输出里出现过 URL；当前实现扫描传入的会话事件并去重 | URL 支持哪条 claim；URL 是否属于当前结构化结果；来源是否完整 | `lib/agent-event-projection.ts:245-256`，结果固定 `slice(0, 5)` |
| `getDocument source:"url"` | 工具输入记录 requested URL，成功输出记录 final URL、标题和提取内容 | 模型最终 claim 使用了哪段内容 | `lib/get-document.ts:15-36,88-112,249-270` |
| `/workspace` 文件 | 某会话保存了指定名称、MIME、字节和时间的文件；写入通过 Dexie 事务完成 | 普通 JSON 是否是 Taber 结果；文件内容是否符合研究契约；哪个 task 生成 | `lib/fs-tool.ts:125-153`、`lib/workspace-files.ts:39-68` |
| FilesStrip | 用户能看到、下载、删除文件，文本文件可导出 PDF | JSON 解析、结果状态、来源展开或 schema 错误 | `entrypoints/sidepanel/FilesStrip.svelte` |
| 会话保留 | workspace 文件随 session prune 一起删除 | 全局研究库、跨会话缓存或云端副本 | `lib/db.ts:282-301`、ADR 0016 |

“来源 URL 出现在工具输出”只证明 URL 共现。当前投影没有业务字段、cell/claim ID 或 claim-to-source 边，且 5 项截断会丢失多来源任务的 provenance。

尚不存在的候选能力包括：带版本的结果 envelope、严格解析器、artifact 身份元数据、持久 research/compare intent、字段级来源 UI 和跨 provider 合约测试。

## 方案比较

评分只比较静态设计属性，不是模型实验结果。1 表示差，5 表示好；`U` 表示缺少真实跨 provider 数据。工程成本列中 5 表示改动小。

| 方案 | 用户价值 | 工程成本 | 跨 provider | 来源真实性 | 失败可见性 | token / storage | 向后兼容 | 可逆性 | 无障碍 | 结论 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Prompt-only Markdown**：要求固定标题、表格或列表、脚注链接和缺失值 | 3 | 5 | U | 2 | 4 | 4 | 5 | 5 | 4 | 可作为实验 arm，不能承诺可解析结果或已核验来源 |
| **现有 fs 写结构化结果文件**：写带版本 JSON，再由未来 UI 解析 | 5 | 2 | U | 3 | 3 | 3 | 4 | 3 | 2 | 最有潜力，但缺 artifact 身份、intent、严格解析和 provider 证据 |
| **从 Agent 事件投影推导**：从 URL 和 timeline 自动拼结构 | 1 | 2 | 5 | 1 | 2 | 5 | 3 | 3 | 2 | 现有事件没有业务字段和 claim 关系，拒绝 |

### Prompt-only Markdown

- 优点：只改现有 prompt；普通 Markdown 渲染、任务终态、工具证据和降级路径都已存在；删除文案即可回退。
- 局限：模型可能改标题、合并缺失值或把总来源列表装饰在结尾。宿主无法判断格式是否完整，也不能把单元格链接标为已核验。
- 成本：增加 prompt token，不增加 schema 或文件；表格在 360px 可能横向溢出，需要求窄屏列表或可换行 Markdown。

### 现有 fs 写结构化结果文件

- 优点：保留字段级 `sourceIds`、missing/unknown、partial 和机器可测错误；继续使用第六个 `fs` 工具和 Dexie workspace。
- 局限：当前 `.json` 只有通用 `application/json` MIME。文件名不能证明 artifact 身份；同名写入会覆盖；合法 Dexie 写入也可能保存语法完整但契约非法的内容。模型是否稳定调用 `fs write` 尚未测试。
- 必需成本：严格解析器、大小和版本边界、artifact 元数据、task intent、文件冲突规则、普通文件回退、窄屏结果视图和 sidepanel smoke。不得让 Svelte 直接解析任意 JSON。

### Agent 事件投影

- 当前事件能证明工具调用和 URL，不包含候选项、列、缺失原因、冲突或 claim-to-source 关系。
- URL 顺序不代表支持关系；会话级扫描和前 5 项截断会进一步误配。
- 给事件补齐业务字段，实质上会创建另一份结果契约并耦合所有工具。该路径不比 workspace artifact 更小。

三个方案都不得依赖单一模型的特殊 prompt、远端研究服务、新搜索供应商或第七个顶层工具。

## 结果契约

以下 envelope 只用于可证伪实验，不是正式 API 或生产 schema：

```json
{
  "schema": "taber.research-result",
  "version": 1,
  "kind": "compare",
  "title": "套餐价格比较",
  "generatedAt": "2026-07-14T08:00:00Z",
  "scope": {
    "query": "比较三个套餐的公开价格",
    "requestedUrls": [
      "https://fixture.test/a",
      "https://fixture.test/account"
    ]
  },
  "columns": [
    { "key": "monthlyPrice", "label": "月付" }
  ],
  "items": [
    {
      "id": "plan-a",
      "label": "Plan A",
      "fields": {
        "monthlyPrice": {
          "state": "value",
          "value": 20,
          "currency": "USD",
          "asOf": "2026-07-14",
          "sourceIds": ["s1"]
        }
      }
    }
  ],
  "claims": [],
  "sources": [
    {
      "id": "s1",
      "kind": "url",
      "requestedUrl": "https://fixture.test/a",
      "finalUrl": "https://fixture.test/plans/a",
      "title": "Plan A pricing"
    },
    {
      "id": "s2",
      "kind": "url",
      "requestedUrl": "https://fixture.test/account",
      "title": "Plan B account pricing"
    }
  ],
  "status": "partial",
  "issues": [
    { "code": "LOGIN_REQUIRED", "sourceId": "s2", "message": "页面要求登录" }
  ]
}
```

实验不变量：

- `version` 必须是整数 1，`kind` 只能是 `research | compare`。未知 version、未知 kind、缺字段、重复 ID、悬空 source ID 或超过 200,000 个解码字符时 fail closed。
- 每个关键字段或 claim 直接保存 `sourceIds`。顶层 `sources` 只是字典，不能替代 claim-to-source 关系。
- 字段状态至少区分 `value`、`missing`、`unknown` 和 `conflict`。空字符串不是缺失值，也不能表示未知。
- 价格值使用数字 `value`、原币 `currency` 和 `asOf`。不同币种默认不换算；没有用户指定汇率和日期时显示不可直接比较。
- `missing` 表示来源明确没有发布该字段，并带原因和来源；`unknown` 表示没有取得证据；`conflict` 保存各候选值及各自 source IDs。
- `status:"partial"` 必须有 `issues`。候选 code 包括 `FETCH_FAILED`、`LOGIN_REQUIRED`、`PAGE_JS_REQUIRED`、`PERMISSION_DENIED`、`FIELD_CONFLICT`、`TASK_STOPPED` 和 `SOURCE_UNREAD`。
- `scope.requestedUrls` 保存用户明确选择的 URL。`scope.query` 只能是用户可见、最多 200 字符的范围摘要，不能复制完整 prompt、系统指令或隐藏上下文。
- 成功读取的 URL source 同时保留 requested URL 和工具返回的 final URL。失败或未读取的 source 必须保留 requested URL，并缺省尚未观察到的 `finalUrl`；禁止复制 requested URL 伪装成 final URL。规范化只统一 scheme/host 大小写、默认端口和 fragment；path 与 query 保留，防止把不同页面错误合并。
- `generatedAt` 是模型声明时间；未来 UI 的可信“保存时间”必须来自 Dexie `WorkspaceFile.updatedAt`。两者不能混称。
- 不保存页面全文、原始思维链、凭证、个人资料或工具输入输出副本。v1 实验不保存证据摘录；若 URL 无法支撑核查，需要重新做隐私评审，而不是默加正文片段。
- 文件继续随 session 清理。没有跨会话缓存、云同步或研究数据库。

实验命名候选为 `research-result.json` / `compare-result.json`，MIME 仍是 `application/json`。文件名和 envelope 都不能单独触发特殊 UI。安全的生产识别至少需要：严格解析成功、当前 task 的 `fs write` 证据，以及 workspace 行上的可选 artifact 元数据。当前数据形状没有该元数据，也无法在文件被后续上传覆盖后证明身份，因此它是 Go 阻塞项。

普通同名 JSON、非法契约和未知 version 都保留为普通文件。若任务被标记为 research/compare intent，UI 另行显示“未生成结构化结果”，不能把解析失败当作完整空表。当前任务启动消息没有持久 intent，这也是阻塞项。

## 来源与错误语义

### 来源声明

字段与 claim 的 source 关系由模型在契约中声明。宿主最多核对 source URL 是否出现在同一 task 的成功工具输入/输出中：

- 匹配成功显示 **“本任务已读取”**，只证明读取行为。
- 无匹配显示 **“模型声明来源”**。
- 不使用 **“已核验来源”** 标签，因为宿主没有证明该来源支持具体 claim。

宿主不得从事件顺序、相邻工具调用或 SourcesBar 顺序推断 claim-to-source 关系。

### 允许的来源

| 来源 | 契约表示 | 宿主可核对 |
|---|---|---|
| `getDocument source:"url"` | `kind:"url"`，requested URL、成功时的 final URL、标题 | 同 task 的工具 input 和成功 output |
| `getDocument source:"currentPage"` | `kind:"page"`，final URL、标题 | 同 task 的 target context 和成功 output |
| `getDocument source:"file"` | `kind:"file"`，workspace 文件名 | 同 session 文件与成功工具事件；不能伪造公网 URL |
| `browser` 页面状态 | `kind:"page"`，当时 URL、标题 | 同 task 的 browser output / target 事件，只证明页面状态被读取 |
| 用户附件 | `kind:"attachment"`，文件名 | session workspace 行；不保存附件全文副本 |

公开静态 URL 继续走 `getDocument source:"url"` 的 fetch-first 路径；登录态或 JS 页面显式回退到受控标签页和 `currentPage`。`navigate` 只证明到达页面，不能证明读取内容。`browserRepl` 和 `extractImage` v1 不作为关键 claim 来源；它们仍留在工具证据中。若未来需要视觉或任意脚本 provenance，应另做契约扩展。

### URL 与数量

- 相同 final URL 规范化后合并 source，并保留所有 requested URL 别名。
- 同源不同 path 或保留后的 query 是不同来源。
- 重定向前后 URL 同时展示；用户打开来源时优先 final URL。
- 结构化 artifact 不继承通用 SourcesBar 的 5 项截断。所有被字段引用的 source 都必须保留，整体只受 artifact 字符上限约束；UI 默认折叠次要来源。
- 重复候选项按稳定 item ID 报错，不静默合并。

### 错误与降级

| 条件 | 任务状态 | 结构化结果 | 用户可见行为 |
|---|---|---|---|
| 一个工具失败，其余来源可用 | 仍由 Agent 事件决定 | `partial` + issue | 显示部分结果、失败来源和普通最终文本 |
| 登录、JS 或权限限制 | 任务可继续 | `partial` + 对应 code | 不补字段，显示“未读取”原因和 retry 线索 |
| 字段冲突 | 任务可完成 | `conflict`，保留各值和 source IDs | 并列冲突，不自动选赢家 |
| 用户停止任务 | `task.cancelled` | 已写合法文件只能视为部分 artifact | 顶层仍显示已停止；文件不能把任务改成完成 |
| 文件写入失败 | 由现有 tool failure 和任务终态处理 | 无 artifact | 保留普通文本和工具错误，显示“未生成结构化结果” |
| 契约解析失败、未知 version 或过大 | 任务终态不变 | 作为普通文件 | 显示“未生成结构化结果”，允许下载原文件，不显示空表 |
| 没有最终文本也没有合法 artifact | 现有 failed / cancelled / completed 事件 | 无结果 | 明确“没有可用结果”，不假成功 |
| 下载或删除失败 | 任务终态不变 | 原文件状态以 Dexie 为准 | Toast 显示错误；失败后不移除本地条目 |

任务完成状态继续来自 Agent 事件日志。artifact 内容和身份只从 Dexie workspace 与同一日志重建；组件本地状态不补历史。文件只是一项 artifact，不建立第二状态机。结构化 artifact 不可用时，普通文本和工具证据是唯一降级路径。

## 交互状态

以下 360px 文本线框只检验信息密度和契约表达力，不授权生产 UI：

```text
调研结果                         部分
套餐价格比较
3 个候选 · 5 个来源 · 保存于 10:24

结论
币种不同，未做换算。Plan B 未公开年付价。

候选项
Plan A  月付 $10 [1]  年付 $100 [1]
Plan B  月付 €20 [2]  年付 缺失 [2]
Plan C  月付 $30 [3]  年付 $300 [3]

问题  1 个来源要求登录
来源  5                           展开
下载 JSON                         更多
```

状态表：

| 状态 | 显示 |
|---|---|
| 生成中 | 复用现有 task running 和工具时间线；不创建 artifact spinner |
| 完整 | 短结论、按行堆叠的字段、来源计数、保存时间、下载 |
| 部分 | 一行可操作警告、缺失字段原因、可用结果和普通文本 |
| 无结果 | 现有失败或停止原因，加“没有可用结果” |
| 契约损坏 | “未生成结构化结果”，原 JSON 仍可下载 |
| 普通文本降级 | 展示 Agent 最终文本和工具证据，不显示空结构卡 |
| 下载 / 删除 | 使用 workspace 文件动作；删除后 artifact 视图随 Dexie 更新 |

颜色只用于 partial/error 警告。来源默认折叠；键盘可展开、打开来源、下载和删除；命中区至少 40px。screen reader 使用列表或定义列表表达行列关系，并给每个 source ID 可读名称，不能只朗读视觉表格。360px 不产生横向滚动。动效复用 `fx-*`，reduced motion 下静止。

### Fixture 1：三个套餐与不可比币种

用户看见：

```text
Plan A  $10/月 · $100/年       [1]
Plan B  €20/月 · 年付未公开    [2]
Plan C  $30/月 · $300/年       [3]
币种不同，未换算。Plan B 的来源明确未提供年付价格。
```

机器数据表达：

```json
{
  "items": [
    { "id": "a", "fields": { "monthly": { "state": "value", "value": 10, "currency": "USD", "sourceIds": ["s1"] }, "annual": { "state": "value", "value": 100, "currency": "USD", "sourceIds": ["s1"] } } },
    { "id": "b", "fields": { "monthly": { "state": "value", "value": 20, "currency": "EUR", "sourceIds": ["s2"] }, "annual": { "state": "missing", "reason": "来源未公开年付价格", "sourceIds": ["s2"] } } },
    { "id": "c", "fields": { "monthly": { "state": "value", "value": 30, "currency": "USD", "sourceIds": ["s3"] }, "annual": { "state": "value", "value": 300, "currency": "USD", "sourceIds": ["s3"] } } }
  ],
  "sources": [
    { "id": "s1", "kind": "url", "requestedUrl": "https://fixture.test/compare/a", "finalUrl": "https://fixture.test/compare/a", "title": "Plan A" },
    { "id": "s2", "kind": "url", "requestedUrl": "https://fixture.test/compare/b", "finalUrl": "https://fixture.test/compare/b", "title": "Plan B" },
    { "id": "s3", "kind": "url", "requestedUrl": "https://fixture.test/compare/c", "finalUrl": "https://fixture.test/compare/c", "title": "Plan C" }
  ]
}
```

该 fixture 证明数值、缺失和币种可以表达；它没有证明模型会稳定产出这些字段。

### Fixture 2：多来源冲突

用户看见：

```text
数据保留期存在冲突
官方帮助页：30 天 [1]
服务条款：90 天 [2]
当前证据不能确定哪条规则适用。
```

机器数据表达：

```json
{
  "claims": [
    {
      "id": "retention",
      "state": "conflict",
      "alternatives": [
        { "value": "30 days", "sourceIds": ["s1"] },
        { "value": "90 days", "sourceIds": ["s2"] }
      ]
    }
  ],
  "status": "partial",
  "issues": [{ "code": "FIELD_CONFLICT", "sourceIds": ["s1", "s2"], "message": "保留期冲突" }],
  "sources": [
    { "id": "s1", "kind": "url", "requestedUrl": "https://fixture.test/help/retention", "finalUrl": "https://fixture.test/help/retention", "title": "官方帮助页" },
    { "id": "s2", "kind": "url", "requestedUrl": "https://fixture.test/terms", "finalUrl": "https://fixture.test/terms", "title": "服务条款" }
  ]
}
```

该 fixture 要求 UI 保留冲突，禁止用来源数量投票。

### Fixture 3：登录失败与契约损坏

用户看见：

```text
未生成结构化结果
一个价格页要求登录。以下是 Agent 保留的普通答案：
“已读取两个公开页面；第三个页面无法访问，价格未知。”
工具证据：LOGIN_REQUIRED · example.test/account
下载原始 JSON
```

若契约有效，登录失败应表达为：

```json
{
  "status": "partial",
  "issues": [{ "code": "LOGIN_REQUIRED", "sourceId": "s3", "message": "页面要求登录" }],
  "items": [{ "id": "c", "fields": { "price": { "state": "unknown", "reason": "source unread", "sourceIds": ["s3"] } } }],
  "sources": [
    { "id": "s3", "kind": "url", "requestedUrl": "https://fixture.test/account", "title": "账户价格页" }
  ]
}
```

本例假定实际文件把 `items` 写成字符串，严格解析器会拒绝整份 artifact。机器端不接受半个对象，也不从损坏 JSON 猜字段；普通文本降级保留可用信息。

## 验证实验

本 spike 没有运行真实 provider 实验。现有 `scripts/test-e2e-scenarios.ts` 直接调用工具，不能测模型遵从；provider/runtime 测试使用 synthetic token 和请求夹具，也不能替代模型输出。以下指标全部是待测门槛，不是运行结果。

### 固定夹具

在 `scripts/test-e2e-scenarios.ts` 的确定性站点旁增加三页资料：

- `/compare/a`：USD 月付和年付，同时声明保留期 30 天。
- `/compare/b`：EUR 月付，明确写“未提供年付”，同时声明保留期 90 天。
- `/compare/c`：固定返回登录限制，两个价格字段都应为 unknown。

一个固定英文任务要求比较三个套餐的月付、年付和保留政策。每次运行有 7 个必需结果单元：6 个价格字段和 1 个保留期冲突 claim；有 8 条预期来源关联：每个价格字段 1 条，冲突 claim 的两个候选值各 1 条。fixture manifest 在运行前固定这些单元、状态、值、URL 和关联，断言不匹配模型措辞。

### 运行矩阵

四条 provider kind 是 `openaiCompatible`、`openaiApiKey`、`openaiCodex`、`xaiSub`。每个 provider 固定一个模型版本和 reasoning 设置，所有执行使用新 session、相同任务输入和相同 fixture；各 arm 使用自己的输出契约：

1. **Prompt-only Markdown**：每个 provider 运行 10 次，共 40 次。契约要求固定窄屏列表、缺失/未知值、冲突和脚注 source ID，不要求 JSON envelope。
2. **fs JSON**：每个 provider 运行 10 次，共 40 次。契约要求写实验 envelope，且任务终态保留非空普通最终文本；两者完成顺序不承担状态语义。

两个 arm 的候选运行总计 80 次。另设当前生产 research/compare prompt 的 token control：每个 provider 运行 5 次，共 20 次，不附加任何结构化输出要求。完整实验共 100 次执行。Prompt-only 的 40 次只作为质量与成本对照；进入 Go 的结果门槛只计算 fs JSON 的 40 次。

每次记录 provider、模型版本、reasoning 设置、arm、运行序号、输入/输出 token、artifact 字节和任务终态。provider 不报告 token 时，该 provider 的成本门槛记为未通过；不保存凭证、页面全文或思维链。事件投影方案不进 provider arm，静态夹具已证明它缺少 claim 关系。

### 指标与分母

| 指标 | arm 和指标分母 |
|---|---|
| Markdown 契约遵从率 | Prompt-only：同时包含固定列表、缺失/未知、冲突和脚注的运行数 / 40 |
| JSON 契约可解析率 | fs JSON：合法 JSON 且通过全部不变量的运行数 / 40 |
| 必填字段完整率 | 两个 arm 分开计算：正确表达的必需结果单元 / 280；任何不可解析 fs artifact 贡献 0 个正确单元 |
| 虚构字段数 | 两个 arm 分开计算：40 次中 fixture 无证据却输出为确定值的字段总数；门槛使用绝对数量，不使用可能为 0 的比率分母 |
| claim-to-source 关联 | 两个 arm 分开计算：正确预期关联数 / 320，同时单列全部额外或错误关联的数量 |
| partial 诚实率 | Prompt-only 显示部分结果并明确登录失败和冲突的运行数 / 40；fs JSON 同时满足 `status:"partial"`、`LOGIN_REQUIRED` 和 `FIELD_CONFLICT` 的运行数 / 40 |
| 普通文本降级保留率 | 将每次 fs JSON artifact 的副本强制替换为非法 version 后重放解析；仍保留非空普通答案和工具证据的运行数 / 40 |
| 结构一致性 | 每个 arm、每个 provider 单独计算：item、column 和状态集合符合 fixture manifest 的运行数 / 10；共 8 个独立比率 |
| token 增幅 | 每个 arm、每个 provider 单独计算：候选 10 次总 token 中位数相对同 provider 的 5 次生产 prompt control 中位数增幅；共 8 个独立比率，不跨 provider 汇总 |
| artifact 大小 | fs JSON 的 40 个文件逐个记录解码字符数 |
| 静态契约闭包 | 文档内每个 JSON fixture 各自递归检查：全部 `sourceId` / `sourceIds` 存在于同一对象的 `sources[].id`；失败来源不得伪造 `finalUrl` |

任何 provider 需要专用 prompt、特殊 schema 或夹具宽容分支，实验即失败。

## 推荐

**No-Go。当前不实施结构化调研与比较结果层。**

三项证据缺口会让上线结果看起来比实际更可靠：

1. 四条 provider 路径没有真实、重复的遵从性结果。
2. 当前事件无法证明 claim-to-source，SourcesBar 还会截断并混入会话内其他成功工具 URL。
3. 普通 workspace JSON 没有可信 artifact 身份，research/compare intent 也没有持久化。解析失败后，UI无法可靠判断自己是否应显示“未生成结构化结果”。

Prompt-only Markdown 只改善排版，不能提供可解析契约或字段级 provenance；它保留为验证实验 arm，不作为首发功能。现有 fs JSON 是证据通过后的首选候选，但现在不能进入生产。事件投影路径拒绝，除非未来事件本身携带直接 claim 关系；到那时仍需重新比较数据重复和耦合成本。

G5 不激活。

## Go/No-Go

### 进入 Go 的数值门槛

候选矩阵先完成总计 80 次运行，token control 再完成 20 次。以下结果门槛只使用 fs JSON arm 的 40 次；Prompt-only 的 40 次不混入分母：

| 指标 | 门槛 |
|---|---:|
| fs JSON 契约可解析率 | 至少 38 / 40（≥ 95%） |
| 必填字段完整率 | 至少 275 / 280（≥ 98%）；不可解析运行按 0 个正确单元计 |
| 虚构字段数 | 40 次合计 0 个 |
| claim-to-source 关联 | 至少 304 / 320（≥ 95%），且额外/错误关联、悬空 source ID 均为 0 |
| 登录失败和冲突的 partial 诚实率 | 40 / 40（100%） |
| 强制非法 version 后的普通文本降级保留率 | 40 / 40（100%） |
| 结构一致性 | 每个 provider 至少 9 / 10（≥ 90%），四条路径分别通过 |
| token 增幅 | 每个 provider 的 fs JSON 10 次中位数相对该 provider 的 5 次生产 prompt control 中位数 ≤ 25%，四条路径分别通过 |
| artifact 大小 | 40 / 40 均 ≤ 200,000 个解码字符 |
| provider 特例 | 0 个专用 prompt、schema 或测试分支 |

还必须先解决两个确定性阻塞项：严格解析后的 artifact 元数据能在文件覆盖后失效；`research | compare` intent 随 `task.started` 持久化且仍由 Agent 事件日志驱动 UI。两项都要有旧数据和普通 JSON 的 fail-closed 测试。

任一指标未达门槛、任一来源被误标为“已核验来源”、结构化失败出现空表、或实现要求新认证、缓存、远端服务和第七个工具，都维持或回退为 No-Go。

### 当前架构决定

| 决策面 | 决定 |
|---|---|
| schema | **无变化**。不修改 `WorkspaceFile`，不建立正式结果 schema |
| 索引 / 迁移 | **无变化**。不新增 Dexie 索引或 version；旧文件继续是普通文件 |
| API | **无变化**。research/compare 仍提交普通 prompt；顶层工具保持 6 个 |
| event | **无变化**。不增加 intent、artifact 或 claim 事件，不新建第二状态机 |
| 并发 | **无变化**。workspace 同名写入继续由现有 Dexie 事务串行完成；不增加裸读、改、写 |
| cache | **无变化**。不增加结果缓存或跨会话研究库 |
| auth | **无变化**。继续使用用户已配置 provider 和现有站点权限，不新增认证 |
| retention | **无变化**。普通 workspace 文件随 session 清理；不云同步 |
| privacy | 不保存页面全文、prompt、凭证、个人资料、工具结果副本或 raw chain-of-thought |
| error semantics | **无变化**。当前只展示普通任务文本、工具错误和文件；不声称结构化结果成功 |

### 证据通过后的实施边界

若门槛全部通过，首选边界是“现有 fs JSON + 严格宿主解析”，不是事件推导：

- 数据与解析：新增纯解析模块，定义版本、不变量、大小限制、URL 规范化和可显示错误；`WorkspaceFile` 只增加可选、非索引的 artifact 元数据，普通旧文件默认无 metadata。若不改索引，Dexie 不升 version。
- 写入：`lib/fs-tool.ts` 在 JSON 写入成功前后调用纯解析逻辑，并让 metadata 与文件内容在同一 Dexie 事务提交；上传或普通覆盖清除 metadata。文件名不参与身份判断。
- intent/API/event：Composer 把 `research | compare` 作为启动任务的显式字段传到既有 start-task 路径，`task.started` 持久化 intent；任务终态仍只取事件日志。
- UI：结果投影放在独立 `lib` 模块；`FilesStrip.svelte` 只发动作，专用窄屏组件消费已解析 view model，不直接 `JSON.parse`。来源标签只用“本任务已读取”或“模型声明来源”。
- 测试：`scripts/test-sidepanel-view.ts` 锁定 intent prompt；新增纯解析 suite；扩展 `scripts/test-e2e-scenarios.ts`；`scripts/smoke-sidepanel-ui.mjs` 覆盖 360px、键盘、screen reader、下载、删除和损坏降级；真实 provider 实验不进入单一模型 fixture。
- 文档：通过评审后新增 ADR，记录 schema 版本、artifact 身份和错误语义；README 只在真实门禁通过后更新产品承诺。

最小发布顺序：provider 实验达到门槛 → 数据语义与解析测试 → 事务写入和 intent 事件 → UI → sidepanel smoke 和真实 provider 复测。不得新增生产依赖、搜索服务、队列、缓存、认证或顶层工具。
