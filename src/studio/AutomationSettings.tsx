import { Field, Slider, Toggle } from './controls';
import type { PipelineCapabilities, PipelineOptions } from './pipeline';
export function AutomationSettings({
  options,
  caps,
  microphone,
  audioOnly = false,
  disabled,
  onChange,
}: {
  options: PipelineOptions;
  caps?: PipelineCapabilities;
  microphone: boolean;
  audioOnly?: boolean;
  disabled: boolean;
  onChange: (patch: Partial<PipelineOptions>) => void;
}) {
  const selected = options.noise_engine || 'auto';
  const engine = caps?.audio_engines?.find(
    (e) =>
      e.id === (selected === 'auto' ? caps.recommended_audio_engine : selected)
  );
  const landscapeWidth = Math.round(options.height * 16 / 9 / 2) * 2;
  return (
    <div className="automation-settings guided-settings">
      {!audioOnly && (
        <Field label="Editing preset">
          <select
            value={options.preset}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                preset: e.target.value as PipelineOptions['preset'],
                profile: e.target.value === 'social' ? 'vertical' : 'lms',
              })
            }
          >
            <option value="clean">Clean Tutorial · natural pacing</option>
            <option value="professional">
              Professional Tutorial · cuts and zooms
            </option>
            <option value="social">
              Social Media Short · vertical highlight
            </option>
          </select>
        </Field>
      )}
      <Field label="Export profile">
        <select
          value={options.profile}
          disabled={disabled}
          onChange={(e) =>
            onChange({ profile: e.target.value as PipelineOptions['profile'] })
          }
        >
          <option value="lms">YouTube / LMS · {landscapeWidth} × {options.height}</option>
          <option value="vertical">Reels / TikTok · {options.height} × {landscapeWidth}</option>
        </select>
      </Field>
      <Field label="Noise reduction">
        <select
          value={options.noise === 'ai' ? 'balanced' : options.noise}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              noise: e.target.value as PipelineOptions['noise'],
              noise_strength: null,
            })
          }
        >
          <option value="off">Off · no noise reduction</option>
          <option value="light">Light · preserve more room sound</option>
          <option value="balanced">Balanced · speech cleanup</option>
          <option value="strong">Strong · maximum suppression</option>
        </select>
      </Field>
      <Field label="Noise cancellation model">
        <select
          value={selected}
          disabled={disabled || options.noise === 'off'}
          onChange={(e) =>
            onChange({
              noise_engine: e.target.value as PipelineOptions['noise_engine'],
              noise: options.noise === 'ai' ? 'balanced' : options.noise,
            })
          }
        >
          <option value="auto">Automatic · best available local model</option>
          {['rnnoise', 'deepfilter', 'spectral'].map((id) => {
            const item = caps?.audio_engines?.find((e) => e.id === id);
            return (
              <option key={id} value={id} disabled={!item?.available}>
                {item?.label ||
                  {
                    rnnoise: 'RNNoise 0.2',
                    deepfilter: 'DeepFilterNet',
                    spectral: 'FFmpeg spectral',
                  }[id as 'rnnoise']}
                {item?.available ? '' : ' · unavailable'}
              </option>
            );
          })}
        </select>
      </Field>
      <div className="audio-model-status" role="status">
        <strong>
          {options.noise === 'off'
            ? 'Original audio'
            : engine?.label || 'Checking local audio models…'}
        </strong>
        <span>
          {options.noise === 'off'
            ? 'Noise suppression is disabled.'
            : engine?.reason ||
              'Start the local service to check model availability.'}
        </span>
        {selected === 'auto' && engine?.id === 'spectral' && (
          <span className="pipeline-warning">
            A neural model is not available. This run will use basic cleanup.
          </span>
        )}
      </div>
      <Field label="Audio source">
        <select
          value={options.audio_source || 'auto'}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              audio_source: e.target.value as PipelineOptions['audio_source'],
            })
          }
        >
          <option value="auto">
            Automatic · independent microphone when available
          </option>
          <option value="microphone" disabled={!microphone}>
            Independent microphone{microphone ? '' : ' · not recorded'}
          </option>
          <option value="screen">
            Original recording mix · microphone + captured system audio
          </option>
        </select>
      </Field>
      <div className="audio-source-hint">
        {microphone && options.audio_source !== 'screen'
          ? 'Uses your separate microphone track for clearer narration. Captured tab/system sound is left out.'
          : 'Cleans the audio in your uploaded video or original recording mix. Background voices can remain.'}
      </div>
      <Toggle
        label="Normalize voice volume"
        description="Steady gain, with boosts limited to 6 dB to protect speech and avoid amplifying residual noise."
        checked={options.normalize}
        disabled={disabled}
        onChange={(normalize) => onChange({ normalize })}
      />
      {!audioOnly && (
        <Toggle
          label="Preselect suggested pause cuts"
          description="Review or restore each proposed removal before downloading."
          checked={options.accept_silence}
          disabled={disabled}
          onChange={(accept_silence) => onChange({ accept_silence })}
        />
      )}
      <details className="automation-advanced">
        <summary>
          {audioOnly
            ? 'Fine-tune cleanup and encoding'
            : 'Fine-tune cleanup, cuts and captions'}
        </summary>
        <fieldset disabled={disabled}>
          {engine?.id !== 'spectral' && options.noise !== 'off' && (
            <>
              <Slider
                label="Neural cleanup amount"
                value={Math.round(
                  (options.noise_strength ??
                    {
                      off: 0,
                      light: 0.65,
                      balanced: 0.95,
                      strong: 1,
                      ai: 0.95,
                    }[options.noise]) * 100
                )}
                min={0}
                max={100}
                step={5}
                suffix="%"
                onChange={(n) => onChange({ noise_strength: n / 100 })}
              />
              <p className="inspector-footnote">
                Lower the amount or choose Light if quiet syllables sound thin.
                Strong can affect speech; compare the cleaned audio.
              </p>
            </>
          )}
          {!audioOnly && (
            <>
              <Field label="Speech detection">
                <select
                  value={options.vad}
                  onChange={(e) =>
                    onChange({ vad: e.target.value as PipelineOptions['vad'] })
                  }
                >
                  <option value="auto">
                    Automatic · Silero or energy fallback
                  </option>
                  <option value="silero" disabled={!caps?.silero}>
                    Silero VAD{caps?.silero ? '' : ' · not installed'}
                  </option>
                  <option value="energy">
                    Energy-based · review quiet speech carefully
                  </option>
                </select>
              </Field>
              <Slider
                label="Minimum silence"
                value={options.minimum_silence}
                min={0.5}
                max={30}
                step={0.1}
                suffix="s"
                onChange={(minimum_silence) => onChange({ minimum_silence })}
              />
              <Slider
                label="Speech padding"
                value={options.speech_padding}
                min={0.1}
                max={0.8}
                step={0.05}
                suffix="s"
                onChange={(speech_padding) => onChange({ speech_padding })}
              />
              <p className="inspector-footnote">
                Detection uses the original voice, including soft syllables.
                Keep 0.4s or more around speech for a more natural pace.
              </p>
              {options.preset === 'social' && (
                <Slider
                  label="Highlight length"
                  min={15}
                  max={90}
                  step={5}
                  value={options.clip_seconds}
                  suffix="s"
                  onChange={(clip_seconds) => onChange({ clip_seconds })}
                />
              )}
            </>
          )}
          <Field label="Encoding quality">
            <select
              value={options.quality}
              onChange={(e) =>
                onChange({
                  quality: e.target.value as PipelineOptions['quality'],
                })
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
            onChange={(bitrate_mbps) => onChange({ bitrate_mbps })}
          />
          {!audioOnly && (
            <>
              <Toggle
                label="Offline Khmer / English captions"
                description={
                  caps?.whisper
                    ? 'Local model ready. Review technical terms.'
                    : 'Install an offline Whisper model to enable captions.'
                }
                checked={options.transcribe}
                disabled={!caps?.whisper || disabled}
                onChange={(transcribe) => onChange({ transcribe })}
              />
              <Field label="Caption language">
                <select
                  value={options.language}
                  disabled={!caps?.whisper}
                  onChange={(e) =>
                    onChange({
                      language: e.target.value as PipelineOptions['language'],
                    })
                  }
                >
                  <option value="km">Khmer</option>
                  <option value="en">English</option>
                  <option value="auto">Detect language</option>
                </select>
              </Field>
            </>
          )}
        </fieldset>
      </details>
      <p className="inspector-footnote">
        All processing stays on this Mac. Noise suppression cannot reliably
        isolate your voice from another person speaking at the same time.
      </p>
    </div>
  );
}
