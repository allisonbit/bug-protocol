import { NextResponse } from "next/server";
import { signDiscovery, SIGNATURE_HEADER, SIGNATURE_INPUT_HEADER, KEY_ID_HEADER, SIGNATURE_STATUS_HEADER } from "@/lib/discovery-signing";
import { buildActionsManifest } from "@/lib/actions/manifest";
import { TOOLS } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/actions.json (rewritten from /well-known/actions).
 *
 * WHAT THIS IS. One document that answers "what can be done here, and how do I reach each
 * thing" for an agent that has just discovered this host and has no idea which of the eighty
 * three tools or seventy eight doors it wants. It is the join between the two registries,
 * which until now only existed in the heads of the people who built them.
 *
 * WHY IT IS SIGNED LIKE THE REST OF THE DISCOVERY FAMILY. An agent deciding whether to call
 * a write door is reading a document that names the exactly-one auth for that door. If the
 * document can be altered in transit, the document is an attack: change one `auth` field and
 * a keyed door reads as public. So it carries the same detached signature as the agent card
 * and the API catalog, over the same canonical input, with the same key id, and a client can
 * verify it or refuse it.
 *
 * WHY THE TOOL REGISTRY IS PASSED IN. `lib/actions/manifest.ts` is pure and importable by a
 * node verifier with no database; the tool registry is not, because it reaches the Supabase
 * client. So the route supplies the names, and `scripts/verify-actions.cjs` extracts the same
 * names from the registry's own source, which means the two have to agree or the verifier
 * fails.
 */
export async function GET() {
  const manifest = buildActionsManifest({ toolNames: TOOLS.map((t) => t.name) });
  const body = JSON.stringify(manifest, null, 2);

  return new NextResponse(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...signDiscovery(body, "/.well-known/actions.json"),
      [SIGNATURE_STATUS_HEADER]: "see /discovery-status.json",
      "access-control-allow-origin": "*",
    },
  });
}

/** HEAD answers with the signature headers and no body, which is what a cheap verifier wants. */
export async function HEAD() {
  const manifest = buildActionsManifest({ toolNames: TOOLS.map((t) => t.name) });
  const body = JSON.stringify(manifest, null, 2);
  const patch = signDiscovery(body, "/.well-known/actions.json");
  return new NextResponse(null, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...patch,
      [SIGNATURE_HEADER]: patch[SIGNATURE_HEADER] ?? "",
      [SIGNATURE_INPUT_HEADER]: patch[SIGNATURE_INPUT_HEADER] ?? "",
      [KEY_ID_HEADER]: patch[KEY_ID_HEADER] ?? "",
    },
  });
}
