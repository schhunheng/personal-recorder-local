"""Source-time edits, retained segments, and safe subtitle/chapter remapping."""
from uuid import uuid4
from .studio_models import EDL, Cut, Zoom, Marker, Caption, Chapter, PipelineOptions

def merged(ranges, start, end):
    result = []
    for a, b in sorted((max(start, float(r['start'])), min(end, float(r['end']))) for r in ranges):
        if b <= a: continue
        if result and a <= result[-1]['end']: result[-1]['end'] = max(result[-1]['end'], b)
        else: result.append({'start': a, 'end': b})
    return result

def retained(edl: EDL):
    current, end, result = edl.trim.start, edl.trim.end, []
    for cut in merged([c.model_dump() for c in edl.cuts if c.accepted], current, end):
        if cut['start'] > current: result.append({'start': current, 'end': cut['start']})
        current = cut['end']
    if current < end: result.append({'start': current, 'end': end})
    return result

def duration(edl):
    return sum(r['end'] - r['start'] for r in retained(edl))

def silence_cuts(speech, length, minimum=1.5, padding=.3):
    speech = merged(speech, 0, length)
    if not speech: return []  # Never silently remove an entirely quiet lesson.
    result, end = [], 0
    for region in speech + [{'start': length, 'end': length}]:
        if region['start'] - end >= minimum:
            start = end + (padding if end > 0 else 0)
            finish = region['start'] - (padding if region['start'] < length else 0)
            if finish - start > .05:
                result.append(Cut(id=str(uuid4()), start=start, end=finish, reason='silence'))
        end = max(end, region['end'])
    return result

def plan_edits(length: float, speech, markers: list[Marker], options: PipelineOptions):
    edl = options.edl.model_copy(deep=True) if options.edl else EDL(source_duration=length, trim={'start':0, 'end':length})
    if options.action == 'render': return edl
    # Preserve explicit manual edits and replace only previous automatic suggestions.
    edl.cuts = [c for c in edl.cuts if c.reason == 'manual']
    suggestions = silence_cuts(speech, length, options.minimum_silence, options.speech_padding)
    for cut in suggestions: cut.accepted = options.accept_silence
    edl.cuts.extend(suggestions)
    auto_zoom = not edl.zooms
    retake = None
    for marker in sorted(markers, key=lambda m: m.time):
        if marker.kind == 'retake_start': retake = marker.time
        elif marker.kind == 'retake_end' and retake is not None:
            if marker.time > retake: edl.cuts.append(Cut(id=marker.id, start=retake, end=min(length,marker.time), reason='retake'))
            retake = None
        elif marker.kind in ('zoom', 'important') and options.preset != 'clean' and auto_zoom:
            edl.zooms += [Zoom(id=marker.id, time=marker.time, x=marker.x, y=marker.y, scale=1.7), Zoom(id=marker.id+'-reset', time=min(length, marker.time+6), scale=1)]
    if options.preset == 'social':
        edl.appearance.ratio = '9:16'; edl.caption_style.size = 58
        edl.appearance.watermark = True; edl.appearance.intro = True; edl.appearance.outro = True
        if edl.trim.end-edl.trim.start > options.clip_seconds:
            focus=next((m.time for m in markers if m.kind=='important' and edl.trim.start<=m.time<edl.trim.end),edl.trim.start+5)
            start=max(edl.trim.start,min(edl.trim.end-options.clip_seconds,focus-5))
            edl.trim.start=start; edl.trim.end=start+options.clip_seconds
    if duration(edl) < .5: edl.cuts = [c.model_copy(update={'accepted':False}) for c in edl.cuts]
    return edl

def mapped_captions(edl: EDL):
    result, offset = [], 0
    for region in retained(edl):
        for caption in edl.captions:
            start, end = max(caption.start,region['start']), min(caption.end,region['end'])
            if end > start:
                result.append(Caption(id=caption.id, start=offset+start-region['start'], end=offset+end-region['start'], text=caption.text))
        offset += region['end']-region['start']
    return result

def source_to_output(edl, time):
    offset = 0
    for r in retained(edl):
        if r['start'] <= time < r['end']: return offset+time-r['start']
        offset += r['end']-r['start']
    return None

def srt(captions):
    def stamp(t):
        ms = round(t*1000); return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    return '\n\n'.join(f'{i+1}\n{stamp(c.start)} --> {stamp(c.end)}\n{c.text.replace(chr(13), "")}' for i,c in enumerate(captions))+'\n'

def suggest_chapters(captions, markers):
    result = [Chapter(time=m.time, title=m.label or 'Lesson section') for m in markers if m.kind == 'chapter']
    last = -120
    for caption in captions:
        if caption.start-last >= 120 and len(caption.text.strip()) >= 12:
            result.append(Chapter(time=caption.start,title=caption.text.strip()[:100])); last=caption.start
    return sorted(result,key=lambda c:c.time)[:200]

def ffmetadata(edl):
    points=[]
    for chapter in edl.chapters:
        output=source_to_output(edl,chapter.time)
        if output is not None: points.append((output,chapter.title))
    points=sorted(dict(points).items())
    def escape(text):
        return text.replace('\\','\\\\').replace('\n',' ').replace('\r',' ').replace('=','\\=').replace(';','\\;').replace('#','\\#')
    lines=[';FFMETADATA1']
    for index,(start,title) in enumerate(points):
        end=points[index+1][0] if index+1<len(points) else duration(edl)
        if end>start: lines += ['[CHAPTER]','TIMEBASE=1/1000',f'START={round(start*1000)}',f'END={round(end*1000)}',f'title={escape(title)}']
    return '\n'.join(lines)+'\n',bool(points)
