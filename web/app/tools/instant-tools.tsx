"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { keccak256, isAddress, type Address } from "viem";
import {
  commitmentFor,
  randomSalt,
  buildReceipt,
  downloadJson,
  downloadText,
  encryptReport,
  decryptReport,
} from "@/lib/commit";
import { Button, Card, Copyable, Field, Input, Textarea } from "@/components/ui";

/** A titled panel for a single instant tool. */
function ToolCard({ title, blurb, children }: { title: string; blurb: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold text-chalk">{title}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-mist">{blurb}</p>
      <div className="mt-4 space-y-3">{children}</div>
    </Card>
  );
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function InstantTools() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <ChecksumTool />
      <ScopeHasher />
      <CommitBuilder />
      <SaltGen />
      <ReportCrypto />
    </div>
  );
}

/** sha256 a file, in-browser. The value a publisher commits and a downloader verifies. */
function ChecksumTool() {
  const [name, setName] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expected, setExpected] = useState("");

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setName(file.name);
    setHash(null);
    try {
      setHash("0x" + (await sha256Hex(await file.arrayBuffer())));
    } finally {
      setBusy(false);
    }
  }

  const match = hash && expected.trim() ? hash.toLowerCase() === expected.trim().toLowerCase() : null;

  return (
    <ToolCard
      title="File checksum (sha256)"
      blurb="Hash any artifact locally. This is the exact 0x... value a tool author commits on chain, and what you re-check after downloading someone else's tool. Nothing is uploaded."
    >
      <input
        type="file"
        onChange={(e) => onFile(e.target.files?.[0])}
        className="block w-full text-xs text-mist file:mr-3 file:rounded file:border file:border-line file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-chalk hover:file:border-mist"
      />
      {busy && <p className="text-[11px] text-mist">hashing...</p>}
      {hash && (
        <div className="rounded border border-line bg-ink p-3 text-xs">
          <div className="text-mist">{name}</div>
          <div className="mt-1">
            <Copyable value={hash} />
          </div>
        </div>
      )}
      <Field label="Verify against expected checksum" hint="Paste a published 0x... to confirm a download is authentic.">
        <Input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="0x..." />
      </Field>
      {match !== null && (
        <p className={`text-xs ${match ? "text-bug" : "text-red-400"}`}>
          {match ? "Matches. The bytes are authentic" : "Mismatch. Do not trust this file"}
        </p>
      )}
    </ToolCard>
  );
}

/** keccak256 of a scope document. The value a program commits on chain. */
function ScopeHasher() {
  const [text, setText] = useState("");
  const hash = useMemo(() => (text.trim() ? keccak256(new TextEncoder().encode(text)) : null), [text]);
  return (
    <ToolCard
      title="Scope hasher (keccak256)"
      blurb="Hash a scope + safe-harbour document the way createProgram does. Publish the text at a URL and the hash on chain; hunters check they agree."
    >
      <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="In scope: *.example.com ..." />
      {hash && (
        <div className="rounded border border-line bg-ink p-3 text-xs">
          <Copyable value={hash} />
        </div>
      )}
    </ToolCard>
  );
}

