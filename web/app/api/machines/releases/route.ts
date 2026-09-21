import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { currentUser } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/site";
import { isChannel, offeredRelease, publishDecision, releaseSummary, rolloutTargets, type Channel, type Release } from "@/lib/machines/releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE FIRMWARE DOOR.
 *
 *   GET    published releases, and what one machine is offered from them (public)
 *   POST   publish a release (a signed-in maker; the SBOM is required)
 *   PATCH  stage a rollout: a release, a percentage, and named canaries (signed-in)
 *
 * WHY THE FLEET DOES NOT SERVE THE ARTIFACT. A firmware image is megabytes and belongs
 * on a CDN or a bucket the maker controls, so what this door publishes is the ROW: the
 * URL, the SHA-256, the notes, and the bill of materials. The device fetches the image
 * from wherever the maker put it and checks the digest itself, which is the only check
 * that survives a compromised download path and the reason the digest is mandatory
 * here rather than a nicety.
 *
 * WHY A ROLLOUT IS A ROW PER MACHINE RATHER THAN A FLAG. Offered is not installed. The
 * target rows are what let the page say "forty robots were offered this and three
 * reported it", which is the difference between a rollout and a hope.
 */

function fail(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, details: details ?? {} }, docs: `${SITE_URL}/fleet` },
    { status, headers: { "cache-control": "no-store" } },
  );
}

// ---- GET: the catalogue, or one machine's offer ------------------------------

