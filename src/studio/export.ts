import type { Project, Asset } from './model';
import { AssetWriter, assetBlob, deleteAsset, getAsset } from './storage';
import { capabilities, MP4, WEBM } from './capabilities';
import { segments, editedDuration } from './timeline';
import { drawFrame } from './compositor';
import { audioGraph, type AudioGraph } from './audio';
import { loadVideo, seek, unloadVideo } from './media';
export async function exportVideo(
  project: Project,
  signal: AbortSignal,
  onProgress: (n: number) => void
): Promise<Asset> {
  const caps = capabilities(),
    settings = project.edits.export;
  if (settings.format === 'mp4' && !caps.mp4)
    throw Error(
      'H.264/AAC MP4 encoding is unavailable in this browser. Choose WebM to export locally.'
    );
  if (settings.format === 'webm' && !caps.webm)
    throw Error('WebM encoding is unavailable. Choose MP4 or use Chrome.');
  const ranges = segments(project.edits);
  if (!ranges.length)
    throw Error(
      'The timeline has no video remaining. Undo a cut or adjust the trim.'
    );
  const urls: string[] = [];
  let screen: HTMLVideoElement | undefined,
    camera: HTMLVideoElement | undefined,
    graph: AudioGraph | undefined;
  let recorder: MediaRecorder | undefined,
    canvasStream: MediaStream | undefined,
    writer: AssetWriter | undefined,
    interval: ReturnType<typeof setInterval> | undefined;
  let writeError: unknown;
  let destination: MediaStreamAudioDestinationNode | undefined;
  const check = () => {
    if (signal.aborted)
      throw new DOMException('Export cancelled.', 'AbortError');
    if (writeError) throw writeError;
    if (document.hidden)
      throw Error(
        'Export paused by tab visibility. Keep this tab visible and retry to preserve frame timing.'
      );
  };
  try {
    const screenURL = URL.createObjectURL(await assetBlob(project.screen));
    urls.push(screenURL);
    screen = await loadVideo(screenURL);
    check();
    const camAsset = project.edits.avatar
      ? await getAsset(project.edits.avatar)
      : project.camera;
    if (camAsset) {
      const url = URL.createObjectURL(await assetBlob(camAsset));
      urls.push(url);
      camera = await loadVideo(url);
      camera.muted = true;
      camera.loop = !!project.edits.avatar;
    }
    graph = await audioGraph(screen);
    graph.update(project.edits.audio);
    const audioDest = graph.context.createMediaStreamDestination();
    destination = audioDest;
    graph.output.connect(audioDest);
    const ratio =
      project.edits.appearance.ratio === '1:1'
        ? 1
        : project.edits.appearance.ratio === '9:16'
        ? 9 / 16
        : 16 / 9;
    const canvas = document.createElement('canvas');
    canvas.height = settings.height;
    canvas.width = Math.round((settings.height * ratio) / 2) * 2;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const draw = () => {
      if (screen)
        drawFrame(
          ctx,
          screen,
          camera,
          project.edits,
          screen.currentTime,
          canvas.width,
          canvas.height
        );
    };
    await seek(screen, ranges[0].start);
    if (camera) await seek(camera, project.edits.avatar ? 0 : ranges[0].start);
    draw();
    canvasStream = canvas.captureStream(settings.fps);
    const mime = settings.format === 'mp4' ? MP4 : WEBM;
    writer = await new AssetWriter(mime, false).open();
    recorder = new MediaRecorder(
      new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]),
      {
        mimeType: mime,
        videoBitsPerSecond:
          settings.quality === 'high'
            ? (settings.height / 1080) ** 2 * 12_000_000
            : (settings.height / 1080) ** 2 * 6_000_000,
        audioBitsPerSecond: 192_000,
      }
    );
    recorder.ondataavailable = ({ data }) => {
      if (data.size)
        void writer!.append(data).catch((e) => {
          writeError = e;
        });
    };
    recorder.onerror = () => {
      writeError = Error(
        'The browser encoder failed. Try a lower resolution or WebM.'
      );
    };
    recorder.start(1000);
    interval = setInterval(draw, 1000 / settings.fps);
    let completed = 0;
    const total = editedDuration(project.edits);
    for (let i = 0; i < ranges.length; i++) {
      check();
      const range = ranges[i];
      if (i > 0) {
        await seek(screen, range.start);
        if (camera && !project.edits.avatar) await seek(camera, range.start);
        draw();
        recorder.resume();
      }
      await screen.play();
      if (camera) await camera.play();
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            check();
            if (writer!.pending > 32 * 1024 ** 2)
              throw Error(
                'Export storage cannot keep up. Free storage or choose a lower quality.'
              );
          } catch (e) {
            clearInterval(timer);
            reject(e);
            return;
          }
          onProgress(
            Math.min(
              0.99,
              (completed + Math.max(0, screen!.currentTime - range.start)) /
                total
            )
          );
          if (screen!.currentTime >= range.end - 0.015 || screen!.ended) {
            clearInterval(timer);
            resolve();
          }
        }, 15);
      });
      screen.pause();
      camera?.pause();
      recorder.pause();
      completed += range.end - range.start;
    }
    await new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
      recorder!.stop();
    });
    const result = await writer.close();
    check();
    onProgress(1);
    return result;
  } catch (e) {
    if (recorder && recorder.state !== 'inactive')
      await new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
        recorder!.stop();
      });
    if (writer) {
      await writer.close().catch(() => {});
      await deleteAsset(writer.asset).catch(() => {});
    }
    throw e;
  } finally {
    clearInterval(interval);
    unloadVideo(screen);
    unloadVideo(camera);
    canvasStream?.getTracks().forEach((t) => t.stop());
    destination?.stream.getTracks().forEach((t) => t.stop());
    await graph?.close();
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}
