import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { MIN_GAP, clamp, fmt, niceStep, parse } from '../lib/time';
import { playhead, usePlayhead } from '../lib/playhead';

type Side = 'start' | 'end';
type DragKind = Side | 'scrub';

interface TrimRangeSliderProps {
  duration: number;
  start: number;
  end: number;
  isPlaying: boolean;
  maxClipSeconds: number;
  onRangeChange: (start: number, end: number, final: boolean, moved: Side) => void;
  onSeek: (t: number, final: boolean) => void;
  onPlayPause: () => void;
  onReset: () => void;
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width || 640);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// ─── Timecode field ──────────────────────────────────────────────────────────
interface TimeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hours: boolean;
  shortcut: string;
  onCommit: (v: number) => void;
  onUsePlayhead: () => void;
}

function TimeField({ label, value, min, max, step, hours, shortcut, onCommit, onUsePlayhead }: TimeFieldProps) {
  const [text, setText] = useState(fmt(value, true, hours));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(fmt(value, true, hours));
  }, [value, focused, hours]);

  const commit = () => {
    const parsed = parse(text);
    if (Number.isFinite(parsed)) onCommit(clamp(parsed, min, max));
    else setText(fmt(value, true, hours));
  };

  const nudge = (delta: number) => onCommit(clamp(Number((value + delta).toFixed(2)), min, max));

  return (
    <div className="ct-field">
      <label className="ct-field-label" htmlFor={`ct-tc-${label}`}>
        {label}
      </label>
      <div className="ct-field-row">
        <button
          type="button"
          className="ct-icon-btn"
          onClick={() => nudge(-step)}
          aria-label={`Move ${label.toLowerCase()} back ${step} second${step === 1 ? '' : 's'}`}
        >
          <ChevronLeft size={16} />
        </button>
        <input
          id={`ct-tc-${label}`}
          className="ct-field-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(step);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(-step);
            }
          }}
        />
        <button
          type="button"
          className="ct-icon-btn"
          onClick={() => nudge(step)}
          aria-label={`Move ${label.toLowerCase()} forward ${step} second${step === 1 ? '' : 's'}`}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <button type="button" className="ct-linkish" onClick={onUsePlayhead}>
        Use playhead <kbd>{shortcut}</kbd>
      </button>
    </div>
  );
}

