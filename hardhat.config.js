require("@nomicfoundation/hardhat-toolbox");

/**
 * Robinhood Chain (mainnet): chain id 4663, native asset ETH.
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
    /**
     * A running `npx hardhat node`, the in-process network served over HTTP.
     *
     * Deliberately the same chainId as `hardhat` and as Robinhood Chain, because
     * that is what makes local testing a config change rather than a code change:
     * the web app resolves its contract addresses from `NEXT_PUBLIC_*_4663`, so
     * pointing those at this node (plus `NEXT_PUBLIC_RPC_URL`) runs the entire
     * hunter loop in a browser with no application edits at all.
     */
    localhost: {
      url: process.env.BUG_LOCAL_RPC_URL || "http://127.0.0.1:8545",
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
