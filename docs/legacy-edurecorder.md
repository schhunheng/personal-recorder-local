# EduRecorder

A local teaching studio for screen + headset microphone recording, optional webcam composition, and explicit post-recording audio cleanup. React/Vite/TypeScript, Tailwind CSS with a shadcn-style Radix Button, FastAPI, FFmpeg, NumPy, SoundFile and noisereduce. No account, remote API, or paid service is used.

## macOS M1 setup

Use a native Apple Silicon terminal, Node.js 22+, Python 3.11, and Chrome desktop. Install prerequisites with Homebrew if needed:

```sh
brew install node python@3.11 ffmpeg
ffmpeg -version
ffprobe -version
```

From this directory:

```sh
npm ci
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
npm run dev:all
```

Open **http://127.0.0.1:5173**. Keep the same origin so browser recordings remain accessible. Chrome may need permission in **System Settings → Privacy & Security → Screen & System Audio Recording**, **Microphone**, and **Camera**. Restart Chrome if macOS requests it.

`npm run dev:all` reads `backend/.env`, binds both services to loopback, and stops both when interrupted. It runs one API process and one audio worker. Do not use multiple Uvicorn workers: this MVP stores job coordination in one process. For separate terminals, run `npm run dev` and `npm run dev:api`; the latter uses environment variables exported in that terminal rather than loading `.env`.

### Record a lesson

1. Connect the H390 or another headset. Click **Test microphone** to grant permission and reveal device names, then select the headset and test again. The test records up to five seconds and releases the microphone afterward.
2. Check the input meter and the actual device settings. Echo cancellation and browser suppression default off; automatic gain defaults on. Browser processing changes the captured original. Turn browser suppression on only if you want it, and use conservative Python cleanup strength when stacking both.
3. Enable the optional camera and select its device before recording.
4. Click **Start recording** and choose the IDE screen/window in Chrome's picker. The canvas records a 1920×1080 composition targeting 30 FPS, preserving source aspect ratio with letterboxing. Small sources are scaled; output cannot invent source detail. System audio is excluded.
5. Drag in the preview to position the circular camera, change its size, or hide it. Keyboard users can focus the preview and use arrow keys. These changes affect the actual recorded canvas.
6. Pause/resume with the buttons or **Alt+P**; stop with the button or **Alt+S**. Screen sharing ending also finalizes the recording. Microphone disconnection stops recording and retains the captured chunks.
7. Play and download the original. Select a cleanup mode and click **Clean audio & create MP4**. This is the first point where media is sent to the local Python process.
8. Switch **Before / After** at the same playback position and download the MP4. Reprocessing always reads the unchanged original. Cancellation or failure retains the original and any previous successful MP4.

Keep the recording tab visible, such as in a second Chrome window alongside the IDE. Browsers may throttle canvas rendering when the tab is hidden or the computer sleeps. The 30 FPS setting is a target, not a guarantee under throttling or overload.

## Audio modes

| Mode | Behavior |
| --- | --- |
| Off | No denoising or normalization; converts to MP4 with AAC audio. AAC conversion is lossy, so it is not bit-identical to the original. |
| Fast | Stationary spectral gating for steady fan/hiss noise. |
| Balanced | Non-stationary spectral gating for changing background noise. Default strength 50%. |
| AI Speech | Optional local DeepFilterNet. Disabled when the package or configured model is unavailable. Never silently falls back. |

Fast, Balanced and AI also normalize active audio toward −20 dBFS RMS, cap gain at +12 dB, and limit peak gain to avoid clipping. Strength controls noise removal, not normalization. Use Off for no normalization. Processing uses ten-second blocks with one-second context and a global gain pass, preserving sample count and bounding memory. No noise-removal method can reliably separate every competing voice or restore clipped input.

The backend uses FFmpeg resampling to preserve the initial audio offset, then encodes H.264 video and AAC audio, pads audio to the video ending, and verifies output duration before publishing it. The original is never overwritten. MP4 encoding is CPU-based `libx264` for a predictable portable MVP; no GPU setup is required.

### Optional DeepFilterNet

Basic recording and Fast/Balanced processing do not require PyTorch or a model. Install AI dependencies only in a separate tested environment if needed:

```sh
.venv/bin/pip install -r backend/requirements-ai.txt
```

