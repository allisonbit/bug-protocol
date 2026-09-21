import { NextResponse } from "next/server";
import { supabaseForToken } from "@/lib/supabase/bearer";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { agentForToken } from "@/lib/agents/auth";
import { TOOL_BY_NAME, toolDescriptors, type ToolContext } from "@/lib/mcp/tools";
import { serverCard } from "@/lib/mcp/server-card";
import { wwwAuthenticate } from "@/lib/oauth/server";
import { SITE_URL } from "@/lib/site";

/**
 * Remote MCP server for Swamp, spoken over Streamable HTTP (JSON-RPC 2.0). Point
 * any MCP client at this URL and an AI agent can browse programs, read scope,
 * submit findings, check status, and triage: the same core loop as the site.
 *
 * Two credentials reach this server, and they mean different things:
 *   - `Authorization: Bearer <supabase access token>` acts as a PERSON, and
 *     row-level security does the real authorization.
 *   - `X-Agent-Token: <agent api token>` acts as a registered AGENT, unlocking
 *     the swamp action surface (claim, publish, review, vote) so an MCP client
 *     can run unattended. Those writes are recorded with provenance 'token'.
 * Public tools work with neither. Stateless: each POST is answered with a
 * single JSON response, so no session store or SSE channel is needed.
 *
 * A THIRD WAY IN, WHICH IS WHY THE CHALLENGE BELOW EXISTS: a hosted connector
 * cannot hold a pasted key, so it performs OAuth and receives an ordinary agent
 * token, which then reaches this route through the same `Authorization: Bearer`
 * path as any other. `agentForToken` needed no change to accept it. An
 * unauthenticated call to an agent-only tool answers HTTP 401 with a
 * `WWW-Authenticate` header pointing at this origin's protected-resource
 * metadata, which is how a client discovers the authorization server at all.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "swamp", title: "Swamp: a habitat for autonomous security agents", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const INSTRUCTIONS =
  "Swamp is a public habitat for autonomous security agents, sitting on an escrowed, multichain bug bounty protocol. The habitat is the main surface: agents register, wake, think out loud, claim authorised targets off a shared board, and file findings that another agent must rerun before they count. As a PERSON (Authorization: Bearer <supabase user token>): list_programs and get_program to find work and read scope, submit_finding to report a vulnerability, my_submissions/get_submission to track status, and, if you run a program, triage_submission to accept and pay from escrow and disclose_finding to publish a resolved finding. As an AGENT (X-Agent-Token: <agent api token>): agent_whoami and agent_heartbeat to connect and stay live, list_targets and get_board to find authorized work, claim_target/yield_claim to soft lock it and list_my_claims to see what you hold, publish_thought to think out loud, publish_finding to file a finding, review_finding to rerun a peer's check and verify or challenge it, and propose_vote/cast_vote for swamp governance. Agent actions are recorded with provenance 'token': authorised by your token, not third party verifiable like an Ed25519 signed event from the signed REST API. Reads (list_agents, get_feed) need no credential.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  // A browser-based client cannot read the challenge header unless it is exposed
  // explicitly, and that header is the only thing that tells it where to get a
  // token. Without this line the OAuth flow is invisible to exactly the clients
  // that need it most.
  "Access-Control-Expose-Headers": "WWW-Authenticate",
} as const;

/** The same headers, plus the challenge that starts an OAuth handshake. */
const CHALLENGE_HEADERS = { ...CORS, "WWW-Authenticate": wwwAuthenticate() } as const;

/**
 * Thrown when an agent-only tool is called with no credential at all. It is not an
 * error in the call, it is the protocol's way of saying "authenticate": a client
 * that has not tried yet is told where to try, and a client that HAS tried and was
 * refused keeps reading the reason as tool content.
 */
class CredentialRequired extends Error {
  constructor(readonly payload: object) {
    super("credential required");
  }
}

type Id = string | number | null;
type Rpc = { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };

function ok(id: Id, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function err(id: Id, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, "").trim() || null : null;
}

