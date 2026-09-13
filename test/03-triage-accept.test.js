const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, DISPUTE, SUB_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

const FEE_BPS = 500n; // 5%, set in the fixture

async function submitted(bounty, client, hunter, cover = 1n) {
  const id = await live(bounty, client, cover);
  const subId = await bounty.nextSubmissionId();
  await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
  return { id, subId };
}

describe("BugBounty: triage accept", function () {
  it("credits the award net of protocol fee, in the same call", async function () {
    const { bounty, client, hunter, fees } = await loadFixture(H.fixture);
    const { id, subId } = await submitted(bounty, client, hunter);

    const fee = (CRIT * FEE_BPS) / 10000n;
    await expect(bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0))
      .to.emit(bounty, "SubmissionAccepted")
      .withArgs(subId, Sev.Critical, CRIT, fee);

    expect(await bounty.claimable(hunter.address, ETH)).to.equal(CRIT - fee);
    expect(await bounty.claimable(fees.address, ETH)).to.equal(fee);
    expect(await bounty.pendingCount(id)).to.equal(0n);

    // The anti-spam bond comes back.
    expect(await bounty.bondCredit(hunter.address)).to.equal(SUB_BOND);
  });

  it("lets the hunter pull the reward", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await submitted(bounty, client, hunter);
    await bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0);

    const owed = await bounty.claimable(hunter.address, ETH);
    await expect(bounty.connect(hunter).claim(ETH, hunter.address)).to.changeEtherBalance(hunter, owed);
    expect(await bounty.claimable(hunter.address, ETH)).to.equal(0n);
    await expect(bounty.connect(hunter).claim(ETH, hunter.address)).to.be.revertedWithCustomError(
      bounty,
      "ZeroAmount"
    );
  });

  it("refuses a severity with no configured tier", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await submitted(bounty, client, hunter);
    await expect(
      bounty.connect(client).triage(subId, Status.Accepted, Sev.None, 0)
    ).to.be.revertedWithCustomError(bounty, "InvalidSeverity");
  });

  it("only the program owner may triage", async function () {
    const { bounty, client, hunter, hunter2 } = await loadFixture(H.fixture);
    const { subId } = await submitted(bounty, client, hunter);
    await expect(
      bounty.connect(hunter2).triage(subId, Status.Accepted, Sev.Critical, 0)
    ).to.be.revertedWithCustomError(bounty, "NotProgramOwner");
  });

  it("cannot triage after the SLA has lapsed", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await submitted(bounty, client, hunter);
    await time.increase(TRIAGE + 1);
    await expect(
      bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0)
    ).to.be.revertedWithCustomError(bounty, "TriageWindowClosed");
  });
});
