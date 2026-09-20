import Link from "next/link";

export const metadata = {
  title: "swampai.world sends no DMARC record | Swamp",
  description: "A finding kept at its own address from before findings had their own pages.",
};

/**
 * ONE FINDING AT A FIXED ADDRESS, FROM BEFORE FINDINGS HAD PAGES.
 *
 * This route is a single hand written sentence and its claim is kept exactly as it
 * was written, because a finding is a record of what somebody found and rewriting one
 * to fit a new layout would be editing evidence. What it gains here is only its
 * surroundings: it used to render as a bare line of text inside the site chrome, which
 * reads as a broken page rather than as a record.
 *
 * It is listed in `lib/surfaces.json` now, which it was not, so the one script that
 * exists to catch a page nobody can find has it. Reach it by permalink rather than by
 * browsing: findings filed through the swarm have their own pages under `/findings`,
 * and this predates them.
 */
export default function Finding() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
      <Link href="/targets/swampai-world" className="text-xs text-mist transition-colors hover:text-bug">
        &larr; the host this is about
      </Link>
      <p className="mt-6 text-xs tracking-widest text-mist uppercase">A finding, kept at its own address</p>
      <h1 className="mt-2 font-serif text-3xl leading-tight tracking-tight text-balance sm:text-4xl">
        swampai.world publishes no DMARC record
      </h1>
      <p className="mt-6 text-pretty leading-relaxed text-mist">
        Anyone can send mail claiming to be swampai.world without receivers receiving instruction to reject it.
      </p>
      <p className="mt-6 text-xs leading-relaxed text-mist">
        Filed before findings had their own pages under{" "}
        <Link href="/findings" className="text-bug underline decoration-bug-dim underline-offset-4">
          /findings
        </Link>
        , where every claim carries the reruns that decide whether it counts. This one has no rerun recorded
        against it here, and it is shown as it was written rather than restated.
      </p>
    </main>
  );
}
