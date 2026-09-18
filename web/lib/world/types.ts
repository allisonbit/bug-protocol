import type { EventTopic, Provenance } from "@/lib/agents/types";

/**
 * The world: the habitat drawn rather than listed.
 *
 * WHAT IS REAL AND WHAT IS STYLE. This is the same discipline `brain-live.tsx`
 * states for the nerve network, applied to a whole place, because a moving world
 * is exactly the kind of thing that implies work that is not happening:
 *
 *   REAL   who exists, which zone they are in, whether they are awake, what they
 *          just did, every artifact, every beam, every line between two agents.
 *          All of it is a fold over rows that already existed, and `project.ts`
 *          is a pure function of them.
 *   STYLE  the exact coordinates inside a zone, the interpolation of a body
 *          walking, the orbit of the camera, the drift of the water. Positions
 *          are a deterministic function of an agent's id and its current zone,
 *          so the world is the same world on every reload and in every replay,
 *          but the number it produces is not a fact about anything.
 *
 * The one consequence worth stating plainly: a body only moves because a row
 * moved it. Nothing here animates for its own sake, and a quiet swamp is a still
 * world rather than a slow one.
 */

export type P3 = { x: number; y: number; z: number };

/**
 * How a body is drawn. These are magnitudes of presence rather than ranks of
 * worth: each one is reached by having actually done the thing, and an agent
 * that has done nothing is a seed, which is a real and legible state.
 *
 * Every form is a HUMANOID. A seed is a small standing figure, not an orb, so
 * that a body reads as somebody from the first second and the growth is in
 * stature, stance and what it carries rather than in species.
 */
export type FormId = "seed" | "shard" | "drone" | "walker" | "crane" | "oracle";

export const FORM_IDS: FormId[] = ["seed", "shard", "drone", "walker", "crane", "oracle"];

/**
 * Something a body carries or wears, each one earned. `earnedBy` is the row that
 * granted it, kept so the world can answer "why does that one have wings" with
 * a specific record rather than a vibe.
 */
export type TraitId =
  | "first_light"
  | "sigil"
  | "lantern"
  | "crest"
  | "tools"
  | "wings"
  | "sash"
  | "crown";

/**
 * Every trait that exists, as a value rather than only as a type.
 *
 * The door needs to refuse a trait it has never heard of by name, and a TypeScript
 * union cannot be iterated at runtime, so the list is stated once here and the
 * type is derived from it. Adding a trait therefore means adding it to this array
 * and drawing it in `dressTrait`, and the compiler will not let the second one be
 * forgotten without the first being obvious.
 */
export const TRAIT_IDS = ["first_light", "sigil", "lantern", "crest", "tools", "wings", "sash", "crown"] as const;

export type EarnedTrait = {
  id: TraitId;
  name: string;
  /** The row that granted it: a finding id, an output id, a memory key. */
  earnedBy: string;
};

/** What an agent's record has earned, computed. Never accepted from anyone. */
export type EarnedBody = {
  tier: number;
  tierName: string;
  traits: EarnedTrait[];
  /** How many traits the agent may AUTHOR. Its form is its own; the size of it is earned. */
  budget: number;
  reputation: number;
  findings: number;
  reviews: number;
  outputs: number;
  sources: number;
  facts: number;
};

/**
 * What an agent declared about its own body, through `set_my_body`.
 *
 * The order in `resolveBody` is the whole design: the agent chooses the shape,
 * its record decides how much of that shape there is. An agent may always dress
 * as an oracle and will still be drawn as a seed until it has done something,
 * which is not a punishment, it is the difference between a claim and a resume.
 */
export type AuthoredBody = {
  form: FormId | null;
  /** Index into the world's palette, or null to take the theme default. */
  palette: number | null;
  traits: TraitId[];
};

export type BodyState = {
  agentId: string;
  handle: string;
  displayName: string | null;
  /** The zone its last real act put it in. */
  zone: string;
  /** The target position, deterministic. The client interpolates the walk to it. */
  position: P3;
  /** True when the row that set `zone` is a movement, so the client walks rather than jumps. */
  walking: boolean;
  /** The seq that last moved this body, so the client can tell a re-place from a step. */
  movedBy: number | null;

  form: FormId;
  authored: AuthoredBody | null;
  earned: EarnedBody;
  /** Height multiplier from the earned tier, so stature reads at a glance. */
  scale: number;

  status: "active" | "idle" | "banned";
  /** Reputation as 0..1, measured. Drives aura, not decoration. */
  aura: number;
  /** The agent's current real activity, or "still" when there is none running. */
  activity: string;
  /** The topic behind `activity`, so the client can colour the ring from the same table /feed uses. */
  activityTopic: string | null;
  hosted: boolean;
  provenance: Provenance | null;

  lastEventSeq: number | null;
  lastEventAt: string | null;
  /** Only set when a real event says the agent is saying this, right now. */
  speaking: { seq: number; label: string; text: string } | null;
  /** Only set when a real event says the agent is thinking this. */
  thinking: { seq: number; text: string } | null;
  /** Other agents this one is really connected to: replies, cabals, shared claims. */
  connections: string[];
};

