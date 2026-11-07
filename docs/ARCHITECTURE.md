# Local automated studio architecture

The current brief permits a local FastAPI service. The original browser-only recorder/editor is preserved and enhanced; its captured media is finalized to the local machine for asynchronous FFmpeg jobs. No Electron integration, cloud API, telemetry, or remote media service is required.

## Frontend modules

| Module | Responsibility |
| --- | --- |
| `model.ts`, `store.ts` | Source assets, timing/markers, captions, nondestructive edits, preferences, bounded undo/redo |
| `recorder.ts` | User-activated Screen Capture picker, audio mix, independent microphone/webcam recorders, pause-aware source clock, chunk persistence/backpressure, cleanup |
| `storage.ts`, `SavedVideos.tsx` | IndexedDB project/export library, OPFS native export, local-service media references, distinct original/edited playback/download |
| `pipeline.ts` | Loopback-only API, immutable asset finalization, SSE subscription, EDL conversion, local-project recovery |
| `AutomaticEditor.tsx` | Automatic start after Stop, presets, measured stage progress, explicit fallbacks, preview/audio comparison, draft review, local MP4 export |
| `Editor.tsx`, `Preview.tsx`, `TimelinePanel.tsx` | Existing timeline, zoom/camera/trim/audio/style editing and preview |
| `captions.ts`, `CaptionEditor.tsx` | Validated UTF-8 SRT, cut-time remapping, caption text/timestamps/style, reviewable chapter labels |
| `compositor.ts`, `export.ts` | Shared Canvas/native-browser fallback, including editable captions and layout |

Frontend automatic uploads are refused outside localhost. Vite proxies `/api` to 127.0.0.1:8001. Media references accept only fixed UUID-based studio paths; they cannot refer to arbitrary third-party URLs.

## Backend modules

| Module | Responsibility |
| --- | --- |
| `studio_models.py` | Strict finite/range-checked request/EDL schemas without user filesystem paths |
| `studio_api.py` | Immutable streamed originals, job finalization/status/SSE/cancel, timeline updates, fixed result routes, explicit project deletion |
| `studio_jobs.py` | SQLite/WAL durable project/job state, one bounded worker, restart recovery, ffprobe validation, local orchestration |
| `edit_decisions.py` | Padded pause proposals, explicit retakes/zoom markers, retained ranges, caption/chapter remapping, SRT/FFmetadata |
| `speech.py` | Bounded-memory waveform/energy analysis, optional installed Silero VAD and local-only faster-whisper adapters |
| `render.py` | Per-range FFmpeg composition, cached static masks/shadows, camera/avatar, H.264/AAC, concatenation, optional libass text, chapter metadata |
| `audio.py`, `jobs.py` | Reused legacy audio engine and subprocess timeout/cancellation/progress primitives; legacy routes remain compatible |

SQLite stores canonical job status/options/result/errors and versioned current timeline metadata. Each job has its own directory. Originals and prior results are never reused as writable output paths. Existing legacy audio recordings are retained; legacy automatic expiry is disabled by the current application.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/studio/capabilities` | FFmpeg readiness, subtitle-filter support, installed offline VAD/transcription availability, limits |
| `POST /api/studio/projects` | Idempotent recording/project metadata creation |
| `PUT /api/studio/projects/{id}/assets/{kind}` | Stream screen/microphone/camera/avatar to local disk with byte limit/hash; preserve existing originals |
| `GET /api/studio/projects` / `GET …/{id}` | Durable library, saved EDL/version, latest job, asset references; restore after browser-data loss |
| `GET …/{id}/assets/{kind}` | Range-capable original playback/download |
| `POST …/{id}/process` | Create or return the active local job; plan a draft or render the supplied reviewed EDL |
| `PUT …/{id}/timeline` | Optimistic current-timeline update with `base_version`; stale versions return 409 |
| `GET /api/studio/jobs/{id}` / `GET …/events` | Authoritative persisted status and SSE updates/heartbeats |
| `POST …/jobs/{id}/cancel` | Cooperative worker/subprocess cancellation |
| `GET …/jobs/{id}/files/{kind}` | Fixed video, EDL, SRT, original/cleaned audio, chapter results; no arbitrary filenames |
| `DELETE …/projects/{id}` | Explicit local-file deletion; active jobs must be cancelled first |

## Media invariants

1. Call getDisplayMedia before awaited storage/device work. Source preferences are picker hints. No global cursor/click tracking is invented.
2. Record original screen directly, plus a separate microphone asset when supported and a separate camera. The screen contains the permitted microphone/system mix. Track offsets and pauses are recorded; backend audio extraction preserves initial audio timestamps.
3. Commit one-second chunks during capture with a 32 MiB pending-write safety bound. Do not keep full video byte arrays or full-length decoded PCM in JS.
4. Save originals before queueing processing. UUID-derived paths, validated media, fixed stream maps, subprocess argument arrays, protocol restrictions, and Host/Origin checks constrain local access.
5. Use one local worker to limit M1 resource contention. SQLite commits every stage; SSE reports real per-stage progress, with indeterminate progress where no useful measure exists.
6. Generate source-time EDL proposals. Retakes require paired explicit markers. A fully quiet clip is not automatically emptied. Edits are reversible; original bytes remain unchanged.
7. FFmpeg composes each retained range with source-time zoom/camera metadata; short audio fades avoid clicks. Static corner masks/shadows are evaluated once and held, avoiding costly full-resolution per-frame expression work.
8. Preserve previous outputs and intermediate files. Restarted jobs are marked failed with retry guidance; a new job gets a new ID/folder. Progress disconnects never mean a job should be restarted.
9. Stream local-service media directly where possible. The browser keeps lightweight references to durable MP4 outputs, and dashboard recovery can recreate its library entries.
10. Optional model absence/failure is explicit. AI denoising falls back to FFmpeg. VAD Auto falls back to labeled energy suggestions. Whisper uses only an existing local model directory. Missing libass leaves the MP4 usable with an explicit text-overlay warning and SRT/browser alternatives.

## Known boundaries

Automatic zoom uses explicit markers/regions; no unverified frame/cursor analysis is exposed. Social selection uses marked/beginning ranges, not semantic highlight detection. Chapter labels are narration excerpts for review. No verified background-removal or post-recording dereverberation model is claimed. Modern Chrome recording/hardware sync, a real 30-minute lesson, full visual QA, and model quality still need external acceptance tests.

Primary references: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [Silero VAD](https://github.com/snakers4/silero-vad), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
