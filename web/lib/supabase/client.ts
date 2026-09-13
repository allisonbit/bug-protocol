"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CONFIGURED } from "./shared";

/**
 * The browser Supabase client. @supabase/ssr writes the auth session into
 * cookies that the server client (and middleware) read back, so a plain
 * client-side `signInWithPassword` / `signUp` is enough to establish a session
 * the server trusts, with no separate server action round-trip.
 *
 * Memoised so every hook shares one client (one auth listener, one socket).
 */
let _client: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (!SUPABASE_CONFIGURED) return null;
  if (!_client) _client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

export { SUPABASE_CONFIGURED };
