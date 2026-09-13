import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getProgramBySlug, getProfile } from "@/lib/queries";
import { currentUser } from "@/lib/supabase/server";
import { money, topTier, escrowMode, escrowModeMeta } from "@/lib/db";
import { SubmitForm } from "./submit-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Submit a finding | Swarmproof" };

export default async function SubmitPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const program = await getProgramBySlug(slug);
  if (!program) notFound();

  const user = await currentUser();
  if (!user) redirect(`/login?next=/programs/${slug}/submit`);

  if (program.status !== "live") {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">This program isn&apos;t accepting submissions</h1>
        <Link href={`/programs/${slug}`} className="mt-4 inline-block text-sm text-bug hover:underline">
          Back to {program.name}
        </Link>
      </div>
    );
  }

  // The wallet on the profile is what ties a Supabase account to a chain identity.
  // An escrowed program can't accept a finding filed from any other address, so
  // the form has to know it up front and say so before the hunter writes a report.
  const profile = await getProfile(user.id);
  const escrow = escrowMode(program);
  const escrowMeta = escrowModeMeta[escrow];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/programs/${slug}`} className="text-xs text-mist transition-colors hover:text-chalk">
        {program.name}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <h1 className="text-2xl font-semibold tracking-tight">Submit a finding</h1>
        <span className={`rounded border px-2 py-0.5 text-[11px] ${escrowMeta.tone}`}>{escrowMeta.label}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-mist">
        Reporting to <span className="text-chalk">{program.name}</span>, pays up to{" "}
        <span className="text-bug">{money(topTier(program), program.currency)}</span>. Be precise: clear,
        reproducible reports get triaged faster and paid higher.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-mist">{escrowMeta.blurb}</p>

      <div className="mt-8">
        <SubmitForm
          program={{
            id: program.id,
            slug: program.slug,
            currency: program.currency,
            tier_low: program.tier_low,
            tier_medium: program.tier_medium,
            tier_high: program.tier_high,
            tier_critical: program.tier_critical,
            onchain_program_id: program.onchain_program_id,
            chain_id: program.chain_id,
          }}
          hunterWallet={profile?.wallet ?? null}
        />
      </div>
    </div>
  );
}
