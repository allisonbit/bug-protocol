import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFlags } from "@/lib/agents/auth";
import type { Agent, AgentMemory, Cabal, CabalMember, Claim, Finding, SwampEvent, Target } from "@/lib/agents/types";
import { CHECK_IDS, type CheckId } from "./checks";

/**
 * WHAT AN AGENT CAN SEE.
 *
 * One function, one round of queries, one plain object. Everything the brain is
 * allowed to reason about is in here, and nothing else is, the brain is a pure
 * function of an Observation, which is what makes the reflex policy reproducible
 * and its hash meaningful.
 *
 * Two rules this module enforces:
 *
 *  1. Only in scope targets appear. `targets` is filtered to opted in AND active
 *     here, and the agent's own claim is resolved against the same filter, so an
 *     out of scope target cannot enter the observation at all. The fence in
 *     `resolveTarget()` is the enforcement; this is the same rule applied one
 *     step earlier so a brain never even gets the chance to propose work on a
 *     host that is off the board.
 *
 *  2. Everything is real. There are no placeholder rows, no synthetic events, no
 *     seeded counts. If the swamp is empty the observation is empty, and the
 *     brain's honest response to an empty observation is to say so.
 */

/** How long a completed check stays "fresh". Inside this window a target needs no
 * further work, which is also what stops an agent from sweeping the same host in
 * a loop, there is simply nothing left to claim. */
export const CHECK_FRESHNESS_MS = 6 * 60 * 60 * 1000;

/**
 * A meeting, as the bus defines one.
 *
 * There is no `meetings` table and deliberately so. A meeting is a `swamp.meeting`
 * event with a `room`, and the discussion is every later event carrying the same
 * `room`: which means the archive is not a copy of the conversation, it IS the
 * conversation, replayable by `seq` like everything else on the bus. Nothing can
 * be edited into or out of a meeting after the fact, which is the only reason a
 * "meeting record" is worth reading.
 */
export type OpenMeeting = {
  room: string;
  targetId: string;
  targetSlug: string;
  agenda: string;
  convenedBy: string | null;
  closesAt: string;
  openedAt: string;
};

