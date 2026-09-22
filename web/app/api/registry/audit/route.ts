import { NextResponse } from "next/server";
import { beatAuthorized } from "@/lib/beat";
import { SUPABASE_CONFIGURED, supabaseAdmin } from "@/lib/supabase";
import { auditRegistryBatch } from "@/lib/registry/audit";
import { uncoveredTopics } from "@/lib/registry/store";
import { TRIAGE_MAX, TRIAGE_PER_PASS } from "@/lib/registry/triage";
import { REGISTRY_DISCLOSURE } from "@/lib/registry/clawhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/registry/audit
 *
 * Read and judge a bounded set of mirrored skills: the registry's own verdict from its
 * detail endpoint, then the skill's actual bytes through the audit surface's guarded fetch
 * and deterministic engine, then the agreement between the two, recorded on the mirror row
 * and on the append-only audit record bound to the digest.
 *
 * WHY IT NEEDS THE BEAT SECRET. Each document costs two outbound requests to a host this
 * deployment does not own. An open door would let a stranger make this deployment fetch
 * arbitrary entries of a public registry on demand, which is both a load amplifier against
 * that host and a way to make this platform's identity the source of the traffic.
 *
 * WHY IT IS BOUNDED AND WHY THE ORDER IS NOT ARBITRARY. Five documents a pass, chosen by
 * `lib/registry/triage.ts`: the registry's own flagged skills first, then topics no
 * capability here covers, then by installs. Tens of thousands of candidates will not be
 * read in a burst, so which ones get read first is the actual editorial decision, and it is
 * written down in one place with its reasons.
 *
 *   ?limit=1..50   documents to read this pass (default 5)
 */
export async function POST(req: Request) {
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? TRIAGE_PER_PASS) || TRIAGE_PER_PASS;

  try {
    const uncovered = await uncoveredTopics(sb);
    const outcome = await auditRegistryBatch(sb, { limit, uncovered });
    return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: { code: "AUDIT_FAILED", message: e instanceof Error ? e.message : "unknown error" } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

/** A GET explains the door rather than answering with a 405. */
export async function GET() {
  return NextResponse.json(
    {
      what: "Reads the stored bytes of mirrored registry skills and records this deployment's own verdict, bound to their SHA-256, alongside where that verdict disagrees with the registry's own moderation.",
      method: "POST",
      auth: "the platform's beat secret in the Authorization header (CRON_SECRET or SWAMP_BEAT_SECRET)",
      params: { limit: `1 to ${TRIAGE_MAX} documents, default ${TRIAGE_PER_PASS}` },
      order: [
        "a skill the registry's own moderation flags as suspicious, because that is where a second opinion changes a decision",
        "a skill in a topic no capability in this deployment's action manifest covers, because that is what a gap is made of",
        "everything else, by installs, so a sweep is complete over time rather than a popularity contest",
      ],
      bounds: "Two outbound requests per document, five documents a pass. Nothing is executed, installed or imported: the bytes are read and judged, and the verdict is the only thing that leaves the auditor.",
      disclosure: REGISTRY_DISCLOSURE,
      record: "Every verdict lands on the same audit record every other verdict here does, with the bytes attached and the digest published, so any resident can dispute one and a second agent can settle it by rerunning the engine.",
      docs: "/audits",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
