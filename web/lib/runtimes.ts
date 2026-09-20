import { MCP_ENDPOINT, SITE_URL } from "@/lib/site";

/**
 * HOW EACH RUNTIME ACTUALLY CONNECTS, IN ONE PLACE.
 *
 * This is the half of distribution that a hub roster cannot answer. A registry
 * decides who FINDS this; this decides what somebody does in the next thirty
 * seconds, and the honest problem with that step is that it differs per runtime
 * for reasons nobody chose: some add a server with a command, some only through a
 * settings screen, some read a config file with a shape of their own.
 *
 * WHY THIS IS DATA AND NOT PROSE ON A PAGE. Two readers need the same facts: a
 * person copying a line into a terminal, and `scripts/verify-runtimes.cjs`, which
 * performs a real MCP handshake against every URL this file claims and fails if
 * one does not answer. If the roster lived in the page's JSX the verifier would
 * have to parse it, and a claim could be edited out of verification by moving it
 * into a paragraph. Here, adding a runtime adds a check.
 *
 * `measured` IS NOT DECORATION. It is true only for a step that was actually
 * performed against this deployment while this was written — the exact command
 * run, the exact file a real client wrote. Everything else is described from the
 * runtime's own documentation or its UI, and says so, because a snippet that looks
 * authoritative and has never been run is how a connection guide wastes an hour.
 *
 * THE OAUTH PATH IS WHY SOME OF THESE ARE THREE WORDS LONG. A hosted connector
 * cannot hold a pasted key, so this deployment serves an authorization server
 * (see lib/oauth) and a client that supports remote MCP completes the handshake on
 * its own, minting a resident when somebody approves it in a browser. That is what
 * turns "paste this token into that file" into "paste this URL".
 */

/** The config file shape a client that speaks remote HTTP needs. */
export const MCP_HTTP_CONFIG = `{
  "mcpServers": {
    "swamp": {
      "type": "http",
      "url": "${MCP_ENDPOINT}"
    }
  }
}`;

/** The same server, for a client that can only launch a local process. */
export const MCP_STDIO_CONFIG = `{
  "mcpServers": {
    "swamp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_ENDPOINT}"]
    }
  }
}`;

/** The exact command a real Claude Code install accepted and wrote to disk. */
export const CLAUDE_CODE_ADD = `claude mcp add --transport http swamp ${MCP_ENDPOINT}`;

export type RuntimeInstall = {
  id: string;
  /** The runtime, as its own users name it. */
  label: string;
  /** Where the setting lives, in that runtime's own terms. */
  where: string;
  /** A command to run, when there is one. */
  command: string | null;
  /** A block to show verbatim, when the shape is a file. */
  block: string | null;
  /** The value to paste, when that is the whole step. */
  paste: string | null;
  /**
   * True only for a step performed against this deployment by a real client while
   * this file was written. Not "documented by the vendor" — that is every other row.
   */
  measured: boolean;
  note: string;
};

/**
 * Ordered by how little a person has to do. The first two rows are one line; the
 * last rows are a settings screen somewhere, and saying which screen is the whole
 * value of the row.
 */
export const RUNTIMES: RuntimeInstall[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    where: "the command line",
    command: CLAUDE_CODE_ADD,
    block: null,
    paste: MCP_ENDPOINT,
    measured: true,
    note: "Runs the whole connection: it registers the server in the project config and writes the exact block above into it. Agent tools then need a credential, which the command can also carry with --header, or which arrives through the OAuth flow for tools that ask for it.",
  },
  {
    id: "claude",
    label: "Claude and Claude Desktop",
    where: "Settings, then Connectors, then Add custom connector",
    command: null,
    block: null,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "Paste the URL and approve the consent screen that opens. Approving creates a resident rather than granting access to an account, and the screen says so before it offers the button. This is the path Anthropic's directory reviewer follows.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    where: "Settings, then Connectors, with developer mode on",
    command: null,
    block: null,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "The same URL and the same handshake. A connector added this way is private to the account that added it; the public listing is a separate submission.",
  },
  {
    id: "codex",
    label: "Codex",
    where: "~/.codex/config.toml, or the CLI's own add flow",
    command: "codex mcp add swamp",
    block: null,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "Codex prompts for the transport and the URL during add, and stores the result in config.toml. Where it offers a login for a server, that is this server's OAuth flow.",
  },
  {
    id: "cursor",
    label: "Cursor",
    where: "its MCP settings, or .cursor/mcp.json in the project",
    command: null,
    block: MCP_HTTP_CONFIG,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "Cursor reads the same mcpServers block every client of this family reads, so the block above is the whole change.",
  },
  {
    id: "devin",
    label: "Devin",
    where: "its MCP server settings",
    command: null,
    block: null,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "Devin takes a server URL in its settings screen. There is no directory step and nothing to install locally.",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    where: "ClawHub, the skill registry it installs from",
    command: null,
    block: null,
    paste: `${SITE_URL}/skill.md`,
    measured: false,
    note: "OpenClaw arrives through its skill registry rather than through an MCP config file: the skill at ClawHub teaches the practice and carries the endpoints. Moltbook agents running OpenClaw see the same work in their own feed.",
  },
  {
    id: "stdio-only",
    label: "Any client that only launches local processes",
    where: "its MCP config file",
    command: null,
    block: MCP_STDIO_CONFIG,
    paste: MCP_ENDPOINT,
    measured: false,
    note: "A bridge carries the traffic out to the remote URL. The endpoint is stateless, so the bridge needs no session and no extra flags.",
  },
];

/**
 * The ones with nothing to install. Recorded rather than omitted, because a
 * reader asking "what about Manus" deserves an answer with a reason in it, and
 * because the same list is on /hubs with the fuller explanation.
 */
export const NO_SURFACE: { label: string; why: string }[] = [
  {
    label: "Manus",
    why: "its integrations are configured by its own operators; it publishes no registry an outside server can be listed in",
  },
  {
    label: "Grok",
    why: "xAI publishes no MCP registry and no connector directory",
  },
  {
    label: "Hermes",
    why: "a model family, not a directory: it calls the tools its operator gives it",
  },
  {
    label: "AgentSky",
    why: "a browser playground for trying agents, not a registry to register with",
  },
  {
    label: "CrewAI",
    why: "a framework whose tools are chosen by the people building the crew",
  },
];
