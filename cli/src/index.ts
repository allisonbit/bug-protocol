#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { isAddress, type Address } from "viem";
import { resolveCtx, requireSigner, type Ctx, type GlobalOpts } from "./config.js";
import {
  claimRewards,
  getProgramFull,
  getSubmission,
  getProgram,
  getClaims,
  listPrograms,
  protocolMeta,
  revealFinding,
  submitFinding,
  triageSubmission,
  withdrawBond,
} from "./actions.js";
import { assetInfo, chainMeta, NATIVE, txUrlOn } from "./chains.js";
import { buildReceipt, normalizeSalt, randomSalt } from "./commit.js";
import { decryptReport, encryptReport } from "./crypto.js";
import { fmtAmount, fmtDate, humanDuration, severityName, short, statusName, subStatusName, table } from "./format.js";
import { SEVERITY_INDEX, VERDICT } from "./abi.js";

const program = new Command();

program
  .name("bug")
  .description("bug-cli: the $SWARM bug-bounty protocol from your terminal. Works on any EVM chain, ETH or USDC, no $SWARM token required.")
  .version("0.1.0")
  .option("--chain <id|name>", "chain id or name: robinhood, base, arbitrum, optimism, base-sepolia (env BUG_CHAIN)")
  .option("--rpc <url>", "RPC URL override (env BUG_RPC_URL)")
  .option("--bounty <address>", "BugBounty contract address (env BUG_BOUNTY_ADDRESS)")
  .option("--key <hex>", "signer private key for write commands (env BUG_PRIVATE_KEY)");

function ctxFrom(cmd: Command): Ctx {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return resolveCtx({ chain: g.chain, rpc: g.rpc, bounty: g.bounty, key: g.key });
}

// Wrap an action so viem/validation errors print cleanly instead of a stack trace.
function action<A extends unknown[]>(fn: (...a: A) => Promise<void>) {
  return async (...a: A) => {
    try {
      await fn(...a);
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      console.error("error: " + (err.shortMessage ?? err.message ?? String(e)));
      process.exitCode = 1;
    }
  };
}

function printTx(ctx: Ctx, label: string, hash: string) {
  console.log(`ok: ${label}`);
  console.log(`  tx:  ${hash}`);
  console.log(`  see: ${txUrlOn(ctx.meta.chain.id, hash)}`);
}

// ---- reads -------------------------------------------------------------------

program
  .command("programs")
  .description("list every program on the chain")
  .action(
    action(async (_opts: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const [meta, programs] = await Promise.all([protocolMeta(ctx), listPrograms(ctx)]);
      if (programs.length === 0) {
        console.log(`no programs yet on ${ctx.meta.label}.`);
        return;
      }
      const rows = programs.map((p) => {
        const a = assetInfo(ctx.meta.chain.id, p.program.rewardToken, meta.bugToken);
        return [
          String(p.id),
          statusName(p.program.status),
          short(p.program.owner),
          fmtAmount(p.program.pool, a.decimals, a.symbol),
          fmtAmount(p.topTier, a.decimals, a.symbol),
          String(p.pending),
        ];
      });
      console.log(`${ctx.meta.label}, ${programs.length} program(s)\n`);
      console.log(table(["#", "status", "owner", "escrow", "top tier", "open"], rows));
    }),
  );

