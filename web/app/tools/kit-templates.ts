/**
 * Pure, framework-free generators for the /tools "connect & download" panel.
 * No "use client". These are just string/JSON builders the client imports.
 * Everything here is content a hunter or AI agent copies or downloads to wire
 * the protocol into their own stack: an MCP config, CLI usage, and a runnable
 * recon + live-triage kit.
 */

export const MCP_PACKAGE = "@bug-protocol/mcp";
export const CLI_PACKAGE = "@bug-protocol/cli";
export const REPO_URL = "https://github.com/allisonbit/bug-protocol";

/** The MCP server config block, to drop into Claude Desktop or any MCP client. */
export function mcpConfig(opts: { bounty?: string; chain?: string; rpc?: string }) {
  const bounty = opts.bounty?.trim() || "0xYourDeployedBugBountyContract";
  const chain = opts.chain?.trim() || "robinhood";
  const rpc = opts.rpc?.trim() || "https://rpc.mainnet.chain.robinhood.com";
  return {
    mcpServers: {
      "bug-protocol": {
        command: "npx",
        args: ["-y", MCP_PACKAGE],
        env: {
          BOUNTY_ADDRESS: bounty,
          CHAIN: chain,
          RPC_URL: rpc,
          PRIVATE_KEY: "0xyour_hunter_key_for_write_actions",
        },
      },
    },
  };
}

/** The 14 tools the MCP server exposes, for the "what an agent can do" list. */
export const MCP_TOOLS: { name: string; write: boolean; desc: string }[] = [
  { name: "protocol_info", write: false, desc: "Protocol config + active chain metadata." },
  { name: "list_programs", write: false, desc: "List programs: status, owner, pool, top tier, scope." },
  { name: "get_program", write: false, desc: "Full detail for one program incl. payout tiers." },
  { name: "get_submission", write: false, desc: "Full detail for one submission incl. triage state." },
  { name: "compute_commit", write: false, desc: "Derive salt + commit hash off-chain." },
  { name: "encrypt_report", write: false, desc: "AES-GCM/PBKDF2 encrypt a report body." },
  { name: "decrypt_report", write: false, desc: "Decrypt a report envelope." },
  { name: "submit_finding", write: true, desc: "Submit a commit on-chain (auto-approves bond)." },
  { name: "reveal_report", write: true, desc: "Reveal reportURI + salt to unlock payout." },
  { name: "triage", write: true, desc: "Owner verdict: accept/reject/duplicate/spam." },
  { name: "escalate", write: true, desc: "Escalate to the arbiter." },
  { name: "resolve_escalation", write: true, desc: "Arbiter ruling on an escalated submission." },
  { name: "claim", write: true, desc: "Withdraw credited rewards (pull-payment)." },
  { name: "withdraw_bond", write: true, desc: "Withdraw refundable $BUG bond credit." },
];

/**
 * One self-contained bash installer that writes a runnable recon + live-triage
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
# $BUG recon + live-triage pipeline. Only run against targets you are
# authorised to test: a live $BUG program's scope is your safe harbour.
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

echo "[done] artifacts in $OUT. Feed nuclei.json into a \$BUG report."
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

  const readme = `# $BUG recon + live-triage kit: ${target}

A zero-install ProjectDiscovery pipeline. You only need Docker.

## Run
    docker compose build
    docker compose run --rm recon ${target}
    # or against another in-scope host:
    docker compose run --rm recon sub.${target}

Artifacts land in ./out/:
- subs.txt: discovered subdomains
- live.txt: responsive hosts
- httpx.json: titles, status, detected tech
- ports.txt: open ports (top 1000)
- urls.txt: historical URLs (wayback/gau)
- nuclei.json: template matches, low to critical

## Authorisation
Run this **only** against assets a live $BUG program lists in scope. The
program's on-chain scope hash + safe-harbour text is your authorisation; anything
outside it is not covered. When you find something, encrypt the report on the
/tools page, publish the ciphertext, and submit the commit on chain.
`;

  // Emit a single installer that recreates the files, so it's one clean download.
  const heredoc = (name: string, body: string) =>
    `mkdir -p bug-recon-kit && cat > "bug-recon-kit/${name}" <<'BUGEOF'\n${body}BUGEOF\n`;

  return `#!/bin/sh
# $BUG recon kit installer: writes ./bug-recon-kit/ then prints next steps.
set -eu
${heredoc("Dockerfile", dockerfile)}${heredoc("recon.sh", reconSh)}${heredoc("docker-compose.yml", compose)}${heredoc("README.md", readme)}chmod +x bug-recon-kit/recon.sh 2>/dev/null || true
echo "[\\$BUG] wrote ./bug-recon-kit/ (Dockerfile, recon.sh, docker-compose.yml, README.md)"
echo "[\\$BUG] next:  cd bug-recon-kit && docker compose build && docker compose run --rm recon ${target}"
`;
}
