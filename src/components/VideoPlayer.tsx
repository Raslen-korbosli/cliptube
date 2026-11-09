import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Loader2, Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useYouTubePlayer } from '../hooks/useYouTubePlayer';
import type { YTPlayer } from '../types';
import { fmt } from '../lib/time';
import { usePlayhead } from '../lib/playhead';
import { getMediaUrl } from '../utils';

interface VideoPlayerProps {
  videoId: string;
  duration: number;
  isPlaying: boolean;
  onDurationReady: (duration: number) => void;
  onTimeUpdate: (currentTime: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onPlayPause: () => void;
  playerRef: MutableRefObject<YTPlayer | null>;
}

const CONTAINER_ID = 'yt-player-container';
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
const API_BASE = import.meta.env.VITE_API_URL || '';

function VideoPlayerImpl({
  videoId,
  duration,
  isPlaying,
  onDurationReady,
  onTimeUpdate,
  onPlayingChange,
  onPlayPause,
  playerRef: externalPlayerRef,
}: VideoPlayerProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const prevVideoId = useRef('');

  const ytInstanceRef = useRef<YTPlayer | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [retryCount, setRetryCount] = useState(0);

  const isSocial = Boolean(
    videoId && (videoId.startsWith('tt_') || videoId.startsWith('ig_') || videoId.startsWith('fb_'))
  );

  const onTimeRef = useRef(onTimeUpdate);
  onTimeRef.current = onTimeUpdate;
  const onDurationRef = useRef(onDurationReady);
  onDurationRef.current = onDurationReady;
  const onPlayingRef = useRef(onPlayingChange);
  onPlayingRef.current = onPlayingChange;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  usePlayhead((t) => {
    if (timeRef.current) timeRef.current.textContent = fmt(t, true, durationRef.current >= 3600);
  });

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startLoop = useCallback(
    (player: YTPlayer) => {
      stopLoop();
      let last = -1;
      const tick = () => {
        try {
          const t = player.getCurrentTime();
          if (typeof t === 'number' && t !== last) {
            last = t;
            onTimeRef.current(t);
          }
        } catch {
          // ignore
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [stopLoop]
  );

  const bindHtml5Player = useCallback(
    (v: HTMLVideoElement) => {
      const adapter: YTPlayer = {
        playVideo: () => {
          v.play().catch(() => { });
        },
        pauseVideo: () => {
          v.pause();
        },
        seekTo: (seconds: number) => {
          if (Number.isFinite(seconds)) {
            v.currentTime = Math.max(0, seconds);
            onTimeRef.current(v.currentTime);
          }
        },
        getCurrentTime: () => v.currentTime || 0,
        getDuration: () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : durationRef.current),
        getPlayerState: () => {
          if (v.ended) return 0;
          if (v.paused) return 2;
          return 1;
        },
        mute: () => {
          v.muted = true;
        },
        unMute: () => {
          v.muted = false;
        },
        isMuted: () => v.muted,
        setPlaybackRate: (rate: number) => {
          v.playbackRate = rate;
        },
        destroy: () => {
          v.pause();
        },
      } as unknown as YTPlayer;

      externalPlayerRef.current = adapter;
      startLoop(adapter);
    },
    [externalPlayerRef, startLoop]
  );

  // Stable ref callback: an inline one would re-bind the player (and restart the rAF loop) on every render.
  const setVideoEl = useCallback(
    (el: HTMLVideoElement | null) => {
      videoElRef.current = el;
      if (el) bindHtml5Player(el);
    },
    [bindHtml5Player]
  );

  const { initPlayer } = useYouTubePlayer({
    containerId: CONTAINER_ID,
    onReady: useCallback(
      (player: YTPlayer) => {
        ytInstanceRef.current = player;
        if (isSocial) return;
        externalPlayerRef.current = player;
        setIsLoading(false);
        setHasError(false);
        const dur = player.getDuration();
        if (dur > 0) onDurationRef.current(dur);
        startLoop(player);
      },
      [externalPlayerRef, startLoop, isSocial]
    ),
    onStateChange: useCallback(
      (state: number, player: YTPlayer) => {
        if (isSocial) return;
        if (state === 1) {
          onPlayingRef.current(true);
          const dur = player.getDuration();
          if (dur > 0) onDurationRef.current(dur);
        } else if (state === 2 || state === 0) {
          onPlayingRef.current(false);
        }
      },
      [isSocial]
    ),
    onError: useCallback(() => {
      if (isSocial) return;
      setHasError(true);
      setIsLoading(false);
    }, [isSocial]),
  });

  useEffect(() => {
    if (!videoId || videoId === prevVideoId.current) return;
    prevVideoId.current = videoId;
    setIsLoading(true);
    setHasError(false);
    setRetryCount(0);

    if (isSocial) {
      try {
        ytInstanceRef.current?.pauseVideo?.();
      } catch {
        // ignore
      }
      if (videoElRef.current) {
        bindHtml5Player(videoElRef.current);
      }
    } else {
      const options = {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          start: 0,
        },
      } as Parameters<typeof initPlayer>[0];
      initPlayer(options);
    }
  }, [videoId, initPlayer, isSocial, bindHtml5Player]);

  useEffect(() => stopLoop, [stopLoop]);

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (isSocial && videoElRef.current) {
      videoElRef.current.playbackRate = next;
    } else {
      const player = externalPlayerRef.current as unknown as { setPlaybackRate?: (r: number) => void } | null;
      player?.setPlaybackRate?.(next);
    }
  };

  const toggleMute = () => {
    if (isSocial && videoElRef.current) {
      videoElRef.current.muted = !muted;
      setMuted(!muted);
    } else {
      const player = externalPlayerRef.current;
      if (!player) return;
      if (muted) player.unMute();
      else player.mute();
      setMuted(!muted);
    }
  };

  const toggleFullscreen = () => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else el.requestFullscreen().catch(() => { });
  };

