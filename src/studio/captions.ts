import type { Caption, Edits } from './model';
import { segments } from './timeline';
function stamp(value: string) {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match || +match[2] > 59 || +match[3] > 59)
    throw Error('Invalid subtitle timestamp. Use HH:MM:SS,mmm.');
  return +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
}
export function parseSRT(text: string, duration: number): Caption[] {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/);
  const captions: Caption[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    if (!lines[0]) continue;
    const parts = lines.shift()!.split(/\s+-->\s+/);
    if (parts.length !== 2) throw Error('Invalid SRT subtitle block.');
    const start = stamp(parts[0]),
      end = stamp(parts[1]);
    if (end <= start || end > duration + 0.1)
      throw Error(
        'Subtitle timestamps must be ordered and inside the original recording.'
      );
    const content = lines.join('\n').trim();
    if (content.length > 1200) throw Error('Subtitle text is too long.');
    if (content)
      captions.push({ id: crypto.randomUUID(), start, end, text: content });
    if (captions.length > 20000) throw Error('Too many subtitles.');
  }
  return captions.sort((a, b) => a.start - b.start);
}
export function outputCaptions(edits: Edits): Caption[] {
  const result: Caption[] = [];
  let offset = 0;
  for (const range of segments(edits)) {
    for (const c of edits.captions || []) {
      const start = Math.max(c.start, range.start),
        end = Math.min(c.end, range.end);
      if (end > start)
        result.push({
          ...c,
          start: offset + start - range.start,
          end: offset + end - range.start,
        });
    }
    offset += range.end - range.start;
  }
  return result;
}
export function toSRT(captions: Caption[]) {
  const timestamp = (t: number) => {
    const ms = Math.round(t * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(
      Math.floor(ms / 60000) % 60
    ).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(
      2,
      '0'
    )},${String(ms % 1000).padStart(3, '0')}`;
  };
  return (
    captions
      .map(
        (c, i) =>
          `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.text}`
      )
      .join('\n\n') + '\n'
  );
}
