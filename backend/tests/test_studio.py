import hashlib
import json
import shutil
import subprocess
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from backend.app.main import create_app
from backend.app.config import Config
from backend.app.edit_decisions import silence_cuts, retained, mapped_captions, duration
from backend.app.studio_models import EDL


def test_silence_padding_and_non_destructive_timeline():
    cuts=silence_cuts([{'start':0,'end':1},{'start':4,'end':6}],6,1.5,.3)
    assert len(cuts)==1 and cuts[0].start==1.3 and cuts[0].end==3.7
    edl=EDL(source_duration=6,trim={'start':0,'end':6},cuts=cuts,captions=[{'id':'c','start':.5,'end':4.5,'text':'Python'}])
    assert abs(duration(edl)-3.6)<.001
    assert len(mapped_captions(edl))==2
    edl.cuts[0].accepted=False
    assert duration(edl)==6
    assert silence_cuts([],30)==[]


def wait(client,id):
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        data=client.get(f'/api/studio/jobs/{id}').json()
        if data['status'] in ('completed','failed','cancelled'): return data
        time.sleep(.1)
    pytest.fail('Studio job timed out')


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg required')
def test_automatic_local_pipeline_real_media_and_durable_outputs(tmp_path):
    screen=tmp_path/'screen.webm'; camera=tmp_path/'camera.webm'
    # 0–1 and 4–6 seconds have tone; the middle gap should be suggested and removed.
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=0xd33232:s=640x360:r=30,drawbox=x=320:y=0:w=320:h=360:c=0x20c6c6:t=fill','-f','lavfi','-i',"aevalsrc='0.12*sin(2*PI*220*t)*if(between(t,1,4),0,1)':s=48000",'-t','6','-c:v','libvpx','-c:a','libopus',str(screen)],check=True)
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=0xf7b34e:s=128x128:r=30','-t','6','-c:v','libvpx',str(camera)],check=True)
    original=screen.read_bytes();config=Config(data_dir=tmp_path/'studio-data');pid=str(uuid4())
    with TestClient(create_app(config)) as client:
        assert client.post('/api/studio/projects',json={'id':pid,'title':'Python test','duration':6,'markers':[{'id':'focus','time':0,'kind':'important','x':.75,'y':.5}]}).status_code==201
        assert client.put(f'/api/studio/projects/{pid}/assets/screen',content=original,headers={'Content-Type':'video/webm'}).status_code==200
        assert client.put(f'/api/studio/projects/{pid}/assets/camera',content=camera.read_bytes(),headers={'Content-Type':'video/webm'}).status_code==200
        result=client.post(f'/api/studio/projects/{pid}/process',json={'preset':'professional','noise':'off','normalize':False,'vad':'energy','height':360,'minimum_silence':1.5,'speech_padding':.3,'edl':{'source_duration':6,'trim':{'start':0,'end':6},'camera':{'x':.16,'y':.22}}}).json()
        done=wait(client,result['id']);assert done['status']=='completed',done
        assert done['result']['vad_engine']=='energy';cuts=done['result']['edl']['cuts'];assert len(cuts)==1,cuts
        assert 3.3<done['result']['duration']<4.0,done
        video=client.get(done['result']['video_url']).content; output=tmp_path/'result.mp4';output.write_bytes(video)
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(output)]))
        v=next(s for s in probe['streams'] if s['codec_type']=='video');a=next(s for s in probe['streams'] if s['codec_type']=='audio')
        assert (v['codec_name'],a['codec_name'],v['width'],v['height'])==('h264','aac',640,360)
        assert abs(float(v['duration'])-float(a['duration']))<.2
        # Inspect decoded RGB pixels: untouched screen is cyan, independent camera is orange.
        raw=subprocess.check_output(['ffmpeg','-v','error','-ss','1','-i',str(output),'-vframes','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        def pixel(x,y): return raw[(y*640+x)*3:(y*640+x)*3+3]
        assert pixel(320,180)[1]>150 and pixel(320,180)[2]>150
        assert pixel(160,180)[1]>150 and pixel(160,180)[2]>150 and pixel(160,180)[0]<100, 'zoom must bring the cyan right region into the left of the edited frame'
        assert pixel(round(640*.16),round(360*.22))[0]>200, 'camera must appear in the selected top-left position'
        assert hashlib.sha256(client.get(f'/api/studio/projects/{pid}/assets/screen').content).digest()==hashlib.sha256(original).digest()
        # A reviewed render restores the pause and produces a second preserved job/output.
        edl=done['result']['edl'];edl['cuts'][0]['accepted']=False;edl['camera']['visible']=False
        again=client.post(f'/api/studio/projects/{pid}/process',json={'action':'render','edl':edl,'noise':'off','normalize':False,'vad':'energy','height':360}).json()
        restored=wait(client,again['id']);assert restored['status']=='completed',restored
        assert restored['result']['duration']>5.8
        hidden=tmp_path/'hidden-camera.mp4';hidden.write_bytes(client.get(restored['result']['video_url']).content)
        raw=subprocess.check_output(['ffmpeg','-v','error','-ss','1','-i',str(hidden),'-vframes','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])
        # The restored timeline reveals red screen pixels underneath the former orange overlay.
        hidden_pixel=pixel(round(640*.16),round(360*.22))
        assert hidden_pixel[0]>150 and hidden_pixel[1]<100 and hidden_pixel[2]<100, 'hidden camera must be absent from the exported MP4'
        assert client.get(done['result']['video_url']).content==video
        conflict=client.put(f'/api/studio/projects/{pid}/timeline',json={'base_version':0,'edl':edl});assert conflict.status_code==409
        # Explicit optional AI absence is an actual fallback, not a simulated model result.
        unavailable=client.get('/api/studio/capabilities').json();assert unavailable['ready']
    with TestClient(create_app(config)) as client:
        assert client.get(f'/api/studio/jobs/{done["id"]}').json()['status']=='completed'
        assert client.get(done['result']['video_url']).content==video

def test_explicit_retake_and_zoom_markers_and_social_highlight():
    from backend.app.edit_decisions import plan_edits
    from backend.app.studio_models import PipelineOptions,Marker
    markers=[Marker(id='r1',time=10,kind='retake_start'),Marker(id='r2',time=15,kind='retake_end'),Marker(id='z1',time=100,kind='important',x=.7,y=.4)]
    draft=plan_edits(300,[{'start':0,'end':300}],markers,PipelineOptions(preset='social',clip_seconds=60))
    assert draft.trim.start==95 and draft.trim.end==155
    assert draft.cuts[0].reason=='retake'
    assert len(draft.zooms)==2 and draft.zooms[0].x==.7
    assert draft.appearance.ratio=='9:16' and draft.caption_style.size==58
    # An unfinished retake is never guessed into a destructive cut.
    assert not plan_edits(300,[{'start':0,'end':300}],markers[:1],PipelineOptions()).cuts

@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg required')
def test_vertical_captions_ai_fallback_and_sse(tmp_path):
    source=tmp_path/'original.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=30','-f','lavfi','-i','sine=frequency=250:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',str(source)],check=True)
    pid=str(uuid4());config=Config(data_dir=tmp_path/'data',model_dir='/nonexistent-test-model')
    edl=EDL(source_duration=2,trim={'start':0,'end':2},captions=[{'id':'cap','start':0,'end':1.5,'text':'Python: print("Hello")'}],caption_style={'font':'Arial','size':42,'burn':True},zooms=[{'id':'zoom','time':0,'duration':.3,'scale':1.5,'x':.5,'y':.5}])
    with TestClient(create_app(config)) as client:
        client.post('/api/studio/projects',json={'id':pid,'title':'Vertical test','duration':2})
        client.put(f'/api/studio/projects/{pid}/assets/screen',content=source.read_bytes(),headers={'Content-Type':'video/mp4'})
        job=client.post(f'/api/studio/projects/{pid}/process',json={'action':'render','edl':edl.model_dump(),'profile':'vertical','height':1080,'noise':'ai','normalize':True}).json()
        done=wait(client,job['id']);assert done['status']=='completed',done.get('error')
        assert done['result']['width']==1080 and done['result']['height']==1920
        rendered=tmp_path/'vertical.mp4'; rendered.write_bytes(client.get(done['result']['video_url']).content)
        actual=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',str(rendered)]))['streams'][0]
        assert (actual['width'],actual['height'])==(1080,1920)
        assert any('AI enhancement unavailable' in w for w in done['result']['warnings'])
        if not client.get('/api/studio/capabilities').json()['subtitle_burn']: assert any('Text overlays were not burned' in w for w in done['result']['warnings'])
        subtitle=client.get(done['result']['srt_url']).text;assert 'print("Hello")' in subtitle
        stream=client.get(f'/api/studio/jobs/{job["id"]}/events');assert 'event: progress' in stream.text and '"status": "completed"' in stream.text
        assert client.get('/api/studio/jobs/invalid/files/video').status_code==404
        assert client.get('/api/studio/capabilities',headers={'Origin':'https://evil.example'}).status_code==403

def test_pending_jobs_are_interrupted_on_restart_and_uploads_are_immutable(tmp_path):
    import sqlite3
    from backend.app.studio_jobs import StudioJobs
    from backend.app.studio_models import NewProject
    config=Config(data_dir=tmp_path/'data');s=StudioJobs(config);pid=str(uuid4());s.create(NewProject(id=pid,title='Recovery',duration=5));s.close()
    jid=str(uuid4());now=time.time()
    with sqlite3.connect(config.data_dir/'studio'/'jobs.sqlite3') as db:
        db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',(jid,pid,'rendering','Rendering',50,'{}',None,None,now,now,0))
    with TestClient(create_app(config)) as client:
        interrupted=client.get(f'/api/studio/jobs/{jid}').json();assert interrupted['status']=='failed' and 'restarted' in interrupted['error']
        data=b'original-container-bytes'
        first=client.put(f'/api/studio/projects/{pid}/assets/screen',content=data,headers={'Content-Type':'video/webm'});assert first.status_code==200
        client.put(f'/api/studio/projects/{pid}/assets/screen',content=b'changed',headers={'Content-Type':'video/webm'})
        assert client.get(f'/api/studio/projects/{pid}/assets/screen').content==data
        assert client.get('/api/studio/projects').json()[0]['latest_job_id']==jid
        assert client.put(f'/api/studio/projects/{pid}/assets/../../outside',content=b'x').status_code in (404,405)

def test_chapters_follow_the_edited_timeline():
    from backend.app.edit_decisions import ffmetadata
    edl=EDL(source_duration=20,trim={'start':0,'end':20},cuts=[{'id':'cut','start':4,'end':8}],chapters=[{'time':0,'title':'Intro'},{'time':10,'title':'Python = variables'}])
    text,present=ffmetadata(edl);assert present and 'START=6000' in text and r'Python \= variables' in text

@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg required')
def test_cancelled_queued_job_retains_originals_and_can_retry(tmp_path):
    import threading
    pid=str(uuid4())
    with TestClient(create_app(Config(data_dir=tmp_path/'data'))) as client:
        s=client.app.state.studio; release=threading.Event(); blocker=s.pool.submit(lambda:release.wait(5))
        try:
            client.post('/api/studio/projects',json={'id':pid,'title':'Cancellation','duration':3})
            data=b'original bytes are retained regardless of cancellation'
            client.put(f'/api/studio/projects/{pid}/assets/screen',content=data,headers={'Content-Type':'video/webm'})
            job=client.post(f'/api/studio/projects/{pid}/process',json={}).json()
            assert client.post(f'/api/studio/jobs/{job["id"]}/cancel').status_code==202
        finally: release.set(); blocker.result(timeout=10)
        done=wait(client,job['id']);assert done['status']=='cancelled'
        assert client.get(f'/api/studio/projects/{pid}/assets/screen').content==data
        # Retrying produces a new durable job; corrupt input fails honestly without erasing the original.
        retried=client.post(f'/api/studio/projects/{pid}/process',json={}).json();assert retried['id']!=job['id']
        assert wait(client,retried['id'])['status']=='failed'
        assert client.get(f'/api/studio/projects/{pid}/assets/screen').content==data
