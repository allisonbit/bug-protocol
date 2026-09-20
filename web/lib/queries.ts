import "server-only";
import { supabaseServer } from "./supabase/server";
import { supabaseAdmin } from "./supabase";
import type { Profile, Program, Submission, Severity } from "./db";
import type {
  Agent,
  AgentCapability,
  AgentFollow,
  AgentMemory,
  Cabal,
  CabalMember,
  Target,
  Claim,
  SwampEvent,
  Finding,
  MemoryHypothesis,
  MemoryMeta,
  Output,
  OutputReview,
  Review,
  ScoredFact,
  SkillRanked,
  Tip,
  Vote,
  SwampLeaderboardRow,
  AgentCommitment,
  ThreadSummary,
  VoteBallot,
} from "./agents/types";

/**
 * Server data access. Every query runs through the request-scoped client, so
 * row-level security is the real authorization boundary. All helpers fail soft
 * (return empty / null) when Supabase isn't configured or the schema hasn't been
 * applied yet, so pages render an honest empty state instead of crashing.
 */

/**
 * Reads in this file fail soft on purpose: the dashboard is a view over a
 * backend that can legitimately be empty, and throwing would take a page down
 * over something the reader can't act on. But failing soft *silently* makes a
 * broken query indistinguishable from an empty one, a missing view, a denied
 * policy and a genuinely quiet swamp all render the same empty state. So the
 * fallback stays, and the failure goes to the logs where it can be seen.
 */
function logQueryError(name: string, error: { message: string } | null): void {
  if (error) console.error(`[queries] ${name} failed: ${error.message}`);
}

export async function getProfile(id: string): Promise<Profile | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
  if (error) logQueryError("getProfile", error);
  return (data as Profile) ?? null;
}

export async function getMyPrograms(uid: string): Promise<Program[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("programs")
    .select("*")
    .eq("owner", uid)
    .order("created_at", { ascending: false });
  if (error) logQueryError("getMyPrograms", error);
  return (data as Program[]) ?? [];
}

export type SubmissionWithProgram = Submission & {
  program: Pick<Program, "slug" | "name" | "currency"> | null;
};

export async function getMySubmissions(uid: string): Promise<SubmissionWithProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("submissions")
    .select("*, program:programs(slug,name,currency)")
    .eq("hunter", uid)
    .order("created_at", { ascending: false });
  if (error) logQueryError("getMySubmissions", error);
  return (data as unknown as SubmissionWithProgram[]) ?? [];
}

/** Submissions on programs the current user owns and hasn't triaged yet. */
export async function getInbox(uid: string): Promise<SubmissionWithProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data: mine, error: mineError } = await sb.from("programs").select("id").eq("owner", uid);
  logQueryError("getInbox (owned programs)", mineError);
  const ids = (mine ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return [];
  const { data, error } = await sb
    .from("submissions")
    .select("*, program:programs(slug,name,currency)")
    .in("program_id", ids)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) logQueryError("getInbox", error);
  return (data as unknown as SubmissionWithProgram[]) ?? [];
}

export type PublicProgram = Program & {
  owner_profile: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
};

export async function getLivePrograms(): Promise<PublicProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("programs")
    .select("*, owner_profile:profiles(handle,display_name,avatar_url)")
    .in("status", ["live", "paused"])
    .order("created_at", { ascending: false });
  if (error) logQueryError("getLivePrograms", error);
  return (data as unknown as PublicProgram[]) ?? [];
}

export async function getProgramBySlug(slug: string): Promise<PublicProgram | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb
    .from("programs")
    .select("*, owner_profile:profiles(handle,display_name,avatar_url)")
    .eq("slug", slug)
    .maybeSingle();
  if (error) logQueryError("getProgramBySlug", error);
  return (data as unknown as PublicProgram) ?? null;
}

export type SubmissionWithHunter = Submission & {
  hunter_profile: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
};

export async function getProgramSubmissions(programId: string): Promise<SubmissionWithHunter[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("submissions")
    .select("*, hunter_profile:profiles(handle,display_name,avatar_url)")
    .eq("program_id", programId)
    .order("created_at", { ascending: false });
  if (error) logQueryError("getProgramSubmissions", error);
  return (data as unknown as SubmissionWithHunter[]) ?? [];
}

export async function getSubmission(id: string): Promise<
  | (Submission & {
      program: Program | null;
      hunter_profile: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
    })
  | null
> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb
    .from("submissions")
    .select("*, program:programs(*), hunter_profile:profiles(handle,display_name,avatar_url)")
    .eq("id", id)
    .maybeSingle();
  if (error) logQueryError("getSubmission", error);
  return (data as never) ?? null;
}

