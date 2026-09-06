const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { ETH, Sev, Status, PStatus, DAY, TRIAGE, EMBARGO, DISPUTE, SUB_BOND, PROG_BOND, tiers } = H;

const SCOPE = ethers.keccak256(ethers.toUtf8Bytes("scope+safe-harbour v1"));
const SCOPE_URI = "ipfs://scope-v1";
const CRIT = ethers.parseEther("10");

/** Creates a Draft program paying 1/2/5/10 ETH by severity. */
async function draft(bounty, client, rewardToken = ETH) {
  const id = await bounty.nextProgramId();
  await bounty
    .connect(client)
    .createProgram(
      rewardToken,
      SCOPE,
      SCOPE_URI,
      tiers(ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("5"), CRIT),
      TRIAGE,
      EMBARGO
    );
  return id;
}

/** Draft + bond + fund + go Live. `cover` is how many Critical payouts to escrow. */
async function live(bounty, client, cover = 1n) {
  const id = await draft(bounty, client);
  await bounty.connect(client).bondProgram(id, PROG_BOND);
  await bounty.connect(client).fundProgram(id, CRIT * cover, { value: CRIT * cover });
  await bounty.connect(client).setStatus(id, PStatus.Live);
  return id;
}

/** Commit to a report the way the contract expects. */
function commit(reportURI, salt, hunter) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "address"], [reportURI, salt, hunter])
  );
}

const SALT = ethers.id("salt-1");
const REPORT = "ipfs://encrypted-report-1";

module.exports = { draft, live, commit, SALT, REPORT, SCOPE, SCOPE_URI, CRIT };
