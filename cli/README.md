# bug-cli

The **$BUG bug-bounty protocol** from your terminal. Fund programs, hunt, commit-reveal findings, triage, and claim rewards on any EVM chain. **ETH or USDC, no `$BUG` token required.**

`bug-cli` speaks directly to the on-chain `BugBounty` contract with [viem](https://viem.sh). Report bodies never touch the chain: you commit a hash, encrypt the report with a passphrase, publish only the ciphertext, and reveal after triage. Commit derivation and the encryption envelope are **byte-for-byte identical to the web app**, so a receipt or encrypted report made in one works in the other.

---

## Install

```bash
npm i -g @bug-protocol/cli      # then: bug --help
# or run without installing:
npx @bug-protocol/cli programs --chain base --bounty 0x...
```

Requires **Node 20+**.

Prefer a single file with no install? Grab **`bug.mjs`** from the web /tools page (or `cli/dist-standalone/bug.mjs` in this repo). It needs only `npm i viem` and covers the read + crypto commands. See [Single-file helper](#single-file-helper).

---

## Configuration

Everything is set with flags or environment variables. Flags win; env is the convenient default.

| Flag | Env | Meaning |
| --- | --- | --- |
| `--chain <id\|name>` | `BUG_CHAIN` | Chain to talk to. Default `robinhood`. |
| `--rpc <url>` | `BUG_RPC_URL` | RPC override. Defaults to the chain's public RPC. |
| `--bounty <address>` | `BUG_BOUNTY_ADDRESS` | The `BugBounty` contract address. |
| `--key <hex>` | `BUG_PRIVATE_KEY` | Signer private key. **Only needed for write commands.** |

Per-chain contract addresses can also be set as `BUG_BOUNTY_<chainId>` (e.g. `BUG_BOUNTY_8453`), which takes effect when you switch chains without passing `--bounty`.

**Supported chains** (`--chain` accepts the id or the short name):

| Name | Id | Native | USDC |
| --- | --- | --- | --- |
| `robinhood` (default) | 4663 | ETH | no |
| `base` | 8453 | ETH | yes |
| `arbitrum` | 42161 | ETH | yes |
| `optimism` | 10 | ETH | yes |
| `base-sepolia` | 84532 | ETH | yes (testnet) |

A typical setup:

```bash
export BUG_CHAIN=base
export BUG_BOUNTY_ADDRESS=0xYourBugBountyContract
export BUG_PRIVATE_KEY=0xabc...        # only for submit/reveal/triage/claim
```

> **Never** paste a private key you care about into a shared machine. Use a throwaway hunting wallet. `--key`/`BUG_PRIVATE_KEY` is read only for the write commands below; every read and offline command works without it.

---

## Commands

### Reads (no key needed)

**`bug programs`**: list every program on the chain.

```bash
bug programs --chain base --bounty 0x...
```

**`bug program <id>`**: full detail for one program (status, escrow, tiers, scope, SLA).

```bash
bug program 0
```

**`bug submission <id>`**: full detail for one submission (status, severity, commit, award).

```bash
bug submission 12
```

**`bug claims <account>`**: what an address can withdraw, unclaimed rewards plus returned bond credit.

```bash
bug claims 0xHunter...
```

**`bug watch`**: poll the chain and print new programs, new submissions, and triage transitions as they happen.

```bash
bug watch --interval 10          # seconds; Ctrl-C to stop
```

### Offline tools (no key, no chain)

**`bug commit`**: derive a salt + commit hash and save a receipt, without sending anything. Useful to prepare a submission or verify a hash.

```bash
bug commit --uri "ipfs://Qm.../report.enc.json" --hunter 0xHunter... --program 0
# prints salt + commit hash, writes bug-commit-receipt-*.json
```

**`bug encrypt <file>`**: AES-GCM encrypt a report file. Publish the output as your `reportURI`; share the passphrase with the client over a side channel.

```bash
bug encrypt report.md --pass "correct horse battery staple" --out report.enc.json
```

**`bug decrypt <file>`**: decrypt an envelope produced by `encrypt` (or by the web app).

```bash
bug decrypt report.enc.json --pass "correct horse battery staple"
```

### The hunt / triage loop (needs a signer)

**`bug submit <programId>`**: commit a finding on chain. The receipt (with your salt) is **saved to disk before the transaction is sent**, so a committed report can never be stranded by a lost salt.

```bash
bug submit 0 --uri "ipfs://Qm.../report.enc.json"
# saves receipt, sends commit, prints the exact `bug reveal ...` to run later
```

**`bug reveal <submissionId>`**: reveal a committed report after triage. `--uri` and `--salt` must exactly match the commit (they're in your receipt).

```bash
bug reveal 12 --uri "ipfs://Qm.../report.enc.json" --salt 0x<32 bytes>
```

**`bug triage <submissionId>`**: program owner records a verdict.

```bash
bug triage 12 --verdict accept --severity high     # accept | reject | duplicate | spam
bug triage 13 --verdict duplicate --dupe 12        # --dupe required for duplicate
```

`--severity` (`low|medium|high|critical`) is required when accepting; `--dupe <id>` is required for a duplicate.

**`bug claim`**: pull rewards owed to you.

```bash
bug claim                         # native coin to your address
bug claim --token 0xUSDC... --to 0xElsewhere...
```

**`bug withdraw-bond`**: withdraw your returned anti-spam bond credit.

```bash
bug withdraw-bond
```

---

## End-to-end example (a hunter)

```bash
export BUG_CHAIN=base
export BUG_BOUNTY_ADDRESS=0xYourBugBountyContract
export BUG_PRIVATE_KEY=0xHunterKey...

# 1. Find a program and read its scope.
bug programs
bug program 0

# 2. Write your report, then encrypt it and publish the ciphertext (IPFS, gist, S3...).
bug encrypt report.md --pass "shared-with-client" --out report.enc.json
#    upload report.enc.json, note its URL as <reportURI>

# 3. Commit on chain (receipt with your salt is saved first).
bug submit 0 --uri "<reportURI>"
#    submission #12, and the reveal command to run later

# 4. After the owner triages, reveal.
bug reveal 12 --uri "<reportURI>" --salt 0x<from receipt>

# 5. Get paid.
bug claims 0xHunter...
bug claim
```

---

## Single-file helper

`cli/dist-standalone/bug.mjs` is a dependency-light, self-contained script for instant download, with no package install and no build step. It covers `programs`, `program`, `submission`, `commit`, `encrypt`, and `decrypt`, with the same commit/encryption format as the full CLI and the web app.

```bash
npm i viem                                   # its only dependency
node bug.mjs programs --chain base --bounty 0x...
node bug.mjs encrypt report.md --pass "..."  # offline, interops with the web app
node bug.mjs --help
```

For the full write loop (`submit`/`reveal`/`triage`/`claim`/`watch`), install the complete CLI: `npm i -g @bug-protocol/cli`.

---

## How the protocol keeps reports private

1. **Encrypt** the report body; publish only the ciphertext as `reportURI`.
2. **Commit** `keccak256(abi.encode(reportURI, salt, hunter))`: the plaintext, and even the ciphertext's contents, stay off-chain.
3. The program owner **triages** blind against the commit and the scope.
4. **Reveal** binds the exact `reportURI` + `salt` to your address; the contract recomputes the hash and pays out from escrow in the **same transaction** as acceptance. Escrow the client has funded cannot be reclaimed once earned.

No `$BUG` token is involved in payments. Programs pay in whatever they escrow (native ETH or USDC today). The `$BUG` token, when present, is only used for the optional anti-spam submission bond.

---

## Develop

```bash
npm install
npm run build      # tsc to dist/
npm run dev -- programs --chain base --bounty 0x...   # tsx, no build
```

## License

MIT
