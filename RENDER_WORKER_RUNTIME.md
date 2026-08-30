# Render Worker — Runtime & Deployment (Module 7 Phase 7.5)

The **render / media worker** is a dedicated `apps/worker` process whose
`WORKER_QUEUES=MEDIA`. It is the only consumer of the MEDIA queue —
image / voice / subtitle generation **and** video rendering
(`media.video-render.v1`). The general worker (`WORKER_QUEUES=SYSTEM,AI`)
never binds a MEDIA handler, so a render failure cannot affect SYSTEM/AI
work (checkpoint §27).

Run it as a **separate service, independently scaled** — see
`docker/docker-compose.yml`'s `render-worker` service. Scale renders by
adding replicas, never by raising `RENDER_CONCURRENCY` (frozen: 2
concurrent renders global, FRD §21.1).

## Render engines

| `RENDER_ENGINE`      | Deps required                        | Used by                          |
| ------------------- | ------------------------------------ | -------------------------------- |
| `deterministic-test` (default) | none                     | all automated tests, CI, local dev |
| `remotion`          | Remotion + Chromium + FFmpeg (below) | production render worker only    |

The deterministic engine produces a byte-reproducible, structurally valid
MP4 whose `moov` truthfully encodes the export-profile geometry, the
narration-scaled timeline duration, and the fps. It exercises the full
`materialize → render → inspect → checksum → ACTIVE VIDEO MediaAsset →
Gate #4 → QA → Gate #5` chain without a browser. It does **not** paint
pixels — it is a CI stand-in, not a player-ready file.

## Production render worker image (`RENDER_ENGINE=remotion`)

Deliberately **not** in this repo's `package.json` / lockfile so the
general worker and CI never pull a browser. A production render-worker
image must add, at build time:

- npm deps: `@remotion/renderer`, `@remotion/bundler`, `remotion`,
  `react`, `react-dom` (versions pinned by the deploy, not this repo)
- **Chromium** — a system install (`RENDER_CHROMIUM_PATH=/usr/bin/chromium`)
  or Remotion's bundled browser (`npx remotion browser ensure` at build)
- **FFmpeg / ffprobe** on `PATH`
- the fonts the composition references (`Inter`, plus any brand fonts)
- the composition sources (`apps/worker/src/render/remotion/**`, which are
  `.tsx` excluded from `tsc` and bundled from source by `@remotion/bundler`)
  with `REMOTION_ENTRY` pointing at `.../remotion/index.tsx`

`RemotionRenderEngine` lazy-loads `@remotion/*` by non-literal specifier;
a misconfigured deploy fails loudly on the first render with a clear
message, never at import time.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `WORKER_QUEUES` | *(required)* | `MEDIA` for the render/media worker |
| `RENDER_ENGINE` | `deterministic-test` | `remotion` in production |
| `RENDER_ENGINE_VERSION` | `WORKER_APPLICATION_VERSION` | stamped onto every render job + VIDEO asset metadata |
| `RENDER_CONCURRENCY` | `2` | global concurrent renders (FRD §21.1); scale via replicas |
| `RENDER_TEMP_DIR` | OS tmp + `myev-render` | per-job isolated dir, sanitized paths, hard-deleted after every job (checkpoint §28) — never a named volume |
| `RENDER_MAX_OUTPUT_BYTES` | `2147483648` | fail-closed ceiling on a produced render |
| `RENDER_CHROMIUM_PATH` | *(unset)* | system Chromium for the Remotion engine |
| `REMOTION_ENTRY` | `<cwd>/src/render/remotion/index.tsx` | composition entry for `@remotion/bundler` |
| `MEDIA_MAX_SIZE_VIDEO_BYTES` | `2147483648` | MediaAssetWriter ceiling for VIDEO assets |
| `VIDEO_RENDER_INTRO_REQUIRED` / `VIDEO_RENDER_OUTRO_REQUIRED` (API) | `false` | when true, QA Branding requires the frame |
| `VIDEO_RENDER_DURATION_TOLERANCE_MS` (API) | `750` | QA Duration tolerance |

## Storage

- Rendered videos are persisted as `MediaAssetType.VIDEO`,
  `WORKSPACE_PRIVATE`, in object storage (R2 in V1 per ENTERPRISE
  ARCHITECTURE — S3-compatible config), workspace-prefixed, one per
  render attempt. Retained indefinitely if published, else 180 days
  (FRD §21 storage table). History is never destructively deleted — a
  re-render supersedes the prior version in the same asset group
  (ARCHIVED, not deleted).
- Temp render files: container ephemeral disk only, job-scoped +
  workspace-tagged, 24h max, auto hard-delete after the job ends
  (success / failure / timeout / shutdown). Never archived.
- `MEDIA_STORAGE_AUTO_CREATE_BUCKET=false` is **mandatory** for a
  production S3/R2 environment (carried from Phase 7.4).
