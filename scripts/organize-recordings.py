"""Publish existing local media; optionally relocate verified flat copies."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.app.config import Config
from backend.app.recording_library import RecordingLibrary, recording_root
from backend.app.recording_migration import archive_workspace, organize_flat_files

parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', type=Path)
parser.add_argument('--recordings-dir', type=Path)
parser.add_argument('--migrate-flat', action='store_true', help='Relocate flat files after verifying their complete contents')
args = parser.parse_args()
config = Config()
if args.data_dir:
    config.data_dir = args.data_dir.resolve()
if args.recordings_dir:
    config.recordings_dir = args.recordings_dir.resolve()
library = RecordingLibrary(recording_root(config))
archive_workspace(library, config.data_dir)
result = organize_flat_files(library) if args.migrate_flat else {}
print(json.dumps({'directory': str(library.root), **result}, indent=2))
