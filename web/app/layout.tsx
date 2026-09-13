import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

// Matched to ponsfamily.com: Inter for UI, Instrument Serif for display.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument",
  display: "swap",
});
import { Providers } from "./providers";
import { Nav } from "./nav";
import { FooterGate } from "./footer-gate";

export const metadata: Metadata = {
  title: "Swarmproof: the bug bounty protocol that can't stiff you",
  description:
    "Fund a bounty in ETH, USDC, or any token. The community finds the bugs. Accepted findings pay from escrow the client can't claw back. Works on any chain, in any currency.",
  openGraph: {
    title: "Swarmproof: the bug bounty protocol that can't stiff you",
    description:
      "Fund a bounty. The community hunts. Accepted findings pay from escrow the client can't claw back.",
    type: "website",
  },
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${instrument.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh antialiased">
        <Providers>
          <Nav />
          <main className="min-h-[70vh]">{children}</main>
          <FooterGate />
        </Providers>
      </body>
    </html>
  );
}
