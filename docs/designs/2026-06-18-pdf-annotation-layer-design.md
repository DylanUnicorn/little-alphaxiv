# Little Alphaxiv — PDF 标注图层 + 代码块语法高亮 设计文档

**日期**: 2026-06-18
**状态**: 已定稿，待用户审阅 → 进入实现
**关联**: `docs/designs/2026-06-17-little-alphaxiv-design.md`（主设计）

## 1. 目标

给现有 PDF 预览页加一套 Zotero 风格的批注能力，以及给右栏聊天代码块加语法高亮。

**核心心智**：标注是独立于 PDF 的"图层"，**不修改 PDF 本身**，而是在 PDF 渲染层之上叠一层可持久化的标注，圈画后保存到 IndexedDB，刷新页面依然在。

四个工具：新增文字、绘制矩形、自由绘图、划词上色（高亮）。颜色选择用预设调色板。ESC 取消当前操作。每个操作支持撤回/重做。已落标注支持选中、移动、缩放、删除。

## 2. 已定决策（brainstorming 结论）

| 维度 | 决策 |
|---|---|
| 工具交互模型 | 默认可选文字 + 工具按钮。文字/矩形/画笔为"一次性"工具（画完回默认态）；高亮为"开关式"按钮（勾选后持续生效，再点取消） |
| 高亮触发 | 高亮按钮勾选时：拖选文字 → 弹气泡选色 → 上色；取消勾选时为普通选文字 |
| 颜色选择 | 预设调色板（黄/绿/蓝/粉/橙/紫 6 色），工具栏选色 + 划词气泡选色两处共用 |
| 新增文字形态 | 原位文本框：点文字按钮 → 点页面位置 → 该点出现可编辑文本框直接输入，失焦/Enter 落盘 |
| 图层技术方案 | 方案 A：SVG/DOM 叠加层。每页 canvas + textlayer 之上加 `<svg class="annot-layer">`（矩形/笔/文字）+ `<div class="highlight-layer">`（高亮色块，在文字下方） |
| 坐标存储 | 页内归一化坐标（x/w、y/h，0..1），渲染时乘当前页面像素尺寸重投影。缩放/重渲染不漂移 |
| 撤销粒度 | 按操作粒度（一次划词/矩形/笔迹/文字框/移动/缩放各为一个 op），非全量快照 |
| 撤销作用域 | per-paper 跨页，op 带 page，按栈顶 op 定位 |
| 选择/移动/缩放 | 默认态单击选中已有标注（8 手柄），拖本体=移动、拖手柄=缩放；高亮不可移动缩放只删 |
| 持久化 | IndexedDB 新增 `annotations` store，DB version 1→2；独立于现有 `papers` store |
| 代码块高亮 | highlight.js + github-dark 主题；自定义 react-markdown 的 `code` 组件；带复制按钮 |
| 测试 | 加 vitest，对坐标换算/op 栈纯函数单测 + tsc 类型检查 + 手动 E2E |

## 3. 架构与图层结构

### 每页 DOM 结构（在现有 `PdfPage` 内，`pdf-page-canvas-wrap` 里追加两层）

```
pdf-page-canvas-wrap (position:relative)
├── canvas              (PDF 位图,           z-index: 0)
├── div.highlight-layer (高亮色块,           z-index: 1, 在文字下方)
├── div.pdf-textlayer   (透明文字选择, 现有,  z-index: 2)
└── svg.annot-layer     (矩形/笔/文字,       z-index: 3, 在文字上方)
```

**为什么高亮单独一层在文字下方**：高亮后文字仍清晰、仍可选可复制。高亮模式关闭时（普通选文字）也不受影响。其他标注（矩形/笔/文字框）盖在文字上方。

**为什么用 SVG**：矩形=`<rect>`、笔迹=`<path>` polyline、文字=绝对定位 `<div>` 或 foreignObject。矢量、任意缩放清晰、React 友好、命中检测靠 DOM 原生。个人批注量级 SVG 完全够用，自由笔迹若以后真卡顿再局部换 Canvas。

### 坐标归一化（正确性命门）

所有标注存**页内归一化坐标**（相对页面宽高的 0..1 比例）。渲染时 ×当前页面像素尺寸反算。这样三件事都不漂移：
- 缩放（zoom 变化整页重画）
- DPR（高 DPI 屏幕）
- 懒渲染重画（页面滚出再滚回视口）

**坐标换算**：pointer 事件坐标先减页面包围盒 origin，再除以当前页面像素宽高 → 归一化。落盘归一化，渲染反算。

## 4. 数据模型

