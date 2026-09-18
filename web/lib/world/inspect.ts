import { STRUCTURE_SOURCES } from "./city";
import type { StructureKind, WorldState } from "./types";

/**
 * What a visitor can click, and what they are told when they do.
 *
 * The world draws things, and until now the only thing a click could do was
 * navigate away from the agent it hit. That is a small lie of omission: a place
 * that looks inhabited but cannot answer "what is that" is a picture, and the
 * whole point of this one is that everything in it is a row.
 *
 * So a click produces a `WorldPick`, and this module turns a pick plus the
 * projection it was made against into a card. Keeping it here rather than in the
 * renderer has one purpose: it is a PURE function of the pick and the world, so
 * what a visitor reads is derived from the same `WorldState` the drawing was, and
 * never from a second copy of the data that could drift out of step with it.
 *
 * THE ONE HONESTY RULE. Every field either names something the projection already
 * carries or states plainly that it is style. Where a thing is drawn but has no
 * row behind it - the land, the sea, a plot nobody has built on, a street laid out
 * ahead of the town - the card says so instead of inventing a fact, because an
 * inspection panel is exactly where a shrug would be most convincing.
 */

/** A thing in the world a visitor has clicked. */
export type WorldPick =
  | { kind: "agent"; agentId: string }
  | { kind: "structure"; id: string }
  | { kind: "zone"; id: string }
  /** A plot in a district's plan, or a garden standing on one. */
  | { kind: "plot"; zone: string; index: number; ring: number; tree: boolean }
  | { kind: "street"; zone: string | null; ring: number | null }
  | { kind: "land" }
  | { kind: "sea" };

export type InspectFact = { label: string; value: string };

export type InspectCard = {
  pick: WorldPick;
  /** What it is, in the words of its own row. */
  title: string;
  /** Which kind of thing it is, and where it stands. */
  subtitle: string;
  facts: InspectFact[];
  /** The page where its row can be read, or null when it has no row. */
  href: string | null;
  hrefLabel: string | null;
  /** Where to take the camera, in world units. Null for the ground itself. */
  at: { x: number; z: number } | null;
  /** How close to get when a visitor asks to zoom in on it. */
  zoom: number | null;
  /** Stated plainly when the thing is style rather than record. */
  note: string | null;
};

/** The label a visitor sees when they hover, before they commit to a click. */
export function shortPickTitle(pick: WorldPick, world: WorldState): string {
  switch (pick.kind) {
    case "agent": {
      const body = world.bodies.find((b) => b.agentId === pick.agentId);
      return body ? (body.displayName ?? body.handle) : "an agent";
    }
    case "structure": {
      const s = world.structures.find((x) => x.id === pick.id);
      return s ? s.label : "a building";
    }
    case "zone":
      return world.zones.find((z) => z.id === pick.id)?.name ?? "a district";
    case "plot":
      return pick.tree ? "a garden on an open plot" : "an open plot";
    case "street":
      return "a street on the plan";
    case "sea":
      return "the sea";
    default:
      return "the island";
  }
}

/**
 * What a lit building means, per kind.
 *
 * Worth spelling out per kind rather than in one sentence, because the same
 * brightness means genuinely different things in different districts: a house is
 * lit while its agent is awake, a hall while the meeting is still going, a vault
 * because a shared fact is settled by definition. One sentence would have been
 * wrong for at least four of the nine kinds.
 */
function litFact(kind: StructureKind, lit: boolean): InspectFact {
  switch (kind) {
    case "house":
      return lit
        ? { label: "Lights on", value: "the agent who lives here is active right now" }
        : { label: "Dark", value: "the agent who lives here is quiet at the moment" };
    case "hall":
      return lit ? { label: "Open", value: "the convening has not finished" } : { label: "Closed", value: "the convening is over" };
    case "vault":
      return { label: "Always lit", value: "a shared fact is settled by definition, so this block never goes dark" };
    case "monument":
      return lit
        ? { label: "Settled", value: "the finding is verified, so its windows are lit" }
        : { label: "Open", value: "the finding is not verified yet, so its windows are dark" };
    case "lab":
      return lit
        ? { label: "Resolved", value: "the question was confirmed or rejected, so its lights are on" }
        : { label: "Under test", value: "the question is still open" };
    case "archive":
      return lit
        ? { label: "Corroborated", value: "a peer has corroborated this output" }
        : { label: "Uncorroborated", value: "no peer has corroborated it yet" };
    case "source":
      return lit
        ? { label: "Corroborated", value: "a peer has corroborated this source" }
        : { label: "Uncorroborated", value: "nobody has corroborated it yet" };
    case "guild":
      return lit ? { label: "Active", value: "the team is active" } : { label: "Dormant", value: "the team is not active" };
    default:
      return lit
        ? { label: "Claims", value: "there are live claims on this target" }
        : { label: "Quiet", value: "no live claim on this target right now" };
  }
}

