import threading
import numpy as np
import pytest
import soundfile as sf
from backend.app.audio import Cancelled, process_audio


def test_off_preserves_samples_and_duration(tmp_path):
    sr = 48000
    samples = np.random.default_rng(7).normal(0, .02, sr * 2).astype('float32')
    source, output = tmp_path / 'original.wav', tmp_path / 'clean.wav'
    sf.write(source, samples, sr, subtype='FLOAT')
    progress = []
    result = process_audio(source, output, 'off', .5, threading.Event(), progress.append)
    data, rate = sf.read(output)
    assert rate == sr and len(data) == len(samples)
    np.testing.assert_allclose(data, samples, atol=2e-7)
    assert result['gain_db'] == 0 and progress[-1] == 1


@pytest.mark.parametrize('mode', ['fast', 'balanced'])
def test_noise_reduction_changes_audio_without_drift(tmp_path, mode):
    sr = 48000
    t = np.arange(sr * 12) / sr
    rng = np.random.default_rng(42)
    speech = .15 * np.sin(2 * np.pi * 200 * t) * ((t % 3) < 1.5)
    samples = (speech + rng.normal(0, .018, len(t))).astype('float32')
    source, output = tmp_path / 'original.wav', tmp_path / 'clean.wav'
    sf.write(source, samples, sr, subtype='FLOAT')
    result = process_audio(source, output, mode, .8, threading.Event(), lambda _: None)
    data, _ = sf.read(output)
    assert len(data) == len(samples)
    assert np.isfinite(data).all() and np.max(np.abs(data)) <= .951
    # Compare normalized quiet intervals so gain normalization cannot disguise suppression.
    gain = 10 ** (result['gain_db'] / 20)
    quiet = ((t % 3) > 2) & (t < 11)
    assert np.mean((data[quiet] / gain) ** 2) < np.mean(samples[quiet] ** 2) * .9
    assert not (tmp_path / 'clean.raw.wav').exists()


def test_cancellation_cleans_intermediates(tmp_path):
    source = tmp_path / 'source.wav'
    sf.write(source, np.zeros(48000), 48000)
    event = threading.Event(); event.set()
    with pytest.raises(Cancelled):
        process_audio(source, tmp_path / 'out.wav', 'balanced', .5, event, lambda _: None)
    assert source.exists() and not (tmp_path / 'out.raw.wav').exists()
