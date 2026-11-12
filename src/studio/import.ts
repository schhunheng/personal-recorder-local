import { defaultEdits, type Asset, type Project } from './model';
import { loadVideo, seek, unloadVideo } from './media';
import { deleteAsset, importAsset, saveProject } from './storage';

export type UploadCleanup = {
  enabled: boolean;
  noise: 'light' | 'balanced' | 'strong';
};
export const videoAccept =
  'video/mp4,video/webm,video/quicktime,video/ogg,video/x-matroska,.mp4,.m4v,.mov,.webm,.ogv,.mkv';
const extensions: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
};
export function uploadedVideoMime(file: Pick<File, 'name' | 'type' | 'size'>) {
  if (!file.size) throw Error('This file is empty. Choose a video with content.');
  let mime = file.type.toLowerCase().split(';')[0].trim();
  if (mime === 'video/x-m4v') mime = 'video/mp4';
  if (mime === 'video/matroska') mime = 'video/x-matroska';
  if (!mime || mime === 'application/octet-stream')
    mime = extensions[file.name.split('.').pop()?.toLowerCase() || ''] || '';
  if (!Object.values(extensions).includes(mime))
    throw Error('Choose an MP4, MOV, WebM, OGV, or browser-supported MKV video.');
  return mime;
}
export function uploadedProject(
  file: Pick<File, 'name'>,
  asset: Asset,
  media: { duration: number; width: number; height: number },
  cleanup: UploadCleanup
): Project {
  const { duration, width, height } = media;
  const edits = defaultEdits(duration);
  // Imported footage already has its own framing. Start without a studio frame.
  edits.appearance = {
    ...edits.appearance,
    padding: 0,
    radius: 0,
    shadow: false,
    ratio: height > width ? '9:16' : '16:9',
  };
  return {
    id: crypto.randomUUID(),
    title: (file.name.replace(/\.[^.]+$/, '').trim() || 'Uploaded video').slice(0, 200),
    created: Date.now(),
    duration,
    width,
    height,
    complete: true,
    screen: asset,
    edits,
    processing: {
      requested: cleanup.enabled,
      mode: cleanup.enabled ? 'denoise' : 'edit',
      noise: cleanup.noise,
    },
  };
}
export async function importVideo(file: File, cleanup: UploadCleanup) {
  const mime = uploadedVideoMime(file);
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota && file.size > estimate.quota - (estimate.usage || 0))
    throw Error(
      'Not enough browser storage. Download and remove an old project first.'
    );
  const blob = file.slice(0, file.size, mime);
  const url = URL.createObjectURL(blob);
  let video: HTMLVideoElement | undefined;
  let asset: Asset | undefined;
  try {
    video = await loadVideo(url);
    if (!Number.isFinite(video.duration)) await seek(video, 1e9);
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : video.currentTime;
    if (
      !Number.isFinite(duration) || duration <= 0 ||
      !video.videoWidth || !video.videoHeight
    )
      throw Error('This video has no playable timeline. Try another video.');
    asset = await importAsset(blob);
    const project = uploadedProject(
      file,
      asset,
      { duration, width: video.videoWidth, height: video.videoHeight },
      cleanup
    );
    await saveProject(project);
    return project;
  } catch (error) {
    if (asset) await deleteAsset(asset).catch(() => {});
    throw error;
  } finally {
    unloadVideo(video);
    URL.revokeObjectURL(url);
  }
}
