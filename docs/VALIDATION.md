# Acceptance evidence and outstanding gates

## Executed in this session

- `npm run build`: passed strict TypeScript and Vite production bundle.
- `npm test`: 13 passing tests for zoom/timeline/silence/source fitting/compositor parameters and mocked recorder lifecycle.
- `npm ci --dry-run --ignore-scripts --offline`: dependency graph validation passed after repairing inherited incompatible versions. A fresh offline install could not retrieve cached tarballs, so a clean install remains unverified.
- Server-side React rendering: dashboard renders without a component exception (not browser visual QA).
- `npm run test:browser`: attempted; blocked before test execution by Chrome `SIGABRT` and sandbox `EPERM`.
- `npm run dev`: attempted; sandbox denies localhost binding with `EPERM`.
- npm FFmpeg package installation: registry hostname cannot resolve. Native MP4/WebM path implemented; FFmpeg.wasm unavailable.
- Native browser file-preview attempts did not expose rendered content; they are not accepted as UI evidence.

## Browser integration gate

Run `npm run build && npm run test:browser` outside the restricted execution sandbox. Inspect `/tmp/reancode101-tests/`:

- Dashboard, editor, and mobile PNGs have no clipped controls or horizontal overflow.
- `result.json` confirms output dimensions and decoded cyan zoom target/orange webcam pixels.
- Actual downloadable MP4 uses H.264/AAC when supported; WebM otherwise. Check audio audibility and synchronization in Chrome and a second player.
- Permission denial/retry, pause/resume, original persistence, saved-export playback/download after editor exit and reload, and no runtime exceptions pass.

The browser fixture replaces physical devices only. The real MediaRecorder/Canvas/Web Audio/storage/encoding path must execute; mocked lifecycle tests do not substitute for this gate.

## Hardware and 30-minute gate (MacBook M1 / H390 / Chrome)

1. Allow Chrome screen, microphone, and camera permissions in macOS. Select the VS Code window and the H390 explicitly after granting microphone permission.
2. Run a mic test with quiet Khmer narration, fan noise, and normal room conditions. Compare original/enhanced without clipping or excessive syllable loss.
3. Record at least 30 minutes at 1080p/30 with webcam. Note wall time, pause periods, actual selected source dimensions, browser storage use, and Chrome memory before/during/after. Stored bytes should grow while retained JS memory does not grow with raw capture size.
4. Pause for ten seconds at multiple points; verify recording duration excludes pauses and webcam/audio remain synchronized. End sharing from Chrome once in a separate shorter test. Disconnect microphone/camera in separate short tests and confirm safe finalization.
5. Add zooms into code at start/middle/end, pan between two focus regions, return to 1×, and drag the overlay between corners. Reopen the project and confirm saved edits and originals.
6. Analyze the long recording, cancel/restart once, review silence suggestions, remove pauses, undo/redo, and inspect speech edges. Streaming analysis should keep responsive controls.
7. Export 1080p/30 MP4 where supported, then WebM. Inspect zoom, border/shadow, title/watermark, camera placement, cut duration, and lip/audio synchronization at beginning/middle/end. Record actual output codecs, duration, size, elapsed export time, and peak memory.
8. Cancel export and verify output cleanup. Hide the tab during export and verify an explicit retry message. Try 1440p/60 separately; resource failure must leave originals usable.
9. Reload the origin; open, rename, duplicate, and delete a duplicate while retaining the original. Download original and metadata. Test reduced-quota/private-storage conditions separately.
10. Import a known valid MP4/WebM and a corrupted file. Verify playable media opens and corrupt input fails with a useful message.

All real-media checks above remain pending. Production readiness is not established until they pass.

## Recovered media (November 6)

Three original/processed files were found under the previous backend storage and copied into Recordings with descriptive names. SHA-256 digests match each source exactly. ffprobe verifies the two originals as 1920×1080 VP9/Opus WebM and the 42.165-second processed output as 1920×1080 H.264/AAC MP4. The other original has no successful processed file; its saved job reports processing failure. These checks establish the recovered files and codecs, not the new browser export pipeline.
