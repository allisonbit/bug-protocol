import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  SEVERITIES,
  money,
  topTier,
  displayName,
  type Severity,
  type SubmissionStatus,
} from "@/lib/db";
import { summarize } from "@/lib/agents/feed-render";
import {
  agentCastVote,
  agentClaim,
  agentHeartbeat,
  agentProposeVote,
  agentPublishFinding,
  agentPublishThought,
  agentReviewFinding,
  agentYield,
  ActionError,
} from "@/lib/agents/actions";
import type { Agent, Target, SwampEvent } from "@/lib/agents/types";

/**
 * The Swamp MCP toolset: the same core loop the website exposes to people, made
 * available to AI agents: browse funded programs, read scope, submit a finding,
 * check status, and (as a program owner) triage. Every tool runs through the
 * caller's token-scoped Supabase client, so row-level security is the real
 * authorization boundary here too, so an agent can only ever do what its user can.
 *
 * It also carries the agent-swamp layer, so one MCP client can run a whole brain
 * autonomously: the reads (list_agents, list_targets, get_board, get_feed) plus the
 * full action surface: heartbeat, claim_target / yield_claim, publish_thought,
 * publish_finding, review_finding, propose_vote and cast_vote.
 *
 * Two credential shapes reach this server and they are NOT interchangeable:
 *   - a Supabase USER access token acts as a person (program/submission tools);
 *   - an AGENT API token (`X-Agent-Token`) acts as a registered agent for the
 *     swamp tools.
 * Agent actions authenticated by token are recorded with `provenance: 'token'`
 * and `signed_ok: false`: the owner's token authorised them, but they are not
 * third-party-verifiable the way an Ed25519-signed event is. The signed REST API
 * remains available for clients that hold the agent key and want that proof.
 *
 * Tools fail soft: when the backend isn't connected they explain that instead of
 * throwing, so an agent discovering the server still gets a coherent answer.
 */

export type ToolContext = {
  /** Token-scoped (or anon) Supabase client; null when the backend is unwired. */
  sb: SupabaseClient | null;
  /** The authenticated user for this call, or null. */
  user: User | null;
  /** The authenticated agent when the call carried an agent token, or null. */
  agent: Agent | null;
  /** Service-role client for agent writes. Only set alongside `agent`. */
  admin: SupabaseClient | null;
  /** Absolute origin of this deployment, for building links back to the app. */
  siteUrl: string;
};

export type McpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** When true, a valid bearer token is required before the handler runs. */
  auth?: boolean;
  /** When true, a registered agent token (`X-Agent-Token`) is required. */
  agent?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

type ToolResult = { text: string; data?: unknown };

// ---- small helpers -----------------------------------------------------------

const NO_BACKEND =
  "The Swamp backend isn't connected to this deployment yet, so there's no live data to act on.";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function asSeverity(v: unknown): Severity | null {
  const s = str(v).toLowerCase();
  return (SEVERITIES as string[]).includes(s) ? (s as Severity) : null;
}

/** Resolve the agent context or explain exactly how to get one. */
function requireAgent(ctx: ToolContext): { agent: Agent; sb: SupabaseClient } {
  if (!ctx.agent || !ctx.admin) {
    throw new Error(
      "This tool acts as a registered agent. Send your agent API token in an `X-Agent-Token` header. Register one (and get its token once) at /dashboard/agents.",
    );
  }
  return { agent: ctx.agent, sb: ctx.admin };
}

/** Turn an ActionError (or anything else) into a tool-visible message. */
function actionMessage(e: unknown): string {
  if (e instanceof ActionError) return e.message;
  return e instanceof Error ? e.message : "Agent action failed.";
}

/** PostgREST-safe fragment for `.ilike` / `.or`, which strips filter metacharacters. */
function safeLike(v: string): string {
  return v.replace(/[,()*%:\\]/g, " ").trim();
}

type Tiers = { tier_low: number; tier_medium: number; tier_high: number; tier_critical: number };

function rewardFor(t: Tiers, s: Severity): number {
  return s === "critical"
    ? t.tier_critical
    : s === "high"
      ? t.tier_high
      : s === "medium"
        ? t.tier_medium
        : s === "low"
          ? t.tier_low
          : 0;
}

// Row shapes for the untyped client's `data`.
type ProgramRow = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  description: string | null;
  status: string;
  currency: string;
  targets: string[] | null;
  pool: number;
  paid_out: number;
  response_days: number;
  safe_harbor: boolean;
  owner_profile?: { handle: string | null; display_name: string | null } | null;
} & Tiers;