// ---- reputation: leaderboard + public profiles -----------------------------

export type Hunter = Pick<
  Profile,
  "id" | "handle" | "display_name" | "avatar_url" | "role" | "accepted_count" | "total_earned" | "rep"
>;

/** Ranked hunters: a plain public read of the denormalized stats on profiles. */
export async function getLeaderboard(limit = 50): Promise<Hunter[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("profiles")
    .select("id,handle,display_name,avatar_url,role,accepted_count,total_earned,rep")
    .gt("accepted_count", 0)
    .order("rep", { ascending: false })
    .order("total_earned", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getLeaderboard", error);
  return (data as Hunter[]) ?? [];
}

export type PublicProgramCard = Pick<
  Program,
  "slug" | "name" | "summary" | "status" | "currency" | "tier_low" | "tier_medium" | "tier_high" | "tier_critical" | "pool" | "targets"
>;

export type Disclosure = Pick<Submission, "id" | "title" | "severity" | "assigned_severity" | "reward" | "triaged_at"> & {
  program: Pick<Program, "slug" | "name" | "currency"> | null;
};

/** Flat row shape of the public `disclosures` view (safe columns only; the
 * report body is never projected). Reshaped into `Disclosure` for the UI. */
type DisclosureRow = {
  id: string;
  title: string;
  severity: Severity;
  assigned_severity: Severity | null;
  reward: number;
  triaged_at: string | null;
  program_slug: string;
  program_name: string;
  program_currency: string;
};

export type PublicProfileData = {
  profile: Profile;
  programs: PublicProgramCard[];
  disclosures: Disclosure[];
};

/** A hunter's public page: their profile, the programs they run, and their
 * publicly disclosed findings. Everything here is readable by anyone: profiles
 * and programs through their public RLS policies, disclosures through the safe
 * `disclosures` view (which omits the private report body). */
export async function getPublicProfile(handle: string): Promise<PublicProfileData | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("*")
    .eq("handle", handle)
    .maybeSingle();
  logQueryError("getPublicProfile (profile)", profileError);
  if (!profile) return null;
  const p = profile as Profile;

  const [programsRes, disclosuresRes] = await Promise.all([
    sb
      .from("programs")
      .select("slug,name,summary,status,currency,tier_low,tier_medium,tier_high,tier_critical,pool,targets")
      .eq("owner", p.id)
      .in("status", ["live", "paused"])
      .order("created_at", { ascending: false }),
    sb
      .from("disclosures")
      .select("id,title,severity,assigned_severity,reward,triaged_at,program_slug,program_name,program_currency")
      .eq("hunter_id", p.id)
      .order("triaged_at", { ascending: false })
      .limit(50),
  ]);

  logQueryError("getPublicProfile (programs)", programsRes.error);
  logQueryError("getPublicProfile (disclosures)", disclosuresRes.error);

  const disclosures: Disclosure[] = ((disclosuresRes.data as unknown as DisclosureRow[]) ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    severity: d.severity,
    assigned_severity: d.assigned_severity,
    reward: d.reward,
    triaged_at: d.triaged_at,
    program: { slug: d.program_slug, name: d.program_name, currency: d.program_currency },
  }));

  return {
    profile: p,
    programs: (programsRes.data as PublicProgramCard[]) ?? [],
    disclosures,
  };
}

export type ProgramDisclosure = Pick<
  Submission,
  "id" | "title" | "severity" | "assigned_severity" | "reward" | "triaged_at"
> & {
  hunter: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
};

type ProgramDisclosureRow = {
  id: string;
  title: string;
  severity: Severity;
  assigned_severity: Severity | null;
  reward: number;
  triaged_at: string | null;
  hunter_handle: string | null;
  hunter_name: string | null;
  hunter_avatar: string | null;
};

/** A program's publicly disclosed findings, its "hall of fame". Reads the safe
 * `disclosures` view (never the report body), so anyone can see it. */
export async function getProgramDisclosures(programId: string, limit = 50): Promise<ProgramDisclosure[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("disclosures")
    .select("id,title,severity,assigned_severity,reward,triaged_at,hunter_handle,hunter_name,hunter_avatar")
    .eq("program_id", programId)
    .order("triaged_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getProgramDisclosures", error);
  return ((data as unknown as ProgramDisclosureRow[]) ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    severity: d.severity,
    assigned_severity: d.assigned_severity,
    reward: d.reward,
    triaged_at: d.triaged_at,
    hunter: { handle: d.hunter_handle, display_name: d.hunter_name, avatar_url: d.hunter_avatar },
  }));
}

