import { useRef, useState } from 'react';
import { FileVideo, LoaderCircle, Upload, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Field, Toggle } from './controls';
import { bytes, type Project } from './model';
import {
  importVideo,
  uploadedVideoMime,
  videoAccept,
  type UploadCleanup,
} from './import';
import { useDialog } from './useDialog';

export function UploadVideo({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (project: Project) => void;
}) {
  const [file, setFile] = useState<File>();
  const [cleanup, setCleanup] = useState<UploadCleanup>({
    enabled: true,
    noise: 'balanced',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useDialog(true, () => {
    if (!busy) onClose();
  });
  function choose(next?: File) {
    if (!next || busy) return;
    setError('');
    try {
      uploadedVideoMime(next);
      setFile(next);
    } catch (error) {
      setFile(undefined);
      setError((error as Error).message);
    }
  }
  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      onImported(await importVideo(file, cleanup));
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="export-modal upload-video-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        aria-busy={busy}
      >
        <button
          className="modal-close"
          aria-label="Close video upload"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
        <div className="modal-symbol"><Upload size={23} /></div>
        <h2 id="upload-title">Upload video</h2>
        <p className="muted">
          Bring an existing video into your studio and clean up its sound.
        </p>
        <button
          type="button"
          className={`video-dropzone ${dragging ? 'dragging' : ''}`}
          disabled={busy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <FileVideo size={28} />
          <strong>{file ? file.name : 'Choose a video or drop it here'}</strong>
          <span>
            {file
              ? `${bytes(file.size)} · click to change`
              : 'MP4, MOV, WebM, OGV or supported MKV'}
          </span>
        </button>
        <input
          ref={input}
          type="file"
          aria-label="Video file"
          accept={videoAccept}
          hidden
          disabled={busy}
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Toggle
          label="AI noise cancellation"
          checked={cleanup.enabled}
          disabled={busy}
          description="Reduce background noise with a local speech model."
          onChange={(enabled) => setCleanup({ ...cleanup, enabled })}
        />
        {cleanup.enabled && (
          <Field label="Noise cancellation strength">
            <select
              value={cleanup.noise}
              disabled={busy}
              onChange={(e) => setCleanup({
                ...cleanup,
                noise: e.target.value as UploadCleanup['noise'],
              })}
            >
              <option value="light">Light · preserve more room sound</option>
              <option value="balanced">Balanced · recommended for speech</option>
              <option value="strong">Strong · maximum suppression</option>
            </select>
          </Field>
        )}
        <p className="upload-help">
          {cleanup.enabled
            ? 'Next, review cleanup settings and click Remove noise. Processing stays on this Mac and requires the local studio service. Your original is kept separately.'
            : 'Your video will open in the editor. You can enable AI noise cancellation there later.'}
        </p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <Button
          className="upload-continue"
          disabled={!file || busy}
          onClick={() => void upload()}
        >
          {busy ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}
          {busy ? 'Importing video…' : 'Continue to editor'}
        </Button>
        {busy && (
          <p className="small muted" role="status">
            Checking your video and saving the original on this device…
          </p>
        )}
      </section>
    </div>
  );
}
