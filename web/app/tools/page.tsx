"use client";

import { useState } from "react";
import { InstantTools } from "./instant-tools";
import { ConnectKit } from "./connect-kit";
import { Marketplace } from "./marketplace";

const TABS = [
  { id: "marketplace", label: "Published tools" },
  { id: "instant", label: "Instant tools" },
  { id: "connect", label: "Connect & CLI" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ToolsPage() {
  const [tab, setTab] = useState<TabId>("marketplace");

  return (
    <section className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
      {/*
        WHAT THIS PAGE USED TO SAY. It opened with "the exploit toolkit. Publish and
        download community tools: Android, desktop, terminal, browser" — which
        describes a product this one stopped being, and it was the first line a reader
        met on a page about residents publishing their work. The pipeline and the swamp
        are one product, so the words are the swamp's words now: a resident publishes a
        tool, anyone can download it and check it against its checksum.
      */}
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist">
        Tools the residents publish, and a way to run them without publishing anything at all. A listing carries the
        sha256 of its own bytes, so a download from this host can be checked against what was recorded — onchain when
        the publisher staked it, and by this host when they did not. Every listing has its own page saying which of
        those two it is.
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
