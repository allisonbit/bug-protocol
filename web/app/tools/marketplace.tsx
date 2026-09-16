"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { decodeEventLog, formatUnits, parseUnits } from "viem";
import {
  useToolRegistry,
  useRegistryMeta,
  toolRegistryAbi,
  Platform,
  Category,
  PLATFORM_OPTIONS,
  CATEGORY_OPTIONS,
} from "@/lib/toolRegistry";
import { useTx } from "@/lib/useTx";
import { useApprove } from "@/lib/useApprove";
import { chainMeta, txUrlOn, addressUrlOn } from "@/lib/chains";
import { short, fmtAmount } from "@/lib/format";
import { Badge, Button, Card, Copyable, Empty, Field, Input, Select, Textarea } from "@/components/ui";
import { BrandMark } from "@/components/brand";

/** Client-side shape of a mirror row (the JSON /api/tools returns). */
type Listing = {
  chain_id: number;
  tool_id: number;
  publisher: string;
  name: string;
  description: string | null;
  platform: number;
  category: number;
  semver: string | null;
  checksum: string;
  artifact_url: string;
  artifact_name: string;
  metadata_url: string;
  source_url: string | null;
  tx_hash: string | null;
  downloads: number;
  flagged: boolean;
  flag_count: number;
  created_at: string;
};

type PublishPhase = "idle" | "staging" | "approving" | "publishing" | "confirming" | "done";

