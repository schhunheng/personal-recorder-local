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
2. Leave **Automatically edit after recording** enabled and select a preset. Click **Start recording**, choose the source in Chrome, and wait for the countdown.
3. Record your lesson. Pause/resume with the buttons or Alt+P; stop with the button, Alt+S, or Chrome’s Stop Sharing control. **Important moment**, **Start/End retake**, and **Mark zoom region** record explicit source-time markers. A region marker comes from clicking this app’s preview; global cursor/click events in VS Code are not available.
4. Stop opens the existing editor. The automatic editor saves immutable originals to this Mac and submits a durable job. Real stage progress arrives through SSE; upload progress measures bytes. A disconnected progress stream reconnects to the same job rather than starting a replacement job.
5. Review the finished preview and its warnings. Check/uncheck proposed cuts, then **Apply reviewed draft to timeline**. Unchecking restores a section. Undo/redo preserves earlier browser edits. Manual edits made while a job runs are not automatically replaced by its finished draft.
6. Change zoom, camera/avatar, trim, captions, style, and chapter labels in the editor. **Save timeline on Mac** stores the current EDL through the local API. **Export current timeline to MP4** renders your reviewed edits; **Create automatic draft** reanalyzes pauses.
7. Download MP4 directly, or return to **All projects → Original / Edited videos**. Outputs remain available after leaving the editor and reloading. Every successful local job keeps its own output; retries do not replace previous results.

Keyboard shortcuts: Space plays/pauses the browser preview, S splits, ⌘Z/Ctrl+Z undoes, ⌘⇧Z/Ctrl+Shift+Z redoes. Shortcuts are limited to this tab. After stopping, choose New recording to record another lesson; each capture needs a fresh browser permission picker.

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
- Cuts use retained source-time ranges and short audio fades to avoid clicks. No crossfade obscures code.

## Audio and speech detection

FFmpeg applies adjustable Light/Balanced/Strong FFT denoising, high-pass filtering, optional loudness normalization, and peak limiting. Off disables noise reduction; normalization is a separate control. Original and cleaned WAV previews are available. Cleanup cannot reliably remove all traffic, animals, competing voices, or room echo. Browser echo cancellation is available during capture; post-processing is not a verified dereverberation model.

The optional DeepFilterNet adapter is reused from the previous backend. Unavailable/failed AI enhancement falls back to Balanced FFmpeg with an explicit warning. No model is downloaded at processing time.

Silero VAD is used when its local package/model is installed. Without it, **Auto** uses labeled energy-based suggestions. Explicit Silero mode fails clearly if unavailable. Defaults detect gaps longer than 1.5 seconds and retain approximately 0.3 seconds around speech. Quiet Khmer syllables and useful coding pauses require review; these are reversible proposals, not guaranteed mistake detection. A fully quiet recording is never automatically cut to an empty file.

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
- **Processing and finished videos:** `backend/data/studio/jobs/<job-id>/` retains extracted/cleaned audio, JSON EDL, SRT/chapters, intermediate segments, and `edited.mp4`. No automatic expiry deletes originals or old outputs.
- **Browser library:** All projects offers separate original/edited playback and downloads. Local-service media streams directly from localhost where possible. Projects saved on this Mac can be restored into a different browser origin/profile through the dashboard’s recovery panel.
- **Normal downloaded files:** your browser’s chosen download folder.
- **Earlier recovered recordings:** see [Recordings](Recordings/README.md). Use Import video to open them in the new studio.

`localhost:5173` and `127.0.0.1:5173` have separate browser libraries. Browser storage may be evicted or cleared; download important originals and results. Backend files remain until explicitly deleted. Deleting a browser project does not silently delete the canonical local-service originals. The local API has an explicit project-deletion endpoint which refuses active jobs.

## Verification

```sh
npm run build
npm test
npm run test:api
npm run test:browser
```

Current evidence:

- Strict TypeScript/Vite build and browser logic tests pass.
- Real FastAPI/FFmpeg tests cover independent camera composition, padded silence removal/restoration, actual H.264/AAC codecs, A/V duration, output retention across retries/restarts, vertical output, SRT, SSE, optional-AI fallback, timeline conflicts, and immutable originals.
- Your recovered 42-second lesson was processed into [a real 1080p MP4](Recordings/automatic-clean-tutorial-optimized.mp4). Its original checksum is unchanged. The optimized run took 13.68 seconds in this environment; it found no qualifying pauses, so it did not invent cuts. This single sample is not a general performance/quality guarantee.
- [Sample verification report](Recordings/automatic-clean-tutorial-optimized.verification.json) includes settings, EDL, codecs/duration checks, warnings, hashes, and measured runtime.
- Automated Chrome launch and localhost server binding remain blocked by this execution sandbox. The connected browser workflow, H390/webcam hardware sync, a real 30-minute recording, model quality, and full visual QA still require validation outside it.
- Silero/faster-whisper model installation was attempted but could not resolve distributions in this environment. They are not installed or presented as verified AI features.

See [architecture](docs/ARCHITECTURE.md), [automation plan](docs/AUTOMATION_PLAN.md), and [validation gates](docs/VALIDATION.md). This is an implemented, tested local processing engine with pending browser/hardware/model acceptance—not a claim that all phases are production verified.
