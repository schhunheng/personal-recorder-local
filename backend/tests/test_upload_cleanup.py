import hashlib
import shutil
import subprocess
import time
from uuid import uuid4

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from backend.app.config import Config
from backend.app.enhancement import rnnoise_status
from backend.app.main import create_app


def wait(client, job_id):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        job = client.get(f'/api/studio/jobs/{job_id}').json()
        if job['status'] in ('completed', 'failed', 'cancelled'):
            return job
        time.sleep(.1)
    pytest.fail('Uploaded-video cleanup timed out')


@pytest.mark.skipif(not shutil.which('ffmpeg') or not rnnoise_status('node')[0], reason='FFmpeg and bundled RNNoise required')
@pytest.mark.parametrize('extension,mime,codecs', [
    ('.mp4', 'video/mp4', ['-c:v', 'libx264', '-c:a', 'aac']),
    ('.mov', 'video/quicktime', ['-c:v', 'libx264', '-c:a', 'aac']),
    ('.webm', 'video/webm', ['-c:v', 'libvpx', '-c:a', 'libopus']),
    ('.mkv', 'video/x-matroska', ['-c:v', 'libx264', '-c:a', 'aac']),
    ('.ogv', 'video/ogg', ['-c:v', 'libtheora', '-c:a', 'libvorbis']),
])
def test_uploaded_video_neural_cleanup_preserves_timeline_and_original(tmp_path, extension, mime, codecs):
    if extension == '.ogv' and 'libtheora' not in subprocess.check_output(['ffmpeg', '-v', 'error', '-encoders'], text=True):
        pytest.skip('This FFmpeg build cannot generate a Theora fixture')
    source = tmp_path / f'uploaded{extension}'
    subprocess.run([
        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x20c6c6:s=320x180:r=30',
        '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.025:sample_rate=48000:seed=7',
        '-t', '3', *codecs, str(source),
    ], check=True)
    original = source.read_bytes()
    config = Config(data_dir=tmp_path / 'data')
    project_id = str(uuid4())
    with TestClient(create_app(config)) as client:
        client.post('/api/studio/projects', json={
            'id': project_id, 'title': 'Uploaded lesson', 'duration': 3,
            'markers': [{'id': 'focus', 'time': .5, 'kind': 'important'}],
        }).raise_for_status()
        saved = client.put(f'/api/studio/projects/{project_id}/assets/screen', content=original, headers={'Content-Type': mime})
        assert saved.status_code == 200, saved.text
        assert saved.json()['file'].endswith(extension)
        job = client.post(f'/api/studio/projects/{project_id}/process', json={
            'action': 'render', 'audio_source': 'screen', 'noise': 'strong',
            'noise_engine': 'rnnoise', 'normalize': False, 'height': 360,
            'edl': {'source_duration': 3, 'trim': {'start': 0, 'end': 3},
                    'appearance': {'padding': 0, 'radius': 0, 'shadow': False}},
        })
        assert job.status_code == 202, job.text
        done = wait(client, job.json()['id'])
        assert done['status'] == 'completed', done
        result = done['result']
        assert result['audio']['engine'] == 'rnnoise'
        assert result['audio']['source'] == 'screen'
        assert not result['audio']['fallback_reason']
        assert result['vad_engine'] == 'not-needed'
        assert not result['edl']['cuts'] and not result['edl']['zooms']
        assert abs(result['duration'] - 3) < .2
        job_folder = config.data_dir / 'studio' / 'jobs' / done['id']
        dry, rate = sf.read(job_folder / 'original-audio.wav')
        wet, wet_rate = sf.read(job_folder / 'cleaned-audio.wav')
        assert rate == wet_rate == 48000 and len(dry) == len(wet)
        assert np.mean(wet[48000:] ** 2) < np.mean(dry[48000:] ** 2) * .2
        output = client.get(result['video_url'])
        assert output.status_code == 200 and output.content[4:8] == b'ftyp'
        assert hashlib.sha256(client.get(f'/api/studio/projects/{project_id}/assets/screen').content).digest() == hashlib.sha256(original).digest()
