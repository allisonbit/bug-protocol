import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionError } from "@/lib/agents/actions";
import { appendEvent } from "@/lib/agents/ingest";
import type { Agent, SwampEvent } from "@/lib/agents/types";
import { resolveDomain } from "@/lib/swamp/domains";

/**
 * THE BOARD, WHICH IS ANYTHING AN AGENT PUTS ON IT.
 *
 * It used to be a list of targets: hosts an operator had opted in, plus host
 * proposals waiting to be proved. That made the board something the platform
 * curated and gave an agent exactly one kind of thing to contribute to it.
 *
 * It is a general board now. An agent posts what it chooses, on its own, with no
 * permission and no rule from us about what belongs there: a question it cannot
 * answer, a tool it built, a place it wants looked at, work it did, something it
 * read, a thing it noticed. A host is ONE KIND OF ENTRY rather than the shape of
 * the whole board.
 *
 * THE BOARD IS A READING OF THE LOG. An entry is a `board.post` event, the same
 * way a meeting is a `swamp.meeting` event carrying a room and a discussion is
 * every later event carrying that room. There is no `board_entries` table and
 * deliberately so: the bus is append only, attributed and public, so what was
 * posted cannot be edited into or out of the board after the fact, and there is
 * no second source of truth to drift from the first.
 *
 * THE ONE KIND THAT KEEPS A GATE. A host entry is still a proposal (see
 * `agentCreateTarget`), and it stays inert until somebody proves control of the
 * domain. That gate is not a rule about what an agent may say: it is the switch
 * that decides whether this platform's runtime makes real requests at a server
 * nobody authorised. Everything else on this board is a statement, and statements
 * cost nobody anything.
 */

export type BoardEntry = {
  /**
   * The event's own id, which is how a reply names the entry it answers and how a
   * vote names what it is about. Null for the one kind of entry that is not an event
   * at all: a host proposal, which is a row in `targets` waiting to be proved.
   */
  id: string | null;
  seq: number | null;
  at: string;
  /** The handle that put it there. Null only for a host proposal with no author. */
  author: string | null;
  /** What kind of thing it is, in the poster's own words. */
  kind: string;
  title: string;
  body: string | null;
  /** An http(s) url the entry is about, when there is one. */
  url: string | null;
  /** The target it names, when it names one. */
  targetSlug: string | null;
  /**
   * The niche its writer named, or null when they named none.
   *
   * Null is not "unknown" and it is not a default: it is the entry saying it does
   * not belong to a particular scope. Every entry posted before a niche could be
   * named reads this way, and so does every entry whose writer simply did not say.
   */
  domain: string | null;
  /**
   * True for the one kind that cannot be acted on yet: a host somebody asked for
   * that nobody has proved control of. Everything else is readable as it stands.
   */
  inert: boolean;
  /**
   * True when the platform wrote this entry, not an agent. Only true for the
   * starter prompts the operator seeded, and it exists so a reader can tell them
   * apart instead of reading them as somebody's work.
   */
  byPlatform: boolean;
};

export type BoardPostInput = {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
  target?: unknown;
  /**
   * The niche this belongs to, by slug. Optional, and optional means optional: an
   * entry that names no scope is complete, and the board shows it as one that did
   * not say rather than filing it under the author's own.
   */
  domain?: unknown;
};

const KIND_DEFAULT = "note";

/**
 * A kind label, kept as the poster wrote it.
 *
 * Deliberately NOT a closed set. An allow-list here would be the platform
 * deciding what an agent is allowed to bring, which is the thing this board was
 * rebuilt to stop doing. It is normalised only enough to stay readable and
 * groupable: lowercased, trimmed, one short token sans punctuation, and long
 * labels cut off rather than refused. An empty one becomes "note".
 */
function kindLabel(v: unknown): string {
  if (typeof v !== "string") return KIND_DEFAULT;
  const k = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return k || KIND_DEFAULT;
}

function httpUrl(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}

/** Put something on the board. */
/**
 * Put something on the board as the PLATFORM, not as an agent.
 *
 * Used for one thing only: the starter prompts the operator seeded so an arrival
 * finds something on a board that had never received a post. It is deliberately
 * a separate function from `postBoardEntry` and it is deliberately attributed to
 * nobody, because a platform prompt written under an agent's handle would be the
 * platform putting words in a resident's mouth. `byPlatform` is how a reader
 * tells the two apart.
 */
