# Offline desktop screen recorder

Electron + React + TypeScript + Vite recorder with a mono microphone processing graph, screen/window capture, circular webcam compositing, and incremental local WebM saving. This workspace was empty; this is a new implementation rather than a modification of an existing recorder.

**Status:** TypeScript/Vite build and automated unit tests pass. The RNNoise adapter is connected in source, but its actual WASM runtime, browser end-to-end behavior, desktop packaging, real noise reduction quality, and macOS/Windows hardware performance have **not** been verified here. See [validation](docs/VALIDATION.md). Do not treat this as a production-qualified release.

## Start the app

Use Node 22.20+ and npm. Installation needs network access; normal use is offline. Run all commands from the project directory (`video-recorder`).

### First-time setup

Check that Node.js and npm are installed, then install the dependencies (including Electron):

```sh
node --version
npm --version
npm install
```

### Start the desktop app

Build the app and launch its Electron window:

```sh
npm run build
npm run desktop
```

For later launches, run `npm run desktop`. Run `npm run build` again after changing the source. Keep the terminal open while using the app; press `Ctrl+C` in that terminal to stop it.

Allow microphone, camera, and Screen & System Audio Recording in macOS System Settings, or microphone/camera permissions in Windows Settings. Restart after granting screen permission if macOS requests it. Recording excludes system audio. Choose a screen/window, enable the microphone, then Start recording and choose a local destination. Stop & save finalizes the file. Canceling the webcam permission cancels startup without silently changing the requested recording.

### Start in development mode

In the first terminal, start Vite:

```sh
npm run dev
```

Wait for Vite to show `http://127.0.0.1:5173`, then open a second terminal in the same project directory and start Electron:

```sh
npm run desktop:dev
```

Keep both terminals running during development. You can also record directly in a browser at `http://127.0.0.1:5173`: enable the microphone, click **Start recording**, then select a window, screen, or tab in the browser sharing dialog. Click **Stop & save** to request a download automatically. The result beside the recording controls shows the filename and size. Find the file in your browser’s download folder or the location selected in its save dialog; browsers do not expose the full saved path to the app. If no download appeared, click **Download recording (.webm) again**. Disable **Circular webcam** if you do not want camera access. Browser recordings stay in memory and stop automatically at 256 MB; download before closing or reloading the tab. Use Electron for long sessions with incremental disk saving. Screen sharing requires localhost or HTTPS and a browser with screen capture support. Stop both processes with `Ctrl+C` in their respective terminals.

If Electron is missing, rerun `npm install` with network access. If the desktop window cannot load the app, run `npm run build` for a normal launch, or make sure Vite is running for a development launch. If port 5173 is already in use, stop the process using it before starting Vite; the desktop development launcher expects that exact port.

The optional `@jitsi/rnnoise-wasm@0.2.1` dependency supplies a precompiled synchronous WASM module with its model embedded. `prepare:audio` copies it into local assets; there are no runtime CDN requests. If installation omits/fails that package, AI requests visibly fall back to browser suppression, or report bypass if the browser cannot confirm suppression. A missing engine never displays RNNoise as running. Desktop packaging commands require the AI asset to exist; run the browser/hardware tests as well before distribution.

## Download MP4 or MOV

Before starting, choose **Recording format → MP4** for a direct MP4 download when your browser supports it. Unsupported native formats are disabled. WebM remains available as the original recording format.

After **Stop & save**, the recording result includes **Export format → MP4 / QuickTime MOV**. Select a format and click **Download MP4/MOV** in the browser, or **Export MP4/MOV** in Electron. Converted files use H.264 video and AAC audio. The original recording remains available; conversion takes time and can introduce some quality loss. Native MP4 codecs depend on your browser.

MP4/MOV conversion requires a local FFmpeg build with libx264 and AAC support. On macOS with Homebrew:

```sh
brew install ffmpeg
ffmpeg -version
```

Restart `npm run dev` or the desktop app after installing. If FFmpeg is outside your PATH, launch with `FFMPEG_PATH=/absolute/path/to/ffmpeg npm run dev` (or `npm run desktop`). The browser conversion service is provided by the local Vite development server; a static hosted build supports native recording/download only. Conversion stays on this computer and uses temporary files that are removed afterward. Browser conversion is limited to 256 MB of input. The desktop app streams its source to disk and lets you choose an export destination.

## Recording quality and background noise

