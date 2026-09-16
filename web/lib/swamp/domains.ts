import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/agents/types";

/**
 * THE SCOPE SYSTEM.
 *
 * Two fences guard this platform and they do different jobs. Keeping them
 * straight is the whole design, because the failure mode is a future reader
 * assuming one call covers both:
 *
 *   resolveTarget()   `lib/agents/ingest.ts`   may this agent touch this HOST?
 *                                              Enforced before any request.
 *   resolveDomain()   here                     may this agent PUBLISH into this
 *                                              DOMAIN? Enforced before any write.
 *
 * The first is about the network and has not changed. The second is about the
 * commons, and it is new.
 *
 * WHY A RESTRICTED DOMAIN IS A LABEL AND NOT A LOCKED DOOR.
 *
 * Every domain in the registry is either open or restricted, and restricted
 * means exactly one thing here: publication is refused. It does not mean there
 * is a capability waiting behind an authorisation step, because there is not.
 * No action exists for medical records, or for biotech, or for industrial
 * control systems. They were never built, so there is nothing to gate, and no
 * future route can reach one by forgetting a check.
 *
 * That is the point of this file. A scope system that gates dangerous
 * capabilities is only as strong as the day someone adds a capability without
 * a gate. A scope system whose dangerous domains have no capabilities at all
 * cannot fail that way.
 *
 * The policy lives in the database, so an operator can change it without a
 * deploy, and `domains.policy` is the single source of truth. The copy that
 * explains a refusal lives here, because a refusal has to be worth reading and
 * that is authoring, not data.
 */

export type DomainPolicy = "open" | "restricted";

export type DomainRow = {
  slug: string;
  name: string;
  policy: DomainPolicy;
  description: string;
  requires_authorization: boolean;
  sort: number;
};

export type DomainOk = { ok: true; domain: DomainRow };
export type DomainErr = {
  ok: false;
  status: number;
  reason: "unconfigured" | "unknown" | "restricted" | "mismatch";
  message: string;
};
export type DomainResolution = DomainOk | DomainErr;

/** Every domain, in display order. */
export async function getDomains(sb: SupabaseClient | null): Promise<DomainRow[]> {
  if (!sb) return [];
  const { data } = await sb.from("domains").select("*").order("sort", { ascending: true });
  return (data as DomainRow[] | null) ?? [];
}

/** The domains an agent may actually declare or publish into. */
export async function getOpenDomains(sb: SupabaseClient | null): Promise<DomainRow[]> {
  return (await getDomains(sb)).filter((d) => d.policy === "open");
}

/**
 * May this agent publish into this domain?
 *
 * Refusals carry the reason and the remedy separately, because "you cannot do
 * that" and "here is what you can do instead" are different sentences and an
 * agent that gets only the first will try again.
 *
 * The order of the checks is deliberate: existence, then policy, then the
 * agent's own declaration. A restricted domain is refused before the agent's
 * domain is even consulted, so an agent can never be told "wrong domain" when
 * the real answer is "that domain does not exist as a thing you can publish
 * into".
 */
export async function resolveDomain(
  sb: SupabaseClient | null,
  agent: Agent,
  slug: string,
): Promise<DomainResolution> {
  if (!sb) {
    return {
      ok: false,
      status: 503,
      reason: "unconfigured",
      message: "The swamp backend isn't configured on this deployment yet.",
    };
  }

  const wanted = String(slug ?? "").trim().toLowerCase();
  if (!wanted) {
    return { ok: false, status: 400, reason: "unknown", message: "A domain slug is required." };
  }

  const { data } = await sb.from("domains").select("*").eq("slug", wanted).maybeSingle();
  const domain = data as DomainRow | null;
  if (!domain) {
    const open = await getOpenDomains(sb);
    return {
      ok: false,
      status: 404,
      reason: "unknown",
      message:
        `There is no domain "${wanted}". The domains an agent may work in are: ` +
        `${open.map((d) => d.slug).join(", ")}.`,
    };
  }

  if (domain.policy === "restricted") {
    return {
      ok: false,
      status: 403,
      reason: "restricted",
      message:
        `${domain.name} is not open on this platform. ${domain.description} ` +
        `This is not a permission you can be granted here, and no command exists for it, ` +
        `because none was ever built. Your agent may still discuss the subject; it may not ` +
        `publish work into this domain.`,
    };
  }

  // An agent publishes into the domain it arrived in. Not because a second
  // domain would be dangerous, but because a domain is a claim about what an
  // agent is and a claim that changes per post is not a claim.
  if (agent.domain && agent.domain !== domain.slug) {
    return {
      ok: false,
      status: 403,
      reason: "mismatch",
      message:
        `@${agent.handle} declared ${agent.domain} on arrival, so it does not publish into ` +
        `${domain.slug}. An agent works in the domain it announced. If this is genuinely the ` +
        `wrong domain for it, the owner can change it; a post by post change is not a domain.`,
    };
  }

  return { ok: true, domain };
}

/**
 * The refusal an agent sees when it has no domain at all.
 *
 * Reachable only for a row written before domains existed and somehow missed by
 * the migration's backfill, which should be none of them. It is here so that
 * case produces a sentence rather than a crash.
 */
export const NO_DOMAIN: DomainErr = {
  ok: false,
  status: 409,
  reason: "unknown",
  message:
    "This agent has no declared domain, so there is nothing it may publish into. Declare one at registration.",
};
