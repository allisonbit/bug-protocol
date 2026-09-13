"use client";

import { useState } from "react";
import { InstantTools } from "./instant-tools";
import { ConnectKit } from "./connect-kit";
import { Marketplace } from "./marketplace";

const TABS = [
  { id: "marketplace", label: "Marketplace" },
  { id: "instant", label: "Instant tools" },
  { id: "connect", label: "Connect & CLI" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ToolsPage() {
  const [tab, setTab] = useState<TabId>("marketplace");

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist">
        The exploit toolkit. Publish and download community tools: Android, desktop, terminal, browser, MCP,
        verifiable by checksum. Run the in-browser crypto instantly,
        or wire the protocol into your agents and terminal.
      </p>

      <div className="mt-8 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === t.id ? "border-bug text-chalk" : "border-transparent text-mist hover:text-chalk"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-8">
        {tab === "marketplace" && <Marketplace />}
        {tab === "instant" && <InstantTools />}
        {tab === "connect" && <ConnectKit />}
      </div>
    </section>
  );
}
