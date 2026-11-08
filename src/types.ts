// YouTube IFrame API types
export interface YT {
  Player: new (elementId: string | HTMLElement, options: YTPlayerOptions) => YTPlayer;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

export interface YTPlayerOptions {
  videoId?: string;
  width?: number | string;
  height?: number | string;
  playerVars?: YTPlayerVars;
  events?: {
    onReady?: (e: YTPlayerEvent) => void;
    onStateChange?: (e: YTPlayerStateEvent) => void;
    onError?: (e: YTPlayerErrorEvent) => void;
  };
}

export interface YTPlayerVars {
  autoplay?: 0 | 1;
  controls?: 0 | 1 | 2;
  rel?: 0 | 1;
  modestbranding?: 0 | 1;
  start?: number;
  end?: number;
  enablejsapi?: 0 | 1;
  origin?: string;
  cc_load_policy?: 0 | 1;
}

export interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  getDuration(): number;
  getCurrentTime(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}

export interface YTPlayerEvent {
  target: YTPlayer;
}

export interface YTPlayerStateEvent {
  target: YTPlayer;
  data: number;
}

export interface YTPlayerErrorEvent {
  target: YTPlayer;
  data: number;
}

declare global {
  interface Window {
    YT: YT;
    onYouTubeIframeAPIReady: () => void;
  }
}

// Download options
export type ClipFormat = 'mp4' | 'mp3';
export type ClipQuality = '360p' | '720p' | '1080p';

export interface VideoInfo {
  title: string;
  duration: number;
  thumbnail: string;
}

export interface ClipDownloadRequest {
  url: string;
  start: number;
  end: number;
  format: ClipFormat;
  quality: ClipQuality;
  exact?: boolean;
  title?: string;
}

export interface ClipProgressEvent {
  percent: number;
  stage: string;
}

export interface ClipDoneEvent {
  clipId: string;
  elapsed: number;
  mode: string;
  sizeMB: number;
}

export interface ClipFailEvent {
  message: string;
}
