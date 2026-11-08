import asyncio
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from .studio_models import NewProject, PipelineOptions, TimelineUpdate
from .recording_library import checksum
from .enhancement import audio_capabilities
from .studio_jobs import RUNNING
from .speech import speech_capabilities
from .render import text_rendering_available

router=APIRouter(prefix='/api/studio')

def service(request): return request.app.state.studio

def require(request,kind,id):
    try: return service(request).project(id) if kind=='project' else service(request).get(id)
    except (KeyError,ValueError): raise HTTPException(404,f'{kind.title()} not found')

@router.get('/capabilities')
def capabilities(request:Request):
    s=service(request)
    return {'ready':bool(shutil.which(s.config.ffmpeg) and shutil.which(s.config.ffprobe)), 'subtitle_burn':text_rendering_available(s.config.ffmpeg), 'max_bytes':s.config.max_bytes, 'max_duration':s.config.max_duration, **speech_capabilities(os.getenv('STUDIO_WHISPER_MODEL','')), **audio_capabilities(s.config)}

@router.get('/projects')
def projects(request:Request): return service(request).projects()

@router.post('/projects',status_code=201)
def create(options:NewProject,request:Request): return service(request).create(options)

@router.get('/projects/{id}')
def project(id:str,request:Request): return require(request,'project',id)

@router.put('/projects/{id}/assets/{kind}')
async def upload(id:str,kind:Literal['screen','microphone','camera','avatar'],request:Request,revision:UUID|None=None):
    s=service(request); p=require(request,'project',id)
    if kind in p['assets'] and (kind!='avatar' or not revision or p['assets'][kind].get('revision')==str(revision)): return p['assets'][kind]
    mime=request.headers.get('content-type','').split(';')[0]
    if mime not in ('video/webm','video/mp4','audio/webm','audio/mp4','audio/ogg','video/quicktime'): raise HTTPException(415,'Unsupported local media type')
    try: size=int(request.headers.get('content-length','0'))
    except ValueError: raise HTTPException(400,'Invalid content length')
    if size>s.config.max_bytes: raise HTTPException(413,'Media exceeds configured local size limit')
    ext='.mp4' if mime.endswith(('mp4','quicktime')) else '.ogg' if mime.endswith('ogg') else '.webm'
    folder=s.folder(id); partial=folder/f'{kind}.upload.partial'; target=folder/f'original-{kind}{"-"+str(revision) if kind=="avatar" and revision else ""}{ext}'
    if target.exists():
        digest=await run_in_threadpool(checksum,target)
        await run_in_threadpool(s.register_asset,id,kind,target,mime,target.stat().st_size,digest,str(revision) if revision else None)
        return s.project(id)['assets'][kind]
    count=0; digest=hashlib.sha256()
    try:
        # Exclusive creation prevents overlapping requests from writing the same asset.
        try: file=partial.open('xb')
        except FileExistsError: raise HTTPException(409,'This asset is already being saved. Wait and retry.')
        with file:
            async for chunk in request.stream():
                count+=len(chunk)
                if count>s.config.max_bytes: raise HTTPException(413,'Media exceeds configured local size limit')
                digest.update(chunk); await run_in_threadpool(file.write,chunk)
        if not count: raise HTTPException(400,'Media file is empty')
        if target.exists(): raise HTTPException(409,'Original media cannot be overwritten')
        partial.replace(target)
        await run_in_threadpool(s.register_asset,id,kind,target,mime,count,digest.hexdigest(),str(revision) if revision else None)
        return s.project(id)['assets'][kind]
    except BaseException:
        if 'file' in locals(): partial.unlink(missing_ok=True)
        raise

@router.post('/projects/{id}/process',status_code=202)
def process(id:str,options:PipelineOptions,request:Request):
    s=service(request); require(request,'project',id)
    if not shutil.which(s.config.ffmpeg) or not shutil.which(s.config.ffprobe): raise HTTPException(503,'Install FFmpeg and FFprobe. Original files are retained.')
    try: return s.submit(id,options)
    except ValueError as exc: raise HTTPException(409,str(exc))

@router.put('/projects/{id}/timeline')
def update_timeline(id:str,body:TimelineUpdate,request:Request):
    require(request,'project',id)
    try: return service(request).update_timeline(id,body.edl,body.base_version)
    except ValueError as exc: raise HTTPException(409,str(exc))

@router.get('/jobs/{id}')
def job(id:str,request:Request): return require(request,'job',id)

@router.post('/jobs/{id}/cancel',status_code=202)
def cancel(id:str,request:Request):
    require(request,'job',id); service(request).cancel(id); return {'message':'Cancellation requested. Originals retained.'}

