"""FFmpeg compositions from nondestructive source-time metadata, one retained range at a time."""
import math
import subprocess
from functools import lru_cache
from pathlib import Path
from .edit_decisions import retained, duration, mapped_captions, source_to_output, ffmetadata

@lru_cache(maxsize=8)
def text_rendering_available(ffmpeg):
    try:
        result=subprocess.run([ffmpeg,'-hide_banner','-filters'],capture_output=True,text=True,timeout=10,check=True)
        return any(' subtitles ' in line for line in result.stdout.splitlines())
    except (OSError,subprocess.SubprocessError): return False

def quote(value):
    return str(value).replace('\\','\\\\').replace("'", "'\\''").replace(':','\\:')

def zoom_expressions(zooms, offset, fps):
    # Numeric transition origins keep expression size linear in keyframe count.
    t=f'(on/{fps}+{offset:.6f})'
    result={'scale':'1','x':'0.5','y':'0.5'}
    origin={'scale':1.,'x':.5,'y':.5}; target=dict(origin); previous=0.; transition=1.
    for z in sorted(zooms,key=lambda z:z.time):
        u=max(0,min(1,(z.time-previous)/transition)); eased=u*u*(3-2*u)
        pose={key:origin[key]+(target[key]-origin[key])*eased for key in origin}
        edge=.5/pose['scale']; pose['x']=max(edge,min(1-edge,pose['x'])); pose['y']=max(edge,min(1-edge,pose['y']))
        unit=f'max(0,min(1,({t}-{z.time})/{z.duration}))'; ease=f'({unit}*{unit}*(3-2*{unit}))'
        target={'scale':z.scale,'x':z.x,'y':z.y}
        result={key:f'if(lt({t},{z.time}),{expr},{pose[key]:.8f}+({target[key]}-{pose[key]:.8f})*{ease})' for key,expr in result.items()}
        origin=pose; previous=z.time; transition=z.duration
    return result

def ass_time(t):
    cs=round(t*100); return f'{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}'

def ass_text(text):
    return text.replace('\\','\\\\').replace('{','｛').replace('}','｝').replace('\r','').replace('\n',r'\N')

def write_ass(path,edl,width,height):
    style=edl.caption_style; alignment={'bottom':2,'top':8,'center':5}[style.position]
    header=f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{style.font},{round(style.size*height/1080)},&H00FFFFFF,&H00FFFFFF,&H00151A14,&H80151A14,0,0,0,0,100,100,0,0,1,2,1,{alignment},40,40,60,1
Style: Title,{style.font},{round(48*height/1080)},&H00B7E76E,&H00FFFFFF,&H00151A14,&H80151A14,-1,0,0,0,100,100,0,0,1,2,1,2,70,70,140,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines=[]
    if style.burn:
        for c in mapped_captions(edl):
            effect=r'{\fad(80,80)}' if style.animation=='fade' else ''
            lines.append(f'Dialogue: 0,{ass_time(c.start)},{ass_time(c.end)},Caption,,0,0,0,,{effect}{ass_text(c.text)}')
    total=duration(edl); a=edl.appearance
    if a.title:
        if a.intro: lines.append(f'Dialogue: 1,0:00:00.00,{ass_time(min(3,total))},Title,,0,0,0,,{ass_text(a.title)}')
        if a.outro: lines.append(f'Dialogue: 1,{ass_time(max(0,total-3))},{ass_time(total)},Title,,0,0,0,,{ass_text(a.title)}')
    if a.watermark: lines.append(f'Dialogue: 1,0:00:00.00,{ass_time(total)},Caption,,0,0,0,,{{\\an9\\fs{max(16,round(18*height/1080))}}}REANCODE101')
    path.write_text(header+'\n'.join(lines)+'\n',encoding='utf-8')
    return bool(lines)