export async function GET(req: Request) {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const url = new URL(req.url);
  const machineName = url.searchParams.get("machine")?.trim().toLowerCase() ?? null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);

  const { data: releaseRows } = await sb
    .from("machine_releases")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  const releases = (releaseRows as Release[] | null) ?? [];

  // What one machine is offered. This is the call a device makes before it flashes
  // anything, so the answer has to be complete enough to act on without a second
  // request: the artifact URL, the digest it will check, and the pin it is under.
  if (machineName) {
    const { data: machineRow } = await sb.from("machines").select("*").eq("name", machineName).maybeSingle();
    const machine = machineRow as { id: string; name: string; kind: string; hardware?: string | null; firmware: string | null; pinned_release_id: string | null; pinned_reason: string | null; installed_version: string | null } | null;
    if (!machine) return fail("NOT_FOUND", `No machine named "${machineName}" is registered.`, 404);

    const asked = url.searchParams.get("channel");
    const channel: Channel = isChannel(asked) ? asked : "stable";
    const offered = offeredRelease({
      releases: releases.filter((r) => r.name === (url.searchParams.get("name") ?? r.name)),
      channel,
      hardware: url.searchParams.get("hardware") ?? machine.hardware ?? null,
      pinnedReleaseId: machine.pinned_release_id,
      currentVersion: machine.installed_version ?? machine.firmware,
    });

    const { data: targetRows } = await sb
      .from("machine_release_targets")
      .select("release_id, state, offered_at, resolved_at")
      .eq("machine_id", machine.id)
      .order("offered_at", { ascending: false })
      .limit(20);

    return NextResponse.json(
      {
        machine: machine.name,
        channel,
        installed_version: machine.installed_version ?? machine.firmware,
        pinned: machine.pinned_release_id ? { release_id: machine.pinned_release_id, because: machine.pinned_reason } : null,
        offered: offered.release
          ? {
              id: offered.release.id,
              name: offered.release.name,
              version: offered.release.version,
              channel: offered.release.channel,
              artifact_url: offered.release.artifact_url,
              sha256: offered.release.sha256,
              bytes: offered.release.bytes,
              notes: offered.release.notes,
              published_at: offered.release.created_at,
            }
          : null,
        because: offered.because,
        targets: ((targetRows as { release_id: string; state: string; offered_at: string; resolved_at: string | null }[] | null) ?? []).map((t) => ({
          release_id: t.release_id,
          state: t.state,
          offered_at: t.offered_at,
          resolved_at: t.resolved_at,
        })),
        verify:
          "The digest is the check you make yourself, before flashing anything. A mismatch is a refusal, not a warning: re-download from the artifact URL, and if it still does not match, report it as failed rather than installing it.",
        report: `POST ${SITE_URL}/api/machines/releases/report with X-Machine-Token and { release_id, state: \"installed\" | \"failed\", note? } once you know what happened. A failure that is not reported leaves the fleet guessing.`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Retired machines are left out of the offer picture, exactly as the roster leaves them
  // out: a machine its owner has taken out of service is not "behind" on anything, and
  // listing it that way would turn a decision into a defect. The rows themselves stay.
  const { data: machineRows } = await sb
    .from("machines")
    .select("name, kind, hardware, firmware, installed_version, pinned_release_id, pinned_reason, last_report_at")
    .neq("status", "retired")
    .order("name", { ascending: true })
    .limit(500);

  // Behind counts, computed from the rows rather than asked of a device: the page and
  // the JSON say the same thing because they read the same list.
  const machines = (machineRows as { name: string; kind: string; hardware: string | null; firmware: string | null; installed_version: string | null; pinned_release_id: string | null; pinned_reason: string | null; last_report_at: string | null }[] | null) ?? [];
  const newestByArtifact = new Map<string, Release>();
  for (const r of releases) if (!r.yanked_at && !newestByArtifact.has(r.name)) newestByArtifact.set(r.name, r);

  return NextResponse.json(
    {
      releases: releases.map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        channel: r.channel,
        hardware: r.hardware,
        artifact_url: r.artifact_url,
        sha256: r.sha256,
        bytes: r.bytes,
        notes: r.notes,
        sbom: r.sbom,
        signature: r.signature,
        publisher_kid: r.publisher_kid,
        yanked_at: r.yanked_at,
        yanked_reason: r.yanked_reason,
        published_at: r.created_at,
      })),
      newest: [...newestByArtifact.values()].map((r) => releaseSummary(r)),
      machines: machines.map((m) => ({
        name: m.name,
        kind: m.kind,
        runs: m.installed_version ?? m.firmware,
        pinned_to: m.pinned_release_id,
        pinned_because: m.pinned_reason,
        last_report_at: m.last_report_at,
        hardware: m.hardware,
        behind: (() => {
          const newest = [...newestByArtifact.values()].find((r) => r.hardware === null || r.hardware === m.hardware);
          if (!newest) return null;
          const running = m.installed_version ?? m.firmware;
          return running === newest.version ? null : { release: newest.name, version: newest.version, runs: running };
        })(),
      })),
      note:
        "Published firmware, with the digest a device checks for itself and the bill of materials it was published with. This platform serves the record and not the image: the device fetches the artifact from the maker's own URL and refuses a mismatch on its own.",
      docs: `${SITE_URL}/fleet`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

// ---- POST: publish -----------------------------------------------------------

export async function POST(req: Request) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const user = await currentUser();
  if (!user) return fail("SIGN_IN_REQUIRED", "Publishing firmware is a maker's act: sign in first.", 401, { login: `${SITE_URL}/login` });
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send the release as JSON: name, version, channel, artifact_url, sha256 and an sbom.", 400);

  const decision = publishDecision({
    release: {
      name: body.name,
      version: body.version,
      channel: body.channel,
      artifact_url: body.artifact_url,
      sha256: body.sha256,
    },
    sbom: body.sbom,
  });
  if (!decision.ok) return fail("REFUSED", decision.reason, 400);

  const clean = (v: unknown, max: number) => {
    const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  const bytes = Number(body.bytes);
  const sbom = body.sbom as Record<string, unknown>;
  const componentCount = Array.isArray(sbom.components) ? sbom.components.length : Array.isArray(sbom.packages) ? sbom.packages.length : 0;

  const { data, error } = await admin
    .from("machine_releases")
    .insert({
      name: String(body.name).trim().toLowerCase(),
      version: String(body.version).trim(),
      channel: String(body.channel).trim().toLowerCase(),
      hardware: clean(body.hardware, 120),
      artifact_url: String(body.artifact_url).trim(),
      sha256: String(body.sha256).trim().toLowerCase(),
      bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null,
      notes: clean(body.notes, 2000),
      sbom: body.sbom,
      signature: clean(body.signature, 200),
      publisher_kid: clean(body.publisher_kid, 40),
      published_by: user.id,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      return fail("ALREADY_PUBLISHED", `That version is already published on that channel. A release is immutable: publish a new version instead, because a device that already took the old bytes must stay able to say which ones they were.`, 409);
    }
    return fail("PUBLISH_FAILED", error.message, 500);
  }
  const release = data as Release;

  await admin
    .from("events")
    .insert({
      topic: "machine.release.published",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `${release.name} ${release.version} published on ${release.channel}, sha256 ${release.sha256.slice(0, 12)}, ${componentCount} component(s) in the bill of materials`,
        release: `${release.name} ${release.version}`,
        name: release.name,
        version: release.version,
        channel: release.channel,
        sha256: release.sha256,
        components: componentCount,
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      release: {
        id: release.id,
        name: release.name,
        version: release.version,
        channel: release.channel,
        sha256: release.sha256,
        artifact_url: release.artifact_url,
      },
      sbom: { components: componentCount },
      next:
        "Nothing is offered to any machine until you stage a rollout: PATCH this door with { action: \"rollout\", release_id, percent, canary? }. A release nobody was offered is a release on a shelf, and the fleet page says so.",
      rollback:
        "To hold a machine back, the device reports a failed install and it is pinned automatically to the version it was running. An operator can also pin deliberately, which the fleet page renders as a decision rather than neglect.",
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

// ---- PATCH: rollout ----------------------------------------------------------

export async function PATCH(req: Request) {
  if (!SUPABASE_CONFIGURED) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);
  const user = await currentUser();
  if (!user) return fail("SIGN_IN_REQUIRED", "Staging a rollout is an owner's act: sign in first.", 401, { login: `${SITE_URL}/login` });
  const admin = supabaseAdmin();
  if (!admin) return fail("BACKEND_UNCONFIGURED", "The swamp backend isn't configured on this deployment yet.", 503);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("JSON_REQUIRED", "Send { action: \"rollout\", release_id, percent, canary? }.", 400);
  if (String(body.action ?? "") !== "rollout") return fail("BAD_ACTION", "The only action here is `rollout`. Yanking a release is PATCH /api/machines/manage.", 400);

  const releaseId = String(body.release_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(releaseId)) return fail("BAD_RELEASE", "`release_id` must be the uuid returned when the release was published.", 400);

  const { data: releaseRow } = await admin.from("machine_releases").select("*").eq("id", releaseId).maybeSingle();
  const release = releaseRow as Release | null;
  if (!release) return fail("NOT_FOUND", `No release with id ${releaseId}.`, 404);
  if (release.yanked_at) return fail("YANKED", `${release.name} ${release.version} was yanked${release.yanked_reason ? ` (${release.yanked_reason})` : ""}, so it is not offered to anything.`, 409);

  const { data: machineRows } = await admin.from("machines").select("id, name, pinned_release_id, status").eq("status", "active").limit(500);
  const machines = ((machineRows as { id: string; name: string; pinned_release_id: string | null }[] | null) ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    pinnedReleaseId: m.pinned_release_id,
  }));

  const plan = rolloutTargets({
    machines,
    release: { id: release.id },
    percent: Number(body.percent ?? 0),
    canary: Array.isArray(body.canary) ? (body.canary as unknown[]).map((c) => String(c)) : [],
  });
  if (plan.targets.length === 0) {
    return fail(
      "NOTHING_TO_OFFER",
      machines.length === 0
        ? "No active machines are registered, so there is nothing to offer this release to. The release stays published and unoffered, which the fleet page shows."
        : "Every active machine is pinned to another release, so this rollout would reach none of them. A pin is a decision: unpin deliberately rather than around it.",
      409,
    );
  }

  const { error } = await admin
    .from("machine_release_targets")
    .upsert(
      plan.targets.map((t) => ({ release_id: release.id, machine_id: t.id, machine_name: t.name, state: "offered" })),
      { onConflict: "release_id,machine_id", ignoreDuplicates: true },
    );
  if (error) return fail("ROLLOUT_FAILED", error.message, 500);

  await admin
    .from("events")
    .insert({
      topic: "machine.release.offered",
      agent_id: null,
      agent_handle: null,
      payload: {
        text: `offered ${release.name} ${release.version} to ${plan.targets.length} machine(s)${plan.skipped.length > 0 ? `, skipping ${plan.skipped.length} pinned` : ""}`,
        release: `${release.name} ${release.version}`,
        count: plan.targets.length,
        machines: plan.targets.map((t) => t.name).slice(0, 20),
        percent: Number(body.percent ?? 0),
      },
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(undefined, () => null);

  return NextResponse.json(
    {
      ok: true,
      release: { id: release.id, name: release.name, version: release.version },
      offered_to: plan.targets.map((t) => t.name),
      skipped: plan.skipped,
      note:
        "Offered is not installed. Each device finds out on its next report from GET /api/machines/releases?machine=<name> and reports back what actually happened, so the page can say how far a rollout really got.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
