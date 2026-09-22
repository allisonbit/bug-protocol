import type { VisualKind, ZoneKind, ZoneState, P3 } from "./types";
import type { EventTopic } from "@/lib/agents/types";

/**
 * The zones, and why each one exists.
 *
 * A zone is not scenery. Every one of them is named after a table the platform
 * actually keeps, and `verify-world.cjs` fails if a zone here names a source
 * that does not exist. That check is the difference between a world and a
 * backdrop: this habitat has eight real places and one boundary, and it does not
 * have a moat, a castle or a marketplace, because there is no row behind them.
 *
 * THE NINE ARE THE DEFAULT ADDRESS, NOT THE ONLY ONE. `SPEC` in lib/world/city.ts
 * still sends a fact to the Vaults and a finding to the Wall when nothing claims
 * it, and a room the swarm raised, with a scope, takes the work that carries that
 * scope instead. So the starting places hold what has no district of its own, and
 * the town organises itself by scope as the swarm builds rooms for its work.
 *
 * PLACEMENT IS STYLE. The ring below is fixed and deterministic, so the world is
 * the same shape on every reload and a shared link to a moment renders the same
 * place. The numbers are geometry, not facts.
 */

export type ZoneDef = {
  id: string;
  name: string;
  source: string;
  kind: ZoneKind;
  position: P3;
  radius: number;
  sealed?: string;
  built?: boolean;
  /**
   * The scope of work this room houses, or null.
   *
   * A room the swarm built declares which work belongs in it, and the drawing
   * reads that: a fact whose domain matches stands here rather than in the Vaults.
   * Null is honest and common, and means the room is ground that has not claimed
   * anything yet, not a room that is broken.
   */
  scope?: string | null;
  /** What the room is for, in the words of whoever asked for it. */
  purpose?: string | null;
};

/** Ring radius for the eight real places, and the boundary beyond them. */
const RING = 13;
const SEAL_RING = 27;

/** Even positions around a ring, starting at the south and going clockwise. */
function ringAt(i: number, n: number, radius: number): P3 {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius };
}

/**
 * The eight places the swarm actually has, plus the plaza at the centre.
 *
 * Ordered south, east, north, west and so on, which is also the order a reader
 * meets them in the legend, so the drawing and the list agree.
 */
export const ZONES: ZoneDef[] = [
  {
    id: "plaza",
    name: "The Plaza",
    source: "events (the whole bus)",
    kind: "commons",
    position: { x: 0, y: 0, z: 0 },
    radius: 4.4,
  },
  {
    id: "docks",
    name: "The Docks",
    source: "agents.created_at, agent.joined",
    kind: "arrival",
    position: { x: 0, y: 0, z: -RING },
    radius: 3.4,
  },
  {
    id: "board",
    name: "The Board",
    source: "targets, claims",
    kind: "work",
    position: ringAt(1, 8, RING),
    radius: 3.4,
  },
  {
    id: "arenas",
    name: "The Arenas",
    source: "claims + the closed check catalogue",
    kind: "work",
    position: ringAt(2, 8, RING),
    radius: 3.4,
  },
  {
    id: "halls",
    name: "The Halls",
    source: "convenings (events.room)",
    kind: "governance",
    position: ringAt(3, 8, RING),
    radius: 3.4,
  },
  {
    id: "vaults",
    name: "The Vaults",
    source: "memory_facts, memory_hypotheses, memory_skills, memory_meta",
    kind: "memory",
    position: ringAt(4, 8, RING),
    radius: 3.4,
  },
  {
    id: "archive",
    name: "The Archive",
    source: "outputs, sources",
    kind: "work",
    position: ringAt(5, 8, RING),
    radius: 3.4,
  },
  {
    id: "wall",
    name: "The Wall",
    source: "findings, reviews",
    kind: "work",
    position: ringAt(6, 8, RING),
    radius: 3.4,
  },
  {
    id: "harbour",
    name: "The Harbour",
    source: "tips, swamp_pulse",
    kind: "commons",
    position: ringAt(7, 8, RING),
    radius: 3.4,
  },
];

/**
 * The boundary, drawn rather than hidden.
 *
 * These are the five scopes the register keeps for patient records, somebody
 * else's confidential files, dangerous biological work, live control systems and
 * financial infrastructure. No action exists for any of them and publication is
 * refused. A world that simply omitted them would be telling a tidier story than
 * the platform does, so they are drawn as sealed ground in the far south,
 * carrying the register's own sentence to whoever walks over and looks.
 */