```ts
// frontend/src/types.ts 新增

export type AnnotationType = "highlight" | "rect" | "draw" | "text";

export interface NormRect { x: number; y: number; w: number; h: number; } // 0..1
export interface NormPoint { x: number; y: number; }                       // 0..1

export interface Annotation {
  id: string;
  arxiv_id: string;        // 关联论文，持久化用
  page: number;            // 1-based
  type: AnnotationType;
  color: string;           // hex，来自调色板
  createdAt: number;
  // 按类型选一的几何：
  highlight?: { rects: NormRect[] };   // 一段划词可能跨多行 → 多个矩形
  rect?:      { x: number; y: number; w: number; h: number };
  draw?:      { points: NormPoint[]; width: number };   // width 归一化笔触粗细
  text?:      { x: number; y: number; w: number; h: number; content: string; fontSize: number };
}

export type Op =
  | { kind: "add";    annot: Annotation }
  | { kind: "remove"; annot: Annotation }
  | { kind: "edit";   before: Annotation; after: Annotation }   // 文字内容改
  | { kind: "move";   before: Annotation; after: Annotation }   // 平移
  | { kind: "resize"; before: Annotation; after: Annotation };  // 缩放
```

**高亮几何来源**：划词后 `Selection.getRangeAt(0).getClientRects()` 拿到 textlayer 里文字的若干矩形 → 换算成归一化 → 存 `highlight.rects[]`。高亮跟着文字走，不依赖选区，刷新后依然准。

**调色板**（`frontend/src/lib/annotations.ts` 常量）：
```ts
export const PALETTE = [
  "#FFEB3B", // 黄
  "#A5F3A0", // 绿
  "#93C5FD", // 蓝
  "#F9A8D4", // 粉
  "#FDBA74", // 橙
  "#C4B5FD", // 紫
] as const;
```

## 5. 工具栏与交互

### 位置与布局

`.pdf-toolbar` 现有缩放按钮右边追加一组标注工具，沿用现有深色风格：

```
[− 100% +] | [🎨当前色块] [📝文字] [▭矩形] [✏画笔] [🖍高亮] | [↶撤销] [↷重做] | N pages
```

**颜色块 `🎨`**：显示当前色（小色块），点击展开预设调色板 6 色，选中即设当前色、关闭面板。当前色作用于全部四种工具。

### 四个工具行为

| 工具 | 触发 | 进行中 | 完成 | ESC |
|---|---|---|---|---|
| 📝 文字 | 点按钮→"放置文字"态，十字光标 | 点击页面某点→该点出现可编辑文本框直接输入 | 失焦/Enter→落盘，回默认态 | 取消正在输入的文本框（不落盘），回默认 |
| ▭ 矩形 | 点按钮→"画矩形"态 | 按住拖拽画框，松开前实时预览 | 松开→落盘，回默认态（一次性） | 取消正在画的框 |
| ✏ 画笔 | 点按钮→"自由绘"态 | 按住拖拽画连续笔迹 | 松开→落盘，回默认态（一次性） | 取消当前笔画 |
| 🕯 高亮 | **可勾选/取消**（开关式） | 勾选时：拖选文字→弹气泡选色→上色 | 点气泡颜色→落盘并关闭气泡 | 取消气泡（不上色）；高亮按钮勾选态不变 |

**关键区分**：文字/矩形/画笔一次性（画完自动回默认）；高亮开关式（勾选后持续生效，再点取消）。对应两种交互模式。

### ESC 总规则（三段优先级）

ESC 优先级 = ① 取消正在进行的绘制/输入/气泡 → ② 若没在画，清除当前浏览器文字选区 → ③ 高亮按钮勾选态保持不变（只清选区）。

### 指针事件切换

`.annot-layer` 的 `pointer-events`：绘制工具激活时 `auto` 接管指针；否则 `none` 透传到 textlayer 选文字。默认态下，单击命中已有标注则选中（阻止文字选区），点空白透传选文字。

## 6. 选择 / 移动 / 缩放 / 删除

- **选中**：默认态单击已有标注 = 选中（选中框 + 8 手柄：四角四边）。
- **移动**：选中后拖拽标注本体 = 平移，松开落盘（`move` op）。
- **缩放**：拖手柄 = 缩放。矩形/文字框：8 手柄，拖角等比、拖边单轴。笔迹：用包围盒 8 手柄整体缩放所有点。
- **高亮不可移动缩放**：点高亮只选中、显示删除按钮，无手柄（它绑文字，移动无意义）。
- **删除**：选中后 `Delete`/`Backspace` = 删除（`remove` op，可撤销）。
- **取消选中**：点空白 或 ESC。
- **移动/缩放优先级冲突**：绘制工具激活时单击总是开始新绘制（不选中已有）；默认态才选中。
- **选中态视觉**：蓝色虚线框 + 8 个白底蓝边圆点手柄；高亮选中态只有删除按钮。

