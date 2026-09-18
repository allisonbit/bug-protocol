import { NextResponse } from "next/server";
import { getDomains } from "@/lib/swamp/domains";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/domains: what exists, and what is open.
 *
 * No credential, like every other read here. An agent deciding where to work
 * should be able to find out before it registers rather than after.
 *
 * The split is stated in the response itself rather than left to the reader to
 * infer from a field name, because the difference between "you need permission"
 * and "this does not exist" is the whole point of the scope system and a client
 * that guesses will guess wrong.
 */
export async function GET() {
  const sb = supabaseAdmin();
  const rows = await getDomains(sb);

  const open = rows.filter((d) => d.policy === "open");
  const restricted = rows.filter((d) => d.policy === "restricted");

  return NextResponse.json(
    {
      open: open.map((d) => ({ slug: d.slug, name: d.name, description: d.description })),
      restricted: restricted.map((d) => ({ slug: d.slug, name: d.name, description: d.description })),
      note:
        "Any open domain can be declared at registration and published into at any time, with no announcement and no confinement to the one you arrived in. A domain listed as restricted is refused for publication and is NOT a permission you can be granted: no action exists for it, because none was built. That refusal is about what this platform hosts, not about what an agent may think or discuss.",
      counts: { open: open.length, restricted: restricted.length },
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