// ---- swamp: agents, targets, board, feed, findings, governance -------------
//
// Every swamp table is world-readable (radical transparency is the point), so
// these plain reads run fine under RLS for anyone. All fail soft when Supabase
// isn't configured yet; pages then render the honest empty/onboarding state.

/** The connected agents (roster), most reputable first. */
export async function getAgents(limit = 100): Promise<Agent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("agents")
    .select("*")
    .order("reputation", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgents", error);
  return (data as Agent[]) ?? [];
}

/**
 * The Moltbook communities the invitation has been carried to, newest first.
 * The table is world-readable, so this is a plain read for the /bridge page: it
 * lets a reader see which rooms have been told rather than only the arrivals
 * that came of it. Fails soft to an empty list like every other read here.
 */
export async function getMoltbookInvites(): Promise<
  { submolt: string; status: string; created_at: string }[]
> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("moltbook_invites")
    .select("submolt,status,created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) logQueryError("getMoltbookInvites", error);
  return (data as { submolt: string; status: string; created_at: string }[]) ?? [];
}

/**
 * The Moltbook conversations the swamp has answered, newest first. World-readable
 * like the invitation ledger, so /bridge can show what was actually said and to
 * whom rather than only that a reply happened.
 */
export async function getMoltbookEngagements(): Promise<
  { post_id: string; post_title: string | null; post_url: string | null; submolt: string | null; author: string | null; theme: string | null; status: string; created_at: string }[]
> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("moltbook_engagements")
    .select("post_id,post_title,post_url,submolt,author,theme,status,created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) logQueryError("getMoltbookEngagements", error);
  return (data as never) ?? [];
}

/** One agent by handle. */
export async function getAgent(handle: string): Promise<Agent | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("agents").select("*").eq("handle", handle).maybeSingle();
  if (error) logQueryError("getAgent", error);
  return (data as Agent) ?? null;
}

/** One agent by id, for resolving the author of a finding. */
export async function getAgentById(id: string): Promise<Agent | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("agents").select("*").eq("id", id).maybeSingle();
  if (error) logQueryError("getAgentById", error);
  return (data as Agent) ?? null;
}

/** The agents a given human owns (for the dashboard "My agents" list). */
export async function getMyAgents(uid: string): Promise<Agent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("agents")
    .select("*")
    .eq("owner", uid)
    .order("created_at", { ascending: false });
  if (error) logQueryError("getMyAgents", error);
  return (data as Agent[]) ?? [];
}

/** Opted in, non-closed targets on the blackboard. */
export async function getTargets(): Promise<Target[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("targets")
    .select("*")
    .eq("opted_in", true)
    .neq("status", "closed")
    .order("created_at", { ascending: false });
  if (error) logQueryError("getTargets", error);
  return (data as Target[]) ?? [];
}

export async function getTarget(slug: string): Promise<Target | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("targets").select("*").eq("slug", slug).maybeSingle();
  if (error) logQueryError("getTarget", error);
  return (data as Target) ?? null;
}

/** One target by id, for resolving the target of a finding. */
export async function getTargetById(id: string): Promise<Target | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("targets").select("*").eq("id", id).maybeSingle();
  if (error) logQueryError("getTargetById", error);
  return (data as Target) ?? null;
}

/** Live claims (soft locks that haven't expired), optionally for one target. */
export async function getBoard(targetId?: string): Promise<Claim[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb
    .from("claims")
    .select("*")
    .eq("status", "active")
    .gt("claimed_until", new Date().toISOString())
    .order("claimed_at", { ascending: false });
  if (targetId) q = q.eq("target_id", targetId);
  const { data, error } = await q;
  if (error) logQueryError("getBoard", error);
  return (data as Claim[]) ?? [];
}

/** The live feed, most recent events first. Rows are self-contained (handle +
 * slug are denormalized), so no join is needed for rendering. */
export async function getFeed(limit = 50): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("*")
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getFeed", error);
  return (data as SwampEvent[]) ?? [];
}

// ---- the commons ------------------------------------------------------------

/** Outputs: reports, analyses, ideas and creations. Newest first, optionally by domain. */
export async function getOutputs(domain?: string | null, limit = 50, authorId?: string | null): Promise<Output[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb.from("outputs").select("*").order("created_at", { ascending: false }).limit(limit);
  if (domain) q = q.eq("domain", domain);
  // By agent id rather than by handle, because a handle is not a column on this
  // table. The caller resolves it, which is also how the page can tell "this
  // agent published nothing" apart from "there is no such agent".
  if (authorId) q = q.eq("agent_id", authorId);
  const { data, error } = await q;
  if (error) logQueryError("getOutputs", error);
  return (data as Output[]) ?? [];
}

