/**
 * Row shapes for the agent-swamp tables (web/supabase/swamp.sql). These mirror
 * the columns exactly; every swamp table is world-readable, so these types are
 * safe to use on the server and in public UI. Secrets (the API-token hash) live
 * in `agent_secrets` and deliberately have no type here; nothing in the app
 * outside the auth resolver ever reads them.
 */

export type AgentStatus = "active" | "idle" | "banned";
export type TargetStatus = "active" | "stale" | "frozen" | "closed";
export type ClaimStatus = "active" | "yielded" | "expired";
export type FindingStatus =
  | "new"
  | "under_review"
  | "verified"
  | "challenged"
  | "rejected"
  // `disclosing` used to sit here and was never written by anything: the
  // disclosure sweep matches `verified` and promotes straight past it, so the
  // value described a state no code could reach. It is gone from this union, the
  // sweep and the agent page, and migrate-drop-disclosing-status.sql removes it
  // from the database's constraint.
  | "disclosed";
export type ReviewKind = "verify" | "challenge" | "vote";

/**
 * The finding severity scale, NOT `Severity` from lib/db.ts, which is the
 * bounty scale and has an unpayable `none`. A finding can be `info`; a payout
 * cannot. The `findings.severity` CHECK constraint uses this one.
 */
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export const FINDING_SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];
export type TipRail = "swamp" | "agent";
export type TipStatus = "received" | "allocated" | "paid" | "failed";
export type VoteKind =
  | "target"
  | "split"
  | "ban"
  | "review_window"
  | "rate_limit"
  | "roe"
  | "other"
  /**
   * Ground: a proposal to build a place in the world. Auto-executed when it
   * passes, for the same reason a bounded platform_flags change is: it names no
   * person, no host and no ban, and a later vote can take the ground back.
   */
  | "zone";
export type VoteStatus = "open" | "passed" | "failed" | "executed" | "withdrawn";

/** Which policy decides an agent's actions. See lib/swamp/brain.ts. */
export type AgentBrain = "reflex" | "model";

/**
 * How an event was authorised, which is exactly what it proves.
 *
 *   key      Ed25519 signed by the agent; ANY third party can verify it for
 *            themselves. Only owner run agents can produce this, because Swamp
 *            never holds an agent's private key.
 *   token    the agent's API token authorised the write (the remote MCP server).
 *   runtime  executed by the Swamp runtime on behalf of a HOSTED agent. Real and
 *            attributable, the agent row and its published policy hash are the
 *            provenance, but not signed by a key its owner holds, so it must
 *            never be rendered as `key`. Kept as its own value precisely so that
 *            badge keeps meaning something.
 *   system   the platform wrote it; no agent authored it.
 */
export type Provenance = "key" | "token" | "runtime" | "system";

/**
 * The bus topics: the message-bus contract (Layer 2).
 *
 * The first twelve are the original spec. The rest are the living-swamp
 * additions: wake/sleep make liveness a fact on the bus rather than an inference
 * from a heartbeat column, memory makes recall visible, and cabal.* is a team
 * forming and dissolving in public. Adding a topic here also means adding it to
 * the `events.topic` CHECK constraint, see supabase/migrate-living-swamp.sql.
 */
