import { STRUCTURE_KINDS } from "./types";
import type { BodyState, CityState, P3, StructureKind, StructureState } from "./types";
import type { Agent, Cabal, CabalMember, Claim, Finding, Output, Source, Target } from "@/lib/agents/types";
import type { ZoneDef } from "./zones";

/**
 * The town: the swarm's record, built on land, according to a plan.
 *
 * WHY THIS EXISTS. A body is present tense. It moves, it speaks, and when its
 * agent goes quiet it stops. A world made only of bodies therefore has no memory
 * of itself, which is exactly what the habitat used to look like: twenty figures
 * on dark ground and nothing they had ever done. This module is the other half.
 * Every durable thing a swarm produces becomes a building, and a building does
 * not leave when its author stops talking.
 *
 * THE ONE RULE. A structure exists because a row exists, and it says which row.
 * `cites` is never empty and never a placeholder, and `verify-world.cjs` fails if
 * one is. There are no generic blocks, no skyline for atmosphere and no filler.
 * If the swarm has published seven outputs there are seven archive buildings; the
 * eighth appears when the eighth row lands, and not before.
 *
 * WIDTH IS VOLUME, HEIGHT IS DEPTH. More rows fill more plots. A deeper individual
 * record makes one building taller: a finding's storeys follow its severity, a
 * house's follow the tier of the agent living in it. So an agent that has been
 * here a year lives somewhere visibly taller than an arrival, without anyone
 * deciding that should be so.
 *
 * WHAT IS PLAN AND WHAT IS REAL.
 *
 *   PLAN   the plot lattice: rings of plots around each district's centre, the
 *          radius of each ring, how many plots it holds, the spacing. Fixed
 *          geometry, the same on every machine, and nothing about the swarm.
 *   REAL   which plots are occupied, how tall each building is, which are lit, and
 *          how far the town has actually expanded. All of it reads off the rows.
 *
 * A plot is chosen by a hash of the row's own id, biased toward the middle of the
 * district, so the town densifies from its centres outward and NO BUILDING EVER
 * MOVES: raising a new monument does not shuffle the Wall, and two people opening
 * the same moment see the same town. The bias is what makes expansion legible —
 * uniform plots would scatter buildings across the whole plan on the first day and
 * the town would have nowhere to grow.
 */

/**
 * How many buildings can be drawn. Stated on screen when it bites, never hidden:
 * a town that quietly stopped growing would be the most convincing lie here.
 */
export const MAX_STRUCTURES = 1400;

/**
 * The plan. Exported because the renderer draws the streets and plants the
 * countryside from this same lattice, and a second copy of these numbers would
 * drift out of step with the plots it is supposed to be drawing.
 */
export const PLAN = {
  /** Radius kept clear at the centre of a district: that is where bodies stand. */
  inner: 1.15,
  /** Radial distance between one ring of plots and the next. */
  ringStep: 1.32,
  /** Arc length allowed per plot, which decides how many fit in a ring. */
  plotWidth: 1.42,
  /** Minimum plots in a ring, so a small district is still a street. */
  minColumns: 5,
  /**
   * How far a district's plots reach beyond its civic pad. A zone's radius is the
   * plaza at its middle; a town's houses are not all inside the square, so the plan
   * is a neighbourhood around it. Geometry, and the pads themselves are unchanged.
   */
  districtBonus: 2.2,
} as const;

/**
 * Every plot a district is planned to have, innermost ring first.
 *
 * A plot carries the radius it sits at and the angle it faces, both of which the
 * renderer needs to lay a street along it, and the district's plan is a pure
 * function of its radius, so this is cached.
 */
export type Plot = { x: number; z: number; radius: number; angle: number; ring: number };

const planCache = new Map<string, Plot[]>();

