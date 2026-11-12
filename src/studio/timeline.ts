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
export const sameRange = (a: Range, b: Range) =>
  Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;
export function automaticCuts(edits: Edits): NonNullable<Edits['automaticCuts']> {
  // Older projects stored suggestions without their provenance. Recover exact
  // matches only; an overlapping manual edit remains a manual edit.
  return edits.automaticCuts ?? edits.cuts
    .filter((cut) => edits.silence?.some((suggestion) => sameRange(cut, suggestion)))
    .map((cut) => ({ ...cut, reason: 'silence' as const }));
}
export function updateSilenceSuggestions(
  edits: Edits,
  suggestions: Range[],
  selected?: Range[]
): Edits {
  const previous = automaticCuts(edits);
  if (!selected) return { ...edits, silence: suggestions, automaticCuts: previous };
  const manual = edits.cuts.filter((cut) => !previous.some((old) =>
    old.reason === 'silence' && sameRange(cut, old)
  ));
  return {
    ...edits,
    silence: suggestions,
    cuts: mergeRanges([...manual, ...selected], edits.trim),
    automaticCuts: [
      ...previous.filter((cut) => cut.reason !== 'silence'),
      ...selected.map((cut) => ({ ...cut, reason: 'silence' as const })),
    ],
  };
}
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
  padding = 0.4
): Range[] {
  if (!levels.length || !Number.isFinite(step) || step <= 0) return [];
  const result: Range[] = [];
  let start = -1;
  const onset = 10 ** (thresholdDb / 20);
  const ordered = [...levels].sort((a, b) => a - b);
  const position = (ordered.length - 1) * 0.2;
  const floor = ordered[Math.floor(position)] +
    (ordered[Math.ceil(position)] - ordered[Math.floor(position)]) * (position % 1);
  // Match the local editor's safety band for quieter syllables and consonants.
  const threshold = Math.min(onset, Math.max(onset * 0.25, floor * 2));
  if (!levels.some((level) => level >= threshold)) return [];
  for (let i = 0; i <= levels.length; i++) {
    if (i < levels.length && levels[i] < threshold) {
      if (start < 0) start = i * step;
    } else if (start >= 0) {
      const end = i * step;
      if (end - start >= minimum && end - start - padding * 2 >= 0.35)
        result.push({ start: start + padding, end: end - padding });
      start = -1;
    }
  }
  return result;
}
