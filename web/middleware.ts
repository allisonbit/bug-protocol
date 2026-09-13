import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth session on every request and re-issues the
 * rotated cookies, so server components always see a valid user. No-op when
 * Supabase isn't configured yet. Never blocks a request; auth gating is done
 * per-page/route, not here.
 */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return res;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });

  // Touching getUser() triggers the refresh + Set-Cookie when the token rotated.
  await supabase.auth.getUser();
  return res;
}

export const config = {
  matcher: [
    // everything except Next internals, static assets, and the downloads dir
    "/((?!_next/static|_next/image|favicon.ico|downloads|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
