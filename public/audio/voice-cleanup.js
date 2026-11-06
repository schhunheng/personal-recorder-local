// Voice cleanup complements a denoiser: rumble filtering plus a soft expander
// reduces noise between phrases. It does not separate noise from active speech.
export class VoiceCleanup {
  constructor(rate) {
    this.rate = rate;
    this.alpha = Math.exp(-2 * Math.PI * 80 / rate);
    this.attack = Math.exp(-1 / (0.003 * rate));
    this.release = Math.exp(-1 / (0.12 * rate));
    this.enabled = false; this.threshold = 10 ** (-45 / 20);
    this.previousInput = this.previousOutput = 0;
    this.gain = 1; this.hold = 0;
  }
  configure(enabled, thresholdDb) {
    this.enabled = Boolean(enabled);
    this.threshold = 10 ** (Math.max(-60, Math.min(-25, Number.isFinite(thresholdDb) ? thresholdDb : -45)) / 20);
    this.previousInput = this.previousOutput = 0;
    this.gain = 1; this.hold = 0;
  }
  process(input, output) {
    if (!this.enabled) {
      for (let i = 0; i < output.length; i++) output[i] = input?.[i] ?? 0;
      return;
    }
    let squares = 0;
    for (let i = 0; i < output.length; i++) {
      const x = Number.isFinite(input?.[i]) ? input[i] : 0;
      const y = this.alpha * (this.previousOutput + x - this.previousInput);
      this.previousInput = x; this.previousOutput = y;
      output[i] = y; squares += y * y;
    }
    const rms = Math.sqrt(squares / Math.max(1, output.length));
    if (rms >= this.threshold) this.hold = this.rate * 0.15;
    else this.hold = Math.max(0, this.hold - output.length);
    const target = this.hold > 0 ? 1 : Math.max(0.03, Math.min(1, (rms / this.threshold) ** 2));
    const smoothing = target > this.gain ? this.attack : this.release;
    for (let i = 0; i < output.length; i++) {
      this.gain = target + smoothing * (this.gain - target);
      output[i] *= this.gain;
    }
  }
}
