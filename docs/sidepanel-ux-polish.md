# Sidepanel UX polish decisions

## Goal

Make the side panel calmer, prettier, more modern, and less log-like. Show users the useful state first. Keep raw technical evidence available, but lower its visual weight.

## Decisions

### Tool timeline

- Tool entries are process evidence, not the main content.
- AI replies have higher visual weight than tools.
- Tool calls render inline inside the assistant turn, in real event order; text deltas split around tool calls instead of being collapsed into one final block.
- Tool UI defaults to human-readable summaries.
- Raw input/output/error stays available under `详细`.
- Tool entries use compact, elegant solid cards/capsules, not heavy log blocks.

### Tool grouping

- Consecutive tools are grouped when no user/assistant message appears between them.
- Groups keep real execution order.
- Groups show a stacked capsule preview.
- Preview shows the latest 3 capsules plus `+N` for the rest.
- A single tool is not grouped unless needed by the same component shape.
- Tool groups do not cross AI/user message boundaries.

### Tool group state

- Latest group is expanded by default.
- New group appears → old group collapses.
- Refresh restore → all collapsed except latest group.
- Failed groups auto-expand unless the user manually collapsed them.
- Group title uses state first:
  - `✓ 浏览器操作 · 5 步`
  - `◌ 正在读取 · 3 步`
  - `✕ 操作失败 · 2 步`
- Group title icon is status-based. Capsules show action.

### Tool capsule copy

- Chinese action labels should be short: usually 2-3 characters.
- English labels should be natural short words, not forced abbreviations.
- Capsule content: status icon + short action + very short result.
- Examples:
  - `✓ 读取 · 1.2k字`
  - `↗ 跳转`
  - `◌ 检查`
  - `✕ 失败`
  - `✓ 截图 · 720p`
  - `✓ 调试 · 3错`
- Tool labels vary by tool input/action/source, not only by tool name.

### Tool icons

- Use tool-level icons with a few action-level exceptions.
- Navigation actions may use different arrows/icons.
- Avoid an icon zoo.
- Success uses a subtle green icon only.
- Failure uses red icon/light accent.
- Running uses a small breathing dot.

### Tool details

- Closed: capsule summary.
- Open: human summary + key input/result.
- `详细`: raw input/output/error.
- Detail entry label is `详细`.
- Expanded summary shows key input + result, e.g. `跳转 example.com · 已完成`.

### Errors

- Show human-readable error first.
- Technical error is hidden under `详细`.
- Error wording starts with tool-specific defaults plus a small high-frequency mapping:
  - timeout → `等待超时`
  - Element not found → `未找到元素`
  - Navigation failed → `页面跳转失败`
  - no readable text → `未读取到正文`
  - permission/access → `页面访问受限`
- Raw error remains available.

### Message time

- No default timestamp in message body.
- Timestamp appears on hover only after an assistant turn is finished.
- User messages show no timestamp on hover.
- Assistant message: below the message with copy action, never overlaying content.
- Running assistant turns show no copy action or timestamp.
- Tool card: title row right side.
- No centered time separators.
- Session history keeps its visible time.

### User and assistant messages

- User messages keep right-side bubble style, refined:
  - light surface
  - subtle ring/shadow
  - natural rounded corners
- Assistant messages are not carded.
- Assistant content remains clean text/markdown flow.
- Assistant hover action first version: copy only.
- Copy success shows temporary copied state.

### Sources / context bar

- Lives above the composer, not at the sidepanel top.
- Lightweight fixed row.
- Shows current page + counts, not all chips by default:
  - `当前页 · example.com · 来源 2 · 图片 1`
- Full source list opens in a small popover.
- Popover lists favicon + title/domain.
- Do not imply sentence-level citations; current data is source-level only.

### Image preview

- Context bar shows a small thumbnail when available.
- Clicking opens a preview dialog/lightbox.
- Tool details show image metadata/size, not a large inline image.
- Images get subtle 1px outlines.

### Running state

- Remove top `RUNNING` pill.
- Running state appears only where useful:
  - current tool group: what Taber is doing
  - composer: what the user can do, mainly stop
- Composer running state becomes a compact status panel with Stop.
- Model selector is hidden while running.

### Composer

- Idle: normal input + model selector.
- Running: rounded status panel + Stop, no model selector.
- Quick actions stay visible above the composer while idle.
- No task queue in this polish pass.

### Quick actions and empty state

- Empty state combines product guidance + quick actions.
- Keep these 4 quick actions visible above the composer while idle:
  - 总结
  - 调研
  - 翻译
  - 比价
- Layout: 2×2 grid.
- Clicking a quick action fills the input, does not auto-send.
- Contextual quick actions use current URL/title only:
  - reorder actions
  - lightly adjust copy when safe
  - no model call, no extra page read
  - no strong highlight

### Layout density and look

- Prioritize beauty, clarity, and breathing room over high density.
- Style target: modern, elegant, calm, not DevTools/log UI.
- Solid light cards/capsules over glass transparency.
- Suggested baseline:
  - Timeline gap: 12-16px
  - Message padding: 11-13px 14px
  - Tool capsules: 26-28px high
  - Context bar: 34-38px high
  - Body text: 13.5-14px
  - Meta: hover-only, 10-11px
  - Outer radius: about 16px
  - Inner radius: 10-12px
  - Shadow/ring: very subtle

## Implementation scope

Implement as one coherent UX pass, not split batches. Keep changes focused on sidepanel UI/view derivation/i18n/components. Do not change AgentHost, tool execution, security boundaries, database schema, or task protocol unless a listed goal cannot be met otherwise.

Required goals:

1. Remove visible message timestamps; add hover timestamps.
2. Remove top running pill.
3. Compact and beautify Tool UI.
4. Add i18n tool/action labels.
5. Add tool/action icons.
6. Add tool grouping with capsule previews.
7. Add human summaries and `详细` raw details.
8. Add error text layering.
9. Move Sources/context into a light composer-adjacent bar.
10. Composer running state panel.
11. AI reply copy hover action.
12. Empty state 2×2 quick actions.
13. Add Sources/context popover.
14. Add image thumbnail + preview dialog/lightbox.
15. Add URL/title-only quick action reordering/light copy adjustments.
16. Preserve raw technical evidence under `详细`.
17. Preserve refresh/reopen recovery from `agentEvents`.

Non-goals for this pass:

- Regenerate/retry protocol.
- Task queue.
- Sentence-level citations.
- Extra model/page analysis for quick action detection.
- New animation dependency unless CSS/Svelte transitions prove insufficient.

## Animation dependency

- Do not add Motion/GSAP for this pass.
- Use CSS transitions, existing Tailwind/tw-animate-css, and Svelte animation primitives.
- Reconsider a dependency only if stacked capsule layout transitions cannot feel good enough without it.

## Verification

- Add/update unit tests for pure view derivation and i18n helpers.
- Run affected unit tests after changes; at minimum `pnpm run test:unit` before handoff.
- Run build verification if UI/component imports changed; at minimum `pnpm build:chrome`.
- Do real browser/sidepanel visual verification after implementation.
- Capture screenshots for at least:
  - empty state with 2×2 quick actions
  - normal conversation with user + assistant messages
  - running tool group with capsule stack
  - failed tool group with human error + `详细`
  - context bar popover and image preview
- Compare screenshots against the goal: modern, elegant, calm, low-noise, not log-like.