program
  .command("program <id>")
  .description("show full detail for one program")
  .action(
    action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const [meta, full] = await Promise.all([protocolMeta(ctx), getProgramFull(ctx, BigInt(id))]);
      const p = full.program;
      const a = assetInfo(ctx.meta.chain.id, p.rewardToken, meta.bugToken);
      console.log(`Program #${id} (${ctx.meta.label})`);
      console.log(`  status:        ${statusName(p.status)}`);
      console.log(`  owner:         ${p.owner}`);
      console.log(`  reward asset:  ${a.symbol} (${p.rewardToken === NATIVE ? "native" : p.rewardToken})`);
      console.log(`  escrow pool:   ${fmtAmount(p.pool, a.decimals, a.symbol)}`);
      console.log(`  locked:        ${fmtAmount(p.locked, a.decimals, a.symbol)}`);
      console.log(`  free pool:     ${fmtAmount(full.freePool, a.decimals, a.symbol)}`);
      console.log(`  client bond:   ${fmtAmount(p.bond, 18, "$SWARM")}`);
      console.log(`  open reports:  ${full.pending}`);
      console.log(`  triage SLA:    ${humanDuration(p.triageDeadline)}`);
      console.log(`  disclosure:    ${humanDuration(p.disclosureDelay)} after triage`);
      console.log(`  scope hash:    ${p.scopeHash}`);
      console.log(`  scope URI:     ${p.scopeURI || "n/a"}`);
      console.log(`  tiers:         Low ${fmtAmount(full.tiers[1], a.decimals)}, Med ${fmtAmount(full.tiers[2], a.decimals)}, High ${fmtAmount(full.tiers[3], a.decimals)}, Critical ${fmtAmount(full.tiers[4], a.decimals)} ${a.symbol}`);
    }),
  );

program
  .command("submission <id>")
  .description("show full detail for one submission")
  .action(
    action(async (id: string, _opts: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const s = await getSubmission(ctx, BigInt(id));
      const [meta, prog] = await Promise.all([protocolMeta(ctx), getProgram(ctx, s.programId)]);
      const a = assetInfo(ctx.meta.chain.id, prog.rewardToken, meta.bugToken);
      console.log(`Submission #${id} (${ctx.meta.label})`);
      console.log(`  program:       #${s.programId}`);
      console.log(`  status:        ${subStatusName(s.status)}`);
      console.log(`  severity:      ${severityName(s.severity)}`);
      console.log(`  hunter:        ${s.hunter}`);
      console.log(`  submitted:     ${fmtDate(s.submittedAt)}`);
      console.log(`  triaged:       ${s.triagedAt > 0n ? fmtDate(s.triagedAt) : "n/a"}`);
      console.log(`  commit hash:   ${s.commitHash}`);
      console.log(`  report URI:    ${s.reportURI || "(not revealed; body still private)"}`);
      console.log(`  award:         ${s.award > 0n ? fmtAmount(s.award, a.decimals, a.symbol) : "n/a"}`);
      console.log(`  anti-spam bond:${" "}${fmtAmount(s.bond, 18, "$SWARM")}`);
      if (s.dupeOf > 0n) console.log(`  duplicate of:  #${s.dupeOf}`);
    }),
  );

program
  .command("claims <account>")
  .description("show what an account can claim (rewards + bond credit)")
  .action(
    action(async (account: string, _opts: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      if (!isAddress(account)) throw new Error("account must be an address");
      const { claimableNative, bondCredit } = await getClaims(ctx, account as Address);
      const sym = ctx.meta.chain.nativeCurrency.symbol;
      console.log(`Claims for ${short(account)} on ${ctx.meta.label}`);
      console.log(`  claimable rewards: ${fmtAmount(claimableNative, 18, sym)}`);
      console.log(`  bond credit:       ${fmtAmount(bondCredit, 18, "$SWARM")}`);
    }),
  );

// ---- offline tools (no chain / no key) --------------------------------------

program
  .command("commit")
  .description("derive a salt + commit hash and save a receipt (offline)")
  .requiredOption("--uri <reportURI>", "the exact report URI bound into the commit")
  .option("--salt <hex>", "reuse a specific 32-byte salt instead of a random one")
  .option("--hunter <address>", "hunter address (defaults to the address of --key/BUG_PRIVATE_KEY)")
  .option("--program <id>", "program id to record in the receipt", "")
  .option("--out <file>", "receipt output path")
  .action(
    action(async (opts: { uri: string; salt?: string; hunter?: string; program: string; out?: string }, cmd: Command) => {
      const salt = opts.salt ? normalizeSalt(opts.salt) : randomSalt();
      let hunter = opts.hunter;
      if (!hunter) {
        const ctx = ctxFrom(cmd);
        if (ctx.account) hunter = ctx.account.address;
      }
      if (!hunter || !isAddress(hunter)) throw new Error("provide --hunter <address> or a signer (--key / BUG_PRIVATE_KEY)");
      const receipt = buildReceipt(opts.program, hunter as Address, opts.uri, salt);
      const file = opts.out ?? `bug-commit-receipt-${opts.program || "program"}-${Date.now()}.json`;
      writeFileSync(file, JSON.stringify(receipt, null, 2));
      console.log(`salt:        ${salt}`);
      console.log(`commit hash: ${receipt.commitHash}`);
      console.log(`receipt:     ${file}  (keep it secret: the salt cannot be recovered)`);
    }),
  );

