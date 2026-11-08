import { Download, Loader2, Music, Video } from 'lucide-react';
import type { ClipFormat, ClipQuality } from '../types';
import { fmt } from '../lib/time';

interface ExportPanelProps {
  format: ClipFormat;
  quality: ClipQuality;
  exactCut: boolean;
  clipSeconds: number;
  maxClipSeconds: number;
  isDownloading: boolean;
  progress: number;
  stage: string;
  canDownload: boolean;
  onFormat: (f: ClipFormat) => void;
  onQuality: (q: ClipQuality) => void;
  onExactCut: (v: boolean) => void;
  onDownload: () => void;
}

const QUALITIES: { value: ClipQuality; label: string; hint: string }[] = [
  { value: '1080p', label: '1080p', hint: 'Sharpest, biggest file' },
  { value: '720p', label: '720p', hint: 'Good balance' },
  { value: '360p', label: '360p', hint: 'Smallest file' },
];

const MB_PER_SECOND: Record<string, number> = { '1080p': 0.7, '720p': 0.35, '360p': 0.14 };

function estimateSize(seconds: number, format: ClipFormat, quality: ClipQuality): string {
  const rate = format === 'mp3' ? 0.024 : MB_PER_SECOND[quality] ?? 0.35;
  const mb = seconds * rate;
  return mb < 1 ? 'under 1 MB' : `about ${Math.round(mb)} MB`;
}

export default function ExportPanel({
  format,
  quality,
  exactCut,
  clipSeconds,
  maxClipSeconds,
  isDownloading,
  progress,
  stage,
  canDownload,
  onFormat,
  onQuality,
  onExactCut,
  onDownload,
}: ExportPanelProps) {
  const tooLong = clipSeconds > maxClipSeconds;
  const ctaLabel = isDownloading
    ? progress > 0
      ? `${progress}%  ${stage}`
      : stage || 'Starting…'
    : `Download ${format === 'mp3' ? 'MP3' : 'MP4'}`;

  return (
    <div className="ct-export">
      <h2 className="ct-h2">Download</h2>

      <div className="ct-block">
        <span className="ct-block-label" id="ct-format-label">
          Format
        </span>
        <div className="ct-seg" role="group" aria-labelledby="ct-format-label">
          <button type="button" aria-pressed={format === 'mp4'} disabled={isDownloading} onClick={() => onFormat('mp4')}>
            <Video size={15} />
            Video (MP4)
          </button>
          <button type="button" aria-pressed={format === 'mp3'} disabled={isDownloading} onClick={() => onFormat('mp3')}>
            <Music size={15} />
            Audio (MP3)
          </button>
        </div>
      </div>

      {format === 'mp4' && (
        <>
          <div className="ct-block">
            <span className="ct-block-label" id="ct-quality-label">
              Quality
            </span>
            <div className="ct-options" role="radiogroup" aria-labelledby="ct-quality-label">
              {QUALITIES.map((q) => (
                <button
                  key={q.value}
                  type="button"
                  role="radio"
                  aria-checked={quality === q.value}
                  className="ct-option"
                  disabled={isDownloading}
                  onClick={() => onQuality(q.value)}
                >
                  <span className="ct-radio" aria-hidden="true" />
                  <span className="ct-option-text">
                    <strong>{q.label}</strong>
                    <small>{q.hint}</small>
                  </span>
                </button>
              ))}
            </div>
            {quality === '1080p' && (
              <p className="ct-footnote">
                If YouTube refuses 1080p for a video, the clip is saved at 720p and you’ll be told.
              </p>
            )}
          </div>

          <div className="ct-switch-row">
            <div>
              <p className="ct-switch-title" id="ct-exact-label">
                Exact cut
              </p>
              <p className="ct-footnote">
                {exactCut
                  ? 'Cuts on the exact frame. Takes longer because the video is re-encoded.'
                  : 'Fast. The cut can land 1 to 3 seconds off because it snaps to the nearest keyframe.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={exactCut}
              aria-labelledby="ct-exact-label"
              className="ct-switch"
              disabled={isDownloading}
              onClick={() => onExactCut(!exactCut)}
            >
              <span />
            </button>
          </div>
        </>
      )}

      <dl className="ct-summary">
        <div>
          <dt>Clip length</dt>
          <dd className={tooLong ? 'is-over' : ''}>{fmt(clipSeconds, true, clipSeconds >= 3600)}</dd>
        </div>
        <div>
          <dt>Estimated size</dt>
          <dd>{estimateSize(clipSeconds, format, quality)}</dd>
        </div>
      </dl>

      {tooLong && (
        <p className="ct-field-error" role="alert">
          Clips can be at most {fmt(maxClipSeconds, false, false)} long. Move the brackets closer together.
        </p>
      )}

      <button type="button" className="ct-cta" onClick={onDownload} disabled={!canDownload || isDownloading}>
        {isDownloading && progress > 0 && <span className="ct-cta-fill" style={{ width: `${progress}%` }} />}
        <span className="ct-cta-inner">
          {isDownloading ? <Loader2 size={18} className="ct-spin" /> : <Download size={18} strokeWidth={2.4} />}
          <span className="ct-cta-label">{ctaLabel}</span>
        </span>
      </button>

      <p className="ct-footnote ct-center">Your clip is made on the server and downloads when it’s ready.</p>
    </div>
  );
}
