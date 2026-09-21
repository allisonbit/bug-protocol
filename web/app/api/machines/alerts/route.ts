import { NextResponse } from "next/server";
import type { MachineReading } from "@/lib/agents/types";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE ALERT FEED: over-threshold events, out of the habitat.
 *
 * Everything on this platform is public data; this door exists because public is
 * not the same as reachable. A feed reader, a pager script, or another machine's
 * polling loop cannot click around a website, so the alerts a machine raises get
 * the plainest two shapes the web has:
 *
 *   GET /api/machines/alerts              JSON, newest first, 50
 *   GET /api/machines/alerts?format=rss   RSS 2.0, for any reader
 *
 * NOTHING IS ADDED HERE. The rows are exactly what machines sent, in the words
 * the machine chose, at the time it sent them. No severity is inferred, no alert
 * is resolved, and a retired machine's old alerts stay listed, because an
 * append-only record does not edit itself to look tidier.
 *
 * No credential, like every read here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  const { supabaseServer } = await import("@/lib/supabase/server");
  const sb = await supabaseServer();

  // Before the machines migration is applied the door answers honestly empty
  // rather than broken, the same way the roster page does.
  const empty = { alerts: [] as unknown[], note: "No alerts yet.", feed: `${SITE_URL}/api/machines/alerts` };
  if (!sb) return NextResponse.json(empty, { headers: { "cache-control": "no-store" } });

  const { data, error } = await sb
    .from("machine_readings")
    .select("id, machine_id, machine_name, kind, metric, value, unit, state, message, created_at")
    .eq("kind", "alert")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      { error: { code: "READ_FAILED", message: error.message }, docs: `${SITE_URL}/machines` },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const rows = (data as MachineReading[] | null) ?? [];
  const alerts = rows.map((r) => ({
    machine: r.machine_name,
    message: r.message ?? r.state ?? "alert raised",
    metric: r.metric,
    value: r.value,
    unit: r.unit,
    at: r.created_at,
    page: `${SITE_URL}/machines/${encodeURIComponent(r.machine_name)}`,
  }));

  if (format === "rss") {
    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const items = rows
      .map((r) => {
        const title = `${r.machine_name}: ${esc(r.message ?? r.state ?? "alert raised").slice(0, 160)}`;
        const link = `${SITE_URL}/machines/${encodeURIComponent(r.machine_name)}`;
        return [
          "    <item>",
          `      <title>${title}</title>`,
          `      <link>${esc(link)}</link>`,
          `      <guid isPermaLink="false">${esc(r.id)}</guid>`,
          `      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>`,
          `      <description>${esc(r.message ?? r.state ?? "alert raised")}</description>`,
          "    </item>",
        ].join("\n");
      })
      .join("\n");
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0">',
      "  <channel>",
      `    <title>Swamp machine alerts</title>`,
      `    <link>${SITE_URL}/machines</link>`,
      `    <description>Alerts raised by the machines connected to the habitat. Exactly what the machines sent, nothing inferred.</description>`,
      `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
      items,
      "  </channel>",
      "</rss>",
      "",
    ].join("\n");
    return new NextResponse(xml, {
      headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return NextResponse.json(
    {
      alerts,
      note: alerts.length === 0 ? "No alerts have been raised yet." : undefined,
      feed: `${SITE_URL}/api/machines/alerts`,
      rss: `${SITE_URL}/api/machines/alerts?format=rss`,
      docs: `${SITE_URL}/machines`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
