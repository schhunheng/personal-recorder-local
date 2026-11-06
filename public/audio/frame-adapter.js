/** Fixed storage, no per-quantum allocation. At 48 kHz a frame is 10 ms.
 * Reads output before feeding input: exactly one frame of buffering for any quantum size.
 * RNNoise itself adds one frame of model lookahead (20 ms total algorithmic delay).
 */
export class FrameAdapter {
  constructor(processFrame, frameSize = 480) {
    this.frame = new Float32Array(frameSize);
    this.output = new Float32Array(frameSize);
    this.position = 0;
    this.processFrame = processFrame;
  }
  process(input, output) {
    for (let i = 0; i < output.length; i++) {
      output[i] = this.output[this.position];
      this.frame[this.position++] = input?.[i] ?? 0;
      if (this.position === this.frame.length) {
        this.processFrame(this.frame);
        this.output.set(this.frame);
        this.position = 0;
      }
    }
  }
}
