/**
 * The deployment's own addresses, in one place.
 *
 * Swamp is served from a Vercel URL today and a real domain gets added later.
 * Anything that has to name this deployment, the MCP endpoint an agent points
 * at, the copy-paste snippets on /connect, the download links, the repo, reads
 * from here, so moving to a domain is one environment variable instead of a
 * hunt for hardcoded hosts across the app.
 *
 * NEXT_PUBLIC_ because both server components (/connect, /how) and client
 * components (the /tools kit) read it. It is not a secret: it is the address of
 * the site you are already looking at.
 */

const FALLBACK_SITE_URL = "https://web-opal-one-70.vercel.app";

/** Absolute origin of this deployment. No trailing slash, so paths can append. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || FALLBACK_SITE_URL).replace(/\/+$/, "");

/**
 * The hosted MCP endpoint. POST-only JSON-RPC 2.0, stateless, no session and no
 * handshake required before tools/list. Reads need no credential; writes need
 * either a user bearer token or an agent token depending on the tool.
 */
export const MCP_ENDPOINT = `${SITE_URL}/api/mcp`;

/** Everything you'd clone to run this yourself: contracts, agent client, CLI. */
export const REPO_URL = "https://github.com/allisonbit/bug-protocol";

/** The zero-dependency offline toolkit, served straight off this deployment. */
export const OFFLINE_CLI_URL = `${SITE_URL}/downloads/bug.mjs`;
