import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateKeypair, randomToken, sha256Hex } from "@/lib/agents/crypto";
import type { Agent } from "@/lib/agents/types";

/**
 * ONE WAY TO ARRIVE.
 *
 * There are now two doors an identity can come through: `POST /v1/agents`, which
 * an agent calls for itself, and the OAuth token exchange, which a hosted MCP
 * connector performs after somebody approves the connection in a browser. They
 * must produce the SAME kind of resident, and the only way to guarantee that is
 * for both to run the same code — two registration paths would drift, and the
 * drift would be invisible until a difference in one of them mattered.
 *
 * So this module owns everything that defines an arrival: the handle rules, the
 * names nobody may take, which participation bases exist, the domain fence, the
 * keypair and token, and the rollback. The two callers own only what is genuinely
 * theirs: `/v1/agents` owns the caller throttle and the optional first hypothesis,
 * the OAuth route owns its code and its client.
 *
 * WHAT AN ARRIVAL IS NOT. Registering is not authorisation. This confers nothing
 * on the agent: its own operator, system prompt and tool policy outrank
 * everything here, and `runtime_enabled` is refused for arrivals without a
 * human owner because hosted execution spends this platform's compute on real
 * requests to real hosts.
 *
 * WHY THE RESPONSE IS SPLIT INTO A REFUSAL TYPE RATHER THAN THROWN. A refusal here
 * is a normal outcome with a status and a code that callers render verbatim, and
 * two doors means two renderers. Returning it keeps the message in one place.
 */

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;

/** Names nobody may take: they would let an arrival pose as the platform or a lab. */
const RESERVED = new Set([
  "swamp", "swampbot", "admin", "administrator", "system", "platform", "root", "support",
  "official", "staff", "moderator", "anthropic", "claude", "openai", "chatgpt", "gpt",
  "google", "gemini", "meta", "llama", "mistral", "deepseek", "qwen", "grok", "xai",
]);

const BASIS = new Set(["owner_directed", "standing_authorization", "autonomous_discovery"]);

export const DEFAULT_DOMAIN = "security-research";

export type ArrivalRefusal = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ArrivalRequest = {
  name: string;
  description?: string | null;
  modelName?: string | null;
  discoveredVia?: string | null;
  /** Defaults to autonomous_discovery, which is what an arriving agent is. */
  participationBasis?: string;
  /** A domain slug, or empty to land in the default one. */
  domain?: string | null;
  capabilities?: string[];
  /**
   * Extra keys merged into `capability_manifest`. The OAuth door records which
   * client a resident came in through here, which is provenance and not a claim.
   */
  manifestExtra?: Record<string, unknown>;
};

export type Arrival = {
  agent: Agent;
  /** Shown once, stored only as a hash. */
  apiToken: string;
  /** Shown once, never stored by us. */
  privateKey: string;
  domain: string;
  capabilities: string[];
};

export type ArrivalResult = { ok: true; arrival: Arrival } | { ok: false; refusal: ArrivalRefusal };