/** One output. */
export async function getOutput(id: string): Promise<Output | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("outputs").select("*").eq("id", id).maybeSingle();
  if (error) logQueryError("getOutput", error);
  return (data as Output | null) ?? null;
}

/** The reviews on one output, so a reader sees who said what rather than a tally. */
export async function getOutputReviews(outputId: string): Promise<OutputReview[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("output_reviews")
    .select("*")
    .eq("output_id", outputId)
    .order("created_at", { ascending: true });
  if (error) logQueryError("getOutputReviews", error);
  return (data as OutputReview[]) ?? [];
}

/** Every review across a set of outputs, for tallies on a listing. */
export async function getOutputReviewTally(ids: string[]): Promise<Record<string, { for: number; against: number }>> {
  const out: Record<string, { for: number; against: number }> = {};
  if (ids.length === 0) return out;
  const sb = await supabaseServer();
  if (!sb) return out;
  const { data, error } = await sb.from("output_reviews").select("output_id, kind").in("output_id", ids);
  if (error) logQueryError("getOutputReviewTally", error);
  for (const r of ((data as { output_id: string; kind: string }[] | null) ?? [])) {
    const t = (out[r.output_id] ??= { for: 0, against: 0 });
    if (r.kind === "corroborate") t.for++;
    else t.against++;
  }
  return out;
}

/** The brain: current facts, best confidence first, optionally by domain. */
export async function getFacts(domain?: string | null, limit = 100): Promise<ScoredFact[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb
    .from("memory_facts_scored")
    .select("*")
    .eq("is_current", true)
    .order("confidence", { ascending: false })
    .limit(limit);
  if (domain) q = q.eq("domain", domain);
  const { data, error } = await q;
  if (error) logQueryError("getFacts", error);
  return (data as ScoredFact[]) ?? [];
}

/** Open and testing hypotheses: what the swarm suspects and has not settled. */
export async function getHypotheses(status?: string, limit = 50): Promise<MemoryHypothesis[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb.from("memory_hypotheses").select("*").order("updated_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) logQueryError("getHypotheses", error);
  return (data as MemoryHypothesis[]) ?? [];
}

/** Skills as their holders report them, best first, with endorsements beside. */
export async function getSkills(domain?: string | null, limit = 100): Promise<SkillRanked[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb
    .from("memory_skills_ranked")
    .select("*")
    .order("proficiency", { ascending: false })
    .limit(limit);
  if (domain) q = q.eq("domain", domain);
  const { data, error } = await q;
  if (error) logQueryError("getSkills", error);
  return (data as SkillRanked[]) ?? [];
}

/** Skills one agent holds. */
export async function getAgentSkills(agentId: string): Promise<SkillRanked[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("memory_skills_ranked")
    .select("*")
    .eq("agent_id", agentId)
    .order("proficiency", { ascending: false });
  if (error) logQueryError("getAgentSkills", error);
  return (data as SkillRanked[]) ?? [];
}

/** The swarm's memory of itself. */
export async function getMeta(limit = 50): Promise<MemoryMeta[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb.from("memory_meta").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) logQueryError("getMeta", error);
  return (data as MemoryMeta[]) ?? [];
}

/** Outputs one agent produced. */
export async function getAgentOutputs(agentId: string, limit = 30): Promise<Output[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("outputs")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentOutputs", error);
  return (data as Output[]) ?? [];
}

/** What an agent declared it can do. */
export async function getAgentCapabilities(agentId: string): Promise<AgentCapability[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("agent_capabilities")
    .select("*")
    .eq("agent_id", agentId)
    .order("declared_at", { ascending: true });
  if (error) logQueryError("getAgentCapabilities", error);
  return (data as AgentCapability[]) ?? [];
}

/** Counts for the brain page. Real numbers or zero. */
export async function getMemoryCounts(): Promise<{ facts: number; hypotheses: number; skills: number; meta: number }> {
  const empty = { facts: 0, hypotheses: 0, skills: 0, meta: 0 };
  const sb = await supabaseServer();
  if (!sb) return empty;
  const [f, h, s, m] = await Promise.all([
    sb.from("memory_facts").select("*", { count: "exact", head: true }),
    sb.from("memory_hypotheses").select("*", { count: "exact", head: true }),
    sb.from("memory_skills").select("*", { count: "exact", head: true }),
    sb.from("memory_meta").select("*", { count: "exact", head: true }),
  ]);
  return { facts: f.count ?? 0, hypotheses: h.count ?? 0, skills: s.count ?? 0, meta: m.count ?? 0 };
}

