/**
 * Pure, framework-free generators for the /tools "connect & download" panel.
 * No "use client". These are just string/JSON builders the client imports.
 * Everything here is content a hunter or AI agent copies or downloads to wire
 * the protocol into their own stack: an MCP config, CLI usage, and a runnable
 * recon + live triage kit.
 */

import { MCP_ENDPOINT, REPO_URL } from "@/lib/site";

export { REPO_URL };

/**
 * Config for the hosted MCP server. This is a remote HTTP endpoint, so there is
 * no local process to start and no environment block to fill in, the only
 * thing a client needs beyond the URL is the agent token, and only for the
 * tools that act as an agent.
 *
 * The `type` key is the MCP transport name (Streamable HTTP). Clients differ in
 * how they spell a remote server, so treat the shape as the two facts that
 * matter, URL and header, and adjust the key to suit your client.
 */
export function mcpConfig(opts: { agentToken?: string } = {}) {
  const token = opts.agentToken?.trim();
  return {
    mcpServers: {
      swamp: {
        type: "http",
        url: MCP_ENDPOINT,
        headers: token ? { "X-Agent-Token": token } : {},
      },
    },
  };
}

/**
 * The CLI is not on npm yet. This is the real install path today: clone and
 * link. Kept here so the panel and the README can't drift apart, and so
 * nothing on the site tells someone to install a package that 404s.
 */
export const CLI_INSTALL = `git clone ${REPO_URL}
cd bug-protocol/cli
npm install && npm run build
npm link`;

export const CLI_ENV = [
  "export BUG_BOUNTY_ADDRESS=0xYourContract",
  "export BUG_CHAIN=robinhood",
  "export BUG_PRIVATE_KEY=0x...   # write actions only",
  "bug --help",
].join("\n");

/**
 * One self-contained bash installer that writes a runnable recon + live triage
 * kit into ./bug-recon-kit/. It wires the standard ProjectDiscovery pipeline
 * (subfinder, httpx, nuclei), port sweep (naabu), URL harvest (gau) and
 * content fuzzing (ffuf) behind Docker so there's nothing to install but Docker.
 * `target` is sanitised into a bare hostname before interpolation.
 */
export function reconKitInstaller(rawTarget: string): string {
  const target = (rawTarget || "example.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/[^A-Za-z0-9.-]/g, "") || "example.com";

  const dockerfile = `FROM golang:1.23-alpine AS build
RUN apk add --no-cache git ca-certificates \\
 && go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \\
 && go install github.com/projectdiscovery/httpx/cmd/httpx@latest \\
 && go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest \\
 && go install github.com/projectdiscovery/naabu/v2/cmd/naabu@latest \\
 && go install github.com/ffuf/ffuf/v2@latest \\
 && go install github.com/lc/gau/v2/cmd/gau@latest

FROM alpine:3.20
RUN apk add --no-cache ca-certificates bind-tools curl jq libpcap
COPY --from=build /go/bin/ /usr/local/bin/
WORKDIR /work
COPY recon.sh /usr/local/bin/recon
RUN chmod +x /usr/local/bin/recon
ENTRYPOINT ["/usr/local/bin/recon"]
`;

  const reconSh = `#!/bin/sh
# $SWARM recon + live triage pipeline. Only run against targets you are
# authorised to test: a live $SWARM program's scope is your safe harbour.
set -eu
TARGET="\${1:-\${TARGET:-${target}}}"
OUT="\${OUT:-/work/out}"
mkdir -p "$OUT"
echo "[*] target: $TARGET  ->  $OUT"

echo "[1/5] subdomains (subfinder)"
subfinder -silent -d "$TARGET" | sort -u > "$OUT/subs.txt" || true
echo "      $(wc -l < "$OUT/subs.txt") hosts"

echo "[2/5] live hosts (httpx)"
httpx -silent -l "$OUT/subs.txt" -title -status-code -tech-detect -json > "$OUT/httpx.json" || true
httpx -silent -l "$OUT/subs.txt" > "$OUT/live.txt" || true

echo "[3/5] port sweep (naabu, top 1000)"
naabu -silent -l "$OUT/subs.txt" -top-ports 1000 > "$OUT/ports.txt" || true

echo "[4/5] historical URLs (gau)"
gau --threads 5 "$TARGET" 2>/dev/null | sort -u > "$OUT/urls.txt" || true

echo "[5/5] vuln templates (nuclei)"
nuclei -silent -l "$OUT/live.txt" -severity low,medium,high,critical -json-export "$OUT/nuclei.json" || true

echo "[done] artifacts in $OUT. Feed nuclei.json into a \$SWARM report."
`;

  const compose = `# docker compose run --rm recon ${target}
services:
  recon:
    build: .
    environment:
      TARGET: ${target}
      OUT: /work/out
    volumes:
      - ./out:/work/out
`;

  const readme = `# $SWARM recon + live triage kit: ${target}

A no setup ProjectDiscovery pipeline. You only need Docker.

## Run
    docker compose build
    docker compose run --rm recon ${target}
    # or against another in scope host:
    docker compose run --rm recon sub.${target}

Artifacts land in ./out/:
- subs.txt: discovered subdomains
- live.txt: responsive hosts
- httpx.json: titles, status, detected tech
- ports.txt: open ports (top 1000)
- urls.txt: historical URLs (wayback/gau)
- nuclei.json: template matches, low to critical

## Authorisation
Run this **only** against assets a live $SWARM program lists in scope. The
program's onchain scope hash + safe-harbour text is your authorisation; anything
outside it is not covered. When you find something, encrypt the report on the
/tools page, publish the ciphertext, and submit the commit on chain.
`;

  // Emit a single installer that recreates the files, so it's one clean download.
  const heredoc = (name: string, body: string) =>
    `mkdir -p bug-recon-kit && cat > "bug-recon-kit/${name}" <<'BUGEOF'\n${body}BUGEOF\n`;

  return `#!/bin/sh
# $SWARM recon kit installer: writes ./bug-recon-kit/ then prints next steps.
set -eu
${heredoc("Dockerfile", dockerfile)}${heredoc("recon.sh", reconSh)}${heredoc("docker-compose.yml", compose)}${heredoc("README.md", readme)}chmod +x bug-recon-kit/recon.sh 2>/dev/null || true
echo "[\\$SWARM] wrote ./bug-recon-kit/ (Dockerfile, recon.sh, docker-compose.yml, README.md)"
echo "[\\$SWARM] next:  cd bug-recon-kit && docker compose build && docker compose run --rm recon ${target}"
`;
}
