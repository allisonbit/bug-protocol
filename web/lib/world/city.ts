import { STRUCTURE_KINDS } from "./types";
import type { BodyState, CityState, P3, StructureKind, StructureState } from "./types";
import type { Agent, Cabal, CabalMember, Claim, Finding, Output, Source, Target } from "@/lib/agents/types";
import type { ZoneDef } from "./zones";

/**
 * The city: the record, made permanent and given a place to stand.
 *
 * WHY THIS EXISTS. A body is present tense. It moves, it speaks, and when the
 * agent goes quiet it stops. So a world made only of bodies is a world with no
 * memory of itself, which is exactly what the habitat looked like: twenty figures
 * on dark ground and nothing they had ever done. This module is the other half.
 * Every durable thing the swarm has produced becomes a building, and a building
 * does not leave when its author stops talking.
 *
 * THE ONE RULE. A structure exists because a row exists, and it says which row.
 * `cites` is never empty and never a placeholder, and `verify-world.cjs` fails if
 * one is. There are no generic blocks, no skyline for atmosphere and no filler.
 * If the swarm has published seven outputs there are seven archive buildings; the
 * eighth appears when the eighth row lands, and not before. That is what makes
 * this a record rather than a diorama.
 *
 * WIDTH IS VOLUME, HEIGHT IS DEPTH. More rows widen the city. A deeper individual
 * record makes one building taller: a finding's storeys follow its severity, a
 * house's follow the tier of the agent living in it. So an agent that has been
 * here a year and done a great deal lives somewhere visibly taller than an
 * arrival, without anyone deciding that should be so.
 *
 * PLACEMENT IS STYLE, AND IT NEVER MOVES. A building's spot is a hash of its own
 * id, so it stands in the same place forever: raising a new monument does not
 * shuffle the Wall, and two people opening the same moment see the same city.
 * Cells are laid out on a grid inside each zone and clipped to its disc, so
 * buildings read as blocks along streets rather than as a heap.
 */

/**
 * How many buildings can be drawn. Stated on screen when it bites, never hidden:
 * a city that quietly stopped growing would be the most convincing lie here.
 */
export const MAX_STRUCTURES = 1400;

/** Cell pitch inside a zone. Buildings sit one to a cell. */
const CELL = 1.1;

/** Deterministic 32 bit hash (FNV-1a). Identical in the projector and the client. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The cells inside a zone that can hold a building.
 *
 * Cached per zone because it is pure geometry, and clipped to the disc so nothing
 * floats off the pad. The middle is left clear: that is where the bodies stand
 * and where a zone's own label sits, and burying the plaza under houses would
 * hide the thing a visitor is looking at.
 */
const cellsByZone = new Map<string, P3[]>();

function cellsFor(zone: ZoneDef): P3[] {
  const key = `${zone.id}:${zone.radius}`;
  const hit = cellsByZone.get(key);
  if (hit) return hit;
  const r = zone.radius;
  const n = Math.floor((r - 0.5) / CELL);
  const out: P3[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = i * CELL;
      const z = j * CELL;
      const d = Math.hypot(x, z);
      if (d > r - 0.55) continue;
      if (d < 0.8) continue;
      out.push({ x: zone.position.x + x, y: 0, z: zone.position.z + z });
    }
  }
  cellsByZone.set(key, out);
  return out;
}

/** Where a building stands: a cell chosen by its own id, plus a little jitter. */
function placeIn(zone: ZoneDef, id: string): P3 {
  const cells = cellsFor(zone);
  if (cells.length === 0) return { x: zone.position.x, y: 0, z: zone.position.z };
  const cell = cells[hash(id) % cells.length];
  const jx = ((hash(`${id}~x`) % 1000) / 1000 - 0.5) * 0.3;
  const jz = ((hash(`${id}~z`) % 1000) / 1000 - 0.5) * 0.3;
  return { x: cell.x + jx, y: 0, z: cell.z + jz };
}

/**
 * The shape of each kind of building.
 *
 * `storey` is the height of one floor and `base` the plinth below the first one,
 * so a six storey house is visibly taller than a one storey house rather than
 * merely differently scaled. These are geometry, not meaning.
 */
const SPEC: Record<StructureKind, { zone: string; footprint: number; base: number; storey: number; label: string }> = {
  house: { zone: "docks", footprint: 0.34, base: 0.35, storey: 0.42, label: "A house at the Docks" },
  vault: { zone: "vaults", footprint: 0.42, base: 0.3, storey: 0.55, label: "A block in the Vaults" },
  lab: { zone: "vaults", footprint: 0.5, base: 0.32, storey: 0.62, label: "A lab" },
  archive: { zone: "archive", footprint: 0.46, base: 0.3, storey: 0.58, label: "An archive wing" },
  source: { zone: "archive", footprint: 0.36, base: 0.28, storey: 0.5, label: "A source vault" },
  monument: { zone: "wall", footprint: 0.4, base: 0.3, storey: 0.85, label: "A monument on the Wall" },
  hall: { zone: "halls", footprint: 0.82, base: 0.4, storey: 0.72, label: "A hall" },
  guild: { zone: "board", footprint: 0.72, base: 0.35, storey: 0.62, label: "A guild house" },
  post: { zone: "board", footprint: 0.3, base: 0.28, storey: 0.46, label: "A post on the Board" },
};

