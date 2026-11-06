# REANCODE101 Studio

A private browser studio for programming lessons. Record a screen, window, or tab with microphone and a separate webcam track; edit framing, pauses, and camera placement; export locally. React 19, strict TypeScript, Vite, Tailwind CSS, shadcn-style Radix Button, Zustand, and Lucide.

## Run

Use Node.js 22+ and current desktop Chrome, preferably native Apple Silicon on macOS:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. No Python, FFmpeg executable, Electron, login, API key, or recording backend is required. Keep the origin unchanged to access the same local projects. Deploy the `dist` directory on any static HTTPS host after `npm run build`.

macOS may require Chrome permission in **System Settings → Privacy & Security → Screen & System Audio Recording**, **Microphone**, and **Camera**. Restart Chrome if macOS asks. The browser’s screen picker always makes the final source selection. Tab/system audio varies by browser, selected source, and OS; requesting it does not guarantee an audio track.

## Find an existing video

Use **All projects → Original** for the source recording, or **Edited videos** for saved exports. The same controls are available through **Original & edited** in the editor. Browser projects are scoped to the exact address and Chrome profile; `http://localhost:5173` and `http://127.0.0.1:5173` are separate libraries. Downloading saves a normal file in the location chosen by your browser.

Files recovered from the previous app are in [Recordings](Recordings/README.md), including its 42-second original and completed processed MP4. Choose **Import video** to add them to the new studio. Old exports deleted by the earlier temporary-output behavior must be exported again unless you already downloaded a copy.

## Record and edit

1. Choose **New recording**. Select Window for VS Code, enable your microphone, and click **Test mic** to grant access and reveal input names. Choose the Logitech H390, then test again to hear that device.
2. Enable webcam if wanted. Choose 720p, 1080p, or 1440p and 30/60 FPS. Capture settings are requests; the selected source determines actual detail and dimensions.
3. Click **Start recording**, choose your source in Chrome, and wait for the three-second countdown. Pause/resume with the controls or Alt+P. Stop with the control, Alt+S, or Chrome’s Stop Sharing button.
4. The editor opens with the original recording. Add zoom keyframes at the playhead. Click/drag the preview or use the focus sliders to frame important code. Set 1–3× zoom and a transition duration. Add a 1× keyframe to return to full view.
5. Use **Camera** to reposition, resize, mirror, hide, or restyle the separately recorded webcam. A muted looping avatar video can replace it. Use **Style** for padding, background, aspect ratio, rounded corners, shadow, watermark, and chapter title intro/outro overlays.
6. Use **Audio** to compare original/enhanced playback. Local cleanup uses an 85 Hz high-pass filter, an AudioWorklet soft noise gate, and compression, with adjustable strength and voice gain. This is conservative noise reduction, not perfect speech separation. It cannot reliably remove competing voices or loud animals/traffic. Analyze audio first to estimate voice normalization gain.
7. **Analyze audio & waveform** streams through the recording locally, without decoding the whole lesson into PCM memory. It takes approximately the recording’s duration. Review threshold/minimum-pause suggestions or select reversible automatic removal. Suggested cuts leave 180 ms on each side. Review quiet words before accepting; energy detection is not language-aware transcription.
8. **Trim** sets source in/out points. Split at the playhead, then remove a section. Undo/redo works for timeline, camera, audio, and visual edits. Original media is preserved.
9. **Export video** renders the finished composition locally in real time. Choose resolution, frame rate, quality, and a supported format. Download the result and upload it to your LMS yourself.

Space plays/pauses the editor, S splits, ⌘Z/Ctrl+Z undoes, and ⌘⇧Z/Ctrl+Shift+Z redoes. Camera placement also supports arrow keys when its preview is focused. Shortcuts apply only to this browser tab.

## Export capabilities and limits

