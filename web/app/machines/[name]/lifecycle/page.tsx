import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import type { Machine } from "@/lib/agents/types";
import { timeAgo } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import type { Release } from "@/lib/machines/releases";

/**
 * One machine's lifecycle, which is the part of a robot's record that outlives it.
 *
 * WHY THIS IS A SEPARATE PAGE FROM THE MACHINE ITSELF. /machines/<name> is what the
 * machine is doing: readings, alerts, the commands in both directions. This page is what
 * has happened to it: which keys stood for it and which were turned off, which reports
 * were signed and which were not, which firmware it was offered and what it said
 * afterwards, and where it is held. A technician arriving at a robot that is behaving
 * oddly needs this list in order and with timestamps, and a reader checking a claim
 * about it needs the same rows.
 *
 * THE HONEST PART IS THE SIGNED COLUMN. A report that arrived unsigned is kept and
 * marked, because a record that silently omitted the unsigned half would be a record
 * that flattered itself. This page counts both and says which is which.
 *
 * A retired machine keeps its page. Rows outliving their status is what append-only
 * means, and a lifecycle page that vanished on retirement would erase exactly the
 * history somebody would come looking for.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return { title: `${decodeURIComponent(name)} lifecycle | Machines | Swamp` };
}

export default async function MachineLifecyclePage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName).trim().toLowerCase();
  const sb = await supabaseServer();
  if (!sb) notFound();

  const { data: machineRow } = await sb.from("machines").select("*").eq("name", name).maybeSingle();
  const machine = machineRow as Machine | null;
  if (!machine) notFound();

  const [keysRes, receiptsRes, targetsRes, releasesRes, eventsRes] = await Promise.all([
    sb.from("machine_keys").select("kid, public_key, algo, label, created_at, retired_at, revoked_at, revoked_reason").eq("machine_id", machine.id).order("created_at", { ascending: false }),
    sb.from("machine_report_receipts").select("digest, kid, signed_ok, signed_reason, readings_count, created_at").eq("machine_id", machine.id).order("created_at", { ascending: false }).limit(40),
    sb.from("machine_release_targets").select("release_id, state, offered_at, resolved_at, note").eq("machine_id", machine.id).order("offered_at", { ascending: false }).limit(40),
    sb.from("machine_releases").select("*").limit(200),
    sb.from("events").select("topic, payload, created_at").eq("payload->>machine", machine.name).order("created_at", { ascending: false }).limit(40),
  ]);

  type KeyRow = { kid: string; public_key: string; algo: string; label: string | null; created_at: string; retired_at: string | null; revoked_at: string | null; revoked_reason: string | null };
  type Receipt = { digest: string; kid: string | null; signed_ok: boolean; signed_reason: string | null; readings_count: number; created_at: string };
  type Target = { release_id: string; state: string; offered_at: string; resolved_at: string | null; note: string | null };

  const keys = (keysRes.data as KeyRow[] | null) ?? [];
  const receipts = (receiptsRes.data as Receipt[] | null) ?? [];
  const targets = (targetsRes.data as Target[] | null) ?? [];
  const releases = (releasesRes.data as Release[] | null) ?? [];
  const events = ((eventsRes.data as { topic: string; payload: Record<string, unknown>; created_at: string }[] | null) ?? []);

  const m = machine as unknown as { hardware?: string | null; installed_version?: string | null; pinned_release_id?: string | null; pinned_reason?: string | null; last_release_at?: string | null };
  const signed = receipts.filter((r) => r.signed_ok).length;
  const unsigned = receipts.length - signed;
  const releaseById = new Map(releases.map((r) => [r.id, r]));
  const pinned = m.pinned_release_id ? releaseById.get(m.pinned_release_id) : undefined;
  const running = m.installed_version ?? machine.firmware;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <header>
        <p className="text-xs uppercase tracking-widest text-mist">
          <Link href="/machines" className="transition-colors hover:text-chalk">
            The machines
          </Link>
          <span className="mx-2">/</span>
          <Link href={`/machines/${machine.name}`} className="transition-colors hover:text-chalk">
            {machine.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-chalk">lifecycle</span>
        </p>
        <h1 className="mt-4 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl">
          {machine.name}, from the record
        </h1>
        <p className="mt-4 max-w-3xl leading-relaxed text-mist">
          What has happened to this machine: the keys that stood for it, which of its reports were signed and which
          were not, what firmware it was offered and what it said afterwards, and where it is held. Nothing on this page
          is a live reading; the machine&rsquo;s own page carries those.
        </p>
      </header>

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-ink/30 p-4">
          <h2 className="text-xs uppercase tracking-[0.14em] text-mist">Identity</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-mist">board</dt>
              <dd className="font-mono text-xs text-chalk">{m.hardware ?? "not stated"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">kind</dt>
              <dd className="font-mono text-xs text-chalk">{machine.kind}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">status</dt>
              <dd className="font-mono text-xs text-chalk">{machine.status}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">keys held</dt>
              <dd className="font-mono text-xs text-chalk">
                {keys.filter((k) => !k.retired_at && !k.revoked_at).length} active of {keys.length}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-mist">
            The DID document is at{" "}
            <a className="text-chalk underline decoration-white/20 underline-offset-4" href={`${SITE_URL}/api/machines/${machine.name}/did.json`}>
              /api/machines/{machine.name}/did.json
            </a>
            , so a third party can resolve this machine without asking this page.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-ink/30 p-4">
          <h2 className="text-xs uppercase tracking-[0.14em] text-mist">What it runs</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-mist">running</dt>
              <dd className="font-mono text-xs text-chalk">{running ?? "unknown"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">last install report</dt>
              <dd className="font-mono text-xs text-chalk">{m.last_release_at ? timeAgo(m.last_release_at) : "never"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mist">held</dt>
              <dd className="font-mono text-xs text-amber">
                {pinned ? `${pinned.name} ${pinned.version}` : "not pinned"}
              </dd>
            </div>
          </dl>
          {m.pinned_reason ? <p className="mt-3 text-xs leading-relaxed text-mist">{m.pinned_reason}</p> : null}
        </div>
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl tracking-tight">Keys</h2>
          <p className="text-xs text-mist">a revoked key verifies nothing afterwards</p>
        </div>
        {keys.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            This machine holds no key, so every report it has sent is unsigned. That is a fact about the record and not a
            failure of it: the reading is kept and marked. Signing starts when the device registers a public key at{" "}
            <span className="font-mono text-xs text-chalk">PUT /api/machines/keys</span>.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {keys.map((k) => (
              <li key={k.kid} className="rounded-lg border border-white/10 bg-ink/30 p-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-xs text-chalk">{k.kid}</span>
                  <span className="text-xs text-mist">{k.algo}</span>
                  <span className={`text-xs ${k.revoked_at ? "text-warn" : k.retired_at ? "text-mist" : "text-bug"}`}>
                    {k.revoked_at ? "revoked" : k.retired_at ? "retired" : "active"}
                  </span>
                  <span className="text-xs text-mist">since {timeAgo(k.created_at)}</span>
                  {k.label ? <span className="text-xs text-mist-bright">{k.label}</span> : null}
                </div>
                <p className="mt-1 font-mono text-[11px] break-all text-mist">{k.public_key.slice(0, 48)}...</p>
                {k.revoked_reason ? <p className="mt-1 text-xs text-warn">{k.revoked_reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl tracking-tight">Signed reports</h2>
          <p className="text-xs text-mist">
            {signed} signed, {unsigned} unsigned, of the last {receipts.length}
          </p>
        </div>
        {receipts.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            No signed report has been received. A signed report writes a receipt keyed on the digest of the canonical
            message it signed, and the unique index on that digest is what makes a replayed report impossible rather than
            merely unlikely.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-[0.14em] text-mist">
                  <th className="px-4 py-3 font-normal">when</th>
                  <th className="px-4 py-3 font-normal">key</th>
                  <th className="px-4 py-3 font-normal">verdict</th>
                  <th className="px-4 py-3 font-normal">digest</th>
                  <th className="px-4 py-3 font-normal">readings</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={`${r.created_at}-${r.digest}`} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2 text-xs text-mist">{timeAgo(r.created_at)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-chalk">{r.kid ?? "none"}</td>
                    <td className={`px-4 py-2 text-xs ${r.signed_ok ? "text-bug" : "text-amber"}`}>
                      {r.signed_ok ? "signed" : r.signed_reason ?? "unsigned"}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-mist">{r.digest.slice(0, 16)}...</td>
                    <td className="px-4 py-2 font-mono text-xs text-mist-bright">{r.readings_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">Firmware history</h2>
        {targets.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            No release has been offered to this machine. An offer is not an install: the fleet offers and the device
            reports, and this section is empty because neither has happened.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {targets.map((t) => {
              const rel = releaseById.get(t.release_id);
              return (
                <li key={`${t.release_id}-${t.offered_at}`} className="rounded-lg border border-white/10 bg-ink/30 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-chalk">{rel ? `${rel.name} ${rel.version}` : t.release_id}</span>
                    <span className={`text-xs ${t.state === "installed" ? "text-bug" : t.state === "failed" ? "text-warn" : "text-mist-bright"}`}>{t.state}</span>
                    <span className="text-xs text-mist">offered {timeAgo(t.offered_at)}</span>
                    {t.resolved_at ? <span className="text-xs text-mist">answered {timeAgo(t.resolved_at)}</span> : null}
                  </div>
                  {rel ? <p className="mt-1 font-mono text-[11px] text-mist">sha256 {rel.sha256.slice(0, 16)}...</p> : null}
                  {t.note ? <p className="mt-1 text-xs leading-relaxed text-mist">{t.note}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">On the bus</h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mist">
          The lifecycle rows that name this machine, newest first. These are the same rows the feed and the world read,
          which is the point of writing a rotation or a rollback as an event rather than as a page edit.
        </p>
        {events.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            Nothing on the bus names this machine yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {events.map((e, i) => (
              <li key={`${e.topic}-${e.created_at}-${i}`} className="rounded-lg border border-white/10 bg-ink/30 p-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-xs text-mist-bright">{e.topic}</span>
                  <span className="text-xs text-mist">{timeAgo(e.created_at)}</span>
                </div>
                <p className="mt-1 leading-relaxed text-chalk">
                  {typeof e.payload?.text === "string" ? e.payload.text : JSON.stringify(e.payload).slice(0, 200)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-12 text-xs leading-relaxed text-mist">
        Machine readable versions of the same rows:{" "}
        <span className="font-mono text-chalk">GET {SITE_URL}/api/machines/releases?machine={machine.name}</span> for
        what it is offered,{" "}
        <span className="font-mono text-chalk">GET {SITE_URL}/api/machines/releases/report</span> with this machine&rsquo;s
        token for what it is recorded as running, and{" "}
        <span className="font-mono text-chalk">{SITE_URL}/.well-known/machines.json</span> for the fleet&rsquo;s keys.
      </p>
    </main>
  );
}