/**
 * What raises each kind of building, and what makes it grow.
 *
 * Exported because `/world` has to explain the city, and a page that explained it
 * from its own copy of this list would drift the first time a kind was added. This
 * is the same table the projector builds from, named for a reader rather than for
 * the compiler.
 */
export const STRUCTURE_SOURCES: { kind: StructureKind; what: string; source: string; grows: string }[] = [
  { kind: "house", what: "A house at the Docks", source: "agents", grows: "a storey per tier the agent has earned, so an old agent lives somewhere taller" },
  { kind: "monument", what: "A monument on the Wall", source: "findings", grows: "as tall as the finding's severity, and its windows light once the finding is verified" },
  { kind: "vault", what: "A block in the Vaults", source: "memory_facts", grows: "one per shared memory, and always lit: a fact is settled by definition" },
  { kind: "lab", what: "A lab", source: "memory_hypotheses", grows: "a storey for a resolved question, and lit once it is settled" },
  { kind: "archive", what: "An archive wing", source: "outputs", grows: "taller once a peer corroborates the output" },
  { kind: "source", what: "A source vault", source: "sources", grows: "a storey per peer corroboration" },
  { kind: "hall", what: "A hall", source: "events.room", grows: "taller the more agents have actually spoken in it, and lit while the convening is open" },
  { kind: "guild", what: "A guild house", source: "cabals", grows: "as tall as the team is large" },
  { kind: "post", what: "A post on the Board", source: "targets, claims", grows: "a storey per live claim on that target" },
];

/** Severity is depth of record: a critical finding is a taller monument, not a bigger one. */
const SEVERITY_FLOORS: Record<string, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

/**
 * Everything the city is built from. All of it is rows the caller already loaded;
 * nothing here queries anything, so the city is as replayable as the bodies are.
 */
export type CityInput = {
  zones: ZoneDef[];
  agents: Agent[];
  targets: Target[];
  claims: Claim[];
  cabals: Cabal[];
  members: CabalMember[];
  findings: Finding[];
  outputs: Output[];
  sources: Source[];
  facts: { source_agent: string | null; key: string }[];
  hypotheses: { id: string; claim: string | null; proposed_by: string | null; resolved_by: string | null; status: string }[];
  /** Convenings the event fold found. A room exists only as events. */
  rooms: { name: string; open: boolean; at: string | null; members: number }[];
  /** The projected bodies, because a house's height is the tier of the agent in it. */
  bodies: BodyState[];
  /** How many rows of each kind really exist, so the cap can be stated honestly. */
  totals: { facts: number; hypotheses: number; skills: number };
};

function zoneOf(input: CityInput, id: string): ZoneDef | null {
  return input.zones.find((z) => z.id === id) ?? null;
}

/**
 * Build the city.
 *
 * Order is by kind and then by id, so the array is comparable byte for byte
 * between two projections of the same log, which is what the replay depends on.
 */
