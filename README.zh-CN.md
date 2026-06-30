<div align="center">

# Little Alphaxiv

[English](./README.md) | **中文**

**一个自托管、alphaxiv 风格的 arXiv 论文阅读工作区。**
用 LLM 聊天发现论文，再与「懂这篇论文」的助手并排阅读 PDF。自带 API
key，数据留在你自己的服务器上。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](./deploy/docker-compose.yml)
[![Python](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)](./backend/requirements.txt)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

## 🎬 演示

<details>
<summary><b>点击展开演示 GIF</b></summary>

| 通用聊天 → 论文发现 | 论文视图（PDF + 懂论文的助手） |
|:---:|:---:|
| <img src="./example_demo/main-paper-chat.gif" width="420" alt="通用聊天发现论文" /> | <img src="./example_demo/pdf-preview-page.gif" width="420" alt="论文视图：PDF 与助手" /> |

| PDF 划线高亮与批注 | Zotero 笔记同步 |
|:---:|:---:|
| <img src="./example_demo/change-theme.gif" width="420" alt="PDF 划线高亮与批注" /> | <img src="./example_demo/zotero-sync.gif" width="420" alt="批注同步到 Zotero" /> |

</details>

---

Little Alphaxiv 是一个自托管的 arXiv 论文阅读与讨论工作区。用自然语言告诉
助手你想找什么，它会搜索 arXiv（可选联网搜索），把结果渲染成可点击的卡片。
点击其一，左侧打开 PDF，右侧是「懂这篇论文」的助手——论文全文已注入对话上下
文，所以你能讨论论文的*真实内容*、划线高亮、做批注，并把笔记同步到 Zotero。

自带 OpenAI 兼容 API key——没有配额、没有共享账号、不锁定厂商。OpenAI、
OpenAI 兼容的 Anthropic 网关、本地 Ollama 的 OpenAI shim、one-api/new-api
等都可用。

每个用户注册自己的账号；聊天历史、PDF 批注、provider 设置都存在**服务器**
的 SQLite 数据库里，API key **以 Fernet 加密存储**。换浏览器？重新登录，一
切都在。

```
 ┌─ Sidebar ─┐  ┌── General chat ──┐     ┌── Paper view ──────────────────┐
 │ + New chat│  │  find me papers   │     │  PDF (pdf.js)  │  Assistant     │
 │ conv list │  │  on X ...         │     │  preview       │  (paper text   │
 │ ⚙ Settings│  │  [clickable cards]│ ──▶ │  (left)        │   in context)  │
 │ ⎋ Log out │  └───────────────────┘     └────────────────┴────────────────┘
 └───────────┘
```

## ✨ 功能特性

- **对话式论文发现** — 用自然语言描述需求；助手调用 `search_arxiv` 工具
  （可选 `web_search`），把结果渲染成可点击的论文卡片。
- **论文感知聊天** — pdf.js 一次性提取全文（全局缓存、跨用户去重）；助手
  讨论论文的真实内容。
- **PDF 批注** — 矩形 / 自由画笔 / 文本 / 高亮工具，带撤销-重做操作栈，按
  用户隔离、服务端持久化。
- **用户账号** — 注册/登录、httpOnly 会话 cookie、bcrypt 密码；每个查询都
  按已认证用户隔离。
- **API key 加密存储** — 明文 key 只在保存时离开浏览器一次；之后界面只显示
  掩码预览（`sk-m…cret`）。
- **密码找回** — 邮件重置（SMTP 或控制台）、一次性令牌、重置时清除所有会话。
- **多 provider** — 配置多个 OpenAI 兼容 provider，按会话或全局设置默认。
- **Zotero 集成** — 本地 + connector + web API；从批注一键同步笔记。
- **11 套主题** — 深色优先，含 sepia 与 solarized，适合长时间阅读。
- **一次性「浏览器 → 服务器」迁移** — 若你用过旧的纯浏览器版本，首次登录
  时本地数据会导入你的账号。

## 🧱 技术栈

