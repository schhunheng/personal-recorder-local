export type Range = { start: number; end: number };
export type Zoom = {
  id: string;
  time: number;
  duration: number;
  scale: number;
  x: number;
  y: number;
};
export type Camera = {
  visible: boolean;
  shape: 'circle' | 'rounded';
  size: number;
  x: number;
  y: number;
  mirror: boolean;
  opacity: number;
  border: boolean;
  shadow: boolean;
};
export type Edits = {
  captions?: Caption[];
  captionStyle?: CaptionStyle;
  chapters?: { time: number; title: string }[];
  waveform?: { levels: number[]; step: number };
  trim: Range;
  cuts: Range[];
  splits: number[];
  zooms: Zoom[];
  silence: Range[];
  camera: Camera;
  avatar?: string;
  audio: { enabled: boolean; strength: number; gain: number };
  appearance: {
    background: string;
    padding: number;
    paddingX?: number | null;
    paddingY?: number | null;
    radius: number;
    shadow: boolean;
    ratio: '16:9' | '1:1' | '9:16';
    watermark: boolean;
    watermarkColor?: string;
    title: string;
    intro: boolean;
    outro: boolean;
  };
  export: {
    height: number;
    fps: number;
    quality: 'standard' | 'high';
    format: 'mp4' | 'webm';
  };
};
export type Asset = {
  id: string;
  mime: string;
  bytes: number;
  storage: 'opfs' | 'idb' | 'local-api';
  url?: string;
};
export type SavedExport = {
  id: string;
  projectId: string;
  title: string;
  libraryPath?: string;
  created: number;
  duration: number;
  asset: Asset;
  edits: Edits;
};
export type RecordingMarker = {
  id: string;
  time: number;
  kind: 'important' | 'zoom' | 'retake_start' | 'retake_end' | 'chapter';
  label?: string;
  x?: number;
  y?: number;
};
export type Caption = Range & { id: string; text: string };
export type CaptionStyle = {
  font:
    | 'Arial'
    | 'Noto Sans Khmer'
    | 'Khmer OS'
    | 'Kohinoor Khmer'
    | 'Khmer MN'
    | 'Khmer Sangam MN';
  size: number;
  position: 'bottom' | 'top' | 'center';
  animation: 'none' | 'fade';
  burn: boolean;
};
export type Project = {
  id: string;
  title: string;
  created: number;
  duration: number;
  width: number;
  height: number;
  complete: boolean;
  screen: Asset;
  camera?: Asset;
  microphone?: Asset;
  markers?: RecordingMarker[];
  timing?: {
    startedAt: number;
    trackOffsetsMs: Record<string, number>;
    pauses: { start: number; end?: number }[];
    sampleRate?: number;
  };
  processing?: {
    // Open automatic editing settings; processing starts only after a click.
    requested?: boolean;
    timelineVersion?: number;
    jobId?: string;
    appliedJobId?: string;
    error?: string;
  };
  edits: Edits;
  warning?: string;
};
export type RecordingOptions = {
  source: 'monitor' | 'window' | 'browser';
  mic: boolean;
  micId: string;
  camera: boolean;
  cameraId: string;
  noise: boolean;
  echo: boolean;
  gain: boolean;
  systemAudio: boolean;
  height: number;
  fps: number;
};
export const defaultRecording: RecordingOptions = {
  source: 'window',
  mic: true,
  micId: '',
  camera: false,
  cameraId: '',
  noise: true,
  echo: true,
  gain: true,
  systemAudio: false,
  height: 1080,
  fps: 30,
};
export const defaultCamera: Camera = {
  visible: true,
  shape: 'circle',
  size: 0.22,
  x: 0.84,
  y: 0.78,
  mirror: true,
  opacity: 1,
  border: true,
  shadow: true,
};
export function defaultEdits(duration: number): Edits {
  return {
    trim: { start: 0, end: duration },
    cuts: [],
    splits: [],
    zooms: [],
    silence: [],
    camera: { ...defaultCamera },
    audio: { enabled: false, strength: 0.5, gain: 1 },
    appearance: {
      background: '#182b29',
      padding: 0.045,
      radius: 16,
      shadow: true,
      ratio: '16:9',
      watermark: false,
      watermarkColor: 'auto',
      title: '',
      intro: false,
      outro: false,
    },
    export: { height: 1080, fps: 30, quality: 'high', format: 'mp4' },
  };
}
export const clamp = (n: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, n));
export function formatTime(n: number) {
  n = Math.max(0, Math.floor(n || 0));
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}
export const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;
