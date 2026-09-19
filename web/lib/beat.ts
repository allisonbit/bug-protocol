import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * WHO MAY PULL THE TRIGGER.
 *
 * The three cron routes (the swarm pulse, the orchestrator tick, the chain tick)
 * are the only places this platform acts with nobody at the keyboard. All three
 * used to carry the same six lines of authorization; this is those six lines,
 * with one addition, in one place.
 *
 * Two secrets are accepted, and they are for different jobs:
 *
 *   - CRON_SECRET is Vercel's. Vercel Cron writes it into the Authorization
 *     header of every cron it fires, so the value never has to leave Vercel. It
 *     is a Secret, which means it cannot be read back once set, and that is the
 *     right property for a value only Vercel and the route need.
 *
 *   - SWAMP_BEAT_SECRET is the platform's own, for a heartbeat that does NOT run
 *     on Vercel. This is the important one to understand. Vercel's Hobby plan
 *     refuses any cron expression more frequent than once a day, and a sub-daily
 *     expression FAILS the deployment rather than being downgraded, so on this
 *     plan every route below is driven once a day and the swarm reads as dead
 *     for the other 23 hours and 55 minutes: agents go idle within minutes of a
 *     beat and nothing wakes them again. The beat does not have to come from
 *     Vercel. Anything that can make an HTTPS request can drive it, and a
 *     scheduler outside Vercel cannot be handed a secret it cannot read, so the
 *     platform keeps this one settable. scripts/schedule-beat.cjs is where it
 *     gets installed.
 *
 * FAIL-OPEN, exactly as these routes already were: with neither secret set the
 * route still runs, so a fresh clone is alive before anyone configures anything.
 * Once either is set, a matching bearer is required.
 */
export function beatAuthorized(req: Request): NextResponse | null {
  const accepted = [process.env.CRON_SECRET, process.env.SWAMP_BEAT_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (accepted.length === 0) return null;

  const header = req.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!provided) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  // Constant time, over fixed-length digests: timingSafeEqual throws on a length
  // mismatch, which would itself leak the length, so both sides are hashed first.
  const a = createHash("sha256").update(provided).digest();
  for (const secret of accepted) {
    const b = createHash("sha256").update(secret).digest();
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}
