/**
 * Application branding & configuration constants.
 * Modify these to easily rebrand or configure the app.
 */
export const APP_CONFIG = {
  // Brand name
  name: 'ClipTube',
  logoPrefix: 'Clip',
  logoSuffix: 'Tube',
  tagline: 'Fast, free YouTube clip trimmer & downloader',
  description: 'Fast, free YouTube clip trimmer & downloader',

  // Defaults
  defaultUrl: 'https://www.youtube.com/watch?v=UtErJXiGTho',
  defaultVideoId: 'UtErJXiGTho',
  defaultStart: 3,
  defaultEnd: 8,
  defaultDuration: 11,

  // Limits
  maxClipSeconds: 600, // 10 minutes maximum clip length
};
