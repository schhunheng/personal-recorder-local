from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.recording_library import RecordingLibrary, checksum, recording_root
from backend.app.recording_migration import archive_workspace, organize_flat_files


def test_original_is_immutable_and_edits_are_numbered_across_restarts_and_retries(tmp_path):
    library = RecordingLibrary(tmp_path / 'Recordings')
    id, first, second = (str(uuid4()) for _ in range(3))
    original = tmp_path / 'original.webm'
    original.write_bytes(b'original bytes')
    edit = tmp_path / 'edited.mp4'
    edit.write_bytes(b'first export')
    entry = library.original(id, 'Python Lesson', 'screen', original)
    assert entry['file'] == f'Python-Lesson-{id}.webm'
    assert library.file(id, entry['file']).read_bytes() == b'original bytes'
    one = library.edit(id, 'Python Lesson', first, edit)
    assert one['file'] == f'edit1-{id}.mp4'
    assert library.edit(id, 'Renamed lesson', first, edit)['version'] == 1
    edit.write_bytes(b'second export')
    library = RecordingLibrary(library.root)
    two = library.edit(id, 'Renamed lesson', second, edit)
    assert two['file'] == f'edit2-{id}.mp4'
    assert library.file(id, one['file']).read_bytes() == b'first export'
    with pytest.raises(ValueError, match='cannot be replaced'):
        library.edit(id, 'Renamed lesson', first, edit)
    original.write_bytes(b'changed original')
    with pytest.raises(ValueError, match='cannot be replaced'):
        library.original(id, 'Renamed lesson', 'screen', original)
    assert library.file(id, entry['file']).read_bytes() == b'original bytes'
    assert not list(library.folder(id).glob('.saving-*'))


def test_parallel_exports_and_unindexed_files_never_replace_an_existing_version(tmp_path):
    library = RecordingLibrary(tmp_path / 'Recordings')
    id = str(uuid4())
    library.folder(id).mkdir()
    reserved = library.folder(id) / f'edit1-{id}.mp4'
    reserved.write_bytes(b'recovered file without manifest')
    source = tmp_path / 'source.webm'
    source.write_bytes(b'export bytes')
    with ThreadPoolExecutor(max_workers=4) as pool:
        entries = list(pool.map(lambda _: library.edit(id, 'Tutorial', str(uuid4()), source), range(4)))
    assert sorted(e['version'] for e in entries) == [2, 3, 4, 5]
    assert reserved.read_bytes() == b'recovered file without manifest'
    assert len(library.read(id)['edits']) == 4


def test_paths_unicode_titles_and_symlinked_folders_are_checked(tmp_path):
    library = RecordingLibrary(tmp_path / 'Recordings')
    id = str(uuid4())
    source = tmp_path / 'source.webm'
    source.write_bytes(b'original')
    entry = library.original(id, '../../' + 'រៀនកូដ' * 40, 'screen', source)
    assert '/' not in entry['file'] and len(entry['file'].encode()) <= 255
    assert library.file(id, entry['file']).parent == library.folder(id)
    with pytest.raises(ValueError): library.folder('../outside')
    with pytest.raises(ValueError): library.file(id, '../outside.mp4')
    outside = tmp_path / 'outside'
    outside.mkdir()
    other = str(uuid4())
    (library.root / other).symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError): library.original(other, 'Lesson', 'screen', source)
    with pytest.raises(ValueError): library.original(id, 'Lesson', 'avatar', source, '../../bad')
    assert recording_root(Config(data_dir=tmp_path / 'data')) == tmp_path / 'data' / 'Recordings'


def test_flat_migration_groups_matching_media_and_verification_reports_without_losing_bytes(tmp_path):
    library = RecordingLibrary(tmp_path / 'Recordings')
    data = tmp_path / 'data'
    id, job = str(uuid4()), str(uuid4())
    legacy = data / id
    legacy.mkdir(parents=True)
    (legacy / 'original.webm').write_bytes(b'original lesson')
    (legacy / 'processed-1.mp4').write_bytes(b'legacy cleanup')
    (legacy / 'status.json').write_text(json.dumps({'id': id, 'original_file': 'original.webm', 'processed_file': 'processed-1.mp4'}))
    original = library.root / '2026-11-04-original.webm'
    original.write_bytes(b'original lesson')
    (library.root / '2026-11-04-processed.mp4').write_bytes(b'legacy cleanup')
    edited = library.root / 'automatic.mp4'
    edited.write_bytes(b'automatic draft')
    report = library.root / 'automatic.verification.json'
    report.write_text(json.dumps({'input_sha256': checksum(original), 'output': str(edited), 'job': {'id': job}}))
    unknown = library.root / 'unknown.mp4'
    unknown.write_bytes(b'unassociated video')
    before = {p.name: checksum(p) for p in library.root.iterdir() if p.is_file()}
    archive_workspace(library, data)
    result = organize_flat_files(library)
    assert result['unmatched'] == ['unknown.mp4']
    assert len(result['moved']) == 4
    for name, path in result['moved'].items():
        assert path.startswith(id + '/')
        assert checksum(library.root / path) == before[name]
        assert not (library.root / name).exists()
    assert len(library.read(id)['edits']) == 2
    assert unknown.read_bytes() == b'unassociated video'
    archive_workspace(library, data)
    assert organize_flat_files(library)['moved'] == {}
    assert len(library.read(id)['edits']) == 2


def test_browser_export_uploads_share_version_numbers_and_keep_stable_downloads(tmp_path):
    id, one, two = (str(uuid4()) for _ in range(3))
    config = Config(data_dir=tmp_path / 'data', recordings_dir=tmp_path / 'Recordings', max_bytes=100)
    with TestClient(create_app(config)) as client:
        client.post('/api/studio/projects', json={'id': id, 'title': 'Python', 'duration': 3})
        original = client.put(f'/api/studio/projects/{id}/assets/screen', content=b'original', headers={'Content-Type': 'video/webm'}).json()
        assert original['file_name'] == f'Python-{id}.webm'
        first = client.put(f'/api/studio/projects/{id}/exports/{one}', content=b'export one', headers={'Content-Type': 'video/mp4'}).json()
        assert first['file_name'] == f'edit1-{id}.mp4'
        retry = client.put(f'/api/studio/projects/{id}/exports/{one}', content=b'retry does not replace the first version', headers={'Content-Type': 'video/mp4'}).json()
        assert retry == first
        assert client.get(first['video_url']).content == b'export one'
        second = client.put(f'/api/studio/projects/{id}/exports/{two}', content=b'export two', headers={'Content-Type': 'video/webm'}).json()
        assert second['file_name'] == f'edit2-{id}.webm'
        assert Path(second['library_path']).read_bytes() == b'export two'
        assert len(client.get(f'/api/studio/projects/{id}/exports').json()) == 2
        too_large = client.put(f'/api/studio/projects/{id}/exports/{uuid4()}', content=b'x' * 101, headers={'Content-Type': 'video/mp4'})
        assert too_large.status_code == 413
        assert not list((config.data_dir / 'studio' / id).glob('*.upload.partial'))
        assert client.get(f'/api/studio/projects/{id}/exports/{uuid4()}').status_code == 404
    with TestClient(create_app(config)) as client:
        assert client.get(first['video_url']).content == b'export one'
        assert client.get(second['video_url']).content == b'export two'