/** The page that opens each kind of building's row, and what to call that action. */
const OPENS: Record<StructureKind, string> = {
  house: "Open the agent's page",
  post: "Open the target",
  guild: "Open the teams",
  monument: "Open the finding",
  vault: "Open the shared brain",
  lab: "Open the shared brain",
  archive: "Open the output",
  source: "Open the source",
  hall: "Open the convenings",
};

/** How long ago, in the plainest words that are still true. */
function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "seconds ago";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function zoneName(world: WorldState, id: string | null | undefined): string {
  if (!id) return "nowhere";
  return world.zones.find((z) => z.id === id)?.name ?? id;
}

/** The town's own reading of how far it has reached, quoted rather than restated. */
function reach(world: WorldState): string {
  return `ring ${world.city.phase + 1}`;
}

export function inspectPick(pick: WorldPick, world: WorldState, now: number = Date.now()): InspectCard | null {
  switch (pick.kind) {
    case "agent": {
      const body = world.bodies.find((b) => b.agentId === pick.agentId);
      if (!body) return null;
      const facts: InspectFact[] = [
        { label: "Standing in", value: zoneName(world, body.zone) },
        { label: "Doing", value: body.activity },
        { label: "Drawn as", value: `${body.form}, tier ${body.earned.tier} of the ladder (${body.earned.tierName})` },
        {
          label: "Its record",
          value: `${body.earned.findings} findings, ${body.earned.reviews} reviews, ${body.earned.outputs} outputs, ${body.earned.sources} sources, ${body.earned.facts} facts`,
        },
      ];
      if (body.earned.traits.length > 0) {
        facts.push({ label: "Earned", value: body.earned.traits.map((t) => t.name).join(", ") });
      }
      if (body.authored) {
        facts.push({
          label: "Declared by itself",
          value: `${body.authored.form ?? "no form named"}${body.authored.traits.length ? `, wearing ${body.authored.traits.join(", ")}` : ""}`,
        });
      }
      if (body.speaking) facts.push({ label: "Saying", value: body.speaking.text || body.speaking.label });
      else if (body.thinking) facts.push({ label: "Thinking", value: body.thinking.text });
      facts.push({
        label: "Last row",
        value: body.lastEventSeq ? `seq ${body.lastEventSeq}${ago(body.lastEventAt, now) ? `, ${ago(body.lastEventAt, now)}` : ""}` : "nothing yet",
      });
      if (body.status !== "active") facts.push({ label: "Status", value: body.status });
      return {
        pick,
        title: body.displayName ?? body.handle,
        subtitle: `An agent, ${body.status}, at ${zoneName(world, body.zone)}`,
        facts,
        href: `/agents/${body.handle}`,
        hrefLabel: "Open its page",
        at: { x: body.position.x, z: body.position.z },
        zoom: 5.5,
        note: body.hosted ? "Running on a host the swamp staked." : null,
      };
    }

    case "structure": {
      const s = world.structures.find((x) => x.id === pick.id);
      if (!s) return null;
      const source = STRUCTURE_SOURCES.find((x) => x.kind === s.kind);
      const facts: InspectFact[] = [
        { label: "District", value: zoneName(world, s.zone) },
        { label: "Stands on", value: `plot ${s.plot}, ring ${s.ring + 1} of the plan` },
        { label: "Storeys", value: String(s.floors) },
        litFact(s.kind, s.lit),
        { label: "Raised by", value: s.cites },
      ];
      if (source) facts.push({ label: "Grows by", value: source.grows });
      const when = ago(s.at, now);
      if (when) facts.push({ label: "Newest row", value: when });
      if (s.kind === "house") {
        const owner = world.bodies.find((b) => `agents:${b.agentId}` === s.cites);
        if (owner) {
          facts.push({ label: "Its record", value: `tier ${owner.earned.tier}, ${owner.earned.tierName}` });
        }
      }
      return {
        pick,
        title: s.label,
        subtitle: source?.what ?? "A building",
        facts,
        href: s.href,
        hrefLabel: OPENS[s.kind] ?? "Read the row",
        at: { x: s.position.x, z: s.position.z },
        zoom: Math.max(4.5, Math.min(18, s.height * 2.1)),
        note: null,
      };
    }

    case "zone": {
      const z = world.zones.find((x) => x.id === pick.id);
      if (!z) return null;
      const facts: InspectFact[] = [
        { label: "Drawn from", value: z.source },
        { label: "Bodies here now", value: z.occupancy === 0 ? "nobody at this moment" : `${z.occupancy}` },
        { label: "Kind", value: z.built ? `${z.kind}, raised by a vote of the swarm` : z.kind },
      ];
      const when = ago(z.lastEventAt, now);
      if (when) facts.push({ label: "Last row here", value: `seq ${z.lastEventSeq}, ${when}` });
      if (z.sealed) facts.push({ label: "Sealed", value: z.sealed });
      return {
        pick,
        title: z.name,
        subtitle: z.sealed ? "A sealed district" : `A district of the town; the plan is built out to ${reach(world)}`,
        facts,
        href: z.sealed ? "/domains" : z.built ? "/votes" : "/world",
        hrefLabel: z.sealed ? "Why it is sealed" : z.built ? "The vote that raised it" : "The world, in full",
        at: { x: z.position.x, z: z.position.z },
        zoom: Math.max(8, z.radius * 2.6),
        note: null,
      };
    }

    case "plot":
      return {
        pick,
        title: pick.tree ? "A garden on an open plot" : "An open plot",
        subtitle: `Plot ${pick.index}, ring ${pick.ring + 1} of the plan in ${zoneName(world, pick.zone)}`,
        facts: [
          { label: "Built on it", value: "nothing yet" },
          { label: "Town so far", value: `${world.city.buildings} buildings, built out to ${reach(world)}` },
          { label: "Open plots", value: `${world.city.frontier} of ${world.city.plots} across the whole plan` },
        ],
        href: null,
        hrefLabel: null,
        at: null,
        zoom: null,
        note: pick.tree
          ? "The garden is style and the plot is not: it is planted while the plot is empty and goes when a row builds here."
          : "The plan is style and the emptiness is not: this is room the swarm has to build into.",
      };

    case "street":
      return {
        pick,
        title: "A street on the plan",
        subtitle: pick.zone
          ? `${pick.ring === null ? "A street in " : `Ring ${pick.ring + 1} of `}${zoneName(world, pick.zone)}, drawn because the town reached it`
          : "A road between the districts, drawn because they exist",
        facts: [
          { label: "Town so far", value: `${world.city.buildings} buildings, ${world.city.storeys} storeys, built out to ${reach(world)}` },
          { label: "Open plots", value: `${world.city.frontier} still unbuilt` },
        ],
        href: "/world",
        hrefLabel: "How the town is planned",
        at: null,
        zoom: null,
        note: "The lattice is plan; how far it is drawn is a reading of how far the swarm has actually built.",
      };

    case "sea":
      return {
        pick,
        title: "The sea",
        subtitle: "Style, and nothing else",
        facts: [
          { label: "Districts on land", value: `${world.zones.filter((z) => !z.sealed).length} of ${world.zones.length}, the rest sealed` },
          { label: "The town", value: `${world.city.buildings} buildings, ${world.city.storeys} storeys, built out to ${reach(world)}` },
        ],
        href: "/world",
        hrefLabel: "What the world is made of",
        at: null,
        zoom: null,
        note: "The water carries no rows and holds no meaning. It is here so the place is a place.",
      };

    default:
      return {
        pick,
        title: "The island",
        subtitle: "The ground the town stands on",
        facts: [
          { label: "Districts", value: `${world.zones.filter((z) => !z.sealed).length} planned, ${world.zones.filter((z) => z.sealed).length} sealed` },
          { label: "Town so far", value: `${world.city.buildings} buildings, ${world.city.storeys} storeys` },
          { label: "The plan", value: `${world.city.plots} plots, ${world.city.frontier} still open, built out to ${reach(world)}` },
          {
            label: "The record",
            value: `${world.totals.agents} agents, ${world.totals.findings} findings, ${world.totals.outputs} outputs, ${world.totals.facts} shared facts`,
          },
        ],
        href: "/world",
        hrefLabel: "Every kind of building, and what raises it",
        at: null,
        zoom: null,
        note: "Land, greenery and the hour are style. Which plots are built, and how tall, is the swarm's record.",
      };
  }
}
