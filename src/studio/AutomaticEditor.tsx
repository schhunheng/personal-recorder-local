import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Field, Slider, Toggle } from './controls';
import type { Project, Edits, SavedExport } from './model';
import { bytes, formatTime } from './model';
import { saveExport } from './storage';
import { useEditor, usePreferences } from './store';
import {
  applyEDL,
  activePipeline,
  defaultPipeline,
  localRequest,
  startPipeline,
  toEDL,
  watchJob,
  type EDL,
  type LocalJob,
  type PipelineCapabilities,
  type PipelineOptions,
} from './pipeline';
export function AutomaticEditor({
  project,
  onEdits,
}: {
  project: Project;
  onEdits: (edits: Edits) => void;
}) {
  const prefs = usePreferences((s) => s.automation),
    setPrefs = usePreferences((s) => s.setAutomation);
  const [options, setOptions] = useState<PipelineOptions>(() => ({
    ...defaultPipeline,
    ...prefs.options,
  }));
  const [expanded, setExpanded] = useState(
      !!project.processing?.requested || !!project.processing?.jobId
    ),
    [caps, setCaps] = useState<PipelineCapabilities>(),
    [job, setJob] = useState<LocalJob>(),
    [draft, setDraft] = useState<EDL>(),
    [busy, setBusy] = useState(false),
    [upload, setUpload] = useState<number>(),
    [error, setError] = useState(''),
    [connection, setConnection] = useState(''),
    [preview, setPreview] = useState<'original' | 'processed'>('processed');
  const latest = useRef({ project, onEdits });
  latest.current = { project, onEdits };
  const controller = useRef<AbortController | undefined>(undefined),
    stopWatch = useRef<(() => void) | undefined>(undefined),
    alive = useRef(true),
    startingEdits = useRef('');
  const submitted = useRef(false);
  function patch(values: Partial<NonNullable<Project['processing']>>) {
    useEditor.setState((state) =>
      state.project?.id === project.id
        ? {
            project: {
              ...state.project,
              processing: { ...state.project.processing, ...values },
            },
          }
        : state
    );
  }
  function update(values: Partial<PipelineOptions>) {
    setOptions((o) => ({ ...o, ...values }));
    setPrefs({ options: { ...options, ...values } });
  }
  function apply(edl: EDL, source = job) {
    if (!source) return;
    const current = latest.current.project;
    latest.current.onEdits({
      ...applyEDL(current.edits, edl),
      waveform: source.result?.waveform.levels.length
        ? source.result.waveform
        : current.edits.waveform,
      export: {
        ...current.edits.export,
        format: 'mp4',
        height: source.result?.height || source.options.height,
        fps: source.options.fps,
        quality: source.options.quality,
      },
    });
    patch({ appliedJobId: source.id });
  }
  async function receive(next: LocalJob) {
    if (!alive.current) return;
    setJob(next);
    setConnection('');
    if (next.status === 'completed' && next.result) {
      setDraft(next.result.edl);
      patch({ requested: false, error: undefined });
      const record: SavedExport = {
        id: `local-${next.id}`,
        projectId: project.id,
        title: `${latest.current.project.title}-edited.mp4`,
        created: Math.round(next.created * 1000),
        duration: next.result.duration,
        asset: {
          id: next.id,
          storage: 'local-api',
          url: next.result.video_url,
          mime: 'video/mp4',
          bytes: next.result.bytes,
        },
        edits: { ...applyEDL(latest.current.project.edits, next.result.edl) },
      };
      try {
        await saveExport(record);
      } catch (e) {
        if (alive.current)
          setError(
            'The edited file is safe on your Mac, but the browser library could not save its reference. ' +
              (e as Error).message
          );
      }
      if (
        alive.current &&
        latest.current.project.processing?.appliedJobId !== next.id &&
        startingEdits.current &&
        JSON.stringify(latest.current.project.edits) === startingEdits.current
      )
        apply(next.result.edl, next);
    } else if (next.status === 'failed' || next.status === 'cancelled')
      patch({ requested: false, error: next.error });
  }
  function subscribe(id: string) {
    stopWatch.current?.();
    stopWatch.current = watchJob(
      id,
      (next) => void receive(next),
      (message) => {
        if (alive.current) setConnection(message);
      }
    );
  }
  async function run(action: 'plan' | 'render' = 'plan') {
    if (busy || activePipeline(job)) return;
    setExpanded(true);
    setBusy(true);
    setError('');
    setUpload(0);
    controller.current = new AbortController();
    startingEdits.current = JSON.stringify(latest.current.project.edits);
    try {
      const capability = await localRequest<PipelineCapabilities>(
        '/capabilities'
      );
      setCaps(capability);
      if (!capability.ready)
        throw Error(
          'FFmpeg is not installed. Install it and restart the local studio service.'
        );
      const snapshot = structuredClone(latest.current.project);
      const request = { ...options, action, edl: toEDL(snapshot) };
      const next = await startPipeline(
        snapshot,
        request,
        controller.current.signal,
        (p) => {
          if (alive.current) setUpload(p);
        }
      );
      patch({ requested: false, jobId: next.id, error: undefined });
      if (alive.current) {
        setJob(next);
        setUpload(undefined);
        subscribe(next.id);
      }
    } catch (e) {
      if (alive.current) {
        const message =
          (e as Error).name === 'AbortError'
            ? 'Saving cancelled. Browser originals retained.'
            : (e as Error).message;
        setError(message);
        patch({ requested: false, error: message });
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        setUpload(undefined);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void localRequest<PipelineCapabilities>('/capabilities')
      .then((value) => {
        if (alive.current) setCaps(value);
      })
      .catch(() => {});
    if (project.processing?.jobId) {
      void localRequest<LocalJob>(`/jobs/${project.processing.jobId}`)
        .then((next) => {
          if (alive.current) {
            void receive(next);
            if (activePipeline(next)) subscribe(next.id);
          }
        })
        .catch((e) => {
          if (alive.current) setError(e.message);
        });
    } else if (project.processing?.requested && !submitted.current) {
      submitted.current = true;
      void run();
    }
    return () => {
      alive.current = false;
      controller.current?.abort();
      stopWatch.current?.();
    };
  }, [project.id]);
  async function cancel() {
    controller.current?.abort();
    if (job && activePipeline(job))
      try {
        await localRequest(`/jobs/${job.id}/cancel`, { method: 'POST' });
      } catch (e) {
        setError((e as Error).message);
      }
  }
  async function saveTimeline() {
    try {
      const remote = await localRequest<{ version: number }>(
        `/projects/${project.id}`
      );
      await localRequest(`/projects/${project.id}/timeline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_version: remote.version,
          edl: toEDL(latest.current.project),
        }),
      });
      setConnection('Current timeline saved to the local studio workspace.');
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const running = busy || activePipeline(job);
  return (
    <section className="automatic-editor">
      <button
        className="automation-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Sparkles size={17} />
        <strong>Automatic editor</strong>
        <span>
          {running
            ? job?.stage || 'Saving originals to this Mac'
            : job?.status === 'completed'
            ? 'Draft ready to review'
            : 'Clean audio. Thoughtful cuts. Ready to share.'}
        </span>
        <ChevronDown size={16} />
      </button>
      {expanded && (
        <div className="automation-body">
          <div className="automation-settings">
            <Field label="Editing preset">
              <select
                value={options.preset}
                disabled={running}
                onChange={(e) =>
                  update({
                    preset: e.target.value as PipelineOptions['preset'],
                    profile: e.target.value === 'social' ? 'vertical' : 'lms',
                  })
                }
              >
                <option value="clean">Clean Tutorial</option>
                <option value="professional">Professional Tutorial</option>
                <option value="social">Social Media Short</option>
              </select>
            </Field>
            <Field label="Noise cleanup">
              <select
                value={options.noise}
                disabled={running}
                onChange={(e) =>
                  update({ noise: e.target.value as PipelineOptions['noise'] })
                }
              >
                <option value="off">Off</option>
                <option value="light">Light</option>
                <option value="balanced">Balanced</option>
                <option value="strong">Strong</option>
                <option value="ai">Local AI · FFmpeg fallback</option>
              </select>
            </Field>
            <Field label="Export profile">
              <select
                value={options.profile}
                disabled={running}
                onChange={(e) =>
                  update({
                    profile: e.target.value as PipelineOptions['profile'],
                  })
                }
              >
                <option value="lms">YouTube / LMS · 1920 × 1080</option>
                <option value="vertical">Reels / TikTok · 1080 × 1920</option>
              </select>
            </Field>
            <Field label="Speech detection">
              <select
                value={options.vad}
                disabled={running}
                onChange={(e) =>
                  update({ vad: e.target.value as PipelineOptions['vad'] })
                }
              >
                <option value="auto">
                  Silero when installed · energy fallback
                </option>
                <option value="silero" disabled={!caps?.silero}>
                  Silero VAD{!caps?.silero ? ' · not installed' : ''}
                </option>
                <option value="energy">
                  Energy-based · manual review advised
                </option>
              </select>
            </Field>
            <Field label="Encoding quality">
              <select
                value={options.quality}
                disabled={running}
                onChange={(e) =>
                  update({ quality: e.target.value as 'high' | 'standard' })
                }
              >
                <option value="high">High · clear code</option>
                <option value="standard">Standard · smaller output</option>
              </select>
            </Field>
            <Slider
              label="Maximum bitrate"
              value={options.bitrate_mbps}
              min={2}
              max={30}
              step={1}
              suffix=" Mbps"
              onChange={(bitrate_mbps) => update({ bitrate_mbps })}
            />
            {options.preset === 'social' && (
              <>
                <Slider
                  label="Highlight length"
                  min={15}
                  max={90}
                  step={5}
                  value={options.clip_seconds}
                  suffix="s"
                  onChange={(clip_seconds) => update({ clip_seconds })}
                />
                <p className="inspector-footnote">
                  Selects a range around your first Important marker, or the
                  beginning when there is no marker. Review the range; this is
                  not semantic highlight detection.
                </p>
              </>
            )}
            <Slider
              label="Minimum silence"
              min={0.5}
              max={5}
              step={0.1}
              value={options.minimum_silence}
              suffix="s"
              onChange={(minimum_silence) => update({ minimum_silence })}
            />
            <Slider
              label="Speech padding"
              min={0.1}
              max={0.8}
              step={0.05}
              value={options.speech_padding}
              suffix="s"
              onChange={(speech_padding) => update({ speech_padding })}
            />
            <Toggle
              label="Normalize voice loudness"
              checked={options.normalize}
              disabled={running}
              onChange={(normalize) => update({ normalize })}
            />
            <Toggle
              label="Apply pause cuts to initial draft"
              checked={options.accept_silence}
              disabled={running}
              onChange={(accept_silence) => update({ accept_silence })}
            />
            <Toggle
              label="Offline Khmer / English captions"
              description={
                caps?.whisper
                  ? 'Local model ready. Drafts require review.'
                  : 'Install an offline Whisper model to enable transcription.'
              }
              checked={options.transcribe}
              disabled={running || !caps?.whisper}
              onChange={(transcribe) => update({ transcribe })}
            />
            <Field label="Transcription language">
              <select
                value={options.language}
                disabled={running || !caps?.whisper}
                onChange={(e) =>
                  update({
                    language: e.target.value as PipelineOptions['language'],
                  })
                }
              >
                <option value="km">Khmer</option>
                <option value="en">English</option>
                <option value="auto">Detect language</option>
              </select>
            </Field>
            {caps && !caps.subtitle_burn && (
              <p className="pipeline-warning">
                This FFmpeg build cannot burn text overlays. MP4 editing works;
                use SRT or the browser export for text overlays.
              </p>
            )}
            <div className="automation-actions">
              <Button disabled={running} onClick={() => void run('plan')}>
                <Sparkles size={15} /> Create automatic draft
              </Button>
              <Button
                variant="secondary"
                disabled={running}
                onClick={() => void run('render')}
              >
                <Download size={15} /> Export current timeline to MP4
              </Button>
              {project.processing?.jobId && (
                <Button
                  variant="ghost"
                  disabled={running}
                  onClick={() => void saveTimeline()}
                >
                  Save timeline on Mac
                </Button>
              )}
              {running && (
                <Button variant="destructive" onClick={() => void cancel()}>
                  <X size={15} /> Cancel
                </Button>
              )}
            </div>
            <p className="inspector-footnote">
              Only this Mac’s localhost service receives media. Original files
              and previous results are preserved. No cursor positions or clicks
              from other desktop apps are inferred. Noise cleanup cannot
              reliably remove all competing voices, animals, or room echo.
            </p>
          </div>
          <div className="automation-review">
            {running && (
              <div className="pipeline-progress" role="status">
                <LoaderCircle className="spin" size={17} />
                <span>
                  {upload !== undefined
                    ? 'Saving originals to this Mac'
                    : job?.stage}
                </span>
                {(upload !== undefined || job?.progress != null) && (
                  <>
                    <progress
                      max={100}
                      value={
                        upload !== undefined ? upload * 100 : job?.progress || 0
                      }
                    />
                    <span>
                      {Math.round(
                        upload !== undefined ? upload * 100 : job?.progress || 0
                      )}
                      %
                    </span>
                  </>
                )}
              </div>
            )}
            {connection && <p className="muted small">{connection}</p>}
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            {job?.error && (
              <p role="alert" className="inline-error">
                {job.error}
              </p>
            )}
            {!job && !running && (
              <div className="automatic-empty">
                <Sparkles size={27} />
                <h3>Your first cut, taken care of.</h3>
                <p>
                  Save originals → clean audio → detect pauses → compose →
                  review. Start the local service with{' '}
                  <code>npm run dev:all</code>.
                </p>
              </div>
            )}
            {job?.result && (
              <>
                <div className="segmented">
                  <button
                    className={preview === 'processed' ? 'active' : ''}
                    onClick={() => setPreview('processed')}
                  >
                    Edited preview
                  </button>
                  <button
                    className={preview === 'original' ? 'active' : ''}
                    onClick={() => setPreview('original')}
                  >
                    Original
                  </button>
                </div>
                <video
                  controls
                  playsInline
                  preload="metadata"
                  src={
                    preview === 'processed'
                      ? job.result.video_url
                      : `/api/studio/projects/${project.id}/assets/screen`
                  }
                  aria-label={
                    preview === 'processed'
                      ? 'Automatic edited preview'
                      : 'Original unedited preview'
                  }
                />
                <div className="automatic-result-meta">
                  <span>
                    {formatTime(job.result.duration)} · {job.result.width} ×{' '}
                    {job.result.height} · {bytes(job.result.bytes)}
                  </span>
                  <a
                    href={job.result.video_url}
                    download={`${project.title}-edited.mp4`}
                  >
                    <Download size={14} /> Download MP4
                  </a>
                </div>
                <details>
                  <summary>Compare original and cleaned audio</summary>
                  <label className="field">
                    Original audio
                    <audio
                      controls
                      preload="none"
                      src={`/api/studio/jobs/${job.id}/files/original_audio`}
                    />
                  </label>
                  <label className="field">
                    Cleaned audio
                    <audio
                      controls
                      preload="none"
                      src={`/api/studio/jobs/${job.id}/files/cleaned_audio`}
                    />
                  </label>
                </details>
                {job.result.warnings.map((warning, i) => (
                  <p className="pipeline-warning" key={i}>
                    {warning}
                  </p>
                ))}
                {draft && (
                  <>
                    <h3>Review suggested cuts</h3>
                    <div className="draft-cuts">
                      {draft.cuts.length ? (
                        draft.cuts.map((c) => (
                          <label key={c.id}>
                            <input
                              type="checkbox"
                              checked={c.accepted}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  cuts: draft.cuts.map((item) =>
                                    item.id === c.id
                                      ? { ...item, accepted: e.target.checked }
                                      : item
                                  ),
                                })
                              }
                            />
                            <span>
                              {formatTime(c.start)} – {formatTime(c.end)}
                            </span>
                            <small>
                              {c.reason} · {(c.end - c.start).toFixed(1)}s
                            </small>
                          </label>
                        ))
                      ) : (
                        <p className="muted small">
                          No pauses or marked retakes need removal.
                        </p>
                      )}
                    </div>
                    <Button variant="secondary" onClick={() => apply(draft)}>
                      <Check size={14} /> Apply reviewed draft to timeline
                    </Button>
                    <p className="inspector-footnote">
                      Uncheck a cut to restore it, then apply and export the
                      current timeline. Undo restores the previous edits. This
                      preview shows the last rendered draft.
                    </p>
                  </>
                )}
                <div className="automation-actions">
                  <a href={job.result.edl_url} download>
                    Download EDL
                  </a>
                  {!!job.result.edl.captions.length && (
                    <a href={job.result.srt_url} download>
                      Download SRT
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
