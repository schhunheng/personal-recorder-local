"""User-facing recording folders; immutable originals and numbered exports."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from uuid import UUID


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def recording_root(config):
    if config.recordings_dir is not None:
        return Path(config.recordings_dir).resolve()
    # Custom data workspaces (including tests) keep their library isolated.
    return (Path('Recordings') if config.data_dir.resolve() == Path('backend/data').resolve()
            else config.data_dir / 'Recordings').resolve()


def slug(title):
    text = unicodedata.normalize('NFKC', title)
    text = ''.join(c if c.isalnum() or unicodedata.category(c).startswith('M') else '-' for c in text)
    text = re.sub('-+', '-', text).strip('-')[:80].rstrip('-')
    while len(text.encode('utf-8')) > 160:
        text = text[:-1]
    return text.rstrip('-') or 'recording'


class RecordingLibrary:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def folder(self, id):
        if str(UUID(id)) != id:
            raise ValueError('Invalid recording UUID')
        folder = self.root / id
        if folder.is_symlink() or not folder.resolve().is_relative_to(self.root):
            raise ValueError('Invalid recording folder')
        return folder

    def file(self, id, name):
        folder = self.folder(id)
        path = folder / name
        if Path(name).name != name or path.is_symlink() or not path.resolve().is_relative_to(folder):
            raise ValueError('Invalid recording filename')
        return path

    @contextmanager
    def locked(self, id):
        folder = self.folder(id)
        folder.mkdir(exist_ok=True)
        lock = self.file(id, '.recording.lock')
        with os.fdopen(os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a') as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            try:
                yield folder
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)

    def read(self, id):
        path = self.file(id, 'recording.json')
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {
            'schema_version': 1, 'id': id, 'title': '', 'originals': {}, 'edits': []}
        if data.get('id') != id or data.get('schema_version') != 1:
            raise ValueError('Invalid recording manifest')
        return data

    def save(self, id, data):
        folder = self.folder(id)
        descriptor, temporary = tempfile.mkstemp(prefix='.manifest-', dir=folder)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.write('\n')
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.file(id, 'recording.json'))
        finally:
            Path(temporary).unlink(missing_ok=True)

    def publish(self, id, source, name):
        source = Path(source)
        target = self.file(id, name)
        if target.exists():
            if checksum(target) != checksum(source):
                raise ValueError(f'Recording file already exists with different content: {name}')
            return
        descriptor, temporary = tempfile.mkstemp(prefix='.saving-', dir=self.folder(id))
        try:
            with os.fdopen(descriptor, 'wb') as outgoing, source.open('rb') as incoming:
                for block in iter(lambda: incoming.read(1024 * 1024), b''):
                    outgoing.write(block)
                outgoing.flush()
                os.fsync(outgoing.fileno())
            # Publish atomically without replacing a file that appeared meanwhile.
            os.link(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def original(self, id, title, kind, source, revision=None, digest=None):
        if kind not in ('screen', 'microphone', 'camera', 'avatar'):
            raise ValueError('Invalid original media kind')
        if revision is not None and str(UUID(revision)) != revision:
            raise ValueError('Invalid avatar revision')
        source = Path(source)
        extension = source.suffix.lower()
        if extension not in ('.webm', '.mp4', '.mov', '.ogg', '.wav'):
            raise ValueError('Unsupported original extension')
        digest = digest or checksum(source)
        key = f'{kind}:{revision}' if revision else kind
        with self.locked(id):
            data = self.read(id)
            existing = data['originals'].get(key)
            if existing and existing['sha256'] != digest:
                raise ValueError('Original recording cannot be replaced')
            prefix = slug(title) if kind == 'screen' else kind + (f'-{revision}' if revision else '')
            name = existing['file'] if existing else f'{prefix}-{id}{extension}'
            self.publish(id, source, name)
            entry = {'file': name, 'bytes': source.stat().st_size, 'sha256': digest}
            data['title'] = title
            data['originals'][key] = entry
            self.save(id, data)
            return entry

    def edit(self, id, title, export_id, source, created=None, sidecars=None, extension=None):
        if str(UUID(export_id)) != export_id:
            raise ValueError('Invalid export UUID')
        source = Path(source)
        extension = extension or source.suffix.lower()
        if extension not in ('.mp4', '.webm'):
            raise ValueError('Unsupported edited video extension')
        digest = checksum(source)
        with self.locked(id) as folder:
            data = self.read(id)
            existing = next((edit for edit in data['edits'] if edit['id'] == export_id), None)
            if existing and existing['sha256'] != digest:
                raise ValueError('Saved export cannot be replaced')
            occupied = [int(match[1]) for file in folder.iterdir()
                        if (match := re.fullmatch(r'edit(\d+)-' + re.escape(id) + r'\.(?:mp4|webm)', file.name))]
            version = existing['version'] if existing else max([0, *occupied, *(e['version'] for e in data['edits'])]) + 1
            name = existing['file'] if existing else f'edit{version}-{id}{extension}'
            self.publish(id, source, name)
            entry = existing or {'id': export_id, 'version': version, 'file': name,
                                'bytes': source.stat().st_size, 'sha256': digest,
                                'created': created if created is not None else time.time()}
            for suffix, path in (sidecars or {}).items():
                if suffix not in ('edl.json', 'srt', 'chapters.json', 'verification.json'):
                    raise ValueError('Invalid export sidecar')
                if Path(path).is_file():
                    self.publish(id, path, f'edit{version}-{id}.{suffix}')
            if not existing:
                data['edits'].append(entry)
            data['title'] = title
            self.save(id, data)
            return entry

    def get_edit(self, id, export_id):
        return next((e for e in self.read(id)['edits'] if e['id'] == export_id), None)

    def location(self, id, entry):
        return {'file_name': entry['file'], 'library_path': str(self.file(id, entry['file'])),
                'edit_version': entry.get('version')}
