/**
 * THE PROTOCOL LAYER: MCP 2026-07-28, in one module.
 *
 * WHY THIS EXISTS. On 2026-07-28 the Model Context Protocol shipped its largest
 * revision: the `initialize` handshake and `Mcp-Session-Id` were removed, every
 * request became self-contained, capability discovery moved to a `server/discover`
 * RPC, every result grew a `resultType` discriminator, and two extensions (Tasks
 * and Apps) landed beside a formal deprecation policy. This server was built on the
 * 2025-06-18 core and led with it, so a current client negotiating the new revision
 * was answered with the old one and never learned what the server could do.
 *
 * WHAT IS DONE ABOUT IT. The new revision is the default and the old one is served
 * and DEPRECATED, which is what SEP-2596 requires: a minimum twelve-month window
 * before anything disappears, and the status stated rather than implied. A client
 * that asks for 2025-06-18 still gets a working server, and its reply says what the
 * revision's status is.
 *
 * THE FIELDS ARE NOT GUESSED. Every name here was read out of the published
 * specification text rather than recalled: `resultType`, `inputRequests` with
 * `method` and `params` per entry (SEP-2322), `taskId` with `status` and
 * `pollInterval` on a task result, and `ttlMs` with `cacheScope` on a list. A
 * verifier asserts each of them, so a mismatch with a real client becomes a failing
 * check rather than a silent incompatibility.
 */

/** The revision this server leads with. */
export const PROTOCOL_2026 = "2026-07-28";
/** The revision it still serves, and says is deprecated. */
export const PROTOCOL_2025 = "2025-06-18";
/** Serving a revision is not endorsing it: this is the one to write against. */
export const DEFAULT_PROTOCOL = PROTOCOL_2026;

export type RevisionStatus = "active" | "deprecated";

/**
 * The revisions this server speaks, with their status and the earliest date the
 * deprecated ones may be removed.
 *
 * The date is not decoration. SEP-2596 gives a deprecated feature a minimum of
 * twelve months, so the earliest removal for anything deprecated on 2026-07-28 is
 * 2027-07-28, and a client reading this can plan against a real date instead of
 * watching for a breaking change to arrive unannounced.
 */
export const PROTOCOL_REVISIONS: { id: string; status: RevisionStatus; removalNotBefore?: string; note: string }[] = [
  {
    id: PROTOCOL_2026,
    status: "active",
    note: "Stateless core: no handshake, no session. Every request carries its own version, client info and capabilities. Capability discovery is server/discover. Results are polymorphic, and the Tasks and Apps extensions are available.",
  },
  {
    id: PROTOCOL_2025,
    status: "deprecated",
    removalNotBefore: "2027-07-28",
    note: "Session-based core with an initialize handshake. Still served in full, and deprecated under SEP-2596, so it stays working for at least twelve months from 2026-07-28.",
  },
];

const SUPPORTED = new Set(PROTOCOL_REVISIONS.map((r) => r.id));

/** The extension identifiers this server implements, as the spec names them. */
export const EXTENSIONS = {
  tasks: "io.modelcontextprotocol/tasks",
  apps: "io.modelcontextprotocol/apps",
  // SEP-2640, Final since 2026-09-13. Declared because this server has published an
  // Agent Skill with a digest since long before the extension existed, and the
  // extension is what lets a client fetch it when a task calls for it instead of
  // receiving it in one enormous instructions string at connect time.
  skills: "io.modelcontextprotocol/skills",
} as const;

/** Shorthands a client may send instead of the full extension id. */
const TASK_EXTENSION_ALIASES = ["tasks", EXTENSIONS.tasks, "io.modelcontextprotocol/tasks"];

export function statusOf(version: string): RevisionStatus | null {
  return PROTOCOL_REVISIONS.find((r) => r.id === version)?.status ?? null;
}

export function isDeprecated(version: string): boolean {
  return statusOf(version) === "deprecated";
}

/**
 * Which revision to answer this request in.
 *
 * Three places can carry it, and they are checked in the order the spec ranks them:
 * the `MCP-Protocol-Version` header, the per-request `_meta` block, and then the
 * legacy `initialize` parameter. A request with no version at all is served the
 * CURRENT revision rather than refused, because the new core is what a client with
 * no opinion should get: refusing would make an unversioned caller retry until it
 * guessed, and guessing is what the header exists to remove.
 */
