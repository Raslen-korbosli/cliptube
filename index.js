/**
 * ClipTube Backend Server — v5 (YouTube + TikTok + Instagram + Local Preview Proxy)
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_CLIP_SECONDS = parseInt(process.env.MAX_CLIP_SECONDS || '600', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const USE_DIRECT_FFMPEG = (process.env.USE_DIRECT_FFMPEG ?? 'true').toLowerCase() !== 'false';
const COOKIES_FROM_BROWSER = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
const PLAYER_CLIENTS = (process.env.YTDLP_PLAYER_CLIENTS || 'default,tv,android_vr,mweb')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_CLIENT_ATTEMPTS = parseInt(process.env.MAX_CLIENT_ATTEMPTS || '3', 10);

const STALL_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 8_000;
const DIRECT_FAIL_LIMIT = 3;
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

// ─── Platform Detection & URL Helpers ───────────────────────────────────────
// ─── Platform Detection & URL Helpers ───────────────────────────────────────
const urlByMediaId = new Map(); // mediaId → clean full URL

function detectPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const t = url.trim();

  if (/^tt_/i.test(t)) return 'tiktok';
  if (/^ig_/i.test(t)) return 'instagram';
  if (/^yt_/i.test(t)) return 'youtube';

  if (
    /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/i.test(t) ||
    /^[A-Za-z0-9_-]{11}$/.test(t)
  ) {
    return 'youtube';
  }

  if (
    /^(https?:\/\/)?(www\.|m\.|vm\.|vt\.)?tiktok\.com\/(@[\w.-]+\/video\/\d+|@[\w.-]+\/photo\/\d+|t\/[\w-]+|v\/\d+|[\w-]+)/i.test(t)
  ) {
    return 'tiktok';
  }

  if (
    /^(https?:\/\/)?(www\.|m\.)?(instagram\.com|instagr\.am)\/(reels?|p|tv|share\/reel|share\/p)\/[A-Za-z0-9_-]+/i.test(t)
  ) {
    return 'instagram';
  }

  return null;
}

function isValidMediaUrl(url) {
  return detectPlatform(url) !== null;
}

function extractMediaId(url) {
  if (!url) return null;
  const t = String(url).trim();
  if (/^(tt_|ig_|yt_)/i.test(t)) return t;

  const platform = detectPlatform(t);

  if (platform === 'youtube') {
    if (/^[A-Za-z0-9_-]{11}$/.test(t)) return `yt_${t}`;
    const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    if (m) return `yt_${m[1]}`;
  }

  if (platform === 'tiktok') {
    const m = t.match(/\/(?:video|v|photo)\/(\d+)/);
    if (m) return `tt_${m[1]}`;
    const shortMatch = t.match(/tiktok\.com\/(?:t\/)?([\w-]+)/i);
    if (shortMatch) return `tt_${shortMatch[1]}`;
  }

  if (platform === 'instagram') {
    const m = t.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
    if (m) return `ig_${m[1]}`;
  }

  const hash = crypto.createHash('sha1').update(t).digest('hex').slice(0, 14);
  return `${platform || 'media'}_${hash}`;
}

function cleanMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const t = url.trim();

  // If the frontend passed a mediaId (e.g. ig_DfcRQgONi_s or tt_7123456), check our saved URL map first
  if (urlByMediaId.has(t)) return urlByMediaId.get(t);
  if (/^ig_([A-Za-z0-9_-]+)$/i.test(t)) return `https://www.instagram.com/reel/${t.slice(3)}/`;
  if (/^tt_(\d+)$/i.test(t)) return `https://www.tiktok.com/@_/video/${t.slice(3)}`;
  if (/^tt_([\w-]+)$/i.test(t)) return `https://vm.tiktok.com/${t.slice(3)}/`;
  if (/^yt_([A-Za-z0-9_-]{11})$/i.test(t)) return `https://www.youtube.com/watch?v=${t.slice(3)}`;

  const platform = detectPlatform(t);

  try {
    if (platform === 'youtube') {
      if (/^[A-Za-z0-9_-]{11}$/.test(t)) return `https://www.youtube.com/watch?v=${t}`;
      const p = new URL(t.startsWith('http') ? t : `https://${t}`);
      if (p.hostname.includes('youtu.be')) {
        const id = p.pathname.replace(/^\//, '').split('/')[0];
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (p.pathname.includes('/shorts/') || p.pathname.includes('/embed/') || p.pathname.includes('/live/')) {
        const m = p.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
        if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
      }
      const v = p.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }

    if (platform === 'instagram') {
      const p = new URL(t.startsWith('http') ? t : `https://${t}`);
      const cleaned = `https://www.instagram.com${p.pathname.replace(/\/+$/, '')}/`;
      const id = extractMediaId(cleaned);
      if (id) urlByMediaId.set(id, cleaned);
      return cleaned;
    }

    if (platform === 'tiktok') {
      const p = new URL(t.startsWith('http') ? t : `https://${t}`);
      const cleaned = `${p.origin}${p.pathname}`;
      const id = extractMediaId(cleaned);
      if (id) urlByMediaId.set(id, cleaned);
      return cleaned;
    }
  } catch { /* fallback */ }

  return t.startsWith('http') ? t : `https://${t}`;
}
function extractMediaId(url) {
  if (!url) return null;
  const t = String(url).trim();
  const platform = detectPlatform(t);

  if (platform === 'youtube') {
    if (/^[A-Za-z0-9_-]{11}$/.test(t)) return `yt_${t}`;
    const m = t.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    if (m) return `yt_${m[1]}`;
  }

  if (platform === 'tiktok') {
    const m = t.match(/\/(?:video|v)\/(\d+)/);
    if (m) return `tt_${m[1]}`;
  }

  if (platform === 'instagram') {
    const m = t.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
    if (m) return `ig_${m[1]}`;
  }

  const hash = crypto.createHash('sha1').update(cleanMediaUrl(t)).digest('hex').slice(0, 14);
  return `${platform || 'media'}_${hash}`;
}

