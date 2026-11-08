import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';
import { formatTime, parseTime, clamp } from '../utils';

interface ControlsCardProps {
  startSeconds: number;
  endSeconds: number;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  onStartChange: (v: number) => void;
  onEndChange: (v: number) => void;
  onPlayPause: () => void;
}

function TimeInput({
  label,
  value,
  duration,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  duration: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const needsHours = duration >= 3600 || value >= 3600;
  const [localText, setLocalText] = useState(formatTime(value, needsHours));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setLocalText(formatTime(value, needsHours));
    }
  }, [value, isFocused, needsHours]);

  const nudge = (delta: number) => {
    const next = clamp(Math.round(value + delta), min, max);
    onChange(next);
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseTime(localText);
    if (!isNaN(parsed)) {
      onChange(clamp(parsed, min, max));
    } else {
      setLocalText(formatTime(value, needsHours));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      nudge(1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      nudge(-1);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-[11px] font-medium text-stone-400 tracking-wide uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => nudge(-1)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-stone-400 hover:text-white hover:bg-[#1a1714] transition-colors"
          aria-label={`Decrease ${label} by 1 second`}
          title="-1s"
        >
          <ChevronLeft size={16} />
        </button>

        <input
          type="text"
          value={localText}
          onFocus={() => setIsFocused(true)}
          onChange={(e) => setLocalText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className={`${
            needsHours ? 'w-20' : 'w-16'
          } text-center bg-[#181512] border border-[#3e3831] rounded-lg px-2 py-1 text-xs sm:text-sm font-mono font-medium text-white focus:outline-none focus:border-accent transition-all`}
          aria-label={`${label} time`}
          placeholder={needsHours ? '00:00:00' : '00:00'}
        />

        <button
          onClick={() => nudge(1)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-stone-400 hover:text-white hover:bg-[#1a1714] transition-colors"
          aria-label={`Increase ${label} by 1 second`}
          title="+1s"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export default function ControlsCard({
  startSeconds,
  endSeconds,
  duration,
  isPlaying,
  onStartChange,
  onEndChange,
  onPlayPause,
}: ControlsCardProps) {
  return (
    <div className="bg-[#26231f] border border-[#3a3530] rounded-2xl px-6 py-3.5 shadow-sm">
      <div className="flex items-center justify-between max-w-md mx-auto">
        {/* Start */}
        <TimeInput
          label="Start"
          value={startSeconds}
          duration={duration}
          onChange={onStartChange}
          min={0}
          max={Math.max(0, endSeconds - 1)}
        />

        {/* Play/Pause button */}
        <button
          onClick={onPlayPause}
          className="w-12 h-12 rounded-full bg-accent hover:bg-accent-dark text-[#15110e] flex items-center justify-center transition-all shadow-[0_0_16px_rgba(16,185,129,0.35)] hover:scale-105 active:scale-95 shrink-0 mx-4"
          aria-label={isPlaying ? 'Pause range preview' : 'Play selected range'}
          title={isPlaying ? 'Pause range preview' : 'Play selected range'}
        >
          {isPlaying ? (
            <Pause size={20} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={20} fill="currentColor" strokeWidth={0} className="ml-0.5" />
          )}
        </button>

        {/* End */}
        <TimeInput
          label="End"
          value={endSeconds}
          duration={duration}
          onChange={onEndChange}
          min={startSeconds + 1}
          max={Math.floor(duration) || 9999}
        />
      </div>
    </div>
  );
}
