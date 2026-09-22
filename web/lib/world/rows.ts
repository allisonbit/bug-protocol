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

/** Postgres's undefined_column, for a table that is installed and has since grown. */
const UNDEFINED_COLUMN = "42703";

/**
 * The built rooms, with their scope and purpose where the columns exist.
 *
 * `world_zones` is installed, and the two columns that make a room mean something
 * arrive with `migrate-room-scope.sql`. A deployment that has the table but not
 * yet the columns must still draw the ground it has, so the wider select is tried
 * first and the narrower one is the fallback: a room without a scope is an empty
 * district, which is exactly what every room was before this door existed, rather
 * than a reason to fail the whole reading.
 */
async function builtZoneRows(sb: Awaited<ReturnType<typeof supabaseServer>>) {
  if (!sb) return { data: [] as Record<string, unknown>[], error: null };
  const wide = await sb.from("world_zones").select("id, name, x, z, vote_id, scope, purpose").eq("status", "built");
  if (!wide.error || wide.error.code !== UNDEFINED_COLUMN) return wide;
  return sb.from("world_zones").select("id, name, x, z, vote_id").eq("status", "built");
}

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
    rooms: [],
    fixtures: [],
    machines: [],
    alerts: [],
    tasks: [],
    now: Date.now(),
  };
}

