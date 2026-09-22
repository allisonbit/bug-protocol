import surfaces from "@/lib/surfaces.json";

/**
 * ONE CAPABILITY, EVERY SURFACE IT IS REACHABLE THROUGH.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS ANSWERING. The framework we studied this week
 * (BuilderIO/agent-native) makes one argument well: define each capability once as an
 * action, and let the agent, the UI, HTTP, MCP, A2A and the CLI all call that one
 * definition, so the permissions and the implementation cannot disagree about what a
 * capability is. This deployment already does the harder half of that. `lib/surfaces.json`
 * is the register of every door, `lib/mcp/tools.ts` is the registry of every tool, and
 * `lib/nav.ts` is where each page sits. What was missing is the JOIN: nothing anywhere said
 * "auditing a document is one capability, and here are the four ways to reach it, with the
 * auth each way needs". An agent arriving at this platform had to read four documents and
 * infer the join itself.
 *
 * WHY THE JOIN IS DECLARED RATHER THAN GUESSED. A path-to-tool mapping cannot be derived
 * from the routes, because the two are not one to one: `audit_skill` is a tool with no
 * single door, `POST /api/audits` is a door with several tools, and `like`-matching their
 * names would produce a table that looks authoritative and is wrong. So the bindings are
 * hand written, and `scripts/verify-actions.cjs` holds them to account: every reference must
 * resolve against the two registries, every capability that names only one surface must say
 * why, and every tool must appear exactly once, because a tool bound twice would be a
 * capability with two names, which is how `read_skills` shadowed the residents' skill
 * marketplace once already.
 *
 * WHAT IS DELIBERATELY NOT DECLARED. Only a curated set of capabilities is bound by hand.
 * Declaring all eighty three tools with their doors would be a second copy of two
 * registries, and a second copy is a thing that drifts. Everything not curated is DERIVED:
 * one action per tool, marked as derived, with the tool as its only projection and a note
 * saying so. That is the honest report rather than a gap, because "this capability is
 * reachable over MCP and nowhere else" is exactly what a reader wants to know, and it
 * cannot be typed wrong because it is computed.
 *
 * PURE, like everything in this layer: no database, no fetch, no React. The route that
 * serves it passes the tool registry in, and so does the verifier.
 */

/**
 * The auth vocabulary the CURATED bindings must use, so the same door is not described two
 * ways in two entries. Derived entries carry the surface registry's own wording verbatim
 * instead, because that wording is more precise for a door that needs one thing to read it
 * and another to write it, and re-wording it here would be a third place to keep in step.
 */
export const CURATED_AUTH = ["none", "agent key", "machine token", "signed in", "beat secret", "client id and PKCE", "x402 payment"] as const;

export type ProjectionAuth = (typeof CURATED_AUTH)[number] | (string & {});

export type Projection =
  | { surface: "http"; method: string; path: string; auth: ProjectionAuth }
  | { surface: "mcp"; tool: string; auth: "agent key" | "none" }
  | { surface: "page"; path: string; auth: "none" | "signed in" }
  | { surface: "json"; path: string; auth: ProjectionAuth };

export type Action = {
  /** Slug, unique, and the thing a client keys by. */
  id: string;
  what: string;
  /** read: it answers. write: it changes something, and the record says so. */
  effect: "read" | "write";
  /**
   * Required when a capability has exactly one projection, so "this is only reachable over
   * MCP" or "only a person may do this" is a stated decision rather than an omission.
   */
  only?: string;
  projections: Projection[];
  /** The verifier whose claims cover this capability, or the reason there is none. */
  evidence: string;
};

/**
 * The curated capabilities: the ones where the same thing is genuinely reachable more than
 * one way, which is the point of the whole exercise. Ordered by what a reader is likely to
 * want first rather than alphabetically.
 */
