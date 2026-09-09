/**
 * Back-compat shim. The chain registry now lives in ./chains (multi-chain).
 * Single-argument txUrl/addressUrl resolve against the default (Robinhood)
 * chain; chain-aware code should use useExplorer() from ./reads or the *On
 * helpers so links follow the connected wallet's chain.
 */
export {
  robinhoodChain,
  CHAINS,
  SUPPORTED_CHAINS,
  DEFAULT_CHAIN_ID,
  chainMeta,
  txUrlOn,
  addressUrlOn,
  assetInfo,
  NATIVE,
  type ChainMeta,
} from "./chains";

import { DEFAULT_CHAIN_ID, chainMeta, txUrlOn, addressUrlOn } from "./chains";

export const EXPLORER = chainMeta(DEFAULT_CHAIN_ID).explorer;
export const txUrl = (hash: string) => txUrlOn(DEFAULT_CHAIN_ID, hash);
export const addressUrl = (a: string) => addressUrlOn(DEFAULT_CHAIN_ID, a);
