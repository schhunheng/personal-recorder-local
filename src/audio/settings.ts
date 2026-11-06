export type Mode = 'off' | 'standard' | 'ai';
export interface AudioSettings {
  deviceId: string;
  enabled: boolean;
  mode: Mode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  voiceCleanup?: boolean;
  gateThresholdDb?: number;
}
export const defaultSettings: AudioSettings = { deviceId: '', enabled: true, mode: 'standard', echoCancellation: true, autoGainControl: false, voiceCleanup: true, gateThresholdDb: -45 };
export function effectiveMode(settings: AudioSettings): Mode { return settings.enabled ? settings.mode : 'off'; }
export function constraints(settings: AudioSettings, mode = effectiveMode(settings)): MediaTrackConstraints {
  return {
    ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
    channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
    noiseSuppression: mode === 'standard',
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
  };
}
export function readSettings(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem('audio-settings') ?? '{}');
    return {
      deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : '',
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
      mode: ['off', 'standard', 'ai'].includes(saved.mode) ? saved.mode : 'standard',
      echoCancellation: typeof saved.echoCancellation === 'boolean' ? saved.echoCancellation : true,
      autoGainControl: typeof saved.autoGainControl === 'boolean' ? saved.autoGainControl : false,
      voiceCleanup: typeof saved.voiceCleanup === 'boolean' ? saved.voiceCleanup : true,
      gateThresholdDb: Number.isFinite(saved.gateThresholdDb) ? Math.max(-60, Math.min(-25, saved.gateThresholdDb)) : -45,
    };
  } catch { return { ...defaultSettings }; }
}
