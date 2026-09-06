const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, EMBARGO, DISPUTE, SUB_BOND, PROG_BOND, tiers } = H;
const { draft, live, commit, SALT, REPORT, SCOPE, SCOPE_URI, CRIT } = S;

describe("BugBounty — program lifecycle", function () {
  it("records scope and payout tiers on creation", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await draft(bounty, client);

    const p = await bounty.getProgram(id);
    expect(p.owner).to.equal(client.address);
    expect(p.scopeHash).to.equal(SCOPE);
    expect(p.scopeURI).to.equal(SCOPE_URI);
    expect(p.status).to.equal(PStatus.Draft);
    expect(await bounty.payoutOf(id, Sev.Critical)).to.equal(CRIT);
    expect(await bounty.topTier(id)).to.equal(CRIT);
  });

  it("refuses a program with no scope document", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    await expect(
      bounty.connect(client).createProgram(ETH, ethers.ZeroHash, SCOPE_URI, tiers(1n, 2n, 3n, 4n), TRIAGE, EMBARGO)
    ).to.be.revertedWithCustomError(bounty, "ScopeRequired");

    await expect(
      bounty.connect(client).createProgram(ETH, SCOPE, "", tiers(1n, 2n, 3n, 4n), TRIAGE, EMBARGO)
    ).to.be.revertedWithCustomError(bounty, "ScopeRequired");
  });

  it("clamps the triage SLA to a humane range", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const t = tiers(1n, 2n, 3n, 4n);
    await expect(
      bounty.connect(client).createProgram(ETH, SCOPE, SCOPE_URI, t, DAY, EMBARGO)
    ).to.be.revertedWithCustomError(bounty, "InvalidTriageDeadline");
    await expect(
      bounty.connect(client).createProgram(ETH, SCOPE, SCOPE_URI, t, 60 * DAY, EMBARGO)
    ).to.be.revertedWithCustomError(bounty, "InvalidTriageDeadline");
  });
});

describe("BugBounty — the Live gate", function () {
  it("will not go Live without the client bond", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await draft(bounty, client);
    await bounty.connect(client).fundProgram(id, CRIT, { value: CRIT });

    await expect(bounty.connect(client).setStatus(id, PStatus.Live))
      .to.be.revertedWithCustomError(bounty, "BondRequired")
      .withArgs(0n, PROG_BOND);
  });

  it("will not go Live without escrow covering the top tier", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await draft(bounty, client);
    await bounty.connect(client).bondProgram(id, PROG_BOND);
    const short = CRIT - 1n;
    await bounty.connect(client).fundProgram(id, short, { value: short });

    await expect(bounty.connect(client).setStatus(id, PStatus.Live))
      .to.be.revertedWithCustomError(bounty, "UnderfundedPool")
      .withArgs(short, CRIT);
  });

  it("goes Live once scope, tiers, escrow and bond are all in place", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    expect((await bounty.getProgram(id)).status).to.equal(PStatus.Live);
  });

  it("only the program owner can change status", async function () {
    const { bounty, client, hunter } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    await expect(bounty.connect(hunter).setStatus(id, PStatus.Paused)).to.be.revertedWithCustomError(
      bounty,
      "NotProgramOwner"
    );
  });

  it("treats Closed as terminal", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await live(bounty, client);
    await bounty.connect(client).setStatus(id, PStatus.Closed);
    await expect(bounty.connect(client).setStatus(id, PStatus.Live)).to.be.revertedWithCustomError(
      bounty,
      "InvalidStatusTransition"
    );
  });
});
