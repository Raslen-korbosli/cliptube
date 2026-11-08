import { useEffect, useRef } from 'react';

/**
 * Tiny external store for the player's current time.
 *
 * The playhead moves ~60 times a second. Keeping it in React state re-rendered
 * the whole page on every frame, which is what made the trim slider feel heavy.
 * Here, subscribers update their own DOM nodes directly and React never re-renders.
 */
type Listener = (t: number) => void;

const listeners = new Set<Listener>();
let current = 0;

export const playhead = {
  get: (): number => current,
  set(t: number): void {
    if (t === current) return;
    current = t;
    listeners.forEach((l) => l(t));
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Call `cb` with the current time now and on every change (no re-render involved). */
export function usePlayhead(cb: (t: number) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const unsubscribe = playhead.subscribe((t) => ref.current(t));
    ref.current(playhead.get());
    return unsubscribe;
  }, []);
}
