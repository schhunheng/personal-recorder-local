import { constraints, effectiveMode, type AudioSettings, type Mode } from './settings';

import { audioAsset as asset, createEngineRegistry } from './engines';
export interface PipelineStatus {
  requested: Mode;
  active: Mode | 'disconnected';
  message: string;
  sampleRate: number;
  baseLatencyMs: number;
  algorithmicDelayMs: number;
  capture: MediaTrackSettings;
}
interface CaptureGraph {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  output: AudioNode;
  ai?: AudioWorkletNode;
  heartbeat?: ReturnType<typeof setInterval>;
}
export class AudioPipeline {
  readonly context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  readonly inputMeter = this.context.createAnalyser();
  readonly outputMeter = this.context.createAnalyser();
  readonly before = this.context.createMediaStreamDestination();
  readonly processed = this.context.createMediaStreamDestination();
  private readonly bus = this.context.createGain();
  private readonly monitor = this.context.createGain();
  private safety!: AudioWorkletNode;
  private graph?: CaptureGraph;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private muted = false;
  private generation = 0;
  readonly engines = createEngineRegistry();
  private settings?: AudioSettings;
  private appliedSettings?: AudioSettings;
  status!: PipelineStatus;
  onStatus: (status: PipelineStatus) => void = () => {};
  private constructor() {}