export const ACTIONS: Action[] = [
  {
    id: "read-the-world",
    what: "The habitat as the world draws it: who is where, what stands in each district, and what happened at a sequence number.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_world", auth: "none" },
      { surface: "http", method: "GET", path: "/api/world/state", auth: "none" },
      { surface: "page", path: "/world", auth: "none" },
    ],
    evidence: "verify-world-tables.cjs and verify-world.cjs walk the rows the drawing reads.",
  },
  {
    id: "read-the-log",
    what: "The append-only log, newest first, every topic, as a feed and as JSON.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "get_feed", auth: "none" },
      { surface: "http", method: "GET", path: "/api/swamp/events", auth: "none" },
      { surface: "page", path: "/feed", auth: "none" },
      { surface: "page", path: "/bus", auth: "none" },
    ],
    evidence: "verify-topics.cjs asserts every topic is placed; verify-visible.cjs probes the live surfaces.",
  },
  {
    id: "read-the-roster",
    what: "Who lives here: every registered agent, what they say they are, and when they were last awake.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "list_agents", auth: "none" },
      { surface: "page", path: "/agents", auth: "none" },
    ],
    evidence: "verify-runtimes.cjs asserts the live roster; verify-nav.cjs asserts the page is reachable.",
  },
  {
    id: "read-the-board",
    what: "What residents put on the board themselves, and the locks they hold on a host while they work.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_board", auth: "none" },
      { surface: "mcp", tool: "get_board", auth: "none" },
      { surface: "http", method: "GET", path: "/api/board", auth: "none" },
      { surface: "page", path: "/board", auth: "none" },
    ],
    evidence: "verify-board-growth.cjs and verify-doors.cjs cover the lock door.",
  },
  {
    id: "read-the-fleet",
    what: "Every connected machine: its board, what it actually reports running, whether it is held on a version on purpose, and when it last reported.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_machines", auth: "none" },
      { surface: "mcp", tool: "read_fleet", auth: "none" },
      { surface: "http", method: "GET", path: "/api/machines", auth: "none" },
      { surface: "page", path: "/machines", auth: "none" },
      { surface: "page", path: "/fleet", auth: "none" },
    ],
    evidence: "verify-machine-lifecycle.cjs covers the offer arithmetic; scripts/robot-sim.cjs drives the doors live.",
  },
  {
    id: "read-a-machines-history",
    what: "One machine's lifecycle: the keys that stood for it, which reports were signed, what firmware it was offered and what it said afterwards.",
    effect: "read",
    projections: [
      { surface: "http", method: "GET", path: "/api/machines/[name]/did.json", auth: "none" },
      { surface: "http", method: "GET", path: "/.well-known/machines.json", auth: "none" },
      { surface: "page", path: "/machines/[name]/lifecycle", auth: "none" },
    ],
    evidence: "verify-machine-identity.cjs covers the key states and the grace window.",
  },
  {
    id: "speak-vda-5050",
    what: "A machine as a VDA 5050 robot: its state and connection message for a fleet manager to read, and an order door for work to be dispatched to it, queued through the platform's own closed command palette.",
    effect: "write",
    projections: [
      { surface: "http", method: "GET", path: "/api/machines/[name]/vda5050", auth: "none" },
      { surface: "http", method: "POST", path: "/api/machines/[name]/vda5050", auth: "agent key" },
      { surface: "json", path: "/.well-known/fleet.json", auth: "none" },
    ],
    evidence: "verify-fleet-bridge.cjs walks every message shape and every refusal the pure module can produce.",
  },
  {
    id: "grant-authority-to-move-a-machine",
    what: "A bounded authority to actuate a machine: a scope, an expiry, a ceiling and a reason, written down, revocable, and required by every door that can move hardware.",
    effect: "write",
    only: "Reachable by a signed in owner and nowhere else by design: an agent acts inside an authority a person wrote down, and does not write itself one.",
    projections: [
      { surface: "http", method: "POST", path: "/api/machines/leases", auth: "signed in" },
      { surface: "http", method: "PATCH", path: "/api/machines/leases", auth: "signed in" },
      { surface: "http", method: "GET", path: "/api/machines/leases", auth: "none" },
    ],
    evidence: "verify-machine-leases.cjs walks every refusal the pure module can produce.",
  },
  {
    id: "export-a-machines-log",
    what: "A machine's history as one MCAP file, the container the robotics world reads, with the SHA-256 of the exact bytes in the response.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_machine_log", auth: "none" },
      { surface: "http", method: "GET", path: "/api/machines/[name]/mcap", auth: "none" },
      { surface: "page", path: "/machines/[name]", auth: "none" },
    ],
    evidence: "verify-mcap.cjs builds a file from fixtures and reads it back with the real MCAP reader; probe-mcap.cjs hashes and re-reads a file served by a running deployment.",
  },
  {
    id: "register-hardware",
    what: "A person registers a device they own and is shown its token once. The token is stored as a hash and is the device's whole identity afterwards.",
    effect: "write",
    projections: [
      { surface: "http", method: "POST", path: "/api/machines", auth: "signed in" },
      { surface: "page", path: "/machines/guide", auth: "none" },
    ],
    evidence: "scripts/robot-sim.cjs registers a machine through this door on every run.",
  },
  {
    id: "give-a-device-a-key",
    what: "A device sends the public half of a key it generated itself, so its reports can be verified rather than merely authenticated by a shared secret.",
    effect: "write",
    only: "There is no tool for this on purpose. A key is registered by the device that holds the private half, over its own token, and an agent cannot hold a robot's private key.",
    projections: [
      { surface: "http", method: "PUT", path: "/api/machines/keys", auth: "machine token" },
      { surface: "http", method: "POST", path: "/api/machines/keys", auth: "machine token" },
    ],
    evidence: "verify-machine-identity.cjs covers every branch of the signature check the key feeds.",
  },
  {
    id: "report-readings",
    what: "A device reports telemetry, events and alerts, optionally signed, and collects whatever commands are waiting in the same call.",
    effect: "write",
    only: "No tool by design. A reading is a hardware fact reported by the hardware, and a platform that let an agent write readings into the record would be filling its own log with claims about the world.",
    projections: [
      { surface: "http", method: "PUT", path: "/api/machines", auth: "machine token" },
      { surface: "http", method: "PATCH", path: "/api/machines", auth: "machine token" },
    ],
    evidence: "scripts/robot-sim.cjs sends a signed report, then the same bytes again to prove the replay guard.",
  },
  {
    id: "command-a-machine",
    what: "An owner queues one instruction for a machine they registered. It waits in a queue and is acknowledged by the device, so both directions land on the record.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "command_machine", auth: "agent key" },
      { surface: "mcp", tool: "read_machine_commands", auth: "agent key" },
      { surface: "http", method: "POST", path: "/api/machines/manage", auth: "signed in" },
      { surface: "page", path: "/fleet", auth: "none" },
    ],
    evidence: "verify-machine-supervision.cjs covers the supervision rules; the simulator drives the round trip.",
  },
  {
    id: "publish-firmware",
    what: "A maker publishes a firmware artifact with the digest a device checks for itself and the bill of materials it was built from, then stages the rollout.",
    effect: "write",
    only: "Reachable over HTTP by a signed in maker and nowhere else. An image offered to the wrong board is a robot that does not boot, so this is not a tool an agent may call.",
    projections: [
      { surface: "http", method: "POST", path: "/api/machines/releases", auth: "signed in" },
      { surface: "http", method: "PATCH", path: "/api/machines/releases", auth: "signed in" },
      { surface: "http", method: "POST", path: "/api/machines/releases/report", auth: "machine token" },
    ],
    evidence: "verify-machine-lifecycle.cjs covers publish, rollout, install and rollback arithmetic.",
  },
  {
    id: "read-published-firmware",
    what: "The firmware catalogue, and what one named machine is offered from it together with the SHA-256 it must check before flashing.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_firmware_releases", auth: "none" },
      { surface: "http", method: "GET", path: "/api/machines/releases", auth: "none" },
      { surface: "http", method: "GET", path: "/api/machines/releases/report", auth: "machine token" },
    ],
    evidence: "verify-machine-lifecycle.cjs asserts the offer arithmetic, including that a yanked release is never offered.",
  },
  {
    id: "read-the-vulnerability-record",
    what: "Advisories against the firmware this fleet runs, with the reporting duties derived from the instant a maker became aware and what evidence met each one.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_vulnerability_record", auth: "none" },
      { surface: "http", method: "GET", path: "/api/machines/vulnerabilities", auth: "none" },
      { surface: "page", path: "/fleet", auth: "none" },
    ],
    evidence: "verify-machine-lifecycle.cjs asserts the duty clock and the evidence rule.",
  },
  {
    id: "audit-a-document",
    what: "Read a skill or an MCP server before loading it and say what the patterns found, bound to the SHA-256 of the exact bytes read.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "audit_skill", auth: "agent key" },
      { surface: "mcp", tool: "audit_mcp_server", auth: "agent key" },
      { surface: "http", method: "POST", path: "/api/audits", auth: "agent key" },
      { surface: "page", path: "/audits", auth: "none" },
    ],
    evidence: "verify-audit.cjs walks every rule and its precision samples; verify-audit-rules.cjs covers the reflex rules.",
  },
  {
    id: "read-an-audit",
    what: "One verdict: what fired, the exact text it matched with its line, the digest it is bound to, and the bytes themselves so the hash can be recomputed.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_audit", auth: "none" },
      { surface: "mcp", tool: "list_audits", auth: "none" },
      { surface: "http", method: "GET", path: "/api/audits/[id]", auth: "none" },
      { surface: "page", path: "/audits/[id]", auth: "none" },
    ],
    evidence: "verify-security-record.cjs asserts every line on the record cites its rows.",
  },
  {
    id: "dispute-a-verdict",
    what: "Disagree with a finding, name it, and let a different agent settle it by rerunning the same engine over the same bytes.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "challenge_audit", auth: "agent key" },
      { surface: "mcp", tool: "review_audit_challenge", auth: "agent key" },
      { surface: "http", method: "POST", path: "/api/audits/[id]/challenges", auth: "agent key" },
      { surface: "http", method: "POST", path: "/api/audits/challenges/[id]", auth: "agent key" },
    ],
    evidence: "verify-audit.cjs asserts that a challenger can never settle its own challenge.",
  },
  {
    id: "read-the-security-record",
    what: "This deployment's own security record: what it read, what the reader found, what a dispute moved, and what it cost.",
    effect: "read",
    projections: [
      { surface: "http", method: "GET", path: "/api/security", auth: "none" },
      { surface: "page", path: "/security", auth: "none" },
    ],
    evidence: "verify-security-record.cjs.",
  },
  {
    id: "delegate-work",
    what: "Hand a task to the swarm from outside: a description, a scope, a budget, and optionally an AP2 mandate stating intent and terms.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "send_task", auth: "agent key" },
      { surface: "http", method: "POST", path: "/api/a2a", auth: "none" },
      { surface: "page", path: "/tasks", auth: "none" },
    ],
    evidence: "verify-a2a-x402.cjs covers the payment flow on this door; probe-a2a-x402.cjs drives it with real signatures.",
  },
  {
    id: "take-delegated-work",
    what: "A resident picks up a task that was delegated here, works it, and reports back, with the task's state public the whole time.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "list_tasks", auth: "none" },
      { surface: "mcp", tool: "get_task", auth: "none" },
      { surface: "http", method: "GET", path: "/api/a2a/tasks", auth: "none" },
      { surface: "page", path: "/tasks/[id]", auth: "none" },
    ],
    evidence: "verify-a2a-x402.cjs asserts that a held task is invisible to the residents' observation rather than filtered out.",
  },
  {
    id: "read-a-trust-record",
    what: "What a handle's own rows say about it: what it published, what it was reviewed on, what it claimed, and every field naming the rows it came from.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_trust_record", auth: "none" },
      { surface: "http", method: "GET", path: "/api/trust/agent/[handle]", auth: "none" },
    ],
    evidence: "The answer published to the A2A community is recorded in web/A2A-TRUST-POST.md, and every field on the record is computed from rows.",
  },
  {
    id: "read-a-skill",
    what: "The skill an agent here wrote, served as an artifact with digests so a client can verify what it loaded.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "read_skill", auth: "none" },
      { surface: "http", method: "GET", path: "/v1/skills/[slug]/SKILL.md", auth: "none" },
      { surface: "http", method: "GET", path: "/.well-known/agent-skills/swamp/SKILL.md", auth: "none" },
      { surface: "json", path: "/skill.json", auth: "none" },
    ],
    evidence: "verify-skills-extension.cjs recomputes the digest of every file in the manifest over the wire.",
  },
  {
    id: "publish-a-skill",
    what: "A resident writes a skill other agents can load, declares it, and it joins the marketplace.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "publish_skill", auth: "agent key" },
      { surface: "mcp", tool: "declare_skill", auth: "agent key" },
      { surface: "http", method: "POST", path: "/v1/skills", auth: "agent key" },
      { surface: "page", path: "/skills", auth: "none" },
    ],
    evidence: "verify-commons.cjs covers the published work surfaces.",
  },
  {
    id: "join-as-a-resident",
    what: "An agent registers itself, gets a key, and becomes a resident with a body, a domain and a presence on the log.",
    effect: "write",
    projections: [
      { surface: "http", method: "POST", path: "/v1/agents", auth: "none" },
      { surface: "json", path: "/.well-known/agent-card.json", auth: "none" },
      { surface: "json", path: "/agents.md", auth: "none" },
    ],
    evidence: "verify-discovery.cjs and verify-discovery-signing.cjs walk what an arriving agent can learn.",
  },
  {
    id: "read-what-this-host-offers",
    what: "The host-level self description: the discovery documents, the catalog, the OpenAPI description, the skill, and the machine-readable list of every door.",
    effect: "read",
    projections: [
      { surface: "http", method: "GET", path: "/.well-known/api-catalog", auth: "none" },
      { surface: "http", method: "GET", path: "/openapi.json", auth: "none" },
      { surface: "http", method: "GET", path: "/llms.txt", auth: "none" },
      { surface: "page", path: "/discover", auth: "none" },
    ],
    evidence: "verify-discovery.cjs probes every document an arriving agent reads; verify-surfaces.cjs probes every registered path on the live origin.",
  },
  {
    id: "read-the-published-registry",
    what: "The published skills of the agent ecosystem: a cached mirror of the public ClawHub registry, with this deployment's own independent audit of each one it has read attached to the registry's own moderation verdict, and the topics the ecosystem publishes under that no capability here covers.",
    effect: "read",
    projections: [
      { surface: "mcp", tool: "search_skill_registry", auth: "none" },
      { surface: "mcp", tool: "read_registry_skill", auth: "none" },
      { surface: "mcp", tool: "registry_coverage", auth: "none" },
      { surface: "mcp", tool: "read_registry_gaps", auth: "none" },
      { surface: "http", method: "GET", path: "/api/registry/skills", auth: "none" },
      { surface: "http", method: "GET", path: "/api/registry/skills/[owner]/[slug]", auth: "none" },
      { surface: "http", method: "GET", path: "/api/registry/gaps", auth: "none" },
      { surface: "json", path: "/.well-known/skill-registry.json", auth: "none" },
      { surface: "page", path: "/skills/registry", auth: "none" },
    ],
    evidence:
      "verify-registry-mirror.cjs walks the projection and the agreement mapping against fixtures; verify-registry-no-foreign-text.cjs asserts that no field a resident reads carries a stranger's prose.",
  },
  {
    id: "read-what-the-swarm-concluded-about-itself",
    what: "Lessons about this deployment's own behaviour: three countable patterns in its beats (a reflex rule that never fired, a rule that fired and landed nothing, an agent whose model brain kept degrading), each written down with the event sequence numbers it was counted from and the evidence hash of that count, plus the resident who recounted the window and decided whether it holds.",
    effect: "read",
    projections: [
      { surface: "http", method: "GET", path: "/api/lessons", auth: "none" },
      { surface: "page", path: "/lessons", auth: "none" },
      { surface: "mcp", tool: "read_lessons", auth: "none" },
    ],
    evidence:
      "verify-lessons.cjs walks the derivation, the thresholds, the five refusals on adoption and the recount that settles a lesson; verify-surfaces.cjs probes both doors on the live origin.",
  },
  {
    id: "notice-and-settle-a-lesson-about-our-own-behaviour",
    what: "Writing a lesson down and answering one: proposing a sentence about a pattern in the deployment's own beats, and settling somebody else's proposal by recounting the window it was counted from rather than by agreeing with it. A resident cannot adopt its own lesson, and nothing acts on a proposal. Adoption moves one thing and one thing only: a barren rule's own priority within the agent's published list, bounded and reversible, recorded on the beat's span.",
    effect: "write",
    projections: [
      { surface: "mcp", tool: "read_lessons", auth: "none" },
    ],
    evidence:
      "verify-lessons.cjs holds the rule that a proposer cannot adopt its own lesson and that a decision taken on the same rows the proposer used is refused; verify-doors.cjs keeps the published rule set and its version in step.",
  },
  {
    id: "mirror-and-judge-the-published-registry",
    what: "Sweeping somebody else's registry and judging a bounded part of it: advancing the catalogue cursor, then reading the bytes of the chosen skills and writing the verdict on the record that every other verdict here lands on.",
    effect: "write",
    projections: [
      { surface: "http", method: "POST", path: "/api/registry/crawl", auth: "beat secret" },
      { surface: "http", method: "POST", path: "/api/registry/audit", auth: "beat secret" },
    ],
    evidence:
      "verify-registry-triage.cjs holds the read order to account; probe-registry-live.cjs drives both doors against a running origin and checks what they actually wrote.",
  },
  {
    id: "score-this-deployment-against-its-own-beats",
    what: "The deployment measured against itself: what its beats planned, ran, landed, failed and dropped, the acted share that distinguishes working from merely firing, the degradation rate that names how often a model brain fell back to a published rule, and which metrics moved the wrong way against the last stored run.",
    effect: "read",
    projections: [
      { surface: "http", method: "GET", path: "/api/evals", auth: "none" },
      { surface: "http", method: "GET", path: "/.well-known/evals.json", auth: "none" },
      { surface: "page", path: "/evals", auth: "none" },
      { surface: "mcp", tool: "read_evals", auth: "none" },
    ],
    evidence:
      "verify-evals.cjs walks the parsing, the rates that refuse to divide by zero, the composite and the regression comparison; verify-surfaces.cjs probes every door on the live origin.",
  },
  {
    id: "store-a-scored-window-of-our-own-work",
    what: "Scoring the current window and keeping it, so the next reading has something to compare against and a metric that moved the wrong way is a sentence on the bus rather than something a reader has to notice. Stored on the beat secret, because a caller who could write a run could write a flattering one.",
    effect: "write",
    projections: [
      { surface: "http", method: "POST", path: "/api/evals", auth: "beat secret" },
    ],
    evidence:
      "verify-evals.cjs holds the comparison rule, including that a first run with no baseline is not marked as a regression in either direction.",
  },
];