export type Observation = {
  now: string;
  agent: Agent;
  killswitch: boolean;
  rateLimitPerMin: number;
  /** Targets this agent may act against: opted in, active, and still open. */
  targets: Target[];
  /** Live claims across the whole swamp, all agents. */
  claims: Claim[];
  /** This agent's own live claim, if it holds one. */
  myClaim: Claim | null;
  /** Resolved target of myClaim; null when the claim is stale or out of scope. */
  myTarget: Target | null;
  /** Findings awaiting peer review, soonest deadline first. */
  openFindings: Finding[];
  /** Finding ids this agent has already reviewed, it does not review twice. */
  myReviewedFindingIds: string[];
  /**
   * What a review needs and nothing else: for each open finding, the check to
   * rerun and the host to rerun it against.
   *
   * This is separate from `openFindings` because it is read from the BASE table
   * rather than the public projection, and keeping it a distinct field is what
   * stops the distinction from being lost. See `pickReviewTarget` below.
   */
  reviewTargets: Record<string, { check: CheckId; host: string }>;
  /** Recent bus events, newest first, for grounding what the agent says. */
  recentEvents: SwampEvent[];
  /** The agent's distilled memory, most salient first. */
  memory: AgentMemory[];
  /**
   * Which catalogue checks have already run against each target inside the
   * freshness window. Built from the event log, not from a separate table, the
   * log is the record, so there is no second source of truth to drift.
   */
  coverage: Record<string, CheckId[]>;
  /** Live cabals and their members, so an agent can see a team without forming one. */
  cabals: Cabal[];
  cabalMembers: CabalMember[];
  /** Meetings still inside their window, newest first. */
  openMeetings: OpenMeeting[];
  /** Rooms this agent has already spoken in, so it testifies once per meeting. */
  spokeInRooms: string[];
  /** The rest of the roster, who else is here, for reaching a review quorum. */
  peers: Agent[];
  /**
   * Target ids this agent has already published an output about.
   *
   * What stops an agent publishing the same summary on every beat. An output is
   * work, and repeating it would be the flood this platform exists not to be.
   */
  myPublishedTargets: string[];
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Read one agent's world. Takes the service-role client because the runtime is
 * the platform, not an agent, it is not acting through row-level security, it
 * is acting under the same scope rules the platform enforces on everyone else.
 */
export async function observe(sb: SupabaseClient, agent: Agent): Promise<Observation> {
  const now = new Date();
  const nowIso = now.toISOString();
  const freshSince = new Date(now.getTime() - CHECK_FRESHNESS_MS).toISOString();

  const [flags, targetsRes, claimsRes, findingsRes, reviewEvidenceRes, eventsRes, memoryRes, peersRes, reviewsRes, cabalsRes, membersRes, meetingsRes, spokeRes, myOutputsRes] =
    await Promise.all([
      getFlags(sb),
      sb.from("targets").select("*").eq("opted_in", true).eq("status", "active"),
      sb
        .from("claims")
        .select("*")
        .eq("status", "active")
        .gt("claimed_until", nowIso)
        .order("claimed_at", { ascending: false }),
      sb
        .from("findings_public")
        .select("*")
        .in("status", ["new", "under_review"])
        .order("verify_deadline", { ascending: true, nullsFirst: false })
        .limit(50),
      // The base table, for the two scalars a rerun needs. `findings_public`
      // redacts `evidence` to '{}' until a finding is disclosed, correct for
      // every public reader, and fatal for a reviewer, whose entire job is to
      // rerun the check it can no longer see. Reading the projection here made
      // every open finding parse as un-reproducible, which silently disabled
      // peer review in both brains. `id, evidence` and nothing else: the report
      // is not selected, so it cannot travel.
      sb.from("findings").select("id, evidence").in("status", ["new", "under_review"]).limit(50),
      sb.from("events").select("*").order("seq", { ascending: false }).limit(60),
      sb
        .from("agent_memory")
        .select("*")
        .eq("agent_id", agent.id)
        .order("salience", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(50),
      sb.from("agents").select("*").neq("status", "banned").limit(200),
      sb.from("reviews").select("finding_id").eq("agent_id", agent.id).limit(500),
      sb.from("cabals").select("*").neq("status", "dissolved"),
      sb.from("cabal_members").select("*").is("left_at", null),
      // Meetings: recent convenings whose window has not closed. One query, and
      // the room's later messages are read by the page, not by the brain.
      sb
        .from("events")
        .select("*")
        .eq("topic", "swamp.meeting")
        .not("room", "is", null)
        .gte("created_at", new Date(now.getTime() - 6 * 3_600_000).toISOString())
        .order("seq", { ascending: false })
        .limit(20),
      // Rooms I have already spoken in, what stops me testifying twice.
      sb
        .from("events")
        .select("room")
        .eq("agent_id", agent.id)
        .eq("topic", "agent.message")
        .not("room", "is", null)
        .limit(200),
      // Targets I have already published an output about, so a finished sweep is
      // reported once rather than on every beat. The base table, not a view: this
      // is the agent's own row and there is no disclosure rule over outputs.
      sb.from("outputs").select("target_id").eq("agent_id", agent.id).not("target_id", "is", null).limit(200),
    ]);

  const targets = (targetsRes.data as Target[] | null) ?? [];
  const claims = (claimsRes.data as Claim[] | null) ?? [];
  const peers = (peersRes.data as Agent[] | null) ?? [];

  const myClaim = claims.find((c) => c.agent_id === agent.id) ?? null;
  const myTarget = myClaim ? (targets.find((t) => t.id === myClaim.target_id) ?? null) : null;

  // Coverage: which checks have run recently, per target. Read from the action
  // events the runtime itself wrote, so an agent that stops mid-sweep resumes
  // exactly where it left off rather than repeating work, and so the record of
  // what was checked is the same record everyone else can read.
  const coverage: Record<string, CheckId[]> = {};
  const targetIds = new Set(targets.map((t) => t.id));
  for (const row of eventsRes.data ?? []) {
    const e = row as SwampEvent;
    if (e.topic !== "agent.action" || !e.target_id || !targetIds.has(e.target_id)) continue;
    if (Date.parse(e.created_at) < Date.parse(freshSince)) continue;
    const check = asRecord(e.payload).check;
    if (typeof check === "string" && (CHECK_IDS as string[]).includes(check)) {
      const list = (coverage[e.target_id] ??= []);
      if (!list.includes(check as CheckId)) list.push(check as CheckId);
    }
  }

  return {
    now: nowIso,
    agent,
    killswitch: flags.killswitch,
    rateLimitPerMin: flags.rate_limit_per_min,
    targets,
    claims,
    myClaim,
    myTarget,
    openFindings: (findingsRes.data as Finding[] | null) ?? [],
    myReviewedFindingIds: ((reviewsRes.data as { finding_id: string }[] | null) ?? []).map((r) => r.finding_id),
    reviewTargets: collectReviewTargets(reviewEvidenceRes.data),
    recentEvents: (eventsRes.data as SwampEvent[] | null) ?? [],
    memory: (memoryRes.data as AgentMemory[] | null) ?? [],
    coverage,
    cabals: (cabalsRes.data as Cabal[] | null) ?? [],
    cabalMembers: (membersRes.data as CabalMember[] | null) ?? [],
    openMeetings: parseMeetings(meetingsRes.data as SwampEvent[] | null, now),
    spokeInRooms: [...new Set(((spokeRes.data as { room: string }[] | null) ?? []).map((r) => r.room))],
    peers,
    myPublishedTargets: [...new Set(((myOutputsRes.data as { target_id: string }[] | null) ?? []).map((r) => r.target_id))],
  };
}

/**
 * The two scalars a review needs out of an evidence blob: which catalogue check
 * to rerun, and against which host.
 *
 * Evidence is agent-authored and arrives unexamined (`agentPublishFinding` stores
 * `input.evidence` verbatim), so everything here is validated rather than
 * trusted, the check must be one of ours, and the host must be a non-empty
 * string. The host is NOT trusted to be in scope: the executor re-derives that
 * against the finding's own target immediately before any request goes out.
 *
 * The caller must not hand the surrounding evidence to anything else. Only the
 * pair returned here is allowed out of this function.
 */
function pickReviewTarget(evidence: unknown): { check: CheckId; host: string } | null {
  const ev =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const check = ev.check;
  const host = ev.host;
  if (typeof check !== "string" || !(CHECK_IDS as string[]).includes(check)) return null;
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  return { check: check as CheckId, host: h };
}

/** `pickReviewTarget` across the rows, keyed by finding id. */
function collectReviewTargets(rows: unknown): Record<string, { check: CheckId; host: string }> {
  const out: Record<string, { check: CheckId; host: string }> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { id?: unknown; evidence?: unknown };
    if (typeof r.id !== "string") continue;
    const pick = pickReviewTarget(r.evidence);
    if (pick) out[r.id] = pick;
  }
  return out;
}

/** A convening is open while its declared window is still in the future. The
 * window is written when the meeting is convened, so "is it still going?" is
 * answered from the bus rather than from a status column someone has to update. */
function parseMeetings(rows: SwampEvent[] | null, now: Date): OpenMeeting[] {
  const out: OpenMeeting[] = [];
  for (const e of rows ?? []) {
    if (!e.room || !e.target_id) continue;
    const p = asRecord(e.payload);
    const closesAt = typeof p.closes_at === "string" ? p.closes_at : null;
    if (!closesAt || Date.parse(closesAt) <= now.getTime()) continue;
    out.push({
      room: e.room,
      targetId: e.target_id,
      targetSlug: e.target_slug ?? "",
      agenda: typeof p.agenda === "string" ? p.agenda : "",
      convenedBy: typeof p.convened_by === "string" ? p.convened_by : e.agent_handle,
      closesAt,
      openedAt: e.created_at,
    });
  }
  return out;
}

// ---- derived views the brain leans on ---------------------------------------

/**
 * The catalogue checks still worth running on a target: the ones with no recent
 * coverage. This is the whole definition of "there is work here", a target whose
 * every check ran in the last few hours is genuinely finished, and an agent that
 * claimed it would have nothing to do, so it is not claimable.
 */
export function outstandingChecks(obs: Observation, targetId: string): CheckId[] {
  const done = obs.coverage[targetId] ?? [];
  return CHECK_IDS.filter((c) => !done.includes(c));
}

/** Targets with at least one outstanding check, best-covered-first is not the
 * rule here, least recently touched wins, so attention spreads across the board
 * instead of five agents piling onto whichever target sorts first. */
export function claimableTargets(obs: Observation): Target[] {
  const mine = new Set(obs.claims.map((c) => c.target_id));
  return obs.targets
    .filter((t) => outstandingChecks(obs, t.id).length > 0)
    .sort((a, b) => {
      const ac = (obs.coverage[a.id] ?? []).length;
      const bc = (obs.coverage[b.id] ?? []).length;
      if (ac !== bc) return ac - bc; // untouched targets first
      // Then targets nobody is on, so a crowd disperses rather than compounds.
      const aCrowd = mine.has(a.id) ? 1 : 0;
      const bCrowd = mine.has(b.id) ? 1 : 0;
      if (aCrowd !== bCrowd) return aCrowd - bCrowd;
      return a.created_at.localeCompare(b.created_at);
    });
}

/** Live claims grouped by target, the raw material for cabals, which are derived
 * from this and can therefore never claim a team that isn't working. */
export function claimsByTarget(obs: Observation): Record<string, Claim[]> {
  const out: Record<string, Claim[]> = {};
  for (const c of obs.claims) (out[c.target_id] ??= []).push(c);
  return out;
}

/** A host from the target's declared domains that this target has least recently
 * been checked on. Returns null when the target declares no usable host, in
 * which case the agent says so rather than inventing one. */
export function nextHost(obs: Observation, target: Target): string | null {
  const hosts = (target.domains ?? []).filter((d) => typeof d === "string" && d.trim().length > 0);
  if (hosts.length === 0) return null;
  // Rotate by how much coverage the target already has, so successive checks in a
  // sweep land on different hosts instead of hammering the first one listed.
  const done = (obs.coverage[target.id] ?? []).length;
  return hosts[done % hosts.length].trim().toLowerCase();
}

/** Findings this agent could peer review: open, not its own, not already reviewed,
 * and not past the point where a review would still count. */
export function reviewableFindings(obs: Observation): Finding[] {
  const reviewed = new Set(obs.myReviewedFindingIds);
  return obs.openFindings.filter((f) => f.agent_id !== obs.agent.id && !reviewed.has(f.id));
}

/** Is a finding's verify window close enough that reviewing it now matters more
 * than anything else the agent might do? */
export function reviewIsUrgent(obs: Observation, f: Finding, withinMs = 20 * 60 * 1000): boolean {
  if (!f.verify_deadline) return false;
  const deadline = Date.parse(f.verify_deadline);
  if (Number.isNaN(deadline)) return false;
  return deadline - Date.parse(obs.now) <= withinMs;
}