export function Marketplace() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { chainId, address: registry, isDeployed } = useToolRegistry();
  const { minStake, bugToken } = useRegistryMeta();

  // ---- browse ----
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("0");
  const [category, setCategory] = useState("0");
  const [listings, setListings] = useState<Listing[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [showPublish, setShowPublish] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (platform !== "0") params.set("platform", platform);
      if (category !== "0") params.set("category", category);
      const res = await fetch(`/api/tools?${params.toString()}`);
      const json = await res.json();
      setConfigured(json.configured !== false);
      setListings(json.tools ?? []);
    } catch {
      setListings([]);
    } finally {
      setLoading(false);
    }
  }, [q, platform, category]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce the search box
    return () => clearTimeout(t);
  }, [load]);

  // ---- flag (onchain is primary; mirror gets a hint for instant UI) ----
  const flagTx = useTx();
  const flag = useCallback(
    async (row: Listing) => {
      if (!registry) return;
      const reason = window.prompt("Why is this tool malicious or broken? (a short reason, or a URL)");
      if (reason === null) return;
      const hash = await flagTx.run({
        address: registry,
        abi: toolRegistryAbi,
        functionName: "flag",
        args: [BigInt(row.tool_id), reason || "flagged via marketplace"],
      });
      if (hash) {
        await fetch("/api/tools/flag", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId: row.chain_id, toolId: row.tool_id }),
        }).catch(() => {});
        load();
      }
    },
    [registry, flagTx, load],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <Field label="Search">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or description..." />
            </Field>
          </div>
          <Field label="Platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="0">all platforms</option>
              {PLATFORM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="0">all categories</option>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button variant="primary" onClick={() => setShowPublish((v) => !v)}>
          {showPublish ? "close" : "publish a tool"}
        </Button>
      </div>

      {showPublish && (
        <PublishForm
          chainId={chainId}
          registry={registry}
          isDeployed={isDeployed}
          isConnected={isConnected}
          publisher={address}
          bugToken={bugToken}
          minStake={minStake}
          configured={configured}
          publicClient={publicClient}
          onPublished={() => {
            setShowPublish(false);
            load();
          }}
        />
      )}

      {!configured && (
        <Card className="border-warn/40 bg-warn/5 p-4">
          <p className="text-xs text-mist">
            <span className="text-warn">Marketplace index not wired yet:</span> Supabase isn&apos;t configured for
            this deploy, so browse is empty. The instant tools and connect kits above work regardless, and
            publishing still records on chain the moment the registry is live.
          </p>
        </Card>
      )}

      {flagTx.error && <p className="text-xs text-red-400">{flagTx.error}</p>}

      {loading ? (
        <p className="text-xs text-mist">loading...</p>
      ) : listings.length === 0 ? (
        <Empty>No tools yet. Be the first to publish one: Android, desktop, terminal, browser, or MCP.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {listings.map((t) => (
            <ListingCard key={`${t.chain_id}:${t.tool_id}`} t={t} onFlag={() => flag(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ListingCard({ t, onFlag }: { t: Listing; onFlag: () => void }) {
  const cm = chainMeta(t.chain_id);
  return (
    <Card className={`p-5 ${t.flagged ? "border-warn/50" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-chalk">{t.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="text-bug border-bug-dim">{Platform[t.platform] ?? "?"}</Badge>
            <Badge>{Category[t.category] ?? "?"}</Badge>
            <Badge>{cm.short}</Badge>
            {t.semver && <Badge>v{t.semver}</Badge>}
            {t.flagged && <Badge tone="text-warn border-warn/50">flagged</Badge>}
          </div>
        </div>
        <div className="text-right text-[11px] text-mist">
          <div className="text-chalk">{t.downloads}</div>
          downloads
        </div>
      </div>

      {t.description && <p className="mt-3 text-xs leading-relaxed text-mist">{t.description}</p>}

      <div className="mt-3 space-y-1.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="text-mist">by</span>
          <a className="font-mono text-mist hover:text-chalk" href={addressUrlOn(t.chain_id, t.publisher)} target="_blank" rel="noreferrer">
            {short(t.publisher)}
          </a>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-mist">sha256</span>
          <Copyable value={t.checksum} display={`${t.checksum.slice(0, 12)}...`} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href={`/api/tools/download?chainId=${t.chain_id}&toolId=${t.tool_id}`}
          className="rounded border border-bug-dim bg-bug-dim/10 px-3 py-1.5 text-xs text-bug hover:bg-bug-dim/20"
        >
          {t.artifact_name}
        </a>
        {t.source_url && (
          <a className="text-[11px] text-mist underline hover:text-chalk" href={t.source_url} target="_blank" rel="noreferrer">                        source
          </a>
        )}
        {t.tx_hash && (
          <a className="text-[11px] text-mist underline hover:text-chalk" href={txUrlOn(t.chain_id, t.tx_hash)} target="_blank" rel="noreferrer">                        onchain
          </a>
        )}
        <button onClick={onFlag} className="ml-auto text-[11px] text-mist hover:text-warn" title="flag as malicious/broken">                        flag
        </button>
      </div>
    </Card>
  );
}

function PublishForm({
  chainId,
  registry,
  isDeployed,
  isConnected,
  publisher,
  bugToken,
  minStake,
  configured,
  publicClient,
  onPublished,
}: {
  chainId: number;
  registry: `0x${string}` | null;
  isDeployed: boolean;
  isConnected: boolean;
  publisher?: `0x${string}`;
  bugToken?: `0x${string}`;
  minStake?: bigint;
  configured: boolean;
  publicClient: ReturnType<typeof usePublicClient>;
  onPublished: () => void;
}) {
  const tx = useTx();
  const approve = useApprove();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [platform, setPlatform] = useState(String(PLATFORM_OPTIONS[0]?.value ?? 1));
  const [category, setCategory] = useState(String(CATEGORY_OPTIONS[0]?.value ?? 1));
  const [semver, setSemver] = useState("1.0.0");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stakeInput, setStakeInput] = useState("");

  const [phase, setPhase] = useState<PublishPhase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);

  // Default the stake to the registry minimum once it's read.
  useEffect(() => {
    if (minStake !== undefined && !stakeInput) setStakeInput(formatUnits(minStake, 18));
  }, [minStake, stakeInput]);

  const stakeWei = useMemo(() => {
    try {
      return stakeInput.trim() ? parseUnits(stakeInput.trim(), 18) : 0n;
    } catch {
      return null;
    }
  }, [stakeInput]);

  const stakeOk = stakeWei !== null && (minStake === undefined || stakeWei >= minStake);
  const canPublish =
    isConnected && isDeployed && configured && !!file && name.trim().length > 0 && stakeOk && phase === "idle";

  async function doPublish() {
    setErr(null);
    if (!file || !registry || !publisher || stakeWei === null) return;
    try {
      // 1. Stage: server hashes the bytes and returns the authoritative checksum.
      setPhase("staging");
      const fd = new FormData();
      fd.append("file", file);
      fd.append(
        "meta",
        JSON.stringify({ name, description, platform: Number(platform), category: Number(category), semver, sourceUrl, publisher }),
      );
      const staged = await fetch("/api/tools/stage", { method: "POST", body: fd }).then((r) => r.json());
      if (!staged?.checksum) throw new Error(staged?.error || "staging failed");

      // 2. Approve the $BUG stake if one is required.
      if (stakeWei > 0n) {
        if (!bugToken) throw new Error("could not resolve the $BUG token address from the registry");
        setPhase("approving");
        const ok = await approve.ensure(bugToken, publisher, registry, stakeWei);
        if (!ok) {
          setPhase("idle");
          return;
        }
      }

      // 3. Publish on chain. metadataURI points at the staged metadata.json.
      setPhase("publishing");
      const hash = await tx.run({
        address: registry,
        abi: toolRegistryAbi,
        functionName: "publish",
        args: [Number(platform), Number(category), staged.metadataUrl, staged.checksum, semver, stakeWei],
      });
      if (!hash) {
        setPhase("idle");
        return;
      }

      // 4. Recover the assigned toolId from the ToolPublished event.
      let toolId: bigint | undefined;
      const receipt = await publicClient?.getTransactionReceipt({ hash });
      for (const log of receipt?.logs ?? []) {
        if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: toolRegistryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "ToolPublished") {
            toolId = (ev.args as { toolId: bigint }).toolId;
            break;
          }
        } catch {
          /* not our event */
        }
      }
      if (toolId === undefined) throw new Error("published on chain, but couldn't read the tool id. Refresh to see it");

      // 5. Confirm the mirror (server re-verifies checksum against chain).
      setPhase("confirming");
      const confirm = await fetch("/api/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          toolId: Number(toolId),
          checksum: staged.checksum,
          name,
          description,
          artifactUrl: staged.artifactUrl,
          artifactName: staged.artifactName,
          sourceUrl,
          txHash: hash,
        }),
      }).then((r) => r.json());
      if (confirm?.error) throw new Error(confirm.error);

      setPublishedId(String(toolId));
      setPhase("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "publish failed");
      setPhase("idle");
    }
  }

  if (phase === "done" && publishedId) {
    return (
      <Card className="border-bug-dim/50 bg-bug-dim/5 p-6 text-center">
        <BrandMark size={32} className="mx-auto" />
        <h3 className="mt-2 text-sm font-semibold text-chalk">Tool #{publishedId} published</h3>
        <p className="mt-2 text-xs text-mist">
          It&apos;s live on chain with your stake bonded and indexed for search. Anyone can download it and
          verify the checksum; a malicious tool can be flagged and your stake slashed.
        </p>
        <div className="mt-4">
          <Button variant="ghost" onClick={onPublished}>
            back to marketplace
          </Button>
        </div>
      </Card>
    );
  }

  const busyLabel =
    phase === "staging"
      ? "uploading..."
      : phase === "approving" || approve.state === "approving"
        ? "approving $BUG..."
        : phase === "publishing"
          ? "publishing..."
          : phase === "confirming"
            ? "indexing..."
            : "publish tool";

  return (
    <Card className="p-6">
      <h3 className="text-sm font-semibold text-chalk">Publish a tool</h3>
      <p className="mt-1 text-xs leading-relaxed text-mist">
        Permissionless. Anyone can ship an Android, desktop, terminal, browser, or MCP tool. The artifact goes
        to storage, its sha256 + your address + a slashable $BUG stake go on chain. No review, no gatekeeper:
        attribution and a bond you lose if it&apos;s malicious.
      </p>

      {!isDeployed && (
        <p className="mt-3 text-xs text-warn">Registry isn&apos;t deployed on {chainMeta(chainId).label} yet. Switch networks to publish.</p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nuclei-scope-runner" />
        </Field>
        <Field label="Version">
          <Input value={semver} onChange={(e) => setSemver(e.target.value)} placeholder="1.0.0" />
        </Field>
        <Field label="Platform">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, how to run it, what it needs." />
        </Field>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Source URL (optional)" hint="Link to the repo so others can read the code.">
          <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://github.com/..." />
        </Field>
        <Field label={`Stake (${minStake !== undefined ? `min ${fmtAmount(minStake, 18, "$BUG")}` : "$BUG"})`} hint="Slashable if the tool is judged malicious. More stake = more trust.">
          <Input value={stakeInput} onChange={(e) => setStakeInput(e.target.value)} placeholder="0.0" />
          {!stakeOk && stakeInput && <span className="mt-1 block text-[11px] text-red-400">must be at least the minimum stake</span>}
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Artifact" hint="The file people download: an APK, binary, .zip, script, or MCP bundle. Hashed locally on the server; the checksum is what goes on chain.">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-mist file:mr-3 file:rounded file:border file:border-line file:bg-ink file:px-3 file:py-1.5 file:text-xs file:text-chalk hover:file:border-mist"
          />
        </Field>
      </div>

      {(err || tx.error || approve.error) && <p className="mt-4 text-xs text-red-400">{err ?? tx.error ?? approve.error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" disabled={!canPublish} onClick={doPublish}>
          {phase === "idle" ? "publish tool" : busyLabel}
        </Button>
        {!isConnected && <span className="text-xs text-mist">connect a wallet first</span>}
      </div>
    </Card>
  );
}
