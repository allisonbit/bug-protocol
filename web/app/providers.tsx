"use client";

import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { Chain } from "viem";
import { SUPPORTED_CHAINS } from "@/lib/chains";
import { AuthProvider } from "@/lib/auth-context";

/**
 * Multi-chain config: Robinhood (home), Base, Arbitrum, Optimism, Base Sepolia.
 * Injected wallets work with no configuration; WalletConnect needs a project id
 * from the user's own account, so it is added only when that id is present
 * rather than shipping a broken connector.
 */
const chains = SUPPORTED_CHAINS as unknown as readonly [Chain, ...Chain[]];

const config = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])),
  ssr: true,
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
