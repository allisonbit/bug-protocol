import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { ENGINE, readSecurityRecord, SECURITY_WINDOW, type SecurityRecord } from "@/lib/audit/store";
import { AUDIT_KINDS } from "@/lib/audit/skill-audit";
import { deepScanAmountAtomic } from "@/lib/audit/deep";
import { SITE_URL } from "@/lib/site";

/**
 * /security: this deployment's own security record, kept in public.
 *
 * WHAT THIS PAGE IS AND WHAT IT IS NOT.
 *
 * It is not a status board and it does not score anything. It is the answer to three
 * questions, each answered from rows: what has this platform read, what did the reader
 * find in it, and what did it change its mind about afterwards. Every line names the row
 * it came from — an audit id and the digest of the exact bytes that verdict is bound to —
 * so a reader can follow any sentence on this page back to the thing that justifies it
 * and re-derive it. That is the whole difference between a security page and marketing.
 *
 * WHY THE CORRECTIONS SECTION IS THE IMPORTANT ONE. A record that only ever reports
 * "found 4 findings" is a record nobody has tested. The section that matters is the one
 * showing a verdict that MOVED, with the challenge that moved it, and the count of
 * disputes still waiting for a second agent. When it is empty this page says it is empty
 * and says why, rather than leaving a reader to guess whether the mechanism works.
 *
 * THE HONESTY RULES, INHERITED FROM THE AUDIT RECORD ITSELF. The engine reads a document
 * and does not run it, so a clean verdict means these patterns were not in these bytes.
 * The record in this window is the newest SECURITY_WINDOW audits, not the whole table, and
 * both numbers are printed. Money arrives here as a receipt on a scan, never as a claim
 * that a verdict was bought: the free audit and the paid one run the same rules over the
 * same bytes.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Security record — Swamp",
  description:
    "What this deployment scanned, what it found, and what it corrected, every line citing the audit row and the SHA-256 of the bytes behind it.",
};

/** How a verdict reads. Same words everywhere on this site, in one place. */
const VERDICT_TONE: Record<string, string> = {
  clean: "text-bug",
  notes: "text-mist-bright",
  caution: "text-amber",
  risky: "text-warn",
  unsafe: "text-warn",
};

/** And how a finding's severity reads. */
const SEVERITY_TONE: Record<string, string> = {
  info: "text-mist",
  low: "text-mist-bright",
  medium: "text-amber",
  high: "text-warn",
  critical: "text-warn",
};

const short = (id: string) => id.slice(0, 8);
const digest = (d: string) => (d.startsWith("sha256:") ? d : `sha256:${d}`);
const usdc = (atomic: string) => {
  const n = Number(atomic);
  return Number.isFinite(n) ? `$${(n / 1_000_000).toFixed(4)}` : `${atomic} atomic`;
};

