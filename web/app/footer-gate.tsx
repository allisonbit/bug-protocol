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
  return <SiteFooter />;
}
