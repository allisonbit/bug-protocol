import { defineChain, type Address, type Chain } from "viem";
import { base, baseSepolia, arbitrum, optimism } from "viem/chains";

/**
 * Chain registry: mirrors web/lib/chains.ts. USDC addresses are the canonical
 * Circle deployments so USDC-denominated bounties work with no extra config.
 * The active chain is chosen by the CHAIN env var (id or short slug); default
 * is Robinhood Chain (4663), the home chain $BUG launches on.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export type ChainMeta = {
  chain: Chain;
  label: string;
  short: string;
  slug: string;
  explorer: string;
  usdc: Address | null;
  testnet?: boolean;
};

export const CHAINS: Record<number, ChainMeta> = {
  [robinhoodChain.id]: {
    chain: robinhoodChain,
    label: "Robinhood Chain",
    short: "Robinhood",
    slug: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    usdc: null,
  },
  [base.id]: {
    chain: base,
    label: "Base",
    short: "Base",
    slug: "base",
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  [arbitrum.id]: {
    chain: arbitrum,
    label: "Arbitrum One",
    short: "Arbitrum",
    slug: "arbitrum",
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  [optimism.id]: {
    chain: optimism,
    label: "Optimism",
    short: "Optimism",
    slug: "optimism",
    explorer: "https://optimistic.etherscan.io",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    label: "Base Sepolia",
    short: "Base Sepolia",
    slug: "base-sepolia",
    explorer: "https://sepolia.basescan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    testnet: true,
  },
};

export const DEFAULT_CHAIN_ID = robinhoodChain.id;

/** Resolve the active chain from the CHAIN env var (numeric id or slug/short). */
export function activeChainMeta(): ChainMeta {
  const raw = (process.env.CHAIN ?? "").trim().toLowerCase();
  if (!raw) return CHAINS[DEFAULT_CHAIN_ID];
  const asId = Number(raw);
  if (Number.isFinite(asId) && CHAINS[asId]) return CHAINS[asId];
  const bySlug = Object.values(CHAINS).find(
    (c) => c.slug === raw || c.short.toLowerCase() === raw || c.label.toLowerCase() === raw,
  );
  if (bySlug) return bySlug;
  throw new Error(
    `Unknown CHAIN "${process.env.CHAIN}". Use a chain id (${Object.keys(CHAINS).join(", ")}) or a slug (${Object.values(CHAINS)
      .map((c) => c.slug)
      .join(", ")}).`,
  );
}

export const txUrlOn = (meta: ChainMeta, hash: string) => `${meta.explorer}/tx/${hash}`;
export const addressUrlOn = (meta: ChainMeta, a: string) => `${meta.explorer}/address/${a}`;

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