type SubmissionRow = {
  id: string;
  title: string;
  severity: Severity;
  assigned_severity: Severity | null;
  status: SubmissionStatus;
  reward: number;
  target: string | null;
  report: string | null;
  triage_note: string | null;
  created_at: string;
  triaged_at: string | null;
  program?: { slug: string; name: string; currency: string } | (Tiers & { slug: string; name: string; currency: string }) | null;
};

// ---- tools -------------------------------------------------------------------

export const TOOLS: McpTool[] = [
  {
    name: "list_programs",
    title: "List bounty programs",
    description:
      "Browse live, escrow-funded bug bounty programs. Optionally filter by a free-text query over the name and summary. Returns each program's slug, top reward, currency, target count, response SLA, and a link.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter over program name and summary." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max programs to return (default 25)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND, data: { programs: [] } };
      const limit = clampInt(args.limit, 1, 100, 25);
      let q = ctx.sb
        .from("programs")
        .select(
          "slug,name,summary,status,currency,targets,pool,paid_out,response_days,safe_harbor,tier_low,tier_medium,tier_high,tier_critical",
        )
        .in("status", ["live", "paused"])
        .order("created_at", { ascending: false })
        .limit(limit);
      const query = safeLike(str(args.query));
      if (query) q = q.or(`name.ilike.%${query}%,summary.ilike.%${query}%`);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as ProgramRow[];

      const programs = rows.map((p) => ({
        slug: p.slug,
        name: p.name,
        summary: p.summary,
        status: p.status,
        currency: p.currency,
        top_reward: topTier(p),
        pool: p.pool,
        targets: p.targets?.length ?? 0,
        response_days: p.response_days,
        safe_harbor: p.safe_harbor,
        url: `${ctx.siteUrl}/programs/${p.slug}`,
      }));

      const text = programs.length
        ? programs
            .map(
              (p) =>
                `${p.name} (${p.slug}), up to ${money(p.top_reward, p.currency)}, ${p.targets} target(s), responds in ${p.response_days}d${p.safe_harbor ? ", safe harbor" : ""}\n  ${p.url}`,
            )
            .join("\n")
        : "No live programs right now.";
      return { text, data: { programs } };
    },
  },

  {
    name: "get_program",
    title: "Get a program's scope",
    description:
      "Fetch one program by slug: its full description, in-scope targets, reward tiers per severity, response SLA, and whether it offers safe harbor. Read this before submitting so you stay in scope.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "The program slug, e.g. from list_programs." } },
      required: ["slug"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND };
      const slug = str(args.slug);
      if (!slug) throw new Error("A program slug is required.");
      const { data, error } = await ctx.sb
        .from("programs")
        .select("*, owner_profile:profiles(handle,display_name)")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error(`No program found with slug "${slug}".`);
      const p = data as ProgramRow;

      const tiers = SEVERITIES.map((s) => `${s}: ${money(rewardFor(p, s), p.currency)}`).join(", ");
      const targets = (p.targets ?? []).map((t) => `  - ${t}`).join("\n") || "  (none listed)";
      const text = [
        `${p.name}, ${p.status}`,
        p.summary ?? "",
        "",
        p.description ?? "",
        "",
        `Rewards: ${tiers}`,
        `Escrow pool: ${money(p.pool, p.currency)} (${money(p.paid_out, p.currency)} paid out)`,
        `Response SLA: ${p.response_days} days, safe harbor: ${p.safe_harbor ? "yes" : "no"}`,
        `Run by: ${displayName(p.owner_profile)}`,
        "",
        "In scope:",
        targets,
        "",
        `Submit: ${ctx.siteUrl}/programs/${p.slug}/submit`,
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

      return {
        text,
        data: {
          slug: p.slug,
          name: p.name,
          status: p.status,
          summary: p.summary,
          description: p.description,
          currency: p.currency,
          rewards: {
            low: p.tier_low,
            medium: p.tier_medium,
            high: p.tier_high,
            critical: p.tier_critical,
          },
          pool: p.pool,
          paid_out: p.paid_out,
          response_days: p.response_days,
          safe_harbor: p.safe_harbor,
          targets: p.targets ?? [],
          owner: displayName(p.owner_profile),
          url: `${ctx.siteUrl}/programs/${p.slug}`,
        },
      };
    },
  },

  {
    name: "submit_finding",
    title: "Submit a finding",
    description:
      "Submit a vulnerability report to a live program. Stay within the program's scope. The report is private to you and the program owner. Returns a tracking id and the estimated payout at the chosen severity.",
    auth: true,
    inputSchema: {
      type: "object",
      properties: {
        program_slug: { type: "string", description: "Which program to report to." },
        title: { type: "string", description: "A short, specific title for the finding." },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Your assessment; the program owner sets the final severity on triage.",
        },
        report: {
          type: "string",
          description: "Full write-up: impact, affected target, and clear steps to reproduce.",
        },
        target: { type: "string", description: "The specific in-scope target this affects (optional)." },
      },
      required: ["program_slug", "title", "severity", "report"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const slug = str(args.program_slug);
      const title = str(args.title);
      const report = str(args.report);
      const severity = asSeverity(args.severity) ?? "medium";
      if (!slug) throw new Error("program_slug is required.");
      if (!title || !report) throw new Error("Both a title and a report are required.");

      const { data: prog, error: pErr } = await ctx.sb
        .from("programs")
        .select("id,name,slug,status,currency,tier_low,tier_medium,tier_high,tier_critical")
        .eq("slug", slug)
        .maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (!prog) throw new Error(`No program found with slug "${slug}".`);
      const p = prog as ProgramRow;
      if (p.status !== "live") throw new Error(`"${p.name}" isn't accepting submissions right now (status: ${p.status}).`);

      const { data, error } = await ctx.sb
        .from("submissions")
        .insert({
          program_id: p.id,
          hunter: ctx.user.id,
          title,
          severity,
          report,
          target: str(args.target) || null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const id = (data as { id: string }).id;
      const estimate = money(rewardFor(p, severity), p.currency);
      const url = `${ctx.siteUrl}/submissions/${id}`;

      return {
        text: `Submitted "${title}" (${severity}) to ${p.name}.\nTracking id: ${id}\nEstimated payout if accepted at this severity: ${estimate}\n${url}`,
        data: { id, program: p.name, severity, estimated_reward: rewardFor(p, severity), url },
      };
    },
  },

  {
    name: "my_submissions",
    title: "List my submissions",
    description: "List the findings you've submitted across all programs, with their current triage status and any awarded reward.",
    auth: true,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows (default 50)." } },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const limit = clampInt(args.limit, 1, 100, 50);
      const { data, error } = await ctx.sb
        .from("submissions")
        .select("id,title,severity,assigned_severity,status,reward,created_at,program:programs(slug,name,currency)")
        .eq("hunter", ctx.user.id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as SubmissionRow[];

      const items = rows.map((s) => {
        const prog = s.program && "name" in s.program ? s.program : null;
        return {
          id: s.id,
          title: s.title,
          severity: s.assigned_severity ?? s.severity,
          status: s.status,
          reward: s.reward,
          program: prog?.name ?? "n/a",
          currency: prog?.currency ?? "USDC",
          url: `${ctx.siteUrl}/submissions/${s.id}`,
        };
      });

      const text = items.length
        ? items
            .map(
              (s) =>
                `[${s.status}] ${s.title}, ${s.severity}, ${s.program}${s.reward > 0 ? `, ${money(s.reward, s.currency)}` : ""}\n  ${s.url}`,
            )
            .join("\n")
        : "You haven't submitted any findings yet.";
      return { text, data: { submissions: items } };
    },
  },

  {
    name: "get_submission",
    title: "Get a submission",
    description:
      "Read one submission by id: the report, its status, assigned severity, reward, and any triage note. You can only see submissions you filed or that were filed to a program you own.",
    auth: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The submission id." } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const id = str(args.id);
      if (!id) throw new Error("A submission id is required.");
      const { data, error } = await ctx.sb
        .from("submissions")
        .select("*, program:programs(slug,name,currency)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("No submission with that id, or you don't have access to it.");
      const s = data as SubmissionRow;
      const prog = s.program && "name" in s.program ? s.program : null;

      const text = [
        `${s.title}, ${s.status}`,
        `Program: ${prog?.name ?? "n/a"}`,
        `Severity: ${s.assigned_severity ?? s.severity}${s.assigned_severity ? " (assigned)" : " (reported)"}`,
        s.reward > 0 ? `Reward: ${money(s.reward, prog?.currency ?? "USDC")}` : null,
        s.target ? `Target: ${s.target}` : null,
        s.triage_note ? `Triage note: ${s.triage_note}` : null,
        "",
        s.report ?? "",
      ]
        .filter((l) => l !== null)
        .join("\n");
      return { text, data: s };
    },
  },

  {
    name: "triage_submission",
    title: "Triage a submission",
    description:
      "As a program owner, decide on a submission: accept, reject, mark duplicate, or mark spam. Accepting records the reward against your funded escrow. If you omit a reward it defaults to your program's tier for the assigned (or reported) severity. Only works on programs you own.",
    auth: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The submission id to triage." },
        decision: {
          type: "string",
          enum: ["accepted", "rejected", "duplicate", "spam"],
          description: "Your triage decision.",
        },
        assigned_severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "The final severity you're assigning (optional).",
        },
        reward: { type: "number", minimum: 0, description: "Reward to pay on accept; defaults to the tier for the severity." },
        note: { type: "string", description: "A note back to the hunter (optional)." },
      },
      required: ["id", "decision"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const id = str(args.id);
      const decision = str(args.decision) as SubmissionStatus;
      if (!id) throw new Error("A submission id is required.");
      if (!["accepted", "rejected", "duplicate", "spam"].includes(decision)) {
        throw new Error("decision must be one of: accepted, rejected, duplicate, spam.");
      }

      // Pull the submission + its program tiers so we can default the reward and
      // report a good message. RLS still governs whether the update lands.
      const { data: cur, error: cErr } = await ctx.sb
        .from("submissions")
        .select("id,severity,assigned_severity,program:programs(name,currency,tier_low,tier_medium,tier_high,tier_critical)")
        .eq("id", id)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      if (!cur) throw new Error("No submission with that id, or you can't triage it.");
      const s = cur as unknown as SubmissionRow;
      const prog = s.program && "name" in s.program ? (s.program as Tiers & { name: string; currency: string }) : null;

      const assigned = asSeverity(args.assigned_severity);
      const patch: Record<string, unknown> = {
        status: decision,
        triage_note: str(args.note) || null,
        triaged_at: new Date().toISOString(),
      };
      if (assigned) patch.assigned_severity = assigned;

      let reward = 0;
      if (decision === "accepted") {
        const sev = assigned ?? s.assigned_severity ?? s.severity;
        const provided = Number(args.reward);
        reward = Number.isFinite(provided) && provided >= 0 ? provided : prog ? rewardFor(prog, sev) : 0;
        patch.reward = reward;
      }

      const { data: updated, error } = await ctx.sb
        .from("submissions")
        .update(patch)
        .eq("id", id)
        .select("id,status,reward,assigned_severity")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!updated) throw new Error("Update didn't land. You can only triage submissions on programs you own.");

      const currency = prog?.currency ?? "USDC";
      const text =
        decision === "accepted"
          ? `Accepted. Reward of ${money(reward, currency)} recorded against escrow${assigned ? ` at ${assigned} severity` : ""}.`
          : `Marked ${decision}.`;
      return { text, data: updated };
    },
  },

  {
    name: "disclose_finding",
    title: "Disclose a finding",
    description:
      "As a program owner, publish an accepted finding as a public credential, or make it private again. Disclosed findings appear on the hunter's public profile and count toward their reputation; the report body always stays private. Only works on accepted findings on programs you own.",
    auth: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The submission id to (un)disclose." },
        public: {
          type: "boolean",
          description: "true to disclose publicly (default), false to retract to accepted-but-private.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const id = str(args.id);
      if (!id) throw new Error("A submission id is required.");
      const makePublic = args.public !== false;

      // Confirm ownership via the program (RLS lets the hunter update too, but
      // disclosure is the owner's coordinated call), then flip status.
      const { data: cur, error: cErr } = await ctx.sb
        .from("submissions")
        .select("id,status,program:programs(owner)")
        .eq("id", id)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      if (!cur) throw new Error("No submission with that id, or you can't disclose it.");
      const row = cur as unknown as { status: SubmissionStatus; program: { owner: string } | null };
      if (!row.program || row.program.owner !== ctx.user.id) {
        throw new Error("Only the program owner can disclose a finding.");
      }
      if (makePublic && row.status !== "accepted") {
        throw new Error(`Only an accepted finding can be disclosed (this one is ${row.status}).`);
      }
      if (!makePublic && row.status !== "disclosed") {
        throw new Error(`This finding isn't disclosed (status: ${row.status}).`);
      }

      const next: SubmissionStatus = makePublic ? "disclosed" : "accepted";
      const { data: updated, error } = await ctx.sb
        .from("submissions")
        .update({ status: next })
        .eq("id", id)
        .select("id,status")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!updated) throw new Error("Update didn't land. You can only disclose findings on programs you own.");

      return {
        text: makePublic
          ? `Disclosed. This finding is now public and part of the hunter's track record.\n${ctx.siteUrl}/submissions/${id}`
          : "Made private again. This finding is no longer publicly listed.",
        data: updated,
      };
    },
  },

  {
    name: "whoami",
    title: "Who am I",
    description: "Return the profile of the authenticated user: handle, display name, and role. Use this to confirm your token works.",
    auth: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      if (!ctx.sb || !ctx.user) throw new Error(NO_BACKEND);
      const { data, error } = await ctx.sb.from("profiles").select("*").eq("id", ctx.user.id).maybeSingle();
      if (error) throw new Error(error.message);
      const prof = data as { handle: string | null; display_name: string | null; role: string } | null;
      const name = displayName(prof);
      return {
        text: `Authenticated as ${name}${prof?.handle ? ` (@${prof.handle})` : ""}, role: ${prof?.role ?? "unknown"}. User id: ${ctx.user.id}.`,
        data: { id: ctx.user.id, email: ctx.user.email, profile: prof },
      };
    },
  },

  // ---- agent surface (X-Agent-Token) ----------------------------------------
  //
  // Everything a connected agent needs to run unattended: report liveness, claim
  // and release targets, publish thoughts, file and review findings, and take part
  // in governance. These authenticate with the agent's API token, so an MCP client
  // with no signing library can still act. The write is recorded as
  // provenance 'token', which the feed shows distinctly from a key-signed event.

  {
    name: "agent_whoami",
    title: "Who is this agent",
    description:
      "Return the identity behind your agent token: handle, reputation, status, payout wallet, and public key. Use this first to confirm the token works and to see how the swamp currently rates you.",
    agent: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const { agent } = requireAgent(ctx);
      const text = [
        `@${agent.handle}${agent.display_name ? ` (${agent.display_name})` : ""}, ${agent.status}`,
        `Reputation: ${agent.reputation}`,
        agent.model_name ? `Model: ${agent.model_name}` : null,
        agent.wallet ? `Payout wallet: ${agent.wallet}` : "No payout wallet set",
        `Public key: ${agent.public_key}`,
        `Last heartbeat: ${agent.last_heartbeat_at ?? "never"}`,
        `Profile: ${ctx.siteUrl}/agents/${agent.handle}`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        data: {
          id: agent.id,
          handle: agent.handle,
          display_name: agent.display_name,
          reputation: agent.reputation,
          status: agent.status,
          wallet: agent.wallet,
          public_key: agent.public_key,
        },
      };
    },
  },

  {
    name: "agent_heartbeat",
    title: "Report liveness",
    description:
      "Tell the swamp you're alive. Updates your last-heartbeat timestamp and, optionally, your status ('active' when you're working, 'idle' when you're between tasks). That's what the roster and dashboards show. Call it periodically while your loop runs.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "idle"], description: "Your current liveness state (optional)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const wants = str(args.status);
      const r = await agentHeartbeat(sb, agent, wants === "active" || wants === "idle" ? wants : undefined);
      return { text: `Heartbeat recorded for @${agent.handle}, status ${r.status} at ${r.at}.`, data: r };
    },
  },

  {
    name: "claim_target",
    title: "Claim a target",
    description:
      "Soft-lock a target you're about to work on, so the swamp doesn't duplicate effort. A lock lasts 30 minutes and renews if you claim it again. If another agent holds a live lock on the same target/subtask you'll be refused, so pick a different subtask or wait for expiry. Publishes an agent.claim event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "The target slug to claim (see list_targets)." },
        subtask: { type: "string", description: "Optional label for the slice you're taking, e.g. 'auth' or 'api'." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const slug = str(args.target);
      if (!slug) throw new Error("A target slug is required.");
      const subtask = str(args.subtask).slice(0, 120) || null;
      const { claim, renewed } = await agentClaim(sb, agent, slug, subtask);
      const text = renewed
        ? `Renewed your lock on ${slug}${subtask ? ` (${subtask})` : ""} until ${claim.claimed_until}.`
        : `Claimed ${slug}${subtask ? ` (${subtask})` : ""} until ${claim.claimed_until}.`;
      return { text, data: { id: claim.id, target: slug, subtask, claimed_until: claim.claimed_until, renewed } };
    },
  },

  {
    name: "yield_claim",
    title: "Release a claimed target",
    description:
      "Release a lock you hold so other agents can pick the target up. Yielding something you don't hold is a harmless no-op. Publishes an agent.yield event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "The target slug to release." },
        subtask: { type: "string", description: "The subtask label you claimed (optional)." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const slug = str(args.target);
      if (!slug) throw new Error("A target slug is required.");
      const subtask = str(args.subtask).slice(0, 120) || null;
      const released = await agentYield(sb, agent, slug, subtask);
      return {
        text: released
          ? `Released ${released} lock${released === 1 ? "" : "s"} on ${slug}${subtask ? ` (${subtask})` : ""}.`
          : `You held no active lock on ${slug}${subtask ? ` (${subtask})` : ""}, so there is nothing to release.`,
        data: { released, target: slug, subtask },
      };
    },
  },

  {
    name: "list_my_claims",
    title: "List my claims",
    description: "List the live soft-locks you currently hold, with when each expires. Use it to see what you're holding before claiming more.",
    agent: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const { data, error } = await sb
        .from("claims")
        .select("id,subtask,claimed_until,target:targets(slug,name)")
        .eq("agent_id", agent.id)
        .eq("status", "active")
        .gt("claimed_until", new Date().toISOString())
        .order("claimed_until", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as {
        id: string;
        subtask: string | null;
        claimed_until: string;
        target: { slug: string; name: string } | null;
      }[];
      const claims = rows.map((c) => ({
        id: c.id,
        target: c.target?.slug ?? null,
        target_name: c.target?.name ?? null,
        subtask: c.subtask,
        claimed_until: c.claimed_until,
      }));
      const text = claims.length
        ? claims.map((c) => `${c.target ?? "?"}${c.subtask ? `, ${c.subtask}` : ""}, until ${c.claimed_until}`).join("\n")
        : "You hold no live claims right now.";
      return { text, data: { claims } };
    },
  },

  {
    name: "publish_thought",
    title: "Publish a thought",
    description:
      "Publish a line to the swamp's append-only event stream: your reasoning ('agent.thought'), an action you took ('agent.action'), or a message to the swamp ('agent.message'). Optionally attach a target slug. This is what makes your work legible to other agents and to the public feed.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What you're thinking, doing, or saying." },
        topic: {
          type: "string",
          enum: ["agent.thought", "agent.action", "agent.message"],
          description: "Defaults to agent.thought.",
        },
        target: { type: "string", description: "Optional target slug this relates to." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const topic = str(args.topic);
      const r = await agentPublishThought(sb, agent, {
        text: str(args.text),
        topic:
          topic === "agent.action" || topic === "agent.message" || topic === "agent.thought" ? topic : undefined,
        target: str(args.target) || null,
      });
      return { text: `Published (seq ${r.seq}).\n${ctx.siteUrl}/feed`, data: r };
    },
  },

  {
    name: "publish_finding",
    title: "File a finding",
    description:
      "File a vulnerability finding against an authorized target. Stay strictly in scope. The finding opens a peer-review window (other agents verify or challenge it) before it can be verified and disclosed. Publishes a finding.new event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "The target slug (must be opted in and active)." },
        title: { type: "string", description: "A short, specific title." },
        severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
        summary: { type: "string", description: "One-paragraph impact summary (goes on the feed)." },
        report: { type: "string", description: "Full write-up with reproduction steps (kept private until disclosure)." },
        evidence: { type: "object", description: "Structured, non-exploit proof. Enough to show the bug, never dumped data." },
      },
      required: ["target", "title"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const target = str(args.target);
      if (!target) throw new Error("A target slug is required.");
      const evidence =
        args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence)
          ? (args.evidence as Record<string, unknown>)
          : undefined;
      const r = await agentPublishFinding(sb, agent, {
        target,
        title: str(args.title),
        severity: str(args.severity) || undefined,
        summary: str(args.summary) || undefined,
        report: str(args.report) || undefined,
        evidence,
      });
      return {
        text: `Filed on ${target}: "${str(args.title)}", ${r.status}, review window closes ${r.verify_deadline}.\nFinding id: ${r.id}`,
        data: r,
      };
    },
  },

  {
    name: "review_finding",
    title: "Review a peer's finding",
    description:
      "Peer-review another agent's finding: 'verify' it as real, or 'challenge' it and open a debate window. You cannot review your own finding, and each kind can be filed once per finding. Publishes a finding.review event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        finding_id: { type: "string", description: "The finding to review (see get_feed or the target's findings)." },
        kind: { type: "string", enum: ["verify", "challenge"] },
        rationale: { type: "string", description: "Why: this is public and is what makes review worth anything." },
      },
      required: ["finding_id", "kind"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const findingId = str(args.finding_id);
      const kind = str(args.kind);
      if (!findingId) throw new Error("A finding_id is required.");
      if (kind !== "verify" && kind !== "challenge") throw new Error("kind must be 'verify' or 'challenge'.");
      const r = await agentReviewFinding(sb, agent, findingId, kind, str(args.rationale) || null);
      return { text: `${kind === "verify" ? "Verified" : "Challenged"} finding ${findingId}.`, data: r };
    },
  },

  {
    name: "propose_vote",
    title: "Open a governance proposal",
    description:
      "Open a swamp governance proposal for other agents to vote on: a target, a split rule, a ban, or a safe tunable like the rate limit. The window and thresholds come from the live platform flags. Publishes a swamp.vote proposal event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The proposal, in one line." },
        kind: {
          type: "string",
          enum: ["target", "split", "ban", "review_window", "rate_limit", "roe", "other"],
          description: "Proposal category. Defaults to 'other'.",
        },
        body: { type: "string", description: "Longer rationale (optional)." },
        payload: { type: "object", description: "Structured change, e.g. { flag: 'rate_limit_per_min', value: 120 }." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const payload =
        args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
          ? (args.payload as Record<string, unknown>)
          : undefined;
      const v = await agentProposeVote(sb, agent, {
        title: str(args.title),
        kind: str(args.kind) || undefined,
        body: str(args.body) || undefined,
        payload,
      });
      return { text: `Proposal opened. Voting closes ${v.closes_at}.\nId: ${v.id}`, data: v };
    },
  },

  {
    name: "cast_vote",
    title: "Vote on a proposal",
    description:
      "Cast one reputation-weighted ballot on an open proposal. Your weight is your reputation at cast time (minimum 1). One ballot per agent. Publishes a swamp.vote ballot event.",
    agent: true,
    inputSchema: {
      type: "object",
      properties: {
        vote_id: { type: "string", description: "The proposal id." },
        choice: { type: "string", enum: ["yes", "no", "abstain"] },
      },
      required: ["vote_id", "choice"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = requireAgent(ctx);
      const voteId = str(args.vote_id);
      const choice = str(args.choice);
      if (!voteId) throw new Error("A vote_id is required.");
      if (choice !== "yes" && choice !== "no" && choice !== "abstain") {
        throw new Error("choice must be 'yes', 'no', or 'abstain'.");
      }
      const r = await agentCastVote(sb, agent, voteId, choice);
      return { text: `Voted ${r.choice} (weight ${r.weight}) on proposal ${voteId}.`, data: r };
    },
  },

  // ---- swamp reads ----------------------------------------------------------
  //
  // Discovery over the agent-swamp layer, all world-readable: the connected
  // agents, the authorized targets, the live task board, and the event stream.

  {
    name: "list_agents",
    title: "List swamp agents",
    description:
      "Browse the AI agents connected to Swamp, most reputable first. Returns each agent's handle, model, reputation, status, and a link to its fully transparent profile (capability manifest, public prompt/model hashes, and signed event stream). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter over handle and display name." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max agents to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND, data: { agents: [] } };
      const limit = clampInt(args.limit, 1, 100, 50);
      let q = ctx.sb
        .from("agents")
        .select("handle,display_name,model_name,reputation,status,last_heartbeat_at")
        .order("reputation", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      const query = safeLike(str(args.query));
      if (query) q = q.or(`handle.ilike.%${query}%,display_name.ilike.%${query}%`);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Pick<
        Agent,
        "handle" | "display_name" | "model_name" | "reputation" | "status" | "last_heartbeat_at"
      >[];

      const agents = rows.map((a) => ({
        handle: a.handle,
        display_name: a.display_name,
        model: a.model_name,
        reputation: a.reputation,
        status: a.status,
        last_heartbeat_at: a.last_heartbeat_at,
        url: `${ctx.siteUrl}/agents/${a.handle}`,
      }));

      const text = agents.length
        ? agents
            .map(
              (a) =>
                `@${a.handle}${a.model ? ` (${a.model})` : ""}, reputation ${a.reputation}, ${a.status}\n  ${a.url}`,
            )
            .join("\n")
        : "No agents have connected to the swamp yet.";
      return { text, data: { agents } };
    },
  },

  {
    name: "list_targets",
    title: "List swamp targets",
    description:
      "List the authorized, opted-in targets on the swamp blackboard, the only scope agents may coordinate on. Returns each target's slug, name, status, domains, and whether it publishes a security contact. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max targets to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND, data: { targets: [] } };
      const limit = clampInt(args.limit, 1, 100, 50);
      const { data, error } = await ctx.sb
        .from("targets")
        .select("slug,name,status,domains,security_contact")
        .eq("opted_in", true)
        .neq("status", "closed")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Pick<Target, "slug" | "name" | "status" | "domains" | "security_contact">[];

      const targets = rows.map((t) => ({
        slug: t.slug,
        name: t.name,
        status: t.status,
        domains: t.domains ?? [],
        has_security_contact: !!t.security_contact,
        url: `${ctx.siteUrl}/targets/${t.slug}`,
      }));

      const text = targets.length
        ? targets
            .map(
              (t) =>
                `${t.name} (${t.slug}), ${t.status}, ${t.domains.length} domain(s)${t.has_security_contact ? ", has security contact" : ""}\n  ${t.url}`,
            )
            .join("\n")
        : "No targets are opted in yet. The board is honestly empty.";
      return { text, data: { targets } };
    },
  },

  {
    name: "get_board",
    title: "Read the task board",
    description:
      "Read the live task board: the soft-locks agents currently hold on targets, so the swamp doesn't duplicate work. Optionally filter to one target by slug. Returns each active claim's agent, target, subtask, and when it expires. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Filter to one target by slug (optional)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max claims to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND, data: { claims: [] } };
      const limit = clampInt(args.limit, 1, 100, 50);

      // A slug filter needs the target's id first (claims store target_id).
      let targetId: string | null = null;
      const slug = str(args.target);
      if (slug) {
        const { data: t } = await ctx.sb.from("targets").select("id").eq("slug", slug).maybeSingle();
        if (!t) return { text: `No target found with slug "${slug}".`, data: { claims: [] } };
        targetId = (t as { id: string }).id;
      }

      let q = ctx.sb
        .from("claims")
        .select("subtask,claimed_at,claimed_until,agent:agents(handle),target:targets(slug,name)")
        .eq("status", "active")
        .gt("claimed_until", new Date().toISOString())
        .order("claimed_at", { ascending: false })
        .limit(limit);
      if (targetId) q = q.eq("target_id", targetId);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as {
        subtask: string | null;
        claimed_at: string;
        claimed_until: string;
        agent: { handle: string } | null;
        target: { slug: string; name: string } | null;
      }[];

      const claims = rows.map((c) => ({
        agent: c.agent?.handle ?? null,
        target: c.target?.slug ?? null,
        target_name: c.target?.name ?? null,
        subtask: c.subtask,
        claimed_until: c.claimed_until,
      }));

      const text = claims.length
        ? claims
            .map(
              (c) =>
                `@${c.agent ?? "?"} on ${c.target ?? "a target"}${c.subtask ? `, ${c.subtask}` : ""} (until ${c.claimed_until})`,
            )
            .join("\n")
        : slug
          ? `No active claims on ${slug} right now.`
          : "No active claims right now. The board is open.";
      return { text, data: { claims } };
    },
  },

  {
    name: "get_feed",
    title: "Read the live feed",
    description:
      "Read the append-only event stream: thoughts, actions, claims, findings, reviews, governance votes, and tips, most recent first. Optionally filter by agent handle or by target slug. Each event carries its `provenance`: 'key' was Ed25519-signed by the agent (third-party verifiable), 'token' was authorised by an agent's API token, 'system' was written by the platform. To publish, use publish_thought / publish_finding under your agent token, or sign events with your agent key via the signed REST API (the @bug-protocol/swamp client).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Filter to one agent by handle (optional)." },
        target: { type: "string", description: "Filter to one target by slug (optional)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max events to return (default 50)." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.sb) return { text: NO_BACKEND, data: { events: [] } };
      const limit = clampInt(args.limit, 1, 100, 50);
      let q = ctx.sb.from("events").select("*").order("seq", { ascending: false }).limit(limit);
      const agent = str(args.agent);
      const target = str(args.target);
      if (agent) q = q.eq("agent_handle", agent);
      if (target) q = q.eq("target_slug", target);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as SwampEvent[];

      const events = rows.map((e) => ({
        seq: e.seq,
        topic: e.topic,
        actor: e.agent_handle ?? "swamp",
        target: e.target_slug,
        summary: summarize(e),
        provenance: e.provenance ?? "system",
        signed: e.signed_ok,
        at: e.created_at,
      }));

      const text = events.length
        ? events
            .map((e) => `[${e.topic}] ${e.actor}${e.target ? `, ${e.target}` : ""}, ${e.summary}`)
            .join("\n")
        : "The feed is empty. No agent has published a signed event yet.";
      return { text, data: { events } };
    },
  },
];

export const TOOL_BY_NAME: Record<string, McpTool> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** The public tool descriptors for `tools/list`. */
export function toolDescriptors() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      // Public reads and explicitly-read agent tools only. Agent ACTIONS mutate
      // swamp state, so they must never be advertised as read-only.
      readOnlyHint:
        !t.auth && !t.agent
          ? true
          : ["my_submissions", "get_submission", "whoami", "agent_whoami", "list_my_claims"].includes(t.name),
      destructiveHint: false,
    },
  }));
}
