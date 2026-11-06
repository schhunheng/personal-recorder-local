import { appendChunk, saveRecording, type LocalRecording } from './storage';
export interface MicOptions { deviceId: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }
export interface CameraOptions { deviceId: string; enabled: boolean; visible: boolean; size: number; x: number; y: number }
export type CaptureState = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';
export function audioConstraints(options: MicOptions): MediaTrackConstraints {
  return { deviceId: options.deviceId ? { exact: options.deviceId } : undefined, echoCancellation: options.echoCancellation,
    noiseSuppression: options.noiseSuppression, autoGainControl: options.autoGainControl, channelCount: 1 };
}
export class Capture {
  state: CaptureState = 'idle';
  camera: CameraOptions = { deviceId: '', enabled: false, visible: true, size: 0.22, x: 0.84, y: 0.78 };
  onState: (state: CaptureState) => void = () => {};
  onMeter: (level: number) => void = () => {};
  onSettings: (settings: MediaTrackSettings) => void = () => {};
  onSaved: (record: LocalRecording, emergency?: Blob) => void = () => {};
  onError: (message: string) => void = () => {};
  private streams: MediaStream[] = [];
  private videos: HTMLVideoElement[] = [];
  private audio?: AudioContext;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private index = 0;
  private record?: LocalRecording;
  private started = 0;
  private elapsed = 0;
  private stopped?: Promise<void>;
  private resolveStop?: () => void;
  private fallback: Blob[] = [];
  private storageFailed = false;
  private encoderFailed = false;
  private cancelledStart = false;
  private micTestStop?: () => void;
  private limitSeconds = 7200;
  private limitBytes = 1024 * 1024 * 1024;
  get seconds() { return this.elapsed + (this.state === 'recording' ? (performance.now() - this.started) / 1000 : 0); }
  private setState(state: CaptureState) { this.state = state; this.onState(state); }
  private async video(stream: MediaStream) {
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
    this.videos.push(video); await video.play(); return video;
  }
  private async microphone(options: MicOptions) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(options), video: false });
    this.streams.push(stream);
    this.onSettings(stream.getAudioTracks()[0].getSettings());
    this.audio = new AudioContext(); await this.audio.resume();
    const source = this.audio.createMediaStreamSource(stream), analyser = this.audio.createAnalyser();
    analyser.fftSize = 1024; source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return { stream, meter: () => { analyser.getFloatTimeDomainData(buffer); this.onMeter(Math.sqrt(buffer.reduce((sum, sample) => sum + sample * sample, 0) / buffer.length)); } };
  }
  async test(options: MicOptions): Promise<Blob> {
    if (this.state !== 'idle') throw Error('Finish the current capture first.');
    this.setState('starting');
    this.stopped = undefined; this.cancelledStart = false;
    try {
      const { stream, meter } = await this.microphone(options);
      if (this.cancelledStart) throw Error('Microphone test cancelled.');
      this.timer = setInterval(meter, 80);
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => recorder.stop(), 5000);
        this.micTestStop = () => { clearTimeout(timeout); if (recorder.state !== 'inactive') recorder.stop(); };
        recorder.onstop = () => { clearTimeout(timeout); resolve(); };
        recorder.onerror = () => { clearTimeout(timeout); reject(Error('Microphone test failed.')); };
        recorder.start();
      });
      return new Blob(chunks, { type: recorder.mimeType });
    } finally { this.release(); this.setState('idle'); }
  }
  async start(canvas: HTMLCanvasElement, options: MicOptions, camera: CameraOptions, limits?: { seconds: number; bytes: number }) {
    if (this.state !== 'idle') return;
    this.setState('starting'); this.cancelledStart = false; this.stopped = undefined; this.elapsed = 0;
    this.fallback = []; this.storageFailed = false; this.encoderFailed = false; this.pending = this.index = 0; this.queue = Promise.resolve();
    this.limitSeconds = limits?.seconds ?? 7200; this.limitBytes = limits?.bytes ?? 1024 * 1024 * 1024;
    this.camera = { ...camera };
    try {
      // Keep this before any awaited storage or mic operations: Chrome requires a user gesture.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
      this.streams.push(display);
      display.getVideoTracks()[0].onended = () => { void this.stop(); };
      const screen = await this.video(display);
      const mic = await this.microphone(options);
      let webcam: HTMLVideoElement | undefined;
      if (camera.enabled) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: camera.deviceId ? { exact: camera.deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
        this.streams.push(stream); webcam = await this.video(stream);
        stream.getVideoTracks()[0].onended = () => { this.camera.visible = false; this.onError('Camera disconnected. Screen and microphone are still recording.'); };
      }
      if (this.cancelledStart || display.getVideoTracks()[0].readyState === 'ended') throw Error('Screen sharing ended before recording started.');
      canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext('2d', { alpha: false })!;
      const draw = () => {
        context.fillStyle = '#10151d'; context.fillRect(0, 0, 1920, 1080);
        const scale = Math.min(1920 / screen.videoWidth, 1080 / screen.videoHeight);
        const w = screen.videoWidth * scale, h = screen.videoHeight * scale;
        context.drawImage(screen, (1920 - w) / 2, (1080 - h) / 2, w, h);
        if (webcam && this.camera.visible && webcam.readyState >= 2) {
          const d = 1080 * this.camera.size, r = d / 2;
          const x = Math.max(r + 8, Math.min(1920 - r - 8, this.camera.x * 1920));
          const y = Math.max(r + 8, Math.min(1080 - r - 8, this.camera.y * 1080));
          context.save(); context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2); context.clip();
          const side = Math.min(webcam.videoWidth, webcam.videoHeight);
          context.translate(x + r, y - r); context.scale(-1, 1);
          context.drawImage(webcam, (webcam.videoWidth - side) / 2, (webcam.videoHeight - side) / 2, side, side, 0, 0, d, d); context.restore();
          context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2); context.strokeStyle = '#fff'; context.lineWidth = 5; context.stroke();
        }
        mic.meter();
        if (this.seconds >= this.limitSeconds && this.state === 'recording') { this.onError('Recording reached the duration limit and was saved.'); void this.stop(); }
      };
      draw(); this.timer = setInterval(draw, 1000 / 30);
      const composite = canvas.captureStream(30); this.streams.push(composite);
      composite.getVideoTracks()[0].contentHint = 'detail';
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw Error('No supported video encoder. Use Chrome desktop.');
      const recorder = new MediaRecorder(new MediaStream([...composite.getVideoTracks(), ...mic.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      this.record = { id: crypto.randomUUID(), name: `Lesson ${new Date().toLocaleString()}`, created: Date.now(), bytes: 0, duration: 0, mime, complete: false };
      await saveRecording(this.record);
      if (this.cancelledStart) throw Error('Recording cancelled.');
      this.recorder = recorder;
      recorder.ondataavailable = e => {
        if (!e.data.size || !this.record) return;
        const index = this.index++, id = this.record.id;
        this.record.bytes += e.data.size; this.pending += e.data.size;
        this.queue = this.queue.then(async () => {
          if (this.storageFailed) { this.fallback.push(e.data); return; }
          try { await appendChunk(id, index, e.data); }
          catch { this.storageFailed = true; this.fallback.push(e.data); this.onError('Browser storage is full. Recording stopped; download the recovered original now.'); void this.stop(); }
        }).finally(() => { this.pending -= e.data.size; });
        if (this.pending > 32 * 1024 * 1024 || this.record.bytes >= this.limitBytes) {
          this.onError('Recording reached the storage limit and was stopped. Your original is retained.'); void this.stop();
        }
      };
      recorder.onerror = () => { this.encoderFailed = true; this.onError('Video encoder failed. Retaining all captured chunks; the original may be incomplete.'); void this.stop(); };
      recorder.onstop = () => { this.resolveStop?.(); if (!this.stopped) void this.stop(); };
      mic.stream.getAudioTracks()[0].onended = () => { this.onError('Microphone disconnected. Recording stopped and preserved.'); void this.stop(); };
      recorder.start(1000); this.started = performance.now(); this.setState('recording');
    } catch (error) { this.release(); this.setState('idle'); throw error; }
  }
  pause() { if (this.recorder?.state === 'recording') { this.elapsed = this.seconds; this.recorder.pause(); this.setState('paused'); } }
  resume() { if (this.recorder?.state === 'paused') { this.recorder.resume(); this.started = performance.now(); this.setState('recording'); } }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    if (!this.recorder) { this.cancelledStart = true; this.micTestStop?.(); return Promise.resolve(); }
    const recorder = this.recorder; this.elapsed = this.seconds; this.setState('saving');
    this.stopped = (async () => {
      if (recorder.state !== 'inactive') await new Promise<void>(resolve => { this.resolveStop = resolve; recorder.stop(); });
      await this.queue;
      if (this.record) {
        const record = { ...this.record, duration: this.elapsed, complete: !this.encoderFailed };
        try { await saveRecording(record); } catch { this.onError('Could not save recording details. Download the original before closing.'); }
        this.onSaved(record, this.fallback.length ? new Blob(this.fallback, { type: record.mime }) : undefined);
      }
    })().catch(e => this.onError(String(e))).finally(() => { this.release(); this.setState('idle'); });
    return this.stopped;
  }
  private release() {
    clearInterval(this.timer); this.streams.forEach(s => s.getTracks().forEach(t => { t.onended = null; t.stop(); }));
    this.videos.forEach(v => { v.pause(); v.srcObject = null; }); this.videos = []; this.streams = [];
    void this.audio?.close(); this.audio = undefined; this.recorder = undefined; this.micTestStop = undefined; this.onMeter(0);
  }
}
