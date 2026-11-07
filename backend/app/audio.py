"""Bounded-memory, overlapping audio processing; exact sample count is preserved."""
from pathlib import Path
from threading import Event
from typing import Callable
import numpy as np
import soundfile as sf
import noisereduce as nr


class Cancelled(Exception):
    pass


def check_cancel(cancel: Event):
    if cancel.is_set():
        raise Cancelled('Processing cancelled. Original retained.')


def ai_status(model_dir: str) -> tuple[bool, str]:
    if not model_dir or not (Path(model_dir) / 'config.ini').is_file() or not (Path(model_dir) / 'checkpoints').is_dir():
        return False, 'Install DeepFilterNet and configure EDU_DF_MODEL_DIR with a local model.'
    try:
        from df.enhance import init_df, enhance  # noqa: F401
        return True, 'Local DeepFilterNet model available.'
    except Exception as exc:
        return False, f'DeepFilterNet is unavailable: {type(exc).__name__}. Fast and Balanced are available.'


def process_audio(source: Path, target: Path, mode: str, strength: float,
                  cancel: Event, progress: Callable[[float], None], model_dir: str = '', normalize: bool = True):
    """Off copies samples; other modes normalize active speech RMS with <=12 dB boost.

    Ten-second cores with one-second context avoid full-recording RAM use. Context is
    discarded, keeping exact input length. A global second pass avoids gain pumping.
    """
    model = state = enhance = None
    if mode == 'ai':
        available, reason = ai_status(model_dir)
        if not available:
            raise ValueError(reason)
        from df.enhance import init_df, enhance
        model, state, _ = init_df(model_base_dir=model_dir, log_level='ERROR')
    raw = target.with_suffix('.raw.wav')
    try:
        with sf.SoundFile(source) as src, sf.SoundFile(raw, 'w', samplerate=src.samplerate, channels=1, subtype='FLOAT') as dst:
            sr, total = src.samplerate, len(src)
            core, context = sr * 10, sr
            peak, energy, active_samples = 0.0, 0.0, 0
            for start in range(0, total, core):
                check_cancel(cancel)
                left, end = max(0, start - context), min(total, start + core + context)
                src.seek(left)
                data = src.read(end - left, dtype='float32', always_2d=True).mean(axis=1)
                if mode in ('fast', 'balanced') and strength > 0:
                    data = nr.reduce_noise(y=data, sr=sr, stationary=mode == 'fast', prop_decrease=strength, n_jobs=1)
                elif mode == 'ai' and strength > 0:
                    import torch
                    original = data.copy()
                    enhanced = enhance(model, state, torch.from_numpy(data).unsqueeze(0), pad=True).squeeze(0).detach().cpu().numpy()
                    if len(enhanced) != len(original):
                        raise ValueError('AI model changed audio length; original retained.')
                    data = original * (1 - strength) + enhanced * strength
                offset = start - left
                data = np.nan_to_num(data[offset:offset + min(core, total - start)]).astype('float32')
                peak = max(peak, float(np.max(np.abs(data), initial=0)))
                # Count 20 ms voiced/active frames, not silence, for stable normalization.
                for frame in np.array_split(data, max(1, len(data) // max(1, sr // 50))):
                    power = float(np.dot(frame, frame))
                    if power / max(1, len(frame)) > 10 ** (-45 / 10):
                        energy += power
                        active_samples += len(frame)
                dst.write(data)
                progress(0.8 * min(total, start + core) / max(1, total))
        rms = np.sqrt(energy / max(1, active_samples))
        gain = 1.0 if mode == 'off' or not normalize else min(10 ** (12 / 20), 10 ** (-20 / 20) / max(rms, 1e-9), 0.95 / max(peak, 1e-9))
        with sf.SoundFile(raw) as src, sf.SoundFile(target, 'w', samplerate=src.samplerate, channels=1, subtype='PCM_24') as dst:
            written = 0
            for block in src.blocks(blocksize=48000 * 5, dtype='float32'):
                check_cancel(cancel)
                dst.write(block * gain)
                written += len(block)
                progress(0.8 + 0.2 * written / max(1, len(src)))
        return {'gain_db': round(float(20 * np.log10(max(gain, 1e-9))), 2), 'samples': total, 'sample_rate': sr}
    finally:
        raw.unlink(missing_ok=True)
