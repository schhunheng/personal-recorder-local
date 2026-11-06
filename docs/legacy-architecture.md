# Architecture and platform notes

## Signal and recording path

```text
Microphone (mono requested, independent AEC / AGC toggles)
  → Chromium capture processing (NS enabled only for Standard)
  → AudioContext 48 kHz (native capture-rate conversion)
  ├─ input analyser / before-test destination
  └─ selected engine: bypass | WebRTC capture stage | RNNoise AudioWorklet
       → persistent bus → safety compressor → finite/peak/mute guard worklet
       → output analyser → persistent MediaStreamDestination audio track
                           ├─ headphone monitor (off by default)
                           ├─ after-test MediaRecorder (8 seconds)
                           └─ video MediaRecorder + canvas video track
Screen/window → video → canvas + clipped circular webcam → canvas video track
MediaRecorder (WebM VP8/Opus, fallback VP9/Opus, 1 second slices)
  → bounded renderer queue → narrow preload IPC → asynchronous file writes
  → flush/fsync/close/rename → local final WebM
```

RNNoise uses `@jitsi/rnnoise-wasm`'s sync build, which the upstream documents specifically for AudioWorklet use. Its compiled model is embedded; no model fetching, speech API, audio upload, or audio telemetry is implemented. [Upstream implementation and usage](https://github.com/jitsi/rnnoise-wasm) describe the distinction between the async 0.1 and sync 0.2 model. The pinned sync build exports the C allocation/state/process functions; it does not export a frame-size getter. The adapter checks required exports, assumes the documented 480-sample model, and processes a real frame before sending ready. Runtime verification on this host remains blocked by unavailable package download.

## Pluggable boundary

`src/audio/engines.ts` defines `AudioEngine` and `EngineRegistry`; `AudioPipeline.engines.register(adapter)` replaces an implementation for a mode. Worklet engines produce mono normalized float PCM at 48 kHz, acknowledge initialization, emit error/heartbeat messages, and accept destroy. Capture policy is centralized in `settings.ts`. To add another mode, extend the mode type, its capture policy, registry, and UI capability information; declare delay and provide separate lifecycle/performance tests. No engine may be advertised as active before initialization succeeds.

A new microphone/engine graph is opened and initialized before replacing the previous graph. Requests are serialized, with generation checks discarding stale work. The final destination stays stable. Engine failures fall back to Standard with a visible explanation; browser capture settings must confirm NS before it is labeled active. AI requires capture NS explicitly confirmed false. Processing errors and a one-second heartbeat monitor detect engine failure even in quiet input. A suspended context does not trigger false heartbeat failures.

The compressor reserves approximately 3 dB peak headroom, with a final finite-value guard and 0.99 peak ceiling. This avoids invalid/out-of-range samples; it cannot repair a microphone ADC that already clipped. Heavy limiting changes the waveform: lower hardware gain when input peaks approach full scale. No speech/noise quality claims or CPU/latency targets are inferred from these safeguards.

## Long sessions and synchronization

The frame adapter owns two fixed 480-float arrays, performs no allocation in steady-state processing, and advances by sample count. No timers determine the audio sample rate. Recorder chunks are not accumulated for a final Blob. An application-level 32 MiB pending-write ceiling stops recording on slow storage; IPC chunks are individually limited to 16 MiB. Finalization waits for all queued writes, including the final MediaRecorder event. Disk errors never rename a failed recording as successful. Screen/webcam tracks and timers are released; microphone capture persists for subsequent recordings.

MediaRecorder muxes audio and canvas video on Chromium timestamps. AI adds a fixed audio delay; no video timestamp compensation is implemented. A/V lip-sync and long-term drift must be measured on real devices before acceptance. Canvas composition runs in the renderer at a target 30 fps; background throttling is disabled and an active recording holds a power-save blocker. This is not a guarantee against overload, sleep, OS lock behavior, driver stalls, or disk exhaustion. VP8 is preferred to reduce encoding cost relative to software VP9. Profiling may justify an encoder/compositor replacement later; it is not part of this audio implementation.

## Desktop boundaries and packaging

- Main process performs asynchronous filesystem writes, source enumeration, permission handling, and local metrics. No DSP or FFmpeg runs there.
- Preload exposes only source selection, recording begin/append/finish, and metrics. Context isolation and sandbox are enabled; Node integration is off. IPC validates main-frame/window ownership. File paths come from a native save dialog, not arbitrary renderer arguments.
- Packaged assets use the secure standard `recorder://app` protocol so worklet imports and fetch work without permissive `file://` behavior. Protocol paths are restricted to the distribution directory. CSP and a session request filter block external hosts; development permits only localhost port 5173. New windows/external navigation are denied.
- Models and worklet scripts are copied under `dist/audio`, included inside the application ASAR as ordinary assets. No native RNNoise add-on, CUDA, Python, sidecar service, or target-specific DSP compilation is required. Emscripten WASM runs on Chromium's CPU engine on ARM64 and x64.
- Electron itself and electron-builder need download access at installation/build time. These dependencies could not be installed here. Signing, installers, production protocol behavior, and permission prompts remain untested.
- macOS ARM64 DMG config includes microphone/camera usage strings and hardened runtime entitlements for camera, audio input, and JIT. Supply proper signing/notarization for distribution. Users separately grant Screen & System Audio Recording permission.
- Windows x64 NSIS targets Windows 10/11; test device privacy switches and audio driver changes. RNNoise does not use the RTX 4060; GPU availability primarily affects video capture/encoding/composition.
- Release packaging runs with `REQUIRE_RNNOISE=1`; asset absence is fatal. Also audit and retain all upstream package/model/license notices before shipping (Jitsi Apache-2.0 wrapper; RNNoise upstream notices must accompany distribution). The asset manifest signals file availability only, not platform qualification.

## DeepFilterNet evaluation

[DeepFilterNet upstream](https://github.com/Rikorose/DeepFilterNet) provides Rust inference and integrations including CLI/LADSPA. That is not a verified drop-in Electron AudioWorklet backend. A feasible follow-up is an ARM64/x64 Rust native worker/utility process with bundled model, a bounded PCM transport, explicit sample-clock/delay handling, and crash fallback; alternatively benchmark a WASM build with its required inference backend. Before enabling it, verify Windows/macOS builds, model licensing, per-frame deadlines, memory/CPU use over three hours, A/V delay, signing and packaging. No such backend is implemented here, so Enhanced AI stays disabled.
