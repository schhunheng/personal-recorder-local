import { useRef, useState } from 'react';
import type { LocalJob } from './pipeline';
export function AudioComparison({ job }: { job: LocalJob }) {
  const [variant, setVariant] = useState<'original_audio' | 'cleaned_audio'>(
    'cleaned_audio'
  );
  const audio = useRef<HTMLAudioElement>(null),
    time = useRef(0),
    resume = useRef(false);
  function select(next: typeof variant) {
    if (variant === next) return;
    time.current = audio.current?.currentTime || 0;
    resume.current = !!audio.current && !audio.current.paused;
    audio.current?.pause();
    setVariant(next);
  }
  return (
    <section
      className="audio-comparison"
      aria-label="Compare noise cancellation"
    >
      <h3>Listen to your voice cleanup</h3>
      <p>
        Switch at the same moment to compare. Listen to quiet words as well as
        background noise.
      </p>
      <div
        className="segmented"
        role="group"
        aria-label="Audio comparison source"
      >
        <button
          type="button"
          aria-pressed={variant === 'original_audio'}
          className={variant === 'original_audio' ? 'active' : ''}
          onClick={() => select('original_audio')}
        >
          Original audio
        </button>
        <button
          type="button"
          aria-pressed={variant === 'cleaned_audio'}
          className={variant === 'cleaned_audio' ? 'active' : ''}
          onClick={() => select('cleaned_audio')}
        >
          Cleaned voice
        </button>
      </div>
      <audio
        ref={audio}
        key={`${job.id}-${variant}`}
        controls
        preload="metadata"
        src={`/api/studio/jobs/${job.id}/files/${variant}`}
        aria-label={
          variant === 'original_audio'
            ? 'Original audio comparison'
            : 'Cleaned audio comparison'
        }
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          element.currentTime = Math.min(
            time.current,
            Number.isFinite(element.duration)
              ? Math.max(0, element.duration - 0.01)
              : time.current
          );
          if (resume.current) void element.play().catch(() => {});
        }}
      />
      {job.result?.audio?.model ? (
        <div className="audio-engine-used">
          <strong>Used: {job.result.audio.model}</strong>
          <span>
            {job.result.audio.source === 'microphone'
              ? 'Independent microphone'
              : 'Original recording mix'}{' '}
            · voice gain {job.result.audio.gain_db > 0 ? '+' : ''}
            {job.result.audio.gain_db} dB
          </span>
          {job.result.audio.fallback_reason && (
            <span className="pipeline-warning">
              Fallback: {job.result.audio.fallback_reason}
            </span>
          )}
        </div>
      ) : (
        job.status === 'completed' && (
          <p className="inspector-footnote">
            This older export did not record its audio model. Create a new draft
            to use the current cleanup settings.
          </p>
        )
      )}
    </section>
  );
}
