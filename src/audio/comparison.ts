import type { AudioPipeline } from './AudioPipeline';
export interface Comparison { before: string; after: string; description: string }
/** Two simultaneous bounded samples from the same capture/graph. Never save/upload automatically. */
export function compareMicrophone(pipeline: AudioPipeline, signal: AbortSignal, seconds = 8): Promise<Comparison> {
  return new Promise((resolve, reject) => {
    const mimeType = 'audio/webm;codecs=opus';
    const a = new MediaRecorder(pipeline.before.stream, { mimeType });
    const b = new MediaRecorder(pipeline.stream, { mimeType });
    const aChunks: Blob[] = [], bChunks: Blob[] = [];
    let done = 0, failed = false;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const stop = () => { if (a.state !== 'inactive') a.stop(); if (b.state !== 'inactive') b.stop(); };
    const fail = (error: unknown) => { if (failed) return; failed = true; cleanup(); stop(); reject(error); };
    const abort = () => fail(Error('Microphone test cancelled'));
    const complete = () => {
      if (++done !== 2 || failed) return;
      cleanup();
      resolve({ before: URL.createObjectURL(new Blob(aChunks, { type: mimeType })), after: URL.createObjectURL(new Blob(bChunks, { type: mimeType })),
        description: pipeline.status.active === 'ai' ? 'Before RNNoise → after RNNoise and output safety limiter. Both include the selected echo and gain settings.' : 'Both samples include browser capture processing. After also includes the output safety limiter. For a suppression A/B comparison, repeat with cancellation Off.' });
    };
    a.ondataavailable = event => aChunks.push(event.data); b.ondataavailable = event => bChunks.push(event.data);
    a.onstop = b.onstop = complete;
    a.onerror = b.onerror = () => fail(Error('Microphone test encoder failed'));
    const timer = setTimeout(stop, seconds * 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { a.start(); b.start(); } catch (error) { fail(error); }
  });
}
