/**
 * ClipTube Backend Server — v4.1 (YouTube, TikTok, Instagram, Facebook — Pure Fast Parallel Path)
 *
 * Fast path:  yt-dlp -j (stream URLs + the exact HTTP headers yt-dlp uses)
 *             → probe each player client → parallel range proxy + parallel ffmpeg (video + audio) → local mux
 * Preview:    Direct HTTP Range proxy over the extracted CDN URL (zero disk download)
 * Exact mode: one ffmpeg pass, both remote inputs, hardware/ultrafast re-encode
 * Fallback:   yt-dlp --download-sections (used only if the fast path is rejected or stalls)
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_CLIP_SECONDS = parseInt(process.env.MAX_CLIP_SECONDS || '600', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const USE_DIRECT_FFMPEG = (process.env.USE_DIRECT_FFMPEG ?? 'true').toLowerCase() !== 'false';
const COOKIES_FROM_BROWSER = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
const COOKIES_FILE = (process.env.YTDLP_COOKIES_FILE || '').trim();
// android_vr and tv serve native 1080p H.264 (avc1) direct streams without SABR throttling
const PLAYER_CLIENTS = (process.env.YTDLP_PLAYER_CLIENTS || 'android_vr,tv,default,mweb')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_CLIENT_ATTEMPTS = parseInt(process.env.MAX_CLIENT_ATTEMPTS || '4', 10);
const QUALITY_FALLBACK = (process.env.QUALITY_FALLBACK ?? 'true').toLowerCase() !== 'false';

const STALL_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const DIRECT_FAIL_LIMIT = 2;
const DIRECT_COOLDOWN_MS = 30 * 60_000;

const TEMP_DIR = path.join(os.tmpdir(), 'cliptube_temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Globals ────────────────────────────────────────────────────────────────
let resolvedYtDlp = 'yt-dlp';
let resolvedFfmpeg = 'ffmpeg';
let resolvedFfmpegDir = null;
let detectedEncoder = 'libx264';
let encoderLabel = 'libx264 (software, ultrafast)';
let jsRuntime = null;
let supportsJsRuntimes = false;
let workingClient = null;
let directFailStreak = 0;
let directDisabledUntil = 0;

// ─── Caches ─────────────────────────────────────────────────────────────────
const infoCache = new Map();          // videoId → { data, ts }
const streamCache = new Map();        // `${videoId}_${height}_${kind}` → { streams, client, ts }
const previewStreamCache = new Map(); // videoId → { stream, ts }
const aliasToUrl = new Map();         // frontend id (tt_..., ig_..., fb_...) → full URL
const INFO_TTL = 30 * 60_000;
const STREAM_TTL = 20 * 60_000;

function extractVideoId(url) {
  if (!url) return null;
  const t = String(url).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─── Supported sites ────────────────────────────────────────────────────────
const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com', 'instagr.am'],
  facebook: ['facebook.com', 'fb.watch', 'fb.com'],
};
const UNSUPPORTED_MSG = 'That link isn’t supported. Use a YouTube, TikTok, Instagram or Facebook video link.';

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Identify and normalise a pasted link (or frontend alias ID).
 * Returns { platform, url, key } or null.
 */
function resolveMedia(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t || t.length > 2048) return null;

  if (aliasToUrl.has(t)) t = aliasToUrl.get(t);
  else if (/^ig_([A-Za-z0-9_-]+)$/i.test(t)) t = `https://www.instagram.com/reel/${t.slice(3)}/`;
  else if (/^tt_(\d+)$/i.test(t)) t = `https://www.tiktok.com/@_/video/${t.slice(3)}`;

  if (/^[A-Za-z0-9_-]{11}$/.test(t)) {
    return { platform: 'youtube', url: `https://www.youtube.com/watch?v=${t}`, key: t };
  }

  let u;
  try { u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  const platform = Object.keys(PLATFORM_HOSTS).find((p) => PLATFORM_HOSTS[p].some((d) => hostMatches(host, d)));
  if (!platform) return null;

  if (platform === 'youtube') {
    if (!isValidYouTubeUrl(t)) return null;
    const url = cleanYouTubeUrl(t);
    const key = extractVideoId(url);
    return key ? { platform, url, key } : null;
  }

  if (u.pathname.length <= 1 && !u.search) return null;
  u.hash = '';
  const url = u.href;
  const key = `${platform}_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
  aliasToUrl.set(key, url);

  // Map frontend short IDs (tt_..., ig_..., fb_...) to the full URL for /api/preview
  const ttMatch = url.match(/\/(?:video|v|photo)\/(\d+)/);
  if (platform === 'tiktok' && ttMatch) aliasToUrl.set(`tt_${ttMatch[1]}`, url);
  const igMatch = url.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (platform === 'instagram' && igMatch) aliasToUrl.set(`ig_${igMatch[1]}`, url);
  const fbMatch =
    url.match(/\/(?:videos|reel|watch\/?\?v=)(\d+)/i) ||
    url.match(/\/share\/(?:v|r)\/([A-Za-z0-9_-]+)/i) ||
    url.match(/fb\.watch\/([A-Za-z0-9_-]+)/i);
  if (platform === 'facebook' && fbMatch) aliasToUrl.set(`fb_${fbMatch[1]}`, url);

  return { platform, url, key };
}

function getCachedInfo(videoId) {
  const c = infoCache.get(videoId);
  if (c && Date.now() - c.ts < INFO_TTL) return c.data;
  infoCache.delete(videoId);
  return null;
}

function streamCacheKey(videoId, height, isMp3) {
  return `${videoId}_${height}_${isMp3 ? 'audio' : 'video'}`;
}

function getCachedStreams(key) {
  const c = streamCache.get(key);
  if (c && Date.now() - c.ts < STREAM_TTL) return c;
  streamCache.delete(key);
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of infoCache) { if (now - v.ts > INFO_TTL) infoCache.delete(k); }
  for (const [k, v] of streamCache) { if (now - v.ts > STREAM_TTL) streamCache.delete(k); }
  for (const [k, v] of previewStreamCache) { if (now - v.ts > STREAM_TTL) previewStreamCache.delete(k); }
}, 60_000);

// ─── Direct-path health (cooldown after repeated failures) ──────────────────
function noteDirectSuccess() {
  directFailStreak = 0;
}

function noteDirectFailure(reason) {
  directFailStreak++;
  if (directFailStreak >= DIRECT_FAIL_LIMIT) {
    directDisabledUntil = Date.now() + DIRECT_COOLDOWN_MS;
    directFailStreak = 0;
    console.warn(`[Direct] Disabled for 30 min after repeated failures (${reason}). Using yt-dlp only until then.`);
  }
}

// ─── Job tracking ───────────────────────────────────────────────────────────
const jobs = new Map();
const JOB_TTL_MS = 10 * 60_000;

function createJob() {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id, status: 'starting', progress: 0, stage: 'Starting…',
    filePath: null, fileName: null, mimeType: 'video/mp4',
    error: null, listeners: new Set(), createdAt: Date.now(),
    mode: 'copy', children: [],
  };
  jobs.set(id, job);
  return job;
}

function notifyJob(id, event, data) {
  const job = jobs.get(id);
  if (!job) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const l of job.listeners) {
    try { l.write(msg); if (event === 'done' || event === 'fail') l.end(); }
    catch { job.listeners.delete(l); }
  }
}

function updateProgress(id, percent, stage) {
  const job = jobs.get(id);
  if (!job) return;
  job.progress = percent;
  job.stage = stage;
  notifyJob(id, 'progress', { percent, stage });
}

function killJobChildren(job) {
  for (const cp of job.children) {
    if (cp && !cp.killed) try { cp.kill(); } catch { /* */ }
  }
  job.children = [];
}

function deleteJobTempFiles(jobId) {
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      if (f.startsWith(jobId)) {
        try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch { /* */ }
      }
    }
  } catch { /* */ }
}

function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  killJobChildren(job);
  deleteJobTempFiles(id);
  jobs.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) { console.log(`[Cleanup] ${id}`); cleanupJob(id); }
  }
}, 60_000);

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use((req, res, next) => { req.setTimeout(600_000); res.setTimeout(600_000); next(); });

const rateLimitMap = new Map();
function rateLimiter(limit = 10, windowMs = 60_000) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const ts = (rateLimitMap.get(ip) || []).filter(t => now - t < windowMs);
    if (ts.length >= limit) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    ts.push(now); rateLimitMap.set(ip, ts); next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rateLimitMap) {
    const r = ts.filter(t => now - t < 60_000);
    if (!r.length) rateLimitMap.delete(ip); else rateLimitMap.set(ip, r);
  }
}, 300_000);

// ─── Utility ────────────────────────────────────────────────────────────────
function cleanYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const t = url.trim();
    if (t.includes('youtube.com/watch')) {
      const p = new URL(t.startsWith('http') ? t : `https://${t}`);
      const v = p.searchParams.get('v'); if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    if (t.includes('youtu.be/')) {
      const p = new URL(t.startsWith('http') ? t : `https://${t}`);
      const id = p.pathname.replace(/^\//, '').split('/')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (t.includes('/shorts/')) {
      const m = t.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    }
  } catch { /* */ }
  return url.trim();
}

