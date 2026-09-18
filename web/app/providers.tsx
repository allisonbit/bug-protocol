"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { RainbowKitProvider, darkTheme, type Theme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { Chain } from "viem";
import { SUPPORTED_CHAINS } from "@/lib/chains";
import { AuthProvider } from "@/lib/auth-context";

/**
 * Wallet connection, with RainbowKit on top of wagmi.
 *
 * MULTICHAIN. Robinhood Chain is home, then Base, Arbitrum, Optimism and Base
 * Sepolia. The chain objects come from lib/chains.ts, so the picker and the rest
 * of the app cannot disagree about which networks exist.
 *
 * WHY THERE IS NO BRANDED WALLET LIST HERE. RainbowKit's named connectors are
 * exported from one barrel, `@rainbow-me/rainbowkit/wallets`, and importing that
 * barrel pulls in Coinbase's connector and with it @coinbase/cdp-sdk. That
 * package ships modules this build cannot resolve, and because the barrel is
 * imported eagerly the whole build fails on code that would never have run.
 * Removing just the Coinbase entry is not enough: the barrel imports it anyway.
 *
 * So the connector here is wagmi's own injected one, which the browser supplies,
 * and RainbowKit still provides the modal, the account view, the chain switching
 * and the theming over it. Nothing about the user experience is missing except
 * the wallet logos.
 *
 * TO ADD THE BRANDED LIST. Get a WalletConnect project id from cloud.reown.com,
 * set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, and import the individual wallet
 * modules by their deep paths rather than from the barrel, so the Coinbase
 * connector is never pulled in. A project id is required for those connectors
 * regardless, so this is a single change made once, not a workaround.
 */
const chains = SUPPORTED_CHAINS as unknown as readonly [Chain, ...Chain[]];

const config = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])),
  ssr: true,
});

/**
 * RainbowKit's accent, matched to the design system rather than left at the
 * library default, so the modal reads as part of the site instead of a widget
 * bolted onto it. Lime is the button fill everywhere else here.
 */
const ACCENT = "#d4fc50";

const WALLET_THEME: Theme = darkTheme({
  accentColor: ACCENT,
  accentColorForeground: "#0d0d0d",
  borderRadius: "large",
  overlayBlur: "small",
  fontStack: "system",
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  // RainbowKit takes its theme as a prop rather than from CSS, which makes the
  // wallet modal the one surface that could stay bright while the page went
  // dark. The site is dark only, so this is a constant: there is no media query
  // left to keep in step with, and nothing to render light and then flip.
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={WALLET_THEME} modalSize="compact" appInfo={{ appName: "Swamp" }}>
          <AuthProvider>{children}</AuthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
