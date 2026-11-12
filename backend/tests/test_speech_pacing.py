import json
import shutil
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from backend.app.audio import Cancelled
from backend.app.audio_edits import assemble_audio
from backend.app.config import Config
from backend.app.edit_decisions import silence_cuts
from backend.app.main import create_app
from backend.app.speech import analyze


def test_pause_detection_keeps_soft_word_endings_and_isolated_quiet_words(tmp_path):
    rate = 48000
    t = np.arange(rate * 8) / rate
    data = np.random.default_rng(17).normal(0, .0001, len(t))
    for start, end, amplitude in ((.3, 1.8, .12), (1.8, 2.2, .006),
                                  (3.5, 3.8, .006), (6, 7.5, .12)):
        voiced = (t >= start) & (t < end)
        data[voiced] += amplitude * np.sin(2 * np.pi * 220 * t[voiced])
    source = tmp_path / 'soft-words.wav'
    sf.write(source, data, rate, subtype='FLOAT')
    detected = analyze(source, 'energy', -38, threading.Event(), lambda _: None)
    cuts = silence_cuts(detected['speech'], 8, minimum=1.2, padding=.4)
    assert cuts, 'Long pauses should still be shortened'
    for cut in cuts:
        for start, end in ((.3, 2.2), (3.5, 3.8), (6, 7.5)):
            assert cut.end <= start - .39 or cut.start >= end + .39
    assert detected['waveform']['step'] == .02
    assert not silence_cuts([{'start': 0, 'end': 1}, {'start': 2, 'end': 3}], 3,
                            minimum=.5, padding=.4), 'Avoid tiny jump cuts'


def test_neural_detection_uses_context_across_analysis_window_boundaries(tmp_path, monkeypatch):
    from backend.app import speech
    rate = 48000
    data = np.zeros(rate * 31, dtype='float32')
    data[round(29.7*rate):round(30.3*rate)] = .1
    source = tmp_path / 'boundary-word.wav'
    sf.write(source, data, rate, subtype='FLOAT')
    monkeypatch.setattr(speech, 'speech_capabilities', lambda: {'silero': True})
    def timestamps(samples, model, **kwargs):
        active = np.flatnonzero(samples > .05)
        # A detector needs context at the ends of its input window.
        if not len(active): return []
        return [{'start': max(.1, active[0]/16000),
                 'end': min((len(samples)/16000)-.1, (active[-1]+1)/16000)}]
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(
        Tensor=type('Tensor', (), {}),
        set_num_threads=lambda _: None, from_numpy=lambda samples: samples))
    monkeypatch.setitem(sys.modules, 'silero_vad', SimpleNamespace(
        load_silero_vad=lambda: object(), get_speech_timestamps=timestamps))
    detected = analyze(source, 'silero', -38, threading.Event(), lambda _: None)
    assert detected['engine'] == 'silero'
    assert len(detected['speech']) == 1
    assert abs(detected['speech'][0]['start'] - 29.7) < .002
    assert abs(detected['speech'][0]['end'] - 30.3) < .002


def test_continuous_pcm_assembly_preserves_samples_and_only_ramps_cut_edges(tmp_path):
    rate = 48000
    data = np.random.default_rng(3).uniform(-.2, .2, rate * 6).astype('float32')
    source, target = tmp_path / 'source.wav', tmp_path / 'edited.wav'
    sf.write(source, data, rate, subtype='FLOAT')
    ranges = [{'start': .123, 'end': 2.047}, {'start': 3.019, 'end': 5.997}]
    assemble_audio(source, target, ranges, threading.Event())
    actual, result_rate = sf.read(target)
    expected = np.concatenate([data[round(r['start']*rate):round(r['end']*rate)] for r in ranges])
    assert result_rate == rate and len(actual) == len(expected)
    join = round(ranges[0]['end']*rate) - round(ranges[0]['start']*rate)
    edge = round(rate * .005)
    for start, end in ((edge, join-edge), (join+edge, len(actual)-edge)):
        np.testing.assert_allclose(actual[start:end], expected[start:end], atol=2e-7)
    assert abs(actual[join-1]) < 1e-7 and abs(actual[join]) < 1e-7
    np.testing.assert_array_equal(sf.read(source, dtype='float32')[0], data)
    cancel = threading.Event(); cancel.set()
    with pytest.raises(Cancelled): assemble_audio(source, target, ranges, cancel)
    assert not target.exists() and source.is_file()


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
def test_repeated_fractional_frame_cuts_do_not_add_audio_gaps_or_av_drift(tmp_path):
    source = tmp_path / 'source.mp4'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', str(source),
    ], check=True)
    pid = str(uuid4())
    config = Config(data_dir=tmp_path / 'data')
    cuts = [{'id': str(i), 'start': i*.35 + .15, 'end': (i+1)*.35} for i in range(11)]
    with TestClient(create_app(config)) as client:
        client.post('/api/studio/projects', json={'id': pid, 'title': 'Continuous voice', 'duration': 4})
        client.put(f'/api/studio/projects/{pid}/assets/screen', content=source.read_bytes(), headers={'Content-Type': 'video/mp4'})
        request = client.post(f'/api/studio/projects/{pid}/process', json={
            'action': 'render', 'noise': 'off', 'normalize': False, 'height': 360,
            'edl': {'source_duration': 4, 'trim': {'start': 0, 'end': 4}, 'cuts': cuts},
        })
        assert request.status_code == 202, request.text
        jid = request.json()['id']
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            done = client.get(f'/api/studio/jobs/{jid}').json()
            if done['status'] in ('completed', 'failed', 'cancelled'): break
            time.sleep(.1)
        assert done['status'] == 'completed', done
        result = done['result']
        assert abs(result['duration'] - 1.8) < .035
        output = config.data_dir / 'studio' / 'jobs' / jid / 'edited.mp4'
        streams = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(output),
        ]))['streams']
        video = next(s for s in streams if s['codec_type'] == 'video')
        audio = next(s for s in streams if s['codec_type'] == 'audio')
        assert int(video['nb_frames']) == 54
        assert abs(float(video['duration']) - float(audio['duration'])) < .035
        pcm = np.frombuffer(subprocess.check_output([
            'ffmpeg', '-v', 'error', '-i', str(output), '-vn', '-ac', '1',
            '-ar', '48000', '-f', 'f32le', 'pipe:1',
        ]), dtype='<f4')
        # A separately encoded AAC segment can introduce a priming gap at every
        # join. Continuous encoding must not add ten milliseconds of dead voice.
        for join in np.arange(1, 12) * .15:
            for offset in (-.01, -.005, 0, .005):
                block = pcm[round((join+offset)*48000):round((join+offset+.005)*48000)]
                assert np.sqrt(np.mean(block**2)) > .015, (join, offset)
        assert client.get(f'/api/studio/projects/{pid}/assets/screen').content == source.read_bytes()
