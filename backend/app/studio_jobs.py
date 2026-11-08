"""Durable single-worker local pipeline. SQLite tracks jobs; originals are immutable files."""
import hashlib
import json
import math
import os
import shutil
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4
from .audio import Cancelled, check_cancel
from .enhancement import cleanup_audio as enhance_voice
from .jobs import Jobs
from .studio_models import EDL, PipelineOptions, NewProject
from .speech import analyze, transcribe, speech_capabilities
from .edit_decisions import plan_edits, mapped_captions, srt, duration, suggest_chapters
from .render import render
from .recording_library import RecordingLibrary, recording_root

RUNNING={'queued','validating','extracting','cleaning','detecting','planning','transcribing','rendering'}

class StudioJobs:
    command=Jobs.command
    probe=Jobs.probe
    validate_timeline=Jobs.validate_timeline
    def __init__(self,config):
        self.config=config; self.root=(config.data_dir/'studio').resolve(); self.root.mkdir(parents=True,exist_ok=True)
        self.library=RecordingLibrary(recording_root(config))
        self.db_path=self.root/'jobs.sqlite3'; self.lock=threading.RLock(); self.cancels={}
        for partial in self.root.glob('*/*.upload.partial'):
            partial.rename(partial.with_name(f'interrupted-{int(time.time())}-{partial.name}'))
        self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='studio-pipeline')
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,duration REAL NOT NULL,markers TEXT NOT NULL,assets TEXT NOT NULL,edl TEXT,version INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,progress REAL,options TEXT NOT NULL,result TEXT,error TEXT,created REAL NOT NULL,updated REAL NOT NULL,base_version INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS project_jobs ON jobs(project_id,created);
''')
            if 'timing' not in {r['name'] for r in db.execute('PRAGMA table_info(projects)')}: db.execute("ALTER TABLE projects ADD COLUMN timing TEXT NOT NULL DEFAULT '{}'")
            db.execute("UPDATE jobs SET status='failed',stage='Interrupted',error='Local service restarted. Original files retained; retry the job.',updated=? WHERE status IN ("+','.join('?' for _ in RUNNING)+')',(time.time(),*RUNNING))
        self.archive_existing()
    @contextmanager
    def connect(self):
        db=sqlite3.connect(self.db_path,timeout=30); db.row_factory=sqlite3.Row
        try:
            with db: yield db
        finally: db.close()
    def folder(self,id):
        if str(UUID(id))!=id: raise ValueError('Invalid project ID')
        folder=self.root/id
        if not folder.resolve().is_relative_to(self.root): raise ValueError('Invalid project path')
        return folder
    def job_folder(self,id):
        if str(UUID(id))!=id: raise ValueError('Invalid job ID')
        folder=self.root/'jobs'/id
        if not folder.resolve().is_relative_to(self.root): raise ValueError('Invalid job path')
        return folder
    def project(self,id):
        self.folder(id)
        with self.connect() as db:
            row=db.execute('SELECT * FROM projects WHERE id=?',(id,)).fetchone()
            latest=db.execute('SELECT id,status FROM jobs WHERE project_id=? ORDER BY created DESC LIMIT 1',(id,)).fetchone()
        if not row: raise KeyError(id)
        value=dict(row)
        for key in ('markers','assets','edl','timing'): value[key]=json.loads(value[key]) if value[key] else None
        value['latest_job_id']=latest['id'] if latest else None; value['latest_status']=latest['status'] if latest else None
        return value
    def projects(self):
        with self.connect() as db: ids=[row['id'] for row in db.execute('SELECT id FROM projects ORDER BY created DESC')]
        return [self.project(id) for id in ids]
    def create(self,options:NewProject):
        id=str(options.id); folder=self.folder(id); folder.mkdir(exist_ok=True)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO projects(id,title,duration,markers,assets,created,timing) VALUES(?,?,?,?,?,?,?)',(id,options.title,options.duration,json.dumps([m.model_dump() for m in options.markers]),'{}',time.time(),json.dumps(options.timing)))
            db.execute('UPDATE projects SET title=?,markers=?,timing=? WHERE id=?',(options.title,json.dumps([m.model_dump() for m in options.markers]),json.dumps(options.timing),id))
        return self.project(id)
    def asset(self,id,kind):
        p=self.project(id); info=p['assets'].get(kind)
        if not info: return None
        folder=self.folder(id); path=folder/info['file']
        if Path(info['file']).name!=info['file'] or not path.resolve().is_relative_to(folder.resolve()): raise ValueError('Invalid asset path')
        return path
    def register_asset(self,id,kind,path,mime,size,digest,revision=None):
        with self.lock:
            p=self.project(id)
            archived=self.library.original(id,p['title'],kind,path,revision,digest)
            assets=p['assets']; assets[kind]={'file':path.name,'mime':mime,'bytes':size,'sha256':digest,'revision':revision,**self.library.location(id,archived)}
            with self.connect() as db: db.execute('UPDATE projects SET assets=? WHERE id=?',(json.dumps(assets),id))
    def archive_existing(self):
        for p in self.projects():
            for kind,asset in p['assets'].items():
                path=self.asset(p['id'],kind)
                if path and path.is_file():
                    self.register_asset(p['id'],kind,path,asset['mime'],asset['bytes'],asset['sha256'],asset.get('revision'))
            with self.connect() as db: rows=db.execute("SELECT id FROM jobs WHERE project_id=? AND status='completed' ORDER BY created,id",(p['id'],)).fetchall()
            for row in rows:
                job=self.get(row['id']);folder=self.job_folder(job['id']);output=folder/'edited.mp4'
                if output.is_file() and job['result']:
                    archived=self.library.edit(p['id'],p['title'],job['id'],output,job['created'],{'edl.json':folder/'edl.json','srt':folder/'captions.srt','chapters.json':folder/'chapters.json'})
                    self.update(job['id'],result={**job['result'],**self.library.location(p['id'],archived)})
    def update_timeline(self,id,edl,base_version):
        with self.lock, self.connect() as db:
            p=self.project(id)
            if p['version']!=base_version: raise ValueError('The timeline changed. Reload its current version before saving.')
            db.execute('UPDATE projects SET edl=?,version=version+1 WHERE id=?',(edl.model_dump_json(),id))
        return self.project(id)
    def get(self,id):
        self.job_folder(id)
        with self.connect() as db: row=db.execute('SELECT * FROM jobs WHERE id=?',(id,)).fetchone()
        if not row: raise KeyError(id)
        value=dict(row); value['options']=json.loads(value['options']); value['result']=json.loads(value['result']) if value['result'] else None
        value['audio_ready']=value['status'] in ('detecting','planning','transcribing','rendering','completed') and (self.job_folder(id)/'cleaned-audio.wav').is_file()
        return value
    def update(self,id,**changes):
        allowed={'status','stage','progress','result','error'}
        if set(changes)-allowed: raise ValueError('Invalid job update')
        if 'result' in changes: changes['result']=json.dumps(changes['result'])
        changes['updated']=time.time()
        with self.lock,self.connect() as db: db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in changes)+' WHERE id=?',(*changes.values(),id))
    def submit(self,id,options):
        p=self.project(id)
        if not self.asset(id,'screen'): raise ValueError('Save the original screen recording first.')
        with self.lock, self.connect() as db:
            running=db.execute('SELECT id FROM jobs WHERE project_id=? AND status IN ('+','.join('?' for _ in RUNNING)+')',(id,*RUNNING)).fetchone()
            if running: return self.get(running['id'])
            jid=str(uuid4()); self.job_folder(jid).mkdir(parents=True)
            now=time.time(); db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',(jid,id,'queued','Waiting for local worker',0,options.model_dump_json(),None,None,now,now,p['version']))
        cancel=threading.Event(); self.cancels[jid]=cancel; self.pool.submit(self.run,jid,cancel)
        return self.get(jid)
    def cancel(self,id):
        self.get(id)
        with self.lock:
            event=self.cancels.get(id)
            if event: event.set()
    def cleanup_audio(self,source,target,options,cancel,job_id,warnings):
        return enhance_voice(self,source,target,options,cancel,job_id,warnings)
    def run(self,jid,cancel):
        job=self.get(jid); p=self.project(job['project_id']); folder=self.job_folder(jid); options=PipelineOptions.model_validate(job['options']); warnings=[]
        try:
            check_cancel(cancel); self.update(jid,status='validating',stage='Validating saved originals',progress=None)
            source=self.asset(p['id'],'screen'); probe=self.probe(source,cancel)
            video=next((s for s in probe['streams'] if s['codec_type']=='video'),None)
            if not video or video.get('width',0)*video.get('height',0)>3840*2160: raise ValueError('Use a screen recording up to 4K.')
            if not any(fmt in probe['format'].get('format_name','').split(',') for fmt in ('matroska','webm','mov','mp4')): raise ValueError('Unsupported original video container.')
            length=float(probe['format'].get('duration') or self.validate_timeline(source,cancel))
            if not math.isfinite(length) or length<=0 or length>self.config.max_duration: raise ValueError('Recording duration exceeds local limits.')
            with self.lock, self.connect() as db:
                current=self.project(p['id']); assets=current['assets']; assets['screen'].update(width=video['width'],height=video['height'])
                db.execute('UPDATE projects SET assets=?,duration=? WHERE id=?',(json.dumps(assets),length,p['id']))
            microphone=self.asset(p['id'],'microphone')
            if options.audio_source=='microphone' and not microphone: raise ValueError('No independent microphone track is available. Choose Original mix.')
            use_microphone=bool(microphone and options.audio_source!='screen')
            audio_source=microphone if use_microphone else source if any(s['codec_type']=='audio' for s in probe['streams']) else None
            timing=p.get('timing') or {};offsets=timing.get('trackOffsetsMs',{});roles=timing.get('trackRoles',{})
            delay=0.
            if use_microphone and roles.get('microphone') in offsets:
                delay=float(offsets[roles['microphone']])-float(offsets.get(roles.get('screen'),0))
                if not math.isfinite(delay) or abs(delay)>10000: raise ValueError('Invalid microphone synchronization offset.')
            self.update(jid,status='extracting',stage='Extracting synchronized audio',progress=None)
            extracted=folder/'original-audio.wav'; cleaned=folder/'cleaned-audio.wav'
            args=[self.config.ffmpeg,'-nostdin','-v','error','-y']
            if audio_source:
                filters=['aresample=48000:async=1:first_pts=0']
                if delay>0: filters.append(f'adelay={delay:.3f}')
                elif delay<0: filters.extend([f'atrim=start={-delay/1000:.6f}','asetpts=PTS-STARTPTS'])
                filters.append('apad')
                args+=['-protocol_whitelist','file,pipe','-i',str(audio_source),'-map','0:a:0','-af',','.join(filters)]
            else:
                args+=['-f','lavfi','-i','anullsrc=r=48000:cl=mono']; warnings.append('No audio track was captured; the draft uses silence.')
            args+=['-t',str(length),'-ac','1','-ar','48000','-c:a','pcm_s24le',str(extracted)]; self.command(args,cancel)
            self.update(jid,status='cleaning',stage='Cleaning and normalizing audio',progress=0)
            audio_info=self.cleanup_audio(extracted,cleaned,options,cancel,jid,warnings)
            audio_info.update(source='microphone' if use_microphone else 'screen' if audio_source else 'silence',source_offset_ms=delay)
            self.update(jid,status='detecting',stage='Detecting speech and pauses',progress=0)
            detected=analyze(cleaned,options.vad,options.threshold_db,cancel,lambda value:self.update(jid,progress=round(value*100,1))) if options.action=='plan' else {'speech':[],'waveform':{'levels':[],'step':.05},'engine':'not-needed','warnings':[]}; warnings+=detected['warnings']
            self.update(jid,status='planning',stage='Preparing reversible draft edits',progress=None)
            from .studio_models import Marker
            edl=plan_edits(length,detected['speech'],[Marker.model_validate(m) for m in p['markers']],options)
            if edl.trim.end>length: edl.trim.end=length
            edl.source_duration=length
            if options.preset=='social' and not edl.appearance.title: edl.appearance.title=p['title']
            edl.cuts=[c.model_copy(update={'end':min(c.end,length)}) for c in edl.cuts if c.start<length]
            if options.transcribe:
                self.update(jid,status='transcribing',stage='Transcribing with the offline model',progress=0)
                try:
                    edl.captions=transcribe(extracted,os.getenv('STUDIO_WHISPER_MODEL',''),options.language,cancel,lambda value:self.update(jid,progress=round(value*100,1)))
                    edl.chapters=suggest_chapters(edl.captions,[Marker.model_validate(m) for m in p['markers']])
                    warnings.append('Khmer/English captions and caption-derived chapter labels are drafts. Review technical terminology.')
                except Cancelled: raise
                except Exception as exc: warnings.append(f'Captions were not generated: {exc}')
            (folder/'edl.json').write_text(edl.model_dump_json(indent=2),encoding='utf-8')
            (folder/'captions.srt').write_text(srt(mapped_captions(edl)),encoding='utf-8')
            (folder/'chapters.json').write_text(json.dumps([c.model_dump() for c in edl.chapters],ensure_ascii=False),encoding='utf-8')
            self.update(jid,status='rendering',stage='Rendering edited H.264 / AAC MP4',progress=0)
            overlay=self.asset(p['id'],'avatar') or self.asset(p['id'],'camera')
            output,width,height,text_burned=render(self,jid,source,cleaned,overlay,bool(self.asset(p['id'],'avatar')),edl,options,probe,cancel)
            if not text_burned: warnings.append('This FFmpeg build has no subtitles/libass filter. Text overlays were not burned in. Download SRT, use browser export, or configure an FFmpeg build with libass. Video and cleaned audio are available.')
            check_cancel(cancel); final=self.probe(output,cancel)
            v=next((s for s in final['streams'] if s['codec_type']=='video'),{}); a=next((s for s in final['streams'] if s['codec_type']=='audio'),{})
            actual=float(final['format']['duration'])
            if (v.get('width'),v.get('height'))!=(width,height) or v.get('codec_name')!='h264' or a.get('codec_name')!='aac' or abs(actual-duration(edl))>max(.5,len(retained_safe(edl))*.05): raise ValueError('Output codec/duration validation failed. Originals retained.')
            self.update(jid,stage='Saving edited video to Recordings',progress=None)
            archived=self.library.edit(p['id'],p['title'],jid,output,job['created'],{'edl.json':folder/'edl.json','srt':folder/'captions.srt','chapters.json':folder/'chapters.json'})
            result={'edl':edl.model_dump(),'waveform':detected['waveform'],'vad_engine':detected['engine'],'warnings':warnings,'audio':audio_info,'text_overlays_burned':text_burned,'bytes':output.stat().st_size,'duration':actual,'width':width,'height':height,'video_url':f'/api/studio/jobs/{jid}/files/video','srt_url':f'/api/studio/jobs/{jid}/files/srt','edl_url':f'/api/studio/jobs/{jid}/files/edl'}
            result.update(self.library.location(p['id'],archived))
            try: self.update_timeline(p['id'],edl,job['base_version'])
            except ValueError: result['warnings'].append('Manual timeline changed while processing. This draft did not overwrite it.')
            self.update(jid,status='completed',stage='Draft ready to review',progress=100,result=result)
        except Cancelled as exc: self.update(jid,status='cancelled',stage='Cancelled · originals retained',progress=None,error=str(exc))
        except Exception as exc: self.update(jid,status='failed',stage='Processing failed · originals retained',progress=None,error=str(exc))
        finally:
            with self.lock: self.cancels.pop(jid,None)
    def delete(self,id):
        self.project(id)
        with self.lock,self.connect() as db:
            jobs=[dict(r) for r in db.execute('SELECT * FROM jobs WHERE project_id=?',(id,))]
            if any(j['status'] in RUNNING for j in jobs): raise ValueError('Cancel running jobs before deleting this project.')
            db.execute('DELETE FROM jobs WHERE project_id=?',(id,)); db.execute('DELETE FROM projects WHERE id=?',(id,))
            for job in jobs: shutil.rmtree(self.job_folder(job['id']),ignore_errors=True)
            shutil.rmtree(self.folder(id))
    def close(self):
        for event in list(self.cancels.values()): event.set()
        self.pool.shutdown(wait=True,cancel_futures=False)

def retained_safe(edl):
    from .edit_decisions import retained
    return retained(edl)