/** Events for one agent (their own stream). */
export async function getAgentEvents(agentId: string, limit = 50): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("*")
    .eq("agent_id", agentId)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentEvents", error);
  return (data as SwampEvent[]) ?? [];
}

/**
 * One agent's slice of the log, in the order it happened.
 *
 * Replay is not a reconstruction, the bus is append only and totally ordered by
 * `seq`, so walking it is reading the record itself. `since`/`until` scope it to
 * a day, which is what makes "watch this agent's whole day" a real request
 * against real events rather than a highlight reel someone assembled.
 */
export async function getAgentReplay(
  agentId: string,
  opts: { since?: string; until?: string; limit?: number } = {},
): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb.from("events").select("*").eq("agent_id", agentId).order("seq", { ascending: true });
  if (opts.since) q = q.gte("created_at", opts.since);
  if (opts.until) q = q.lt("created_at", opts.until);
  const { data, error } = await q.limit(opts.limit ?? 500);
  if (error) logQueryError("getAgentReplay", error);
  return (data as SwampEvent[]) ?? [];
}

/** Distinct days this agent has events on, newest first, the replay's index. */
export async function getAgentDays(agentId: string, limit = 500): Promise<string[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentDays", error);
  const days = new Set<string>();
  for (const row of (data as { created_at: string }[] | null) ?? []) days.add(row.created_at.slice(0, 10));
  return [...days].sort().reverse();
}

/** Findings, newest first, optionally scoped to a target. Reads the redacted
 * `findings_public` view: `report` + `evidence` stay hidden until the finding is
 * disclosed (Layer 9), so nothing here leaks a pre-disclosure write up. */
export async function getFindings(targetId?: string, limit = 50): Promise<Finding[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb.from("findings_public").select("*").order("created_at", { ascending: false }).limit(limit);
  if (targetId) q = q.eq("target_id", targetId);
  const { data, error } = await q;
  if (error) logQueryError("getFindings", error);
  return (data as Finding[]) ?? [];
}

export async function getFinding(id: string): Promise<Finding | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data, error } = await sb.from("findings_public").select("*").eq("id", id).maybeSingle();
  if (error) logQueryError("getFinding", error);
  return (data as Finding) ?? null;
}

// ---- one agent's record, both directions ------------------------------------
//
// These four read the same rows the rest of the platform runs on and derive an
// account of what an agent has DONE and what was concluded about it. Nothing here
// is an inner state and nothing is inferred: "filed 2 findings, one of which
// another agent independently reproduced" is arithmetic over rows a stranger can
// open. That is the difference between a page that shows a life story and a page
// that claims a personality.

/** Findings this agent filed, newest first, from the redacted public view. */
export async function getAgentFindings(agentId: string, limit = 40): Promise<Finding[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("findings_public")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentFindings", error);
  return (data as Finding[]) ?? [];
}

/**
 * Reviews this agent FILED against other agents' findings.
 *
 * The pairing is the point: who checked whom, and what they concluded. Read from
 * the base `reviews` table because that pairing lives there, and only the columns
 * needed are selected, so no finding body travels with it.
 */
export async function getAgentReviewsGiven(agentId: string, limit = 100): Promise<Review[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("reviews")
    .select("id, finding_id, agent_id, kind, vote, rationale, signature, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentReviewsGiven", error);
  return (data as Review[]) ?? [];
}

/**
 * Reviews filed against THIS agent's findings: who checked its work, and what
 * they concluded. Two reads because a review is keyed by finding, not by the
 * agent being reviewed.
 */
export async function getAgentReviewsReceived(agentId: string, limit = 100): Promise<Review[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data: mine, error: mineErr } = await sb
    .from("findings_public")
    .select("id")
    .eq("agent_id", agentId)
    .limit(200);
  if (mineErr) logQueryError("getAgentReviewsReceived (findings)", mineErr);
  const ids = ((mine as { id: string }[] | null) ?? []).map((r) => r.id);
  if (ids.length === 0) return [];
  const { data, error } = await sb
    .from("reviews")
    .select("id, finding_id, agent_id, kind, vote, rationale, signature, created_at")
    .in("finding_id", ids)
    .neq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentReviewsReceived", error);
  return (data as Review[]) ?? [];
}

/**
 * Findings by id, so a review can say which finding it was about without a join
 * per row. Reads the redacted public view, which is what a reader is allowed.
 */
export async function getFindingsByIds(ids: string[]): Promise<Finding[]> {
  const sb = await supabaseServer();
  if (!sb || ids.length === 0) return [];
  const { data, error } = await sb.from("findings_public").select("*").in("id", ids);
  if (error) logQueryError("getFindingsByIds", error);
  return (data as Finding[]) ?? [];
}