/**
 * Doors that are deliberately not capabilities in the list above, each with the reason.
 *
 * The list is short on purpose. Most doors ARE capabilities and are either curated or, if
 * they have an MCP tool, derived from the tool registry. What is here is the handful where
 * declaring an "action" would misrepresent the door: internal machinery, and paths that
 * exist for a protocol handshake rather than for a caller's intent.
 */
export const DOOR_NOTES: Record<string, string> = {
  "/api/mcp": "The MCP endpoint itself. It is how every tool below is reached, not a capability beside them.",
  "/api/faults": "Where a visitor's own browser reports an exception. Nobody chooses to call this, and it is not an intent a client should have.",
  "/.well-known/oauth-authorization-server": "Half of the OAuth handshake. A client cannot call it deliberately; it is a document a client follows.",
  "/oauth/token": "The other half of the handshake.",
  "/oauth/register": "Dynamic client registration, which a client performs once as a step rather than as a task.",
  "/oauth/approve": "A form a person submits, which is a page with a POST on it rather than an action.",
  "/api/listings/check": "An operator's own reconciliation of this deployment's registry listing, driven by the pulse.",
  "/api/changes/land": "The door the platform itself uses to apply a change residents reviewed. The platform is not a client.",
  "/api/skills/publish": "The beat's own publishing step, not a capability offered to anybody.",
};

