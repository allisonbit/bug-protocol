import "server-only";

/**
 * THE MCP APP: the habitat as an interface a client can render.
 *
 * MCP Apps (shipped with the 2026-07-28 revision) lets a tool declare
 * `_meta.ui.resourceUri` pointing at a sandboxed HTML interface, so a call can answer
 * with a picture of the thing it changed instead of a wall of prose about it. This
 * platform is unusually well suited to that: the habitat is already a projection of
 * the log into a place, and the trace record is already a timeline. Rendered as text
 * they are two long strings. Rendered as an interface they are what they describe.
 *
 * WHY THE DATA IS INLINED. A sandboxed interface is not guaranteed network access,
 * and one that fetched this site's own API from inside the sandbox would fail in
 * exactly the clients that enforce the sandbox properly. So the resource read fetches
 * the data on the server and embeds it as JSON in the document. What the client
 * renders is therefore a snapshot as of the read, which the document states plainly
 * rather than implying it updates itself.
 *
 * WHAT IT IS NOT. It is not a second source of truth and it computes nothing: every
 * number here is copied from the tool the caller could have called directly, and the
 * interface says which tool each section came from so a reader can go and read the
 * same thing as data. If this renderer and `read_world` ever disagree, the tool is
 * right, and the reason to keep the renderer that dumb is so that disagreement is
 * obvious rather than plausible.
 */

/** HTML-escape, because structure labels and agent handles end up in this document. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Structure = {
  kind?: string;
  zone?: string;
  floors?: number;
  lit?: boolean;
  trouble?: boolean;
  /** A live lease authorizes an actuation here. A different claim from the trouble mark. */
  leased?: boolean;
  label?: string;
  cites?: string;
  href?: string;
};

type Span = { created_at?: string; agent_handle?: string | null; payload?: { span?: Record<string, unknown> } };

/**
 * The interface document.
 *
 * Colour carries the same meaning it carries in the 3D world: lit is a thing that is
 * alive right now, dark is a thing that is not, the trouble mark is the last alert, and
 * a lease mark is a live authority to actuate. A reader who has looked at the world page
 * once should recognise this immediately, which is the only reason to reuse the palette
 * rather than pick a nicer one.
 */
export function habitatAppHtml(input: {
  world: { structures?: Structure[]; total?: number; lit?: number; trouble?: number; leased?: number; totals?: Record<string, number> } | null;
  activity: { spans?: Span[] } | null;
  worldError?: string | null;
  activityError?: string | null;
  siteUrl: string;
}): string {
  const world = input.world ?? null;
  const structures = Array.isArray(world?.structures) ? world.structures : [];
  const spans = Array.isArray(input.activity?.spans) ? input.activity.spans : [];

  const districtRows = structures
    .slice()
    .sort((a, b) => String(a.zone ?? "").localeCompare(String(b.zone ?? "")) || Number(b.floors ?? 0) - Number(a.floors ?? 0))
    .map(
      (s) => `<tr>
      <td class="zone">${esc(s.zone ?? "?")}</td>
      <td><span class="dot ${s.lit ? "lit" : "dark"}"></span>${esc(s.label ?? s.kind ?? "")}</td>
      <td class="num">${esc(s.floors ?? 0)}</td>
      <td class="mark">${s.trouble ? "trouble" : ""}${s.trouble && s.leased ? " " : ""}${s.leased ? "leased" : ""}</td>
    </tr>`,
    )
    .join("\n");

  const traceRows = spans
    .slice(0, 40)
    .map((s) => {
      const span = s.payload?.span ?? {};
      const brain = String(span.brain ?? "?");
      const actions = String(span["swamp.actions.ran"] ?? "?");
      const tokens = String(span["gen_ai.usage.input_tokens"] ?? 0);
      const degraded = typeof span["swamp.degraded"] === "string" ? String(span["swamp.degraded"]) : "";
      return `<tr>
      <td class="num">${esc(String(s.created_at ?? "").slice(11, 19))}</td>
      <td>${esc(s.agent_handle ?? "-")}</td>
      <td>${esc(brain)}</td>
      <td class="num">${esc(actions)}</td>
      <td class="num">${esc(tokens)}</td>
      <td class="degraded">${esc(degraded.slice(0, 90))}</td>
    </tr>`;
    })
    .join("\n");

  const totals = Object.entries(world?.totals ?? {})
    .map(([k, v]) => `<span class="pill">${esc(k)} <b>${esc(v)}</b></span>`)
    .join(" ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Swamp habitat</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 20px; background: #08130f; color: #d8e7e0; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #6f8f83; margin: 22px 0 8px; }
  .sub { color: #6f8f83; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid #14261f; vertical-align: top; }
  th { color: #6f8f83; font-weight: 500; font-size: 11px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .zone { color: #9fd8bd; }
  .mark { color: #ff8a7a; }
  .degraded { color: #b99a5e; }
  .pill { display: inline-block; background: #10231c; border: 1px solid #1c3a2f; border-radius: 999px; padding: 1px 9px; margin: 0 6px 6px 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; }
  .lit { background: #57d9a3; box-shadow: 0 0 6px #57d9a3; }
  .dark { background: #23453a; }
  .empty { color: #6f8f83; font-style: italic; }
  .err { color: #ff8a7a; }
  a { color: #8fd6ff; }
  footer { margin-top: 24px; color: #6f8f83; }
</style>
</head>
<body>
  <h1>Swamp habitat</h1>
  <p class="sub">A snapshot taken when this resource was read. Every number is copied from the tools named beside it, and those tools serve the same facts as data.</p>

  ${totals ? `<div>${totals}</div>` : ""}

  <h2>Structures, from read_world</h2>
  ${
    world
      ? `<p class="sub">${esc(world.total ?? structures.length)} drawn, ${esc(world.lit ?? 0)} lit, ${esc(world.trouble ?? 0)} carrying the trouble mark.</p>`
      : `<p class="err">${esc(input.worldError ?? "The world could not be read on this deployment.")}</p>`
  }
  <table>
    <thead><tr><th>District</th><th>What stands there</th><th class="num">Floors</th><th></th></tr></thead>
    <tbody>${districtRows || `<tr><td colspan="4" class="empty">Nothing is drawn yet.</td></tr>`}</tbody>
  </table>

  <h2>Recent beats, from read_activity</h2>
  ${
    input.activity
      ? `<table>
    <thead><tr><th>Time</th><th>Agent</th><th>Brain</th><th class="num">Actions</th><th class="num">Tokens</th><th>Degraded</th></tr></thead>
    <tbody>${traceRows || `<tr><td colspan="6" class="empty">No beat has been recorded yet.</td></tr>`}</tbody>
  </table>`
      : `<p class="err">${esc(input.activityError ?? "The trace could not be read on this deployment.")}</p>`
  }

  <footer>
    The same facts as data: <a href="${esc(input.siteUrl)}/api/mcp">this MCP server</a>, the tools read_world and read_activity,
    and the public world at <a href="${esc(input.siteUrl)}/world">${esc(input.siteUrl)}/world</a>.
  </footer>
</body>
</html>`;
}

/** The resource URI this app is published under, stated once so nothing drifts. */
export const HABITAT_APP_URI = "ui://swamp/habitat.html";
