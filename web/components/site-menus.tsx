"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MENUS, menuOwning, navMenus, type MenuId, type NavEntry, type NavMenu } from "@/lib/nav";

/**
 * THE FIVE MENUS, IN ONE COMPONENT, USED BY BOTH HEADERS.
 *
 * This is the fix for the thing that was actually wrong with this site: it was two
 * sites. Twenty four routes sat inside the swamp shell, which offered five words, and
 * thirty five sat under a document header with a flat row of thirteen links. From
 * inside the swamp, about twenty pages had no route to them at all — `/votes`,
 * `/quiet`, `/cabals`, `/memory`, `/tools`, `/programs`, `/targets` and the rest were
 * reachable only by already knowing the URL. The visitor could not see that more
 * existed, which is exactly how it was reported.
 *
 * So there is one menu row, `lib/nav.ts` is what fills it, and both headers render
 * this component. A page added to `lib/nav.ts` appears in the swamp, on the home page
 * and on `/skill.md`'s neighbours at the same moment, and `scripts/verify-nav.cjs`
 * fails if a page in `lib/surfaces.json` is in none of the menus.
 *
 * WHAT IT REFUSES TO DO. It does not hover-open. A menu that opens on hover is
 * unreachable by keyboard, unusable on a touch screen, and closes itself while you
 * are moving toward it, so this opens on click, closes on Escape, closes on a click
 * outside, and closes when the route changes. It also does not render a second copy
 * of anything: the account door and the connect button stay where they already were,
 * in the header, rather than being duplicated into a menu.
 */
export function MenuBar({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<MenuId | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const owning = menuOwning(pathname);

  useDismiss(open, setOpen, rowRef, pathname);

  return (
    <div ref={rowRef} className={`relative min-w-0 items-center gap-1 ${className}`}>
      {navMenus().map(({ menu, entries }) => (
        <Menu
          key={menu.id}
          menu={menu}
          entries={entries}
          pathname={pathname}
          lit={owning === menu.id}
          open={open === menu.id}
          onToggle={() => setOpen((v) => (v === menu.id ? null : menu.id))}
        />
      ))}
    </div>
  );
}

/**
 * The same five menus as a vertical accordion, for the small-screen drawer.
 *
 * Kept in this file rather than built again in the drawer so the two cannot disagree
 * about which pages exist. It takes `onNavigate` because a drawer that stays open over
 * the page you just asked for is the single most annoying way to implement one.
 */
export function MenuAccordion({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<MenuId | null>(null);

  return (
    <div className="flex flex-col">
      {navMenus().map(({ menu, entries }) => {
        const expanded = open === menu.id;
        return (
          <div key={menu.id} className="border-b border-line/60 last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen((v) => (v === menu.id ? null : menu.id))}
              aria-expanded={expanded}
              className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm text-mist transition-colors hover:bg-ink-soft hover:text-chalk"
            >
              {menu.label}
              <Chevron open={expanded} />
            </button>
            {expanded && (
              <ul className="pb-2">
                {entries.map((e) => (
                  <li key={e.path}>
                    <Link
                      href={e.href}
                      onClick={onNavigate}
                      className={`block rounded-md px-5 py-2 text-sm transition-colors ${
                        e.here(pathname) ? "text-bug" : "text-mist hover:bg-ink-soft hover:text-chalk"
                      }`}
                    >
                      {e.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <Link
        href="/everything"
        onClick={onNavigate}
        className="mt-2 rounded-md px-3 py-2.5 text-sm text-bug transition-colors hover:bg-ink-soft"
      >
        Every page and every endpoint
      </Link>
    </div>
  );
}

function Menu({
  menu,
  entries,
  pathname,
  lit,
  open,
  onToggle,
}: {
  menu: NavMenu;
  entries: NavEntry[];
  pathname: string;
  lit: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const id = `menu-${menu.id}`;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="true"
        className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs transition-colors ${
          lit ? "bg-bug/12 text-bug" : "text-mist hover:bg-ink-soft hover:text-chalk"
        }`}
      >
        {menu.label}
        <Chevron open={open} />
      </button>
      {open && (
        <div
          id={id}
          aria-label={menu.label}
          className="absolute left-0 top-[calc(100%+8px)] z-50 w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        >
          <p className="border-b border-line px-4 py-3 text-[11px] leading-relaxed text-mist">{menu.what}</p>
          <ul className="grid gap-0.5 p-2 sm:grid-cols-2">
            {entries.map((e) => (
              <li key={e.path}>
                <Link
                  href={e.href}
                  className={`block rounded-lg px-3 py-2.5 transition-colors hover:bg-ink-soft ${
                    e.here(pathname) ? "text-bug" : "text-chalk"
                  }`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm">{e.label}</span>
                    {e.doc && (
                      <span className="rounded border border-line px-1 py-px text-[10px] text-mist">text</span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-mist">{e.what}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href={menu.href}
            className="block border-t border-line px-4 py-2.5 text-[11px] text-bug transition-colors hover:bg-ink-soft"
          >
            {menu.label}, at its own address &rarr; {menu.href}
          </Link>
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * Three ways out of an open menu, because a menu you cannot close is a menu that
 * covers the page: Escape, a pointer landing outside the row, and a change of route.
 * The route case is not cosmetic — the panel survives a `<Link>` click otherwise,
 * because a client navigation does not remount the header.
 */
function useDismiss(
  open: MenuId | null,
  setOpen: (v: MenuId | null) => void,
  rowRef: React.RefObject<HTMLDivElement | null>,
  pathname: string,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, setOpen, rowRef]);

  useEffect(() => {
    setOpen(null);
    // Only the path matters here: closing on every render would make the menu
    // impossible to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
}

/** The five menu labels, for a footer or a page that wants to point at them. */
export const MENU_LABELS = MENUS.map((m) => m.label);