function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/.test(t)
    || /^[A-Za-z0-9_-]{11}$/.test(t);
}

function formatTimestamp(s) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}-${String(sec).padStart(2, '0')}`;
}

function sanitizeFilename(s) { return s.replace(/[/\\?%*:|"<>]/g, '').trim() || 'clip'; }

function deleteFiles(...paths) {
  for (const p of paths) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ } }
}

function sec(ms) { return (ms / 1000).toFixed(1); }

function mkErr(message, fatal = false) {
  const e = new Error(message);
  e.fatal = fatal;
  return e;
}

function mapYtDlpError(stderr) {
  const lo = stderr.toLowerCase();
  const last = stderr.trim().split('\n').pop() || 'yt-dlp failed';
  if (lo.includes('not a bot')) {
    return mkErr('YouTube is asking for a bot check. Update yt-dlp (yt-dlp -U) or set YTDLP_COOKIES_FROM_BROWSER in .env.', false);
  }
  if (lo.includes('login required') || lo.includes('requires login') || lo.includes('rate-limit reached')
    || lo.includes('empty media response') || lo.includes('use --cookies')) {
    return mkErr('This site wants a logged-in session for this video. Add YTDLP_COOKIES_FROM_BROWSER=chrome (or YTDLP_COOKIES_FILE=path/to/cookies.txt) to .env and restart the server.', true);
  }
  if (lo.includes('unsupported url')) {
    return mkErr(UNSUPPORTED_MSG, true);
  }
  if (lo.includes('no video') || lo.includes('there is no video')) {
    return mkErr('This post has no video in it.', true);
  }
  if (lo.includes('age-restricted') || lo.includes('confirm your age')) {
    return mkErr('This video is age-restricted.', true);
  }
  if (lo.includes('video unavailable') || lo.includes('private video') || lo.includes('this video is private')) {
    return mkErr('This video is private or unavailable.', true);
  }
  return mkErr(last, false);
}

// ─── Binary resolution ─────────────────────────────────────────────────────
function checkBinary(cmd, args = ['--version']) {
  return new Promise(resolve => {
    try {
      const c = spawn(cmd, args, { windowsHide: true });
      c.on('error', () => resolve(false));
      c.on('close', code => resolve(code === 0));
    } catch { resolve(false); }
  });
}

function findBinaryInDirs(name, dirs) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir, { recursive: true })) {
        if (typeof f === 'string' && f.toLowerCase().endsWith(name.toLowerCase() + '.exe'))
          return path.join(dir, f);
      }
    } catch { /* */ }
  }
  return null;
}

async function resolveBinaries() {
  const win = process.platform === 'win32';
  if (await checkBinary('yt-dlp')) { resolvedYtDlp = 'yt-dlp'; }
  else if (win) {
    const f = findBinaryInDirs('yt-dlp', [
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      'C:\\ProgramData\\chocolatey\\bin', 'C:\\Program Files\\yt-dlp',
    ]);
    if (f) { resolvedYtDlp = f; process.env.PATH = `${path.dirname(f)};${process.env.PATH}`; }
  }
  if (await checkBinary('ffmpeg', ['-version'])) { resolvedFfmpeg = 'ffmpeg'; }
  else if (win) {
    const f = findBinaryInDirs('ffmpeg', [
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      'C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', 'C:\\ProgramData\\chocolatey\\bin',
    ]);
    if (f) { resolvedFfmpeg = f; resolvedFfmpegDir = path.dirname(f); process.env.PATH = `${resolvedFfmpegDir};${process.env.PATH}`; }
  }
  const [y, f] = await Promise.all([checkBinary(resolvedYtDlp), checkBinary(resolvedFfmpeg, ['-version'])]);
  console.log('\n===========================================================');
  console.log('  🔍 Dependency Check');
  console.log('===========================================================');
  console.log(`  • yt-dlp : ${y ? `✓ (${resolvedYtDlp})` : '✗ NOT FOUND'}`);
  console.log(`  • ffmpeg : ${f ? `✓ (${resolvedFfmpeg})` : '✗ NOT FOUND'}`);
  if (!y || !f) {
    console.warn('  ⚠️  Install: winget install yt-dlp ffmpeg');
  }
  console.log('===========================================================');
}

// ─── Startup checks ────────────────────────────────────────────────────────
async function checkYtDlpVersion() {
  return new Promise(resolve => {
    const c = spawn(resolvedYtDlp, ['--version'], { windowsHide: true });
    let v = '';
    c.stdout.on('data', d => { v += d; });
    c.on('close', () => {
      v = v.trim();
      if (!v) { resolve(); return; }
      const parts = v.split('.');
      if (parts.length >= 3) {
        const vDate = new Date(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`);
        const days = Math.round((Date.now() - vDate.getTime()) / 86_400_000);
        if (days > 14) {
          console.warn(`  ⚠️  yt-dlp ${v} is ${days} days old — run: yt-dlp -U`);
        } else {
          console.log(`  • yt-dlp v${v} (${days}d old, up to date)`);
        }
      }
      resolve();
    });
    c.on('error', () => resolve());
  });
}

async function detectJsRuntimeSupport() {
  return new Promise(resolve => {
    const c = spawn(resolvedYtDlp, ['--help'], { windowsHide: true });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('close', () => { supportsJsRuntimes = out.includes('--js-runtimes'); resolve(); });
    c.on('error', () => resolve());
  });
}

