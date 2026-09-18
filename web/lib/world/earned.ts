import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/agents/types";
import { EMPTY_SIGNALS, resolveEarned, type BodySignals } from "./bodies";
import type { EarnedBody } from "./types";

/**
 * One agent's earned body, read from its own rows.
 *
 * The projector computes this for every agent at once from a batch it has already
 * fetched. This is the single agent version, and it exists for one reason: the
 * body door has to know an agent's budget at the moment it writes, and it must
 * answer from the record rather than from whatever the caller claimed. A door that
 * took the client's word for how much it had earned would be no door at all.
 *
 * Counted with narrow selects rather than head counts, because the same rows also
 * supply the citations the traits carry: when an agent is told it has unlocked
 * wings, it is told which facts put them there.
 */
export async function earnedBodyFor(sb: SupabaseClient, agent: Agent): Promise<EarnedBody> {
  const [findings, outputs, sources, reviews, facts, hypotheses, endorsements, firstEvent, eventCount] = await Promise.all([
    sb.from("findings").select("id, status").eq("agent_id", agent.id).limit(500),
    sb.from("outputs").select("id, status").eq("agent_id", agent.id).limit(500),
    sb.from("sources").select("id").eq("agent_id", agent.id).limit(500),
    sb.from("reviews").select("finding_id").eq("agent_id", agent.id).limit(500),
    sb.from("memory_facts").select("key").eq("source_agent", agent.id).limit(500),
    sb.from("memory_hypotheses").select("status").eq("proposed_by", agent.id).limit(500),
    sb.from("memory_skill_endorsements").select("agent_id").eq("agent_id", agent.id).limit(500),
    sb.from("events").select("seq").eq("agent_id", agent.id).order("seq", { ascending: true }).limit(1),
    sb.from("events").select("*", { count: "exact", head: true }).eq("agent_id", agent.id),
  ]);

  const findingRows = (findings.data ?? []) as { id: string; status: string }[];
  const outputRows = (outputs.data ?? []) as { id: string; status: string }[];
  const sourceRows = (sources.data ?? []) as { id: string }[];
  const reviewRows = (reviews.data ?? []) as { finding_id: string }[];
  const factRows = (facts.data ?? []) as { key: string }[];
  const hypRows = (hypotheses.data ?? []) as { status: string }[];
  const endorseRows = (endorsements.data ?? []) as { agent_id: string }[];

  const signals: BodySignals = {
    ...EMPTY_SIGNALS,
    events: eventCount.count ?? 0,
    findings: findingRows.length,
    findingsVerified: findingRows.filter((f) => f.status === "verified" || f.status === "disclosed").length,
    reviews: reviewRows.length,
    outputs: outputRows.length,
    outputsCorroborated: outputRows.filter((o) => o.status === "corroborated").length,
    sources: sourceRows.length,
    facts: factRows.length,
    hypothesesResolved: hypRows.filter((h) => h.status === "confirmed" || h.status === "rejected").length,
    skillsEndorsed: endorseRows.length,
  };

  return resolveEarned(agent, signals, {
    finding: findingRows[0]?.id ?? null,
    output: outputRows[0]?.id ?? null,
    fact: factRows[0]?.key ?? null,
    review: reviewRows[0]?.finding_id ?? null,
    firstSeq: (firstEvent.data as { seq: number }[] | null)?.[0]?.seq ?? null,
  });
}
