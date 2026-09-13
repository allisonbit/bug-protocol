import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicProfile } from "@/lib/queries";
import { money, initials, displayName, topTier, severityMeta, fmtDate, type Severity } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params) {
  const { handle } = await params;
  const data = await getPublicProfile(handle);
  if (!data) return { title: "Hunter | Swamp" };
  const name = displayName(data.profile);
  return {
    title: `${name} (@${handle}) | Swamp`,
    description: `${name} has ${data.profile.accepted_count} accepted finding(s) and ${data.profile.rep} reputation on Swamp.`,
  };
}

export default async function PublicProfile({ params }: Params) {
  const { handle } = await params;
  const data = await getPublicProfile(handle);
  if (!data) notFound();
  const { profile, programs, disclosures } = data;
  const name = displayName(profile);

  const roleLabel =
    profile.role === "client" ? "Runs programs" : profile.role === "both" ? "Hunts & runs programs" : "Bug hunter";

  return (
    <div className="aurora min-h-[70vh]">
      <div className="relative z-10 mx-auto max-w-3xl px-6 py-16">
        {/* Header */}
        <div className="flex flex-wrap items-start gap-5">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-bug-dim/60 bg-bug-dim/15 text-xl font-semibold text-bug">
            {initials(name)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-chalk">{name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mist">
              {profile.handle && <span>@{profile.handle}</span>}
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] uppercase tracking-wide">
                {roleLabel}
              </span>
            </div>
            {profile.bio && <p className="mt-3 text-pretty leading-relaxed text-mist">{profile.bio}</p>}
            {profile.website && (
              <a
                href={profile.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-2 inline-block text-sm text-bug transition-colors hover:text-bug-dim"
              >
                {profile.website.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="mt-8 grid grid-cols-3 gap-3">
          <Stat value={profile.rep.toLocaleString()} label="reputation" accent />
          <Stat value={profile.accepted_count.toString()} label="accepted findings" />
          <Stat value={money(profile.total_earned, "USDC")} label="earned" />
        </div>

        {/* Programs they run */}
        {programs.length > 0 && (
          <section className="mt-12">
            <h2 className="text-xs uppercase tracking-widest text-mist">Programs they run</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {programs.map((p) => (
                <Link
                  key={p.slug}
                  href={`/programs/${p.slug}`}
                  className="rounded-xl border border-line bg-ink-soft p-5 transition-colors hover:border-mist"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="truncate font-medium text-chalk">{p.name}</h3>
                    <span className="shrink-0 text-sm font-semibold text-bug">
                      {money(topTier(p), p.currency)}
                    </span>
                  </div>
                  {p.summary && <p className="mt-1.5 line-clamp-2 text-sm text-mist">{p.summary}</p>}
                  <p className="mt-3 text-xs text-mist">{p.targets.length} target(s) in scope</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Disclosed findings */}
        {disclosures.length > 0 && (
          <section className="mt-12">
            <h2 className="text-xs uppercase tracking-widest text-mist">Disclosed findings</h2>
            <ul className="mt-4 space-y-2">
              {disclosures.map((d) => {
                const sev = (d.assigned_severity ?? d.severity) as Severity;
                const meta = severityMeta[sev];
                return (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-ink-soft p-4"
                  >
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-chalk">{d.title}</span>
                    {d.program && (
                      <Link href={`/programs/${d.program.slug}`} className="text-xs text-mist hover:text-chalk">
                        {d.program.name}
                      </Link>
                    )}
                    {d.reward > 0 && (
                      <span className="text-sm font-medium text-bug">
                        {money(d.reward, d.program?.currency ?? "USDC")}
                      </span>
                    )}
                    {d.triaged_at && <span className="text-xs text-mist">{fmtDate(d.triaged_at)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {programs.length === 0 && disclosures.length === 0 && (
          <p className="mt-12 rounded-xl border border-dashed border-line bg-ink-soft/50 p-8 text-center text-sm text-mist">
            Nothing public yet. Accepted findings show up here once a program discloses them.
          </p>
        )}

        <div className="mt-12">
          <Link href="/hunters" className="text-sm text-mist transition-colors hover:text-chalk">
            All hunters
          </Link>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-ink-soft p-4 text-center">
      <div className={`text-xl font-semibold ${accent ? "text-bug" : "text-chalk"}`}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-mist">{label}</div>
    </div>
  );
}
