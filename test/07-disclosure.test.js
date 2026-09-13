const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, EMBARGO, SUB_BOND } = H;
const { live, commit, SALT, REPORT, CRIT } = S;

async function accepted(bounty, client, hunter) {
  const id = await live(bounty, client);
  const subId = await bounty.nextSubmissionId();
  await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
  await bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0);
  return { id, subId };
}

describe("BugBounty: disclosure", function () {
  it("keeps the report embargoed until a fix can ship", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await accepted(bounty, client, hunter);

    await expect(
      bounty.connect(hunter).reveal(subId, REPORT, SALT)
    ).to.be.revertedWithCustomError(bounty, "DisclosureEmbargoed");

    await time.increase(EMBARGO + 1);
    await expect(bounty.connect(hunter).reveal(subId, REPORT, SALT))
      .to.emit(bounty, "SubmissionRevealed")
      .withArgs(subId, REPORT);

    expect((await bounty.getSubmission(subId)).reportURI).to.equal(REPORT);
  });

  it("lets the client lift the embargo once patched", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await accepted(bounty, client, hunter);

    await bounty.connect(client).waiveEmbargo(subId);
    await expect(bounty.connect(hunter).reveal(subId, REPORT, SALT)).to.emit(bounty, "SubmissionRevealed");
  });

  it("rejects a reveal that does not open the commitment", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const { subId } = await accepted(bounty, client, hunter);
    await bounty.connect(client).waiveEmbargo(subId);

    await expect(
      bounty.connect(hunter).reveal(subId, "ipfs://a-different-report", SALT)
    ).to.be.revertedWithCustomError(bounty, "CommitMismatch");
    await expect(
      bounty.connect(hunter).reveal(subId, REPORT, ethers.id("wrong-salt"))
    ).to.be.revertedWithCustomError(bounty, "CommitMismatch");
  });

  it("binds the commitment to the hunter, so a mempool watcher cannot steal priority", async function () {
    const { bounty, client, hunter, hunter2 } = await loadFixture(H.fixture);
    const id = await live(bounty, client, 2n);

    // hunter2 copies the exact commit hash out of the mempool and submits it.
    const stolen = commit(REPORT, SALT, hunter.address);
    const theirs = await bounty.nextSubmissionId();
    await bounty.connect(hunter2).submit(id, stolen);
    await bounty.connect(client).triage(theirs, Status.Accepted, Sev.Critical, 0);
    await bounty.connect(client).waiveEmbargo(theirs);

    // They cannot open it: the preimage commits to the original hunter.
    await expect(
      bounty.connect(hunter2).reveal(theirs, REPORT, SALT)
    ).to.be.revertedWithCustomError(bounty, "CommitMismatch");
  });

  it("agrees with the on-chain commitment helper", async function () {
    const { bounty, hunter } = await loadFixture(H.fixture);
    expect(await bounty.commitmentFor(REPORT, SALT, hunter.address)).to.equal(
      commit(REPORT, SALT, hunter.address)
    );
  });

  it("cannot be revealed twice, or while still pending", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));

    await expect(bounty.connect(hunter).reveal(subId, REPORT, SALT)).to.be.revertedWithCustomError(
      bounty,
      "NotPending"
    );

    await bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0);
    await bounty.connect(client).waiveEmbargo(subId);
    await bounty.connect(hunter).reveal(subId, REPORT, SALT);
    await expect(bounty.connect(hunter).reveal(subId, REPORT, SALT)).to.be.revertedWithCustomError(
      bounty,
      "AlreadyRevealed"
    );
  });
});