| 层     | 技术 |
|--------|------|
| 后端   | FastAPI, SQLModel, aiosqlite, Alembic, uvicorn |
| 前端   | React 18, Vite 5, TypeScript, pdf.js, Zustand |
| 数据库 | SQLite（WAL 模式） |
| 认证   | httpOnly 会话 cookie（itsdangerous）+ bcrypt + Fernet |
| PDF    | pdf.js（文本提取 + 批注层） |
| 工具链 | Vitest（前端）、pytest（后端）、Playwright（E2E） |

## 🚀 快速开始（Docker）

运行 Little Alphaxiv 最快的方式——单个镜像同时构建前端并由后端同源提供服
务。`LAX_SECRET_KEY` 会在首次启动时自动生成并写入 `deploy/data` 卷，所以**零配
置**即可启动。

```bash
git clone https://github.com/DylanUnicorn/little-alphaxiv.git
cd little-alphaxiv
cd deploy && docker compose up -d   # 构建并在 http://127.0.0.1:8000 启动
```

然后：

1. 打开 **http://127.0.0.1:8000** → 跳转到 `/login`。
2. 点击 **注册**，填写用户名 + 邮箱 + 密码。
3. 进入 **⚙ 设置 → Providers**，添加一个 OpenAI 兼容 provider（见下方「配置
   提供商」一节），设为默认。
4. 回到聊天——问：*「找几篇近期关于 vision transformer 的论文」*。

数据（SQLite 数据库、PDF 缓存、持久化的 secret key）都在 `deploy/data/`。
查看日志：`docker compose logs -f little-alphaxiv`（在 `deploy/` 下运行，或任意
位置 `docker logs little-alphaxiv`）。停止：`docker compose down`。

> **无需 SMTP 的密码找回：** 默认情况下，重置链接会打印到容器日志（本地用
> 无需邮件服务器）。若要发送邮件，在 `docker-compose.yml` 同目录放一个 `.env`
> 并设置 `LAX_SMTP_URL`——见「配置（环境变量）」一节。

## 📦 安装

### A. Docker（推荐）

见上方「快速开始」。所有 Docker 文件都在 `deploy/` 目录下——命令都在那里运
行。可选的高级配置：在 `deploy/` 下拷贝 `.env`（从 `deploy/.env.docker.example`）：

```bash
cd deploy
cp .env.docker.example .env      # 可选——所有值都有合理默认
# 编辑 .env 设置 LAX_PORT、LAX_SMTP_URL、LAX_SECURE_COOKIES 等
docker compose up -d
```

不改 compose 文件自定义端口：

```bash
cd deploy
LAX_PORT=8080 docker compose up -d
```

### B. 本地开发（两个终端，仅 localhost）

```bash
# 终端 1 — 后端（Python 3.10+）
cd backend
./run.sh                        # Windows: run.bat
# run.sh/run.bat 自动把后端指向 deploy/data/（与 Docker 共用同一数据目录），
# 本地 dev 与容器共享同一份 DB + 密钥——不会分叉。首次启动自动创建
# deploy/data/little_alphaxiv.db 并生成 deploy/data/.lax_secret_key。

# 终端 2 — 前端
cd frontend
npm install
npm run dev                     # http://127.0.0.1:5173
```

打开 **http://127.0.0.1:5173** → 注册 → 添加 provider → 聊天。Vite 把
`/api/*` 代理到 `http://127.0.0.1:8000`。默认配置无需任何环境变量——
`run.sh`/`run.bat` 已为你设好 `LAX_DATABASE_URL` + `LAX_PDF_CACHE` 指向
`../deploy/data/`（自行设置则覆盖）。**不要**同时跑后端和容器——它们共用同一
个 SQLite 文件，二选一。

> **从旧版本升级？** 若你的数据还在旧的 `backend/data/`（2026-06-30 之前），
> 拷进 `deploy/data/` 即可继续用：`cp -r backend/data/* deploy/data/`
> （Windows：`Copy-Item backend\data\* deploy\data\ -Recurse -Force`）。数据原样
> 保留——Fernet 密钥复用，加密的 API key + 现有会话继续可用。全新安装则在
> `deploy/data/` 从空开始。

> Windows 用户：优先用 `run.bat` 而非 `bash run.sh`——`bash` 可能解析到
> WSL，其 Python 3.8 无法解析后端的 `str | None` 语法（需 Python 3.10+）。

