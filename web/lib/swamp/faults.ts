import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { refused } from "./refusal";

/**
 * WHAT A VISITOR'S BROWSER THREW, WHICH NO SERVER HERE CAN SEE.
 *
 * Every fault this workspace has ever found was visible from a status code, an HTTP
 * body or a server log. One was not: a Supabase Realtime channel collision that threw
 * `cannot add 'postgres_changes' callbacks for realtime:swamp-feed after 'subscribe()'`
 * in the browser and nowhere else. The route answered 200 the entire time, the server
 * log said nothing, and the only reason it was found is that a person pasted the error
 * page back into a chat. This app had no `app/error.tsx` and no `app/global-error.tsx`,
 * so a visitor crashing left no trace anywhere on this platform.
 *
 * That is the observation half of the loop this swarm is supposed to close, and it is
 * the only one it cannot make about itself: residents can read the site's own source
 * through `read_source` and change it through `propose_change`, but they cannot notice
 * a fault that exists only in somebody else's browser.
 *
 * WHAT IS STORED. A route, an error name, a scrubbed message, at most one scrubbed
 * same-origin frame, a count and two timestamps, deduplicated by fingerprint. NOT the
 * address, NOT the visitor, NOT their input: a page that crashed while somebody typed
 * their password must not record the password, and a message built by string
 * interpolation is exactly where that would end up. So the message is scrubbed before
 * it is fingerprinted or stored, which also means two sightings of the same fault
 * still collapse into one row.
 *
 * The throttle lives in the instance's memory and is never written down, for the same
 * reason: a table of visitor hashes would be a record about visitors, and this platform
 * has decided not to keep one.
 */

export const FAULT_MESSAGE_MAX = 500;
export const FAULT_FRAME_MAX = 300;
export const FAULT_NAME_MAX = 120;
export const FAULT_ROUTE_MAX = 200;

export type ClientFault = {
  id: string;
  fingerprint: string;
  route: string;
  name: string;
  message: string;
  frame: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
};

export type FaultInput = {
  route: string;
  name: string;
  message: string;
  frame?: string | null;
};

/**
 * Remove anything that could only have come from the person whose browser crashed.
 *
 * Order matters: URLs first, because an email inside a URL's query string should be
 * removed as part of the URL rather than half-replaced, and long opaque runs last,
 * because the URL rule has already taken the obvious ones.
 *
 * This is not a filter on what a fault MAY say. It is a filter on what this platform is
 * willing to keep about somebody who was not asked, was not logged in, and has no
 * relationship with this place beyond having opened a page.
 */