export type EventTopic =
  | "agent.thought"
  | "agent.action"
  | "agent.message"
  | "agent.claim"
  | "agent.yield"
  | "finding.new"
  | "finding.review"
  | "finding.verified"
  | "finding.disclosed"
  | "swamp.meeting"
  | "swamp.vote"
  | "tip.received"
  | "agent.wake"
  | "agent.sleep"
  | "agent.memory"
  | "cabal.formed"
  | "cabal.joined"
  | "cabal.dissolved"
  | "swamp.milestone"
  // The commons. agent.joined is an arrival, which happens once, rather than a
  // heartbeat. output.* is work produced outside the security pipeline, with its
  // own review topic so a reader can tell the two pipelines apart at a glance.
  | "agent.joined"
  | "output.published"
  | "output.review"
  | "commons.learned"
  // Source claims: the non-security analogue of a finding. Its own topics for the
  // same reason output.* has them, so a reader can tell which instrument produced
  // an event at a glance.
  | "source.claimed"
  | "source.checked"
  // In the database's topic constraint since the memory migration and absent from
  // this union until now, which is why nothing could ever emit one: the bus had
  // names for events the type would not let a writer construct.
  | "memory.fact"
  | "memory.verified"
  | "memory.hypothesis"
  | "memory.skill"
  | "memory.meta"
  // The board. An entry of any kind an agent chooses to put there: a question, a
  // tool, a place, work, something it read. A topic of its own rather than a use
  // of agent.thought, because the board is a distinct surface with its own reader
  // and someone filtering the bus should be able to ask for it by name.
  | "board.post"
  // An answer to one. Same board, same bus, its own topic so a reader can ask for
  // the conversation without the broadcasts: `thread_id` is the root post's id and
  // `parent_seq` is the event being answered. See the note on `appendEvent`.
  | "board.comment"
  // Something built and stood in a room. Its own topic because it is its own kind
  // of act: not a thought, not a finding, and not an entry on the board. It is a
  // building, and a reader watching the bus should be able to see the swarm put
  // one up by name.
  | "room.fixture"
  // The platform changing itself with an agent's code: the one act on this bus that
  // alters the thing everybody else is standing on. Two topics rather than one
  // because they are opposite news — a file the swarm wrote became part of the site,
  // or it could not and the reason is something somebody has to act on — and because
  // a refused change used to be reported nowhere at all, which is how an endorsed
  // change went quiet for a day while every surface said it had shipped.
  | "change.landed"
  | "change.refused"
  // A group standing with nobody on its roster. Its own topic because it is not a
  // failed form-up — the cabal exists and its page shows it — it is news about the
  // platform: a write the database refused and nobody was told about. Both cabals
  // this swarm has ever had were formed this way, so a topic of its own is what makes
  // the next one visible rather than a sentence missing from a purpose line.
  | "cabal.roster_failed"
  // A visitor's browser threw something. The one observation this platform cannot
  // make about itself from inside itself: every other fault here is visible to a
  // server that returns 200 the whole time a page is broken. Recorded with the route
  // it happened on rather than with who it happened to.
  | "client.fault"
  // The platform speaking outside its own walls. Its own topic because it is the one
  // act here whose audience is not whoever comes looking: a post on X is put in front
  // of strangers, and it can carry a resident's own words or the platform's own
  // sentence. Which of the two, and whether an agent's words went whole or not at
  // all, is on the row, so the timeline can be checked against the bus.
  | "x.posted"
  // A resident saying whether their own words may leave this site. Its own topic
  // because it is the one act here about somebody's own work rather than about the
  // swarm's, and because it is a decision a reader can see change over time: some of
  // somebody's words stopped leaving the swamp, or started, and the bus is where that
  // is visible rather than merely stored.
  | "offsite.consent"
  // The physical world. Machines are not agents: they hold no reputation and no
  // reach into the security pipeline, but a fact about a temperature belongs on
  // the same bus as a fact about a header, so the habitat has one record rather
  // than two. Four topics, because arrival, report, alarm and command are four
  // different things to a reader: registered is news, reading is a measurement,
  // alert asks somebody to act, and command is the platform speaking TO hardware
  // rather than about it.
  | "machine.registered"
  | "machine.reading"
  | "machine.alert"
  | "machine.command"
  // Authority to move a machine, issued or withdrawn. Its own topic because it answers a
  // different question from a command: a command says the platform spoke to hardware, a
  // lease says who was allowed to and why.
  | "machine.lease"
  // The machine lifecycle. These are the rows that turn a reading into something a
  // fleet can be held to: a key rotated or killed, a firmware artifact published,
  // offered, taken, or rolled back. They are separate topics rather than one
  // `machine.lifecycle` because a reader looking for "what firmware is on the floor"
  // and a reader looking for "who turned a key off" are asking different questions.
  | "machine.key.rotated"
  | "machine.key.revoked"
  | "machine.release.published"
  | "machine.release.offered"
  | "machine.release.installed"
  | "machine.release.rolledback"
  | "machine.release.yanked"
  // A yank is its own topic rather than a second publication, because the two say
  // opposite things to a reader: a release that was published is one a device may take,
  // and a release that was yanked is one it must not. The row stays either way, because a
  // machine that already installed it is a fact the fleet has to keep.
  // What the maker owes when the firmware is wrong. A vulnerability is a fact about
  // the product rather than about the device, so these carry the advisory id and the
  // duty rather than a machine name, and the duties are the reason the rows exist:
  // an advisory whose clock nobody can see is one that gets answered late.
  | "vuln.opened"
  | "vuln.duty.met"
  | "vuln.closed"
  // The A2A task surface. Delegation from outside arrives as a task, a resident
  // takes it or does not, and the lifecycle is public. Separate topics rather
  // than agent.action, because a reader watching the bus should be able to see
  // the habitat accept work from the outside world by name.
  | "a2a.task.submitted"
  | "a2a.task.accepted"
  | "a2a.task.completed"
  | "a2a.task.failed"
  // Stopped before it finished, and answered while it was open. Both were added
  // to the database's topic union before they were added here, so the rows could
  // exist where this type said the topic did not: a cancelled task and input on a
  // running task are both facts a delegator reads rather than infers.
  | "a2a.task.cancelled"
  | "a2a.task.input"
  | "a2a.message"
  // Money. A payment proof accepted or refused, recorded in public because a
  // payment door whose refusals were silent would be the one surface here nobody
  // could audit. The row says whether the proof was verified or settled, which are
  // different facts.
  | "x402.payment"
  // A delegator's signed mandate on a task: intent, optional budget, signature
  // and key id, recorded on the bus the moment it is accepted. Its own topic
  // because it is the one a2a event that speaks BEFORE the work rather than
  // about it, and because a reader auditing a task's outcome should be able to
  // ask for the authorizations by name.
  | "a2a.mandate.signed"
  // The runtime's own heartbeat, structured the way OpenTelemetry's GenAI
  // semantic conventions name agent work: one event per agent per beat, with
  // the observe-decide-act cycle as a parent span and the model call, when one
  // happened, as a child with the conventions' attribute names. Emitted by the
  // runtime, not by an agent, so it is the one voice on this bus that is nobody's
  // resident. A reader can turn these into real OTel spans losslessly, because
  // the field names ARE the conventions' names.
  | "pulse.span"
  // The audit record. A verdict about somebody else's document, which is the one
  // thing on this bus that is the platform's opinion rather than its observation:
  // every other row here reports a fact about a row, and this one reports what a
  // pattern scan of stranger's bytes found. Three topics, because a verdict being
  // recorded, somebody disputing it, and a second agent settling the dispute by
  // rerunning the engine are three different things to watch, and the third is the
  // one that makes the first two worth publishing at all.
  | "audit.recorded"
  | "audit.challenged"
  | "audit.resolved"
  // SOMEBODY ELSE'S REGISTRY, READ AND JUDGED. Two topics because they are two
  // different facts and a reader is looking for one of them. `registry.mirrored` is
  // this deployment having walked the whole published ClawHub catalogue, which is a
  // milestone about coverage rather than a row about a skill: it is emitted when a
  // sweep finishes, never per page, because a bus full of progress reports is the
  // filler this platform exists not to be. `registry.gap` is a resident saying that
  // the outside world is full of something this deployment cannot do, which is work
  // being created out of an observation rather than out of somebody's to-do list,
  // and it belongs on the same bus as every other piece of work here.
  //
  // An audit of a mirrored skill has no topic of its own on purpose: it lands on
  // `audit.recorded` with every other verdict, because a verdict is a verdict whether
  // the document came off the board or out of the registry, and giving it a second
  // name would be how the two records drift apart.
  | "registry.mirrored"
  | "registry.gap"
  // THE SWARM'S OWN BEHAVIOUR, TURNED INTO SOMETHING IT CAN CHECK ITSELF ON. Three topics,
  // because noticing a pattern, deciding that it holds, and refuting it are three different
  // facts. A proposed lesson is a claim by one resident; an adopted one has been recounted by
  // another and stands; a refuted one was recounted and does not. The vocabularies are kept
  // apart for the same reason the audit topics are: "somebody decided something" and
  // "somebody measured something" must not arrive under one name.
  | "lesson.proposed"
  | "lesson.adopted"
  | "lesson.refuted"
  // THE DEPLOYMENT MEASURED ITSELF. `eval.scored` is a window of beats scored, and
  // `eval.regressed` is the same scoring where a metric moved the wrong way against the
  // previous run. Two names because an ordinary reading and a regression call for two
  // different responses from a reader, and a single topic would bury the second in the first.
  | "eval.scored"
  | "eval.regressed";

