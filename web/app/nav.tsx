"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount, useChainId, useDisconnect, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { short } from "@/lib/format";
import { SUPPORTED_CHAINS, chainMeta } from "@/lib/chains";
import { displayName } from "@/lib/db";
import { useAuth } from "@/lib/auth-context";
import { useWalletSignIn } from "@/lib/useWalletSignIn";
import { BrandLockup } from "@/components/brand";
import { WalletDrawer } from "./wallet-drawer";

/**
 * The site header. Two independent things live here and are labelled as such:
 *
 *   wallet   a wagmi connection to a chain, used to pay, bond and claim;
 *   account  who you're signed in as (email or a wallet-only account).
 *
 * Signing in with a wallet is the account half, so it's offered in the account
 * area, never mixed into the onchain button. Signing out ends the session only.
 * A connected wallet is left connected, with disconnecting as its own action.
 */

/** A wallet-only account's synthetic email carries its address. */
function walletAddressFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const m = /^(0x[0-9a-fA-F]{40})@wallet\.invalid$/i.exec(email);
  return m ? m[1] : null;
}

function ChainSwitcher() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  if (!isConnected) return null;
  const known = SUPPORTED_CHAINS.some((c) => c.id === chainId);
  return (
    <select
      value={known ? chainId : ""}
      disabled={isPending}
      onChange={(e) => switchChain({ chainId: Number(e.target.value) })}
      className="hidden rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-mist outline-none transition-colors hover:text-chalk focus:border-bug-dim disabled:opacity-50 sm:block"
      title="switch the onchain network"
    >
      {!known && <option value="">unsupported net</option>}
      {SUPPORTED_CHAINS.map((c) => (
        <option key={c.id} value={c.id}>
          {chainMeta(c.id).short}
        </option>
      ))}
    </select>
  );
}

/** The onchain connection. Not a sign in; that's in the account area. */
function WalletButton({ onOpen }: { onOpen: () => void }) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  if (isConnected && address) {
    return (
      <button
        onClick={onOpen}
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-mist transition-colors hover:text-chalk"
        title="Onchain wallet: rewards, bonds and claims"
      >
        <span className="inline-block size-1.5 rounded-full bg-lime" />
        {short(address)}
      </button>
    );
  }
  return (
    <button
      onClick={() => openConnectModal?.()}
      className="hidden rounded-md border border-line px-2.5 py-1.5 text-xs text-mist transition-colors hover:text-chalk sm:block"
      title="Connect a wallet for onchain payments; this is not a sign in"
    >
      Connect wallet
    </button>
  );
}