def render(jobs,job_id,source,audio,overlay,loop,edl,options,probe,cancel):
    folder=jobs.job_folder(job_id); ranges=retained(edl); total=duration(edl)
    if not ranges or total<.1: raise ValueError('No retained video. Restore a cut before export.')
    width=options.height if options.profile=='vertical' else round(options.height*16/9/2)*2
    height=round(options.height*16/9/2)*2 if options.profile=='vertical' else options.height
    video=next(s for s in probe['streams'] if s['codec_type']=='video'); sw,sh=video['width'],video['height']
    pad=round(min(width,height)*edl.appearance.padding); ratio=min((width-2*pad)/sw,(height-2*pad)/sh)
    fw,fh=max(2,round(sw*ratio/2)*2),max(2,round(sh*ratio/2)*2)
    overlay_codec=None
    if overlay:
        overlay_probe=jobs.probe(overlay,cancel); overlay_codec=next((s.get('codec_name') for s in overlay_probe['streams'] if s.get('codec_type')=='video'),None)
    files=[]; elapsed=0
    for index,r in enumerate(ranges):
        length=r['end']-r['start']; output=folder/f'part-{index:05}.mp4'
        z=zoom_expressions(edl.zooms,r['start'],options.fps)
        radius=max(0,min(min(fw,fh)/2,edl.appearance.radius*width/1920))
        corner=f'if(lte(pow(max(abs(X-W/2)-(W/2-{radius}),0),2)+pow(max(abs(Y-H/2)-(H/2-{radius}),0),2),pow({radius},2)),255,0)'
        screen=f"[0:v]trim=duration={length},setpts=PTS-STARTPTS,fps={options.fps},zoompan=z='{z['scale']}':x='max(0,min(iw-iw/zoom,iw*({z['x']})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,ih*({z['y']})-ih/zoom/2))':d=1:s={fw}x{fh}:fps={options.fps}"
        filters=[]
        if radius>0:
            filters += [screen+'[screen-rgb]',f"color=c=white:s={fw}x{fh}:r=1:d=0.01,format=gray,geq=lum='{corner}'[screen-mask]",'[screen-rgb][screen-mask]alphamerge[screen]']
        else: filters.append(screen+'[screen]')
        filters.append(f"color=c={edl.appearance.background}:s={width}x{height}:r={options.fps}:d={length}[background]")
        background='background'
        if edl.appearance.shadow:
            filters.append(f"color=c=black:s={fw}x{fh}:r=1:d=0.01,format=rgba,geq=r=0:g=0:b=0:a='({corner})*0.35',pad=iw+80:ih+80:40:40:color=black@0,gblur=sigma=12[shadow]")
            filters.append(f'[background][shadow]overlay={(width-fw)//2-40}:{(height-fh)//2-28}[background-shadow]'); background='background-shadow'
        filters += [f'[{background}][screen]overlay={(width-fw)//2}:{(height-fh)//2}[base]',f"[1:a]atrim=duration={length},asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st={max(0,length-.008)}:d=0.008[a]"]
        args=[jobs.config.ffmpeg,'-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-ss',str(r['start']),'-i',str(source),'-ss',str(r['start']),'-i',str(audio)]
        out='base'; c=edl.camera
        if overlay and c.visible:
            if loop: args+=['-stream_loop','-1']
            if overlay_codec in ('vp8','vp9'): args+=['-c:v','libvpx-vp9' if overlay_codec=='vp9' else 'libvpx']
            args+=['-ss',str(0 if loop else r['start']),'-i',str(overlay)]
            d=max(2,round(min(width,height)*c.size/2)*2); x=round(max(d/2,min(width-d/2,c.x*width))-d/2); y=round(max(d/2,min(height-d/2,c.y*height))-d/2)
            start=0; end=length
            base=f'[2:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,scale={d}:{d}:force_original_aspect_ratio=increase,crop={d}:{d}'
            if c.mirror: base+=',hflip'
            dist='pow(X-W/2,2)+pow(Y-H/2,2)'
            mask=f'if(lte({dist},pow(W/2,2)),255,0)' if c.shape=='circle' else f'if(lte(pow(max(abs(X-W/2)-W*.32,0),2)+pow(max(abs(Y-H/2)-H*.32,0),2),pow(W*.18,2)),255,0)'
            distance=dist if c.shape=='circle' else 'pow(max(abs(X-W/2)-W*.32,0),2)+pow(max(abs(Y-H/2)-H*.32,0),2)'
            inner='pow(W/2-2,2)' if c.shape=='circle' else 'pow(W*.18-2,2)'
            channel=lambda channel:f"if(gte({distance},{inner}),235,{channel}(X,Y))" if c.border else f'{channel}(X,Y)'
            base+=f",format=rgba,geq=r='{channel('r')}':g='{channel('g')}':b='{channel('b')}':a='alpha(X,Y)*({mask})/255',colorchannelmixer=aa={c.opacity}[cam]"
            beneath='base'
            if c.shadow:
                filters += [f"color=c=black:s={d}x{d}:r=1:d=0.01,format=rgba,geq=r=0:g=0:b=0:a='({mask})*0.4',pad=iw+40:ih+40:20:20:color=black@0,gblur=sigma=6[cam-shadow]",f'[base][cam-shadow]overlay={x-20}:{y-16}[cam-beneath]']; beneath='cam-beneath'
            filters+=[base,f'[{beneath}][cam]overlay={x}:{y}:eof_action=pass:shortest=0[v]']; out='v'
        script=folder/f'filter-{index:05}.txt'; script.write_text(';\n'.join(filters))
        args+=['-filter_complex',script.read_text(),'-map',f'[{out}]','-map','[a]','-t',str(length),'-r',str(options.fps),'-c:v','libx264','-preset','veryfast','-crf','19' if options.quality=='high' else '24','-maxrate',f'{options.bitrate_mbps}M','-bufsize',f'{options.bitrate_mbps*2}M','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-b:a','192k','-movflags','+faststart','-progress','pipe:1',str(output)]
        jobs.command(args,cancel,lambda seconds:jobs.update(job_id,progress=round(min(99,(elapsed+seconds)/total*100),1)))
        files.append(output); elapsed+=length
    jobs.update(job_id,stage='Assembling retained sections',progress=None)
    listing=folder/'concat.txt'; listing.write_text('\n'.join(f"file '{f.name}'" for f in files)+'\n')
    combined=folder/'combined.mp4'
    jobs.command([jobs.config.ffmpeg,'-nostdin','-v','error','-y','-f','concat','-safe','1','-i',str(listing),'-c','copy','-movflags','+faststart',str(combined)],cancel)
    ass=folder/'captions.ass'; burn=write_ass(ass,edl,width,height)
    final=folder/'edited.mp4'
    burned=burn and text_rendering_available(jobs.config.ffmpeg)
    if burned:
        jobs.update(job_id,stage='Rendering caption and title overlays',progress=0)
        jobs.command([jobs.config.ffmpeg,'-nostdin','-v','error','-y','-i',str(combined),'-vf',f"subtitles=filename='{quote(ass)}'",'-c:v','libx264','-preset','veryfast','-crf','19' if options.quality=='high' else '24','-c:a','copy','-movflags','+faststart','-progress','pipe:1',str(final)],cancel,lambda seconds:jobs.update(job_id,progress=round(min(99,seconds/total*100),1)))
    else:
        # Keep the intermediate as requested; never replace an earlier successful export.
        import shutil
        shutil.copyfile(combined,final)
    metadata,chapters=ffmetadata(edl)
    if chapters:
        chapter_file=folder/'chapters.ffmeta'; chapter_file.write_text(metadata,encoding='utf-8')
        before=folder/'edited-before-chapters.mp4'; final.rename(before)
        jobs.command([jobs.config.ffmpeg,'-nostdin','-v','error','-y','-i',str(before),'-f','ffmetadata','-i',str(chapter_file),'-map','0','-map_metadata','1','-map_chapters','1','-c','copy','-movflags','+faststart',str(final)],cancel)
    return final,width,height,(not burn or burned)