### C. 局域网多用户（同事各自注册登录）

`run.sh`/`run.bat` 只绑定 `127.0.0.1`。若要局域网访问，用后端**同源**服务构
建好的前端（避免所有 cookie/CORS 麻烦）：

```bash
cd frontend && npm run build     # 产出 frontend/dist
cd ../backend
uvicorn app.main:app --host 0.0.0.0 --port 8000   # 自动把 frontend/dist 挂载到 "/"
```

找到你的局域网 IP（`ipconfig` → 那个 `192.168.x.x`）。同事打开
**`http://<你的IP>:8000/`**，各自注册账号、添加自己的 provider、聊天。每个
人的数据相互独立、互不可见。

> ⚠️ `--host 0.0.0.0` 会把后端暴露出去——只用于局域网，别直接暴露到公网
> （数据库里存着所有人加密的 API key + 聊天历史）。若要上公网，加 TLS 并设
> `LAX_SECURE_COOKIES=true`。

## 🔑 配置提供商

点击 ⚙ **设置 → Providers** → 添加一个 OpenAI 兼容 provider：

| 字段     | 示例                                   |
|----------|----------------------------------------|
| 名称     | OpenAI / My Gateway                    |
| Base URL | `https://api.openai.com/v1`            |
| API key  | `sk-...`                               |
| 模型     | `gpt-4o-mini`                          |

任何 OpenAI 兼容端点都行（OpenAI、OpenAI 兼容的 Anthropic 网关、本地 Ollama
的 OpenAI shim、one-api/new-api 等）。设一个为默认。key 只发送到服务器一
次，用 Fernet 加密后存储；之后界面只显示掩码预览。

## ⚙️ 配置（环境变量）

全部可选——默认值即可用于 localhost。Docker 下在 `deploy/docker-compose.yml`
同目录的 `.env`（从 `deploy/.env.docker.example` 拷贝）设置；本地开发由
`run.sh`/`run.bat` 自动设好数据目录变量，仅当需覆盖其它变量时才拷贝
`backend/.env.example` → `backend/.env`。

| 变量 | 默认 | 用途 |
|-----|---------|---------|
| `LAX_DATABASE_URL` | `sqlite:///./data/little_alphaxiv.db` | SQLite 文件（相对路径基于 `backend/` 解析）。`run.sh`/`run.bat` 指向 `../deploy/data/little_alphaxiv.db`；Docker 下为 `sqlite:////app/data/little_alphaxiv.db`。密钥与重置日志与 DB 同目录。 |
| `LAX_SECRET_KEY` | *(自动生成)* | 用于加密存储的 API key + 签名会话 cookie 的 Fernet key。首次运行自动生成并写入 `deploy/data/.lax_secret_key`（本地 dev 与 Docker 共用）——DB、PDF 缓存、密钥、重置日志均集中在同一数据目录。**务必保密——丢失它会让所有加密 key + 会话全部失效。** |
| `LAX_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | CORS 允许的浏览器来源，逗号分隔。因 cookie 携带凭据，固定列表（不允许 `*`）。跨源运行时加上你的局域网来源。 |
| `LAX_SECURE_COOKIES` | `false` | 在 HTTPS 后设为 `true`，让会话 cookie 带 `Secure` 标记。 |
| `LAX_SESSION_MAX_AGE_DAYS` | `30` | 会话 cookie + 记录的存活天数。 |
| `LAX_SMTP_URL` | *(未设置)* | 发送密码重置邮件的 SMTP URL，如 `smtps://user:pass@smtp.gmail.com:465`。未设置 → 重置链接打印到日志（本地零配置）。 |
| `LAX_SMTP_FROM` | *(SMTP 用户)* | 重置邮件的发件人地址。 |
| `LAX_PASSWORD_RESET_TTL_MIN` | `30` | 重置链接存活分钟数。 |
| `LAX_PDF_CACHE` | `deploy/data/pdf_cache` | PDF 磁盘缓存目录（按内容寻址、全局、非敏感）。`run.sh`/`run.bat` 指向此处；Docker 下为 `/app/data/pdf_cache`。 |
| `LAX_PORT` | `8000` | *(仅 Docker)* 暴露的宿主端口。 |

