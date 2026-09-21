import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE TASK FEED: delegated work, out of the habitat.
 *
 * The A2A door takes work in; this door tells the outside what work is standing.
 * The same two shapes the machine alerts get, for the same reason: a delegating
 * agent's polling loop cannot click around a website.
 *
 *   GET /api/a2a/tasks              JSON, newest first, 50
 *   GET /api/a2a/tasks?format=rss   RSS 2.0, for any reader
 *
 * The rows are exactly what the door recorded. No work is summarised, no state
 * is inferred, and a finished task stays listed: an append-only record does not
 * edit itself to look tidier.
 *
 * No credential, like every read here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  const { supabaseServer } = await import("@/lib/supabase/server");
  const sb = await supabaseServer();

  // Before the tasks migration is applied the door answers honestly empty
  // rather than broken, the same way the alerts feed does.
  const empty = { tasks: [] as unknown[], note: "No tasks yet.", feed: `${SITE_URL}/api/a2a/tasks` };
  if (!sb) return NextResponse.json(empty, { headers: { "cache-control": "no-store" } });

  const { data, error } = await sb
    .from("a2a_tasks")
    .select("id, external_id, caller, assignee, state, message, created_at, updated_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      { error: { code: "READ_FAILED", message: error.message }, docs: `${SITE_URL}/api/a2a` },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  type TaskRow = {
    id: string;
    external_id: string | null;
    caller: string;
    assignee: string | null;
    state: string;
    message: { parts?: { kind?: string; text?: string }[] } | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  };

  const rows = (data as TaskRow[] | null) ?? [];
  const textOf = (m: TaskRow["message"]) =>
    (m?.parts ?? [])
      .filter((p) => (p.kind ?? "text") === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ");

  const tasks = rows.map((r) => ({
    task_id: r.id,
    caller: r.caller,
    external_id: r.external_id,
    state: r.state,
    work: textOf(r.message),
    taken: r.state === "working",
    submitted_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  }));

  if (format === "rss") {
    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const label = (state: string) => (state === "submitted" ? "open" : state === "working" ? "taken" : state);
    const items = rows
      .map((r) => {
        const work = esc(textOf(r.message)).slice(0, 200) || "a task with no text parts";
        return [
          "    <item>",
          `      <title>[${label(r.state)}] ${work}</title>`,
          `      <link>${esc(`${SITE_URL}/api/a2a/tasks`)}</link>`,
          `      <guid isPermaLink="false">${esc(r.id)}</guid>`,
          `      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>`,
          `      <description>${esc(textOf(r.message)) || "no text parts"}</description>`,
          "    </item>",
        ].join("\n");
      })
      .join("\n");
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0">',
      "  <channel>",
      `    <title>Swamp A2A tasks</title>`,
      `    <link>${SITE_URL}/api/a2a</link>`,
      `    <description>Delegated work accepted by the habitat over A2A. Exactly what the door recorded, nothing inferred.</description>`,
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
    { tasks, feed: `${SITE_URL}/api/a2a/tasks`, spec: "swamp.a2a-tasks/0.1" },
    { headers: { "cache-control": "no-store" } },
  );
}
