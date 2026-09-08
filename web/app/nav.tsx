"use client";

import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="rounded border border-line px-3 py-1.5 text-xs text-chalk transition-colors hover:border-bug-dim"
        aria-label={`Disconnect wallet ${short(address)}`}
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

export function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ink/80 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden>🐛</span>
          <span>$BUG</span>
        </Link>
        <Link href="/programs" className="text-mist transition-colors hover:text-chalk">
          programs
        </Link>
        <Link href="/how" className="text-mist transition-colors hover:text-chalk">
          how it works
        </Link>
        <div className="ml-auto">
          <ConnectButton />
        </div>
      </nav>
    </header>
  );
}
