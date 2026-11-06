# Browser studio architecture

The active application has no service API. Vite serves development assets; a static HTTPS host serves production. Screen, microphone, camera, and imported media stay in the browser.

| Module | Responsibility |
| --- | --- |
| `model.ts` | Serializable project, asset, recording settings, nondestructive edits |
| `capabilities.ts` | Secure-context/API/codec checks and permission errors |
| `recorder.ts` | User-activated picker, device acquisition, Web Audio mix, separate screen/webcam MediaRecorders, pause clock, chunk backpressure, lifecycle cleanup |
| `storage.ts` | IndexedDB project/asset/chunk transactions, sequential OPFS output, imports, shared-source duplication/deletion, downloads |
| `store.ts` | Zustand preferences, editor state, bounded undo/redo history |
| `timeline.ts` | Merged cut ranges, retained segments, duration, bounded smooth zoom, padded silence regions |
| `compositor.ts` | Shared preview/export Canvas renderer, crop/fitting, overlay, style, branding |
| `audio.ts` and `public/audio/studio-cleanup.js` | Local preview/export audio graph and envelope noise gate |
| `analyze.ts` and `analysis.worker.ts` | Streaming RMS waveform extraction and worker-based pause detection |
| `export.ts` | Source playback/seek, matching canvas composition, audio destination, native encoding, output progress/cancellation/cleanup |
| `App.tsx`, `Recording.tsx`, `Editor.tsx` | Dashboard/storage library, capture controls, editing workspace |
| `Preview.tsx`, `TimelinePanel.tsx`, `controls.tsx`, `useDialog.ts` | Reusable presentation, playback, editing controls, modal keyboard handling |

## Media invariants

1. Call getDisplayMedia before awaiting storage/device work, preserving transient activation. Picker source hints cannot constrain the user’s final choice.
2. Record the original screen track directly. No UI canvas throttling affects the captured screen. Webcam is a separate immutable asset; both recorders start, pause, resume, and stop together.
3. Mix permitted display audio and microphone using a shared AudioContext destination. That one mixed track travels with screen video. No speaker monitoring during recording, avoiding feedback.
4. Commit one-second original chunks to IndexedDB, with a 32 MiB pending-write safety bound. Never collect the entire capture in a JS array. Mark the project complete only after recording and storage finalization.
5. Interrupted assets and saved metadata survive reload where browser storage permits. A partially finalized container may not decode completely.
6. Editing only changes JSON metadata. Sources are shared by duplicates and deleted only when no other saved project references them.
7. Preview and export call the same drawFrame function. Zoom focus is clamped to source bounds. Camera/avatar coordinates are independent of screen crops.
8. Retained source-time ranges determine preview/export order. Pausing the encoder around source seeks excludes removed timeline sections.
9. Export uses the exact detected codec MIME string. A native encoder error is surfaced, never renamed to a different file format.
10. Cancelled/failed exports stop video, camera, audio contexts, canvas tracks, temporary output, and object URLs. Completed exports have their own persisted records, including project ID, media asset, creation date, duration, and edit snapshot. They survive editor exit and reload.
11. IndexedDB schema version 2 adds an indexed exports store while preserving version-1 project/media stores. Export metadata is committed only for an existing project. Project deletion removes its exports and checks remaining project/export references before deleting media.

## Capability review

[Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) requires HTTPS/localhost, active user interaction, and a new picker for each session. System audio is optional and varies by OS/source; no assumed loopback recording.

[MediaRecorder codec detection](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static) is a capability hint, not a guarantee that every resolution/frame-rate combination has enough resources. Output errors and supported alternatives are explicit.

[FFmpeg.wasm FAQ](https://ffmpegwasm.netlify.app/docs/faq/) identifies browser/WASM memory and performance costs. Native real-time export is the installed working implementation path. A WASM fallback requires actual packaged local core assets, memory budgeting, and codec verification; it is pending package availability and integration validation.

## Smart-feature evaluation

Global cursor/click positions in other applications are unavailable to a normal website. No global listeners are installed. Template-based cursor detection is fragile across OS cursor themes/scales and may confuse code glyphs with cursors. Optical-flow centroids can prioritize scrolling or blinking elements rather than important code. Low-resolution frame differences could suggest visual activity regions, but need confidence thresholds and a measurable fixture set before exposure. Manual zoom is the reliable path; experimental UI describes this limitation without inventing detections.

Basic high-pass/gate/compressor processing is language-independent and local. It is not a semantic voice separator. RNNoise and browser ONNX are possible future optional engines; the current editor does not expose them as verified working features. Speech energy plus pause padding is intentionally reviewable and reversible, especially for quiet Khmer syllables.

## Performance acceptance still required

Use the checklist in VALIDATION.md for a real 30-minute M1 lesson. The 30-minute unit fixture validates edit calculations only. Lower-resolution preview canvases reduce composition work, but original-source decoding still occurs; no proxy transcoding pipeline is claimed. Export currently draws on a main-thread canvas. Background-tab rendering and sleep remain platform limits.