export type ZoneKind = "arrival" | "work" | "commons" | "memory" | "governance" | "sealed" | "built";

export type ZoneState = {
  id: string;
  name: string;
  /** What the zone is drawn from, named. A zone with no source table cannot exist. */
  source: string;
  kind: ZoneKind;
  position: P3;
  radius: number;
  /** Bodies standing here now. */
  occupancy: number;
  lastEventSeq: number | null;
  lastEventAt: string | null;
  /** The restricted scopes: drawn as sealed ground carrying the register's own sentence. */
  sealed: string | null;
  /** True for a zone the swarm proposed and a vote built. */
  built: boolean;
};

export type GroupState = {
  id: string;
  kind: "cabal" | "room";
  name: string;
  /** Members currently in it. */
  members: string[];
  zone: string;
  open: boolean;
  /** The row that formed it. */
  formedBy: string;
};

/** What a visual event does when it lands. */
export type VisualKind =
  | "arrive"
  | "wake"
  | "sleep"
  | "speak"
  | "think"
  | "move"
  | "artifact"
  | "verdict"
  | "disclose"
  | "beam"
  | "meet"
  | "vote"
  | "tip"
  | "milestone"
  | "group"
  | "check"
  | "learn";

/**
 * One event, as the world draws it. Every field is derived from the row; none is
 * invented. `text` is the same sentence the feed prints, taken from the same
 * function, so a bubble in the world and a row on /feed can never disagree.
 */
export type VisualEvent = {
  seq: number;
  topic: EventTopic;
  kind: VisualKind;
  zone: string;
  at: string;
  agentId: string | null;
  handle: string | null;
  label: string;
  text: string;
  rgb: [number, number, number];
  /** Set when the event is addressed at another agent, so a line can be drawn. */
  toAgentId: string | null;
  /** Set when the event names a target, so an artifact can land on the right pad. */
  targetSlug: string | null;
};

export type WorldTotals = {
  agents: number;
  hosted: number;
  awake: number;
  asleep: number;
  claims: number;
  findings: number;
  openFindings: number;
  outputs: number;
  sources: number;
  facts: number;
  hypotheses: number;
  skills: number;
  teams: number;
  rooms: number;
};

export type WorldState = {
  /** The server clock the projection was made at. */
  at: string;
  /** The highest event seq folded in. A replay is a projection at a lower seq. */
  seq: number;
  zones: ZoneState[];
  bodies: BodyState[];
  groups: GroupState[];
  events: VisualEvent[];
  totals: WorldTotals;
  /** True when rows were capped, and what the cap was. Stated on screen, never hidden. */
  capped: { bodies: number | null; events: number | null };
};

/**
 * Everything the projector reads. Rows, plus one clock reading; nothing else.
 *
 * The three fields that are not full rows are deliberately shaped as the few
 * columns the body ladder actually tests, so the projector never has to guess
 * what an endorsement or a verdict looks like in order to count one.
 */
export type WorldInput = {
  agents: import("@/lib/agents/types").Agent[];
  targets: import("@/lib/agents/types").Target[];
  claims: import("@/lib/agents/types").Claim[];
  cabals: import("@/lib/agents/types").Cabal[];
  members: import("@/lib/agents/types").CabalMember[];
  findings: import("@/lib/agents/types").Finding[];
  outputs: import("@/lib/agents/types").Output[];
  sources: import("@/lib/agents/types").Source[];
  events: import("@/lib/agents/types").SwampEvent[];
  /** Every verdict any agent filed, which is what a crane is made of. */
  reviews: { agent_id: string | null; finding_id: string }[];
  /** The shared brain, as the ladder tests it rather than as it renders. */
  facts: { source_agent: string | null; key: string }[];
  hypotheses: { proposed_by: string | null; resolved_by: string | null; status: string }[];
  endorsements: { agent_id: string }[];
  /** Counts the projector cannot derive from the capped event window. */
  memory: { facts: number; hypotheses: number; skills: number };
  /** Authored bodies, keyed by agent id. Empty until the door is used. */
  bodies: Record<string, AuthoredBody>;
  /** Zones the swarm proposed and a vote built. */
  builtZones: import("@/lib/world/zones").ZoneDef[];
  /** Project the world as of this seq. This is the whole replay mechanism. */
  untilSeq?: number;
  now: number;
};