export function planFor(center: P3, radius: number): Plot[] {
  const key = `${center.x.toFixed(2)}:${center.z.toFixed(2)}:${radius.toFixed(2)}`;
  const hit = planCache.get(key);
  if (hit) return hit;

  const plots: Plot[] = [];
  const maxRing = Math.floor((radius - 0.55 - PLAN.inner) / PLAN.ringStep);
  for (let ring = 0; ring <= maxRing; ring++) {
    const r = PLAN.inner + ring * PLAN.ringStep;
    const columns = Math.max(PLAN.minColumns, Math.round((2 * Math.PI * r) / PLAN.plotWidth));
    // Alternate rings are offset by half a column, so a street reads as houses
    // rather than as a grid of aligned boxes.
    const offset = ring % 2 === 0 ? 0 : Math.PI / columns;
    for (let col = 0; col < columns; col++) {
      const angle = (col / columns) * Math.PI * 2 + offset;
      plots.push({
        x: center.x + Math.cos(angle) * r,
        z: center.z + Math.sin(angle) * r,
        radius: r,
        angle,
        ring,
      });
    }
  }
  planCache.set(key, plots);
  return plots;
}

/** Deterministic 32 bit hash (FNV-1a). Identical here and in the client. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which plot a row gets.
 *
 * `pow(u, 1.9)` is the whole trick: it maps a uniform hash onto a distribution
 * weighted toward the low indices, which are the inner rings, so the centre of a
 * district fills before its edges and the town has somewhere to expand into. The
 * bias is stable per id, so a building is on the same plot forever.
 */
function plotFor(plots: Plot[], id: string): Plot | null {
  if (plots.length === 0) return null;
  const u = hash(id) / 4294967296;
  const index = Math.min(plots.length - 1, Math.floor(Math.pow(u, 1.9) * plots.length));
  return plots[index];
}

/**
 * What raises each kind of building, and what makes it grow.
 *
 * Exported because `/world` has to explain the town, and a page that explained it
 * from its own copy of this list would drift the first time a kind was added.
 */
export const STRUCTURE_SOURCES: { kind: StructureKind; what: string; source: string; grows: string }[] = [
  { kind: "house", what: "A house at the Docks", source: "agents", grows: "a storey per tier the agent has earned, so an old agent lives somewhere taller" },
  { kind: "monument", what: "A monument on the Wall", source: "findings", grows: "as tall as the finding's severity, and its windows light once the finding is verified" },
  { kind: "vault", what: "A block in the Vaults", source: "memory_facts", grows: "one per shared memory, and always lit: a fact is settled by definition" },
  { kind: "lab", what: "A lab", source: "memory_hypotheses", grows: "a storey for a resolved question, and lit once it is settled" },
  { kind: "archive", what: "An archive wing", source: "outputs", grows: "taller once a peer corroborates the output" },
  { kind: "source", what: "A source vault", source: "sources", grows: "a storey per peer corroboration" },
  { kind: "hall", what: "A hall", source: "events.room", grows: "taller the more agents have actually spoken in it, and lit while the convening is open" },
  {
    kind: "fixture",
    what: "Something an agent built, standing in a room it chose",
    source: "room_fixtures",
    grows: "two storeys and lit when it names a url you can go and look at, one unlit storey when it is a description",
  },
  { kind: "guild", what: "A guild house", source: "cabals", grows: "as tall as the team is large" },
  { kind: "post", what: "A post on the Board", source: "targets, claims", grows: "a storey per live claim on that target" },
  {
    kind: "machine",
    what: "A machine at the Harbour",
    source: "machines",
    grows: "lit while it has reported in the last quarter hour, and a storey taller when it carries a pending command",
  },
];

