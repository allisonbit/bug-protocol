import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase, service-role. All marketplace storage and mirror access
 * goes through API route handlers using this client, so no Supabase key is ever
 * shipped to the browser. Env names are resolved defensively: the Vercel↔
 * Supabase integration sets `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, but we
 * also accept the `NEXT_PUBLIC_` variants and an anon-key fallback so a project
 * wired any of the usual ways just works. When nothing is set, `isConfigured` is
 * false and the marketplace routes answer honestly instead of throwing — the
 * same "renders before it's wired" contract the on-chain reads follow.
 */
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

export const SUPABASE_CONFIGURED = Boolean(url && serviceKey);

/** Public Storage bucket the tool artifacts + metadata JSON live in. */
export const TOOLS_BUCKET = process.env.SUPABASE_TOOLS_BUCKET ?? "tools";

let _client: SupabaseClient | null = null;

/** The admin client, or null when Supabase isn't configured for this project. */
export function supabaseAdmin(): SupabaseClient | null {
  if (!SUPABASE_CONFIGURED) return null;
  if (!_client) {
    _client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _client;
}

/** A row in the `tools` mirror table. Keyed by (chain_id, tool_id) — the same
 * identity the on-chain registry uses, so the mirror always points back to a
 * verifiable listing. */
export type ToolRow = {
  chain_id: number;
  tool_id: number;
  publisher: string;
  name: string;
  description: string | null;
  platform: number;
  category: number;
  semver: string | null;
  checksum: string; // 0x + 64 hex, matches on-chain
  artifact_url: string;
  artifact_name: string;
  metadata_url: string;
  source_url: string | null;
  tx_hash: string | null;
  downloads: number;
  flagged: boolean;
  flag_count: number;
  created_at: string;
};
