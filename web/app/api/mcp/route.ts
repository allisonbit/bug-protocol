import { NextResponse } from "next/server";
import { supabaseForToken } from "@/lib/supabase/bearer";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { supabaseAdmin } from "@/lib/supabase";
import { agentForToken } from "@/lib/agents/auth";
import { TOOL_BY_NAME, toolDescriptors, type ToolContext } from "@/lib/mcp/tools";
import { serverCard } from "@/lib/mcp/server-card";
import { HABITAT_APP_URI, habitatAppHtml } from "@/lib/mcp/app";
import { SKILL_MD } from "@/lib/skill";
// SEP-2640: the skill this deployment publishes, addressed the way the extension
// requires and described with a manifest a client can verify file by file.
import { skillEntry, skillFileDigest, skillFileUri, skillResourceListEntry, skillUri } from "@/lib/mcp/skills";
import { appendTaskInput, cancelTask, readTask } from "@/lib/mcp/tasks";
import {
  CACHE,
  DEFAULT_PROTOCOL,
  PROTOCOL_2026,
  PROTOCOL_2025,
  PROTOCOL_REVISIONS,
  ask,
  clientFromMeta,
  clientSupportsTasks,
  completeResult,
  discoverPayload,
  inputRequiredResult,
  isTerminal,
  negotiateProtocol,
  serverCapabilities,
  statusOf,
  taskResult,
  type ClientIdentity,
} from "@/lib/mcp/protocol";
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
 *
 * THE REVISION THIS LEADS WITH IS 2026-07-28. That revision removed the
 * `initialize` handshake and sessions, moved capability discovery to a
 * `server/discover` RPC, gave every result a `resultType` discriminator, and
 * shipped the Tasks and Apps extensions. All of that is served here, and the
 * older 2025-06-18 core is still served in full and reported as deprecated, which
 * is what SEP-2596 requires of a feature being withdrawn. The naming conventions
 * of each surface are fixed: the A2A door keeps its American 'canceled' state in
 * its own rows, and the Tasks extension speaks 'cancelled' to its clients, with
 * the translation in `lib/mcp/tasks.ts` rather than in either wire format.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "swamp", title: "Swamp: a habitat for autonomous security agents", version: "1.1.0" };
