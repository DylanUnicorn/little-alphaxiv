# deploy/ 目录重构 + 本地 dev 共用数据卷

**日期:** 2026-06-30
**状态:** 已批准并实施

## 背景

Docker 相关文件散落在仓库根(`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.env.docker.example`)+ `docker/entrypoint.sh`,数据卷 `./data/` 也在根。不符合专业软件管理规范。同时本地 dev(`backend/data/`)与 Docker(`./data/`)是两份独立数据,会分叉。

## 参考

sub2api 的 `deploy/` 模式:所有部署文件收进 `deploy/`,数据卷也在 `deploy/` 下,`.dockerignore` 留仓库根。

## 目标布局

```
little-alphaxiv/
├── deploy/                      ← 收纳所有部署事宜
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── entrypoint.sh
│   ├── .env.docker.example
│   └── data/                    ← 数据卷(bind mount,gitignored)
├── .dockerignore                ← 留根(build context 是根)
├── backend/  frontend/  ...
```

## 关键决策

1. **`.dockerignore` 留仓库根**:build context 是仓库根,Docker 只读根的 `.dockerignore`。加 `deploy/data/` 排除运行时数据。
2. **build.context = 仓库根**(`..`),`dockerfile: deploy/Dockerfile`;Dockerfile 里 `COPY deploy/entrypoint.sh`。
3. **数据卷挪到 `deploy/data/`**:compose `./data:/app/data` 相对 compose 文件即 `deploy/data/`。
4. **本地 dev 共用 `deploy/data/`**:`run.sh`/`run.bat` 自动设 `LAX_DATABASE_URL=sqlite:///../deploy/data/little_alphaxiv.db` + `LAX_PDF_CACHE=../deploy/data/pdf_cache`(仅当用户未自行设置时)。`backend/data/` 保留作历史数据。
5. **`.gitignore` 加 `deploy/data/`**:抓到 `deploy/data/.lax_secret_key` 原本未被忽略的漏洞(`*.db`/`*.log` 不匹配密钥文件名)。

## 文件改动

- `git mv` 4 文件进 `deploy/`,删 `docker/`
- `deploy/docker-compose.yml`:`build.context: ..`、`dockerfile: deploy/Dockerfile`、命令注释改 `cd deploy && ...`
- `deploy/Dockerfile`:`COPY deploy/entrypoint.sh`、注释更新
- `.dockerignore`:加 `deploy/data/`、`backend/data/`
- `.gitignore`:加 `deploy/data/`
- `backend/run.sh` + `run.bat`:自动设两个环境变量(仅当未设置)
- `backend/app/security.py`:注释 `docker/` → `deploy/`
- `tools/drive_password_reset.py`、`reset_password.py`、`measure_pdf_load.py`:路径 `backend/data` → `deploy/data`
- `README.md`、`README.zh-CN.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`backend/.env.example`、`deploy/.env.docker.example`:文档全面更新

## 用户命令变化

| 操作 | 之后 |
|---|---|
| 启动容器 | `cd deploy && docker compose up -d` |
| 看日志 | `docker logs little-alphaxiv`(任意位置)或 `cd deploy && docker compose logs -f` |
| 本地 dev | `cd backend && run.bat`(脚本自动设环境变量) |

## 验证(全流程跑通)

1. `cd deploy && docker compose build` ✓(`COPY deploy/entrypoint.sh` 正确)
2. `cd deploy && docker compose up -d` → healthy ✓
3. 卷落点 = `deploy/data/` ✓
4. 迁移真实数据(含 dyyyy 账号)→ 容器 DB 有 dyyyy ✓
5. forgot-password → docker logs 出现重置链接 ✓
6. pytest 22 passed ✓
7. 本地 dev 路径解析(`LAX_DATABASE_URL=sqlite:///../deploy/data/...`)→ 解析出的 DB 存在且有 dyyyy ✓

## 不在范围内

- 不改 `app/paths.py` 默认路径逻辑(仍 `backend/data/` 作 fallback,run 脚本覆盖到 `deploy/data/`)
- 不删 `backend/data/`(保留历史数据)
- 不引入 named volume(保持 bind mount)
- 不改 entrypoint.sh 逻辑(只移位置)