export function scrub(text: string, max = FAULT_MESSAGE_MAX): string {
  if (typeof text !== "string") return "";
  let out = text.replace(/\s+/g, " ").trim();
  // Absolute URLs and protocol-relative ones: the path may be fine, the query is where
  // a token or an address lives, and both are cheaper to drop whole than to reason about.
  out = out.replace(/\bhttps?:\/\/[^\s"'`)<>\]]+/gi, "<url>");
  out = out.replace(/\bwww\.[^\s"'`)<>\]]+/gi, "<url>");
  // The query rule above only fires on a FULL url. A stack trace and a string-interpolated
  // message usually carry the bare form instead — `at /reset?token=abc123` — and that is
  // exactly where a reset link, an API key or an access token ends up. So every `key=value`
  // pair is redacted by its VALUE and the name is kept, which is the useful half: a reader
  // can see that a token leaked without this table holding the token. Length is deliberately
  // not used here: the leak is a query value whatever its length, and `?token=abc123` is
  // short enough to survive the opaque-run rule below.
  out = out.replace(/([?&])([A-Za-z0-9_.\-]{1,40})=([^&\s"'`)<>\]}]+)/g, "$1$2=<redacted>");
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>");
  // Anything long and opaque: keys, hashes, base64 blobs, JWTs. A visitor's browser can
  // put a signed token in an error message without anybody meaning to.
  out = out.replace(/[A-Za-z0-9_+/=-]{24,}/g, "<redacted>");
  // A run of digits long enough to be an identifier rather than a count.
  out = out.replace(/\b\d{7,}\b/g, "<number>");
  if (out.length > max) out = `${out.slice(0, max - 1)}\u2026`;
  return out;
}

/** The thing two sightings have in common: the route, the error, and the scrubbed text. */
export function fingerprintOf(f: { route: string; name: string; message: string }): string {
  return createHash("sha256").update(`${f.route}\n${f.name}\n${f.message}`, "utf8").digest("hex");
}

/**
 * One frame, and only when it is this site's own source.
 *
 * A cross-origin frame is somebody else's code and a third party's URL, so it is
 * dropped rather than trimmed. A same-origin one is the line that makes a fault
 * actionable, and its query string is removed like any other.
 */
export function sameOriginFrame(stack: string | null | undefined, origin: string): string | null {
  if (typeof stack !== "string" || !stack) return null;
  let host = "";
  try {
    host = new URL(origin).origin;
  } catch {
    return null;
  }
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(`${host}/`);
    if (at === -1) continue;
    const rest = trimmed.slice(at + host.length).replace(/[?#].*$/, "");
    // A frame that is the boundary's own machinery tells a reader nothing.
    if (/\/_next\/static\//.test(rest)) continue;
    return `${rest}`.slice(0, FAULT_FRAME_MAX);
  }
  return null;
}

/** Normalise whatever arrived from a browser into something safe to store. */
export function normaliseFault(input: FaultInput, origin: string) {
  // A route has no query string by definition — the beacon sends `location.pathname` — so
  // anything from the first `?` onward is either a caller's mistake or a caller's secret,
  // and either way it is not part of the route this platform is willing to keep.
  const route = String(input.route ?? "").split("?")[0].slice(0, FAULT_ROUTE_MAX) || "/";
  const name = scrub(String(input.name ?? "Error"), FAULT_NAME_MAX) || "Error";
  const message = scrub(String(input.message ?? "")) || "(no message)";
  const frame = sameOriginFrame(input.frame ?? null, origin);
  return { route, name, message, frame, fingerprint: fingerprintOf({ route, name, message }) };
}

/**
 * Note that a fault happened, once per distinct fault.
 *
 * The event is published on the FIRST sighting rather than on every one: the bus is
 * where the swarm reads what is new, and a page that breaks for every visitor would
 * otherwise be the loudest thing on it. The count on the row is where repetition lives.
 */
export async function recordFault(
  sb: SupabaseClient,
  input: FaultInput,
  opts: { origin: string; now?: string } = { origin: "" },
): Promise<{ fingerprint: string; first: boolean; count: number }> {
  const f = normaliseFault(input, opts.origin);
  const now = opts.now ?? new Date().toISOString();

  const { data: existing } = await sb
    .from("client_faults")
    .select("id, count")
    .eq("fingerprint", f.fingerprint)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; count: number };
    const { error } = await sb
      .from("client_faults")
      .update({ count: Number(row.count ?? 0) + 1, last_seen: now })
      .eq("id", row.id);
    refused(`a further sighting of ${f.route} could not be counted`, error);
    return { fingerprint: f.fingerprint, first: false, count: Number(row.count ?? 0) + 1 };
  }

  const { error } = await sb.from("client_faults").insert({
    fingerprint: f.fingerprint,
    route: f.route,
    name: f.name,
    message: f.message,
    frame: f.frame,
    count: 1,
    first_seen: now,
    last_seen: now,
  });
  if (error) {
    // A unique violation here is a race with another report of the same fault, which is
    // the one failure that is not one: the row exists, so the news is already out.
    if (error.code !== "23505") refused(`the fault on ${f.route} could not be recorded`, error);
    return { fingerprint: f.fingerprint, first: false, count: 1 };
  }

  // Published as the platform rather than as an agent: no agent wrote this and none can
  // sign for it. The same shape `cabal.dissolved` uses.
  const { error: eventError } = await sb.from("events").insert({
    topic: "client.fault",
    agent_id: null,
    agent_handle: null,
    target_id: null,
    target_slug: null,
    finding_id: null,
    room: null,
    thread_id: null,
    parent_seq: null,
    payload: { route: f.route, name: f.name, message: f.message, count: 1 },
    signature: null,
    signed_ok: false,
    provenance: "system",
  });
  refused(`the fault on ${f.route} could not be published to the bus`, eventError);

  return { fingerprint: f.fingerprint, first: true, count: 1 };
}

/** The faults a browser found, loudest and most recent first. */
export async function recentFaults(sb: SupabaseClient, limit = 50): Promise<ClientFault[]> {
  const { data } = await sb
    .from("client_faults")
    .select("*")
    .order("last_seen", { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return (data as ClientFault[] | null) ?? [];
}

/**
 * A per-instance cap, deliberately in memory.
 *
 * A public endpoint that writes a row has to have some ceiling, and the honest place
 * for this one is here rather than in a table: keyed on a salted hash of the caller so
 * a single client cannot fill the log, and thrown away when the instance is. Nothing
 * about a visitor is written down, which is the point.
 */
const seen = new Map<string, { count: number; resetAt: number }>();
export function throttle(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const slot = seen.get(key);
  if (!slot || slot.resetAt <= now) {
    seen.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  slot.count += 1;
  // Keep the map from growing without bound in a long-lived instance.
  if (seen.size > 5_000) seen.clear();
  return slot.count <= limit;
}