export function negotiateProtocol(input: {
  header?: string | null;
  metaVersion?: unknown;
  initVersion?: unknown;
}): string {
  for (const candidate of [input.header, input.metaVersion, input.initVersion]) {
    if (typeof candidate === "string" && SUPPORTED.has(candidate.trim())) return candidate.trim();
  }
  return DEFAULT_PROTOCOL;
}

/** The client identity a self-contained request may carry, from `_meta`. */
export type ClientIdentity = { name: string; version: string; capabilities?: unknown };

/**
 * Read client identity and capabilities out of the request's `_meta`.
 *
 * The spec namespaces these keys (`io.modelcontextprotocol/clientInfo`), and a
 * client that sends them in the older `initialize` params instead is still read, so
 * one code path serves both revisions. Nothing here is trusted for authorization:
 * identity in a request body is a claim about a client, and the credential is the
 * only thing that decides what it may do.
 */
export function clientFromMeta(meta: unknown, legacy?: unknown): ClientIdentity | null {
  const m = (meta ?? {}) as Record<string, unknown>;
  const scoped = m["io.modelcontextprotocol/clientInfo"] ?? m.clientInfo ?? legacy;
  const c = (scoped ?? {}) as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 120) : "";
  if (!name) return null;
  return {
    name,
    version: typeof c.version === "string" ? c.version.trim().slice(0, 40) : "unknown",
    capabilities: m["io.modelcontextprotocol/clientCapabilities"] ?? m.capabilities,
  };
}

/** True when a request declares the Tasks extension, however it spells it. */
export function clientSupportsTasks(identity: ClientIdentity | null): boolean {
  const caps = (identity?.capabilities ?? {}) as Record<string, unknown>;
  const ext = (caps.extensions ?? caps) as Record<string, unknown>;
  return TASK_EXTENSION_ALIASES.some((k) => Boolean(ext?.[k]));
}

/**
 * What this server can do, in the shape `initialize` and `server/discover` both
 * answer with.
 *
 * `tools.listChanged` is false and stays false: this registry is compiled into the
 * deployment, so a client can cache the catalogue for the ttl below rather than
 * waiting for a change it will never see. The extension block is how a client learns
 * that long work can be handed back as a task handle and that one tool carries an
 * interface, without needing either.
 */
export function serverCapabilities() {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    extensions: {
      [EXTENSIONS.tasks]: { methods: ["tasks/get", "tasks/update", "tasks/cancel"] },
      [EXTENSIONS.apps]: { resources: ["ui://swamp/habitat.html"] },
      // `directoryRead` says what the extension asks it to say: whether a client may
      // list skills without naming one. True here, because this server's catalogue is
      // compiled into the deployment and there is nothing to protect by hiding it.
      [EXTENSIONS.skills]: { directoryRead: true, methods: ["skills/list", "skills/get"] },
    },
  };
}

/** The `server/discover` payload: everything a client needs, with no handshake. */
export function discoverPayload(input: { server: unknown; instructions: string }) {
  return {
    // Every result in the new revision carries a discriminator, discovery included.
    resultType: "complete" as const,
    serverInfo: input.server,
    capabilities: serverCapabilities(),
    instructions: input.instructions,
    protocolVersion: DEFAULT_PROTOCOL,
    protocolVersions: PROTOCOL_REVISIONS,
    /** Discovery is a catalogue read, so it is cacheable like the tool list. */
    ttlMs: CACHE.ttlMs,
    cacheScope: CACHE.cacheScope,
  };
}

/**
 * Cache hints for catalogue reads, so a client reuses a tool list instead of
 * refetching it on every connection.
 *
 * The field names are the specification's (`ttlMs` and `cacheScope`) rather than this
 * codebase's habit of naming things for its own convenience, and they were briefly the
 * wrong pair: the object was spread into a list response that looked for `ttlMs` and
 * found nothing, so the hints were present in the source and absent from the wire. A
 * client would simply have refetched everything and nobody would have noticed. The
 * names being the spec's is what makes that class of mistake hard to make here.
 *
 * The lifetime is public because the tool registry only changes when the deployment
 * does, which is the definition of a bounded, shared lifetime. Ten minutes is short
 * enough that a deploy is noticed quickly and long enough that a reconnect loop is not
 * a load generator.
 */