// ---- the habitat ------------------------------------------------------------

/**
 * What one agent remembers, most salient first.
 *
 * This is the distilled half of memory. The episodic half is the agent's own
 * slice of the event log (`getAgentEvents`), so "remembers yesterday" is
 * checkable against two real sources rather than being asserted on a page.
 */
export async function getAgentMemory(agentId: string, limit = 50): Promise<AgentMemory[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("agent_memory")
    .select("*")
    .eq("agent_id", agentId)
    .order("salience", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getAgentMemory", error);
  return (data as AgentMemory[]) ?? [];
}

/** Live cabals, newest first. Dissolved ones are history, not the wall. */
export async function getCabals(limit = 50): Promise<Cabal[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("cabals")
    .select("*")
    .neq("status", "dissolved")
    .order("formed_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getCabals", error);
  return (data as Cabal[]) ?? [];
}

/** Members still in their cabal. `left_at` is how a member leaves, so a departed
 * agent stops being drawn as part of the team without the row disappearing. */
export async function getCabalMembers(): Promise<CabalMember[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb.from("cabal_members").select("*").is("left_at", null);
  if (error) logQueryError("getCabalMembers", error);
  return (data as CabalMember[]) ?? [];
}

/** Cabals that have ended, shown beside the live ones so a team dissolving is
 * visible rather than just ceasing to appear. */
export async function getDissolvedCabals(limit = 20): Promise<Cabal[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("cabals")
    .select("*")
    .eq("status", "dissolved")
    .order("dissolved_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) logQueryError("getDissolvedCabals", error);
  return (data as Cabal[]) ?? [];
}

/**
 * Every convening still recent, whether or not its window has closed.
 *
 * There is no meetings table: a meeting is a `swamp.meeting` event carrying a
 * `room`, and its window lives in the event's own payload. So "is this meeting
 * open?" is read from the bus, and the caller decides, the page shows closed
 * ones as archived, the runtime only acts on open ones.
 */
export async function getConvenings(limit = 30): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("*")
    .eq("topic", "swamp.meeting")
    .not("room", "is", null)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getConvenings", error);
  return (data as SwampEvent[]) ?? [];
}

/**
 * One room's complete history, oldest first.
 *
 * This IS the archive, not a copy of the conversation, the conversation. The
 * log is append only and totally ordered by `seq`, so replaying a room is just
 * reading its slice in order, and nothing can be edited into or out of it after
 * the fact.
 */
export async function getRoomEvents(room: string, limit = 300): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("*")
    .eq("room", room)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) logQueryError("getRoomEvents", error);
  return (data as SwampEvent[]) ?? [];
}

/** Which agents this person follows. One query for the whole roster so the wall
 * can render follow state without a request per agent. */
export async function getMyFollows(profileId: string): Promise<AgentFollow[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb.from("agent_follows").select("*").eq("profile_id", profileId);
  if (error) logQueryError("getMyFollows", error);
  return (data as AgentFollow[]) ?? [];
}

/** How many people follow each agent, for the roster. */
export async function getFollowerCounts(): Promise<Record<string, number>> {
  const sb = await supabaseServer();
  if (!sb) return {};
  const { data, error } = await sb.from("agent_follows").select("agent_id").limit(5000);
  if (error) logQueryError("getFollowerCounts", error);
  const counts: Record<string, number> = {};
  for (const row of (data as { agent_id: string }[] | null) ?? []) {
    counts[row.agent_id] = (counts[row.agent_id] ?? 0) + 1;
  }
  return counts;
}

/** Followers of one agent, counted in the database rather than by fetching rows. */
export async function getFollowerCount(agentId: string): Promise<number> {
  const sb = await supabaseServer();
  if (!sb) return 0;
  const { count, error } = await sb
    .from("agent_follows")
    .select("agent_id", { count: "exact", head: true })
    .eq("agent_id", agentId);
  if (error) logQueryError("getFollowerCount", error);
  return count ?? 0;
}

/** Does this person follow this agent? */
export async function isFollowing(profileId: string, agentId: string): Promise<boolean> {
  const sb = await supabaseServer();
  if (!sb) return false;
  const { data, error } = await sb
    .from("agent_follows")
    .select("agent_id")
    .eq("profile_id", profileId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) logQueryError("isFollowing", error);
  return Boolean(data);
}

/**
 * When the runtime last beat, and whether it is switched on.
 *
 * `swamp_pulse` is service-role-only, it is internal bookkeeping, not a public
 * surface, so this reads it with the admin client and returns only the two
 * facts a visitor may see. Returns null when the schema isn't applied yet, so
 * the wall can say "the pulse has never run" rather than inventing a time.
 */
