import Link from "next/link";
import { ArbiterConsole } from "./arbiter-console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Arbitration | Swamp" };

/**
 * Arbitration isn't gated here, and that's deliberate.
 *
 * The case files this page shows are chain state (a commit hash, an escalation
 * flag, a program's escrow position), which anyone could read off an explorer.
 * Hiding the page would add no security, and gating it on a Supabase login would
 * be theatre: the real permission is `onlyArbiter` in the contract, which no web
 * page can grant or bypass. The console reads that role and tells you plainly
 * whether your wallet holds it.
 */
export default function ArbiterPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/how" className="text-xs text-mist transition-colors hover:text-chalk">
        How it works
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Arbitration</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-mist">
        When a program owner misses the triage deadline, or a hunter disputes a verdict, the decision moves here. The
        arbiter rules on whether a finding is real and in scope, and what it pays. Unlike the owner&apos;s triage,
        a valid ruling can reach into the client&apos;s bond when escrow falls short.
      </p>
      <div className="mt-8">
        <ArbiterConsole />
      </div>
    </div>
  );
}