- Runtime detection checks the exact **H.264/AAC MP4** and **VP8/Opus WebM** MediaRecorder MIME strings. MP4 is offered only when Chrome reports that combination. Actual encoder failures remain possible and are shown explicitly.
- Export uses a canvas and the same renderer as preview, including zoom, camera/avatar, background, title, watermark, cuts, and processed audio. Audio/video follow media playback time. Playback pauses and encoder pauses exclude seek gaps between retained segments.
- Encoding runs in real time. Keep the tab visible; export stops with an explanation when hidden, rather than silently finishing a throttled render. Do not sleep the computer. 1440p/60 FPS costs substantially more CPU than 1080p/30. Export cannot add source detail.
- Chunks go to an OPFS writable file, with IndexedDB fallback. Cancellation cleans up temporary output. Output is not uploaded. Completed exports are saved with the project and remain available after leaving the editor or reloading. Use **All projects → Original / Edited videos** to play and download them; several exports can be retained separately.
- FFmpeg.wasm was evaluated, but its packages/core were unavailable in this environment (npm registry DNS failure). It is **not bundled or presented as a working fallback**. Native WebM is the supported alternative when MP4 is unavailable. The WebCodecs capability is reported; a separate WebCodecs muxing pipeline has not been implemented.
- The source audio is the microphone/tab mix, including any browser processing enabled during capture. It cannot later be separated into its original inputs.

## Storage, privacy, and recovery

Recording chunks are committed individually to IndexedDB every second. Screen and webcam assets are separate from project/edit metadata. This avoids retaining the whole recording in JavaScript memory and preserves committed chunks if capture is interrupted. Projects are marked incomplete until finalized. An interrupted WebM may be only partly playable; recovery is best effort.

Exports use OPFS when possible because a sequential file is efficient; original captures intentionally use committed IndexedDB chunks rather than an OPFS writable that would commit only on close. A storage error or excessive pending write backlog stops capture. Already saved chunks remain in the recovery library; the final failed chunk may be lost.

Settings shows estimated storage usage/quota, browser capabilities, and persistent-storage status. Storage can still be cleared by the user, private browsing, or browser policy. Download originals and project metadata after important lessons. Keep this tab open while recording. Closing, reloading, device loss, or capture-session termination may interrupt the recording.

Projects can be opened, renamed, duplicated, deleted, and restored by reopening the same origin. Original recordings and finished exports have separate playback/download controls. Editing a project saves editing instructions; use Export video to create the finished video file. Duplicates share immutable source assets; deleting one retains media used by another. Project metadata JSON is an edit/reference backup and **does not contain media**. There is no remote upload or content analytics in the active application.

## Validation

```sh
npm run build
npm test
npm run test:browser
```

`npm test` checks timeline math, smooth/bounded zoom, source fitting, compositor parameters, silence padding, capture lifecycle, separate sources, pause timing, permission retry, picker cancellation, Stop Sharing, and quota failure. Mocked lifecycle tests do not prove actual browser encoding.

`test:browser` uses real Chrome MediaRecorder, Web Audio, Canvas, IndexedDB, and OPFS with deterministic generated device fixtures. It checks recording, preview, local export, decoded export pixels, original persistence, and responsive layout. It launches its own Chrome; set `CHROME_PATH` if necessary. It routes the built app internally and requires no development server.

**Current verification:** TypeScript and production build passed; 13 unit/lifecycle tests passed. The real browser suite could not execute because the session sandbox aborts Chrome launch (`SIGABRT` / `EPERM`). Local server binding also fails with `EPERM`. Real H390/VS Code capture, actual MP4/WebM output, visual browser QA, audio synchronization, and the required 30-minute recording/performance acceptance test remain **unverified**. This is not a production-readiness claim. See [validation](docs/VALIDATION.md).

## Architecture

See [architecture](docs/ARCHITECTURE.md) for module boundaries and media decisions. The active entry point is `src/main.tsx → src/studio/App.tsx`. Previous Python/Electron implementations remain as inactive reference files in `backend/`, `electron/`, `src/edu/`, `src/legacy-main.tsx`, and legacy documentation. None are imported by the current app, required by current npm scripts, or included in the browser production bundle.