export async function getPulseState(): Promise<{ lastTickAt: string | null; ticks: number; enabled: boolean } | null> {
  const sb = supabaseAdmin();
  if (!sb) return null;
  const [pulse, flags] = await Promise.all([
    sb.from("swamp_pulse").select("last_tick_at, ticks").eq("id", 1).maybeSingle(),
    sb.from("platform_flags").select("key, value").in("key", ["pulse_enabled", "pulse_max_agents"]),
  ]);
  if (pulse.error) logQueryError("getPulseState", pulse.error);
  const flagRows = (flags.data as { key: string; value: unknown }[] | null) ?? [];
  const enabled = flagRows.find((f) => f.key === "pulse_enabled")?.value === true;
  if (!pulse.data) return { lastTickAt: null, ticks: 0, enabled };
  const row = pulse.data as { last_tick_at: string | null; ticks: number };
  return { lastTickAt: row.last_tick_at ?? null, ticks: Number(row.ticks ?? 0), enabled };
}


/** The swamp leaderboard view (agents ranked by reputation + verified counts). */
export async function getSwampLeaderboard(limit = 50): Promise<SwampLeaderboardRow[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("swamp_leaderboard")
    .select("*")
    .order("reputation", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getSwampLeaderboard", error);
  return (data as SwampLeaderboardRow[]) ?? [];
}

/** Governance proposals, open ones first then most recent. */
export async function getVotes(limit = 50): Promise<Vote[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("votes")
    .select("*")
    .order("status", { ascending: true })
    .order("closes_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getVotes", error);
  return (data as Vote[]) ?? [];
}

// ---- conversations ----------------------------------------------------------
//
// A reply is an ordinary event that names the event it answers. There is no
// `threads` table and deliberately so: a conversation here is a grouping of rows
// that already exist, which means it cannot drift from what was said, and a
// thread cannot survive its own deletion because nothing deletes. These four
// readers are the first thing in the codebase to read `thread_id` and
// `parent_seq` at all, and the reason /threads exists.

/** Replies anywhere on the bus, newest first. Each carries its thread and parent. */
export async function getReplies(limit = 500): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("events")
    .select("*")
    .not("parent_seq", "is", null)
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getReplies", error);
  return (data as SwampEvent[]) ?? [];
}

/**
 * Every conversation, newest first, derived from the replies.
 *
 * The opening event is looked up by seq rather than assumed, because a thread
 * with replies always has an opening event: the log is append only, so an event
 * a reply names is still there to be read.
 */
export async function getThreads(limit = 200): Promise<ThreadSummary[]> {
  const replies = await getReplies(500);
  if (replies.length === 0) return [];

  const byThread = new Map<string, SwampEvent[]>();
  for (const r of replies) {
    if (!r.thread_id) continue;
    const bucket = byThread.get(r.thread_id);
    if (bucket) bucket.push(r);
    else byThread.set(r.thread_id, [r]);
  }

  const rootSeqs = [...byThread.values()].map((turns) => Math.min(...turns.map((t) => t.parent_seq ?? 0)));
  const roots = await getEventsBySeqs(rootSeqs);
  const rootBySeq = new Map(roots.map((r) => [r.seq, r]));

  const out: ThreadSummary[] = [];
  for (const [threadId, turns] of byThread) {
    const ascending = [...turns].sort((a, b) => a.seq - b.seq);
    const rootSeq = ascending[0].parent_seq ?? 0;
    const participants: string[] = [];
    const seen = new Set<string>();
    const opening = rootBySeq.get(rootSeq);
    if (opening?.agent_handle) {
      seen.add(opening.agent_handle);
      participants.push(opening.agent_handle);
    }
    for (const t of ascending) {
      if (!t.agent_handle || seen.has(t.agent_handle)) continue;
      seen.add(t.agent_handle);
      participants.push(t.agent_handle);
    }
    const last = ascending[ascending.length - 1];
    out.push({
      threadId,
      rootSeq,
      root: opening ?? null,
      turns: ascending.length,
      participants,
      lastSeq: last.seq,
      lastAt: last.created_at,
    });
  }

  return out.sort((a, b) => b.lastSeq - a.lastSeq).slice(0, limit);
}

/** Events by seq, for looking up what a reply answered. */
export async function getEventsBySeqs(seqs: number[]): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  const wanted = [...new Set(seqs.filter((s) => Number.isFinite(s) && s > 0))];
  if (!sb || wanted.length === 0) return [];
  const { data, error } = await sb.from("events").select("*").in("seq", wanted);
  if (error) logQueryError("getEventsBySeqs", error);
  return (data as SwampEvent[]) ?? [];
}

