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
import { AutomationSettings } from './AutomationSettings';
import { AudioComparison } from './AudioComparison';
import {
  editingSteps,
  processingLabels,
  processingStage,
  audioReady,
  cutsChanged,
  type EditingStep,
} from './automation-flow';
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
    noise:
      prefs.options.noise === 'ai'
        ? 'balanced'
        : prefs.options.noise || defaultPipeline.noise,
  }));
  const [step, setStep] = useState<EditingStep>(0);
  const completedShown = useRef('');
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
      if (completedShown.current !== next.id) {
        completedShown.current = next.id;
        setStep(2);
      }
      setDraft(next.result.edl);
      patch({ requested: false, error: undefined });
      const record: SavedExport = {
        id: `local-${next.id}`,
        projectId: project.id,
        title:
          next.result.file_name || `${latest.current.project.title}-edited.mp4`,
        libraryPath: next.result.library_path,
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
  async function run(action: 'plan' | 'render' = 'plan', reviewed?: EDL) {
    if (busy || activePipeline(job)) return;
    setExpanded(true);
    setStep(1);
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
      const request = { ...options, action, edl: reviewed || toEDL(snapshot) };
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
            if (activePipeline(next)) {
              setStep(1);
              subscribe(next.id);
            }
          }
        })
        .catch((e) => {
          if (alive.current) setError(e.message);
        });
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
  async function saveTimeline(reviewed?: EDL) {
    try {
      const remote = await localRequest<{ version: number }>(
        `/projects/${project.id}`
      );
      await localRequest(`/projects/${project.id}/timeline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_version: remote.version,
          edl: reviewed || toEDL(latest.current.project),
        }),
      });
      setConnection('Current timeline saved to the local studio workspace.');
      if (reviewed) apply(reviewed);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const running = busy || activePipeline(job);
  const ready = job?.status === 'completed' && !!job.result;
  const stage = processingStage(job, upload);
  const changed = cutsChanged(draft, job);
  const result = job?.result;
  async function exportReviewed() {
    if (!draft) return;
    await run('render', { ...toEDL(latest.current.project), cuts: draft.cuts });
  }
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
            : ready
            ? 'Your draft is ready to review'
            : 'Four clear steps from recording to finished video'}
        </span>
        <ChevronDown size={16} />
      </button>
      {expanded && (
        <div className="guided-automation">
          <nav className="editing-stepper" aria-label="Automatic editing steps">
            {editingSteps.map((label, index) => {
              const complete =
                index === 0
                  ? !!job
                  : index === 1
                  ? ready
                  : index === 2
                  ? step === 3
                  : false;
              return (
                <button
                  key={label}
                  type="button"
                  aria-current={step === index ? 'step' : undefined}
                  disabled={
                    (index >= 2 && (!ready || running)) ||
                    (index === 3 && changed)
                  }
                  onClick={() => setStep(index as EditingStep)}
                >
                  <span
                    className={
                      complete ? 'step-number complete' : 'step-number'
                    }
                  >
                    {complete ? <Check size={15} /> : index + 1}
                  </span>
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
          <div
            className="automation-step-panel"
            role="region"
            aria-label={`${editingSteps[step]} step`}
          >
            {(error || job?.error) && (
              <p role="alert" className="inline-error">
                {error || job?.error}
              </p>
            )}
            {connection && (
              <p role="status" className="muted small">
                {connection}
              </p>
            )}
            {step === 0 && (
              <>
                <div className="step-introduction">
                  <h3>1. Choose your sound and editing style</h3>
                  <p>
                    Review your settings, then click Auto edit to clean your
                    voice and create a draft. Your originals stay intact.
                  </p>
                </div>
                <AutomationSettings
                  options={options}
                  caps={caps}
                  microphone={!!project.microphone}
                  disabled={running}
                  onChange={update}
                />
                <div className="automation-actions step-actions">
                  <Button disabled={running} onClick={() => void run('plan')}>
                    <Sparkles size={15} />
                    Auto edit
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={running}
                    onClick={() => void run('render')}
                  >
                    Export current timeline to MP4
                  </Button>
                  {running && (
                    <Button variant="secondary" onClick={() => setStep(1)}>
                      View progress
                    </Button>
                  )}
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="step-introduction">
                  <h3>2. Follow your edit as it happens</h3>
                  <p>
                    Each stage below reflects the local worker. You can listen
                    once voice cleanup finishes.
                  </p>
                </div>
                <ol
                  className="processing-checklist"
                  aria-label="Processing stages"
                >
                  {processingLabels.map((label, index) => (
                    <li
                      key={label}
                      className={
                        stage > index
                          ? 'done'
                          : stage === index
                          ? 'current'
                          : ''
                      }
                      aria-current={stage === index ? 'step' : undefined}
                    >
                      <span>
                        {stage > index ? (
                          <Check size={16} />
                        ) : stage === index && running ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <div>
                        <strong>
                          {index === 3 && job?.options.action === 'render'
                            ? 'Use reviewed timeline'
                            : label}
                        </strong>
                        {stage === index && (
                          <small>
                            {upload !== undefined
                              ? 'Saving original files to this Mac'
                              : job?.stage}
                          </small>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                {running && (
                  <div className="pipeline-progress" role="status">
                    <span>
                      {upload !== undefined
                        ? 'Saving originals'
                        : 'Current stage'}
                    </span>
                    {upload !== undefined || job?.progress != null ? (
                      <>
                        <progress
                          max={100}
                          value={
                            upload !== undefined
                              ? upload * 100
                              : job?.progress || 0
                          }
                        />
                        <span>
                          {Math.round(
                            upload !== undefined
                              ? upload * 100
                              : job?.progress || 0
                          )}
                          %
                        </span>
                      </>
                    ) : (
                      <span>Working…</span>
                    )}
                  </div>
                )}
                {audioReady(job) && job && <AudioComparison job={job} />}
                <div className="automation-actions step-actions">
                  {running ? (
                    <Button variant="destructive" onClick={() => void cancel()}>
                      <X size={15} />
                      Cancel processing
                    </Button>
                  ) : ready ? (
                    <Button onClick={() => setStep(2)}>
                      Next: review your video
                    </Button>
                  ) : (
                    <Button onClick={() => setStep(0)}>Back to settings</Button>
                  )}
                </div>
                <p className="inspector-footnote">
                  If your voice sounds thin or distorted, cancel and retry with
                  Light or a lower cleanup amount. Previous finished versions
                  are kept.
                </p>
              </>
            )}
            {step === 2 && ready && result && job && (
              <>
                <div className="step-introduction">
                  <h3>3. Listen, watch and review cuts</h3>
                  <p>
                    This preview is the last rendered draft. Adjust the proposed
                    cuts below, then export to include your changes.
                  </p>
                </div>
                <div className="guided-review-layout">
                  <div className="automation-review">
                    <div
                      className="segmented"
                      role="group"
                      aria-label="Video comparison source"
                    >
                      <button
                        aria-pressed={preview === 'processed'}
                        className={preview === 'processed' ? 'active' : ''}
                        onClick={() => setPreview('processed')}
                      >
                        Edited preview
                      </button>
                      <button
                        aria-pressed={preview === 'original'}
                        className={preview === 'original' ? 'active' : ''}
                        onClick={() => setPreview('original')}
                      >
                        Original
                      </button>
                    </div>
                    <video
                      key={`${job.id}-${preview}`}
                      controls
                      playsInline
                      preload="metadata"
                      src={
                        preview === 'processed'
                          ? result.video_url
                          : `/api/studio/projects/${project.id}/assets/screen`
                      }
                      aria-label={
                        preview === 'processed'
                          ? 'Automatic edited preview'
                          : 'Original unedited preview'
                      }
                    />
                    <p className="automatic-result-meta">
                      {formatTime(result.duration)} · {result.width} ×{' '}
                      {result.height} · {bytes(result.bytes)}
                    </p>
                    <AudioComparison job={job} />
                  </div>
                  <div className="review-cuts-panel">
                    <h3>Suggested cuts</h3>
                    <p className="muted small">
                      Uncheck a region to keep it in your lesson.
                    </p>
                    <div className="draft-cuts">
                      {draft?.cuts.length ? (
                        draft.cuts.map((cut) => (
                          <label key={cut.id}>
                            <input
                              type="checkbox"
                              checked={cut.accepted}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  cuts: draft.cuts.map((item) =>
                                    item.id === cut.id
                                      ? {
                                          ...item,
                                          accepted: event.target.checked,
                                        }
                                      : item
                                  ),
                                })
                              }
                            />
                            <span>
                              {formatTime(cut.start)} – {formatTime(cut.end)}
                            </span>
                            <small>
                              {cut.reason} · {(cut.end - cut.start).toFixed(1)}s
                            </small>
                          </label>
                        ))
                      ) : (
                        <p className="muted small">
                          No pauses or marked retakes need removal.
                        </p>
                      )}
                    </div>
                    {draft && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          apply({
                            ...toEDL(latest.current.project),
                            cuts: draft.cuts,
                          })
                        }
                      >
                        <Check size={14} />
                        Apply reviewed cuts to timeline
                      </Button>
                    )}
                    {changed && (
                      <p className="pipeline-warning">
                        Your cut choices changed. Export the reviewed video to
                        update the preview and download.
                      </p>
                    )}
                    <div className="automation-actions">
                      <Button
                        variant={changed ? 'default' : 'secondary'}
                        disabled={running}
                        onClick={() => void exportReviewed()}
                      >
                        Export reviewed video
                      </Button>
                      {project.processing?.jobId && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void saveTimeline(
                              draft
                                ? {
                                    ...toEDL(latest.current.project),
                                    cuts: draft.cuts,
                                  }
                                : undefined
                            )
                          }
                        >
                          Save timeline on Mac
                        </Button>
                      )}
                    </div>
                    {result.warnings.map((warning, index) => (
                      <p className="pipeline-warning" key={index}>
                        {warning}
                      </p>
                    ))}
                    {caps && !caps.subtitle_burn && (
                      <p className="inspector-footnote">
                        MP4 text overlays require a libass-capable FFmpeg. Use
                        SRT or browser export for captions when unavailable.
                      </p>
                    )}
                  </div>
                </div>
                <div className="automation-actions step-actions">
                  <Button variant="secondary" onClick={() => setStep(0)}>
                    Adjust cleanup settings
                  </Button>
                  <Button disabled={changed} onClick={() => setStep(3)}>
                    Next: download video
                  </Button>
                </div>
              </>
            )}
            {step === 3 && ready && result && (
              <div className="finished-video-step">
                <span className="finished-check">
                  <Check size={24} />
                </span>
                <h3>4. Your edited video is ready</h3>
                <p>{project.title}</p>
                <p className="automatic-result-meta">
                  {formatTime(result.duration)} · {result.width} ×{' '}
                  {result.height} · {bytes(result.bytes)}
                </p>
                <div className="automation-actions">
                  <Button asChild>
                    <a
                      href={result.video_url}
                      download={
                        result.file_name || `${project.title}-edited.mp4`
                      }
                    >
                      <Download size={16} />
                      Download MP4
                    </a>
                  </Button>
                  <Button variant="secondary" onClick={() => setStep(2)}>
                    <Play size={15} />
                    Review again
                  </Button>
                </div>
                {result.library_path && (
                  <p className="recording-file-location">
                    Saved on your Mac: <strong>{result.library_path}</strong>
                  </p>
                )}
                <p className="inspector-footnote">
                  Find this version again under All projects → Edited videos.
                  Creating another edit keeps this one.
                </p>
                <div className="automation-actions">
                  <a href={result.edl_url} download>
                    Download edit decisions
                  </a>
                  {!!result.edl.captions.length && (
                    <a href={result.srt_url} download>
                      Download subtitles (SRT)
                    </a>
                  )}
                  <button className="subtle-button" onClick={() => setStep(0)}>
                    Create another version
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
