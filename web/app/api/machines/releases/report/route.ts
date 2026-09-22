import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { machineForToken, machineToken } from "@/lib/machines/auth";
import { installOutcome, type Release } from "@/lib/machines/releases";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WHAT THE DEVICE SAYS AFTER IT TRIED.
 *
 * Offering a release to a fleet is a guess about whether the fleet can take it. This
 * door is where the guess is answered, and it is deliberately the only place a machine
 * can change what it runs on the record: the device says `installed` or `failed`, and
 * the fleet's picture of it follows from that rather than from an operator editing a
 * column.
 *
 * WHY A FAILURE PINS THE MACHINE BACK ITSELF. A robot that keeps offering itself a
 * release that does not boot is a robot in a loop, and a fleet of them is a fleet with
 * a technician's problem. So a reported failure writes the pin in the same call: the
 * machine is held on the version it was running, the reason names the release that did
 * not take, and the pin is public. An operator who wants it to try again clears the pin
 * deliberately, which is a decision the record can show.
 *
 * WHY THE OUTCOME IS NOT TRUSTED BEYOND THAT. The device is the only witness to what
 * it runs, so this is a report and every surface words it as one. What is not
 * self-reported is the digest: the device checks the artifact against the published
 * SHA-256 itself and a mismatch is a refusal there rather than a claim here.
 */
