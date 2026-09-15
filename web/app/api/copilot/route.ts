import { streamText, tool, jsonSchema, stepCountIs } from "ai";
import { currentUser } from "@/lib/supabase/server";
import {
  getLivePrograms,
  getProgramBySlug,
  getMySubmissions,
  getSubmission,
  getInbox,
  getLeaderboard,
  getProfile,
} from "@/lib/queries";
import { money, topTier, displayName, tierFor, SEVERITIES } from "@/lib/db";

/**
 * The AI Copilot's live model, over Vercel AI Gateway. It gets READ-ONLY tools
 * onto the real database (the same queries the site renders), so every answer is
 * grounded in actual programs, submissions, and reputation. Never invented.
 *
 * It does not write. For anything that changes state (submitting or triaging a
 * finding), it returns a numbered plan the person runs through the real forms or
 * the MCP server. That keeps a human in the loop and keeps the model honest.
 *
 * Auth flows through the request's Supabase cookies: read tools that touch
 * private rows (your submissions, your triage inbox) only return what RLS lets
 * the signed-in caller see. Degrades gracefully: with no gateway credentials it
 * returns { available:false } and the console falls back to the offline planner.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A plain "provider/model" string is routed through AI Gateway. Overridable via env.
const MODEL = process.env.COPILOT_MODEL || "anthropic/claude-sonnet-5";
const FALLBACK_MODELS = ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"];

type WireMessage = { role: "user" | "assistant" | "system"; content: string };

function gatewayReady(): boolean {
  // On Vercel with AI Gateway enabled, VERCEL_OIDC_TOKEN is injected at runtime;
  // locally (or via BYOK) an explicit key is used. Either is enough to attempt.
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

const SYSTEM = `You are the Swamp Copilot, a security assistant embedded in Swamp, an escrowed bug-bounty platform where teams fund programs and hunters submit findings that pay out from escrow when accepted.

Your job: help hunters find in-scope work and write good findings, and help program owners triage. You reason over REAL data through your tools.

HARD RULES. Never break these:
- Ground every factual claim in a tool result. If you haven't called a tool for something, don't state it as fact.
- NEVER invent programs, hunters, handles, rewards, pools, severities, statuses, dates, or counts. If a tool returns nothing, say plainly that there's nothing there yet.
- You have READ-ONLY tools. You cannot submit or triage. For any action that writes data, output a short numbered plan of the exact steps the person should take (which page/form, or which MCP tool: submit_finding, triage_submission, disclose_finding), and make clear you did not perform it.
- Stay within a program's published scope and safe harbor when advising. Never suggest testing out of scope.
- Be concise and concrete. Cite programs by name and slug, submissions by their title/id, and format currency amounts as the tool gives them.

If the tools return no data at all, tell the user the platform has no programs/findings yet rather than making any up.`;

// ---- read-only, RLS-scoped tools over the real queries ----------------------

function buildTools(userId: string | null) {
  const authNote = "You must be signed in for this; there is no signed-in user on this request.";

  return {
    list_programs: tool({
      description:
        "List the live and paused bug-bounty programs on Swamp, with their top reward, currency, escrow pool, scope size, and response SLA. Optionally filter by a free-text query over name and summary.",
      inputSchema: jsonSchema<{ query?: string }>({
        type: "object",
        properties: { query: { type: "string", description: "Free-text filter over program name/summary." } },
        additionalProperties: false,
      }),
      execute: async ({ query }) => {
        const all = await getLivePrograms();
        const q = (query ?? "").trim().toLowerCase();
        const rows = q
          ? all.filter((p) => `${p.name} ${p.summary ?? ""}`.toLowerCase().includes(q))
          : all;
        if (rows.length === 0) return { count: 0, programs: [], note: "No programs match." };
        return {
          count: rows.length,
          programs: rows.map((p) => ({
            name: p.name,
            slug: p.slug,
            status: p.status,
            summary: p.summary,
            currency: p.currency,
            top_reward: money(topTier(p), p.currency),
            pool: money(p.pool, p.currency),
            paid_out: money(p.paid_out, p.currency),
            targets: p.targets?.length ?? 0,
            response_days: p.response_days,
            safe_harbor: p.safe_harbor,
          })),
        };
      },
    }),

    get_program: tool({
      description:
        "Get one program by slug: its full scope description, in-scope targets, per-severity reward tiers, escrow pool, response SLA, and owner. Read this before advising on a submission so you stay in scope.",
      inputSchema: jsonSchema<{ slug: string }>({
        type: "object",
        properties: { slug: { type: "string", description: "Program slug from list_programs." } },
        required: ["slug"],
        additionalProperties: false,
      }),
      execute: async ({ slug }) => {
        const p = await getProgramBySlug(slug);
        if (!p) return { found: false, note: `No program with slug "${slug}".` };
        return {
          found: true,
          name: p.name,
          slug: p.slug,
          status: p.status,
          summary: p.summary,
          description: p.description,
          currency: p.currency,
          tiers: Object.fromEntries(SEVERITIES.map((s) => [s, money(tierFor(p, s), p.currency)])),
          pool: money(p.pool, p.currency),
          paid_out: money(p.paid_out, p.currency),
          response_days: p.response_days,
          safe_harbor: p.safe_harbor,
          targets: p.targets ?? [],
          owner: displayName(p.owner_profile),
        };
      },
    }),

    leaderboard: tool({
      description:
        "The ranked hunters on Swamp by reputation, with their accepted-finding count and total earned. Reputation is derived from accepted and publicly disclosed findings.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        const rows = await getLeaderboard(25);
        if (rows.length === 0) return { count: 0, hunters: [], note: "No ranked hunters yet." };
        return {
          count: rows.length,
          hunters: rows.map((h, i) => ({
            rank: i + 1,
            name: displayName(h),
            handle: h.handle,
            rep: h.rep,
            accepted: h.accepted_count,
            earned: money(h.total_earned, "USDC"),
          })),
        };
      },
    }),

    whoami: tool({
      description: "The signed-in user's own profile: handle, role, reputation, accepted findings, and total earned.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        if (!userId) return { signed_in: false, note: authNote };
        const p = await getProfile(userId);
        if (!p) return { signed_in: true, note: "No profile row found for the signed-in user." };
        return {
          signed_in: true,
          name: displayName(p),
          handle: p.handle,
          role: p.role,
          rep: p.rep,
          accepted: p.accepted_count,
          earned: money(p.total_earned, "USDC"),
        };
      },
    }),

    my_submissions: tool({
      description:
        "The findings the signed-in user has submitted across all programs, with current triage status and any awarded reward. Only returns the caller's own submissions.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        if (!userId) return { signed_in: false, note: authNote };
        const rows = await getMySubmissions(userId);
        if (rows.length === 0) return { count: 0, submissions: [], note: "You haven't submitted any findings yet." };
        return {
          count: rows.length,
          submissions: rows.map((s) => ({
            id: s.id,
            title: s.title,
            program: s.program?.name ?? "n/a",
            severity: s.assigned_severity ?? s.severity,
            status: s.status,
            reward: s.reward > 0 ? money(s.reward, s.program?.currency ?? "USDC") : null,
          })),
        };
      },
    }),

    my_inbox: tool({
      description:
        "For a program owner: the pending, not-yet-triaged submissions across the programs the signed-in user owns. This is the triage queue.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        if (!userId) return { signed_in: false, note: authNote };
        const rows = await getInbox(userId);
        if (rows.length === 0) return { count: 0, pending: [], note: "No pending submissions to triage." };
        return {
          count: rows.length,
          pending: rows.map((s) => ({
            id: s.id,
            title: s.title,
            program: s.program?.name ?? "n/a",
            reported_severity: s.severity,
          })),
        };
      },
    }),

    get_submission: tool({
      description:
        "Read one submission by id: its report body, status, severities, reward, and triage note. You can only read submissions you filed or that were filed to a program you own (enforced by the database).",
      inputSchema: jsonSchema<{ id: string }>({
        type: "object",
        properties: { id: { type: "string", description: "The submission id." } },
        required: ["id"],
        additionalProperties: false,
      }),
      execute: async ({ id }) => {
        if (!userId) return { signed_in: false, note: authNote };
        const s = await getSubmission(id);
        if (!s) return { found: false, note: "No submission with that id, or you don't have access to it." };
        return {
          found: true,
          id: s.id,
          title: s.title,
          program: s.program?.name ?? "n/a",
          reported_severity: s.severity,
          assigned_severity: s.assigned_severity,
          status: s.status,
          reward: s.reward > 0 ? money(s.reward, s.program?.currency ?? "USDC") : null,
          target: s.target,
          triage_note: s.triage_note,
          report: s.report,
        };
      },
    }),
  };
}

export async function POST(req: Request) {
  if (!gatewayReady()) {
    return Response.json(
      {
        available: false,
        reason:
          "The live model isn't connected on this deployment yet (no AI Gateway credentials). The offline planner is still available below.",
      },
      { status: 503 },
    );
  }

  let messages: WireMessage[] = [];
  try {
    const body = (await req.json()) as { messages?: WireMessage[] };
    messages = Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Keep only well-formed text messages; cap history to keep tokens bounded.
  messages = messages
    .filter((m) => m && typeof m.content === "string" && ["user", "assistant"].includes(m.role))
    .slice(-16);
  if (messages.length === 0) {
    return Response.json({ error: "No messages provided." }, { status: 400 });
  }

  const user = await currentUser();

  const result = streamText({
    model: MODEL,
    system: SYSTEM,
    messages,
    tools: buildTools(user?.id ?? null),
    stopWhen: stepCountIs(8),
    providerOptions: { gateway: { models: FALLBACK_MODELS } },
    onError: ({ error }) => {
      console.error("[copilot] stream error:", error);
    },
  });

  // A provider failure before the first token used to reach the browser as an
  // empty 200, which the console rendered as a blank reply — indistinguishable
  // from the model having nothing to say. It is not the same thing, and the
  // difference matters: a gateway that refuses the model (free tier, exhausted
  // credits, provider outage) is a real, fixable condition the reader should be
  // told about. So the stream is wrapped, and a failure is written into it as
  // text the person can actually read.
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : "unknown error";
        console.error("[copilot] stream failed:", e);
        controller.enqueue(
          encoder.encode(
            `\n\nThe model request failed: ${detail}\n\n` +
              `This is a deployment condition, not a problem with your question. ` +
              `The most common cause is that AI Gateway has no credits or the account cannot ` +
              `reach ${MODEL}. The offline planner below still works and needs no model.`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