// ─── Caches ─────────────────────────────────────────────────────────────────
const infoCache = new Map();     // mediaId → { data, ts }
const streamCache = new Map();   // `${mediaId}_${height}_${kind}` → { streams, client, ts }
const previewCache = new Map();  // mediaId → { filePath, ts, promise }
const INFO_TTL = 30 * 60_000;
const STREAM_TTL = 20 * 60_000;

function getCachedInfo(mediaId) {
  const c = infoCache.get(mediaId);
  if (c && Date.now() - c.ts < INFO_TTL) return c.data;
  infoCache.delete(mediaId);
  return null;
}

function streamCacheKey(mediaId, height, isMp3) {
  return `${mediaId}_${height}_${isMp3 ? 'audio' : 'video'}`;
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
  for (const [k, v] of previewCache) {
    if (now - v.ts > STREAM_TTL) {
      if (v.filePath) deleteFiles(v.filePath);
      previewCache.delete(k);
    }
  }
}, 60_000);

// ─── Direct-path health ─────────────────────────────────────────────────────
function noteDirectSuccess() { directFailStreak = 0; }
function noteDirectFailure(reason) {
  directFailStreak++;
  if (directFailStreak >= DIRECT_FAIL_LIMIT) {
    directDisabledUntil = Date.now() + DIRECT_COOLDOWN_MS;
    directFailStreak = 0;
    console.warn(`[Direct] Disabled for 30 min after repeated failures (${reason}).`);
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
    if (now - job.createdAt > JOB_TTL_MS) { cleanupJob(id); }
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

// ─── Utility ────────────────────────────────────────────────────────────────
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

function mapYtDlpError(stderr, platform = 'youtube') {
  const lo = stderr.toLowerCase();
  const lines = stderr.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || 'yt-dlp failed';
  if (lo.includes('not a bot') || lo.includes('sign in to confirm')) {
    return mkErr('Bot check triggered. Update yt-dlp (yt-dlp -U) or set YTDLP_COOKIES_FROM_BROWSER in .env.', false);
  }
  if (lo.includes('login required') || lo.includes('rate-limit reached')) {
    return mkErr(`${platform} requires login or hit a rate limit. Set YTDLP_COOKIES_FROM_BROWSER=firefox in .env.`, true);
  }
  if (lo.includes('age-restricted') || lo.includes('confirm your age')) {
    return mkErr('This video is age-restricted.', true);
  }
  if (lo.includes('video unavailable') || lo.includes('private video') || lo.includes('status code 10204')) {
    return mkErr('This video is private or unavailable.', true);
  }
  return mkErr(last.replace(/^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?/i, ''), false);
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
}

async function checkYtDlpVersion() {
  return new Promise(resolve => {
    const c = spawn(resolvedYtDlp, ['--version'], { windowsHide: true });
    c.on('close', () => resolve());
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
  if (await checkBinary('deno', ['--version'])) jsRuntime = 'deno';
  else if (await checkBinary('node', ['--version'])) jsRuntime = 'node';
}

async function detectEncoder() {
  return new Promise(resolve => {
    try {
      const c = spawn(resolvedFfmpeg, ['-encoders', '-hide_banner'], { windowsHide: true });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.on('close', () => {
        for (const { name, label } of [
          { name: 'h264_nvenc', label: 'NVIDIA NVENC' },
          { name: 'h264_qsv', label: 'Intel QuickSync' },
          { name: 'h264_amf', label: 'AMD AMF' },
          { name: 'h264_videotoolbox', label: 'Apple VideoToolbox' },
        ]) {
          if (out.includes(name)) { detectedEncoder = name; encoderLabel = `${name} (${label})`; break; }
        }
        resolve();
      });
      c.on('error', () => resolve());
    } catch { resolve(); }
  });
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
      resolve();
    });
    child.on('error', () => resolve());
  });
}