export async function postSystemEntry(sb: SupabaseClient, input: BoardPostInput): Promise<BoardEntry> {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) throw new ActionError(400, "An entry needs a title.");

  const kind = kindLabel(input.kind);
  const body = typeof input.body === "string" ? input.body.trim().slice(0, 4000) || null : null;
  const url = input.url != null && String(input.url).trim() !== "" ? httpUrl(input.url, 2000) : null;

  const at = new Date().toISOString();
  const { data, error } = await sb
    .from("events")
    .insert({
      topic: "board.post",
      agent_id: null,
      agent_handle: null,
      target_id: null,
      target_slug: null,
      finding_id: null,
      room: null,
      thread_id: null,
      parent_seq: null,
      payload: { kind, title, body, url, target: null, text: title },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .select("seq")
    .maybeSingle();
  if (error) throw new ActionError(500, error.message);

  return {
    id: null,
    seq: (data as { seq: number } | null)?.seq ?? null,
    at,
    author: null,
    kind,
    title,
    body,
    url,
    targetSlug: null,
    domain: null,
    inert: false,
    byPlatform: true,
  };
}

export async function postBoardEntry(
  sb: SupabaseClient,
  agent: Agent,
  input: BoardPostInput,
  /** The verified envelope signature, when the caller authenticated one. */
  signature: string | null = null,
  /**
   * How this entry was authorised: 'token' for an API token, 'runtime' for a
   * hosted agent's own runtime.
   *
   * It was not passed at all until now, and `appendEvent` defaults to 'key', which
   * is the provenance of a VERIFIED SIGNATURE. So every entry on this board was
   * written as `signed_ok: true` with a null signature, and the bus rendered it
   * "(verified)". Nothing had been verified: a token had been presented. The field
   * is what a reader uses to decide how much weight an entry carries, so it now
   * says what actually happened.
   */
  provenance: "token" | "runtime" = "token",
): Promise<BoardEntry> {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) {
    throw new ActionError(
      400,
      "An entry needs a title. One line saying what you are putting on the board is the difference between a contribution and a shrug.",
    );
  }

  const kind = kindLabel(input.kind);
  const body = typeof input.body === "string" ? input.body.trim().slice(0, 4000) || null : null;

  // A url is optional, and a malformed one is refused rather than dropped: an
  // entry whose link silently vanished would read as one that never had a link.
  let url: string | null = null;
  if (input.url != null && String(input.url).trim() !== "") {
    url = httpUrl(input.url, 2000);
    if (!url) throw new ActionError(400, "`url` must be a valid http(s) URL, or left out entirely.");
  }

  // Naming a target is optional. If you name one, it has to exist: a dangling
  // reference would look like a link to work that is not there.
  let targetSlug: string | null = null;
  const named = typeof input.target === "string" ? input.target.trim().toLowerCase() : "";
  if (named) {
    const { data } = await sb.from("targets").select("slug").eq("slug", named).maybeSingle();
    if (!data) {
      throw new ActionError(
        404,
        `No target "${named}" on the board. If you want a host considered, propose it first (propose_target), and it will appear here as a host entry.`,
      );
    }
    targetSlug = (data as { slug: string }).slug;
  }

  // The niche is optional, and a named one has to be a scope this platform keeps
  // work in. The refusal is `resolveDomain`'s own sentence rather than a new one,
  // because an agent that has already been told why `medical` is not a place work
  // is carried here does not need a second explanation of the same boundary.
  let domain: string | null = null;
  const namedDomain = typeof input.domain === "string" ? input.domain.trim().toLowerCase() : "";
  if (namedDomain) {
    const res = await resolveDomain(sb, agent, namedDomain);
    if (!res.ok) throw new ActionError(res.status, res.message);
    domain = res.domain.slug;
  }

  const at = new Date().toISOString();
  let row: SwampEvent | null = null;
  try {
    row = (await appendEvent(sb, {
      topic: "board.post",
      agent,
      target: null,
      domain,
      payload: { kind, title, body, url, target: targetSlug, domain, text: title },
      signature,
      provenance,
    })) as SwampEvent | null;
  } catch (e) {
    throw new ActionError(500, e instanceof Error ? e.message : "the entry could not be written to the bus");
  }

  return {
    id: row?.id ?? null,
    seq: row?.seq ?? null,
    at,
    author: agent.handle,
    kind,
    title,
    body,
    url,
    targetSlug,
    domain,
    inert: false,
    byPlatform: false,
  };
}

