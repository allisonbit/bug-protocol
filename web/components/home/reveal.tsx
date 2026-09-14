"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Reveal a block once it is actually on screen.
 *
 * The page is long and most of it is read while scrolling, so the animation is
 * the reader's own arrival rather than a timer: nothing moves until the block
 * is a third of the way up from the bottom edge. `delay` staggers siblings by a
 * few tens of milliseconds, which is what makes a list read as one gesture
 * instead of several.
 *
 * The hidden state lives in CSS (`.reveal`), so the server-rendered HTML is
 * already in its final position for a reader whose JS never runs, and the
 * reduced-motion rule at the end of globals.css turns the transition off
 * without turning the content off.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShown(true);
        io.disconnect();
      },
      // Fire when the block has genuinely entered the page, not when its first
      // pixel appears: a block that reveals at the very edge looks like it
      // flickered rather than arrived.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${shown ? "is-in" : ""} ${className}`}
      style={shown && delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