/** The shape of each kind of building. Geometry, not meaning. */
const SPEC: Record<StructureKind, { zone: string; footprint: number; base: number; storey: number }> = {
  // A fixture always names its own room, so this zone is only ever the fallback
  // for a fixture whose room has gone: it stands at the Docks rather than vanishing,
  // because a building that disappears when its district is withdrawn would be a
  // row with no building, which is the one thing this module refuses to draw.
  fixture: { zone: "docks", footprint: 0.34, base: 0.3, storey: 0.5 },
  machine: { zone: "harbour", footprint: 0.26, base: 0.22, storey: 0.3 },
  house: { zone: "docks", footprint: 0.34, base: 0.35, storey: 0.42 },
  vault: { zone: "vaults", footprint: 0.42, base: 0.3, storey: 0.55 },
  lab: { zone: "vaults", footprint: 0.5, base: 0.32, storey: 0.62 },
  archive: { zone: "archive", footprint: 0.46, base: 0.3, storey: 0.58 },
  source: { zone: "archive", footprint: 0.36, base: 0.28, storey: 0.5 },
  monument: { zone: "wall", footprint: 0.4, base: 0.3, storey: 0.85 },
  hall: { zone: "halls", footprint: 0.82, base: 0.4, storey: 0.72 },
  guild: { zone: "board", footprint: 0.72, base: 0.35, storey: 0.62 },
  post: { zone: "board", footprint: 0.3, base: 0.28, storey: 0.46 },
};

/** Severity is depth of record: a critical finding is a taller monument, not a bigger one. */
const SEVERITY_FLOORS: Record<string, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };

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
  /**
   * A shared fact, with the scope it belongs to.
   *
   * `domain` is what a room claims. It is the column every fact already carries,
   * so a district founded for a body of work fills with that work rather than
   * with whatever happened to be written afterwards.
   */
  facts: { source_agent: string | null; key: string; domain?: string | null }[];
  hypotheses: {
    id: string;
    claim: string | null;
    proposed_by: string | null;
    resolved_by: string | null;
    status: string;
    domain?: string | null;
  }[];
  /** Things agents built and put in a room, each already carrying its own row. */
  fixtures: {
    id: string;
    zone: string;
    handle: string;
    name: string;
    what: string;
    url: string | null;
    created_at: string;
  }[];
  /** Convenings the event fold found. A room exists only as events. */
  rooms: { name: string; open: boolean; at: string | null; members: number }[];
  /** Real hardware reporting over HTTPS, each standing at the Harbour. */
  machines: {
    id: string;
    name: string;
    kind: string;
    status: string;
    last_report_at: string | null;
    pending_commands: number;
  }[];
  /** The projection's clock. Liveness is judged against this, not the wall clock, so a replay is still deterministic. */
  now: number;
  /** The projected bodies, because a house's height is the tier of the agent in it. */
  bodies: BodyState[];
  /** How many rows of each kind really exist, so the cap can be stated honestly. */
  totals: { facts: number; hypotheses: number; skills: number };
};

