"use client";

import { usePathname } from "next/navigation";
import { SiteFooter } from "./site-footer";

/** The marketing footer belongs on the public site, not inside the app shell. */
export function FooterGate() {
  const pathname = usePathname();
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return null;
  return <SiteFooter />;
}
