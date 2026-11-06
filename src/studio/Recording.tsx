import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Mic,
  Monitor,
  AppWindow,
  Globe,
  Circle,
  Pause,
  Play,
  Square,
  ShieldCheck,
  ArrowLeft,
  AudioLines,
  Check,
  X,
} from 'lucide-react';
import { StudioRecorder, type CaptureState } from './recorder';
import type { Project } from './model';
import { formatTime } from './model';
import { usePreferences } from './store';
import { capabilities, mediaError } from './capabilities';
import { Toggle, Field } from './controls';
import { Button } from '../components/ui/button';
export default function Recording({
  onBack,
  onSaved,
  onBusy,
}: {
  onBusy: (busy: boolean) => void;
  onBack: () => void;
  onSaved: (p: Project) => void;
}) {
  const options = usePreferences((s) => s.recording),
    update = usePreferences((s) => s.setRecording);
  const recorder = useRef(new StudioRecorder()),
    screen = useRef<HTMLVideoElement>(null),
    webcam = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CaptureState>('idle'),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [error, setError] = useState(''),
    [level, setLevel] = useState(0),
    [count, setCount] = useState(3),
    [time, setTime] = useState(0),
    [test, setTest] = useState(false),
    [testUrl, setTestUrl] = useState('');
  const testStop = useRef<(() => void) | undefined>(undefined);
  const caps = capabilities();
  useEffect(() => {
    const r = recorder.current;
    r.onState = (state) => {
      setState(state);
      onBusy(state !== 'idle');
    };
    r.onError = setError;
    r.onLevel = setLevel;
    r.onCountdown = setCount;
    r.onSaved = onSaved;
    r.onReady = () => {
      if (screen.current) {
        screen.current.srcObject = r.screen!;
        void screen.current.play();
      }
      if (webcam.current && r.camera) {
        webcam.current.srcObject = r.camera;
        void webcam.current.play();
      }
    };
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    const timer = setInterval(() => setTime(r.seconds), 100);
    const unload = (e: BeforeUnloadEvent) => {
      if (r.state !== 'idle') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', unload);
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
      r.onSaved = () => {};
      r.onState = () => {};
      onBusy(false);
      void r.stop();
      testStop.current?.();
    };
  }, []);
  useEffect(
    () => () => {
      if (testUrl) URL.revokeObjectURL(testUrl);
    },
    [testUrl]
  );
  const busy = state !== 'idle';
  async function testMicrophone() {
    setError('');
    setTest(true);
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.micId ? { exact: options.micId } : undefined,
          noiseSuppression: options.noise,
          echoCancellation: options.echo,
          autoGainControl: options.gain,
        },
      });
      setDevices(await navigator.mediaDevices.enumerateDevices());
      context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(1024);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        setLevel(
          Math.min(
            1,
            Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length) *
              4
          )
        );
      }, 50);
      const chunks: Blob[] = [],
        rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => rec.stop(), 5000);
        testStop.current = () => {
          clearTimeout(timeout);
          if (rec.state !== 'inactive') rec.stop();
        };
        rec.onstop = () => {
          clearTimeout(timeout);
          resolve();
        };
        rec.onerror = () => {
          clearTimeout(timeout);
          reject(Error('Microphone test failed.'));
        };
        rec.start();
      });
      setTestUrl(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })));
    } catch (e) {
      setError(mediaError(e));
    } finally {
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
      setLevel(0);
      setTest(false);
      testStop.current = undefined;
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        if (state === 'recording') recorder.current.pause();
        else if (state === 'paused') recorder.current.resume();
      }
      if (e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        void recorder.current.stop();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [state]);
  return (
    <main className="setup-page">
      <button className="back-link" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} /> Back to projects
      </button>
      <div className="page-eyebrow">YOUR NEXT GREAT LESSON</div>
      <h1>Make something worth sharing.</h1>
      <p className="page-subtitle">
        A little preparation. A much better recording.
      </p>
      <div className="setup-grid">
        <section className="setup-controls">
          <fieldset disabled={busy || test}>
            <div className="section-label">
              01 <span>Choose your canvas</span>
            </div>
            <div className="source-options">
              {(
                [
                  ['monitor', Monitor, 'Entire screen'],
                  ['window', AppWindow, 'Window'],
                  ['browser', Globe, 'Browser tab'],
                ] as const
              ).map(([source, Icon, label]) => (
                <button
                  key={source}
                  className={options.source === source ? 'selected' : ''}
                  onClick={() => update({ source })}
                >
                  <Icon size={23} />
                  <span>{label}</span>
                  {options.source === source && (
                    <Check className="source-check" size={12} />
                  )}
                </button>
              ))}
            </div>
            <p className="muted small">
              Chrome’s picker opens when you start. You choose the final source
              there.
            </p>
            <div className="section-label">
              02 <span>Sound like yourself</span>
              <Mic size={16} />
            </div>
            <Toggle
              label="Microphone"
              checked={options.mic}
              onChange={(mic) => update({ mic })}
            />
            <Field label="Input device">
              <select
                value={options.micId}
                disabled={!options.mic}
                onChange={(e) => update({ micId: e.target.value })}
              >
                <option value="">System default microphone</option>
                {devices
                  .filter((d) => d.kind === 'audioinput' && d.deviceId)
                  .map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
              </select>
            </Field>
            <Toggle
              label="Browser noise suppression"
              checked={options.noise}
              onChange={(noise) => update({ noise })}
            />
            <Toggle
              label="Echo cancellation"
              checked={options.echo}
              onChange={(echo) => update({ echo })}
            />
            <Toggle
              label="Automatic microphone gain"
              checked={options.gain}
              onChange={(gain) => update({ gain })}
            />
            <Toggle
              label="Include tab / system audio"
              description="Available sources depend on Chrome and macOS."
              checked={options.systemAudio}
              onChange={(systemAudio) => update({ systemAudio })}
            />
          </fieldset>
          <div className="mic-test">
            <div
              className="meter"
              role="meter"
              aria-label="Microphone volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} className={level > i / 24 ? 'lit' : ''} />
              ))}
            </div>
            <button
              disabled={busy || !options.mic}
              onClick={() =>
                test ? testStop.current?.() : void testMicrophone()
              }
            >
              <AudioLines size={14} />
              {test ? 'End test' : 'Test mic · 5s'}
            </button>
          </div>
          {testUrl && (
            <audio
              className="test-audio"
              controls
              src={testUrl}
              aria-label="Microphone test playback"
            />
          )}
          <fieldset disabled={busy || test}>
            <div className="section-label">
              03 <span>Add a familiar face</span>
              <Camera size={16} />
            </div>
            <Toggle
              label="Webcam"
              description="Recorded separately. Adjust it later in the editor."
              checked={options.camera}
              onChange={(camera) => update({ camera })}
            />
            {options.camera && (
              <Field label="Camera device">
                <select
                  value={options.cameraId}
                  onChange={(e) => update({ cameraId: e.target.value })}
                >
                  <option value="">System default camera</option>
                  {devices
                    .filter((d) => d.kind === 'videoinput' && d.deviceId)
                    .map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <div className="two-fields">
              <Field label="Capture quality">
                <select
                  value={options.height}
                  onChange={(e) => update({ height: +e.target.value })}
                >
                  <option value={720}>720p · HD</option>
                  <option value={1080}>1080p · Full HD</option>
                  <option value={1440}>1440p · 2K</option>
                </select>
              </Field>
              <Field label="Frame rate">
                <select
                  value={options.fps}
                  onChange={(e) => update({ fps: +e.target.value })}
                >
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS · more CPU</option>
                </select>
              </Field>
            </div>
          </fieldset>
        </section>
        <section className="setup-monitor">
          <div className="monitor-bar">
            <span
              className={
                state === 'recording' ? 'status-dot recording' : 'status-dot'
              }
            />
            <span>
              {busy
                ? state === 'recording'
                  ? 'You’re recording'
                  : state === 'paused'
                  ? 'Recording paused'
                  : state === 'countdown'
                  ? 'Get ready…'
                  : 'Preparing your recording…'
                : 'Ready when you are'}
            </span>
            <span className="spacer" />
            <span className="local-pill">
              <ShieldCheck size={12} /> Only on this device
            </span>
          </div>
          <div className="capture-preview">
            <video ref={screen} muted playsInline />
            <video
              ref={webcam}
              muted
              playsInline
              className={options.camera && busy ? 'capture-webcam' : 'hidden'}
            />
            {!busy && (
              <div className="capture-empty">
                <div className="capture-icon">
                  <Monitor size={40} strokeWidth={1.3} />
                </div>
                <h3>Your ideas, in focus.</h3>
                <p>
                  Choose your screen, take a breath,
                  <br />
                  and share what you know.
                </p>
                <span>SCREEN + AUDIO + YOU</span>
              </div>
            )}
            {state === 'countdown' && <div className="countdown">{count}</div>}
            {state === 'paused' && (
              <div className="countdown">
                <Pause size={60} />
              </div>
            )}
          </div>
          <div className="record-actions">
            <span className="timecode">{formatTime(time)}</span>
            <div className="spacer" />
            {state === 'idle' ? (
              <Button
                disabled={test || !caps.capture || !caps.recorder}
                onClick={() => {
                  setError('');
                  void recorder.current.start(options);
                }}
              >
                <Circle size={15} fill="currentColor" /> Start recording
              </Button>
            ) : (
              <>
                {(state === 'recording' || state === 'paused') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      state === 'paused'
                        ? recorder.current.resume()
                        : recorder.current.pause()
                    }
                  >
                    {state === 'paused' ? (
                      <Play size={16} />
                    ) : (
                      <Pause size={16} />
                    )}
                    {state === 'paused' ? 'Resume' : 'Pause'}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  disabled={state === 'saving'}
                  onClick={() => void recorder.current.stop()}
                >
                  {state === 'countdown' || state === 'preparing' ? (
                    <X size={15} />
                  ) : (
                    <Square size={15} fill="currentColor" />
                  )}
                  {state === 'saving'
                    ? 'Saving…'
                    : state === 'preparing' || state === 'countdown'
                    ? 'Cancel'
                    : 'Stop recording'}
                </Button>
              </>
            )}
          </div>
          <div className="privacy-note">
            <ShieldCheck size={17} />
            <p>
              Private by design. Your recordings stay in your browser.
              <br />
              <span>
                Keep this tab open. Closing or reloading it can interrupt
                capture.
              </span>
            </p>
          </div>
          {!caps.capture && (
            <p role="alert" className="inline-error">
              Screen capture requires desktop Chrome on localhost or HTTPS.
            </p>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
