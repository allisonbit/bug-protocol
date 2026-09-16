"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain } from "wagmi";
import { decodeEventLog, type Address } from "viem";
import { submitFinding } from "@/app/actions";
import { commitmentFor, randomSalt, buildReceipt, downloadJson, encryptReport } from "@/lib/commit";
import { saveEntry } from "@/lib/vault";
import { bountyAbi, bountyEventsAbi } from "@/lib/contract";
import { useProtocolMeta, useBounty } from "@/lib/reads";
import { useTx, humanizeError } from "@/lib/useTx";
import { useApprove } from "@/lib/useApprove";
import { chainMeta } from "@/lib/chains";
import { short, fmtAmount } from "@/lib/format";
import { money, severityMeta, SEVERITIES, type Severity } from "@/lib/db";
import { Button, Copyable, Field, Input, Select, Textarea } from "@/components/ui";

type FormProgram = {
  id: string;
  slug: string;
  currency: string;
  tier_low: number;
  tier_medium: number;
  tier_high: number;
  tier_critical: number;
  onchain_program_id: number | null;
  chain_id: number | null;
};

/**
 * The hunter's side of the loop: encrypt, commit, receipt, submit.
 *
 * Three rules shape the ordering, and none of them are negotiable:
 *
 *  1. **The salt is persisted before anything is signed.** Losing it means the
 *     report can never be revealed, so the receipt is downloaded and written to
 *     the local vault *before* the wallet is ever asked to send a transaction.
 *     If the transaction then fails, the hunter still holds a valid commit.
 *
 *  2. **Encryption happens here, in the browser.** The plaintext never leaves the
 *     device; the server stores an AES-GCM envelope it cannot read, and the
 *     passphrase goes to the owner over a side channel.
 *
 *  3. **The report URI is content-addressed and is fixed before submission.**
 *     `reportURI` is inside the commit preimage, so it has to be known before we
 *     send anything, but the ciphertext doesn't exist on a server yet. Hashing
 *     the envelope locally and committing to `/api/reports/<sha256>` resolves the
 *     deadlock, and because the URI is the hash of the bytes, a stranger can later
 *     verify the stored envelope is the one that was committed to.
 */
