import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { STALE_AFTER_MS, VDA_VERSION } from "@/lib/machines/fleet/vda5050";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/fleet.json: how a fleet manager coordinates the machines here.
 *
 * WHY THIS DOCUMENT. A VDA 5050 master control or an Open-RMF fleet adapter arrives
 * knowing nothing about this deployment. It needs to be told, without reading a page,
 * which robot is which, where the state message is served, where an order goes, what
 * the reliability window is, and which of its own conventions this speaks. That is one
 * document, and it is the difference between a fleet that can adopt these machines and
 * an operator copying and pasting URLs into an adapter config.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not claim certified conformance, it does not
 * invent a broker it is not running, and it does not promise any safety property. The
 * bridge serves the language over HTTP; a deployment that also runs an MQTT broker says
 * so on its own row rather than here claiming one exists.
 */
export async function GET() {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const { data } = await sb
    .from("machines")
    .select("name, kind, hardware, status, last_report_at")
    .order("name", { ascending: true })
    .limit(500);
  const rows = (data as { name: string; kind: string; hardware: string | null; status: string; last_report_at: string | null }[] | null) ?? [];
  const nowMs = Date.now();

  const robots = rows.map((m) => {
    const at = m.last_report_at ? Date.parse(m.last_report_at) : Number.NaN;
    const fresh = Number.isFinite(at) && nowMs - at <= STALE_AFTER_MS;
    return {
      serialNumber: m.name,
      manufacturer: "swampai.world",
      kind: m.kind,
      // The board, when a machine stated one, is the closest thing here to a VDA
      // `agvClass`; the standard's own class vocabulary is the integrator's to fill.
      board: m.hardware,
      status: m.status,
      connectionState: !m.last_report_at ? "OFFLINE" : fresh ? "ONLINE" : "CONNECTIONBROKEN",
      state_url: `${SITE_URL}/api/machines/${encodeURIComponent(m.name)}/vda5050`,
      order_url: `${SITE_URL}/api/machines/${encodeURIComponent(m.name)}/vda5050`,
      did_url: `${SITE_URL}/api/machines/${encodeURIComponent(m.name)}/did.json`,
      log_url: `${SITE_URL}/api/machines/${encodeURIComponent(m.name)}/mcap`,
    };
  });

  return NextResponse.json(
    {
      site: SITE_URL,
      protocol: "VDA5050",
      version: VDA_VERSION,
      transport: {
        kind: "http",
        // A VDA 5050 deployment normally pairs a per-robot topic with a broker. This
        // bridge serves the same messages over HTTP, which is what makes it reachable
        // without an operator standing up a broker first. A deployment running MQTT as
        // well announces it on its own machine row, not in this document.
        state: { method: "GET" },
        order: { method: "POST" },
        note: "The state message is public and the order door needs an agent key; the order passes through the platform's closed command palette, so the condition decides which command applies, not the caller.",
      },
      // The message shapes a client will receive, named so an adapter can check it is
      // reading the right thing before it trusts a field.
      messages: ["connection", "state", "order", "visualization"],
      state_machine: {
        states: ["INITIALIZING", "IDLE", "EXECUTING", "CHARGING", "ERROR"],
        note: "ERROR is reachable from every state by a fault and leaves only on an explicit reset, because a robot that silently returned to IDLE from a fault would be reporting health it does not have.",
      },
      staleness_window_secs: Math.round(STALE_AFTER_MS / 1000),
      profiles: [
        {
          name: "open-rmf-fleet-adapter",
          what: "An Open-RMF fleet adapter reads the state message for each robot, dispatches by POSTing an order, and follows the same AGV state machine.",
          entry: `${SITE_URL}/api/machines/{name}/vda5050`,
        },
        {
          name: "massrobotics-amr-interop",
          what: "The MassRobotics AMR interoperability profile's status fields map onto this state message: agvPosition and batteryState carry what a facility dashboard draws, and errors carry the faults.",
        },
      ],
      robots,
      count: robots.length,
      note: "This describes a bridge, not a certification. It does not claim conformance to VDA 5050, it does not assert a safety function, and safetyState on every state message is carried from the device or reported unknown.",
    },
    { headers: { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" } },
  );
}
