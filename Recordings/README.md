# Recordings

Every original recording owns one UUID folder. The same UUID appears in its filenames:

```text
Recordings/<uuid>/
  <name>-<uuid>.webm
  microphone-<uuid>.webm
  camera-<uuid>.webm
  edit1-<uuid>.mp4
  edit2-<uuid>.mp4
  edit1-<uuid>.edl.json
  edit1-<uuid>.srt
  recording.json
```

Original extensions are preserved from the saved source. Independent microphone/camera files and subtitle/EDL sidecars appear when available. Browser WebM exports use `.webm`. Automatic exports and browser exports saved through the local service share the same edit numbering. Retries keep the existing version; a new export gets the next number. Original and earlier edited files are never overwritten.

`recording.json` records the title, original tracks, versions, export IDs and SHA-256 hashes. Renaming a project does not rename an existing original. Internal backend media and API links stay available separately. Restart `npm run dev:all` after backend code changes to enable automatic publication for subsequent recordings/exports.

## Existing lessons

- [ok-if-elif-else](ac88d27e-0081-4b8c-b168-94ac37ed7fd9/): the original 12:39 lesson and [edited 1080p MP4](ac88d27e-0081-4b8c-b168-94ac37ed7fd9/edit1-ac88d27e-0081-4b8c-b168-94ac37ed7fd9.mp4).
- [Recovered 42-second lesson](b3238abe-fd64-4cc6-85bc-cc781b880557/): the original, previous cleanup (`edit1`), initial automated run (`edit2`), and optimized automated run (`edit3`). Verification reports are stored beside their corresponding edits. No qualifying pause was found in this sample.
- [Recovered 39-second lesson](da4eab70-f83b-4a37-9544-bd5f36af5055/): original only; its earlier processing failed.

Other UUID folders retain the independent originals and completed exports from the current studio. All existing media was verified by SHA-256 after organization. `migration.json` maps the previous flat filenames to their new paths. Historical paths inside verification reports remain a record of the original run.

Run `npm run recordings:organize` to backfill existing local-service projects safely. Add `-- --migrate-flat` to relocate recognized flat files after their contents have been verified. Unassociated files stay untouched. Set `EDU_RECORDINGS_DIR` in `backend/.env` to choose another location for the library.
