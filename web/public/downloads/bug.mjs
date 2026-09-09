#!/usr/bin/env node
// $BUG offline toolkit — zero dependencies, Node 20+.
//
//   bug checksum <file>              sha256 of a file, as 0x… (the exact value
//                                    a tool publisher commits on chain)
//   bug verify   <file> <0xhash>     recompute + compare (verify a download)
//   bug salt                         random 32-byte hex (commit salt)
//   bug encrypt  <file> [--pass p]   AES-GCM/PBKDF2 envelope (→ file.enc.json)
//   bug decrypt  <file.enc.json>     decrypt an envelope (--pass p / BUG_PASS)
//   bug mcp-config [--bounty x] [--chain c] [--rpc r]
//
// The encrypt/decrypt envelope and the checksum are byte-for-byte identical to
// the in-browser tools at /tools, so files move freely between them. Chain
// actions (submit, publish, triage, claim) live in the full CLI — `npm i -g
// @bug-protocol/cli` — and the MCP server, which need a signer.

import { createHash, pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const cmd = (argv[0] || "help").toLowerCase();
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const die = (msg) => {
  console.error(`bug: ${msg}`);
  process.exit(1);
};

const PBKDF2_ITERS = 200_000;

function encrypt(plaintext, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, PBKDF2_ITERS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  // WebCrypto appends the 16-byte tag to the ciphertext; match that layout.
  return {
    v: 1,
    alg: "AES-GCM/PBKDF2-SHA256",
    iterations: PBKDF2_ITERS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([ct, tag]).toString("base64"),
  };
}

function decrypt(env, passphrase) {
  const data = Buffer.from(env.ciphertext, "base64");
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const key = pbkdf2Sync(
    Buffer.from(passphrase, "utf8"),
    Buffer.from(env.salt, "base64"),
    env.iterations ?? PBKDF2_ITERS,
    32,
    "sha256",
  );
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function needPass() {
  const p = opt("pass") ?? process.env.BUG_PASS;
  if (!p) die("passphrase required: pass --pass <secret> or set BUG_PASS");
  return p;
}

switch (cmd) {
  case "checksum": {
    const file = positional[0] || die("usage: bug checksum <file>");
    console.log("0x" + createHash("sha256").update(readFileSync(file)).digest("hex"));
    break;
  }
  case "verify": {
    const file = positional[0];
    const expected = (positional[1] || "").toLowerCase().replace(/^0x/, "");
    if (!file || !expected) die("usage: bug verify <file> <0xchecksum>");
    const got = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (got === expected) {
      console.log(`OK  ${basename(file)}  0x${got}`);
    } else {
      console.error(`MISMATCH\n  expected 0x${expected}\n  got      0x${got}`);
      process.exit(2);
    }
    break;
  }
  case "salt": {
    console.log("0x" + randomBytes(32).toString("hex"));
    break;
  }
  case "encrypt": {
    const file = positional[0] || die("usage: bug encrypt <file> [--pass p] [--out f]");
    const out = opt("out") || `${file}.enc.json`;
    const env = encrypt(readFileSync(file, "utf8"), needPass());
    writeFileSync(out, JSON.stringify(env, null, 2));
    console.log(`encrypted → ${out}`);
    break;
  }
  case "decrypt": {
    const file = positional[0] || die("usage: bug decrypt <file.enc.json> [--pass p] [--out f]");
    const env = JSON.parse(readFileSync(file, "utf8"));
    let plain;
    try {
      plain = decrypt(env, needPass());
    } catch {
      die("decryption failed — wrong passphrase or corrupt envelope");
    }
    const out = opt("out");
    if (out) {
      writeFileSync(out, plain);
      console.log(`decrypted → ${out}`);
    } else {
      process.stdout.write(plain + "\n");
    }
    break;
  }
  case "mcp-config": {
    const cfg = {
      mcpServers: {
        "bug-protocol": {
          command: "npx",
          args: ["-y", "@bug-protocol/mcp"],
          env: {
            BOUNTY_ADDRESS: opt("bounty") || "0xYourDeployedBugBountyContract",
            CHAIN: opt("chain") || "robinhood",
            RPC_URL: opt("rpc") || "https://rpc.mainnet.chain.robinhood.com",
            PRIVATE_KEY: "0xyour_hunter_key_for_write_actions",
          },
        },
      },
    };
    console.log(JSON.stringify(cfg, null, 2));
    break;
  }
  default:
    console.log(
      [
        "$BUG offline toolkit — zero dependencies, Node 20+.",
        "",
        "  bug checksum <file>            sha256 as 0x… (publish/verify a tool)",
        "  bug verify   <file> <0xhash>   recompute + compare a download",
        "  bug salt                       random 32-byte commit salt",
        "  bug encrypt  <file> [--pass p] AES-GCM report envelope → file.enc.json",
        "  bug decrypt  <file.enc.json>   decrypt (--pass p or BUG_PASS)",
        "  bug mcp-config [--bounty x] [--chain c] [--rpc r]",
        "",
        "Chain actions (submit, publish, triage, claim): npm i -g @bug-protocol/cli",
        "Docs: https://github.com/allisonbit/bug-protocol",
      ].join("\n"),
    );
}