async function detectJsRuntime() {
  if (await checkBinary('deno', ['--version'])) {
    jsRuntime = 'deno';
    console.log('  • JS runtime: deno ✓');
  } else if (await checkBinary('node', ['--version'])) {
    jsRuntime = 'node';
    console.log('  • JS runtime: node ✓');
  } else {
    console.warn('  ⚠️  No JS runtime for yt-dlp. Install: winget install DenoLand.Deno');
  }
}

/** Test-encode 1 blank frame so we only pick a hardware encoder that actually works on this GPU. */
function testEncoder(args) {
  return new Promise((resolve) => {
    const c = spawn(
      resolvedFfmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:d=0.1', '-frames:v', '1', ...args, '-f', 'null', '-'],
      { windowsHide: true }
    );
    c.on('close', (code) => resolve(code === 0));
    c.on('error', () => resolve(false));
  });
}

async function detectEncoder() {
  for (const { name, label, args } of [
    { name: 'h264_nvenc', label: 'NVIDIA NVENC', args: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '23'] },
    { name: 'h264_qsv', label: 'Intel QuickSync', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'] },
    { name: 'h264_amf', label: 'AMD AMF', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'] },
    { name: 'h264_videotoolbox', label: 'Apple VideoToolbox', args: ['-c:v', 'h264_videotoolbox', '-q:v', '65'] },
  ]) {
    if (await testEncoder(args)) {
      detectedEncoder = name;
      encoderLabel = `${name} (${label})`;
      return;
    }
  }
}

function getEncoderArgs() {
  switch (detectedEncoder) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '23'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', '65'];
    default: return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];
  }
}

// ─── ffmpeg protocol option detection ──────────────────────────────────────
const HTTP_OPTION_DEFAULTS = ['user_agent', 'reconnect', 'reconnect_streamed', 'reconnect_delay_max'];
let supportedHttpOptions = new Set(HTTP_OPTION_DEFAULTS);

async function detectHttpOptions() {
  return new Promise((resolve) => {
    const child = spawn(resolvedFfmpeg, ['-h', 'protocol=https'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      const opts = new Set();
      for (const o of HTTP_OPTION_DEFAULTS) {
        if (new RegExp(`-${o}\\b`).test(out)) opts.add(o);
      }
      supportedHttpOptions = opts.size ? opts : new Set(HTTP_OPTION_DEFAULTS);
      console.log(`  • ffmpeg protocol options: ${Array.from(supportedHttpOptions).join(', ')}`);
      resolve();
    });
    child.on('error', () => resolve());
  });
}

// ─── yt-dlp helpers ─────────────────────────────────────────────────────────
function ytdlpCommonArgs() {
  const a = [];
  if (supportsJsRuntimes && jsRuntime) a.push('--js-runtimes', jsRuntime);
  if (COOKIES_FILE) a.push('--cookies', COOKIES_FILE);
  else if (COOKIES_FROM_BROWSER) a.push('--cookies-from-browser', COOKIES_FROM_BROWSER);
  return a;
}

function clientArgs(client) {
  if (!client || client === 'default') return [];
  return ['--extractor-args', `youtube:player_client=${client}`];
}

/**
 * Format selector for the fast parallel downloader:
 * - For 1080p, explicitly tries `height>720` (horizontal) and `width>720` (vertical 9:16) FIRST
 *   so yt-dlp does not settle for a 720p avc1 stream when 1080p is available.
 * - For TikTok / Instagram / Facebook, prefers H.264 (`h264`/`avc1`) at the requested resolution
 *   so `-c copy` and browser preview work without re-encoding.
 */
function buildFormat(heightLimit, isMp3, platform = 'youtube') {
  if (platform !== 'youtube') {
    if (isMp3) return 'ba/b';
    if (heightLimit >= 1080) {
      return [
        'bv*[vcodec^=avc1][height>720]+ba/bv*[vcodec^=h264][height>720]+ba',
        'b[vcodec^=h264][width>720]/b[vcodec^=avc1][width>720]',
        'b[vcodec^=h264]/b[vcodec^=avc1]',
        'bv*+ba/b',
      ].join('/');
    }
    return `bv*[vcodec^=avc1][width<=?${heightLimit}]+ba/b[vcodec^=h264][width<=?${heightLimit}]/bv*[height<=?${heightLimit}]+ba/b[height<=?${heightLimit}]/bv*+ba/b`;
  }

  if (isMp3) return 'ba[ext=m4a]/ba';

  if (heightLimit >= 1080) {
    return [
      'bv*[vcodec^=avc1][height<=1080][height>720]+ba[ext=m4a]',
      'bv*[vcodec^=avc1][width<=1080][width>720]+ba[ext=m4a]',
      'bv*[vcodec^=avc1][height<=1080][height>720]+ba',
      'bv*[height<=1080][height>720]+ba[ext=m4a]',
      'bv*[width<=1080][width>720]+ba[ext=m4a]',
      'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]',
      'bv*[height<=1080]+ba/b[height<=1080]/b',
    ].join('/');
  }

  return `bv*[vcodec^=avc1][height<=${heightLimit}]+ba[ext=m4a]/bv*[vcodec^=avc1][width<=${heightLimit}]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=${heightLimit}]+ba/bv*[height<=${heightLimit}]+ba/b[height<=${heightLimit}]/b`;
}

function candidateClients() {
  const list = [];
  if (workingClient) list.push(workingClient);
  for (const c of PLAYER_CLIENTS) if (!list.includes(c)) list.push(c);
  return list.slice(0, Math.max(1, MAX_CLIENT_ATTEMPTS));
}

function runYtDlpJson(url, formatStr, client) {
  return new Promise((resolve, reject) => {
    const args = ['-j', '--no-playlist', '--playlist-items', '1', '--no-warnings', '--no-progress'];
    if (formatStr) args.push('-f', formatStr);
    args.push(...ytdlpCommonArgs(), ...clientArgs(client), url);

    const child = spawn(resolvedYtDlp, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') return reject(mkErr('yt-dlp is not installed.', true));
      reject(mkErr(`yt-dlp: ${err.message}`, false));
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(mapYtDlpError(stderr));
      try {
        const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
        resolve(JSON.parse(line || stdout));
      } catch {
        reject(mkErr('Failed to parse yt-dlp output.', false));
      }
    });
  });
}

function classifyStream(f) {
  const hasV = f.vcodec && f.vcodec !== 'none';
  const hasA = f.acodec && f.acodec !== 'none';
  if (hasV && hasA) return 'muxed';
  if (hasV) return 'video';
  if (hasA) return 'audio';
  if (f.ext === 'mp4') return 'muxed';
  return 'unknown';
}

function makeStreamObj(d, f) {
  const headers = { ...(d.http_headers || {}), ...(f.http_headers || {}) };
  const hasCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
  const cookies = f.cookies || d.cookies;
  if (cookies && !hasCookie) headers.Cookie = cookies;
  return {
    url: f.url,
    headers,
    protocol: f.protocol || 'https',
    kind: classifyStream(f),
    ext: f.ext || '',
    vcodec: f.vcodec || '',
    width: f.width || null,
    height: f.height || null,
  };
}

function streamsFromJson(d) {
  const list = Array.isArray(d.requested_formats) && d.requested_formats.length ? d.requested_formats : [d];
  return list.filter((f) => f && f.url).map((f) => makeStreamObj(d, f));
}

