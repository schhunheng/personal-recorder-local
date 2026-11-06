import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioPipeline, type PipelineStatus } from './audio/AudioPipeline';
import { readSettings, type AudioSettings } from './audio/settings';
import { compareMicrophone, type Comparison } from './audio/comparison';
import { ScreenRecorder, recordingMimeType, type RecordingFormat, recordingQualities, type RecordingQuality, type RecorderState } from './recording/ScreenRecorder';
import './style.css';

function requestDownload(recording: { url: string; filename: string }) {
  const link = document.createElement('a');
  link.href = recording.url; link.download = recording.filename;
  document.body.append(link);
  link.click(); link.remove();
}

function LevelMeter({ node, label }: { node?: AnalyserNode; label: string }) {
  const [level, setLevel] = useState({ rms: -90, peak: -90 });
  useEffect(() => {
    if (!node) return;
    const samples = new Float32Array(node.fftSize);
    const timer = setInterval(() => {
      node.getFloatTimeDomainData(samples);
      let squares = 0, peak = 0;
      for (const value of samples) { squares += value * value; peak = Math.max(peak, Math.abs(value)); }
      setLevel({ rms: Math.max(-90, 20 * Math.log10(Math.sqrt(squares / samples.length) || 1e-9)), peak: Math.max(-90, 20 * Math.log10(peak || 1e-9)) });
    }, 100);
    return () => clearInterval(timer);
  }, [node]);
  return <div className="level"><div><span>{label}</span><small>{level.rms.toFixed(0)} dBFS · peak {level.peak.toFixed(0)}</small></div><meter min={-60} max={0} low={-36} high={-3} optimum={-18} value={level.rms} aria-label={label} />{level.peak > -1 && <small className="warning">Near clipping — reduce the microphone’s hardware gain.</small>}</div>;
}
function App() {
  const [settings, setSettings] = useState<AudioSettings>(readSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const pipelineRef = useRef<AudioPipeline | undefined>(undefined);
  const [pipeline, setPipeline] = useState<AudioPipeline>();
  const [status, setStatus] = useState<PipelineStatus>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [monitor, setMonitor] = useState('none');
  const [testing, setTesting] = useState(false);
  const testAbort = useRef<AbortController | undefined>(undefined);
  const [comparison, setComparison] = useState<Comparison>();
  const [sources, setSources] = useState<{ id: string; name: string; thumbnail: string }[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [webcam, setWebcam] = useState(true);
  const [format, setFormat] = useState<RecordingFormat>(() => recordingMimeType('webm') ? 'webm' : 'mp4');
  const [exportFormat, setExportFormat] = useState<'mp4' | 'mov'>('mp4');
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const [exportCapability, setExportCapability] = useState({ available: false, message: 'Checking local MP4/MOV converter…' });
  const [exported, setExported] = useState<{ url: string; filename: string }>();
  const [exportedPath, setExportedPath] = useState('');
  const [quality, setQuality] = useState<RecordingQuality>('sharp');
  const [recorder] = useState(() => new ScreenRecorder());
  const [recordState, setRecordState] = useState<RecorderState>('idle');
  const [starting, setStarting] = useState(false);
  const [saved, setSaved] = useState('');
  const [download, setDownload] = useState<{ url: string; filename: string; bytes: number }>();
  const [elapsed, setElapsed] = useState(0);
  const [metrics, setMetrics] = useState<{ cpuPercent: number; memoryMB: number }>();
  const preview = useRef<HTMLVideoElement>(null);
  const saveResult = useRef<HTMLDivElement>(null);
  const active = recordState !== 'idle' || starting;
  const refreshDevices = async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter(device => device.kind === 'audioinput'));
  };
  const refreshSources = async () => {
    try {
      const list = await window.desktop?.sources() ?? [];
      setSources(list); setSourceId(previous => list.some(source => source.id === previous) ? previous : list[0]?.id ?? '');
    } catch (error) { setError(String(error)); }
  };
  useEffect(() => {
    recorder.onState = setRecordState; recorder.onError = error => setError(error.message);
    recorder.onSaved = setSaved;
    recorder.onDownload = (blob, filename) => {
      const recording = { url: URL.createObjectURL(blob), filename, bytes: blob.size };
      setExported(undefined); setExportedPath('');
      setDownload(recording);
      requestDownload(recording);
    };
    recorder.onPreview = stream => { if (preview.current) { preview.current.srcObject = stream ?? null; if (stream) void preview.current.play().catch(() => {}); } };
    const devicesChanged = () => { void refreshDevices().catch(error => setError(String(error))); };
    navigator.mediaDevices.addEventListener('devicechange', devicesChanged);
    void refreshSources(); void refreshDevices().catch(() => {});
    const preventClose = (event: BeforeUnloadEvent) => { if (recorder.isActive || exportBusy.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', preventClose);
    return () => { testAbort.current?.abort(); void pipelineRef.current?.close(); navigator.mediaDevices.removeEventListener('devicechange', devicesChanged); window.removeEventListener('beforeunload', preventClose); };
  }, [recorder]);
  useEffect(() => {
    try { localStorage.setItem('audio-settings', JSON.stringify(settings)); } catch { /* session settings still apply */ }
    const audio = pipelineRef.current;
    if (!audio) return;
    setBusy(true);
    let current = true;
    void audio.configure(settings).catch(error => { if (current) setError(String(error)); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [settings]);
  useEffect(() => {
    return () => { if (comparison) { URL.revokeObjectURL(comparison.before); URL.revokeObjectURL(comparison.after); } };
  }, [comparison]);
  useEffect(() => {
    if (recordState !== 'recording') return;
    const timer = setInterval(() => setElapsed(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recordState]);
  useEffect(() => {
    if (!window.desktop) return;
    const timer = setInterval(() => { void window.desktop!.metrics().then(setMetrics).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  useEffect(() => {
    if (download || saved) saveResult.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [download, saved]);
  useEffect(() => () => { if (exported) URL.revokeObjectURL(exported.url); }, [exported]);
  useEffect(() => {
    let current = true;
    const check = window.desktop?.exportCapabilities
      ? window.desktop.exportCapabilities()
      : fetch('/api/video-export').then(async response => { if (!response.ok) throw Error(); return response.json(); });
    void check.then(result => { if (current) setExportCapability(result); }).catch(() => {
      if (current) setExportCapability({ available: false, message: 'Format conversion requires the desktop app or the local npm run dev server with FFmpeg installed.' });
    });
    return () => { current = false; };
  }, []);
  const exportRecording = async () => {
    if (exporting) return;
    exportBusy.current = true; setExporting(true); setError('');
    try {
      if (download && download.filename.endsWith(`.${exportFormat}`)) { requestDownload(download); return; }
      if (window.desktop) {
        const path = await window.desktop.exportVideo(exportFormat);
        if (path) setExportedPath(path);
      } else if (download) {
        const source = await (await fetch(download.url)).blob();
        const response = await fetch(`/api/video-export?format=${exportFormat}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Recorder-Export': '1' }, body: source,
        });
        if (!response.ok) { const result = await response.json(); throw Error(result.error || 'Video export failed'); }
        const blob = await response.blob();
        const result = { url: URL.createObjectURL(blob), filename: download.filename.replace(/\.[^.]+$/, `.${exportFormat}`) };
        setExported(result); requestDownload(result);
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { exportBusy.current = false; setExporting(false); }
  };
  const enableAudio = async () => {
    setBusy(true); setError('');
    try {
      const audio = await AudioPipeline.create();
      audio.onStatus = setStatus; pipelineRef.current = audio;
      await audio.configure(settingsRef.current);
      setPipeline(audio); setStatus(audio.status);
      await refreshDevices();
    } catch (error) { await pipelineRef.current?.close(); pipelineRef.current = undefined; setError(String(error)); }
    finally { setBusy(false); }
  };
  const update = (patch: Partial<AudioSettings>) => { setError(''); setSettings(previous => ({ ...previous, ...patch })); };
  const test = async () => {
    if (!pipeline) return;
    setTesting(true); setError(''); setComparison(undefined);
    const abort = new AbortController(); testAbort.current = abort;
    try { setComparison(await compareMicrophone(pipeline, abort.signal)); }
    catch (error) { if (!abort.signal.aborted) setError(String(error)); }
    finally { setTesting(false); }
  };
  const start = async () => {
    if (!pipeline) return;
    setStarting(true); setError(''); setSaved(''); setExported(undefined); setExportedPath(''); setElapsed(0);
    try {
      // Request screen sharing before awaiting audio resume to preserve the user gesture.
      const resuming = pipeline.context.resume();
      await Promise.all([resuming, recorder.start(pipeline.stream, { sourceId, webcam, quality, format })]);
    }
    catch (error) { setError(String(error)); }
    finally { setStarting(false); }
  };
  const toggleMute = () => { pipeline?.setMuted(!muted); setMuted(!muted); };
  return <main>
    <header><div className="brand">◉ <span>LOCAL / RECORDER</span></div><span className="privacy">● Offline audio · local files</span></header>
    <div className="intro"><span className="eyebrow">YOUR SCREEN. YOUR VOICE. YOUR DEVICE.</span><h1>Keep the voice.<br /><em>Quiet the background.</em></h1><p>Record your screen with a circular camera overlay and offline microphone processing.</p></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!window.desktop && <div className="notice">Click Start recording to choose a screen, window, or tab in your browser. Stop & save downloads the selected recording format. The filename and download link appear beside the recording controls. Keep this tab open until your file has downloaded.</div>}
    <div className="columns">
      <section className="panel"><div className="panel-title"><h2>Microphone</h2><span className="badge">{status?.active === 'ai' ? 'RNNoise running' : status?.active === 'standard' ? 'WebRTC running' : status?.active ?? 'Not connected'}</span></div>
        {!pipeline ? <button className="primary" onClick={() => void enableAudio()} disabled={busy}>{busy ? 'Connecting…' : 'Enable microphone'}</button> : <>
          <label>Input device<select value={settings.deviceId} disabled={busy || testing} onChange={event => update({ deviceId: event.target.value })}><option value="">System default</option>{devices.filter(device => device.deviceId !== 'default').map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={settings.enabled} disabled={testing || busy} onChange={event => update({ enabled: event.target.checked })} />Noise cancellation</label>
          <label>Processing mode<select value={settings.mode} disabled={!settings.enabled || testing || busy} onChange={event => update({ mode: event.target.value as AudioSettings['mode'] })}><option value="off">Off — original capture</option><option value="standard">Standard — browser / WebRTC</option><option value="ai">AI — RNNoise, offline WASM</option><option disabled>Enhanced AI — DeepFilterNet (unavailable)</option></select></label>
          <p className="hint">RNNoise runs on an AudioWorklet at 48 kHz. It has no strength setting. AI mode disables browser noise suppression.</p>
          <div className="toggles"><label className="check"><input type="checkbox" checked={settings.echoCancellation} disabled={busy || testing} onChange={event => update({ echoCancellation: event.target.checked })} />Echo cancellation</label><label className="check"><input type="checkbox" checked={settings.autoGainControl} disabled={busy || testing} onChange={event => update({ autoGainControl: event.target.checked })} />Automatic gain</label></div>
          <p className="hint">Off bypasses noise suppression; echo and gain remain independent. Input meters are after browser capture processing.</p>
          <label className="check"><input type="checkbox" checked={settings.voiceCleanup ?? true} disabled={busy || testing || !settings.enabled || settings.mode === 'off'} onChange={event => update({ voiceCleanup: event.target.checked })} />Voice cleanup — reduce rumble and noise between phrases</label>
          {(settings.voiceCleanup ?? true) && <label>Quiet-noise threshold: {settings.gateThresholdDb ?? -45} dBFS<input aria-label="Quiet-noise threshold" type="range" min="-60" max="-25" step="1" value={settings.gateThresholdDb ?? -45} disabled={busy || testing || !settings.enabled || settings.mode === 'off'} onChange={event => update({ gateThresholdDb: Number(event.target.value) })} /></label>}
          <p className="hint">Move the threshold right to reduce louder noise between words. Lower it if quiet words fade. Cleanup is bypassed in Off mode. It does not remove background voices while you speak. Use AI mode for RNNoise when installed; automatic gain can raise room noise.</p>
          <LevelMeter node={pipeline.inputMeter} label="Input level" /><LevelMeter node={pipeline.outputMeter} label="Output level" />
          <button onClick={toggleMute}>{muted ? 'Unmute microphone' : 'Mute microphone'}</button>
          {status?.message && <div className="notice" role="status">{status.message}</div>}
          <div className="diagnostics">{status?.sampleRate} Hz · graph base latency {status?.baseLatencyMs.toFixed(1)} ms · {status?.algorithmicDelayMs} ms algorithmic delay<span>Device capture and codec delay are additional. A/V offset requires hardware validation.</span></div>
          <details><summary>Actual browser capture settings</summary><pre>{JSON.stringify(status?.capture, null, 2)}</pre></details>
        </>}
      </section>
      <div className="right-column"><section className="panel"><div className="panel-title"><h2>Screen recording</h2><span className="badge">{recordState}</span></div>
        <div className="preview"><video ref={preview} muted playsInline autoPlay /><div className="preview-label">{active ? `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}` : 'Screen + circular webcam + processed voice'}</div></div>
        <label>Recording format<select value={format} disabled={active || exporting} onChange={event => setFormat(event.target.value as RecordingFormat)}><option value="webm" disabled={!recordingMimeType('webm')}>WebM</option><option value="mp4" disabled={!recordingMimeType('mp4')}>MP4{!recordingMimeType('mp4') ? ' — use export after recording' : ''}</option></select></label>
        <p className="hint">Choose MP4 here for direct recording when supported. After stopping, export MP4 or MOV with the local converter.</p>
        <label>Recording quality<select value={quality} disabled={active} onChange={event => setQuality(event.target.value as RecordingQuality)}>{Object.entries(recordingQualities).map(([value, profile]) => <option key={value} value={value}>{profile.label}</option>)}</select></label>
        {window.desktop ? <label>Screen or window<select value={sourceId} disabled={active} onChange={event => setSourceId(event.target.value)}>{!sources.length && <option value="">No source selected</option>}{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label> : <p className="hint">Choose the window in the browser’s sharing dialog when you start recording.</p>}
        <div className="actions">{window.desktop && <button disabled={active} onClick={() => void refreshSources()}>Refresh sources</button>}<label className="check"><input type="checkbox" checked={webcam} disabled={active} onChange={event => setWebcam(event.target.checked)} />Circular webcam</label></div>
        <div className="actions">{!active ? <button className="primary" disabled={!pipeline || busy || testing || exporting || (Boolean(window.desktop) && !sourceId) || !navigator.mediaDevices?.getDisplayMedia} onClick={() => void start()}>● Start recording</button> : <><button disabled={starting || recordState === 'saving'} onClick={() => recordState === 'paused' ? recorder.resume() : recorder.pause()}>{recordState === 'paused' ? 'Resume' : 'Pause'}</button><button className="primary" disabled={starting || recordState === 'saving'} onClick={() => void recorder.stop().catch(error => setError(String(error)))}>{recordState === 'saving' ? 'Saving…' : 'Stop & save'}</button></>}</div>
        {(saved || download) && <div className="notice save-result" role="status" ref={saveResult}>
          {saved ? <><strong>Recording saved</strong><span>Location: {saved}</span></> : download && <>
            <strong>Recording ready · download requested</strong>
            <span>{download.filename} · {(download.bytes / (1024 * 1024)).toFixed(2)} MB</span>
            <span>Location: your browser’s download folder, or the location you choose in its save dialog. Your browser does not share the full saved path with this app.</span>
            <a className="download-button" href={download.url} download={download.filename}>Download recording (.{download.filename.split('.').pop()}) again</a>
            <span>If no file appeared, click the download button above. Keep this tab open until the download finishes.</span>
          </>}
          <label>Export format<select value={exportFormat} disabled={exporting || active} onChange={event => setExportFormat(event.target.value as 'mp4' | 'mov')}><option value="mp4">MP4 (.mp4)</option><option value="mov">QuickTime MOV (.mov)</option></select></label>
          <button className="primary" disabled={exporting || active || (!exportCapability.available && !download?.filename.endsWith(`.${exportFormat}`))} onClick={() => void exportRecording()}>{exporting ? 'Converting… keep this app open' : `${window.desktop ? 'Export' : 'Download'} ${exportFormat.toUpperCase()}`}</button>
          {!exportCapability.available && <span>{exportCapability.message} Native MP4 recording above does not need FFmpeg when supported.</span>}
          {exportCapability.available && <span>Conversion runs locally with H.264 video and AAC audio. It can take a while; the original stays available.</span>}
          {exported && <a className="download-button" href={exported.url} download={exported.filename}>Download {exported.filename} again</a>}
          {exportedPath && <span>Export saved: {exportedPath}</span>}
        </div>}
        <p className="hint">{format === 'mp4' ? 'MP4' : 'WebM / Opus'} · {recordingQualities[quality].label} · {recordingQualities[quality].bitrate / 1_000_000} Mbps target. Actual detail is limited by the selected source. {window.desktop ? 'Incremental local saving.' : 'Downloads when stopped. Stops automatically at 256 MB; use the desktop app for longer recordings.'} System audio is excluded.</p>
      </section>
      <section className="panel"><div className="panel-title"><h2>Hear the difference</h2><span className="badge">8 second test</span></div><p className="hint">Use headphones for monitoring. Samples stay in memory and are discarded when replaced or closed.</p>
        <label>Live monitor<select value={monitor} disabled={!pipeline} onChange={event => { setMonitor(event.target.value); pipeline?.setMonitoring(event.target.value as 'none' | 'before' | 'after'); }}><option value="none">Off</option><option value="before">Before engine (50% volume)</option><option value="after">After engine (50% volume)</option></select></label>
        <button disabled={!pipeline || busy || testing || exporting || active} onClick={() => void test()}>{testing ? 'Listening… speak for 8 seconds' : 'Test microphone — before / after'}</button>{testing && <button onClick={() => testAbort.current?.abort()}>Cancel test</button>}
        {comparison && <div className="comparison"><label>Before<audio controls src={comparison.before} /></label><label>After<audio controls src={comparison.after} /></label><p className="hint">{comparison.description}</p></div>}
      </section></div>
    </div>
    <footer><span>No cloud APIs. No audio telemetry. Audio stays on this device.</span><span>{metrics ? `App CPU ${metrics.cpuPercent.toFixed(1)}% · memory ${metrics.memoryMB.toFixed(0)} MB` : 'Offline by design'}</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