export function SubmitForm({
  program,
  hunterWallet,
}: {
  program: FormProgram;
  hunterWallet: string | null;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const protocol = useProtocolMeta();
  const { address: bountyAddress } = useBounty();
  const approve = useApprove();
  const submitTx = useTx();

  const escrowed = program.onchain_program_id !== null;
  const targetChain = program.chain_id ?? chainId;
  const linkMeta = chainMeta(targetChain);
  const onRightChain = !escrowed || chainId === program.chain_id;

  const [severity, setSeverity] = useState<Severity>("medium");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [body, setBody] = useState("");
  const [pass, setPass] = useState("");
  const [encrypt, setEncrypt] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [receiptNote, setReceiptNote] = useState<string | null>(null);

  const tier = {
    low: program.tier_low,
    medium: program.tier_medium,
    high: program.tier_high,
    critical: program.tier_critical,
  }[severity as "low" | "medium" | "high" | "critical"];

  // A wallet that doesn't match the profile can't file against an escrowed
  // program. The server checks this too, but saying it now saves the hunter
  // writing a whole report first.
  const walletMismatch =
    escrowed && !!address && !!hunterWallet && address.toLowerCase() !== hunterWallet.toLowerCase();
  const needWallet = escrowed && !hunterWallet;

  const hunter = (address ?? undefined) as Address | undefined;

  /** A passphrase strong enough that the envelope is the weak link, not the key. */
  function generatePass() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const words = [...bytes].map((b) => b.toString(36)).join("");
    setPass(words.slice(0, 32));
  }

  async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const canSubmit = useMemo(() => {
    if (!title.trim() || !body.trim()) return false;
    if (encrypt && !pass.trim()) return false;
    if (escrowed && !address) return false;
    // Refused here rather than after a wallet signature: with no contract address
    // for this chain there is nothing to commit to, and the hunter would only
    // discover that once the report was already written.
    if (escrowed && !bountyAddress) return false;
    return true;
  }, [title, body, encrypt, pass, escrowed, address, bountyAddress]);

  async function run() {
    setError(null);
    setStage(null);
    if (!address) return setError("Connect a wallet first. The commit is bound to your address.");
    if (!title.trim() || !body.trim()) return setError("A title and a report body are required.");
    if (encrypt && !pass.trim()) return setError("Set a passphrase, or turn encryption off.");
    if (escrowed && !onRightChain) {
      switchChain({ chainId: targetChain });
      return setError(`Switch your wallet to ${linkMeta.short} to submit to this program.`);
    }
    if (escrowed && !hunterWallet) {
      return setError("Link your wallet in Settings first. It's how an escrowed finding is tied to you.");
    }
    if (walletMismatch) {
      return setError("This program pays the address that filed the commit. Switch to the wallet on your profile.");
    }

    setBusy("preparing...");
    try {
      // 1) Encrypt locally. The envelope is the only thing that ever leaves the
      //    browser, and only in ciphertext form.
      const envelope = encrypt ? await encryptReport(body, pass) : body;

      // 2) Content-address it. The hash of these exact bytes is the URI, so the
      //    URI is known before the ciphertext is stored anywhere.
      const hash = await sha256Hex(envelope);
      const reportURI = `${window.location.origin}/api/reports/${hash}`;

      // 3) Commit + receipt, saved before any signature.
      const salt = randomSalt();
      const commitHash = commitmentFor(reportURI, salt, hunter!);
      const receipt = buildReceipt(String(program.onchain_program_id ?? program.slug), hunter!, reportURI, salt);
      downloadJson(`bug-commit-receipt-${program.slug}-${Date.now()}.json`, receipt);
      saveEntry({
        programId: String(program.onchain_program_id ?? program.slug),
        hunter: hunter!,
        reportURI,
        salt,
        commitHash,
        createdAt: receipt.createdAt,
      });
      setReceiptNote(
        `Receipt downloaded. Keep it, because it holds the salt that reveals this report, and it cannot be recovered.`,
      );

      const fd = new FormData();
      fd.set("program_id", program.id);
      fd.set("slug", program.slug);
      fd.set("title", title.trim());
      fd.set("severity", severity);
      fd.set("target", target.trim());
      fd.set("report", envelope);
      fd.set("encrypted", encrypt ? "1" : "0");
      fd.set("commit_hash", commitHash);
      fd.set("report_uri", reportURI);
      fd.set("report_sha256", hash);

      if (escrowed && bountyAddress) {
        // 4) The spam bond is pulled by `submit` via transferFrom, so the
        //    allowance has to exist first.
        const bond = protocol.submissionBond ?? 0n;
        if (bond > 0n && protocol.bugToken) {
          setBusy("approving $BUG bond...");
          const ok = await approve.ensure(protocol.bugToken, address, bountyAddress, bond);
          if (!ok) {
            setError(approve.error ?? "The $BUG bond approval failed, so nothing was submitted.");
            setBusy(null);
            return;
          }
        }

        setBusy("committing on chain...");
        const tx = await submitTx.run({
          address: bountyAddress,
          abi: bountyAbi,
          functionName: "submit",
          args: [BigInt(program.onchain_program_id ?? 0), commitHash],
        });
        if (!tx || !publicClient) {
          setError(
            submitTx.error ??
              "The commit transaction didn't confirm. Your receipt is saved, so you can retry without losing it.",
          );
          setBusy(null);
          return;
        }

        const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
        const created = rcpt.logs
          .map((log) => {
            try {
              return decodeEventLog({ abi: bountyEventsAbi, data: log.data, topics: log.topics });
            } catch {
              return null;
            }
          })
          .find((e) => e?.eventName === "SubmissionCreated");
        const submissionId =
          created && created.eventName === "SubmissionCreated" ? created.args.submissionId : undefined;
        if (submissionId === undefined) {
          setError(
            "The commit confirmed but its SubmissionCreated event wasn't readable, so it couldn't be indexed. Your receipt is saved and the commit is on chain. Keep the receipt and the tx hash.",
          );
          setBusy(null);
          return;
        }

        fd.set("chain_id", String(program.chain_id));
        fd.set("onchain_submission_id", String(submissionId));
        fd.set("tx_hash", tx);
        setStage(`committed as onchain submission #${submissionId}`);
        setBusy("indexing...");
      } else {
        setBusy("recording...");
      }

      // 5) Index it. The server re-reads the chain before accepting any of the
      //    escrow fields, so nothing here is taken on trust. This redirects.
      await submitFinding(fd);
    } catch (e) {
      // Success travels out of the server action as a NEXT_REDIRECT; anything
      // else is a real failure the hunter needs to see.
      const digest = String((e as { digest?: string })?.digest ?? "");
      if (!digest.startsWith("NEXT_REDIRECT")) setError(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <Field label="Title">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Reentrancy in withdraw() drains the pool"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Severity you're claiming">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {severityMeta[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Affected target">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="app.acme.xyz / 0x... / repo path" />
        </Field>
      </div>

      <div className="rounded-lg border border-bug-dim/30 bg-bug-dim/[0.06] px-4 py-3 text-sm">
        <span className="text-mist">If accepted at this severity, this pays </span>
        <span className="font-semibold text-bug">{money(tier ?? 0, program.currency)}</span>
        <span className="text-mist"> The owner sets the final tier.</span>
      </div>

      <Field label="Report" hint="Summary, impact, and exact steps to reproduce. Markdown is fine.">
        <Textarea
          rows={14}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={"## Summary\n\n## Impact\n\n## Steps to reproduce\n1. \n2. \n\n## Suggested fix"}
          className="text-xs leading-relaxed"
        />
      </Field>

      {/* Encryption + passphrase */}
      <div className="rounded-xl border border-line bg-ink-soft p-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={encrypt}
            onChange={(e) => setEncrypt(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-bug)]"
          />
          <span className="text-xs leading-relaxed text-mist">
            <span className="text-chalk">Encrypt the report</span>: AES-GCM, entirely in this browser. The server
            stores ciphertext it cannot read. Give the passphrase to the program owner over a channel you trust;
            without it they cannot decrypt your report, and without the receipt you cannot prove it was yours.
          </span>
        </label>

        {encrypt && (
          <div className="mt-3">
            <Field label="Passphrase">
              <div className="flex gap-2">
                <Input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="a strong shared secret" />
                <Button variant="ghost" className="shrink-0" onClick={generatePass} type="button">
                  generate
                </Button>
              </div>
            </Field>
            {pass && (
              <p className="mt-1.5 text-[11px] text-mist">
                Send this to the owner yourself. It never leaves this page otherwise.{" "}
                <Copyable value={pass} display="copy passphrase" />
              </p>
            )}
          </div>
        )}
      </div>

      {/* Where it's going */}
      {escrowed ? (
        <div className="rounded-xl border border-line bg-ink-soft p-4 text-xs leading-relaxed text-mist">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-chalk">Escrowed onchain</span>
            <span className="rounded border border-line px-2 py-0.5 text-[11px]">
              program #{program.onchain_program_id} on {linkMeta.short}
            </span>
          </div>
          <p className="mt-2">
            Your report is committed before anyone can read it, so the timestamp is yours and cannot be back claimed.
            {protocol.submissionBond !== undefined && protocol.submissionBond > 0n && (
              <>
                {" "}
                A refundable spam bond of{" "}
                <span className="font-mono text-chalk">{fmtAmount(protocol.submissionBond, 18, "$BUG")}</span> is
                posted with the commit. It comes back unless the owner marks it spam, and you can dispute that to the
                arbiter for seven days.
              </>
            )}
          </p>
          {!isConnected && <p className="mt-2 text-chalk">Connect a wallet to submit.</p>}
          {!bountyAddress && (
            <p className="mt-2 text-amber-300">
              This deployment has no escrow contract address configured for {linkMeta.label}, so findings can&apos;t be
              committed here yet. The program will accept offchain reports once it&apos;s unlinked or the address is
              set.
            </p>
          )}
          {needWallet && (
            <p className="mt-2 text-amber-300">
              Your profile has no wallet linked, so an escrowed finding can&apos;t be attributed to you.{" "}
              <a href="/settings" className="underline underline-offset-4">
                Link it in Settings
              </a>
              .
            </p>
          )}
          {walletMismatch && (
            <p className="mt-2 text-amber-300">
              Connected wallet doesn&apos;t match the one on your profile ({short(hunterWallet ?? "")}). Switch wallets
              or update Settings. Escrow pays the committing address, not the account.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-ink-soft p-4 text-xs leading-relaxed text-mist">
          <span className="text-chalk">Offchain program.</span> You still get an encrypted report and a commit receipt
          that timestamps and binds your finding, but this program holds no escrow, so the reward is the owner&apos;s to
          honour rather than a contract&apos;s obligation.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={run}
          disabled={!canSubmit || !!busy || submitTx.busy || approve.state === "approving"}
          className="px-6"
        >
          {busy ?? (escrowed ? "Commit & submit onchain" : "Encrypt & submit")}
        </Button>
        {stage && <span className="text-[11px] text-bug">{stage}</span>}
      </div>

      {receiptNote && <p className="text-[11px] text-mist">{receiptNote}</p>}
      {(error || submitTx.error || approve.error) && (
        <p className="text-xs text-red-400">{error ?? submitTx.error ?? approve.error}</p>
      )}

      <p className="text-[11px] leading-relaxed text-mist">
        Your receipt is downloaded before any transaction is signed, and the salt is also kept in this browser. Lose
        both and the report can never be revealed: the salt isn&apos;t recoverable from the commit hash.
      </p>
    </div>
  );
}
