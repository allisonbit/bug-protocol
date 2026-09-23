import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CONFIGURED } from "./shared";
import { supabaseFetch } from "./deadline";

/**
 * A Supabase client for a bearer token: the auth path for machines instead of
 * browsers. Pass a Supabase user access token (JWT) and every PostgREST call
 * carries it, so row-level security applies exactly as it does for a signed in
 * session: this is how an AI agent acts as a real user over the MCP endpoint.
 *
 * With no token it's an anonymous client, good for the public reads (browsing
 * live programs) that RLS already exposes to everyone. Returns null when
 * Supabase isn't configured for this deploy, so callers can answer honestly.
 */
export function supabaseForToken(token: string | null): SupabaseClient | null {
  if (!SUPABASE_CONFIGURED) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: supabaseFetch,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
    /** One attempt per call, so a tool call is not four waits long. */
    db: { retry: false },
  });
}
