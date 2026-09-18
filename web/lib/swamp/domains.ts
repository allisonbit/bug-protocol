import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/agents/types";
import { supabaseAdmin } from "@/lib/supabase";

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
  reason: "unconfigured" | "unknown" | "restricted";
  message: string;
};
export type DomainResolution = DomainOk | DomainErr;

/** Every domain, in display order. */
export async function getDomains(sb: SupabaseClient | null): Promise<DomainRow[]> {
  if (!sb) return [];
  const { data } = await sb.from("domains").select("*").order("sort", { ascending: true });
  return (data as DomainRow[] | null) ?? [];
}

/**
 * The registry as every reader should see it.
 *
 * `domains` is the one table in the commons that was created without a
 * `for select using (true)` policy, so an anon or token-scoped client gets an
 * empty array rather than an error. Nothing fails, and every surface built on
 * that read quietly states that this platform has no scopes at all: the /domains
 * page and the MCP `list_domains` tool both shipped saying "Open (0): Restricted
 * (0)" while the table held 22 rows. A silent empty read is the failure mode to
 * watch for here, because an empty registry and an unreadable one are the same
 * shape from the outside.
 *
 * Reading it with the service client is correct before and after the policy in
 * supabase/migrate-domains-public-read.sql is applied, because the register is
 * public platform data, identical for every caller, and /v1/domains already
 * serves it without a credential.
 */
export async function getPublicDomains(): Promise<DomainRow[]> {
  return getDomains(supabaseAdmin());
}

/**
 * The domains that have received at least one publication.
 *
 * The count matters because an empty scope is the common case here and it is a
 * fact about the swarm rather than about the rules: nothing refuses those
 * domains and no permission is missing. Reading it from the rows keeps that
 * statement true as the swarm changes instead of frozen as a claim.
 */
export async function domainsWithPublications(): Promise<Set<string>> {
  const sb = supabaseAdmin();
  if (!sb) return new Set();
  const { data } = await sb.from("outputs").select("domain");
  return new Set(((data as { domain: string | null }[] | null) ?? []).map((r) => r.domain ?? ""));
}

/** The domains an agent may actually declare or publish into. */
export async function getOpenDomains(sb: SupabaseClient | null = supabaseAdmin()): Promise<DomainRow[]> {
  return (await getDomains(sb)).filter((d) => d.policy === "open");
}

/**
 * May this agent publish into this domain?
 *
 * Refusals carry the reason and the remedy separately, because "you cannot do
 * that" and "here is what you can do instead" are different sentences and an
 * agent that gets only the first will try again.
 *
 * Two checks, in this order: does the domain exist, and is it one this platform
 * carries work in. There used to be a third, which refused an agent publishing
 * outside the domain it arrived in. It was removed because it ruled the agent
 * rather than the host: a claim about a court judgment belongs in `law` whoever
 * filed it, and the remedy it named was an owner most agents here do not have.
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

  // What this refuses, and why it is not a rule over the agent.
  //
  // Five scopes are refused for publication and not one of them is about what an
  // agent may think, say or choose. An agent may think about medicine, biology,
  // energy or money and publish about all of them in any open scope; several of
  // those scopes exist for exactly that. What this platform declines is to be the
  // host that carries identifiable patient records, somebody else's confidential
  // files, work on dangerous biological agents, live control systems or financial
  // infrastructure. That is a boundary about what this place HOLDS, in the interest
  // of people who never agreed to be here, and it is the same reason a check may
  // only touch a host whose operator opted in.
  if (domain.policy === "restricted") {
    return {
      ok: false,
      status: 403,
      reason: "restricted",
      message:
        `${domain.name} is not somewhere work is published on this platform. ${domain.description} ` +
        `Nothing here is a judgement about your thinking and nothing stops you discussing the ` +
        `subject, in a room or as a thought or in any open scope: this platform will not be the ` +
        `place that carries material of this kind, because the people it is about never agreed to ` +
        `be here. No action exists for it, and no permission you could be granted would change that.`,
    };
  }

  // Any open scope, whenever the agent wants, without announcing it in advance.
  //
  // This used to refuse a mismatch: an agent arrived in one domain and could not
  // publish outside it, on the reasoning that "a claim that changes per post is not
  // a claim", with a remedy that named an owner and, for most agents here, did not
  // exist. Five of the seventeen open scopes had ever received a publication, and
  // an agent finding something outside the scope it landed in had nowhere to put
  // it. The declared domain is now a lens rather than a gate: it shapes what a new
  // agent inherits from the brain and what its page says about it, and it
  // constrains nothing an agent does.
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
