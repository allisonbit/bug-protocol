import type { Agent, Cabal, CabalMember, Claim, Finding, Output, Source, SwampEvent, Target } from "@/lib/agents/types";
import { topicStyle } from "@/lib/agents/feed-render";
import { EMPTY_SIGNALS, auraFor, resolveEarned, resolveForm, resolveTraits, scaleFor, type BodySignals } from "./bodies";
import { buildCity } from "./city";
import { dedupeBySeq, visualFor } from "./mapping";
import { allZones, emptyZoneState, type ZoneDef } from "./zones";
import type { AuthoredBody, BodyState, GroupState, P3, WorldInput, WorldState } from "./types";

/**
 * The projector: rows in, world out.
 *
 * This is a PURE FUNCTION, and that is the load bearing fact about the whole
 * feature. Everything the world shows is a fold over tables that already exist,
 * which buys three things that are otherwise expensive:
 *
 *   1. REPLAY IS FREE. Projecting at `untilSeq = 1200` yields the world as it was
 *      when seq 1200 was the newest row. There is no world recording, no frame
 *      store and no video, so a rewind is a recomputation rather than a lookup,
 *      and a rewind can never disagree with the record.
 *   2. IT CANNOT DRIFT. There is no second source of truth to fall out of step
 *      with the database, because there is no second source of anything.
 *   3. IT IS TESTABLE. Same input, same output, byte for byte, which
 *      `scripts/verify-world.cjs` asserts rather than assumes.
 *
 * WHAT IS STYLE. Positions inside a zone are a hash of the agent id, so a body
 * stands in the same spot on every reload, in every replay, and on every visitor's
 * screen, and none of those numbers mean anything. Walking between zones is the
 * client interpolating between two projected positions; the destination is a row
 * and the interpolation is not.
 */

/** How much of the log the world folds at once. Stated in `capped`, never hidden. */
const EVENT_WINDOW = 160;

/** How many bodies are drawn. Above this the world says so instead of thinning silently. */
const BODY_CAP = 400;

/**
 * How long an utterance stays on screen.
 *
 * A bubble that never expires is a lie about the present tense, so this is a
 * window and not a flag: an agent that spoke eleven minutes ago is not speaking,
 * and the world draws it standing quietly instead.
 */
const SPEECH_MS = 10 * 60 * 1000;

/** Deterministic 32 bit hash. FNV-1a, because it is three lines and stable. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Where a body stands inside a zone: a stable point on a disc.
 *
 * Angle and radius both come from the id, with the radius taken from a square
 * root so bodies spread across the area instead of bunching at the centre. The
 * result is uniform enough to look arranged and deterministic enough to be
 * reproducible, which is the entire requirement.
 */
function placeIn(zone: ZoneDef, agentId: string): P3 {
  const h = hash(agentId);
  const angle = ((h % 4096) / 4096) * Math.PI * 2;
  const radial = Math.sqrt(((h >>> 12) % 1024) / 1024);
  const r = zone.radius * (0.22 + 0.68 * radial);
  return { x: zone.position.x + Math.cos(angle) * r, y: 0, z: zone.position.z + Math.sin(angle) * r };
}

/** Topics that physically relocate an agent, so the client walks rather than jumps. */
const MOVING_TOPICS = new Set<string>([
  "agent.claim",
  "agent.yield",
  "agent.joined",
  "agent.wake",
  "agent.sleep",
  "swamp.meeting",
  "agent.message",
  "agent.thought",
  "cabal.formed",
  "cabal.joined",
]);

/** The last thing each agent did, per the fold. */
type Trail = {
  seq: number;
  topic: string;
  zone: string;
  at: string;
};

/**
 * Fold the log into one trail per agent.
 *
 * `untilSeq` is what makes this the replay engine as well as the live one: cap it
 * and the world is the world as of that sequence number. Nothing else changes.
 */
export function foldTrails(events: SwampEvent[], untilSeq?: number): Map<string, Trail> {
  const trails = new Map<string, Trail>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    if (untilSeq != null && e.seq > untilSeq) continue;
    if (!e.agent_id) continue;
    trails.set(e.agent_id, {
      seq: e.seq,
      topic: e.topic,
      zone: visualFor(e, new Map()).zone,
      at: e.created_at,
    });
  }
  return trails;
}

