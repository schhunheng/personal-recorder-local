"""Backfill the visible library without starting workers or interrupting live jobs."""
import json
from pathlib import Path
import sqlite3
from uuid import UUID, NAMESPACE_URL, uuid5
from .recording_library import checksum


def archive_workspace(library, data_dir):
    data_dir = Path(data_dir)
    database = data_dir / 'studio' / 'jobs.sqlite3'
    if database.exists():
        with sqlite3.connect(f'file:{database.resolve()}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            projects = [dict(row) for row in db.execute('SELECT * FROM projects ORDER BY created,id')]
            jobs = [dict(row) for row in db.execute("SELECT * FROM jobs WHERE status='completed' ORDER BY created,id")]
        titles = {p['id']: p['title'] for p in projects}
        for project in projects:
            for kind, asset in json.loads(project['assets']).items():
                folder = data_dir / 'studio' / project['id']
                source = folder / asset['file']
                if Path(asset['file']).name != asset['file']:
                    raise ValueError('Invalid stored asset filename')
                if source.is_file():
                    library.original(project['id'], project['title'], kind, source,
                                     asset.get('revision'), asset.get('sha256'))
        for job in jobs:
            folder = data_dir / 'studio' / 'jobs' / job['id']
            if (folder / 'edited.mp4').is_file():
                library.edit(job['project_id'], titles[job['project_id']], job['id'], folder / 'edited.mp4',
                             job['created'], {'edl.json': folder / 'edl.json', 'srt': folder / 'captions.srt',
                                              'chapters.json': folder / 'chapters.json'})
    # Retain the UUIDs from the previous recorder as well.
    flat_originals = {checksum(p): p.stem.removesuffix('-original')
                      for p in library.root.glob('*-original.*') if p.is_file() and not p.is_symlink()}
    for status in sorted(data_dir.glob('*/status.json')):
        record = json.loads(status.read_text())
        id = record.get('id', status.parent.name)
        if str(UUID(id)) != id:
            raise ValueError('Invalid legacy recording UUID')
        name = record.get('original_file', '')
        if not name or Path(name).name != name:
            continue
        source = status.parent / name
        if not source.is_file():
            continue
        digest = checksum(source)
        title = flat_originals.get(digest) or library.read(id)['title'] or 'recording'
        library.original(id, title, 'screen', source, digest=digest)
        processed = record.get('processed_file')
        if processed and Path(processed).name == processed and (status.parent / processed).is_file():
            library.edit(id, title, str(uuid5(UUID(id), 'legacy:' + processed)), status.parent / processed,
                         (status.parent / processed).stat().st_mtime)


def manifests(library):
    for path in sorted(library.root.glob('*/recording.json')):
        yield library.read(path.parent.name)


def organize_flat_files(library):
    """Move a flat file only after its complete bytes exist in its UUID folder."""
    mapping = {}
    originals = {entry['sha256']: data['id'] for data in manifests(library)
                 for kind, entry in data['originals'].items() if kind == 'screen'}
    for source in sorted(library.root.glob('*-original.*')):
        if not source.is_file() or source.is_symlink() or source.suffix not in ('.webm', '.mp4', '.mov'):
            continue
        digest = checksum(source)
        id = originals.get(digest) or str(uuid5(NAMESPACE_URL, 'reancode101:original:' + digest))
        entry = library.original(id, source.stem.removesuffix('-original'), 'screen', source, digest=digest)
        originals[digest] = id
        mapping[source.name] = str(library.file(id, entry['file']).relative_to(library.root))
    for report in sorted(library.root.glob('*.verification.json'), key=lambda p: (p.stat().st_mtime, p.name)):
        if report.is_symlink():
            continue
        data = json.loads(report.read_text())
        id = originals.get(data.get('input_sha256'))
        source = library.root / Path(data.get('output', '')).name
        if not id or not source.is_file() or source.is_symlink():
            continue
        export_id = data.get('job', {}).get('id') or str(uuid5(UUID(id), report.name))
        entry = library.edit(id, library.read(id)['title'], export_id, source, source.stat().st_mtime,
                             {'verification.json': report})
        mapping[source.name] = str(library.file(id, entry['file']).relative_to(library.root))
        mapping[report.name] = f'{id}/edit{entry["version"]}-{id}.verification.json'
    # Match already published exports by content, never by a guessed title.
    edits = {entry['sha256']: (data['id'], entry['file']) for data in manifests(library) for entry in data['edits']}
    unmatched = []
    for source in sorted(library.root.iterdir()):
        if not source.is_file() or source.is_symlink() or source.name in mapping or source.suffix not in ('.mp4', '.webm', '.mov'):
            continue
        match = edits.get(checksum(source))
        if match:
            mapping[source.name] = f'{match[0]}/{match[1]}'
        else:
            unmatched.append(source.name)
    for name, relative in mapping.items():
        source = library.root / name
        target = library.root / relative
        if checksum(source) != checksum(target):
            raise ValueError(f'Could not verify migrated recording: {name}')
    # Record the relocation before removing the old directory entries.
    index = library.root / 'migration.json'
    if index.is_symlink():
        raise ValueError('Invalid migration index')
    previous = json.loads(index.read_text()) if index.exists() else {}
    if mapping:
        temporary = library.root / '.migration.json.partial'
        if temporary.is_symlink():
            raise ValueError('Invalid migration temporary file')
        temporary.write_text(json.dumps({**previous, **mapping}, indent=2) + '\n')
        temporary.replace(index)
        for name in mapping:
            (library.root / name).unlink()
    return {'moved': mapping, 'unmatched': unmatched}