/**
 * Pick a single muxed H.264 MP4 stream from `d.formats` for instant browser `<video>` preview
 * on TikTok, Instagram, and Facebook (streamed directly via /api/preview with zero disk download).
 */
function pickPreviewStreamFromJson(d, selectedStreams) {
  if (Array.isArray(d.formats)) {
    const muxedH264 = d.formats.filter(
      (f) =>
        f &&
        f.url &&
        /^https?$/.test(f.protocol || 'https') &&
        f.ext === 'mp4' &&
        f.vcodec &&
        /^(avc1|h264)/i.test(f.vcodec) &&
        f.acodec &&
        f.acodec !== 'none'
    );
    if (muxedH264.length) {
      return makeStreamObj(d, muxedH264[muxedH264.length - 1]);
    }
    const anyMuxedMp4 = d.formats.filter(
      (f) =>
        f &&
        f.url &&
        /^https?$/.test(f.protocol || 'https') &&
        f.ext === 'mp4' &&
        f.vcodec &&
        f.vcodec !== 'none' &&
        (f.acodec !== 'none' || !Array.isArray(d.requested_formats))
    );
    if (anyMuxedMp4.length) {
      return makeStreamObj(d, anyMuxedMp4[anyMuxedMp4.length - 1]);
    }
  }
  return selectedStreams.find((s) => s.kind === 'muxed') || selectedStreams[0] || null;
}

function describeStreams(streams) {
  return streams.map((s) => `${s.kind}/${s.ext || '?'}${s.height ? '@' + s.height + 'p' : ''}`).join(' + ');
}

async function extractStreams(url, formatStr, client) {
  const d = await runYtDlpJson(url, formatStr, client);
  const info = {
    title: d.title || d.description?.slice(0, 80) || 'Video',
    duration: d.duration || 0,
    thumbnail: d.thumbnail || (Array.isArray(d.thumbnails) && d.thumbnails.length ? d.thumbnails[d.thumbnails.length - 1].url : ''),
  };
  const streams = streamsFromJson(d);
  const previewStream = pickPreviewStreamFromJson(d, streams);
  return { info, streams, previewStream };
}

async function probeStream(stream) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(stream.url, {
      method: 'GET',
      headers: { ...stream.headers, Range: 'bytes=0-' },
      signal: ac.signal,
      redirect: 'follow',
    });
    const ok = res.status === 200 || res.status === 206;
    try { await res.body?.cancel(); } catch { /* */ }
    return { ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Check if the extracted stream actually meets 1080p when 1080p was requested. */
function isTrue1080p(streams, heightLimit, isMp3) {
  if (isMp3 || heightLimit < 1080) return true;
  const v = streams.find((s) => s.kind === 'video' || s.kind === 'muxed');
  if (!v || (!v.height && !v.width)) return true;
  const maxDim = Math.max(v.width || 0, v.height || 0);
  return maxDim > 1280 || (v.height || 0) > 720;
}

async function resolveDirectStreams(url, formatStr, cacheKey, maxClients = 0, platform = 'youtube', heightLimit = 1080, isMp3 = false) {
  const videoId = resolveMedia(url)?.key;

  const cached = getCachedStreams(cacheKey);
  if (cached) {
    const probes = await Promise.all(cached.streams.map(probeStream));
    if (probes.every((p) => p.ok)) {
      console.log(`[Direct] Cached streams OK (client=${cached.client}) ${describeStreams(cached.streams)}`);
      return { streams: cached.streams, client: cached.client };
    }
    console.log(`[Direct] Cached streams rejected (${probes.map((p) => p.status || p.error).join('/')}), re-extracting…`);
    streamCache.delete(cacheKey);
  }

  const allClients = platform === 'youtube' ? candidateClients() : [null];
  const clientsToTry = maxClients > 0 ? allClients.slice(0, maxClients) : allClients;
  let bestLowerClient = null;

  for (const client of clientsToTry) {
    const label = client || platform;
    let result;
    try {
      result = await extractStreams(url, formatStr, client);
    } catch (err) {
      if (err.fatal) throw err;
      console.warn(`[Direct] client=${label} extraction failed: ${err.message}`);
      continue;
    }

    const { info, streams, previewStream } = result;
    if (videoId) {
      infoCache.set(videoId, { data: info, ts: Date.now() });
      if (previewStream) previewStreamCache.set(videoId, { stream: previewStream, ts: Date.now() });
    }

    if (!streams.length) {
      console.warn(`[Direct] client=${label} returned no streams`);
      continue;
    }
    const manifest = streams.find((s) => !/^https?$/.test(s.protocol));
    if (manifest) {
      console.log(`[Direct] client=${label} returned a ${manifest.protocol} stream (not directly fetchable), skipping`);
      continue;
    }

    const probes = await Promise.all(streams.map(probeStream));
    console.log(`[Direct] client=${label} ${describeStreams(streams)} → probe ${probes.map((p) => p.status || p.error).join('/')}`);
    if (probes.every((p) => p.ok)) {
      if (platform === 'youtube' && !isTrue1080p(streams, heightLimit, isMp3)) {
        console.log(`[Direct] client=${label} only offered <=720p for 1080p request; checking next client…`);
        if (!bestLowerClient) bestLowerClient = { streams, client: label };
        continue;
      }
      if (platform === 'youtube') workingClient = client;
      streamCache.set(cacheKey, { streams, client: label, ts: Date.now() });
      return { streams, client: label };
    }
  }

  if (bestLowerClient) {
    streamCache.set(cacheKey, { streams: bestLowerClient.streams, client: bestLowerClient.client, ts: Date.now() });
    return bestLowerClient;
  }

  return null;
}

// <<RANGE_PROXY_START>>
// ─── Parallel range proxy ───────────────────────────────────────────────────
const PROXY_ENABLED = (process.env.PARALLEL_FETCH ?? 'true').toLowerCase() !== 'false';
const PROXY_CHUNK_BYTES = Math.max(256 * 1024, Math.round(parseFloat(process.env.FETCH_CHUNK_MB || '2') * 1_048_576));
const PROXY_CONNECTIONS = Math.max(1, parseInt(process.env.FETCH_CONNECTIONS || '8', 10));
const PROXY_CHUNK_RETRIES = 3;

const rangeStreams = new Map();
let rangeProxyServer = null;
let rangeProxyPort = 0;

function cleanUpstreamHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (['range', 'host', 'connection', 'accept-encoding', 'content-length'].includes(lk)) continue;
    out[k] = v;
  }
  out['Accept-Encoding'] = 'identity';
  return out;
}

async function fetchRangeChunk(entry, start, end, signal) {
  let lastErr;
  for (let attempt = 0; attempt < PROXY_CHUNK_RETRIES; attempt++) {
    if (signal.aborted) throw new Error('aborted');
    try {
      const res = await fetch(entry.url, {
        headers: { ...entry.headers, Range: `bytes=${start}-${end}` },
        signal,
        redirect: 'follow',
      });
      if (res.status !== 206 && res.status !== 200) {
        try { await res.body?.cancel(); } catch { /* */ }
        throw new Error(`upstream HTTP ${res.status}`);
      }
      if (!entry.contentType) entry.contentType = res.headers.get('content-type') || 'application/octet-stream';
      let buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && (start > 0 || buf.length > end - start + 1)) {
        buf = buf.subarray(start, end + 1);
      }
      entry.stats.bytes += buf.length;
      entry.stats.requests += 1;
      return buf;
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw err;
      entry.stats.retries += 1;
    }
  }
  throw lastErr;
}

