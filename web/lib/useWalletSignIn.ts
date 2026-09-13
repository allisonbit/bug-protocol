"use client";

import { useCallback, useState } from "react";
import { useAccount, useChainId, useConnect, useSignMessage } from "wagmi";
import { injected } from "wagmi/connectors";

/**
 * Wallet sign-in as its own path, independent of email.
 *
 * Connects the browser wallet if needed, asks the server for a challenge, has the
 * wallet sign it, and lets the server mint the session. On success we do a full
 * navigation so the freshly-set auth cookies are visible to both the client and
 * the server-rendered pages, with no half-refreshed header.
 *
 * This is deliberately separate from the wagmi connection used for on-chain
 * actions: signing in proves who you are; connecting a wallet lets you pay and
 * claim. The two are shown as different things in the UI on purpose.
 */
export function useWalletSignIn() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectAsync, isPending: connecting } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(
    async (opts?: { next?: string }): Promise<{ error: string | null }> => {
      setError(null);
      setBusy(true);
      try {
        let addr = address ?? null;
        if (!isConnected || !addr) {
          const res = await connectAsync({ connector: injected() });
          addr = res.accounts[0] ?? null;
        }
        if (!addr) return { error: "No wallet address available." };

        const nonceRes = await fetch("/api/auth/wallet/nonce", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: addr, chainId }),
        });
        const challenge = (await nonceRes.json().catch(() => null)) as { message?: string; error?: string } | null;
        if (!nonceRes.ok || !challenge?.message) {
          return { error: challenge?.error ?? "Could not start wallet sign-in." };
        }

        const signature = await signMessageAsync({ message: challenge.message });

        const verifyRes = await fetch("/api/auth/wallet/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: challenge.message, signature }),
        });
        const verified = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
        if (!verifyRes.ok) return { error: verified?.error ?? "Wallet sign-in failed." };

        window.location.assign(opts?.next ?? "/dashboard");
        return { error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly = /reject|denied|cancel/i.test(msg)
          ? "Signature request was rejected."
          : /no ethereum|not found|provider/i.test(msg)
            ? "No browser wallet detected. Install a wallet extension to sign in this way."
            : msg || "Wallet sign-in failed.";
        setError(friendly);
        return { error: friendly };
      } finally {
        setBusy(false);
      }
    },
    [address, isConnected, chainId, connectAsync, signMessageAsync],
  );

  return { signIn, busy: busy || connecting, error };
}