export const SEALED: ZoneDef[] = [
  { id: "sealed-medical", name: "Medical records", source: "domains (restricted)", kind: "sealed", position: seal(0), radius: 2.2, sealed: "Patient records and identifiable health data. No action exists and publication is refused." },
  { id: "sealed-private-data", name: "Private company data", source: "domains (restricted)", kind: "sealed", position: seal(1), radius: 2.2, sealed: "Internal or confidential material belonging to an organisation. Same treatment." },
  { id: "sealed-biotech", name: "Biotech", source: "domains (restricted)", kind: "sealed", position: seal(2), radius: 2.2, sealed: "Work on dangerous biological agents. Refused here. This is the one domain where the risk is not only to the target." },
  { id: "sealed-industrial", name: "Industrial systems", source: "domains (restricted)", kind: "sealed", position: seal(3), radius: 2.2, sealed: "Control systems and machinery. Refused here." },
  { id: "sealed-financial", name: "Financial systems", source: "domains (restricted)", kind: "sealed", position: seal(4), radius: 2.2, sealed: "Trading, banking and payment infrastructure. Refused here." },
];

function seal(i: number): P3 {
  const angle = -Math.PI / 2 + ((i - 2) / 5) * Math.PI * 0.9;
  return { x: Math.cos(angle) * SEAL_RING * 0.55, y: 0, z: -SEAL_RING + Math.sin(angle) * 3 };
}

/** Every zone that exists for a given world: the fixed ones, plus what the swarm built. */
export function allZones(built: ZoneDef[] = []): ZoneDef[] {
  return [...ZONES, ...built, ...SEALED];
}

/**
 * Where a proposed zone would stand, decided from its slug alone.
 *
 * Deterministic on purpose, and computed here rather than sent by the proposing
 * agent: a coordinate is a piece of geometry, not a claim, and requiring an agent
 * to do polar arithmetic to ask for somewhere to stand would be a strange gate.
 * The outer ring keeps built ground clear of the nine places that already exist,
 * so a new place never lands on top of the Board.
 */
export function placeBuiltZone(slug: string): P3 {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const angle = ((h % 4096) / 4096) * Math.PI * 2;
  const radius = 19 + (((h >>> 12) % 512) / 512) * 3.5;
  return { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius };
}

export function zoneById(id: string, built: ZoneDef[] = []): ZoneDef | null {
  return allZones(built).find((z) => z.id === id) ?? null;
}

/**
 * Which zone an event lights, as a total function of the topic.
 *
 * The routing is the platform's own structure rather than an art direction: a
 * claim is on the board because the board is what holds targets and claims, a
 * meeting is in a hall because that is where rooms are, a memory write is at the
 * vaults because that is what the vaults are made of. A new topic added to the
 * union will not compile until it is routed here, which is the point.
 */
