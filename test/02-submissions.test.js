const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, SUB_BOND, PROG_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

describe("BugBounty — submissions", function () {
  it("takes a commitment and the hunter's anti-spam bond", async function () {
    const { bounty, bug, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const c = commit(REPORT, SALT, hunter.address);

    const before = await bug.balanceOf(hunter.address);
    const subId = await bounty.nextSubmissionId();
    await expect(bounty.connect(hunter).submit(id, c))
      .to.emit(bounty, "SubmissionCreated")
      .withArgs(subId, id, hunter.address, c);

    expect(await bug.balanceOf(hunter.address)).to.equal(before - SUB_BOND);

    const s = await bounty.getSubmission(subId);
    expect(s.hunter).to.equal(hunter.address);
    expect(s.commitHash).to.equal(c);
    expect(s.status).to.equal(Status.Pending);
    expect(s.bond).to.equal(SUB_BOND);
    expect(s.reportURI).to.equal(""); // nothing disclosed on chain
    expect(await bounty.pendingCount(id)).to.equal(1n);
  });

  it("rejects submissions to a program that is not Live", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    await bounty.connect(client).setStatus(id, PStatus.Paused);
    await expect(
      bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address))
    ).to.be.revertedWithCustomError(bounty, "ProgramNotLive");
  });

  it("guarantees every pending submission is fully escrowed", async function () {
    const { bounty, client, hunter, hunter2 } = await loadFixture(H.fixture);
    const id = await live(bounty, client, 1n); // escrow covers exactly one Critical

    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    // A second concurrent submission would not be payable, so it is refused.
    await expect(bounty.connect(hunter2).submit(id, commit("r2", SALT, hunter2.address)))
      .to.be.revertedWithCustomError(bounty, "UnderfundedPool")
      .withArgs(CRIT, CRIT * 2n);

    // Funding a second Critical unblocks it.
    await bounty.connect(client).fundProgram(id, CRIT, { value: CRIT });
    await bounty.connect(hunter2).submit(id, commit("r2", SALT, hunter2.address));
    expect(await bounty.pendingCount(id)).to.equal(2n);
  });

  it("stops the client withdrawing escrow reserved for open submissions", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client, 2n);
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    expect(await bounty.freePool(id)).to.equal(CRIT); // one of two Criticals is reserved
    await expect(
      bounty.connect(client).withdrawPool(id, client.address, CRIT + 1n)
    ).to.be.revertedWithCustomError(bounty, "UnderfundedPool");

    await bounty.connect(client).withdrawPool(id, client.address, CRIT);
    expect(await bounty.freePool(id)).to.equal(0n);
  });
});