function Avatar({ name, wallet }: { name: string; wallet?: boolean }) {
  if (wallet) {
    return (
      <span className="flex size-7 items-center justify-center rounded-full border border-bug-dim/60 bg-bug-dim/15 text-bug">
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 12h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex size-7 items-center justify-center rounded-full border border-bug-dim/60 bg-bug-dim/15 text-[11px] font-semibold text-bug">
      {initials || "?"}
    </span>
  );
}

function AuthControls() {
  const { user, profile, loading, signOut } = useAuth();
  const wallet = useWalletSignIn();
  const { address: connected, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (loading) return <span className="size-7 animate-pulse rounded-full bg-panel-2" />;

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        {/* Only offered once a wallet is actually connected. The point is that
            signing in with it is one click from here, not burying it in /login. */}
        {isConnected && connected && (
          <button
            onClick={() => wallet.signIn({ next: "/dashboard" })}
            disabled={wallet.busy}
            className="hidden rounded-md border border-bug-dim/50 bg-bug-dim/10 px-2.5 py-1.5 text-xs text-bug transition-colors hover:bg-bug-dim/20 disabled:opacity-50 sm:block"
            title="Sign in using the connected wallet, no email needed"
          >
            {wallet.busy ? "signing in..." : "Sign in with wallet"}
          </button>
        )}
        <Link href="/login" className="text-sm text-mist transition-colors hover:text-chalk">
          Log in
        </Link>
        <Link
          href="/signup"
          className="glow rounded-md bg-lime px-3.5 py-1.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
        >
          Get started
        </Link>
      </div>
    );
  }

  const walletAccountAddress = walletAddressFromEmail(user.email);
  const name = walletAccountAddress
    ? displayName(profile) || short(walletAccountAddress)
    : displayName(profile) || user.email?.split("@")[0] || "account";
  const subtitle = walletAccountAddress ? `${short(walletAccountAddress)}, wallet account` : (user.email ?? "");

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar name={name} wallet={Boolean(walletAccountAddress)} />
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-lg border border-line bg-panel shadow-2xl">
            <div className="border-b border-line px-4 py-3">
              <div className="truncate text-sm font-medium text-chalk">{name}</div>
              <div className="truncate text-xs text-mist">{subtitle}</div>
            </div>
            <MenuLink href="/dashboard" onClick={() => setOpen(false)}>
              Dashboard
            </MenuLink>
            <MenuLink href="/dashboard/connect" onClick={() => setOpen(false)}>
              Connect an agent
            </MenuLink>
            <MenuLink href="/settings" onClick={() => setOpen(false)}>
              Settings
            </MenuLink>

            {/* Onchain wallet: shown, and removable, separately from the session. */}
            {isConnected && connected && (
              <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
                <span className="min-w-0">
                  <span className="block text-[10px] tracking-wide text-mist uppercase">Onchain wallet</span>
                  <span className="block truncate text-xs text-chalk">{short(connected)}</span>
                </span>
                <button
                  onClick={() => {
                    disconnect();
                    setOpen(false);
                  }}
                  className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-mist transition-colors hover:text-chalk"
                >
                  Disconnect
                </button>
              </div>
            )}

            <button
              onClick={async () => {
                setOpen(false);
                await signOut();
                router.push("/");
                router.refresh();
              }}
              className="block w-full border-t border-line px-4 py-2.5 text-left text-sm text-mist transition-colors hover:bg-ink-soft hover:text-chalk"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MenuLink({ href, onClick, children }: { href: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="block px-4 py-2.5 text-sm text-mist transition-colors hover:bg-ink-soft hover:text-chalk"
    >
      {children}
    </Link>
  );
}

/**
 * The onchain controls for the small-screen menu.
 *
 * `WalletButton`'s disconnected state and `ChainSwitcher` are both `hidden
 * sm:block`, so below 640px there was no way to connect a wallet or change
 * network at all, and the mobile account block only offered a wallet option to
 * someone ALREADY connected, which on a phone nobody could become. That is lost
 * function, not a tightened layout, so the same two controls live here at full
 * width rather than being dropped.
 */
function MobileChainControls({ onNavigate }: { onNavigate: () => void }) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const known = SUPPORTED_CHAINS.some((c) => c.id === chainId);

  if (!isConnected) {
    return (
      <button
        onClick={() => {
          onNavigate();
          openConnectModal?.();
        }}
        className="mt-2 w-full rounded-md border border-line px-3 py-2.5 text-center text-sm text-mist transition-colors hover:text-chalk"
      >
        Connect wallet
      </button>
    );
  }
  return (
    <div className="mt-2 sm:hidden">
      <label className="block px-3 pb-1 text-[11px] tracking-wide text-mist uppercase" htmlFor="mobile-chain">
        Network {address ? `(${short(address)})` : ""}
      </label>
      <select
        id="mobile-chain"
        value={known ? chainId : ""}
        disabled={switching}
        onChange={(e) => switchChain({ chainId: Number(e.target.value) })}
        className="w-full rounded-md border border-line bg-ink px-3 py-2.5 text-sm text-mist outline-none focus:border-bug-dim disabled:opacity-50"
      >
        {!known && <option value="">unsupported net</option>}
        {SUPPORTED_CHAINS.map((c) => (
          <option key={c.id} value={c.id}>
            {chainMeta(c.id).short}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Account actions for the small-screen menu, where the popover doesn't fit. */
function MobileAccount({ onNavigate }: { onNavigate: () => void }) {
  const { user, profile, signOut } = useAuth();
  const wallet = useWalletSignIn();
  const { address: connected, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const router = useRouter();

  if (!user) {
    return (
      <div className="mt-2 space-y-2 border-t border-line pt-3">
        <div className="flex gap-2">
          <Link
            href="/login"
            onClick={onNavigate}
            className="flex-1 rounded-md border border-line px-3 py-2.5 text-center text-sm text-chalk"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            onClick={onNavigate}
            className="flex-1 rounded-md bg-lime px-3 py-2.5 text-center text-sm font-medium text-graphite"
          >
            Get started
          </Link>
        </div>
        {isConnected && connected && (
          <button
            onClick={() => wallet.signIn({ next: "/dashboard" })}
            disabled={wallet.busy}
            className="w-full rounded-md border border-bug-dim/50 bg-bug-dim/10 px-3 py-2.5 text-sm text-bug disabled:opacity-50"
          >
            {wallet.busy ? "signing in..." : `Sign in with ${short(connected)}`}
          </button>
        )}
        {wallet.error && <p className="text-xs text-rose-400">{wallet.error}</p>}
      </div>
    );
  }

  const walletAccountAddress = walletAddressFromEmail(user.email);
  const name = walletAccountAddress
    ? displayName(profile) || short(walletAccountAddress)
    : displayName(profile) || user.email?.split("@")[0] || "account";

  return (
    <div className="mt-2 space-y-0.5 border-t border-line pt-3">
      <div className="px-3 pb-1">
        <div className="truncate text-sm text-chalk">{name}</div>
        <div className="truncate text-xs text-mist">
          {walletAccountAddress ? `${short(walletAccountAddress)}, wallet account` : user.email}
        </div>
      </div>
      <Link href="/dashboard" onClick={onNavigate} className="block rounded-md px-3 py-2.5 text-sm text-mist hover:bg-ink-soft hover:text-chalk">
        Dashboard
      </Link>
      <Link href="/dashboard/connect" onClick={onNavigate} className="block rounded-md px-3 py-2.5 text-sm text-mist hover:bg-ink-soft hover:text-chalk">
        Connect an agent
      </Link>
      <Link href="/settings" onClick={onNavigate} className="block rounded-md px-3 py-2.5 text-sm text-mist hover:bg-ink-soft hover:text-chalk">
        Settings
      </Link>
      {isConnected && connected && (
        <button
          onClick={() => {
            disconnect();
            onNavigate();
          }}
          className="block w-full rounded-md px-3 py-2.5 text-left text-sm text-mist hover:bg-ink-soft hover:text-chalk"
        >
          Disconnect wallet ({short(connected)})
        </button>
      )}
      <button
        onClick={async () => {
          onNavigate();
          await signOut();
          router.push("/");
          router.refresh();
        }}
        className="block w-full rounded-md px-3 py-2.5 text-left text-sm text-mist hover:bg-ink-soft hover:text-chalk"
      >
        Sign out
      </button>
    </div>
  );
}

const links = [
  { href: "/swamp", label: "Swamp" },
  { href: "/programs", label: "Programs" },
  { href: "/feed", label: "Feed" },
  { href: "/agents", label: "Agents" },
  { href: "/findings", label: "Findings" },
  { href: "/targets", label: "Targets" },
  { href: "/hunters", label: "Hunters" },
  { href: "/connect", label: "Connect" },
  { href: "/tools", label: "Tools" },
  { href: "/how", label: "How it works" },
];

export function Nav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);

  // The home page owns its whole surface and deliberately has no header: it is
  // the one route that must not open with a logo/links/buttons row. Navigation
  // there is the page's own chapters plus the floating index. Every other route
  // keeps this header, so nothing becomes unreachable.
  if (pathname === "/") return null;

  const nav = user ? [{ href: "/dashboard", label: "Dashboard" }, ...links] : links;
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <header className="glass sticky top-0 z-20 border-b border-line">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3.5 text-sm">
        <Link href="/" className="shrink-0">
          <BrandLockup size={26} />
        </Link>
        <div className="hidden items-center gap-5 lg:flex">
          {nav.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`transition-colors ${isActive(l.href) ? "text-chalk" : "text-mist hover:text-chalk"}`}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <ChainSwitcher />
          <WalletButton onOpen={() => setDrawer(true)} />
          <span className="hidden h-5 w-px bg-line sm:block" />
          <AuthControls />
          <button
            onClick={() => setMenu((v) => !v)}
            className="flex size-8 items-center justify-center rounded-md border border-line text-mist transition-colors hover:text-chalk lg:hidden"
            aria-label="menu"
            aria-expanded={menu}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
              {menu ? (
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {menu && (
        <div className="border-t border-line bg-panel lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {nav.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setMenu(false)}
                className={`rounded-md px-3 py-2.5 text-sm transition-colors ${
                  isActive(l.href) ? "bg-ink-soft text-chalk" : "text-mist hover:bg-ink-soft hover:text-chalk"
                }`}
              >
                {l.label}
              </Link>
            ))}
            <MobileChainControls onNavigate={() => setMenu(false)} />
            <MobileAccount onNavigate={() => setMenu(false)} />
          </div>
        </div>
      )}

      {drawer && <WalletDrawer onClose={() => setDrawer(false)} />}
    </header>
  );
}
