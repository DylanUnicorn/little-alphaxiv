# Zotero 集成设计（Little Alphaxiv）

日期：2026-06-20
状态：设计已定（自驱动模式，用户授权自主实现）

## 目标

在 PDF 预览界面上方工具栏添加一个 Zotero 图标按钮，点击后弹出 Zotero 面板，实现：

1. **跳转到文献**（类 Zotero 浏览器插件）：在用户 Zotero 库中查找当前 arXiv 论文，命中则一键在 Zotero 桌面客户端中定位该条目（`zotero://select`）。
2. **类 Zotero MCP 操作**：
   - **查询**：搜索用户 Zotero 库（按标题/作者/任意字段），列出结果。
   - **添加**：把当前论文（元数据 + 可选 PDF）添加到 Zotero 库。
   - **整理**：列出/新建分类（collection），把当前论文加入分类。

## 背景与 API 现实

Zotero 有三套 API，能力互补（详见 memory `zotero-api-surface`）：

| 操作 | 本地 `/api/`（端口 23119，无 key） | Connector `/connector/`（无 key） | Web `api.zotero.org`（userID+key） |
|---|---|---|---|
| 读取/搜索条目、分类 | ✅ | ❌ | ✅ |
| 创建条目（+PDF 两步协议） | ❌ | ✅ | ✅ |
| 新建分类 / 加入分类 / 改 / 删 | ❌ | ❌ | ✅ |

- **本地模式**（零配置，需 Zotero 桌面运行 + 偏好设置开启"允许其他应用通信"）：读用 `/api/users/0/...`，建用 `/connector/saveItems`（+`saveAttachment` 两步挂 PDF）。无需任何密钥。
- **Web 模式**（需 userID + API key，库需同步到 zotero.org）：完整 CRUD，是唯一能"整理（建分类/加入分类）"的途径。
- 三套 API 均不发 CORS 头 → 浏览器直连不可行 → 走后端代理（符合本项目"哑管道"模式）。

## 架构

后端新增 **`backend/app/routers/zotero.py`**（无状态代理，凭据按请求传入，镜像 `openalex.py`/`llm.py` 模式）。前端新增 **`ZoteroPanel`** 组件 + `pdf-toolbar` 中的图标按钮 + settings 中的 Zotero 配置切片。

### 后端端点（`/api/zotero/*`，凭据均在 query/body）

1. `GET /api/zotero/status` — `{mode, user_id, api_key}` → 探测连通性。`auto` 模式先试本地（2s 超时）再试 Web。返回 `{ok, mode, libraryName?, itemCount?, error?}`。
2. `GET /api/zotero/items` — `{mode, user_id, api_key, q?, limit?, qmode?, collection_key?}` → 转发到本地 `/api/users/0/items` 或 Web `/users/<id>/items`。归一化为 `{key, title, creators, itemType, year, url, arxivId, abstract, collections[]}`。
3. `GET /api/zotero/collections` — `{mode, user_id, api_key}` → 列分类 `{key, name, parentKey?, numItems?}`。
4. `POST /api/zotero/items` — body `{mode, user_id, api_key, item}` → 本地 `connector/saveItems`；Web `POST /users/<id>/items`。返回 `{ok, key?}`（本地建后回读最新条目取 key）。
5. `POST /api/zotero/collections` — body `{mode, user_id, api_key, name, parent_key?}` → 仅 Web `POST /users/<id>/collections`。返回 `{ok, key?}`。
6. `POST /api/zotero/items/{key}/collections` — body `{mode, user_id, api_key, collection_keys[]}` → 仅 Web `PATCH /users/<id>/items/<key>` 带 `collections`。返回 `{ok}`。
7. `POST /api/zotero/save-arxiv` — body `{mode, user_id, api_key, paper:{arxiv_id,title,authors,doi,abstract,abs_url,published}, attach_pdf}` → 由 `Paper` 记录构造 Zotero 条目（`itemType=preprint`，`creators`，`DOI`，`url=abs_url`，`extra` 含 `arXiv: <id>` 以便日后按 arXiv id 命中）；创建后若 `attach_pdf` 且本地模式，后端抓取 `https://arxiv.org/pdf/<id>` 走两步 connector 协议挂 PDF。返回 `{ok, key?, pdfAttached?}`。

**路径/凭据规则**：本地模式 user 段恒为 `0`；Web 模式用传入 `user_id`。Web 模式加 `Zotero-API-Key` 头。本地连接器请求加 `X-Zotero-Connector-API-Version: 3`。`mode=auto` 由后端在 status/items 等读操作上解析为"先本地后 Web"。

### 前端

**settings store**（`store/settings.ts`）新增切片（镜像 `searchSources` 模式 + `onRehydrateStorage` 回填）：
```ts
export interface ZoteroConfig {
  mode: "auto" | "local" | "web";
  userId: string;   // Web 模式
  apiKey: string;   // Web 模式
}
```
+ `zotero: ZoteroConfig` 状态、`setZotero(patch)` 动作、默认 `{mode:"auto",userId:"",apiKey:""}`。

**Settings UI**（`views/SettingsView.tsx`）新增 "Zotero" 小节（镜像 Search sources）：模式选择（Auto/Local/Web）、userID 输入、API key 输入、帮助链接（如何开启本地 API；如何获取 Web key+userID）、"测试连接"按钮。

**api.ts** 新增类型化助手：`zoteroStatus / zoteroSearchItems / zoteroListCollections / zoteroCreateItem / zoteroCreateCollection / zoteroAddToCollection / zoteroSaveArxiv`，均接收 `cfg={mode,userId,apiKey}`。

