import Link from "next/link";
import { HUBS, REACH_LABEL, REACH_NOTE, hubCounts, hubsByReach, type Hub, type HubReach } from "@/lib/hubs";
import { readListingHealth } from "@/lib/swamp/listings";
import type { ListingResult } from "@/lib/swamp/listings";

/**
 * /hubs: every place an agent could arrive from, and how each one actually works.
 *
 * WHY THIS IS NOT /discover. That page is about conventions and registries a
 * runtime guesses at, and whether the listings are alive. This page is about the
 * runtimes people ask about by name — OpenClaw, Claude Code, Cursor, ChatGPT, and
 * the rest — and the honest answer for each is one of five things, not a yes or a
 * no. Two of those five are "there is nowhere to be" and "we are not listed yet",
 * and keeping them apart is the entire point: a page that renders them the same
 * way teaches a reader to distrust all of it.
 *
 * WHAT IS DERIVED RATHER THAN WRITTEN. The counts come from `lib/hubs.ts`, not
 * from prose. The state of every hub that has a listing comes from the database
 * row the hourly check writes, so a listing that was restored last night shows as
 * restored here instead of as broken. Only the things a check cannot know — that a
 * portal needs a Team plan, that a directory takes a pull request — are declared,
 * and each of those is stated as a step a person takes rather than a status.
 *
 * WHY A COMPANY'S SOCIAL ACCOUNT IS NOT ON THIS PAGE. Several of the runtimes
 * below have large accounts on X, and those are not hubs. There is no endpoint
 * behind a marketing account: mentioning it is not a connection, and what it
 * reaches is the people reading it, not the runtime. The hubs are the registries,
 * the direct install surfaces and the marketplaces, which is what this page lists.
 */
export const revalidate = 300;

/** The tone a listing state maps to. Three states, three meanings, no guessing. */
function StateDot({ state }: { state: string }) {
  const tone = state === "present" ? "bg-bug" : state === "missing" ? "bg-warn" : "bg-line-strong";
  return <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden />;
}

function ago(iso: string | null): string {
  if (!iso) return "never checked";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `checked ${Math.round(hours / 24)} days ago`;
}

/** One row. Every sentence here is either a fact about the hub or a step for a person. */
function HubCard({ hub, health }: { hub: Hub; health: ListingResult | null }) {
  return (
    <section id={hub.id} className="rounded-xl border border-line bg-ink-soft p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-serif text-xl text-chalk">
          {hub.url ? (
            hub.url.startsWith("/") ? (
              <Link href={hub.url} className="transition-colors hover:text-bug">
                {hub.label}
              </Link>
            ) : (
              <a
                href={hub.url}
                target="_blank"
                rel="noreferrer noopener"
                className="transition-colors hover:text-bug"
              >
                {hub.label}
              </a>
            )
          ) : (
            hub.label
          )}
        </h3>
        {hub.pending && (
          <span className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-mist">
            built, not published
          </span>
        )}
      </div>

      <p className="mt-1 font-mono text-[11px] tracking-wide text-mist">
        {hub.reaches.length > 0 ? `reaches: ${hub.reaches.join(", ")}` : "reaches nobody"}
      </p>

      <p className="mt-3 text-sm leading-relaxed text-mist">{hub.what}</p>

      {health && (
        <div className="mt-4 flex items-start gap-2 border-t border-line-soft pt-3">
          <StateDot state={health.state} />
          <div className="min-w-0">
            <p className="font-mono text-xs text-mist-bright">
              {health.state === "present" ? "listed" : health.state === "missing" ? "not listed" : "could not be read"}
              {" · "}
              {ago(health.checkedIso)}
            </p>
            {health.repaired && health.repairDetail && (
              <p className="mt-1 text-xs leading-relaxed text-mist">
                It was put back: {health.repairDetail}
              </p>
            )}
            {health.detail && <p className="mt-1 text-xs leading-relaxed text-mist">{health.detail}</p>}
          </div>
        </div>
      )}

      {hub.needs && (
        <div className="mt-4 border-t border-line-soft pt-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-mist">What it needs</p>
          <p className="mt-1.5 text-sm leading-relaxed text-mist-bright">{hub.needs}</p>
        </div>
      )}
    </section>
  );
}

export default async function HubsPage() {
  // The live record, when the database can be reached. A page that cannot read it
  // says nothing about state rather than drawing an empty green list.
  let health: ListingResult[] | null = null;
  try {
    const sb = (await import("@/lib/supabase")).supabaseAdmin();
    if (sb) health = await readListingHealth(sb);
  } catch {
    health = null;
  }
  const healthFor = (check: string | null) =>
    check && health ? health.find((h) => h.listing === check || h.kind === check) ?? null : null;

  const counts = hubCounts();
  const groups = hubsByReach();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-24 pt-20 sm:pt-28">
      <p className="text-xs tracking-widest text-mist uppercase">Distribution</p>
      <h1 className="mt-4 font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
        Where an agent arrives from.
      </h1>
      <p className="mt-6 max-w-2xl text-pretty leading-relaxed text-mist">
        A list of {counts.total} places that could carry an agent here. {counts.machine} are published from this
        deployment and read back on an hourly schedule, {counts.credentialed + counts.human} are waiting on a
        credential or a person, {counts.mirror} follow the registry rather than needing their own submission, and{" "}
        {counts.none} have no machine surface at all.
      </p>
      <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-mist">
        The last of those is the row people skip. A runtime with no registry is not a missed opportunity to chase; it is
        one where an outside server cannot be listed, and saying so is more useful than a status page that implies
        somebody forgot.
      </p>

      <div className="mt-8 rounded-xl border border-line-soft p-5">
        <dl className="space-y-3">
          {(Object.keys(REACH_LABEL) as HubReach[]).map((reach) => (
            <div key={reach}>
              <dt className="font-mono text-xs text-chalk">{REACH_LABEL[reach]}</dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-mist">{REACH_NOTE[reach]}</dd>
            </div>
          ))}
        </dl>
      </div>

      {groups.map((group) => (
        <section key={group.reach} className="mt-14">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-xs tracking-widest text-mist uppercase">{REACH_LABEL[group.reach]}</h2>
            <span className="font-mono text-[11px] text-mist">{group.hubs.length}</span>
          </div>
          <div className="mt-4 space-y-4">
            {group.hubs.map((hub) => (
              <HubCard key={hub.id} hub={hub} health={healthFor(hub.check)} />
            ))}
          </div>
        </section>
      ))}

      <section className="mt-16 border-t border-line-soft pt-8">
        <h2 className="text-xs tracking-widest text-mist uppercase">The doors themselves</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-mist">
          A hub decides who finds this. These decide what happens next:{" "}
          <Link href="/connect" className="text-bug transition-colors hover:text-bug-dim">
            the ways to connect
          </Link>{" "}
          are the endpoints and the exact commands,{" "}
          <Link href="/discover" className="text-bug transition-colors hover:text-bug-dim">
            the discovery surfaces
          </Link>{" "}
          are the paths a runtime guesses from a bare domain, and{" "}
          <Link href="/everything" className="text-bug transition-colors hover:text-bug-dim">
            everything
          </Link>{" "}
          is the complete list of what this host serves. A hub not on this page that you have been told exists is worth
          asking about: it is more often a directory that mirrors one of these than a fifth kind of thing.
        </p>
      </section>
    </main>
  );
}
