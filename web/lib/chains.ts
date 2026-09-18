import { defineChain, type Address, type Chain } from "viem";
import { base, baseSepolia, arbitrum, optimism } from "viem/chains";

/**
 * Robinhood Chain, the Arbitrum Orbit L2 that $SWARM launches on.
 * chainId 4663, ~101 ms blocks, native asset ETH.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

const addr = (v: string | undefined): Address | null =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;

/**
 * Per-chain metadata. `bounty`/`bugToken` come from env so the same build serves
 * every deployment; `usdc` is the canonical Circle address so USDC-denominated
 * escrow works the moment the contract is deployed on that chain. The protocol
 * needs neither $SWARM nor a Robinhood deployment to function; any chain here can
 * run pure-ETH or USDC bounties (req: "even without our contract it can work").
 */
export type ChainMeta = {
  chain: Chain;
  label: string;
  short: string;
  explorer: string;
  usdc: Address | null;
  bounty: Address | null;
  bugToken: Address | null;
  toolRegistry: Address | null;
  testnet?: boolean;
};

export const CHAINS: Record<number, ChainMeta> = {
  [robinhoodChain.id]: {
    chain: robinhoodChain,
    label: "Robinhood Chain",
    short: "Robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    usdc: addr(process.env.NEXT_PUBLIC_USDC_4663),
    // NEXT_PUBLIC_BOUNTY_ADDRESS kept as the legacy/default key for Robinhood.
    bounty: addr(process.env.NEXT_PUBLIC_BOUNTY_4663) ?? addr(process.env.NEXT_PUBLIC_BOUNTY_ADDRESS),
    bugToken: addr(process.env.NEXT_PUBLIC_BUG_TOKEN_4663) ?? addr(process.env.NEXT_PUBLIC_BUG_TOKEN),
    toolRegistry: addr(process.env.NEXT_PUBLIC_TOOLS_4663) ?? addr(process.env.NEXT_PUBLIC_TOOLS_ADDRESS),
  },
  [base.id]: {
    chain: base,
    label: "Base",
    short: "Base",
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    bounty: addr(process.env.NEXT_PUBLIC_BOUNTY_8453),
    bugToken: addr(process.env.NEXT_PUBLIC_BUG_TOKEN_8453),
    toolRegistry: addr(process.env.NEXT_PUBLIC_TOOLS_8453),
  },
  [arbitrum.id]: {
    chain: arbitrum,
    label: "Arbitrum One",
    short: "Arbitrum",
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    bounty: addr(process.env.NEXT_PUBLIC_BOUNTY_42161),
    bugToken: addr(process.env.NEXT_PUBLIC_BUG_TOKEN_42161),
    toolRegistry: addr(process.env.NEXT_PUBLIC_TOOLS_42161),
  },
  [optimism.id]: {
    chain: optimism,
    label: "Optimism",
    short: "Optimism",
    explorer: "https://optimistic.etherscan.io",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    bounty: addr(process.env.NEXT_PUBLIC_BOUNTY_10),
    bugToken: addr(process.env.NEXT_PUBLIC_BUG_TOKEN_10),
    toolRegistry: addr(process.env.NEXT_PUBLIC_TOOLS_10),
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    label: "Base Sepolia",
    short: "Base Sepolia",
    explorer: "https://sepolia.basescan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    bounty: addr(process.env.NEXT_PUBLIC_BOUNTY_84532),
    bugToken: addr(process.env.NEXT_PUBLIC_BUG_TOKEN_84532),
    toolRegistry: addr(process.env.NEXT_PUBLIC_TOOLS_84532),
    testnet: true,
  },
};

/**
 * Order shown in the switcher; Robinhood first (home chain), testnet last.
 *
 * There is deliberately no separate "local" chain. This repo's Hardhat node runs
 * at chainId 4663, the same as Robinhood Chain (see hardhat.config.js), so local
 * testing is a pointer change and not a code change: set
 * `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545`, `NEXT_PUBLIC_BOUNTY_4663` and
 * `NEXT_PUBLIC_BUG_TOKEN_4663` to a local deployment and the whole hunter loop
 * runs here with no application edits. `scripts/e2e-local.js` exercises the same
 * loop from the command line.
 */
export const SUPPORTED_CHAINS = [robinhoodChain, base, arbitrum, optimism, baseSepolia] as const;

export const DEFAULT_CHAIN_ID = robinhoodChain.id;

export const chainMeta = (id?: number): ChainMeta => CHAINS[id ?? DEFAULT_CHAIN_ID] ?? CHAINS[DEFAULT_CHAIN_ID];

export const txUrlOn = (id: number | undefined, hash: string) => `${chainMeta(id).explorer}/tx/${hash}`;
export const addressUrlOn = (id: number | undefined, a: string) => `${chainMeta(id).explorer}/address/${a}`;

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/**
 * Symbol + decimals for a reward/bond token on a given chain. Recognises the
 * native coin (18), the chain's canonical USDC (6), and $SWARM (18); anything
 * else is treated as an 18-decimal ERC-20 named "TOKEN". This is what makes
 * escrow denominated in ETH *or* USDC render and parse correctly.
 */
export function assetInfo(chainId: number | undefined, token: string): { symbol: string; decimals: number } {
  const m = chainMeta(chainId);
  const t = token.toLowerCase();
  if (t === NATIVE) return { symbol: m.chain.nativeCurrency.symbol, decimals: 18 };
  if (m.usdc && t === m.usdc.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  if (m.bugToken && t === m.bugToken.toLowerCase()) return { symbol: "$SWARM", decimals: 18 };
  return { symbol: "TOKEN", decimals: 18 };
}
