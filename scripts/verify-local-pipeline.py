"""Run the real pipeline against existing media; never modify the input file."""
import argparse
import hashlib
import json
import shutil
import time
import threading
from pathlib import Path
from uuid import uuid4
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from backend.app.config import Config
from backend.app.studio_jobs import StudioJobs,RUNNING
from backend.app.studio_models import NewProject,PipelineOptions

parser=argparse.ArgumentParser()
parser.add_argument('--input',required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--workspace',default='/tmp/reancode101-verification')
args=parser.parse_args()
def checksum(path):
    digest=hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda:file.read(1024*1024),b''): digest.update(chunk)
    return digest.hexdigest()
source=Path(args.input).resolve(); output=Path(args.output).resolve(); before=checksum(source)
service=StudioJobs(Config(data_dir=Path(args.workspace).resolve()))
try:
    id=str(uuid4());service.create(NewProject(id=id,title='Recovered lesson automated draft',duration=42.182))
    original=service.folder(id)/'original-screen.webm';shutil.copyfile(source,original);service.register_asset(id,'screen',original,'video/webm',source.stat().st_size,before)
    started=time.monotonic();job=service.submit(id,PipelineOptions(preset='clean',noise='balanced',vad='auto',height=1080))
    previous=None
    while job['status'] in RUNNING:
        marker=(job['stage'],None if job['progress'] is None else int(job['progress'])//10*10)
        if marker!=previous: print(job['stage'], '' if job['progress'] is None else f'{job["progress"]:.1f}%',flush=True);previous=marker
        time.sleep(.5);job=service.get(job['id'])
    if job['status']!='completed': raise RuntimeError(job.get('error'))
    assert checksum(source)==before
    assert checksum(original)==before
    output.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(service.job_folder(job['id'])/'edited.mp4',output)
    metadata=service.probe(output,threading.Event())
    streams={s['codec_type']:s for s in metadata['streams']}
    report={'output_probe':metadata,'checks':{'input_unchanged':True,'output_codecs_verified':streams['video']['codec_name']=='h264' and streams['audio']['codec_name']=='aac','av_skew_seconds':abs(float(streams['video']['duration'])-float(streams['audio']['duration']))},'input':str(source),'input_sha256':before,'output':str(output),'output_sha256':checksum(output),'elapsed_seconds':round(time.monotonic()-started,2),'job':job}
    output.with_suffix('.verification.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    print(json.dumps({k:job['result'][k] for k in ('duration','width','height','bytes','vad_engine','warnings')},ensure_ascii=False),flush=True)
finally: service.close()
