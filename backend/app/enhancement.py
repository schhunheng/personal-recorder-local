"""Offline neural speech cleanup with bounded memory and explicit engine reporting."""
from functools import lru_cache
import json
from pathlib import Path
import shutil
import subprocess
import numpy as np
import soundfile as sf
from .audio import Cancelled, ai_status, process_audio, check_cancel

RNNOISE = Path(__file__).resolve().parents[2] / 'scripts' / 'rnnoise.mjs'


@lru_cache(maxsize=4)
def rnnoise_status(node):
    if not shutil.which(node):
        return False, 'Node.js is unavailable. Start the studio with Node.js on PATH.'
    try:
        result = subprocess.run([node, str(RNNOISE), '--check'], capture_output=True, text=True, timeout=15, check=True)
        data = json.loads(result.stdout)
        return data['engine'] == 'rnnoise', 'RNNoise 0.2 model ready locally.'
    except (OSError, ValueError, subprocess.SubprocessError):
        return False, 'RNNoise unavailable. Run npm ci with optional dependencies, then restart the studio.'


def audio_capabilities(config):
    rn_ready, rn_reason = rnnoise_status(config.node)
    df_ready, df_reason = ai_status(config.model_dir)
    return {'audio_engines': [
        {'id': 'rnnoise', 'label': 'RNNoise 0.2 · offline speech model', 'available': rn_ready, 'reason': rn_reason},
        {'id': 'deepfilter', 'label': 'DeepFilterNet · optional local model', 'available': df_ready, 'reason': df_reason},
        {'id': 'spectral', 'label': 'FFmpeg · basic spectral cleanup', 'available': bool(shutil.which(config.ffmpeg)),
         'reason': 'Basic fallback; less effective on changing background noise.'}],
        'recommended_audio_engine': 'deepfilter' if df_ready else 'rnnoise' if rn_ready else 'spectral'}


