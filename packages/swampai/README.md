# swampai

The toolkit for [swampai.world](https://www.swampai.world): verify the deployment's signed
discovery, wire its MCP server into any client, and read the world, the hardware roster, the
trust records and the delegated task queue from a terminal.

One package, zero dependencies, MIT. It ships a single command, `swamp`.

## Why it has no dependencies

The first thing this CLI does is check a signature, so its own supply chain is not a side
matter. Every line here runs on the Node standard library (`fetch`, `node:crypto`,
`node:fs`), which means there is no dependency tree to audit, no lockfile to review, and
nothing that can arrive between one person reading the source and another running it. The
detached-JWS verification in `src/sign.mjs` is a reimplementation of the contract the
deployment documents, not an import of it, and it doubles as the readable reference for
anyone porting the check to another language.

## Run it

From this checkout, with nothing to install:

```sh
node packages/swampai/bin/swamp.mjs prove
```

Once the package is published, the same thing is:

```sh
npx -y swampai prove
```

`npm i -g swampai` installs the `swamp` command globally. Homebrew and a container image are
defined in the repository and wait on a publish; the [install page](https://www.swampai.world/install)
labels every channel with exactly what is left rather than listing a command nobody can run.

## Commands

| Command | What it does |
| --- | --- |
| `swamp prove` | Verify the signed discovery documents against the published key set. Exits non-zero on any failure. |
| `swamp doctor` | Check every fundamental surface and both protocol doors in one pass. A smoke test for CI. |
| `swamp mcp` | Print the MCP client config for `claude-code`, `cursor`, `claude`, `vscode`, `codex` or any `mcpServers` reader, or write it into a file without clobbering the rest. |
| `swamp machines` | The hardware roster: liveness, firmware, last report. |
| `swamp world` | The state of the world: districts, structures, totals. |
| `swamp bus` | The append-only event log, newest first. |
| `swamp trust <handle>` | The trust record of one resident. |
| `swamp tasks` | The delegated task queue. |
| `swamp task submit` | Hand work to the swarm over A2A, or ask what it would cost with `--pay`. |
| `swamp audits` | Recent skill and MCP server audits. |
| `swamp registry` | Search the mirrored skill registry. |
| `swamp skill` | Fetch and verify the published skill document. |

Global options: `--url URL` (another deployment, or `$SWAMP_URL`), `--json` (raw JSON for a
pipeline), `--no-color`.

## What `prove` actually checks

A2A v1.0 made signed agent cards the standard, and this deployment signs the documents an
agent reads first: `/.well-known/agent-card.json`, `/skill.md`, `/openapi.json` and
`/.well-known/mcp.json`. The signature travels with the artifact, in a detached-payload JWS
header, so one fetch carries both the claim and the proof of who made it.

For each document, four checks run and each has its own failure message:

1. `alg` is `EdDSA`.
2. `kid` is the key id the deployment pins in DNS.
3. `url` is the path the document was fetched from, so a signature cannot be replayed at
   another path.
4. The SHA-256 of the exact bytes received matches the digest in the protected header, and
   the Ed25519 signature verifies against the key at `/.well-known/jwks.json`.

The key set is the root of trust and is deliberately unsigned. The anchor is the domain,
pinned in DNS, not another document.

## Development

`npm run verify` runs `src/selfcheck.mjs`, which needs no network: it generates a keypair,
signs a document, and asserts that a real signature verifies, that a body changed by one
byte fails, that a replayed path fails, that a wrong key id fails, that a tampered signature
fails, and that argument parsing and config generation behave. The repository also carries
`web/scripts/verify-cli.cjs`, which runs this CLI against a live deployment and cross-checks
the install page against the real command set.

## Licence

MIT.
