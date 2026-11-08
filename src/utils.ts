export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook';

// In-memory map from extracted mediaId (e.g. tt_..., ig_..., fb_...) to the original full URL
const mediaUrlMap = new Map<string, string>();

export function getMediaUrl(idOrUrl: string): string {
  return mediaUrlMap.get(idOrUrl) || idOrUrl;
}

/**
 * Detect whether a URL belongs to YouTube, TikTok, Instagram, or Facebook.
 */
export function detectPlatform(url: string): Platform | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  if (/^tt_/i.test(trimmed)) return 'tiktok';
  if (/^ig_/i.test(trimmed)) return 'instagram';
  if (/^fb_/i.test(trimmed)) return 'facebook';
  if (/^yt_/i.test(trimmed)) return 'youtube';

  // YouTube
  if (
    /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/i.test(trimmed) ||
    /^[A-Za-z0-9_-]{11}$/.test(trimmed)
  ) {
    return 'youtube';
  }

  // TikTok
  if (
    /^(https?:\/\/)?(www\.|m\.|vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/\d+|@[\w.-]+\/photo\/\d+|t\/[\w-]+|v\/\d+|[\w-]+)/i.test(trimmed)
  ) {
    return 'tiktok';
  }

  // Instagram
  if (
    /^(https?:\/\/)?(www\.|m\.)?(instagram\.com|instagr\.am)\/(reels?|p|tv|share\/reel|share\/p)\/[A-Za-z0-9_-]+/i.test(trimmed)
  ) {
    return 'instagram';
  }

  // Facebook (facebook.com/reel/, /watch, /videos/, /share/v/, /share/r/, fb.watch/)
  if (
    /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook\.com|fb\.watch|fb\.com)\/.+/i.test(trimmed)
  ) {
    return 'facebook';
  }

  return null;
}

/**
 * Parse a YouTube, TikTok, Instagram, or Facebook URL and return a unique video ID, or null if invalid.
 */
export function extractVideoId(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const platform = detectPlatform(trimmed);
  if (!platform) return null;

  if (platform === 'youtube') {
    const shortMatch = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];

    const watchMatch = trimmed.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (watchMatch) return watchMatch[1];

    const shortsMatch = trimmed.match(/shorts\/([A-Za-z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    const embedMatch = trimmed.match(/(?:embed|live)\/([A-Za-z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
    return null;
  }

  const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  if (platform === 'tiktok') {
    const videoMatch = trimmed.match(/\/(?:video|v|photo)\/(\d+)/);
    const id = videoMatch
      ? `tt_${videoMatch[1]}`
      : (() => {
        const shortCode = trimmed.match(/tiktok\.com\/(?:t\/)?([\w-]+)/i);
        return shortCode ? `tt_${shortCode[1]}` : `tt_${encodeURIComponent(trimmed)}`;
      })();
    mediaUrlMap.set(id, normalizedUrl);
    return id;
  }

  if (platform === 'instagram') {
    const igMatch = trimmed.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
    const id = igMatch ? `ig_${igMatch[1]}` : `ig_${encodeURIComponent(trimmed)}`;
    mediaUrlMap.set(id, normalizedUrl);
    return id;
  }

  if (platform === 'facebook') {
    const fbMatch =
      trimmed.match(/\/(?:videos|reel|watch\/?\?v=)(\d+)/i) ||
      trimmed.match(/\/share\/(?:v|r)\/([A-Za-z0-9_-]+)/i) ||
      trimmed.match(/fb\.watch\/([A-Za-z0-9_-]+)/i);
    const id = fbMatch ? `fb_${fbMatch[1]}` : `fb_${encodeURIComponent(trimmed).slice(0, 32)}`;
    mediaUrlMap.set(id, normalizedUrl);
    return id;
  }

  return null;
}

/**
 * Format seconds to mm:ss or hh:mm:ss string
 */
export function formatTime(secs: number, forceHours = false): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0 || forceHours) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Format seconds for safe filesystem names (e.g. 00-03 or 01-15-30)
 */
export function formatTimeForFilename(secs: number): string {
  return formatTime(secs).replace(/:/g, '-');
}

/**
 * Parse time string (accepts ss, mm:ss, hh:mm:ss, with optional decimal) to seconds.
 * Returns NaN on invalid.
 */
export function parseTime(str: string): number {
  if (!str) return NaN;
  const trimmed = str.trim();
  const parts = trimmed.split(':');

  if (parts.length === 1) {
    const s = parseFloat(parts[0]);
    return isNaN(s) ? NaN : Math.max(0, s);
  }

  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(s)) return NaN;
    return Math.max(0, m * 60 + s);
  }

  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
    return Math.max(0, h * 3600 + m * 60 + s);
  }

  return NaN;
}

/**
 * Clamp a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}