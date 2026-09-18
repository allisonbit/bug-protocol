import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChainMeta, addressUrlOn, txUrlOn, type ChainMeta } from "./chains.js";

/**
 * Chain + address wiring from the environment. Read tools need only an RPC
 * (public client). Write tools need PRIVATE_KEY; if it's missing we throw a
 * clear, actionable error the agent can surface instead of a cryptic failure.
 */
export function meta(): ChainMeta {
  return activeChainMeta();
}

function envAddress(key: string): Address | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  if (!isAddress(v)) throw new Error(`${key} is not a valid address: ${v}`);
  return v;
}

/** BugBounty contract address (BOUNTY_ADDRESS). Throws with guidance if unset. */
export function bountyAddress(): Address {
  const a = envAddress("BOUNTY_ADDRESS");
  if (!a) {
    throw new Error(
      "BOUNTY_ADDRESS is not set. The $SWARM protocol is not yet deployed on this chain, or you have not pointed the server at it. Set BOUNTY_ADDRESS to the deployed BugBounty contract.",
    );
  }
  return a;
}

export function bugTokenAddress(): Address | undefined {
  return envAddress("BUG_TOKEN");
}

/** USDC for the active chain: env override (USDC) wins, else the canonical value. */
export function usdcAddress(): Address | null {
  const override = envAddress("USDC");
  return override ?? meta().usdc;
}

let _public: PublicClient | undefined;
export function publicClient(): PublicClient {
  if (!_public) {
    const m = meta();
    _public = createPublicClient({
      chain: m.chain,
      transport: http(process.env.RPC_URL ?? m.chain.rpcUrls.default.http[0]),
    });
  }
  return _public;
}

export function account(): Account {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "This action requires a signer, but PRIVATE_KEY is not set. Export PRIVATE_KEY (a 0x-prefixed 32-byte hex key for the hunter/owner wallet) to enable write actions. Read-only tools work without it.",
    );
  }
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  return privateKeyToAccount(key);
}

export function walletClient(): WalletClient {
  const m = meta();
  return createWalletClient({
    account: account(),
    chain: m.chain,
    transport: http(process.env.RPC_URL ?? m.chain.rpcUrls.default.http[0]),
  });
}

export const txUrl = (hash: string) => txUrlOn(meta(), hash);
export const addressUrl = (a: string) => addressUrlOn(meta(), a);

/** Wait for a receipt and shape a consistent result for tool output. */
export async function receipt(hash: Hash) {
  const r = await publicClient().waitForTransactionReceipt({ hash });
  return {
    hash,
    status: r.status, // "success" | "reverted"
    blockNumber: r.blockNumber,
    explorerUrl: txUrl(hash),
  };
}
