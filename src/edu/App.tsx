import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, ChevronRight, Circle, Download, HardDrive, Headphones, Mic, Monitor, Moon, Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Square, Sun, Trash2, Video, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Capture, type CameraOptions, type CaptureState, type MicOptions } from './capture';
import { deleteRecording, listRecordings, processedBlob, recordingBlob, saveProcessed, saveRecording, type LocalRecording } from './storage';
import { activeJob, api, upload, type Capabilities, type Job, type Mode } from './api';
import './styles.css';
const duration = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const initialMic: MicOptions = { deviceId: '', echoCancellation: false, noiseSuppression: false, autoGainControl: true };
const initialCamera: CameraOptions = { deviceId: '', enabled: false, visible: true, size: .22, x: .84, y: .78 };

export default function App() {
  const capture = useRef(new Capture()).current;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [mic, setMic] = useState(initialMic), [camera, setCamera] = useState(initialCamera);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [actual, setActual] = useState<MediaTrackSettings>();
  const [level, setLevel] = useState(0), [seconds, setSeconds] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('edu-theme') || 'dark');
  const [records, setRecords] = useState<LocalRecording[]>([]), [selected, setSelected] = useState<LocalRecording>();
  const [blob, setBlob] = useState<Blob>(), [original, setOriginal] = useState(''), [processedVideo, setProcessedVideo] = useState(''), [sample, setSample] = useState('');
  const [job, setJob] = useState<Job>(), [caps, setCaps] = useState<Capabilities>(), [serverOnline, setServerOnline] = useState(false);
  const [mode, setMode] = useState<Mode>('balanced'), [strength, setStrength] = useState(.5);
  const [uploadProgress, setUploadProgress] = useState<number>(), [uploading, setUploading] = useState(false);
  const [testing, setTesting] = useState(false), [loadingRecord, setLoadingRecord] = useState(false);
  const [comparison, setComparison] = useState<'original' | 'processed'>('original');
  const originalPlayer = useRef<HTMLVideoElement>(null), processedPlayer = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  const savedVersion = useRef<string>('');
  const active = state === 'recording' || state === 'paused';
  const busy = state !== 'idle';
  const processing = uploading || activeJob(job);
  const selectGeneration = useRef(0);
  const refreshRecords = useCallback(async () => setRecords((await listRecordings()).sort((a, b) => b.created - a.created)), []);
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) throw Error('Open EduRecorder on localhost in Chrome to access recording devices.');
    setDevices(await navigator.mediaDevices.enumerateDevices());
  }, []);
  const openRecord = useCallback(async (record: LocalRecording, emergency?: Blob) => {
    const generation = ++selectGeneration.current;
    setLoadingRecord(true);
    try {
      const stored = await recordingBlob(record);
      if (generation !== selectGeneration.current) return;
      const file = emergency ? new Blob([stored, emergency], { type: record.mime }) : stored;
      setSelected(record); setBlob(file); setJob(undefined); setComparison('original');
      const localProcessed = await processedBlob(record.id);
      if (generation !== selectGeneration.current) return;
      setProcessedVideo(localProcessed ? URL.createObjectURL(localProcessed) : '');
      savedVersion.current = '';
      if (record.serverId) {
        try { const status = await api<Job>(`recordings/${record.serverId}/status`); if (generation === selectGeneration.current) setJob(status); }
        catch (e) { if (generation === selectGeneration.current && !localProcessed) setNotice(`Local original loaded. ${message(e)}`); }
      }
    } catch (e) { setError(message(e)); }
    finally { if (generation === selectGeneration.current) setLoadingRecord(false); }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('edu-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!blob) { setOriginal(''); return; }
    const url = URL.createObjectURL(blob); setOriginal(url); return () => URL.revokeObjectURL(url);
  }, [blob]);
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample); }, [sample]);
  useEffect(() => () => { if (processedVideo) URL.revokeObjectURL(processedVideo); }, [processedVideo]);
  useEffect(() => {
    capture.onState = setState; capture.onMeter = setLevel; capture.onSettings = setActual; capture.onError = setError;
    capture.onSaved = (record, emergency) => { void refreshRecords(); void openRecord(record, emergency); setNotice('Original preserved in this browser. Download a copy, or process the audio locally.'); };
    void refreshRecords().catch(e => setError(`Browser storage unavailable: ${message(e)}`));
    void refreshDevices().catch(e => setError(message(e)));
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    const interval = setInterval(() => setSeconds(capture.seconds), 200);
    return () => { clearInterval(interval); navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); void capture.stop(); abort.current?.abort(); };
  }, [capture, openRecord, refreshDevices, refreshRecords]);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try { const value = await api<Capabilities>('capabilities'); if (alive) { setCaps(value); setServerOnline(true); } }
      catch { if (alive) setServerOnline(false); }
    };
    void check(); const interval = setInterval(check, 10000);
    return () => { alive = false; clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (!job) return;
    if (job.status === 'completed' && job.processed_file && selected?.serverId === job.id && savedVersion.current !== `${job.id}:${job.version}`) {
      const versionKey = `${job.id}:${job.version}`; savedVersion.current = versionKey;
      void fetch(`/api/recordings/${job.id}/download?v=${job.version}`).then(response => { if (!response.ok) throw Error('Could not download the processed MP4 from the local server.'); return response.blob(); }).then(async file => {
        await saveProcessed(selected.id, file);
        const localUrl = URL.createObjectURL(file);
        setProcessedVideo(previous => { if (previous) URL.revokeObjectURL(previous); return localUrl; });
        setSelected(previous => previous?.id === selected.id ? { ...previous, processedBytes: file.size, processedVersion: job.version } : previous);
        await refreshRecords(); setNotice('Processed MP4 saved in your browser library alongside the original.');
      }).catch(e => { savedVersion.current = ''; setError(`MP4 is ready on the local server, but could not be saved in browser storage: ${message(e)}`); });
    }
    if (!activeJob(job)) return;
    let alive = true, running = false;
    const id = job.id;
    const poll = async () => {
      if (running) return; running = true;
      try { const update = await api<Job>(`recordings/${id}/status`); if (alive) { setJob(update); setServerOnline(true); } }
      catch { if (alive) { setServerOnline(false); setNotice('Connection interrupted. Polling will resume; your original is retained.'); } }
      finally { running = false; }
    };
    const interval = setInterval(poll, 1000); void poll();
    return () => { alive = false; clearInterval(interval); };
  }, [job?.id, job?.status, job?.version, selected?.id, selected?.serverId, refreshRecords]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (busy || uploading) { event.preventDefault(); } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [busy, uploading]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden && active) setNotice('Keep EduRecorder visible while recording. Chrome may reduce the frame rate of a hidden canvas.');
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [active]);
  const start = async () => {
    setError(''); setNotice(''); setSeconds(0);
    try {
      if (!canvas.current) return;
      await capture.start(canvas.current, mic, camera, caps ? { seconds: caps.max_duration, bytes: Math.min(caps.max_bytes * .95, 1024 ** 3) } : undefined);
      void refreshDevices(); void navigator.storage?.persist?.();
    } catch (e) { setError(message(e)); }
  };
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!event.altKey || event.repeat || /INPUT|SELECT|TEXTAREA/.test((event.target as HTMLElement)?.tagName)) return;
      if (event.code === 'KeyP' && active) { event.preventDefault(); state === 'paused' ? capture.resume() : capture.pause(); }
      if (event.code === 'KeyS' && active) { event.preventDefault(); void capture.stop(); }
    };
    window.addEventListener('keydown', shortcuts); return () => window.removeEventListener('keydown', shortcuts);
  }, [active, state, capture]);
  const testMic = async () => {
    setError(''); setTesting(true);
    try { const audio = await capture.test(mic); setSample(URL.createObjectURL(audio)); void refreshDevices(); }
    catch (e) { setError(message(e)); } finally { setTesting(false); }
  };
  const process = async () => {
    if (!blob || !selected) return;
    setError(''); setNotice(''); setUploading(true); setUploadProgress(undefined);
    abort.current = new AbortController();
    try {
      let result: Job;
      if (job) result = await api<Job>(`recordings/${job.id}/reprocess`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, strength }) });
      else result = await upload(blob, mode, strength, setUploadProgress, abort.current.signal);
      setJob(result);
      const record = { ...selected, serverId: result.id };
      setSelected(record); await saveRecording(record); await refreshRecords();
    } catch (e) { setError(message(e)); } finally { setUploading(false); setUploadProgress(undefined); }
  };
  const cancel = async () => {
    if (uploading) abort.current?.abort();
    else if (job) try { await api(`recordings/${job.id}/cancel`, { method: 'POST' }); setNotice('Cancellation requested. Your original will be kept.'); } catch (e) { setError(message(e)); }
  };
  const remove = async () => {
    if (!selected || !confirm('Delete this original from browser storage and its server files? This cannot be undone.')) return;
    try {
      if (selected.serverId) await api(`recordings/${selected.serverId}`, { method: 'DELETE' });
      await deleteRecording(selected.id); setSelected(undefined); setBlob(undefined); setProcessedVideo(''); setJob(undefined); await refreshRecords();
    } catch (e) { setError(message(e)); }
  };
  const changeCamera = (value: Partial<CameraOptions>) => {
    const next = { ...camera, ...value }; setCamera(next); capture.camera = next;
  };
  const dragging = useRef(false);
  const moveCamera = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current || !camera.enabled || !active) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    changeCamera({ x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) });
  };
  const switchComparison = (next: 'original' | 'processed') => {
    const from = comparison === 'original' ? originalPlayer.current : processedPlayer.current;
    const to = next === 'original' ? originalPlayer.current : processedPlayer.current;
    if (from && to) { const playing = !from.paused; const time = from.currentTime; from.pause(); to.currentTime = time; if (playing) void to.play().catch(() => {}); }
    setComparison(next);
  };
  const supported = navigator.mediaDevices?.getSupportedConstraints() ?? {};
  const processed = processedVideo;
  const db = level > 0 ? Math.max(-60, 20 * Math.log10(level)) : -60;
  return <div className="app-shell">
    <header className="topbar"><a href="#" className="brand"><span className="brand-icon"><Video size={23}/></span>Edu<span>Recorder</span><span className="version">LOCAL STUDIO</span></a><div className="topbar-right"><span className="privacy"><ShieldCheck size={15}/> On your device. Under your control.</span><Button variant="ghost" size="icon" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19}/> : <Moon size={19}/>}</Button></div></header>
    <main className="workspace">
      <div className="page-heading"><div><p className="eyebrow">YOUR NEXT GREAT LESSON STARTS HERE</p><h1>Record. Refine. <span>Teach.</span></h1><p>Capture your knowledge. Make every word clear.</p></div><div className={`connection ${serverOnline && caps?.ready ? 'online' : ''}`}><span/>{serverOnline ? caps?.ready ? 'Local audio engine ready' : 'FFmpeg setup needed' : 'Recording ready · audio engine offline'}</div></div>
      {error && <div className="banner error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={18}/></button></div>}
      {notice && <div className="banner" role="status"><Check size={17}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={18}/></button></div>}
      <div className="studio-grid">
        <section className="capture-panel panel" aria-labelledby="capture-title"><div className="panel-header"><h2 id="capture-title"><Monitor size={18}/> Recording studio</h2><span className="tag">1080p <span>·</span> 30 FPS</span></div>
          <div className={`preview ${active ? 'is-live' : ''}`}>
            <canvas ref={canvas} className={active ? 'visible' : 'hidden-canvas'} aria-label="Recorded composition preview. Drag to position camera." tabIndex={active && camera.enabled ? 0 : -1}
              onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); moveCamera(e); }} onPointerMove={moveCamera} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
              onKeyDown={e => { const offsets: Record<string, number[]> = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02] }; if (active && camera.enabled && offsets[e.key]) { e.preventDefault(); const [x, y] = offsets[e.key]; changeCamera({ x: Math.max(0, Math.min(1, camera.x + x)), y: Math.max(0, Math.min(1, camera.y + y)) }); } }}/>
            {!active && <div className="preview-empty"><div className="preview-art"><Monitor size={48} strokeWidth={1.2}/><span><Mic size={19}/></span></div><h3>{state === 'starting' ? testing ? 'Let’s hear your microphone' : 'Getting your studio ready…' : state === 'saving' ? 'Preserving your recording…' : 'Your knowledge, center stage.'}</h3><p>{testing ? 'Speak for 5 seconds. Playback will appear in the device panel.' : 'Share your screen or an app window to begin.\nYour microphone will be recorded with it.'}</p><div className="preview-pills"><span><Monitor size={13}/> Screen</span><Plus size={12}/><span><Mic size={13}/> Microphone</span><span className="optional">Camera optional</span></div></div>}
            {active && <><span className="live-badge"><span/>{state === 'paused' ? 'PAUSED' : 'RECORDING'}</span><span className="preview-note">This composition is your recording</span></>}
          </div>
          <div className="recording-bar"><div className="timer"><span className={state === 'recording' ? 'red-dot' : 'timer-dot'}/><span>{duration(seconds)}</span><small>{state === 'paused' ? 'Paused' : active ? 'Recording' : 'Ready when you are'}</small></div><div className="recording-actions">{active ? <><Button variant="secondary" onClick={() => state === 'paused' ? capture.resume() : capture.pause()} title="Alt + P">{state === 'paused' ? <Play size={16}/> : <Pause size={16}/>} {state === 'paused' ? 'Resume' : 'Pause'}</Button><Button variant="destructive" onClick={() => void capture.stop()} title="Alt + S"><Square size={15} fill="currentColor"/> Stop recording</Button></> : <Button onClick={() => void start()} disabled={busy || processing || loadingRecord}><Circle size={15} fill="currentColor"/> {state === 'saving' ? 'Saving…' : 'Start recording'}</Button>}</div></div>
          <div className="studio-footer"><span><ShieldCheck size={14}/> Original saved automatically in this browser</span><span>Alt P · pause / resume &nbsp; Alt S · stop</span></div>
        </section>
        <aside className="device-panel panel" aria-labelledby="device-title"><div className="panel-header"><h2 id="device-title"><Settings2 size={18}/> Studio setup</h2><Button variant="ghost" size="icon" disabled={busy} onClick={() => void refreshDevices().catch(e => setError(message(e)))} aria-label="Refresh devices"><RefreshCw size={15}/></Button></div>
          <div className="device-content"><label className="field-label" htmlFor="microphone"><Mic size={15}/> Microphone</label><select id="microphone" value={mic.deviceId} disabled={busy} onChange={e => setMic({ ...mic, deviceId: e.target.value })}><option value="">System default microphone</option>{devices.filter(d => d.kind === 'audioinput' && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select>
            <div className="meter-heading"><span>INPUT LEVEL</span><span>{level ? `${db.toFixed(0)} dBFS` : 'No input'}</span></div><div className="meter" role="meter" aria-label="Microphone input level" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(db)}>{Array.from({ length: 28 }, (_, i) => <i key={i} className={i / 28 < (db + 60) / 60 ? i > 24 ? 'hot' : 'lit' : ''}/>)}</div><p className="field-hint">{level > .7 ? 'Input is loud. Lower your headset microphone gain.' : 'Select your headset, then test your voice.'}</p>
            <div className="mic-options">{([['echoCancellation', 'Echo cancellation'], ['noiseSuppression', 'Browser noise suppression'], ['autoGainControl', 'Automatic gain control']] as const).map(([key, label]) => <label className="toggle-row" key={key}><span>{label}{!supported[key] && <small>Not supported by this browser</small>}</span><input type="checkbox" role="switch" checked={mic[key]} disabled={busy || !supported[key]} onChange={e => setMic({ ...mic, [key]: e.target.checked })}/></label>)}</div>
            {mic.noiseSuppression && <p className="inline-warning">Browser suppression changes the original. Keep Python strength low to avoid processing twice.</p>}
            <Button variant="secondary" className="w-full" disabled={busy && !testing} onClick={() => testing ? void capture.stop() : void testMic()}><Headphones size={16}/>{testing ? 'Finish microphone test' : 'Test microphone · 5 sec'}</Button>
            {sample && <audio className="sample-player" src={sample} controls aria-label="Microphone test playback"/>}
            {actual && <details className="actual-settings"><summary>Actual device settings</summary><dl>{(['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'] as const).map(key => <div key={key}><dt>{key}</dt><dd>{actual[key] === undefined ? 'Not reported' : String(actual[key])}</dd></div>)}</dl></details>}
            <div className="section-divider"/>
            <label className="toggle-row camera-toggle"><span><Camera size={16}/> Camera overlay</span><input type="checkbox" role="switch" checked={camera.enabled} disabled={busy} onChange={e => changeCamera({ enabled: e.target.checked, visible: true })}/></label><p className="field-hint">A personal touch for your lesson.</p>
            {camera.enabled && <div className="camera-options"><label htmlFor="camera">Camera device</label><select id="camera" disabled={busy} value={camera.deviceId} onChange={e => changeCamera({ deviceId: e.target.value })}><option value="">System default camera</option>{devices.filter(d => d.kind === 'videoinput' && d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}</select><label className="toggle-row"><span>Show camera in recording</span><input type="checkbox" role="switch" checked={camera.visible} onChange={e => changeCamera({ visible: e.target.checked })}/></label><label htmlFor="camera-size">Camera size <span>{Math.round(camera.size * 100)}%</span></label><input id="camera-size" type="range" min=".12" max=".4" step=".01" value={camera.size} onChange={e => changeCamera({ size: +e.target.value })}/><p className="field-hint">Drag in the preview to move. Or focus the preview and use arrow keys.</p></div>}
          </div><div className="setup-note"><HardDrive size={16}/><span>Local by design.<br/><small>No accounts. No cloud uploads.</small></span></div>
        </aside>
        <section className="review-panel panel" aria-labelledby="review-title"><div className="panel-header"><h2 id="review-title"><Sparkles size={18}/> Refine your recording</h2><span className="tag">{selected ? 'ORIGINAL PROTECTED' : 'AFTER RECORDING'}</span></div>
          {!selected ? <div className="review-empty"><span className="step-number">02</span><div><h3>A clearer voice. The same great lesson.</h3><p>After recording, remove background noise locally and export a clean MP4.</p></div><ChevronRight size={22}/></div> : <div className="review-content"><div className="record-title"><div><h3>{selected.name}</h3><p>{duration(selected.duration)} · {size(blob?.size ?? selected.bytes)} · {selected.complete ? 'Original preserved' : 'Recovered interrupted recording · may be incomplete'}</p></div><Button variant="ghost" size="icon" aria-label="Delete recording" disabled={processing || busy} onClick={() => void remove()}><Trash2 size={17}/></Button></div>
            <div className="review-layout"><div className="comparison-area"><div className="segmented" role="group" aria-label="Before and after comparison"><button aria-pressed={comparison === 'original'} onClick={() => switchComparison('original')}>Before · Original</button><button disabled={!processed} aria-pressed={comparison === 'processed'} onClick={() => switchComparison('processed')}>After · Processed</button></div><video ref={originalPlayer} className={comparison === 'original' ? '' : 'hidden'} src={original} controls playsInline preload="metadata" aria-label="Original recording"/>{processed && <video ref={processedPlayer} className={comparison === 'processed' ? '' : 'hidden'} src={processed} controls playsInline preload="metadata" aria-label="Processed recording"/>}<p className="field-hint">Switch before / after at the same playback position. Use headphones to compare.</p><div className="downloads"><Button asChild variant="secondary" size="sm"><a href={original} download={`edu-original-${selected.id.slice(0, 8)}.${selected.mime.includes('mp4') ? 'mp4' : 'webm'}`}><Download size={15}/> Original</a></Button>{processed && <Button asChild size="sm"><a href={processed} download={`edu-clean-${job?.id.slice(0, 8)}.mp4`}><Download size={15}/> Clean MP4</a></Button>}</div></div>
              <div className="processing-controls"><label htmlFor="mode" className="field-label">Audio cleanup</label><select id="mode" disabled={processing} value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="off">Off · MP4 conversion only</option><option value="fast">Fast · steady background noise</option><option value="balanced">Balanced · changing background noise</option><option value="ai" disabled={!caps?.ai_available}>AI Speech {caps?.ai_available ? '· DeepFilterNet' : '· not installed'}</option></select><p className="field-hint">{mode === 'off' ? 'No noise removal or volume normalization. Audio is encoded to AAC for MP4.' : 'Noise removal with gentle speech leveling, up to +12 dB. Always starts from your original.'}</p><label className="range-label" htmlFor="strength">Noise reduction <span>{Math.round(strength * 100)}%</span></label><input id="strength" type="range" min="0" max="1" step=".05" value={strength} disabled={mode === 'off' || processing} onChange={e => setStrength(+e.target.value)}/><div className="range-ends"><span>Natural</span><span>Stronger</span></div>{!caps?.ai_available && <details className="actual-settings"><summary>About optional AI Speech</summary><p>{caps?.ai_message || 'Start the local backend to check model availability.'}</p></details>}
                {processing ? <div className="job-progress" role="status"><div><span>{uploading ? uploadProgress === undefined ? 'Starting local job…' : 'Sending to local Python…' : job?.stage}</span><strong>{(uploading ? uploadProgress : job?.progress) != null ? `${Math.round((uploading ? uploadProgress : job?.progress)!) }%` : ''}</strong></div><progress max="100" value={(uploading ? uploadProgress : job?.progress) ?? undefined}/><Button variant="ghost" size="sm" onClick={() => void cancel()}>Cancel processing</Button></div> : <Button className="w-full" disabled={!serverOnline || !caps?.ready || busy || loadingRecord} onClick={() => void process()}><Sparkles size={16}/>{job ? 'Process again from original' : mode === 'off' ? 'Create MP4' : 'Clean audio & create MP4'}</Button>}
                {!serverOnline && <p className="inline-warning">Start the local Python backend to enable processing. You can download the original now.</p>}{serverOnline && !caps?.ready && <p className="inline-warning">Install FFmpeg and FFprobe, then restart the backend.</p>}{job?.error && <p role="alert" className="inline-warning">{job.error}</p>}{job?.status === 'completed' && <p className="success-line"><Check size={15}/> MP4 ready · {job.audio?.gain_db ?? 0} dB volume adjustment</p>}
              </div></div></div>}
        </section>
      </div>
      {records.length > 0 && <section className="library" aria-labelledby="library-title"><div><h2 id="library-title"><HardDrive size={17}/> Your local recordings</h2><p>Browser originals stay until you delete them or clear site data. Server copies expire after {caps?.retention_days === 0 ? 'explicit deletion only' : `${caps?.retention_days ?? 7} days of inactivity`}.</p></div><div className="record-list">{records.map(record => <button key={record.id} className={selected?.id === record.id ? 'selected' : ''} disabled={busy || processing || loadingRecord} onClick={() => void openRecord(record)}><span className="record-icon"><Video size={19}/></span><span><strong>{record.name}</strong><small>{duration(record.duration)} · {size(record.bytes)}{record.processedBytes ? ` · MP4 ${size(record.processedBytes)}` : ''}{!record.complete ? ' · Recover original' : ''}</small></span><ChevronRight size={17}/></button>)}</div></section>}
      <footer className="page-footer"><span><ShieldCheck size={14}/> Made for educators. Built to stay local.</span><span>Screen + microphone only · system audio excluded</span></footer>
    </main>
  </div>;
}
