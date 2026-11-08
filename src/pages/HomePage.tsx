import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Sparkles, X } from 'lucide-react';
import UrlBar from '../components/UrlBar';
import VideoPlayer from '../components/VideoPlayer';
import TrimRangeSlider from '../components/TrimRangeSlider';
import ExportPanel from '../components/ExportPanel';
import type {
  YTPlayer,
  ClipFormat,
  ClipQuality,
  VideoInfo,
  ClipProgressEvent,
  ClipDoneEvent,
  ClipFailEvent,
} from '../types';
import { APP_CONFIG } from '../config';
import { MIN_GAP, clamp } from '../lib/time';
import { playhead } from '../lib/playhead';

const DEFAULT_CLIP_SECONDS = 30;
const SSE_SILENCE_LIMIT_MS = 180_000;
const SSE_MAX_RECONNECTS = 5;
const SEEK_THROTTLE_MS = 140;

function describeMode(mode: string): string {
  if (!mode) return 'done';
  if (mode.includes('parallel-fetch')) return 'fast mode';
  if (mode.includes('ytdlp')) return 'standard mode';
  if (mode.includes('direct')) return 'direct mode';
  if (mode.includes('social')) return 'optimized mode';
  return mode;
}

type DoneExtras = ClipDoneEvent & { downgraded?: boolean; actualQuality?: string; requestedQuality?: string };

interface HomePageProps {
  onVideoLoadStateChange?: (hasVideo: boolean) => void;
}