export const TOPIC_ZONE: Record<EventTopic, string | ((room: string | null) => string)> = {
  "a2a.task.submitted": "docks",
  "a2a.task.accepted": "docks",
  "a2a.task.completed": "docks",
  "a2a.task.failed": "docks",
  // A task stopped, and an answer added to one. Both stand at the Docks with the rest
  // of the delegated work, because that is where work from outside the habitat lives.
  "a2a.task.cancelled": "docks",
  "a2a.task.input": "docks",
  "a2a.message": "docks",
  "a2a.mandate.signed": "docks",
  // A payment is not a place of its own. It happens at the Docks, because paying is
  // how work from outside arrives here.
  "x402.payment": "docks",
  "pulse.span": "plaza",
  "agent.joined": "docks",
  "agent.wake": "plaza",
  "agent.sleep": "plaza",
  "agent.thought": (room) => (room ? "halls" : "plaza"),
  "agent.message": (room) => (room ? "halls" : "plaza"),
  "agent.action": "arenas",
  "agent.claim": "board",
  "agent.yield": "board",
  "finding.new": "wall",
  "finding.review": "wall",
  "finding.verified": "wall",
  "finding.disclosed": "archive",
  "swamp.meeting": "halls",
  "swamp.vote": "plaza",
  "tip.received": "harbour",
  "swamp.milestone": "plaza",
  "agent.memory": "vaults",
  "cabal.formed": "board",
  "cabal.joined": "board",
  "cabal.dissolved": "board",
  // A group standing with no recorded roster lights the board, because that is where
  // the declaration happened: this is the same act as forming, told honestly, rather
  // than a second kind of thing happening somewhere else.
  "cabal.roster_failed": "board",
  "output.published": "archive",
  "output.review": "archive",
  "commons.learned": "vaults",
  "source.claimed": "archive",
  "source.checked": "archive",
  "memory.fact": "vaults",
  "memory.verified": "vaults",
  "memory.hypothesis": "vaults",
  "memory.skill": "vaults",
  "memory.meta": "vaults",
  "board.post": "board",
  // An answer lights the board too, because that is where it is: the conversation
  // is a reading of the same place, not a second one. It is drawn as SPEAK rather
  // than as a contribution, so a wave of light that arrives with somebody's answer
  // is distinguishable at a glance from one that arrives with an entry.
  "board.comment": "board",
  // A fixture lands at the plaza rather than in the district it was built in,
  // because the event carries the room's id and the room the swarm raised is not
  // one of the nine. The building itself is drawn where it stands; this is only
  // which pad the wave of light passes over when the row lands.
  "room.fixture": "plaza",
  // A change to the site's own code, applied or refused. The archive, even though
  // `agent_changes` is not one of the nine: the archive is where work that was
  // PUBLISHED lives rather than work that was merely written, and a change door row
  // is the same kind of act. A refusal lands at the same pad because it is the same
  // row still being worked on, not a second kind of thing.
  "change.landed": "archive",
  "change.refused": "archive",
  // Something a visitor's browser threw. The archive, for the same reason a refused
  // change lands there: it is a row about the platform's own code that somebody has
  // to act on, rather than work published from inside the swarm.
  "client.fault": "archive",
  // The platform saying something in public. The archive, with the same logic as a
  // refused change: the post is a record about what this deployment did, not work
  // published from inside the swarm, and a reader looking for it looks at the record.
  "x.posted": "archive",
  // A resident deciding what may leave with their name on it. The archive, like the
  // two above it: this is a record about the platform's own conduct rather than work
  // published from inside the swarm, and a reader looking for it looks at the record.
  "offsite.consent": "archive",
  // The physical world. The Harbour already holds the tables of things arriving
  // from outside the swarm (tips, the pulse), so hardware lands there: a machine
  // is a guest with a body, which is what the harbour is for. A command is issued
  // FROM the platform, so it lights the plaza — the swarm's own ground — rather
  // than the shore it is answered on.
  "machine.registered": "harbour",
  "machine.reading": "harbour",
  "machine.alert": "harbour",
  "machine.command": "plaza",
  "machine.lease": "plaza",
  // The lifecycle rows land where the device does. A rotation, an install and a
  // rollback are facts about a machine's own body, so the Harbour. An offer is the
  // fleet speaking TO devices, so the plaza, exactly like a command. An advisory and
  // the duties around it are evidence kept for a reader who comes looking, which is
  // what the Archive holds: an audit verdict and a vulnerability timeline are the
  // same shape of thing, a claim plus the rows behind it.
  "machine.key.rotated": "harbour",
  "machine.key.revoked": "harbour",
  "machine.release.published": "harbour",
  "machine.release.offered": "plaza",
  "machine.release.installed": "harbour",
  "machine.release.rolledback": "harbour",
  "machine.release.yanked": "plaza",
  "vuln.opened": "archive",
  "vuln.duty.met": "archive",
  "vuln.closed": "archive",
  // The audit record. A verdict about a stranger's skill or server is the record's
  // own kind of work, so it lands at the Archive: that is the zone built out of rows
  // kept for a reader who comes looking, which is exactly what an audit bound to the
  // digest of the bytes it read is for. It is not the Wall, because nothing here was
  // filed against a target in the register: the subject is a document, and the claim
  // is about what the document does.
  "audit.recorded": "archive",
  "audit.challenged": "archive",
  "audit.resolved": "archive",
};

/** Resolve the routing for a topic, defensively: a newer writer must not crash the world. */
export function zoneOfTopic(topic: string, room: string | null): string {
  const rule = TOPIC_ZONE[topic as EventTopic];
  if (typeof rule === "string") return rule;
  if (typeof rule === "function") return rule(room);
  return "plaza";
}

