"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient } from "wagmi";
import { bountyAbi } from "@/lib/contract";
import { useProgram, useProtocolMeta, useBounty, useExplorer } from "@/lib/reads";
import { useTx } from "@/lib/useTx";
import { useApprove } from "@/lib/useApprove";
import { commitmentFor, randomSalt, buildReceipt, downloadJson, downloadText, encryptReport } from "@/lib/commit";
import { saveEntry, attachSubmissionId } from "@/lib/vault";
import { fmtAmount, statusName } from "@/lib/format";
import { Button, Card, Copyable, Field, Input, SectionTitle, Textarea } from "@/components/ui";

export default function SubmitFinding({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pid = BigInt(id);
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { address: bounty, isDeployed } = useBounty();
  const explorer = useExplorer();
  const meta = useProtocolMeta();
  const { program } = useProgram(pid);
  const tx = useTx();
  const approve = useApprove();

  const [reportBody, setReportBody] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [reportURI, setReportURI] = useState("");
  const [salt, setSalt] = useState<`0x${string}` | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [encrypted, setEncrypted] = useState(false);

  useEffect(() => {
    setSalt(randomSalt());
  }, []);

  const commit = useMemo(
    () => (salt && address && reportURI.trim() ? commitmentFor(reportURI.trim(), salt, address) : null),
    [salt, address, reportURI],
  );

  const bondNeeded = meta.submissionBond ?? 0n;
  const canSubmit = isConnected && !!commit && downloaded && program?.status === 1;

  function doEncrypt() {
    if (!reportBody.trim() || !passphrase) return;
    encryptReport(reportBody, passphrase).then((env) => {
      downloadText(`bug-report-${id}.enc.json`, env, "application/json");
      setEncrypted(true);
    });
  }

  function doDownloadReceipt() {
    if (!salt || !address || !reportURI.trim()) return;
    const r = buildReceipt(id, address, reportURI.trim(), salt);
    downloadJson(`bug-commit-receipt-program-${id}.json`, r);
    saveEntry({
      programId: id,
      hunter: address,
      reportURI: reportURI.trim(),
      salt,
      commitHash: r.commitHash,
      createdAt: r.createdAt,
    });
    setDownloaded(true);
  }

  async function doSubmit() {
    if (!commit || !address || !salt || !bounty) return;
    if (bondNeeded > 0n && meta.bugToken) {
      const ok = await approve.ensure(meta.bugToken, address, bounty, bondNeeded);
      if (!ok) return;
    }
    // The id that will be assigned is the current nextSubmissionId.
    let assignedId: bigint | undefined;
    try {
      assignedId = (await publicClient?.readContract({
        address: bounty,
        abi: bountyAbi,
        functionName: "nextSubmissionId",
      })) as bigint;
    } catch {
      /* best-effort */
    }
    const hash = await tx.run({
      address: bounty,
      abi: bountyAbi,
      functionName: "submit",
      args: [pid, commit],
    });
    if (hash && assignedId) {
      attachSubmissionId(commit, String(assignedId));
      router.push(`/submissions/${assignedId}`);
    }
  }

  return (
    <section className="mx-auto max-w-3xl px-6 py-12">
      <Link href={`/programs/${id}`} className="text-xs text-mist hover:text-chalk">
        ← program #{id}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Submit a finding</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
        You commit to a report on chain without revealing it. The body stays encrypted and off-chain;
        only a hash is public. Binding your address into the hash means no one can copy it from the
        mempool and steal priority.
      </p>

      {program && program.status !== 1 && (
        <Card className="mt-6 border-warn/40 bg-warn/5 p-4">
          <p className="text-xs text-warn">This program is {statusName(program.status)}, not Live — submissions are closed.</p>
        </Card>
      )}

      <ol className="mt-8 space-y-8">
        {/* 1. encrypt (optional but encouraged) */}
        <li>
          <SectionTitle>1 · Write &amp; encrypt your report</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            Encrypt in-browser (AES-GCM). Publish the resulting file anywhere (IPFS, a gist) and use
            its URL below. Share the passphrase with the client over a side channel. Optional — you
            can also point at an already-published encrypted report.
          </p>
          <div className="mt-4 space-y-3">
            <Textarea rows={6} value={reportBody} onChange={(e) => setReportBody(e.target.value)} placeholder="Steps to reproduce, impact, PoC…" />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Passphrase (share with client separately)">
                <Input type="text" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="a strong shared secret" />
              </Field>
              <Button variant="ghost" disabled={!reportBody.trim() || !passphrase} onClick={doEncrypt}>
                encrypt &amp; download
              </Button>
              {encrypted && <span className="text-xs text-bug">✓ encrypted file downloaded</span>}
            </div>
          </div>
        </li>

        {/* 2. reportURI */}
        <li>
          <SectionTitle>2 · Where the report lives</SectionTitle>
          <div className="mt-4">
            <Field label="Report URI" hint="Public link to the encrypted report. This exact string is bound into your commit — it must not change.">
              <Input value={reportURI} onChange={(e) => setReportURI(e.target.value)} placeholder="ipfs://… or https://…" />
            </Field>
          </div>
        </li>

        {/* 3. commit */}
        <li>
          <SectionTitle>3 · Your commit</SectionTitle>
          <div className="mt-4 space-y-3 rounded border border-line bg-ink p-4 text-xs">
            <div>
              <span className="text-mist">salt </span>
              {salt ? <Copyable value={salt} /> : "…"}
            </div>
            <div>
              <span className="text-mist">commitHash </span>
              {commit ? <Copyable value={commit} /> : <span className="text-mist">enter a report URI first</span>}
            </div>
            <p className="text-mist">
              commit = keccak256(reportURI, salt, {address ? address.slice(0, 8) + "…" : "your address"})
            </p>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="ghost" disabled={!commit} onClick={doDownloadReceipt}>
              download receipt
            </Button>
            {downloaded ? (
              <span className="text-xs text-bug">✓ receipt saved — you can reveal later</span>
            ) : (
              <span className="text-xs text-warn">required: the salt can&apos;t be recovered if lost</span>
            )}
          </div>
        </li>

        {/* 4. submit */}
        <li>
          <SectionTitle>4 · Submit on chain</SectionTitle>
          <p className="mt-2 text-xs text-mist">
            {bondNeeded > 0n
              ? `Posts a refundable anti-spam bond of ${fmtAmount(bondNeeded, 18, "$BUG")}. Returned unless the report is judged spam.`
              : "No anti-spam bond currently required."}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" disabled={!canSubmit || tx.busy || !isDeployed} onClick={doSubmit}>
              {approve.state === "approving" ? "approving $BUG…" : tx.busy ? "submitting…" : "submit finding"}
            </Button>
            {!isConnected && <span className="text-xs text-mist">connect a wallet</span>}
            {!isDeployed && <span className="text-xs text-warn">contract not deployed yet</span>}
          </div>
          {(tx.error || approve.error) && <p className="mt-3 text-xs text-red-400">{tx.error ?? approve.error}</p>}
          {tx.hash && (
            <a className="mt-3 block text-xs text-bug underline" href={explorer.tx(tx.hash)}>
              view transaction ↗
            </a>
          )}
        </li>
      </ol>
    </section>
  );
}
