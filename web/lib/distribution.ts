import { MCP_ENDPOINT, SITE_URL } from "./site";

/**
 * HOW SOMEONE GETS THIS, STATED SO IT CANNOT BE OVERSTATED.
 *
 * The rule that shaped this file: a channel is either installable today or it is labelled with
 * what is missing. The site has been careful about this everywhere else (an empty programme
 * list says nothing is funded rather than showing a placeholder), and an install page is the
 * easiest place in a product to break that habit, because "npm install X" reads as true even
 * when X has never been published.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. The first version of this page had two live channels and
 * four waiting on the owner's npm account. Three of those four did not need npm at all: a
 * release asset is installable by npm directly, Homebrew can point at any tarball URL, and a
 * single file needs no package manager in the first place. So the artifact is the same one in
 * every case and the channels that were waiting on a credential are now open, tested by
 * `scripts/verify-cli.cjs` on every run.
 *
 * PURE: no React, no fetch. The page renders it, /install.json serves it to agents, and the
 * verifier reads the same file as text.
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

/**
 * The release that carries the installable artifacts, and the assets in it.
 *
 * SPELLED OUT, NOT COMPOSED FROM TEMPLATES, and the reason is the verifier. It reads this file
 * as text to find the URL it should fetch, and a URL assembled from three other constants
 * arrives there as the literal `${REPO_SLUG}` and gets fetched. A constant a checker has to
 * evaluate is a constant a checker gets wrong, so these are the strings themselves, and the
 * verifier additionally asserts each one against the release that must contain it.
 */
export const RELEASE_TAG = "swampai-v0.1.0";
export const REPO_SLUG = "allisonbit/bug-protocol";
export const RELEASE_ASSET_URL =
  "https://github.com/allisonbit/bug-protocol/releases/download/swampai-v0.1.0/swampai-0.1.0.tgz";
/** The Homebrew tap, which points at that same asset. */
export const TAP_SLUG = "allisonbit/homebrew-tap";
export const TAP_FORMULA_URL = "https://raw.githubusercontent.com/allisonbit/homebrew-tap/main/Formula/swamp.rb";
/** The single file, served from this deployment. */
export const SINGLE_FILE_URL = `${SITE_URL}/downloads/swamp.mjs`;

export type ChannelState = "live" | "after-publish";

export type Channel = {
  id: string;
  label: string;
  state: ChannelState;
  /** What the reader runs, exactly. */
  command: string;
  /** What is left, when something is. Never empty for `after-publish`. */
  remaining?: string;
  /** A URL that answers, and that the verifier probes. */
  provenBy?: string;
  note: string;
};

export const CHANNELS: Channel[] = [
  {
    id: "single-file",
    label: "One file, no package manager",
    state: "live",
    command: `curl -fsSL ${SINGLE_FILE_URL} -o swamp.mjs && node swamp.mjs prove`,
    provenBy: SINGLE_FILE_URL,
    note: "The whole toolkit in one file, on the Node standard library. It carries the SHA-256 of its own body, and `node swamp.mjs --self-sha256` prints the number to compare with the one printed on this page and in the release notes. No registry, no account, no lockfile, nothing else to trust.",
  },
  {
    id: "release",
    label: "Install with npm, straight from the release",
    state: "live",
    command: `npm i -g ${RELEASE_ASSET_URL}`,
    provenBy: RELEASE_ASSET_URL,
    note: "npm installs any tarball URL, so the published artifact does not need a registry to exist before it can be installed. This is the real package: nine files, no dependencies.",
  },
  {
    id: "brew",
    label: "Homebrew",
    state: "live",
    command: `brew install ${TAP_SLUG.split("/")[0]}/tap/${NPM_BIN}`,
    provenBy: TAP_FORMULA_URL,
    note: "A tap built for exactly this, installing the same tarball with its hash pinned in the formula. It is the channel for a machine that already has Homebrew and wants the command on its path.",
  },
  {
    id: "mcp",
    label: "No install at all: point a client at the endpoint",
    state: "live",
    command: `claude mcp add --transport http swamp ${MCP_ENDPOINT}`,
    provenBy: MCP_ENDPOINT,
    note: "The MCP door is a URL, not a package. Any client that speaks streamable HTTP needs that URL and nothing else, and the read tools answer with no credential.",
  },
  {
    id: "checkout",
    label: "From a checkout, for working on the tool itself",
    state: "live",
    command: `node ${PACKAGE_PATH}/bin/swamp.mjs prove\nnode ${PACKAGE_PATH}/build.mjs    # rebuild the single file, which is checked in`,
    provenBy: `${SITE_URL}/install.json`,
    note: "The source of everything above. The verifier runs this path too, so the checkout and the released artifact cannot drift without failing.",
  },
  {
    id: "npx",
    label: "npx, once it is on the public npm registry",
    state: "after-publish",
    command: `npx -y ${NPM_PACKAGE} prove`,
    remaining: "npm publish to registry.npmjs.org, which needs the owner's npm account",
    note: "The one channel a registry account is genuinely required for. Nothing else on this page is blocked behind it, which is the point of the release asset above.",
  },
  {
    id: "container",
    label: "Container",
    state: "after-publish",
    command: `docker run --rm ${IMAGE} prove`,
    remaining: "a registry push of the Dockerfile in packages/swampai",
    note: "Node slim plus the CLI, no build step, for a pipeline where a smoke test of this deployment should be one step. The Dockerfile is written and its build runs the offline self-check before it produces an image.",
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
  { name: "registry", summary: "search the mirrored skill registry" },
  { name: "skill", summary: "fetch and verify the published skill document" },
];

/** What the CLI does not do, said here rather than discovered by a reader. */
export const NOT_YET = [
  "No write door beyond a delegated task. Filing findings, publishing outputs and actuating hardware go through the MCP endpoint with a credential, which is where those belong.",
  "No Python package. The verification this CLI performs is one file of Node standard library calls, and a second implementation would be a second thing to keep correct. The protocol is documented in packages/swampai/src/sign.mjs for anyone porting it.",
];

export const SITE = SITE_URL;
