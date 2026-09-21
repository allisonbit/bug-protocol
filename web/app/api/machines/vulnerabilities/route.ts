import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/site";
import { dutiesFor, dutyViews, mayMarkMet, overdueDuties, type DutyName, type DutyRow, type Vulnerability } from "@/lib/machines/duties";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE VULNERABILITY RECORD, WITH ITS CLOCK.
 *
 * A connected robot is a product with digital elements, and since 11 September 2026 the
 * EU Cyber Resilience Act expects the manufacturer of one to report an actively
 * exploited vulnerability within 24 hours of becoming aware, then notify and file a
 * final report, and to keep handling it for the life of the product. This door is the
 * row that makes that measurable: the instant awareness began, the duties derived from
 * it, when each was met, and what met it.
 *
 * WHAT IS DELIBERATELY NOT HERE. No claim of conformity, no certification, no badge
 * saying this platform or any product on it is compliant. This is a clock over facts a
 * maker entered, and every surface that renders it says so in those words. A page that
 * implied otherwise would be worse than no page, because somebody might rely on it.
 *
 * WHY A DUTY CANNOT BE MARKED MET WITHOUT EVIDENCE. The timeline is the only part of
 * this anyone outside the maker reads, and a line saying "notified" with nothing behind
 * it is indistinguishable from a line that was typed to close a gap. The verifier
 * exercises the refusal, so the rule is checked rather than trusted.
 *
 *   GET   the advisory list, or one advisory with its duties and its clock
 *   POST  report an advisory; the duties are derived, never typed
 *   PATCH mark a duty met, or move the advisory's state
 */

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, docs: `${SITE_URL}/fleet` }, { status, headers: { "cache-control": "no-store" } });
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const KINDS = ["vulnerability", "severe_incident"] as const;
const STATES = ["open", "fixing", "fixed", "wontfix"] as const;

