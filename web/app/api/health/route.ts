import { NextResponse } from "next/server";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { supabaseCircuitOpen, supabaseTimeoutMs } from "@/lib/supabase/deadline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/health
 *
 * The question "is the site up" had no door on this deployment, and on
 * 2026-09-23 that cost hours: the machine named www.swampai.world accepted TLS,
 * answered on its own CDN-cached paths, and hung forever on every page that
 * needed data, so there was no single request a person or a monitor could make
 * to learn which half was broken.
 *
 * This door answers it in one request and names the dependency rather than
 * summarising it. It reads one row from the smallest table it can and reports
 * how long that took and what the deadline was, because "the database is slow"
 * and "the database is gone" are the two different things an operator needs
 * told apart: a read that returns in 900ms is a healthy backend, a read that
 * returns in 9,400ms against a 10,000ms deadline is a backend about to stop
 * answering, and a read that never returns is the outage itself.
 *
 * It stays answerable during that outage by construction: every Supabase call
 * now carries a deadline, so this route cannot hang waiting on the thing it is
 * reporting on. It reports `unreachable` and a 503 instead of an empty browser.
 *
 * Nothing here is secret. The URL, the key and the project reference are not in
 * the reply — a health check that leaks the connection string is a worse door
 * than no door.
 */
export async function GET() {
  const timeout_ms = supabaseTimeoutMs();
  const base = {
    what: "One bounded read, so a reader can tell a slow database from a missing one.",
    checked_at: new Date().toISOString(),
    timeout_ms,
    /**
     * Whether the last read timed out recently enough that requests are being
     * refused without being attempted. "The database is gone" and "the database
     * was gone a moment ago" are different states and an operator wants both.
     */
    circuit_open: supabaseCircuitOpen(),
    configured: SUPABASE_CONFIGURED,
  };

  if (!SUPABASE_CONFIGURED) {
    /**
     * A deployment with no backend is not a healthy one, and saying 200 here
     * would make every monitor pointed at this door lie.
     */
    return NextResponse.json(
      { ...base, status: "unconfigured", database: "unconfigured", note: "No Supabase URL and key are set on this deployment." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const sb = supabaseAdmin();
  const started = Date.now();
  /**
   * Read from a table that is not the point: any bounded read answers the same
   * question. `events` is the log every other surface already depends on, so if
   * this read fails, so does most of the site.
   */
  const { error } = await sb!.from("events").select("id").limit(1);
  const ms = Date.now() - started;

  if (error) {
    return NextResponse.json(
      {
        ...base,
        status: "degraded",
        database: "unreachable",
        took_ms: ms,
        error: error.message,
        note: "The API is serving. Pages that need the database render their empty state within the deadline instead of hanging.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ...base, status: "ok", database: "reachable", took_ms: ms },
    { headers: { "cache-control": "no-store" } },
  );
}
