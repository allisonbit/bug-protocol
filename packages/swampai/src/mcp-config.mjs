/**
 * ONE LINE FROM A TERMINAL TO A CONNECTED AGENT.
 *
 * Adoption dies at the config paste. Every MCP client names the same two things
 * differently, so this module owns that translation in one place instead of the
 * README owning four snippets that drift from each other. Each entry knows the
 * block shape, the key that holds configured servers, and where that file lives
 * on a normal machine.
 */

export const MCP_PATH = "/api/mcp";

export function serverUrl(base) {
  return String(base).replace(/\/+$/, "") + MCP_PATH;
}

const asJson = (serversKey, url, token) => ({
  [serversKey]: {
    swamp: {
      type: "http",
      url,
      ...(token ? { headers: { "X-Agent-Token": token } } : {}),
    },
  },
});

export const MCP_CLIENTS = {
  generic: {
    label: "Any MCP client that reads an mcpServers block",
    fileHint: "your client's MCP config file",
    build: (url, token) => ({ kind: "json", value: asJson("mcpServers", url, token) }),
  },
  cursor: {
    label: "Cursor",
    fileHint: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    build: (url, token) => ({ kind: "json", value: asJson("mcpServers", url, token) }),
  },
  claude: {
    label: "Claude Desktop and other mcpServers readers",
    fileHint: "claude_desktop_config.json",
    build: (url, token) => ({ kind: "json", value: asJson("mcpServers", url, token) }),
  },
  vscode: {
    label: "VS Code",
    fileHint: ".vscode/mcp.json",
    build: (url, token) => ({ kind: "json", value: asJson("servers", url, token) }),
  },
  "claude-code": {
    label: "Claude Code (one command, no file edit)",
    fileHint: "nothing to edit",
    build: (url, token) => ({
      kind: "text",
      value:
        `claude mcp add --transport http swamp ${url}` +
        (token ? ` --header "X-Agent-Token: ${token}"` : ""),
    }),
  },
  codex: {
    label: "Codex",
    fileHint: "~/.codex/config.toml",
    build: (url, token) => ({
      kind: "text",
      value:
        `[mcp_servers.swamp]\nurl = "${url}"` +
        (token ? `\nhttp_headers = { "X-Agent-Token" = "${token}" }` : ""),
    }),
  },
};

export function clientNames() {
  return Object.keys(MCP_CLIENTS);
}

/**
 * Build the config for one client. Unknown client names come back as a refusal
 * listing the real ones rather than as a stack trace.
 */
export function renderMcpConfig(client, base, token) {
  const entry = MCP_CLIENTS[client];
  if (!entry) {
    return { ok: false, reason: `unknown client "${client}". Known clients: ${clientNames().join(", ")}` };
  }
  const url = serverUrl(base);
  const built = entry.build(url, token);
  return {
    ok: true,
    client,
    label: entry.label,
    fileHint: entry.fileHint,
    url,
    kind: built.kind,
    value: built.value,
    text: built.kind === "json" ? JSON.stringify(built.value, null, 2) : built.value,
  };
}

/**
 * Merge a swamp entry into an existing config file without touching the rest of
 * it. Returns the new text, or a reason. Refuses anything that is not a JSON
 * object, because rewriting a file we could not parse is how a config gets
 * destroyed by a helpful tool.
 */
export function mergeIntoConfig(existingText, client, base, token) {
  const serversKey = client === "vscode" ? "servers" : "mcpServers";
  let parsed;
  try {
    parsed = existingText.trim() ? JSON.parse(existingText) : {};
  } catch (err) {
    return { ok: false, reason: "the existing file is not valid JSON, so swamp will not rewrite it: " + (err && err.message ? err.message : err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the existing file is not a JSON object" };
  }
  const block = asJson(serversKey, serverUrl(base), token);
  const next = { ...parsed, [serversKey]: { ...(parsed[serversKey] || {}), ...block[serversKey] } };
  return { ok: true, value: next, text: JSON.stringify(next, null, 2) + "\n" };
}
