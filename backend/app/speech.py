"""Offline optional speech adapters and bounded-memory energy fallback."""
import importlib.util
from pathlib import Path
import numpy as np
import soundfile as sf
from .audio import check_cancel
from .edit_decisions import merged
from .studio_models import Caption

def speech_capabilities(model_dir=''):
    whisper = bool(importlib.util.find_spec('faster_whisper')) and bool(model_dir) and (Path(model_dir)/'model.bin').is_file()
    silero = bool(importlib.util.find_spec('silero_vad')) and bool(importlib.util.find_spec('torch'))
    return {'silero':silero, 'whisper':whisper, 'whisper_message':'Offline model ready' if whisper else 'Install faster-whisper and set STUDIO_WHISPER_MODEL to a local CTranslate2 model directory. No runtime model downloads.'}

def energy_speech(levels, step, threshold):
    """Protect quiet consonants as well as loud vowels, relative to room tone."""
    if not levels: return []
    onset = 10 ** (threshold / 20)
    floor = float(np.percentile(levels, 20))
    # A 12 dB safety band retains soft syllables. Room tone alone should not
    # become speech, but uncertain/noisy material is kept rather than deleted.
    quiet_voice = min(onset, max(onset * .25, floor * 2))
    return merged([{'start': i * step, 'end': (i + 1) * step}
                   for i, level in enumerate(levels) if level >= quiet_voice],
                  0, len(levels) * step)

def analyze(path, engine, threshold, cancel, progress):
    levels, speech, warnings, used = [], [], [], 'energy'
    model = timestamps = torch = None
    if engine in ('auto','silero'):
        try:
            if not speech_capabilities()['silero']: raise RuntimeError('Silero is not installed')
            import torch
            from silero_vad import load_silero_vad, get_speech_timestamps
            torch.set_num_threads(1)
            model, timestamps = load_silero_vad(), get_speech_timestamps
            used = 'silero'
        except Exception as exc:
            if engine == 'silero': raise ValueError(f'Silero VAD unavailable: {exc}')
            warnings.append('Silero unavailable. Using energy-based pause suggestions; review quiet speech carefully.')
    with sf.SoundFile(path) as src:
        sr, total = src.samplerate, len(src)
        frame, block = max(1, round(sr*.02)), sr*30
        for start in range(0,total,block):
            check_cancel(cancel); src.seek(start)
            samples = src.read(min(block,total-start),dtype='float32',always_2d=True).mean(axis=1)
            for i in range(0,len(samples),frame):
                part = samples[i:i+frame]; rms = float(np.sqrt(np.mean(part*part)))
                levels.append(rms)
            if model is not None:
                # Overlap model windows so a word crossing a 30-second boundary
                # is not treated as the beginning/end of a separate utterance.
                left, right = max(0, start-sr), min(total, start+block+sr)
                src.seek(left)
                context = src.read(right-left,dtype='float32',always_2d=True).mean(axis=1)
                # 48 kHz source -> 16 kHz model with a real anti-aliasing resampler.
                from scipy.signal import resample_poly
                data = resample_poly(context,16000,sr).astype('float32')
                regions = timestamps(torch.from_numpy(data),model,sampling_rate=16000,return_seconds=True,speech_pad_ms=0)
                speech.extend({'start':max(start/sr,left/sr+r['start']),
                               'end':min((start+len(samples))/sr,left/sr+r['end'])} for r in regions)
            progress(min(1,(start+len(samples))/max(1,total)))
    if model is None: speech = energy_speech(levels, frame/sr, threshold)
    return {'speech':merged(speech,0,total/sr), 'waveform':{'levels':levels,'step':frame/sr}, 'engine':used,'warnings':warnings}

def transcribe(path, model_dir, language, cancel, progress):
    if not speech_capabilities(model_dir)['whisper']: raise ValueError('Offline Whisper model is not installed/configured. Disable captions or install the local model first.')
    from faster_whisper import WhisperModel
    model = WhisperModel(model_dir,device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
    segments, info = model.transcribe(str(path),language=None if language=='auto' else language,beam_size=3,vad_filter=False,condition_on_previous_text=False)
    result=[]
    for i,segment in enumerate(segments):
        check_cancel(cancel)
        if segment.end>segment.start and segment.text.strip(): result.append(Caption(id=f'caption-{i}',start=max(0,segment.start),end=segment.end,text=segment.text.strip()))
        progress(min(1,segment.end/max(.1,info.duration)))
    return result