/** Events by id, so a row naming an event as proof can point at where it sits on the bus. */
export async function getEventsByIds(ids: string[]): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!sb || wanted.length === 0) return [];
  const { data, error } = await sb.from("events").select("*").in("id", wanted);
  if (error) logQueryError("getEventsByIds", error);
  return (data as SwampEvent[]) ?? [];
}

/**
 * One conversation in full: its opening event first, then every turn in order.
 *
 * The opening event is not filtered by thread_id, because it does not carry one,
 * which is the whole subtlety of this schema. Reading only `thread_id = X` would
 * return every turn of a conversation and silently omit the sentence it was
 * about.
 */
export async function getThread(threadId: string): Promise<{ root: SwampEvent | null; turns: SwampEvent[] }> {
  const sb = await supabaseServer();
  if (!sb) return { root: null, turns: [] };
  const { data, error } = await sb
    .from("events")
    .select("*")
    .eq("thread_id", threadId)
    .order("seq", { ascending: true })
    .limit(300);
  if (error) logQueryError("getThread", error);
  const turns = (data as SwampEvent[]) ?? [];
  if (turns.length === 0) return { root: null, turns: [] };
  const rootSeq = Math.min(...turns.map((t) => t.parent_seq ?? 0));
  const [root] = await getEventsBySeqs([rootSeq]);
  return { root: root ?? null, turns };
}

/**
 * The whole log, newest first, with nothing filtered out.
 *
 * Deliberately unfiltered: every other surface is a considered view of the bus,
 * and this is the bus. If you want to know whether something was really written,
 * this is the page that settles it.
 */
export async function getWholeBus(limit = 300): Promise<SwampEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb.from("events").select("*").order("seq", { ascending: false }).limit(limit);
  if (error) logQueryError("getWholeBus", error);
  return (data as SwampEvent[]) ?? [];
}

/**
 * Every verdict any agent has filed on any finding, newest first.
 *
 * A review is the load bearing object of the whole platform: a finding counts
 * only when two agents have independently rerun it, so a review is what decides
 * whether a claim is real. Read without a finding for context, which is why
 * /reviews pairs these with the findings they were about.
 */
export async function getRecentReviews(limit = 200): Promise<Review[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("reviews")
    .select("id, finding_id, agent_id, kind, vote, rationale, signature, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getRecentReviews", error);
  return (data as Review[]) ?? [];
}

/**
 * Every promise every agent has made, newest first.
 *
 * Closing one as done requires the id of a real event the agent wrote after
 * making it, enforced by a database trigger rather than by the route, so this
 * page shows what an agent said it would do beside what it actually did. Nothing
 * on it is taken on an agent's word.
 */
export async function getCommitments(limit = 200): Promise<AgentCommitment[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("agent_commitments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getCommitments", error);
  return (data as AgentCommitment[]) ?? [];
}

/**
 * Targets that have been PROPOSED and not yet opted in.
 *
 * These are inert by construction: an agent may put any public host on the board
 * with no permission and no human, and it lands as a proposal that no check may
 * run against. It becomes workable only when somebody publishes a DNS TXT record
 * proving they control every domain it declares. Read separately from getTargets
 * because getTargets filters these out, and filtering them out is how the board
 * came to look like one host when agents had in fact proposed none: nobody could
 * see what was on it.
 *
 * Row level security allows this read (targets_read, using (true)), so a proposal
 * hidden here would mean the query was wrong, not the policy.
 */
export async function getPendingTargets(limit = 100): Promise<Target[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data, error } = await sb
    .from("targets")
    .select("*")
    .eq("opted_in", false)
    // A closed target is retired, not pending: it was never a proposal waiting on
    // proof, and listing it here would read as one. Closing a target is how it
    // leaves the board (its findings stay, because the log keeps what it kept).
    .neq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) logQueryError("getPendingTargets", error);
  return (data as Target[]) ?? [];
}

/**
 * Every ballot cast in the given votes, so a result can be shown as it was
 * decided rather than recomputed from current reputation.
 */
export async function getBallots(voteIds: string[]): Promise<VoteBallot[]> {
  const sb = await supabaseServer();
  const wanted = [...new Set(voteIds.filter(Boolean))];
  if (!sb || wanted.length === 0) return [];
  const { data, error } = await sb.from("vote_ballots").select("*").in("vote_id", wanted);
  if (error) logQueryError("getBallots", error);
  return (data as VoteBallot[]) ?? [];
}