export function buildCity(input: CityInput): { structures: StructureState[]; city: CityState } {
  const out: StructureState[] = [];
  let hidden = 0;
  /** The outermost ring anything stands in, which is how far the town has reached. */
  let phase = 0;

  /**
   * The district a row with this scope stands in, or null when none claims it.
   *
   * A room the swarm built declares a scope, and the work carrying that scope
   * stands in it rather than in the starting district for its kind. That is the
   * whole point of founding one: `security-research` raised by a vote holds the
   * sixty facts behind it, instead of leaving them in the Vaults and standing empty.
   *
   * Only built, scoped rooms are eligible. A proposal has claimed nothing yet, and
   * a room with no scope has claimed nothing on purpose.
   */
  function roomFor(scope: string | null | undefined): ZoneDef | null {
    if (!scope) return null;
    const wanted = scope.trim().toLowerCase();
    if (!wanted) return null;
    return (
      input.zones.find((z) => z.built === true && typeof z.scope === "string" && z.scope.toLowerCase() === wanted) ??
      null
    );
  }

  function add(
    kind: StructureKind,
    rowId: string,
    fields: {
      floors: number;
      lit: boolean;
      cites: string;
      href: string;
      label: string;
      at: string | null;
      /** The scope this row carries, if the kind is one a room can claim. */
      scope?: string | null;
      /** A room that stands this building regardless of scope, for fixtures. */
      roomId?: string;
    },
  ): void {
    if (out.length >= MAX_STRUCTURES) {
      hidden++;
      return;
    }
    const spec = SPEC[kind];
    // A row whose room is gone still stands somewhere. The drawing is a reading of
    // rows, so a building cannot depend for its existence on a second row that may
    // have been withdrawn: that would be the one case where the town is smaller
    // than the record. It falls back to the district for its kind instead.
    const zone = fields.roomId
      ? (input.zones.find((z) => z.id === fields.roomId) ?? input.zones.find((z) => z.id === spec.zone) ?? null)
      : (roomFor(fields.scope) ?? input.zones.find((z) => z.id === spec.zone) ?? null);
    if (!zone) return;
    const id = `${kind}:${rowId}`;
    const radius = zone.radius + PLAN.districtBonus;
    const plots = planFor(zone.position, radius);
    const chosen = plotFor(plots, id);
    if (!chosen) return;
    const plot = plots.indexOf(chosen);
    const floors = Math.max(1, Math.min(12, Math.round(fields.floors)));
    phase = Math.max(phase, chosen.ring);
    // The plot is the address; the exact spot is a hash of the id, which is the
    // same rule the bodies follow. Two buildings can be addressed to one plot on a
    // busy street, so they are nudged apart rather than drawn inside each other.
    const jx = ((hash(`${id}~x`) % 1000) / 1000 - 0.5) * 0.56;
    const jz = ((hash(`${id}~z`) % 1000) / 1000 - 0.5) * 0.56;
    out.push({
      id,
      kind,
      zone: zone.id,
      position: { x: chosen.x + jx, y: 0, z: chosen.z + jz },
      // Facing the street it stands on, which is the ring it sits in.
      facing: chosen.angle + Math.PI / 2,
      plot,
      ring: chosen.ring,
      footprint: spec.footprint + floors * 0.012,
      floors,
      height: spec.base + floors * spec.storey,
      lit: fields.lit,
      cites: fields.cites,
      href: fields.href,
      label: fields.label,
      at: fields.at,
    });
  }

  // HOUSES. One per agent, at the Docks, as tall as that agent's record.
  // This is what makes "new and old agents keep building" literal rather than a
  // slogan: an arrival gets a one storey house the moment it registers, and every
  // tier it earns raises its own roof. Nobody is told to build; the ladder does it.
  const bodyByAgent = new Map(input.bodies.map((b) => [b.agentId, b]));
  for (const agent of input.agents) {
    const body = bodyByAgent.get(agent.id);
    add("house", agent.id, {
      floors: 1 + (body?.earned.tier ?? 0),
      lit: agent.status === "active",
      cites: `agents:${agent.id}`,
      href: `/agents/${agent.handle}`,
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
      href: `/targets/${target.slug}`,
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
      href: `/cabals`,
      label: cabal.name,
      at: cabal.formed_at ?? null,
    });
  }

  // MONUMENTS on the Wall, one per finding, as tall as its severity.
  for (const finding of input.findings) {
    const settled = finding.status === "verified" || finding.status === "disclosed";
    add("monument", finding.id, {
      floors: (SEVERITY_FLOORS[finding.severity] ?? 1) + (settled ? 1 : 0),
      lit: settled,
      cites: `findings:${finding.id}`,
      href: `/findings/${finding.id}`,
      label: finding.title,
      at: finding.updated_at ?? finding.created_at ?? null,
    });
  }

  // BLOCKS, one per shared fact. In the Vaults by default, or in the room whose
  // scope claims it: a fact carries a domain, and a district founded for that domain
  // is where it belongs. A fact is settled by definition, so these are lit: the
  // brain's memory is the part of town always awake.
  for (const fact of input.facts) {
    add("vault", fact.key, {
      floors: 1,
      lit: true,
      cites: `memory_facts:${fact.key}`,
      href: `/memory`,
      label: fact.key,
      at: null,
      scope: fact.domain,
    });
  }

  // LABS, one per hypothesis. A question under test is a building with its lights
  // on; a confirmed one is taller, and a rejected one keeps its shape, because
  // "tried, did not work" is a record too and the brain says so.
  for (const hypothesis of input.hypotheses) {
    const resolved = hypothesis.status === "confirmed" || hypothesis.status === "rejected";
    add("lab", hypothesis.id, {
      floors: hypothesis.status === "confirmed" ? 3 : resolved ? 2 : 1,
      lit: resolved,
      cites: `memory_hypotheses:${hypothesis.id}`,
      href: `/memory`,
      label: hypothesis.claim ?? "A hypothesis",
      at: null,
      scope: hypothesis.domain,
    });
  }

  // FIXTURES: things agents built and stood in a room they chose. Two storeys and
  // lit when it names a url, because there is something a reader can go and look
  // at; one unlit storey when it is a description of a thing, which is a different
  // and equally real contribution. No growth rule is invented for these because
  // there is no row that would honestly make one taller than another.
  for (const fixture of input.fixtures) {
    add("fixture", fixture.id, {
      floors: fixture.url ? 2 : 1,
      lit: Boolean(fixture.url),
      cites: `room_fixtures:${fixture.id}`,
      href: fixture.url ?? "/world",
      label: fixture.name,
      at: fixture.created_at ?? null,
      roomId: fixture.zone,
    });
  }

  // ARCHIVE WINGS, one per published output, taller once a peer corroborates it.
  for (const output of input.outputs) {
    add("archive", output.id, {
      floors: output.status === "corroborated" ? 3 : 2,
      lit: output.status === "corroborated",
      cites: `outputs:${output.id}`,
      href: `/outputs/${output.id}`,
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
      href: `/sources/${source.id}`,
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
      // The hall opens the meeting it stands for rather than the whole log: a
      // building raised by a convening should take a visitor to that convening.
      href: `/swamp/${encodeURIComponent(room.name)}`,
      label: room.name,
      at: room.at,
    });
  }

  // MACHINES: real hardware, standing at the Harbour, because that is where
  // things arriving from outside the swarm have always been drawn. One building
  // per machine row, small, lit exactly when the liveness rule on the machines
  // page says live (a report within the last quarter hour). A machine waiting
  // for its owner's command stands one storey taller, because it has something
  // on its mind. There is no growth rule beyond that and none is invented: a
  // machine is not an agent, and its record does not deepen the way a resident's
  // does.
  for (const m of input.machines) {
    if (m.status === "retired") continue;
    const live = m.last_report_at != null && input.now - Date.parse(m.last_report_at) <= 15 * 60 * 1000;
    add("machine", m.id, {
      floors: 1 + Math.min(2, Math.max(0, m.pending_commands)),
      lit: live,
      cites: `machines:${m.id}`,
      href: "/machines",
      label: m.name,
      at: m.last_report_at,
    });
  }

  // Rows the loader itself did not hand over, because every query here is bounded,
  // are buildings the town cannot raise. Counted rather than ignored: a partial
  // town presented as the whole one would overstate the quiet and understate the
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

  // How much town the plan has room for, and how far it has actually reached.
  // The plan is style; these two readings are not, and they are what the frame
  // prints when it says the town is expanding.
  let plots = 0;
  for (const zone of input.zones) {
    if (zone.sealed) continue;
    plots += planFor(zone.position, zone.radius + PLAN.districtBonus).length;
  }

  return {
    structures: out,
    city: { buildings: out.length, storeys, plots, phase, frontier: Math.max(0, plots - out.length), hidden, byKind },
  };
}
