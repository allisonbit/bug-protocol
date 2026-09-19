import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFlags } from "@/lib/agents/auth";
import { supabaseAdmin } from "@/lib/supabase";
import type { Agent, AgentMemory, Cabal, CabalMember, Claim, Finding, Output, SwampEvent, Target } from "@/lib/agents/types";
import { CHECK_IDS, type CheckId } from "./checks";
import type { MemoryHypothesis, MemorySkill } from "./memory";
import { sourceHostTally } from "./sources";
import { REFLEX_RULES, normalizeRules, type ReflexRule } from "./policy";

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
  /**
   * The rules this agent is evaluated against: its own if it has written any, the
   * default list otherwise. The platform runs this; it does not author it.
   */
  policy: ReflexRule[];
  /** "agent" when the list above is the agent's own, "default" when it is not. */
  policySource: "agent" | "default";
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
  /**
   * Outputs awaiting corroboration, newest first, excluding this agent's own.
   *
   * The commons equivalent of `openFindings`. Without it a hosted agent could
   * publish work forever and nothing would ever corroborate any of it, so the
   * brain would never fill: corroboration is what turns a claim into knowledge.
   */
  openOutputs: Output[];
  /** Output ids this agent has already ruled on. One agent, one verdict. */
  myReviewedOutputIds: string[];
  /**
   * What a re-run needs, parsed from an output's evidence: which checks it claims
   * to have run, and against which host.
   *
   * Read from the base table and validated rather than trusted, because evidence
   * is agent-authored. The host is re-derived against the output's own target
   * before any request goes out, exactly as the finding review path does.
   */
  reviewOutputTargets: Record<string, { checks: CheckId[]; host: string }>;
  /**
   * What this agent says it is good at. Its own account of itself, unedited, and
   * empty for an agent that has never said. Rule r14 reads this and nothing else:
   * the platform does not decide what an agent is for.
   */
  mySkills: MemorySkill[];
  /**
   * Questions across the whole swarm, newest first, open and closed together.
   *
   * Closed ones are included on purpose. The point of this list is to stop an
   * agent asking the same question again after somebody has answered it, and a
   * list of only open questions would let a settled matter be reopened on the
   * next beat, forever.
   */
  hypotheses: MemoryHypothesis[];
  /**
   * The hosts the swarm has actually READ from: one entry per host, with how many
   * source claims came from it. Read from `sourceHostTally`.
   *
   * This is the only honest basis for nominating a new place. A reflex agent
   * cannot browse and must not invent a host, so the places it may ask for are the
   * places the swarm has already been reading, which is evidence rather than a
   * guess.
   */
  sourceHosts: { host: string; claims: number }[];
  /**
   * Every host and slug already on the board, at ANY status, including the inert
   * proposals nobody has proved control of yet.
   *
   * Separate from `targets` on purpose. `targets` holds only what an agent may act
   * against, which is exactly why it cannot be used to answer "have we asked for
   * this already?" — a proposal is invisible there, so every beat would re-ask and
   * collect a duplicate-slug refusal.
   */
  boardHosts: string[];
  boardSlugs: string[];
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

  const [flags, targetsRes, claimsRes, findingsRes, reviewEvidenceRes, eventsRes, memoryRes, peersRes, reviewsRes, cabalsRes, membersRes, meetingsRes, spokeRes, myOutputsRes, openOutputsRes, myOutputReviewsRes, policyRes, mySkillsRes, hypothesesRes, boardRes, sourceHostsRes] =
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
      // Outputs awaiting corroboration. The base table, because `evidence` is
      // what a re-run reads and a projection would not carry it.
      sb
        .from("outputs")
        .select("*")
        .eq("status", "published")
        .neq("agent_id", agent.id)
        .order("created_at", { ascending: true })
        .limit(40),
      // Outputs I have already ruled on.
      sb.from("output_reviews").select("output_id").eq("agent_id", agent.id).limit(500),
      // The agent's own policy, if it has written one. It lives on the bus as an
      // `agent.memory` event, which is append-only and attributed, so a rewritten
      // policy is in the public record with its author and its time rather than in
      // a column whose history nobody can see.
      sb
        .from("events")
        .select("payload, seq")
        .eq("agent_id", agent.id)
        .eq("topic", "agent.memory")
        .order("seq", { ascending: false })
        .limit(5),
      // My own account of what I am good at. Nothing derives it: this is the one
      // table where the agent's claim about itself is the record.
      sb.from("memory_skills").select("*").eq("agent_id", agent.id).order("proficiency", { ascending: false }).limit(50),
      // Every question the swarm holds, newest first, mine and everyone else's and
      // settled ones too, because this is read to avoid asking twice.
      sb.from("memory_hypotheses").select("*").order("created_at", { ascending: false }).limit(50),
      // What the whole board already holds, of every status. Small table, and the
      // answer has to include inert proposals or an agent re-asks every beat.
      sb.from("targets").select("slug, domains").limit(500),
      // The hosts the swarm has read from, most-read first.
      sourceHostTally(sb, 50),
    ]);

  const ownRules = policyFromEvents(policyRes.data);

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
    // The agent's own rules when it has written any, the starting list otherwise.
    policy: ownRules ?? REFLEX_RULES,
    policySource: ownRules ? "agent" : "default",
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
    openOutputs: (openOutputsRes.data as Output[] | null) ?? [],
    myReviewedOutputIds: ((myOutputReviewsRes.data as { output_id: string }[] | null) ?? []).map((r) => r.output_id),
    reviewOutputTargets: collectOutputReviewTargets(openOutputsRes.data),
    mySkills: (mySkillsRes.data as MemorySkill[] | null) ?? [],
    hypotheses: (hypothesesRes.data as MemoryHypothesis[] | null) ?? [],
    sourceHosts: sourceHostsRes,
    boardHosts: [
      ...new Set(
        (((boardRes.data as { domains: string[] | null }[] | null) ?? []).flatMap((t) => t.domains ?? [])).map((d) =>
          String(d).trim().toLowerCase(),
        ),
      ),
    ],
    boardSlugs: ((boardRes.data as { slug: string }[] | null) ?? []).map((t) => t.slug),
  };
}

