export type RecordingFormat = 'webm' | 'mp4';
export function recordingMimeType(format: RecordingFormat) {
  const types = format === 'mp4'
    ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
    : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus'];
  return types.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
}
export const recordingQualities = {
  sharp: { label: 'Maximum detail · up to 4K / 30 fps', width: 3840, height: 2160, bitrate: 24_000_000 },
  high: { label: 'High · 1080p / 30 fps', width: 1920, height: 1080, bitrate: 12_000_000 },
  compact: { label: 'Compact · 1080p / 30 fps', width: 1920, height: 1080, bitrate: 5_000_000 },
} as const;
export type RecordingQuality = keyof typeof recordingQualities;
export type RecorderState = 'idle' | 'recording' | 'paused' | 'saving';
export class ScreenRecorder {
  private recorder?: MediaRecorder;
  private screen?: MediaStream;
  private camera?: MediaStream;
  private composite?: MediaStream;
  private timer?: ReturnType<typeof setInterval>;
  private videos: HTMLVideoElement[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private chunks: Blob[] = [];
  private browserBytes = 0;
  private format: RecordingFormat = 'webm';
  private failure?: Error;
  private saving?: Promise<string>;
  private complete?: () => void;
  private session?: { id: string; path: string };
  get isActive() { return Boolean(this.recorder); }
  onSaved: (path: string) => void = () => {};
  onDownload: (blob: Blob, filename: string) => void = () => {};
  onState: (state: RecorderState) => void = () => {};
  onError: (error: Error) => void = () => {};
  onPreview: (stream?: MediaStream) => void = () => {};
  private async video(stream: MediaStream) {
    const video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    this.videos.push(video);
    await video.play();
    return video;
  }
  async start(audio: MediaStream, options: { sourceId: string; webcam: boolean; quality?: RecordingQuality; format?: RecordingFormat }) {
    if (this.recorder) throw Error('A recording is already active.');
    if (!navigator.mediaDevices?.getDisplayMedia) throw Error('Screen capture is unavailable. Open this app on localhost or HTTPS in a browser that supports screen sharing.');
    const format = options.format ?? 'webm';
    this.format = format;
    const mimeType = recordingMimeType(format);
    if (!mimeType) throw Error(`${format.toUpperCase()} recording is not supported here. Record WebM and use the export options after stopping.`);
    const quality = recordingQualities[options.quality ?? 'sharp'];
    this.failure = undefined; this.saving = undefined; this.writeQueue = Promise.resolve(); this.pendingBytes = 0; this.chunks = []; this.browserBytes = 0;
    try {
      // Browser capture must be requested directly from the Start button gesture.
      if (window.desktop) await window.desktop.selectSource(options.sourceId);
      this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: quality.width }, height: { ideal: quality.height } }, audio: false });
      const screenVideo = await this.video(this.screen);
      let cameraVideo: HTMLVideoElement | undefined;
      if (options.webcam) {
        this.camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 480 } }, audio: false });
        cameraVideo = await this.video(this.camera);
      }
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, quality.width / screenVideo.videoWidth, quality.height / screenVideo.videoHeight);
      canvas.width = Math.max(2, Math.floor(screenVideo.videoWidth * scale / 2) * 2);
      canvas.height = Math.max(2, Math.floor(screenVideo.videoHeight * scale / 2) * 2);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const draw = () => {
        ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
        if (cameraVideo && cameraVideo.readyState >= 2) {
          const diameter = Math.min(canvas.width, canvas.height) * 0.23;
          const x = 24, y = canvas.height - diameter - 24;
          ctx.save(); ctx.beginPath(); ctx.arc(x + diameter / 2, y + diameter / 2, diameter / 2, 0, Math.PI * 2); ctx.clip();
          const side = Math.min(cameraVideo.videoWidth, cameraVideo.videoHeight);
          ctx.translate(x + diameter, y); ctx.scale(-1, 1);
          ctx.drawImage(cameraVideo, (cameraVideo.videoWidth - side) / 2, (cameraVideo.videoHeight - side) / 2, side, side, 0, 0, diameter, diameter);
          ctx.restore();
        }
      };
      draw(); this.timer = setInterval(draw, 1000 / 30);
      this.composite = canvas.captureStream(30);
      this.composite.getVideoTracks()[0].contentHint = 'detail';
      const mixed = new MediaStream([...this.composite.getVideoTracks(), ...audio.getAudioTracks()]);
      // The only audio track in this recorder is the processed destination track.
      const recorder = new MediaRecorder(mixed, { mimeType, videoBitsPerSecond: quality.bitrate, audioBitsPerSecond: 192_000 });
      if (window.desktop) {
        this.session = await window.desktop.beginRecording(format) ?? undefined;
        if (!this.session) { this.cleanup(); return false; }
      }
      this.recorder = recorder;
      recorder.ondataavailable = event => {
        if (!event.data.size || this.failure) return;
        if (!this.session) {
          this.chunks.push(event.data); this.browserBytes += event.data.size;
          if (this.browserBytes >= 256 * 1024 * 1024 && recorder.state !== 'inactive') {
            this.onError(Error('Browser recording reached its 256 MB limit and was stopped. Download the recording below; use the desktop app for longer sessions.'));
            void this.stop().catch(this.onError);
          }
          return;
        }
        this.pendingBytes += event.data.size;
        if (this.pendingBytes > 32 * 1024 * 1024) { this.fail(Error('Disk cannot keep up. Recording stopped; partial file retained.')); return; }
        this.writeQueue = this.writeQueue.then(async () => {
          const data = await event.data.arrayBuffer();
          await window.desktop!.appendRecording(this.session!.id, data);
        }).catch(error => this.fail(error instanceof Error ? error : Error(String(error))))
          .finally(() => { this.pendingBytes -= event.data.size; });
      };
      recorder.onerror = () => this.fail(Error(this.session ? 'Recording encoder failed. Partial file retained.' : 'Recording encoder failed. Please try again.'));
      recorder.onstop = () => { this.complete?.(); if (!this.saving) void this.stop().catch(this.onError); };
      this.screen.getVideoTracks()[0].onended = () => { void this.stop().catch(this.onError); };
      recorder.start(1000);
      this.onState('recording'); this.onPreview(this.composite);
      return true;
    } catch (error) {
      if (this.session) await window.desktop!.finishRecording(this.session.id).catch(() => {});
      this.cleanup(); throw error;
    }
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error; this.onError(error);
    void this.stop().catch(() => {});
  }
  pause() { if (this.recorder?.state === 'recording') { this.recorder.pause(); this.onState('paused'); } }
  resume() { if (this.recorder?.state === 'paused') { this.recorder.resume(); this.onState('recording'); } }
  stop(): Promise<string> {
    if (this.saving) return this.saving;
    if (!this.recorder) return Promise.resolve('');
    const recorder = this.recorder;
    this.onState('saving');
    this.saving = (async () => {
      if (recorder.state !== 'inactive') await new Promise<void>(resolve => { this.complete = resolve; recorder.stop(); });
      await this.writeQueue;
      if (this.session) {
        const path = await window.desktop!.finishRecording(this.session.id, Boolean(this.failure));
        if (this.failure) throw this.failure;
        this.onSaved(path);
        return path;
      }
      if (this.failure) throw this.failure;
      const filename = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${this.format}`;
      this.onDownload(new Blob(this.chunks, { type: recorder.mimeType || (this.format === 'mp4' ? 'video/mp4' : 'video/webm') }), filename);
      return filename;
    })().finally(() => { this.cleanup(); this.onState('idle'); });
    return this.saving;
  }
  private cleanup() {
    clearInterval(this.timer);
    this.screen?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.camera?.getTracks().forEach(track => track.stop());
    this.composite?.getTracks().forEach(track => track.stop());
    this.videos.forEach(video => { video.pause(); video.srcObject = null; });
    this.chunks = []; this.browserBytes = 0;
    this.videos = []; this.screen = this.camera = this.composite = undefined;
    this.recorder = undefined; this.session = undefined; this.complete = undefined;
    this.onPreview(undefined);
  }
}
