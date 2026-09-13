import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CONFIGURED } from "./shared";

/**
 * A request-scoped Supabase client bound to the caller's auth cookies. Reads
 * and writes run as the signed-in user, so row-level security is what actually
 * enforces "you can only edit your own program", not app code. Use this in
 * server components (reads) and route handlers / server actions (writes).
 *
 * In a server component the cookie `setAll` is a no-op (you can't set cookies
 * while streaming a response); the middleware refreshes the session instead.
 */
export async function supabaseServer() {
  if (!SUPABASE_CONFIGURED) return null;
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* called from a server component; middleware handles refresh */
        }
      },
    },
  });
}

/** The signed-in user for this request, or null. Safe when Supabase is unset. */
export async function currentUser() {
  const sb = await supabaseServer();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}
