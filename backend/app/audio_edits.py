"""Assemble retained audio in PCM so AAC priming never repeats at each cut."""
import numpy as np
import soundfile as sf
from .audio import check_cancel


def assemble_audio(source, target, ranges, cancel):
    try:
        with sf.SoundFile(source) as incoming, sf.SoundFile(
            target, 'w', samplerate=incoming.samplerate,
            channels=incoming.channels, subtype='PCM_24',
        ) as outgoing:
            rate = incoming.samplerate
            for region in ranges:
                check_cancel(cancel)
                start = round(region['start'] * rate)
                count = round(region['end'] * rate) - start
                incoming.seek(start)
                # Five millisecond ramps remove clicks without overlapping
                # words, changing the timeline, or fading whole syllables.
                fade = min(round(rate * .005), count // 2)
                written = 0
                while written < count:
                    check_cancel(cancel)
                    data = incoming.read(min(rate * 5, count-written),
                                         dtype='float32', always_2d=True)
                    if not len(data): raise ValueError('Retained audio exceeds the source timeline.')
                    positions = np.arange(written, written + len(data))
                    if fade:
                        ramp = np.minimum(np.minimum(positions / fade,
                                                     (count-1-positions) / fade), 1)
                        data *= np.sin(np.maximum(0, ramp) * np.pi / 2)[:, None] ** 2
                    outgoing.write(data)
                    written += len(data)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
