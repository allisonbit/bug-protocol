import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { readAudit } from "@/lib/audit/store";
import { SEVERITIES, type Severity } from "@/lib/audit/skill-audit";
import { SITE_URL } from "@/lib/site";

/**
 * One audit, with the bytes it read and every dispute against it.
 *
 * The homepage of this surface says a verdict can be checked. This page is where that
 * happens: the document itself is here, so the digest below it can be recomputed by a
 * reader who trusts neither this deployment nor the skill's author. A verdict that
 * cannot be recomputed is a verdict that has to be believed, and belief is the thing
 * this surface exists to replace.
 */
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  clean: "text-bug",
  notes: "text-mist-bright",
  caution: "text-amber",
  risky: "text-warn",
  unsafe: "text-warn",
};

const SEV_TONE: Record<Severity, string> = {
  info: "text-mist",
  low: "text-mist-bright",
  medium: "text-amber",
  high: "text-warn",
  critical: "text-warn",
};

type Finding = {
  code: string;
  severity: Severity;
  title: string;
  why: string;
  evidence: string;
  where: string;
  line: number | null;
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Audit ${id.slice(0, 8)} — Swamp`, description: "One audit, the bytes it read, and every dispute against it." };
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = supabaseAdmin();
  if (!sb) notFound();
  const read = await readAudit(sb, id).catch(() => ({ ok: false as const, reason: "unreadable" }));
  if (!read.ok) notFound();

  const audit = read.audit;
  const findings: Finding[] = Array.isArray(audit.findings) ? (audit.findings as Finding[]) : [];
  const revisions = Array.isArray(audit.revisions) ? (audit.revisions as { verdict: string; at: string; because: string }[]) : [];

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <p className="text-xs tracking-[0.18em] text-mist uppercase">The audit record</p>
      <h1 className="mt-4 font-serif text-3xl leading-[1.1] tracking-tight sm:text-4xl">
        <span className={TONE[audit.verdict] ?? "text-chalk"}>{audit.verdict}</span>{" "}
        <span className="text-mist">{audit.kind}</span>
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-mist-bright">
        {audit.subject ? (
          <>
            Subject: <span className="font-mono text-xs text-chalk break-all">{audit.subject}</span>
          </>
        ) : (
          <>Subject: bytes submitted by {audit.submitted_by}, with no URL claimed.</>
        )}
      </p>
      <p className="mt-2 text-sm text-mist">
        {audit.source === "fetched"
          ? "This deployment fetched the document itself, under its own guard: https only, public addresses only, no redirect off the host, a byte cap and a timeout."
          : "The bytes were submitted by the caller. They were audited exactly as submitted, and the URL above, if any, is a claim about their origin that this audit did not check."}
      </p>

      <section className="mt-8 rounded-lg border border-white/10 bg-ink/40 p-4">
        <p className="text-sm leading-relaxed text-chalk">{audit.summary}</p>
        <p className="mt-2 font-mono text-xs text-mist break-all">
          {audit.bytes} bytes &middot; sha256 {audit.content_digest} &middot; {audit.engine}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-mist-bright">{audit.scope}</p>
        {revisions.length > 0 && (
          <p className="mt-3 text-xs leading-relaxed text-amber">
            This verdict has moved. It was {revisions.map((r) => r.verdict).join(" then ")} before{" "}
            {audit.verdict}, and each earlier verdict is kept rather than overwritten:{" "}
            {revisions.map((r) => r.because).join("; ")}.
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-serif text-xl tracking-tight">
          {findings.length === 0 ? "No findings" : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}
        </h2>
        {findings.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-mist">
            No rule fired on these bytes. That is a statement about this engine&rsquo;s rule set and this snapshot, and
            nothing more.
          </p>
        ) : (
          <ul className="mt-4 space-y-5">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className="rounded-lg border border-white/10 p-4">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className={`font-mono text-xs uppercase ${SEV_TONE[f.severity] ?? "text-chalk"}`}>{f.severity}</span>
                  <span className="font-mono text-xs text-chalk">{f.code}</span>
                  <span className="text-xs text-mist">
                    {f.where}
                    {f.line ? ` line ${f.line}` : ""}
                  </span>
                </div>
                <p className="mt-2 text-sm text-chalk">{f.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-mist">{f.why}</p>
                <pre className="mt-3 overflow-x-auto rounded border border-white/10 bg-ink/60 p-3 text-xs text-mist-bright">
{f.evidence}
                </pre>
                <p className="mt-2 text-xs text-mist">
                  Dispute it: <span className="font-mono">POST /api/audits/{audit.id}/challenges</span> with{" "}
                  <span className="font-mono">{`{"finding_code":"${f.code}","claim":"..."}`}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-serif text-xl tracking-tight">Challenges</h2>
        {read.challenges.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-mist">
            Nobody has disputed this audit. A challenge names one finding and is settled by rerunning the engine over
            the bytes below, in front of a second agent.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {read.challenges.map((c) => (
              <li key={c.id} className="rounded-lg border border-white/10 p-4">
                <p className="text-sm text-chalk">
                  @{c.challenger} disputes <span className="font-mono text-xs">{c.finding_code}</span>{" "}
                  <span className="text-mist">({c.status})</span>
                  {c.reviewer ? <span className="text-mist"> · reviewed by @{c.reviewer}</span> : null}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-mist">{c.claim}</p>
                {c.counter_evidence ? <p className="mt-1 text-xs text-mist-bright">{c.counter_evidence}</p> : null}
                {c.resolution ? (
                  <p className="mt-2 text-sm leading-relaxed text-chalk">{c.resolution}</p>
                ) : (
                  <p className="mt-2 text-xs leading-relaxed text-mist-bright">
                    Waiting for a reviewer other than its author. Rerun verdict: {c.rerun_verdict ?? "not yet run"}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-serif text-xl tracking-tight">The document this verdict is about</h2>
        <p className="mt-3 text-sm leading-relaxed text-mist">
          Kept for one purpose: settling a challenge against it. Hash it and compare: if sha256 of the text below is{" "}
          <span className="font-mono text-xs break-all text-chalk">{audit.content_digest}</span>, then every finding
          above is about exactly these bytes.
        </p>
        <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-white/10 bg-ink/60 p-4 text-xs leading-relaxed text-mist-bright">
{audit.content}
        </pre>
      </section>

      <footer className="mt-10 text-xs leading-relaxed text-mist">
        Severities this engine uses: {SEVERITIES.join(", ")}. Read the same audit on the bus by topic{" "}
        <span className="font-mono">audit.recorded</span>, and the machine-readable form at{" "}
        <Link className="underline decoration-dotted" href={`/api/audits/${audit.id}`}>
          {SITE_URL.replace(/^https?:\/\//, "")}/api/audits/{audit.id.slice(0, 8)}&hellip;
        </Link>
      </footer>
    </main>
  );
}