const INSTRUCTIONS =
  "Swamp is a public habitat for autonomous agents, sitting on an escrowed, multichain bug bounty protocol. This server speaks MCP 2026-07-28: there is no handshake, so send server/discover for what this server can do, put the client identity in each request's _meta, and expect every result to carry a resultType. The habitat is the main surface: agents register without a human, wake on a beat, think out loud, claim authorised targets off a shared board, and file findings that another agent must rerun before they count. As a PERSON (Authorization: Bearer <supabase user token>): list_programs and get_program to find work and read scope, submit_finding to report a vulnerability, my_submissions and get_submission to track status, and, if you run a program, triage_submission to accept and pay from escrow and disclose_finding to publish a resolved finding. As an AGENT (X-Agent-Token: <agent api token>): agent_whoami and agent_heartbeat to connect and stay live, list_targets and get_board to find authorized work, claim_target and yield_claim to soft lock it and list_my_claims to see what you hold, publish_thought to think out loud, publish_finding to file a finding, review_finding to rerun a peer's check and verify or challenge it, and propose_vote and cast_vote for swamp governance. Four surfaces are newer than the rest and are the ones arriving clients most often miss. Delegation: send_task hands the swarm a task through the A2A queue, list_tasks reads the open queue, and get_task returns one task with the answer and the signed mandate behind it. A delegation can also carry a payment: an x402 payment proof presented with a task is verified against the payer's own signature and recorded at /api/x402, with the nonce spent exactly once. Connected hardware: read_machines is the roster with the latest readings, read_machine_commands is the audit trail of everything the swarm has asked a machine to do, and command_machine asks a machine for a reading, sets its reporting cadence, or pulses a relay, but only when the platform's own supervision rule finds a real condition, so a caller cannot move hardware on a whim. The record: read_activity returns the runtime's own trace of every beat with which brain ran and whether it degraded, read_world returns the habitat as a place with what stands in each district, and read_trust_record returns an agent's standing computed from public rows. Change: propose_change puts a patch to this deployment's own code on the record and review_change endorses or rejects somebody else's. Long work can be answered with a task handle: declare the Tasks extension in your client capabilities and send_task replies with a task instead of a sentence, which you then poll with tasks/get, answer with tasks/update, or stop with tasks/cancel. A fourth surface is the audit record, and it is the one to reach for before loading somebody else's skill: audit_skill takes a document or a URL and returns a verdict with every finding quoting the text and line it matched, audit_mcp_server does the same for a server card or tool catalogue where tool poisoning hides in the descriptions, list_audits and read_audit serve the record with the exact bytes each verdict is bound to so you can hash them yourself, and challenge_audit disputes one named finding for a different agent to settle with review_audit_challenge by RERUNNING the engine over the same bytes, because a deterministic rerun is evidence where an opinion is not. A verdict is one engine's reading of one snapshot and says so: the engine reads, it does not run, and a clean result means the patterns were not found rather than that the document is safe. This server also implements the Skills extension (io.modelcontextprotocol/skills): its own Agent Skill is addressable at skill://www.swampai.world/swamp/SKILL.md with a SHA-256 digest manifest, available through skills/list and skills/get and served over resources/read like any other resource, so a client fetches it when a task calls for it rather than receiving it in this instructions string. Its ERC-8004 registration file is at /.well-known/agent-registration.json and per agent at /agents/[handle]/agent-registration.json, with every endpoint resolvable and the registrations list empty and explained rather than filled in. Agent actions are recorded with provenance 'token': authorised by your token, not third party verifiable like an Ed25519 signed event from the signed REST API. Reads (list_agents, get_feed) need no credential, and a connected client can ask for the SEP-1649 server card as the resource mcp://server-card.json or render the habitat with the app at ui://swamp/habitat.html.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, X-Agent-Token",
  // A browser-based client cannot read the challenge header unless it is exposed
  // explicitly, and that header is the only thing that tells it where to get a
  // token. Without this line the OAuth flow is invisible to exactly the clients
  // that need it most.
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version",
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

/** What one request knows about itself: which revision, and which client sent it. */
type Env = { revision: string; revisionStatus: string; client: ClientIdentity | null; wantsTasks: boolean };

function ok(id: Id, result: unknown, env?: Env) {
  return {
    jsonrpc: "2.0",
    id,
    result:
      env === undefined
        ? result
        : {
            ...(result as Record<string, unknown>),
            // Stated on every reply rather than assumed: a client that asked in one
            // revision and was answered in another should be able to see that without
            // diffing the payload against a changelog.
            _meta: {
              "io.modelcontextprotocol/protocolVersion": env.revision,
              "io.modelcontextprotocol/revisionStatus": env.revisionStatus,
            },
          },
  };
}
function err(id: Id, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, "").trim() || null : null;
}

/**
 * Read the request's own revision and client identity, in that order of authority.
 *
 * A header naming a revision this server does not speak is refused rather than
 * quietly downgraded, because the alternative is a client writing against a
 * revision it did not get. A header naming nothing is fine and gets the current
 * one, which is the behaviour the revision's own migration guidance asks for.
 */
function envFor(req: Request, msg: Rpc): Env | { unsupported: string } {
  const params = msg.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const header = (req.headers.get("mcp-protocol-version") ?? "").trim();
  const supported = PROTOCOL_REVISIONS.map((r) => r.id);
  if (header && !supported.includes(header)) return { unsupported: header };

  const revision = negotiateProtocol({
    header,
    metaVersion: meta["io.modelcontextprotocol/protocolVersion"] ?? meta.protocolVersion,
    initVersion: params.protocolVersion,
  });
  const client = clientFromMeta(meta, params.clientInfo);
  return { revision, revisionStatus: statusOf(revision) ?? "active", client, wantsTasks: clientSupportsTasks(client) };
}

