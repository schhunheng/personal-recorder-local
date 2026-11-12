# REANCODE101 Studio

A local recording and automated editing studio for programming lessons on macOS Apple Silicon. React/Vite/TypeScript captures the screen, microphone, and webcam; a loopback FastAPI/FFmpeg service saves originals and prepares a reviewable MP4. No account, cloud upload, or remote AI API is required.

**Record → Stop → save originals → clean audio → suggest/remove pauses → compose → review → download MP4.**

## Start the complete studio

Use Node.js 22+, Python 3.11+, current desktop Chrome, and FFmpeg/FFprobe:

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
# Install FFmpeg using its official instructions / your macOS package manager.
# Confirm both executables are on PATH:
ffmpeg -version
ffprobe -version
npm run dev:all
```

Open **http://127.0.0.1:5173**. The launcher starts Vite and the local API at **127.0.0.1:8001**. It reads optional settings from `backend/.env`; copy `backend/.env.example` to configure paths/limits/models. Both services bind to loopback. Do not expose this single-user service to the public internet.

For separate terminals, use `npm run dev` and `npm run dev:api`. The latter reads exported environment variables; use `dev:all` for `.env` loading. Basic browser recording/manual editing/native export remain usable with `npm run dev` alone, but automatic FFmpeg editing requires the local service. A static HTTPS deployment can use the browser-only features; media uploads for automatic editing are explicitly blocked outside a localhost origin.

macOS may require Chrome permission in **Privacy & Security → Screen & System Audio Recording**, **Microphone**, and **Camera**. The browser picker makes the final source choice. System/tab audio depends on Chrome, OS, and selected source; requesting it does not guarantee an audio track. Keep the recording tab open and do not sleep the Mac during capture.

## Recording and automatic editing

1. Choose **New recording**. Test the microphone to reveal device names, select the Logitech H390, and test again. Choose screen/window/tab, quality, FPS, and webcam or an uploaded muted looping avatar.
   Under **Camera & avatar layout**, toggle **Show camera / avatar**, choose a corner, adjust the size, or drag the overlay in the preview. These settings remain available during recording and are remembered for the next lesson. They apply to the whole video; hiding the overlay keeps independently recorded webcam footage available. The editor's **Camera** tab has the same controls, with undo/redo support.
2. Leave **Open editing settings after recording** enabled and select a preset. Click **Start recording**, choose the source in Chrome, and wait for the countdown.
3. Record your lesson. Pause/resume with the buttons or Alt+P; stop with the button, Alt+S, or Chrome’s Stop Sharing control. **Important moment**, **Start/End retake**, and **Mark zoom region** record explicit source-time markers. A region marker comes from clicking this app’s preview; global cursor/click events in VS Code are not available.
4. Stop opens the existing editor at **Settings**. Choose your audio cleanup, editing preset, and export options, then click **Auto edit** to start. Opening or reloading an unprocessed recording never starts processing by itself. After your click, the automatic editor saves immutable originals to this Mac and submits a durable job. Real stage progress arrives through SSE; upload progress measures bytes. A disconnected progress stream reconnects to the same job rather than starting a replacement job.
5. Follow **Settings → Process → Review → Download** in Automatic editor. Settings shows the available local speech models and audio source. Process shows actual worker stages and enables the original/cleaned audio comparison once cleanup finishes. Review the video and proposed cuts; **Apply reviewed cuts to timeline** keeps your other current edits. Changed cut choices require **Export reviewed video** before Download unlocks. Undo/redo preserves earlier edits. Manual edits made while a job runs are not automatically replaced by its finished draft.
6. Change zoom, camera/avatar, trim, captions, style, and chapter labels in the editor. Style has independent **Horizontal padding** and **Vertical padding**, plus automatic background contrast or a custom watermark color. Source proportions are preserved. **Save timeline on Mac** stores the current EDL through the local API. **Export current timeline to MP4** renders your reviewed edits; **Auto edit** reanalyzes pauses.
   Use **Hide** to draw opaque boxes over private screen details. Drag a box to move it or its bottom-right handle to resize it; the inspector also offers position, size, color, and start/end time controls. Areas default to the full trimmed recording, follow screen content through zooms, support undo/redo, and are saved with the project. Both browser exports and local MP4 renders include the covers. Original recordings remain available separately.
7. Download MP4 directly, or return to **All projects → Original / Edited videos**. Outputs remain available after leaving the editor and reloading. Every successful local job keeps its own output; retries do not replace previous results.

Keyboard shortcuts: Space plays/pauses the browser preview, S splits, ⌘Z/Ctrl+Z undoes, ⌘⇧Z/Ctrl+Shift+Z redoes. Shortcuts are limited to this tab. After stopping, choose New recording to record another lesson; each capture needs a fresh browser permission picker.

## Upload a video with AI noise cancellation

Choose **Upload video** (or **Upload a video** on the dashboard), select or drop a browser-playable MP4, MOV, WebM, OGV, or MKV, and leave **AI noise cancellation** enabled. Choose Light, Balanced, or Strong, then **Continue to editor → Remove noise**. The local service cleans the video's existing audio and creates an MP4 using the current timeline, without automatic cuts, zooms, or transcription. Review the original/cleaned audio comparison, then choose **Next: download video → Download MP4**. The original stays available separately; output uses the selected landscape or portrait export profile.

Run `npm run dev:all` for local AI processing. The settings show available neural models and any basic-cleanup fallback. Importing a video and reopening its project never starts a processing job automatically. You can turn off AI cleanup during upload, or enable **Noise cancellation only** in any project's Automatic editor later.

## Presets and output profiles

| Preset | Behavior |
| --- | --- |
| Clean Tutorial | Conservative cleanup, natural pauses, no automatic zoom added |
| Professional Tutorial | Reversible pause/retake cuts and smooth zooms from explicit Important/Zoom markers, with editable camera layout |
| Social Media Short | Vertical output, larger captions, and a configurable range around the first Important marker (or the beginning), with optional title/watermark overlays |

Social selection is marker/rule-based, not semantic highlight recognition. It never guesses repeated words or deletes suspected mistakes without explicit retake markers. An unfinished retake marker does not remove footage.

- **YouTube/LMS:** 1920×1080, 16:9, 30 FPS by default.
- **Facebook/TikTok:** 1080×1920, 9:16, 30 FPS by default.
- H.264 video, AAC audio, high/standard quality, and adjustable maximum bitrate.
- Vertical output fits the source without stretching it. Use editable zoom regions to make a chosen code area readable. Full desktop text may be too small in vertical framing; review before sharing.
- Cuts use retained source-time ranges and short audio ramps to avoid clicks. Retained audio is assembled as continuous PCM and encoded to AAC once, avoiding repeated encoder delay at joins. Video frame rounding uses cumulative time to prevent drift across many cuts.

## Audio and speech detection

The automatic editor now uses a real local neural model when available. **Automatic** prefers a configured DeepFilterNet model, then **RNNoise 0.2**, then basic FFmpeg spectral cleanup. The RNNoise model is already bundled in the pinned `@jitsi/rnnoise-wasm` npm package and runs in a local Node worker; it does not need PyTorch, a model download, or cloud uploads. Model readiness is tested with actual inference. See the [Jitsi package documentation](https://github.com/jitsi/rnnoise-wasm#usage) for the synchronous RNNoise 0.2 model.

Choose Light, Balanced, or Strong. Balanced mixes 95% neural enhancement; Strong uses the full enhanced signal. Advanced settings let you lower the amount if quiet syllables sound thin. RNNoise's 20 ms analysis/lookahead delay is compensated and partial frames are flushed, retaining the exact sample count. Voice normalization uses a constant gain capped at +6 dB, avoiding gain pumping and noise-only boosts. Basic FFmpeg fallback estimates a noise floor instead of assuming a fixed -35 dB floor. The finished result reports the actual model used and any fallback; it never labels basic cleanup as a successful neural run.

**Audio source** defaults to the independent microphone when recorded. Its stored timing offset is applied to keep narration aligned with the video. This mode leaves out captured tab/system sound; choose **Original recording mix** to retain that mixed audio. The A/B comparison uses a single audio player and preserves the playback position when switching. The editor's separate browser-only voice-cleanup switch remains a basic filter/gate; use the Automatic editor for neural enhancement.

DeepFilterNet remains an optional adapter requiring installed Python dependencies and a local model directory (`EDU_DF_MODEL_DIR`). It is shown as unavailable when missing. Engine failures fall back with an explicit warning. No model is downloaded at processing time. Cleanup cannot reliably isolate one speaker from overlapping voices or remove all room echo. Compare speech as well as background sound before accepting a result.

Silero VAD is used when its local package/model is installed. Without it, **Auto** uses labeled energy-based suggestions. Explicit Silero mode fails clearly if unavailable. Defaults detect gaps longer than 1.8 seconds and retain approximately 0.4 seconds on each side of speech. Detection uses the original synchronized voice before noise suppression, with a lower-energy safety band for soft syllables. Tiny removals are skipped. Silero windows overlap so words crossing a processing boundary retain their context. Quiet Khmer syllables and useful coding pauses require review; these are reversible proposals, not guaranteed mistake detection. A fully quiet recording is never automatically cut to an empty file. Re-running Auto edit or updating applied pause suggestions replaces earlier automatic cuts while preserving manual edits; old exports stay available. Regenerate an existing edit to use these improvements.

## Optional offline Khmer/English captions

```sh
.venv/bin/python -m pip install -r backend/requirements-models.txt
```

This optional group adds Silero/PyTorch and faster-whisper/CTranslate2; it can use substantially more disk and memory than the core editor. Obtain a compatible **multilingual CTranslate2 Whisper model directory** using the [upstream faster-whisper instructions](https://github.com/SYSTRAN/faster-whisper), then set:

```sh
STUDIO_WHISPER_MODEL=/absolute/path/to/local/model-directory
```

Use `backend/.env` with the combined launcher or export the variable for `dev:api`. The directory must contain `model.bin` and the model’s supporting files. Runtime transcription uses `local_files_only=True` and CPU int8. It does not fetch weights. Khmer (`km`), English (`en`), and automatic language selection are offered only when the installed local model is available.

Captions appear as editable text/timestamps; SRT import/export works without any model. SRT times are remapped around accepted cuts. Caption-derived chapter labels are narration excerpts for review, not generated summaries. Chapter metadata is remapped and embedded in MP4 when provided.

**Text rendering is capability-dependent.** FFmpeg builds with the `subtitles`/libass filter can burn captions/titles with font, size, position, and gentle fade settings. The current installed FFmpeg lacks that filter. Its MP4 exports therefore display an explicit warning when text overlays were requested and offer SRT; the browser Canvas exporter can include text overlays where its codec APIs permit. Correct Khmer font shaping/availability and actual offline transcription quality remain unverified here. No automatic background-removal feature is claimed.

## Where your files live

- **During capture:** original screen, independent microphone (where an audio recorder is supported), and webcam chunks are committed to IndexedDB every second. Timing offsets, pause periods, markers, and edits are stored separately.
- **After automatic finalization:** immutable files are under `backend/data/studio/<project-id>/original-*`. SQLite jobs/timeline state live in `backend/data/studio/jobs.sqlite3`.
- **Your recording folders:** `Recordings/<project-uuid>/<name>-<project-uuid>.<extension>` contains the screen original. Independent tracks use `camera-<uuid>` and `microphone-<uuid>`. Completed exports are `edit1-<uuid>.mp4`, `edit2-<uuid>.mp4`, etc. WebM browser exports keep `.webm`. Each folder has a `recording.json` index and available per-edit EDL/SRT/chapters. Original filenames stay stable when you rename a project.
- **Automatic and browser exports:** the local service copies originals and publishes finished exports to the UUID folder. Both export paths share a persistent version sequence. With the local service unavailable, browser export remains downloadable from browser storage and shows that the extra filesystem save failed. A browser alone cannot silently write into the repository's Recordings directory.
- **Internal processing:** `backend/data/studio/jobs/<job-id>/` retains extracted/cleaned audio and intermediate files; internal originals and old API URLs remain valid. The visible library contains independent copies. No automatic expiry deletes originals or old outputs. Set `EDU_RECORDINGS_DIR` to change the visible library location; a custom data workspace defaults to its own `Recordings` subdirectory unless overridden.
- **Browser library:** All projects offers separate original/edited playback and downloads. Local-service media streams directly from localhost where possible. Projects saved on this Mac can be restored into a different browser origin/profile through the dashboard’s recovery panel.
- **Normal downloaded files:** your browser’s chosen download folder.
- **Existing recordings:** see [Recordings](Recordings/README.md). UUIDs from existing studio/legacy projects are retained. `npm run recordings:organize -- --migrate-flat` backfills the library and relocates associated flat files after verifying SHA-256 hashes. Unassociated files are left untouched; `Recordings/migration.json` maps old names to new paths. Restart the local backend after code changes to activate the automatic save behavior.

`localhost:5173` and `127.0.0.1:5173` have separate browser libraries. Browser storage may be evicted or cleared; download important originals and results. Backend files remain until explicitly deleted. Deleting a browser project does not silently delete the canonical local-service originals. The local API has an explicit project-deletion endpoint which refuses active jobs.

## Verification

```sh
npm run build
npm test
npm run test:api
npm run test:browser
npm run test:upload-browser
```

Current evidence:

- Strict TypeScript/Vite build and browser logic tests pass.
- Real FastAPI/FFmpeg tests cover independent camera composition, padded silence removal/restoration, actual H.264/AAC codecs, A/V duration, output retention across retries/restarts, vertical output, SRT, SSE, optional-AI fallback, timeline conflicts, and immutable originals.
- Your recovered 42-second lesson was processed into [a real 1080p MP4](Recordings/b3238abe-fd64-4cc6-85bc-cc781b880557/edit3-b3238abe-fd64-4cc6-85bc-cc781b880557.mp4). Its original checksum is unchanged. The optimized run took 13.68 seconds in this environment; it found no qualifying pauses, so it did not invent cuts. This single sample is not a general performance/quality guarantee.
- [Sample verification report](Recordings/b3238abe-fd64-4cc6-85bc-cc781b880557/edit3-b3238abe-fd64-4cc6-85bc-cc781b880557.verification.json) includes settings, EDL, codecs/duration checks, warnings, hashes, and measured runtime. Historical input/output paths inside this report are recorded from the original run; use `migration.json` for their current locations.
- Automated Chrome tests pass when run with permission to launch Chrome and bind a loopback test server. They verify recording fixtures, hidden-area drawing/movement/resizing, undo/redo, saved cover settings, actual covered pixels in browser MP4 exports, and responsive layout. Physical H390/webcam sync, a real 30-minute recording, model quality, and full visual QA still require validation.
- Silero/faster-whisper model installation was attempted but could not resolve distributions in this environment. They are not installed or presented as verified AI features.

See [architecture](docs/ARCHITECTURE.md), [automation plan](docs/AUTOMATION_PLAN.md), and [validation gates](docs/VALIDATION.md). This is an implemented, tested local processing engine with pending browser/hardware/model acceptance—not a claim that all phases are production verified.
