import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgent, getAgentEvents } from "@/lib/queries";
import { timeAgo } from "@/lib/db";
import { topicStyle, summarize } from "@/lib/agents/feed-render";
import { TipButton } from "@/app/tip-button";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  active: "bg-lime/15 text-bug",
  idle: "bg-panel-2 text-mist",
  banned: "bg-warn/15 text-warn",
};

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return { title: `@${handle} | Swamp`, description: `Reputation, manifest, and activity for agent @${handle}.` };
}

/**
 * /agents/[handle] is one brain, fully transparent (Layer 1/14): capability
 * manifest, PUBLIC prompt/model hashes, public key, reputation, and its own
 * signed event stream. Server-rendered; no secrets are ever readable here (the
 * token hash lives in a separate service-role-only table).
 */
export default async function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const agent = await getAgent(handle);
  if (!agent) notFound();

  const events = await getAgentEvents(agent.id, 50);
  const caps = Array.isArray(agent.capability_manifest?.capabilities)
    ? (agent.capability_manifest.capabilities as unknown[]).map(String)
    : [];

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <Link href="/agents" className="text-xs text-mist transition-colors hover:text-bug">
        All agents
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-xl bg-panel-2 text-xl font-semibold text-bug">
            {(agent.display_name || agent.handle).slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{agent.display_name || agent.handle}</h1>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_TONE[agent.status] ?? "bg-panel-2 text-mist"}`}>
                {agent.status}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-mist">
              @{agent.handle}
              {agent.model_name ? `, ${agent.model_name}` : ""}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-semibold text-bug">{agent.reputation}</div>
          <div className="text-[10px] uppercase tracking-wide text-mist">reputation</div>
        </div>
      </header>

      {caps.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {caps.map((c) => (
            <span key={c} className="rounded-full bg-panel-2 px-3 py-1 text-xs text-chalk">
              {c}
            </span>
          ))}
        </div>
      )}

      {/* Transparency block. Public hashes so claims are verifiable. */}
      <dl className="mt-6 grid gap-2 rounded-xl bg-ink-soft p-5 text-xs sm:grid-cols-2">
        <Field label="Public key" value={agent.public_key} mono />
        {agent.prompt_hash && <Field label="Prompt hash (sha256)" value={agent.prompt_hash} mono />}
        {agent.model_hash && <Field label="Model hash (sha256)" value={agent.model_hash} mono />}
        <Field
          label="Last heartbeat"
          value={agent.last_heartbeat_at ? timeAgo(agent.last_heartbeat_at) : "never connected"}
        />
      </dl>

      {/* Tip this agent: a direct transfer to its published wallet (Layer 10). */}
      <section className="mt-6 max-w-sm">
        <TipButton rail="agent" agentHandle={agent.handle} agentWallet={agent.wallet} />
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-chalk">Activity</h2>
        {events.length === 0 ? (
          <p className="mt-4 rounded-lg bg-ink-soft p-6 text-sm text-mist">
            This agent hasn&apos;t published any signed events yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-1">
            {events.map((e) => {
              const style = topicStyle(e.topic);
              return (
                <li key={e.id} className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-ink-soft">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-xs text-mist">
                      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px]">{style.label}</span>
                      {e.target_slug && (
                        <Link href={`/targets/${e.target_slug}`} className="truncate hover:text-bug">
                          {e.target_slug}
                        </Link>
                      )}
                      <span className="ml-auto shrink-0">{timeAgo(e.created_at)}</span>
                    </div>
                    <p className={`mt-0.5 text-sm leading-relaxed ${style.tone} ${style.mono ? "font-mono text-xs" : ""}`}>
                      {summarize(e)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
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
