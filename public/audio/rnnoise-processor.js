import createRNNWasmModuleSync from './rnnoise-sync.js';
import { FrameAdapter } from './frame-adapter.js';

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.failed = false;
    this.destroyed = false;
    this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'destroy') {
        this.destroyed = true;
        this.release();
      }
    };
    // Sync Emscripten module initializes on this worklet, never on the UI/main thread.
    try {
      if (sampleRate !== 48000) throw Error('RNNoise requires a 48 kHz graph');
      this.module = createRNNWasmModuleSync();
      for (const name of ['_rnnoise_create', '_rnnoise_process_frame', '_rnnoise_destroy', '_malloc', '_free']) {
        if (typeof this.module[name] !== 'function') throw Error(`Missing RNNoise export: ${name}`);
      }
      this.state = this.module._rnnoise_create(0);
      this.ptr = this.module._malloc(480 * 4);
      if (!this.state || !this.ptr) throw Error('RNNoise allocation failed');
      this.adapter = new FrameAdapter(frame => {
        const heap = this.module.HEAPF32;
        const offset = this.ptr >>> 2;
        for (let i = 0; i < 480; i++) heap[offset + i] = frame[i] * 32768;
        this.module._rnnoise_process_frame(this.state, this.ptr, this.ptr);
        for (let i = 0; i < 480; i++) {
          const value = this.module.HEAPF32[offset + i] / 32768;
          if (!Number.isFinite(value)) throw Error('Non-finite RNNoise output');
          frame[i] = value;
        }
      });
      // Exercise a real frame before acknowledging readiness (not merely WASM download).
      this.adapter.process(new Float32Array(480), new Float32Array(480));
      this.port.postMessage({ type: 'ready', algorithmicDelayMs: 20 });
    } catch (error) { this.fail(error); }
  }
  release() {
    if (this.state) this.module._rnnoise_destroy(this.state);
    if (this.ptr) this.module._free(this.ptr);
    this.state = this.ptr = 0;
  }
  fail(error) {
    this.failed = true;
    this.release();
    this.port.postMessage({ type: 'error', message: String(error) });
  }
  process(inputs, outputs) {
    if (this.destroyed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (this.failed) { output.fill(0); return true; }
    try {
      this.adapter.process(inputs[0]?.[0], output);
      // Heartbeat catches a stopped worklet independently of speech/silence.
      this.frames += output.length;
      if (this.frames >= 48000) {
        this.frames -= 48000;
        this.port.postMessage({ type: 'heartbeat' });
      }
    } catch (error) { output.fill(0); this.fail(error); }
    return true;
  }
}
registerProcessor('offline-rnnoise', RNNoiseProcessor);
