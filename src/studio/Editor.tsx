import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ZoomIn,
  Camera,
  AudioLines,
  Palette,
  SlidersHorizontal,
  Download,
  Plus,
  Trash2,
  Check,
  Sparkles,
  X,
  Scissors,
  Save,
  LoaderCircle,
} from 'lucide-react';
import { useEditor, usePreferences } from './store';
import {
  formatTime,
  bytes,
  clamp,
  type Edits,
  type Project,
  type Asset,
  type SavedExport,
} from './model';
import {
  saveProject,
  importAsset,
  download,
  assetBlob,
  deleteAsset,
  saveExport,
  listExports,
} from './storage';
import { SavedVideos } from './SavedVideos';
import { Preview } from './Preview';
import { Timeline } from './TimelinePanel';
import { Toggle, Slider, Field } from './controls';
import { Button } from '../components/ui/button';
import { analyzeAudio, silenceSuggestions } from './analyze';
import { editedDuration, mergeRanges } from './timeline';
import { exportVideo } from './export';
import { loadVideo, unloadVideo } from './media';
import { useDialog } from './useDialog';
import { capabilities } from './capabilities';
export default function Editor({ onBack }: { onBack: () => void }) {
  const { project, edit, past, undo, redo } = useEditor();
  const p = project!;
  const [tool, setTool] = useState('zoom'),
    [time, setTime] = useState(0),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(true);
  const [analysis, setAnalysis] = useState<{ levels: number[]; step: number }>(
      p.edits.waveform || { levels: [], step: 0.05 }
    ),
    [progress, setProgress] = useState(0),
    [working, setWorking] = useState(''),
    [minimum, setMinimum] = useState(1.2),
    [threshold, setThreshold] = useState(-38),
    [mode, setMode] = useState('review'),
    [selectedSilence, setSelectedSilence] = useState<number[]>([]);
  const [exportOpen, setExportOpen] = useState(false),
    [result, setResult] = useState<Asset>(),
    [resultName, setResultName] = useState(''),
    [videosOpen, setVideosOpen] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined),
    saveQueue = useRef(Promise.resolve()),
    latest = useRef(p),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latest.current = p;
  useDialog(exportOpen, () => {
    if (!working) setExportOpen(false);
  });
  const zoomPreferences = usePreferences((s) => s.zoom);
  const z = p.edits.zooms.find((z) => z.id === selected),
    caps = capabilities();
  function update<K extends keyof Edits>(key: K, values: Partial<Edits[K]>) {
    edit((e) => ({
      ...e,
      [key]: { ...(e[key] as object), ...(values as object) },
    }));
  }
  function save(project: Project) {
    const job = saveQueue.current
      .catch(() => {})
      .then(async () => {
        await saveProject(project);
        setSaved(true);
      });
    saveQueue.current = job;
    void job.catch((e) => setError(e.message));
    return job;
  }
  useEffect(() => {
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(p), 400);
    return () => clearTimeout(saveTimer.current);
  }, [p]);
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      const value = latest.current;
      void saveQueue.current.catch(() => {}).then(() => saveProject(value));
      controller.current?.abort();
    },
    []
  );
  useEffect(() => {
    let active = true;
    void listExports(p.id)
      .then((exports) => {
        const latest = exports[0];
        if (active && latest) {
          setResult(latest.asset);
          setResultName(latest.title);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [p.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]'))
        return;
      if ((e.target as HTMLElement).matches('input,textarea,select')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key.toLowerCase() === 's')
        edit((edits) => ({
          ...edits,
          splits: [...new Set([...edits.splits, time])].sort((a, b) => a - b),
        }));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [time]);
  function addZoom(scale = zoomPreferences.scale, x = 0.5, y = 0.5) {
    const id = crypto.randomUUID();
    edit((e) => ({
      ...e,
      zooms: [
        ...e.zooms,
        { id, time, scale, duration: zoomPreferences.duration, x, y },
      ],
    }));
    setSelected(id);
  }
  function changeZoom(values: Partial<NonNullable<typeof z>>) {
    edit((e) => ({
      ...e,
      zooms: e.zooms.map((z) => (z.id === selected ? { ...z, ...values } : z)),
    }));
  }
  async function analyze() {
    controller.current = new AbortController();
    setWorking('Analyzing audio');
    setProgress(0);
    setError('');
    try {
      const data = await analyzeAudio(
        p.screen,
        p.duration,
        controller.current.signal,
        setProgress
      );
      setAnalysis(data);
      const silence = await silenceSuggestions(
        data.levels,
        data.step,
        threshold,
        minimum
      );
      edit((e) => ({
        ...e,
        waveform: data,
        silence,
        ...(mode === 'auto'
          ? { cuts: mergeRanges([...e.cuts, ...silence], e.trim) }
          : {}),
      }));
      setSelectedSilence(silence.map((_, i) => i));
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking('');
    }
  }
  async function suggest() {
    if (!analysis.levels.length) {
      await analyze();
      return;
    }
    const silence = await silenceSuggestions(
      analysis.levels,
      analysis.step,
      threshold,
      minimum
    );
    edit((e) => ({
      ...e,
      silence,
      ...(mode === 'auto'
        ? { cuts: mergeRanges([...e.cuts, ...silence], e.trim) }
        : {}),
    }));
    setSelectedSilence(silence.map((_, i) => i));
  }
  async function exportNow() {
    controller.current = new AbortController();
    setError('');
    setProgress(0);
    setWorking('Exporting video');
    try {
      const snapshot = structuredClone(p);
      const asset = await exportVideo(
        snapshot,
        controller.current.signal,
        setProgress
      );
      const record: SavedExport = {
        id: crypto.randomUUID(),
        projectId: snapshot.id,
        title: `${snapshot.title}-edited.${snapshot.edits.export.format}`,
        created: Date.now(),
        duration: editedDuration(snapshot.edits),
        asset,
        edits: snapshot.edits,
      };
      try {
        await saveExport(record);
      } catch (error) {
        await deleteAsset(asset).catch(() => {});
        throw error;
      }
      setResult(asset);
      setResultName(record.title);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking('');
    }
  }
  return (
    <main className="editor-page">
      {videosOpen && (
        <SavedVideos project={p} onClose={() => setVideosOpen(false)} />
      )}
      <div className="editor-header">
        <button
          className="icon-button"
          title="Back to projects"
          aria-label="Back to projects"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <input
            className="project-title"
            aria-label="Project title"
            value={p.title}
            onChange={(e) =>
              useEditor.setState((s) => ({
                project: { ...s.project!, title: e.target.value },
              }))
            }
          />
          <div className="small muted">
            {formatTime(p.duration)} original <span>·</span> {p.width} ×{' '}
            {p.height} <span>·</span>{' '}
            {saved ? (
              <>
                <Check size={11} /> Saved on this device
              </>
            ) : (
              'Saving…'
            )}
          </div>
        </div>
        <div className="spacer" />
        <Button
          variant="ghost"
          size="sm"
          title="Export editable project metadata"
          onClick={() =>
            download(
              new Blob([JSON.stringify(p, null, 2)], {
                type: 'application/json',
              }),
              `${p.title}.studio.json`
            )
          }
        >
          <Save size={15} /> Metadata
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setVideosOpen(true)}
        >
          Original & edited
        </Button>
        <Button size="sm" onClick={() => setExportOpen(true)}>
          <Download size={15} /> Export video
        </Button>
      </div>
      <div className="editor-workspace">
        <nav className="editor-tools" aria-label="Editing tools">
          {(
            [
              ['zoom', ZoomIn, 'Zoom'],
              ['camera', Camera, 'Camera'],
              ['audio', AudioLines, 'Audio'],
              ['style', Palette, 'Style'],
              ['trim', Scissors, 'Trim'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              aria-pressed={tool === id}
              className={tool === id ? 'active' : ''}
              onClick={() => setTool(id)}
            >
              <Icon size={21} strokeWidth={1.5} />
              {label}
            </button>
          ))}
        </nav>
        <aside className="inspector">
          <div className="inspector-heading">
            <h2>
              {tool === 'zoom'
                ? 'Smart zoom'
                : tool === 'camera'
                ? 'Camera & avatar'
                : tool === 'audio'
                ? 'Audio studio'
                : tool === 'trim'
                ? 'Trim & cut'
                : 'Make it yours'}
            </h2>
            <span className="small muted">
              {tool === 'zoom'
                ? 'A closer look. A clearer lesson.'
                : 'Small details. Better stories.'}
            </span>
          </div>
          {tool === 'zoom' && (
            <>
              <div className="feature-note">
                <ZoomIn size={20} />
                <p>
                  Bring the important parts into focus.
                  <span>Click the preview to place a zoom.</span>
                </p>
              </div>
              <Button
                className="full"
                variant="secondary"
                onClick={() => addZoom()}
              >
                <Plus size={15} /> Add zoom at {formatTime(time)}
              </Button>
              <div className="keyframe-list">
                {p.edits.zooms.length ? (
                  [...p.edits.zooms]
                    .sort((a, b) => a.time - b.time)
                    .map((item, i) => (
                      <button
                        className={selected === item.id ? 'selected' : ''}
                        key={item.id}
                        onClick={() => {
                          setSelected(item.id);
                          setTime(item.time);
                        }}
                      >
                        <span className="keyframe-diamond" />
                        <span>
                          Zoom {String(i + 1).padStart(2, '0')}
                          <small>
                            {formatTime(item.time)} · {item.duration.toFixed(1)}
                            s ease
                          </small>
                        </span>
                        <strong>{item.scale.toFixed(1)}×</strong>
                      </button>
                    ))
                ) : (
                  <div className="inspector-empty">
                    No zooms yet.
                    <br />
                    Let your code take center stage.
                  </div>
                )}
              </div>
              {z && (
                <>
                  <Slider
                    label="Zoom level"
                    value={z.scale}
                    min={1}
                    max={3}
                    step={0.1}
                    suffix="×"
                    onChange={(scale) => changeZoom({ scale })}
                  />
                  <Slider
                    label="Transition"
                    value={z.duration}
                    min={0.1}
                    max={3}
                    step={0.1}
                    suffix="s"
                    onChange={(duration) => changeZoom({ duration })}
                  />
                  <Field label="Starts at (seconds)">
                    <input
                      type="number"
                      min={0}
                      max={p.duration}
                      step={0.1}
                      value={Number(z.time.toFixed(2))}
                      onChange={(e) =>
                        changeZoom({
                          time: clamp(+e.target.value, 0, p.duration),
                        })
                      }
                    />
                  </Field>
                  <div className="two-fields">
                    <Slider
                      label="Focus X"
                      value={z.x}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(x) => changeZoom({ x })}
                    />
                    <Slider
                      label="Focus Y"
                      value={z.y}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(y) => changeZoom({ y })}
                    />
                  </div>
                  <button
                    className="danger-link"
                    onClick={() => {
                      edit((e) => ({
                        ...e,
                        zooms: e.zooms.filter((z) => z.id !== selected),
                      }));
                      setSelected('');
                    }}
                  >
                    <Trash2 size={14} /> Remove zoom
                  </button>
                </>
              )}
              <button className="subtle-button full" onClick={() => addZoom(1)}>
                Reset to full frame at playhead
              </button>
              <p className="inspector-footnote">
                Smooth ease-in and ease-out. Focus stays inside your source
                bounds.
              </p>
              <details>
                <summary>
                  <Sparkles size={13} /> Experimental auto zoom
                </summary>
                <p>
                  Browsers cannot read cursor coordinates or clicks in other
                  apps. Frame activity analysis is under evaluation. Use manual
                  keyframes for reliable framing.
                </p>
              </details>
            </>
          )}
          {tool === 'camera' && (
            <>
              <Toggle
                label="Show overlay"
                checked={p.edits.camera.visible}
                onChange={(visible) => update('camera', { visible })}
              />
              {!p.camera && !p.edits.avatar && (
                <p className="muted small">
                  No webcam recorded. Import a loop avatar to add an overlay.
                </p>
              )}
              <Field label="Overlay shape">
                <select
                  value={p.edits.camera.shape}
                  onChange={(e) =>
                    update('camera', {
                      shape: e.target.value as 'circle' | 'rounded',
                    })
                  }
                >
                  <option value="circle">Circle</option>
                  <option value="rounded">Rounded square</option>
                </select>
              </Field>
              <Slider
                label="Size"
                value={p.edits.camera.size}
                min={0.08}
                max={0.5}
                step={0.01}
                onChange={(size) => update('camera', { size })}
              />
              <Slider
                label="Opacity"
                value={p.edits.camera.opacity}
                min={0.1}
                max={1}
                step={0.05}
                onChange={(opacity) => update('camera', { opacity })}
              />
              <div className="corner-grid">
                {[
                  [0.17, 0.22, 'Top left'],
                  [0.83, 0.22, 'Top right'],
                  [0.17, 0.78, 'Bottom left'],
                  [0.83, 0.78, 'Bottom right'],
                ].map(([x, y, label]) => (
                  <button
                    key={label}
                    onClick={() => update('camera', { x: +x, y: +y })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Toggle
                label="Mirror camera"
                checked={p.edits.camera.mirror}
                onChange={(mirror) => update('camera', { mirror })}
              />
              <Toggle
                label="Thin border"
                checked={p.edits.camera.border}
                onChange={(border) => update('camera', { border })}
              />
              <Toggle
                label="Soft shadow"
                checked={p.edits.camera.shadow}
                onChange={(shadow) => update('camera', { shadow })}
              />
              <label className="upload-label">
                <Plus size={14} /> Import loop avatar
                <input
                  hidden
                  type="file"
                  accept="video/webm,video/mp4,video/quicktime"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      if (!f.type.startsWith('video/'))
                        throw Error('Choose a supported video file.');
                      const url = URL.createObjectURL(f);
                      let candidate: HTMLVideoElement | undefined;
                      try {
                        candidate = await loadVideo(url);
                      } finally {
                        unloadVideo(candidate);
                        URL.revokeObjectURL(url);
                      }
                      const asset = await importAsset(f);
                      edit((edits) => ({ ...edits, avatar: asset.id }));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                />
              </label>
              {p.edits.avatar && (
                <button
                  className="danger-link"
                  onClick={() => edit((e) => ({ ...e, avatar: undefined }))}
                >
                  Remove avatar
                </button>
              )}
              <p className="inspector-footnote">
                Avatar loops without audio. Transparent WebM works when
                supported by your browser.
              </p>
            </>
          )}
          {tool === 'audio' && (
            <>
              <Toggle
                label="Local voice cleanup"
                description="High-pass filter, soft gate, and compression."
                checked={p.edits.audio.enabled}
                onChange={(enabled) => update('audio', { enabled })}
              />
              <Slider
                label="Noise reduction"
                value={p.edits.audio.strength}
                min={0}
                max={1}
                step={0.05}
                onChange={(strength) => update('audio', { strength })}
              />
              <Slider
                label="Voice gain"
                value={p.edits.audio.gain}
                min={0.5}
                max={2}
                step={0.05}
                suffix="×"
                onChange={(gain) => update('audio', { gain })}
              />
              <div className="segmented">
                <button
                  className={!p.edits.audio.enabled ? 'active' : ''}
                  onClick={() => update('audio', { enabled: false })}
                >
                  Original
                </button>
                <button
                  className={p.edits.audio.enabled ? 'active' : ''}
                  onClick={() => update('audio', { enabled: true })}
                >
                  Enhanced
                </button>
              </div>
              <p className="inspector-footnote">
                Compare during playback. Cleanup reduces quiet fan/hiss noise;
                it cannot isolate every voice or background sound.
              </p>
              <Button
                variant="secondary"
                className="full"
                disabled={!analysis.levels.length}
                onClick={() => {
                  const speech = analysis.levels.filter((n) => n > 0.015);
                  if (!speech.length) {
                    setError('No active speech detected. Try manual gain.');
                    return;
                  }
                  const rms = Math.sqrt(
                    speech.reduce((sum, n) => sum + n * n, 0) / speech.length
                  );
                  update('audio', {
                    enabled: true,
                    gain: clamp(0.1 / rms, 0.5, 2),
                  });
                }}
              >
                Normalize voice volume
              </Button>
              <p className="inspector-footnote">
                Analyze first to estimate active voice level. Gain is limited to
                2×.
              </p>
              <hr />
              <h3>Give your pauses purpose</h3>
              <p className="muted small">
                Detect quiet regions locally. We leave 180ms at each edge to
                protect words.
              </p>
              <Field label="Silence workflow">
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="review">Manual review</option>
                  <option value="auto">Automatic removal · reversible</option>
                </select>
              </Field>
              <Slider
                label="Threshold"
                value={threshold}
                min={-60}
                max={-20}
                suffix=" dB"
                onChange={setThreshold}
              />
              <Slider
                label="Minimum pause"
                value={minimum}
                min={0.5}
                max={5}
                step={0.1}
                suffix="s"
                onChange={setMinimum}
              />
              <Button
                variant="secondary"
                className="full"
                disabled={!!working}
                onClick={() => void suggest()}
              >
                <AudioLines size={14} />
                {analysis.levels.length
                  ? 'Update suggestions'
                  : 'Analyze audio & waveform'}
              </Button>
              <p className="inspector-footnote">
                Streaming analysis takes about the length of your recording.
                Keep this tab visible.
              </p>
              {p.edits.silence.map((r, i) => (
                <label className="silence-row" key={i}>
                  <input
                    type="checkbox"
                    checked={selectedSilence.includes(i)}
                    onChange={(ev) =>
                      setSelectedSilence((s) =>
                        ev.target.checked ? [...s, i] : s.filter((x) => x !== i)
                      )
                    }
                  />
                  <button onClick={() => setTime(r.start)}>
                    {formatTime(r.start)} – {formatTime(r.end)}
                  </button>
                  <span>{(r.end - r.start).toFixed(1)}s</span>
                </label>
              ))}
              {p.edits.silence.length > 0 && (
                <Button
                  className="full"
                  disabled={!selectedSilence.length}
                  onClick={() =>
                    edit((e) => ({
                      ...e,
                      cuts: mergeRanges(
                        [
                          ...e.cuts,
                          ...e.silence.filter((_, i) =>
                            selectedSilence.includes(i)
                          ),
                        ],
                        e.trim
                      ),
                    }))
                  }
                >
                  <Scissors size={14} /> Remove selected pauses
                </Button>
              )}
            </>
          )}
          {tool === 'style' && (
            <>
              <div className="background-swatches">
                {[
                  '#182b29',
                  '#191c2c',
                  '#2a222b',
                  '#263141',
                  '#e5e7de',
                  '#0c1010',
                ].map((background) => (
                  <button
                    key={background}
                    aria-label={`Background ${background}`}
                    aria-pressed={p.edits.appearance.background === background}
                    style={{ background }}
                    onClick={() => update('appearance', { background })}
                  >
                    {p.edits.appearance.background === background && (
                      <Check size={17} />
                    )}
                  </button>
                ))}
              </div>
              <Field label="Custom background">
                <input
                  type="color"
                  value={p.edits.appearance.background}
                  onChange={(e) =>
                    update('appearance', { background: e.target.value })
                  }
                />
              </Field>
              <Field label="Aspect ratio">
                <select
                  value={p.edits.appearance.ratio}
                  onChange={(e) =>
                    update('appearance', { ratio: e.target.value as '16:9' })
                  }
                >
                  <option>16:9</option>
                  <option>1:1</option>
                  <option>9:16</option>
                </select>
              </Field>
              <Slider
                label="Screen padding"
                value={p.edits.appearance.padding}
                min={0}
                max={0.18}
                step={0.005}
                onChange={(padding) => update('appearance', { padding })}
              />
              <Slider
                label="Corner radius"
                value={p.edits.appearance.radius}
                min={0}
                max={60}
                onChange={(radius) => update('appearance', { radius })}
              />
              <Toggle
                label="Screen shadow"
                checked={p.edits.appearance.shadow}
                onChange={(shadow) => update('appearance', { shadow })}
              />
              <Toggle
                label="REANCODE101 watermark"
                checked={p.edits.appearance.watermark}
                onChange={(watermark) => update('appearance', { watermark })}
              />
              <Field label="Chapter title">
                <input
                  value={p.edits.appearance.title}
                  placeholder="e.g. Understanding Python lists"
                  maxLength={90}
                  onChange={(e) =>
                    update('appearance', { title: e.target.value })
                  }
                />
              </Field>
              <Toggle
                label="Show title at intro · 3s"
                checked={p.edits.appearance.intro}
                onChange={(intro) => update('appearance', { intro })}
              />
              <Toggle
                label="Show title at outro · 3s"
                checked={p.edits.appearance.outro}
                onChange={(outro) => update('appearance', { outro })}
              />
            </>
          )}
          {tool === 'trim' && (
            <>
              <p className="muted small">
                Trim using source seconds. Split at the playhead, then remove
                individual sections below.
              </p>
              <Field label="Trim start (seconds)">
                <input
                  type="number"
                  min={0}
                  max={p.edits.trim.end - 0.1}
                  step={0.1}
                  value={p.edits.trim.start}
                  onChange={(e) =>
                    update('trim', {
                      start: clamp(+e.target.value, 0, p.edits.trim.end - 0.1),
                    })
                  }
                />
              </Field>
              <Field label="Trim end (seconds)">
                <input
                  type="number"
                  min={p.edits.trim.start + 0.1}
                  max={p.duration}
                  step={0.1}
                  value={p.edits.trim.end}
                  onChange={(e) =>
                    update('trim', {
                      end: clamp(
                        +e.target.value,
                        p.edits.trim.start + 0.1,
                        p.duration
                      ),
                    })
                  }
                />
              </Field>
              <Button
                variant="secondary"
                className="full"
                onClick={() =>
                  edit((e) => ({
                    ...e,
                    splits: [...new Set([...e.splits, time])].sort(
                      (a, b) => a - b
                    ),
                  }))
                }
              >
                <Scissors size={14} /> Split at {formatTime(time)}
              </Button>
              {[
                p.edits.trim.start,
                ...p.edits.splits.filter(
                  (s) => s > p.edits.trim.start && s < p.edits.trim.end
                ),
                p.edits.trim.end,
              ]
                .sort((a, b) => a - b)
                .slice(0, -1)
                .map((start, i, all) => {
                  const end = [
                    ...p.edits.splits.filter(
                      (s) => s > start && s < p.edits.trim.end
                    ),
                    p.edits.trim.end,
                  ].sort((a, b) => a - b)[0];
                  return (
                    <div className="cut-row" key={i}>
                      <button onClick={() => setTime(start)}>
                        {formatTime(start)} – {formatTime(end)}
                      </button>
                      <button
                        aria-label={`Remove section ${i + 1}`}
                        onClick={() =>
                          edit((e) => ({
                            ...e,
                            cuts: mergeRanges(
                              [...e.cuts, { start, end }],
                              e.trim
                            ),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              <button
                className="subtle-button full"
                onClick={() =>
                  edit((e) => ({
                    ...e,
                    cuts: [],
                    splits: [],
                    trim: { start: 0, end: p.duration },
                  }))
                }
              >
                Restore full recording
              </button>
              <p className="inspector-footnote">
                Finished length: {formatTime(editedDuration(p.edits))}. Undo
                restores any removed pause or section.
              </p>
            </>
          )}
        </aside>
        <Preview
          suspended={videosOpen || exportOpen || !!working}
          project={p}
          time={time}
          setTime={setTime}
          tool={tool}
          selectedZoom={selected}
          onFocus={(x, y) =>
            z ? changeZoom({ x, y }) : addZoom(zoomPreferences.scale, x, y)
          }
          onCamera={(x, y) => update('camera', { x, y })}
        />
      </div>
      <Timeline
        project={p}
        time={time}
        setTime={setTime}
        levels={analysis.levels}
        onZoom={(id) => {
          setTool('zoom');
          setSelected(id);
        }}
      />
      {error && (
        <div className="toast error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {working && (
        <div className="processing-banner" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>
            {working} · {Math.round(progress * 100)}%
          </span>
          <progress max={1} value={progress} />
          <button onClick={() => controller.current?.abort()}>Cancel</button>
        </div>
      )}
      {exportOpen && (
        <div className="modal-backdrop">
          <section
            className="export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-heading"
          >
            <button
              className="modal-close"
              aria-label="Close export settings"
              disabled={!!working}
              onClick={() => setExportOpen(false)}
            >
              <X size={19} />
            </button>
            <div className="modal-symbol">
              <Download size={25} />
            </div>
            <h2 id="export-heading">Ready for your audience.</h2>
            <p className="muted">A little knowledge can go a long way.</p>
            <div className="two-fields">
              <Field label="Resolution">
                <select
                  disabled={!!working}
                  value={p.edits.export.height}
                  onChange={(e) =>
                    update('export', { height: +e.target.value })
                  }
                >
                  <option value={720}>720p</option>
                  <option value={1080}>1080p · Full HD</option>
                  <option value={1440}>1440p · 2K</option>
                </select>
              </Field>
              <Field label="Frame rate">
                <select
                  disabled={!!working}
                  value={p.edits.export.fps}
                  onChange={(e) => update('export', { fps: +e.target.value })}
                >
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                </select>
              </Field>
            </div>
            <Field label="Format">
              <select
                disabled={!!working}
                value={p.edits.export.format}
                onChange={(e) =>
                  update('export', { format: e.target.value as 'mp4' | 'webm' })
                }
              >
                <option value="mp4" disabled={!caps.mp4}>
                  MP4 · H.264 / AAC{!caps.mp4 ? ' · unavailable' : ''}
                </option>
                <option value="webm" disabled={!caps.webm}>
                  WebM · VP8 / Opus
                </option>
              </select>
            </Field>
            {!caps.mp4 && (
              <p className="inline-error">
                This browser cannot encode H.264/AAC MP4. Choose WebM for local
                export.
              </p>
            )}
            <Field label="Quality">
              <select
                disabled={!!working}
                value={p.edits.export.quality}
                onChange={(e) =>
                  update('export', {
                    quality: e.target.value as 'high' | 'standard',
                  })
                }
              >
                <option value="high">High · clear code and fine detail</option>
                <option value="standard">Standard · smaller file</option>
              </select>
            </Field>
            <div className="export-summary">
              <span>
                Finished duration
                <strong>{formatTime(editedDuration(p.edits))}</strong>
              </span>
              <span>
                Estimated size
                <strong>
                  ~
                  {bytes(
                    (editedDuration(p.edits) *
                      ((p.edits.export.quality === 'high' ? 12e6 : 6e6) *
                        (p.edits.export.height / 1080) ** 2 +
                        192000)) /
                      8
                  )}
                </strong>
              </span>
            </div>
            <p className="small muted">
              Export runs locally in real time. Keep this tab visible. Higher
              resolutions increase CPU use; source detail limits final
              sharpness.
            </p>
            <Button
              className="full"
              disabled={
                !!working ||
                (p.edits.export.format === 'mp4' ? !caps.mp4 : !caps.webm)
              }
              onClick={() => void exportNow()}
            >
              <Download size={16} />
              {working === 'Exporting video' ? 'Exporting…' : 'Export video'}
            </Button>
            {result && (
              <Button
                className="full"
                variant="secondary"
                onClick={() =>
                  void assetBlob(result)
                    .then((b) => download(b, resultName))
                    .catch((e) => setError(e.message))
                }
              >
                <Check size={16} /> Download finished video ·{' '}
                {bytes(result.bytes)}
              </Button>
            )}
            {result && (
              <p className="small muted">
                This export is saved with your project. Find it under All
                projects → Edited videos.
              </p>
            )}
            {working === 'Exporting video' && (
              <button
                className="subtle-button full"
                onClick={() => controller.current?.abort()}
              >
                Cancel export · {Math.round(progress * 100)}%
              </button>
            )}
            <button
              className="subtle-button full"
              onClick={() =>
                void assetBlob(p.screen)
                  .then((b) =>
                    download(
                      b,
                      `${p.title}-original.${
                        p.screen.mime.includes('mp4') ? 'mp4' : 'webm'
                      }`
                    )
                  )
                  .catch((e) => setError(e.message))
              }
            >
              Download original recording
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