export default function HomePage({ onVideoLoadStateChange }: HomePageProps = {}) {
  // Start empty so only the modern hero + search bar appear initially
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [thumbnail, setThumbnail] = useState('');
  const [duration, setDuration] = useState(0);
  const [startSeconds, setStartSeconds] = useState(0);
  const [endSeconds, setEndSeconds] = useState(DEFAULT_CLIP_SECONDS);
  const [isPlaying, setIsPlaying] = useState(false);

  const [format, setFormat] = useState<ClipFormat>('mp4');
  const [quality, setQuality] = useState<ClipQuality>('1080p');
  const [exactCut, setExactCut] = useState(false);

  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const playerRef = useRef<YTPlayer | null>(null);
  const rangeRef = useRef({ start: startSeconds, end: endSeconds });
  const durationRef = useRef(duration);
  const previewRef = useRef(false);
  const playingRef = useRef(false);
  const lastSeekRef = useRef(0);
  const evtSourceRef = useRef<EventSource | null>(null);
  const infoRequestRef = useRef(0);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasVideo = Boolean(videoId);

  useEffect(() => {
    onVideoLoadStateChange?.(hasVideo);
  }, [hasVideo, onVideoLoadStateChange]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    return () => {
      evtSourceRef.current?.close();
      evtSourceRef.current = null;
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  // ─── Video info ────────────────────────────────────────────────────────────
  const fetchVideoInfo = useCallback(async (targetUrl: string) => {
    const requestId = ++infoRequestRef.current;
    setIsLoadingInfo(true);
    setErrorMessage('');
    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!res.ok) {
        if (res.status === 502 || res.status === 503) {
          throw new Error('The server isn’t running. Start it with "npm run dev" and try again.');
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Couldn’t read this video’s details.');
      }

      const info: VideoInfo & { thumbnail?: string } = await res.json();
      if (requestId !== infoRequestRef.current) return;

      if (info.duration && info.duration > 0) {
        const end = Math.min(info.duration, DEFAULT_CLIP_SECONDS);
        setDuration(info.duration);
        setStartSeconds(0);
        setEndSeconds(end);
        rangeRef.current = { start: 0, end };
      }
      if (info.title) setVideoTitle(info.title);
      if (info.thumbnail) setThumbnail(info.thumbnail);
    } catch (err: unknown) {
      if (requestId !== infoRequestRef.current) return;
      setErrorMessage(err instanceof Error ? err.message : 'Couldn’t reach the server.');
    } finally {
      if (requestId === infoRequestRef.current) setIsLoadingInfo(false);
    }
  }, []);

  const handleLoad = useCallback(
    (newId: string, rawUrl: string) => {
      const end = DEFAULT_CLIP_SECONDS;
      setVideoId(newId);
      setUrl(rawUrl);
      setVideoTitle('');
      setThumbnail('');
      setDuration(0);
      setStartSeconds(0);
      setEndSeconds(end);
      rangeRef.current = { start: 0, end };
      previewRef.current = false;
      playingRef.current = false;
      setIsPlaying(false);
      playhead.set(0);
      setErrorMessage('');
      setStatusMessage('');
      fetchVideoInfo(rawUrl);
    },
    [fetchVideoInfo]
  );

  // Return to the clean initial landing screen when the user clears the URL bar
  const handleClear = useCallback(() => {
    infoRequestRef.current += 1;
    try {
      playerRef.current?.pauseVideo?.();
    } catch {
      // ignore
    }
    setVideoId('');
    setUrl('');
    setVideoTitle('');
    setThumbnail('');
    setDuration(0);
    setStartSeconds(0);
    setEndSeconds(DEFAULT_CLIP_SECONDS);
    setIsLoadingInfo(false);
    setIsPlaying(false);
    previewRef.current = false;
    playingRef.current = false;
    playhead.set(0);
    setErrorMessage('');
    setStatusMessage('');
  }, []);

  const handleDurationReady = useCallback((dur: number) => {
    if (!(dur > 0)) return;
    setDuration(dur);
    durationRef.current = dur;
    setEndSeconds((prev) => {
      const next = prev > 0 && prev <= dur ? prev : Math.min(dur, DEFAULT_CLIP_SECONDS);
      rangeRef.current = { start: rangeRef.current.start, end: next };
      return next;
    });
  }, []);

  // ─── Preview playback ──────────────────────────────────────────────────────
  const handleTimeUpdate = useCallback((t: number) => {
    playhead.set(t);
    const { start, end } = rangeRef.current;
    if (previewRef.current && t >= end - 0.05) {
      const p = playerRef.current;
      p?.pauseVideo();
      p?.seekTo(start, true);
      playhead.set(start);
      previewRef.current = false;
      playingRef.current = false;
      setIsPlaying(false);
    }
  }, []);

  const handlePlayingChange = useCallback((playing: boolean) => {
    playingRef.current = playing;
    setIsPlaying(playing);
    if (!playing) previewRef.current = false;
  }, []);

  const handlePlayPause = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playingRef.current) {
      p.pauseVideo();
      previewRef.current = false;
      playingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const { start, end } = rangeRef.current;
    const cur = p.getCurrentTime();
    if (cur < start - 0.05 || cur >= end - 0.1) {
      p.seekTo(start, true);
      playhead.set(start);
    }
    previewRef.current = true;
    playingRef.current = true;
    setIsPlaying(true);
    p.playVideo();
  }, []);

  const seekTo = useCallback((t: number, final: boolean) => {
    playhead.set(t);
    const p = playerRef.current;
    if (!p) return;
    const now = performance.now();
    if (final || now - lastSeekRef.current > SEEK_THROTTLE_MS) {
      lastSeekRef.current = now;
      try {
        p.seekTo(t, final);
      } catch {
        // player not ready
      }
    }
  }, []);

  // ─── Trim range ────────────────────────────────────────────────────────────
  const handleRangeChange = useCallback(
    (s: number, e: number, final: boolean, moved: 'start' | 'end') => {
      const maxEnd = durationRef.current > 0 ? durationRef.current : 99999;
      let ns: number;
      let ne: number;
      if (moved === 'start') {
        ne = clamp(e, MIN_GAP, maxEnd);
        ns = clamp(s, 0, ne - MIN_GAP);
      } else {
        ns = clamp(s, 0, Math.max(0, maxEnd - MIN_GAP));
        ne = clamp(e, ns + MIN_GAP, maxEnd);
      }
      rangeRef.current = { start: ns, end: ne };
      setStartSeconds(ns);
      setEndSeconds(ne);
      seekTo(moved === 'start' ? ns : ne, final);
    },
    [seekTo]
  );

  const handleReset = useCallback(() => {
    const end = Math.min(durationRef.current > 0 ? durationRef.current : DEFAULT_CLIP_SECONDS, DEFAULT_CLIP_SECONDS);
    rangeRef.current = { start: 0, end };
    setStartSeconds(0);
    setEndSeconds(end);
    previewRef.current = false;
    playingRef.current = false;
    setIsPlaying(false);
    setErrorMessage('');
    setStatusMessage('');
    playhead.set(0);
    const p = playerRef.current;
    if (p) {
      p.pauseVideo();
      p.seekTo(0, true);
    }
  }, []);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasVideo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      if (el?.getAttribute('role') === 'slider') return;

      if (e.code === 'Space') {
        if (tag === 'button') return;
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'i' || e.key === 'I') {
        handleRangeChange(playhead.get(), rangeRef.current.end, true, 'start');
      } else if (e.key === 'o' || e.key === 'O') {
        handleRangeChange(rangeRef.current.start, playhead.get(), true, 'end');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const p = playerRef.current;
        if (!p) return;
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        seekTo(clamp(p.getCurrentTime() + step, 0, durationRef.current || 99999), true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasVideo, handlePlayPause, handleRangeChange, seekTo]);

  useEffect(() => {
    if (!isDownloading) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDownloading]);

  // ─── Download: POST /api/clip → SSE progress → GET /api/download ───────────
  const handleDownload = async () => {
    if (!url || startSeconds >= endSeconds || isDownloading) return;

    const clipLength = endSeconds - startSeconds;
    if (clipLength > APP_CONFIG.maxClipSeconds) {
      setErrorMessage(`This clip is ${Math.round(clipLength)}s long. The limit is ${APP_CONFIG.maxClipSeconds}s.`);
      return;
    }

    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }

    playerRef.current?.pauseVideo();

    setIsDownloading(true);
    setDownloadProgress(0);
    setErrorMessage('');
    setStatusMessage('Starting…');

    let watchdog: ReturnType<typeof setInterval> | null = null;

    try {
      const response = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          start: startSeconds,
          end: endSeconds,
          format,
          quality,
          exact: exactCut,
          title: videoTitle,
        }),
      });

      if (!response.ok) {
        if (response.status === 502 || response.status === 503) {
          throw new Error('The server isn’t running. Start it with "npm run dev" and try again.');
        }
        if (response.status === 429) {
          throw new Error('Too many requests. Wait a moment and try again.');
        }
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `The server returned an error (${response.status}).`);
      }

      const { clipId } = await response.json();

      const result = await new Promise<ClipDoneEvent>((resolve, reject) => {
        const evtSource = new EventSource(`/api/progress/${clipId}`);
        evtSourceRef.current = evtSource;

        let lastEventAt = Date.now();
        let reconnects = 0;
        const touch = () => {
          lastEventAt = Date.now();
          reconnects = 0;
        };

        watchdog = setInterval(() => {
          if (Date.now() - lastEventAt > SSE_SILENCE_LIMIT_MS) {
            evtSource.close();
            evtSourceRef.current = null;
            reject(new Error('The server stopped responding. Try again.'));
          }
        }, 5000);

        evtSource.addEventListener('progress', (e: MessageEvent) => {
          touch();
          try {
            const { percent, stage } = JSON.parse(e.data) as ClipProgressEvent;
            setDownloadProgress(percent);
            setStatusMessage(stage);
          } catch {
            // ignore
          }
        });

        evtSource.addEventListener('done', (e: MessageEvent) => {
          evtSource.close();
          evtSourceRef.current = null;
          try {
            resolve(JSON.parse(e.data) as ClipDoneEvent);
          } catch {
            resolve({ clipId, elapsed: 0, mode: 'unknown', sizeMB: 0 });
          }
        });

        evtSource.addEventListener('fail', (e: MessageEvent) => {
          evtSource.close();
          evtSourceRef.current = null;
          try {
            const { message } = JSON.parse(e.data) as ClipFailEvent;
            reject(new Error(message));
          } catch {
            reject(new Error('The clip couldn’t be made. Try again.'));
          }
        });

        evtSource.onerror = () => {
          if (evtSource.readyState === EventSource.CLOSED) {
            evtSourceRef.current = null;
            reject(new Error('Lost the connection to the server.'));
            return;
          }
          reconnects += 1;
          if (reconnects > SSE_MAX_RECONNECTS) {
            evtSource.close();
            evtSourceRef.current = null;
            reject(new Error('Lost the connection to the server.'));
          }
        };
      });

      setDownloadProgress(100);
      const extra = result as DoneExtras;
      const size = result.sizeMB ? `${result.sizeMB} MB` : 'Clip';
      const took = result.elapsed ? ` in ${result.elapsed}s` : '';
      const qualityNote = extra.downgraded
        ? ` ${extra.requestedQuality || 'HD'} was unavailable, so it was saved at ${extra.actualQuality}.`
        : '';
      setStatusMessage(`Downloaded. ${size}${took} (${describeMode(result.mode)}).${qualityNote}`);

      const link = document.createElement('a');
      link.href = `/api/download/${clipId}`;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      statusTimerRef.current = setTimeout(() => setStatusMessage(''), 10000);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'The clip couldn’t be made. Try again.');
      setStatusMessage('');
    } finally {
      if (watchdog) clearInterval(watchdog);
      setIsDownloading(false);
      setDownloadProgress(0);
      evtSourceRef.current?.close();
      evtSourceRef.current = null;
    }
  };

  const clipSeconds = Math.max(0, endSeconds - startSeconds);
  const canDownload = Boolean(url) && startSeconds < endSeconds && clipSeconds <= APP_CONFIG.maxClipSeconds;

  return (
    <div className={`ct-wrap ${hasVideo ? 'is-workspace' : 'is-landing'}`}>
      {!hasVideo && (
        <div className="ct-intro ct-hero-intro">
          <div className="ct-hero-badge">
            <Sparkles size={14} />
            <span>YouTube · TikTok · Instagram Trimmer</span>
          </div>
          <h1>Download just the part you need</h1>
          <p>
            Paste a link from YouTube, TikTok, or Instagram, trim the exact moment you want, and export it as MP4 or
            MP3. Instant &amp; no account needed.
          </p>
        </div>
      )}

      <UrlBar
        url={url}
        videoId={videoId}
        videoTitle={videoTitle}
        duration={duration}
        isLoading={isLoadingInfo}
        thumbnail={thumbnail}
        onLoad={handleLoad}
        onClear={handleClear}
      />

      {errorMessage && (
        <div className="ct-banner is-error" role="alert">
          <AlertCircle size={18} />
          <p>{errorMessage}</p>
          <button type="button" className="ct-icon-btn" onClick={() => setErrorMessage('')} aria-label="Dismiss message">
            <X size={15} />
          </button>
        </div>
      )}

      {statusMessage && !isDownloading && (
        <div className="ct-banner is-ok" role="status">
          <CheckCircle2 size={18} />
          <p>{statusMessage}</p>
        </div>
      )}

      {hasVideo && (
        <div className="ct-stage ct-stage-reveal">
          <div className="ct-editor">
            <VideoPlayer
              videoId={videoId}
              duration={duration}
              isPlaying={isPlaying}
              onDurationReady={handleDurationReady}
              onTimeUpdate={handleTimeUpdate}
              onPlayingChange={handlePlayingChange}
              onPlayPause={handlePlayPause}
              playerRef={playerRef}
            />
            <TrimRangeSlider
              duration={duration}
              start={startSeconds}
              end={endSeconds}
              isPlaying={isPlaying}
              maxClipSeconds={APP_CONFIG.maxClipSeconds}
              onRangeChange={handleRangeChange}
              onSeek={seekTo}
              onPlayPause={handlePlayPause}
              onReset={handleReset}
            />
          </div>

          <aside className="ct-rail">
            <ExportPanel
              format={format}
              quality={quality}
              exactCut={exactCut}
              clipSeconds={clipSeconds}
              maxClipSeconds={APP_CONFIG.maxClipSeconds}
              isDownloading={isDownloading}
              progress={downloadProgress}
              stage={statusMessage}
              canDownload={canDownload}
              onFormat={setFormat}
              onQuality={setQuality}
              onExactCut={setExactCut}
              onDownload={handleDownload}
            />
          </aside>
        </div>
      )}
    </div>
  );
}