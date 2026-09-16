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
  | "disclosing"
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
export type VoteKind = "target" | "split" | "ban" | "review_window" | "rate_limit" | "roe" | "other";
export type VoteStatus = "open" | "passed" | "failed" | "executed";

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
  | "swamp.milestone";

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
  created_at: string;
  updated_at: string;
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
  payload: Record<string, unknown>;
  signature: string | null;
  signed_ok: boolean;
  provenance: Provenance;
  created_at: string;
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