async function ensureStreamSize(entry) {
  if (entry.size) return entry.size;
  try {
    const clen = parseInt(new URL(entry.url).searchParams.get('clen') || '', 10);
    if (clen > 0) { entry.size = clen; return clen; }
  } catch { /* */ }
  const res = await fetch(entry.url, { headers: { ...entry.headers, Range: 'bytes=0-0' }, redirect: 'follow' });
  try { await res.body?.cancel(); } catch { /* */ }
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
  if (m) {
    entry.size = parseInt(m[1], 10);
    if (!entry.contentType) entry.contentType = res.headers.get('content-type') || 'application/octet-stream';
    return entry.size;
  }
  const cl = parseInt(res.headers.get('content-length') || '', 10);
  if (res.status === 200 && cl > 1) {
    entry.size = cl;
    if (!entry.contentType) entry.contentType = res.headers.get('content-type') || 'application/octet-stream';
    return entry.size;
  }
  throw new Error(`could not determine stream size (HTTP ${res.status})`);
}

function waitDrain(res) {
  return new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
}

async function handleRangeRequest(req, res) {
  const m = /^\/s\/([a-f0-9]+)/.exec(req.url || '');
  const entry = m && rangeStreams.get(m[1]);
  if (!entry) { res.writeHead(404); return res.end(); }

  let size;
  try { size = await ensureStreamSize(entry); }
  catch (err) { res.writeHead(502); return res.end(err.message); }

  let start = 0, end = size - 1, partial = false;
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rm && (rm[1] !== '' || rm[2] !== '')) {
    partial = true;
    if (rm[1] === '') { start = Math.max(0, size - parseInt(rm[2], 10)); }
    else { start = parseInt(rm[1], 10); if (rm[2] !== '') end = Math.min(end, parseInt(rm[2], 10)); }
  }
  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(partial ? 206 : 200, {
    'Content-Type': entry.contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  const chunks = [];
  for (let p = start; p <= end; p += PROXY_CHUNK_BYTES) chunks.push([p, Math.min(p + PROXY_CHUNK_BYTES - 1, end)]);

  const pending = new Map();
  let nextLaunch = 0, nextWrite = 0;
  const launch = () => {
    while (nextLaunch < chunks.length && nextLaunch - nextWrite < PROXY_CONNECTIONS) {
      const i = nextLaunch++;
      const p = fetchRangeChunk(entry, chunks[i][0], chunks[i][1], ac.signal);
      p.catch(() => { /* handled when awaited */ });
      pending.set(i, p);
    }
  };

  try {
    launch();
    while (nextWrite < chunks.length) {
      const buf = await pending.get(nextWrite);
      pending.delete(nextWrite);
      nextWrite++;
      launch();
      if (ac.signal.aborted) return;
      if (!res.write(buf)) await waitDrain(res);
    }
    res.end();
  } catch (err) {
    if (!ac.signal.aborted) {
      console.warn(`[Proxy] stream failed: ${err.message}`);
      res.destroy(err);
    }
  } finally {
    ac.abort();
  }
}

function startRangeProxy() {
  return new Promise((resolve, reject) => {
    rangeProxyServer = http.createServer((req, res) => {
      handleRangeRequest(req, res).catch((err) => { try { res.destroy(err); } catch { /* */ } });
    });
    rangeProxyServer.on('error', reject);
    rangeProxyServer.listen(0, '127.0.0.1', () => {
      rangeProxyPort = rangeProxyServer.address().port;
      resolve(rangeProxyPort);
    });
  });
}

function registerRangeStream(stream) {
  const id = crypto.randomBytes(8).toString('hex');
  rangeStreams.set(id, {
    url: stream.url,
    headers: cleanUpstreamHeaders(stream.headers),
    size: 0,
    contentType: '',
    stats: { bytes: 0, requests: 0, retries: 0 },
    kind: stream.kind,
  });
  return { ...stream, url: `http://127.0.0.1:${rangeProxyPort}/s/${id}`, headers: {}, _proxyId: id };
}

function releaseRangeStreams(streams) {
  for (const s of streams) {
    if (!s._proxyId) continue;
    const e = rangeStreams.get(s._proxyId);
    if (e && e.stats.requests) {
      console.log(`[Proxy] ${e.kind}: ${(e.stats.bytes / 1_048_576).toFixed(1)}MB in ${e.stats.requests} chunk requests (${e.stats.retries} retries)`);
    }
    rangeStreams.delete(s._proxyId);
  }
}
// <<RANGE_PROXY_END>>

// ─── ffmpeg helpers ─────────────────────────────────────────────────────────
function remoteInputArgs(stream, start, duration) {
  if (stream._proxyId) return ['-ss', String(start), '-t', String(duration), '-i', stream.url];

  const args = [];
  const headers = { ...stream.headers };

  let ua = null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'user-agent') { ua = headers[k]; delete headers[k]; }
  }
  if (ua) {
    if (supportedHttpOptions.has('user_agent')) args.push('-user_agent', ua);
    else headers['User-Agent'] = ua;
  }

  const headerBlock = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  if (headerBlock) args.push('-headers', headerBlock);

  if (supportedHttpOptions.has('reconnect')) args.push('-reconnect', '1');
  if (supportedHttpOptions.has('reconnect_streamed')) args.push('-reconnect_streamed', '1');
  if (supportedHttpOptions.has('reconnect_delay_max')) args.push('-reconnect_delay_max', '5');

  args.push('-ss', String(start), '-t', String(duration), '-i', stream.url);
  return args;
}

function spawnFfmpeg(args, job, tag = 'ffmpeg') {
  const child = spawn(resolvedFfmpeg, args, { windowsHide: true });
  if (job) job.children.push(child);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const promise = new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (code === null) {
        reject(new Error('KILLED'));
      } else {
        const tail = stderr.trim().split('\n').slice(-2).join(' | ') || 'ffmpeg failed';
        console.warn(`[${tag}] failed (code ${code}): ${tail}`);
        reject(new Error(tail));
      }
    });
    child.on('error', (err) => reject(err));
  });
  return { child, promise };
}

function trackProgress(child, durationSec, cb) {
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    let p = null;
    for (const line of lines) {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m) p = Math.max(0, Math.min(1, parseInt(m[1], 10) / 1_000_000 / durationSec));
    }
    cb(p);
  });
}

function startStreamFetch(stream, start, duration, outPath, isVideo, job) {
  const tag = isVideo ? 'ffmpeg-video-fetch' : 'ffmpeg-audio-fetch';
  const args = [
    ...remoteInputArgs(stream, start, duration),
    ...(isVideo ? ['-an', '-c:v', 'copy'] : ['-vn', '-c:a', 'copy']),
    '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    '-y', outPath,
  ];
  return spawnFfmpeg(args, job, tag);
}

