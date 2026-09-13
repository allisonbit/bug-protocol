import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { resolveChainMeta, type ChainMeta } from "./chains.js";

export type GlobalOpts = {
  chain?: string;
  rpc?: string;
  bounty?: string;
  key?: string;
};

export type Ctx = {
  meta: ChainMeta;
  rpc: string;
  bounty: Address | null;
  publicClient: PublicClient;
  account?: PrivateKeyAccount;
  walletClient?: WalletClient;
};

function normalizeAddr(v: string | undefined): Address | null {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
}

function normalizeKey(v: string): Hex {
  const k = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("private key must be 32 bytes hex (64 hex chars, optional 0x prefix)");
  }
  return k as Hex;
}

export function resolveCtx(opts: GlobalOpts): Ctx {
  const meta = resolveChainMeta(opts.chain ?? process.env.BUG_CHAIN);
  const rpc = opts.rpc ?? process.env.BUG_RPC_URL ?? meta.chain.rpcUrls.default.http[0]!;
  const bounty =
    normalizeAddr(opts.bounty) ??
    normalizeAddr(process.env.BUG_BOUNTY_ADDRESS) ??
    normalizeAddr(process.env[`BUG_BOUNTY_${meta.chain.id}`]);

  const publicClient = createPublicClient({ chain: meta.chain, transport: http(rpc) });

  const key = opts.key ?? process.env.BUG_PRIVATE_KEY;
  let account: PrivateKeyAccount | undefined;
  let walletClient: WalletClient | undefined;
  if (key) {
    account = privateKeyToAccount(normalizeKey(key));
    walletClient = createWalletClient({ account, chain: meta.chain, transport: http(rpc) });
  }

  return { meta, rpc, bounty, publicClient, account, walletClient };
}

export function requireBounty(ctx: Ctx): Address {
  if (!ctx.bounty) {
    throw new Error(
      `no bounty contract address for ${ctx.meta.label}. Pass --bounty 0x... or set BUG_BOUNTY_ADDRESS (or BUG_BOUNTY_${ctx.meta.chain.id}).`,
    );
  }
  return ctx.bounty;
}

export function requireSigner(ctx: Ctx): { account: PrivateKeyAccount; walletClient: WalletClient } {
  if (!ctx.account || !ctx.walletClient) {
    throw new Error("no signer configured. Pass --key 0x... or set BUG_PRIVATE_KEY to send transactions.");
  }
  return { account: ctx.account, walletClient: ctx.walletClient };
}
