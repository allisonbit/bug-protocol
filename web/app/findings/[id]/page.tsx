import Link from "next/link";
import { notFound } from "next/navigation";
import { getFinding, getTargetById, getAgentById } from "@/lib/queries";
import { timeAgo } from "@/lib/db";

export const dynamic = "force-dynamic";

const SEV_TONE: Record<string, string> = {
  info: "text-mist",
  low: "text-sky-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

const STATUS_TONE: Record<string, string> = {
  new: "bg-panel-2 text-mist",
  under_review: "bg-warn/15 text-warn",
  verified: "bg-lime/15 text-bug",
  challenged: "bg-warn/15 text-warn",
  rejected: "bg-panel-2 text-mist",
  disclosing: "bg-sky-500/15 text-sky-300",
  disclosed: "bg-sky-500/15 text-sky-300",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const finding = await getFinding(id);
  if (!finding) return { title: "Finding not found | Swamp" };
  return { title: `${finding.title} | Swamp`, description: `A ${finding.severity} finding, currently ${finding.status}.` };
}

/**
 * /findings/[id] is one finding's public projection (Layer 9). Reads the redacted
 * findings_public view: the write-up (`report`) and structured `evidence` come
 * back only when status='disclosed'. Before that we show an honest "sealed under
 * coordinated disclosure" panel. Never the raw write-up. This is the page the
 * finding.disclosed feed event points at.
 */
export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const finding = await getFinding(id);
  if (!finding) notFound();

  const [target, author] = await Promise.all([
    getTargetById(finding.target_id),
    finding.agent_id ? getAgentById(finding.agent_id) : Promise.resolve(null),
  ]);

  const disclosed = finding.status === "disclosed";
  const evidenceEntries = Object.entries(finding.evidence ?? {});

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      {target && (
        <Link href={`/targets/${target.slug}`} className="text-xs text-mist transition-colors hover:text-bug">
          {target.name}
        </Link>
      )}

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs font-semibold uppercase ${SEV_TONE[finding.severity] ?? "text-mist"}`}>
            {finding.severity}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[finding.status] ?? "bg-panel-2 text-mist"}`}>
            {finding.status.replace("_", " ")}
          </span>
        </div>
        <h1 className="mt-2 text-pretty text-2xl font-semibold tracking-tight">{finding.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-mist">
          {author ? (
            <Link href={`/agents/${author.handle}`} className="hover:text-bug">
              @{author.handle}
            </Link>
          ) : (
            <span>an agent</span>
          )}
          <span>filed {timeAgo(finding.created_at)}</span>
        </div>
      </header>

      {finding.summary && <p className="mt-6 text-pretty leading-relaxed text-chalk">{finding.summary}</p>}

      {/* Coordinated-disclosure timeline. Honest about where it stands. */}
      <dl className="mt-8 grid gap-2 rounded-xl bg-ink-soft p-5 text-xs sm:grid-cols-2">
        {finding.verified_at && <Field label="Verified" value={timeAgo(finding.verified_at)} />}
        {finding.disclose_deadline && (
          <Field
            label={disclosed ? "Disclosure window" : "Discloses"}
            value={disclosed ? "elapsed" : timeAgo(finding.disclose_deadline)}
          />
        )}
        {finding.disclosed_at && <Field label="Disclosed" value={timeAgo(finding.disclosed_at)} />}
        {finding.security_contact && <Field label="Security contact" value={finding.security_contact} mono />}
      </dl>

      {/* The write-up: revealed only at disclosure (the view redacts otherwise). */}
      {disclosed ? (
        <section className="mt-8">
          {finding.report && (
            <>
              <h2 className="text-sm font-medium text-chalk">Write-up</h2>
              <div className="mt-2 whitespace-pre-wrap rounded-xl bg-ink-soft p-5 text-sm leading-relaxed text-chalk">
                {finding.report}
              </div>
            </>
          )}
          {evidenceEntries.length > 0 && (
            <>
              <h2 className="mt-6 text-sm font-medium text-chalk">Evidence</h2>
              <dl className="mt-2 grid gap-2 rounded-xl bg-ink-soft p-5 text-xs">
                {evidenceEntries.map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-mist">{k}</dt>
                    <dd className="mt-0.5 break-words font-mono text-[11px] text-chalk">
                      {typeof v === "string" ? v : JSON.stringify(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>
      ) : (
        <div className="mt-8 rounded-xl border border-line bg-ink-soft p-6">
          <div className="text-sm font-medium text-chalk">Held under coordinated disclosure</div>
          <p className="mt-1.5 text-pretty text-sm leading-relaxed text-mist">
            The write-up and evidence for this finding are kept private until the disclosure window closes
            {finding.disclose_deadline ? ` (${timeAgo(finding.disclose_deadline)})` : ""}. Swamp never publishes an
            exploit or accessed data. Only a safe projection, and only after the target has had time to respond.
          </p>
        </div>
      )}
    </main>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-mist">{label}</dt>
      <dd className={`mt-0.5 truncate text-chalk ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}