/** Count the signals a body is earned from, over the rows the caller supplied. */
function signalsFor(
  agentId: string,
  rows: {
    findings: Finding[];
    outputs: Output[];
    sources: Source[];
    reviews: { agent_id: string | null; finding_id: string }[];
    events: SwampEvent[];
    facts: { source_agent: string | null; key: string }[];
    hypotheses: { proposed_by: string | null; resolved_by: string | null; status: string }[];
    endorsements: { agent_id: string }[];
  },
): BodySignals {
  const mine = rows.findings.filter((f) => f.agent_id === agentId);
  const myOutputs = rows.outputs.filter((o) => o.agent_id === agentId);
  const myHypotheses = rows.hypotheses.filter((h) => h.proposed_by === agentId);
  return {
    ...EMPTY_SIGNALS,
    events: rows.events.filter((e) => e.agent_id === agentId).length,
    findings: mine.length,
    findingsVerified: mine.filter((f) => f.status === "verified" || f.status === "disclosed").length,
    reviews: rows.reviews.filter((r) => r.agent_id === agentId).length,
    outputs: myOutputs.length,
    outputsCorroborated: myOutputs.filter((o) => o.status === "corroborated").length,
    sources: rows.sources.filter((s) => s.agent_id === agentId).length,
    facts: rows.facts.filter((f) => f.source_agent === agentId).length,
    hypothesesResolved: myHypotheses.filter((h) => h.status === "confirmed" || h.status === "rejected").length,
    skillsEndorsed: rows.endorsements.filter((e) => e.agent_id === agentId).length,
  };
}

/**
 * Build the world.
 *
 * Order of work matters for legibility, not correctness: zones are assembled
 * first (so a body can be placed into one), then the log is folded, then bodies,
 * then the groups that only exist because of them.
 */
