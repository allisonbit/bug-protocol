import { supabaseServer } from "@/lib/supabase/server";
import { getAgents, getBoard, getCabalMembers, getCabals, getFeed, getFindings, getMemoryCounts, getOutputs, getTargets } from "@/lib/queries";
import { recentSources } from "@/lib/swamp/sources";
import type { SwampEvent } from "@/lib/agents/types";
import type { AuthoredBody, WorldInput } from "./types";
import type { ZoneDef } from "./zones";

/**
 * Every row the world reads, in one batch.
 *
 * Kept apart from the projector for one reason: the projector must stay pure and
 * testable with no database in the room, so all the I/O lives here and hands it
 * a plain object. That is what lets `verify-world.cjs` assert that the same rows
 * produce the same world without standing a server up to prove it.
 *
 * THE LAST TWO READS ARE TOLERANT, DELIBERATELY. `agent_bodies` and
 * `world_zones` arrive with `migrate-world.sql`; before it is applied, both
 * queries fail. That must not take the world down, because the world is drawn
 * from nine other tables that are already live: a missing body table means nobody
 * has authored a body yet, which is exactly what an empty map says. A world that
 * refused to render because an optional door was not yet installed would trade
 * something real for something additive.
 *
 * The same reasoning covers `42P01`, Postgres's "relation does not exist". A
 * genuinely broken query still goes to the logs, because a silent soft failure
 * makes a broken read indistinguishable from an empty one.
 */

function logRowError(name: string, error: { message: string } | null): void {
  if (error) console.error(`[world] ${name} failed: ${error.message}`);
}

/** Postgres's undefined_table. Expected, and harmless, before the door is installed. */
const UNDEFINED_TABLE = "42P01";

/** A read that may legitimately be absent: its rows, or an empty list, never a throw. */
type Maybe<T> = { data: T[] | null; error: { message: string; code?: string } | null };

function absentFor(fallback: string): WorldInput {
  return {
    agents: [],
    targets: [],
    claims: [],
    cabals: [],
    members: [],
    findings: [],
    outputs: [],
    sources: [],
    events: [],
    reviews: [],
    facts: [],
    hypotheses: [],
    endorsements: [],
    memory: { facts: 0, hypotheses: 0, skills: 0 },
    bodies: {},
    builtZones: [],
    now: Date.now(),
  };
}

export async function getWorldRows(opts: { now?: number; untilSeq?: number; eventLimit?: number } = {}): Promise<WorldInput> {
  const now = opts.now ?? Date.now();
  const eventLimit = opts.eventLimit ?? 400;
  const sb = await supabaseServer();
  if (!sb) return { ...absentFor("no backend"), now };

  /**
   * A replay at `untilSeq` must fold the log UP TO that point, so the window is
   * bound at the far end rather than taken newest first. Taking the newest four
   * hundred and filtering afterwards would show a visitor the wrong month.
   */
  const eventsQuery =
    opts.untilSeq != null
      ? sb.from("events").select("*").lte("seq", opts.untilSeq).order("seq", { ascending: false }).limit(eventLimit)
      : null;

  const [agents, targets, claims, cabals, members, findings, outputs, sources, eventsRes, counts, reviewsRes, factsRes, hypothesesRes, endorsementsRes, bodiesRes, zonesRes] =
    await Promise.all([
      getAgents(500),
      getTargets(),
      getBoard(),
      getCabals(200),
      getCabalMembers(),
      getFindings(undefined, 300),
      getOutputs(null, 300),
      recentSources(sb, {}),
      eventsQuery ?? getFeed(eventLimit),
      getMemoryCounts(),
      sb.from("reviews").select("agent_id, finding_id").limit(4000),
      sb.from("memory_facts").select("source_agent, key").limit(4000),
      sb.from("memory_hypotheses").select("proposed_by, resolved_by, status").limit(4000),
      sb.from("memory_skill_endorsements").select("agent_id").limit(4000),
      sb.from("agent_bodies").select("*"),
      sb.from("world_zones").select("id, name, x, z, vote_id").eq("status", "built"),
    ]);

  // `getFeed` returns bare rows; a bounded query returns a response envelope. Both
  // are legitimate, so the shape is normalised once here rather than at every use.
  let events: WorldInput["events"] = [];
  if (Array.isArray(eventsRes)) {
    events = eventsRes;
  } else if (eventsRes.error) {
    logRowError("world.events", eventsRes.error);
  } else {
    events = (eventsRes.data ?? []) as SwampEvent[];
  }

  /** Read one optional table: rows on success, nothing when the table is not installed. */
  function optional<T>(what: string, res: Maybe<T>): T[] {
    if (!res.error) return res.data ?? [];
    if (res.error.code !== UNDEFINED_TABLE) logRowError(what, res.error);
    return [];
  }

  const bodies: Record<string, AuthoredBody> = {};
  for (const row of optional("world.bodies", bodiesRes as Maybe<Record<string, unknown>>)) {
    const agentId = row.agent_id;
    if (typeof agentId !== "string") continue;
    bodies[agentId] = {
      form: (typeof row.form === "string" ? row.form : null) as AuthoredBody["form"],
      palette: typeof row.palette === "number" ? row.palette : null,
      traits: Array.isArray(row.traits) ? ((row.traits as unknown[]).filter((t): t is string => typeof t === "string") as AuthoredBody["traits"]) : [],
    };
  }

  const builtZones: ZoneDef[] = [];
  for (const row of optional("world.zones", zonesRes as Maybe<Record<string, unknown>>)) {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) continue;
    builtZones.push({
      id,
      name: typeof row.name === "string" ? row.name : id,
      source: `world_zones (built by vote ${typeof row.vote_id === "string" ? row.vote_id : "unrecorded"})`,
      kind: "built",
      position: { x: num(row.x), y: 0, z: num(row.z) },
      radius: 3.2,
      built: true,
    });
  }

  return {
    agents,
    targets,
    claims,
    cabals,
    members,
    findings,
    outputs,
    sources,
    events,
    reviews: optional("world.reviews", reviewsRes as Maybe<{ agent_id: string | null; finding_id: string }>),
    facts: optional("world.facts", factsRes as Maybe<{ source_agent: string | null; key: string }>),
    hypotheses: optional("world.hypotheses", hypothesesRes as Maybe<{ proposed_by: string | null; resolved_by: string | null; status: string }>),
    endorsements: optional("world.endorsements", endorsementsRes as Maybe<{ agent_id: string }>),
    memory: counts,
    bodies,
    builtZones,
    untilSeq: opts.untilSeq,
    now,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
