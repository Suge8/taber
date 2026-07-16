# Promo 物料索引

全部物料可重跑，改动 UI 或文案后按顺序重新生成。

## 管线

1. **原始截图** `shots/capture.mjs`：启动 headless Chrome 加载 `.output/chrome-mv3`，向 Dexie 灌黄金会话（英文 UI、真实感数据），2x DPR 截 light/dark × 6 状态 → `shots/raw/`。需先 `pnpm build:chrome`。
2. **静态合成** `compose/build.mjs`：程序化 halftone 点场（呼应 logo）+ 原始截图 + 文案，headless Chrome 按平台精确尺寸出图。支持名称过滤参数。

```bash
node design/promo/shots/capture.mjs
node design/promo/compose/build.mjs [filter]
```

3. **真实任务录屏** `motion/record-demo.mjs`：真 Chrome + CDP loadUnpacked + 真 Codex 订阅（读 `~/.codex/auth.json`）。
   - `prepare`：headless 一次性授权（developerPrivate userScriptsAccess + addHostPermission 预登记后 permissions.request 在 headless 下静默自动授予）+ seed 供应商/模型/前台模式
   - `record`：有头重启（授权不跨 loadUnpacked 保留，会重跑授权序列）→ ⛧⌘Y 开真侧栏 → `screencapture -v -l <windowID>` 后台录窗口 → 打字提交 → 等完成
   - 任务设计约束：小页面、少轮次（本机网络对大上下文长 SSE 响应易 stall 180s）；HN 任务 ≈ 35s 完成
   - 后期：ffmpeg 1.25x + h264 1600w → MP4；两趟调色板法 → 960w 12fps GIF

## 产物 → 投放

| 文件 | 投放位置 |
|---|---|
| `shots/cws-0{1..4}-*-1280x800.png` | Chrome Web Store 截图（按序上传） |
| `shots/cws-tile-440x280.png` | CWS 宣传小图 |
| `shots/github-social-1280x640.png` | GitHub 仓库 Settings → Social preview |
| `shots/og-twitter-1200x630.png` | 官网 og:image / 推文配图 |
| `shots/readme-hero-2400x1260.png` | README 头图（webp 版在 `docs/assets/readme/hero.webp`） |
| `visual/site-card-default-2400x1500.png` | 个人网站项目卡默认态（品牌封面） |
| `visual/site-card-hover-2400x1500.png` | 个人网站项目卡 hover 态（产品实景） |
| `store-listing.md` | CWS listing 文案（EN/中文）+ 权限说明 + 推文草稿 |
| `shots/og-twitter-zh-1200x630.png` | 中文推文配图 |
| `motion/demo-hn-1600.mp4` | 发推演示视频（2.0M，37s） |
| `motion/demo-hn-960.gif` | README 演示（已复制到 `docs/assets/readme/demo.gif`） |
| `motion/demo-hn-source.mov` | 录屏原片（重剪用） |

## 注意

- 截图文案、模型名、任务内容都在 `capture.mjs` 的 seed 里，改产品文案后同步。
- README 引用的 webp 用 `cwebp -q 82` 从 PNG 转换。
- 品牌规则：warm monochrome、halftone 点场为唯一装饰 motif、图上文字全部 HTML 叠加。