program
  .command("encrypt <file>")
  .description("AES-GCM encrypt a report file (interops with the web app)")
  .requiredOption("--pass <passphrase>", "shared passphrase (give to the client over a side channel)")
  .option("--out <file>", "output path (default <file>.enc.json)")
  .action(
    action(async (file: string, opts: { pass: string; out?: string }) => {
      const plaintext = readFileSync(file, "utf8");
      const envelope = await encryptReport(plaintext, opts.pass);
      const out = opts.out ?? `${file}.enc.json`;
      writeFileSync(out, envelope);
      console.log(`encrypted: ${out}  (safe to publish as your reportURI)`);
    }),
  );

program
  .command("decrypt <file>")
  .description("decrypt an AES-GCM report envelope")
  .requiredOption("--pass <passphrase>", "the shared passphrase")
  .option("--out <file>", "write plaintext to a file instead of stdout")
  .action(
    action(async (file: string, opts: { pass: string; out?: string }) => {
      const envelope = readFileSync(file, "utf8");
      const plaintext = await decryptReport(envelope, opts.pass);
      if (opts.out) {
        writeFileSync(opts.out, plaintext);
        console.log(`decrypted: ${opts.out}`);
      } else {
        console.log(plaintext);
      }
    }),
  );

// ---- writes (need a signer) --------------------------------------------------