/** Build a hunter commit hash + downloadable receipt, entirely offline. */
function CommitBuilder() {
  const { address } = useAccount();
  const [reportURI, setReportURI] = useState("");
  const [hunter, setHunter] = useState("");
  const [salt, setSalt] = useState<`0x${string}` | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setSalt(randomSalt()), []);
  useEffect(() => {
    if (address && !hunter) setHunter(address);
  }, [address, hunter]);

  const who = (isAddress(hunter) ? hunter : address) as Address | undefined;
  const commit = useMemo(
    () => (salt && who && reportURI.trim() ? commitmentFor(reportURI.trim(), salt, who) : null),
    [salt, who, reportURI],
  );

  return (
    <ToolCard
      title="Commit builder"
      blurb="Bind a reportURI + salt + your address into the exact keccak256 the contract's reveal checks. Download the receipt, because the salt can't be recovered if lost."
    >
      <Field label="Report URI">
        <Input value={reportURI} onChange={(e) => setReportURI(e.target.value)} placeholder="ipfs://... or https://..." />
      </Field>
      <Field label="Hunter address">
        <Input value={hunter} onChange={(e) => setHunter(e.target.value)} placeholder="0x... (defaults to connected wallet)" />
        {hunter && !isAddress(hunter) && <span className="mt-1 block text-[11px] text-red-400">not a valid address</span>}
      </Field>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-mist">salt</span>
        {salt ? <Copyable value={salt} display={`${salt.slice(0, 10)}...`} /> : "..."}
        <button className="text-bug-dim hover:text-bug" onClick={() => setSalt(randomSalt())}>                regenerate
        </button>
      </div>
      {commit && (
        <div className="rounded border border-line bg-ink p-3 text-xs">
          <span className="text-mist">commit </span>
          <Copyable value={commit} />
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          disabled={!commit || !who || !salt}
          onClick={() => {
            if (!commit || !who || !salt) return;
            downloadJson(`bug-commit-receipt.json`, buildReceipt("n/a", who, reportURI.trim(), salt));
            setSaved(true);
          }}
        >
          download receipt
        </Button>
        {saved && <span className="text-[11px] text-bug">saved</span>}
      </div>
    </ToolCard>
  );
}

function SaltGen() {
  const [salt, setSalt] = useState<`0x${string}` | null>(null);
  useEffect(() => setSalt(randomSalt()), []);
  return (
    <ToolCard title="Salt generator" blurb="A fresh cryptographically-random 32-byte salt for any commit you build by hand.">
      <div className="rounded border border-line bg-ink p-3 text-xs">{salt ? <Copyable value={salt} /> : "..."}</div>
      <Button variant="ghost" onClick={() => setSalt(randomSalt())}>                new salt
      </Button>
    </ToolCard>
  );
}

/** Encrypt/decrypt a report body in-browser. AES-GCM, matches the CLI + MCP. */
function ReportCrypto() {
  const [mode, setMode] = useState<"encrypt" | "decrypt">("encrypt");
  const [body, setBody] = useState("");
  const [pass, setPass] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run() {
    setErr(null);
    setOut(null);
    try {
      if (mode === "encrypt") {
        if (!body.trim() || !pass) return;
        const env = await encryptReport(body, pass);
        downloadText("bug-report.enc.json", env, "application/json");
        setOut("encrypted file downloaded");
      } else {
        const file = fileRef.current?.files?.[0];
        if (!file || !pass) return;
        setOut(await decryptReport(await file.text(), pass));
      }
    } catch {
      setErr(mode === "decrypt" ? "decryption failed. Wrong passphrase or corrupt file" : "encryption failed");
    }
  }

  return (
    <ToolCard
      title="Report encrypt / decrypt"
      blurb="AES-GCM with a PBKDF2 passphrase. Publish the ciphertext anywhere and use its URL as your reportURI; hand the passphrase to the client over a side channel."
    >
      <div className="flex gap-1 text-xs">
        {(["encrypt", "decrypt"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setOut(null);
              setErr(null);
            }}
            className={`rounded border px-2.5 py-1 ${mode === m ? "border-bug-dim text-bug" : "border-line text-mist hover:text-chalk"}`}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "encrypt" ? (
        <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Steps to reproduce, impact, PoC..." />
      ) : (
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="block w-full text-xs text-mist file:mr-3 file:rounded file:border file:border-line file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-chalk hover:file:border-mist"
        />
      )}
      <Field label="Passphrase">
        <Input type="text" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="a strong shared secret" />
      </Field>
      <Button variant="ghost" onClick={run}>
        {mode === "encrypt" ? "encrypt & download" : "decrypt"}
      </Button>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {out && mode === "decrypt" && (
        <pre className="max-h-48 overflow-auto rounded border border-line bg-ink p-3 text-[11px] whitespace-pre-wrap text-chalk">{out}</pre>
      )}
      {out && mode === "encrypt" && <p className="text-xs text-bug">{out}</p>}
    </ToolCard>
  );
}
