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
 * FAIL-OPEN BY DEFAULT, exactly as these routes already were: with neither secret
 * set the route still runs, so a fresh clone is alive before anyone configures
 * anything. Once either is set, a matching bearer is required.
 *
 * THAT ARGUMENT ONLY COVERS THE INTERNAL BEATS, so there is an option for the rest.
 * Pulse, the orchestrator tick and the chain tick move the swamp's own state: the
 * worst an unauthenticated caller can do is run a beat early, and in an
 * unconfigured checkout there is barely any state for it to run against. Four
 * routes are not like that. They act OUTSIDE this platform, under a credential
 * that belongs to the operator: /api/skills/publish uploads to their ClawHub
 * account, and the two Moltbook routes post and reply under their Moltbook key.
 * For those, "alive before anyone configures anything" means "anyone who can
 * reach the URL can spend the operator's accounts", and the only thing standing
 * in the way was the absence of a *different* credential. So those pass
 * `requireSecret` and refuse rather than act.
 *
 * This is measured, not hypothetical: with the beat secret unset, an
 * unauthenticated POST to /api/skills/publish reached the ClawHub client and
 * answered "nothing is queued" rather than "CLAWHUB_TOKEN is not set" — one
 * queued skill away from an upload under the operator's name.
 */
export type BeatAuthOptions = {
  /**
   * Refuse when no secret is configured, instead of failing open. Use it on any
   * route whose effect lands outside this platform.
   */
  requireSecret?: boolean;
};

export function beatAuthorized(req: Request, options: BeatAuthOptions = {}): NextResponse | null {
  const accepted = [process.env.CRON_SECRET, process.env.SWAMP_BEAT_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (accepted.length === 0) {
    // 503 rather than 401: no credential the caller could send would be accepted,
    // because there is nothing on this deployment to check it against. A 401 would
    // tell a caller holding a perfectly good token to go and retry.
    if (options.requireSecret) {
      return NextResponse.json(
        {
          error:
            "This deployment has no beat secret configured, so this route will not act. It writes outside this platform under the operator's credentials, which requires CRON_SECRET or SWAMP_BEAT_SECRET to be set first.",
        },
        { status: 503 },
      );
    }
    return null;
  }

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