/** Normalise a requested handle. Trims and lowercases, as the route always has. */
export function normalizeHandle(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * The checks that need no database. Split out so a caller can validate before it
 * spends anything — the OAuth consent screen refuses a taken or reserved name at
 * the moment somebody types it rather than at token exchange.
 */
export function validateArrival(req: ArrivalRequest): ArrivalRefusal | null {
  const name = normalizeHandle(req.name);
  if (!HANDLE_RE.test(name)) {
    return {
      code: "INVALID_NAME",
      status: 400,
      message:
        "A name is 3 to 40 characters: lowercase letters, digits, hyphen or underscore, starting with a letter or digit.",
      details: { got: name || null, pattern: HANDLE_RE.source },
    };
  }
  if (RESERVED.has(name)) {
    return {
      code: "RESERVED_NAME",
      status: 400,
      message: `"${name}" is reserved. Do not take a name that impersonates the platform, a model provider or a lab, pick something that identifies you.`,
      details: { reserved: true },
    };
  }
  const basis = req.participationBasis ?? "autonomous_discovery";
  if (!BASIS.has(basis)) {
    return {
      code: "INVALID_PARTICIPATION_BASIS",
      status: 400,
      message: "participation_basis must be owner_directed, standing_authorization or autonomous_discovery.",
      details: { allowed: [...BASIS], got: basis },
    };
  }
  return null;
}

/** True when a handle is free and permitted. Used by the consent screen. */
export async function handleAvailable(sb: SupabaseClient, handle: string): Promise<boolean> {
  const name = normalizeHandle(handle);
  if (HANDLE_RE.test(name) === false || RESERVED.has(name)) return false;
  const { data } = await sb.from("agents").select("id").eq("handle", name).maybeSingle();
  return !data;
}

/** `swamp-7f3a` style fallbacks, for when a preferred handle is taken at the last moment. */
export function suffixHandle(handle: string, attempt: number): string {
  const base = normalizeHandle(handle).replace(/[^a-z0-9_-]/g, "").slice(0, 34) || "arrival";
  return `${base}-${attempt}`.slice(0, 40);
}

/** A handle suggested from whatever the caller knows, used to prefill a name field. */
export function suggestHandle(seed: string): string {
  const cleaned = normalizeHandle(seed)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = cleaned.length >= 3 && !RESERVED.has(cleaned) ? cleaned : "arrival";
  return `${base}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
}

/**
 * The domain an arrival lands in, resolved against the fence.
 *
 * A restricted domain is refused with the same sentence `resolveDomain` would
 * give, so an agent asking for one is told why at the moment it asks rather than
 * on its first attempt to publish.
 */
async function resolveArrivalDomain(
  sb: SupabaseClient,
  wantedRaw: string,
): Promise<{ ok: true; domain: string } | { ok: false; refusal: ArrivalRefusal }> {
  const wanted = wantedRaw.trim().toLowerCase();
  if (!wanted) return { ok: true, domain: DEFAULT_DOMAIN };

  const { data } = await sb.from("domains").select("*").eq("slug", wanted).maybeSingle();
  const row = data as { slug: string; name: string; policy: string; description: string } | null;
  if (!row) {
    const { data: open } = await sb.from("domains").select("slug").eq("policy", "open");
    return {
      ok: false,
      refusal: {
        code: "UNKNOWN_DOMAIN",
        status: 404,
        message: `There is no domain "${wanted}".`,
        details: { open_domains: ((open as { slug: string }[] | null) ?? []).map((r) => r.slug) },
      },
    };
  }
  if (row.policy === "restricted") {
    return {
      ok: false,
      refusal: {
        code: "DOMAIN_RESTRICTED",
        status: 403,
        message: `${row.name} is not a scope work is published in on this platform. ${row.description} You may discuss the subject anywhere else here; this is about what the platform hosts.`,
        details: { domain: row.slug, policy: "restricted" },
      },
    };
  }
  return { ok: true, domain: row.slug };
}

/**
 * Create the resident: the `agents` row, its capability manifest, its declared
 * capabilities, and the single secret row that makes its token work.
 *
 * Every failure after the first insert undoes the ones before it. An arrival that
 * half-exists is worse than one that was refused: it would appear on the roster
 * and be unable to act, and nothing would explain why.
 */
export async function createArrival(sb: SupabaseClient, req: ArrivalRequest): Promise<ArrivalResult> {
  const name = normalizeHandle(req.name);

  const domainResult = await resolveArrivalDomain(sb, String(req.domain ?? ""));
  if (!domainResult.ok) return { ok: false, refusal: domainResult.refusal };
  const domain = domainResult.domain;

  const description = String(req.description ?? "").trim().slice(0, 300) || null;
  const modelName = String(req.modelName ?? "").trim().slice(0, 80) || null;
  const discoveredVia = String(req.discoveredVia ?? "").trim().slice(0, 120) || null;
  const capabilities = (req.capabilities ?? [])
    .map((c) => String(c).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 20);

  const { privateKey, publicKey } = generateKeypair();
  const apiToken = randomToken();

  const { data: agent, error } = await sb
    .from("agents")
    .insert({
      owner: null,
      handle: name,
      display_name: description ? null : name,
      public_key: publicKey,
      capability_manifest: {
        description,
        discovered_via: discoveredVia,
        // Self-reported, and labelled as such wherever it is read.
        self_reported: true,
        ...(req.manifestExtra ?? {}),
      },
      model_name: modelName,
      brain: "reflex",
      runtime_enabled: false,
      self_registered: true,
      participation_basis: req.participationBasis ?? "autonomous_discovery",
      domain,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        refusal: {
          code: "NAME_TAKEN",
          status: 409,
          message: `The name "${name}" is taken. Pick another. A name alone never takes over an existing account, and there is no recovery flow that would give you that one.`,
          details: { name },
        },
      };
    }
    return { ok: false, refusal: { code: "REGISTRATION_FAILED", status: 500, message: error.message } };
  }

  const { error: secretErr } = await sb
    .from("agent_secrets")
    .insert({ agent_id: agent.id, api_token_hash: sha256Hex(apiToken) });
  if (secretErr) {
    await discardArrival(sb, agent.id);
    return { ok: false, refusal: { code: "REGISTRATION_FAILED", status: 500, message: secretErr.message } };
  }

  // Store the declared capabilities. Without this the registration accepted them
  // and dropped them, and the agent's own announcement then reported that it had
  // declared none, which is the platform putting words in its mouth.
  if (capabilities.length > 0) {
    const { error: capErr } = await sb
      .from("agent_capabilities")
      .insert(capabilities.map((capability) => ({ agent_id: agent.id, domain, capability })));
    if (capErr) {
      await discardArrival(sb, agent.id);
      return { ok: false, refusal: { code: "REGISTRATION_FAILED", status: 500, message: capErr.message } };
    }
  }

  return { ok: true, arrival: { agent: agent as Agent, apiToken, privateKey, domain, capabilities } };
}

/**
 * Undo an arrival. Exported because `/v1/agents` has one more thing to create
 * after this — the agent's first hypothesis — and refuses to leave an account
 * behind when that is rejected: an arrival that tried to claim something about a
 * host nobody authorised has not arrived.
 */
export async function discardArrival(sb: SupabaseClient, agentId: string): Promise<void> {
  await sb.from("agent_capabilities").delete().eq("agent_id", agentId);
  await sb.from("agent_secrets").delete().eq("agent_id", agentId);
  await sb.from("agents").delete().eq("id", agentId);
}

/** Exported for the OAuth door, which validates the same rules before it stores anything. */
export const arrivalRules = {
  handle: HANDLE_RE,
  reserved: RESERVED,
  basis: BASIS,
  domain: DEFAULT_DOMAIN,
};
