import {
  Scissors,
  ZoomIn,
  Video,
  AudioLines,
  Camera,
  Undo2,
  Redo2,
  Plus,
  Minus,
} from 'lucide-react';
import { useState } from 'react';
import type { Project } from './model';
import { clamp, formatTime } from './model';
import { useEditor } from './store';
export function Timeline({
  project,
  time,
  setTime,
  levels,
  onZoom,
}: {
  project: Project;
  time: number;
  setTime: (n: number) => void;
  levels: number[];
  onZoom: (id: string) => void;
}) {
  const { edit, undo, redo, past, future } = useEditor(),
    [zoom, setZoom] = useState(1);
  const duration = Math.max(0.1, project.duration),
    e = project.edits;
  const position = (n: number) => `${clamp(n / duration) * 100}%`;
  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <button
          title="Split at playhead (S)"
          onClick={() =>
            edit((e) => ({
              ...e,
              splits: [...new Set([...e.splits, time])].sort((a, b) => a - b),
            }))
          }
        >
          <Scissors size={15} /> Split
        </button>
        <span className="divider" />
        <button
          title="Undo (⌘Z)"
          aria-label="Undo"
          disabled={!past.length}
          onClick={undo}
        >
          <Undo2 size={16} />
        </button>
        <button
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          disabled={!future.length}
          onClick={redo}
        >
          <Redo2 size={16} />
        </button>
        <span className="muted small">Original always preserved</span>
        <div className="spacer" />
        <button
          title="Zoom timeline out"
          aria-label="Zoom timeline out"
          onClick={() => setZoom(Math.max(1, zoom - 0.5))}
        >
          <Minus size={14} />
        </button>
        <span className="small">{Math.round(zoom * 100)}%</span>
        <button
          title="Zoom timeline in"
          aria-label="Zoom timeline in"
          onClick={() => setZoom(Math.min(8, zoom + 0.5))}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-labels">
          <span />
          <span>
            <Video size={14} /> Screen
          </span>
          <span>
            <AudioLines size={14} /> Audio
          </span>
          <span>
            <ZoomIn size={14} /> Zoom
          </span>
          <span>
            <Camera size={14} /> Camera
          </span>
        </div>
        <div className="timeline-data" style={{ minWidth: `${zoom * 85}%` }}>
          <div
            className="ruler"
            onPointerDown={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              setTime(clamp((event.clientX - r.left) / r.width) * duration);
            }}
          >
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} style={{ left: `${(i / 8) * 100}%` }}>
                {formatTime((i / 8) * duration)}
              </span>
            ))}
          </div>
          <div
            className="tracks"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const r = event.currentTarget.getBoundingClientRect();
              setTime(clamp((event.clientX - r.left) / r.width) * duration);
            }}
          >
            <div
              className="screen-track"
              style={{
                left: position(e.trim.start),
                width: position(e.trim.end - e.trim.start),
              }}
            >
              <Video size={13} />
              <span>{project.title}</span>
              {e.splits.map((s, i) => (
                <button
                  key={i}
                  title={`Select split at ${formatTime(s)}`}
                  className="split-marker"
                  style={{
                    left: `${
                      ((s - e.trim.start) / (e.trim.end - e.trim.start)) * 100
                    }%`,
                  }}
                  onClick={() => setTime(s)}
                />
              ))}
              <span className="track-end">{formatTime(duration)}</span>
            </div>
            <div className="audio-track">
              {levels.length ? (
                Array.from({ length: Math.min(400, levels.length) }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${Math.max(
                        3,
                        Math.min(
                          100,
                          levels[
                            Math.floor(
                              (i / Math.min(400, levels.length)) * levels.length
                            )
                          ] * 500
                        )
                      )}%`,
                    }}
                  />
                ))
              ) : (
                <span className="muted small">
                  Analyze audio to generate waveform
                </span>
              )}
            </div>
            <div className="zoom-track">
              {e.zooms.map((z) => (
                <button
                  key={z.id}
                  title={`${z.scale.toFixed(1)}× zoom at ${formatTime(z.time)}`}
                  style={{ left: position(z.time) }}
                  onClick={() => {
                    setTime(z.time);
                    onZoom(z.id);
                  }}
                >
                  <span />
                  {z.scale.toFixed(1)}×
                </button>
              ))}
            </div>
            <div className="camera-track">
              {(project.camera || e.avatar) && e.camera.visible && (
                <span>
                  <Camera size={12} />
                  {e.avatar ? 'Loop avatar' : 'Webcam'} · separate source
                </span>
              )}
            </div>
            {e.silence.map((s, i) => (
              <button
                key={`silence-${i}`}
                title={`Suggested silence ${formatTime(s.start)}–${formatTime(
                  s.end
                )}`}
                className="silence-region"
                style={{
                  left: position(s.start),
                  width: position(s.end - s.start),
                }}
                onClick={() => setTime(s.start)}
              />
            ))}
            {e.cuts.map((s, i) => (
              <div
                key={`cut-${i}`}
                title="Removed region"
                className="cut-region"
                style={{
                  left: position(s.start),
                  width: position(s.end - s.start),
                }}
              />
            ))}
            <div className="playhead" style={{ left: position(time) }}>
              <span />
              {/* Position is mapped to source time, edits never overwrite originals. */}
            </div>
          </div>
        </div>
      </div>
      <input
        className="seekbar"
        aria-label="Seek video"
        type="range"
        value={time}
        min={0}
        max={duration}
        step={0.01}
        onChange={(event) => setTime(+event.target.value)}
      />
    </section>
  );
}
