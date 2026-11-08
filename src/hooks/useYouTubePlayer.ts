import { useEffect, useRef, useCallback } from 'react';
import type { YTPlayer, YTPlayerOptions } from '../types';

let apiLoaded = false;
let apiLoading = false;
const callbacks: Array<() => void> = [];

function loadYouTubeAPI(): Promise<void> {
  return new Promise((resolve) => {
    if (apiLoaded && window.YT) {
      resolve();
      return;
    }
    callbacks.push(resolve);
    if (apiLoading) return;
    apiLoading = true;

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    document.head.appendChild(script);

    window.onYouTubeIframeAPIReady = () => {
      apiLoaded = true;
      apiLoading = false;
      callbacks.forEach(cb => cb());
      callbacks.length = 0;
    };
  });
}

interface UseYouTubePlayerOptions {
  containerId: string;
  onReady?: (player: YTPlayer) => void;
  onStateChange?: (state: number, player: YTPlayer) => void;
  onError?: (code: number) => void;
}

export function useYouTubePlayer({
  containerId,
  onReady,
  onStateChange,
  onError,
}: UseYouTubePlayerOptions) {
  const playerRef = useRef<YTPlayer | null>(null);
  const onReadyRef = useRef(onReady);
  const onStateChangeRef = useRef(onStateChange);
  const onErrorRef = useRef(onError);

  // Keep refs up to date
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const initPlayer = useCallback((options: Partial<YTPlayerOptions> = {}) => {
    loadYouTubeAPI().then(() => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }

      playerRef.current = new window.YT.Player(containerId, {
        width: '100%',
        height: '100%',
        ...options,
        playerVars: {
          enablejsapi: 1,
          modestbranding: 1,
          rel: 0,
          origin: window.location.origin,
          ...options.playerVars,
        },
        events: {
          onReady: (e) => {
            onReadyRef.current?.(e.target);
          },
          onStateChange: (e) => {
            onStateChangeRef.current?.(e.data, e.target);
          },
          onError: (e) => {
            onErrorRef.current?.(e.data);
          },
        },
      });
    });
  }, [containerId]);

  const destroy = useCallback(() => {
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch { /* ignore */ }
      playerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => { destroy(); };
  }, [destroy]);

  return { playerRef, initPlayer, destroy };
}