function muxLocal(videoPath, audioPath, outPath, job) {
  const args = [
    '-i', videoPath, '-i', audioPath,
    '-c', 'copy', '-movflags', '+faststart',
    '-nostats', '-loglevel', 'error',
    '-y', outPath,
  ];
  return spawnFfmpeg(args, job, 'ffmpeg-mux');
}

// ─── Direct path (stream URLs + parallel ffmpeg) ────────────────────────────
async function runDirectPath(job, streams, { start, end, isMp3, exact, outPath, vPath, aPath, T }) {
  const dur = end - start;

  // ── MP3 ──
  if (isMp3) {
    const a = streams.find((s) => s.kind === 'audio') || streams[0];
    updateProgress(job.id, 15, 'Extracting audio…');
    const t = Date.now();
    const { child, promise } = spawnFfmpeg([
      ...remoteInputArgs(a, start, dur),
      '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
      '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-y', outPath,
    ], job, 'ffmpeg-audio');
    trackProgress(child, dur, (p) => {
      if (p !== null) updateProgress(job.id, 15 + Math.round(p * 75), 'Extracting audio…');
    });
    await promise;
    T.audio = Date.now() - t;
    return 'direct-audio';
  }

  const v = streams.find((s) => s.kind === 'video');
  const a = streams.find((s) => s.kind === 'audio');
  const m = streams.find((s) => s.kind === 'muxed');

  // ── Single combined stream (video+audio in 1 URL) ──
  if (!(v && a) && m) {
    updateProgress(job.id, 15, exact ? 'Encoding clip…' : 'Downloading clip…');
    const t = Date.now();
    const codecArgs = exact ? [...getEncoderArgs(), '-c:a', 'copy'] : ['-c', 'copy'];
    const { child, promise } = spawnFfmpeg([
      ...remoteInputArgs(m, start, dur),
      ...codecArgs, '-movflags', '+faststart',
      '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-y', outPath,
    ], job, 'ffmpeg-single');
    trackProgress(child, dur, (p) => {
      if (p !== null) updateProgress(job.id, 15 + Math.round(p * 80), exact ? 'Encoding…' : 'Downloading…');
    });
    await promise;
    T.video = Date.now() - t;
    return exact ? 'direct-single-exact' : 'direct-single-copy';
  }

  if (!(v && a)) throw new Error('Unsupported stream layout');

  // ── Exact mode: ONE ffmpeg pass, both remote inputs, frame-accurate re-encode ──
  if (exact) {
    const label = detectedEncoder === 'libx264' ? 'direct-exact-sw' : 'direct-exact-hw';
    updateProgress(job.id, 15, `Encoding (${encoderLabel})…`);
    const t = Date.now();
    const audioCodec = a.ext === 'm4a' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'];
    const { child, promise } = spawnFfmpeg([
      ...remoteInputArgs(v, start, dur),
      ...remoteInputArgs(a, start, dur),
      '-map', '0:v:0', '-map', '1:a:0',
      ...getEncoderArgs(), ...audioCodec,
      '-movflags', '+faststart',
      '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-y', outPath,
    ], job, 'ffmpeg-exact');
    trackProgress(child, dur, (p) => {
      if (p !== null) updateProgress(job.id, 15 + Math.round(p * 80), 'Encoding…');
    });
    await promise;
    T.video = Date.now() - t;
    return label;
  }

  // ── Fast mode: parallel separate video + audio fetch (-c copy), then local mux ──
  updateProgress(job.id, 15, 'Downloading video + audio in parallel…');
  let vp = 0, ap = 0;
  let stalled = false;
  const beat = { t: Date.now() };
  const report = () => updateProgress(job.id, 15 + Math.round(((vp + ap) / 2) * 60), 'Downloading video + audio…');

  const tv = Date.now();
  const vFetch = startStreamFetch(v, start, dur, vPath, true, job);
  const aFetch = startStreamFetch(a, start, dur, aPath, false, job);
  trackProgress(vFetch.child, dur, (p) => { beat.t = Date.now(); if (p !== null) { vp = p; report(); } });
  trackProgress(aFetch.child, dur, (p) => { beat.t = Date.now(); if (p !== null) { ap = p; report(); } });

  const stallTimer = setInterval(() => {
    if (Date.now() - beat.t > STALL_TIMEOUT_MS) { stalled = true; killJobChildren(job); }
  }, 2000);

  try {
    await Promise.all([
      vFetch.promise.then(() => { vp = 1; T.video = Date.now() - tv; }),
      aFetch.promise.then(() => { ap = 1; T.audio = Date.now() - tv; }),
    ]);
  } catch (err) {
    killJobChildren(job);
    throw new Error(stalled ? `stream stalled for ${STALL_TIMEOUT_MS / 1000}s` : err.message);
  } finally {
    clearInterval(stallTimer);
  }

  updateProgress(job.id, 85, 'Muxing…');
  const tm = Date.now();
  await muxLocal(vPath, aPath, outPath, job).promise;
  T.mux = Date.now() - tm;
  deleteFiles(vPath, aPath);
  return 'direct-parallel-copy';
}

// ─── yt-dlp fallback downloader ─────────────────────────────────────────────
function ytdlpFallback(job, url, start, end, formatStr, outPath, isMp3 = false, client = null) {
  return new Promise((resolve, reject) => {
    const fileExt = isMp3 ? 'mp3' : 'mp4';
    const outTemplate = path.join(TEMP_DIR, `${job.id}.%(ext)s`);
    const sectionArg = `*${start}-${end}`;
    const args = [
      '--no-playlist',
      '--playlist-items', '1',
      '--no-warnings',
      '--windows-filenames',
      '--download-sections', sectionArg,
      '-N', '16',
      '--http-chunk-size', '5M',
    ];

    if (resolvedFfmpegDir) args.push('--ffmpeg-location', resolvedFfmpegDir);
    args.push(...ytdlpCommonArgs(), ...clientArgs(client));

    if (isMp3) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', formatStr, '--merge-output-format', 'mp4');
    }

    args.push('-o', outTemplate, url);

    console.log(`[Clip ${job.id}] Spawning yt-dlp fallback: ${sectionArg} (${fileExt})${client ? ` client=${client}` : ''}`);

    const child = spawn(resolvedYtDlp, args, { windowsHide: true });
    job.children.push(child);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      const m = text.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        const pct = Math.min(95, Math.round(20 + parseFloat(m[1]) * 0.75));
        updateProgress(job.id, pct, `Downloading (${m[1]}%)…`);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        const expected = path.join(TEMP_DIR, `${job.id}.${fileExt}`);
        if (fs.existsSync(expected)) return resolve(expected);
        try {
          const found = fs.readdirSync(TEMP_DIR).find((f) => f.startsWith(job.id) && f.endsWith(`.${fileExt}`));
          if (found) {
            const foundPath = path.join(TEMP_DIR, found);
            if (foundPath !== outPath) fs.renameSync(foundPath, outPath);
          }
        } catch { /* */ }
        resolve(outPath);
      } else if (code === null) {
        reject(new Error('KILLED'));
      } else {
        const lastErr = stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop() || 'yt-dlp fallback failed';
        reject(new Error(lastErr));
      }
    });
    child.on('error', reject);
  });
}

