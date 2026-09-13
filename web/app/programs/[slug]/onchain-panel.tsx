"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, keccak256, parseUnits, toBytes, type Address } from "viem";
import { bountyAbi, bountyEventsAbi } from "@/lib/contract";
import { useBounty, useProgram, useProtocolMeta, useProtocolBounds } from "@/lib/reads";
import { useTx, humanizeError } from "@/lib/useTx";
import { useApprove } from "@/lib/useApprove";
import { linkProgramOnChain, unlinkProgram } from "@/app/actions";
import { assetInfo, chainMeta, DEFAULT_CHAIN_ID, NATIVE, SUPPORTED_CHAINS } from "@/lib/chains";
import { fmtAmount, short, humanDuration, statusName } from "@/lib/format";
import { Button, Card, Copyable, Field, Input, Select } from "@/components/ui";
import type { Program } from "@/lib/db";

const DAY = 86_400;

/**
 * The owner's escrow console.
 *
 * Everything here exists for one reason: without it, no program can ever be Live
 * on chain, which means the hunter's on-chain `submit()` is unreachable and the
 * whole commit-reveal loop is dead code. It is the gate in front of every other
 * part of the protocol.
 *
 * Each step preflights the invariant the contract will enforce and says why a
 * button is disabled, instead of letting the owner sign a transaction that is
 * certain to revert. `setStatus(Live)` in particular needs a recorded scope, a
 * non-zero top tier, escrow covering it and the client bond: four separate
 * reverts the owner would otherwise discover one at a time.
 */
export function OnchainPanel({ program }: { program: Program }) {
  const { isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const protocol = useProtocolMeta();

  const linked = program.onchain_program_id !== null && program.chain_id !== null;
  // TypeScript can't narrow through the derived `linked` flag, and when it's false
  // this value is never used; the default just keeps it well-typed.
  const linkChainId = program.chain_id ?? DEFAULT_CHAIN_ID;
  const linkMeta = linked ? chainMeta(linkChainId) : null;
  const onRightChain = linked && connectedChainId === linkChainId;

  const [refetchKey, setRefetchKey] = useState(0);
  const onchain = useProgram(linked ? BigInt(program.onchain_program_id ?? 0) : undefined, refetchKey);
  const refresh = () => setRefetchKey((k) => k + 1);

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-chalk">On-chain escrow</h2>
          <span className="text-[11px] text-mist">owner only</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mist">
          {linked
            ? "This program is linked to the escrow contract. Verdicts, bonds and the disclosure embargo are enforced there; this site indexes them."
            : "Linking deploys nothing. It points this program at a BugBounty program you own, so findings are committed and escrowed on chain. Until then this is an off-chain bounty: the commit receipt still proves authorship, but nothing is held on your behalf."}
        </p>

        {linked && (
          <div className="mt-4 space-y-3">
            <div className="rounded border border-line bg-ink p-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-mist">program</span>
                <Copyable value={`#${program.onchain_program_id}`} display={`#${program.onchain_program_id}`} />
                <span className="text-mist">on</span>
                <span className="text-chalk">{linkMeta?.label}</span>
                {!onRightChain && (
                  <button
                    onClick={() => switchChain({ chainId: linkChainId })}
                    className="text-bug underline underline-offset-4"
                  >
                    switch to {linkMeta?.short}
                  </button>
                )}
              </div>
              {onchain.program && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <Row label="status" value={statusName(onchain.program.status)} />
                  <Row
                    label="escrow"
                    value={fmtAmount(
                      onchain.program.pool,
                      assetInfo(linkChainId, onchain.program.rewardToken).decimals,
                      assetInfo(linkChainId, onchain.program.rewardToken).symbol,
                    )}
                  />
                  <Row
                    label="free to withdraw"
                    value={
                      onchain.freePool !== undefined
                        ? fmtAmount(
                            onchain.freePool,
                            assetInfo(linkChainId, onchain.program.rewardToken).decimals,
                            assetInfo(linkChainId, onchain.program.rewardToken).symbol,
                          )
                        : "..."
                    }
                  />
                  <Row label="client bond" value={fmtAmount(onchain.program.bond, 18, "$BUG")} />
                  <Row
                    label="open findings"
                    value={onchain.pending !== undefined ? String(onchain.pending) : "..."}
                  />
                  <Row label="triage SLA" value={humanDuration(onchain.program.triageDeadline)} />
                </dl>
              )}
            </div>

            {onRightChain ? (
              <EscrowActions program={program} onDone={refresh} />
            ) : (
              isConnected && (
                <p className="text-[11px] text-mist">
                  Funding, bonding and lifecycle controls need your wallet on {linkMeta?.short}.
                </p>
              )
            )}
          </div>
        )}
      </Card>

      {!linked && (
        <LinkForm
          program={program}
          onDone={refresh}
          suspended={!isConnected || !protocol.bugToken}
        />
      )}

      {linked && <UnlinkForm program={program} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-mist">{label}</dt>
      <dd className="text-right font-mono text-[11px] text-chalk">{value}</dd>
    </>
  );
}

