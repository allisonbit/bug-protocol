const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ETH = ethers.ZeroAddress;
const Sev = { None: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };
const Status = {
  Pending: 0,
  Accepted: 1,
  Rejected: 2,
  Duplicate: 3,
  Spam: 4,
  Escalated: 5,
  Resolved: 6,
};
const PStatus = { Draft: 0, Live: 1, Paused: 2, Closed: 3 };

const DAY = 24 * 60 * 60;
const TRIAGE = 7 * DAY;
const EMBARGO = 30 * DAY;
const DISPUTE = 7 * DAY;

const SUB_BOND = ethers.parseEther("100");
const PROG_BOND = ethers.parseEther("1000");

const tiers = (low, med, high, crit) => [0n, low, med, high, crit];

async function fixture() {
  const [deployer, client, hunter, hunter2, arbiter, fees] = await ethers.getSigners();

  const bug = await (await ethers.getContractFactory("MockERC20")).deploy("Bug", "BUG");
  const bounty = await (
    await ethers.getContractFactory("BugBounty")
  ).deploy(deployer.address, await bug.getAddress(), fees.address, 500); // 5% fee

  await bounty.setArbiter(arbiter.address);
  await bounty.setBondTerms(SUB_BOND, PROG_BOND);

  for (const who of [client, hunter, hunter2]) {
    await bug.mint(who.address, ethers.parseEther("100000"));
    await bug.connect(who).approve(await bounty.getAddress(), ethers.MaxUint256);
  }

  return { bounty, bug, deployer, client, hunter, hunter2, arbiter, fees };
}

module.exports = { fixture, ETH, Sev, Status, PStatus, DAY, TRIAGE, EMBARGO, DISPUTE, SUB_BOND, PROG_BOND, tiers };
