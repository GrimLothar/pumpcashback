let audioCache: HTMLAudioElement | null = null;

export function playCashSound() {
  if (!audioCache) {
    audioCache = new Audio("/kaching.m4a");
  }
  audioCache.currentTime = 0;
  audioCache.volume = 0.5;
  audioCache.play().catch(() => {});
}
