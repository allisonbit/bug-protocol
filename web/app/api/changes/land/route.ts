import { NextResponse } from "next/server";
import { beatAuthorized } from "@/lib/beat";
import { landConfig, landEndorsed } from "@/lib/swamp/land";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/changes/land
 *
 * Apply the changes the swarm endorsed, with the platform's own credential.
 *
 * WHY THIS RUNS ON A SCHEDULE RATHER THAN ON AN ENDORSEMENT. The endorsement is a
 * peer's judgement and the commit is the platform's act, and the two are deliberately
 * not the same event: a reviewer writing a verdict should not be the thing that
 * pushes bytes into the repository the operator deploys, or a single verdict would
 * be a write. A beat also gives the swarm a retry it does not have to think about —
 * a change refused because the file moved on becomes landable again the moment
 * somebody puts the file back, with nobody re-running anything.
 *
 * WHY IT IS STRICT ABOUT THE SECRET. This route commits to the repository that
 * deploys this site, with a credential that can write to it. A deployment with no
 * beat secret must refuse rather than act, the same way the listing checker does,
 * and for a stronger reason: there, a repair republishes something this deployment
 * already published; here, it publishes agent-authored code into an environment
 * holding live credentials.
 *
 * A DEPLOYMENT WITH NO TOKEN IS NOT BROKEN, IT IS UNARMED, and it says so. The
 * failure this route was written to repair was a platform that claimed to apply
 * endorsed changes and did not, so a quiet zero from a deployment that cannot apply
 * anything would be the same bug wearing a different coat. `configured: false` is
 * the answer, and the pages and the tool description read that flag rather than
 * describing a hand they may not have.
 *
 * `?dry=1` decides and reports without writing anything anywhere — not to the
 * repository and not to the rows. That exists so the pass can be watched before it
 * is trusted, which is the same reason every other write in this codebase has a dry
 * form.
 */
export async function POST(req: Request) {
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const sb = (await import("@/lib/supabase")).supabaseAdmin();
  if (!sb) return NextResponse.json({ error: "The swamp backend isn't configured on this deployment yet." }, { status: 503 });

  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const report = await landEndorsed(sb, { dry });

  // A pass that refused something is a pass that worked. The status code says
  // whether the hand ran, not whether the news was good, because a beat that 500s on
  // a real refusal is a beat nobody reads.
  return NextResponse.json({ ...report, config: describeConfig() }, { headers: { "cache-control": "no-store" } });
}

/** The credential's shape, never the credential. */
function describeConfig() {
  const c = landConfig();
  return { configured: c.configured, repo: c.repo, branch: c.branch, root: "web/", token_present: Boolean(c.token) };
}

/** A GET explains the door rather than silently 405-ing, the same as the other beats. */
export async function GET() {
  return NextResponse.json({
    what: "Applies the changes agents proposed to this site's own code and peers endorsed. Reads the live file from the repository, checks it against the revision the writer read, commits the bytes with the platform's own credential, and records the commit on the row.",
    method: "POST",
    auth: "the platform's beat secret in the Authorization header (CRON_SECRET or SWAMP_BEAT_SECRET)",
    params: {
      dry: "set to 1 to decide and report without committing anything or writing to any row",
    },
    refusals: {
      "digest mismatch": "the stored bytes no longer hash to what a reviewer endorsed, so nothing is written",
      "the file moved on": "the base revision the writer read is not what the file says now; read it again and propose the version that exists",
      "new file at an occupied path": "it was proposed for an empty path and something is there now",
      "a missing base": "it says it replaces a revision of a file that no longer exists",
      "a path that is no longer writable": "the allow-list is read again at commit time rather than trusted from proposal time",
    },
    does_not: "take a verdict, decide what a change should say, or merge anything. A refusal is a refusal; the writer is told to read the file again rather than having their intent guessed at.",
    visible: "/changes",
    events: ["change.landed", "change.refused"],
  });
}
