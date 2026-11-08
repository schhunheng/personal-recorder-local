# Automated local studio implementation

The updated brief permits a localhost FastAPI/FFmpeg service. Preserve the React recorder, nondestructive editor, original media, and saved-output library. Old backend recordings remain untouched.

1. Add a separate SQLite-backed studio job service and immutable multi-asset upload/finalization API. Reuse the tested subprocess cancellation/progress machinery; do not use the legacy expiry policy.
2. Build FFmpeg cleanup and loudness normalization, bounded-memory speech/energy analysis, padded silence/explicit-retake EDL generation, and H.264/AAC rendering. Persist stage progress, failures, retries, EDL versions, and every successful output.
3. Connect automatic processing after Stop, SSE progress, original/processed review, preset selection, EDL application/undo, and one-click server export. Keep manual browser editing available while the local service is unavailable.
4. Preserve microphone separately; add important/zoom/retake markers. Recompose camera/avatar, manual zoom regions, style, captions, and LMS/vertical profiles from metadata.
5. Add optional offline Silero/Whisper adapters with no runtime downloads, editable caption timestamps, SRT import/export, caption styling/burn-in, and reviewable caption-derived chapter suggestions. Model absence must be explicit.
6. Verify real FFmpeg output with generated speech/silence/video fixtures and recovered sample recordings; retain the Chrome/hardware validation gates. Never claim model quality or actual Chrome recording based on unit tests.

Optional background removal, semantic mistake detection, and automatic semantic highlights require verified models/quality evidence; do not fabricate these results.

## Current implementation status

- [x] SQLite projects/jobs, immutable streamed assets, SSE stage progress, cancellation/retry/restart state.
- [x] FFmpeg cleanup/normalization, padded pause/retake EDL, restore/rerender, preserved originals and prior results.
- [x] Stop-to-pipeline integration, processed/audio preview controls, draft review/apply/undo, original/edited library, local-project recovery (build verified; connected-browser gate pending).
- [x] Independent microphone asset/timing, important/retake/zoom markers, camera/avatar and editable zoom composition; actual decoded zoom/camera render tests pass.
- [x] Caption text/timestamp/style editor, SRT remapping/import/export, optional local transcription adapter, chapter remapping/MP4 metadata.
- [x] Exact LMS/vertical export profiles, quality/bitrate controls, marker-based social range selection; actual 1080×1920 output verified.
- [ ] Install and verify Silero/Whisper models on this Mac; optional installation failed in this environment.
- [ ] Verify Khmer font shaping and burned text with libass-capable FFmpeg or the native browser path; current FFmpeg uses explicit SRT fallback.
- [ ] Run connected Chrome/H390/webcam acceptance, full visual QA, and the real 30-minute performance test outside the restricted sandbox.

Latest checks: production build passes; 26 frontend logic tests and 30 backend tests pass. The guided editing stepper, RNNoise 0.2 inference, source alignment, fallback, and gain protection are covered. A 20-second real microphone sample retains its sample count and original hash after neural cleanup. Existing media is organized into UUID folders with hash-verified originals and numbered edits. Independent padding is verified in real MP4 pixels; watermark contrast/custom colors are verified in browser rendering logic and ASS output. See VALIDATION.md and the Recordings verification reports. These checks do not mark pending hardware/model/listening gates complete.
