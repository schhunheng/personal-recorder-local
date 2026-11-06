import { VoiceCleanup } from './voice-cleanup.js';
class SafetyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.cleanup = new VoiceCleanup(sampleRate);
    this.port.onmessage = ({data}) => {
      if ('muted' in data) this.muted = Boolean(data.muted);
      if ('voiceCleanup' in data) this.cleanup.configure(data.voiceCleanup, data.gateThresholdDb);
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) this.cleanup.process(input, output);
    if (output) for (let i = 0; i < output.length; i++) {
      const x = output[i];
      output[i] = this.muted || !Number.isFinite(x) ? 0 : Math.max(-0.99, Math.min(0.99, x));
    }
    return true;
  }
}
registerProcessor('offline-safety', SafetyProcessor);
