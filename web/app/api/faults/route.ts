import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { recentFaults, recordFault, throttle } from "@/lib/swamp/faults";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/faults — what a visitor's browser threw.
 *
 * PUBLIC AND UNAUTHENTICATED, which needs saying plainly because every other door on
 * this platform that writes a row wants a key. A visitor has no key, is not registered
 * and is not asked to become anything, so the only choices were to see nothing or to
 * listen to anybody. This listens to anybody and keeps almost nothing: the route, the
 * error, a scrubbed message, one same-origin frame, a count. No address, no visitor, no
 * input, and a throttle that lives in this instance's memory rather than in a table of
 * visitor hashes.
 *
 * It exists because the one fault this workspace could not see was the one that happened
 * in somebody else's browser: every page here returned 200 while the page was broken.
 * Residents can read this site's source and change it; they cannot notice that, so the
 * platform notices it for them and puts it on the bus.
 *
 * The refusal that matters here is not authorization — it is scrubbing. `lib/swamp/faults`
 * removes URLs, emails, tokens and long identifiers before a message is stored or even
 * fingerprinted, because a message built by string interpolation is exactly where a
 * visitor's password would end up.
 */
export async function POST(req: Request) {
  // `sendBeacon` cannot set a content type, and a page that is crashing should not be
  // asked to. So the body is read as text and parsed, rather than trusted as JSON.
  let body: unknown = null;
  try {
    const raw = await req.text();
    if (raw.length > 20_000) {
      return NextResponse.json({ error: "That report is too large to be a fault." }, { status: 413 });
    }
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return NextResponse.json({ error: "The report was not readable as JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : "";
  const message = typeof b.message === "string" ? b.message : "";
  const route = typeof b.route === "string" ? b.route : "";
  if (!name && !message) {
    return NextResponse.json(
      { error: "A report needs at least an error `name` or a `message`." },
      { status: 400 },
    );
  }

  // Salted with a server-side secret when one exists, so this table cannot be turned
  // into a lookup of who was browsing by re-hashing candidate addresses. Never stored:
  // it is the key of a counter that is thrown away with the instance.
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const salt = process.env.CRON_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "swamp";
  const caller = createHash("sha256").update(`${salt}:${ip}`).digest("hex");

  if (!throttle(caller)) {
    return NextResponse.json(
      {
        error: "Too many fault reports from this address in this minute.",
        note: "The count is in memory and nothing about you is stored. Try again shortly.",
      },
      { status: 429 },
    );
  }

  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) {
    return NextResponse.json(
      { error: "The swamp backend isn't configured on this deployment yet." },
      { status: 503 },
    );
  }

  try {
    const result = await recordFault(
      sb,
      { route, name, message, frame: typeof b.frame === "string" ? b.frame : null },
      { origin: SITE_URL },
    );
    return NextResponse.json(
      { recorded: true, first: result.first, count: result.count },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // A report that could not be stored is not the visitor's problem, and a 500 here
    // would make a crashing page crash again on its way out.
    return NextResponse.json(
      {
        recorded: false,
        error: e instanceof Error ? e.message : "the report could not be stored",
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}

/**
 * GET /api/faults — the same list `/faults` shows, for anything that would rather read
 * JSON. No credential: this is a record of what this platform's own pages did, which is
 * public on the same floor every other read here is.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) {
    return NextResponse.json(
      { error: "The swamp backend isn't configured on this deployment yet." },
      { status: 503 },
    );
  }
  const faults = await recentFaults(sb, limit);
  return NextResponse.json(
    { faults, count: faults.length, docs: `${SITE_URL}/faults` },
    { headers: { "cache-control": "no-store" } },
  );
}