// ─── yt-dlp helpers ─────────────────────────────────────────────────────────
function ytdlpCommonArgs() {
  const a = [];
  if (supportsJsRuntimes && jsRuntime) a.push('--js-runtimes', jsRuntime);
  if (COOKIES_FROM_BROWSER) a.push('--cookies-from-browser', COOKIES_FROM_BROWSER);
  return a;
}

function clientArgs(client, platform = 'youtube') {
  if (platform !== 'youtube' || !client || client === 'default') return [];
  return ['--extractor-args', `youtube:player_client=${client}`];
}

/**
 * Format selector:
 * - TikTok uses `h264` or `bytevc1` (not `avc1`) and serves pre-muxed MP4s (`b`).
 * - Instagram uses DASH (`bv*+ba`) or muxed MP4 (`b`).
 * - YouTube uses `bv*[vcodec^=avc1]+ba`.
 */
function buildFormat(heightLimit, isMp3, platform = 'youtube') {
  if (isMp3) {
    return platform === 'tiktok' ? 'b[ext=mp4]/b/ba' : 'ba[ext=m4a]/ba/b';
  }
  if (platform === 'tiktok') {
    return `b[vcodec^=h264][width<=${heightLimit}]/b[vcodec^=h264]/b[ext=mp4][width<=${heightLimit}]/b[ext=mp4]/b`;
  }
  if (platform === 'instagram') {
    return `bv*[vcodec^=avc1][width<=${heightLimit}]+ba/bv*[width<=${heightLimit}]+ba/b[width<=${heightLimit}]/bv*+ba/b`;
  }
  return `bv*[vcodec^=avc1][height<=${heightLimit}]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=${heightLimit}]+ba/bv*[height<=${heightLimit}]+ba/b[height<=${heightLimit}]/b`;
}

function candidateClients(platform = 'youtube') {
  if (platform !== 'youtube') return ['default'];
  const list = [];
  if (workingClient) list.push(workingClient);
  for (const c of PLAYER_CLIENTS) if (!list.includes(c)) list.push(c);
  return list.slice(0, Math.max(1, MAX_CLIENT_ATTEMPTS));
}

