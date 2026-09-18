import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refreshes the Supabase auth session on every request and re-issues the
 * rotated cookies, so server components always see a valid user. No-op when
 * Supabase isn't configured yet. Never blocks a request; auth gating is done
 * per-page/route, not here.
 *
 * Next 16 renamed this convention: the file is `proxy.ts` and the exported
 * function must be named `proxy` (or be the default export). The body is the
 * old middleware, unchanged.
 */
/**
 * RFC 9727 section 3 says a publisher advertises its API catalog by carrying the
 * link relation on other responses, so a crawler that fetched the homepage learns
 * the catalog exists instead of having to guess the URI. `service-desc` pointing
 * at the agent card (RFC 8631) does the same for the A2A discovery document.
 *
 * This is the one place every non-asset request passes through, which is why the
 * advertisement lives here rather than being repeated per page. The matcher below
 * skips paths with a file extension, so the extensionless routes — a homepage
 * fetch, an API call — are exactly the ones that carry it.
 */
const DISCOVERY_LINKS = [
  `</.well-known/api-catalog>; rel="api-catalog"`,
  `</.well-known/agent-card.json>; rel="service-desc"`,
].join(", ");

function advertise(res: NextResponse) {
  res.headers.set("Link", DISCOVERY_LINKS);
  return res;
}

export async function proxy(req: NextRequest) {
  let res = NextResponse.next({ request: req });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return advertise(res);

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
  return advertise(res);
}

export const config = {
  matcher: [
    // Everything except Next internals, the downloads dir, and any request for a
    // file by extension. The pattern is deliberately flat: the matcher is parsed
    // by path-to-regexp, which cannot parse a nested `(?:...)` group inside the
    // negative lookahead, so the extensions are matched as `.[a-z0-9]+` instead
    // of an alternation.
    "/((?!_next/static|_next/image|favicon.ico|downloads|.*\\.[a-zA-Z0-9]+$).*)",
  ],
};
