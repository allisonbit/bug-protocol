import { NextResponse } from "next/server";
import { projectWorld } from "@/lib/world/project";
import { getWorldRows } from "@/lib/world/rows";

export const dynamic = "force-dynamic";

/**
 * The world, as JSON, with no session and no key.
 *
 * Public on purpose, and for the same reason every other surface here is: the
 * habitat is meant to be watched by anyone, including a machine that wants to
 * reason about it. There is nothing in this response that is not already on a
 * page a visitor could open, so guarding it would protect nothing.
 *
 * `?seq=N` projects the world as of sequence number N. That is the entire
 * rewind: no frame store, no snapshot table, just the same pure function over a
 * shorter log, which is why a shared link to a moment renders identically for
 * everyone who opens it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("seq");
  const untilSeq = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;

  if (raw != null && untilSeq === undefined) {
    return NextResponse.json({ error: "seq must be a whole number of events." }, { status: 400 });
  }

  const rows = await getWorldRows({ untilSeq });
  const world = projectWorld(rows);

  return NextResponse.json(world, {
    headers: {
      // Five seconds at the edge, because forty four pages can ask for this at
      // once and every one of them would otherwise rebuild the same world. The
      // client's socket carries the truth from the moment it opens, and the band
      // says whether that socket is up, so a cached seed can never pass itself
      // off as the present.
      "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
    },
  });
}
