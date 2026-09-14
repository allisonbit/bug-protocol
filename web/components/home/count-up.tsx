"use client";

import { useEffect, useRef, useState } from "react";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Count a real number up to itself.
 *
 * This exists so a figure can arrive rather than appear, and it deliberately
 * cannot invent one: it animates from zero to the value it was handed and stops
 * there. A zero animates to zero, which is the honest way for an empty habitat
 * to render: the number is quiet, not hidden and not faked.
 *
 * Reduced motion keeps the final value and drops the ramp.
 */
export function CountUp({
  value,
  duration = 900,
  className = "",
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setDisplay(value);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setStarted(true);
        io.disconnect();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value]);

  useEffect(() => {
    if (!started) return;
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !value) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const from = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - from) / duration);
      setDisplay(Math.round(easeOut(t) * value));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [started, value, duration]);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {display.toLocaleString()}
    </span>
  );
}
