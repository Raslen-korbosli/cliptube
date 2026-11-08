# ClipTube ✂️

A fast, dark-themed, single-page web tool that lets users paste a YouTube link, pick a start and end time with frame-accurate precision, preview the selection, and download ONLY that trimmed segment as an **MP4** video or **MP3** audio file.

No account needed. No video downloading or re-hosting of full videos — only the selected section is retrieved and re-encoded using `yt-dlp` and `ffmpeg`.

---

## Features

- 🎬 **Smart YouTube Support**: Supports `youtube.com/watch?v=...`, `youtu.be/...`, YouTube Shorts, and embed URLs.
- ⏱️ **Frame-Accurate Trimming**:
  - Start & End inputs with `<` and `>` 1-second nudging. Supports `mm:ss` and `hh:mm:ss`.
  - Dual-handle range slider with teal highlight and real-time playback head fill.
  - Hold `Shift` while dragging or nudging for **0.1-second fine precision**.
  - Integrated YouTube player preview that plays only the trimmed section and auto-pauses at the end.
- ⚡ **High-Speed Parallel Pipeline**:
  - Direct stream URL extraction with in-memory caching (10 min TTL).
  - Parallel concurrent video & audio stream downloading via twin ffmpeg workers with persistent HTTP connections and automatic retry.
  - Sub-second local stream-copy muxing (`-c copy -movflags +faststart`).
  - Automatic fallback to `yt-dlp -N 8` multi-connection downloader if parallel fetch stalls.
  - Hardware-accelerated "Exact cut" option with automatic GPU detection (NVIDIA NVENC, Intel QSV, AMD AMF, Apple VideoToolbox) or software libx264 ultrafast.
  - Real-time Server-Sent Events (SSE) progress streaming.
- 🎵 **Format & Quality Options**:
  - Formats: **MP4** (video + audio) and **MP3** (audio only).
  - Video qualities: **360p**, **720p** (default), and **1080p**.
- 🛡️ **Clean & Secure Architecture**:
  - `child_process.spawn` argument array execution (no shell string execution / zero command injection risk).
  - In-memory rate limiting and request timeout guards.
  - Automatic temp file streaming and immediate cleanup.
- 🎨 **Minimal Dark UI**:
  - Near-black background (`#15110e`), card surfaces (`#26231f`), teal/emerald accents (`#10b981`), geometric sans-serif typography (`Outfit`).
  - Single-page application with no clutter, no paywalls, no login barriers.

---

## Prerequisites

Before running, ensure you have:

1. **Node.js** (v18 or higher) and **npm** (v9+)
2. **yt-dlp** and **ffmpeg** installed and in your system `PATH`:

### Installing yt-dlp & ffmpeg

- **Windows** (Run in PowerShell or Command Prompt):
  ```powershell
  winget install yt-dlp ffmpeg
  ```
  *(Or using Chocolatey: `choco install yt-dlp ffmpeg`)*

- **macOS** (Using Homebrew):
  ```bash
  brew install yt-dlp ffmpeg
  ```

- **Linux** (Debian / Ubuntu):
  ```bash
  sudo apt update && sudo apt install -y ffmpeg
  pip install --upgrade yt-dlp
  ```

---

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment (optional)**:
   A `.env.example` file is included:
   ```env
   PORT=3001
   MAX_CLIP_SECONDS=600
   CORS_ORIGIN=http://localhost:5173
   ```
   Copy it to `.env` if you want to customize the port or maximum clip duration:
   ```bash
   cp .env.example .env
   ```

3. **Run both Frontend and Backend with a single command**:
   ```bash
   npm run dev
   ```

   This launches:
   - **Frontend (Vite + React)** on `http://localhost:5173`
   - **Backend API (Node/Express)** on `http://localhost:3001`
   - Built-in Vite proxy forwarding `/api` to the backend.

4. Open your browser at **`http://localhost:5173`**.

---

## API Endpoints

### 1. `POST /api/info`
Retrieves video metadata without downloading.
- **Request Body**:
  ```json
  { "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
    "duration": 213,
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
  }
  ```

### 2. `POST /api/clip`
Downloads, cuts, and streams the specified time range.
- **Request Body**:
  ```json
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "start": 42.5,
    "end": 55.0,
    "format": "mp4",
    "quality": "720p"
  }
  ```
- **Response**: Binary stream with header:
  `Content-Disposition: attachment; filename="Rick Astley - Never Gonna Give You Up (00-42 to 00-55).mp4"`

### 3. `GET /api/health`
Checks server status and configuration.

---

## Customizing the App Name / Branding

The app name and branding are defined in one centralized file:
[`src/config.ts`](./src/config.ts):

```ts
export const APP_CONFIG = {
  name: 'ClipTube',
  logoPrefix: 'Clip',
  logoSuffix: 'Tube',
  tagline: 'Trim and download YouTube clips instantly',
  maxClipSeconds: 600,
};
```
Change these values to rebrand the application instantly across the UI.

---

## License

MIT
