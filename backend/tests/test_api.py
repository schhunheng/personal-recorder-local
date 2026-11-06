import hashlib
import shutil
import subprocess
import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.app.config import Config
from backend.app.main import create_app


@pytest.fixture
def client(tmp_path):
    config = Config(data_dir=tmp_path / 'data')
    with TestClient(create_app(config)) as client:
        yield client


def wait_for_job(client, id):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        result = client.get(f'/api/recordings/{id}/status').json()
        if result['status'] in ('completed', 'failed', 'cancelled'):
            return result
        time.sleep(.1)
    pytest.fail('Background job timed out')


def test_capabilities_and_unknown_id(client):
    assert client.get('/api/capabilities').status_code == 200
    assert client.get('/api/recordings/not-an-id/status').status_code == 404
    assert client.get('/api/recordings').json() == []


def test_local_origin_and_host_restrictions(client):
    assert client.get('/api/capabilities', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.get('/api/capabilities', headers={'Host': 'evil.example'}).status_code == 403
    assert client.post('/api/recordings?strength=2', content=b'bad', headers={'Content-Type': 'video/webm'}).status_code == 422


def test_missing_dependencies_are_explicit(tmp_path):
    with TestClient(create_app(Config(data_dir=tmp_path, ffmpeg='/nonexistent/ffmpeg'))) as client:
        assert client.get('/api/capabilities').json()['ready'] is False
        assert client.post('/api/recordings', content=b'abc', headers={'Content-Type': 'video/webm'}).status_code == 503


ffmpeg_required = pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='FFmpeg and FFprobe required')


@ffmpeg_required
def test_upload_size_and_content_validation(tmp_path):
    with TestClient(create_app(Config(data_dir=tmp_path, max_bytes=16))) as client:
        assert client.post('/api/recordings', content=b'x' * 17, headers={'Content-Type': 'video/webm'}).status_code == 413
        assert client.post('/api/recordings', content=b'bad', headers={'Content-Type': 'text/plain'}).status_code == 415
        result = client.post('/api/recordings', content=b'not a video', headers={'Content-Type': 'video/webm'})
        assert result.status_code == 202
        id = result.json()['id']
        assert wait_for_job(client, id)['status'] == 'failed'
        assert client.get(f'/api/recordings/{id}/original').content == b'not a video'
        assert client.get(f'/api/recordings/{id}/download').status_code == 409
        assert client.delete(f'/api/recordings/{id}').status_code == 204


@ffmpeg_required
def test_real_media_round_trip_and_reprocess(client, tmp_path):
    source = tmp_path / 'fixture.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i',
                    'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libvpx', '-c:a', 'libopus', str(source)], check=True)
    original = source.read_bytes()
    response = client.post('/api/recordings?mode=balanced&strength=0.5', content=original, headers={'Content-Type': 'video/webm'})
    assert response.status_code == 202
    id = response.json()['id']
    done = wait_for_job(client, id)
    assert done['status'] == 'completed', done
    assert hashlib.sha256(client.get(f'/api/recordings/{id}/original').content).digest() == hashlib.sha256(original).digest()
    output = tmp_path / 'result.mp4'
    output.write_bytes(client.get(f'/api/recordings/{id}/download').content)
    import json
    metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
    assert {s['codec_type'] for s in metadata['streams']} == {'audio', 'video'}
    video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
    audio = next(s for s in metadata['streams'] if s['codec_type'] == 'audio')
    assert video['codec_name'] == 'h264' and audio['codec_name'] == 'aac'
    assert abs(float(audio['duration']) - float(video['duration'])) < .2
    assert abs(float(metadata['format']['duration']) - 3) < .2
    assert client.post(f'/api/recordings/{id}/reprocess', json={'mode': 'off', 'strength': 0}).status_code == 202
    again = wait_for_job(client, id)
    assert again['status'] == 'completed' and again['version'] == 2
    assert client.get(f'/api/recordings/{id}/original').content == original
    assert client.post(f'/api/recordings/{id}/reprocess', json={'mode': 'ai', 'strength': .5}).status_code == 409


@ffmpeg_required
def test_duration_limit_retains_original(tmp_path):
    source = tmp_path / 'too-long.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10', '-f', 'lavfi', '-i',
                    'sine=sample_rate=48000', '-t', '2', '-c:v', 'libvpx', '-c:a', 'libopus', str(source)], check=True)
    with TestClient(create_app(Config(data_dir=tmp_path / 'data', max_duration=.5))) as client:
        data = source.read_bytes()
        result = client.post('/api/recordings', content=data, headers={'Content-Type': 'video/webm'}).json()
        assert wait_for_job(client, result['id'])['status'] == 'failed'
        assert client.get(f"/api/recordings/{result['id']}/original").content == data
