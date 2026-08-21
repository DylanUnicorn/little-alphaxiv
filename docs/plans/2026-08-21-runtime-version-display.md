# Runtime Version Display Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Add one canonical runtime version file, package it in every supported distribution, and show it unobtrusively in the app sidebar.

**Architecture:** The root `VERSION` file is the release source of truth. FastAPI reads it once, exposes it through application metadata and `/api/version`, and the React sidebar fetches and renders that value with a non-blocking fallback.

**Tech Stack:** FastAPI, Python 3.10+, React 18, TypeScript, Vitest, Docker, Bash portable packaging.

---

### Task 1: Define and test the backend version contract

**Files:**
- Create: `VERSION`
- Create: `backend/app/version.py`
- Create: `backend/tests/test_version.py`
- Modify: `backend/app/main.py`

1. Write tests that require the root file to match frontend package metadata,
   cover missing and blank-file fallbacks, and assert both FastAPI metadata and
   `GET /api/version` use the same value.
2. Run `python -m pytest tests/test_version.py -q` from `backend/` in
   `Agent_env`; expect the first run to fail because the module is absent.
3. Add `VERSION`, implement `read_version()`, set `APP_VERSION`, wire FastAPI,
   and add the public endpoint.
4. Re-run the focused test; expect all cases to pass.

### Task 2: Add and test the sidebar display

**Files:**
- Create: `frontend/src/components/AppVersion.tsx`
- Create: `frontend/src/components/AppVersion.test.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/index.css`

1. Write component tests for loading, `Version v0.1.4`, and
   `Version unavailable` states.
2. Run `npx vitest run src/components/AppVersion.test.tsx`; expect failure
   because the component does not exist.
3. Add the typed API call and component, mount it at the bottom of the expanded
   sidebar, and style it with existing theme tokens.
4. Re-run the focused test and `npm run typecheck`; expect both to pass.

### Task 3: Make releases carry the same version

**Files:**
- Modify: `deploy/Dockerfile`
- Modify: `packaging/linux/build-linux-run.sh`
- Modify: `packaging/linux/README.md`

1. Copy root `VERSION` into `/app/VERSION` in Docker and into the portable
   payload root.
2. Make the portable artifact name default to the file version and reject a
   conflicting `LAX_APP_VERSION` override.
3. Document that releases update `VERSION` first and synchronize frontend
   package metadata.
4. Inspect the assembled packaging diff and run `git diff --check`.

### Task 4: Verify and deliver

**Files:**
- Verify all files above.

1. Run frontend typecheck, full Vitest, and production build.
2. Run the full backend pytest suite inside `Agent_env`.
3. Build and run an isolated Docker image, request `/api/version`, and verify the
   response matches `VERSION` without touching `deploy/data/` or the current
   application container.
4. Commit, push `codex/show-app-version`, open a PR, wait for frontend and
   backend CI, and merge only when both are green.
5. Pull `main`, remove the worktree safely, delete local and remote feature
   branches, prune remote refs, and verify no completed feature branch remains.
