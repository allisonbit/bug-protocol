"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { keccak256, parseUnits, decodeEventLog, isAddress, type Address } from "viem";
import { bountyAbi, NATIVE } from "@/lib/contract";
import { useProtocolMeta, useBounty, useExplorer } from "@/lib/reads";
import { assetInfo } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { fmtAmount } from "@/lib/format";
import { Button, Card, Field, Input, Select, SectionTitle, Textarea } from "@/components/ui";

const SEV = ["Low", "Medium", "High", "Critical"] as const;

export default function NewProgram() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const meta = useProtocolMeta();
  const { address: bounty, isDeployed, chainId, meta: chain } = useBounty();
  const explorer = useExplorer();
  const tx = useTx();

  const [scopeText, setScopeText] = useState("");
  const [scopeURI, setScopeURI] = useState("");
  const [rewardKind, setRewardKind] = useState<"native" | "usdc" | "custom">("native");
  const [customToken, setCustomToken] = useState("");
  const [tiers, setTiers] = useState<Record<string, string>>({ Low: "", Medium: "", High: "", Critical: "" });
  const [triageDays, setTriageDays] = useState("7");
  const [disclosureDays, setDisclosureDays] = useState("30");
  const [newId, setNewId] = useState<string | null>(null);

  // Resolve the reward token + its symbol/decimals so escrow can be ETH, USDC,
  // or any ERC-20 — the protocol never requires $BUG to run a program.
  const rewardToken: Address | null = useMemo(() => {
    if (rewardKind === "native") return NATIVE as Address;
    if (rewardKind === "usdc") return chain.usdc;
    return isAddress(customToken) ? (customToken as Address) : null;
  }, [rewardKind, chain.usdc, customToken]);

  const asset = assetInfo(chainId, rewardToken ?? NATIVE);

  const scopeHash = useMemo(
    () => (scopeText.trim() ? keccak256(new TextEncoder().encode(scopeText)) : null),
    [scopeText],
  );

  const topTier = useMemo(() => {
    const vals = SEV.map((s) => Number(tiers[s] || 0)).filter((n) => n > 0);
    return vals.length ? Math.max(...vals) : 0;
  }, [tiers]);

  const triageOk = Number(triageDays) >= 3 && Number(triageDays) <= 30;
  const disclosureOk = Number(disclosureDays) >= 0 && Number(disclosureDays) <= 180;
  const canSubmit =
    isConnected &&
    !!scopeHash &&
    scopeURI.trim().length > 0 &&
    topTier > 0 &&
    triageOk &&
    disclosureOk &&
    !!rewardToken;

  async function create() {
    if (!scopeHash || !rewardToken || !bounty) return;
    const tierWei = [0n, ...SEV.map((s) => (tiers[s] ? parseUnits(tiers[s], asset.decimals) : 0n))] as unknown as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const hash = await tx.run({
      address: bounty,
      abi: bountyAbi,
      functionName: "createProgram",
      args: [
        rewardToken,
        scopeHash,
        scopeURI.trim(),
        tierWei,
        BigInt(Number(triageDays) * 86400),
        BigInt(Number(disclosureDays) * 86400),
      ],
    });
    if (hash && publicClient) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: bountyAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "ProgramCreated") {
            const id = String((ev.args as { programId: bigint }).programId);
            setNewId(id);
            return;
          }
        } catch {
          /* not our event */
        }
      }
    }
  }

  if (newId) {
    return (
      <section className="mx-auto max-w-2xl px-6 py-16 text-center">
        <div className="text-4xl">🐛</div>
        <h1 className="mt-4 text-2xl font-semibold">Program #{newId} created</h1>
        <p className="mt-3 text-sm text-mist">
          It&apos;s in <span className="text-chalk">Draft</span>. To go Live and start accepting
          findings, fund the {asset.symbol} escrow, post your $BUG bond, then flip it Live — all from
          the program page.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button variant="primary" onClick={() => router.push(`/programs/${newId}`)}>
            open program →
          </Button>
        </div>
        {tx.hash && (
          <a className="mt-6 block text-xs text-bug underline" href={explorer.tx(tx.hash)}>
            view transaction ↗
          </a>
        )}
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create a program</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
        This creates the program in Draft on <span className="text-chalk">{chain.label}</span>. Nothing
        is charged now — funding, the bond, and going Live are separate steps so you review the exact
        escrow before hunters can submit.
      </p>

      {!isDeployed && (
        <Card className="mt-6 border-warn/40 bg-warn/5 p-4">
          <p className="text-xs text-mist">
            <span className="text-warn">Not deployed on {chain.label} yet:</span> the create button is
            disabled here. Switch networks in the top bar, or the form stays fully functional against
            the real ABI.
          </p>
        </Card>
      )}

      <div className="mt-8 space-y-8">
        <div>
          <SectionTitle>Scope & safe harbour</SectionTitle>
          <div className="mt-4 space-y-5">
            <Field
              label="Scope document"
              hint="Paste the full text of what's in scope and your safe-harbour terms. We hash it locally with keccak256 — only the hash goes on chain, so the document itself never leaves your browser here."
            >
              <Textarea
                rows={8}
                value={scopeText}
                onChange={(e) => setScopeText(e.target.value)}
                placeholder={"In scope: *.example.com, the iOS app...\nOut of scope: DoS, social engineering...\nSafe harbour: good-faith research authorised under..."}
              />
            </Field>
            {scopeHash && (
              <p className="font-mono text-[11px] break-all text-mist">
                scopeHash <span className="text-bug">{scopeHash}</span>
              </p>
            )}
            <Field
              label="Scope URI"
              hint="A public, permanent link to the same document (your site, IPFS, a gist). Hunters check that its hash matches."
            >
              <Input
                value={scopeURI}
                onChange={(e) => setScopeURI(e.target.value)}
                placeholder="https://example.com/security/scope.txt"
              />
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Reward asset</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            Escrow can be the native coin, USDC, or any ERC-20. The protocol doesn&apos;t require $BUG
            to run — the token only adds slashable bonds on top.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Pay bounties in">
              <Select value={rewardKind} onChange={(e) => setRewardKind(e.target.value as typeof rewardKind)}>
                <option value="native">{chain.chain.nativeCurrency.symbol} (native)</option>
                <option value="usdc" disabled={!chain.usdc}>
                  USDC{chain.usdc ? "" : " (not on this chain)"}
                </option>
                <option value="custom">Custom ERC-20…</option>
              </Select>
            </Field>
            {rewardKind === "custom" && (
              <Field label="Token address" hint="Tiers are entered in this token's units (assumes 18 decimals).">
                <Input value={customToken} onChange={(e) => setCustomToken(e.target.value)} placeholder="0x…" />
                {customToken && !isAddress(customToken) && (
                  <span className="mt-1 block text-[11px] text-red-400">not a valid address</span>
                )}
              </Field>
            )}
            {rewardKind === "usdc" && chain.usdc && (
              <div className="self-end text-[11px] text-mist">
                USDC on {chain.label}: <span className="font-mono text-chalk break-all">{chain.usdc}</span>
              </div>
            )}
          </div>
        </div>

        <div>
          <SectionTitle>Payout tiers ({asset.symbol})</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            Set at least one. Escrow must later cover your top tier for every open report at once, so
            the top tier caps what a single finding pays.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SEV.map((s) => (
              <Field key={s} label={s}>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={tiers[s]}
                  onChange={(e) => setTiers((t) => ({ ...t, [s]: e.target.value }))}
                  placeholder="0.0"
                />
              </Field>
            ))}
          </div>
          {topTier > 0 && (
            <p className="mt-3 text-xs text-mist">
              top tier <span className="text-chalk">{topTier} {asset.symbol}</span> — you&apos;ll escrow
              at least this to go Live.
            </p>
          )}
        </div>

        <div>
          <SectionTitle>Timing</SectionTitle>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Triage deadline (days)" hint="3–30. How long you have to triage each report before a hunter can escalate.">
              <Input type="number" min="3" max="30" value={triageDays} onChange={(e) => setTriageDays(e.target.value)} />
              {!triageOk && <span className="mt-1 block text-[11px] text-red-400">must be 3–30 days</span>}
            </Field>
            <Field label="Disclosure delay (days)" hint="0–180. Embargo after resolution before a hunter may publish.">
              <Input
                type="number"
                min="0"
                max="180"
                value={disclosureDays}
                onChange={(e) => setDisclosureDays(e.target.value)}
              />
              {!disclosureOk && <span className="mt-1 block text-[11px] text-red-400">must be 0–180 days</span>}
            </Field>
          </div>
        </div>

        {meta.minProgramBond !== undefined && (
          <p className="text-xs text-mist">
            Note: going Live also requires a client bond of at least{" "}
            <span className="text-chalk">{fmtAmount(meta.minProgramBond, 18, "$BUG")}</span>. You post
            it on the program page.
          </p>
        )}

        {tx.error && <p className="text-sm text-red-400">{tx.error}</p>}

        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!canSubmit || tx.busy || !isDeployed} onClick={create}>
            {tx.busy ? "creating…" : "create program"}
          </Button>
          {!isConnected && <span className="text-xs text-mist">connect a wallet first</span>}
        </div>
      </div>
    </section>
  );
}
