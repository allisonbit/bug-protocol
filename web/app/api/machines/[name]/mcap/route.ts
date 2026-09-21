import { NextResponse } from "next/server";
import type { Machine, MachineReading } from "@/lib/agents/types";
import { SITE_URL } from "@/lib/site";
import { buildMachineMcap, mcapDigestHex, mcapFilename, MCAP_MAX_MESSAGES } from "@/lib/machines/mcap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A MACHINE'S HISTORY AS A LOG FILE ANY ROBOTICS TOOL CAN OPEN.
 *
 *   GET /api/machines/<name>/mcap           the file itself
 *   GET /api/machines/<name>/mcap?meta=1    what the file would hold, as JSON
 *
 * The rows are already public on the machine's page. This door exists because a page is not a
 * container: a fleet operator, a failure review, or an agent doing postmortem analysis wants
 * one file with timestamps, channels and an index, not a scrape of someone's HTML. MCAP is
 * that file in the robotics world, so the bytes here are the standard container rather than a
 * shape invented for this site.
 *
 * THE DIGEST IS OF THE BYTES, NOT THE ROWS. Two requests a minute apart produce different
 * files, because more readings arrived, and both are correct: the header says which bytes
 * this response carried. That is what makes a saved file provable later instead of merely
 * plausible.
 *
 * A machine with no readings still gets a valid, empty, indexed file rather than an error,
 * because "this device has reported nothing yet" is a true and useful thing to download.
 *
 * No credential, like every other read here. A retired machine keeps its log, because an
 * append-only record does not become unreadable when the hardware does.
 */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await ctx.params;
  const name = decodeURIComponent(rawName).trim().toLowerCase();
  const url = new URL(req.url);
  const wantsMeta = ["1", "true", "yes"].includes((url.searchParams.get("meta") ?? "").toLowerCase());

  // Bounded, like every other read: a log export is a window on the record, not a mirror of it.
  const limitRaw = Number(url.searchParams.get("limit") ?? 2000);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MCAP_MAX_MESSAGES) : 2000;

  const { supabaseServer } = await import("@/lib/supabase/server");
  const sb = await supabaseServer();
  if (!sb) {
    return NextResponse.json(
      { error: { code: "NO_DATABASE", message: "This deployment has no database configured, so it holds no machine logs." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const { data: machineRow, error: machineError } = await sb
    .from("machines")
    .select("*")
    .eq("name", name)
    .maybeSingle();

  if (machineError) {
    return NextResponse.json(
      { error: { code: "READ_FAILED", message: machineError.message } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
  const machine = machineRow as Machine | null;
  if (!machine) {
    return NextResponse.json(
      {
        error: { code: "NOT_FOUND", message: `No machine called ${name} is registered here.` },
        machines: `${SITE_URL}/machines`,
        register: `${SITE_URL}/machines/guide`,
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const { data: readingRows, error: readingError } = await sb
    .from("machine_readings")
    .select("id, machine_id, machine_name, kind, metric, value, unit, state, message, payload, created_at")
    .eq("machine_id", machine.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (readingError) {
    return NextResponse.json(
      { error: { code: "READ_FAILED", message: readingError.message } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const readings = (readingRows as MachineReading[] | null) ?? [];
  const built = await buildMachineMcap({ machine, readings, origin: SITE_URL });
  const digest = mcapDigestHex(built.bytes);
  const filename = mcapFilename(machine.name);

  if (wantsMeta) {
    return NextResponse.json(
      {
        machine: machine.name,
        kind: machine.kind,
        messages: built.messages,
        rows_offered: readings.length,
        skipped_rows_without_a_timestamp: built.skipped,
        channels: built.channels,
        span: built.span,
        bytes: built.bytes.byteLength,
        sha256: digest,
        filename,
        file: `${SITE_URL}/api/machines/${encodeURIComponent(machine.name)}/mcap`,
        schema: "swampai.MachineReading",
        container: "MCAP",
        note: "The digest is of the bytes this response would serve. It changes as the machine reports, so a saved file is proved against the header it arrived with rather than against this page.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return new NextResponse(built.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      // The media type this format is served under in practice, since none is registered.
      "content-type": "application/mcap",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(built.bytes.byteLength),
      "cache-control": "no-store",
      "x-mcap-sha256": digest,
      "x-mcap-messages": String(built.messages),
      "x-mcap-skipped": String(built.skipped),
      "x-mcap-schema": "swampai.MachineReading",
      "x-mcap-profile": "swampai.machine",
      "x-machine": machine.name,
      ...(built.span ? { "x-mcap-span-from": built.span.from, "x-mcap-span-to": built.span.to } : {}),
      "access-control-allow-origin": "*",
      "access-control-expose-headers":
        "x-mcap-sha256, x-mcap-messages, x-mcap-skipped, x-mcap-schema, x-mcap-profile, x-mcap-span-from, x-mcap-span-to, x-machine",
    },
  });
}
