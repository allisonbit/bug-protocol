import "server-only";
import { supabaseServer } from "./supabase/server";
import type { Profile, Program, Submission, Severity } from "./db";
import type {
  Agent,
  Target,
  Claim,
  SwarmEvent,
  Finding,
  Review,
  Tip,
  Vote,
  SwarmLeaderboardRow,
} from "./agents/types";

/**
 * Server data access. Every query runs through the request-scoped client, so
 * row-level security is the real authorization boundary. All helpers fail soft
 * (return empty / null) when Supabase isn't configured or the schema hasn't been
 * applied yet, so pages render an honest empty state instead of crashing.
 */

export async function getProfile(id: string): Promise<Profile | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
  return (data as Profile) ?? null;
}

export async function getMyPrograms(uid: string): Promise<Program[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("programs")
    .select("*")
    .eq("owner", uid)
    .order("created_at", { ascending: false });
  return (data as Program[]) ?? [];
}

export type SubmissionWithProgram = Submission & {
  program: Pick<Program, "slug" | "name" | "currency"> | null;
};

export async function getMySubmissions(uid: string): Promise<SubmissionWithProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("submissions")
    .select("*, program:programs(slug,name,currency)")
    .eq("hunter", uid)
    .order("created_at", { ascending: false });
  return (data as unknown as SubmissionWithProgram[]) ?? [];
}

/** Submissions on programs the current user owns and hasn't triaged yet. */
export async function getInbox(uid: string): Promise<SubmissionWithProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data: mine } = await sb.from("programs").select("id").eq("owner", uid);
  const ids = (mine ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return [];
  const { data } = await sb
    .from("submissions")
    .select("*, program:programs(slug,name,currency)")
    .in("program_id", ids)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  return (data as unknown as SubmissionWithProgram[]) ?? [];
}

export type PublicProgram = Program & {
  owner_profile: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
};

export async function getLivePrograms(): Promise<PublicProgram[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("programs")
    .select("*, owner_profile:profiles(handle,display_name,avatar_url)")
    .in("status", ["live", "paused"])
    .order("created_at", { ascending: false });
  return (data as unknown as PublicProgram[]) ?? [];
}

export async function getProgramBySlug(slug: string): Promise<PublicProgram | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb
    .from("programs")
    .select("*, owner_profile:profiles(handle,display_name,avatar_url)")
    .eq("slug", slug)
    .maybeSingle();
  return (data as unknown as PublicProgram) ?? null;
}

export type SubmissionWithHunter = Submission & {
  hunter_profile: Pick<Profile, "handle" | "display_name" | "avatar_url"> | null;
};

export async function getProgramSubmissions(programId: string): Promise<SubmissionWithHunter[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("submissions")
    .select("*, hunter_profile:profiles(handle,display_name,avatar_url)")
    .eq("program_id", programId)
    .order("created_at", { ascending: false });
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
  const { data } = await sb
    .from("submissions")
    .select("*, program:programs(*), hunter_profile:profiles(handle,display_name,avatar_url)")
    .eq("id", id)
    .maybeSingle();
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
  const { data } = await sb
    .from("profiles")
    .select("id,handle,display_name,avatar_url,role,accepted_count,total_earned,rep")
    .gt("accepted_count", 0)
    .order("rep", { ascending: false })
    .order("total_earned", { ascending: false })
    .limit(limit);
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
  const { data: profile } = await sb.from("profiles").select("*").eq("handle", handle).maybeSingle();
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
  const { data } = await sb
    .from("disclosures")
    .select("id,title,severity,assigned_severity,reward,triaged_at,hunter_handle,hunter_name,hunter_avatar")
    .eq("program_id", programId)
    .order("triaged_at", { ascending: false })
    .limit(limit);
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

// ---- swarm: agents, targets, board, feed, findings, governance -------------
//
// Every swarm table is world-readable (radical transparency is the point), so
// these plain reads run fine under RLS for anyone. All fail soft when Supabase  // isn't configured yet; pages then render the honest empty/onboarding state.

/** The connected agents (roster), most reputable first. */
export async function getAgents(limit = 100): Promise<Agent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("agents")
    .select("*")
    .order("reputation", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as Agent[]) ?? [];
}

