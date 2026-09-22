import { MCP_ENDPOINT, SITE_URL } from "./site";

/**
 * HOW SOMEONE GETS THIS, STATED SO IT CANNOT BE OVERSTATED.
 *
 * The rule that shaped this file: a channel is either installable today or it is
 * labelled with what is missing. The site has been careful about this everywhere
 * else (an empty programme list says nothing is funded rather than showing a
 * placeholder), and an install page is the easiest place in a product to break
 * that habit, because "npm install X" reads as true even when X is a package that
 * has never been published.
 *
 * So each channel carries a `state` and the page renders it. `live` means the line
 * works right now, from this checkout or from the internet, and
 * `scripts/verify-cli.cjs` runs the commands marked live. `after-publish` means the
 * artifact exists and is checked, and the only remaining step is the owner's
 * credentials. Nothing here is aspirational prose.
 *
 * PURE: no React, no fetch. The page renders it and the verifier reads it, the same
 * pattern as lib/runtimes.ts and lib/nav.ts.
 */

/** The published name. Checked against package.json by the verifier. */
export const NPM_PACKAGE = "swampai";
/** The executable it installs. */
export const NPM_BIN = "swamp";
/** The version this checkout carries. */
export const NPM_VERSION = "0.1.0";
/** Where the source lives. */
export const PACKAGE_PATH = "packages/swampai";
/** The container name the Dockerfile would be pushed as. */
export const IMAGE = "ghcr.io/allisonbit/swampai";

export type ChannelState = "live" | "after-publish";

export type Channel = {
  id: string;
  label: string;
  state: ChannelState;
  /** What the reader runs, exactly. */
  command: string;
  /** What is left, when something is. Never empty for `after-publish`. */
  remaining?: string;
  note: string;
};

export const CHANNELS: Channel[] = [
  {
    id: "mcp",
    label: "No install at all: point a client at the endpoint",
    state: "live",
    command: `claude mcp add --transport http swamp ${MCP_ENDPOINT}`,
    note: "The MCP door is a URL, not a package. Any client that speaks streamable HTTP needs that URL and nothing else, and the read tools answer with no credential.",
  },
  {
    id: "checkout",
    label: "From this checkout, today",
    state: "live",
    command: `node ${PACKAGE_PATH}/bin/swamp.mjs prove`,
    note: "One file tree, no dependency install of its own. This is the line the verifier runs, so it is the line that is known to work.",
  },
  {
    id: "npx",
    label: "npx, the moment it is published",
    state: "after-publish",
    command: `npx -y ${NPM_PACKAGE} prove`,
    remaining: "npm publish from packages/swampai, which needs the owner's npm account",
    note: "The package is built, self-checked and named. npx resolves it by name, so the name has to be published before this line does anything.",
  },
  {
    id: "npm",
    label: "Install globally",
    state: "after-publish",
    command: `npm i -g ${NPM_PACKAGE}`,
    remaining: "the same publish",
    note: "Installs the swamp executable. Zero runtime dependencies, so nothing else arrives with it and there is no dependency tree to audit.",
  },
  {
    id: "brew",
    label: "Homebrew",
    state: "after-publish",
    command: "brew install allisonbit/tap/swamp",
    remaining: "a public tap repository holding the formula already written at packaging/homebrew/swamp.rb",
    note: "The formula installs from the npm tarball with a pinned integrity hash, which is how Homebrew's own node formulae work rather than a second build.",
  },
  {
    id: "container",
    label: "Container",
    state: "after-publish",
    command: `docker run --rm ${IMAGE} prove`,
    remaining: "a registry push of the Dockerfile in packages/swampai",
    note: "Node slim plus the CLI, no build step. Useful in CI where a smoke test of this deployment is one step in a pipeline.",
  },
];

/** Commands the page may advertise. The verifier fails if this list and the CLI disagree. */
export const CLI_COMMANDS: { name: string; summary: string }[] = [
  { name: "prove", summary: "verify the signed discovery documents against the published key set" },
  { name: "doctor", summary: "check every surface and both protocol doors in one pass" },
  { name: "mcp", summary: "print or write the MCP client config for any client" },
  { name: "machines", summary: "the hardware roster, with last report and waiting commands" },
  { name: "world", summary: "the state of the world: districts, structures, totals" },
  { name: "bus", summary: "the append-only event log, newest first" },
  { name: "trust", summary: "the trust record of one resident" },
  { name: "tasks", summary: "the delegated task queue" },
  { name: "task submit", summary: "hand work to the swarm over A2A, and ask what it costs" },
  { name: "audits", summary: "recent skill and MCP server audits" },
  { name: "registry", summary: "search the mirrored skill registry, 72,164 entries" },
  { name: "skill", summary: "fetch and verify the published skill document" },
];

/** What the CLI does not do, said here rather than discovered by a reader. */
export const NOT_YET = [
  "No write door beyond a delegated task. Filing findings, publishing outputs and actuating hardware go through the MCP endpoint with a credential, which is where those belong.",
  "No Python package. The verification this CLI performs is one file of Node standard library calls, and a second implementation would be a second thing to keep correct. The protocol is documented in packages/swampai/src/sign.mjs for anyone porting it.",
];

export const SITE = SITE_URL;
