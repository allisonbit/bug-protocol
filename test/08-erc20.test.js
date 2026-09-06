const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const S = require("./shared");
const { ETH, Sev, Status, PStatus, TRIAGE, EMBARGO, SUB_BOND, PROG_BOND, tiers } = H;
const { commit, SALT, REPORT, SCOPE, SCOPE_URI, CRIT } = S;

/**
 * Most real clients will fund in a stablecoin rather than native ETH, so the
 * ERC-20 path is exercised end to end here, including the fee-on-transfer
 * safeguard (balance deltas, not the requested amount, are what get credited).
 */
describe("BugBounty — ERC-20 reward pools", function () {
  async function usdcFixture() {
    const base = await H.fixture();
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC");
    for (const who of [base.client, base.hunter]) {
      await usdc.mint(who.address, ethers.parseEther("1000000"));
      await usdc.connect(who).approve(await base.bounty.getAddress(), ethers.MaxUint256);
    }
    return { ...base, usdc };
  }

  it("runs a full program in an ERC-20", async function () {
    const { bounty, usdc, client, hunter, fees } = await loadFixture(usdcFixture);
    const usdcAddr = await usdc.getAddress();

    const id = await bounty.nextProgramId();
    await bounty
      .connect(client)
      .createProgram(
        usdcAddr,
        SCOPE,
        SCOPE_URI,
        tiers(ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("5"), CRIT),
        TRIAGE,
        EMBARGO
      );
    await bounty.connect(client).bondProgram(id, PROG_BOND);
    await bounty.connect(client).fundProgram(id, CRIT);
    await bounty.connect(client).setStatus(id, PStatus.Live);

    expect((await bounty.getProgram(id)).pool).to.equal(CRIT);

    const subId = await bounty.nextSubmissionId();
    await bounty.connect(hunter).submit(id, commit(REPORT, SALT, hunter.address));
    await bounty.connect(client).triage(subId, Status.Accepted, Sev.Critical, 0);

    const fee = (CRIT * 500n) / 10000n;
    expect(await bounty.claimable(hunter.address, usdcAddr)).to.equal(CRIT - fee);
    expect(await bounty.claimable(fees.address, usdcAddr)).to.equal(fee);

    const before = await usdc.balanceOf(hunter.address);
    await bounty.connect(hunter).claim(usdcAddr, hunter.address);
    expect(await usdc.balanceOf(hunter.address)).to.equal(before + CRIT - fee);

    // The protocol collects its own cut through the same pull-payment ledger.
    await bounty.connect(fees).claim(usdcAddr, fees.address);
    expect(await usdc.balanceOf(fees.address)).to.equal(fee);
  });

  it("refuses native value sent to an ERC-20 program", async function () {
    const { bounty, usdc, client } = await loadFixture(usdcFixture);
    const id = await bounty.nextProgramId();
    await bounty
      .connect(client)
      .createProgram(await usdc.getAddress(), SCOPE, SCOPE_URI, tiers(1n, 2n, 3n, CRIT), TRIAGE, EMBARGO);

    await expect(
      bounty.connect(client).fundProgram(id, CRIT, { value: 1n })
    ).to.be.revertedWithCustomError(bounty, "NativeValueUnexpected");
  });

  it("refuses a native funding call whose value disagrees with the amount", async function () {
    const { bounty, client } = await loadFixture(H.fixture);
    const id = await bounty.nextProgramId();
    await bounty
      .connect(client)
      .createProgram(ETH, SCOPE, SCOPE_URI, tiers(1n, 2n, 3n, CRIT), TRIAGE, EMBARGO);

    await expect(
      bounty.connect(client).fundProgram(id, CRIT, { value: CRIT - 1n })
    ).to.be.revertedWithCustomError(bounty, "ZeroAmount");
  });
});
