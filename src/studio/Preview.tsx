import { useEffect, useRef, useState } from 'react';
import {
  Pause,
  Play,
  SkipBack,
  Volume2,
  VolumeX,
  Maximize2,
} from 'lucide-react';
import type { Project } from './model';
import { clamp, formatTime } from './model';
import { assetBlob, getAsset } from './storage';
import { audioGraph, type AudioGraph } from './audio';
import { drawFrame, screenBounds } from './compositor';
import { loadVideo, seek, unloadVideo } from './media';
import { segments, zoomAt } from './timeline';
export function Preview({
  project,
  time,
  setTime,
  tool,
  onFocus,
  onCamera,
  selectedZoom,
  suspended = false,
}: {
  project: Project;
  time: number;
  setTime: (n: number) => void;
  tool: string;
  onFocus: (x: number, y: number) => void;
  onCamera: (x: number, y: number) => void;
  selectedZoom?: string;
  suspended?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    screen = useRef<HTMLVideoElement | undefined>(undefined),
    camera = useRef<HTMLVideoElement | undefined>(undefined),
    graph = useRef<AudioGraph | undefined>(undefined);
  const requestedTime = useRef(time);
  requestedTime.current = time;
  const latest = useRef({ project, setTime });
  latest.current = { project, setTime };
  const [playing, setPlaying] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [muted, setMuted] = useState(false),
    [resolution, setResolution] = useState(720);
  const externalTime = useRef(time),
    currentTime = useRef(time),
    dragging = useRef(false);
  useEffect(() => {
    let gone = false;
    const urls: string[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    let localScreen: HTMLVideoElement | undefined,
      localCamera: HTMLVideoElement | undefined;
    setReady(false);
    setError('');
    setPlaying(false);
    void (async () => {
      const url = URL.createObjectURL(await assetBlob(project.screen));
      urls.push(url);
      localScreen = await loadVideo(url);
      if (gone) {
        unloadVideo(localScreen);
        URL.revokeObjectURL(url);
        return;
      }
      const cam = project.edits.avatar
        ? await getAsset(project.edits.avatar)
        : project.camera;
      if (cam) {
        try {
          const u = URL.createObjectURL(await assetBlob(cam));
          urls.push(u);
          localCamera = await loadVideo(u);
          localCamera.muted = true;
          localCamera.loop = !!project.edits.avatar;
        } catch {
          if (!gone)
            setError(
              'The overlay could not be decoded. Hide it or import a different avatar; the screen recording is available.'
            );
        }
      }
      if (gone) {
        unloadVideo(localScreen);
        unloadVideo(localCamera);
        urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      screen.current = localScreen;
      camera.current = localCamera;
      localScreen.muted = false;
      const initialTime = clamp(
        requestedTime.current,
        project.edits.trim.start,
        project.edits.trim.end
      );
      if (initialTime > 0) await seek(localScreen, initialTime);
      currentTime.current = initialTime;
      latest.current.setTime(initialTime);
      if (gone) return;
      setReady(true);
      interval = setInterval(() => {
        const { project: p, setTime: publish } = latest.current,
          video = localScreen!;
        if (!video.paused) {
          const ranges = segments(p.edits),
            range = ranges.find(
              (r) =>
                video.currentTime >= r.start - 0.03 &&
                video.currentTime < r.end - 0.02
            );
          if (!range) {
            const next = ranges.find((r) => r.start > video.currentTime + 0.01);
            if (next) {
              video.currentTime = next.start;
              if (localCamera && !p.edits.avatar)
                localCamera.currentTime = next.start;
            } else {
              video.pause();
              localCamera?.pause();
              setPlaying(false);
            }
          }
          currentTime.current = video.currentTime;
          publish(video.currentTime);
          if (
            localCamera &&
            !p.edits.avatar &&
            Math.abs(localCamera.currentTime - video.currentTime) > 0.15
          )
            localCamera.currentTime = video.currentTime;
        }
        const c = canvas.current;
        if (c)
          drawFrame(
            c.getContext('2d')!,
            video,
            localCamera,
            p.edits,
            video.currentTime,
            c.width,
            c.height
          );
      }, 1000 / 30);
    })().catch((e) => {
      if (!gone) setError(e.message);
    });
    return () => {
      gone = true;
      clearInterval(interval);
      unloadVideo(localScreen);
      unloadVideo(localCamera);
      screen.current = camera.current = undefined;
      if (graph.current) {
        void graph.current.close();
        graph.current = undefined;
      }
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [project.id, project.edits.avatar]);
  useEffect(() => {
    if (suspended) {
      screen.current?.pause();
      camera.current?.pause();
      setPlaying(false);
    }
  }, [suspended]);
  useEffect(() => {
    if (graph.current) graph.current.update(project.edits.audio);
  }, [project.edits.audio]);
  useEffect(() => {
    if (
      Math.abs(time - currentTime.current) > 0.15 &&
      screen.current &&
      Math.abs(time - externalTime.current) > 0.01
    ) {
      screen.current.currentTime = time;
      if (camera.current && !project.edits.avatar)
        camera.current.currentTime = time;
    }
    externalTime.current = time;
  }, [time, project.edits.avatar]);
  async function toggle() {
    const video = screen.current;
    if (!video) return;
    try {
      if (!video.paused) {
        video.pause();
        camera.current?.pause();
        setPlaying(false);
        return;
      }
      if (!graph.current) {
        graph.current = await audioGraph(video);
        graph.current.output.connect(graph.current.context.destination);
      }
      await graph.current.context.resume();
      graph.current.update(project.edits.audio);
      video.muted = false;
      graph.current.output.gain.value = muted ? 0 : 1;
      const ranges = segments(project.edits);
      if (!ranges.length) throw Error('No video remains. Undo a cut.');
      if (
        video.currentTime >= ranges.at(-1)!.end - 0.1 ||
        video.currentTime < ranges[0].start
      )
        await seek(video, ranges[0].start);
      if (camera.current && !project.edits.avatar)
        await seek(camera.current, video.currentTime);
      await video.play();
      if (camera.current) await camera.current.play();
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]'))
        return;
      if ((e.target as HTMLElement).matches('input,textarea,select,button'))
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        void toggle();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const ratio =
    project.edits.appearance.ratio === '1:1'
      ? 1
      : project.edits.appearance.ratio === '9:16'
      ? 9 / 16
      : 16 / 9;
  function pointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!,
      rect = c.getBoundingClientRect(),
      x = clamp((e.clientX - rect.left) / rect.width),
      y = clamp((e.clientY - rect.top) / rect.height);
    if (tool === 'camera') onCamera(x, y);
    else if (tool === 'zoom' && screen.current) {
      const b = screenBounds(screen.current, project.edits, c.width, c.height);
      const z = zoomAt(project.edits.zooms, time);
      onFocus(
        clamp(z.x + ((x * c.width - b.x) / b.w - 0.5) / z.scale),
        clamp(z.y + ((y * c.height - b.y) / b.h - 0.5) / z.scale)
      );
    }
  }
  return (
    <section className="preview-column">
      <div className="preview-toolbar">
        <span>
          <span className="status-dot" /> Live preview
        </span>
        <label className="inline-label">
          Preview{' '}
          <select
            aria-label="Playback resolution"
            value={resolution}
            onChange={(e) => setResolution(+e.target.value)}
          >
            <option value={480}>480p</option>
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
          </select>
        </label>
      </div>
      <div className="preview-stage">
        <div className="preview-surface" style={{ aspectRatio: ratio }}>
          <canvas
            ref={canvas}
            width={Math.round(resolution * ratio)}
            height={resolution}
            aria-label={
              tool === 'camera'
                ? 'Video preview. Drag to move camera.'
                : 'Video preview. Click to focus zoom.'
            }
            tabIndex={0}
            onKeyDown={(e) => {
              const d = 0.02;
              if (
                tool === 'camera' &&
                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                  e.key
                )
              ) {
                e.preventDefault();
                onCamera(
                  clamp(
                    project.edits.camera.x +
                      (e.key === 'ArrowLeft'
                        ? -d
                        : e.key === 'ArrowRight'
                        ? d
                        : 0)
                  ),
                  clamp(
                    project.edits.camera.y +
                      (e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)
                  )
                );
              }
            }}
            onPointerDown={(e) => {
              if (tool !== 'zoom' && tool !== 'camera') return;
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              pointer(e);
            }}
            onPointerMove={(e) => {
              if (dragging.current) pointer(e);
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
          />
          {!ready && (
            <div className="preview-loading">
              {error || 'Loading your recording…'}
            </div>
          )}
        </div>
      </div>
      <div className="preview-hint">
        {tool === 'zoom'
          ? selectedZoom
            ? 'Drag in the preview to move the selected zoom focus'
            : 'Click on the code you want to bring into focus'
          : tool === 'camera'
          ? 'Drag in the preview to reposition your camera · Arrow keys also work'
          : 'Your edits are saved on this device'}
      </div>
      {error && ready && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="playback-controls">
        <button
          title="Back to start"
          aria-label="Back to start"
          onClick={() => setTime(project.edits.trim.start)}
        >
          <SkipBack size={16} />
        </button>
        <button
          className="play-button"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          disabled={!ready}
          onClick={() => void toggle()}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="timecode">
          {formatTime(time)} <em>/ {formatTime(project.duration)}</em>
        </span>
        <div className="spacer" />
        <button
          aria-label={muted ? 'Unmute preview' : 'Mute preview'}
          onClick={() => {
            setMuted(!muted);
            if (graph.current) graph.current.output.gain.value = !muted ? 0 : 1;
          }}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <button
          aria-label="Fullscreen preview"
          onClick={() =>
            void canvas.current
              ?.requestFullscreen()
              .catch((e) => setError(e.message))
          }
        >
          <Maximize2 size={16} />
        </button>
      </div>
    </section>
  );
}
