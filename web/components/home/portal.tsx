"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * The one navigation control on this page.
 *
 * The brief for the home page is no header, so there is no row of buttons at the
 * top and no hamburger in a corner. What there is: a single control that names
 * itself, and a surface behind it that opens only when asked. It carries the
 * chapters (so the page can be traversed without scrolling) and the product
 * itself, with the real figures for each surface, which is what makes this read
 * as an entrance to the app rather than a menu of marketing links.
 *
 * It also owns the account action, because the header used to: `account` is
 * resolved on the server, so a signed-in reader gets their dashboard and
 * everyone else gets the sign-in door, and nobody sees both.
 */

type Surface = { href: string; label: string; note: string; count?: number | null };

export function Portal({
  chapters,
  surfaces,
  account,
  facts,
}: {
  chapters: { id: string; n: string; label: string }[];
  surfaces: Surface[];
  account: { href: string; label: string; note: string };
  facts: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(chapters[0]?.id ?? "");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  // Track the chapter behind the panel, so closing it lands the reader in the
  // right place rather than at the top.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = chapters
      .map((c) => document.getElementById(c.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!sections.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-40% 0px -40% 0px" },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [chapters]);

  // Open: lock the page, move focus into the panel. Close: unlock, hand focus
  // back to the control that opened it. Escape always closes.
  //
  // Tab is trapped inside the panel. `aria-modal` only tells a screen reader
  // that the rest of the page is inert; it does nothing to the tab order, so
  // without this a keyboard reader tabs straight out of the dialog into the
  // page behind it and has no way back except Escape.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLButtonElement>("[data-portal-close]")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const root = panel.current;
      if (!root) return;
      const stops = Array.from(
        root.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      );
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      const outside = !root.contains(active);
      // Wrap at both ends, and pull focus back in if it has escaped somehow.
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      {/* The control. Hairline, quiet, and it says what it is rather than showing
          three lines that mean "menu". While the panel is open it fades out AND
          leaves the tab order: a control you cannot see is worse than no
          control, because a keyboard reader lands on it with no way to tell
          where they are. */}
      <button
        ref={trigger}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="home-portal"
        tabIndex={open ? -1 : undefined}
        className={`fixed right-5 bottom-5 z-40 flex items-center gap-2.5 rounded-full border border-line bg-ink/70 px-4 py-2.5 text-xs text-mist shadow-card backdrop-blur-md transition-all duration-300 hover:border-line-strong hover:text-chalk sm:right-8 sm:bottom-8 ${
          open ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <span className="font-mono text-[10px] text-bug">{chapters.find((c) => c.id === activeId)?.n ?? "00"}</span>
        <span className="tracking-wide">Index</span>
      </button>

      {open && (
        <div
          id="home-portal"
          role="dialog"
          aria-modal="true"
          aria-label="Index"
          className="menu-panel fixed inset-0 z-50 bg-ink/97 backdrop-blur-xl"
        >
          <div
            className="absolute inset-0"
            onClick={close}
            aria-hidden
          />
          <div ref={panel} className="relative flex h-full flex-col">
            {/* Top hairline row: wordmark on the left, close on the right. */}
            <div className="flex items-center justify-between border-b border-line px-6 py-4 sm:px-10">
              <span className="text-xs tracking-widest text-mist uppercase">Index</span>
              <button
                data-portal-close
                onClick={close}
                className="rounded-full border border-line px-3.5 py-1.5 text-xs text-mist transition-colors hover:border-line-strong hover:text-chalk"
              >
                Close
              </button>
            </div>

            <div className="grid flex-1 gap-10 overflow-y-auto px-6 py-10 sm:px-10 lg:grid-cols-[1fr_1fr] lg:gap-16 lg:py-14">
              {/* Chapters, in the page's own order. */}
              <div>
                <div className="text-xs tracking-widest text-mist uppercase">On this page</div>
                <ol className="mt-6 space-y-1">
                  {chapters.map((c, i) => (
                    <li
                      key={c.id}
                      className="menu-item"
                      style={{ animationDelay: `${40 + i * 45}ms` }}
                    >
                      <a
                        href={`#${c.id}`}
                        onClick={close}
                        className="group flex items-baseline gap-5 border-b border-line py-3.5 transition-colors hover:border-line-strong"
                      >
                        <span className="font-mono text-[11px] text-bug">{c.n}</span>
                        <span className="font-serif text-2xl leading-none text-chalk transition-transform duration-300 group-hover:translate-x-1 sm:text-3xl">
                          {c.label}
                        </span>
                      </a>
                    </li>
                  ))}
                </ol>
              </div>

              {/* The product, with the real count for each surface. */}
              <div>
                <div className="text-xs tracking-widest text-mist uppercase">The habitat</div>
                <ul className="mt-6 grid gap-x-8 gap-y-0 sm:grid-cols-2 lg:grid-cols-1">
                  {surfaces.map((s, i) => (
                    <li
                      key={s.href + s.label}
                      className="menu-item"
                      style={{ animationDelay: `${120 + i * 35}ms` }}
                    >
                      <Link
                        href={s.href}
                        onClick={close}
                        className="flex items-baseline gap-4 border-b border-line py-3 transition-colors hover:border-line-strong"
                      >
                        <span className="w-32 shrink-0 text-sm text-chalk">{s.label}</span>
                        <span className="flex-1 text-xs leading-relaxed text-mist">{s.note}</span>
                        {s.count != null && (
                          <span className="font-mono text-[11px] text-mist tabular-nums">{s.count}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-6 py-4 sm:px-10">
              <span className="text-xs text-mist">{facts}</span>
              <Link
                href={account.href}
                onClick={close}
                className="text-xs text-chalk underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-bug"
                title={account.note}
              >
                {account.label}
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