Obtain the model files explicitly using the [upstream DeepFilterNet instructions](https://github.com/Rikorose/DeepFilterNet). Point `EDU_DF_MODEL_DIR` to a local model directory containing `config.ini` and `checkpoints/`, then restart. Package and model setup require internet once; EduRecorder itself does not download models. M1 package/wheel compatibility depends on the Python/PyTorch versions. The capability endpoint reports missing imports/configuration, and runtime model failures are explicit failed jobs. The optional AI path has not been exercised in this environment.

References: [noisereduce parameters](https://github.com/timsainb/noisereduce), [FastAPI](https://fastapi.tiangolo.com/), [DeepFilterNet API examples](https://github.com/Rikorose/DeepFilterNet/blob/main/scripts/external_usage.py).

## Storage and recovery

- During recording, one-second MediaRecorder chunks are written serially to **IndexedDB**. The browser library survives reloads. Interrupted recordings remain listed for recovery, though an interrupted encoder may leave a partly playable file.
- Original files should be downloaded after each lesson. Browser storage can be removed by clearing site data, private browsing, or browser eviction. Persistent storage is requested but may not be granted.
- Recording automatically stops at the smaller of 1 GiB or 95% of the backend upload limit, or at the configured duration limit (two hours by default). The browser stops if disk writes fall behind. On quota failure, remaining chunks are retained in memory for immediate emergency download.
- Loading a recording assembles Blob references to stored chunks; it does not decode the full video into JavaScript memory. Avoid many very large recordings in a single browser library.
- Python storage defaults to `backend/data/<uuid>/`. Originals and atomic JSON job state survive restarts. Interrupted jobs become explicitly failed and can be retried.
- Server retention defaults to seven days since the last status update, checked on startup and hourly. Set `EDU_RETENTION_DAYS=0` to retain until explicit deletion. Browser originals have no app-enforced expiry.
- Deleting a recording explicitly removes the selected browser copy and its associated server files. If the backend is offline, deletion reports an error instead of pretending server deletion succeeded.
- Upload cancellation discards an incomplete server upload while retaining the browser copy. A disconnect after the server accepted an upload can leave an extra server copy until expiry; `GET /api/recordings` lists those jobs.

## API

The Vite `/api` proxy targets `http://127.0.0.1:8001`. FastAPI docs are at `http://127.0.0.1:8001/docs`.

| Endpoint | Contract |
| --- | --- |
| `POST /api/recordings?mode=balanced&strength=0.5` | Raw `video/webm` or `video/mp4` body (not multipart). Streams to disk with a byte limit. Returns 202 and a job. |
| `GET /api/recordings/{id}/status` | Persisted status, stage, stage-specific progress, error, result version. |
| `GET /api/recordings/{id}/original` | Untouched original, including after processing failure. Supports media range requests. |
| `GET /api/recordings/{id}/download` | Latest successful MP4, or 409 if none exists. |
| `POST /api/recordings/{id}/reprocess` | JSON `{ "mode": "fast", "strength": 0.4 }`. Rejects concurrent jobs on the same recording. |
| `POST /api/recordings/{id}/cancel` | Requests cooperative cancellation, including FFmpeg termination. |
| `DELETE /api/recordings/{id}` | Explicit deletion. Active jobs must be cancelled and finish first. |
| `GET /api/capabilities` | Tool/model availability and configured limits. |
| `GET /api/recordings` | Server library for recovery. |

Stages: uploading → queued → validating → extracting → cleaning → encoding → completed. Failed and cancelled are explicit terminal states. The UI polls every second. Upload progress measures transferred bytes; cleaning measures processed samples; encoding uses FFmpeg timestamps. Queued, validation and extraction show indeterminate status. Percentages are **per stage**, not a fabricated total-job estimate.

Security is scoped to a local single-user MVP: loopback binding, local Host/Origin checks, safe UUID paths, no user filename paths, bounded raw uploads, FFprobe validation of container/streams/dimensions/timestamps/duration, safe subprocess argument arrays, no shell interpolation, cancellation, and intermediate-file cleanup. **Do not expose this server on a network**; it has no authentication or multi-user isolation. Only WebM/MP4 with both video and audio are accepted. Input is limited to 4K dimensions and the configured duration.

## Project structure

```text
src/edu/App.tsx          workspace, devices, processing and comparison
src/edu/capture.ts       MediaRecorder, Web Audio meter, canvas camera composition
src/edu/storage.ts       IndexedDB chunk and recording storage
src/edu/api.ts           local API client, upload progress and cancellation
src/edu/styles.css       light/dark responsive workspace
src/components/ui/      shadcn-style Radix button and variants
backend/app/main.py     FastAPI endpoints and streamed upload validation
backend/app/jobs.py     serialized background worker, FFmpeg and durable job state
backend/app/audio.py    bounded-memory noise removal, normalization and optional AI
backend/app/config.py   environment configuration
backend/tests/          API/media integration and audio tests
scripts/dev.mjs         local frontend + backend launcher
```

The previous browser-live/Electron recorder remains in `src/legacy-main.tsx`, `src/audio/`, `src/recording/`, `electron/`, and `docs/legacy-recorder.md`. EduRecorder's entry point uses the new post-processing workflow. The legacy Electron packaging scripts are retained, but a packaged EduRecorder/Python distribution is outside this browser MVP.

## Checks

```sh
npm run build
npm test
npm run test:api
npm run test:browser
```

The browser suite uses Chrome with generated screen/microphone/camera fixtures and the real MediaRecorder/IndexedDB APIs. It checks permission denial/retry, pause/resume, composition, downloads, track cleanup, persistence, and layouts. It deliberately tests with the backend offline; Python integration tests separately generate a real FFmpeg fixture and validate H.264/AAC output, synchronization, original integrity, duration rejection and reprocessing. This is test isolation; the application has no mock APIs or simulated processing progress.

**Verification in this implementation session:** frontend TypeScript/production build passed; existing Node tests passed (FFmpeg integration skipped); the new capture lifecycle/storage-failure test passed; Python source compilation passed. Python runtime tests could not run because dependency downloads are blocked and FastAPI/SoundFile/noisereduce/FFmpeg are unavailable. Chrome automation and local server startup are blocked by this session's sandbox. Real H390 capture, browser visual QA, MP4 synchronization, and optional AI require verification after the setup above. This is implemented source, not a claim that the full end-to-end acceptance test has passed here.

Phase 2 avatar animation, camera animation, shape customization, branding intros, templates and transcription/subtitles are intentionally excluded.