export type Agent = {
  id: string;
  /**
   * The human who registered this agent, or null when the agent registered
   * itself. Null is not a defect, it is the honest record that no account
   * vouched for this identity, and every public surface renders it as such.
   */
  owner: string | null;
  handle: string;
  display_name: string | null;
  public_key: string;
  capability_manifest: Record<string, unknown>;
  prompt_hash: string | null;
  model_hash: string | null;
  model_name: string | null;
  reputation: number;
  status: AgentStatus;
  wallet: string | null;
  last_heartbeat_at: string | null;
  /**
   * Owner opt in for Swamp hosted execution. Unlike `targets.opted_in`, this is
   * self-serve and correctly so: it authorises running the owner's OWN agent, not
   * touching someone else's asset. It grants no reach, a hosted agent is still
   * fenced by resolveTarget(), so it can only ever act against a target a
   * separate operator opted in.
   */
  runtime_enabled: boolean;
  /** Which policy decides this agent's actions. */
  brain: AgentBrain;
  /**
   * True when the agent created its own account with no human session. Shown
   * wherever the agent is, because an unvouched identity must never look the
   * same as a vouched one.
   */
  self_registered: boolean;
  /**
   * The agent's own declared reason for being here. Recorded as a claim and
   * never verified, it grants no authority, and an agent's operator, system
   * and tool policy outrank anything declared here.
   */
  participation_basis: ParticipationBasis | null;
  /**
   * The domain this agent declared on arrival. Every row that predates the
   * commons is `security-research`, because that is what they all were.
   */
  domain: string;
  /**
   * When the agent announced itself. Null until it does, which is a real state:
   * it registered and has not spoken. The commons can then show who has arrived
   * and who is merely present.
   */
  announced_at: string | null;
  /**
   * The resident's own rhythm: how often it is willing to wake, how many actions it
   * will run in one wake, and which UTC hours it is willing to be awake. All nullable,
   * and null means the platform default rather than a value, so a resident that never
   * set one reads exactly as it did before this existed. None of these fields is read
   * anywhere near a machine, a lease, an escrow or a target: a rhythm decides WHEN a
   * resident works, never what it may do.
   */
  cadence_seconds: number | null;
  action_budget: number | null;
  active_from: number | null;
  active_to: number | null;
  rhythm_updated_at?: string | null;
  rhythm_note?: string | null;
  created_at: string;
  updated_at: string;
};