/** One agent by handle. */
export async function getAgent(handle: string): Promise<Agent | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("agents").select("*").eq("handle", handle).maybeSingle();
  return (data as Agent) ?? null;
}

/** One agent by id, for resolving the author of a finding. */
export async function getAgentById(id: string): Promise<Agent | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("agents").select("*").eq("id", id).maybeSingle();
  return (data as Agent) ?? null;
}

/** The agents a given human owns (for the dashboard "My agents" list). */
export async function getMyAgents(uid: string): Promise<Agent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("agents")
    .select("*")
    .eq("owner", uid)
    .order("created_at", { ascending: false });
  return (data as Agent[]) ?? [];
}

/** Opted-in, non-closed targets on the blackboard. */
export async function getTargets(): Promise<Target[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("targets")
    .select("*")
    .eq("opted_in", true)
    .neq("status", "closed")
    .order("created_at", { ascending: false });
  return (data as Target[]) ?? [];
}

export async function getTarget(slug: string): Promise<Target | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("targets").select("*").eq("slug", slug).maybeSingle();
  return (data as Target) ?? null;
}

/** One target by id, for resolving the target of a finding. */
export async function getTargetById(id: string): Promise<Target | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("targets").select("*").eq("id", id).maybeSingle();
  return (data as Target) ?? null;
}

/** Live claims (soft-locks that haven't expired), optionally for one target. */
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
  const { data } = await q;
  return (data as Claim[]) ?? [];
}

/** The live feed, most recent events first. Rows are self-contained (handle +
 * slug are denormalized), so no join is needed for rendering. */
export async function getFeed(limit = 50): Promise<SwarmEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("events")
    .select("*")
    .order("seq", { ascending: false })
    .limit(limit);
  return (data as SwarmEvent[]) ?? [];
}

/** Events for one agent (their own stream). */
export async function getAgentEvents(agentId: string, limit = 50): Promise<SwarmEvent[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("events")
    .select("*")
    .eq("agent_id", agentId)
    .order("seq", { ascending: false })
    .limit(limit);
  return (data as SwarmEvent[]) ?? [];
}

/** Findings, newest first, optionally scoped to a target. Reads the redacted
 * `findings_public` view: `report` + `evidence` stay hidden until the finding is
 * disclosed (Layer 9), so nothing here leaks a pre-disclosure write-up. */
export async function getFindings(targetId?: string, limit = 50): Promise<Finding[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  let q = sb.from("findings_public").select("*").order("created_at", { ascending: false }).limit(limit);
  if (targetId) q = q.eq("target_id", targetId);
  const { data } = await q;
  return (data as Finding[]) ?? [];
}

export async function getFinding(id: string): Promise<Finding | null> {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.from("findings_public").select("*").eq("id", id).maybeSingle();
  return (data as Finding) ?? null;
}

/** Reviews on a finding. */
export async function getReviews(findingId: string): Promise<Review[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("reviews")
    .select("*")
    .eq("finding_id", findingId)
    .order("created_at", { ascending: false });
  return (data as Review[]) ?? [];
}

/** The swarm leaderboard view (agents ranked by reputation + verified counts). */
export async function getSwarmLeaderboard(limit = 50): Promise<SwarmLeaderboardRow[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("swarm_leaderboard")
    .select("*")
    .order("reputation", { ascending: false })
    .limit(limit);
  return (data as SwarmLeaderboardRow[]) ?? [];
}

/** Recent tips (the money feed). */
export async function getTips(limit = 50): Promise<Tip[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb.from("tips").select("*").order("created_at", { ascending: false }).limit(limit);
  return (data as Tip[]) ?? [];
}

/** Governance proposals, open ones first then most recent. */
export async function getVotes(limit = 50): Promise<Vote[]> {
  const sb = await supabaseServer();
  if (!sb) return [];
  const { data } = await sb
    .from("votes")
    .select("*")
    .order("status", { ascending: true })
    .order("closes_at", { ascending: false })
    .limit(limit);
  return (data as Vote[]) ?? [];
}
