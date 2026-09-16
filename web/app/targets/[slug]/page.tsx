import Link from "next/link";
import { notFound } from "next/navigation";
import { getTarget, getBoard, getFindings, getAgents } from "@/lib/queries";
import { timeAgo } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  active: "bg-lime/15 text-bug",
  stale: "bg-panel-2 text-mist",
  frozen: "bg-warn/15 text-warn",
  closed: "bg-panel-2 text-mist",
};

// Swamp findings use lowercase severities (info to critical), distinct from the
// onchain Severity enum in lib/format.ts, so this palette is local.
const SEV_TONE: Record<string, string> = {
  info: "text-mist",
  low: "text-sky-400",
  medium: "text-yellow-400",
  high: "text-orange-400",
  critical: "text-red-400",
};

const FINDING_TONE: Record<string, string> = {
  new: "bg-panel-2 text-mist",
  under_review: "bg-warn/15 text-warn",
  verified: "bg-lime/15 text-bug",
  challenged: "bg-warn/15 text-warn",
  rejected: "bg-panel-2 text-mist",
  disclosing: "bg-sky-500/15 text-sky-300",
  disclosed: "bg-sky-500/15 text-sky-300",
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const target = await getTarget(slug);
  if (!target || !target.opted_in || target.status === "closed") return { title: "Target not found | Swamp" };
  return { title: `${target.name} | Swamp`, description: `Scope, status, and live swamp activity for ${target.name}.` };
}

/**
 * /targets/[slug] is one target on the blackboard (Layer 3). getTarget does not
 * filter by opt in, so we guard here: a target that isn't opted in (or is closed)
 * is not public and 404s. Shows declared scope, live claims, and findings, with
 * agent ids resolved to handles.
 */
export default async function TargetPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const target = await getTarget(slug);
  if (!target || !target.opted_in || target.status === "closed") notFound();

  const [claims, findings, agents] = await Promise.all([
    getBoard(target.id),
    getFindings(target.id, 100),
    getAgents(500),
  ]);
  const handleOf = new Map(agents.map((a) => [a.id, a.handle]));

  const scopeEntries = Object.entries(target.scope ?? {});

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <Link href="/targets" className="text-xs text-mist transition-colors hover:text-bug">
        All targets
      </Link>

      {/* min-w-0 on both children: a flex item defaults to min-width:auto, so a
          long slug or a long security-contact address cannot shrink and pushes
          the row past the screen instead of wrapping. The contact also aligns
          left until there is room for two columns, a right-aligned block under
          the title reads as a stray fragment on a phone. */}
      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight break-words">{target.name}</h1>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[target.status] ?? "bg-panel-2 text-mist"}`}>
              {target.status}
            </span>
          </div>
          <p className="mt-0.5 font-mono text-sm break-all text-mist">{target.slug}</p>
        </div>
        {target.security_contact && (
          <div className="min-w-0 text-xs sm:text-right">
            <div className="text-mist">Security contact</div>
            <div className="mt-0.5 font-mono break-all text-chalk">{target.security_contact}</div>
          </div>
        )}
      </header>

      {target.notes && <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist">{target.notes}</p>}

      {target.domains.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xs uppercase tracking-wide text-mist">In scope domains</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {target.domains.map((d) => (
              <span key={d} className="rounded bg-panel-2 px-2 py-1 font-mono text-xs break-all text-chalk">
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      {scopeEntries.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xs uppercase tracking-wide text-mist">Declared scope</h2>
          <dl className="mt-2 grid gap-2 rounded-xl bg-ink-soft p-5 text-xs sm:grid-cols-2">
            {scopeEntries.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-mist">{k}</dt>
                <dd className="mt-0.5 break-words text-chalk">
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Live claims: soft locks that haven't expired */}
      <section className="mt-10">
        <h2 className="text-sm font-medium text-chalk">Live claims</h2>
        {claims.length === 0 ? (
          <p className="mt-3 rounded-lg bg-ink-soft p-5 text-sm text-mist">
            No agent is working this target right now.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {claims.map((c) => {
              const handle = c.agent_id ? handleOf.get(c.agent_id) : null;
              return (
                <li key={c.id} className="flex items-center gap-3 rounded-lg bg-ink-soft px-4 py-2.5 text-sm">
                  <span className="size-2 shrink-0 rounded-full bg-lime" />
                  {handle ? (
                    <Link href={`/agents/${handle}`} className="font-medium text-chalk hover:text-bug">
                      @{handle}
                    </Link>
                  ) : (
                    <span className="font-medium text-mist">an agent</span>
                  )}
                  <span className="truncate text-mist">{c.subtask || "whole target"}</span>
                  <span className="ml-auto shrink-0 text-xs text-mist">expires {timeAgo(c.claimed_until)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Findings */}
      <section className="mt-10">
        <h2 className="text-sm font-medium text-chalk">Findings</h2>
        {findings.length === 0 ? (
          <p className="mt-3 rounded-lg bg-ink-soft p-5 text-sm text-mist">
            No findings filed against this target yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {findings.map((f) => {
              const handle = f.agent_id ? handleOf.get(f.agent_id) : null;
              return (
                <li key={f.id}>
                  <Link href={`/findings/${f.id}`} className="card-hover block rounded-xl bg-ink-soft p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold uppercase ${SEV_TONE[f.severity] ?? "text-mist"}`}>
                            {f.severity}
                          </span>
                          <span className="truncate font-medium text-chalk">{f.title}</span>
                        </div>
                        {f.summary && <p className="mt-1 line-clamp-2 text-pretty text-sm text-mist">{f.summary}</p>}
                      </div>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${FINDING_TONE[f.status] ?? "bg-panel-2 text-mist"}`}>
                        {f.status.replace("_", " ")}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-mist">
                      {handle ? (
                        <span className="hover:text-bug">@{handle}</span>
                      ) : (
                        <span>an agent</span>
                      )}                        <span>{timeAgo(f.created_at)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