**Recording quality** defaults to **Maximum detail**: preserves the selected source resolution up to 4K at 30 fps with a 24 Mbps video target and 192 kbps Opus audio. **High** uses up to 1080p at 12 Mbps; **Compact** uses up to 1080p at 5 Mbps. Smaller sources are never enlarged. Higher settings use more CPU and storage and reach the browser's 256 MB limit sooner; choose High if 4K recording stutters. The source's resolution and capture quality still limit the result.

With noise cancellation enabled in Standard or AI mode, **Voice cleanup** adds an 80 Hz rumble filter and a soft expander that lowers quiet noise between phrases. Adjust **Quiet-noise threshold** toward -25 dBFS to attenuate louder background noise during pauses, or toward -60 dBFS if quiet words fade. Cleanup is independent of RNNoise and is bypassed in Off mode. It cannot remove noise overlapping your voice. Leave automatic gain off to avoid raising quiet room noise; use the before/after microphone test to check your actual room and microphone.

AI suppression requires the optional RNNoise dependency. From a network-enabled terminal run:

```sh
npm install --include=optional
npm run prepare:audio
```

Restart the development server (or rebuild the desktop app), select AI, and verify the badge says **RNNoise running**. If it says **WebRTC running** with an AI-unavailable message, the app is using browser suppression. A build passing does not verify the quality of denoising on your microphone.

## Audio behavior

| Mode | Processing |
| --- | --- |
| Off / cancellation disabled | Browser noise suppression disabled; echo cancellation and automatic gain remain independent toggles. |
| Standard | Browser/WebRTC suppression requested and actual capture settings checked. |
| AI | Local RNNoise worklet; browser suppression explicitly disabled and checked. Initialization acknowledges a successfully processed frame. |
| Enhanced AI | DeepFilterNet unavailable, disabled in UI. No model or processing path is bundled. |

“Original” means bypassing suppression, not bit-perfect PCM: Web Audio resampling and the output safety limiter remain in the recording path. The cleanup threshold controls the expander, not RNNoise strength: RNNoise has no supported strength parameter in this adapter. No parallel wet/dry mix is used, avoiding phase differences between delayed paths.

The pipeline uses a 48 kHz AudioContext. Chromium resamples microphone capture to the context rate, including 44.1 kHz devices. A fixed-memory frame adapter converts render quanta into RNNoise's 480-sample frames, scales normalized float audio to/from RNNoise's PCM amplitude range, and adds 10 ms buffering. The model contributes approximately another 10 ms. Capture, browser AEC/AGC, the safety compressor, device buffering, and codecs add latency; UI diagnostics are not an end-to-end latency measurement. No GPU or NVIDIA runtime is required.

Input meters and “before” samples are **after browser capture processing**. In AI mode, paired samples compare pre/post RNNoise from the same capture, with output safety processing on “after”. In Standard mode both samples include browser suppression; repeat a separate test with Off to compare that stage. Samples last eight seconds, stay in memory, and are revoked on replacement/unmount. Monitoring defaults off; use headphones.

The recorder receives only the persistent processed destination track. Device and engine changes preserve that track. Reconnection uses the default input after a disconnection; until then the recording retains silence rather than losing its audio track. Failed device switches preserve the existing microphone. Mute silences capture and the final safety output, including pending denoiser samples.

See [architecture and packaging](docs/ARCHITECTURE.md) and [validation procedure](docs/VALIDATION.md).

## Verify and package

```sh
npm test
npm run build
npm run test:browser
npm run package:mac
npm run package:win
```

The browser test requires Chrome installed, or `CHROME_PATH` pointing to a compatible Chromium binary. It uses deterministic local media fixtures and a mocked file IPC transport; it does not validate Electron's native source picker or OS permissions. Package macOS on an Apple Silicon Mac and Windows on Windows; signing/notarization credentials must be configured for distribution. Commit a complete dependency lockfile from a network-enabled install before release: the restricted environment could not resolve Electron/RNNoise dependencies, so an incomplete lockfile is deliberately not supplied.

Video files stream to a unique `.partial` beside the chosen destination, then flush and rename on success. Encoder/disk/backpressure failures retain the partial; do not delete it if recovery is needed. A crash can leave an incomplete final cluster. Optional repair/remux with a locally installed FFmpeg:

```sh
ffmpeg -i recording.webm.unique-id.partial -c copy recovered.webm
```

For seeking/duration metadata, remux a finished WebM using the same command with the finished file as input and a different output filename. FFmpeg is not bundled or required for capture. At the default 24 Mbps video + 192 kbps audio target, budget roughly 33 GB for three hours, plus free-space margin. Compact targets about 7 GB for three hours. Actual output varies with encoder and content.
