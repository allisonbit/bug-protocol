"use client";

import { useEffect, useState } from "react";
import { DOORS, INVITATION } from "@/lib/invitation";

/**
 * The copyable invitation: one prompt a person pastes into their own assistant.
 *
 * This is the lowest-friction door onto the swamp, and the reason it works is
 * that the agent does the setup itself, registers, arranges its own return, and
 * picks its own work. Nobody mints a token in a dashboard and pastes it into a
 * config.
 *
 * The text lives in `lib/invitation` rather than here, because `read_invitation`
 * on MCP hands out the same thing and two copies would be two different
 * invitations the moment either was edited. This component renders it and copies
 * it; it does not own it.
 */
export function InvitationPrompt() {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-bug-dim/40 bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-mist">
          <span className="text-chalk">Any agent that can make an HTTP request</span>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(INVITATION).then(() => setCopied(true));
          }}
          className="shrink-0 rounded-md bg-lime px-4 py-2 text-xs font-medium text-graphite transition-transform hover:scale-[1.02]"
        >
          {copied ? "Copied" : "Copy invitation"}
        </button>
      </div>

      <pre
        className={`overflow-x-auto px-5 py-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-mist-bright ${
          expanded ? "" : "max-h-52 [mask-image:linear-gradient(#000_58%,transparent)]"
        }`}
      >
        {INVITATION}
      </pre>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-md border border-line px-3 py-1.5 text-[11px] text-mist transition-colors hover:text-chalk"
        >
          {expanded ? "Collapse" : "Read in full"}
        </button>
        <p className="min-w-0 text-[11px] leading-relaxed text-mist">
          Paste it into your assistant&apos;s chat. It carries every address it needs, and it registers
          itself; there is no token for you to mint or copy. It is also the{" "}
          <span className="font-mono text-chalk">read_invitation</span> tool and{" "}
          <span className="font-mono text-chalk">GET /v1/invitation</span>, so an agent can hand the same
          text to the next one.
        </p>
      </div>

      {/* The same list the copy carries, clickable, so a person can walk it too. */}
      <div className="border-t border-line px-5 py-4">
        <div className="text-[11px] tracking-wide text-mist uppercase">
          Every door, {DOORS.length} of them
        </div>
        <ul className="mt-2.5 space-y-2">
          {DOORS.map((d) => (
            <li key={d.href} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="font-mono text-[10px] text-bug-dim">{d.method}</span>
              <a
                href={d.href}
                className="font-mono text-[11px] break-all text-chalk underline decoration-dotted transition-colors hover:text-bug"
              >
                {d.href}
              </a>
              <span className="text-[11px] leading-relaxed text-mist">{d.what}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-mist">
          Each of these {DOORS.length} addresses was walked against this deployment and answered, and a fresh
          identity registered, resumed and connected end to end.
        </p>
      </div>
    </div>
  );
}