// ─── Slider ──────────────────────────────────────────────────────────────────
function TrimRangeSliderImpl({
  duration,
  start,
  end,
  isPlaying,
  maxClipSeconds,
  onRangeChange,
  onSeek,
  onPlayPause,
  onReset,
}: TrimRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLElement>(null);

  const [fine, setFine] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [view, setView] = useState({ a: 0, b: Math.max(duration, 1) });
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const width = useElementWidth(trackRef);

  const safeDuration = Math.max(duration, 1);
  const a = zoom ? view.a : 0;
  const b = zoom ? view.b : safeDuration;
  const span = Math.max(b - a, 0.001);
  const hours = duration >= 3600;
  const snap = fine ? 0.1 : span <= 30 ? 0.1 : span <= 180 ? 0.5 : 1;
  const nudgeStep = fine ? 0.1 : 1;

  // Always-fresh values for pointer handlers (so listeners never go stale).
  const latest = useRef({ start, end, a, b, span, duration: safeDuration, snap });
  latest.current = { start, end, a, b, span, duration: safeDuration, snap };
  const onRangeRef = useRef(onRangeChange);
  onRangeRef.current = onRangeChange;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const dragRef = useRef<DragKind | null>(null);
  const pending = useRef<{ kind: DragKind; t: number } | null>(null);
  const raf = useRef<number | null>(null);

  // New video → leave zoom.
  useEffect(() => {
    setZoom(false);
    setView({ a: 0, b: Math.max(duration, 1) });
  }, [duration]);

  const fitView = useCallback(() => {
    const len = Math.max(end - start, 1);
    const pad = Math.max(3, len * 0.5);
    let na = Math.max(0, start - pad);
    let nb = Math.min(safeDuration, end + pad);
    if (nb - na < 5) {
      na = Math.max(0, (na + nb) / 2 - 2.5);
      nb = Math.min(safeDuration, na + 5);
    }
    setView({ a: na, b: nb });
  }, [start, end, safeDuration]);

  // While zoomed, follow the selection if it leaves the visible window (not while dragging).
  useEffect(() => {
    if (zoom && !dragging && (start < view.a - 0.01 || end > view.b + 0.01)) fitView();
  }, [zoom, dragging, start, end, view.a, view.b, fitView]);

  const toggleZoom = () => {
    if (zoom) {
      setZoom(false);
    } else {
      fitView();
      setZoom(true);
    }
  };

  // ─ Playhead: updated straight in the DOM, no React render per frame ─
  usePlayhead((t) => {
    const L = latest.current;
    const el = playheadRef.current;
    if (el) {
      const pct = ((t - L.a) / L.span) * 100;
      if (pct < 0 || pct > 100) {
        el.style.opacity = '0';
      } else {
        el.style.opacity = '1';
        el.style.left = `${pct}%`;
      }
    }
    if (nowRef.current) nowRef.current.textContent = fmt(t, true, L.duration >= 3600);
  });
  useEffect(() => {
    // Re-place the playhead when the visible window changes.
    const t = playhead.get();
    const el = playheadRef.current;
    if (el) {
      const pct = ((t - a) / span) * 100;
      el.style.opacity = pct < 0 || pct > 100 ? '0' : '1';
      el.style.left = `${clamp(pct, 0, 100)}%`;
    }
  }, [a, span]);

  // ─ Pointer helpers ─
  const timeFromX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const L = latest.current;
    const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    const raw = L.a + ratio * (L.b - L.a);
    const snapped = Math.round(raw / L.snap) * L.snap;
    return clamp(Number(snapped.toFixed(2)), 0, L.duration);
  };

  const flush = useCallback((final: boolean) => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const L = latest.current;
    if (p.kind === 'scrub') {
      onSeekRef.current(p.t, final);
    } else if (p.kind === 'start') {
      onRangeRef.current(clamp(p.t, 0, L.end - MIN_GAP), L.end, final, 'start');
    } else {
      onRangeRef.current(L.start, clamp(p.t, L.start + MIN_GAP, L.duration), final, 'end');
    }
  }, []);

  // At most one update per animation frame while dragging.
  const schedule = () => {
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      flush(false);
    });
  };

  const finish = (kind: DragKind, clientX: number | null) => {
    if (dragRef.current !== kind) return;
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    const L = latest.current;
    if (clientX !== null) {
      pending.current = { kind, t: timeFromX(clientX) };
    } else if (!pending.current) {
      pending.current = { kind, t: kind === 'start' ? L.start : kind === 'end' ? L.end : playhead.get() };
    }
    flush(true);
    dragRef.current = null;
    setDragging(null);
  };

  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    []
  );

  const isPrimary = (e: ReactPointerEvent<HTMLElement>) => e.pointerType !== 'mouse' || e.button === 0;

  const handleProps = (side: Side) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isPrimary(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = side;
      setDragging(side);
      e.currentTarget.focus({ preventScroll: true });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current !== side) return;
      pending.current = { kind: side, t: timeFromX(e.clientX) };
      schedule();
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => finish(side, e.clientX),
    onPointerCancel: () => finish(side, null),
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      let delta = 0;
      const step = e.shiftKey ? 0.1 : nudgeStep;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      const L = latest.current;
      if (side === 'start') {
        onRangeRef.current(clamp(Number((L.start + delta).toFixed(2)), 0, L.end - MIN_GAP), L.end, true, 'start');
      } else {
        onRangeRef.current(L.start, clamp(Number((L.end + delta).toFixed(2)), L.start + MIN_GAP, L.duration), true, 'end');
      }
    },
  });

  const trackProps = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isPrimary(e)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = 'scrub';
      setDragging('scrub');
      const t = timeFromX(e.clientX);
      onSeekRef.current(t, false);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current !== 'scrub') return;
      pending.current = { kind: 'scrub' as const, t: timeFromX(e.clientX) };
      schedule();
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => finish('scrub', e.clientX),
    onPointerCancel: () => finish('scrub', null),
  };

  // ─ Derived layout ─
  const pct = (t: number) => clamp(((t - a) / span) * 100, 0, 100);
  const startPct = pct(start);
  const endPct = pct(end);
  const len = Math.max(0, end - start);
  const tooLong = len > maxClipSeconds;

  const ticks = useMemo(() => {
    const target = Math.max(3, Math.floor(width / 92));
    const step = niceStep(span, target);
    const out: number[] = [];
    for (let t = Math.ceil(a / step) * step; t <= b + 1e-6 && out.length < 60; t += step) out.push(t);
    return out;
  }, [a, b, span, width]);

  return (
    <section className="ct-bench" aria-label="Trim range">
      <div className="ct-bench-head">
        <div className="ct-tools">
          <button type="button" className="ct-tool" aria-pressed={zoom} onClick={toggleZoom} disabled={duration <= 0}>
            {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
            {zoom ? 'Show full video' : 'Zoom to selection'}
          </button>
          {zoom && (
            <button type="button" className="ct-tool" onClick={fitView}>
              Re-fit
            </button>
          )}
          <button type="button" className="ct-tool" aria-pressed={fine} onClick={() => setFine((f) => !f)}>
            Fine steps (0.1s)
          </button>
          <button type="button" className="ct-tool" onClick={onReset}>
            <RotateCcw size={14} />
            Reset
          </button>
        </div>
        <div className="ct-bench-right">
          <span className="ct-now">
            Playhead <strong ref={nowRef}>00:00.0</strong>
          </span>
          <button type="button" className="ct-btn ct-btn-sm" onClick={onPlayPause}>
            {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            {isPlaying ? 'Pause' : 'Preview clip'}
          </button>
        </div>
      </div>

      <div className="ct-trackwrap">
        <div
          ref={trackRef}
          className={`ct-track${dragging ? ' is-dragging' : ''}`}
          {...trackProps}
          role="group"
          aria-label="Timeline. Click or drag to move the playhead."
        >
          <div className="ct-track-clip">
            <div className="ct-shade" style={{ left: 0, width: `${startPct}%` }} />
            <div className="ct-shade" style={{ left: `${endPct}%`, right: 0 }} />
            <div className="ct-region" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
            <div className="ct-ruler" aria-hidden="true">
              {ticks.map((t) => {
                const p = ((t - a) / span) * 100;
                return (
                  <span key={t} className="ct-tick" style={{ left: `${p}%` }}>
                    {p > 4 && p < 96 ? <span>{fmt(t, false, b >= 3600)}</span> : null}
                  </span>
                );
              })}
            </div>
          </div>

          <div
            className="ct-handle"
            data-side="start"
            data-active={dragging === 'start'}
            role="slider"
            tabIndex={0}
            aria-label="Clip start"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, end - MIN_GAP)}
            aria-valuenow={start}
            aria-valuetext={fmt(start, true, hours)}
            style={{ left: `${startPct}%` }}
            {...handleProps('start')}
          >
            <i />
            <span className="ct-bubble">{fmt(start, true, hours)}</span>
          </div>

          <div
            className="ct-handle"
            data-side="end"
            data-active={dragging === 'end'}
            role="slider"
            tabIndex={0}
            aria-label="Clip end"
            aria-valuemin={start + MIN_GAP}
            aria-valuemax={safeDuration}
            aria-valuenow={end}
            aria-valuetext={fmt(end, true, hours)}
            style={{ left: `${endPct}%` }}
            {...handleProps('end')}
          >
            <i />
            <span className="ct-bubble">{fmt(end, true, hours)}</span>
          </div>

          <div ref={playheadRef} className="ct-playhead" aria-hidden="true" />
        </div>
      </div>

      <div className="ct-tc">
        <TimeField
          label="In"
          value={start}
          min={0}
          max={Math.max(0, end - MIN_GAP)}
          step={nudgeStep}
          hours={hours}
          shortcut="I"
          onCommit={(v) => onRangeChange(v, end, true, 'start')}
          onUsePlayhead={() => onRangeChange(playhead.get(), end, true, 'start')}
        />
        <div className={`ct-len${tooLong ? ' is-over' : ''}`}>
          <span>Clip length</span>
          <strong>{fmt(len, true, hours)}</strong>
          {tooLong && <em>Limit is {fmt(maxClipSeconds, false, false)}</em>}
        </div>
        <TimeField
          label="Out"
          value={end}
          min={start + MIN_GAP}
          max={safeDuration}
          step={nudgeStep}
          hours={hours}
          shortcut="O"
          onCommit={(v) => onRangeChange(start, v, true, 'end')}
          onUsePlayhead={() => onRangeChange(start, playhead.get(), true, 'end')}
        />
      </div>

      <p className="ct-hint">
        Drag the brackets to trim and click the timeline to move the playhead. <kbd>Space</kbd> previews the clip.
      </p>
    </section>
  );
}

export default memo(TrimRangeSliderImpl);
