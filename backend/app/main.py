import asyncio
import shutil
import time
from contextlib import asynccontextmanager, suppress
from typing import Literal
from uuid import uuid4
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from .audio import ai_status
from .config import Config
from .jobs import Jobs, ACTIVE
from .studio_jobs import StudioJobs
from .studio_api import router as studio_router


class Options(BaseModel):
    mode: Literal['off', 'fast', 'balanced', 'ai'] = 'balanced'
    strength: float = Field(default=0.5, ge=0, le=1)


def create_app(config: Config | None = None):
    config = config or Config()
    # The studio retains original media until explicit deletion, including legacy files.
    config.retention_days = 0

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.jobs = Jobs(config)
        app.state.studio = StudioJobs(config)
        async def expiry():
            while True:
                await asyncio.sleep(3600)
                await run_in_threadpool(app.state.jobs.expire)
        task = asyncio.create_task(expiry())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        await run_in_threadpool(app.state.jobs.close)
        await run_in_threadpool(app.state.studio.close)

    app = FastAPI(title='REANCODE101 local studio', lifespan=lifespan)
    app.include_router(studio_router)
    app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
                       allow_methods=['GET', 'POST', 'PUT', 'DELETE'], allow_headers=['Content-Type'])

    @app.middleware('http')
    async def local_only(request: Request, call_next):
        host = request.url.hostname
        origin = request.headers.get('origin')
        if host not in ('localhost', '127.0.0.1', '::1', 'testserver'):
            return JSONResponse({'detail': 'Local access only'}, status_code=403)
        if origin and origin not in ('http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8001', 'http://127.0.0.1:8001'):
            return JSONResponse({'detail': 'Origin not allowed'}, status_code=403)
        return await call_next(request)

    def jobs() -> Jobs:
        return app.state.jobs

    def require(id: str):
        try:
            jobs().folder(id)
            return jobs().get(id)
        except (KeyError, ValueError):
            raise HTTPException(404, 'Recording not found')

    def check_options(options: Options):
        if not shutil.which(config.ffmpeg) or not shutil.which(config.ffprobe):
            raise HTTPException(503, 'Install FFmpeg and FFprobe to process audio. Your browser original is safe.')
        if options.mode == 'ai':
            available, reason = ai_status(config.model_dir)
            if not available:
                raise HTTPException(409, reason)

    @app.get('/api/capabilities')
    def capabilities():
        available, reason = ai_status(config.model_dir)
        return {'ready': bool(shutil.which(config.ffmpeg) and shutil.which(config.ffprobe)),
                'ai_available': available, 'ai_message': reason, 'max_bytes': config.max_bytes,
                'max_duration': config.max_duration, 'retention_days': config.retention_days}

    @app.get('/api/recordings')
    def recordings():
        with jobs().lock:
            return sorted((dict(r) for r in jobs().records.values()), key=lambda r: r['created_at'], reverse=True)

    @app.post('/api/recordings', status_code=202)
    async def upload(request: Request, mode: Literal['off', 'fast', 'balanced', 'ai'] = 'balanced', strength: float = 0.5):
        # Raw streamed body avoids multipart spooling before application size validation.
        if not 0 <= strength <= 1:
            raise HTTPException(422, 'Strength must be between 0 and 1')
        options = Options(mode=mode, strength=strength)
        check_options(options)
        mime = request.headers.get('content-type', '').split(';')[0]
        if mime not in ('video/webm', 'video/mp4'):
            raise HTTPException(415, 'Upload a WebM or MP4 video body')
        try:
            length = int(request.headers.get('content-length', '0'))
        except ValueError:
            raise HTTPException(400, 'Invalid Content-Length')
        if length > config.max_bytes:
            raise HTTPException(413, 'Recording exceeds upload size limit')
        id = str(uuid4())
        folder = jobs().folder(id)
        folder.mkdir()
        filename = 'original.webm' if mime == 'video/webm' else 'original.mp4'
        now = time.time()
        with jobs().lock:
            jobs().records[id] = {'id': id, 'status': 'uploading', 'stage': 'Receiving original', 'created_at': now,
                                  'updated_at': now, 'original_file': filename, 'mime': mime, 'bytes': 0, 'version': 0, 'progress': None}
        jobs().update(id)
        partial = folder / 'upload.partial'
        size = 0
        try:
            with partial.open('wb') as file:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > config.max_bytes:
                        raise HTTPException(413, 'Recording exceeds upload size limit')
                    await run_in_threadpool(file.write, chunk)
            if not size:
                raise HTTPException(400, 'Recording is empty')
            partial.replace(folder / filename)
            jobs().update(id, status='uploaded', bytes=size, stage='Original preserved')
            jobs().submit(id, mode, strength)
        except BaseException:
            partial.unlink(missing_ok=True)
            if not (folder / filename).exists():
                with jobs().lock:
                    jobs().records.pop(id, None)
                shutil.rmtree(folder, ignore_errors=True)
            raise
        return jobs().get(id)

    @app.get('/api/recordings/{id}/status')
    def status(id: str):
        return require(id)

    @app.get('/api/recordings/{id}/original')
    def original(id: str):
        record = require(id)
        path = jobs().folder(id) / record['original_file']
        if not path.is_file():
            raise HTTPException(409, 'Original upload is incomplete')
        return FileResponse(path, media_type=record['mime'], filename=f'edu-{id[:8]}-original{path.suffix}', content_disposition_type='inline')

    @app.get('/api/recordings/{id}/download')
    def download(id: str):
        record = require(id)
        if not record.get('processed_file'):
            raise HTTPException(409, 'Processed MP4 is not ready')
        return FileResponse(jobs().folder(id) / record['processed_file'], media_type='video/mp4',
                            filename=f'edu-{id[:8]}-clean.mp4', content_disposition_type='inline', headers={'Cache-Control': 'no-store'})

    @app.post('/api/recordings/{id}/reprocess', status_code=202)
    def reprocess(id: str, options: Options):
        record = require(id)
        check_options(options)
        if not (jobs().folder(id) / record['original_file']).is_file():
            raise HTTPException(409, 'Original is incomplete. Upload the browser copy again.')
        try:
            jobs().submit(id, options.mode, options.strength)
        except ValueError as exc:
            raise HTTPException(409, str(exc))
        return jobs().get(id)

    @app.post('/api/recordings/{id}/cancel', status_code=202)
    def cancel(id: str):
        require(id)
        jobs().cancel(id)
        return {'message': 'Cancellation requested. Original retained.'}

    @app.delete('/api/recordings/{id}', status_code=204)
    def delete(id: str):
        require(id)
        try:
            jobs().delete(id)
        except ValueError as exc:
            raise HTTPException(409, str(exc))

    return app


app = create_app()