@router.get('/jobs/{id}/events')
async def events(id:str,request:Request):
    require(request,'job',id)
    async def stream():
        previous=None
        while not await request.is_disconnected():
            current=service(request).get(id); encoded=json.dumps(current,ensure_ascii=False)
            if encoded!=previous:
                yield f'event: progress\ndata: {encoded}\n\n'; previous=encoded
            else: yield ': heartbeat\n\n'
            if current['status'] not in RUNNING: break
            await asyncio.sleep(.4)
    return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

@router.get('/jobs/{id}/files/{kind}')
def file(id:str,kind:Literal['video','srt','edl','original_audio','cleaned_audio','chapters'],request:Request):
    s=service(request); j=require(request,'job',id)
    names={'video':('edited.mp4','video/mp4'),'srt':('captions.srt','application/x-subrip'),'edl':('edl.json','application/json'),'original_audio':('original-audio.wav','audio/wav'),'cleaned_audio':('cleaned-audio.wav','audio/wav'),'chapters':('chapters.json','application/json')}
    name,mime=names[kind]; path=s.job_folder(id)/name
    if kind=='video' and j['status']!='completed': raise HTTPException(409,'Edited video is not ready')
    if kind=='cleaned_audio' and not j['audio_ready']: raise HTTPException(409,'Cleaned audio is not ready')
    if not path.is_file(): raise HTTPException(404,'This result is not available')
    filename=(j.get('result') or {}).get('file_name') if kind=='video' else None
    return FileResponse(path,media_type=mime,filename=filename or f'reancode101-{id[:8]}-{name}',content_disposition_type='inline',headers={'Cache-Control':'no-store'})

@router.get('/projects/{id}/assets/{kind}')
def original(id:str,kind:Literal['screen','microphone','camera','avatar'],request:Request):
    s=service(request); p=require(request,'project',id); asset=p['assets'].get(kind)
    if not asset: raise HTTPException(404,'Original asset not found')
    return FileResponse(s.asset(id,kind),media_type=asset['mime'],filename=asset.get('file_name') or f'reancode101-{id[:8]}-{asset["file"]}',content_disposition_type='inline')

def export_info(s,id,entry):
    return {**s.library.location(id,entry),'id':entry['id'],'bytes':entry['bytes'],
            'video_url':f'/api/studio/projects/{id}/exports/{entry["id"]}'}

@router.get('/projects/{id}/exports')
def exports(id:str,request:Request):
    s=service(request);require(request,'project',id)
    return [export_info(s,id,e) for e in s.library.read(id)['edits']]

@router.put('/projects/{id}/exports/{export_id}')
async def save_export(id:str,export_id:UUID,request:Request):
    s=service(request);p=require(request,'project',id);key=str(export_id)
    existing=s.library.get_edit(id,key)
    if existing: return export_info(s,id,existing)
    mime=request.headers.get('content-type','').split(';')[0]
    if mime not in ('video/mp4','video/webm'): raise HTTPException(415,'Choose an MP4 or WebM export')
    try: size=int(request.headers.get('content-length','0'))
    except ValueError: raise HTTPException(400,'Invalid content length')
    if size>s.config.max_bytes: raise HTTPException(413,'Export exceeds configured local size limit')
    partial=s.folder(id)/f'export-{key}.upload.partial'
    count=0
    try:
        try: file=partial.open('xb')
        except FileExistsError: raise HTTPException(409,'This export is already being saved. Wait and retry.')
        with file:
            async for chunk in request.stream():
                count+=len(chunk)
                if count>s.config.max_bytes: raise HTTPException(413,'Export exceeds configured local size limit')
                await run_in_threadpool(file.write,chunk)
        if not count: raise HTTPException(400,'Export is empty')
        entry=await run_in_threadpool(s.library.edit,id,p['title'],key,partial,extension='.mp4' if mime=='video/mp4' else '.webm')
        return export_info(s,id,entry)
    finally:
        if 'file' in locals(): partial.unlink(missing_ok=True)

@router.get('/projects/{id}/exports/{export_id}')
def exported_video(id:str,export_id:UUID,request:Request):
    s=service(request);require(request,'project',id);entry=s.library.get_edit(id,str(export_id))
    if not entry: raise HTTPException(404,'Edited video not found')
    path=s.library.file(id,entry['file'])
    if not path.is_file(): raise HTTPException(404,'Edited video is unavailable')
    return FileResponse(path,media_type='video/mp4' if path.suffix=='.mp4' else 'video/webm',
                        filename=entry['file'],content_disposition_type='inline')

@router.delete('/projects/{id}',status_code=204)
def delete(id:str,request:Request):
    require(request,'project',id)
    try: service(request).delete(id)
    except ValueError as exc: raise HTTPException(409,str(exc))
