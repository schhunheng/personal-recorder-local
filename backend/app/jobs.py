import json
import math
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID
import soundfile as sf
from .audio import Cancelled, check_cancel, process_audio
from .config import Config

ACTIVE = {'queued', 'validating', 'extracting', 'cleaning', 'encoding'}


class Jobs:
    def __init__(self, config: Config):
        self.config = config
        config.data_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='edu-audio')
        self.cancels: dict[str, threading.Event] = {}
        self.records: dict[str, dict] = {}
        for path in config.data_dir.glob('*/status.json'):
            try:
                data = json.loads(path.read_text())
                if str(UUID(path.parent.name)) != path.parent.name:
                    continue
                self.records[path.parent.name] = data
                if data['status'] in ACTIVE or data['status'] == 'uploading':
                    self.update(path.parent.name, status='failed', error='Server restarted during the job. Original retained; retry processing.', stage='Interrupted')
                for name in ('upload.partial', 'extracted.wav', 'cleaned.wav', 'cleaned.raw.wav', 'output.partial.mp4', 'status.tmp'):
                    (path.parent / name).unlink(missing_ok=True)
            except (ValueError, KeyError, OSError):
                continue
        self.expire()

    def folder(self, id: str) -> Path:
        if str(UUID(id)) != id:
            raise ValueError('Invalid recording ID')
        return self.config.data_dir / id

    def get(self, id: str):
        with self.lock:
            return dict(self.records[id])

    def update(self, id: str, **changes):
        with self.lock:
            record = self.records[id]
            record.update(changes, updated_at=time.time())
            temp = self.folder(id) / 'status.tmp'
            temp.write_text(json.dumps(record))
            os.replace(temp, self.folder(id) / 'status.json')

    def submit(self, id: str, mode: str, strength: float):
        with self.lock:
            if self.records[id]['status'] in ACTIVE:
                raise ValueError('This recording is already processing.')
            cancel = threading.Event()
            self.cancels[id] = cancel
            self.update(id, status='queued', stage='Waiting for local worker', progress=0, error=None, mode=mode, strength=strength)
            self.pool.submit(self.run, id, mode, strength, cancel)

    def cancel(self, id: str):
        with self.lock:
            if id in self.cancels:
                self.cancels[id].set()

    def command(self, args: list[str], cancel: threading.Event, progress=None, timeout=7200):
        # Read progress through a regular temporary file: no PIPE deadlocks or RAM growth.
        import tempfile
        with tempfile.NamedTemporaryFile() as output, tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=errors)
            start = time.monotonic()
            cursor = 0
            try:
                while process.poll() is None:
                    check_cancel(cancel)
                    if time.monotonic() - start > timeout:
                        raise ValueError('Media operation timed out. Original retained.')
                    if progress:
                        with open(output.name, 'rb') as reader:
                            reader.seek(cursor)
                            lines = reader.read().decode(errors='replace').splitlines()
                            cursor = reader.tell()
                        latest = next((line for line in reversed(lines) if line.startswith('out_time_us=')), None)
                        if latest:
                            try:
                                progress(float(latest.split('=')[1]) / 1_000_000)
                            except ValueError:
                                pass
                    cancel.wait(0.2)
                if process.returncode:
                    errors.seek(0)
                    detail = errors.read(8000).decode(errors='replace')
                    raise ValueError(f'Media processing failed: {detail[-1500:]}')
                output.seek(0)
                return output.read()
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()

    def probe(self, path: Path, cancel: threading.Event):
        return json.loads(self.command([
            self.config.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,start_time,duration',
            '-of', 'json', str(path),
        ], cancel, timeout=60))

    def run(self, id: str, mode: str, strength: float, cancel: threading.Event):
        folder = self.folder(id)
        extracted, cleaned, output = folder / 'extracted.wav', folder / 'cleaned.wav', folder / 'output.partial.mp4'
        try:
            check_cancel(cancel)
            self.update(id, status='validating', stage='Validating original media', progress=0)
            source = folder / self.get(id)['original_file']
            probe = self.probe(source, cancel)
            video = next((s for s in probe['streams'] if s['codec_type'] == 'video'), None)
            audio = next((s for s in probe['streams'] if s['codec_type'] == 'audio'), None)
            if not video or not audio:
                raise ValueError('Recording must contain both video and microphone audio.')
            if video.get('width', 0) * video.get('height', 0) > 3840 * 2160:
                raise ValueError('Video exceeds the 4K input limit.')
            if not any(fmt in probe['format']['format_name'].split(',') for fmt in ('matroska', 'webm', 'mov', 'mp4')):
                raise ValueError('Only WebM and MP4 recordings are supported.')
            for stream in (video, audio):
                start_time = float(stream.get('start_time', 0))
                if not math.isfinite(start_time) or abs(start_time) > self.config.max_duration:
                    raise ValueError('Invalid media start timestamp.')
            declared = float(probe['format'].get('duration', 0))
            if not math.isfinite(declared) or declared > self.config.max_duration + 0.1:
                raise ValueError('Recording exceeds the configured duration limit.')
            self.update(id, status='extracting', stage='Extracting microphone audio', progress=None)
            # first_pts=0 inserts initial silence for a late microphone track, maintaining A/V offset.
            self.command([self.config.ffmpeg, '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source),
                          '-map', '0:a:0', '-vn', '-t', str(self.config.max_duration + 1), '-af', 'aresample=48000:async=1:first_pts=0',
                          '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s24le', str(extracted)], cancel)
            duration = sf.info(extracted).duration
            if duration <= 0 or duration > self.config.max_duration + 0.1:
                raise ValueError('Empty audio or recording exceeds the configured duration limit.')
            # WebM MediaRecorder files often have no container duration. Read packet timestamps
            # in a streaming subprocess to validate the video too, rather than trusting audio length.
            packet_duration = self.validate_timeline(source, cancel)
            video_duration = float(video.get('duration') or declared or packet_duration)
            if not math.isfinite(video_duration) or video_duration <= 0 or video_duration > self.config.max_duration + 0.1:
                raise ValueError('Invalid video duration.')
            self.update(id, status='cleaning', stage='Converting audio' if mode == 'off' else 'Reducing noise and leveling speech', duration=duration, progress=0)
            details = process_audio(extracted, cleaned, mode, strength, cancel,
                                    lambda p: self.update(id, progress=round(p * 100, 1)), self.config.model_dir)
            self.update(id, status='encoding', stage='Encoding synchronized MP4', progress=0, audio=details)
            self.command([self.config.ffmpeg, '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source),
                          '-i', str(cleaned), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                          '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '192k',
                          '-af', 'apad', '-shortest', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', str(output)], cancel,
                         lambda seconds: self.update(id, progress=round(min(99, seconds / duration * 100), 1)))
            check_cancel(cancel)
            final_probe = self.probe(output, cancel)
            output_duration = float(final_probe['format']['duration'])
            output_video = next((s for s in final_probe['streams'] if s['codec_type'] == 'video'), None)
            output_audio = next((s for s in final_probe['streams'] if s['codec_type'] == 'audio'), None)
            final_video_duration = float((output_video or {}).get('duration') or output_duration)
            final_audio_duration = float((output_audio or {}).get('duration') or output_duration)
            # WebM's final packet, AAC priming, and independent screen/microphone track endings
            # can differ by a few frames. Validate the rendered video against the source video,
            # then validate audio against the rendered video rather than the raw WAV alone.
            if (not math.isfinite(output_duration) or not math.isfinite(final_video_duration) or
                abs(final_video_duration - video_duration) > 1.0 or
                abs(final_audio_duration - final_video_duration) > 0.75):
                raise ValueError('Processed audio and video durations do not align; original retained.')
            version = self.get(id).get('version', 0) + 1
            final = folder / f'processed-{version}.mp4'
            os.replace(output, final)
            previous = self.get(id).get('processed_file')
            self.update(id, status='completed', stage='MP4 ready', progress=100, processed_file=final.name, version=version)
            if previous:
                (folder / previous).unlink(missing_ok=True)
        except Cancelled as exc:
            self.update(id, status='cancelled', stage='Cancelled · original retained', error=str(exc), progress=None)
        except Exception as exc:
            self.update(id, status='failed', stage='Processing failed · original retained', error=str(exc), progress=None)
        finally:
            for path in (extracted, cleaned, output):
                path.unlink(missing_ok=True)
            with self.lock:
                if self.cancels.get(id) is cancel:
                    self.cancels.pop(id, None)

    def validate_timeline(self, source: Path, cancel: threading.Event):
        # A regular file bounds memory; FFprobe's packet output grows only on disk.
        import tempfile
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen([self.config.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
                                        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', str(source)],
                                       stdout=output, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            try:
                start = time.monotonic()
                while process.poll() is None:
                    check_cancel(cancel)
                    if time.monotonic() - start > 120:
                        raise ValueError('Media validation timed out.')
                    cancel.wait(0.1)
                if process.returncode:
                    raise ValueError('Video timestamps could not be validated.')
                output.seek(0)
                first = last = None
                count = 0
                for line in output:
                    try:
                        value = float(line.strip())
                    except ValueError:
                        continue
                    if not math.isfinite(value):
                        raise ValueError('Invalid video timestamp.')
                    first = value if first is None else min(first, value)
                    last = value if last is None else max(last, value)
                    count += 1
                if first is None or last - first > self.config.max_duration + 0.1:
                    raise ValueError('Empty video or video exceeds the duration limit.')
                # Use packet spacing for the last frame (container duration is often absent
                # in browser MediaRecorder WebM); cap to declared source audio/container length.
                return max(0.001, last - first + (last - first) / max(1, count - 1))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    def delete(self, id: str):
        with self.lock:
            if self.records[id]['status'] in ACTIVE or self.records[id]['status'] == 'uploading':
                raise ValueError('Cancel the active job and wait before deleting.')
            shutil.rmtree(self.folder(id))
            del self.records[id]

    def expire(self):
        if self.config.retention_days <= 0:
            return
        cutoff = time.time() - self.config.retention_days * 86400
        for id, record in list(self.records.items()):
            if record['updated_at'] < cutoff and record['status'] not in ACTIVE:
                self.delete(id)

    def close(self):
        for event in list(self.cancels.values()):
            event.set()
        self.pool.shutdown(wait=True, cancel_futures=False)