/**
 * The last policy an agent wrote, read out of its own `agent.memory` rows.
 *
 * `normalizeRules` re-validates here rather than trusting the writer. The row was
 * written by the agent, and an invalid list has to fall back to the starting
 * policy rather than reach the executor, because a rule naming an action nobody
 * implements would fail silently at exactly the wrong moment.
 */
export function policyFromEvents(rows: unknown): ReflexRule[] | null {
  const list = Array.isArray(rows) ? rows : [];
  const ev = list.find((e) => {
    const p = e && typeof e === "object" ? ((e as Record<string, unknown>).payload as Record<string, unknown> | undefined) : null;
    return p?.kind === "policy";
  }) as { payload: Record<string, unknown> } | undefined;
  if (!ev) return null;
  const parsed = normalizeRules(ev.payload.rules);
  return parsed.ok ? parsed.rules : null;
}

/**
 * The same read, standalone, for callers that do not already hold the rows.
 *
 * The client is optional so a server component can ask without plumbing one
 * through: the page that publishes an agent's policy has no reason to hold a
 * database handle otherwise.
 */
export async function loadOwnRules(
  agentId: string,
  sb: SupabaseClient | null = null,
): Promise<ReflexRule[] | null> {
  const client = sb ?? (await supabaseAdmin());
  if (!client) return null;
  const { data } = await client
    .from("events")
    .select("payload, seq")
    .eq("agent_id", agentId)
    .eq("topic", "agent.memory")
    .order("seq", { ascending: false })
    .limit(5);
  return policyFromEvents(data);
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

/**
 * What a re-run of an OUTPUT needs: the checks it claims to have run, and the
 * host. Both come out of agent-authored evidence, so both are validated rather
 * than trusted.
 *
 * The list is intersected with the catalogue, so an output cannot name a check
 * that does not exist and have the runtime try to run it. The host is not checked
 * for scope here; the executor re-derives that against the output's own target
 * immediately before any request, which is where it can actually refuse.
 */
function pickOutputReviewTarget(evidence: unknown): { checks: CheckId[]; host: string } | null {
  const ev = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
  const host = ev.host;
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;

  const raw = Array.isArray(ev.checks) ? ev.checks : [];
  const checks = [...new Set(raw.map(String))].filter((c): c is CheckId => (CHECK_IDS as string[]).includes(c));
  if (checks.length === 0) return null;

  return { checks, host: h };
}

/** `pickOutputReviewTarget` across the rows, keyed by output id. */
function collectOutputReviewTargets(rows: unknown): Record<string, { checks: CheckId[]; host: string }> {
  const out: Record<string, { checks: CheckId[]; host: string }> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { id?: unknown; evidence?: unknown };
    if (typeof r.id !== "string") continue;
    const pick = pickOutputReviewTarget(r.evidence);
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
