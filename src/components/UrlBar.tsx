import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import { Clipboard, Link2, Loader2, X } from 'lucide-react';
import { extractVideoId, detectPlatform } from '../utils';
import { fmt } from '../lib/time';

interface UrlBarProps {
  url: string;
  videoId: string;
  videoTitle: string;
  duration: number;
  isLoading: boolean;
  thumbnail?: string;
  onLoad: (videoId: string, url: string) => void;
  onClear?: () => void;
}

export default function UrlBar({
  url,
  videoId,
  videoTitle,
  duration,
  isLoading,
  thumbnail,
  onLoad,
  onClear,
}: UrlBarProps) {
  const [input, setInput] = useState(url);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInput(url);
  }, [url]);

  useEffect(() => {
    if (!videoId) {
      inputRef.current?.focus();
    }
  }, [videoId]);

  const submit = useCallback(
    (raw?: string) => {
      const target = (raw ?? input).trim();
      if (!target) {
        setError('Paste a YouTube, TikTok, or Instagram link to get started.');
        return;
      }
      const id = extractVideoId(target);
      if (!id) {
        setError('Unsupported link. Links from YouTube, TikTok, and Instagram work.');
        return;
      }
      setError('');
      onLoad(id, target);
    },
    [input, onLoad]
  );

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').trim();
    if (pasted && extractVideoId(pasted)) {
      e.preventDefault();
      setInput(pasted);
      submit(pasted);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        setInput(text);
        submit(text);
      }
    } catch {
      inputRef.current?.focus();
      setError('The browser blocked clipboard access. Click the box and press Ctrl+V instead.');
    }
  };

  const clear = () => {
    setInput('');
    setError('');
    onClear?.();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      setInput(url);
      setError('');
    }
  };

  const platform = detectPlatform(url || input);
  const platformLabel =
    platform === 'tiktok' ? 'TikTok' :
      platform === 'instagram' ? 'Instagram' :
        platform === 'facebook' ? 'Facebook' : 'YouTube';
  const thumbSrc =
    thumbnail ||
    (platform === 'youtube' && videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '');

  return (
    <div className={`ct-urlwrap ${videoId ? 'is-compact' : 'is-hero'}`}>
      <div className={`ct-url ct-modern-url${error ? ' has-error' : ''}`}>
        <Link2 size={18} className="ct-url-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          className="ct-url-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={input}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setInput(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          placeholder="Paste a YouTube, TikTok, or Instagram link…"
          aria-label="Video link"
          aria-invalid={Boolean(error)}
        />
        {(input || videoId) && (
          <button
            type="button"
            className="ct-icon-btn"
            onClick={clear}
            aria-label="Clear link"
            title="Clear and start over"
          >
            <X size={16} />
          </button>
        )}
        <button type="button" className="ct-btn ct-btn-quiet" onClick={pasteFromClipboard}>
          <Clipboard size={15} />
          <span className="ct-hide-sm">Paste</span>
        </button>
        <button type="button" className="ct-btn ct-btn-primary" onClick={() => submit()} disabled={isLoading}>
          {isLoading ? <Loader2 size={16} className="ct-spin" /> : null}
          Load video
        </button>
      </div>

      {!videoId && !error && (
        <div className="ct-platform-pills" aria-label="Supported platforms">
          <span className="ct-platform-pill">
            <span className="ct-dot ct-dot-yt" />
            YouTube &amp; Shorts
          </span>
          <span className="ct-platform-pill">
            <span className="ct-dot ct-dot-tt" />
            TikTok
          </span>
          <span className="ct-platform-pill">
            <span className="ct-dot ct-dot-ig" />
            Instagram Reels
          </span>
        </div>
      )}

      {error && (
        <p className="ct-field-error" role="alert">
          {error}
        </p>
      )}

      {videoId && !error && (
        <div className="ct-meta ct-meta-animate">
          {thumbSrc && (
            <img
              className="ct-thumb"
              src={thumbSrc}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
          <div className="ct-meta-text">
            <div className="ct-meta-row">
              <span className={`ct-badge ct-badge-${platform || 'youtube'}`}>
                {platformLabel}
              </span>
              {videoTitle ? (
                <p className="ct-meta-title" title={videoTitle}>
                  {videoTitle}
                </p>
              ) : (
                <p className="ct-meta-title ct-skel">
                  {isLoading ? 'Fetching video details…' : `${platformLabel} video`}
                </p>
              )}
            </div>
            {duration > 0 && <p className="ct-meta-sub">Length {fmt(duration, false, duration >= 3600)}</p>}
          </div>
        </div>
      )}
    </div>
  );
}