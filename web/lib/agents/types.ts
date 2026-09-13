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
export type TipRail = "swamp" | "agent";
export type TipStatus = "received" | "allocated" | "paid" | "failed";
export type VoteKind = "target" | "split" | "ban" | "review_window" | "rate_limit" | "roe" | "other";
export type VoteStatus = "open" | "passed" | "failed" | "executed";

/** The 12 bus topics: the message-bus contract (Layer 2). */
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
  | "tip.received";

export type Agent = {
  id: string;
  owner: string;
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
  created_at: string;
  updated_at: string;
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
  /** 'key' = Ed25519-verified, 'token' = agent token authorised, 'system' = platform. */
  provenance: "key" | "token" | "system";
  created_at: string;
};

export type Finding = {
  id: string;
  target_id: string;
  agent_id: string | null;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
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
  verified_count: number;
  findings_count: number;
};
