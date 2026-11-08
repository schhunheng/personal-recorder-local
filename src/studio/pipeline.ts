import { defaultEdits } from './model';
import type {
  Project,
  Asset,
  Edits,
  Caption,
  CaptionStyle,
  RecordingMarker,
} from './model';
import { assetBlob, getAsset, saveAssetReference } from './storage';
export type Preset = 'clean' | 'professional' | 'social';
export type PipelineOptions = {
  preset: Preset;
  clip_seconds: number;
  noise: 'off' | 'light' | 'balanced' | 'strong' | 'ai';
  noise_engine?: 'auto' | 'rnnoise' | 'deepfilter' | 'spectral';
  noise_strength?: number | null;
  audio_source?: 'auto' | 'microphone' | 'screen';
  normalize: boolean;
  vad: 'auto' | 'silero' | 'energy';
  minimum_silence: number;
  speech_padding: number;
  threshold_db: number;
  accept_silence: boolean;
  transcribe: boolean;
  language: 'km' | 'en' | 'auto';
  profile: 'lms' | 'vertical';
  quality: 'high' | 'standard';
  bitrate_mbps: number;
  height: 720 | 1080 | 1440;
  fps: 30 | 60;
  action: 'plan' | 'render';
  edl?: EDL;
};
export type EDL = {
  schema_version: number;
  source_duration: number;
  trim: { start: number; end: number };
  cuts: {
    id: string;
    start: number;
    end: number;
    reason: 'silence' | 'retake' | 'manual';
    accepted: boolean;
  }[];
  zooms: Edits['zooms'];
  camera: Edits['camera'];
  appearance: Edits['appearance'];
  captions: Caption[];
  caption_style: CaptionStyle;
  chapters: { time: number; title: string }[];
};
export type LocalJob = {
  created: number;
  id: string;
  project_id: string;
  status: string;
  stage: string;
  progress: number | null;
  error?: string;
  audio_ready?: boolean;
  options: PipelineOptions;
  result?: {
    edl: EDL;
    waveform: { levels: number[]; step: number };
    vad_engine: string;
    warnings: string[];
    bytes: number;
    duration: number;
    width: number;
    height: number;
    video_url: string;
    srt_url: string;
    edl_url: string;
    file_name?: string;
    library_path?: string;
    edit_version?: number;
    audio?: {
      engine: string;
      model: string;
      source: string;
      strength: number;
      gain_db: number;
      quiet_reduction_db?: number | null;
      fallback_reason?: string | null;
    };
  };
};
export type PipelineCapabilities = {
  ready: boolean;
  subtitle_burn: boolean;
  silero: boolean;
  whisper: boolean;
  whisper_message: string;
  max_bytes: number;
  max_duration: number;
  audio_engines?: {
    id: string;
    label: string;
    available: boolean;
    reason: string;
  }[];
  recommended_audio_engine?: string;
};
export const defaultPipeline: PipelineOptions = {
  preset: 'clean',
  clip_seconds: 60,
  noise: 'balanced',
  noise_engine: 'auto',
  noise_strength: null,
  audio_source: 'auto',
  normalize: true,
  vad: 'auto',
  minimum_silence: 1.5,
  speech_padding: 0.3,
  threshold_db: -38,
  accept_silence: true,
  transcribe: false,
  language: 'km',
  profile: 'lms',
  quality: 'high',
  bitrate_mbps: 12,
  height: 1080,
  fps: 30,
  action: 'plan',
};
export const defaultCaptionStyle: CaptionStyle = {
  font: 'Khmer Sangam MN',
  size: 42,
  position: 'bottom',
  animation: 'none',
  burn: false,
};
export const activePipeline = (job?: LocalJob) =>
  !!job && !['completed', 'failed', 'cancelled'].includes(job.status);
