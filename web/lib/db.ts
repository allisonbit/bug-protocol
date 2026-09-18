/**
 * Application data types: the shape of rows in the Supabase schema, plus the
 * small display helpers the UI shares (severity/status labels + tones, money
 * formatting, slugify). No blockchain here: this is the offchain product that
 * works on its own.
 */

export type Role = "hunter" | "client" | "both";

export type Profile = {
  id: string;
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  website: string | null;
  wallet: string | null;
  role: Role;
  // Denormalized reputation, maintained by a trigger on `submissions`. Public.
  accepted_count: number;
  total_earned: number;
  rep: number;
  created_at: string;
  updated_at: string;
};

export type ProgramStatus = "draft" | "live" | "paused" | "closed";

export type Program = {
  id: string;
  owner: string;
  slug: string;
  name: string;
  summary: string | null;
  description: string | null;
  targets: string[];
  status: ProgramStatus;
  currency: string;
  tier_low: number;
  tier_medium: number;
  tier_high: number;
  tier_critical: number;
  pool: number;
  paid_out: number;
  response_days: number;
  safe_harbor: boolean;
  logo_url: string | null;
  // ---- onchain link (all null/zero on a purely offchain program) ----
  chain_id: number | null;
  onchain_program_id: number | null;
  /** Address the onchain pool is denominated in; zero address means native ETH. */
  reward_token: string | null;
  /** keccak256 of the scope document `createProgram` committed to. */
  scope_hash: string | null;
  /** Where that scope document is published. */
  scope_uri: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A program's escrow mode. This is the single most important thing to show a
 * hunter: an `escrow` program has funds the client cannot claw back and a
 * slashable bond behind it, an `offchain` program is an honour-system bounty
 * that works with no contract deployed at all.
 */
export type EscrowMode = "escrow" | "offchain";

export function escrowMode(p: Pick<Program, "onchain_program_id">): EscrowMode {
  return p.onchain_program_id ? "escrow" : "offchain";
}

export const escrowModeMeta: Record<EscrowMode, { label: string; tone: string; blurb: string }> = {
  escrow: {
    label: "Escrowed onchain",
    tone: "text-bug border-bug-dim",
    blurb:
      "Funds are held in the BugBounty contract and an accepted finding pays out of escrow in the same transaction the owner accepts it. The owner cannot withdraw what is reserved for your report.",
  },
  offchain: {
    label: "Offchain",
    tone: "text-amber-300 border-amber-500/30",
    blurb:
      "This program is not linked to an escrow contract. Rewards are recorded here by the owner, and the commit receipt is still proof of authorship, but nothing is held in escrow on your behalf.",
  },
};

export type Severity = "none" | "low" | "medium" | "high" | "critical";
export type SubmissionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "duplicate"
  | "spam"
  | "disclosed"
  | "escalated"
  | "resolved";

export type Submission = {
  id: string;
  program_id: string;
  hunter: string;
  title: string;
  severity: Severity;
  assigned_severity: Severity | null;
  status: SubmissionStatus;
  report: string | null;
  encrypted: boolean;
  target: string | null;
  reward: number;
  dupe_of: string | null;
  triage_note: string | null;
  // ---- onchain link (null/zero on an offchain submission) ----
  chain_id: number | null;
  onchain_submission_id: number | null;
  /** keccak256(abi.encode(reportURI, salt, hunter)), never the salt itself. */
  commit_hash: string | null;
  /** Public URL of the (encrypted) report body; bound into the commit hash. */
  report_uri: string | null;
  /** sha256 of the exact envelope bytes served at `report_uri`. */
  report_sha256: string | null;
  /** Hunter's spam bond, in $SWARM. Refunded unless slashed. */
  bond: number;
  /** Protocol's cut of the award, taken from the pool at acceptance. */
  protocol_fee: number;
  revealed_at: string | null;
  escalated_at: string | null;
  /** Last moment the hunter may dispute a verdict to the arbiter. */
  dispute_deadline: string | null;
  resolved_at: string | null;
  tx_hash: string | null;
  created_at: string;
  triaged_at: string | null;
};

// ---- display metadata --------------------------------------------------------

/**
 * A severity that can carry a reward. `none` exists in the schema because a
 * submission arrives with no assigned severity yet. It is never a choice a human
 * makes, and the contract's `Severity.None` is deliberately unpayable, so the
 * pickable lists are typed to exclude it rather than being filtered by hand at
 * every call site.
 */
export type PayableSeverity = Exclude<Severity, "none">;

export const SEVERITIES: PayableSeverity[] = ["low", "medium", "high", "critical"];

export const severityMeta: Record<Severity, { label: string; tone: string; dot: string }> = {
  none: { label: "Triage", tone: "text-mist border-line", dot: "bg-mist" },
  low: { label: "Low", tone: "text-sky-300 border-sky-500/30", dot: "bg-sky-400" },
  medium: { label: "Medium", tone: "text-amber-300 border-amber-500/30", dot: "bg-amber-400" },
  high: { label: "High", tone: "text-orange-300 border-orange-500/30", dot: "bg-orange-400" },
  critical: { label: "Critical", tone: "text-rose-300 border-rose-500/30", dot: "bg-rose-400" },
};

export const programStatusMeta: Record<ProgramStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "text-mist border-line" },
  live: { label: "Live", tone: "text-bug border-bug-dim" },
  paused: { label: "Paused", tone: "text-amber-300 border-amber-500/30" },
  closed: { label: "Closed", tone: "text-mist border-line" },
};

