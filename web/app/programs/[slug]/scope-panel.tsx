"use client";

import { useMemo } from "react";
import { keccak256, toBytes } from "viem";
import Link from "next/link";
import { Copyable } from "@/components/ui";

/**
 * Independent verification of the scope hash.
 *
 * `scopeHash` is the one onchain value a hunter can check without trusting anyone:
 * it authorises the work (a program without a recorded scope can't go live, which
 * is what keeps this from coordinating unauthorised access), and it pins the exact
 * rules the program will be judged against.
 *
 * So this recomputes it from the published text, in the browser, and says whether
 * it matches. If it doesn't, that is worth knowing loudly: either the scope was
 * edited after the contract recorded it, or someone is being shown different text
 * than the program committed to.
 */
export function ScopeHashPanel({ text, scopeHash }: { text: string; scopeHash: string }) {
  const computed = useMemo(() => {
    try {
      return keccak256(toBytes(text));
    } catch {
      return null;
    }
  }, [text]);

  const matches = computed?.toLowerCase() === scopeHash.toLowerCase();

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-chalk">Scope &amp; rules</h2>
        <span
          className={`rounded border px-2 py-0.5 text-[11px] ${
            matches ? "border-bug-dim text-bug" : "border-red-500/40 text-red-400"
          }`}
          title={
            matches
              ? "The text below hashes to the scopeHash recorded on chain."
              : "The text below does NOT hash to the onchain scopeHash."
          }
        >
          {matches ? "scope hash verified" : "scope hash mismatch"}
        </span>
      </div>

      <div className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-ink-soft p-4 font-mono text-xs leading-relaxed text-mist-bright">
        {text}
      </div>

      <div className="mt-2 space-y-1 text-[11px]">
        <div className="text-mist">
          on chain:{" "}
          <span className="font-mono break-all text-chalk">{scopeHash}</span>
        </div>
        {!matches && computed && (
          <div className="text-red-400">
            this page: <span className="font-mono break-all">{computed}</span>
            <p className="mt-1 text-mist">
              The published scope doesn&apos;t match what the program committed to, which means the rules you&apos;re
              reading may not be the rules you&apos;d be judged by. Ask the owner before you test anything.
            </p>
          </div>
        )}
        <div className="text-mist">
          Hash it yourself with the{" "}
          <Link href="/tools" className="text-bug underline underline-offset-4">
            scope hasher
          </Link>
          , or with <span className="font-mono">cast keccak</span>. Nothing here needs to be taken on trust.
        </div>
      </div>
    </section>
  );
}