  static async create() {
    const pipeline = new AudioPipeline();
    try { await pipeline.initialize(); return pipeline; }
    catch (error) { await pipeline.close(); throw error; }
  }
  private async initialize() {
    if (this.context.sampleRate !== 48000) throw Error('48 kHz AudioContext is unavailable');
    this.inputMeter.fftSize = this.outputMeter.fftSize = 1024;
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.08;
    await this.context.audioWorklet.addModule(asset('safety-processor.js'));
    this.safety = new AudioWorkletNode(this.context, 'offline-safety', { outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    this.bus.connect(limiter).connect(this.safety).connect(this.outputMeter).connect(this.processed);
    this.monitor.gain.value = 0;
    this.outputMeter.connect(this.monitor).connect(this.context.destination);
    await this.context.resume();
    navigator.mediaDevices.addEventListener('devicechange', this.deviceChange);
  }
  get stream() { return this.processed.stream; }
  async configure(settings: AudioSettings) {
    // Serialize getUserMedia and graph mutations. A failed request does not poison the queue.
    const previous = this.appliedSettings;
    // Cleanup-only changes must not reopen the microphone or interrupt speech.
    if (this.graph && previous && this.settings && this.generation > 0 &&
      ['deviceId', 'enabled', 'mode', 'echoCancellation', 'autoGainControl'].every(key =>
        previous[key as keyof AudioSettings] === settings[key as keyof AudioSettings] &&
        this.settings![key as keyof AudioSettings] === settings[key as keyof AudioSettings])) {
      this.settings = this.appliedSettings = { ...settings };
      this.safety.port.postMessage({ voiceCleanup: effectiveMode(settings) !== 'off' && (settings.voiceCleanup ?? true), gateThresholdDb: settings.gateThresholdDb ?? -45 });
      return;
    }
    this.settings = { ...settings };
    const generation = ++this.generation;
    const job = this.queue.then(() => this.configureNow(settings, generation));
    this.queue = job.catch(() => {});
    return job;
  }
  private publish(requested: Mode, active: PipelineStatus['active'], message: string, capture: MediaTrackSettings = {}) {
    this.status = { requested, active, message, sampleRate: this.context.sampleRate,
      baseLatencyMs: this.context.baseLatency * 1000, algorithmicDelayMs: active === 'disconnected' ? 0 : this.engines.get(active).algorithmicDelayMs, capture };
    this.onStatus(this.status);
  }
  private async configureNow(settings: AudioSettings, generation: number) {
    if (this.closed || generation !== this.generation) return;
    const requested = effectiveMode(settings);
    let mode = requested;
    let message = '';
    let candidate: CaptureGraph | undefined;
    try {
      try { candidate = await this.capture(settings, mode); }
      catch (error) {
        if (mode !== 'ai') throw error;
        mode = 'standard';
        message = `AI unavailable; using Standard. ${error instanceof Error ? error.message : String(error)}`;
        candidate = await this.capture(settings, mode);
      }
      if (this.closed || generation !== this.generation) { this.disposeGraph(candidate); return; }
      const old = this.graph;
      // The MediaStreamDestination and its track never change, including during a recording.
      old?.source.disconnect();
      old?.output.disconnect();
      this.graph = candidate;
      candidate.source.connect(this.inputMeter);
      candidate.source.connect(this.before);
      candidate.output.connect(this.bus);
      this.disposeGraph(old);
      const track = candidate.stream.getAudioTracks()[0];
      track.enabled = !this.muted;
      track.onended = () => this.recover('Microphone disconnected.');
      track.onmute = () => this.publish(requested, mode, 'Microphone is temporarily unavailable or muted by the operating system.', track.getSettings());
      track.onunmute = () => this.publish(requested, mode, message, track.getSettings());
      const actual = track.getSettings();
      if (mode === 'standard' && actual.noiseSuppression !== true) {
        mode = 'off';
        message += ' Browser noise suppression was not confirmed; capture is bypassing suppression.';
      }
      this.appliedSettings = { ...settings };
      this.safety.port.postMessage({ voiceCleanup: requested !== 'off' && (settings.voiceCleanup ?? true), gateThresholdDb: settings.gateThresholdDb ?? -45 });
      this.publish(requested, mode, message, actual);
      if (candidate.ai) this.watchAI(candidate, generation);
    } catch (error) {
      this.disposeGraph(candidate);
      if (!this.graph) this.publish(requested, 'disconnected', `No microphone: ${String(error)}`);
      throw error;
    }
  }
  private async capture(settings: AudioSettings, mode: Mode): Promise<CaptureGraph> {
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let ai: AudioWorkletNode | undefined;
    try {
      ai = await this.engines.get(mode).createNode(this.context);
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(settings, mode), video: false });
      source = this.context.createMediaStreamSource(stream);
      if (mode === 'ai') {
        if (stream.getAudioTracks()[0].getSettings().noiseSuppression !== false) {
          throw Error('Browser did not confirm noise suppression is disabled for RNNoise');
        }
        if (!ai) throw Error('AI engine did not provide an audio node');
      }
      if (ai) source.connect(ai);
      return { stream, source, output: ai ?? source, ai };
    } catch (error) {
      source?.disconnect(); ai?.port.postMessage('destroy'); ai?.disconnect(); ai?.port.close();
      stream?.getTracks().forEach(track => track.stop());
      throw error;
    }
  }
  private watchAI(graph: CaptureGraph, generation: number) {
    let last = performance.now();
    let failed = false;
    const fallback = () => {
      if (failed || this.graph !== graph || generation !== this.generation || !this.settings || this.closed) return;
      failed = true;
      clearInterval(graph.heartbeat);
      // Disconnect the failed branch immediately; preserve recording's silent output track.
      graph.output.disconnect();
      const original = { ...this.settings };
      const recovery = this.configure({ ...original, mode: 'standard' });
      const recoveryGeneration = this.generation;
      void recovery.then(() => {
        if (this.closed || recoveryGeneration !== this.generation) return;
        this.settings = original;
        this.publish('ai', this.status.active, 'RNNoise stopped; switched to browser suppression.', this.status.capture);
      }).catch(() => this.recover('AI failed and the microphone could not be reopened.'));
    };
    graph.ai!.port.onmessage = ({ data }) => { if (data.type === 'error') fallback(); else if (data.type === 'heartbeat') last = performance.now(); };
    graph.ai!.onprocessorerror = fallback;
    graph.heartbeat = setInterval(() => {
      if (this.context.state !== 'running') { last = performance.now(); return; }
      if (performance.now() - last > 5000) fallback();
    }, 1000);
  }
  private recover(message: string) {
    if (this.closed || !this.settings) return;
    this.disposeGraph(this.graph); this.graph = undefined;
    this.publish(effectiveMode(this.settings), 'disconnected', `${message} Recording continues with silence. Reconnecting to default input…`);
    const settings = { ...this.settings, deviceId: '' };
    void this.configure(settings).catch(() => this.publish(effectiveMode(settings), 'disconnected', 'No microphone available. Recording continues with silence; reconnect a microphone.'));
  }
  private deviceChange = () => {
    if (!this.graph || this.graph.stream.getAudioTracks()[0]?.readyState === 'ended') this.recover('Audio devices changed.');
  };
  setMuted(muted: boolean) {
    this.muted = muted;
    this.safety.port.postMessage({ muted });
    this.graph?.stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }
  setMonitoring(source: 'none' | 'before' | 'after') {
    this.monitor.disconnect();
    try { this.inputMeter.disconnect(this.monitor); } catch { /* not connected */ }
    try { this.outputMeter.disconnect(this.monitor); } catch { /* not connected */ }
    if (source !== 'none') (source === 'before' ? this.inputMeter : this.outputMeter).connect(this.monitor);
    this.monitor.gain.setTargetAtTime(source === 'none' ? 0 : 0.5, this.context.currentTime, 0.01);
    this.monitor.connect(this.context.destination);
  }
  private disposeGraph(graph?: CaptureGraph) {
    if (!graph) return;
    clearInterval(graph.heartbeat);
    graph.stream.getTracks().forEach(track => { track.onended = track.onmute = track.onunmute = null; track.stop(); });
    graph.source.disconnect(); graph.output.disconnect();
    if (graph.ai) { graph.ai.onprocessorerror = null; graph.ai.port.onmessage = null; graph.ai.port.postMessage('destroy'); graph.ai.port.close(); }
  }
  async close() {
    this.closed = true; this.generation++;
    navigator.mediaDevices.removeEventListener('devicechange', this.deviceChange);
    this.disposeGraph(this.graph); this.graph = undefined;
    this.before.stream.getTracks().forEach(track => track.stop());
    this.processed.stream.getTracks().forEach(track => track.stop());
    await this.context.close();
  }
}
