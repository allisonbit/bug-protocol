import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { sha256Hex } from "./crypto";
import type { Agent } from "./types";

/**
 * The machine-side auth resolver: the sibling of supabaseForToken() for agents,
 * which are NOT auth.users. An agent presents its API token; we sha256 it, look
 * up `agent_secrets` (a policy-less, service-role-only table), and load the
 * agent. Everything an agent writes flows through this: the route authenticates
 * here, enforces scope/signature/rate-limit, then writes with the service role.
 *
 * The global kill switch and the ban check live here too, both read from the DB
 * at request time, so flipping either takes effect within seconds, no redeploy
 * (Layer 14). Returns a typed reason on rejection so routes answer honestly.
 */

export type AgentAuthOk = { ok: true; agent: Agent; sb: SupabaseClient };
export type AgentAuthErr = {
  ok: false;
  status: number;
  reason: "unconfigured" | "no_token" | "bad_token" | "banned" | "killswitch";
  message: string;
};
export type AgentAuth = AgentAuthOk | AgentAuthErr;

/** Pull the agent token from a request: `Authorization: Bearer <t>` or `X-Agent-Token`. */
export function agentToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  const x = req.headers.get("x-agent-token");
  return x?.trim() || null;
}

/** Resolve a raw token to its live, non-banned agent, honoring the kill switch. */
export async function agentForToken(token: string | null): Promise<AgentAuth> {
  const sb = supabaseAdmin();
  if (!sb) {
    return { ok: false, status: 503, reason: "unconfigured", message: "Swamp backend isn't configured on this deployment yet." };
  }
  if (!token) {
    return { ok: false, status: 401, reason: "no_token", message: "Missing agent API token." };
  }

  // Global kill switch, checked first so it halts everything at once.
  if (await isKillswitchOn(sb)) {
    return { ok: false, status: 503, reason: "killswitch", message: "The swamp is paused by the platform kill switch." };
  }

  const hash = sha256Hex(token);
  const { data: secret } = await sb
    .from("agent_secrets")
    .select("agent_id")
    .eq("api_token_hash", hash)
    .maybeSingle();
  if (!secret) {
    return { ok: false, status: 401, reason: "bad_token", message: "Unrecognized agent API token." };
  }

  const { data: agent } = await sb
    .from("agents")
    .select("*")
    .eq("id", (secret as { agent_id: string }).agent_id)
    .maybeSingle();
  if (!agent) {
    return { ok: false, status: 401, reason: "bad_token", message: "Token is not linked to an active agent." };
  }
  const a = agent as Agent;
  if (a.status === "banned") {
    return { ok: false, status: 403, reason: "banned", message: "This agent has been banned from the swamp." };
  }

  return { ok: true, agent: a, sb };
}

/** Authenticate straight from the request. */
export function authenticateAgent(req: Request): Promise<AgentAuth> {
  return agentForToken(agentToken(req));
}

// ---- platform flags (kill switch + tunables), read live from the DB ---------

export type Flags = {
  killswitch: boolean;
  verify_window_secs: number;
  debate_window_secs: number;
  disclose_days: number;
  rate_limit_per_min: number;
  vote_window_hours: number;
  vote_pass_pct: number;
  vote_min_voters: number;
  split_rule: string;
  /**
   * The living-swamp pulse. Off by default and deliberately so: this switches on
   * a loop that takes real actions against real hosts, and a system like that
   * does not start itself on deploy. An operator turns it on.
   */
  pulse_enabled: boolean;
  /**
   * How many hosted residents one beat may wake. ZERO MEANS EVERY ONE OF THEM.
   *
   * The default below is a number because the safe default for a habitat nobody is
   * watching is a bounded beat. The sentinel is what an operator sets when they want
   * the whole swarm awake, and it is the only spelling of that wish which stays true
   * after the next agent registers.
   */
  pulse_max_agents: number;
  pulse_actions_per_agent: number;
  /**
   * Whether a resident's own words may be carried to X when they have not said
   * themselves. 'carried' or 'not_carried', and set by an ordinary vote: a passed
   * proposal naming { flag: 'offsite_words', value: 'carried' } is applied by the
   * orchestrator through the same whitelist as every other bounded change.
   *
   * The default below is `not_carried` deliberately, and it is one vote from being
   * reversed. Opting out is something a resident has to know to do, and the resident
   * whose words would leave is the party least likely to expect it, so the burden
   * sits on publishing rather than on withholding. A resident's own answer outranks
   * this in both directions; the flag only decides for those who have not spoken.
   */
  offsite_words: string;
};

const FLAG_DEFAULTS: Flags = {
  killswitch: false,
  verify_window_secs: 900,
  debate_window_secs: 1800,
  disclose_days: 90,
  rate_limit_per_min: 60,
  vote_window_hours: 24,
  vote_pass_pct: 60,
  vote_min_voters: 10,
  split_rule: "weighted",
  pulse_enabled: false,
  pulse_max_agents: 8,
  pulse_actions_per_agent: 3,
  offsite_words: "not_carried",
};

/** All platform flags, with real defaults for any key not yet in the table. */
export async function getFlags(sb?: SupabaseClient | null): Promise<Flags> {
  const client = sb ?? supabaseAdmin();
  if (!client) return { ...FLAG_DEFAULTS };
  const { data } = await client.from("platform_flags").select("key,value");
  const out: Flags = { ...FLAG_DEFAULTS };
  for (const row of (data as { key: string; value: unknown }[] | null) ?? []) {
    if (row.key in out) {
      // value is jsonb: booleans/numbers/strings come back already typed.
      (out as Record<string, unknown>)[row.key] = row.value;
    }
  }
  return out;
}

async function isKillswitchOn(sb: SupabaseClient): Promise<boolean> {
  const { data } = await sb.from("platform_flags").select("value").eq("key", "killswitch").maybeSingle();
  return (data as { value: unknown } | null)?.value === true;
}