export const CACHE = { ttlMs: 600_000, cacheScope: "public" as const };

type Content = { type: "text"; text: string };

/** The ordinary result envelope. Every result carries its discriminator. */
export function completeResult(input: { content: Content[]; structured?: unknown; ttlMs?: number }) {
  return {
    resultType: "complete" as const,
    content: input.content,
    ...(input.structured !== undefined ? { structuredContent: { result: input.structured } } : {}),
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs, cacheScope: CACHE.cacheScope } : {}),
  };
}

/**
 * A MULTI ROUND-TRIP REQUEST: the server stopping to ask, in a stateless world.
 *
 * SEP-2322 replaced server-initiated requests (roots, sampling, elicitation) with a
 * result the server returns: `resultType: "input_required"` carrying an
 * `inputRequests` map of server-assigned keys to request objects. The client gets
 * the answer from its user or its caller and retries the original call with it
 * attached. Nothing holds the connection open, which is the whole point of doing it
 * this way.
 *
 * EVERY ONE OF THESE CARRIES TEXT AS WELL. A client that does not know the
 * discriminator still receives an actionable sentence, so the choice to implement
 * MRTR cannot make a call unusable for anyone: the worst case is a client that has
 * to read a sentence and send the missing argument, which is what it would have
 * done before the revision existed.
 */
export function inputRequiredResult(input: {
  content: Content[];
  inputRequests: Record<string, ElicitationRequest>;
}) {
  return {
    resultType: "input_required" as const,
    content: input.content,
    inputRequests: input.inputRequests,
  };
}

/** One request inside an `inputRequests` map: a method and its params. */
export type ElicitationRequest = {
  method: "elicitation/create";
  params: { message: string; requestedSchema: Record<string, unknown> };
};

/**
 * Ask the caller for one missing argument.
 *
 * `key` is the key the client will send back, so it is chosen by the server and
 * echoed by the client rather than inferred from the prompt: a key the client
 * invented would be a key nobody could match up.
 */
export function ask(input: {
  key: string;
  question: string;
  field: string;
  description: string;
  example?: string;
}): { content: Content[]; inputRequests: Record<string, ElicitationRequest> } {
  return {
    content: [{ type: "text", text: input.question }],
    inputRequests: {
      [input.key]: {
        method: "elicitation/create",
        params: {
          message: input.question,
          requestedSchema: {
            type: "object",
            properties: {
              [input.field]: {
                type: "string",
                description: input.description,
                ...(input.example ? { examples: [input.example] } : {}),
              },
            },
            required: [input.field],
          },
        },
      },
    },
  };
}

/**
 * A TASK HANDLE: long work answered with a durable id instead of a held connection.
 *
 * The Tasks extension (SEP-2663) is the half of the stateless rewrite this platform
 * was already built for. A resident taking delegated work can take minutes, and the
 * work here was never synchronous: it is a row in a queue with a lifecycle, which is
 * exactly what a task handle describes. So this is a mapping rather than a new
 * subsystem, and an MCP client, an A2A client and a resident all watch one row.
 */
export function taskResult(input: {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  pollInterval?: number;
  ttlMs?: number;
}) {
  return {
    resultType: "task" as const,
    task: {
      taskId: input.taskId,
      status: input.status,
      ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
      pollInterval: input.pollInterval ?? TASK_POLL_MS,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    },
  };
}

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/**
 * How often a client should ask again, in milliseconds.
 *
 * Tied to the pulse's own cadence on purpose: a task here advances when a resident
 * takes it, and residents wake on a beat. Polling faster than the thing that moves
 * the work would be pure traffic, and polling much slower would make a finished task
 * look stalled.
 */
export const TASK_POLL_MS = 5_000;

/** Terminal task states are immutable, so a cancel on one is refused, not ignored. */
export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * There is deliberately no tool count here.
 *
 * An earlier version of this module imported the whole tool registry just to answer
 * how many tools there are, which dragged the entire application graph, including
 * request-scoped Supabase and Next's headers, into anything that wanted to know the
 * protocol revision. The count belongs where the registry is (`server-card.ts`), and
 * keeping it out of here is what lets a verifier check the protocol without a
 * deployment attached.
 */