program
  .command("submit <programId>")
  .description("commit a finding on chain (saves a receipt first)")
  .requiredOption("--uri <reportURI>", "public link to your encrypted report")
  .option("--salt <hex>", "reuse a specific salt (default random)")
  .option("--out <file>", "receipt output path")
  .action(
    action(async (programId: string, opts: { uri: string; salt?: string; out?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const { account } = requireSigner(ctx);
      const salt = opts.salt ? normalizeSalt(opts.salt) : randomSalt();

      // Persist the receipt BEFORE sending: losing the salt means the report can
      // never be revealed, so we never risk a submitted commit with no saved salt.
      const receipt = buildReceipt(programId, account.address, opts.uri, salt);
      const file = opts.out ?? `bug-commit-receipt-program-${programId}-${Date.now()}.json`;
      writeFileSync(file, JSON.stringify(receipt, null, 2));
      console.log(`receipt saved: ${file}`);

      const { submissionId, commit, hash } = await submitFinding(ctx, BigInt(programId), opts.uri, salt);
      console.log(`commit:        ${commit}`);
      printTx(ctx, `submitted finding as submission #${submissionId}`, hash);
      console.log(`  reveal later: bug reveal ${submissionId} --uri "${opts.uri}" --salt ${salt}`);
    }),
  );

program
  .command("reveal <submissionId>")
  .description("reveal a previously committed report")
  .requiredOption("--uri <reportURI>", "the exact URI used at commit time")
  .requiredOption("--salt <hex>", "the salt from your receipt")
  .action(
    action(async (submissionId: string, opts: { uri: string; salt: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireSigner(ctx);
      const hash = await revealFinding(ctx, BigInt(submissionId), opts.uri, normalizeSalt(opts.salt));
      printTx(ctx, `revealed submission #${submissionId}`, hash);
    }),
  );

program
  .command("triage <submissionId>")
  .description("record a verdict on a submission (program owner)")
  .requiredOption("--verdict <verdict>", "accept | reject | duplicate | spam")
  .option("--severity <severity>", "low | medium | high | critical (required for accept)")
  .option("--dupe <id>", "original submission id (required for duplicate)")
  .action(
    action(async (submissionId: string, opts: { verdict: string; severity?: string; dupe?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireSigner(ctx);
      const verdict = VERDICT[opts.verdict.toLowerCase()];
      if (verdict === undefined) throw new Error("verdict must be accept, reject, duplicate, or spam");
      let severity = 0;
      if (opts.verdict.toLowerCase() === "accept") {
        if (!opts.severity) throw new Error("--severity is required when accepting");
        severity = SEVERITY_INDEX[opts.severity.toLowerCase()] ?? -1;
        if (severity < 1) throw new Error("severity must be low, medium, high, or critical");
      }
      const dupeOf = opts.verdict.toLowerCase() === "duplicate" ? BigInt(opts.dupe ?? (() => { throw new Error("--dupe <id> is required for duplicate"); })()) : 0n;
      const hash = await triageSubmission(ctx, BigInt(submissionId), verdict, severity, dupeOf);
      printTx(ctx, `triaged #${submissionId} as ${opts.verdict}`, hash);
    }),
  );

program
  .command("claim")
  .description("claim rewards owed to you (pull payment)")
  .option("--token <address>", "reward token (default native coin)")
  .option("--to <address>", "recipient (default your address)")
  .action(
    action(async (opts: { token?: string; to?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const { account } = requireSigner(ctx);
      const token = (opts.token && isAddress(opts.token) ? opts.token : NATIVE) as Address;
      const to = (opts.to && isAddress(opts.to) ? opts.to : account.address) as Address;
      const hash = await claimRewards(ctx, token, to);
      printTx(ctx, "claimed rewards", hash);
    }),
  );

program
  .command("withdraw-bond")
  .description("withdraw your returned bond credit")
  .option("--to <address>", "recipient (default your address)")
  .action(
    action(async (opts: { to?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const { account } = requireSigner(ctx);
      const to = (opts.to && isAddress(opts.to) ? opts.to : account.address) as Address;
      const hash = await withdrawBond(ctx, to);
      printTx(ctx, "withdrew bond credit", hash);
    }),
  );

// ---- live monitor ------------------------------------------------------------

program
  .command("watch")
  .description("poll the chain and print new programs, submissions, and triage transitions")
  .option("--interval <seconds>", "poll interval", "10")
  .action(
    action(async (opts: { interval: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const everyMs = Math.max(2, Number(opts.interval) || 10) * 1000;
      console.log(`watching ${ctx.meta.label} every ${everyMs / 1000}s. Press Ctrl-C to stop\n`);

      let lastProg = 0n;
      let lastSub = 0n;
      const statuses = new Map<string, number>();
      let first = true;

      const tick = async () => {
        const meta = await protocolMeta(ctx);
        // New programs
        if (meta.nextProgramId > lastProg) {
          if (!first) {
            for (let i = lastProg; i < meta.nextProgramId; i++) console.log(`[${new Date().toISOString().slice(11, 19)}] + program #${i}`);
          }
          lastProg = meta.nextProgramId;
        }
        // New submissions: record their status for transition tracking
        if (meta.nextSubmissionId > lastSub) {
          for (let i = lastSub; i < meta.nextSubmissionId; i++) {
            const s = await getSubmission(ctx, i);
            statuses.set(String(i), s.status);
            if (!first) console.log(`[${new Date().toISOString().slice(11, 19)}] + submission #${i} on program #${s.programId} (${subStatusName(s.status)})`);
          }
          lastSub = meta.nextSubmissionId;
        }
        // Status transitions on known submissions
        for (const [idStr, prev] of statuses) {
          const s = await getSubmission(ctx, BigInt(idStr));
          if (s.status !== prev) {
            statuses.set(idStr, s.status);
            console.log(`[${new Date().toISOString().slice(11, 19)}] ~ submission #${idStr}: ${subStatusName(prev)} to ${subStatusName(s.status)}${s.award > 0n ? ` (award set)` : ""}`);
          }
        }
        if (first) {
          console.log(`baseline: ${lastProg} program(s), ${lastSub} submission(s). waiting for changes...`);
          first = false;
        }
      };

      await tick();
      // eslint-disable-next-line no-constant-condition
      await new Promise<void>(() => {
        setInterval(() => {
          tick().catch((e) => console.error("poll error:", (e as Error).message));
        }, everyMs);
      });
    }),
  );

program.parseAsync(process.argv);
