"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { short } from "@/lib/format";

/**
 * The authenticated app shell: a persistent left sidebar (the "everything menu")
 * plus a scrolling content column. No hairlines anywhere. Separation comes from
 * surface fills (panel / panel-2) and the active-item pill, per the design.
 * On small screens the sidebar collapses into a horizontal pill strip.
 */

type Item = { href: string; label: string; icon: ReactNode; tag?: string; exact?: boolean };
type Group = { label: string; items: Item[] };

const groups: Group[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: <IconGrid />, exact: true },
      { href: "/dashboard/ai", label: "AI Copilot", icon: <IconSpark />, tag: "AI" },
    ],
  },
  {
    label: "Swamp",
    items: [
      { href: "/dashboard/swamp", label: "Live swamp", icon: <IconActivity />, tag: "LIVE" },
      { href: "/dashboard/agents", label: "My agents", icon: <IconNodes /> },
      { href: "/feed", label: "Feed", icon: <IconStream /> },
    ],
  },
  {
    label: "Hunt & build",
    items: [
      { href: "/programs", label: "Browse programs", icon: <IconTarget /> },
      { href: "/programs/new", label: "Start a program", icon: <IconPlus /> },
      { href: "/hunters", label: "Hunters", icon: <IconTrophy /> },
    ],
  },
  {
    // The arbiter is its own role, so it gets its own heading rather than being
    // filed under hunting. The page is deliberately open (the real permission is
    // `onlyArbiter` in the contract, which no web page can grant), so this is a
    // link for the person who holds the role, not a gate for anyone else.
    label: "Resolve",
    items: [{ href: "/arbiter", label: "Arbitration", icon: <IconScale /> }],
  },
  {
    label: "Connect",
    items: [
      { href: "/dashboard/connect", label: "Connect an agent", icon: <IconPlug /> },
      { href: "/tools", label: "Agent tools", icon: <IconTerminal /> },
    ],
  },
  {
    label: "Account",
    items: [{ href: "/settings", label: "Settings", icon: <IconGear /> }],
  },
];

const flat = groups.flatMap((g) => g.items);

/**
 * Who you're signed in as, and the way out. The sidebar is the "everything menu",
 * so logging out belongs here as much as in the header. A session ends the same
 * way from anywhere.
 */
function AccountBlock() {
  const { user, profile, signOut } = useAuth();
  const router = useRouter();
  if (!user) return null;

  const walletAddress = /^(0x[0-9a-fA-F]{40})@wallet\.invalid$/i.exec(user.email ?? "")?.[1] ?? null;
  const name = profile?.display_name || (walletAddress ? short(walletAddress) : user.email?.split("@")[0]) || "account";
  const sub = walletAddress ? `${short(walletAddress)}, wallet account` : user.email;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="px-3">
        <div className="truncate text-sm text-chalk">{name}</div>
        <div className="truncate text-[11px] text-mist">{sub}</div>
      </div>
      <button
        onClick={async () => {
          await signOut();
          router.push("/");
          router.refresh();
        }}
        className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-mist transition-colors hover:bg-panel-2/60 hover:text-chalk"
      >
        Sign out
      </button>
    </div>
  );
}

function isActive(pathname: string, item: Item): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="mx-auto flex w-full max-w-7xl">
      {/* Sidebar: desktop */}
      <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto px-3 py-6 md:block">
        <nav className="space-y-6">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-3 text-[10px] font-medium tracking-widest text-mist uppercase">{g.label}</div>
              <ul className="mt-2 space-y-0.5">
                {g.items.map((it) => {
                  const active = isActive(pathname, it);
                  return (
                    <li key={it.href}>
                      <Link
                        href={it.href}
                        className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          active ? "bg-panel-2 text-chalk" : "text-mist hover:bg-panel-2/60 hover:text-chalk"
                        }`}
                      >
                        <span className={active ? "text-bug" : "text-mist group-hover:text-chalk"}>{it.icon}</span>
                        <span className="flex-1">{it.label}</span>
                        {it.tag && (
                          <span className="rounded bg-lime px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-graphite">
                            {it.tag}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <AccountBlock />
      </aside>

      {/* Content column */}
      <div className="min-w-0 flex-1">
        {/* Mobile nav: horizontal pills */}
        <div className="flex gap-2 overflow-x-auto px-4 py-3 md:hidden">
          {flat.map((it) => {
            const active = isActive(pathname, it);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors ${
                  active ? "bg-lime text-graphite" : "bg-panel-2 text-mist"
                }`}
              >
                {it.label}
              </Link>
            );
          })}
          <MobileSignOut />
        </div>
        <div className="px-5 py-6 sm:px-8 sm:py-8">{children}</div>
      </div>
    </div>
  );
}

/** Sign-out as a pill at the end of the mobile strip. */
function MobileSignOut() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  if (!user) return null;
  return (
    <button
      onClick={async () => {
        await signOut();
        router.push("/");
        router.refresh();
      }}
      className="shrink-0 rounded-full px-3 py-1.5 text-xs text-mist transition-colors hover:text-chalk"
    >
      Sign out
    </button>
  );
}

/* 16px line icons, inherit currentColor */
function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function IconSpark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3l1.9 5.6L19 10l-5.1 1.4L12 17l-1.9-5.6L5 10l5.1-1.4z" />
    </svg>
  );
}
function IconTarget() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h10v4a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3M9 20h6M12 13v4" />
    </svg>
  );
}
function IconNodes() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <circle cx="12" cy="17" r="2.5" />
      <path d="M8 7l2 8M16 9l-3 6M8 6.5h7.5" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7l4 4-4 4M12 17h7" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L16.5 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.5 2.5h4l.5-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z" />
    </svg>
  );
}
function IconActivity() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />
    </svg>
  );
}
function IconStream() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="18" r="2" />
      <path d="M4 5a15 15 0 0 1 15 15M4 11a9 9 0 0 1 9 9" />
    </svg>
  );
}
function IconPlug() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" />
    </svg>
  );
}
function IconScale() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v16M7 20h10M6 7h12M6 7l-3 5a3 3 0 0 0 6 0zM18 7l3 5a3 3 0 0 1-6 0z" />
    </svg>
  );
}
