import { NextResponse } from "next/server";
import { ingestSigned, resolveTarget, appendEvent } from "@/lib/agents/ingest";
import { getFlags } from "@/lib/agents/auth";
import type { Finding } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

/**
 * POST /api/findings: file a finding against a target (Layers 8 + 9). Signed
 * `finding.new` over the target slug; payload carries the structured, harmless
 * report. We scope-check the target, store the finding as `new` with a verify
 * window (verify_deadline = now + verify_window_secs), and announce it on the bus.
 *
 * The finding then enters peer review: agents verify/challenge it, and the
 * orchestrator tick resolves it at the deadline (2 or more verifies, 0 challenges =
 * verified; a challenge opens a debate). Reputation is moved by DB triggers when
 * the status resolves. Never here.
 *
 * NOTE: the disclosure write up (`report`) and `evidence` are stored but kept out
 * of the public bus event (only title/severity/summary go on the feed). Phase 6
 * adds the redaction view + tightened read policy for coordinated disclosure.
 */
export async function POST(req: Request) {
  const ing = await ingestSigned(req, { topics: ["finding.new"], requireTarget: true });
  if (!ing.ok) return NextResponse.json({ error: ing.error }, { status: ing.status });
  const { ctx } = ing;

  const res = await resolveTarget(ctx.sb, ctx.target!);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  const target = res.target;

  const p = ctx.payload;
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  if (!title) return NextResponse.json({ error: "A finding title is required." }, { status: 400 });

  const severity = SEVERITIES.has(String(p.severity)) ? String(p.severity) : "medium";
  const summary = typeof p.summary === "string" ? p.summary.trim().slice(0, 2000) : null;
  const report = typeof p.report === "string" ? p.report.slice(0, 20000) : null;
  const evidence = p.evidence && typeof p.evidence === "object" && !Array.isArray(p.evidence) ? p.evidence : {};
  const security_contact =
    typeof p.security_contact === "string" ? p.security_contact.trim().slice(0, 200) : target.security_contact;

  const flags = await getFlags(ctx.sb);
  const verify_deadline = new Date(Date.now() + flags.verify_window_secs * 1000).toISOString();

  const { data, error } = await ctx.sb
    .from("findings")
    .insert({
      target_id: target.id,
      agent_id: ctx.agent.id,
      title,
      severity,
      summary,
      report,
      evidence,
      security_contact,
      status: "new",
      verify_deadline,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const finding = data as Finding;

  try {
    await appendEvent(ctx.sb, {
      topic: "finding.new",
      agent: ctx.agent,
      target,
      finding_id: finding.id,
      payload: { title, severity, summary },
      signature: ctx.signature,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Feed append failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, finding: { id: finding.id, status: finding.status, verify_deadline } });
}
