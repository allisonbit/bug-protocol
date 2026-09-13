const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, DISPUTE, SUB_BOND, PROG_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

describe("BugBounty: disputing a verdict", function () {
  it("a wrongly-flagged hunter gets their bond back", async function () {
    const { bounty, client, hunter, arbiter, fees } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await bounty.connect(client).triage(subId, Status.Spam, Sev.None, 0);

    await bounty.connect(hunter).escalate(subId);
    await bounty.connect(arbiter).resolveEscalation(subId, true, Sev.High, false);

    expect(await bounty.bondCredit(hunter.address)).to.equal(SUB_BOND);
    expect(await bounty.bondCredit(fees.address)).to.equal(0n);
    expect(await bounty.claimable(hunter.address, ETH)).to.be.gt(0n);

    // The slash path is now closed off.
    await time.increase(DISPUTE + 1);
    await expect(bounty.finalizeSpamSlash(subId)).to.be.revertedWithCustomError(bounty, "NotPending");
  });

  it("closes the dispute window after seven days", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await bounty.connect(client).triage(subId, Status.Rejected, Sev.None, 0);

    await time.increase(DISPUTE + 1);
    await expect(bounty.connect(hunter).escalate(subId)).to.be.revertedWithCustomError(
      bounty,
      "TriageWindowClosed"
    );
  });

  it("lets the arbiter slash a bad-faith submitter", async function () {
    const { bounty, client, hunter, arbiter, fees } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await bounty.connect(client).triage(subId, Status.Spam, Sev.None, 0);
    await bounty.connect(hunter).escalate(subId);

    await bounty.connect(arbiter).resolveEscalation(subId, false, Sev.None, true);
    expect(await bounty.bondCredit(fees.address)).to.equal(SUB_BOND);
    expect(await bounty.bondCredit(hunter.address)).to.equal(0n);
  });

  it("falls back to the client's bond when escrow was already released", async function () {
    const { bounty, client, hunter, arbiter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    // Client rejects, then closes the program and pulls the escrow back out.
    await bounty.connect(client).triage(subId, Status.Rejected, Sev.None, 0);
    await bounty.connect(client).setStatus(id, PStatus.Closed);
    await bounty.connect(client).withdrawPool(id, client.address, CRIT);
    expect((await bounty.getProgram(id)).pool).to.equal(0n);

    // The hunter disputes and wins: the shortfall comes out of the client bond.
    await bounty.connect(hunter).escalate(subId);
    await expect(bounty.connect(arbiter).resolveEscalation(subId, true, Sev.Critical, false))
      .to.emit(bounty, "ProgramBondSlashed")
      .withArgs(id, PROG_BOND, hunter.address);

    // Bond is capped at what was posted, so the hunter is made whole up to it.
    expect(await bounty.bondCredit(hunter.address)).to.equal(PROG_BOND + SUB_BOND);
    expect((await bounty.getProgram(id)).bond).to.equal(0n);
  });
});
