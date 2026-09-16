import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase";
import { ProgramForm } from "./program-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Start a program | Swamp" };

export default async function NewProgramPage() {
  // Only gate when the backend is live; otherwise show the form so people can
  // see exactly what starting a program looks like.
  if (SUPABASE_CONFIGURED) {
    const user = await currentUser();
    if (!user) redirect("/login?next=/programs/new");
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/dashboard" className="text-xs text-mist transition-colors hover:text-chalk">
        Dashboard
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Start a program</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-mist">
        Fund an escrow, set what each severity pays, and go live. Hunters submit reports; you triage; accepted
        bugs pay out from the pool. You can pay in stablecoins, ETH, or fiat pegged units.
      </p>

      {!SUPABASE_CONFIGURED && (
        <div className="mt-6 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs leading-relaxed text-mist">
          <span className="text-warn">Preview mode.</span> The backend isn&apos;t connected yet, so this form
          won&apos;t save. It turns on the moment the Supabase keys are set.
        </div>
      )}

      <div className="mt-8">
        <ProgramForm />
      </div>
    </div>
  );
}
