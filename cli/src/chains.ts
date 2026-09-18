import { defineChain, type Address, type Chain } from "viem";
import { base, baseSepolia, arbitrum, optimism } from "viem/chains";

// Chain registry mirrored from web/lib/chains.ts. The CLI resolves the bounty
// address from flags/env (see config.ts), so this table only carries static
// metadata: the viem chain (with its default public RPC), explorer, and the
// canonical USDC address so USDC-denominated escrow renders/parses correctly.

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export type ChainMeta = {
  chain: Chain;
  label: string;
  short: string;
  explorer: string;
  usdc: Address | null;
  testnet?: boolean;
};

export const CHAINS: Record<number, ChainMeta> = {
  [robinhoodChain.id]: {
    chain: robinhoodChain,
    label: "Robinhood Chain",
    short: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    usdc: null,
  },
  [base.id]: {
    chain: base,
    label: "Base",
    short: "base",
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  [arbitrum.id]: {
    chain: arbitrum,
    label: "Arbitrum One",
    short: "arbitrum",
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  [optimism.id]: {
    chain: optimism,
    label: "Optimism",
    short: "optimism",
    explorer: "https://optimistic.etherscan.io",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    label: "Base Sepolia",
    short: "base-sepolia",
    explorer: "https://sepolia.basescan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    testnet: true,
  },
};

export const DEFAULT_CHAIN_ID = robinhoodChain.id;

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

export function chainMeta(id?: number): ChainMeta {
  return (id !== undefined ? CHAINS[id] : undefined) ?? CHAINS[DEFAULT_CHAIN_ID]!;
}

/** Accepts a chain id ("8453") or a short/label name ("base", "Robinhood Chain"). */
export function resolveChainMeta(input?: string): ChainMeta {
  if (!input) return chainMeta(DEFAULT_CHAIN_ID);
  const asNum = Number(input);
  if (Number.isInteger(asNum) && CHAINS[asNum]) return CHAINS[asNum]!;
  const needle = input.toLowerCase();
  const hit = Object.values(CHAINS).find(
    (m) => m.short === needle || m.label.toLowerCase() === needle,
  );
  if (!hit) {
    const known = Object.values(CHAINS).map((m) => m.short).join(", ");
    throw new Error(`unknown chain "${input}". Known: ${known}, or a numeric chain id.`);
  }
  return hit;
}

export const txUrlOn = (id: number | undefined, hash: string) => `${chainMeta(id).explorer}/tx/${hash}`;
export const addressUrlOn = (id: number | undefined, a: string) => `${chainMeta(id).explorer}/address/${a}`;

/**
 * Symbol + decimals for a reward/bond token on a chain. Recognises the native
 * coin (18), the chain's canonical USDC (6), and an optional $SWARM address (18).
 * Anything else is treated as an 18-decimal ERC-20 named "TOKEN".
 */
export function assetInfo(chainId: number | undefined, token: string, bugToken?: string | null): { symbol: string; decimals: number } {
  const m = chainMeta(chainId);
  const t = token.toLowerCase();
  if (t === NATIVE) return { symbol: m.chain.nativeCurrency.symbol, decimals: 18 };
  if (m.usdc && t === m.usdc.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  if (bugToken && t === bugToken.toLowerCase()) return { symbol: "$SWARM", decimals: 18 };
  return { symbol: "TOKEN", decimals: 18 };
}
