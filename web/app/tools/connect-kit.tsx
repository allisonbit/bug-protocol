"use client";

import { useState, type ReactNode } from "react";
import { downloadText } from "@/lib/commit";
import { MCP_ENDPOINT } from "@/lib/site";
import { Button, Card, Copyable, Field, Input, SectionTitle } from "@/components/ui";
import { CLI_ENV, CLI_INSTALL, mcpConfig, REPO_URL, reconKitInstaller } from "./kit-templates";

/** Multi-line code block with a copy button. */
function CodeBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      {label && <div className="mb-1 text-[11px] text-mist">{label}</div>}
      <pre className="overflow-auto rounded border border-line bg-ink p-3 pr-16 text-[11px] leading-relaxed whitespace-pre-wrap text-chalk">
        {text}
      </pre>
      <button
        onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}
        className="absolute top-2 right-2 rounded border border-line bg-ink-soft px-2 py-1 text-[10px] text-mist hover:text-chalk"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <SectionTitle>{title}</SectionTitle>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function ConnectKit() {
  return (
    <div className="space-y-5">
      <McpPanel />
      <div className="grid gap-5 md:grid-cols-2">
        <CliPanel />
        <ReconPanel />
      </div>
    </div>
  );
}

/** Wire the protocol into any MCP client so AI agents can hunt + triage. */
function McpPanel() {
  const [token, setToken] = useState("");
  const json = JSON.stringify(mcpConfig({ agentToken: token }), null, 2);

  return (
    <Panel title="Connect an AI agent (MCP)">
      <p className="text-xs leading-relaxed text-mist">
        Swamp runs a hosted MCP server, so there is no local process to start and no key to configure
        here. Paste this into an MCP client that supports a remote HTTP server. Reads need no
        credential at all; agent tools need a token.
      </p>
      <div className="mt-4 rounded border border-line bg-ink px-3 py-2">
        <Copyable value={MCP_ENDPOINT} />
      </div>
      <div className="mt-4">
        <Field
          label="Agent token (optional)"
          hint="Only for the tools that act as an agent. Register one at /dashboard/agents; it is shown once."
        >
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste an agent token" />
        </Field>
      </div>
      <div className="mt-4">
        <CodeBlock text={json} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => downloadText("swamp.mcp.json", json, "application/json")}>
          download config
        </Button>
        <a className="text-[11px] text-bug underline" href="/connect">
          the {MCP_TOOL_COUNT} tools, and how signing works
        </a>
      </div>
      <p className="mt-5 text-xs leading-relaxed text-mist">
        Every tool the server exposes is listed on{" "}
        <a className="text-bug underline" href="/connect">
          /connect
        </a>
        , including which credential each one needs.
      </p>
    </Panel>
  );
}

/**
 * Verified against the live server. `/connect` renders the authoritative list
 * straight from the tool registry; this is only a headline count, and the same
 * `tools/list` call on that page is what proves it.
 */
const MCP_TOOL_COUNT = 22;

/** The terminal path: an instant zero-dep script, or the full signing CLI. */
function CliPanel() {
  return (
    <Panel title="Terminal / CLI">
      <p className="text-xs leading-relaxed text-mist">
        <span className="text-chalk">Instant, no setup:</span> a single Node file for the offline crypto:
        checksums, commit salts, report encryption. No dependencies, works today.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href="/downloads/bug.mjs"
          download
          className="inline-block rounded border border-bug-dim bg-bug-dim/10 px-4 py-2 text-sm text-bug transition-colors hover:bg-bug-dim/20"
        >
          download bug.mjs
        </a>
      </div>
      <div className="mt-3">
        <CodeBlock
          text={[
            "node bug.mjs checksum ./mytool.zip      # 0x... to publish/verify",
            "node bug.mjs verify ./mytool.zip 0x...  # confirm a download",
            "node bug.mjs encrypt report.md --pass s # writes report.md.enc.json",
            "node bug.mjs salt                       # random commit salt",
          ].join("\n")}
        />
      </div>
      <p className="mt-5 text-xs leading-relaxed text-mist">
        <span className="text-chalk">Full CLI</span> (signs transactions: submit, reveal, triage, claim on any
        chain, ETH or USDC). <span className="text-warn">Not published to npm yet</span>, install it from
        the repo:
      </p>
      <div className="mt-3 space-y-2">
        <CodeBlock text={CLI_INSTALL} />
        <CodeBlock text={CLI_ENV} />
      </div>
    </Panel>
  );
}

/** Generate a runnable recon + live triage kit for an in scope target. */
function ReconPanel() {
  const [target, setTarget] = useState("");
  const script = reconKitInstaller(target);
  return (
    <Panel title="Recon + live triage kit">
      <p className="text-xs leading-relaxed text-mist">
        A one file installer that stands up the ProjectDiscovery pipeline in Docker:
        subfinder, httpx and nuclei, plus naabu, gau and ffuf. Point it at a host a
        live program lists in scope; feed the nuclei output into a report.
      </p>
      <div className="mt-4">
        <Field label="Target host" hint="Bare hostname. Only test assets covered by a program's onchain scope + safe harbour.">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="example.com" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => downloadText("bug-recon-kit.sh", script, "text/x-shellscript")}>
          download kit installer
        </Button>
        <a className="text-[11px] text-bug underline" href={REPO_URL} target="_blank" rel="noreferrer">
          full protocol repo
        </a>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-[11px] text-mist hover:text-chalk">preview installer</summary>
        <div className="mt-2">
          <CodeBlock text={script} />
        </div>
      </details>
    </Panel>
  );
}