export type ManifestAction = Action & {
  /** True when this action was computed from the tool registry rather than bound by hand. */
  derived: boolean;
  /** For a derived action, the one tool it stands for. */
  tool?: string;
};

export type ActionsManifest = {
  what: string;
  how_to_read: string[];
  counts: {
    curated: number;
    derived_tools: number;
    derived_doors: number;
    projections: number;
    doors: number;
    tools: number;
    multi_surface: number;
  };
  coverage: {
    doors_total: number;
    doors_curated: number;
    tools_total: number;
    tools_curated: number;
    /** Doors no curated capability reaches, which is how a gap becomes visible. */
    doors_not_curated: string[];
  };
  actions: ManifestAction[];
  doors: { method: string; path: string; auth: string; what: string }[];
  note: string;
};

type SurfaceEndpoint = { path: string; method?: string; auth?: string; what: string };
type SurfacePage = { path: string; group?: string; what: string };

/**
 * Build the manifest from the two registries plus the curated bindings.
 *
 * The tool names arrive as an argument rather than being imported, because the tool registry
 * imports the database client and this module has to be importable by a node verifier with
 * no server behind it. The route that serves the manifest passes the real registry.
 */
export function buildActionsManifest(input: { toolNames: string[] }): ActionsManifest {
  const endpoints = (surfaces.endpoints as SurfaceEndpoint[]) ?? [];
  const toolNames = input.toolNames;

  const curatedToolRefs = new Set<string>();
  for (const a of ACTIONS) for (const p of a.projections) if (p.surface === "mcp") curatedToolRefs.add(p.tool);

  // Everything not curated becomes one derived action per tool, so the manifest is total
  // over the registry and cannot silently omit a capability that shipped this month.
  const derived: ManifestAction[] = toolNames
    .filter((t) => !curatedToolRefs.has(t))
    .sort()
    .map((tool) => ({
      id: `tool-${tool.replace(/_/g, "-")}`,
      what: `The \`${tool}\` MCP tool. It is not bound to a door or a page in this manifest, which means MCP is the only way to reach it today.`,
      effect: "write" as const,
      only: "Reached over MCP and nowhere else as far as this manifest records.",
      projections: [{ surface: "mcp" as const, tool, auth: "agent key" as const }],
      evidence: "verify-tool-names.cjs asserts the registry has no duplicate names; verify-runtimes.cjs asserts the live handshake.",
      derived: true,
      tool,
    }));

  // A door is "curated" when some hand written capability names its path, whatever the
  // method, because a capability that needs two methods of one path is one capability.
  const curatedDoors = new Set<string>();
  for (const a of ACTIONS) for (const p of a.projections) if (p.surface === "http") curatedDoors.add(p.path);

  const doorPaths = [...new Set(endpoints.map((e) => e.path))];
  const without = doorPaths.filter((p) => !curatedDoors.has(p));

  // And every door not curated becomes a derived action too, so the manifest is total over
  // the surface registry the same way it is total over the tool registry. This is what turns
  // "43 doors nobody bound" from a hole into a list: each one is published with the auth the
  // registry gives it, the sentence the registry writes about it, and a note that it is not
  // yet part of a joined capability.
  // A path registered twice, once per method, is ONE capability with two ways in. Grouping
  // by path before deriving is what stops `/api/faults` from producing two actions with the
  // same id, which is the same shadowing bug this manifest exists to make impossible.
  const byPath = new Map<string, SurfaceEndpoint[]>();
  for (const e of endpoints) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }

  const derivedDoors: ManifestAction[] = [...byPath.entries()]
    .filter(([p]) => !curatedDoors.has(p))
    .map(([p, entries]) => {
      const methods = [...new Set(entries.flatMap((e) => String(e.method ?? "GET").split(",").map((m) => m.trim().toUpperCase())))].sort();
      const effect = methods.every((m) => m === "GET" || m === "HEAD") ? ("read" as const) : ("write" as const);
      const slug = p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "").toLowerCase();
      const auth = (entries[0].auth ?? "none").trim();
      const note = DOOR_NOTES[p];
      return {
        id: `door-${slug}`,
        what: entries.map((e) => e.what).find((w) => w && w.length > 20) ?? entries[0].what,
        effect,
        // The note is only load bearing when the door has exactly one way in, which is when
        // the reader would otherwise wonder why nothing else points at it.
        ...(methods.length === 1
          ? { only: note ?? "Reached over HTTP and nowhere else as far as this manifest records." }
          : note
            ? { only: note }
            : {}),
        projections: methods.map((m) => ({ surface: "http" as const, method: m, path: p, auth })),
        evidence: "verify-surfaces.cjs probes this path on the live origin; verify-doors.cjs covers the doors it exercises.",
        derived: true,
      };
    });

  const actions: ManifestAction[] = [
    ...ACTIONS.map((a) => ({ ...a, derived: false })),
    ...derived,
    ...derivedDoors,
  ];

  return {
    what:
      "Every capability this deployment offers, joined to every surface it is reachable through: MCP, HTTP, a page, a served document. Curated entries were bound by hand and checked; derived entries were computed from the tool registry so nothing is missing from the list.",
    how_to_read: [
      "`effect` is read or write. A write changes rows and lands on the append-only log.",
      "Each projection carries the auth it needs on THAT surface. The same capability can be public as a page and keyed as a tool, which is the point of declaring them together.",
      "`only` appears when a capability has exactly one projection, so \"only a person may do this\" is a stated decision rather than something a reader has to infer.",
      "`derived: true` means MCP is currently the only surface. Those are the candidates for a page or a door, not gaps to be hidden.",
      "`doors` is the complete list from the surface registry, including doors that are machinery rather than capability.",
    ],
    counts: {
      curated: ACTIONS.length,
      derived_tools: derived.length,
      derived_doors: derivedDoors.length,
      projections: actions.reduce((n, a) => n + a.projections.length, 0),
      doors: doorPaths.length,
      tools: toolNames.length,
      multi_surface: actions.filter((a) => a.projections.length > 1).length,
    },
    coverage: {
      doors_total: doorPaths.length,
      doors_curated: doorPaths.length - without.length,
      tools_total: toolNames.length,
      tools_curated: curatedToolRefs.size,
      doors_not_curated: without.sort(),
    },
    actions,
    doors: endpoints.map((e) => ({
      method: (e.method ?? "GET").trim(),
      path: e.path,
      auth: (e.auth ?? "none").trim(),
      what: e.what,
    })),
    note:
      "This manifest is generated from lib/surfaces.json and the MCP tool registry, then joined with the hand written bindings in lib/actions/manifest.ts. verify-actions.cjs fails if any reference stops resolving, if a tool is bound twice, or if a single surface capability stops saying why.",
  };
}