async function runYtdlpFallback(job, url, start, end, formatStr, outPath, isMp3, platform = 'youtube') {
  try {
    return await ytdlpFallback(job, url, start, end, formatStr, outPath, isMp3, null);
  } catch (err) {
    if (platform === 'youtube' && /403|forbidden/i.test(err.message)) {
      const alt = PLAYER_CLIENTS.find((c) => c !== 'default');
      if (alt) {
        console.warn(`[Clip ${job.id}] yt-dlp got 403, retrying with client=${alt}`);
        deleteJobTempFiles(job.id);
        return await ytdlpFallback(job, url, start, end, formatStr, outPath, isMp3, alt);
      }
    }
    throw err;
  }
}

// ─── Main clip pipeline ─────────────────────────────────────────────────────
async function processClip(job, { url, start, end, format, quality, exact, title }) {
  const T = { extract: 0, video: 0, audio: 0, mux: 0, total: 0 };
  const t0 = Date.now();
  const isMp3 = format === 'mp3';
  const fileExt = isMp3 ? 'mp3' : 'mp4';
  const outPath = path.join(TEMP_DIR, `${job.id}.${fileExt}`);
  const media = resolveMedia(url);
  if (!media) throw new Error(UNSUPPORTED_MSG);
  const { platform } = media;
  const videoId = media.key;
  const siteName = platform[0].toUpperCase() + platform.slice(1);

  job.mimeType = isMp3 ? 'audio/mpeg' : 'video/mp4';

  const vPath = path.join(TEMP_DIR, `${job.id}_v.mp4`);
  const aPath = path.join(TEMP_DIR, `${job.id}_a.m4a`);

  // Default to 1080p to match the UI default
  const heightLimit = quality === '360p' ? 360 : quality === '720p' ? 720 : 1080;
  const formatStr = buildFormat(heightLimit, isMp3, platform);

  const heightPlan = [heightLimit];
  if (platform === 'youtube' && !isMp3 && QUALITY_FALLBACK && heightLimit > 720) heightPlan.push(720);
  // Route all platforms through the parallel chunk proxy when available
  const useProxy = Boolean(rangeProxyPort);

  job.requestedQuality = quality;

  try {
    let method = 'yt-dlp-fallback';
    let client = '-';
    let finished = false;

    // ── 1. Direct Fast Parallel Path (YouTube, TikTok, Instagram, Facebook) ──
    if (USE_DIRECT_FFMPEG && (platform !== 'youtube' || Date.now() >= directDisabledUntil)) {
      let failReason = `${siteName} did not accept the direct stream URLs`;

      for (let i = 0; i < heightPlan.length && !finished; i++) {
        const h = heightPlan[i];
        const fStr = buildFormat(h, isMp3, platform);
        const cKey = streamCacheKey(videoId, h, isMp3);

        updateProgress(job.id, i === 0 ? 5 : 12, i === 0 ? 'Resolving stream…' : `${heightLimit}p unavailable, trying ${h}p…`);
        if (i > 0) console.log(`[Clip ${job.id}] ${heightLimit}p was refused by YouTube, retrying direct path at ${h}p`);

        const te = Date.now();
        const direct = await resolveDirectStreams(url, fStr, cKey, i === 0 ? 0 : 2, platform, h, isMp3);
        T.extract += Date.now() - te;

        if (!direct) continue;

        client = direct.client;
        // Detect if all clients only had <=720p for a 1080p request
        if (h === 1080 && !isTrue1080p(direct.streams, 1080, isMp3)) {
          job.downgradedTo = 720;
        }

        const routed = useProxy ? direct.streams.map(registerRangeStream) : direct.streams;
        try {
          method = await runDirectPath(job, routed, { start, end, isMp3, exact, outPath, vPath, aPath, T });
          if (useProxy) method += '+parallel-fetch';
          if (h !== heightLimit) {
            method += `+${h}p-fallback`;
            job.downgradedTo = h;
          }
          if (platform === 'youtube') noteDirectSuccess();
          finished = true;
        } catch (err) {
          killJobChildren(job);
          deleteFiles(outPath, vPath, aPath);
          streamCache.delete(cKey);
          failReason = err.message;
          console.warn(`[Clip ${job.id}] Direct path failed (${err.message}).`);
          break;
        } finally {
          releaseRangeStreams(routed);
        }
      }

      if (!finished) {
        if (platform === 'youtube') noteDirectFailure(failReason);
        console.warn(`[Clip ${job.id}] Falling back to yt-dlp…`);
      }
    }

    // ── 2. yt-dlp fallback ──
    if (!finished) {
      method = 'yt-dlp-fallback';
      updateProgress(job.id, 20, 'Downloading with yt-dlp…');
      const tf = Date.now();
      await runYtdlpFallback(job, url, start, end, formatStr, outPath, isMp3, platform);
      T.video = Date.now() - tf;
      T.audio = 0;
      T.mux = 0;
    }

    T.total = Date.now() - t0;
    await finishJob(job, outPath, title, start, end, fileExt, method, T, client);

  } catch (err) {
    killJobChildren(job);
    deleteJobTempFiles(job.id);
    job.status = 'error';
    job.error = err.message;
    console.error(`[Clip ${job.id}] ✗ ${err.message}`);
    notifyJob(job.id, 'fail', { message: err.message });
  }
}