## 🧠 工作原理

- **认证 + 持久化：** 注册/登录；后端设置 httpOnly `lax_session` cookie（用
  `itsdangerous` 签名，在 `sessions` 表里查——登出即删该行）。每个 API 调用
  都按已认证的 `user.id` 隔离。聊天历史、批注、provider 配置、设置都存在
  SQLite 里，按用户隔离。
- **发现（通用聊天）：** 你描述需求；助手调用 `search_arxiv`（可选
  `web_search`）；结果渲染成可点击的论文卡片。点击 → 论文视图。
- **论文视图：** PDF 经代理加载（缓存到磁盘）；pdf.js 一次性提取全文，缓存
  在**全局** `papers` 表（同一 arxiv_id → 同一份文本，跨用户去重）；该文本注
  入聊天上下文。
- **工具在浏览器里跑。** 后端负责代理 + 持久化；OpenAI 风格的工具调用循环
  在前端（`src/lib/llm.ts`）。
- **一次性迁移：** 从旧的纯浏览器版本升级后首次登录时，若浏览器仍持有旧的
  IndexedDB + localStorage 数据，应用会提示导入到你的账号（幂等）。

更深入的架构介绍见 [`CLAUDE.md`](./CLAUDE.md)。

## 📁 项目结构

```
little-alphaxiv/
├── backend/                  # FastAPI：代理 + 按用户持久化 + 认证
│   ├── app/
│   │   ├── main.py           # FastAPI 应用、lifespan、CORS、静态挂载、路由
│   │   ├── security.py       # Fernet（key）+ bcrypt（密码）+ itsdangerous（会话）
│   │   ├── db.py             # 异步引擎、WAL PRAGMA、会话工厂
│   │   ├── models.py         # SQLModel 表 + password_reset
│   │   ├── deps.py           # current_user —— 按用户隔离的总入口
│   │   ├── email.py          # 密码重置投递（SMTP 或控制台）
│   │   └── routers/          # auth, providers, settings, conversations,
│   │                         #   annotations, papers, llm, search, pdf, models,
│   │                         #   zotero, zotero_note_sync, migrate, websearch, …
│   ├── alembic/              # 迁移（lifespan 启动时跑 `upgrade head`）
│   ├── tests/                # pytest（conftest 为每个测试建临时 SQLite）
│   ├── requirements.txt
│   └── run.sh / run.bat
├── frontend/                 # Vite + React + TypeScript SPA
│   ├── src/
│   │   ├── lib/              # api, llm（工具调用循环）, stores, annotations
│   │   ├── components/       # ChatPanel, PdfViewer, AnnotLayer, Sidebar, …
│   │   ├── views/            # ChatView, PaperView, SettingsView
│   │   └── store/            # zustand stores（登录时从后端水合）
│   └── package.json
├── tools/                    # Playwright E2E 驱动 + mock LLM + 管理 CLI
├── docs/designs/             # 已验证的设计文档
├── deploy/                   # 所有 Docker 文件（构建 + 运行 + 数据卷）
│   ├── Dockerfile            # 多阶段：构建前端 → 运行后端并服务 dist
│   ├── docker-compose.yml    # 一键自托管运行（build context = 仓库根）
│   ├── entrypoint.sh         # 自动生成并持久化 LAX_SECRET_KEY
│   ├── .env.docker.example   # 可选的 compose 环境变量覆盖
│   └── data/                 # 运行时数据卷（DB + 密钥 + PDF 缓存；已 gitignore）
└── .dockerignore             # 构建上下文排除（留在仓库根）
```

## 🔒 安全

- API key 服务端存储、**Fernet 加密存储**（以 `LAX_SECRET_KEY` 为 key）。明
  文 key 只在保存 provider 时离开浏览器一次；仅在单次上游 LLM 调用期间在内存
  中解密（或向你本人展示掩码预览）。绝不写日志。
- 密码用 bcrypt 哈希。会话是 httpOnly + 签名 cookie，由数据库表支撑（登出 =
  删行）。
- 密码重置令牌一次性、有 TTL，且只存 `sha256(token)`。`forgot-password` 端
  点始终返回相同的通用成功响应——绝不透露账号是否存在（防枚举）。重置会清除
  该用户所有会话。
