const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, DISPUTE, SUB_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

describe("BugBounty — triage: reject, duplicate, spam", function () {
  it("an honest rejection costs the hunter nothing", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    await expect(bounty.connect(client).triage(subId, Status.Rejected, Sev.None, 0))
      .to.emit(bounty, "SubmissionRejected")
      .withArgs(subId);

    expect(await bounty.bondCredit(hunter.address)).to.equal(SUB_BOND);
    expect(await bounty.claimable(hunter.address, ETH)).to.equal(0n);
    expect(await bounty.pendingCount(id)).to.equal(0n);
  });

  it("refuses 'duplicate' unless it points at an earlier PAID finding", async function () {
    const { bounty, client, hunter, hunter2 } = await loadFixture(H.fixture);
    const id = await live(bounty, client, 2n);

    const first = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    const second = await bounty.nextSubmissionId();
    await bounty.connect(hunter2).submit(id, commit("r2", SALT, hunter2.address));

    // Nothing accepted yet, so nothing can be a duplicate of anything.
    await expect(
      bounty.connect(client).triage(second, Status.Duplicate, Sev.None, first)
    ).to.be.revertedWithCustomError(bounty, "BadDuplicateReference");

    // Pointing at itself, or forward in time, is also refused.
    await expect(
      bounty.connect(client).triage(second, Status.Duplicate, Sev.None, second)
    ).to.be.revertedWithCustomError(bounty, "BadDuplicateReference");
    await expect(
      bounty.connect(client).triage(first, Status.Duplicate, Sev.None, second)
    ).to.be.revertedWithCustomError(bounty, "BadDuplicateReference");

    // Once the first is accepted and paid, the second may be closed as a dupe.
    await bounty.connect(client).triage(first, Status.Accepted, Sev.Critical, 0);
    await expect(bounty.connect(client).triage(second, Status.Duplicate, Sev.None, first))
      .to.emit(bounty, "SubmissionDuplicate")
      .withArgs(second, first);

    // The duplicate reporter keeps their bond.
    expect(await bounty.bondCredit(hunter2.address)).to.equal(SUB_BOND);
  });

  it("holds a spam bond through the dispute window, then slashes it", async function () {
    const { bounty, client, hunter, fees } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    await expect(bounty.connect(client).triage(subId, Status.Spam, Sev.None, 0))
      .to.emit(bounty, "SubmissionFlaggedSpam")
      .withArgs(subId, SUB_BOND);

    // Not credited yet — the hunter still has time to dispute.
    expect(await bounty.bondCredit(fees.address)).to.equal(0n);
    await expect(bounty.finalizeSpamSlash(subId)).to.be.revertedWithCustomError(bounty, "TriageWindowOpen");

    await time.increase(DISPUTE + 1);
    await expect(bounty.finalizeSpamSlash(subId)).to.emit(bounty, "SubmissionSpam").withArgs(subId, SUB_BOND);
    expect(await bounty.bondCredit(fees.address)).to.equal(SUB_BOND);
    expect(await bounty.bondCredit(hunter.address)).to.equal(0n);
  });
});