def frame_levels(path, cancel):
    levels, peak = [], 0.
    with sf.SoundFile(path) as file:
        rate, samples = file.samplerate, len(file)
        frame = max(1, rate // 50)
        for block in file.blocks(blocksize=frame * 250, dtype='float32', always_2d=True):
            check_cancel(cancel)
            data = block.mean(axis=1)
            peak = max(peak, float(np.max(np.abs(data), initial=0)))
            for start in range(0, len(data), frame):
                segment = data[start:start + frame]
                levels.append(float(np.sqrt(np.mean(segment.astype('float64') ** 2))))
    return np.asarray(levels), peak, rate, samples


def finish_audio(source, enhanced, target, normalize, cancel, progress):
    before, _, rate, samples = frame_levels(source, cancel)
    after, peak, result_rate, result_samples = frame_levels(enhanced, cancel)
    if (rate, samples) != (result_rate, result_samples) or not np.isfinite(after).all():
        raise ValueError('Speech enhancement changed timing or produced invalid samples.')
    floor = float(np.percentile(before, 20)) if len(before) else 0
    active = before > max(floor * 2.5, 10 ** (-45 / 20))
    gain = min(1., .95 / max(peak, 1e-12))
    if normalize and active.any():
        voice_rms = float(np.sqrt(np.mean(after[active] ** 2)))
        gain = min(2., .1 / max(voice_rms, 1e-9), .95 / max(peak, 1e-9))
    # One constant gain avoids pumping and caps boosts at 6 dB. Noise-only audio is never boosted.
    with sf.SoundFile(enhanced) as incoming, sf.SoundFile(target, 'w', samplerate=rate, channels=1, subtype='PCM_24') as outgoing:
        written = 0
        for block in incoming.blocks(blocksize=rate * 5, dtype='float32', always_2d=True):
            check_cancel(cancel)
            data = block.mean(axis=1)
            if not np.isfinite(data).all(): raise ValueError('Invalid speech enhancement samples.')
            outgoing.write(data * gain)
            written += len(data)
            progress(written / max(1, samples))
    quiet = (before <= floor * 1.05) & (before > 1e-6)
    reduction = None
    if quiet.any() and active.any():
        reduction = round(float(20 * np.log10(max(np.sqrt(np.mean(before[quiet] ** 2)), 1e-12) /
                                            max(np.sqrt(np.mean(after[quiet] ** 2)), 1e-12))), 1)
    return {'gain_db': round(float(20 * np.log10(max(gain, 1e-12))), 2), 'samples': samples,
            'sample_rate': rate, 'quiet_reduction_db': reduction, 'normalized': normalize}


def cleanup_audio(jobs, source, target, options, cancel, job_id, warnings):
    length = sf.info(source).duration
    requested = options.noise_engine
    engines = audio_capabilities(jobs.config)
    available = {engine['id']: engine['available'] for engine in engines['audio_engines']}
    engine = engines['recommended_audio_engine'] if requested == 'auto' else requested
    if options.noise == 'ai' and requested == 'auto': engine = 'deepfilter'  # Legacy selection.
    if options.noise == 'off': engine = 'off'
    fallback = None
    if engine != 'off' and not available.get(engine):
        fallback = f'{engine} unavailable'
        warnings.append(('AI enhancement unavailable. ' if options.noise == 'ai' else '') +
                        f'{engine} is unavailable; using {engines["recommended_audio_engine"]}.')
        engine = engines['recommended_audio_engine']
    strength = options.noise_strength if options.noise_strength is not None else {
        'off': 0, 'light': .65, 'balanced': .95, 'strong': 1., 'ai': .95}[options.noise]
    enhanced = target.with_name('enhanced-voice.wav')
    pcm_in, pcm_out = target.with_suffix('.input.f32'), target.with_suffix('.neural.f32')
    def report(value): jobs.update(job_id, progress=round(min(99, max(0, value * 100)), 1))
    try:
        if engine == 'rnnoise':
            try:
                jobs.update(job_id, stage='Cleaning voice with RNNoise 0.2', progress=0)
                info = sf.info(source)
                if info.samplerate != 48000: raise ValueError('RNNoise requires 48 kHz source audio.')
                with sf.SoundFile(source) as file, pcm_in.open('wb') as output:
                    for block in file.blocks(blocksize=48000 * 5, dtype='float32', always_2d=True):
                        check_cancel(cancel)
                        output.write(block.mean(axis=1).astype('<f4').tobytes())
                jobs.command([jobs.config.node, str(RNNOISE), str(pcm_in), str(pcm_out)], cancel,
                             lambda sec: report(.8 * sec / max(.1, length)))
                if pcm_out.stat().st_size != info.frames * 4: raise ValueError('RNNoise output length mismatch.')
                with sf.SoundFile(source) as file, pcm_out.open('rb') as wet, sf.SoundFile(enhanced, 'w', samplerate=48000, channels=1, subtype='FLOAT') as output:
                    for block in file.blocks(blocksize=48000 * 5, dtype='float32', always_2d=True):
                        check_cancel(cancel)
                        dry = block.mean(axis=1)
                        neural = np.frombuffer(wet.read(len(dry) * 4), dtype='<f4')
                        output.write(dry * (1 - strength) + neural * strength)
            except Cancelled: raise
            except Exception as exc:
                fallback = f'RNNoise failed: {type(exc).__name__}'
                warnings.append(f'{fallback}; using basic spectral cleanup. Listen to the comparison before exporting.')
                engine = 'spectral'
        if engine == 'deepfilter':
            try:
                jobs.update(job_id, stage='Cleaning voice with DeepFilterNet', progress=0)
                process_audio(source, enhanced, 'ai', strength, cancel, lambda value: report(value * .8), jobs.config.model_dir, normalize=False)
            except Cancelled: raise
            except Exception as exc:
                fallback = f'DeepFilterNet failed: {type(exc).__name__}'
                warnings.append(f'{fallback}; using basic spectral cleanup.')
                engine = 'spectral'
        if engine == 'spectral':
            jobs.update(job_id, stage='Reducing noise with basic spectral cleanup', progress=0)
            levels, _, _, _ = frame_levels(source, cancel)
            floor = float(20 * np.log10(max(float(np.percentile(levels, 20)), 1e-9))) if len(levels) else -60
            noise_floor = max(-80, min(-25, floor))
            reduction = {'light': 6, 'balanced': 12, 'strong': 18, 'ai': 12}.get(options.noise, 12)
            filters = f'highpass=f=70,afftdn=nr={reduction}:nf={noise_floor:.2f}:tn=1'
            jobs.command([jobs.config.ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(source), '-af', filters,
                          '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', '-progress', 'pipe:1', str(enhanced)],
                         cancel, lambda sec: report(.8 * sec / max(.1, length)))
        metrics = finish_audio(source, source if engine == 'off' else enhanced, target, options.normalize,
                               cancel, lambda value: report(.8 + value * .2))
        report(1)
        return {**metrics, 'mode': options.noise, 'engine': engine, 'model': {
            'rnnoise': 'RNNoise 0.2', 'deepfilter': 'DeepFilterNet', 'spectral': 'FFmpeg spectral', 'off': 'Original audio'}[engine],
            'strength': strength, 'delay_compensated_ms': 20 if engine == 'rnnoise' else 0,
            'fallback_reason': fallback}
    finally:
        for path in (enhanced, pcm_in, pcm_out): path.unlink(missing_ok=True)
