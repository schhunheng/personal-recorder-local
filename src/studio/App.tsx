import { useEffect, useRef, useState } from 'react';
import {
  Aperture,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  Mic,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Video,
  Film,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import {
  bytes,
  formatTime,
  type Project,
  type SavedExport,
} from './model';
import {
  assetBlob,
  deleteProject,
  download,
  duplicateProject,
  listProjects,
  listExports,
  localMediaURL,
  saveProject,
} from './storage';
import { loadVideo, unloadVideo } from './media';
import { useEditor, usePreferences } from './store';
import Recording from './Recording';
import { SavedVideos } from './SavedVideos';
import {
  localRequest,
  restoreLocalProject,
  type LocalProject,
} from './pipeline';
import Editor from './Editor';
import { UploadVideo } from './UploadVideo';
import { capabilities } from './capabilities';
import { useMediaPlayback } from './useMediaPlayback';
import { useDialog } from './useDialog';
import { Field, Toggle, Slider } from './controls';
function Thumbnail({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false,
      url = '',
      video: HTMLVideoElement | undefined;
    void (async () => {
      url =
        localMediaURL(project.screen) ||
        URL.createObjectURL(await assetBlob(project.screen));
      video = await loadVideo(url);
      if (!gone && ref.current) {
        const c = ref.current,
          ctx = c.getContext('2d')!;
        ctx.fillStyle = project.edits.appearance.background;
        ctx.fillRect(0, 0, c.width, c.height);
        const ratio = Math.min(
            (c.width - 24) / video.videoWidth,
            (c.height - 24) / video.videoHeight
          ),
          w = video.videoWidth * ratio,
          h = video.videoHeight * ratio;
        ctx.drawImage(video, (c.width - w) / 2, (c.height - h) / 2, w, h);
      }
    })().catch(() => {
      if (!gone) setFailed(true);
    });
    return () => {
      gone = true;
      unloadVideo(video);
      if (url) URL.revokeObjectURL(url);
    };
  }, [project.screen.id]);
  return (
    <div className="project-thumbnail">
      <canvas width={480} height={270} ref={ref} />
      {failed && (
        <span className="thumbnail-error">
          <Video size={24} /> Recover original
        </span>
      )}
      <span className="duration-badge">{formatTime(project.duration)}</span>
      {!project.complete && <span className="recovery-badge">Interrupted</span>}
    </div>
  );
}
export default function App() {
  useMediaPlayback();
  const [page, setPage] = useState<
      'dashboard' | 'record' | 'editor' | 'settings'
    >('dashboard'),
    [projects, setProjects] = useState<Project[]>([]),
    [localProjects, setLocalProjects] = useState<LocalProject[]>([]),
    [exports, setExports] = useState<SavedExport[]>([]),
    [videos, setVideos] = useState<{
      project: Project;
      initial: 'original' | 'edited';
    }>(),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [error, setError] = useState(''),
    [uploadOpen, setUploadOpen] = useState(false),
    [menu, setMenu] = useState(''),
    [confirmDelete, setConfirmDelete] = useState<Project>(),
    [storage, setStorage] = useState<StorageEstimate>(),
    [persisted, setPersisted] = useState(false);
  const open = useEditor((s) => s.open),
    current = useEditor((s) => s.project),
    preferences = usePreferences();
  useDialog(!!confirmDelete, () => setConfirmDelete(undefined));
  const [captureBusy, setCaptureBusy] = useState(false);
  const caps = capabilities();
  const refresh = () => {
    void localRequest<LocalProject[]>('/projects')
      .then(setLocalProjects)
      .catch(() => {});
    void Promise.all([listProjects(), listExports()])
      .then(([projects, exports]) => {
        setProjects(projects);
        setExports(exports);
      })
      .catch((e) => setError(`Could not open browser storage: ${e.message}`));
    void navigator.storage?.estimate?.().then(setStorage);
    void navigator.storage?.persisted?.().then(setPersisted);
  };
  useEffect(refresh, [page]);
  const total = projects.reduce(
    (s, p) => s + p.screen.bytes + (p.camera?.bytes || 0),
    exports.reduce((sum, e) => sum + e.asset.bytes, 0)
  );
  function openProject(p: Project) {
    open(p);
    setPage('editor');
  }
  const restorable = localProjects.filter(
    (p) => p.assets.screen && !projects.some((current) => current.id === p.id)
  );
  async function restoreRecording(p: LocalProject) {
    try {
      const project = await restoreLocalProject(p);
      await saveProject(project);
      refresh();
      openProject(project);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function recordingSaved(p: Project) {
    const next = {
      ...p,
      processing: { requested: preferences.automation.enabled && p.complete },
    };
    try {
      await saveProject(next);
      openProject(next);
    } catch (e) {
      setError((e as Error).message);
      openProject(p);
    }
  }
  const filtered = projects.filter(
    (p) =>
      p.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter !== 'recovery' || !p.complete)
  );
  return (
    <div className={`app-shell ${page === 'editor' ? 'editing' : ''}`}>
      <aside className="app-sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (!captureBusy) setPage('dashboard');
          }}
        >
          <div className="brand-mark">
            <Aperture size={26} strokeWidth={1.8} />
          </div>
          <div>
            REANCODE<span>101</span>
            <small>STUDIO</small>
          </div>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          <button
            disabled={captureBusy}
            className={page === 'dashboard' ? 'active' : ''}
            onClick={() => setPage('dashboard')}
          >
            <LayoutGrid size={18} /> All projects
            <span className="nav-count">{projects.length}</span>
          </button>
          <button
            disabled={captureBusy}
            className={page === 'record' ? 'active' : ''}
            onClick={() => setPage('record')}
          >
            <Video size={18} /> New recording
          </button>
          <button
            disabled={captureBusy}
            onClick={() => setUploadOpen(true)}
          >
            <ArrowDownToLine size={18} /> Upload video
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="local-card">
            <ShieldCheck size={21} />
            <strong>
              Your creativity.
              <br />
              Your device.
            </strong>
            <p>
              No cloud uploads. No accounts.
              <br />
              Just you and your next idea.
            </p>
            <span>
              <i /> 100% local
            </span>
          </div>
          <button
            disabled={captureBusy}
            className={page === 'settings' ? 'active' : ''}
            onClick={() => setPage('settings')}
          >
            <Settings2 size={17} /> Settings
          </button>
          <div className="sidebar-bottom">
            <span className="avatar">R</span>
            <span>
              REANCODE101<small>Personal workspace</small>
            </span>
            <span className="small muted">v1.0</span>
          </div>
        </div>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <span className="breadcrumb">
            Workspace <ChevronRight size={13} />{' '}
            <strong>
              {page === 'dashboard'
                ? 'All projects'
                : page === 'record'
                ? 'New recording'
                : page === 'settings'
                ? 'Settings'
                : 'Editor'}
            </strong>
          </span>
          <div className="spacer" />
          <span className="topbar-local">
            <span className="status-dot" /> Everything stays on your device
          </span>
          <span className="top-avatar">R</span>
        </header>
        {page === 'record' ? (
          <Recording
            onBusy={setCaptureBusy}
            onBack={() => setPage('dashboard')}
            onSaved={recordingSaved}
          />
        ) : page === 'editor' && current ? (
          <Editor
            onBack={() => {
              open(undefined);
              setPage('dashboard');
            }}
          />
        ) : page === 'settings' ? (
          <main className="settings-page">
            <div className="page-eyebrow">SET UP YOUR STUDIO</div>
            <h1>A space that works for you.</h1>
            <p className="page-subtitle">
              Your defaults, permissions, and local storage.
            </p>
            <div className="settings-grid">
              <section className="settings-card">
                <h2>Recording defaults</h2>
                <Field label="Default resolution">
                  <select
                    value={preferences.recording.height}
                    onChange={(e) =>
                      preferences.setRecording({ height: +e.target.value })
                    }
                  >
                    <option value={720}>720p</option>
                    <option value={1080}>1080p</option>
                    <option value={1440}>1440p</option>
                  </select>
                </Field>
                <Field label="Default frame rate">
                  <select
                    value={preferences.recording.fps}
                    onChange={(e) =>
                      preferences.setRecording({ fps: +e.target.value })
                    }
                  >
                    <option value={30}>30 FPS</option>
                    <option value={60}>60 FPS</option>
                  </select>
                </Field>
                <Toggle
                  label="Enable microphone"
                  checked={preferences.recording.mic}
                  onChange={(mic) => preferences.setRecording({ mic })}
                />
                <Toggle
                  label="Browser noise suppression"
                  checked={preferences.recording.noise}
                  onChange={(noise) => preferences.setRecording({ noise })}
                />
                <Toggle
                  label="Echo cancellation"
                  checked={preferences.recording.echo}
                  onChange={(echo) => preferences.setRecording({ echo })}
                />
                <Toggle
                  label="Automatic gain"
                  checked={preferences.recording.gain}
                  onChange={(gain) => preferences.setRecording({ gain })}
                />
                <Toggle
                  label="Enable webcam"
                  checked={preferences.recording.camera}
                  onChange={(camera) => preferences.setRecording({ camera })}
                />
              </section>
              <section className="settings-card">
                <h2>Browser capabilities</h2>
                {Object.entries({
                  'Secure context': caps.secure,
                  'Screen capture': caps.capture,
                  MediaRecorder: caps.recorder,
                  'H.264 / AAC MP4 export': caps.mp4,
                  'WebM export': caps.webm,
                  'Origin private files': caps.opfs,
                  WebCodecs: caps.webcodecs,
                  AudioWorklet: caps.audioWorklet,
                }).map(([key, available]) => (
                  <div key={key} className="capability-row">
                    <span>{key}</span>
                    <span className={available ? 'mint' : 'muted'}>
                      {available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                ))}
                <p className="small muted">
                  Chrome on macOS offers the most complete experience. Allow
                  screen recording, camera, and microphone in macOS Privacy &
                  Security when prompted.
                </p>
              </section>
              <section className="settings-card">
                <h2>Storage on this device</h2>
                <div className="storage-value">
                  {bytes(storage?.usage || 0)}
                  <span> / {bytes(storage?.quota || 0)}</span>
                </div>
                <progress
                  max={storage?.quota || 1}
                  value={storage?.usage || 0}
                />
                <p className="small muted">
                  {persisted
                    ? 'Persistent storage was granted.'
                    : 'Storage may be evicted by your browser.'}{' '}
                  Clearing site data deletes your projects. Download originals
                  and metadata as a backup.
                </p>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void navigator.storage
                      .persist()
                      .then(setPersisted)
                      .catch((e) => setError(e.message))
                  }
                >
                  <HardDrive size={15} /> Request persistent storage
                </Button>
              </section>
              <section className="settings-card">
                <h2>Zoom preferences</h2>
                <Slider
                  label="Default zoom level"
                  value={preferences.zoom.scale}
                  min={1}
                  max={3}
                  step={0.1}
                  suffix="×"
                  onChange={(scale) => preferences.setZoom({ scale })}
                />
                <Slider
                  label="Default transition"
                  value={preferences.zoom.duration}
                  min={0.1}
                  max={3}
                  step={0.1}
                  suffix="s"
                  onChange={(duration) => preferences.setZoom({ duration })}
                />
                <h3>Keyboard shortcuts</h3>
                <div className="capability-row">
                  <span>Play / pause preview</span>
                  <kbd>Space</kbd>
                </div>
                <div className="capability-row">
                  <span>Split at playhead</span>
                  <kbd>S</kbd>
                </div>
                <div className="capability-row">
                  <span>Undo / redo</span>
                  <kbd>⌘Z / ⌘⇧Z</kbd>
                </div>
                <div className="capability-row">
                  <span>Pause / stop capture</span>
                  <kbd>Alt P / Alt S</kbd>
                </div>
              </section>
            </div>
          </main>
        ) : (
          <main className="dashboard">
            <div className="dashboard-heading">
              <div>
                <div className="page-eyebrow">LESS SETUP. MORE SHARING.</div>
                <h1>Your next great lesson starts here.</h1>
                <p className="page-subtitle">
                  Record your screen. Refine your story. Share what you know.
                </p>
              </div>
              <div className="date-label">
                YOUR PERSONAL
                <br />
                <strong>CREATIVE SPACE</strong>
              </div>
            </div>
            <section className="recording-hero">
              <div className="hero-copy">
                <div className="hero-tag">
                  <span className="status-dot" /> BUILT FOR THE WAY YOU TEACH
                </div>
                <h2>
                  Good ideas deserve
                  <br />a great <span>close-up.</span>
                </h2>
                <p>
                  Turn your screen into a lesson worth watching.
                  <br />A thoughtful studio, right in your browser.
                </p>
                <div className="hero-actions">
                  <Button onClick={() => setPage('record')}>
                    <span className="record-icon" /> New recording{' '}
                    <ArrowUpRight size={17} />
                  </Button>
                  <button
                    className="hero-import"
                    onClick={() => setUploadOpen(true)}
                  >
                    <ArrowDownToLine size={16} /> Upload a video
                  </button>
                </div>
                <div className="hero-footer">
                  <span>
                    <Check size={12} /> No account needed
                  </span>
                  <span>
                    <Check size={12} /> Yours, from start to finish
                  </span>
                </div>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="art-orbit orbit-one" />
                <div className="art-orbit orbit-two" />
                <div className="code-window">
                  <div className="code-window-top">
                    <span className="traffic">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>hello_world.py</span>
                    <span>Python</span>
                  </div>
                  <div className="code-body">
                    <div>
                      <span>1</span>
                      <b># A little knowledge goes a long way.</b>
                    </div>
                    <div>
                      <span>2</span>
                    </div>
                    <div>
                      <span>3</span>
                      <em>def</em> <strong>share_what_you_know</strong>():
                    </div>
                    <div>
                      <span>4</span> idea ={' '}
                      <mark>"Something worth sharing"</mark>
                    </div>
                    <div>
                      <span>5</span> <em>return</em> create_lesson(idea)
                    </div>
                    <div>
                      <span>6</span>
                    </div>
                    <div>
                      <span>7</span>
                      <strong>share_what_you_know</strong>()
                      <i className="code-caret" />
                    </div>
                  </div>
                  <div className="art-focus">
                    <span>2.0×</span>
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
                <div className="art-recorder">
                  <span className="art-record-dot" />
                  <strong>REC</strong>
                  <span>Screen + you</span>
                  <div />
                  <Mic size={15} />
                  <Camera size={15} />
                </div>
                <div className="art-caption">
                  <Sparkles size={14} /> A clearer view of what matters.
                </div>
              </div>
            </section>
            {!!restorable.length && (
              <section className="local-recovery-panel">
                <h2>
                  <HardDrive size={18} /> Recordings saved on this Mac
                </h2>
                <p>
                  These originals are safe in the local studio workspace.
                  Restore them to this browser to edit or download.
                </p>
                {restorable.map((p) => (
                  <div key={p.id}>
                    <span>
                      {p.title}
                      <small>
                        {formatTime(p.duration)} ·{' '}
                        {new Date(p.created * 1000).toLocaleDateString()}
                      </small>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void restoreRecording(p)}
                    >
                      Restore project
                    </Button>
                  </div>
                ))}
              </section>
            )}
            <section className="projects-section">
              <div className="projects-heading">
                <h2>
                  Your projects <span>{projects.length}</span>
                </h2>
                <div className="spacer" />
                <label className="search-field">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects"
                  />
                </label>
                <button
                  className="icon-button"
                  title="Upload a video"
                  aria-label="Upload a video"
                  onClick={() => setUploadOpen(true)}
                >
                  <Plus size={19} />
                </button>
              </div>
              <p className="library-location">
                <HardDrive size={14} /> Your originals and exported edits are
                saved in this browser at{' '}
                <strong>{window.location.origin}</strong>.
              </p>
              <div className="projects-tabs">
                <button
                  className={filter === 'all' ? 'active' : ''}
                  onClick={() => setFilter('all')}
                >
                  All projects
                </button>
                <button
                  className={filter === 'recovery' ? 'active' : ''}
                  onClick={() => setFilter('recovery')}
                >
                  Recovery
                </button>
                <span className="spacer" />
                <span>
                  <HardDrive size={12} />
                  {bytes(total)} stored locally
                </span>
              </div>
              {filtered.length ? (
                <div className="project-grid">
                  {filtered.map((p) => (
                    <article className="project-card" key={p.id}>
                      <button
                        className="thumbnail-button"
                        onClick={() => openProject(p)}
                        aria-label={`Open ${p.title}`}
                      >
                        <Thumbnail project={p} />
                        <span className="thumbnail-open">
                          <FolderOpen size={19} /> Open project
                        </span>
                      </button>
                      <div className="project-card-info">
                        <button
                          className="project-name"
                          onClick={() => openProject(p)}
                        >
                          {p.title}
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Actions for ${p.title}`}
                          onClick={() => setMenu(menu === p.id ? '' : p.id)}
                        >
                          <MoreHorizontal size={19} />
                        </button>
                        {menu === p.id && (
                          <div className="project-menu">
                            <button
                              onClick={() => {
                                openProject(p);
                                setMenu('');
                              }}
                            >
                              <FolderOpen size={14} /> Open & rename
                            </button>
                            <button
                              onClick={() =>
                                void duplicateProject(p)
                                  .then(() => {
                                    refresh();
                                    setMenu('');
                                  })
                                  .catch((e) => setError(e.message))
                              }
                            >
                              <Copy size={14} /> Duplicate project
                            </button>
                            <button
                              onClick={() =>
                                void assetBlob(p.screen)
                                  .then((b) => {
                                    download(
                                      b,
                                      `${p.title}-original.${
                                        p.screen.mime.includes('mp4')
                                          ? 'mp4'
                                          : 'webm'
                                      }`
                                    );
                                    setMenu('');
                                  })
                                  .catch((e) => setError(e.message))
                              }
                            >
                              <Download size={14} /> Download original
                            </button>
                            <button
                              onClick={() => {
                                setConfirmDelete(p);
                                setMenu('');
                              }}
                            >
                              <Trash2 size={14} /> Delete project
                            </button>
                          </div>
                        )}
                      </div>
                      <div
                        className="project-video-actions"
                        aria-label={`Videos for ${p.title}`}
                      >
                        <button
                          onClick={() =>
                            setVideos({ project: p, initial: 'original' })
                          }
                        >
                          <Video size={14} /> Original
                        </button>
                        <button
                          onClick={() =>
                            setVideos({ project: p, initial: 'edited' })
                          }
                        >
                          <Film size={14} /> Edited videos{' '}
                          <span>
                            {exports.filter((e) => e.projectId === p.id).length}
                          </span>
                        </button>
                      </div>
                      <div className="project-card-meta">
                        <span>
                          {new Date(p.created).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}{' '}
                          <i>·</i> {bytes(p.screen.bytes)}
                        </span>
                        <span>
                          {p.edits.zooms.length
                            ? `${p.edits.zooms.length} zooms`
                            : 'Ready to edit'}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="projects-empty">
                  <div className="empty-visual">
                    <Clapperboard size={31} strokeWidth={1.3} />
                    <Plus size={14} />
                  </div>
                  <h3>
                    {query || filter !== 'all'
                      ? 'No projects found'
                      : 'A blank canvas. Endless possibilities.'}
                  </h3>
                  <p>
                    {query || filter !== 'all'
                      ? 'Try another search or view all your projects.'
                      : 'After you stop recording, your original appears here. Finished exports stay with the same project.'}
                  </p>
                  <button
                    onClick={() =>
                      query || filter !== 'all'
                        ? (setQuery(''), setFilter('all'))
                        : setPage('record')
                    }
                  >
                    {query || filter !== 'all'
                      ? 'View all projects'
                      : 'Create your first recording'}
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </section>
            <footer className="dashboard-footer">
              <span>
                <ShieldCheck size={14} /> Private by design. Made for sharing
                knowledge.
              </span>
              <span>
                REANCODE101 <i>✦</i> STUDIO
              </span>
            </footer>
          </main>
        )}
      </div>
      {uploadOpen && (
        <UploadVideo
          onClose={() => setUploadOpen(false)}
          onImported={(project) => {
            setUploadOpen(false);
            openProject(project);
          }}
        />
      )}
      {error && (
        <div className="toast error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {videos && (
        <SavedVideos
          project={videos.project}
          initial={videos.initial}
          onClose={() => setVideos(undefined)}
          onEdit={() => {
            const project = videos.project;
            setVideos(undefined);
            openProject(project);
          }}
        />
      )}
      {confirmDelete && (
        <div className="modal-backdrop">
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <Trash2 size={28} />
            <h2 id="delete-title">Delete this project?</h2>
            <p>
              “{confirmDelete.title}” and any media used only by this project
              will be removed from this browser. Files already saved to the
              local studio service remain on this Mac and can be restored.
            </p>
            <div className="two-fields">
              <Button
                variant="secondary"
                onClick={() => setConfirmDelete(undefined)}
              >
                Keep project
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  void deleteProject(confirmDelete)
                    .then(() => {
                      setConfirmDelete(undefined);
                      refresh();
                    })
                    .catch((e) => setError(e.message))
                }
              >
                Delete project
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