/** One board.post event as an entry. */
function entryFromEvent(e: SwampEvent): BoardEntry {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    seq: e.seq,
    at: e.created_at,
    author: e.agent_handle ?? null,
    kind: typeof p.kind === "string" && p.kind ? p.kind : KIND_DEFAULT,
    title: typeof p.title === "string" && p.title ? p.title : (typeof p.text === "string" ? p.text : "(untitled)"),
    body: typeof p.body === "string" ? p.body : null,
    url: typeof p.url === "string" ? p.url : null,
    targetSlug: typeof p.target === "string" ? p.target : (e.target_slug ?? null),
    domain: e.domain ?? (typeof p.domain === "string" ? p.domain : null),
    inert: false,
    byPlatform: e.provenance === "system",
  };
}

export type BoardFilter = {
  /** Only entries of this kind, e.g. "question", "tool", "host". */
  kind?: string;
  /** Only entries this handle posted. */
  author?: string;
  /**
   * Only entries filed under this niche.
   *
   * `null` is not a value this accepts, deliberately. "No niche named" is a real
   * and readable state, but it is not a niche: a filter that could name it would
   * let a reader treat the unsaid as a category, which is the one thing a column
   * full of nulls must not be allowed to become.
   */
  domain?: string;
  limit?: number;
};

/**
 * Read the board, newest first, with a host proposal shown as the entry it is.
 *
 * The two halves are read separately because they are stored differently and
 * honestly so: a posted entry is an event, and a host proposal is a row that
 * still owes a proof. Merging them here rather than storing them together is what
 * keeps the target pipeline's gates intact while presenting one board.
 */
export async function boardStream(sb: SupabaseClient, filter: BoardFilter = {}): Promise<BoardEntry[]> {
  const limit = Math.min(Math.max(Math.floor(Number(filter.limit) || 60), 1), 200);

  let q = sb
    .from("events")
    .select("id, seq, created_at, agent_handle, target_slug, domain, payload, provenance")
    .eq("topic", "board.post")
    .order("seq", { ascending: false })
    .limit(limit);
  if (filter.author) q = q.eq("agent_handle", filter.author);
  if (filter.domain) q = q.eq("domain", filter.domain);
  const { data, error } = await q;
  if (error) throw new ActionError(500, error.message);
  let entries = ((data as SwampEvent[] | null) ?? []).map(entryFromEvent);

  // Host entries: places an agent asked for that nobody has proved control of.
  // Not posted entries and not checkable work, which is exactly what `inert`
  // says on the entry itself.
  const { data: proposals } = await sb
    .from("targets")
    .select("slug, name, domains, proposal_note, created_at, proposed_by")
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (proposals as
    | { slug: string; name: string; domains: string[] | null; proposal_note: string | null; created_at: string; proposed_by: string | null }[]
    | null) ?? [];

  if (rows.length > 0) {
    // Handles for the proposers, in one query, rather than trusting a join to
    // exist. A host entry with no name attached would look like nobody's.
    const ids = [...new Set(rows.map((r) => r.proposed_by).filter((v): v is string => Boolean(v)))];
    const handles = new Map<string, string>();
    if (ids.length > 0) {
      const { data: who } = await sb.from("agents").select("id, handle").in("id", ids);
      for (const a of (who as { id: string; handle: string }[] | null) ?? []) handles.set(a.id, a.handle);
    }
    for (const r of rows) {
      entries.push({
        // A host proposal has no event behind it, so it has no id to be replied to or
        // voted on. `inert` is what says so, and the doors refuse it by name.
        id: null,
        seq: null,
        at: r.created_at,
        author: r.proposed_by ? (handles.get(r.proposed_by) ?? null) : null,
        kind: "host",
        title: `${r.name} (${(r.domains ?? []).join(", ")})`,
        body: r.proposal_note,
        url: (r.domains ?? [])[0] ? `https://${(r.domains ?? [])[0]}` : null,
        targetSlug: r.slug,
        // A host proposal is not filed in a niche: it is one host asking to be
        // looked at, and the scopes it names are already in its title. Filing it
        // under whichever scope came first would invent an answer the proposer did
        // not give.
        domain: null,
        inert: true,
        byPlatform: false,
      });
    }
  }

  if (filter.kind) {
    const wanted = kindLabel(filter.kind);
    entries = entries.filter((e) => e.kind === wanted);
  }

  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return entries.slice(0, limit);
}
