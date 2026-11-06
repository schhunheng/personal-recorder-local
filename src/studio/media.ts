export async function loadVideo(url: string) {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          Error(
            'Media did not load. It may be damaged or use an unsupported codec.'
          )
        ),
      20000
    );
    video.onloadeddata = () => {
      clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timeout);
      reject(Error('Unsupported or corrupted video. Try WebM or H.264 MP4.'));
    };
  });
  return video;
}
export async function seek(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.025 && video.readyState >= 2)
    return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      video.removeEventListener('seeked', done);
      reject(
        Error(
          'Could not seek this media. Try downloading and reimporting the original.'
        )
      );
    }, 10000);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = time;
  });
}
export function unloadVideo(video?: HTMLVideoElement) {
  if (video) {
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
  }
}