function runYtDlpJson(url, formatStr, client, platform = 'youtube') {
  return new Promise((resolve, reject) => {
    const args = ['-j', '--no-playlist', '--no-warnings', '--no-progress'];
    if (formatStr) args.push('-f', formatStr);
    args.push(...ytdlpCommonArgs(), ...clientArgs(client, platform), url);

    const child = spawn(resolvedYtDlp, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') return reject(mkErr('yt-dlp is not installed.', true));
      reject(mkErr(`yt-dlp: ${err.message}`, false));
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(mapYtDlpError(stderr, platform));
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

function streamsFromJson(d) {
  const list = Array.isArray(d.requested_formats) && d.requested_formats.length ? d.requested_formats : [d];
  return list
    .filter((f) => f && f.url)
    .map((f) => {
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
        height: f.height || null,
      };
    });
}

function describeStreams(streams) {
  return streams.map((s) => `${s.kind}/${s.ext || '?'}${s.height ? '@' + s.height + 'p' : ''}`).join(' + ');
}

async function extractStreams(url, formatStr, client, platform = 'youtube') {
  const d = await runYtDlpJson(url, formatStr, client, platform);
  const defaultTitle =
    platform === 'tiktok' ? 'TikTok Video' :
      platform === 'instagram' ? 'Instagram Video' : 'YouTube Video';

  const info = {
    title: d.title || d.description?.slice(0, 80) || defaultTitle,
    duration: d.duration || 0,
    thumbnail: d.thumbnail || (Array.isArray(d.thumbnails) && d.thumbnails.length ? d.thumbnails[d.thumbnails.length - 1].url : ''),
    platform,
    previewUrl: platform !== 'youtube' ? `/api/preview?url=${encodeURIComponent(url)}` : null,
  };
  return { info, streams: streamsFromJson(d) };
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

async function resolveDirectStreams(url, formatStr, cacheKey, platform = 'youtube') {
  const mediaId = extractMediaId(url);
  const cached = getCachedStreams(cacheKey);
  if (cached) {
    const probes = await Promise.all(cached.streams.map(probeStream));
    if (probes.every((p) => p.ok)) return { streams: cached.streams, client: cached.client };
    streamCache.delete(cacheKey);
  }

  for (const client of candidateClients(platform)) {
    let result;
    try {
      result = await extractStreams(url, formatStr, client, platform);
    } catch (err) {
      if (err.fatal) throw err;
      continue;
    }

    const { info, streams } = result;
    if (mediaId) infoCache.set(mediaId, { data: info, ts: Date.now() });
    if (!streams.length || streams.some((s) => !/^https?$/.test(s.protocol))) continue;

    const probes = await Promise.all(streams.map(probeStream));
    if (probes.every((p) => p.ok)) {
      if (platform === 'youtube') workingClient = client;
      streamCache.set(cacheKey, { streams, client, ts: Date.now() });
      return { streams, client };
    }
  }
  return null;
}

// ─── Parallel range proxy (YouTube) ─────────────────────────────────────────
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
  if (!m) throw new Error(`could not determine stream size (HTTP ${res.status})`);
  entry.size = parseInt(m[1], 10);
  if (!entry.contentType) entry.contentType = res.headers.get('content-type') || 'application/octet-stream';
  return entry.size;
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
      p.catch(() => { });
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
    if (!ac.signal.aborted) res.destroy(err);
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
    if (s._proxyId) rangeStreams.delete(s._proxyId);
  }
}

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
      if (code === 0) resolve();
      else if (code === null) reject(new Error('KILLED'));
      else {
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

// ─── Social Media (TikTok & Instagram) Download-Then-Trim Pipeline ──────────
/**
 * Downloads the full TikTok/Instagram video via yt-dlp's native downloader (which preserves
 * cookies, TLS session, and merges DASH segments reliably), then caches it for preview/clipping.
 */
function ensureSocialSourceFile(url, mediaId, formatStr, job = null) {
  const cached = previewCache.get(mediaId);
  if (cached && cached.filePath && fs.existsSync(cached.filePath)) {
    cached.ts = Date.now();
    return Promise.resolve(cached.filePath);
  }
  if (cached && cached.promise) return cached.promise;

  const outFile = path.join(TEMP_DIR, `src_${mediaId}.mp4`);
  const promise = new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--windows-filenames',
      '-f', formatStr || 'bv*+ba/b[ext=mp4]/b',
      '--merge-output-format', 'mp4',
      ...ytdlpCommonArgs(),
    ];
    if (resolvedFfmpegDir) args.push('--ffmpeg-location', resolvedFfmpegDir);
    args.push('-o', outFile, url);

    const child = spawn(resolvedYtDlp, args, { windowsHide: true });
    if (job) job.children.push(child);

    let stderr = '';
    child.stdout.on('data', (d) => {
      if (!job) return;
      const m = d.toString().match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        const pct = Math.min(60, Math.round(10 + parseFloat(m[1]) * 0.5));
        updateProgress(job.id, pct, `Fetching video (${m[1]}%)…`);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outFile)) {
        previewCache.set(mediaId, { filePath: outFile, ts: Date.now(), promise: null });
        resolve(outFile);
      } else {
        previewCache.delete(mediaId);
        reject(mapYtDlpError(stderr || 'Failed to download source video', detectPlatform(url)));
      }
    });
    child.on('error', (err) => {
      previewCache.delete(mediaId);
      reject(err);
    });
  });

  previewCache.set(mediaId, { filePath: null, ts: Date.now(), promise });
  return promise;
}

