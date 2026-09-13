/**
 * The full hunter loop, end to end, against a real BugBounty deployment.
 *
 *   npm run e2e                                 # fresh fixtures, in-process network
 *   npm run e2e:node                            # fresh fixtures, against `npx hardhat node`
 *
 * Or point it at a deployment that already exists, including a testnet one:
 *
 *   E2E_BOUNTY=0x... E2E_BUG_TOKEN=0x... npm run e2e:node
 *
 * With `E2E_BOUNTY` set it skips deployment and reads the bond terms, fee and
 * arbiter back off the contract, so it also works against a deployment it didn't
 * create. Either way the tests below are identical.
 *
 * Run standalone it deploys its own fixtures and its own mock $BUG, so it is safe
 * to run anywhere and spends nothing. It exits non-zero the moment any expected
 * state doesn't hold.
 *
 * Two things make this worth more than the unit tests, which already cover the
 * contract's own rules:
 *
 *  1. **It uses the browser's real commit helper.** `web/lib/commit.ts` is
 *     required here as-is. Node strips the types, so this is literally the module
 *     the browser bundles, not a re-implementation. The commit it produces is then
 *     checked against the value the deployed contract verifies. A mismatch there
 *     is not a subtle bug: every reveal would revert with `CommitMismatch`, and
 *     nothing else in the suite would catch it, because each side would be
 *     self-consistent.
 *
 *  2. **It walks the loop the way a person does.** Owner provisions, hunter
 *     commits, owner pays, hunter reveals and withdraws, plus the two failure
 *     paths the UI is built around: a lapsed triage SLA that hands the decision to
 *     the arbiter, and a spam verdict whose bond is held rather than taken.
 */
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("node:path");

const DAY = 86_400;
const TRIAGE_WINDOW = 30 * DAY; // the contract's ceiling, so time travel has room
const DISCLOSURE_DELAY = 30 * DAY;
// Assignable: when we're pointed at an existing deployment these are read back off
// the contract rather than assumed. `let` on purpose; hardcoding them would make
// the loop silently wrong against anything but its own fixtures.
let SUB_BOND = ethers.parseEther("100");
let PROG_BOND = ethers.parseEther("1000");
let FEE_BPS = 500n; // 5%
const LOW = ethers.parseEther("1");
const MEDIUM = ethers.parseEther("2");
const HIGH = ethers.parseEther("5");
const CRITICAL = ethers.parseEther("10");
const ESCROW = ethers.parseEther("40");

const Sev = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const SubStatus = { Pending: 0, Accepted: 1, Rejected: 2, Duplicate: 3, Spam: 4, Escalated: 5, Resolved: 6 };
const PStatus = { Draft: 0, Live: 1, Paused: 2, Closed: 3 };

const WEB_DIR = path.join(__dirname, "..", "web");

// ---- tiny reporter ----------------------------------------------------------

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failures.push(label);
    console.log(`  fail: ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  ok(label, a === e, `expected ${e}, got ${a}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Asserts a call reverts with a specific custom error, by name. */
async function expectRevert(label, fn, errorName) {
  try {
    await fn();
  } catch (e) {
    const msg = `${e.shortMessage ?? ""} ${e.message ?? ""}`;
    if (msg.includes(errorName)) {
      ok(label, true);
      return;
    }
    ok(label, false, `expected ${errorName}, got: ${msg.split("\n")[0].slice(0, 120)}`);
    return;
  }
  ok(label, false, `expected ${errorName}, but it succeeded`);
}

/**
 * Loads the web app's commit helper: the same module the browser bundles.
 *
 * Node strips the TypeScript types on require, so there's no build step and
 * nothing to keep in sync: if someone changes the encoding in `web/lib/commit.ts`
 * and the contract disagrees, this script fails instead of both sides being
 * quietly self-consistent.
 */
function loadWebCommitHelper() {
  const helperPath = path.join(WEB_DIR, "lib", "commit.ts");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const helper = require(helperPath);
    if (typeof helper.commitmentFor !== "function") {
      throw new Error("web/lib/commit.ts no longer exports commitmentFor()");
    }
    return helper;
  } catch (e) {
    if (e.code === "ERR_UNKNOWN_FILE_EXTENSION" || e.code === "ERR_REQUIRE_ESM") {
      throw new Error(
        `This check requires Node 22.18+ so it can read web/lib/commit.ts directly (you're on ${process.version}).`,
      );
    }
    throw e;
  }
}

