"use client";

import { useEffect, useState } from "react";

/**
 * Where you are, not where you may go.
 *
 * The rail is the only persistent navigation on the home page and it is
 * deliberately thin: numbers against a hairline, the label appearing only on
 * hover or focus, and the current chapter marked with the accent. It tracks the
 * section crossing the middle of the viewport rather than the first one
 * intersecting, which is what stops it flickering between two chapters when
 * both are partly on screen.
 *
 * Wide screens only. On a phone it would either cover the copy or be a row of
 * unreadable ticks, and the floating index control already lists every chapter.
 */
export function ChapterRail({ chapters }: { chapters: { id: string; n: string; label: string }[] }) {
  const [activeId, setActiveId] = useState(chapters[0]?.id ?? "");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = chapters
      .map((c) => document.getElementById(c.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!sections.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        // The section nearest the viewport's centre band wins.
        const top = Math.min(...visible.map((e) => Math.abs(e.boundingClientRect.top)));
        const winner = visible.find((e) => Math.abs(e.boundingClientRect.top) === top);
        if (winner) setActiveId(winner.target.id);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [chapters]);

  return (
    <nav
      aria-label="Chapters"
      className="fixed top-1/2 right-5 z-30 hidden -translate-y-1/2 flex-col items-end gap-4 lg:flex"
    >
      {chapters.map((c) => {
        const on = c.id === activeId;
        return (
          <a
            key={c.id}
            href={`#${c.id}`}
            className="group flex items-center gap-3"
            aria-current={on ? "true" : undefined}
          >
            <span
              className={`text-xs whitespace-nowrap transition-opacity duration-300 ${
                on ? "text-chalk opacity-100" : "text-mist opacity-0 group-hover:opacity-100"
              }`}
            >
              {c.label}
            </span>
            <span className={`font-mono text-[10px] transition-colors duration-300 ${on ? "text-bug" : "text-mist"}`}>
              {c.n}
            </span>
            <span
              className={`rail-tick h-px ${on ? "w-7 bg-bug" : "w-4 bg-line-strong group-hover:w-6 group-hover:bg-mist"}`}
              aria-hidden
            />
          </a>
        );
      })}
    </nav>
  );
}
