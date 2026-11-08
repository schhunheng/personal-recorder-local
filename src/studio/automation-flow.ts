import type { EDL, LocalJob } from './pipeline';
export const editingSteps = [
  'Settings',
  'Process',
  'Review',
  'Download',
] as const;
export type EditingStep = 0 | 1 | 2 | 3;
export const processingLabels = [
  'Save originals',
  'Prepare audio',
  'Clean voice',
  'Prepare edits',
  'Render video',
  'Save finished video',
];
export function processingStage(job?: LocalJob, upload?: number) {
  if (upload !== undefined) return 0;
  if (!job) return -1;
  if (job.status === 'completed') return processingLabels.length;
  if (job.status === 'failed' || job.status === 'cancelled') return -1;
  if (/Saving edited video/.test(job.stage)) return 5;
  return (
    (
      {
        queued: 1,
        validating: 1,
        extracting: 1,
        cleaning: 2,
        detecting: 3,
        planning: 3,
        transcribing: 3,
        rendering: 4,
      } as Record<string, number>
    )[job.status] ?? -1
  );
}
export function audioReady(job?: LocalJob) {
  return (
    !!job &&
    (job.audio_ready ??
      [
        'detecting',
        'planning',
        'transcribing',
        'rendering',
        'completed',
      ].includes(job.status))
  );
}
export function cutsChanged(
  draft: Pick<EDL, 'cuts'> | undefined,
  job?: LocalJob
) {
  const signature = (
    cuts: { start: number; end: number; accepted: boolean }[]
  ) =>
    JSON.stringify(
      cuts.map(({ start, end, accepted }) => [start, end, accepted])
    );
  return (
    !!draft &&
    !!job?.result &&
    signature(draft.cuts) !== signature(job.result.edl.cuts)
  );
}