async function main() {
  console.log(`Hunter loop, end to end on "${network.name}" (chainId ${network.config.chainId})`);

  const { commitmentFor, randomSalt } = loadWebCommitHelper();
  const signers = await ethers.getSigners();
  const [deployer, client, hunter] = signers;
  // The arbiter and the fee recipient are roles on the contract, not positions in
  // this script, so when we adopt an existing deployment we resolve them from the
  // contract back to whichever signer holds them.
  let arbiter = signers[3];
  let fees = signers[4];

  // ---- fixtures --------------------------------------------------------------
  const reuse = Boolean(process.env.E2E_BOUNTY || process.env.E2E_BUG_TOKEN);
  let bounty;
  let bug;
  let bountyAddr;

  if (reuse) {
    const at = process.env.E2E_BOUNTY ?? "";
    const token = process.env.E2E_BUG_TOKEN ?? "";
    if (!at || !token) {
      throw new Error("Set both E2E_BOUNTY and E2E_BUG_TOKEN, or neither.");
    }
    section(`Setup: adopting the deployment at ${at}`);
    bounty = await ethers.getContractAt("BugBounty", at);
    bug = await ethers.getContractAt("MockERC20", token);
    bountyAddr = at;

    eq("the contract is deployed there", (await ethers.provider.getCode(at)) !== "0x", true);
    eq("it was built with that $BUG token", await bounty.bugToken(), token);

    // These are the deployment's own terms. Read them rather than assume, so this
    // script is also usable against a testnet deployment someone else configured.
    SUB_BOND = await bounty.submissionBond();
    PROG_BOND = await bounty.minProgramBond();
    FEE_BPS = await bounty.protocolFeeBps();
    if (SUB_BOND === 0n || PROG_BOND === 0n) {
      throw new Error(
        "This deployment has no bond terms configured, so the bond paths can't be checked. Deploy it with BUG_SUBMISSION_BOND and BUG_PROGRAM_BOND, or drop E2E_BOUNTY.",
      );
    }

    const resolve = (address, role) => {
      const found = signers.find((s) => s.address.toLowerCase() === address.toLowerCase());
      if (!found) throw new Error(`The ${role} is ${address}, which isn't one of this network's signers.`);
      return found;
    };
    arbiter = resolve(await bounty.arbiter(), "arbiter");
    fees = resolve(await bounty.feeRecipient(), "fee recipient");
  } else {
    section("Setup: deploy the protocol and its mock $BUG");
    bug = await (await ethers.getContractFactory("MockERC20")).deploy("Bug", "BUG");
    bounty = await (
      await ethers.getContractFactory("BugBounty")
    ).deploy(deployer.address, await bug.getAddress(), fees.address, FEE_BPS);
    bountyAddr = await bounty.getAddress();
    await (await bounty.setArbiter(arbiter.address)).wait();
    await (await bounty.setBondTerms(SUB_BOND, PROG_BOND)).wait();
  }

  eq("the anti-spam bond is a real amount", SUB_BOND > 0n, true);
  eq("the client bond is a real amount", PROG_BOND > 0n, true);
  eq("the protocol fee is within its ceiling", FEE_BPS <= 1000n, true);
  eq("the arbiter resolves to a signer that can rule", await bounty.arbiter(), arbiter.address);
  eq("the fee recipient resolves to a signer that can claim", await bounty.feeRecipient(), fees.address);

  for (const who of [client, hunter]) {
    await (await bug.mint(who.address, ethers.parseEther("100000"))).wait();
    await (await bug.connect(who).approve(bountyAddr, ethers.MaxUint256)).wait();
  }

  // ---- owner provisioning ----------------------------------------------------
  section("Phase 0: the owner provisions a program on chain");
  const scopeDoc = "In scope: *.example.com and 0x0000000000000000000000000000000000000001\nNo DoS, no data exfiltration.";
  const scopeHash = ethers.keccak256(ethers.toUtf8Bytes(scopeDoc));
  const scopeURI = "https://swamp.example/programs/example";

  const programId = await bounty.nextProgramId();
  await (
    await bounty
      .connect(client)
      .createProgram(
        ethers.ZeroAddress, // native ETH pool
        scopeHash,
        scopeURI,
        [0n, LOW, MEDIUM, HIGH, CRITICAL],
        TRIAGE_WINDOW,
        DISCLOSURE_DELAY,
      )
  ).wait();

  let program = await bounty.getProgram(programId);
  eq("program starts in Draft", program.status, PStatus.Draft);
  eq("scope hash is recorded", program.scopeHash, scopeHash);

  await expectRevert(
    "cannot go live with an unfunded pool",
    () => bounty.connect(client).setStatus(programId, PStatus.Live),
    "UnderfundedPool",
  );

  await (await bounty.connect(client).fundProgram(programId, ESCROW, { value: ESCROW })).wait();
  await expectRevert(
    "cannot go live without the client bond",
    () => bounty.connect(client).setStatus(programId, PStatus.Live),
    "BondRequired",
  );
  await (await bounty.connect(client).bondProgram(programId, PROG_BOND)).wait();
  await (await bounty.connect(client).setStatus(programId, PStatus.Live)).wait();

  program = await bounty.getProgram(programId);
  eq("program is Live", program.status, PStatus.Live);
  eq("escrow is held", program.pool, ESCROW);
  eq("client bond is held in $BUG", program.bond, PROG_BOND);

  // ---- the hunter's commit ---------------------------------------------------
  section("Phase 1: the hunter commits an encrypted report");
  const reportURI = "http://127.0.0.1:3000/api/reports/9f2c" + "0".repeat(58); // content-addressed
  const salt = randomSalt();

  // The three-way agreement that everything else depends on.
  const webCommit = commitmentFor(reportURI, salt, hunter.address);
  const contractCommit = await bounty.commitmentFor(reportURI, salt, hunter.address);
  const ethersCommit = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "address"], [reportURI, salt, hunter.address]),
  );
  eq("the browser's commit hash matches the deployed contract", webCommit, contractCommit);
  eq("and matches the raw ABI encoding", webCommit, ethersCommit);

  const sub1 = await bounty.nextSubmissionId();
  await (await bounty.connect(hunter).submit(programId, webCommit)).wait();

  const s1 = await bounty.getSubmission(sub1);
  eq("submission is Pending", s1.status, SubStatus.Pending);
  eq("the commit hash is stored, not the report", s1.commitHash, webCommit);
  eq("no report URI on chain yet", s1.reportURI, "");
  eq("the hunter's anti-spam bond was taken", s1.bond, SUB_BOND);
  eq("the program counts one open finding", await bounty.pendingCount(programId), 1n);

  // Every open finding is fully escrowed, which is the whole reason a payout can
  // be promised. The owner can only withdraw what isn't reserved.
  const reserved = await bounty.topTier(programId);
  eq("free pool excludes the reserve for open findings", await bounty.freePool(programId), ESCROW - reserved);
  await expectRevert(
    "the owner cannot withdraw into the reserve",
    () => bounty.connect(client).withdrawPool(programId, client.address, ESCROW - reserved + 1n),
    "UnderfundedPool",
  );

  // ---- triage ----------------------------------------------------------------
  section("Phase 2: the owner accepts, and escrow pays in the same transaction");
  const award = HIGH;
  const fee = (award * FEE_BPS) / 10_000n;
  const netAward = award - fee;

  await (await bounty.connect(client).triage(sub1, SubStatus.Accepted, Sev.High, 0)).wait();

  const s1After = await bounty.getSubmission(sub1);
  eq("verdict recorded as Accepted", s1After.status, SubStatus.Accepted);
  eq("severity assigned by the owner", s1After.severity, Sev.High);
  eq("award is the High tier", s1After.award, award);
  eq("the hunter can claim the award net of the protocol fee", await bounty.claimable(hunter.address, ethers.ZeroAddress), netAward);
  eq("the protocol fee is credited", await bounty.claimable(fees.address, ethers.ZeroAddress), fee);
  eq("paid funds are out of the pool", (await bounty.getProgram(programId)).pool, ESCROW - award);
  eq("the anti-spam bond came back", await bounty.bondCredit(hunter.address), SUB_BOND);
  eq("the submission's bond is cleared", (await bounty.getSubmission(sub1)).bond, 0n);
  eq("nothing is outstanding any more", await bounty.pendingCount(programId), 0n);
  eq("all remaining escrow is withdrawable by the owner", await bounty.freePool(programId), ESCROW - award);

  // ---- reveal ----------------------------------------------------------------
  section("Phase 3: reveal, embargoed until a fix could ship");
  await expectRevert(
    "reveal is refused while the disclosure embargo runs",
    () => bounty.connect(hunter).reveal(sub1, reportURI, salt),
    "DisclosureEmbargoed",
  );

  const wrongSalt = ethers.id("not-the-salt");
  await (await bounty.connect(client).waiveEmbargo(sub1)).wait();
  eq("the owner released the embargo", await bounty.embargoWaived(sub1), true);

  await expectRevert(
    "a salt that doesn't open the commit is rejected",
    () => bounty.connect(hunter).reveal(sub1, reportURI, wrongSalt),
    "CommitMismatch",
  );

  await expectRevert(
    "only the hunter can reveal",
    () => bounty.connect(client).reveal(sub1, reportURI, salt),
    "NotHunter",
  );

  await (await bounty.connect(hunter).reveal(sub1, reportURI, salt)).wait();
  const revealed = await bounty.getSubmission(sub1);
  eq("the report URI is now public on chain", revealed.reportURI, reportURI);
  eq("the document is provably the committed one", revealed.commitHash, webCommit);

  // ---- withdrawal ------------------------------------------------------------
  section("Phase 4: the hunter withdraws");
  // Simulated from the hunter's own address: `claim` pays msg.sender, so a call
  // from any other signer correctly reverts with ZeroAmount.
  eq("the hunter is owed the award net of fee", await bounty.claimable(hunter.address, ethers.ZeroAddress), netAward);
  eq(
    "a simulated claim reports exactly that amount",
    await bounty.connect(hunter).claim.staticCall(ethers.ZeroAddress, hunter.address),
    netAward,
  );
  const feeRecipientBefore = await ethers.provider.getBalance(fees.address);
  await (await bounty.connect(hunter).claim(ethers.ZeroAddress, hunter.address)).wait();
  eq("the claim is cleared", await bounty.claimable(hunter.address, ethers.ZeroAddress), 0n);

  // The protocol fee is a pull-payment credit too, never a push: nothing about
  // accepting a finding depends on the fee recipient being able to receive funds.
  const contractBefore = await ethers.provider.getBalance(bountyAddr);
  eq("the fee is sitting as a credit, not sent", await bounty.claimable(fees.address, ethers.ZeroAddress), fee);
  await (await bounty.connect(fees).claim(ethers.ZeroAddress, fees.address)).wait();
  eq(
    "pulling it moves exactly that much value out of the contract",
    contractBefore - (await ethers.provider.getBalance(bountyAddr)),
    fee,
  );
  eq("the fee recipient's credit is cleared", await bounty.claimable(fees.address, ethers.ZeroAddress), 0n);
  ok(
    "the fee recipient's own balance grew",
    (await ethers.provider.getBalance(fees.address)) > feeRecipientBefore,
  );
  await expectRevert(
    "claiming twice is refused",
    () => bounty.connect(hunter).claim(ethers.ZeroAddress, hunter.address),
    "ZeroAmount",
  );
  await (await bounty.connect(hunter).withdrawBond(hunter.address)).wait();
  eq("bond credit is cleared", await bounty.bondCredit(hunter.address), 0n);

  // ---- a lapsed SLA hands the decision to the arbiter ------------------------
  section("Phase 5: the owner misses the triage SLA; the arbiter decides");
  const sub2 = await bounty.nextSubmissionId();
  const uri2 = "http://127.0.0.1:3000/api/reports/aa11" + "0".repeat(58);
  const salt2 = randomSalt();
  await (await bounty.connect(hunter).submit(programId, commitmentFor(uri2, salt2, hunter.address))).wait();

  await expectRevert(
    "escalating is refused while the owner still has time",
    () => bounty.connect(hunter).escalate(sub2),
    "TriageWindowOpen",
  );
  await expectRevert(
    "a stranger cannot escalate someone else's finding",
    () => bounty.connect(client).escalate(sub2),
    "NotHunter",
  );

  await time.increase(TRIAGE_WINDOW + 1);

  await expectRevert(
    "the owner can no longer triage once the window has closed",
    () => bounty.connect(client).triage(sub2, SubStatus.Accepted, Sev.High, 0),
    "TriageWindowClosed",
  );

  await (await bounty.connect(hunter).escalate(sub2)).wait();
  eq("the finding is Escalated", (await bounty.getSubmission(sub2)).status, SubStatus.Escalated);
  eq("its escrow cover is still reserved while the arbiter rules", await bounty.freePool(programId), ESCROW - award - reserved);
  eq("the escalation is recorded as coming from pending", await bounty.escalatedFromPending(sub2), true);

  // The disclosure delay is measured from a triage that never happened, so a
  // lapsed-SLA finding can be revealed straight away, which is what puts the
  // evidence in front of the arbiter. The UI tells hunters exactly this.
  await (await bounty.connect(hunter).reveal(sub2, uri2, salt2)).wait();
  eq("a lapsed-SLA finding can be revealed immediately", (await bounty.getSubmission(sub2)).reportURI, uri2);

  await (await bounty.connect(arbiter).resolveEscalation(sub2, true, Sev.High, false)).wait();
  const s2After = await bounty.getSubmission(sub2);
  eq("the arbiter's ruling is Resolved", s2After.status, SubStatus.Resolved);
  eq("a valid ruling pays the tier", s2After.award, HIGH);
  eq("the reserve is released once ruled on", await bounty.pendingCount(programId), 0n);
  eq("the hunter can claim the ruling", await bounty.claimable(hunter.address, ethers.ZeroAddress), netAward);
  eq("no bond was slashed for an honest appeal", (await bounty.getSubmission(sub2)).bond, 0n);
  await (await bounty.connect(hunter).claim(ethers.ZeroAddress, hunter.address)).wait();

  // ---- spam: held, not taken -------------------------------------------------
  section("Phase 6: a spam verdict holds the bond for the dispute window");
  const sub3 = await bounty.nextSubmissionId();
  const uri3 = "http://127.0.0.1:3000/api/reports/bb22" + "0".repeat(58);
  await (await bounty.connect(hunter).submit(programId, commitmentFor(uri3, randomSalt(), hunter.address))).wait();
  await (await bounty.connect(client).triage(sub3, SubStatus.Spam, 0, 0)).wait();

  const hunterBondBefore = await bounty.bondCredit(hunter.address);
  const spammer = await bounty.getSubmission(sub3);
  eq("the verdict is Spam", spammer.status, SubStatus.Spam);
  eq("the bond is held, not yet taken", spammer.bond, SUB_BOND);
  eq("the hunter's bond credit is untouched", await bounty.bondCredit(hunter.address), hunterBondBefore);
  eq("the protocol has not been credited yet", await bounty.bondCredit(fees.address), 0n);

  await expectRevert(
    "the slash cannot be finalized while the hunter can still appeal",
    () => bounty.connect(client).finalizeSpamSlash(sub3),
    "TriageWindowOpen",
  );

  await time.increase(7 * DAY + 1);
  await (await bounty.connect(client).finalizeSpamSlash(sub3)).wait();
  eq("the bond is gone from the submission", (await bounty.getSubmission(sub3)).bond, 0n);
  eq("and credited to the protocol", await bounty.bondCredit(fees.address), SUB_BOND);
  eq("the hunter's own credit is unaffected", await bounty.bondCredit(hunter.address), hunterBondBefore);

  // ---- summary ---------------------------------------------------------------
  console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\nthe loop threw before finishing:\n", e);
  process.exitCode = 1;
});
