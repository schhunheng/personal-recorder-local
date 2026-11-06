import type { Mode } from './settings';
export const audioAsset = (name: string) => `${import.meta.env.BASE_URL}audio/${name}`;
/** Engine boundary: mono, normalized float PCM at the AudioContext's 48 kHz clock.
 * Node creation must acknowledge successful initialization. Worklet engines emit
 * ready/error/heartbeat messages and accept 'destroy' for bounded lifecycle cleanup.
 * Browser capture processing is selected independently by constraints().
 */
export interface AudioEngine {
  readonly mode: Mode;
  readonly algorithmicDelayMs: number;
  createNode(context: AudioContext): Promise<AudioWorkletNode | undefined>;
}
export class EngineRegistry {
  private readonly engines = new Map<Mode, AudioEngine>();
  register(engine: AudioEngine) { this.engines.set(engine.mode, engine); }
  get(mode: Mode) {
    const engine = this.engines.get(mode);
    if (!engine) throw Error(`Audio engine is not registered: ${mode}`);
    return engine;
  }
}
class RNNoiseEngine implements AudioEngine {
  readonly mode = 'ai' as const;
  readonly algorithmicDelayMs = 20;
  private loaded = new WeakSet<AudioContext>();
  async createNode(context: AudioContext) {
    if (context.sampleRate !== 48000) throw Error('RNNoise requires 48 kHz');
    if (!this.loaded.has(context)) {
      const response = await fetch(audioAsset('engine.json'));
      if (!response.ok || !(await response.json()).rnnoise) throw Error('RNNoise WASM assets are not installed');
      await context.audioWorklet.addModule(audioAsset('rnnoise-processor.js'));
      this.loaded.add(context);
    }
    const node = new AudioWorkletNode(context, 'offline-rnnoise', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { node.port.onmessage = null; reject(Error('RNNoise initialization timed out')); }, 8000);
        node.onprocessorerror = () => { clearTimeout(timer); reject(Error('RNNoise processor failed')); };
        node.port.onmessage = ({ data }) => {
          if (data.type === 'ready' || data.type === 'error') {
            clearTimeout(timer); node.port.onmessage = null;
            if (data.type === 'ready') resolve(); else reject(Error(data.message));
          }
        };
      });
      return node;
    } catch (error) {
      node.port.postMessage('destroy'); node.disconnect(); node.port.close(); throw error;
    }
  }
}
export function createEngineRegistry() {
  const registry = new EngineRegistry();
  for (const mode of ['off', 'standard'] as const) registry.register({ mode, algorithmicDelayMs: 0, createNode: async () => undefined });
  registry.register(new RNNoiseEngine());
  return registry;
}