- 本应用面向**可信局域网**设计。若要上公网，必须加 TLS
  （`LAX_SECURE_COOKIES=true`）并重新考虑注册是否开放。

## 🗺 路线图

| 方面 | 状态 |
|------|------|
| 认证、持久化、加密 key、密码找回 | ✅ 已验证 |
| arXiv 搜索 + 工具调用、PDF 预览、论文聊天 | ✅ 已验证 |
| PDF 批注（矩形/画笔/文本/高亮） | ✅ 已验证 |
| Zotero 集成（本地 + web） | ✅ 可用；按请求传凭据（v1） |
| 通过 anysearch MCP 的 `web_search` | ⏳ 占位——真实接入待办 |

已知待办（非阻塞）见 [`CLAUDE.md`](./CLAUDE.md)。主要几项：真实 anysearch
MCP 接入；`tools/` 里若干 Playwright 驱动仍用旧的 localStorage seed 模式；
Zotero 路由仍按请求传凭据（功能正常，未来清理）。

## 🤝 贡献

欢迎贡献！完整指南见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。简版：

```bash
# 后端（Python 3.10+）
cd backend && ./run.sh                 # Windows: run.bat

# 前端
cd frontend && npm install && npm run dev

# 测试（gate）
cd frontend && npm run typecheck && npm test      # 前端（TS + Vitest）
cd backend && python -m pytest                   # 后端（pytest）
```

E2E 测试套件（Playwright + `:5050` 上的 mock LLM）让你**无需真实 API key**
即可验证前端改动——见 [`tools/mock_llm.py`](./tools/mock_llm.py) 与
`tools/drive_*.py` 驱动。`drive_auth_persistence.py` 与
`drive_password_reset.py` 是核心回归用例。

开 PR 前：跑上述 gate、保持 diff 聚焦、较大改动先
[开 issue](https://github.com/DylanUnicorn/little-alphaxiv/issues) 对齐方向。

## ❓ 常见问题

<details>
<summary><b>我的 API key 安全吗？</b></summary>

你的 key 只发送到服务器一次（经回环/局域网），用 Fernet 加密后存储。仅在单次
上游 LLM 调用期间在内存中解密，绝不写日志。浏览器只持有掩码预览。但若丢失
`LAX_SECRET_KEY`，所有加密 key + 会话都会失效——请备份
`deploy/data/.lax_secret_key`（本地 dev 与 Docker 共用）。
</details>

<details>
<summary><b>能部署到公网吗？</b></summary>

本应用面向可信局域网设计。若要公开暴露，请加 TLS、设
`LAX_SECURE_COOKIES=true`、收窄 `LAX_ALLOWED_ORIGINS`，并重新考虑注册是否开
放（任何注册者都能在你服务器上存加密 key + 聊天历史）。
</details>

<details>
<summary><b>论文是怎么存的？会共享吗？</b></summary>

PDF 全文一次性提取并缓存在**全局** `papers` 表（按 arxiv_id 跨用户去重——同
一篇论文只存一份）。你的*对话*与*批注*按用户隔离、互不可见。PDF 文件缓存按
内容寻址、非敏感。
</details>

<details>
<summary><b>我忘了密码、且账号没绑邮箱。</b></summary>

在要求邮箱之前创建的账号无法走邮件流程。登录时在「设置 → 账号」里设置邮
箱；或若你现在就被锁在外面——用管理 CLI 直接重置：

```bash
python tools/reset_password.py <username>   # 在数据库里直接 bcrypt 哈希一个新密码
```
</details>

<details>
<summary><b>支持哪些 LLM provider？</b></summary>

任何 OpenAI 兼容的 `/v1/chat/completions` 端点：OpenAI、OpenAI 兼容的
Anthropic 网关、本地 Ollama 的 OpenAI shim、one-api/new-api 等。在「设置 →
Providers」里填 base URL + key。
</details>

## 📄 许可证

基于 [MIT 许可证](./LICENSE) 发布 —— © 2026 DylanUnicorn 及贡献者。

---

<div align="center">

**如果 Little Alphaxiv 对你有用，欢迎点个 ⭐ —— 帮助更多人发现它。**

</div>
