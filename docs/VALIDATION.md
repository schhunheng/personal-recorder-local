# Evidence and remaining acceptance gates

## Executed

- Strict TypeScript / Vite production build: passed.
- Browser logic/capture lifecycle/caption tests: passed (including separate microphone and pause-aware marker metadata).
- Camera/avatar layout checks: all 22 frontend tests pass, including bounded corner placement in landscape/portrait/square frames, hide/show rendering, and layout persistence through recording finalization while raw webcam capture continues. The real FastAPI/FFmpeg fixture also passes with a selected top-left camera position and a second MP4 with that overlay hidden. Browser interaction checks were extended for the new controls, but Chrome still aborts before the suite can run here.
- Real FastAPI/FFmpeg tests: passed for silence padding and retained ranges, actual camera pixels in an MP4, H.264/AAC codecs and duration, restoring removed pauses, retaining both outputs, original hashes, SQLite restart recovery, immutable uploads, version conflicts, vertical rendering, SRT/SSE, and optional-AI fallback.
- Recovered 42-second source processed at 1920×1080 using Balanced FFmpeg cleanup. Static-mask optimization reduced the measured sample run from 261.06s to 13.68s. The output is 42.330s; H.264 video duration 42.300s and AAC duration 42.330s differ by approximately 30ms. No qualifying pauses were found, so no pauses were invented or removed.
- Input/source SHA-256 remained identical. Inspect `Recordings/automatic-clean-tutorial-optimized.verification.json` and its real MP4.
- Optional model install was attempted but could not resolve the requested distributions here. Silero/PyTorch and faster-whisper are not installed or verified.
- Installed FFmpeg 9.0.2 lacks `subtitles`/libass. Its output correctly warns when requested text overlays cannot be burned; UTF-8 SRT/manual/browser caption paths are implemented.
- Headless Chrome launch and localhost server binding are still denied by the execution sandbox. Automated connected-browser tests and live UI/hardware tests cannot be claimed as passing.

## Six-feature checklist

| Requested milestone | Implementation/evidence | Remaining gate |
| --- | --- | --- |
| Stable screen + microphone recording | Original capture retained; separate microphone/camera and clock/marker tests pass | Actual Chrome/H390/webcam capture, reconnects, 30-minute run |
| Automatic FFmpeg audio cleanup | Real fixture and recovered-lesson MP4 pass | Listen to Khmer narration under representative noise; subjective quality |
| Silence detection/suggested cuts | Real gap fixture, 0.3s padding, restore/rerender, explicit retake tests pass | Installed Silero quality and human review on long lessons |
| Processed preview | Real MP4/audio endpoints and UI controls implemented | Browser playback/visual QA |
| One-click MP4 export | Real H.264/AAC render/retry/persistence tests pass | Connected browser Stop→automatic draft→review→export acceptance |
| Smart zoom/avatar/Khmer captions | Editable zoom/camera/markers, real camera render, captions/SRT editor and offline adapter implemented | Khmer model/font verification; libass burn-in; semantic AI features not claimed |

## Browser integration

Run `npm run build && npm run test:browser` outside the restricted environment. The existing browser-only suite intentionally tests fallback recording/editing/export without the local API; it does not substitute for connected pipeline verification.

Then start `npm run dev:all` and verify:

1. Choose VS Code window and H390 after microphone permission. Record webcam or imported looping avatar. Mark important content and a paired retake. Pause/resume; Stop Sharing once from Chrome in a separate short recording.
2. Stop must save originals and start a real local job, with byte progress followed by per-stage progress. Disconnect/reconnect the progress stream and reopen the editor; the same job must resume observation.
3. Review actual processed preview and before/after audio. Uncheck a cut, apply draft, undo/redo, save timeline on Mac, and export reviewed MP4. Open Original / Edited videos after reload and verify both files remain.
4. Before and during recording, use **Camera & avatar layout** to hide/show, choose each corner, resize, and drag the overlay. After stopping, check the editor's **Camera** controls retain that layout. Hide/show again, undo/redo, and compare the actual server output to the chosen layout. Also change zoom, mirror, background/padding/corners, trim, and captions. Verify explicit warning/SRT fallback when libass is absent.
5. Export both 1920×1080 and 1080×1920. Check code readability, audio/video alignment at beginning/middle/end, caption/cut time mapping, and chapters. Social range selection must be labeled marker/rule-based.
6. Cancel during extraction/cleanup/render; retain originals and any previous successful MP4. Retry safely. Restart the local service mid-job; show failed/interrupted state without pretending success.
7. Clear only test browser data / switch localhost origin, then restore a backend project through dashboard recovery. Preserve originals and outputs. Test storage quota, corrupted media, and missing devices in disposable fixtures.

## 30-minute / model gate

Record a real 30-minute 1080p/30 lesson on the MacBook M1 with H390/webcam. Measure memory, disk use, elapsed render time, UI responsiveness, pauses, and A/V sync. Do not infer that this passed from a timeline-math fixture or a 42-second example.

Install optional models separately, configure an existing multilingual Whisper model, and test Khmer/English narration and technical terms. Inspect quiet syllables around proposed cuts and correct captions before publishing. Verify required font shaping and burned text with a libass-capable FFmpeg build or the browser path. These checks remain pending.