async function finishJob(job, outPath, title, start, end, fileExt, method, T, client = '-') {
  if (!fs.existsSync(outPath)) throw new Error('Output file was not created.');
  const stat = fs.statSync(outPath);
  const sizeMB = (stat.size / 1_048_576).toFixed(1);
  const totalSecs = (T.total / 1000) || 0.1;
  const speedMBs = (parseFloat(sizeMB) / totalSecs).toFixed(2);

  const cleanTitle = sanitizeFilename(title || 'clip');
  job.filePath = outPath;
  job.fileName = `${cleanTitle} (${formatTimestamp(start)} to ${formatTimestamp(end)}).${fileExt}`;
  job.status = 'complete';
  job.progress = 100;
  job.mode = method;

  console.log(
    `[Clip ${job.id}] ✓ method=${method} client=${client} extract=${sec(T.extract)}s video=${sec(T.video)}s audio=${sec(T.audio)}s mux=${sec(T.mux)}s total=${sec(T.total)}s size=${sizeMB}MB speed=${speedMBs}MB/s`
  );

  updateProgress(job.id, 100, 'Ready');
  notifyJob(job.id, 'done', {
    clipId: job.id,
    elapsed: parseFloat(sec(T.total)),
    mode: method,
    sizeMB: parseFloat(sizeMB),
    speedMBs: parseFloat(speedMBs),
    requestedQuality: job.requestedQuality,
    downgraded: Boolean(job.downgradedTo),
    actualQuality: job.downgradedTo ? `${job.downgradedTo}p` : job.requestedQuality,
    timings: { extract: sec(T.extract), video: sec(T.video), audio: sec(T.audio), mux: sec(T.mux) },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/info', rateLimiter(15), async (req, res) => {
  const media = resolveMedia((req.body || {}).url);
  if (!media) return res.status(400).json({ error: UNSUPPORTED_MSG });

  const { platform, url: cleanUrl, key: vid } = media;
  const cached = getCachedInfo(vid);
  if (cached) {
    console.log(`[Info] Cache hit: ${vid}`);
    return res.json({ ...cached, platform });
  }

  // Pre-warm stream URLs at 1080p (matching the UI default) so clicking Download is instant
  const fmt = buildFormat(1080, false, platform);
  const clients = platform === 'youtube' ? candidateClients() : [null];

  let lastErr = null;
  for (const client of clients) {
    try {
      const { info, streams, previewStream } = await extractStreams(cleanUrl, fmt, client);
      infoCache.set(vid, { data: info, ts: Date.now() });
      if (previewStream) {
        previewStreamCache.set(vid, { stream: previewStream, ts: Date.now() });
      }
      if (streams.length && (platform !== 'youtube' || isTrue1080p(streams, 1080, false))) {
        streamCache.set(streamCacheKey(vid, 1080, false), { streams, client: client || platform, ts: Date.now() });
        if (platform === 'youtube') workingClient = client;
        return res.json({ ...info, platform });
      }
      // If YouTube only has <=720p on this client, still return info if it's our last client
      if (client === clients[clients.length - 1]) {
        if (streams.length) {
          streamCache.set(streamCacheKey(vid, 720, false), { streams, client: client || platform, ts: Date.now() });
        }
        return res.json({ ...info, platform });
      }
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
    }
  }
  return res.status(400).json({ error: lastErr?.message || 'Metadata fetch failed.' });
});

/**
 * Direct Zero-Disk HTTP Stream Proxy for TikTok, Instagram, and Facebook `<video>` preview.
 * Streams bytes straight from the platform CDN with the exact headers/cookies yt-dlp extracted.
 */
app.get('/api/preview', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  const media = resolveMedia(rawUrl);
  if (!media) return res.status(400).json({ error: UNSUPPORTED_MSG });

  const { platform, url: cleanUrl, key: vid } = media;

  try {
    let previewEntry = previewStreamCache.get(vid);
    if (!previewEntry) {
      const fmt = buildFormat(1080, false, platform);
      const { info, streams, previewStream } = await extractStreams(cleanUrl, fmt, null);
      infoCache.set(vid, { data: info, ts: Date.now() });
      if (streams.length) {
        streamCache.set(streamCacheKey(vid, 1080, false), { streams, client: platform, ts: Date.now() });
      }
      if (previewStream) {
        previewEntry = { stream: previewStream, ts: Date.now() };
        previewStreamCache.set(vid, previewEntry);
      }
    }

    if (!previewEntry || !previewEntry.stream) {
      return res.status(404).json({ error: 'No preview stream available.' });
    }

    const upstreamHeaders = cleanUpstreamHeaders(previewEntry.stream.headers);
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    const ac = new AbortController();
    res.on('close', () => ac.abort());

    const upstreamRes = await fetch(previewEntry.stream.url, {
      headers: upstreamHeaders,
      signal: ac.signal,
      redirect: 'follow',
    });

    res.status(upstreamRes.status);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    const cl = upstreamRes.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstreamRes.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);

    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body).on('error', () => { }).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

app.post('/api/clip', rateLimiter(10), (req, res) => {
  const { url, start, end, format = 'mp4', quality = '1080p', exact = false, title = '' } = req.body || {};
  const media = resolveMedia(url);
  if (!media) return res.status(400).json({ error: UNSUPPORTED_MSG });
  const s = parseFloat(start), e = parseFloat(end);
  if (isNaN(s) || isNaN(e)) return res.status(400).json({ error: 'Invalid times.' });
  if (s < 0 || e <= s) return res.status(400).json({ error: 'Start must be >= 0 and < end.' });
  if (e - s > MAX_CLIP_SECONDS) return res.status(400).json({ error: `Clip too long (max ${MAX_CLIP_SECONDS}s).` });

  const cleanUrl = media.url;
  const useTitle = title || getCachedInfo(media.key)?.title || '';

  const job = createJob();
  res.json({ clipId: job.id });

  processClip(job, {
    url: cleanUrl, start: s, end: e, format, quality,
    exact: exact === true || exact === 'true', title: useTitle,
  }).catch(err => {
    job.status = 'error'; job.error = err.message;
    notifyJob(job.id, 'fail', { message: err.message });
  });
});

app.get('/api/progress/:clipId', (req, res) => {
  const job = jobs.get(req.params.clipId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`event: progress\ndata: ${JSON.stringify({ percent: job.progress, stage: job.stage })}\n\n`);
  if (job.status === 'complete') { res.write(`event: done\ndata: ${JSON.stringify({ clipId: job.id, mode: job.mode })}\n\n`); res.end(); return; }
  if (job.status === 'error') { res.write(`event: fail\ndata: ${JSON.stringify({ message: job.error })}\n\n`); res.end(); return; }
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

app.get('/api/download/:clipId', (req, res) => {
  const job = jobs.get(req.params.clipId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  if (job.status !== 'complete' || !job.filePath) return res.status(400).json({ error: 'Not ready.' });
  let stat;
  try { stat = fs.statSync(job.filePath); } catch { return res.status(500).json({ error: 'File unavailable.' }); }
  const asciiName = job.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', job.mimeType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(job.fileName)}`);
  const stream = fs.createReadStream(job.filePath);
  stream.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  res.on('finish', () => setTimeout(() => cleanupJob(job.id), 2000));
  stream.pipe(res);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', maxClipSeconds: MAX_CLIP_SECONDS,
    ytDlp: resolvedYtDlp, ffmpeg: resolvedFfmpeg,
    encoder: encoderLabel, jsRuntime, supportsJsRuntimes,
    directFfmpeg: USE_DIRECT_FFMPEG && Date.now() >= directDisabledUntil,
    workingClient, activeJobs: jobs.size,
    sites: Object.keys(PLATFORM_HOSTS),
    parallelFetch: rangeProxyPort ? { connections: PROXY_CONNECTIONS, chunkBytes: PROXY_CHUNK_BYTES } : false,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
await resolveBinaries();
if (PROXY_ENABLED) {
  try {
    await startRangeProxy();
    console.log(`  • Parallel fetch proxy: 127.0.0.1:${rangeProxyPort} (${PROXY_CONNECTIONS} connections x ${(PROXY_CHUNK_BYTES / 1_048_576).toFixed(1)}MB chunks)`);
  } catch (err) {
    console.warn(`  ⚠️  Parallel fetch proxy failed to start (${err.message}). Using single-connection fetch.`);
  }
}
await Promise.all([
  checkYtDlpVersion(),
  detectJsRuntimeSupport(),
  detectJsRuntime(),
  detectEncoder(),
  detectHttpOptions(),
]);
console.log(`  • Encoder : ${encoderLabel}`);
console.log(`  • Direct ffmpeg path: ${USE_DIRECT_FFMPEG ? 'on' : 'off'} | clients: ${PLAYER_CLIENTS.join(', ')}`);
if (!supportsJsRuntimes) console.warn('  ⚠️  This yt-dlp does not support --js-runtimes. Update it: yt-dlp -U');
console.log(`  • Sites: ${Object.keys(PLATFORM_HOSTS).join(', ')}`);
if (COOKIES_FILE) console.log(`  • Cookies file: ${COOKIES_FILE}`);
else if (COOKIES_FROM_BROWSER) console.log(`  • Cookies from browser: ${COOKIES_FROM_BROWSER}`);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 ClipTube API → http://127.0.0.1:${PORT}`);
  console.log(`  • Max clip: ${MAX_CLIP_SECONDS}s | CORS: ${CORS_ORIGIN} | Temp: ${TEMP_DIR}\n`);
});