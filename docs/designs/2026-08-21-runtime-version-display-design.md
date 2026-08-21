# Runtime Version Display Design

## Goal and placement

Little Alphaxiv should tell a running user which release they are using without
requiring them to inspect an image tag, Git checkout, or package manifest. The
version should appear in the expanded sidebar footer, below the existing
settings and logout actions. This location is available throughout the signed-in
app, but its muted auxiliary styling keeps the PDF and conversation as the
primary content. The collapsed paper-reading sidebar remains unchanged so the
new information does not consume scarce horizontal space.

The displayed copy is `Version v<value>`. While the request is in flight it is
`Version ...`; if the endpoint cannot be read it becomes `Version unavailable`.
That failure is informational only and must never block app boot, login, or
navigation. The text uses the existing theme tokens and the same 11px auxiliary
type scale as provider status. It introduces no new badge, color, or motion.

## Source of truth and data flow

A new repository-root `VERSION` file contains plain SemVer without a leading
`v`, initially `0.1.4`, matching the current latest GitHub release and frontend
package metadata. This is the canonical release version. A small backend module
resolves the file relative to its own source location, which works in all three
supported layouts: a source checkout, the Docker image, and the portable Linux
payload. It strips whitespace and falls back to `unknown` if the file is absent
or empty.

At import time the backend exposes the result as `APP_VERSION`. FastAPI uses it
for OpenAPI metadata, replacing the stale hard-coded `0.2.0`, and a public
`GET /api/version` endpoint returns `{ "version": "0.1.4" }`. The frontend
requests that endpoint from a small `AppVersion` component. Keeping the fetch
inside the component avoids adding version state to the user settings store and
keeps the feature independent of authentication or persisted data.

## Packaging, release workflow, and verification

The Dockerfile explicitly copies `VERSION` to `/app/VERSION`; the portable Linux
builder copies it to the payload root. The portable artifact name also defaults
to `v$(cat VERSION)`. Its existing `LAX_APP_VERSION` override remains accepted
only when it identifies the same version, preventing the filename and runtime UI
from disagreeing. Maintainer documentation will say to update `VERSION` as the
first release step and keep `frontend/package.json` synchronized.

Backend tests cover file reading, the fallback, FastAPI metadata, the endpoint,
and synchronization with frontend package metadata. Frontend tests cover the
loading, success, and unavailable states. The normal typecheck, Vitest suite,
backend pytest suite, production build, and a Docker runtime request verify the
complete path. No database migration or persistent-data change is required.