export async function getWorldRows(opts: { now?: number; untilSeq?: number; eventLimit?: number } = {}): Promise<WorldInput> {
  const now = opts.now ?? Date.now();
  /**
   * How much of the log a projection folds.
   *
   * This used to be 400, and 400 was a lie that only stayed hidden while the log
   * was shorter than the window. Two things in the town are derived from EVENTS
   * rather than from rows: a hall, which stands where a convening happened, and an
   * agent's house, whose height is the tier that agent has earned. With a window
   * narrower than the log, both go out of sight as unrelated events arrive, so the
   * town SHRINKS while the swarm keeps working, and the one thing the city is
   * supposed to prove, that the record only ever grows, stops being true.
   *
   * It did not show up until the log passed 400: verify-world's monotonicity check
   * ("the town at seq N is no larger than it is now") then failed, because a
   * convening had slid out of the live window and taken its hall with it.
   *
   * So the window is wide enough to hold the whole log as it stands, with the cap
   * left in place and raised rather than removed: a projection is served to every
   * visitor and has to stay bounded. When the log is genuinely large enough for
   * this to bite, the fix is to stop deriving halls and heights from events at all
   * and read them from rows, which is stated here because that is the real limit,
   * not this number.
   */
  const eventLimit = opts.eventLimit ?? 5000;
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

  const [agents, targets, claims, cabals, members, findings, outputs, sources, eventsRes, counts, reviewsRes, factsRes, hypothesesRes, endorsementsRes, bodiesRes, zonesRes, fixturesRes, machinesRes, machineCommandsRes, a2aTasksRes, machineReadingsRes, machineLeasesRes] =
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
      // `domain` is what a room claims, so the reading carries it: without it a
      // founded district could not know which of the swarm's facts are its own.
      sb.from("memory_facts").select("source_agent, key, domain").limit(4000),
      // `domain` is the scope a question is filed under, which is what a room the
      // swarm built matches on. A lab whose question belongs to a founded district
      // stands in that district rather than in the Vaults.
      sb.from("memory_hypotheses").select("id, claim, proposed_by, resolved_by, status, domain").limit(4000),
      sb.from("memory_skill_endorsements").select("agent_id").limit(4000),
      sb.from("agent_bodies").select("*"),
      builtZoneRows(sb),
      // Things agents built and stood in a room. `room_fixtures` arrives with
      // `migrate-room-fixtures.sql`, so before it is applied this read fails and
      // the town simply has no fixtures in it, which is true.
      sb
        .from("room_fixtures")
        .select("id, zone, agent_id, handle, name, what, url, created_at")
        .order("created_at", { ascending: true })
        .limit(2000),
      // Connected hardware. `machines` and `machine_commands` arrive with
      // `migrate-machines.sql`, and the same tolerance applies: before it is
      // applied the world has no machines standing at the Harbour, which is
      // exactly true rather than broken.
      sb.from("machines").select("id, name, kind, status, last_report_at").limit(1000),
      sb
        .from("machine_commands")
        .select("machine_id")
        .in("status", ["pending", "delivered"])
        .limit(2000),
      // Delegated work. `a2a_tasks` arrives with `migrate-a2a-tasks.sql`, and the
      // same tolerance applies as for machines: before it is applied the world has
      // no task board, which is exactly true rather than broken.
      sb
        .from("a2a_tasks")
        .select("id, state, message")
        .order("created_at", { ascending: false })
        .limit(60),
      // The newest reading per machine, for the trouble mark. Ordered newest
      // first and capped, then the projector takes the first row per machine:
      // one bounded query instead of one per machine.
      sb.from("machine_readings").select("machine_id, kind, created_at").order("created_at", { ascending: false }).limit(500),
      // Live authority, for the lease mark: unrevoked, unexpired and under its
      // ceiling. `machine_leases` arrives with `migrate-machine-leases.sql` and its
      // read policy with `migrate-lease-visibility.sql`, so before either is applied
      // the Harbour simply shows no leased machine, which is exactly true.
      sb
        .from("machine_leases")
        .select("machine_id, max_actuations, used_actuations")
        .is("revoked_at", null)
        .gt("expires_at", new Date(now).toISOString())
        .limit(1000),
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
      // The scope decides which rows stand here, and the purpose is what the
      // room's card answers "what is this for" with. Both are nullable on
      // purpose: a room that claims nothing is ground, not a fault.
      scope: typeof row.scope === "string" ? row.scope : null,
      purpose: typeof row.purpose === "string" ? row.purpose : null,
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
    hypotheses: optional(
      "world.hypotheses",
      hypothesesRes as Maybe<{ id: string; claim: string | null; proposed_by: string | null; resolved_by: string | null; status: string }>,
    ),
    endorsements: optional("world.endorsements", endorsementsRes as Maybe<{ agent_id: string }>),
    fixtures: optional("world.fixtures", fixturesRes as Maybe<WorldInput["fixtures"][number]>),
    machines: optional("world.machines", machinesRes as Maybe<WorldInput["machines"][number]>).map((m) => ({
      ...m,
      pending_commands: (optional("world.machine_commands", machineCommandsRes as Maybe<{ machine_id: string }>)).filter(
        (c) => c.machine_id === m.id,
      ).length,
      // A machine is leased when a live grant with actuations left names it. The
      // projector reads the same two bounds the doors enforce, so the mark cannot
      // say "authorized" about a lease that would refuse the command.
      leased: optional("world.machine_leases", machineLeasesRes as Maybe<{ machine_id: string; max_actuations: number; used_actuations: number }>).some(
        (l) => l.machine_id === m.id && l.used_actuations < l.max_actuations,
      ),
    })),
    // First row per machine IS the newest: the query is already newest first.
    alerts: optional("world.machine_readings", machineReadingsRes as Maybe<{ machine_id: string; kind: string; created_at: string }>)
      .filter((r, i, all) => all.findIndex((x) => x.machine_id === r.machine_id) === i),
    tasks: optional("world.a2a_tasks", a2aTasksRes as Maybe<{ id: string; state: string; message: { parts?: { kind?: string; text?: string }[] } | null }>).map(
      (t) => ({
        task_id: t.id,
        status: t.state,
        // The work, in the submitter's own words: the text parts joined, cut at
        // 240 characters so one long request cannot dominate a street. The cut
        // is a drawing constraint, not an edit; the full text stays on the row
        // and in the feed.
        work:
          (t.message?.parts ?? [])
            .filter((part) => (part.kind ?? "text") === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join(" ")
            .slice(0, 240) || "(no text parts)",
      }),
    ),
    // The convenings are not queried: a room exists only as events, so the fold in
    // `projectWorld` fills this in from the window it already read.
    rooms: [],
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