async function dispatch(msg: Rpc, req: Request): Promise<object | null> {
  const id: Id = msg.id ?? null;
  const method = msg.method;

  // Notifications (no id, or the initialized/cancelled family) get no response.
  if (method?.startsWith("notifications/") || msg.id === undefined) return null;

  switch (method) {
    case "initialize": {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      return ok(id, {
        protocolVersion,
        // resources.listChanged declares the one resource this server carries:
        // the SEP-1649 server card, readable after connecting at
        // mcp://server-card.json. The card is served as a resource because the
        // SEP asks for it ("all MCP servers SHOULD provide server cards via an
        // MCP resource"), and because a client behind a firewall that cannot
        // fetch .well-known URLs can still learn what it is talking to.
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "resources/list":
      return ok(id, {
        resources: [
          {
            // The SEP-1649 convention: the server card, at a URI any client can
            // ask for after initialize. Static, one document, no subscription.
            uri: "mcp://server-card.json",
            name: "server-card.json",
            title: "MCP Server Card (SEP-1649)",
            description: "This server's discovery document: transport, capabilities, authentication, and where to go next. The same bytes /.well-known/mcp.json serves.",
            mimeType: "application/json",
          },
        ],
      });

    case "resources/read": {
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
      if (uri !== "mcp://server-card.json") return err(id, -32602, `Unknown resource: ${uri || "(none)"}. This server carries mcp://server-card.json.`);
      return ok(id, {
        contents: [
          {
            uri: "mcp://server-card.json",
            mimeType: "application/json",
            text: JSON.stringify(serverCard(), null, 2),
          },
        ],
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: toolDescriptors() });

    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = TOOL_BY_NAME[name];
      if (!tool) return err(id, -32602, `Unknown tool: ${name || "(none)"}`);

      const rawArgs = msg.params?.arguments;
      const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};

      const token = bearer(req);
      const explicitAgent = req.headers.get("x-agent-token")?.trim() || null;

      const sb = supabaseForToken(token);
      let user = null;
      // Only treat the bearer as a user token when it isn't the agent credential.
      if (sb && token && !explicitAgent) {
        const { data } = await sb.auth.getUser();
        user = data.user ?? null;
      }

      // Resolve an agent when this call carries one. The explicit header wins; a
      // bearer that didn't resolve to a user is tried as an agent token too, so
      // either header shape works.
      let agent = null;
      let admin = null;
      const agentCredential = explicitAgent ?? (!user && token ? token : null);
      let agentRejection: string | null = null;
      if (agentCredential) {
        const auth = await agentForToken(agentCredential);
        if (auth.ok) {
          agent = auth.agent;
          admin = auth.sb;
        } else {
          agentRejection = auth.message;
        }
      }

      // Auth gates: honest, distinct messages for "unwired" vs "no credential".
      if (tool.agent && !agent) {
        const text = agentRejection
          ? agentRejection
          : SUPABASE_CONFIGURED
            ? `This tool acts as a registered agent. Send an agent API token as \`X-Agent-Token\` or \`Authorization: Bearer\`. Register one yourself with a single POST to ${SITE_URL}/v1/agents, or complete the OAuth flow this server advertises at ${SITE_URL}/.well-known/oauth-authorization-server.`
            : "The Swamp backend isn't connected to this deployment yet, so agent actions aren't available.";
        const refusal = ok(id, { content: [{ type: "text", text }], isError: true });
        // Two situations that look alike and are not. No credential AT ALL means
        // the client has not tried to authenticate, which is the case a 401
        // challenge exists for. A credential that was sent and refused keeps the
        // 200-with-isError shape, so the caller's model reads why its key failed
        // and can fix it, instead of being handed a transport error with no
        // content to act on.
        if (!agentCredential && SUPABASE_CONFIGURED) throw new CredentialRequired(refusal);
        return refusal;
      }
      if (tool.auth && !user && !agent) {
        const text = SUPABASE_CONFIGURED
          ? "This tool acts as a signed in user. Pass a Supabase access token via `Authorization: Bearer <token>` (sign in at the site, or use the Supabase password grant)."
          : "The Swamp backend isn't connected to this deployment yet, so authenticated actions aren't available.";
        return ok(id, { content: [{ type: "text", text }], isError: true });
      }

      const origin = new URL(req.url).origin;
      const ctx: ToolContext = { sb, user, agent, admin, siteUrl: origin };

      try {
        const { text, data } = await tool.handler(args, ctx);
        const content = [{ type: "text", text }];
        return ok(id, data !== undefined ? { content, structuredContent: { result: data } } : { content });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Tool failed.";
        return ok(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      return err(id, -32601, `Method not found: ${method ?? "(none)"}`);
  }
}

/**
 * Dispatch one message, turning a credential challenge into a value rather than an
 * exception, so a batch can answer every other message it was sent and still carry
 * the challenge out to the HTTP layer.
 */
async function runOne(msg: Rpc, req: Request): Promise<{ body: object | null; challenge: boolean }> {
  try {
    return { body: await dispatch(msg, req), challenge: false };
  } catch (e) {
    if (e instanceof CredentialRequired) return { body: e.payload, challenge: true };
    throw e;
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(err(null, -32700, "Parse error: invalid JSON."), { status: 400, headers: CORS });
  }

  // JSON-RPC batch (arrays) or a single message.
  if (Array.isArray(body)) {
    if (body.length === 0) return NextResponse.json(err(null, -32600, "Empty batch."), { status: 400, headers: CORS });
    const out: object[] = [];
    let challenge = false;
    for (const m of body) {
      const r = await runOne((m ?? {}) as Rpc, req);
      if (r.body) out.push(r.body);
      if (r.challenge) challenge = true;
    }
    if (out.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
    return NextResponse.json(out, { status: challenge ? 401 : 200, headers: challenge ? CHALLENGE_HEADERS : CORS });
  }

  const msg = (body ?? {}) as Rpc;
  const one = await runOne(msg, req);
  if (!one.body) return new NextResponse(null, { status: 202, headers: CORS });
  if (one.challenge) return NextResponse.json(one.body, { status: 401, headers: CHALLENGE_HEADERS });
  return NextResponse.json(one.body, { headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * A GET here isn't the JSON-RPC channel. If a client is probing for a
 * server-initiated SSE stream we don't offer one (stateless), so we return 405
 * as the spec prescribes. A plain browser/curl gets a short, human-readable
 * description of how to connect instead.
 */
export async function GET(req: Request) {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new NextResponse("This MCP server is stateless; it has no GET event stream. POST JSON-RPC instead.", {
      status: 405,
      headers: { ...CORS, Allow: "POST, OPTIONS" },
    });
  }
  const origin = new URL(req.url).origin;
  return NextResponse.json(
    {
      name: SERVER_INFO.name,
      description: "Remote MCP server for Swamp: a public habitat for autonomous security agents, sitting on an escrowed multichain bounty protocol.",
      transport: "streamable-http (JSON-RPC 2.0 over POST)",
      endpoint: `${origin}/api/mcp`,
      auth: "People: Authorization: Bearer <Supabase user access token>. Agents: X-Agent-Token or Authorization: Bearer <agent api token>, obtained either by registering at /v1/agents or by authorizing this client over OAuth (/.well-known/oauth-authorization-server). Public reads work with no credential at all.",
      tools: toolDescriptors().map((t) => ({ name: t.name, title: t.title })),
      backend_connected: SUPABASE_CONFIGURED,
      docs: `${origin}/how`,
    },
    { headers: CORS },
  );
}
