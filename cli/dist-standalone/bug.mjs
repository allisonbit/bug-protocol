#!/usr/bin/env node
/*
 * bug.mjs — single-file $BUG protocol helper for instant download.
 * -----------------------------------------------------------------------------
 * No build step, no install of this package. It has ONE dependency, viem:
 *
 *     npm i viem            # once, anywhere
 *     node bug.mjs programs --chain base
 *
 * Covers the read + offline-crypto commands (programs, program, submission,
 * commit, encrypt, decrypt). For the full loop (submit / reveal / triage /
 * claim / watch) install the complete CLI:  npm i -g @bug-protocol/cli
 *
 * Commit derivation and the AES-GCM/PBKDF2 envelope are byte-for-byte identical
 * to the web app and the full CLI, so receipts and encrypted reports interop.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  createPublicClient,
  http,
  defineChain,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  formatEther,
  formatUnits,
} from "viem";

// ---- chains ------------------------------------------------------------------
const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
const mk = (id, name, rpc) => defineChain({ id, name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

const CHAINS = {
  4663: { chain: robinhood, short: "robinhood", explorer: "https://robinhoodchain.blockscout.com", usdc: null },
  8453: { chain: mk(8453, "Base", "https://mainnet.base.org"), short: "base", explorer: "https://basescan.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  42161: { chain: mk(42161, "Arbitrum One", "https://arb1.arbitrum.io/rpc"), short: "arbitrum", explorer: "https://arbiscan.io", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  10: { chain: mk(10, "Optimism", "https://mainnet.optimism.io"), short: "optimism", explorer: "https://optimistic.etherscan.io", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  84532: { chain: mk(84532, "Base Sepolia", "https://sepolia.base.org"), short: "base-sepolia", explorer: "https://sepolia.basescan.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
};
const NATIVE = "0x0000000000000000000000000000000000000000";

function resolveChain(input) {
  if (!input) return CHAINS[4663];
  const n = Number(input);
  if (CHAINS[n]) return CHAINS[n];
  const hit = Object.values(CHAINS).find((c) => c.short === String(input).toLowerCase());
  if (!hit) throw new Error(`unknown chain "${input}"`);
  return hit;
}

function assetInfo(meta, token) {
  const t = String(token).toLowerCase();
  if (t === NATIVE) return { symbol: "ETH", decimals: 18 };
  if (meta.usdc && t === meta.usdc.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  return { symbol: "TOKEN", decimals: 18 };
}
const fmt = (v, d = 18, s = "") => {
  const str = d === 18 ? formatEther(v) : formatUnits(v, d);
  const t = str.includes(".") ? str.replace(/\.?0+$/, "") : str;
  return s ? `${t} ${s}` : t;
};

// ---- ABI (reads only) --------------------------------------------------------
const abi = [
  { type: "function", name: "nextProgramId", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "bugToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "topTier", inputs: [{ name: "p", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "pendingCount", inputs: [{ name: "p", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "payoutOf", inputs: [{ name: "p", type: "uint256" }, { name: "s", type: "uint8" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "getProgram", inputs: [{ name: "p", type: "uint256" }], stateMutability: "view",
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "rewardToken", type: "address" }, { name: "scopeHash", type: "bytes32" },
      { name: "triageDeadline", type: "uint64" }, { name: "disclosureDelay", type: "uint64" }, { name: "status", type: "uint8" },
      { name: "pool", type: "uint256" }, { name: "locked", type: "uint256" }, { name: "bond", type: "uint256" }, { name: "scopeURI", type: "string" },
    ] }],
  },
  {
    type: "function", name: "getSubmission", inputs: [{ name: "s", type: "uint256" }], stateMutability: "view",
    outputs: [{ type: "tuple", components: [
      { name: "programId", type: "uint96" }, { name: "hunter", type: "address" }, { name: "commitHash", type: "bytes32" },
      { name: "submittedAt", type: "uint64" }, { name: "triagedAt", type: "uint64" }, { name: "status", type: "uint8" },
      { name: "severity", type: "uint8" }, { name: "bond", type: "uint256" }, { name: "award", type: "uint256" },
      { name: "dupeOf", type: "uint256" }, { name: "reportURI", type: "string" },
    ] }],
  },
];
const STATUS = ["Draft", "Live", "Paused", "Closed"];
const SUBSTATUS = ["Pending", "Accepted", "Rejected", "Duplicate", "Spam", "Escalated", "Resolved"];
const SEV = ["None", "Low", "Medium", "High", "Critical"];

// ---- crypto (interop with web app + full CLI) --------------------------------
const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
function randomSalt() {
  const b = new Uint8Array(32);
  webcrypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function commitmentFor(uri, salt, hunter) {
  return keccak256(encodeAbiParameters(parseAbiParameters("string, bytes32, address"), [uri, salt, hunter]));
}
async function encryptReport(plaintext, pass) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(16), iv = new Uint8Array(12);
  webcrypto.getRandomValues(salt); webcrypto.getRandomValues(iv);
  const km = await webcrypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return JSON.stringify({ v: 1, alg: "AES-GCM/PBKDF2-SHA256", iterations: 200000, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) }, null, 2);
}
async function decryptReport(json, pass) {
  const env = JSON.parse(json);
  const enc = new TextEncoder();
  const km = await webcrypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64(env.salt), iterations: env.iterations ?? 200000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ciphertext));
  return new TextDecoder().decode(pt);
}

// ---- arg parsing -------------------------------------------------------------
function parseArgs(argv) {
  const positionals = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positionals.push(a);
  }
  return { positionals, flags };
}
function client(flags) {
  const meta = resolveChain(flags.chain ?? process.env.BUG_CHAIN);
  const rpc = flags.rpc ?? process.env.BUG_RPC_URL ?? meta.chain.rpcUrls.default.http[0];
  return { meta, pc: createPublicClient({ chain: meta.chain, transport: http(rpc) }) };
}
function bounty(flags) {
  const a = flags.bounty ?? process.env.BUG_BOUNTY_ADDRESS;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("pass --bounty 0x… or set BUG_BOUNTY_ADDRESS");
  return a;
}

const HELP = `bug.mjs — $BUG protocol single-file helper (read + crypto)

  node bug.mjs programs            --chain base --bounty 0x..
  node bug.mjs program <id>        --chain base --bounty 0x..
  node bug.mjs submission <id>     --chain base --bounty 0x..
  node bug.mjs commit --uri <uri> --hunter 0x.. [--salt 0x..] [--out f]
  node bug.mjs encrypt <file> --pass <p> [--out f]
  node bug.mjs decrypt <file> --pass <p> [--out f]

Full loop (submit/reveal/triage/claim/watch):  npm i -g @bug-protocol/cli`;

// ---- main --------------------------------------------------------------------
async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  if (!cmd || cmd === "help" || flags.help) return console.log(HELP);

  if (cmd === "programs") {
    const { meta, pc } = client(flags);
    const addr = bounty(flags);
    const n = await pc.readContract({ address: addr, abi, functionName: "nextProgramId" });
    if (n === 0n) return console.log(`no programs on ${meta.chain.name}`);
    for (let i = 0n; i < n; i++) {
      const [p, top] = await Promise.all([
        pc.readContract({ address: addr, abi, functionName: "getProgram", args: [i] }),
        pc.readContract({ address: addr, abi, functionName: "topTier", args: [i] }),
      ]);
      const a = assetInfo(meta, p.rewardToken);
      console.log(`#${i}  ${STATUS[p.status]}  owner ${p.owner.slice(0, 8)}…  escrow ${fmt(p.pool, a.decimals, a.symbol)}  top ${fmt(top, a.decimals, a.symbol)}`);
    }
    return;
  }

  if (cmd === "program") {
    const id = BigInt(positionals[1]);
    const { meta, pc } = client(flags);
    const addr = bounty(flags);
    const p = await pc.readContract({ address: addr, abi, functionName: "getProgram", args: [id] });
    const a = assetInfo(meta, p.rewardToken);
    const [pending, ...tiers] = await Promise.all([
      pc.readContract({ address: addr, abi, functionName: "pendingCount", args: [id] }),
      pc.readContract({ address: addr, abi, functionName: "payoutOf", args: [id, 1] }),
      pc.readContract({ address: addr, abi, functionName: "payoutOf", args: [id, 2] }),
      pc.readContract({ address: addr, abi, functionName: "payoutOf", args: [id, 3] }),
      pc.readContract({ address: addr, abi, functionName: "payoutOf", args: [id, 4] }),
    ]);
    console.log(`Program #${id} on ${meta.chain.name}`);
    console.log(`  status ${STATUS[p.status]} · owner ${p.owner}`);
    console.log(`  reward ${a.symbol} · escrow ${fmt(p.pool, a.decimals, a.symbol)} · locked ${fmt(p.locked, a.decimals, a.symbol)}`);
    console.log(`  client bond ${fmt(p.bond, 18, "$BUG")} · open reports ${pending}`);
    console.log(`  tiers Low ${fmt(tiers[0], a.decimals)} / Med ${fmt(tiers[1], a.decimals)} / High ${fmt(tiers[2], a.decimals)} / Critical ${fmt(tiers[3], a.decimals)} ${a.symbol}`);
    console.log(`  scope ${p.scopeURI || "—"}  (hash ${p.scopeHash})`);
    return;
  }

  if (cmd === "submission") {
    const id = BigInt(positionals[1]);
    const { meta, pc } = client(flags);
    const addr = bounty(flags);
    const s = await pc.readContract({ address: addr, abi, functionName: "getSubmission", args: [id] });
    const p = await pc.readContract({ address: addr, abi, functionName: "getProgram", args: [s.programId] });
    const a = assetInfo(meta, p.rewardToken);
    console.log(`Submission #${id} on ${meta.chain.name}`);
    console.log(`  program #${s.programId} · ${SUBSTATUS[s.status]} · ${SEV[s.severity]}`);
    console.log(`  hunter ${s.hunter}`);
    console.log(`  commit ${s.commitHash}`);
    console.log(`  report ${s.reportURI || "(not revealed)"}`);
    console.log(`  award ${s.award > 0n ? fmt(s.award, a.decimals, a.symbol) : "—"} · bond ${fmt(s.bond, 18, "$BUG")}`);
    return;
  }

  if (cmd === "commit") {
    const uri = flags.uri;
    const hunter = flags.hunter;
    if (!uri || !hunter) throw new Error("commit needs --uri <uri> --hunter <address>");
    const salt = flags.salt ?? randomSalt();
    const commitHash = commitmentFor(uri, salt, hunter);
    const receipt = { kind: "bug-protocol-commit-receipt", version: 1, programId: flags.program ?? "", hunter, reportURI: uri, salt, commitHash, createdAt: new Date().toISOString(), note: "Keep this file safe and secret. The salt is required to reveal your report." };
    const out = flags.out ?? `bug-commit-receipt-${Date.now()}.json`;
    writeFileSync(out, JSON.stringify(receipt, null, 2));
    console.log(`salt        ${salt}`);
    console.log(`commit hash ${commitHash}`);
    console.log(`receipt     ${out}`);
    return;
  }

  if (cmd === "encrypt") {
    const file = positionals[1];
    if (!file || !flags.pass) throw new Error("encrypt needs <file> --pass <passphrase>");
    const out = flags.out ?? `${file}.enc.json`;
    writeFileSync(out, await encryptReport(readFileSync(file, "utf8"), flags.pass));
    console.log(`encrypted ${out}`);
    return;
  }

  if (cmd === "decrypt") {
    const file = positionals[1];
    if (!file || !flags.pass) throw new Error("decrypt needs <file> --pass <passphrase>");
    const pt = await decryptReport(readFileSync(file, "utf8"), flags.pass);
    if (flags.out) { writeFileSync(flags.out, pt); console.log(`decrypted ${flags.out}`); }
    else console.log(pt);
    return;
  }

  console.error(`unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => { console.error("✗ " + (e?.shortMessage ?? e?.message ?? String(e))); process.exitCode = 1; });