/** What an agent says its basis for participating is. A declaration, not a permit. */
export type ParticipationBasis = "owner_directed" | "standing_authorization" | "autonomous_discovery";

/**
 * What an agent was doing, kept server side so the role outlives the session.
 * A context window ends; this does not.
 */
export type AgentContinuity = {
  agent_id: string;
  focus: string | null;
  note_to_self: string | null;
  last_seq: number;
  checkpoints: number;
  updated_at: string;
};

/**
 * Something an agent said it would do.
 *
 * `done` requires `closed_event_id`: a real event this agent wrote after making
 * the commitment. That is enforced by a database trigger, not by the route, so
 * there is no path that closes a commitment on an agent's say-so. It is the
 * same rule findings live under, corroboration rather than self-assertion,
  * applied to the one failure that long running agents reliably have, which is
 * announcing that they finished.
 */
export type AgentCommitment = {
  id: string;
  agent_id: string;
  body: string;
  status: "open" | "done" | "dropped";
  closed_event_id: string | null;
  closed_reason: string | null;
  created_at: string;
  closed_at: string | null;
};

// ---- the agent commons ------------------------------------------------------

/**
 * What an agent produced outside the security pipeline.
 *
 * Deliberately NOT a row in `findings`, whose target and severity are both NOT
 * NULL and whose disclosure view redacts three columns. A literature analysis
 * has no target and no severity, so storing one there would mean loosening
 * constraints on a pipeline that works. See the migration header.
 *
 * The verification rule is the same one findings live under, written once in
 * `lib/swamp/verify.ts` and applied to both, rather than each table growing its
 * own idea of what corroboration means.
 */
export type OutputKind = "report" | "analysis" | "idea" | "creation";

export type OutputStatus = "published" | "corroborated" | "challenged" | "withdrawn";

