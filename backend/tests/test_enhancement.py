import threading
import numpy as np
import pytest
import soundfile as sf
from backend.app.audio import Cancelled
from backend.app.config import Config
from backend.app.enhancement import cleanup_audio, finish_audio, rnnoise_status
from backend.app.jobs import Jobs
from backend.app.studio_models import PipelineOptions


class Worker:
    command = Jobs.command

    def __init__(self, path, node='node'):
        self.config = Config(data_dir=path, node=node)
        self.events = []

    def update(self, id, **values):
        self.events.append(values)


def noisy_clip(path):
    rate = 48000
    t = np.arange(rate * 6 + 137) / rate
    rng = np.random.default_rng(2026)
    envelope = ((t > 1) & (t < 4.5)) * (.6 + .4 * np.sin(t * 7) ** 2)
    phase = 2 * np.pi * (180 * t + 20 * np.sin(t))
    voice = envelope * (.12 * np.sin(phase) + .04 * np.sin(2 * phase) + .02 * np.sin(4 * phase))
    noise = rng.normal(0, .014, len(t)) * (1 + .3 * np.sin(t * 3))
    data = (voice + noise).astype('float32')
    sf.write(path, data, rate, subtype='FLOAT')
    return data, t


@pytest.mark.skipif(not rnnoise_status('node')[0], reason='Optional RNNoise npm package required')
def test_real_neural_inference_reduces_changing_noise_with_exact_partial_frame_length(tmp_path):
    source, output = tmp_path / 'source.wav', tmp_path / 'cleaned.wav'
    original, t = noisy_clip(source)
    worker, warnings = Worker(tmp_path), []
    result = cleanup_audio(worker, source, output, PipelineOptions(noise_engine='rnnoise', noise='strong', normalize=False), threading.Event(), 'test', warnings)
    data, rate = sf.read(output)
    assert result['engine'] == 'rnnoise' and result['model'] == 'RNNoise 0.2' and not warnings
    assert result['delay_compensated_ms'] == 20
    assert rate == 48000 and len(data) == len(original) and np.isfinite(data).all()
    quiet = (t > 5) & (t < 5.8)
    assert np.mean(data[quiet] ** 2) < np.mean(original[quiet] ** 2) * .1
    np.testing.assert_array_equal(sf.read(source, dtype='float32')[0], original)
    assert not list(tmp_path.glob('*.f32')) and not (tmp_path / 'enhanced-voice.wav').exists()
    assert worker.events[-1]['progress'] == 99


@pytest.mark.skipif(not rnnoise_status('node')[0], reason='Optional RNNoise npm package required')
def test_zero_neural_amount_preserves_timing_and_samples(tmp_path):
    source, output = tmp_path / 'source.wav', tmp_path / 'cleaned.wav'
    original, _ = noisy_clip(source)
    result = cleanup_audio(Worker(tmp_path), source, output, PipelineOptions(noise_engine='rnnoise', noise_strength=0, normalize=False), threading.Event(), 'test', [])
    np.testing.assert_allclose(sf.read(output)[0], original, atol=2e-7)
    assert result['gain_db'] == 0


def test_normalization_does_not_boost_noise_only_audio_and_limits_voice_boost(tmp_path):
    source, enhanced, output = (tmp_path / name for name in ('source.wav', 'wet.wav', 'cleaned.wav'))
    noisy_clip(source)
    dry, _ = sf.read(source)
    sf.write(enhanced, dry * .01, 48000, subtype='FLOAT')
    result = finish_audio(source, enhanced, output, True, threading.Event(), lambda _: None)
    assert result['gain_db'] <= 6.03
    noise = np.random.default_rng(3).normal(0, .01, 48000 * 2)
    sf.write(source, noise, 48000, subtype='FLOAT')
    result = finish_audio(source, source, output, True, threading.Event(), lambda _: None)
    assert result['gain_db'] == 0


def test_unavailable_neural_runtime_reports_the_actual_fallback(tmp_path):
    source, output = tmp_path / 'source.wav', tmp_path / 'cleaned.wav'
    original, _ = noisy_clip(source)
    warnings = []
    result = cleanup_audio(Worker(tmp_path, node='/missing/studio-node'), source, output,
                           PipelineOptions(noise_engine='rnnoise', normalize=False), threading.Event(), 'test', warnings)
    assert result['engine'] == 'spectral' and result['fallback_reason']
    assert any('rnnoise is unavailable' in w for w in warnings)
    assert len(sf.read(output)[0]) == len(original)


def test_cancelled_cleanup_keeps_source_and_removes_scratch_files(tmp_path):
    source = tmp_path / 'source.wav'
    noisy_clip(source)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        cleanup_audio(Worker(tmp_path), source, tmp_path / 'out.wav', PipelineOptions(noise_engine='rnnoise'), cancel, 'test', [])
    assert source.is_file() and not list(tmp_path.glob('*.f32'))