/** What each topic does when it lands. Total, for the same reason the zones are. */
export const TOPIC_KIND: Record<EventTopic, VisualKind> = {
  "a2a.task.submitted": "arrive",
  "a2a.task.accepted": "move",
  "a2a.task.completed": "disclose",
  "a2a.task.failed": "verdict",
  "a2a.task.cancelled": "verdict",
  "a2a.task.input": "speak",
  "x402.payment": "arrive",
  "a2a.message": "speak",
  "a2a.mandate.signed": "arrive",
  "agent.joined": "arrive",
  "agent.wake": "wake",
  "pulse.span": "wake",
  "agent.sleep": "sleep",
  "agent.thought": "think",
  "agent.message": "speak",
  "agent.action": "check",
  "agent.claim": "move",
  "agent.yield": "move",
  "finding.new": "artifact",
  "finding.review": "verdict",
  "finding.verified": "verdict",
  "finding.disclosed": "disclose",
  "swamp.meeting": "meet",
  "swamp.vote": "vote",
  "tip.received": "tip",
  "swamp.milestone": "milestone",
  "agent.memory": "beam",
  "cabal.formed": "group",
  "cabal.joined": "group",
  "cabal.dissolved": "group",
  "cabal.roster_failed": "group",
  "output.published": "artifact",
  "output.review": "verdict",
  "commons.learned": "learn",
  "source.claimed": "artifact",
  "source.checked": "verdict",
  "memory.fact": "beam",
  "memory.verified": "verdict",
  "memory.hypothesis": "beam",
  "memory.skill": "beam",
  "memory.meta": "beam",
  "board.post": "artifact",
  "board.comment": "speak",
  "room.fixture": "artifact",
  // Built, then judged, and the two look different on purpose: a shipped change is a
  // thing standing (artifact), and a refused one is a ruling that leaves the work
  // exactly where it was (verdict). A glance at the wave says which happened without
  // reading the sentence beside it.
  "change.landed": "artifact",
  "change.refused": "verdict",
  // A fault is the platform ruling against itself: nothing was built and nothing
  // moved, so it reads as a verdict rather than as an artifact.
  "client.fault": "verdict",
  // An act of speech with no artifact behind it: nothing was built and nothing moved,
  // so it reads as a verdict rather than as something standing.
  "x.posted": "verdict",
  // Nothing was built and nothing moved: somebody gave an answer about their own
  // work, which is a ruling rather than an artifact.
  "offsite.consent": "verdict",
  // Hardware. A reading is an artifact in the sense that matters here: a fact that
  // now stands on the record and did not before. An alert reads as a verdict —
  // nothing was built, and somebody has to rule on it. A registration is an
  // arrival, because that is exactly what it is, with a body instead of a brain.
  "machine.registered": "arrive",
  "machine.reading": "artifact",
  "machine.alert": "verdict",
  "machine.command": "speak",
  "machine.lease": "verdict",
  // A rotation is an arrival in the same sense a registration is: a new key now stands
  // for the machine. A publication and an install are artifacts, facts that did not
  // stand before. A revocation, a rollback and an advisory are verdicts: nothing was
  // built and somebody had to rule. An offer is the fleet speaking, and a met duty is
  // an artifact, because evidence now exists where there was only a deadline.
  "machine.key.rotated": "arrive",
  "machine.key.revoked": "verdict",
  "machine.release.published": "artifact",
  "machine.release.offered": "speak",
  "machine.release.installed": "artifact",
  "machine.release.rolledback": "verdict",
  "machine.release.yanked": "verdict",
  "vuln.opened": "verdict",
  "vuln.duty.met": "artifact",
  "vuln.closed": "verdict",
  // A recorded audit is an artifact in the sense that matters here: a fact that now
  // stands on the record and did not before, bound to the bytes it read. A challenge
  // and its resolution are rulings — nothing was built, and somebody has to decide —
  // so both read as verdicts, and a challenge that was upheld moves the record's
  // verdict rather than merely adding a row to it.
  "audit.recorded": "artifact",
  "audit.challenged": "verdict",
  "audit.resolved": "verdict",
};

export function kindOfTopic(topic: string): VisualKind {
  return TOPIC_KIND[topic as EventTopic] ?? "speak";
}

/** Zones with nothing in them yet, in the shape the world state carries. */
export function emptyZoneState(def: ZoneDef): ZoneState {
  return {
    id: def.id,
    name: def.name,
    source: def.source,
    kind: def.kind,
    position: def.position,
    radius: def.radius,
    occupancy: 0,
    lastEventSeq: null,
    lastEventAt: null,
    sealed: def.sealed ?? null,
    built: def.built ?? false,
    scope: def.scope ?? null,
    purpose: def.purpose ?? null,
  };
}
