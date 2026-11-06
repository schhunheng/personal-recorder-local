import { clamp, type Edits, type Range, type Zoom } from './model';
export function mergeRanges(ranges: Range[], bounds: Range): Range[] {
  const result: Range[] = [];
  for (const range of ranges
    .map((r) => ({
      start: Math.max(bounds.start, r.start),
      end: Math.min(bounds.end, r.end),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
    )
    .sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
export function segments(edits: Edits): Range[] {
  let start = edits.trim.start;
  const result: Range[] = [];
  for (const cut of mergeRanges(edits.cuts, edits.trim)) {
    if (cut.start > start) result.push({ start, end: cut.start });
    start = cut.end;
  }
  if (start < edits.trim.end) result.push({ start, end: edits.trim.end });
  return result;
}
export const editedDuration = (edits: Edits) =>
  segments(edits).reduce((sum, r) => sum + r.end - r.start, 0);
export function zoomAt(zooms: Zoom[], time: number) {
  const sorted = [...zooms].sort((a, b) => a.time - b.time);
  type Pose = { scale: number; x: number; y: number };
  const bounded = (p: Pose): Pose => {
    const edge = 0.5 / p.scale;
    return {
      ...p,
      x: clamp(p.x, edge, 1 - edge),
      y: clamp(p.y, edge, 1 - edge),
    };
  };
  let origin: Pose = { scale: 1, x: 0.5, y: 0.5 },
    target = origin,
    start = 0,
    duration = 1;
  const interpolate = (t: number) => {
    const u = clamp((t - start) / duration),
      ease = u * u * (3 - 2 * u);
    return bounded({
      scale: origin.scale + (target.scale - origin.scale) * ease,
      x: origin.x + (target.x - origin.x) * ease,
      y: origin.y + (target.y - origin.y) * ease,
    });
  };
  for (const z of sorted) {
    if (time < z.time) break;
    origin = interpolate(z.time);
    target = { scale: clamp(z.scale, 1, 3), x: clamp(z.x), y: clamp(z.y) };
    start = z.time;
    duration = Math.max(0.05, z.duration);
  }
  return interpolate(time);
}
export function detectSilence(
  levels: number[],
  step: number,
  thresholdDb: number,
  minimum: number,
  padding = 0.18
): Range[] {
  const result: Range[] = [];
  let start = -1;
  const threshold = 10 ** (thresholdDb / 20);
  for (let i = 0; i <= levels.length; i++) {
    if (i < levels.length && levels[i] < threshold) {
      if (start < 0) start = i * step;
    } else if (start >= 0) {
      const end = i * step;
      if (end - start >= minimum + padding * 2)
        result.push({ start: start + padding, end: end - padding });
      start = -1;
    }
  }
  return result;
}