export const submissionStatusMeta: Record<SubmissionStatus, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "text-amber-300 border-amber-500/30" },
  accepted: { label: "Accepted", tone: "text-bug border-bug-dim" },
  rejected: { label: "Rejected", tone: "text-mist border-line" },
  duplicate: { label: "Duplicate", tone: "text-sky-300 border-sky-500/30" },
  spam: { label: "Spam", tone: "text-rose-300 border-rose-500/30" },
  disclosed: { label: "Disclosed", tone: "text-violet-300 border-violet-500/30" },
  escalated: { label: "Escalated", tone: "text-orange-300 border-orange-500/30" },
  resolved: { label: "Resolved", tone: "text-bug border-bug-dim" },
};

/** Compact money formatting, e.g. 12000 becomes "$12K", 1500000 becomes "$1.5M". */
export function money(n: number, currency = "USD"): string {
  const sym = currency === "USDC" || currency === "USD" ? "$" : "";
  const suffix = sym ? "" : ` ${currency}`;
  const abs = Math.abs(n);
  let body: string;
  if (abs >= 1_000_000) body = `${trim(n / 1_000_000)}M`;
  else if (abs >= 1_000) body = `${trim(n / 1_000)}K`;
  else body = trim(n);
  return `${sym}${body}${suffix}`;
}

function trim(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/** The top payout across the four tiers, for program cards. */
export function topTier(p: Pick<Program, "tier_low" | "tier_medium" | "tier_high" | "tier_critical">): number {
  return Math.max(p.tier_low, p.tier_medium, p.tier_high, p.tier_critical);
}

export function tierFor(p: Program, s: Severity): number {
  return s === "critical"
    ? p.tier_critical
    : s === "high"
      ? p.tier_high
      : s === "medium"
        ? p.tier_medium
        : s === "low"
          ? p.tier_low
          : 0;
}

/** URL-safe slug from a program name, with a short random suffix for uniqueness. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "program"}-${suffix}`;
}

export function displayName(p: Pick<Profile, "handle" | "display_name"> | null | undefined): string {
  if (!p) return "someone";
  return p.display_name || p.handle || "someone";
}

/** Initials for avatar fallbacks, e.g. "Ada Lovelace" becomes "AL". */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Short absolute date, e.g. "Sep 10". Adds the year when it isn't the current one. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** Relative time, e.g. "just now", "3h ago", "2d ago", falling back to a date. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}
