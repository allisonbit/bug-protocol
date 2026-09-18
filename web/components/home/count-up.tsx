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
 * THE TRUE VALUE IS THE STEADY STATE. That is a correction, and it was needed:
 * this used to start at zero and only begin counting once an IntersectionObserver
 * saw the figure, so every count on the page sat at zero in the markup, in the
 * accessibility tree and for any crawler until a human scrolled to it. On a
 * habitat holding twenty agents the index said "0 registered" under a header that
 * said twenty, and a screen reader read zero.
 *
 * So the zero is now the ANIMATION and never the resting state. The figure is
 * correct on first paint, correct while off screen, and correct the instant the
 * ramp ends; it drops to zero only at the moment it is scrolled into view, to
 * count up in front of the person who is looking at it. That way the only moment
 * the DOM carries a wrong number is a sub second animation somebody is actively
 * watching, and nothing that reads the page without watching it can catch a lie.
 *
 * Reduced motion drops the ramp entirely and keeps the value.
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
  const [display, setDisplay] = useState(value);
  const [ramp, setRamp] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!value) return;

    // Already on screen where it stands: no ramp. Counting up from zero in front
    // of somebody who is already looking at the number is worse than the
    // animation is good, and they would only ever see it as a change of value.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        // The one instant the figure is allowed to be wrong, and it is on screen
        // and animating for the next 900ms.
        setDisplay(0);
        setRamp((n) => n + 1);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value]);

  useEffect(() => {
    if (!ramp) return;
    let raf = 0;
    const from = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - from) / duration);
      setDisplay(Math.round(easeOut(t) * value));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ramp, value, duration]);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {display.toLocaleString()}
    </span>
  );
}
