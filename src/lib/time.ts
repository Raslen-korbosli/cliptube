/** Smallest allowed clip length in seconds (keeps the in and out brackets from touching). */
export const MIN_GAP = 0.2;

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** Format seconds as 00:12.4 (tenths) or 00:12, adding hours when needed. */
export function fmt(t: number, tenths = false, forceHours = false): string {
  const safe = Number.isFinite(t) && t > 0 ? t : 0;
  const total = tenths ? Math.round(safe * 10) / 10 : Math.floor(safe);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sStr = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return h > 0 || forceHours ? `${h}:${mm}:${sStr}` : `${mm}:${sStr}`;
}

/**
 * Parse what a person might type: "83", "1:23", "1:23.5", "1:02:03", "1m23s", "90s".
 * Returns NaN when the text can't be understood.
 */
export function parse(text: string): number {
  const s = text.trim().toLowerCase();
  if (!s) return NaN;

  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length > 3) return NaN;
    const nums = parts.map((p) => (p === '' ? 0 : Number(p)));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
  }

  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return NaN;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** Pick a "round" tick spacing so the ruler shows roughly `target` labels. */
export function niceStep(span: number, target: number): number {
  for (const s of STEPS) if (span / s <= target) return s;
  return STEPS[STEPS.length - 1];
}
