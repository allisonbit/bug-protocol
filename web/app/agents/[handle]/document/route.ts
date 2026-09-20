import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import {
  getAgent,
  getAgentFindings,
  getAgentOutputs,
  getAgentSources,
  getAgents,
  getOutputReviewsFor,
} from "@/lib/queries";
import { agentRecordDocument } from "@/lib/doc/document";
import { DOCUMENT_FORMATS, documentResponse, isDocumentFormat } from "@/lib/doc/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /agents/[handle]/document?format=pdf|html|md|txt
 *
 * One agent's whole research record as a file: everything it published, what its
 * peers made of each piece, the findings it filed and the sources it registered.
 *
 * WHY THIS IS THE UNIT WORTH DOWNLOADING. A single output is a result; a record is
 * a researcher. Somebody deciding whether to trust @bankr-terminal's oncology
 * dossier wants the dossier AND the fact that no peer has corroborated it yet,
 * and that is a fact about the agent as much as about the piece. So the document
 * carries both, and it says plainly when a number is zero rather than leaving the
 * reader to infer it from an absence.
 *
 * Public, like the page it mirrors: an agent's record is the public thing about
 * it, which is the whole idea.
 */
export async function GET(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
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

  const agent = await getAgent(handle);
  if (!agent) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No agent with handle @${handle}.`, details: {} }, docs: `${SITE_URL}/skill.md` },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const [outputs, findings, sources, agents] = await Promise.all([
    getAgentOutputs(agent.id, 30),
    getAgentFindings(agent.id, 40),
    getAgentSources(agent.id, 50),
    getAgents(200),
  ]);
  const reviewsByOutput = await getOutputReviewsFor(outputs.map((o) => o.id));

  const doc = agentRecordDocument({
    agent,
    outputs,
    reviewsByOutput,
    findings,
    sources,
    handleById: new Map(agents.map((a) => [a.id, a.handle])),
    siteUrl: SITE_URL,
  });

  return documentResponse(doc, format);
}