  const socialTargetUrl = isSocial ? getMediaUrl(videoId) : '';

  return (
    <div ref={cardRef} className="ct-player">
      <div className="ct-video-frame">
        <div
          style={{
            display: isSocial ? 'none' : 'block',
            width: '100%',
            height: '100%',
          }}
        >
          <div id={CONTAINER_ID} />
        </div>

        {isSocial && (
          <video
            key={`${videoId}_${retryCount}`}
            ref={setVideoEl}
            src={`${API_BASE}/api/preview?url=${encodeURIComponent(socialTargetUrl)}&r=${retryCount}`}
            playsInline
            preload="auto"
            muted={muted}
            onLoadedMetadata={(e) => {
              setIsLoading(false);
              setHasError(false);
              const dur = e.currentTarget.duration;
              if (Number.isFinite(dur) && dur > 0) onDurationRef.current(dur);
            }}
            onCanPlay={() => {
              setIsLoading(false);
              setHasError(false);
            }}
            onPlay={() => onPlayingRef.current(true)}
            onPause={() => onPlayingRef.current(false)}
            onEnded={() => onPlayingRef.current(false)}
            onError={() => {
              if (retryCount < 2) {
                setTimeout(() => setRetryCount((c) => c + 1), 1500);
              } else {
                setHasError(true);
                setIsLoading(false);
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              background: '#000',
              display: 'block',
            }}
          />
        )}

        {isLoading && (
          <div className="ct-overlay" role="status">
            <Loader2 size={28} className="ct-spin" />
            <p>Loading preview…</p>
          </div>
        )}

        {hasError && !isLoading && (
          <div className="ct-overlay is-error" role="alert">
            <p className="ct-overlay-title">The preview can’t play this video</p>
            <p>
              {isSocial
                ? 'The preview stream didn’t load. Reload the page and try again. Downloading a clip may still work.'
                : 'It may be private, age-restricted or blocked from embedding. You can still try downloading a clip if the video is public.'}
            </p>
          </div>
        )}
      </div>

      <div className="ct-player-bar">
        <button
          type="button"
          className="ct-icon-btn is-solid"
          onClick={onPlayPause}
          aria-label={isPlaying ? 'Pause preview' : 'Play the selected clip'}
          title={isPlaying ? 'Pause (Space)' : 'Play the selected clip (Space)'}
        >
          {isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <span className="ct-time">
          <span ref={timeRef}>00:00.0</span>
          <span className="ct-time-sep">/</span>
          <span>{fmt(duration, false, duration >= 3600)}</span>
        </span>
        <span className="ct-spacer" />
        <button type="button" className="ct-chip-btn" onClick={cycleSpeed} title="Change playback speed" aria-label={`Playback speed ${speed}x, click to change`}>
          {speed}x
        </button>
        <button
          type="button"
          className="ct-icon-btn"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <button type="button" className="ct-icon-btn" onClick={toggleFullscreen} aria-label="Fullscreen" title="Fullscreen">
          <Maximize size={16} />
        </button>
      </div>
    </div>
  );
}

export default memo(VideoPlayerImpl);