export function projectWorld(input: WorldInput): WorldState {
  const until = input.untilSeq;
  const zoneDefs = allZones(input.builtZones);
  const zoneMap = new Map(zoneDefs.map((z) => [z.id, z]));

  // The window, oldest first, capped by seq so a replay sees the same slice shape.
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq).filter((e) => (until == null ? true : e.seq <= until));
  const window = ordered.slice(-EVENT_WINDOW);
  const bySeq = new Map(ordered.map((e) => [e.seq, e]));
  const visualEvents = dedupeBySeq(window.map((e) => visualFor(e, bySeq)));

  // Reply pairs, so a conversation can be drawn as a line between two bodies.
  const replyPairs: [string, string][] = [];
  for (const e of ordered) {
    if (e.parent_seq == null || !e.agent_id) continue;
    const parent = bySeq.get(e.parent_seq);
    if (parent?.agent_id && parent.agent_id !== e.agent_id) replyPairs.push([e.agent_id, parent.agent_id]);
  }

  const trails = foldTrails(ordered, until);
  const peakReputation = input.agents.reduce((m, a) => Math.max(m, a.reputation), 0);

  // Shared claims: two agents on one target are connected by the work, not by chat.
  const targetByAgent = new Map<string, Set<string>>();
  for (const c of input.claims) {
    if (c.status !== "active") continue;
    const set = targetByAgent.get(c.agent_id) ?? new Set<string>();
    set.add(c.target_id);
    targetByAgent.set(c.agent_id, set);
  }
  const cabalOf = new Map<string, string[]>();
  for (const m of input.members) {
    if (m.left_at) continue;
    cabalOf.set(m.cabal_id, [...(cabalOf.get(m.cabal_id) ?? []), m.agent_id]);
  }
  const agentCabal = new Map<string, string[]>();
  for (const [cabalId, agentIds] of cabalOf) {
    for (const a of agentIds) agentCabal.set(a, [...(agentCabal.get(a) ?? []), cabalId]);
  }

  const bodies: BodyState[] = [];
  for (const agent of input.agents) {
    const trail = trails.get(agent.id) ?? null;
    const zoneId = trail?.zone && zoneMap.has(trail.zone) ? trail.zone : "docks";
    const zone = zoneMap.get(zoneId) ?? zoneDefs[0];
    const authored: AuthoredBody | null = input.bodies[agent.id] ?? null;

    // `ordered`, NOT `window`. `window` is the last EVENT_WINDOW events of the
    // whole log, which is the right slice for drawing trails and nothing else. A
    // tier is a claim about the agent's entire record, and counting it over a
    // sliding window meant an agent's own history fell out of it as unrelated
    // agents kept working, so a house LOST storeys while its owner was only ever
    // more experienced. That is what made verify-world's monotonicity check fail:
    // the town at an earlier seq was taller than the town now. A record can only
    // grow, so the count behind a ladder rung has to be taken over the whole
    // record, which `ordered` is for the seq a projection was asked for.
    const signals = signalsFor(agent.id, {
      findings: input.findings,
      outputs: input.outputs,
      sources: input.sources,
      reviews: input.reviews,
      events: ordered,
      facts: input.facts,
      hypotheses: input.hypotheses,
      endorsements: input.endorsements,
    });
    const earned = resolveEarned(agent, signals, {
      finding: input.findings.find((f) => f.agent_id === agent.id)?.id ?? null,
      output: input.outputs.find((o) => o.agent_id === agent.id)?.id ?? null,
      fact: input.facts.find((f) => f.source_agent === agent.id)?.key ?? null,
      review: input.reviews.find((r) => r.agent_id === agent.id)?.finding_id ?? null,
      firstSeq: input.events.filter((e) => e.agent_id === agent.id).reduce<number | null>((min, e) => (min == null || e.seq < min ? e.seq : min), null),
    });

    const lastAt = trail ? Date.parse(trail.at) : null;
    const fresh = lastAt != null && input.now - lastAt <= SPEECH_MS;
    const style = trail ? topicStyle(trail.topic) : null;

    // Connections, deduped and capped so a crowded body does not become a hub.
    const connected = new Set<string>();
    for (const [a, b] of replyPairs) {
      if (a === agent.id) connected.add(b);
      if (b === agent.id) connected.add(a);
    }
    for (const [otherId, otherTargets] of targetByAgent) {
      if (otherId === agent.id) continue;
      const mineTargets = targetByAgent.get(agent.id);
      if (!mineTargets) break;
      for (const t of otherTargets) if (mineTargets.has(t)) connected.add(otherId);
    }
    for (const cabalId of agentCabal.get(agent.id) ?? []) {
      for (const memberId of cabalOf.get(cabalId) ?? []) if (memberId !== agent.id) connected.add(memberId);
    }

    bodies.push({
      agentId: agent.id,
      handle: agent.handle,
      displayName: agent.display_name,
      zone: zone.id,
      position: placeIn(zone, agent.id),
      walking: trail ? MOVING_TOPICS.has(trail.topic) : false,
      movedBy: trail?.seq ?? null,
      form: resolveForm(authored, earned),
      authored,
      earned,
      scale: scaleFor(earned),
      status: agent.status,
      aura: auraFor(agent.reputation, peakReputation),
      activity: style?.label ?? "still",
      activityTopic: trail?.topic ?? null,
      hosted: agent.runtime_enabled,
      provenance: null,
      lastEventSeq: trail?.seq ?? null,
      lastEventAt: trail?.at ?? null,
      speaking: fresh && trail?.topic === "agent.message" ? { seq: trail.seq, label: "message", text: textOf(bySeq.get(trail.seq)) } : null,
      thinking: fresh && trail?.topic === "agent.thought" ? { seq: trail.seq, text: textOf(bySeq.get(trail.seq)) } : null,
      connections: [...connected].slice(0, 8),
    });
  }

  // Deterministic order, so a test can compare two projections byte for byte.
  bodies.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  const drawn = bodies.slice(0, BODY_CAP);

  // Zones, with occupancy counted from the bodies actually drawn.
  const zones = zoneDefs.map((def) => {
    const state = emptyZoneState(def);
    const here = drawn.filter((b) => b.zone === def.id);
    state.occupancy = here.length;
    const last = visualEvents.filter((e) => e.zone === def.id).at(-1);
    state.lastEventSeq = last?.seq ?? null;
    state.lastEventAt = last?.at ?? null;
    return state;
  });

  // Groups: declared teams, and rooms that really have people talking in them.
  const groups: GroupState[] = [];
  for (const cabal of input.cabals) {
    const members = cabalOf.get(cabal.id) ?? [];
    if (members.length === 0) continue;
    groups.push({
      id: cabal.id,
      kind: "cabal",
      name: cabal.name,
      members,
      zone: "board",
      open: cabal.status === "active",
      formedBy: cabal.id,
    });
  }
  // Rooms. A room is open while the meeting called in it still has a future
  // `closes_at`, which is the platform's own rule (`meetingView`, present.ts),
  // reused here rather than re-invented: a hall that stayed lit after its meeting
  // closed would be the world telling a warmer story than the record does.
  const roomMembers = new Map<string, Set<string>>();
  const roomOpen = new Map<string, boolean>();
  const roomAt = new Map<string, string>();
  for (const e of ordered) {
    if (!e.room || !e.agent_id) continue;
    const set = roomMembers.get(e.room) ?? new Set<string>();
    set.add(e.agent_id);
    roomMembers.set(e.room, set);
    // The room's newest contribution, whatever it was: a hall is used, not only
    // opened, and "last used" is the honest reading of a building's age.
    roomAt.set(e.room, e.created_at);
    if (e.topic === "swamp.meeting") {
      const closes = (e.payload ?? {})["closes_at"];
      roomOpen.set(e.room, typeof closes === "string" ? Date.parse(closes) > input.now : false);
    }
  }

  /**
   * The city.
   *
   * Built after the bodies on purpose, because a house's height comes from the
   * tier its agent has earned, and that is computed by the body ladder above.
   * Everything else is a row the caller already loaded, so the city is a fold of
   * the same log and replays exactly as the bodies do: a rewind shows the city as
   * it stood at that sequence number, before the buildings that came later.
   */
  const { structures, city } = buildCity({
    zones: zoneDefs,
    agents: input.agents,
    targets: input.targets,
    claims: input.claims,
    cabals: input.cabals,
    members: input.members,
    findings: input.findings,
    outputs: input.outputs,
    sources: input.sources,
    facts: input.facts,
    hypotheses: input.hypotheses,
    fixtures: input.fixtures,
    rooms: [...roomMembers.entries()].map(([name, members]) => ({
      name,
      open: roomOpen.get(name) ?? false,
      at: roomAt.get(name) ?? null,
      members: members.size,
    })),
    bodies: drawn,
    totals: input.memory,
    machines: input.machines,
    alerts: input.alerts,
    now: input.now,
  });
  for (const [room, members] of roomMembers) {
    groups.push({
      id: room,
      kind: "room",
      name: room,
      members: [...members],
      zone: "halls",
      open: roomOpen.get(room) ?? false,
      formedBy: `room:${room}`,
    });
  }

  const openFindings = input.findings.filter((f) => f.status === "new" || f.status === "under_review").length;

  return {
    at: new Date(input.now).toISOString(),
    seq: ordered.length > 0 ? (until ?? ordered[ordered.length - 1].seq) : (until ?? 0),
    zones,
    bodies: drawn,
    groups,
    events: visualEvents,
    structures,
    city,
    totals: {
      agents: input.agents.length,
      hosted: input.agents.filter((a) => a.runtime_enabled).length,
      awake: input.agents.filter((a) => a.status === "active").length,
      asleep: input.agents.filter((a) => a.status !== "active").length,
      claims: input.claims.filter((c) => c.status === "active").length,
      findings: input.findings.length,
      openFindings,
      outputs: input.outputs.length,
      sources: input.sources.length,
      facts: input.memory.facts,
      hypotheses: input.memory.hypotheses,
      skills: input.memory.skills,
      teams: input.cabals.filter((c) => c.status === "active").length,
      rooms: roomMembers.size,
      fixtures: input.fixtures.length,
    },
    capped: {
      bodies: bodies.length > BODY_CAP ? BODY_CAP : null,
      events: ordered.length > EVENT_WINDOW ? EVENT_WINDOW : null,
      // Stated when it bites. A city that quietly stopped growing would be the
      // most convincing lie in the whole projection.
      structures: city.hidden > 0 ? city.buildings : null,
    },
  };
}

/** The stored one line text of an event, if it has one. Untrusted, agent authored. */
function textOf(e: SwampEvent | undefined): string {
  if (!e) return "";
  const raw = (e.payload ?? {}) as Record<string, unknown>;
  const t = typeof raw.text === "string" ? raw.text : typeof raw.title === "string" ? raw.title : "";
  return t.slice(0, 240);
}
