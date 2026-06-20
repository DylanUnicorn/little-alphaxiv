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

## 增补：新论文添加时的分类选择（2026-06-20）

### 问题
「本文」Tab 里发现论文不在库中、点「Add to Zotero」时，新条目落到一个用户无法在面板里控制的分类——体感"随机加的"。

### 根因（已对照 Zotero 源码 `chrome/content/zotero/xpcom/server/server_connector.js` 核实）
- **本地/connector 模式**：`/connector/saveItems` 的 `init` 调 `Zotero.Server.Connector.getSaveTarget()`，取桌面 GUI 当前选中的 library/collection（`zp.collectionsView.selectedTreeRow`）作为 target，**完全不读请求体里的 `collections`**。item 上的 `collections`/`parentItem` 等字段被静默忽略（参见 zotero-mcp issue #138 对 `parentItem` 的同类证实）。所以本地模式无法通过请求体指定目标分类——条目落到 Zotero 桌面当前选中分类，这就是"随机"的真相。
- **Web 模式**：`POST /users/<id>/items` 在创建时 honor `item.collections=[key]`，条目直接进指定分类。✅ 可靠。
- 本地 `/api/` 只读（写 501），connector 不能移动已有条目，故本地模式创建后也无法补救性地把条目挪进指定分类。

### 设计
按模式如实分流，把"随机"变成"可见可控"：

- **Web 模式**：「Add to Zotero」上方加一个分类 `<select>`（选项：`My Library`（=不进任何分类）+ 用户各分类，复用 `/zotero/collections`）。所选 key 随创建请求传给后端 → 后端在 web 分支设 `item["collections"]` → 条目直接进该分类。可靠。
- **本地模式**：不显示选择器（选了也没用），改为显示「Saving to: <name>」——`name` 来自新增的 `/zotero/selected-collection`（代理 `/connector/getSelectedCollection`，返回桌面当前选中分类名）。并提示"在 Zotero 里改当前选中分类，或切到 Web API 在此选择"。这让用户知道条目会落到哪、且可在 Zotero 端控制，消除"随机"感。

### 后端改动（`backend/app/routers/zotero.py`）
1. `SaveArxivRequest` 增 `collection_keys: list[str]`（默认空）。
2. `save_arxiv` web 分支：`if req.collection_keys: item["collections"] = req.collection_keys`（创建前）。本地分支不传（connector 忽略，传了也无害，但为清晰不传）。
3. 新端点 `GET /zotero/selected-collection`：本地模式 POST `/connector/getSelectedCollection`（body `{}`，头 `X-Zotero-Connector-API-Version: 3`），归一化返回 `{ok, mode, libraryName, collectionName, collectionId}`；web 模式返回空名（无 GUI 选中概念）。connector 端点在 Zotero 运行时即可用（不依赖"允许其他应用通信"偏好，但本地模式由 `_local_alive()` 保证该偏好已开，故 connector 必然可用）。

### 前端改动
- `lib/api.ts`：`zoteroSaveArxiv` 增第 4 参 `collectionKeys`（→ `collection_keys`）；新增 `zoteroGetSelectedCollection(c)`。
- `components/ZoteroPanel.tsx`：「本文」未命中态按 `webMode` 分流（选择器 / 目标显示）；`loadCollections` 加 `collLoaded` 幂等守卫与 `force` 参数（创建分类后强制刷新）；新增 `localTarget` 状态与拉取 effect；`addToZotero` 传 `collectionKeys` 并在成功消息里点名目标分类。
- `index.css`：`.zotero-coll-pick*`（选择器行）与 `.zotero-target`（本地目标显示）样式，复用现有 CSS 变量。

### 非目标（沿用）
- 不在本地模式伪装可选择分类（Zotero API 不支持，伪选择会误导）。
- 不做创建分类的快捷入口于「本文」Tab（Collections Tab 已有 Web 模式建分类）。