### 最小尺寸防御

矩形/笔迹绘制或缩放小于 6px 归一化阈值时丢弃（防误触极小标注）；文字框空内容落盘时丢弃（防空标注）。

## 7. 撤销 / 重做

**机制**：每个变更产生一个 `Op`，push 进 undo 栈、清空 redo 栈。撤销 = 从 undo 弹出，应用反向（`add`↔`remove`，`edit`/`move`/`resize` 把 `after` 换回 `before`），push 进 redo。重做反之。所有 op 用 `before/after` 两个完整 annotation 快照，撤销=替换回 before，统一模型。

**作用域**：per-paper 跨页。op 带 `page`，撤销栈全局，按栈顶 op 的 page 定位。

**快捷键**：
- `Ctrl/Cmd + Z` 撤销
- `Ctrl/Cmd + Shift + Z`（或 `Ctrl+Y`）重做
- 工具栏 `↶` `↷` 按钮同样功能；栈空时 disabled。

## 8. 持久化（IndexedDB）

### 新增 store

DB version 1→2，走 `idb` 的 `upgrade` 钩子加 store，现有数据零迁移：

```ts
interface AnnoDB extends LaxDB {
  annotations: {
    key: string;                                    // annot.id
    value: Annotation;                              // 带 page/type/arxiv_id
    indexes: {
      "by-paper": string;                           // arxiv_id
      "by-paper-page": [string, number];            // [arxiv_id, page]
    };
  };
}
```

### 读写 API（`lib/db.ts` 新增）

- `listAnnotations(arxivId)` → 该论文全部标注（启动时一次性 load 进 store）
- `putAnnotation(a)` / `deleteAnnotation(id)` → 增删改，落盘
- `clearAnnotations(arxivId)` → 清空该论文（可选，第一版不做 UI）

### 加载与写时机

- **加载**：`PaperView` 挂载 → `listAnnotations(arxivId)` → 灌进 zustand store。每页 `PdfPage` 渲染时从 store 取本页标注重投影。
- **写**：每次落盘 op 立即写 DB（画完/输入完/上色完/移动缩放松开/删除）。撤销/重做也立即写回（删除或恢复对应记录）。刷新不丢。

### 与现有 `papers` store 关系

标注**独立 store**，不塞进 `papers`。`papers` 存全文缓存（大字符串），标注是结构化小数据，分开避免每次存全文连带序列化标注。`arxiv_id` 做关联键。

## 9. 代码块语法高亮（右栏）

### 现状

`ChatPanel` 用 `react-markdown` + remark-gfm + remark-math + rehype-katex，无自定义 `code` 组件，代码块是裸 `<pre><code>` 无高亮。

### 方案

新建 `frontend/src/components/CodeBlock.tsx`，react-markdown 的 `components={{ code }}` 自定义渲染，用 **highlight.js**：

- 取 `className` 里 `language-xxx`（有则指定语言调 `hljs.highlight`，无则 `hljs.highlightAuto` 自动检测）。
- `dangerouslySetInnerHTML` 渲染高亮 HTML。
- 行内 code（无 `<pre>` 包裹）不高亮，只高亮代码块。
- 主题：highlight.js `github-dark`，配浅色 `<pre>` 背景、横向滚动、等宽字体。
- **复制按钮**：代码块右上角，点一下复制到剪贴板（论文聊天高频操作）。
- 位置：`ChatPanel.tsx` 两个 `ReactMarkdown`（流式 pending + 落地消息）都接同一套 `components`。

### 依赖

`highlight.js` + `@types/highlight.js`（无单独 `@types`，highlight.js v11 自带类型，装 `highlight.js` 即可）。

### 为什么 highlight.js

Shiki 高亮质量最好但包大、浏览器构建慢，本地小工具过重；Prism 要手动按语言引组件配主题，胶水多。highlight.js 开箱 190+ 语言、自动检测、一个 import 搞定，契合自托管小工具。

## 10. 状态管理（zustand）

新建 `frontend/src/store/annotations.ts`：

```ts
interface AnnotationState {
  arxivId: string | null;
  byPage: Map<number, Annotation[]>;   // 按 page 索引的当前标注
  undo: Op[];                          // per-paper 全局栈
  redo: Op[];
  tool: "none" | "text" | "rect" | "draw" | "highlight";
  highlightOn: boolean;                // 高亮开关
  color: string;                       // 当前色
  selectedId: string | null;           // 选中标注
  // actions: load(arxivId), addAnnot, removeAnnot, moveAnnot, resizeAnnot, editAnnot,
  //           undo(), redo(), setTool, setColor, toggleHighlight, select
}
```