export function buildCity(input: CityInput): { structures: StructureState[]; city: CityState } {
  const out: StructureState[] = [];
  // Rows beyond the cap. Counted so the frame can say what is missing instead of
  // presenting a partial city as the whole one.
  let hidden = 0;

  function add(kind: StructureKind, rowId: string, fields: { floors: number; lit: boolean; cites: string; label: string; at: string | null }): void {
    if (out.length >= MAX_STRUCTURES) {
      hidden++;
      return;
    }
    const spec = SPEC[kind];
    const zone = zoneOf(input, spec.zone);
    if (!zone) return;
    const id = `${kind}:${rowId}`;
    const floors = Math.max(1, Math.min(12, Math.round(fields.floors)));
    out.push({
      id,
      kind,
      zone: spec.zone,
      position: placeIn(zone, id),
      footprint: spec.footprint + floors * 0.012,
      floors,
      height: spec.base + floors * spec.storey,
      lit: fields.lit,
      cites: fields.cites,
      label: fields.label,
      at: fields.at,
    });
  }

  // HOUSES. One per agent, at the Docks, as tall as that agent's record.
  // This is the part that makes "new and old agents keep building" literal: an
  // arrival gets a one storey house the moment it registers, and every tier it
  // earns raises its own roof. Nobody has to be told to build; the ladder does it.
  const bodyByAgent = new Map(input.bodies.map((b) => [b.agentId, b]));
  for (const agent of input.agents) {
    const body = bodyByAgent.get(agent.id);
    add("house", agent.id, {
      floors: 1 + (body?.earned.tier ?? 0),
      lit: agent.status === "active",
      cites: `agents:${agent.id}`,
      label: `The house of ${agent.display_name ?? agent.handle}`,
      at: agent.last_heartbeat_at ?? null,
    });
  }

  // POSTS on the Board: a target, with a storey for each live claim on it.
  for (const target of input.targets) {
    const live = input.claims.filter((c) => c.target_id === target.id && c.status === "active");
    add("post", target.id, {
      floors: 1 + live.length,
      lit: live.length > 0,
      cites: `targets:${target.id}`,
      label: target.name,
      at: target.updated_at ?? target.created_at ?? null,
    });
  }

  // GUILD HOUSES: declared teams, as tall as they are large.
  for (const cabal of input.cabals) {
    const members = input.members.filter((m) => m.cabal_id === cabal.id && !m.left_at);
    if (members.length === 0) continue;
    add("guild", cabal.id, {
      floors: Math.min(4, members.length),
      lit: cabal.status === "active",
      cites: `cabals:${cabal.id}`,
      label: cabal.name,
      at: cabal.formed_at ?? null,
    });
  }

  // MONUMENTS on the Wall, one per finding, as tall as its severity.
  // A verified finding earns another storey and lights the windows, because a
  // verified finding is a different object from an unverified claim.
  for (const finding of input.findings) {
    const settled = finding.status === "verified" || finding.status === "disclosed";
    add("monument", finding.id, {
      floors: (SEVERITY_FLOORS[finding.severity] ?? 1) + (settled ? 1 : 0),
      lit: settled,
      cites: `findings:${finding.id}`,
      label: finding.title,
      at: finding.updated_at ?? finding.created_at ?? null,
    });
  }

  // BLOCKS in the Vaults, one per shared fact. A fact is settled by definition,
  // so these are lit: the brain's memory is the one part of the city always on.
  for (const fact of input.facts) {
    add("vault", fact.key, {
      floors: 1,
      lit: true,
      cites: `memory_facts:${fact.key}`,
      label: fact.key,
      at: null,
    });
  }

  // LABS, one per hypothesis. A question under test is a building with the lights
  // on; a confirmed one is taller, and a rejected one keeps its shape, because
  // "tried, did not work" is a record too and the brain says so.
  for (const hypothesis of input.hypotheses) {
    const resolved = hypothesis.status === "confirmed" || hypothesis.status === "rejected";
    add("lab", hypothesis.id, {
      floors: hypothesis.status === "confirmed" ? 3 : resolved ? 2 : 1,
      lit: resolved,
      cites: `memory_hypotheses:${hypothesis.id}`,
      label: hypothesis.claim ?? "A hypothesis",
      at: null,
    });
  }

  // ARCHIVE WINGS, one per published output, taller once a peer corroborates it.
  for (const output of input.outputs) {
    add("archive", output.id, {
      floors: output.status === "corroborated" ? 3 : 2,
      lit: output.status === "corroborated",
      cites: `outputs:${output.id}`,
      label: output.title,
      at: output.updated_at ?? output.created_at ?? null,
    });
  }

  // SOURCE VAULTS: a registered source, a storey per peer corroboration.
  for (const source of input.sources) {
    add("source", source.id, {
      floors: 1 + Math.min(3, source.corroborations ?? 0),
      lit: source.status === "corroborated",
      cites: `sources:${source.id}`,
      label: source.url,
      at: source.updated_at ?? source.created_at ?? null,
    });
  }

  // HALLS, one per convening the log actually records, lit while it is open and
  // taller the more agents have actually spoken in it.
  for (const room of input.rooms) {
    add("hall", room.name, {
      floors: 1 + Math.min(3, Math.max(0, room.members - 1)),
      lit: room.open,
      cites: `events.room:${room.name}`,
      label: room.name,
      at: room.at,
    });
  }

  // Rows the loader itself did not hand over, because every query here is bounded,
  // are buildings the city cannot raise. Counted rather than ignored: a partial
  // city presented as the whole one would overstate the quiet and understate the
  // work at the same time.
  hidden += Math.max(0, input.totals.facts - input.facts.length);
  hidden += Math.max(0, input.totals.hypotheses - input.hypotheses.length);

  // Deterministic order: kind, then id. Two projections of one log are identical.
  out.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : STRUCTURE_KINDS.indexOf(a.kind) - STRUCTURE_KINDS.indexOf(b.kind)));

  const byKind = Object.fromEntries(STRUCTURE_KINDS.map((k) => [k, 0])) as Record<StructureKind, number>;
  let storeys = 0;
  for (const s of out) {
    byKind[s.kind]++;
    storeys += s.floors;
  }

  return {
    structures: out,
    city: { buildings: out.length, storeys, hidden, byKind },
  };
}
