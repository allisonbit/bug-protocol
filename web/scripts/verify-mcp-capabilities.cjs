#!/usr/bin/env node
/**
 * Are the platform's capabilities actually reachable by an agent over MCP?
 *
 * THE FAILURE THIS EXISTS FOR. Every door on this site was built for people first,
 * and then the MCP surface was written for whoever was standing there at the time.
 * Delegation arrived as an A2A queue and a page; hardware supervision arrived as a
 * command palette the swarm uses internally; the habitat arrived as a drawing; the
 * trust record arrived as a JSON route pointed at from a forum post. A client
 * arriving with an MCP handshake — which is how most agents arrive — could reach
 * the bug-bounty loop and almost nothing else, and NOTHING FAILED. No route 404'd,
 * no page broke. The capabilities existed and were simply invisible.
 *
 * So this check is about reachability, in both directions:
 *
 *   COVERAGE  the surfaces an agent would want are described by a tool, by name.
 *   GUARDING  the action tools reuse the platform's own decisions rather than
 *             inventing a second path to doing something in the world, and they
 *             are gated on a token and announced as mutating rather than read-only.
 *
 * THE SECOND ONE MATTERS MORE THAN THE FIRST. A read tool that drifts is a stale
 * answer. A WRITE tool that drifts is a second, unaudited way to move hardware, and
 * the whole supervision design rests on there being exactly one: a condition cited
 * from the machine's own declared band, a closed palette, and cool-downs that read
 * a shared note. So the tool is asserted to call the same pure decision the pulse
 * calls, and to contain none of the decision itself.
 *
 * No network, no database, no server:
 *
 *   node scripts/verify-mcp-capabilities.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

const capPath = path.join(ROOT, "lib", "mcp", "tools-capabilities.ts");
if (!fs.existsSync(capPath)) {
  console.error("verify-mcp-capabilities: lib/mcp/tools-capabilities.ts is missing");
  process.exit(1);
}
const cap = read("lib/mcp/tools-capabilities.ts");
const registry = read("lib/mcp/tools.ts");
const supervision = read("lib/swamp/machine-supervision.ts");
const worldRows = read("lib/world/rows.ts");

/** A tool descriptor's name, as the registry writes it. */
const names = [...cap.matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
/** The descriptor block for one tool, so its own flags can be read. */
function block(name) {
  const start = cap.indexOf(`    name: "${name}",`);
  if (start < 0) return "";
  const next = cap.indexOf("\n    name: \"", start + 1);
  return cap.slice(start, next < 0 ? cap.length : next);
}

console.log("== coverage: the capabilities an agent arrives looking for ==");
for (const name of [
  "send_task",
  "list_tasks",
  "get_task", // delegation, the A2A queue
  "read_machine_commands",
  "command_machine", // hardware, read and act
  "read_activity", // the runtime's own trace
  "read_world", // the habitat
  "read_trust_record", // an agent's standing
]) {
  check(`${name} is described`, names.includes(name));
}
check("every descriptor here has a handler", names.length === [...cap.matchAll(/^ {4}handler:/gm)].length);

// The reads are wired to the real thing rather than to an intention.
check("the queue tools read the A2A tables", /from\("a2a_tasks"\)/.test(cap) && /from\("a2a_mandates"\)/.test(cap));
check("the submission writes the row the A2A door writes", /from\("a2a_tasks"\)\s*\n?\s*\.insert/.test(cap));
check("activity spans come from the public log", cap.includes('"pulse.span"'));
check(
  "the world is the world's own projection, not a re-reading of the tables",
  cap.includes('from "@/lib/world/rows"') && cap.includes('from "@/lib/world/project"') && worldRows.includes("export async function getWorldRows"),
);
check(
  "the trust record is fetched from its one author",
  cap.includes("/api/trust/agent/") && cap.includes("ctx.siteUrl"),
);

console.log("== guarding: the action tools reuse the platform's own decisions ==");
check(
  "command_machine calls the same pure decision the pulse calls",
  block("command_machine").includes("supervisionDecision(") && supervision.includes("export function supervisionDecision("),
);
check(
  "and contains none of the decision itself",
  !/COMMAND_COOLDOWN_MS|ACTUATION_COOLDOWN_MS\s*[<>]/.test(block("command_machine")),
);
check(
  "the cable bodies live only in the palette",
  !block("command_machine").includes('action: "') && supervision.includes("export const COMMAND_PALETTE"),
);
check(
  "the actuation cap comes from the module",
  block("command_machine").includes("MAX_RELAY_SECONDS") && supervision.includes("export const MAX_RELAY_SECONDS"),
);
check(
  "the cool-down is read from the shared note, not from the caller",
  block("command_machine").includes("SUPERVISION_NOTE_KEY") && cap.includes("rememberNote("),
);
check(
  "a caller cannot name a command the condition did not support",
  block("command_machine").includes("asked !== decision.name"),
);
check(
  "the command is attributed to the resident that issued it",
  cap.includes("issued_by_agent: agent.id") && cap.includes("issued_by: null"),
);

console.log("== the write path leaves the same three traces the pulse leaves ==");
check("the row", cap.includes('from("machine_commands").insert'));
check("the event", cap.includes('topic: "machine.command"') && cap.includes('provenance: "runtime"'));
check("the shared note", cap.includes("key: SUPERVISION_NOTE_KEY"));

console.log("== gating: who may call what, and how it is advertised ==");
check("sending a task needs a token, because a delegation must be attributable", /agent: true/.test(block("send_task")));
check("commanding hardware needs a token", /agent: true/.test(block("command_machine")));
check(
  "the public reads need no token",
  !/agent: true/.test(block("list_tasks")) && !/agent: true/.test(block("read_activity")) && !/agent: true/.test(block("read_world")),
);
check(
  "the registry spreads these in, so they are dispatchable",
  registry.includes("...CAPABILITY_TOOLS,") && registry.includes('from "./tools-capabilities"'),
);
check(
  "and the dispatcher and the descriptor list are both derived from the same array",
  registry.includes("Object.fromEntries(TOOLS.map((t) => [t.name, t]))") && registry.includes("TOOLS.map((t) => ({"),
);
check(
  "an agent action is never advertised read-only",
  registry.includes("readOnlyHint:") && registry.includes("!t.auth && !t.agent"),
);

console.log("== honesty: text written by somebody else is marked as such ==");
check(
  "task text, answers and machine notes are marked untrusted",
  /content_is_untrusted: true/.test(cap) && block("get_task").includes("content_is_untrusted: true"),
);

console.log(
  failed === 0
    ? "\nmcp capabilities: doors reachable, actions guarded - all checks passed"
    : `\nmcp capabilities: ${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
