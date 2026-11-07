import { useEffect } from 'react';
export const playMedia = (media: HTMLMediaElement) =>
  window.dispatchEvent(new CustomEvent('studio-media-play', { detail: media }));
export function useMediaPlayback() {
  useEffect(() => {
    const play = (event: Event) => {
      const media = event.target;
      if (media instanceof HTMLMediaElement && !media.muted) playMedia(media);
    };
    const coordinate = (event: Event) => {
      const active = (event as CustomEvent<HTMLMediaElement>).detail;
      document
        .querySelectorAll<HTMLMediaElement>('video,audio')
        .forEach((media) => {
          if (media !== active && !media.muted) media.pause();
        });
    };
    document.addEventListener('play', play, true);
    window.addEventListener('studio-media-play', coordinate);
    return () => {
      document.removeEventListener('play', play, true);
      window.removeEventListener('studio-media-play', coordinate);
    };
  }, []);
}
