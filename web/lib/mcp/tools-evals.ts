import type { McpTool } from "./tools";
import { supabaseAdmin } from "@/lib/supabase";
import { EVAL_WINDOW_MS, readEvalSpans, readLatestRun } from "@/lib/swamp/eval-store";
import { composite, rate, regressions, scoreWindow } from "@/lib/swamp/evals";

/**
 * HOW THIS DEPLOYMENT IS DOING, AT THE SIZE OF A TOOL CALL.
 *
 * WHY AN AGENT IS ENTITLED TO THIS. A resident deciding whether to keep working a
 * strategy has no way to see whether its own deployment is landing work or spinning.
 * This is that number, counted from the spans every beat already writes, so an agent
 * can tell a productive stretch from a degraded one without reading a page.
 *
 * WHAT IT HANDS OVER. The metrics, the per-agent breakdown, and the regressions against
 * the last stored run. Not the spans: an agent that needs them can ask the log. The
 * point is that the deployment's own performance claim is checkable rather than felt.
 *
 * READ ONLY. Scoring a window and storing it is a write on the beat secret, done by the
 * pulse rather than by a caller, because a tool that could write a run could write a
 * flattering one.
 */

const NO_BACKEND = "The swamp backend is not configured on this deployment, so there is no scoreboard to read.";

export const EVAL_TOOLS: McpTool[] = [
  {
    name: "read_evals",
    title: "Read this deployment's own scoreboard",
    description:
      "How this deployment's recent beats scored, counted from the pulse spans in its public log. Reports landed rate (actions that ran and did not fail, of actions planned), acted share (beats that both planned and ran something), degradation rate (beats where the model brain fell back to the reflex policy), latency, tokens, and a per-agent breakdown, plus which metrics moved the wrong way against the last stored run. Not a benchmark of intelligence, not a model grading a model, and not a comparison to another system. Read only: nothing here changes a rule, a prompt or a weight.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "The window to score, 1 to 72 hours. Default 6." },
        agent: { type: "string", description: "Only report agents whose handle contains this text." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? supabaseAdmin();
      if (!sb) return { text: NO_BACKEND };

      const hoursRaw = Number(args.hours ?? EVAL_WINDOW_MS / 3600000);
      const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(Math.floor(hoursRaw), 1), 72) : 6;
      const filter = typeof args.agent === "string" ? args.agent.trim().toLowerCase().slice(0, 80) : "";

      const toIso = new Date().toISOString();
      const fromIso = new Date(Date.parse(toIso) - hours * 60 * 60 * 1000).toISOString();
      const spans = await readEvalSpans(sb, fromIso, toIso);
      const board = scoreWindow(spans, fromIso, toIso);
      const previous = await readLatestRun(sb);
      const moved = regressions(board, previous).filter((r) => r.regressed);

      const perAgent = filter ? board.perAgent.filter((a) => a.agent.toLowerCase().includes(filter)) : board.perAgent;
      const actedShare = rate(board.actedBeats, board.beats);

      const pct = (v: number | null) => (v === null ? "n/a" : `${v}%`);
      const lines = perAgent.map(
        (a) =>
          `- ${a.agent}: ${a.beats} beat(s), ${a.planned} planned, ${a.landed} landed (${pct(a.landedRate)}), ${a.degradedBeats} degraded`,
      );

      return {
        text:
          `Last ${hours}h: ${board.beats} beat(s) from ${board.agents} agent(s). ` +
          `Planned ${board.planned}, ran ${board.ran}, landed ${board.landed} (${pct(board.landedRate)} landed rate), ` +
          `${board.failed} failed, ${board.dropped} dropped. Acted share ${pct(actedShare)}, degradation ${pct(board.degradationRate)}, ` +
          `average latency ${board.avgLatencyMs === null ? "n/a" : `${board.avgLatencyMs}ms`}. ` +
          `Composite score ${composite(board.landedRate, actedShare)} of 100.\n\n` +
          (perAgent.length > 0 ? `Per agent:\n${lines.join("\n")}\n\n` : "No beats from any agent in this window.\n\n") +
          (previous === null
            ? "No stored run to compare against yet, so no regression can be reported."
            : moved.length === 0
              ? `Nothing moved the wrong way against the run ending ${previous.to}.`
              : `Regressed against the run ending ${previous.to}: ` +
                moved.map((r) => `${r.metric} ${r.was} to ${r.now}`).join("; ") +
                ".") +
          `\n\nThis reports; it changes nothing.`,
        data: {
          window: { from: fromIso, to: toIso, hours },
          scoreboard: board,
          acted_share: actedShare,
          regressions: moved,
          compared_to: previous ? previous.to : null,
        },
      };
    },
  },
];
