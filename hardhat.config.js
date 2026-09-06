require("@nomicfoundation/hardhat-toolbox");

/**
 * Robinhood Chain (mainnet) — chain id 4663, native asset ETH.
 * Deploy target for $BUG. Keys come from the environment; nothing is
 * committed. Set BUG_DEPLOYER_KEY only when actually deploying.
 */
const deployerKey = process.env.BUG_DEPLOYER_KEY;

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Robinhood Chain is an Arbitrum Orbit L2; cancun is safe here.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 4663,
    },
    robinhood: {
      url: process.env.BUG_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
};
