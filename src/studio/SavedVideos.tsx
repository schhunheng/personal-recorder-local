import { useEffect, useState } from 'react';
import { Download, Film, Pencil, Video, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { bytes, formatTime, type Project, type SavedExport } from './model';
import { assetBlob, listExports, localMediaURL } from './storage';
import { useDialog } from './useDialog';
export function SavedVideos({
  project,
  initial = 'original',
  onClose,
  onEdit,
}: {
  project: Project;
  initial?: 'original' | 'edited';
  onClose: () => void;
  onEdit?: () => void;
}) {
  const [tab, setTab] = useState(initial),
    [versions, setVersions] = useState<SavedExport[]>([]),
    [selected, setSelected] = useState(''),
    [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useDialog(true, onClose);
  useEffect(() => {
    let active = true;
    void listExports(project.id)
      .then((exports) => {
        if (active) {
          setVersions(exports);
          setSelected(exports[0]?.id || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [project.id]);
  const exported = versions.find((e) => e.id === selected);
  const asset = tab === 'original' ? project.screen : exported?.asset;
  const name =
    tab === 'original'
      ? `${project.title}-original.${
          project.screen.mime.includes('mp4') ? 'mp4' : 'webm'
        }`
      : exported?.title;
  useEffect(() => {
    let active = true,
      objectUrl = '';
    setUrl('');
    setError('');
    setLoading(!!asset);
    try {
      if (asset && localMediaURL(asset)) {
        setUrl(localMediaURL(asset)!);
        setLoading(false);
        return;
      }
    } catch (error) {
      setError((error as Error).message);
      setLoading(false);
      return;
    }
    if (asset)
      void assetBlob(asset)
        .then((blob) => {
          if (!blob.size)
            throw Error('No playable chunks were saved for this recording.');
          objectUrl = URL.createObjectURL(blob);
          if (active) setUrl(objectUrl);
          else URL.revokeObjectURL(objectUrl);
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset?.id]);
  return (
    <div className="modal-backdrop">
      <section
        className="saved-videos-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-videos-heading"
      >
        <button
          className="modal-close"
          aria-label="Close saved videos"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="saved-videos-heading">Your recording & finished videos</h2>
        <p className="muted">{project.title}</p>
        <div className="segmented" role="group" aria-label="Video version">
          <button
            aria-pressed={tab === 'original'}
            className={tab === 'original' ? 'active' : ''}
            onClick={() => setTab('original')}
          >
            <Video size={14} /> Original recording
          </button>
          <button
            aria-pressed={tab === 'edited'}
            className={tab === 'edited' ? 'active' : ''}
            onClick={() => setTab('edited')}
          >
            <Film size={14} /> Edited videos ({versions.length})
          </button>
        </div>
        {tab === 'edited' && versions.length > 1 && (
          <label className="field">
            Saved export
            <select
              aria-label="Saved export"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {new Date(v.created).toLocaleString()} ·{' '}
                  {v.edits.export.height}p · {bytes(v.asset.bytes)}
                </option>
              ))}
            </select>
          </label>
        )}
        {url && (
          <video
            key={url}
            controls
            playsInline
            preload="metadata"
            src={url}
            aria-label={
              tab === 'original'
                ? 'Original recording playback'
                : 'Edited video playback'
            }
            onError={() =>
              setError(
                'The browser could not play this video. Download it to try another player; the saved file is still available.'
              )
            }
          />
        )}
        {loading && (
          <p role="status" className="saved-video-empty">
            Loading video…
          </p>
        )}
        {tab === 'edited' && !versions.length && (
          <div className="saved-video-empty">
            <Film size={30} />
            <h3>No finished video yet</h3>
            <p>
              Your edits are saved in the project. Choose Export video in the
              editor to create a playable edited file. Previous temporary
              exports may need to be exported again.
            </p>
          </div>
        )}
        {asset && (
          <div className="saved-video-details">
            <span>
              {formatTime(
                tab === 'original' ? project.duration : exported?.duration || 0
              )}{' '}
              · {bytes(asset.bytes)} ·{' '}
              {asset.mime.includes('mp4') ? 'MP4' : 'WebM'}
            </span>
            {exported && tab === 'edited' && (
              <span>
                Exported {new Date(exported.created).toLocaleString()}
              </span>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <div className="saved-video-actions">
          {url && (
            <Button asChild>
              <a href={url} download={name}>
                <Download size={15} /> Download{' '}
                {tab === 'original' ? 'original' : 'edited video'}
              </a>
            </Button>
          )}
          {onEdit && (
            <Button variant="secondary" onClick={onEdit}>
              <Pencil size={15} />
              {tab === 'edited' && !versions.length
                ? 'Open editor & export'
                : 'Continue editing'}
            </Button>
          )}
        </div>
        <p className="storage-location">
          {tab === 'edited' && exported?.libraryPath ? (
            <>
              Saved on your Mac:{' '}
              <strong className="recording-file-location">
                {exported.libraryPath}
              </strong>
              .
            </>
          ) : (
            <>
              Saved in this Chrome profile at{' '}
              <strong>{window.location.origin}</strong>.
            </>
          )}{' '}
          Downloads go to your browser’s chosen download folder.
        </p>
      </section>
    </div>
  );
}
