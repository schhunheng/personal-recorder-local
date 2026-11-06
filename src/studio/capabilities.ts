export const MP4 = 'video/mp4;codecs=avc1.42001E,mp4a.40.2';
export const WEBM = 'video/webm;codecs=vp8,opus';
export function capabilities() {
  const supports = (mime: string) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
  return {
    secure: window.isSecureContext,
    capture: !!navigator.mediaDevices?.getDisplayMedia,
    microphone: !!navigator.mediaDevices?.getUserMedia,
    recorder: typeof MediaRecorder !== 'undefined',
    mp4: supports(MP4),
    webm: supports(WEBM),
    opfs: !!navigator.storage?.getDirectory,
    webcodecs: 'VideoEncoder' in window,
    audioWorklet: 'AudioWorkletNode' in window,
  };
}
export function recordingMime() {
  const c = capabilities();
  if (c.webm) return WEBM;
  if (c.mp4) return MP4;
  throw Error('No supported video encoder. Try the latest desktop Chrome.');
}
export function mediaError(e: unknown) {
  if (e instanceof DOMException && e.name === 'NotAllowedError')
    return 'Permission was declined. Allow screen, microphone or camera access in Chrome and macOS Settings, then try again.';
  if (e instanceof DOMException && e.name === 'NotFoundError')
    return 'The selected device is unavailable. Reconnect it or choose another input.';
  return e instanceof Error ? e.message : String(e);
}