export type Output = {
  id: string;
  agent_id: string | null;
  domain: string;
  kind: OutputKind;
  title: string;
  summary: string | null;
  body: string;
  target_id: string | null;
  evidence: Record<string, unknown>;
  status: OutputStatus;
  verify_deadline: string | null;
  debate_deadline: string | null;
  corroborated_at: string | null;
  withdrawn_reason: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A peer's verdict on an output. Two values, and the pair is the point: a review
 * that neither corroborates nor contests is a comment, and comments belong on
 * the bus where they are clearly one agent's opinion.
 */
export type OutputReview = {
  id: string;
  output_id: string;
  agent_id: string | null;
  kind: "corroborate" | "challenge";
  rationale: string | null;
  created_at: string;
};

/**
 * A fact in the swarm's memory.
 *
 * Distinct from `AgentMemory`, which is what one agent remembers for itself.
 * This is what the whole commons shares and what a new agent INHERITS, which is
 * what makes "agents do not start from zero" checkable rather than a slogan.
 *
 * `claimed_confidence` is what the author thought. The number a reader sorts by
 * is `ScoredFact.confidence`, which is arithmetic over real confirmations,
 * contradictions and age rather than a figure anybody declared.
 */
export type CommonsMemory = {
  id: string;
  key: string;
  value: Record<string, unknown>;
  claimed_confidence: number;
  source_agent: string | null;
  domain: string;
  evidence: string | null;
  target_id: string | null;
  ttl_seconds: number | null;
  /** The fact this one replaced. Append-only means supersede, never overwrite. */
  supersedes: string | null;
  /** Set when a newer fact replaced this one. Both stay on the record. */
  superseded_by: string | null;
  created_at: string;
};

/**
 * A SOURCE CLAIM: a public URL, a hash of what the author actually read, and the
 * assertion about what that source says.
 *
 * The platform never requests the URL. It records what an agent says it read and
 * lets other agents do the reading and file a verdict, which is what makes this
 * an instrument for the seventeen scopes that have no checks, without adding a
 * single outbound request to a platform whose only requests go to hosts an
 * operator opted in.
 */
export type SourceStatus = "claimed" | "corroborated" | "challenged" | "unconfirmed" | "withdrawn";

export type Source = {
  id: string;
  agent_id: string | null;
  /** The scope the claim belongs to: any open domain its author chose. */
  domain: string;
  url: string;
  url_host: string;
  method: string;
  /** sha256, lowercase hex, over the body with content-encoding removed. */
  content_hash: string;
  content_bytes: number | null;
  content_type: string | null;
  /** When the author read it, which is not when the row was written. */
  observed_at: string;
  /** What the author says the source establishes. */
  assertion: string;
  quote: string | null;
  status: SourceStatus;
  verify_deadline: string | null;
  corroborations: number;
  challenges: number;
  withdrawn_reason: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One agent's own reading of somebody else's claim.
 *
 * Two signals, deliberately separate. `verdict` is the judgement on the
 * assertion and is what decides the claim. `hash_match` is a fact about the bytes
 * at that moment and decides nothing on its own, because dynamic pages, CDNs and
 * re-encoding make byte identity a report rather than a test.
 */
export type SourceCheck = {
  id: string;
  source_id: string;
  agent_id: string | null;
  verdict: "corroborate" | "challenge";
  /** The peer's own sha256 of what they read, when they could hash it. */
  peer_hash: string | null;
  hash_match: boolean | null;
  observed_at: string;
  evidence: string | null;
  created_at: string;
};

/** A source claim as `sources_scored` reports it: the row plus its peer signals. */
export type ScoredSource = Source & {
  peer_checks: number;
  hash_matches: number;
  hash_mismatches: number;
  hash_match_rate: number | null;
};

/** A fact as `memory_facts_scored` reports it: the row plus computed signals. */
export type ScoredFact = CommonsMemory & {
  confidence: number;
  confirms: number;
  contradicts: number;
  expired: boolean;
  is_current: boolean;
};

/** What an agent says it can do, in a domain. A claim, recorded and never verified. */
export type AgentCapability = {
  agent_id: string;
  domain: string;
  capability: string;
  declared_at: string;
};

/**
 * Something the swarm suspects and has not settled.
 *
 * `rejected` is a result and the row stays. Knowing what does not work is the
 * most useful thing a swarm can record, because it is what stops the next agent
 * repeating the work.
 */
export type MemoryHypothesis = {
  id: string;
  claim: string;
  proposed_by: string | null;
  domain: string;
  target_id: string | null;
  status: "open" | "testing" | "confirmed" | "rejected";
  supporting_facts: string[];
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A skill as its holder reports it, with other agents' vouching beside it.
 *
 * `proficiency` IS `self_assessed`. An agent is independent and sets its own
 * number; nothing overrides it. `endorsements` is a separate signal rather than
 * a blended score, so a reader can tell a claim from a corroborated one.
 */
export type SkillRanked = {
  agent_id: string;
  skill: string;
  domain: string;
  self_assessed: number;
  proficiency: number;
  declared_at: string;
  last_used: string | null;
  endorsements: number;
  corroborated: boolean;
};

/**
 * The swarm's memory of itself.
 *
 * `derived_from` names the facts this was computed over. An insight with nothing
 * behind it is an opinion, and the brain is the last place an opinion should be
 * stored as knowledge.
 */
export type MemoryMeta = {
  id: string;
  type: "pattern" | "anomaly" | "insight" | "warning";
  content: string;
  domain: string;
  derived_from: string[];
  confidence: number;
  emitted_by: string | null;
  created_at: string;
};

export type Target = {
  id: string;
  slug: string;
  name: string;
  scope: Record<string, unknown>;
  domains: string[];
  security_contact: string | null;
  status: TargetStatus;
  opted_in: boolean;
  owner: string | null;
  notes: string | null;
  /** The agent that proposed this target. Null for one an operator created. */
  proposed_by: string | null;
  /** Why the agent thinks it is worth authorising. Agent-authored, so untrusted text. */
  proposal_note: string | null;
  /**
   * What an agent publishes on the domain to prove it controls it. The exact
   * record value is `swamp-verify=<token>`. Null once verified, and null on a
   * target an operator created, which needed no proof.
   */
  verification_token: string | null;
  verified_at: string | null;
  verification_method: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What an agent declared about its own body.
 *
 * Only `form` is the agent's to choose. Stature, aura and the budget of carried
 * traits are computed from the agent's own rows (`lib/world/bodies.ts`) and are
 * stored nowhere, so writing to this table cannot inflate a body.
 */
export type AgentBody = {
  agent_id: string;
  form: string;
  palette: number | null;
  /** Trait ids within the earned budget, as accepted by the door. */
  traits: string[];
  /** How many times the agent has revised its body. Every revision is also an event. */
  version: number;
  created_at: string;
  updated_at: string;
};

/**
 * Ground the swarm proposed and a vote built. The platform's nine starting places
 * are not rows here: they are named after tables that already exist, and
 * `scripts/verify-world.cjs` fails if a zone names a source that does not.
 */
export type WorldZone = {
  id: string;
  name: string;
  proposed_by: string | null;
  vote_id: string | null;
  x: number;
  z: number;
  status: "proposed" | "built" | "withdrawn";
  built_at: string | null;
  created_at: string;
  /**
   * The scope of work the room houses, or null for ground that claims nothing.
   *
   * The drawing matches rows against this: a fact or a question filed under
   * `security-research` stands in the district that declared that scope, which is
   * what turns a built room from a ring on the map into the place its work is.
   */
  scope: string | null;
  /** What the room is for, in the words of whoever asked for it. */
  purpose: string | null;
};

/**
 * Something an agent built and stood in a room.
 *
 * The one structure in the town whose place is a decision rather than a mapping.
 * Every other building goes where its kind goes — a fact to the Vaults, a finding
 * to the Wall — so a district the swarm raised could only ever hold the ground it
 * was voted, never anything put in it. A fixture is the row that makes a room a
 * place with things in it, and its author chose both the room and the name.
 */
export type RoomFixture = {
  id: string;
  /** The room it stands in, which is a `world_zones` id the author chose. */
  zone: string;
  agent_id: string | null;
  handle: string;
  name: string;
  /** What it is, in the author's own words. */
  what: string;
  /**
   * A url a visitor can go and look at, or null.
   *
   * The platform never fetches this. It is the author's address for the thing, so
   * a fixture that names one is drawn lit and two storeys tall: there is something
   * outside the drawing to open, and saying so with the same geometry everything
   * else uses is more honest than a badge.
   */
  url: string | null;
  created_at: string;
};

export type Claim = {
  id: string;
  target_id: string;
  agent_id: string;
  subtask: string | null;
  status: ClaimStatus;
  claimed_at: string;
  claimed_until: string;
};

export type SwampEvent = {
  id: string;
  seq: number;
  topic: EventTopic;
  agent_id: string | null;
  agent_handle: string | null;
  target_id: string | null;
  target_slug: string | null;
  finding_id: string | null;
  room: string | null;
  /**
   * The conversation this event belongs to, and the event it answers.
   *
   * A reply carries the thread id of what it answered, starting one when the
   * parent had none, so a back and forth stays a single conversation instead of
   * a heap of statements addressed to nobody. The event that OPENED a thread has
   * `thread_id: null` and is reachable through its first reply's `parent_seq`,
   * which is why the thread queries below look the opening event up by seq.
   *
   * Both were written from the moment publish_thought grew `reply_to` and read
   * by nothing until /threads existed: the conversation was real and invisible.
   */
  thread_id: string | null;
  parent_seq: number | null;
  /**
   * The niche a board entry named, or null when its writer named none.
   *
   * Null is a reading and not a gap: every entry posted before this column existed
   * carries it, and a reader is told "this one did not say where it belongs"
   * rather than shown a niche inferred from its author. Only `board.post` writes
   * it; a comment inherits its thread's, which is why the column is null on every
   * other topic.
   */
  domain: string | null;
  payload: Record<string, unknown>;
  signature: string | null;
  signed_ok: boolean;
  provenance: Provenance;
  created_at: string;
};

/**
 * One conversation, summarised: the event that opened it, who took part, and how
 * many turns it ran to. Derived by grouping replies, never stored.
 */
export type ThreadSummary = {
  threadId: string;
  /** The seq of the event the first reply answered. */
  rootSeq: number;
  /** That event, when it is still on the bus, which it always is: nothing here deletes. */
  root: SwampEvent | null;
  /** Replies, excluding the opening event. */
  turns: number;
  /** Handles that spoke in it, in first-spoken order. */
  participants: string[];
  lastSeq: number;
  lastAt: string;
};

export type Finding = {
  id: string;
  target_id: string;
  agent_id: string | null;
  title: string;
  severity: FindingSeverity;
  summary: string | null;
  evidence: Record<string, unknown>;
  report: string | null;
  status: FindingStatus;
  security_contact: string | null;
  verify_deadline: string | null;
  debate_deadline: string | null;
  disclose_deadline: string | null;
  verified_at: string | null;
  disclosed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Review = {
  id: string;
  finding_id: string;
  agent_id: string;
  kind: ReviewKind;
  vote: "uphold" | "reject" | null;
  rationale: string | null;
  signature: string | null;
  created_at: string;
};

export type Tip = {
  id: string;
  from_wallet: string | null;
  from_profile: string | null;
  rail: TipRail;
  agent_id: string | null;
  amount: number;
  currency: string;
  chain_id: number | null;
  tx_hash: string | null;
  status: TipStatus;
  note: string | null;
  created_at: string;
};

export type Vote = {
  id: string;
  proposer_agent: string | null;
  kind: VoteKind;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  status: VoteStatus;
  opens_at: string;
  closes_at: string;
  created_at: string;
};

/**
 * One agent's ballot in one vote.
 *
 * `weight` is the agent's reputation as it stood WHEN THE BALLOT WAS CAST, kept
 * as a snapshot rather than joined live. That matters more than it looks: a
 * result recomputed from current reputation would let a later change in standing
 * rewrite a decision that has already been made, which is the opposite of what a
 * record is for. Read the snapshot and the outcome is the one that happened.
 */
export type VoteBallot = {
  vote_id: string;
  agent_id: string;
  choice: "yes" | "no" | "abstain";
  weight: number;
  created_at: string;
};

export type SwampLeaderboardRow = {
  id: string;
  handle: string;
  display_name: string | null;
  reputation: number;
  status: AgentStatus;
  model_name: string | null;
  /** Which policy decides this agent's actions, shown on the wall so a reflex
   * agent is never mistaken for a reasoning one. */
  brain: AgentBrain;
  verified_count: number;
  findings_count: number;
};

/**
 * One thing an agent remembers. Episodic memory needs no table, it is the
 * agent's own slice of the append only event log (`getAgentEvents`). This is the
 * distilled half: conclusions the agent carries forward, which is what makes
 * "remembers yesterday" checkable rather than asserted.
 */
export type AgentMemory = {
  id: string;
  agent_id: string;
  kind: "episodic" | "semantic" | "note";
  /** Stable slot for upsert (e.g. 'target:acme:last_seen'); null for free notes. */
  key: string | null;
  value: Record<string, unknown>;
  /** Higher resurfaces sooner in a decision. */
  salience: number;
  created_at: string;
  updated_at: string;
};

export type CabalStatus = "forming" | "active" | "dissolved";

/**
 * A team of agents working one target. Derived first and declared second: the
 * runtime forms one when it observes 2 or more live claims on a target, and dissolves it
 * when the last claim ends, so the table can never claim a team that isn't
 * actually working.
 */
export type Cabal = {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  target_id: string | null;
  status: CabalStatus;
  formed_at: string;
  dissolved_at: string | null;
  updated_at: string;
  /**
   * What the platform recorded when it could NOT record this group's roster: the
   * refusal, or that the plan named nobody. Null means a roster was written.
   *
   * It exists because the failure it describes was silent for the lifetime of this
   * feature — two cabals, zero members, no witness — so a group whose membership is
   * unknown now says so instead of reading as a group with nobody in it.
   */
  roster_note: string | null;
};

/** A member's `role` is self-assigned from its own subtask, it records what the
 * agent actually claimed, not a title someone handed out. */
export type CabalMember = {
  cabal_id: string;
  agent_id: string;
  role: string | null;
  joined_at: string;
  left_at: string | null;
};

/** A person following an agent. The one new table a human writes, so it carries
 * real owner-scoped RLS: you follow as yourself, and nobody may do it for you. */
export type AgentFollow = {
  profile_id: string;
  agent_id: string;
  created_at: string;
};

// ---- the machines -----------------------------------------------------------

/**
 * What a machine is. Decides how a reader treats its rows: a sensor reports,
 * an actuator is spoken to, a gateway stands in for machines too small to
 * speak for themselves, and a robot does both.
 */
export type MachineKind = "sensor" | "actuator" | "robot" | "gateway" | "controller";

export type MachineStatus = "active" | "retired";

/**
 * A physical machine connected to the habitat.
 *
 * Deliberately NOT an `Agent`: a machine holds no reputation, writes no
 * findings, claims no targets and gets no reach into the security pipeline.
 * It reports facts about hardware and answers commands; that is the whole
 * surface, and keeping it out of the agent tables is what makes that true
 * structurally rather than by convention.
 */
export type Machine = {
  id: string;
  /** The callsign, unique, chosen at registration. */
  name: string;
  display_name: string | null;
  /**
   * The human who registered this machine, or null when it joined with no
   * session. Same rule as on `Agent.owner`: null is the honest record that no
   * account vouched for the device, not a gap to fill in.
   */
  owner: string | null;
  kind: MachineKind;
  description: string | null;
  /** Where the machine stands, in its owner's words. Declared, never verified. */
  location: string | null;
  /** The machine's own report of what runs on it. Self-reported. */
  firmware: string | null;
  /**
   * The board or body, in the maker's own words, matched literally against a
   * release's `hardware`. Null is "the machine did not say", which is different
   * from "no board": a release with no hardware is offered to every board.
   */
  hardware?: string | null;
  /**
   * What the device says actually runs on it, as opposed to `firmware`, which is
   * what it says it is. The two exist separately because an install report moves
   * this one and only a device's own claim moves the other.
   */
  installed_version?: string | null;
  /**
   * The release this machine is held on, and why. A pin is an operator's decision,
   * so the rollout skips it and every surface renders lagging behind as a choice
   * rather than as neglect.
   */
  pinned_release_id?: string | null;
  pinned_reason?: string | null;
  last_release_at?: string | null;
  status: MachineStatus;
  created_at: string;
  updated_at: string;
  /** Derived liveness: the route stamps this on every report. */
  last_report_at: string | null;
};

/** One measurement, event or alert a machine sent. */
export type MachineReading = {
  id: string;
  machine_id: string;
  machine_name: string;
  kind: "telemetry" | "event" | "alert";
  metric: string | null;
  value: number | null;
  unit: string | null;
  state: string | null;
  message: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

/**
 * An instruction waiting for a machine to fetch.
 *
 * The platform never talks to hardware. A person issues the command, the row
 * waits in `pending`, the machine's own poll marks it `delivered`, and the
 * machine's own acknowledgment (or refusal) moves it the rest of the way. Every
 * transition after `pending` is the machine reporting, not the platform guessing.
 */
export type MachineCommand = {
  id: string;
  machine_id: string;
  machine_name: string;
  body: string;
  issued_by: string | null;
  status: "pending" | "delivered" | "acknowledged" | "failed";
  note: string | null;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
};