**ZoteroPanel**（`components/ZoteroPanel.tsx`，由 `PdfViewer` 工具栏图标触发的浮层/模态）：
- 顶栏：标题 + 连接状态芯片（Auto/Local/Web · connected/offline）+ 关闭。
- Tab「本文」：打开即按 arxivId 搜库 → 命中显示"Found: <title> [在 Zotero 中打开]"；未命中显示"[加入 Zotero]"按钮（本地模式附"同时保存 PDF"复选框）。加入后变"已添加 ✓ [在 Zotero 中打开]"。
- Tab「文库」：搜索框 → 结果列表（标题/作者/年）→ 每行"在 Zotero 中打开"（`zotero://select/library/items/<key>`）。
- Tab「分类」：列分类；若本文已命中，可"加入分类"/"新建分类"（仅 Web 模式；本地模式显示提示"整理需切换到 Web API 模式"）。

**PDF 工具栏**（`components/PdfViewer.tsx`）：在 `<AnnotationToolbar />` 旁加 Zotero 图标按钮（内联 SVG，遵循本项目零图标库约定）。点击切换 `ZoteroPanel`（PdfViewer 内 `useState` 控制）。面板自行通过 `db.getPaper(arxivId)`（PdfViewer 已 import db）取论文元数据。

**打开 Zotero 条目**：渲染 `<a href={`zotero://select/library/items/${key}`} target="_blank" rel="noopener noreferrer">` 样式为按钮。Zotero 桌面注册了 `zotero://` 协议，锚点点击可唤起。

**CSS**（`index.css`）：新增 `.zotero-*` 类，复用现有变量（`--bg-2/--border/--accent` 等）与模式（`.dropdown-menu`/`.settings-shell`/`.toggle`）。

## 数据流

```
PdfViewer 工具栏图标 → ZoteroPanel(浮层)
  → api.ts zotero* → POST/GET /api/zotero/* (同源, Vite 代理)
    → 后端 zotero.py → 本地 127.0.0.1:23119 或 Web api.zotero.org
```

凭据从 `useSettings.zotero`（localStorage）取，按请求传给代理；后端不存任何状态。

## 错误处理

- 本地不可达（Zotero 未运行/未开开关）：status `ok:false, error:"local-unreachable"`。UI 提示开启 Zotero 偏好或切 Web 模式。
- Web 403（key 无效/无写权限）：透传错误。
- `auto`：先本地（2s 超时）→ 失败则 Web（若有 userId+apiKey）→ 否则离线。
- 加入分类/建分类在本地模式被拒：UI 明确提示需 Web 模式。

## 测试 / 验证

- 前端 `npm run typecheck`（本项目唯一 gate，无 lint）。
- 后端无测试（项目约定）：启动后 `curl /api/zotero/status?mode=local` 应返回 `ok:false`（本环境无 Zotero）——验证端点不崩。
- Playwright 冒烟（`tools/` 风格）：打开论文视图 → 点 Zotero 图标 → 面板渲染、显示离线状态、不崩。

## 范围与非目标

- 不做：Zotero 条目编辑/删除（Web 可扩展，但 v1 不做 UI）、群组库（仅用户库）、PDF 全文索引。
- 本地模式"整理"受限是 Zotero API 本身限制，非本设计偷懒——UI 会明确说明。

## 更新（2026-06-20）：完整元数据 + 笔记

初版 `save-arxiv` 只写 `title/creators/abstractNote/date/url/DOI/repository/extra`，且当 Paper 记录是裸 id 桩（直接 URL 导航时 `PaperView.onTextExtracted` 把 `title` 回退成 arxivId、其余字段为空）时，Zotero 条目标题就成了 arxivId、字段全空。本次修复：

- **根因修复（app 级）**：新增 `GET /api/paper?arxiv_id=` 后端端点（复用 arXiv `id_list` 查询 + `_parse_entry`，加 `doi` 提取 + 空-entry 守卫）。前端新增 `lib/paperMeta.ts` 的 `ensurePaperMeta(arxivId)`——若缓存记录无真实标题则从 arXiv 拉取并合并入 IDB（保留 `full_text`/`oa_pdf_url`）。`PaperView`（加载 + 文本提取）与 `ZoteroPanel`（添加前）都调用它，`onTextExtracted` 不再把标题降级为 arxivId。
- **字段补全**：`_build_arxiv_item` 现在写满 preprint 全字段——`title / creators / abstractNote / date / DOI / url / archive=arXiv / archiveID=<id> / repository=arXiv / libraryCatalog=arXiv / language=en / shortTitle`（冒号副标题派生）`/ extra="arXiv: <id>" / tags=[primary_category]`。后端 `_enrich_paper_from_arxiv` 作安全网：入参缺标题/作者时按 arxiv_id 从 arXiv 补齐（即使前端仍传桩也能产出完整条目）。
- **笔记（笔记）**：Web 模式创建真子笔记（`parentItem=<key>`，可靠）。**本地连接器不支持挂载子笔记**——`saveItems` 的 `parentItem` 仅对 `itemType=attachment` 生效，对 note 两种方式（同批次用 connector id、跨调用用 Zotero key）都只会产生孤立笔记（已对 Zotero 7/8 实测验证）。故本地模式只存元数据、不建笔记（避免污染文库），UI 在本地模式注明"笔记需 Web API 模式"。
- **验证**：前端 `typecheck` + 119 测试通过；后端 `py_compile` + 导入通过；直接 Python 管线测试（真实 arXiv id 拉取 + 桩补全 + 全字段构建）通过；Playwright 冒烟（面板渲染/三标签/状态芯片/关闭/无页面错误）通过；端到端——用裸 id 桩调 `save-arxiv` 命中用户真实 Zotero，读回确认标题为真实论文标题、全字段就位。
