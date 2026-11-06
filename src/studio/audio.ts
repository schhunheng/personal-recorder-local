import type { Edits } from './model';
export async function audioGraph(video: HTMLVideoElement) {
  const context = new AudioContext();
  await context.resume();
  try {
    const source = context.createMediaElementSource(video),
      highpass = context.createBiquadFilter(),
      compressor = context.createDynamicsCompressor(),
      gain = context.createGain(),
      bypass = context.createGain(),
      wet = context.createGain(),
      output = context.createGain();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    compressor.threshold.value = -22;
    compressor.knee.value = 16;
    compressor.ratio.value = 2.5;
    let gate: AudioWorkletNode | undefined;
    if (context.audioWorklet) {
      await context.audioWorklet.addModule(
        `${import.meta.env.BASE_URL}audio/studio-cleanup.js`
      );
      gate = new AudioWorkletNode(context, 'studio-cleanup');
    }
    source.connect(bypass).connect(output);
    source.connect(highpass);
    if (gate) highpass.connect(gate).connect(compressor);
    else highpass.connect(compressor);
    compressor.connect(gain).connect(wet).connect(output);
    return {
      context,
      output,
      update(settings: Edits['audio']) {
        bypass.gain.value = settings.enabled ? 0 : 1;
        wet.gain.value = settings.enabled ? 1 : 0;
        gain.gain.value = settings.gain;
        gate?.port.postMessage({ strength: settings.strength });
      },
      close: () => context.close(),
    };
  } catch (e) {
    await context.close();
    throw e;
  }
}
export type AudioGraph = Awaited<ReturnType<typeof audioGraph>>;
