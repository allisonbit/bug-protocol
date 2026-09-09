"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAccount, useConnect, useChainId, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";
import { short } from "@/lib/format";
import { SUPPORTED_CHAINS, chainMeta } from "@/lib/chains";
import { WalletDrawer } from "./wallet-drawer";

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
      className="rounded border border-line bg-ink px-2 py-1.5 text-xs text-mist outline-none transition-colors hover:text-chalk focus:border-bug-dim disabled:opacity-50"
      title="switch network"
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

function ConnectButton({ onOpen }: { onOpen: () => void }) {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();

  if (isConnected && address) {
    return (
      <button
        onClick={onOpen}
        className="rounded border border-bug-dim/60 bg-bug-dim/5 px-3 py-1.5 text-xs text-bug transition-colors hover:bg-bug-dim/15"
      >
        {short(address)}
      </button>
    );
  }
  return (
    <button
      onClick={() => connect({ connector: injected() })}
      disabled={isPending}
      className="rounded border border-bug-dim bg-bug-dim/10 px-3 py-1.5 text-xs text-bug transition-colors hover:bg-bug-dim/20 disabled:opacity-50"
    >
      {isPending ? "connecting…" : "connect wallet"}
    </button>
  );
}

const links = [
  { href: "/programs", label: "programs" },
  { href: "/dashboard", label: "dashboard" },
  { href: "/tools", label: "tools" },
  { href: "/how", label: "how it works" },
];

export function Nav() {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ink/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center gap-5 px-6 py-4 text-sm">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden>🐛</span>
          <span>$BUG</span>
        </Link>
        {links.map((l) => {
          const active = pathname === l.href || pathname.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`hidden transition-colors sm:inline ${active ? "text-chalk" : "text-mist hover:text-chalk"}`}
            >
              {l.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <ChainSwitcher />
          <ConnectButton onOpen={() => setDrawer(true)} />
        </div>
      </nav>
      {drawer && <WalletDrawer onClose={() => setDrawer(false)} />}
    </header>
  );
}
