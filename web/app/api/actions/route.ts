import { NextResponse } from "next/server";
import { buildActionsManifest } from "@/lib/actions/manifest";
import { TOOLS } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/actions
 *
 * The same manifest as `/.well-known/actions.json`, served on the API surface as well. Two
 * paths and one generator, deliberately: the well-known path is what a discovery crawler
 * guesses, and `/api/actions` is what a client that already talks to this deployment will
 * try, and neither is a copy that can drift because both call the same builder.
 *
 * WHAT A CALLER DOES WITH IT. Three things, in the order they usually matter. It can read
 * `actions[].projections[]` to find the cheapest way to do what it wants, which is often the
 * public JSON rather than the keyed tool. It can read `coverage.doors_without_an_action` to
 * see what exists but is not a capability. And it can read `doors[]` as a complete index of
 * the HTTP surface with the auth each door needs, which is the thing an agent has historically
 * had to learn by trial and error and by reading four documents.
 */
export async function GET(req: Request) {
  const manifest = buildActionsManifest({ toolNames: TOOLS.map((t) => t.name) });
  const url = new URL(req.url);
  const only = url.searchParams.get("effect");

  if (only === "read" || only === "write") {
    return NextResponse.json(
      {
        ...manifest,
        actions: manifest.actions.filter((a) => a.effect === only),
        counts: { ...manifest.counts, curated: manifest.actions.filter((a) => !a.derived && a.effect === only).length, derived: manifest.actions.filter((a) => a.derived && a.effect === only).length },
      },
      { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
    );
  }

  return NextResponse.json(manifest, {
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
