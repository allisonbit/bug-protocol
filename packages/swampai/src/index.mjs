import { COMMANDS } from "./commands.mjs";
import { DEFAULT_BASE, makeClient } from "./http.mjs";

export const VERSION = "0.1.0";

/**
 * The flags that never take a value.
 *
 * This list exists because a greedy parser is unpredictable in exactly the case
 * people write most: `swamp prove --json` followed by a path. Without it, `--json`
 * would swallow the next word and the command would appear to do nothing. A flag
 * that only ever means "on" says so here, and a value can still be forced with
 * `--flag=value`.
 */
export const BOOLEAN_FLAGS = new Set([
  "json",
  "no-color",
  "help",
  "h",
  "version",
  "v",
  "pay",
  "allow-unsigned",
  "quiet",
]);

/**
 * Argument parsing, deliberately small and predictable: long and short flags, a
 * value taken from `--flag value` or `--flag=value`, everything else positional.
 * A CLI whose flags surprise the caller is a CLI nobody scripts against.
 */
export function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (/^-{1,2}.+/.test(arg)) {
      const body = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      if (eq !== -1) flags[key] = body.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) flags[key] = argv[++i];
      else flags[key] = true;
      continue;
    }
    rest.push(arg);
  }
  return { flags, rest };
}

function makePaint(enabled) {
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return { green: wrap(32), red: wrap(31), yellow: wrap(33), dim: wrap(2), bold: wrap(1) };
}

function makeOut() {
  return {
    line: (s = "") => process.stdout.write(String(s) + "\n"),
    jsonOut: (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n"),
  };
}

export function helpText() {
  const rows = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`)
    .join("\n");
  return `swamp ${VERSION} - the swampai.world toolkit, one install away

usage: swamp <command> [options]

commands
${rows}

global options
  --url URL        talk to another deployment (default ${DEFAULT_BASE}, or $SWAMP_URL)
  --json           print raw JSON instead of human lines
  --no-color       plain text, for logs and pipes
  -h, --help       this text
  -v, --version    the CLI version

examples
  swamp prove                                   prove the discovery documents are authentic
  swamp doctor                                  is this deployment healthy from the outside
  swamp mcp --client claude-code                 the one command that connects an agent
  swamp mcp --client cursor --write mcp.json     write the config into a file without clobbering it
  swamp task submit --text "check the firmware" --pay
  swamp machines                                who is connected and when they last reported
`;
}

export async function main(argv) {
  const { flags, rest } = parseArgv(argv);
  const out = makeOut();
  const paint = makePaint(Boolean(process.stdout.isTTY) && !flags["no-color"] && !process.env.NO_COLOR);

  // Version first, because `swamp --version` has no positional arguments and the help
  // fallback below fires on exactly that shape. Asking what version a tool is should never
  // answer with a manual.
  if (flags.version || flags.v) {
    out.line(VERSION);
    return 0;
  }
  if (flags.help || flags.h || rest[0] === "help") {
    out.line(helpText());
    return 0;
  }
  if (rest.length === 0) {
    out.line(helpText());
    return 2;
  }

  const [name, ...args] = rest;
  const command = COMMANDS[name];
  if (!command) {
    out.line(`unknown command "${name}"`);
    out.line("");
    out.line(helpText());
    return 2;
  }

  const base = typeof flags.url === "string" ? flags.url : process.env.SWAMP_URL || DEFAULT_BASE;
  const client = makeClient({ base, timeoutMs: flags.timeout ? Number(flags.timeout) : undefined });

  try {
    return await command.run({
      client,
      flags,
      rest: args,
      json: Boolean(flags.json),
      out,
      paint,
    });
  } catch (err) {
    // A network failure is a fact about the deployment, not a crash. Say which.
    const message = err && err.message ? err.message : String(err);
    out.line(`${paint.red("unreachable")} ${base}: ${message}`);
    return 1;
  }
}
