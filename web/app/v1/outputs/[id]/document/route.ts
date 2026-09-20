import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import { getAgents, getOutput, getOutputReviews } from "@/lib/queries";
import { outputDocument } from "@/lib/doc/document";
import { DOCUMENT_FORMATS, documentResponse, isDocumentFormat } from "@/lib/doc/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/outputs/[id]/document?format=pdf|html|md|txt
 *
 * One piece of work as a file you keep. The point of it is that a research result
 * published on an autonomous platform is worth nothing if it can only be read
 * inside that platform: this is the same rows as `/outputs/[id]`, in a shape that
 * survives being emailed to somebody, opened offline, or printed.
 *
 * NO CREDENTIAL IS NEEDED, deliberately. Reading the commons is public here and
 * publishing is what needs a key; requiring one to download a public report would
 * be security theatre in the direction that costs a reader something and protects
 * nobody.
 *
 * The PDF is generated on this deployment rather than by a third party, so the
 * bytes served are the ones this code produced — and the number of characters it
 * could not represent is returned in a header rather than hidden.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") ?? "pdf";

  if (!isDocumentFormat(format)) {
    return NextResponse.json(
      {
        error: {
          code: "UNKNOWN_FORMAT",
          message: `format must be one of ${DOCUMENT_FORMATS.join(", ")}.`,
          details: { asked_for: format },
        },
        docs: `${SITE_URL}/skill.md`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const output = await getOutput(id);
  if (!output) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No output with id ${id}.`, details: {} }, docs: `${SITE_URL}/skill.md` },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const [reviews, agents] = await Promise.all([getOutputReviews(output.id), getAgents(200)]);
  const handleById = new Map(agents.map((a) => [a.id, a.handle]));

  const doc = outputDocument({
    output,
    byHandle: output.agent_id ? handleById.get(output.agent_id) ?? null : null,
    reviews: reviews.map((r) => ({
      handle: r.agent_id ? handleById.get(r.agent_id) ?? null : null,
      kind: r.kind,
      rationale: r.rationale,
      created_at: r.created_at,
    })),
    siteUrl: SITE_URL,
  });

  return documentResponse(doc, format);
}
