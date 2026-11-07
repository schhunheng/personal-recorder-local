import {
  defaultCamera,
  type Camera,
  defaultEdits,
  type Project,
  type RecordingOptions,
} from './model';
import {
  AssetWriter,
  saveProject,
  deleteProject,
  deleteAsset,
} from './storage';
import { recordingMime, mediaError } from './capabilities';
export type CaptureState =
  | 'idle'
  | 'preparing'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'saving';
export class StudioRecorder {
  state: CaptureState = 'idle';
  screen?: MediaStream;
  camera?: MediaStream;
  onState = (_s: CaptureState) => {};
  onLevel = (_n: number) => {};
  onCountdown = (_n: number) => {};
  onSaved = (_p: Project) => {};
  onError = (_e: string) => {};
  onReady = () => {};
  private streams: MediaStream[] = [];
  private audio?: AudioContext;
  private recorders: MediaRecorder[] = [];
  private writers: AssetWriter[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private elapsed = 0;
  private started = 0;
  private clockOrigin = 0;
  private cancelled = false;
  private starting = false;
  private cancelWait?: Promise<void>;
  private cancelResolve?: () => void;
  private metadata: Promise<unknown> = Promise.resolve();
  private stopping?: Promise<void>;
  private project?: Project;
  private overlay: Camera = { ...defaultCamera };
  private failed = false;
  get seconds() {
    return (
      this.elapsed +
      (this.state === 'recording'
        ? (performance.now() - this.started) / 1000
        : 0)
    );
  }
  private setState(s: CaptureState) {
    this.state = s;
    this.onState(s);
  }
  async start(options: RecordingOptions) {
    if (this.state !== 'idle') return;
    this.cancelled = false;
    this.starting = true;
    this.cancelWait = undefined;
    this.cancelResolve = undefined;
    this.stopping = undefined;
    this.elapsed = 0;
    this.failed = false;
    this.project = undefined;
    this.setState('preparing');
    try {
      // Must be the first awaited call: screen selection requires the click's transient activation.
      this.screen = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: options.source,
          height: { ideal: options.height },
          frameRate: { ideal: options.fps, max: options.fps },
        },
        audio: options.systemAudio,
      });
      this.streams.push(this.screen);
      this.checkCancelled();
      const displayTrack = this.screen.getVideoTracks()[0];
      displayTrack.contentHint = 'detail';
      displayTrack.onended = () => {
        void this.stop();
      };
      const settings = displayTrack.getSettings();
      const audioStreams: MediaStream[] = [];
      let microphone: MediaStream | undefined;
      if (this.screen.getAudioTracks().length)
        audioStreams.push(new MediaStream(this.screen.getAudioTracks()));
      else if (options.systemAudio)
        this.onError(
          'This source did not provide tab/system audio. Microphone recording can still continue.'
        );
      if (options.mic) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: options.micId ? { exact: options.micId } : undefined,
            noiseSuppression: options.noise,
            echoCancellation: options.echo,
            autoGainControl: options.gain,
          },
          video: false,
        });
        microphone = mic;
        this.streams.push(mic);
        this.checkCancelled();
        audioStreams.push(mic);
        mic.getAudioTracks()[0].onended = () => {
          this.onError(
            'Microphone disconnected. Stopping and preserving the recording.'
          );
          void this.stop();
        };
      }
      if (options.camera) {
        this.camera = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: options.cameraId
              ? { exact: options.cameraId }
              : undefined,
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: options.fps },
          },
          audio: false,
        });
        this.streams.push(this.camera);
        this.checkCancelled();
        this.camera.getVideoTracks()[0].onended = () => {
          this.onError(
            'Camera disconnected. Stopping to keep screen and camera synchronized.'
          );
          void this.stop();
        };
      }
      let audioTrack: MediaStreamTrack | undefined;
      let analyser: AnalyserNode | undefined;
      if (audioStreams.length) {
        this.audio = new AudioContext();
        await this.audio.resume();
        this.checkCancelled();
        const dest = this.audio.createMediaStreamDestination();
        analyser = this.audio.createAnalyser();
        analyser.fftSize = 1024;
        const bus = this.audio.createGain();
        bus.connect(dest);
        if (microphone)
          this.audio.createMediaStreamSource(microphone).connect(analyser);
        else bus.connect(analyser);
        audioStreams.forEach((s) =>
          this.audio!.createMediaStreamSource(s).connect(bus)
        );
        audioTrack = dest.stream.getAudioTracks()[0];
        this.streams.push(dest.stream);
      }
      const mime = recordingMime();
      const screenWriter = await new AssetWriter(mime).open();
      this.writers.push(screenWriter);
      const cameraWriter = this.camera
        ? await new AssetWriter(mime).open()
        : undefined;
      if (cameraWriter) this.writers.push(cameraWriter);
      const micMime = microphone
        ? ['audio/webm;codecs=opus', 'audio/mp4'].find((type) =>
            MediaRecorder.isTypeSupported(type)
          )
        : undefined;
      const micWriter =
        microphone && micMime
          ? await new AssetWriter(micMime).open()
          : undefined;
      if (micWriter) this.writers.push(micWriter);
      this.project = {
        id: crypto.randomUUID(),
        title: `Untitled lesson · ${new Date().toLocaleDateString()}`,
        created: Date.now(),
        duration: 0,
        width: settings.width || 1920,
        height: settings.height || options.height,
        complete: false,
        screen: screenWriter.asset,
        camera: cameraWriter?.asset,
        microphone: micWriter?.asset,
        markers: [],
        edits: { ...defaultEdits(0), camera: { ...this.overlay } },
      };
      await saveProject(this.project);
      this.checkCancelled();
      const makeRecorder = (stream: MediaStream, writer: AssetWriter) => {
        const recorder = new MediaRecorder(stream, {
          mimeType: writer.asset.mime,
          videoBitsPerSecond: options.height >= 1440 ? 14_000_000 : 8_000_000,
          audioBitsPerSecond: 192_000,
        });
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          void writer
            .append(event.data)
            .then(async () => {
              if (this.project) {
                this.project.duration = this.seconds;
                this.project.edits.trim.end = this.seconds;
                this.metadata = saveProject(this.project);
                await this.metadata;
              }
            })
            .catch(() => {
              this.failed = true;
              this.onError(
                'Browser storage failed. Recording stopped; saved chunks remain available for recovery.'
              );
              void this.stop();
            });
          if (writer.pending > 32 * 1024 ** 2) {
            this.failed = true;
            this.onError(
              'Disk writes fell behind. Recording stopped to protect the saved media.'
            );
            void this.stop();
          }
        };
        recorder.onerror = () => {
          this.failed = true;
          this.onError(
            'Encoder interrupted. Recover the saved original from your project.'
          );
          void this.stop();
        };
        recorder.onstop = () => {
          if (!this.stopping && !this.starting) void this.stop();
        };
        this.recorders.push(recorder);
      };
      makeRecorder(
        new MediaStream([
          ...this.screen.getVideoTracks(),
          ...(audioTrack ? [audioTrack] : []),
        ]),
        screenWriter
      );
      if (this.camera && cameraWriter) makeRecorder(this.camera, cameraWriter);
      if (microphone && micWriter) makeRecorder(microphone, micWriter);
      this.onReady();
      this.setState('countdown');
      for (let n = 3; n > 0; n--) {
        this.onCountdown(n);
        await new Promise((r) => setTimeout(r, 1000));
        this.checkCancelled();
      }
      this.checkCancelled();
      this.clockOrigin = performance.now();
      this.project.timing = {
        startedAt: Date.now(),
        trackOffsetsMs: {},
        pauses: [],
        sampleRate: this.audio?.sampleRate,
      };
      this.recorders.forEach((r, index) => {
        this.project!.timing!.trackOffsetsMs[this.writers[index].asset.id] =
          performance.now() - this.clockOrigin;
        r.start(1000);
      });
      this.starting = false;
      this.started = performance.now();
      this.setState('recording');
      const samples = new Float32Array(1024);
      this.timer = setInterval(() => {
        if (analyser) {
          analyser.getFloatTimeDomainData(samples);
          this.onLevel(
            Math.min(
              1,
              Math.sqrt(
                samples.reduce((s, x) => s + x * x, 0) / samples.length
              ) * 4
            )
          );
        }
      }, 80);
      void navigator.storage?.persist?.().catch(() => {});
    } catch (e) {
      if (!this.cancelled) this.onError(mediaError(e));
      this.starting = false;
      await this.stop();
      this.resolveCancellation();
    }
  }
  private resolveCancellation() {
    this.cancelResolve?.();
  }
  private checkCancelled() {
    if (
      this.cancelled ||
      this.screen?.getVideoTracks()[0].readyState === 'ended'
    )
      throw Error('Capture cancelled.');
  }
  setOverlay(camera: Camera) {
    this.overlay = { ...camera };
    if (this.project) this.project.edits.camera = { ...camera };
  }
  mark(
    kind: NonNullable<Project['markers']>[number]['kind'],
    x = 0.5,
    y = 0.5,
    label = ''
  ) {
    if (!this.project || !['recording', 'paused'].includes(this.state)) return;
    this.project.markers ||= [];
    this.project.markers.push({
      id: crypto.randomUUID(),
      time: this.seconds,
      kind,
      x,
      y,
      label,
    });
    this.metadata = this.metadata
      .catch(() => {})
      .then(() => saveProject(this.project!));
  }
  pause() {
    if (this.state !== 'recording') return;
    try {
      this.elapsed = this.seconds;
      this.project?.timing?.pauses.push({
        start: (performance.now() - this.clockOrigin) / 1000,
      });
      this.recorders.forEach((r) => r.pause());
      this.setState('paused');
    } catch {
      this.onError(
        'Pause is unavailable. Stopping to preserve synchronization.'
      );
      void this.stop();
    }
  }
  resume() {
    if (this.state !== 'paused') return;
    try {
      const pause = this.project?.timing?.pauses.at(-1);
      if (pause) pause.end = (performance.now() - this.clockOrigin) / 1000;
      this.recorders.forEach((r) => r.resume());
      this.started = performance.now();
      this.setState('recording');
    } catch {
      this.onError('Resume failed. Stopping to preserve the recording.');
      void this.stop();
    }
  }
  stop(): Promise<void> {
    this.cancelled = true;
    if (this.starting) {
      this.setState('saving');
      return (this.cancelWait ||= new Promise((resolve) => {
        this.cancelResolve = resolve;
      }));
    }
    if (this.stopping) return this.stopping;
    this.elapsed = this.seconds;
    const pause = this.project?.timing?.pauses.at(-1);
    if (pause && pause.end === undefined)
      pause.end = (performance.now() - this.clockOrigin) / 1000;
    this.setState('saving');
    this.stopping = (async () => {
      await Promise.all(
        this.recorders.map((r) =>
          r.state === 'inactive'
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                r.onstop = () => resolve();
                r.stop();
              })
        )
      );
      for (const writer of this.writers) {
        try {
          await writer.close();
        } catch {
          this.failed = true;
        }
      }
      await this.metadata.catch(() => {});
      if (this.project && this.elapsed > 0) {
        this.project.duration = this.elapsed;
        this.project.edits.trim.end = this.elapsed;
        this.project.complete = !this.failed;
        if (this.failed)
          this.project.warning =
            'Interrupted recording. Some saved media may be incomplete.';
        try {
          await saveProject(this.project);
          this.onSaved(this.project);
        } catch {
          this.onError(
            'Could not save project metadata. Free browser storage and retry.'
          );
        }
      } else if (this.project) {
        await deleteProject(this.project).catch(() => {});
      } else {
        for (const writer of this.writers)
          await deleteAsset(writer.asset).catch(() => {});
      }
    })().finally(() => {
      clearInterval(this.timer);
      this.streams.forEach((s) =>
        s.getTracks().forEach((t) => {
          t.onended = null;
          t.stop();
        })
      );
      this.streams = [];
      this.recorders = [];
      this.writers = [];
      void this.audio?.close();
      this.audio = undefined;
      this.screen = this.camera = undefined;
      this.onLevel(0);
      this.setState('idle');
    });
    return this.stopping;
  }
}