/** Fund, bond, go live, plus the exit hatches. */
function EscrowActions({ program, onDone }: { program: Program; onDone: () => void }) {
  const { address } = useAccount();
  const chainId = program.chain_id ?? undefined;
  const bounty = chainMeta(chainId).bounty;
  const protocol = useProtocolMeta();
  const onchain = useProgram(BigInt(program.onchain_program_id ?? 0));
  const approve = useApprove();

  const [amount, setAmount] = useState("");
  const [bondAmount, setBondAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fund = useTx(onDone);
  const bond = useTx(onDone);
  const lifecycle = useTx(onDone);
  const withdraw = useTx(onDone);
  const reclaim = useTx(onDone);

  const token = (onchain.program?.rewardToken ?? NATIVE) as Address;
  const info = assetInfo(chainId, token);
  const isEth = token.toLowerCase() === NATIVE.toLowerCase();

  const parsed = useMemo(() => {
    if (!amount.trim()) return 0n;
    try {
      return parseUnits(amount.trim() as `${number}`, info.decimals);
    } catch {
      return 0n;
    }
  }, [amount, info.decimals]);

  const minBond = protocol.minProgramBond ?? 0n;
  const topTier = onchain.topTier ?? 0n;
  const pool = onchain.program?.pool ?? 0n;
  const postedBond = onchain.program?.bond ?? 0n;
  const status = onchain.program?.status;
  const isLive = status === 1;
  const isPaused = status === 2;
  const isClosed = status === 3;

  // The exact checklist `setStatus(Live)` enforces, so the owner sees what's
  // missing before signing rather than decoding a revert.
  const gates = [
    { ok: !!onchain.program, label: "Program readable on this chain" },
    { ok: topTier > 0n, label: "At least one payout tier set" },
    {
      ok: topTier > 0n && pool >= topTier,
      label: `Escrow covers the top tier (${fmtAmount(topTier, info.decimals, info.symbol)})`,
    },
    { ok: postedBond >= minBond, label: `Client bond posted (${fmtAmount(minBond, 18, "$BUG")})` },
  ];
  const canGoLive = gates.every((g) => g.ok);

  if (!bounty || !address) return null;

  async function runFund() {
    setError(null);
    if (parsed === 0n) return setError("Enter an amount to escrow.");
    if (!bounty || !address) return;
    if (!isEth) {
      setBusy("approving...");
      const ok = await approve.ensure(token, address, bounty, parsed);
      if (!ok) {
        setBusy(null);
        return setError(approve.error ?? "Approval failed.");
      }
    }
    setBusy("escrowing...");
    // For a native pool the amount is both the argument and msg.value; an ERC-20
    // pool requires msg.value to be exactly zero.
    await fund.run({
      address: bounty,
      abi: bountyAbi,
      functionName: "fundProgram",
      args: [BigInt(program.onchain_program_id ?? 0), parsed],
      ...(isEth ? { value: parsed } : {}),
    });
    setBusy(null);
  }

  async function runBond() {
    setError(null);
    if (!bounty || !address) return;
    const bug = protocol.bugToken;
    if (!bug) return setError("This deployment has no $BUG address configured.");
    let wei = 0n;
    try {
      wei = parseUnits((bondAmount || "0").trim() as `${number}`, 18);
    } catch {
      return setError("That bond amount isn't a number.");
    }
    if (wei === 0n) return setError("Enter a bond amount.");
    setBusy("approving $BUG...");
    const ok = await approve.ensure(bug, address, bounty, wei);
    if (!ok) {
      setBusy(null);
      return setError(approve.error ?? "Approval failed.");
    }
    setBusy("posting bond...");
    await bond.run({ address: bounty, abi: bountyAbi, functionName: "bondProgram", args: [BigInt(program.onchain_program_id ?? 0), wei] });
    setBusy(null);
  }

  async function setStatus(next: number) {
    setError(null);
    if (!bounty) return;
    await lifecycle.run({
      address: bounty,
      abi: bountyAbi,
      functionName: "setStatus",
      args: [BigInt(program.onchain_program_id ?? 0), next],
    });
  }

  async function runWithdraw() {
    setError(null);
    if (!bounty || !address) return;
    if (parsed === 0n) return setError("Enter an amount to withdraw.");
    await withdraw.run({
      address: bounty,
      abi: bountyAbi,
      functionName: "withdrawPool",
      args: [BigInt(program.onchain_program_id ?? 0), address, parsed],
    });
  }

  const err =
    error ?? fund.error ?? bond.error ?? lifecycle.error ?? withdraw.error ?? reclaim.error ?? approve.error;
  const hash = fund.hash ?? bond.hash ?? lifecycle.hash ?? withdraw.hash ?? reclaim.hash;

  return (
    <div className="mt-4 space-y-4 border-t border-line pt-4">
      {!isClosed && (
        <Field
          label={`Escrow more (${info.symbol})`}
          hint="Anyone may top up. The contract only lets you withdraw what isn't reserved for open findings. That reserve is why an accepted report is always payable."
        >
          <div className="flex gap-2">
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" inputMode="decimal" />
            <Button variant="ghost" disabled={!!busy || fund.busy} onClick={runFund} className="shrink-0">
              {fund.busy ? "..." : "escrow"}
            </Button>
          </div>
        </Field>
      )}

      {!isClosed && !isLive && (
        <Field
          label="Post / top up $BUG bond"
          hint="Slashable good-faith bond. Forfeited to the hunter if escrow can't cover an award the arbiter rules valid."
        >
          <div className="flex gap-2">
            <Input
              value={bondAmount}
              onChange={(e) => setBondAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
            <Button variant="ghost" disabled={!!busy || bond.busy} onClick={runBond} className="shrink-0">
              {bond.busy ? "..." : "bond"}
            </Button>
          </div>
        </Field>
      )}

      {!isLive && !isClosed && (
        <div className="rounded border border-line bg-ink p-3">
          <div className="text-[11px] text-mist">Before this program can accept findings on chain:</div>
          <ul className="mt-2 space-y-1">
            {gates.map((g) => (
              <li key={g.label} className="flex items-start gap-2 text-[11px]">
                <span className={g.ok ? "text-bug" : "text-mist"}>{g.ok ? "ok" : "to do"}</span>
                <span className={g.ok ? "text-mist" : "text-chalk"}>{g.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!isLive && !isClosed && (
          <Button disabled={!canGoLive || lifecycle.busy} onClick={() => setStatus(1)}>
            {lifecycle.busy ? "..." : "Go live on chain"}
          </Button>
        )}
        {isLive && (
          <Button variant="ghost" disabled={lifecycle.busy} onClick={() => setStatus(2)}>
            Pause on chain
          </Button>
        )}
        {isPaused && (
          <Button disabled={lifecycle.busy} onClick={() => setStatus(1)}>
            Resume on chain
          </Button>
        )}
        {!isClosed && (
          <Button variant="danger" disabled={lifecycle.busy} onClick={() => setStatus(3)}>
            Close permanently
          </Button>
        )}
        {isClosed && (
          <Button
            variant="ghost"
            disabled={reclaim.busy}
            onClick={() =>
              reclaim.run({
                address: bounty,
                abi: bountyAbi,
                functionName: "reclaimProgramBond",
                args: [BigInt(program.onchain_program_id ?? 0), address],
              })
            }
          >
            {reclaim.busy ? "..." : "Reclaim $BUG bond"}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={!!busy || withdraw.busy || parsed === 0n}
          onClick={runWithdraw}
          title="Withdraw only what isn't reserved for open findings"
        >
          {withdraw.busy ? "..." : "Withdraw unreserved escrow"}
        </Button>
      </div>

      {err && <p className="text-[11px] text-red-400">{err}</p>}
      {hash && <p className="text-[11px] text-mist">confirmed {short(hash)}</p>}
      {isPaused && (
        <p className="text-[11px] leading-relaxed text-mist">
          Paused programs still hold escrow for open findings and existing reports stay resolvable. Pausing stops new
          submissions, it doesn&apos;t walk back the ones already committed.
        </p>
      )}
    </div>
  );
}

/**
 * Creates a program on chain and links this row to it.
 *
 * The scope document is hashed here, in the browser, and that hash is what the
 * contract records. The identical document is what the program page publishes, so
 * a hunter can hash it themselves and check the two agree. Which is the whole
 * point of `scopeHash` being on chain.
 */
function LinkForm({
  program,
  onDone,
  suspended,
}: {
  program: Program;
  onDone: () => void;
  suspended: boolean;
}) {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const bounds = useProtocolBounds();
  const protocol = useProtocolMeta();
  const { writeContractAsync } = useWriteContract();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const firstDeployed = SUPPORTED_CHAINS.find((c) => chainMeta(c.id).bounty);
  const [chainId, setChainId] = useState<number>(firstDeployed?.id ?? SUPPORTED_CHAINS[0].id);
  const meta = chainMeta(chainId);

  const [token, setToken] = useState<Address>(NATIVE);
  const [tierInputs, setTierInputs] = useState({
    low: String(program.tier_low),
    medium: String(program.tier_medium),
    high: String(program.tier_high),
    critical: String(program.tier_critical),
  });
  const [triageDays, setTriageDays] = useState(String(program.response_days || 7));
  const [disclosureDays, setDisclosureDays] = useState("30");

  // The scope document is the program's published description, hashed verbatim.
  // It is deliberately NOT an editable field here: the whole value of `scopeHash`
  // is that a hunter can hash the text the program page shows and get the same
  // number, and an owner editing the text at link time would break exactly that.
  const scopeDoc = program.description ?? "";
  const scopeHash = useMemo(() => (scopeDoc ? keccak256(toBytes(scopeDoc)) : null), [scopeDoc]);
  const info = assetInfo(chainId, token);

  const minDays = Number(bounds.minTriageDeadline) / DAY;
  const maxDays = Number(bounds.maxTriageDeadline) / DAY;
  const maxDisclosureDays = Number(bounds.maxDisclosureDelay) / DAY;
  const triageDaysNum = Number(triageDays);
  const disclosureDaysNum = Number(disclosureDays);
  const triageOk = Number.isFinite(triageDaysNum) && triageDaysNum >= minDays && triageDaysNum <= maxDays;
  const disclosureOk =
    Number.isFinite(disclosureDaysNum) && disclosureDaysNum >= 0 && disclosureDaysNum <= maxDisclosureDays;

  function parseTier(v: string): bigint {
    try {
      return parseUnits((v || "0").trim() as `${number}`, info.decimals);
    } catch {
      return 0n;
    }
  }

  const tiers = useMemo(
    () => [
      parseTier(tierInputs.low),
      parseTier(tierInputs.medium),
      parseTier(tierInputs.high),
      parseTier(tierInputs.critical),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tierInputs, info.decimals],
  );

  async function submit() {
    setError(null);
    setNote(null);
    if (!address || !publicClient) return;
    if (!meta.bounty) return setError(`The protocol isn't deployed on ${meta.label}.`);
    if (connectedChainId !== chainId) {
      switchChain({ chainId });
      return setError(`Switch your wallet to ${meta.label} first, then press again.`);
    }
    if (!scopeHash) {
      return setError(
        "This program has no scope document. Add one under Scope & rules first. The contract refuses to go live without a recorded, hashed scope.",
      );
    }
    if (!triageOk) return setError(`Triage window must be between ${minDays} and ${maxDays} days.`);
    if (!disclosureOk) return setError(`Disclosure delay must be between 0 and ${maxDisclosureDays} days.`);
    if (tiers.every((t) => t === 0n)) return setError("At least one reward tier has to be above zero.");

    setBusy(true);
    try {
      const scopeURI = `${window.location.origin}/programs/${program.slug}`;
      const tx = await writeContractAsync({
        address: meta.bounty,
        abi: bountyAbi,
        functionName: "createProgram",
        args: [
          token,
          scopeHash,
          scopeURI,
          [0n, tiers[0], tiers[1], tiers[2], tiers[3]],
          BigInt(Math.round(triageDaysNum * DAY)),
          BigInt(Math.round(disclosureDaysNum * DAY)),
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      const created = receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: bountyEventsAbi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "ProgramCreated");

      const programId = created && created.eventName === "ProgramCreated" ? created.args.programId : undefined;
      if (programId === undefined) {
        return setError(
          "The transaction confirmed but no ProgramCreated event was readable. The program exists on chain, link it manually.",
        );
      }

      setNote(`Created as #${programId}. Recording the link...`);
      const fd = new FormData();
      fd.set("program_id", program.id);
      fd.set("slug", program.slug);
      fd.set("chain_id", String(chainId));
      fd.set("onchain_program_id", String(programId));
      await linkProgramOnChain(fd);
      setNote(`Linked to #${programId} on ${meta.label}. Next: escrow funds, post the bond, then go live.`);
      onDone();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const tokenChoices: { value: string; label: string }[] = [
    { value: NATIVE, label: `Native ${meta.chain.nativeCurrency.symbol}` },
    ...(meta.usdc ? [{ value: meta.usdc, label: "USDC" }] : []),
    ...(meta.bugToken ? [{ value: meta.bugToken, label: "$BUG" }] : []),
  ];

  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-chalk">Create on chain &amp; link</h2>
      <p className="mt-1.5 text-[11px] leading-relaxed text-mist">
        One transaction, then the resulting program id is recorded on this row. The tier values below are the amounts
        hunters actually receive, converted to the token&apos;s base units for you.
        {protocol.minProgramBond !== undefined && protocol.minProgramBond > 0n && (
          <> A $BUG bond of {fmtAmount(protocol.minProgramBond, 18, "$BUG")} is also required before it can go live.</>
        )}
      </p>

      <div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Network">
            <Select value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.id} value={c.id} disabled={!chainMeta(c.id).bounty}>
                  {c.name}
                  {chainMeta(c.id).bounty ? "" : ", not deployed"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reward asset" hint="What the escrow pool is denominated in.">
            <Select value={token} onChange={(e) => setToken(e.target.value as Address)}>
              {tokenChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Scope + safe-harbour document"
          hint="Your program's published scope, hashed here exactly as a hunter will hash it. This is what makes the work authorised, and a program cannot go live without it."
        >
          {scopeDoc ? (
            <pre className="max-h-40 overflow-auto rounded border border-line bg-ink p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-mist-bright">
              {scopeDoc}
            </pre>
          ) : (
            <p className="rounded border border-amber-500/40 bg-amber-500/[0.06] p-3 text-[11px] leading-relaxed text-amber-300">
              No scope document yet. Add one under <span className="text-chalk">Scope &amp; rules</span> first. The
              contract requires a recorded scope before a program may accept findings, and it is also what makes testing
              your systems authorised rather than not.
            </p>
          )}
        </Field>
        {scopeHash && (
          <div className="rounded border border-line bg-ink p-2.5 text-[11px]">
            <span className="text-mist">scope hash </span>
            <Copyable value={scopeHash} display={`${scopeHash.slice(0, 18)}...`} />
            <span className="ml-2 text-mist">published on the program page, so hunters can check it</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["low", "medium", "high", "critical"] as const).map((sev) => (
            <Field key={sev} label={`${sev} (${info.symbol})`}>
              <Input
                value={tierInputs[sev]}
                inputMode="decimal"
                onChange={(e) => setTierInputs((t) => ({ ...t, [sev]: e.target.value }))}
              />
            </Field>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Triage SLA (days)"
            hint={`The contract allows ${minDays} to ${maxDays}. Miss it and the hunter can escalate to the arbiter.`}
          >
            <Input value={triageDays} inputMode="numeric" onChange={(e) => setTriageDays(e.target.value)} />
          </Field>
          <Field
            label="Disclosure delay (days)"
            hint={`Up to ${maxDisclosureDays}. Time to ship a fix before the hunter may publish.`}
          >
            <Input value={disclosureDays} inputMode="numeric" onChange={(e) => setDisclosureDays(e.target.value)} />
          </Field>
        </div>

        {suspended && (
          <p className="text-[11px] text-mist">
            Connect a wallet
            {protocol.bugToken ? "" : " and configure this deployment's contract addresses"} to create the on-chain
            program.
          </p>
        )}
        <Button disabled={busy || suspended} onClick={submit}>
          {busy ? "..." : `Create on ${meta.short} & link`}
        </Button>
        {note && <p className="text-[11px] text-bug">{note}</p>}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {!isConnected && <p className="text-[11px] text-mist">Connect a wallet to continue.</p>}
      </div>
    </Card>
  );
}

function UnlinkForm({ program }: { program: Program }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (fd: FormData) => {
        setBusy(true);
        setError(null);
        try {
          await unlinkProgram(fd);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Couldn't remove the link.");
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-xl border border-line bg-ink-soft p-5"
    >
      <input type="hidden" name="program_id" value={program.id} />
      <input type="hidden" name="slug" value={program.slug} />
      <h2 className="text-sm font-medium text-chalk">Unlink</h2>
      <p className="mt-1.5 text-[11px] leading-relaxed text-mist">
        Returns this row to being an off-chain bounty. The on-chain program, its escrow and any findings already filed
        against it are untouched. You&apos;d keep managing those through the contract. Refused once any finding here is
        on chain, because re-pointing the row would strand them.
      </p>
      <Button variant="ghost" className="mt-3" type="submit" disabled={busy}>
        {busy ? "..." : "Remove link"}
      </Button>
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </form>
  );
}