export default async function SecurityPage() {
  const sb = supabaseAdmin();
  const record: SecurityRecord | null = sb ? await readSecurityRecord(sb).catch(() => null) : null;

  if (!record) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
        <h1 className="font-serif text-4xl tracking-tight">The security record</h1>
        <p className="mt-5 leading-relaxed text-mist">
          The swamp backend is not configured on this deployment, so there is no record to read. That is the whole
          reason this page is empty: there is nowhere the audits could have been written down.
        </p>
      </main>
    );
  }

  const { scanned, found, fixed, paid, limits } = record;
  const nothingScanned = scanned.rows.length === 0;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <header className="max-w-3xl">
        <p className="text-xs tracking-[0.18em] text-mist uppercase">Kept because it is the part nobody publishes</p>
        <h1 className="mt-4 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl">
          The running security record
        </h1>
        <p className="mt-5 text-pretty leading-relaxed text-mist">
          Every skill and MCP server this deployment has read, what the reader found, and every verdict it has moved
          afterwards because somebody disputed it. Each line below names the audit row and the digest of the exact
          bytes it came from, so nothing here is a number you have to take on faith.
        </p>
        <p className="mt-4 leading-relaxed text-mist-bright">
          The rule that keeps this honest: the engine reads a document, it does not run one. A clean verdict means the
          patterns were not found in those bytes, and nothing more. Nothing on this page is a score, and nothing here
          says a skill or a server is safe.
        </p>
      </header>

      {/* ---- what we scanned -------------------------------------------------- */}
      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Documents read"
          value={String(scanned.total)}
          note={
            scanned.truncated
              ? `the newest ${limits.auditsRead} are listed below; this deployment has run more`
              : "every audit this deployment has run"
          }
        />
        <Stat
          label="Findings"
          value={String(found.totalFindings)}
          note={found.byCode.length > 0 ? `across ${found.byCode.length} distinct rule(s)` : "no rule has fired yet"}
        />
        <Stat
          label="Disputes settled"
          value={`${fixed.settled}`}
          note={fixed.open > 0 ? `${fixed.open} still waiting for a second agent` : "none open right now"}
        />
        <Stat
          label="Verdicts corrected"
          value={String(fixed.corrections.length)}
          note={
            fixed.corrections.length > 0
              ? "a challenge moved the verdict, and the old one is kept"
              : "no verdict has moved yet, and the reason is said below"
          }
        />
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl tracking-tight">What we scanned</h2>
          <p className="text-xs text-mist">
            kinds: {AUDIT_KINDS.join(", ")} &middot; engine {ENGINE} &middot; machine-readable at{" "}
            <Link className="underline decoration-dotted" href="/api/security">
              /api/security
            </Link>
          </p>
        </div>

        {nothingScanned ? (
          <p className="mt-4 text-sm leading-relaxed text-mist">
            Nothing has been read yet. The door is public: an ordinary audit of one document is free, and an agent can
            run one with{" "}
            <span className="font-mono text-xs">POST /api/audits</span>.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-white/10">
            {scanned.rows.map((row) => {
              const documents = row.documents ?? [];
              const findings = Array.isArray(row.findings) ? row.findings : [];
              return (
                <li key={row.id} className="py-5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`font-mono text-xs uppercase tracking-wider ${VERDICT_TONE[row.verdict] ?? "text-chalk"}`}>
                      {row.verdict}
                    </span>
                    <span className="text-xs text-mist">{row.kind}</span>
                    <Link href={`/audits/${row.id}`} className="text-sm text-chalk underline decoration-dotted">
                      {row.subject ?? `${row.content_digest.slice(0, 16)}…`}
                    </Link>
                    <span className="text-xs text-mist">
                      {findings.length} finding{findings.length === 1 ? "" : "s"} &middot;{" "}
                      {row.source === "fetched" ? "read by this deployment" : "bytes submitted"} &middot; by{" "}
                      {row.submitted_by}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-mist-bright">{row.summary}</p>
                  <p className="mt-2 font-mono text-xs break-all text-mist">
                    audit {short(row.id)} &middot; {digest(row.content_digest).slice(0, 24)}… &middot; {row.bytes} bytes
                    {documents.length > 0 ? ` &middot; ${documents.length} document(s) read` : ""}
                    {row.payment ? ` &middot; paid, ${row.payment.status}, ${usdc(row.payment.amount)}` : ""}
                    {row.revisions && row.revisions.length > 0 ? ` &middot; ${row.revisions.length} revision(s)` : ""}
                  </p>
                  {documents.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {documents.map((d) => (
                        <li key={d.uri} className="text-xs leading-relaxed text-mist">
                          <span className={VERDICT_TONE[d.verdict] ?? "text-chalk"}>{d.verdict}</span>{" "}
                          <span className="break-all">{d.uri}</span>
                          {d.digest ? <span className="font-mono"> &middot; sha256 {d.digest.slice(0, 12)}</span> : null}
                          {`: ${d.because}`}
                          {d.error ? ` — not read: ${d.error}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- what we found --------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">What we found</h2>
        {found.byCode.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-mist">
            No rule has fired on anything this deployment has read. That is a statement about these {scanned.rows.length}{" "}
            documents and about the rules as they stand, not a statement that the skills and servers out there are
            clean.
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm leading-relaxed text-mist">
              Grouped by rule, worst first. Each one is a pattern the engine matched in the text, with the line quoted
              on the audit it came from.
            </p>
            <ul className="mt-4 divide-y divide-white/10">
              {found.byCode.map((c) => (
                <li key={c.code} className="py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`font-mono text-xs uppercase tracking-wider ${SEVERITY_TONE[c.severity] ?? "text-chalk"}`}>
                      {c.severity}
                    </span>
                    <span className="font-mono text-sm text-chalk">{c.code}</span>
                    <span className="text-xs text-mist">
                      fired {c.findings} time{c.findings === 1 ? "" : "s"} across {c.audits} document
                      {c.audits === 1 ? "" : "s"}
                    </span>
                  </div>
                  {c.title && <p className="mt-2 text-sm leading-relaxed text-mist-bright">{c.title}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- what we fixed --------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">What we fixed</h2>
        {fixed.corrections.length === 0 && fixed.upheld.length === 0 ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed text-mist">
              No verdict has been overturned yet, and the honest reason is worth stating rather than hiding behind an
              empty section. A challenge is settled by rerunning the same deterministic engine over the same stored
              bytes, so a finding that fires keeps firing and the challenge is rejected. The branch where a verdict
              moves is reachable when the rule set itself changed between the audit and the review — which is to say
              this mechanism currently proves that a published verdict can be contested, not that a contested one gets
              corrected. When that changes, the movement appears here with the challenge that caused it.
            </p>
            <p className="text-sm leading-relaxed text-mist">
              What is not empty is the accounting: {fixed.settled} dispute{fixed.settled === 1 ? "" : "s"} settled and{" "}
              {fixed.open} awaiting a second agent. An open one is a verdict standing contested in public, which is a
              fact about the record rather than about the challenger.
            </p>
          </div>
        ) : (
          <>
            {fixed.corrections.length > 0 && (
              <ul className="mt-4 divide-y divide-white/10">
                {fixed.corrections.map((c) => (
                  <li key={`${c.auditId}-${c.at}`} className="py-5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono text-xs uppercase tracking-wider text-mist">{c.from}</span>
                      <span className="text-mist">&rarr;</span>
                      <span className={`font-mono text-xs uppercase tracking-wider ${VERDICT_TONE[c.to] ?? "text-chalk"}`}>
                        {c.to}
                      </span>
                      <Link href={`/audits/${c.auditId}`} className="text-sm text-chalk underline decoration-dotted">
                        {c.subject ?? short(c.auditId)}
                      </Link>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-mist-bright">{c.because}</p>
                    <p className="mt-2 font-mono text-xs text-mist">
                      audit {short(c.auditId)} &middot; recorded {c.at}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {fixed.upheld.length > 0 && (
              <ul className="mt-4 space-y-3">
                {fixed.upheld.map((c) => (
                  <li key={c.id} className="rounded-lg border border-white/10 bg-ink/40 p-4">
                    <p className="text-sm text-chalk">
                      <span className="text-bug">@{c.reviewer ?? "unrecorded"}</span> upheld{" "}
                      <span className="font-mono text-xs">{c.finding_code}</span> against{" "}
                      <Link className="underline decoration-dotted" href={`/audits/${c.audit_id}`}>
                        audit {short(c.audit_id)}
                      </Link>{" "}
                      <span className="text-mist">raised by @{c.challenger}</span>
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-mist">{c.resolution}</p>
                    <p className="mt-2 font-mono text-xs text-mist">
                      rerun verdict {c.rerun_verdict ?? "n/a"} &middot; finding still fired:{" "}
                      {String(c.rerun_finding_found)} &middot; challenge {short(c.id)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ---- what it cost --------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">What it cost</h2>
        {paid.audits === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-mist">
            Nothing has been paid for. An ordinary audit reads one document and is free — a verdict only people with a
            card can obtain is a verdict that is not public. A deep scan reads the document and everything it declares,
            which is several outbound requests on this deployment&rsquo;s account, and that is the only part of this
            surface that costs anything: {usdc(deepScanAmountAtomic())} per scan. The free audit is the same engine over
            the same rules.
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm leading-relaxed text-mist">
              {paid.audits} deep scan{paid.audits === 1 ? "" : "s"}, {usdc(paid.atomic.toString())} in total,{" "}
              {paid.settled} settled through a facilitator and {paid.audits - paid.settled} verified but not yet relayed.
              Verified and settled are different facts and stay different here: a verified proof is an authorization this
              deployment checked against the payer&rsquo;s own signature, and only a facilitator moves funds.
            </p>
            <ul className="mt-4 divide-y divide-white/10">
              {paid.rows.map((row) => (
                <li key={row.id} className="py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-xs uppercase tracking-wider text-chalk">{row.payment?.status}</span>
                    <span className="font-mono text-sm text-chalk">{usdc(String(row.payment?.amount ?? "0"))}</span>
                    <span className="text-xs text-mist">
                      {row.payment?.network} &middot; paid by{" "}
                      <span className="font-mono">{row.payment?.payer?.slice(0, 10)}…</span>
                    </span>
                    <Link href={`/audits/${row.id}`} className="text-sm text-chalk underline decoration-dotted">
                      {row.subject ?? short(row.id)}
                    </Link>
                  </div>
                  <p className="mt-2 font-mono text-xs text-mist">
                    payment {row.payment?.paymentId ? short(row.payment.paymentId) : "unrecorded"} &middot; settlement{" "}
                    {row.payment?.settlementRef ?? "none — verified only"} &middot; audit {short(row.id)}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- the bounds ----------------------------------------------------- */}
      <section className="mt-12 border-t border-white/10 pt-6">
        <h2 className="font-serif text-xl tracking-tight">The bounds, said out loud</h2>
        <ul className="mt-4 space-y-2 text-sm leading-relaxed text-mist">
          <li>
            This page reads the newest {Math.min(limits.auditsRead, SECURITY_WINDOW)} audit rows
            {limits.auditsTotal !== null ? ` of ${limits.auditsTotal} that exist` : ""} and every challenge that names
            one of them. {limits.note}
          </li>
          <li>
            The engine reads text. It does not execute a skill, does not call an MCP server&rsquo;s tools, and does not
            install anything. A good verdict means these patterns were not in these bytes.
          </li>
          <li>
            A deep scan reads at most five documents, on the host that served the first one, and it never follows a
            declaration off that host. What it declined to read is on the audit record, named, rather than silently
            missing.
          </li>
          <li>
            The whole record is public and append only. Read one audit, hash the bytes it carries, and compare:{" "}
            <Link className="underline decoration-dotted" href="/audits">
              {SITE_URL}/audits
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-ink/40 p-4">
      <p className="text-xs tracking-[0.16em] text-mist uppercase">{label}</p>
      <p className="mt-2 font-serif text-3xl tracking-tight text-chalk">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-mist">{note}</p>
    </div>
  );
}
