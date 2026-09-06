/**
 * Deploys BugBounty.
 *
 * Required env:
 *   BUG_TOKEN         $BUG address (the token you launch on pons.family).
 *                     On the local network, omit it and a mock is deployed.
 *   BUG_FEE_RECIPIENT Address that collects the protocol fee.
 *
 * Optional env:
 *   BUG_FEE_BPS       Protocol fee in basis points, default 500 (5%), max 1000.
 *   BUG_ARBITER       Arbiter address. Wired immediately if set — it is one-shot,
 *                     so leaving it unset is the safe default until the
 *                     arbitration contract exists.
 *   BUG_SUBMISSION_BOND / BUG_PROGRAM_BOND   Bond terms, in whole $BUG.
 *
 * Deploying to Robinhood Chain requires --network robinhood AND
 * BUG_CONFIRM_DEPLOY=yes, so a mainnet deploy is never a typo away.
 */
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal = network.name === "hardhat" || network.name === "localhost";

  if (!isLocal && process.env.BUG_CONFIRM_DEPLOY !== "yes") {
    throw new Error(
      `Refusing to deploy to "${network.name}" without BUG_CONFIRM_DEPLOY=yes. ` +
        `This spends real funds and the arbiter slot is one-shot.`
    );
  }

  let bugToken = process.env.BUG_TOKEN;
  if (!bugToken) {
    if (!isLocal) throw new Error("BUG_TOKEN is required outside the local network.");
    const mock = await (await ethers.getContractFactory("MockERC20")).deploy("Bug", "BUG");
    bugToken = await mock.getAddress();
    console.log(`[local] deployed mock $BUG at ${bugToken}`);
  }

  const feeRecipient = process.env.BUG_FEE_RECIPIENT || deployer.address;
  const feeBps = BigInt(process.env.BUG_FEE_BPS ?? 500);

  console.log(`network      ${network.name} (chainId ${network.config.chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`$BUG         ${bugToken}`);
  console.log(`feeRecipient ${feeRecipient}`);
  console.log(`feeBps       ${feeBps}`);

  const bounty = await (
    await ethers.getContractFactory("BugBounty")
  ).deploy(deployer.address, bugToken, feeRecipient, feeBps);
  await bounty.waitForDeployment();
  const addr = await bounty.getAddress();
  console.log(`\nBugBounty    ${addr}`);

  const subBond = process.env.BUG_SUBMISSION_BOND;
  const progBond = process.env.BUG_PROGRAM_BOND;
  if (subBond || progBond) {
    const tx = await bounty.setBondTerms(
      ethers.parseEther(subBond ?? "0"),
      ethers.parseEther(progBond ?? "0")
    );
    await tx.wait();
    console.log(`bond terms   submission=${subBond ?? 0} $BUG  program=${progBond ?? 0} $BUG`);
  }

  if (process.env.BUG_ARBITER) {
    const tx = await bounty.setArbiter(process.env.BUG_ARBITER);
    await tx.wait();
    console.log(`arbiter      ${process.env.BUG_ARBITER} (one-shot, now locked)`);
  } else {
    console.log(`arbiter      UNSET — escalations cannot be resolved until setArbiter is called`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