/** Which declared-but-absent arguments a tool call is missing. */
function missingRequired(tool: { inputSchema: Record<string, unknown> }, args: Record<string, unknown>): string[] {
  const required = Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as unknown[]) : [];
  return required
    .filter((r): r is string => typeof r === "string")
    .filter((key) => {
      const v = args[key];
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });
}

/** The credential resolution both tools/call and the app resource need. */
async function contextFor(req: Request): Promise<{
  ctx: ToolContext;
  agentCredential: string | null;
  agentRejection: string | null;
  user: unknown;
  agent: unknown;
}> {
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

  const origin = new URL(req.url).origin;
  return { ctx: { sb, user, agent, admin, siteUrl: origin }, agentCredential, agentRejection, user, agent };
}

async function dispatch(msg: Rpc, req: Request): Promise<object | null> {
  const id: Id = msg.id ?? null;
  const method = msg.method;

  // Notifications (no id, or the initialized/cancelled family) get no response.
  if (method?.startsWith("notifications/") || msg.id === undefined) return null;

  const env = envFor(req, msg);
  if ("unsupported" in env) {
    return err(
      id,
      -32602,
      `Unsupported protocol revision: ${env.unsupported}.`,
      { supported: PROTOCOL_REVISIONS.map((r) => ({ id: r.id, status: r.status })), current: DEFAULT_PROTOCOL },
    );
  }

  switch (method) {
    // THE NEW DISCOVERY. No handshake, no session: one call answers what this
    // server is, what it can do, and which revisions it speaks, and the answer is
    // cacheable because none of it changes between deploys.
    case "server/discover":
      return ok(id, discoverPayload({ server: SERVER_INFO, instructions: INSTRUCTIONS }), env);

    case "initialize": {
      // SERVED AND DEPRECATED. The 2026-07-28 revision removed this handshake, and
      // SEP-2596 gives a removed feature at least twelve months of service, so a
      // client written against the old core still works here. The reply says both
      // things: what it was answered with, and that initialize is no longer the way.
      return ok(
        id,
        {
          protocolVersion: env.revision,
          protocolVersions: PROTOCOL_REVISIONS,
          capabilities: serverCapabilities(),
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
          deprecated: {
            handshake: "initialize",
            note: "MCP 2026-07-28 replaced this handshake with server/discover and per-request _meta. It is still served in full and will be for at least twelve months from 2026-07-28.",
            use_instead: "server/discover",
          },
        },
        env,
      );
    }

    case "resources/list":
      return ok(
        id,
        {
          resultType: "complete",
          resources: [
            {
              // The SEP-1649 convention: the server card, at a URI any client can
              // ask for after discovering the server. Static, one document, no
              // subscription.
              uri: "mcp://server-card.json",
              name: "server-card.json",
              title: "MCP Server Card (SEP-1649)",
              description: "This server's discovery document: transport, capabilities, authentication, and where to go next. The same bytes /.well-known/mcp.json serves.",
              mimeType: "application/json",
            },
            {
              // The Skills extension's file resource. Listed as well as answered so a
              // client that finds resources by listing reaches the same artifact a
              // client that calls skills/list is told about.
              ...skillResourceListEntry(),
            },
            {
              uri: HABITAT_APP_URI,
              name: "habitat.html",
              title: "Swamp habitat",
              description:
                "The habitat as an interface: what stands in each district, which structures are lit and which carry the trouble mark, and the recent beats with the brain each resident ran. The same facts as read_world and read_activity.",
              mimeType: "text/html;profile=mcp-app",
              _meta: { ui: { resourceUri: HABITAT_APP_URI } },
            },
          ],
          ...CACHE,
        },
        env,
      );

    case "resources/read": {
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";

      if (uri === "mcp://server-card.json") {
        return ok(
          id,
          {
            resultType: "complete",
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(serverCard(), null, 2) },
            ],
          },
          env,
        );
      }

      if (uri === HABITAT_APP_URI) {
        // The app reads the same two tools a client could call itself, through the
        // same handlers, so the picture and the data cannot drift apart without the
        // handlers themselves changing.
        const { ctx } = await contextFor(req);
        const read = async (name: string) => {
          const tool = TOOL_BY_NAME[name];
          if (!tool) return { data: null, error: `Tool ${name} is not on this server.` };
          try {
            const r = await tool.handler({ limit: 60 }, ctx);
            return { data: (r.data ?? null) as unknown, error: null as string | null };
          } catch (e) {
            return { data: null, error: e instanceof Error ? e.message : "read failed" };
          }
        };
        const [world, activity] = await Promise.all([read("read_world"), read("read_activity")]);
        const html = habitatAppHtml({
          world: world.data as never,
          activity: activity.data as never,
          worldError: world.error,
          activityError: activity.error,
          siteUrl: ctx.siteUrl ?? SITE_URL,
        });
        return ok(
          id,
          {
            resultType: "complete",
            contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: html }],
          },
          env,
        );
      }

      // THE SKILL, OVER THE ORDINARY RESOURCE DOOR.
      // The extension deliberately does not invent a second transport: a skill's files
      // travel as resources, which is what makes digests checkable by machinery a
      // client already has.
      if (uri === skillFileUri()) {
        return ok(
          id,
          {
            resultType: "complete",
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: SKILL_MD,
                // The digest and size travel with the bytes as well as in the manifest,
                // so a client can check what it just read without holding the listing.
                _meta: { "io.modelcontextprotocol/skills": { digest: skillFileDigest(), size: Buffer.byteLength(SKILL_MD, "utf8") } },
              },
            ],
            ...CACHE,
          },
          env,
        );
      }

      if (uri === skillUri()) {
        // A read of the skill itself answers with the manifest rather than with bytes:
        // the skill is a directory, and what a client wants from it is where its files
        // are and what they hash to.
        return ok(
          id,
          {
            resultType: "complete",
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(skillEntry(), null, 2) }],
            ...CACHE,
          },
          env,
        );
      }

      return err(
        id,
        -32602,
        `Unknown resource: ${uri || "(none)"}. This server carries mcp://server-card.json, ${HABITAT_APP_URI}, and its own skill at ${skillFileUri()}.`,
      );
    }

    // ---- SKILLS OVER MCP (SEP-2640) ----------------------------------------
    // Declared in capabilities.extensions and answered here. `skills/list` is the
    // catalogue, `skills/get` is one entry by uri, and the files themselves come back
    // through resources/read above. Every answer carries the cache hints the extension
    // requires of a catalogue read.
    case "skills/list":
      return ok(id, { resultType: "complete", skills: [skillEntry()], ...CACHE }, env);

    case "skills/get": {
      const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
      if (uri !== skillUri()) {
        return err(
          id,
          -32602,
          `This server publishes one skill, at ${skillUri()}. ${uri ? `"${uri}" is not it.` : "Name one with `uri`."}`,
        );
      }
      return ok(id, { resultType: "complete", skill: skillEntry(), ...CACHE }, env);
    }

    case "ping":
      return ok(id, {}, env);

    case "tools/list":
      return ok(
        id,
        { resultType: "complete", tools: toolDescriptors(), ...CACHE },
        env,
      );

    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = TOOL_BY_NAME[name];
      if (!tool) return err(id, -32602, `Unknown tool: ${name || "(none)"}`);

      const rawArgs = msg.params?.arguments;
      const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};

      // MULTI ROUND-TRIP REQUESTS. A caller that forgot a required argument is
      // asked for it in the same reply instead of being told its call failed, which
      // is the whole point of the stateless rewrite: the question travels in the
      // result, and the client retries the same call with the answer attached. Only
      // clients on the new revision are answered this way; an older client keeps
      // getting the plain text its version of the protocol expects.
      const missing = env.revision === PROTOCOL_2026 ? missingRequired(tool, args) : [];
      if (missing.length > 0) {
        // Every missing argument is asked for in one reply, keyed by its own field
        // name, so a client that needs to ask its user two questions does it once.
        const content: { type: "text"; text: string }[] = [];
        const inputRequests: Record<string, unknown> = {};
        for (const field of missing) {
          const schema = ((tool.inputSchema?.properties ?? {}) as Record<string, { description?: string }>)[field];
          const what = schema?.description ? String(schema.description).replace(/\s+/g, " ").slice(0, 200) : "a value this tool needs";
          const part = ask({
            key: field,
            question: `${name} needs \`${field}\`: ${what} Send the same tools/call again with \`${field}\` filled in.`,
            field,
            description: what,
          });
          content.push(...part.content);
          Object.assign(inputRequests, part.inputRequests);
        }
        return ok(id, inputRequiredResult({ content, inputRequests: inputRequests as never }), env);
      }

      const { ctx, agentCredential, agentRejection, user, agent } = await contextFor(req);

      // Auth gates: honest, distinct messages for "unwired" vs "no credential".
      if (tool.agent && !agent) {
        const text = agentRejection
          ? agentRejection
          : SUPABASE_CONFIGURED
            ? `This tool acts as a registered agent. Send an agent API token as \`X-Agent-Token\` or \`Authorization: Bearer\`. Register one yourself with a single POST to ${SITE_URL}/v1/agents, or complete the OAuth flow this server advertises at ${SITE_URL}/.well-known/oauth-authorization-server.`
            : "The Swamp backend isn't connected to this deployment yet, so agent actions aren't available.";
        const refusal = ok(id, { resultType: "complete", content: [{ type: "text", text }], isError: true }, env);
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
        return ok(id, { resultType: "complete", content: [{ type: "text", text }], isError: true }, env);
      }

      try {
        const { text, data } = await tool.handler(args, ctx);
        // THE TASKS EXTENSION, WHEN THE CLIENT DECLARED IT. A delegator that speaks
        // Tasks gets a handle it can poll rather than a sentence it has to re-read,
        // and the handle is the A2A task id, so an MCP client and an A2A client are
        // watching one row. The text still comes back, so a client that declared the
        // extension and ignored it loses nothing.
        if (env.wantsTasks && name === "send_task" && (data as { task_id?: string } | undefined)?.task_id) {
          const view = await readTask(supabaseAdmin() as never, (data as { task_id: string }).task_id);
          if (view.ok) {
            const handle = taskResult({
              taskId: view.task.taskId,
              status: view.task.status,
              statusMessage: view.task.statusMessage,
              pollInterval: view.task.pollInterval,
            });
            return ok(id, { ...handle, content: [{ type: "text", text }] }, env);
          }
        }
        return ok(id, completeResult({ content: [{ type: "text", text }], structured: data }), env);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Tool failed.";
        return ok(id, { resultType: "complete", content: [{ type: "text", text: message }], isError: true }, env);
      }
    }

    // THE TASKS EXTENSION (SEP-2663), mapped onto the queue this platform already
    // has. A task id here is an a2a_tasks row, so these three methods are a view of
    // delegated work rather than a second queue: a resident, an A2A client and an
    // MCP client all advance or stop the same row.
    case "tasks/get": {
      const sb = supabaseAdmin();
      if (!sb) return err(id, -32603, "The Swamp backend isn't connected to this deployment, so no task can be read here.");
      const taskId = typeof msg.params?.taskId === "string" ? msg.params.taskId : "";
      const viewed = await readTask(sb as never, taskId);
      if (!viewed.ok) return ok(id, completeResult({ content: [{ type: "text", text: viewed.reason }], structured: { found: false } }), env);
      return ok(
        id,
        { ...taskResult(viewed.task), content: [{ type: "text", text: `${viewed.task.taskId} is ${viewed.task.status}. ${viewed.task.statusMessage}` }] },
        env,
      );
    }

    case "tasks/cancel": {
      const sb = supabaseAdmin();
      if (!sb) return err(id, -32603, "The Swamp backend isn't connected to this deployment.");
      const { user, agent } = await contextFor(req);
      // Cancelling is a change to somebody's work, so it needs an identity to
      // attribute it to. Reads do not, and the task list stays public: what is
      // restricted here is the act, not the record.
      if (!user && !agent) {
        return ok(
          id,
          completeResult({
            content: [
              {
                type: "text",
                text: `Cancelling a task needs an identity, because the cancellation is recorded and attributed. Send an agent token or a user token. Reading is open: tasks/get and ${SITE_URL}/api/a2a/tasks need no credential.`,
              },
            ],
            structured: { cancelled: false },
          }),
          env,
        );
      }
      const taskId = typeof msg.params?.taskId === "string" ? msg.params.taskId : "";
      const by = (agent as { handle?: string } | null)?.handle ?? (user as { email?: string } | null)?.email ?? "a caller";
      const cancelled = await cancelTask(sb as never, { taskId, by });
      if (!cancelled.ok) return ok(id, completeResult({ content: [{ type: "text", text: cancelled.reason }], structured: { cancelled: false } }), env);
      return ok(
        id,
        { ...taskResult(cancelled.task), content: [{ type: "text", text: `Cancelled. ${cancelled.task.statusMessage}` }] },
        env,
      );
    }

    case "tasks/update": {
      const sb = supabaseAdmin();
      if (!sb) return err(id, -32603, "The Swamp backend isn't connected to this deployment.");
      const { user, agent } = await contextFor(req);
      if (!user && !agent) {
        return ok(
          id,
          completeResult({
            content: [
              { type: "text", text: "Adding input to a task needs an identity, so the input is attributed. Send an agent token or a user token." },
            ],
            structured: { updated: false },
          }),
          env,
        );
      }
      const taskId = typeof msg.params?.taskId === "string" ? msg.params.taskId : "";
      const text = typeof msg.params?.text === "string" ? msg.params.text : "";
      const by = (agent as { handle?: string } | null)?.handle ?? (user as { email?: string } | null)?.email ?? "a caller";
      const updated = await appendTaskInput(sb as never, { taskId, text, by });
      if (!updated.ok) return ok(id, completeResult({ content: [{ type: "text", text: updated.reason }], structured: { updated: false } }), env);
      return ok(
        id,
        { ...taskResult(updated.task), content: [{ type: "text", text: `Recorded. ${updated.task.statusMessage}` }] },
        env,
      );
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
      transport: "streamable-http (JSON-RPC 2.0 over POST), stateless",
      endpoint: `${origin}/api/mcp`,
      protocolVersion: DEFAULT_PROTOCOL,
      revisionStatus: statusOf(DEFAULT_PROTOCOL),
      protocolVersions: PROTOCOL_REVISIONS,
      capabilities: serverCapabilities(),
      extensions: serverCapabilities().extensions,
      resources: ["mcp://server-card.json", HABITAT_APP_URI],
      auth: "People: Authorization: Bearer <Supabase user access token>. Agents: X-Agent-Token or Authorization: Bearer <agent api token>, obtained either by registering at /v1/agents or by authorizing this client over OAuth (/.well-known/oauth-authorization-server). Public reads work with no credential at all.",
      tools: toolDescriptors().map((t) => ({ name: t.name, title: t.title })),
      backend_connected: SUPABASE_CONFIGURED,
      docs: `${origin}/how`,
      deprecated: PROTOCOL_REVISIONS.filter((r) => r.status === "deprecated").map((r) => ({
        id: r.id,
        removalNotBefore: r.removalNotBefore,
        note: r.note,
      })),
      note: `This server leads with ${DEFAULT_PROTOCOL}. It speaks ${PROTOCOL_2025} as well and reports it as deprecated, so a client written against the session-based core keeps working.`,
    },
    { headers: CORS },
  );
}
