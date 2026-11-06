// A conservative envelope gate for quiet background noise. This is not speech separation.
class StudioCleanup extends AudioWorkletProcessor {
  constructor() { super(); this.strength = .5; this.envelope = 0; this.gain = 1; this.port.onmessage = ({data}) => { this.strength = data.strength; }; }
  process(inputs, outputs) {
    const source = inputs[0], out = outputs[0];
    for (let i = 0; i < (out[0]?.length || 0); i++) {
      let peak = 0; for (const c of source) peak = Math.max(peak, Math.abs(c[i] || 0));
      this.envelope = Math.max(peak, this.envelope * .9995);
      const threshold = .003 + this.strength * .012;
      const target = this.envelope < threshold ? 1 - this.strength * .85 : 1;
      this.gain += (target - this.gain) * (target > this.gain ? .03 : .0008);
      out.forEach((c, ch) => { c[i] = (source[ch]?.[i] || source[0]?.[i] || 0) * this.gain; });
    }
    return true;
  }
}
registerProcessor('studio-cleanup', StudioCleanup);
