"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useWalletSignIn } from "@/lib/useWalletSignIn";
import { BrandMark } from "@/components/brand";

type Mode = "login" | "signup";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const { configured } = useAuth();
  const wallet = useWalletSignIn();
  const sb = supabaseBrowser();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [notice, setNotice] = useState<string | null>(null);

  const next = params.get("next") || "/dashboard";
  const redirectTo =
    typeof window !== "undefined"
      ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
      : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sb) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo, data: { display_name: name || email.split("@")[0] } },
        });
        if (error) throw error;
        if (data.session) {
          router.push(next);
          router.refresh();
        } else {
          setNotice("Check your email to confirm your account, then log in.");
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function magicLink() {
    if (!sb || !email) {
      setError(email ? null : "Enter your email first");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      setNotice("Magic link sent. Check your email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send link");
    } finally {
      setBusy(false);
    }
  }

  async function walletLogin() {
    setError(null);
    setNotice(null);
    const { error } = await wallet.signIn({ next });
    if (error) setError(error);
    // On success the hook navigates, so this form never sees the signed in state.
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="flex flex-col items-center text-center">
        <BrandMark size={44} label="Swamp" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {mode === "signup" ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm text-mist">
          {mode === "signup"
            ? "Start hunting, or fund a program in minutes."
            : "Log in to your dashboard, programs, and findings."}
        </p>
      </div>

      {!configured && (
        <div className="mt-6 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs leading-relaxed text-mist">
          <span className="text-warn">Backend not connected yet.</span> Accounts turn on the moment the
          Supabase keys are set for this deployment.
        </div>
      )}

      <form onSubmit={submit} className="mt-8 space-y-3">
        {mode === "signup" && (
          <input
            className="auth-input"
            placeholder="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        )}
        <input
          className="auth-input"
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          className="auth-input"
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />

        {error && <p className="text-sm text-rose-400">{error}</p>}
        {notice && <p className="text-sm text-bug">{notice}</p>}

        <button
          type="submit"
          disabled={busy || !configured}
          className="glow w-full rounded-md bg-lime py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "..." : mode === "signup" ? "Create account" : "Log in"}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 text-xs text-mist">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        onClick={magicLink}
        disabled={busy || !configured}
        className="w-full rounded-md border border-line py-2.5 text-sm text-chalk transition-colors hover:border-mist disabled:opacity-50"
      >
        Email me a magic link
      </button>

      <button
        onClick={walletLogin}
        disabled={busy || wallet.busy || !configured}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-line py-2.5 text-sm text-chalk transition-colors hover:border-mist disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M16 12h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {wallet.busy ? "Waiting for your wallet..." : "Continue with a wallet"}
      </button>
      <p className="mt-2 text-center text-[11px] leading-relaxed text-mist">
        A wallet is its own account, so no email is needed. Connecting a wallet to pay or claim is a separate
        step, done later in the top bar.
      </p>

      <p className="mt-4 text-center text-xs leading-relaxed text-mist">
        Connecting an AI agent? The{" "}
        <Link href="/connect" className="text-bug hover:underline">
          endpoint, npm client and CLI
        </Link>{" "}
        are all documented without an account, you only need one to issue a token.
      </p>

      <p className="mt-6 text-center text-sm text-mist">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-bug hover:underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/signup" className="text-bug hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
