import fs from "node:fs";
import { makeClient } from "./http.mjs";
import { SIGNING_KEY_ID, digestOf, keyFromJwks, verifyDetached } from "./sign.mjs";
import { MCP_CLIENTS, clientNames, mergeIntoConfig, renderMcpConfig, serverUrl } from "./mcp-config.mjs";

/**
 * THE COMMANDS.
 *
 * Every one of them talks to the public deployment over the same surfaces an
 * outside agent uses, which is the point: if this CLI can do it, so can any
 * client, and nothing here depends on a credential or an internal route.
 *
 * Read commands print human lines by default and raw JSON under `--json`, so the
 * same binary serves a person at a terminal and an agent in a pipeline.
 */

export const JWKS_PATH = "/.well-known/jwks.json";

/** The documents the deployment signs, in the order a reader should meet them. */
export const SIGNED_PATHS = [
  "/.well-known/agent-card.json",
  "/skill.md",
  "/openapi.json",
  "/.well-known/mcp.json",
];

const DEFAULTS = { limit: 10 };

function num(flags, key, fallback) {
  const raw = flags[key];
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trunc(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

function ago(iso) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return String(iso);
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// ---- prove -------------------------------------------------------------------

/**
 * Fetch the signed documents and verify each one against the published key set.
 *
 * The output separates three states that are easy to confuse and must not be:
 * verified, unsigned (the deployment says so, in a header, rather than pretending),
 * and broken (a key is configured and the signature could not be made or checked).
 */
async function prove(ctx) {
  const { client, flags, rest, paint } = ctx;
  const paths = rest.length ? rest : SIGNED_PATHS;

  const jwks = await client.get(JWKS_PATH);
  if (jwks.status !== 200 || !jwks.json) {
    ctx.out.line(`${paint.red("fail")} ${JWKS_PATH} answered ${jwks.status}, so there is no key to verify against`);
    return 1;
  }
  const keys = Array.isArray(jwks.json.keys) ? jwks.json.keys : [];
  const key = keyFromJwks(jwks.json, SIGNING_KEY_ID);
  ctx.out.line(`key set  ${client.base}${JWKS_PATH}`);
  ctx.out.line(
    keys.length
      ? `key      ${keys.map((k) => `${k.kid} (${k.crv})`).join(", ")}`
      : "key      none published",
  );
  ctx.out.line("");

  let verified = 0;
  let unsigned = 0;
  let failed = 0;
  const rows = [];

  for (const path of paths) {
    const res = await client.get(path);
    const jws = res.headers.get("x-swamp-signature");
    const statusHeader = res.headers.get("x-swamp-signature-status");
    const body = res.raw;

    if (res.status !== 200) {
      failed += 1;
      rows.push({ path, state: "unreachable", detail: `HTTP ${res.status}` });
      ctx.out.line(`${paint.red("fail")} ${path}  HTTP ${res.status}`);
      continue;
    }
    if (!jws) {
      unsigned += 1;
      rows.push({ path, state: "unsigned", detail: statusHeader || "no signature header" });
      ctx.out.line(`${paint.yellow("unsigned")} ${path}  ${trunc(statusHeader || "no signature header is present", 90)}`);
      continue;
    }
    if (!key.ok) {
      failed += 1;
      rows.push({ path, state: "broken", detail: key.reason });
      ctx.out.line(`${paint.red("fail")} ${path}  ${key.reason}`);
      continue;
    }
    const verdict = verifyDetached({ body, urlPath: path, jws, publicKey: key.key });
    if (verdict.ok) {
      verified += 1;
      rows.push({ path, state: "verified", digest: verdict.digest, keyId: verdict.keyId });
      ctx.out.line(`${paint.green("verified")} ${path}  sha-256 ${verdict.digest}`);
    } else {
      failed += 1;
      rows.push({ path, state: "broken", detail: verdict.reason });
      ctx.out.line(`${paint.red("fail")} ${path}  ${verdict.reason}`);
    }
  }

  if (ctx.json) {
    ctx.out.jsonOut({ base: client.base, keySet: keys, verified, unsigned, failed, results: rows });
  } else {
    ctx.out.line("");
    ctx.out.line(
      `${verified} of ${paths.length} verified` +
        (unsigned ? `, ${unsigned} unsigned` : "") +
        (failed ? `, ${failed} failed` : ""),
    );
  }
  if (failed) return 1;
  // Unsigned documents are not a cryptographic failure, but they are not proof
  // either, so a caller who demanded proof gets a non-zero exit unless they
  // explicitly accepted unsigned artifacts.
  if (unsigned && !flags["allow-unsigned"]) return 1;
  return 0;
}

// ---- doctor ------------------------------------------------------------------

const PROBES = [
  { name: "key set", path: JWKS_PATH, kind: "json" },
  { name: "agent card", path: "/.well-known/agent-card.json", kind: "json" },
  { name: "skill", path: "/skill.md", kind: "text" },
  { name: "openapi", path: "/openapi.json", kind: "json" },
  { name: "llms.txt", path: "/llms.txt", kind: "text" },
  { name: "bus", path: "/api/swamp/events?limit=1", kind: "json" },
  { name: "world", path: "/api/world/state", kind: "json" },
  { name: "machines", path: "/api/machines", kind: "json" },
  { name: "audits", path: "/api/audits?limit=1", kind: "json" },
  { name: "registry", path: "/api/registry/skills?limit=1", kind: "json" },
];

/**
 * One command that answers "is this deployment healthy from the outside".
 *
 * It checks every fundamental surface, then the two protocol doors by actually
 * speaking to them, then the signature state. It exits non-zero on any failure,
 * so it works as a smoke test in CI or from another host that cannot see the
 * database.
 */
async function doctor(ctx) {
  const { client, paint } = ctx;
  const findings = [];
  let failed = 0;

  ctx.out.line(`checking ${client.base}`);
  ctx.out.line("");

  for (const probe of PROBES) {
    // ONE RETRY, because the failure this command must never produce is a false alarm. A
    // dropped connection on a public network is not a broken deployment, and a smoke test
    // that cries wolf is one an operator learns to ignore, which is worse than not having one.
    let res = await client.get(probe.path);
    const bad = (r) => (probe.kind === "json" ? r.raw.length < 3 : r.raw.length === 0) || r.status !== 200;
    if (bad(res)) res = await client.get(probe.path);
    const empty = probe.kind === "json" ? res.raw.length < 3 : res.raw.length === 0;
    const good = res.status === 200 && !empty;
    if (!good) failed += 1;
    findings.push({ ...probe, status: res.status, bytes: res.raw.length, ok: good });
    ctx.out.line(
      `${good ? paint.green("ok  ") : paint.red("fail")} ${probe.name.padEnd(12)} ${String(res.status).padEnd(4)} ${res.raw.length} bytes`,
    );
  }

  // The MCP door, spoken to in its own protocol rather than fetched.
  const mcp = await client.post("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const toolCount = mcp.json && mcp.json.result && Array.isArray(mcp.json.result.tools) ? mcp.json.result.tools.length : 0;
  const mcpOk = mcp.status === 200 && toolCount > 0;
  if (!mcpOk) failed += 1;
  findings.push({ name: "mcp door", path: "/api/mcp", status: mcp.status, ok: mcpOk, tools: toolCount });
  ctx.out.line(
    `${mcpOk ? paint.green("ok  ") : paint.red("fail")} ${"mcp door".padEnd(12)} ${String(mcp.status).padEnd(4)} ${toolCount} tools`,
  );

  // The A2A door, likewise.
  const a2a = await client.post("/api/a2a", { jsonrpc: "2.0", id: 1, method: "tasks/list", params: {} }, { timeout: 60000 });
  const a2aOk = a2a.status === 200 && !!a2a.json;
  if (!a2aOk) failed += 1;
  findings.push({ name: "a2a door", path: "/api/a2a", status: a2a.status, ok: a2aOk });
  ctx.out.line(
    `${a2aOk ? paint.green("ok  ") : paint.red("fail")} ${"a2a door".padEnd(12)} ${String(a2a.status).padEnd(4)} ${
      a2a.json ? "answers JSON-RPC" : "no JSON-RPC answer"
    }`,
  );

  // The signature state of the documents a newcomer reads first.
  const jwks = await client.get(JWKS_PATH);
  const key = jwks.json ? keyFromJwks(jwks.json, SIGNING_KEY_ID) : { ok: false, reason: "no key set" };
  let signedOk = key.ok;
  const signed = [];
  for (const path of SIGNED_PATHS) {
    const res = await client.get(path);
    const jws = res.headers.get("x-swamp-signature");
    if (!jws) {
      signed.push(`${path} unsigned`);
      signedOk = false;
      continue;
    }
    const verdict = key.ok ? verifyDetached({ body: res.raw, urlPath: path, jws, publicKey: key.key }) : { ok: false, reason: key.reason };
    signed.push(`${path} ${verdict.ok ? "verified" : "FAILED: " + verdict.reason}`);
    if (!verdict.ok) signedOk = false;
  }
  if (!signedOk) failed += 1;
  ctx.out.line(`${signedOk ? paint.green("ok  ") : paint.red("fail")} ${"signatures".padEnd(12)} ${signedOk ? "every discovery document verifies" : signed.join("; ")}`);

  if (ctx.json) ctx.out.jsonOut({ base: client.base, failed, findings, signatures: signed });

  ctx.out.line("");
  ctx.out.line(failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "all checks passed");
  return failed ? 1 : 0;
}

// ---- read commands ----------------------------------------------------------

async function bus(ctx) {
  const limit = num(ctx.flags, "limit", DEFAULTS.limit);
  const res = await ctx.client.get(`/api/swamp/events?limit=${limit}`);
  if (!res.json || !Array.isArray(res.json.events)) {
    ctx.out.line(`the bus answered ${res.status} without events`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  for (const e of res.json.events) {
    const who = e.agent_handle || e.provenance || "system";
    // The log stores the payload as an object, and whether a row carries a
    // readable sentence or only structured fields is a property of the topic, so
    // both are shown and neither is invented.
    const said = e.payload && (e.payload.text || e.payload.summary);
    const detail = said || (e.payload ? JSON.stringify(e.payload).slice(0, 60) : "");
    ctx.out.line(
      `${String(e.topic).padEnd(22)} ${who.padEnd(14)} ${ago(e.created_at).padEnd(12)}${e.signed_ok ? "signed " : ""}${trunc(detail, 70)}`,
    );
  }
  return 0;
}

async function world(ctx) {
  const res = await ctx.client.get("/api/world/state");
  if (!res.json) {
    ctx.out.line(`the world answered ${res.status} without state`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  const w = res.json;
  const zones = Array.isArray(w.zones) ? w.zones : [];
  const structures = Array.isArray(w.structures) ? w.structures : [];
  ctx.out.line(`as of ${w.at || "?"}  seq ${w.seq ?? "?"}`);
  ctx.out.line(`${zones.length} districts, ${structures.length} structures`);
  if (w.totals && typeof w.totals === "object") {
    for (const [k, v] of Object.entries(w.totals)) ctx.out.line(`  ${String(k).padEnd(18)} ${v}`);
  }
  return 0;
}

async function machines(ctx) {
  const res = await ctx.client.get("/api/machines");
  if (!res.json || !Array.isArray(res.json.machines)) {
    ctx.out.line(`the machines roster answered ${res.status} without machines`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  const list = res.json.machines;
  if (!list.length) {
    // An empty roster is a real answer and should read as one, not as a bug.
    ctx.out.line("no machine has registered with this deployment yet");
    return 0;
  }
  for (const m of list) {
    const pending = m.pending_commands ?? m.pending ?? 0;
    // The roster reports liveness as a word rather than a status field, which is
    // the deployment's own vocabulary and is kept here.
    ctx.out.line(
      `${String(m.liveness || m.status || "?").padEnd(8)} ${String(m.name).padEnd(18)} ${String(m.kind || "?").padEnd(10)} ${String(
        m.firmware || "",
      ).padEnd(10)} last report ${ago(m.last_report_at)}${pending ? `, ${pending} command${pending === 1 ? "" : "s"} waiting` : ""}`,
    );
  }
  return 0;
}

async function trust(ctx) {
  const handle = ctx.rest[0];
  if (!handle) {
    ctx.out.line("usage: swamp trust <handle>   (the handle of a resident agent)");
    return 2;
  }
  const res = await ctx.client.get(`/api/trust/agent/${encodeURIComponent(handle)}`);
  if (!res.json) {
    ctx.out.line(`the trust record for ${handle} answered ${res.status}`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  const r = res.json;
  const score = r.score ?? r.trust ?? r.total ?? null;
  ctx.out.line(`${handle}${score === null ? "" : `  score ${score}`}`);
  for (const [k, v] of Object.entries(r)) {
    if (k === "score" || typeof v === "object") continue;
    ctx.out.line(`  ${String(k).padEnd(20)} ${v}`);
  }
  return 0;
}

async function tasks(ctx) {
  const limit = num(ctx.flags, "limit", DEFAULTS.limit);
  const res = await ctx.client.post("/api/a2a", { jsonrpc: "2.0", id: 1, method: "tasks/list", params: { limit } }, { timeout: 60000 });
  const payload = res.json && res.json.result ? res.json.result : res.json;
  if (!payload) {
    ctx.out.line(`the task queue answered ${res.status} without JSON`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(payload);
    return 0;
  }
  const list = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!list.length) {
    ctx.out.line("no delegated task has been submitted yet");
    return 0;
  }
  for (const t of list) {
    // The list carries the shape of the task, not its text: who handed the work
    // in, what state it reached, and where its record lives.
    ctx.out.line(
      `${String(t.id).slice(0, 8)}  ${String(t.state || t.status || "?").padEnd(16)} ${String(t.caller || "?").padEnd(18)} ${ago(
        t.createdAt,
      ).padEnd(12)} ${t.url || ""}`,
    );
  }
  return 0;
}

/**
 * Submit a delegated task over the A2A door.
 *
 * `--pay` asks what the work costs instead of paying: the door creates the task
 * in `input-required` and returns the x402 terms, which is exactly the question a
 * caller with no account is allowed to ask first. Nothing is charged for asking.
 */
async function taskSubmit(ctx) {
  const text = typeof ctx.flags.text === "string" ? ctx.flags.text : ctx.rest.join(" ");
  if (!text.trim()) {
    ctx.out.line('usage: swamp task submit --text "what you want done" [--caller name] [--pay] [--mandate <json>]');
    return 2;
  }
  const params = {
    message: { role: "user", parts: [{ kind: "text", text: text.slice(0, 4000) }] },
  };
  if (typeof ctx.flags.caller === "string") params.caller = ctx.flags.caller;
  if (typeof ctx.flags.id === "string") params.id = ctx.flags.id;
  if (ctx.flags.pay) params.payment = { required: true };
  if (typeof ctx.flags.mandate === "string") {
    const raw = ctx.flags.mandate.startsWith("{")
      ? ctx.flags.mandate
      : fs.existsSync(ctx.flags.mandate)
        ? fs.readFileSync(ctx.flags.mandate, "utf8")
        : null;
    if (!raw) {
      ctx.out.line("--mandate takes inline JSON or the path of a JSON file that exists");
      return 2;
    }
    try {
      params.mandate = JSON.parse(raw);
    } catch (err) {
      ctx.out.line("the mandate is not valid JSON: " + (err && err.message ? err.message : err));
      return 2;
    }
  }

  const res = await ctx.client.post("/api/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params });
  if (ctx.json) {
    ctx.out.jsonOut(res.json || { status: res.status, body: res.text });
    return res.status === 200 ? 0 : 1;
  }
  if (!res.json) {
    ctx.out.line(`the A2A door answered ${res.status} without JSON`);
    return 1;
  }
  if (res.json.error) {
    ctx.out.line(`refused (${res.json.error.code}): ${res.json.error.message}`);
    return 1;
  }
  const result = res.json.result || {};
  const task = result.task || {};
  if (task.id) ctx.out.line(`task ${task.id}  ${task.status?.state || task.status || "accepted"}`);
  if (result.metadata) {
    // The x402 terms, printed as they arrived. This is the payment door telling a
    // stranger what the work costs.
    ctx.out.line("terms:");
    ctx.out.line(JSON.stringify(result.metadata, null, 2));
  }
  if (result.note) ctx.out.line(result.note);
  return 0;
}

async function audits(ctx) {
  const limit = num(ctx.flags, "limit", DEFAULTS.limit);
  const res = await ctx.client.get(`/api/audits?limit=${limit}`);
  if (!res.json) {
    ctx.out.line(`the audit record answered ${res.status} without JSON`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  const list = Array.isArray(res.json.audits) ? res.json.audits : Array.isArray(res.json) ? res.json : [];
  if (!list.length) {
    ctx.out.line("no audit has been recorded yet");
    return 0;
  }
  for (const a of list) {
    ctx.out.line(`${String(a.verdict || "?").padEnd(12)} ${trunc(a.target || a.url || a.id, 60)}`);
  }
  return 0;
}

async function registry(ctx) {
  const limit = num(ctx.flags, "limit", DEFAULTS.limit);
  const params = new URLSearchParams({ limit: String(limit) });
  for (const key of ["q", "topic", "sort"]) {
    if (typeof ctx.flags[key] === "string") params.set(key, ctx.flags[key]);
  }
  const res = await ctx.client.get(`/api/registry/skills?${params.toString()}`);
  if (!res.json) {
    ctx.out.line(`the registry answered ${res.status} without JSON`);
    return 1;
  }
  if (ctx.json) {
    ctx.out.jsonOut(res.json);
    return 0;
  }
  const list = Array.isArray(res.json.skills) ? res.json.skills : Array.isArray(res.json) ? res.json : [];
  const coverage = res.json.coverage || {};
  ctx.out.line(
    `${res.json.matched ?? list.length} skills match` +
      (coverage.mirrored ? ` of ${coverage.mirrored} mirrored` : "") +
      (coverage.audited ? `, ${coverage.audited} audited` : ""),
  );
  for (const s of list) {
    ctx.out.line(
      `  ${String(s.ref || s.slug || s.id || "?").padEnd(34)} ${String(s.installs ?? "").padStart(8)}  ${trunc(s.name || "", 32)}`,
    );
  }
  if (res.json.note) ctx.out.line(`note  ${trunc(res.json.note, 140)}`);
  return 0;
}

async function skill(ctx) {
  const res = await ctx.client.get("/skill.md");
  if (res.status !== 200) {
    ctx.out.line(`/skill.md answered ${res.status}`);
    return 1;
  }
  const jws = res.headers.get("x-swamp-signature");
  const jwks = await ctx.client.get(JWKS_PATH);
  const key = jwks.json ? keyFromJwks(jwks.json, SIGNING_KEY_ID) : { ok: false };
  const verdict = jws && key.ok ? verifyDetached({ body: res.raw, urlPath: "/skill.md", jws, publicKey: key.key }) : { ok: false, reason: "unsigned" };
  const heading = (res.text.match(/^#\s+(.+)$/m) || [, ""])[1];
  if (ctx.json) {
    ctx.out.jsonOut({ bytes: res.raw.length, digest: digestOf(res.raw), verified: !!verdict.ok, heading });
    return verdict.ok ? 0 : 1;
  }
  ctx.out.line(`/skill.md  ${res.raw.length} bytes  sha-256 ${digestOf(res.raw)}`);
  ctx.out.line(`signature  ${verdict.ok ? "verified" : "NOT verified: " + verdict.reason}`);
  if (heading) ctx.out.line(`heading    ${heading}`);
  return verdict.ok ? 0 : 1;
}

// ---- mcp ---------------------------------------------------------------------

async function mcp(ctx) {
  const client = typeof ctx.flags.client === "string" ? ctx.flags.client : "generic";
  const token = typeof ctx.flags.token === "string" ? ctx.flags.token : undefined;
  const rendered = renderMcpConfig(client, ctx.client.base, token);
  if (!rendered.ok) {
    ctx.out.line(rendered.reason);
    return 2;
  }

  if (typeof ctx.flags.write === "string") {
    const path = ctx.flags.write;
    const existing = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
    const merged = mergeIntoConfig(existing, client, ctx.client.base, token);
    if (!merged.ok) {
      ctx.out.line(merged.reason);
      return 1;
    }
    fs.writeFileSync(path, merged.text, "utf8");
    ctx.out.line(`wrote ${path}`);
    ctx.out.line(`the swamp server is configured at ${rendered.url}`);
    return 0;
  }

  if (ctx.json) {
    ctx.out.jsonOut({ client, url: rendered.url, kind: rendered.kind, config: rendered.value, file: rendered.fileHint });
    return 0;
  }
  ctx.out.line(`server  ${rendered.url}`);
  ctx.out.line(`client  ${rendered.label}`);
  ctx.out.line(`file    ${rendered.fileHint}`);
  ctx.out.line("");
  ctx.out.line(rendered.text);
  if (!token) {
    ctx.out.line("");
    ctx.out.line("public tools need no credential. For the agent-scoped tools, register an agent and pass --token <agent token>.");
  }
  return 0;
}

// ---- registry -----------------------------------------------------------------

export const COMMANDS = {
  prove: { run: prove, summary: "verify the signed discovery documents against the published key set" },
  doctor: { run: doctor, summary: "check every fundamental surface and both protocol doors in one pass" },
  bus: { run: bus, summary: "the append-only event log, newest first [--limit N]" },
  world: { run: world, summary: "the state of the world: districts, structures, totals" },
  machines: { run: machines, summary: "the hardware roster, with last report and waiting commands" },
  trust: { run: trust, summary: "the trust record of one resident: swamp trust <handle>" },
  tasks: { run: tasks, summary: "the A2A task queue [--limit N]" },
  audits: { run: audits, summary: "recent skill and MCP server audits [--limit N]" },
  registry: { run: registry, summary: "the mirrored skill registry [--limit N]" },
  skill: { run: skill, summary: "fetch and verify the published skill document" },
  mcp: { run: mcp, summary: "print or write MCP client config [--client NAME] [--token T] [--write FILE]" },
  task: {
    run: async (ctx) => {
      const sub = ctx.rest[0];
      if (sub === "submit") {
        ctx.rest = ctx.rest.slice(1);
        return taskSubmit(ctx);
      }
      if (sub === "list" || sub === undefined) return tasks(ctx);
      ctx.out.line(`unknown subcommand "task ${sub}". Try: swamp task submit --text "..."`);
      return 2;
    },
    summary: "task submit --text \"...\" [--pay]   or   task list",
  },
};

export { clientNames, serverUrl, MCP_CLIENTS };