/**
 * Trims the locally downloaded TikTok/Instagram file with ffmpeg.
 */
async function runSocialPipeline(job, { url, mediaId, start, end, isMp3, exact, formatStr, outPath, T }) {
  updateProgress(job.id, 10, 'Downloading source video…');
  const t0 = Date.now();
  const srcPath = await ensureSocialSourceFile(url, mediaId, formatStr, job);
  T.extract = Date.now() - t0;

  const dur = end - start;
  updateProgress(job.id, 65, isMp3 ? 'Extracting MP3…' : 'Trimming clip…');
  const tTrim = Date.now();

  let ffmpegArgs;
  if (isMp3) {
    ffmpegArgs = [
      '-ss', String(start), '-t', String(dur), '-i', srcPath,
      '-vn', '-c:a', 'libmp3lame', '-q:a', '2',
      '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-y', outPath,
    ];
  } else {
    // Re-encode if exact mode is requested, or copy stream (with ultrafast fallback if VP9/ByteVC1)
    const codecArgs = exact
      ? [...getEncoderArgs(), '-c:a', 'aac', '-b:a', '128k']
      : ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'];
    ffmpegArgs = [
      '-ss', String(start), '-t', String(dur), '-i', srcPath,
      ...codecArgs,
      '-movflags', '+faststart',
      '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-y', outPath,
    ];
  }

  try {
    const { child, promise } = spawnFfmpeg(ffmpegArgs, job, 'ffmpeg-social-trim');
    trackProgress(child, dur, (p) => {
      if (p !== null) updateProgress(job.id, 65 + Math.round(p * 30), 'Trimming clip…');
    });
    await promise;
  } catch (err) {
    // If -c:v copy failed (e.g. VP9 stream inside MP4 container), re-encode with H.264
    if (!isMp3 && !exact) {
      const { child, promise } = spawnFfmpeg([
        '-ss', String(start), '-t', String(dur), '-i', srcPath,
        ...getEncoderArgs(), '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
        '-y', outPath,
      ], job, 'ffmpeg-social-reencode');
      trackProgress(child, dur, (p) => {
        if (p !== null) updateProgress(job.id, 65 + Math.round(p * 30), 'Encoding clip…');
      });
      await promise;
    } else {
      throw err;
    }
  }

  T.video = Date.now() - tTrim;
  return exact ? 'social-local-exact' : 'social-local-trim';
}

