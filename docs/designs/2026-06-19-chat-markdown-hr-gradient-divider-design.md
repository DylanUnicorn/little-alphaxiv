# 聊天 Markdown 水平分割线（`---`）主题感知渐变样式设计

- 日期：2026-06-19
- 分支：`worktree-chat-hr-gradient`
- 影响范围：`frontend/src/index.css`（仅一处新增 CSS 规则，无 JS/TS、无主题目录改动）

## 背景 / 问题

论文预览模式右侧栏（对话）里，assistant 消息用 `Markdown.tsx` 渲染。当模型在回复里写 `---` 时，react-markdown 产出一个裸 `<hr>`。

**根因**：整个代码库**没有任何 `hr` 的 CSS 规则**（`frontend/src/index.css` 全文 grep 不到 `hr`）。于是 `<hr>` 回退到浏览器默认样式——一条 `currentColor`（≈ `--text`，深色主题下接近纯白）的等粗实线。这就是用户看到的「不管什么主题都是白色等粗线段、朴素」的来源。

## 目标

- 中间粗、两端细、模糊渐变的分割线样式。
- 颜色随主题变化。
- 与现有主题系统和谐，尽量零按主题覆写。

## 设计

在 `index.css` 的「Markdown rendering」段（blockquote / `a` 规则之后、bold 规则之前，约 556 行处）新增一条规则：

```css
/* Horizontal rule (markdown `---`): a soft accent-tinted band that's solid
   in the middle and fades to transparent at both ends — "thick middle, thin
   faded ends, blurred gradient" — tinted via color-mix on the theme accent so
   it stays harmonious across every theme with no per-theme overrides (same
   idiom as the bold-emphasis marker). No glow; the fade is the softness. */
.msg-assistant hr,
.msg-reasoning hr {
  border: none;
  height: 2px;
  margin: 18px 0;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--accent) 55%, transparent) 50%,
    transparent
  );
}
```

## 为什么满足每条要求

- **中间粗、两端细、模糊渐变**：渐变在正中央达到满不透明度（accent 55%），向两端淡出到透明。中间读作「实/粗」，两端读作「细/淡」；平滑插值本身即是「模糊渐变」。无额外发光层——淡出就是柔和感。
- **颜色随主题变化**：由 `--accent` 驱动，11 个主题各自覆写 `--accent`，因此自动随主题变色（靛蓝、Nord 青、Gruvbox 黄……），零按主题工作。
- **和谐**：复用 bold-emphasis 标记已确立的 `color-mix(in srgb, var(--accent) …, transparent)` 写法（index.css:574），与链接 / blockquote / bold 同色系，读起来像周边代码。

## 关键参数

- 高度 `2px`、accent `55%`、clean fade、无 glow——即头脑风暴中选定的「Balanced fade」方案。
- `margin: 18px 0`：略大于段落间距（`p` 为 `0 0 10px`），让分割线在视觉上断开而不挤。
- `border: none`：去掉浏览器默认的 `border`，改用 `background` 渐变控制整条线的形态。

## 作用范围

- 同时作用于通用聊天（`ChatView`）与论文视图聊天（`PaperView`）的 assistant 消息——二者共用 `Markdown.tsx` + `.msg-assistant`。
- 同时作用于可折叠的 reasoning 区块（`.msg-reasoning`），与 `strong` 已对两处统一 styling 的做法一致。
- user 消息是纯文本（不走 Markdown），不受影响。
- 边界情况：已有的 `.msg-assistant > div > *:first-child { margin-top: 0 }` / `:last-child { margin-bottom: 0 }` 已会在 `hr` 作为首/末子元素时裁掉其外边距，不会产生顶端/底端空隙。

## 验证

- `npm run typecheck` 是项目闸门（无 lint 脚本）；本次为纯 CSS，typecheck 不会检查 CSS，属无操作通过。真正的校验是视觉。
- 视觉：跑 Playwright `tools/drive_themes.py`（主题截图），或在多个主题（dark / light / gruvbox-dark / sepia）下肉眼确认 `---` 的淡出与随主题变色。
- 按记忆笔记，mock-LLM E2E 装置（`tools/drive_*.py` + `tools/mock_llm.py`）可在无真实 key 下验证前端改动。

## 非目标（YAGNI）

- 不加中心发光层（已选「无 glow」）。
- 不为 `hr` 引入新的主题 token 或按主题覆写——`color-mix` on `--accent` 已足够。
- 不改 `Markdown.tsx`、不改 `themes.ts` 主题目录。
