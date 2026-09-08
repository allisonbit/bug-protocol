import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "./nav";

export const metadata: Metadata = {
  title: "$BUG — bug bounties, escrowed on chain",
  description:
    "Clients fund a program. The community finds the bugs. Accepted findings pay out of escrow the client cannot reclaim. Built on Robinhood Chain.",
  openGraph: {
    title: "$BUG — bug bounties, escrowed on chain",
    description:
      "Clients fund a program. The community finds the bugs. Accepted findings pay out of escrow the client cannot reclaim.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-mono antialiased">
        <Providers>
          <Nav />
          <main>{children}</main>
          <footer className="mt-24 border-t border-line px-6 py-10 text-xs text-mist">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
              <p>
                $BUG runs on Robinhood Chain (id 4663). Not affiliated with Robinhood Markets.
              </p>
              <a
                className="underline decoration-line underline-offset-4 hover:text-chalk"
                href="https://github.com/allisonbit/bug-protocol"
              >
                contracts on github
              </a>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