// ─── YouTube Direct Path ────────────────────────────────────────────────────
async function runDirectPath(job, streams, { start, end, isMp3, exact, outPath, vPath, aPath, T }) {
  const dur = end - start;

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
  const m = streams.find((s) => s.kind === 'muxed') || (streams.length === 1 ? streams[0] : null);

  if (!(v && a) && m) {
    updateProgress(job.id, 15, exact ? 'Encoding clip…' : 'Downloading clip…');
    const t = Date.now();
    const codecArgs = exact ? [...getEncoderArgs(), '-c:a', 'aac', '-b:a', '128k'] : ['-c', 'copy'];
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

// ─── YouTube yt-dlp fallback ────────────────────────────────────────────────
function ytdlpFallback(job, url, start, end, formatStr, outPath, isMp3 = false, client = null) {
  return new Promise((resolve, reject) => {
    const fileExt = isMp3 ? 'mp3' : 'mp4';
    const outTemplate = path.join(TEMP_DIR, `${job.id}.%(ext)s`);
    const sectionArg = `*${start}-${end}`;
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--windows-filenames',
      '--download-sections', sectionArg,
      '-N', '16',
      '--http-chunk-size', '5M',
    ];

    if (resolvedFfmpegDir) args.push('--ffmpeg-location', resolvedFfmpegDir);
    args.push(...ytdlpCommonArgs(), ...clientArgs(client, 'youtube'));

    if (isMp3) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', formatStr, '--merge-output-format', 'mp4');
    }

    args.push('-o', outTemplate, url);

    const child = spawn(resolvedYtDlp, args, { windowsHide: true });
    job.children.push(child);
    let stderr = '', stdout = '';
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

async function runYtdlpFallback(job, url, start, end, formatStr, outPath, isMp3) {
  try {
    return await ytdlpFallback(job, url, start, end, formatStr, outPath, isMp3, null);
  } catch (err) {
    if (/403|forbidden/i.test(err.message)) {
      const alt = PLAYER_CLIENTS.find((c) => c !== 'default');
      if (alt) {
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
  const platform = detectPlatform(url) || 'youtube';
  const mediaId = extractMediaId(url);

  job.mimeType = isMp3 ? 'audio/mpeg' : 'video/mp4';

  const vPath = path.join(TEMP_DIR, `${job.id}_v.mp4`);
  const aPath = path.join(TEMP_DIR, `${job.id}_a.m4a`);

  const heightLimit = quality === '1080p' ? 1080 : quality === '360p' ? 360 : 720;
  const formatStr = buildFormat(heightLimit, isMp3, platform);
  const cacheKey = streamCacheKey(mediaId, heightLimit, isMp3);

  try {
    let method = 'yt-dlp-fallback';
    let client = '-';

    if (platform === 'tiktok' || platform === 'instagram') {
      // TikTok & Instagram: native yt-dlp fetch + local ffmpeg trim (100% immune to CDN 403s)
      method = await runSocialPipeline(job, {
        url, mediaId, start, end, isMp3, exact, formatStr, outPath, T,
      });
    } else {
      // YouTube: Direct fast path + parallel range proxy -> yt-dlp fallback
      let finished = false;
      if (USE_DIRECT_FFMPEG && Date.now() >= directDisabledUntil) {
        updateProgress(job.id, 5, 'Resolving stream…');
        const te = Date.now();
        const direct = await resolveDirectStreams(url, formatStr, cacheKey, platform);
        T.extract = Date.now() - te;

        if (direct) {
          client = direct.client;
          const routed = rangeProxyPort ? direct.streams.map(registerRangeStream) : direct.streams;
          try {
            method = await runDirectPath(job, routed, { start, end, isMp3, exact, outPath, vPath, aPath, T });
            if (rangeProxyPort) method += '+parallel-fetch';
            noteDirectSuccess();
            finished = true;
          } catch (err) {
            killJobChildren(job);
            deleteFiles(outPath, vPath, aPath);
            streamCache.delete(cacheKey);
            noteDirectFailure(err.message);
            console.warn(`[Clip ${job.id}] Direct path failed (${err.message}). Falling back to yt-dlp…`);
          } finally {
            releaseRangeStreams(routed);
          }
        } else {
          noteDirectFailure('no player client accepted');
        }
      }

      if (!finished) {
        method = 'yt-dlp-fallback';
        updateProgress(job.id, 20, 'Downloading with yt-dlp…');
        const tf = Date.now();
        await runYtdlpFallback(job, url, start, end, formatStr, outPath, isMp3);
        T.video = Date.now() - tf;
      }
    }

    T.total = Date.now() - t0;
    await finishJob(job, outPath, title, start, end, fileExt, method, T, client, platform);

  } catch (err) {
    killJobChildren(job);
    deleteJobTempFiles(job.id);
    job.status = 'error';
    job.error = err.message;
    console.error(`[Clip ${job.id}] ✗ ${err.message}`);
    notifyJob(job.id, 'fail', { message: err.message });
  }
}

async function finishJob(job, outPath, title, start, end, fileExt, method, T, client = '-', platform = 'youtube') {
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
    `[Clip ${job.id}] ✓ platform=${platform} method=${method} total=${sec(T.total)}s size=${sizeMB}MB`
  );

  updateProgress(job.id, 100, 'Ready');
  notifyJob(job.id, 'done', {
    clipId: job.id,
    platform,
    elapsed: parseFloat(sec(T.total)),
    mode: method,
    sizeMB: parseFloat(sizeMB),
    speedMBs: parseFloat(speedMBs),
    timings: { extract: sec(T.extract), video: sec(T.video), audio: sec(T.audio), mux: sec(T.mux) },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/info', rateLimiter(15), async (req, res) => {
  const { url } = req.body || {};
  if (!isValidMediaUrl(url))
    return res.status(400).json({ error: 'Invalid link. Supported platforms: YouTube, TikTok, and Instagram.' });

  const platform = detectPlatform(url);
  const cleanUrl = cleanMediaUrl(url);
  const mediaId = extractMediaId(cleanUrl);
  const cached = mediaId && getCachedInfo(mediaId);
  if (cached) {
    return res.json(cached);
  }

  const fmt = buildFormat(720, false, platform);
  const clients = platform === 'youtube' ? [workingClient || 'default'] : ['default'];
  if (platform === 'youtube' && !clients.includes('default')) clients.push('default');

  let lastErr = null;
  for (const client of clients) {
    try {
      const { info, streams } = await extractStreams(cleanUrl, fmt, client, platform);
      if (mediaId) {
        infoCache.set(mediaId, { data: info, ts: Date.now() });
        if (platform === 'youtube' && streams.length) {
          streamCache.set(streamCacheKey(mediaId, 720, false), { streams, client, ts: Date.now() });
        }
      }
      // Pre-warm the local video file in the background for TikTok/Instagram so preview & clipping are instant
      if (platform === 'tiktok' || platform === 'instagram') {
        ensureSocialSourceFile(cleanUrl, mediaId, fmt).catch(() => { });
      }
      return res.json(info);
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
    }
  }
  return res.status(400).json({ error: lastErr?.message || 'Metadata fetch failed.' });
});

/**
 * Local video preview endpoint for TikTok & Instagram so the frontend <video> tag
 * can play and seek smoothly without CORS or CDN 403 errors.
 */
app.get('/api/preview', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  if (!isValidMediaUrl(rawUrl)) return res.status(400).json({ error: 'Invalid URL' });

  const platform = detectPlatform(rawUrl);
  const cleanUrl = cleanMediaUrl(rawUrl);
  const mediaId = extractMediaId(cleanUrl);
  const fmt = buildFormat(720, false, platform);

  try {
    const filePath = await ensureSocialSourceFile(cleanUrl, mediaId, fmt);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clip', rateLimiter(10), (req, res) => {
  const { url, start, end, format = 'mp4', quality = '720p', exact = false, title = '' } = req.body || {};
  if (!isValidMediaUrl(url))
    return res.status(400).json({ error: 'Invalid link. Supported platforms: YouTube, TikTok, and Instagram.' });

  const s = parseFloat(start), e = parseFloat(end);
  if (isNaN(s) || isNaN(e)) return res.status(400).json({ error: 'Invalid times.' });
  if (s < 0 || e <= s) return res.status(400).json({ error: 'Start must be >= 0 and < end.' });
  if (e - s > MAX_CLIP_SECONDS) return res.status(400).json({ error: `Clip too long (max ${MAX_CLIP_SECONDS}s).` });

  const cleanUrl = cleanMediaUrl(url);
  const mediaId = extractMediaId(cleanUrl);
  const useTitle = title || (mediaId && getCachedInfo(mediaId)?.title) || '';

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
  stream.on('finish', () => setTimeout(() => cleanupJob(job.id), 2000));
  stream.pipe(res);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    supportedPlatforms: ['youtube', 'tiktok', 'instagram'],
    maxClipSeconds: MAX_CLIP_SECONDS,
    ytDlp: resolvedYtDlp, ffmpeg: resolvedFfmpeg,
    encoder: encoderLabel, jsRuntime, supportsJsRuntimes,
    directFfmpeg: USE_DIRECT_FFMPEG && Date.now() >= directDisabledUntil,
    workingClient, activeJobs: jobs.size,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
await resolveBinaries();
if (PROXY_ENABLED) {
  try { await startRangeProxy(); } catch { /* */ }
}
await Promise.all([
  checkYtDlpVersion(),
  detectJsRuntimeSupport(),
  detectJsRuntime(),
  detectEncoder(),
  detectHttpOptions(),
]);
console.log(`  🚀 ClipTube v5 Ready → http://127.0.0.1:${PORT} (YouTube + TikTok + Instagram)\n`);

app.listen(PORT, '0.0.0.0');