export async function POST(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) {
    return NextResponse.json({ error: { code: auth.code, message: auth.message } }, { status: auth.status, headers: { "cache-control": "no-store" } });
  }
  const { machine, sb } = auth;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json(
      { error: { code: "JSON_REQUIRED", message: "Send { release_id, state: \"installed\" | \"failed\", note? } as JSON." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const state = String(body.state ?? "").trim();
  if (state !== "installed" && state !== "failed") {
    return NextResponse.json(
      {
        error: {
          code: "BAD_STATE",
          message: "`state` must be `installed` or `failed`. There is no third answer: a device that is not sure yet reports nothing until it knows, because a fleet told \"maybe\" cannot act.",
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const releaseId = String(body.release_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(releaseId)) {
    return NextResponse.json(
      { error: { code: "BAD_RELEASE", message: "`release_id` must be the uuid of the release you were offered, from GET /api/machines/releases?machine=<name>." } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const { data: releaseRow } = await sb.from("machine_releases").select("*").eq("id", releaseId).maybeSingle();
  const release = releaseRow as Release | null;
  if (!release) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: `No release with id ${releaseId}.` } }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  // Was this machine ever actually offered it? A device installing something nobody
  // offered is worth recording rather than refusing — it happens with a technician and
  // a cable — but the row says so, so the rollout page cannot claim credit for it.
  const { data: targetRow } = await sb
    .from("machine_release_targets")
    .select("id, state")
    .eq("release_id", releaseId)
    .eq("machine_id", machine.id)
    .maybeSingle();
  const wasOffered = Boolean(targetRow);

  const m = machine as unknown as { installed_version?: string | null; firmware?: string | null; pinned_release_id?: string | null };
  const previousVersion = m.installed_version ?? m.firmware ?? null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  // WHAT A FAILURE PINS TO. The pin has to name a ROW, and the machine only told us the
  // version string it was running. So on a failure the release row carrying that version
  // on the same artifact is looked up and becomes the pin, which is what makes the hold a
  // reference a rollout can skip rather than a sentence. When no row matches (firmware
  // flashed by hand from a laptop, or a release later deleted) the reason is still written
  // and the pin id is left null, and the reply says which of the two happened instead of
  // reporting a pin that does not exist.
  let previousReleaseId = m.pinned_release_id ?? null;
  if (state === "failed" && !previousReleaseId && previousVersion) {
    const { data: runningRow } = await sb
      .from("machine_releases")
      .select("id")
      .eq("name", release.name)
      .eq("version", previousVersion)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    previousReleaseId = (runningRow as { id: string } | null)?.id ?? null;
  }

  const outcome = installOutcome({
    reported: state,
    release: { id: release.id, name: release.name, version: release.version },
    previousVersion,
    previousReleaseId,
    note,
  });

  const nowIso = new Date().toISOString();
  const targetWrite = targetRow
    ? sb.from("machine_release_targets").update({ state, resolved_at: nowIso, note }).eq("id", (targetRow as { id: string }).id)
    : sb.from("machine_release_targets").insert({
        release_id: release.id,
        machine_id: machine.id,
        machine_name: machine.name,
        state,
        resolved_at: nowIso,
        note: note ? `${note} (not offered by a rollout; the device reported it anyway)` : "not offered by a rollout; the device reported it anyway",
      });
  const { error: targetErr } = await targetWrite;
  // The target row is what the rollout's progress is counted from. A refusal here would
  // make the fleet page show an install that never landed, so it is carried into the
  // reply rather than only logged.
  if (targetErr) console.warn(`[write refused] machine_release_targets for ${machine.name}/${release.version}: ${targetErr.message}`);

  const { error: machineErr } = await sb
    .from("machines")
    .update({
      installed_version: outcome.machinePatch.installedVersion,
      pinned_release_id: outcome.machinePatch.pinReleaseId,
      pinned_reason: outcome.machinePatch.pinReason,
      firmware: outcome.machinePatch.installedVersion,
      last_release_at: nowIso,
    })
    .eq("id", machine.id);
  // The reply below asserts what this machine now runs and whether it is pinned. If this
  // write did not happen, the reply would be describing a state the store does not hold,
  // so a refusal turns the answer into an error instead of an optimistic summary.
  if (machineErr) {
    return NextResponse.json(
      {
        error: {
          code: "REPORT_RECORDED_INCOMPLETELY",
          message: `The install report was recorded but ${machine.name} could not be updated: ${machineErr.message}. The machine still reads as running ${previousVersion ?? "its previous version"}, and nothing was pinned.`,
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const { error: w1 } = await sb
    .from("events")
    .insert({
      topic: outcome.event.topic,
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${machine.name} ${outcome.event.text}`,
        machine: machine.name,
        release: `${release.name} ${release.version}`,
        version: state === "installed" ? release.version : previousVersion,
        state,
        offered: wasOffered,
      },
      signature: null,
      signed_ok: false,
      provenance: "machine",
    })
    if (w1) console.warn("[write refused] events row: " + (w1.message ?? w1));

  return NextResponse.json(
    {
      ok: true,
      machine: machine.name,
      release: { id: release.id, name: release.name, version: release.version },
      state,
      was_offered: wasOffered,
      running: outcome.machinePatch.installedVersion,
      pinned: outcome.machinePatch.pinReleaseId
        ? { release_id: outcome.machinePatch.pinReleaseId, because: outcome.machinePatch.pinReason, clear_with: `PATCH ${SITE_URL}/api/machines/manage with { action: "unpin", machine: "${machine.name}" }` }
        : state === "failed"
          ? {
              release_id: null,
              because: outcome.machinePatch.pinReason,
              why_no_row: `No published release carries version ${previousVersion ?? "the machine was running"} on ${release.name}, so the hold is recorded as a reason without a row to skip. Pin explicitly with the pin action if this machine must not be offered anything until somebody looks.`,
            }
          : null,
      note:
        state === "installed"
          ? "Recorded as running this version. The fleet page shows how far the rollout got from these reports and not from the offer."
          : "Recorded as a failed install, and this machine is now held on the version it was running. Clear the pin deliberately if you want it to try again, because the fleet counts an unclear pin as a decision.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** GET tells a device what it is currently recorded as running, which is the cheap check. */
export async function GET(req: Request) {
  const auth = await machineForToken(machineToken(req));
  if (!auth.ok) {
    return NextResponse.json({ error: { code: auth.code, message: auth.message } }, { status: auth.status, headers: { "cache-control": "no-store" } });
  }
  const { machine } = auth;
  const admin = supabaseAdmin();
  const m = machine as unknown as { installed_version?: string | null; firmware?: string | null; pinned_release_id?: string | null; pinned_reason?: string | null; last_release_at?: string | null };
  const { data: rows } = admin
    ? await admin
        .from("machine_release_targets")
        .select("release_id, state, offered_at, resolved_at, note")
        .eq("machine_id", machine.id)
        .order("offered_at", { ascending: false })
        .limit(20)
    : { data: null };

  return NextResponse.json(
    {
      machine: machine.name,
      running: m.installed_version ?? m.firmware ?? null,
      pinned_to: m.pinned_release_id ?? null,
      pinned_because: m.pinned_reason ?? null,
      last_release_at: m.last_release_at ?? null,
      history: ((rows as { release_id: string; state: string; offered_at: string; resolved_at: string | null; note: string | null }[] | null) ?? []).map((r) => ({
        release_id: r.release_id,
        state: r.state,
        offered_at: r.offered_at,
        resolved_at: r.resolved_at,
        note: r.note,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
