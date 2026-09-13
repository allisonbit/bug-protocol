/**
 * Public Supabase config, safe for the browser bundle. Only the URL and the
 * anon (publishable) key live here; both are designed to ship to clients and
 * are protected by row-level security, never the service role key.
 *
 * The references to `process.env.NEXT_PUBLIC_*` are intentionally literal so
 * Next inlines them into the client bundle at build time.
 */
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "";

/** True when the public client can be constructed (auth + RLS-scoped reads). */
export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
