/// <reference lib="webworker" />
import { detectSilence } from './timeline';
self.onmessage = ({
  data,
}: MessageEvent<{
  levels: number[];
  step: number;
  threshold: number;
  minimum: number;
}>) => {
  self.postMessage({
    silence: detectSilence(
      data.levels,
      data.step,
      data.threshold,
      data.minimum
    ),
  });
};
