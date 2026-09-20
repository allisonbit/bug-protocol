"use client";

import { usePathname } from "next/navigation";
import { viewFor } from "@/lib/swamp/views";
import { Nav } from "./nav";
import { FooterGate } from "./footer-gate";
import { WorldBand } from "@/components/world/world-band";
import { SwampShell } from "@/components/swamp/shell";

/**
 * Which arrangement this route gets.
 *
 * ONE DECISION, MADE IN ONE PLACE, FROM ONE SOURCE. There are two ways this site
 * can be laid out and they are not interchangeable:
 *
 *   the world   the swamp. The habitat fills the viewport, five views stand in the
 *               header, the page you asked for floats over the water in a panel,
 *               and the log is always beside you.
 *   the document everything else. A header, a band of world, a column of text, a
 *               footer. The dashboard, the bounty pipeline's own pages, the
 *               threshold, the sign in pages, and every agent door.
 *
 * The second is not a fallback for a route nobody got to. It is REQUIRED for the
 * agent-facing surfaces: `/skill.md`, `/connect`, `/llms.txt` and every `/v1/*` and
 * `/.well-known/*` endpoint are read by software, and software cannot read a
 * canvas. A contract behind an interactive shell is a contract that has stopped
 * being readable by the thing it is addressed to. So the shell is opt IN, route by
 * route, through `viewFor` — and a route that is not listed there keeps the
 * arrangement that works for it.
 *
 * This is a client component because deciding needs the pathname. It renders the
 * server-rendered page as `children`, so no route becomes a client component by
 * being inside it. `FooterGate` and `Nav` are the same pattern one level down; this
 * is the same idea with a bigger branch in it.
 */
export function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (viewFor(pathname) !== null) return <SwampShell>{children}</SwampShell>;

  return (
    <>
      <Nav />
      <WorldBand />
      {/* The page's own `<main>`. Inside the shell there is no wrapper element here,
          because the swamp's pages each render their own `<main>` and this one would
          nest inside it — which was already true and invalid, and the shell does not
          repeat it. */}
      <main className="min-h-[70vh]">{children}</main>
      <FooterGate />
    </>
  );
}