`PdfViewer`/`PdfPage` 订阅本页标注 + 当前工具；`AnnotationToolbar` 订阅 tool/color/undo/redo 栈长度。

## 11. 文件改动清单

| 文件 | 改动 |
|---|---|
| `frontend/src/types.ts` | 新增 `Annotation`/`Op`/`NormRect`/`NormPoint`/`AnnotationType`/`PALETTE` |
| `frontend/src/lib/annotations.ts` | 新文件：`PALETTE` 常量、`normalize`/`denormalize`/`rectsToNorm` 纯函数、`id()` 生成 |
| `frontend/src/lib/db.ts` | DB v2 加 `annotations` store + `listAnnotations`/`putAnnotation`/`deleteAnnotation`/`clearAnnotations` |
| `frontend/src/store/annotations.ts` | 新文件：zustand store + undo/redo 栈 |
| `frontend/src/components/AnnotationToolbar.tsx` | 新文件：工具栏（色块/文字/矩形/画笔/高亮/撤销/重做） |
| `frontend/src/components/PdfViewer.tsx` | `PdfPage` 加 `highlight-layer` + `annot-layer` SVG；接入 store；挂 `AnnotationToolbar`；ESC/快捷键 |
| `frontend/src/components/AnnotLayer.tsx` | 新文件：单页标注渲染 + 选中/移动/缩放手柄 + 绘制 pointer 逻辑 |
| `frontend/src/components/HighlightLayer.tsx` | 新文件：单页高亮色块渲染 |
| `frontend/src/views/PaperView.tsx` | 挂载时 `listAnnotations` load 进 store；arxivId 注入 |
| `frontend/src/components/CodeBlock.tsx` | 新文件：highlight.js 代码块 + 复制按钮 |
| `frontend/src/components/ChatPanel.tsx` | 两个 `ReactMarkdown` 接 `components={{ code: CodeBlock }}` |
| `frontend/src/index.css` | **末尾追加** `.annot-layer`/`.highlight-layer`/`.annot-toolbar`/`.code-block` 等类（纯追加，不动现有行，降低与界面优化 worktree 冲突） |
| `frontend/package.json` | 加 `highlight.js`、`vitest` 依赖 |
| `frontend/vitest.config.ts` | 新文件 |

## 12. 错误处理 / 边界

- **PDF 页面未渲染时**：标注层随 `PdfPage` 懒渲染，不在视口不渲染（数据仍在 store）。归一化坐标保证渲染即正确投影。
- **缩放重画**：现有 `PdfPage` 在 zoom/width 变化时重建 canvas+textlayer。标注层 SVG 在同一 effect 一起重建，从 store 取本页标注重画。
- **getClientRects 跨页**：划词只在单页 textlayer 内，`getClientRects` 全在该页坐标系，换算无歧义。
- **DB 迁移**：v1→v2 只加 store 不动旧数据，`idb` upgrade 原子，无失败路径。
- **空操作防御**：撤销栈空时按钮 disabled、快捷键 no-op；缩放过小丢弃；空文字框丢弃。

## 13. 测试

- **vitest 纯函数单测**（正确性命门）：
  - `normalize(point, pageSize)` / `denormalize(norm, pageSize)` 往返一致性
  - `rectsToNorm(clientRects, pageBox)` 多行矩形换算
  - op 栈状态机：add→undo→redo→edit→undo→move→undo 序列
- **tsc 类型检查**：`npm run typecheck` 保证 `Annotation`/`Op` 模型一致
- **手动 E2E**（沿用 memory 记的 Playwright + mock LLM rig，但标注纯前端不依赖 LLM）：
  - 开论文 → 画矩形 → 缩放 → 刷新页面标注还在 → 撤销重做 → 划词上色 → 移动/缩放/删除 → 代码块高亮 + 复制

## 14. 隔离与合并策略（与界面优化 worktree）

- 本功能另开 git worktree 独立分支实现，与界面优化 Agent 隔离。
- `index.css` 改动**纯追加在文件末尾**，不动现有行 → 合并冲突易解。
- `PdfViewer.tsx` 若界面优化也改，合并时手动 reconcile。
- 设计文档本身先落 `main`，两边 worktree 基于它。

## 15. 不做（YAGNI）

- 标注导出（PDF 烧录/JSON 导出）
- 多人协作标注同步
- 标注搜索/列表侧栏
- 笔触粗细多档选择（固定一档）
- 画笔换 Canvas（SVG 够用，卡顿再说）
- `clearAnnotations` UI（API 留口，第一版不暴露）
