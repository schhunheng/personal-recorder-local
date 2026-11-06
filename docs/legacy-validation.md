# Validation record and hardware acceptance plan

## Executed here (2026-11-02, macOS ARM64 host, Node 22.20)

| Check | Result and limit |
| --- | --- |
| TypeScript and Vite production build | Passed; build has RNNoise unavailable manifest and visible fallback path. |
| Unit tests | 9 passed. Real frame adapter continuity, missing input, fixed buffers over 3 simulated hours; mocked Web Audio graph/lifecycle; mocked muxer track selection, pause/resume and final chunk order; real filesystem ordering, ownership, disk error and partial preservation. |
| Simulated long audio | 518,400,000 samples through framing at accelerated speed. Does not run RNNoise, capture/encode video, or establish three-hour recording stability. |
| RNNoise processing | Not executed: dependency not cached and registry DNS unavailable. ABI checked against upstream source only. |
| Browser end-to-end | Attempted; Chrome launch aborted under the sandbox (SIGABRT / EPERM). Test suite is provided but has no passing runtime result. |
| Dev server | Attempted; loopback listen denied (EPERM). Production build succeeds without a server. |
| Electron source picker, secure asset protocol, installers | Not executed: Electron download unavailable. |
| Noise quality, real end-to-end latency, CPU and lip-sync | Not measured. No fabricated benchmark values. |

The browser harness uses an intercepted local HTTPS origin, deterministic tone/fake media capture and an in-memory IPC fixture. It checks a live output graph, silence on mute, stable track identity through changes, paired tests, fallback, disconnect recovery, webcam composition, pause/resume, and audio decoded from muxed WebM. It writes `docs/browser-results.json` only after every assertion passes. If the RNNoise asset exists it requires active AI; otherwise it requires a visible fallback. It does not replace packaged Electron testing.

## Run on both target machines

Use an Apple Silicon M1 Mac and Windows 10/11 PC with RTX 4060. Record OS/Electron/Chromium versions, input/output hardware, driver, sample rates, power mode, selected AEC/AGC toggles and encoder. Run installed packaged builds offline, with Wi-Fi disabled, as well as development fixtures. Confirm no outbound requests while processing. Capture only consented, locally stored test speech/noise.

For each case below test Off, Standard, and **verified active** AI. Enhanced AI is unavailable and must not be scored. Keep microphone distance/gain constant and avoid clipping. Use the same speech excerpt with quiet pauses, fricatives, consonants and soft syllables. Mix traffic, passing motorcycle, dog/animal and keyboard/fan fixtures at documented SNRs (for example -5, 0, 10 and 20 dB); include natural room capture. Suppression can damage speech or leave nonstationary sounds: listening evaluation is required.

| Scenario | Observe / measure |
| --- | --- |
| Quiet room | Voice timbre, breaths, consonants, noise pumping and artifacts versus bypass. |
| Traffic, motorcycle passing | Residual noise during speech/pauses, lost syllables, recovery after transient. |
| Dog/animal sounds | Bark attenuation and voice clarity while sounds overlap. |
| Fan / AC | Steady-state attenuation and tonal remnants. |
| Keyboard typing | Transient leakage and speech distortion during typing. |
| Mute / unmute, hardware privacy switch | Final saved audio silent while muted; no stale bursts; recovery without stuck status. |
| Mic switch and unplug/replug | Switch between 44.1 and 48 kHz devices while recording/paused; destination remains stable, UI explains silence/fallback; rejected device leaves previous one working. |
| Pause / resume repeated 100 times | One valid video, no missing final audio, no growing memory or timestamp jumps at resume. |
| Three-hour real recording | Bounded RSS, no unbounded file queue, acceptable CPU, no worklet heartbeat failures, valid final file. Test foreground/background/minimized and capture selection changes between sessions. |
| A/V synchronization | Clap/visible LED at start, every 15 minutes and end. Measure video frame time minus audio transient time with FFmpeg/ffprobe or editor; compare modes. |
| Failure/recovery | Kill renderer, disconnect mic, revoke permissions, fill disk or slow writes. Prior bytes retained in partial file; no successful-save message after failure. |

## Measurement method and proposed acceptance gates

These are **targets to validate**, not achieved results:

- Voice quality: blinded A/B review plus local SI-SDR/STOI against clean aligned reference speech when available. Report noise attenuation in non-speech windows separately from speech distortion. Avoid judging solely by reduced RMS. Keep all analysis offline.
- Latency: route a repeatable impulse/chirp into the microphone path and measure loopback input→processed output with a common-clock recorder. Repeat at least 100 times; report median/p95. Measure capture/browser/limiter delay for Off and Standard, and the incremental AI delay. Target AI incremental p95 below 40 ms, zero missed worklet deadlines.
- Performance: record app CPU/RSS (UI shows app totals) and OS process traces at one-second intervals; compare screen recording with Off versus AI at the same resolution/webcam settings. Target incremental AI below 10% of one CPU core and no sustained memory slope after warmup. Specify OS CPU percentage conventions; app aggregate percentages are not a DSP-only measurement.
- Synchronization: proposed absolute audio/video error under 80 ms, with drift under one 30 fps frame from start to finish. Constant AI offset can require explicit video compensation if measured error exceeds the threshold. This implementation has no timestamp compensation yet.
- Stability: three-hour capture completes, file plays with continuous audio across mic changes/pause/resume, no leaked device handles, no stalled save, and memory/queue remain bounded. Use `ffprobe -show_streams -show_format output.webm` and listen at every checkpoint. Remux into a separate file if a duration/seek index is needed.

Store per-platform results in a local report: engine actual status, sample rates, quality scores/listening notes, latency median/p95, CPU baseline/AI delta, memory baseline/end, frame drops, A/V start/end offsets, device recovery time, final file duration/size and errors. Do not label RNNoise or a platform verified until its runtime and these acceptance checks pass.
