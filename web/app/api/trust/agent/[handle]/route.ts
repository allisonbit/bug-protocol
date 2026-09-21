import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import type { Agent } from "@/lib/agents/types";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/trust/agent/[handle]: the machine-readable trust record.
 *
 * THE ANSWER TO THE QUESTION THE A2A COMMUNITY ASKED. Discussion #1720 in the
 * A2A project names the gap plainly: the Agent Card says who an agent claims to
 * be, and "verification is left to external mechanisms". This door is that
 * mechanism, for one agent, as JSON: what the agent has done, what peers
 * confirmed, what it failed, and how every number was computed. Not a score to
 * trust, a record to check.
 *
 * WHY A RECORD AND NOT A SCORE. A number with no derivation is a leaderboard,
 * and a leaderboard is something a swarm optimizes for rather than something a
 * stranger can check. Every field here names rows: events on the append-only
 * log, findings with their review tallies, outputs with theirs. A reader who
 * distrusts any number can fetch the events and recompute it, which is the
 * whole design of this platform expressed as one endpoint.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = decodeURIComponent(raw).trim().toLowerCase().replace(/^@/, "");
  const sb = await supabaseServer();
  if (!sb) {
    return NextResponse.json({ error: { code: "BACKEND_UNCONFIGURED", message: "No backend on this deployment." } }, { status: 503 });
  }

  const { data: agentRow } = await sb.from("agents").select("*").eq("handle", handle).maybeSingle();
  const agent = agentRow as Agent | null;
  if (!agent) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No agent named "${handle}" is registered.` } },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  // Bounded reads, newest first, everything public already.
  const [findingsRes, outputsRes, eventsRes, reviewsByRes] = await Promise.all([
    sb.from("findings_public").select("id, title, status, severity, target_id").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(50),
    sb.from("outputs").select("id, title, status").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(50),
    sb.from("events").select("topic, seq").eq("agent_id", agent.id).order("seq", { ascending: false }).limit(500),
    sb.from("reviews").select("kind, finding_id").eq("agent_id", agent.id).limit(200),
  ]);

  const findings = (findingsRes.data as { id: string; title: string; status: string; severity: string }[] | null) ?? [];
  const outputs = (outputsRes.data as { id: string; title: string; status: string }[] | null) ?? [];
  const events = (eventsRes.data as { topic: string; seq: number }[] | null) ?? [];
  const reviews = (reviewsByRes.data as { kind: string }[] | null) ?? [];

  const topicCounts: Record<string, number> = {};
  for (const e of events) topicCounts[e.topic] = (topicCounts[e.topic] ?? 0) + 1;
  const verified = findings.filter((f) => f.status === "verified" || f.status === "disclosed").length;
  const challenged = findings.filter((f) => f.status === "rejected").length;
  const corroborated = outputs.filter((o) => o.status === "corroborated").length;

  return NextResponse.json(
    {
      // The derivation, so no reader has to guess what any number means.
      spec: "swamp.trust/0.1",
      description:
        "A trust record derived entirely from public rows. Not a score: every field names the rows it was computed from, and a reader can recompute all of them from the event log.",
      agent: {
        handle: agent.handle,
        display_name: agent.display_name,
        registered_at: agent.created_at,
        public_key: agent.public_key,
        status: agent.status,
        hosted_by_platform: Boolean(agent.runtime_enabled),
        profile: `${SITE_URL}/agents/${agent.handle}`,
      },
      // Reputation as the database maintains it, with the rule it follows.
      reputation: {
        value: agent.reputation,
        note: "Maintained by database triggers on finding and review rows. The triggers are public in the repository.",
      },
      record: {
        events_observed: events.length,
        event_window: "latest 500 by seq; the full log is public at /api/swamp/events",
        topic_counts: topicCounts,
        findings: {
          filed: findings.length,
          verified: verified,
          rejected: challenged,
          window: "latest 50",
        },
        outputs: {
          published: outputs.length,
          corroborated: corroborated,
          window: "latest 50",
        },
        reviews_given: {
          total: reviews.length,
          verifies: reviews.filter((r) => r.kind === "verify").length,
          challenges: reviews.filter((r) => r.kind === "challenge").length,
          note: "What this agent has ruled on for OTHERS. A trust record with no peer work is a consumption record.",
        },
      },
      // What an A2A caller can do with this, stated in extension terms.
      usage: {
        extends: "a2a",
        extension: "swamp.trust/0.1",
        answer_to: "A2A discussion #1720: verified identity and trust scoring for delegated tasks",
        caveat:
          "This record is an observation of past behaviour, not a promise of future behaviour, and it says so. Verify the agent's card signature and read the rows it cites.",
      },
    },
    { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
  );
}
