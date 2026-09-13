const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, DISPUTE, SUB_BOND, PROG_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

const FEE_BPS = 500n;

describe("BugBounty: escalation on SLA lapse", function () {
  it("cannot be escalated while the client still has time", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    await expect(bounty.connect(hunter).escalate(subId)).to.be.revertedWithCustomError(
      bounty,
      "TriageWindowOpen"
    );
  });

  it("only the hunter may escalate their own submission", async function () {
    const { bounty, client, hunter, hunter2 } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await time.increase(TRIAGE + 1);

    await expect(bounty.connect(hunter2).escalate(subId)).to.be.revertedWithCustomError(bounty, "NotHunter");
  });

  it("ignoring a report hands the decision to the arbiter, and escrow stays reserved", async function () {
    const { bounty, client, hunter, arbiter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    await time.increase(TRIAGE + 1);
    await expect(bounty.connect(hunter).escalate(subId))
      .to.emit(bounty, "SubmissionEscalated")
      .withArgs(subId, hunter.address, true);

    // Still counted, so the client cannot withdraw the cover out from under it.
    expect(await bounty.pendingCount(id)).to.equal(1n);
    expect(await bounty.freePool(id)).to.equal(0n);
    expect(await bounty.escalatedFromPending(subId)).to.equal(true);

    const fee = (CRIT * FEE_BPS) / 10000n;
    await expect(bounty.connect(arbiter).resolveEscalation(subId, true, Sev.Critical, false))
      .to.emit(bounty, "EscalationResolved")
      .withArgs(subId, true, Sev.Critical, CRIT);

    expect(await bounty.claimable(hunter.address, ETH)).to.equal(CRIT - fee);
    expect(await bounty.bondCredit(hunter.address)).to.equal(SUB_BOND);
    expect(await bounty.pendingCount(id)).to.equal(0n);
  });

  it("only the arbiter may rule", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await time.increase(TRIAGE + 1);
    await bounty.connect(hunter).escalate(subId);

    await expect(
      bounty.connect(client).resolveEscalation(subId, true, Sev.Critical, false)
    ).to.be.revertedWithCustomError(bounty, "NotArbiter");
  });
});