function localOnly() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))
    throw Error(
      'Automatic editing runs only on localhost. Open the studio on your Mac with npm run dev:all.'
    );
}
export async function localRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  localOnly();
  const response = await fetch(`/api/studio${path}`, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw Error(
      typeof error?.detail === 'string'
        ? error.detail
        : 'The local studio service is unavailable. Start it with npm run dev:all. Your originals are safe.'
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export function toEDL(project: Project): EDL {
  const e = project.edits;
  return {
    schema_version: 1,
    source_duration: project.duration,
    trim: e.trim,
    cuts: e.cuts.map((c, i) => ({
      id: `manual-${i}`,
      reason: 'manual',
      accepted: true,
      ...c,
    })),
    zooms: e.zooms,
    camera: e.camera,
    appearance: e.appearance,
    captions: e.captions || [],
    caption_style: e.captionStyle || defaultCaptionStyle,
    chapters: e.chapters || [],
  };
}
export function applyEDL(edits: Edits, edl: EDL): Edits {
  return {
    ...edits,
    trim: edl.trim,
    cuts: edl.cuts
      .filter((c) => c.accepted)
      .map((c) => ({ start: c.start, end: c.end })),
    silence: edl.cuts
      .filter((c) => c.reason === 'silence')
      .map((c) => ({ start: c.start, end: c.end })),
    zooms: edl.zooms,
    camera: edl.camera,
    appearance: edl.appearance,
    captions: edl.captions,
    captionStyle: edl.caption_style,
    chapters: edl.chapters,
  };
}
export async function uploadOriginals(
  project: Project,
  signal: AbortSignal,
  progress: (p: number) => void
) {
  const remote = await localRequest<{
    assets: Record<string, { revision?: string }>;
  }>(`/projects`, {
    ...json({
      id: project.id,
      title: project.title,
      duration: project.duration,
      markers: project.markers || [],
      timing: {
        ...project.timing,
        trackRoles: {
          screen: project.screen.id,
          microphone: project.microphone?.id,
          camera: project.camera?.id,
        },
      },
    }),
    signal,
  });
  const assets: [string, Asset | undefined][] = [
    ['screen', project.screen],
    ['microphone', project.microphone],
    ['camera', project.camera],
    [
      'avatar',
      project.edits.avatar ? await getAsset(project.edits.avatar) : undefined,
    ],
  ];
  let complete = 0;
  const total = assets.reduce((sum, [, a]) => sum + (a?.bytes || 0), 0);
  for (const [kind, asset] of assets) {
    if (!asset) continue;
    if (
      remote.assets[kind] &&
      (kind !== 'avatar' || remote.assets[kind].revision === asset.id)
    ) {
      complete += asset.bytes;
      continue;
    }
    const blob = await assetBlob(asset);
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'PUT',
        `/api/studio/projects/${project.id}/assets/${kind}${
          kind === 'avatar' ? `?revision=${asset.id}` : ''
        }`
      );
      xhr.setRequestHeader('Content-Type', blob.type.split(';')[0]);
      const abort = () => xhr.abort();
      signal.addEventListener('abort', abort, { once: true });
      xhr.onloadend = () => signal.removeEventListener('abort', abort);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          progress((complete + e.loaded) / Math.max(1, total));
      };
      xhr.onerror = () =>
        reject(
          Error(
            'Saving to the local service failed. Browser originals are retained.'
          )
        );
      xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let body;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {}
          reject(Error(body?.detail || 'Local media save failed.'));
        }
      };
      if (signal.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      xhr.send(blob);
    });
    complete += asset.bytes;
    progress(complete / Math.max(1, total));
  }
}
export async function startPipeline(
  project: Project,
  options: PipelineOptions,
  signal: AbortSignal,
  progress: (p: number) => void
) {
  await uploadOriginals(project, signal, progress);
  return localRequest<LocalJob>(`/projects/${project.id}/process`, {
    ...json(options),
    signal,
  });
}
export type ArchivedExport = {
  id: string;
  file_name: string;
  library_path: string;
  edit_version: number;
  video_url: string;
  bytes: number;
};
export async function archiveBrowserExport(
  project: Project,
  asset: Asset,
  exportId: string,
  signal: AbortSignal
): Promise<ArchivedExport | undefined> {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname))
    return;
  await uploadOriginals(project, signal, () => {});
  const blob = await assetBlob(asset);
  return localRequest<ArchivedExport>(
    `/projects/${project.id}/exports/${exportId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': blob.type.split(';')[0] },
      body: blob,
      signal,
    }
  );
}
export function watchJob(
  id: string,
  onJob: (j: LocalJob) => void,
  onError: (e: string) => void
) {
  localOnly();
  const events = new EventSource(`/api/studio/jobs/${id}/events`);
  events.addEventListener('progress', (event) => {
    const job = JSON.parse((event as MessageEvent).data) as LocalJob;
    onJob(job);
    if (!activePipeline(job)) events.close();
  });
  events.onerror = () => {
    onError('Progress connection interrupted. Reconnecting to the same job…');
  };
  return () => events.close();
}

export type LocalProject = {
  id: string;
  title: string;
  created: number;
  duration: number;
  version: number;
  edl?: EDL;
  latest_job_id?: string;
  latest_status?: string;
  assets: Record<
    string,
    {
      file: string;
      mime: string;
      bytes: number;
      width?: number;
      height?: number;
      revision?: string;
    }
  >;
};
export async function restoreLocalProject(
  remote: LocalProject
): Promise<Project> {
  const source = remote.assets.screen;
  if (!source)
    throw Error('The local project has no finished screen file yet.');
  const asset = (kind: string): Asset | undefined =>
    remote.assets[kind]
      ? {
          id:
            kind === 'avatar'
              ? remote.assets[kind].revision || crypto.randomUUID()
              : `${remote.id}-${kind}`,
          mime: remote.assets[kind].mime,
          bytes: remote.assets[kind].bytes,
          storage: 'local-api',
          url: `/api/studio/projects/${remote.id}/assets/${kind}`,
        }
      : undefined;
  const edits = defaultEdits(remote.duration);
  const avatar = asset('avatar');
  if (avatar) {
    await saveAssetReference(avatar);
    edits.avatar = avatar.id;
  }
  return {
    id: remote.id,
    title: remote.title,
    created: remote.created * 1000,
    duration: remote.duration,
    width: source.width || 1920,
    height: source.height || 1080,
    complete: remote.latest_status !== 'failed',
    screen: asset('screen')!,
    microphone: asset('microphone'),
    camera: asset('camera'),
    edits: remote.edl ? applyEDL(edits, remote.edl) : edits,
    processing: {
      requested: false,
      jobId: remote.latest_job_id,
      appliedJobId:
        remote.latest_status === 'completed' ? remote.latest_job_id : undefined,
      timelineVersion: remote.version,
    },
  };
}