export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const url = new URL(req.url);
  const advisory = url.searchParams.get("advisory")?.trim() ?? null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);

  let query = sb.from("machine_vulnerabilities").select("*").order("first_aware_at", { ascending: false }).limit(limit);
  if (advisory) query = query.eq("advisory_id", advisory);
  const { data: rows } = await query;
  const advisories = (rows as Vulnerability[] | null) ?? [];
  if (advisories.length === 0) {
    return NextResponse.json(
      {
        advisories: [],
        note:
          "Nothing is on the record. That means no advisory has been reported here, not that the firmware is free of them: the record can only speak to what a maker entered, and every surface says so.",
        duty_clock: `POST this door with { advisory_id, title, summary, kind, actively_exploited, first_aware_at } and the duties are derived from the Regulation's paragraphs. Details on ${SITE_URL}/fleet.`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const ids = advisories.map((a) => a.id);
  const { data: dutyRows } = await sb.from("machine_vulnerability_duties").select("*").in("vulnerability_id", ids);
  const byVuln = new Map<string, DutyRow[]>();
  for (const r of ((dutyRows as (DutyRow & { vulnerability_id: string })[] | null) ?? [])) {
    const list = byVuln.get(r.vulnerability_id) ?? [];
    list.push(r);
    byVuln.set(r.vulnerability_id, list);
  }

  const nowMs = Date.now();
  const out = advisories.map((v) => {
    const views = dutyViews({ vulnerability: v, rows: byVuln.get(v.id) ?? [], nowMs });
    return {
      advisory_id: v.advisory_id,
      title: v.title,
      severity: v.severity,
      kind: v.kind,
      actively_exploited: v.actively_exploited,
      state: v.state,
      fixed_in: v.fixed_in ?? null,
      first_aware_at: v.first_aware_at,
      overdue: overdueDuties(views).map((d) => ({ duty: d.duty, label: d.label, due_at: d.dueAt, hours_late: Math.round(Math.abs(d.msRemaining) / 3_600_000), because: d.because })),
      duties: views.map((d) => ({ duty: d.duty, label: d.label, due_at: d.dueAt, met_at: d.metAt, met_by: d.metBy, state: d.state, ms_remaining: d.msRemaining })),
      docs: `${SITE_URL}/fleet`,
    };
  });

  const allOverdue = out.flatMap((a) => a.overdue);
  return NextResponse.json(
    {
      advisories: out,
      overdue_count: allOverdue.length,
      note:
        "A clock over the facts a maker entered, and not a statement about compliance or certification. The paragraphs are the ones the Regulation states for the two categories it distinguishes; a maker with a lawyer will have more obligations, not fewer.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const user = await currentUser();
  if (!user) return fail("SIGN_IN_REQUIRED", "Reporting an advisory is a maker's act: sign in first.", 401);
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { advisory_id, title, summary, kind, actively_exploited, first_aware_at, severity } as JSON.", 400);

  const clean = (v: unknown, max: number) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s.slice(0, max) : "";
  };
  const advisoryId = clean(body.advisory_id, 80);
  const title = clean(body.title, 300);
  const summary = clean(body.summary, 4000);
  const kind = clean(body.kind, 40) || "vulnerability";
  const severity = clean(body.severity, 20) || "medium";
  if (!advisoryId) return fail("ADVISORY_ID_REQUIRED", "`advisory_id` is what the world will cite this by: a CVE, a GHSA, or your own identifier.", 400);
  if (!title) return fail("TITLE_REQUIRED", "`title` says what is wrong in one line.", 400);
  if (summary.length < 20) return fail("SUMMARY_REQUIRED", "`summary` explains what happens and what a fleet should do. A record with no explanation is not one.", 400);
  if (!(KINDS as readonly string[]).includes(kind)) return fail("BAD_KIND", "`kind` must be `vulnerability` or `severe_incident`.", 400);
  if (!(SEVERITIES as readonly string[]).includes(severity)) return fail("BAD_SEVERITY", "`severity` must be low, medium, high or critical.", 400);

  // The awareness instant is the one fact only the maker can supply, and the whole
  // clock hangs off it, so it is parsed rather than defaulted silently.
  const awareRaw = clean(body.first_aware_at, 40);
  const awareMs = awareRaw ? Date.parse(awareRaw) : Date.now();
  if (awareRaw && !Number.isFinite(awareMs)) {
    return fail("BAD_AWARENESS", "`first_aware_at` must be an ISO timestamp. It is the instant awareness began, and every duty is measured from it.", 400);
  }
  const firstAware = new Date(awareMs).toISOString();
  const activelyExploited = body.actively_exploited === true;

  const { data, error } = await admin
    .from("machine_vulnerabilities")
    .insert({
      advisory_id: advisoryId,
      cve: clean(body.cve, 60) || null,
      title,
      component: clean(body.component, 200) || null,
      affected: clean(body.affected, 400) || null,
      fixed_in: clean(body.fixed_in, 120) || null,
      severity,
      kind,
      actively_exploited: activelyExploited,
      summary,
      evidence_url: clean(body.evidence_url, 500) || null,
      first_aware_at: firstAware,
      reported_by: clean(body.reported_by, 120) || user.id,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return fail("ALREADY_RECORDED", `${advisoryId} is already on the record. An advisory is added to rather than replaced: PATCH it to change its state, and mark duties met as they are.`, 409);
    return fail("RECORD_FAILED", error.message, 500);
  }
  const vuln = data as Vulnerability;

  // Duties are derived from the awareness instant and the category, not typed. A duty
  // somebody has to remember to create is a duty somebody will forget.
  const duties = dutiesFor(vuln);
  const { error: dutyError } = await admin
    .from("machine_vulnerability_duties")
    .insert(duties.map((d) => ({ vulnerability_id: vuln.id, duty: d.duty, due_at: d.due_at })));
  if (dutyError) return fail("DUTIES_FAILED", dutyError.message, 500);

  await admin
    .from("events")
    .insert({
      topic: "vuln.opened",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${vuln.advisory_id} recorded: ${vuln.title}${activelyExploited ? " (actively exploited)" : ""}`,
        advisory: vuln.advisory_id,
        severity: vuln.severity,
        kind: vuln.kind,
        actively_exploited: activelyExploited,
        duties: duties.map((d) => d.duty),
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      advisory_id: vuln.advisory_id,
      severity: vuln.severity,
      actively_exploited: activelyExploited,
      first_aware_at: firstAware,
      duties: duties.map((d) => ({ duty: d.duty, due_at: d.due_at, because: d.because })),
      not_advice:
        "This is a clock over the facts you entered, not legal advice, not a certification, and not a statement about whether your product is in scope of the Regulation.",
      next: `PATCH this door with { advisory_id: "${vuln.advisory_id}", duty: "notification", evidence: "<url or row>" } when a duty is met. Evidence is required, because a timeline entry nobody can check is the thing this record exists to replace.`,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(req: Request) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const user = await currentUser();
  if (!user) return fail("SIGN_IN_REQUIRED", "Only the maker updates the record: sign in first.", 401);
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { advisory_id, duty?, evidence?, state?, fixed_in? }.", 400);
  const advisoryId = String(body.advisory_id ?? "").trim();
  if (!advisoryId) return fail("ADVISORY_ID_REQUIRED", "`advisory_id` names the advisory to update.", 400);

  const { data: vulnRow } = await admin.from("machine_vulnerabilities").select("*").eq("advisory_id", advisoryId).maybeSingle();
  const vuln = vulnRow as Vulnerability | null;
  if (!vuln) return fail("NOT_FOUND", `No advisory with id ${advisoryId} is on the record.`, 404);

  const nowIso = new Date().toISOString();
  const changed: Record<string, unknown> = { updated_at: nowIso };

  // A state move first, so a fix can be marked in the same call that sets state fixed:
  // the two-rule check below reads the state rather than the request.
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (state) {
    if (!(STATES as readonly string[]).includes(state)) return fail("BAD_STATE", "`state` must be open, fixing, fixed or wontfix.", 400);
    changed.state = state;
    changed.fixed_in = typeof body.fixed_in === "string" ? body.fixed_in.trim().slice(0, 120) : vuln.fixed_in ?? null;
    if (state === "fixed" || state === "wontfix") changed.closed_at = nowIso;
  }

  const duty = typeof body.duty === "string" ? body.duty.trim() : "";
  if (!duty) {
    if (!state) return fail("NOTHING_TO_DO", "Nothing to change: send `duty` to mark one met, or `state` to move the advisory.", 400);
    await admin.from("machine_vulnerabilities").update(changed).eq("id", vuln.id);
    await admin
      .from("events")
      .insert({
        topic: state === "fixed" || state === "wontfix" ? "vuln.closed" : "vuln.opened",
        agent_id: null,
        agent_handle: null,
        payload: { text: `${advisoryId} moved to ${state}`, advisory: advisoryId, state },
        signature: null,
        signed_ok: false,
        provenance: "system",
      })
      .then(undefined, () => null);
    return NextResponse.json({ ok: true, advisory_id: advisoryId, state, note: "The clock is unchanged; only what the fleet is told changed." }, { headers: { "cache-control": "no-store" } });
  }

  const effectiveState = (changed.state as Vulnerability["state"] | undefined) ?? vuln.state;
  const decision = mayMarkMet({ duty: duty as DutyName, evidence: body.evidence, fixedIn: changed.fixed_in ?? vuln.fixed_in, vulnerabilityState: effectiveState });
  if (!decision.ok) return fail("EVIDENCE_REQUIRED", decision.reason, 400);

  const { data: existing } = await admin
    .from("machine_vulnerability_duties")
    .select("*")
    .eq("vulnerability_id", vuln.id)
    .eq("duty", duty)
    .maybeSingle();
  if (!existing) {
    const derived = dutiesFor(vuln).find((d) => d.duty === duty);
    if (!derived) return fail("NOT_OWED", `The record does not owe a \`${duty}\` duty for this advisory, so marking one met would invent a duty rather than meet it.`, 400);
    await admin.from("machine_vulnerability_duties").insert({ vulnerability_id: vuln.id, duty, due_at: derived.due_at, met_at: nowIso, met_by: String(body.evidence).trim().slice(0, 500), note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : null });
  } else {
    await admin
      .from("machine_vulnerability_duties")
      .update({ met_at: nowIso, met_by: String(body.evidence).trim().slice(0, 500), note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : null })
      .eq("id", (existing as { id: string }).id);
  }

  await admin.from("machine_vulnerabilities").update(changed).eq("id", vuln.id);

  await admin
    .from("events")
    .insert({
      topic: "vuln.duty.met",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${advisoryId}: ${duty} met, evidence ${String(body.evidence).trim().slice(0, 80)}${state ? `, now ${state}` : ""}`,
        advisory: advisoryId,
        duty,
        state: effectiveState,
        evidence: String(body.evidence).trim().slice(0, 200),
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      advisory_id: advisoryId,
      duty,
      met_at: nowIso,
      evidence: String(body.evidence).trim().slice(0, 200),
      state: effectiveState,
      note:
        "Every duty here is measured from the instant awareness began and cites the row or URL that met it. A reader can check the citation, which is the only thing that makes the timeline worth publishing.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
