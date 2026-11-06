import type { Range } from './model';
import { loadVideo, unloadVideo } from './media';
import { assetBlob } from './storage';
import type { Asset } from './model';
export async function analyzeAudio(
  asset: Asset,
  duration: number,
  signal: AbortSignal,
  progress: (n: number) => void
): Promise<{ levels: number[]; step: number }> {
  // Real-time streaming analysis avoids decoding an entire long lesson into PCM memory.
  const url = URL.createObjectURL(await assetBlob(asset));
  const context = new AudioContext();
  let video: HTMLVideoElement | undefined;
  const levels: number[] = [],
    step = 0.05;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await context.resume();
    video = await loadVideo(url);
    if (signal.aborted)
      throw new DOMException('Analysis cancelled.', 'AbortError');
    const source = context.createMediaElementSource(video),
      analyser = context.createAnalyser(),
      mute = context.createGain();
    analyser.fftSize = 2048;
    source.connect(analyser).connect(mute).connect(context.destination);
    mute.gain.value = 0;
    const samples = new Float32Array(analyser.fftSize);
    // Downstream binning uses media time, independent of timers or playback rate.
    video.playbackRate = 1;
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        reject(new DOMException('Analysis cancelled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      video!.onended = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      video!.onerror = () => reject(Error('Audio analysis was interrupted.'));
      timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          abort();
          return;
        }
        if (document.hidden) {
          clearInterval(timer);
          reject(
            Error(
              'Analysis stopped because the tab is hidden. Keep this tab visible and retry.'
            )
          );
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        const level = Math.sqrt(
          samples.reduce((s, x) => s + x * x, 0) / samples.length
        );
        const index = Math.floor(video!.currentTime / step);
        while (levels.length <= index) levels.push(level);
        levels[index] = Math.max(levels[index], level);
        progress(Math.min(1, video!.currentTime / duration));
      }, 25);
      void video!.play().catch(reject);
    });
    return { levels, step };
  } finally {
    clearInterval(timer);
    unloadVideo(video);
    await context.close();
    URL.revokeObjectURL(url);
  }
}
export async function silenceSuggestions(
  levels: number[],
  step: number,
  threshold: number,
  minimum: number
) {
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    return await new Promise<Range[]>((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data.silence);
      worker.onerror = () => reject(Error('Silence analysis failed.'));
      worker.postMessage({ levels, step, threshold, minimum });
    });
  } finally {
    worker.terminate();
  }
}
