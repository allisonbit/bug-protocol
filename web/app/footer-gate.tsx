"use client";

import { usePathname } from "next/navigation";
import { SiteFooter } from "./site-footer";

/**
 * The marketing footer belongs on the public site, not inside the app shell.
 *
 * It is also suppressed on the home page, which closes on its own terms: the
 * home route is the one surface with no header, so a footer full of link
 * columns would put the conventional navigation back on it at the bottom.
 */
export function FooterGate() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return null;
  // The consent screen is one decision on one screen. A footer of link columns
  // under "approve this connection?" is noise at the exact moment a person should
  // be reading what they are agreeing to.
  if (pathname === "/oauth" || pathname.startsWith("/oauth/")) return null;
  return <SiteFooter />;
}
