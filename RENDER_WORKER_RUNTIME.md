# Render Worker — Runtime & Deployment (Module 7 Phase 7.5)

## Ownership

`apps/render-worker` (`@myev/render-worker`) is a **genuinely separate
Nest application and package** — its own `package.json`, `tsconfig`,
`Dockerfile`, lint/test/build. It is the **only** process type that
consumes the `MEDIA` queue (frozen Queue Engine: "MEDIA = dedicated
isolated workers"):

| Job type | Owner |
| --- | --- |
| `media.image-generate.v1` | render-worker |
| `media.tts.v1` | render-worker |
| `media.subtitle-generate.v1` | render-worker |
| `media.video-render.v1` | render-worker |

`apps/worker` (the general worker) runs `SYSTEM,AI` only. It has **zero**
media / render / Remotion / Chromium dependency in its `package.json`, it
never opens a BullMQ worker on `MEDIA`, and a render crash can never
touch SYSTEM/AI work (asserted by
`apps/worker/test/general-worker-media-isolation.e2e-spec.ts`).

The API registers `media.video-render.v1` **manifest-only** (for
submission) and never executes a render.

Shared framework infrastructure — `BullMqWorkerManager` (+ DEFECT-1F
fencing), `BackgroundJobReconciliationManager`, `PrismaService`,
`WorkerHeartbeatService`, `ShutdownModule`, `bootstrapWorker()`, the
media persistence services — lives in **`@myev/worker-core`**
(`packages/worker-core`), consumed by both workers. It was moved, not
copied.

## Render engines

| `RENDER_ENGINE` | Deps | Chromium | Used by |
| --- | --- | --- | --- |
| `remotion` (production default) | `@remotion/renderer` + `@remotion/bundler` + `remotion` + `react` + `react-dom` — real, installed, in the lockfile | Chrome Headless Shell (pre-fetched into the image); FFmpeg bundled inside `@remotion/renderer` | the deployed render-worker |
| `deterministic-test` | none | none | automated tests / the API E2E golden path (fast coverage, no browser) |

`RemotionRenderEngine` type-checks against the real `@remotion/*` types
(a missing dependency fails the build). The heavy runtime machinery
(esbuild, Chromium) is loaded via a literal-specifier `import()` inside
`render()` so it is not pulled in under `deterministic-test`.

The real production render path is proven end-to-end by
`apps/render-worker/test/remotion.smoke-spec.ts` — CI builds the
render-worker image's `smoke` target, which ensures a real browser and
runs `bundle()` → `renderMedia()` → MP4 inspection.

## Container / runtime requirements

The `apps/render-worker/Dockerfile` is **Debian** (`node:24-bookworm-slim`)
— Chrome Headless Shell needs glibc; the alpine `apps/worker` image
cannot host it. It:

- installs the Chrome Headless Shell system libraries: `libnss3
  libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libatk-bridge2.0-0 libcups2
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0
  libpango-1.0-0 libcairo2 libatspi2.0-0 libxrender1 libxext6 libx11-6`
- installs fonts: `fonts-liberation fontconfig` (the composition's
  `Inter, Arial, …` stack falls back to Liberation)
- **pre-fetches Chrome Headless Shell** into the image
  (`ensureBrowser()` at build) so the first render — and a
  no-egress runtime — works
- ships the composition `.tsx` sources at
  `/repo/apps/render-worker/src/render/remotion/` and sets
  `REMOTION_ENTRY` (`@remotion/bundler` compiles TSX directly)
- **does not** install FFmpeg/ffprobe separately — `@remotion/renderer`
  4.0.x bundles its own; our container inspection (`parseMp4`) is
  dependency-free pure JS

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `WORKER_QUEUES` | *(required)* | `MEDIA` |
| `RENDER_ENGINE` | `remotion` | `deterministic-test` is test-only |
| `RENDER_ENGINE_VERSION` | `WORKER_APPLICATION_VERSION` | stamped onto every render job + VIDEO asset |
| `RENDER_CONCURRENCY` | `2` | the MEDIA-queue concurrency (frozen: 2 renders global, FRD §21.1); scale via replicas, not this number |
| `RENDER_TEMP_DIR` | OS tmp + `myev-render` | per-job isolated dir, sanitized paths, hard-deleted after every job (checkpoint §28) — never a named volume |
| `RENDER_MAX_OUTPUT_BYTES` | `2147483648` | fail-closed ceiling on a produced render |
| `RENDER_CHROMIUM_PATH` | *(unset)* | system Chrome path; unset → Remotion's bundled Chrome Headless Shell |
| `REMOTION_ENTRY` | *(image sets it)* | composition entry for `@remotion/bundler` |
| `STORAGE_*` / `MEDIA_STORAGE_AUTO_CREATE_BUCKET` | see worker-core | object storage; **`false` mandatory for production S3/R2** |
| `MEDIA_IMAGE_PROVIDER` / `MEDIA_TTS_PROVIDER` | `fake` | `openai` / `azure` need their credentials |

## Resource sizing & scaling

- **CPU**: a single 1080p Remotion render is CPU-bound (Chromium raster +
  h264 encode). Budget ~2 vCPU per concurrent render → a
  `RENDER_CONCURRENCY=2` replica wants ~4 vCPU.
- **Memory**: ~1.5–2 GB per concurrent render (Chromium + frame
  buffers) → ~4 GB per replica.
- **Disk**: ephemeral only; a render job's temp dir holds the input
  assets + the bundle + the output (~a few hundred MB for a long video).
  24h max, auto-deleted. Never a persistent/named volume.
- **Scaling**: horizontal only — add replicas of the `render-worker`
  service. BullMQ distributes MEDIA jobs across them; each replica
  self-limits to `RENDER_CONCURRENCY`. The reconciliation sweep
  (worker-core) recovers a job whose replica died mid-render.

## Storage / retention

Rendered videos → `MediaAssetType.VIDEO`, `WORKSPACE_PRIVATE`, object
storage (R2 in V1), workspace-prefixed, one per render attempt.
Retained indefinitely if published, else 180 days (FRD §21). A re-render
supersedes the prior version in the same asset group (ARCHIVED, never
deleted).
