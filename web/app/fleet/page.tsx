import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { CHANNELS, type Release } from "@/lib/machines/releases";
import { dutyViews, overdueDuties, nextDuties, DUTY_LABELS, type DutyRow, type Vulnerability } from "@/lib/machines/duties";

/**
 * /fleet, the operations page for real hardware.
 *
 * WHAT A ROBOT FLEET OPERATOR ACTUALLY NEEDS TO SEE. Three questions, and this page is
 * built to answer exactly those. What firmware exists and which channel is it on. What
 * each machine is running, and where a machine is behind, whether that is a rollout in
 * flight or a pin somebody chose. And what the maker owes about the firmware that is
 * already on a floor, because a connected robot is a product with digital elements and
 * the duties around a vulnerability start counting from the moment somebody became
 * aware of it.
 *
 * WHAT THIS PAGE REFUSES TO SAY. It does not score any machine's security, it does not
 * certify anything, and it does not claim that a product here is compliant with the EU
 * Cyber Resilience Act. The clock below is a clock over facts a maker entered, and it
 * says so on the page rather than only in this comment. A page that implied compliance
 * would be worse than no page, because somebody might rely on it.
 *
 * Offline it still renders. With no backend configured every section says so instead of
 * throwing, because a page that 500s during an outage is a page nobody can point at.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fleet — Swamp",
  description:
    "Connected hardware as a fleet: published firmware with the digest a device checks itself, what each machine runs and why it is behind, and the vulnerability record with its clock.",
};

type MachineRow = {
  name: string;
  kind: string;
  hardware: string | null;
  firmware: string | null;
  installed_version: string | null;
  pinned_release_id: string | null;
  pinned_reason: string | null;
  status: string;
  last_report_at: string | null;
};

const CHANNEL_TONE: Record<string, string> = { stable: "text-bug", beta: "text-amber", dev: "text-mist-bright" };

function shortDigest(sha: string): string {
  return `${sha.slice(0, 12)}...${sha.slice(-6)}`;
}

export default async function FleetPage() {
  const sb = supabaseAdmin();
  const nowMs = Date.now();

  const [releaseRes, machineRes] = sb
    ? await Promise.all([
        sb.from("machine_releases").select("*").order("created_at", { ascending: false }).limit(60),
        sb.from("machines").select("name, kind, hardware, firmware, installed_version, pinned_release_id, pinned_reason, status, last_report_at").order("name", { ascending: true }).limit(300),
      ])
    : [{ data: null }, { data: null }];

  const releases = ((releaseRes.data as Release[] | null) ?? []).filter((r) => r);
  const machines = ((machineRes.data as MachineRow[] | null) ?? []).filter((m) => m);
  const live = machines.filter((m) => m.status !== "retired");

  // Newest per artifact name, which is what "behind" is measured against. A yanked
  // release is excluded from the comparison but stays in the list below, because a
  // machine already running one is a fact the record has to keep.
  const newest = new Map<string, Release>();
  for (const r of releases) if (!r.yanked_at && !newest.has(r.name)) newest.set(r.name, r);

  const vulnRes = sb ? await sb.from("machine_vulnerabilities").select("*").order("first_aware_at", { ascending: false }).limit(40) : { data: null };
  const advisories = ((vulnRes.data as Vulnerability[] | null) ?? []).filter((v) => v);
  const dutyRes = advisories.length > 0 && sb ? await sb.from("machine_vulnerability_duties").select("*").in("vulnerability_id", advisories.map((a) => a.id)) : { data: null };
  const dutyRows = ((dutyRes.data as (DutyRow & { vulnerability_id: string })[] | null) ?? []);
  const byVuln = new Map<string, DutyRow[]>();
  for (const r of dutyRows) {
    const list = byVuln.get(r.vulnerability_id) ?? [];
    list.push(r);
    byVuln.set(r.vulnerability_id, list);
  }

  const advisoryViews = advisories.map((v) => ({ vuln: v, views: dutyViews({ vulnerability: v, rows: byVuln.get(v.id) ?? [], nowMs }) }));
  const lateTotal = advisoryViews.reduce((n, a) => n + overdueDuties(a.views).length, 0);

  const behind = live
    .map((m) => {
      const target = [...newest.values()].find((r) => r.name === "swamp-robot" && (r.hardware === null || r.hardware === m.hardware));
      if (!target) return null;
      const running = m.installed_version ?? m.firmware;
      if (running === target.version) return null;
      return { machine: m, target, running, pinned: m.pinned_release_id !== null };
    })
    .filter((x): x is { machine: MachineRow; target: Release; running: string | null; pinned: boolean } => x !== null);

  const offered = releases.filter((r) => r.yanked_at === null);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <header className="max-w-3xl">
        <p className="text-xs tracking-[0.18em] text-mist uppercase">Hardware in the record</p>
        <h1 className="mt-4 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl">The fleet</h1>
        <p className="mt-5 text-pretty leading-relaxed text-mist">
          Every robot here is a product with digital elements, and every one of them needs the same four things
          answered in public: which firmware is for it, whether what it downloaded is the thing that was published,
          what it runs if an update goes wrong, and what the maker owes when something in that firmware turns out to be
          wrong. This page holds those four answers as rows rather than as a policy document.
        </p>
        <p className="mt-4 leading-relaxed text-mist-bright">
          What is not here, said as plainly as it is said anywhere else: no score for any machine, no claim that any
          product on this page is compliant with anything, and no substitute for a notified body or a lawyer. The clock
          below measures facts a maker entered. It is not legal advice and it is not a certification.
        </p>
      </header>

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl tracking-tight">What is running</h2>
          <p className="text-xs text-mist">
            {live.length} machine{live.length === 1 ? "" : "s"} in the fleet, {behind.length} behind
          </p>
        </div>

        {machines.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            No machines are registered on this deployment. Register one with a token from{" "}
            <Link className="text-chalk underline decoration-white/20 underline-offset-4" href="/machines">
              /machines
            </Link>
            , then set the board it runs on, because a release is offered to a board and not to a fleet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-[0.14em] text-mist">
                  <th className="px-4 py-3 font-normal">machine</th>
                  <th className="px-4 py-3 font-normal">runs</th>
                  <th className="px-4 py-3 font-normal">newest for it</th>
                  <th className="px-4 py-3 font-normal">because</th>
                </tr>
              </thead>
              <tbody>
                {live.map((m) => {
                  const target = [...newest.values()].find((r) => r.name === "swamp-robot" && (r.hardware === null || r.hardware === m.hardware));
                  const running = m.installed_version ?? m.firmware;
                  const isBehind = target ? running !== target.version : false;
                  const pinRelease = m.pinned_release_id ? releases.find((r) => r.id === m.pinned_release_id) : undefined;
                  return (
                    <tr key={m.name} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-3">
                        <Link className="text-chalk underline decoration-white/20 underline-offset-4" href={`/machines/${m.name}/lifecycle`}>
                          {m.name}
                        </Link>
                        <span className="ml-2 text-xs text-mist">{m.hardware ?? "board not stated"}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-chalk">{running ?? "unknown"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-mist-bright">{target ? target.version : "nothing published"}</td>
                      <td className="px-4 py-3 text-xs leading-relaxed text-mist">
                        {m.pinned_release_id ? (
                          <>
                            <span className="text-amber">pinned</span>
                            {pinRelease ? ` to ${pinRelease.name} ${pinRelease.version}` : ""}
                            {m.pinned_reason ? `: ${m.pinned_reason}` : ""}
                          </>
                        ) : isBehind ? (
                          <span className="text-mist-bright">offered and not taken yet. It reports what it actually runs, so this column moves on its word and not on ours.</span>
                        ) : (
                          "current"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-serif text-xl tracking-tight">Published firmware</h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mist">
          The digest is the point. A device fetches the image from wherever the maker put it and checks the SHA-256
          itself, so a compromised download path is a refusal on the device and not a warning on a page. The bill of
          materials is required at publish time, because the only moment a publisher still has one to hand is the
          moment they are publishing.
        </p>
        {offered.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            Nothing is published. A maker signs in and posts a release with its artifact URL, its SHA-256 and its SBOM
            to <span className="font-mono text-xs text-chalk">POST /api/machines/releases</span>, then stages a rollout
            so a device can be offered it.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {releases.map((r) => (
              <li key={r.id} className="rounded-lg border border-white/10 bg-ink/30 p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-sm text-chalk">
                    {r.name} {r.version}
                  </span>
                  <span className={`text-xs ${CHANNEL_TONE[r.channel] ?? "text-mist"}`}>{r.channel}</span>
                  {r.hardware ? <span className="text-xs text-mist">for {r.hardware}</span> : <span className="text-xs text-mist">for any board</span>}
                  {r.yanked_at ? <span className="text-xs text-warn">yanked{r.yanked_reason ? `: ${r.yanked_reason}` : ""}</span> : null}
                </div>
                <p className="mt-2 font-mono text-xs break-all text-mist-bright">
                  sha256 {shortDigest(r.sha256)} · {r.bytes ? `${(r.bytes / 1024).toFixed(0)} KiB · ` : ""}
                  {Array.isArray((r.sbom as { components?: unknown[] })?.components) ? `${(r.sbom as { components: unknown[] }).components.length} components` : "bill of materials attached"}
                </p>
                {r.notes ? <p className="mt-2 text-sm leading-relaxed text-mist">{r.notes}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm leading-relaxed text-mist">
          A device asks what it is offered at{" "}
          <span className="font-mono text-xs text-chalk">GET /api/machines/releases?machine=&lt;name&gt;</span> and
          answers with what actually happened at{" "}
          <span className="font-mono text-xs text-chalk">POST /api/machines/releases/report</span>. A reported failure
          pins the machine back to what it was running, because a robot that keeps trying a release that does not boot
          is a robot in a loop.
        </p>
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl tracking-tight">The vulnerability record</h2>
          <p className="text-xs text-mist">
            {advisories.length} record{advisories.length === 1 ? "" : "s"}, {lateTotal} dut{lateTotal === 1 ? "y" : "ies"} late
          </p>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mist">
          Since 11 September 2026 the EU Cyber Resilience Act expects a manufacturer that becomes aware of an actively
          exploited vulnerability in a product with digital elements to warn within 24 hours, notify within 72, and file
          a final report inside 14 days, with severe incidents carrying a 30 day window for the report. The clock below
          runs from the instant awareness began, which is the one fact only the maker can supply, and it is derived
          rather than typed so nobody has to remember to create a duty.
        </p>
        {advisories.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-ink/40 p-4 text-sm leading-relaxed text-mist">
            The record is empty, and that means no advisory has been entered here rather than that the firmware is
            clean. A maker opens one at{" "}
            <span className="font-mono text-xs text-chalk">POST /api/machines/vulnerabilities</span> with the instant
            they became aware, and the duties appear with it.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {advisoryViews.map(({ vuln, views }) => {
              const late = overdueDuties(views);
              const next = nextDuties(views, 2);
              return (
                <li key={vuln.id} className="rounded-lg border border-white/10 bg-ink/30 p-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-sm text-chalk">{vuln.advisory_id}</span>
                    <span className={`text-xs ${vuln.severity === "critical" || vuln.severity === "high" ? "text-warn" : "text-amber"}`}>{vuln.severity}</span>
                    <span className="text-xs text-mist">{vuln.kind === "severe_incident" ? "severe incident" : "vulnerability"}</span>
                    {vuln.actively_exploited ? <span className="text-xs text-warn">actively exploited</span> : null}
                    <span className="text-xs text-mist-bright">{vuln.state}</span>
                    {vuln.fixed_in ? <span className="text-xs text-mist">fixed in {vuln.fixed_in}</span> : null}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-chalk">{vuln.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-mist">
                    Aware since {vuln.first_aware_at}
                    {late.length > 0 ? `, ${late.length} dut${late.length === 1 ? "y" : "ies"} late` : ""}
                    {next.length > 0 ? `, next: ${next.map((n) => `${n.label} due ${n.dueAt}`).join("; ")}` : ""}
                  </p>
                  <ul className="mt-3 space-y-1">
                    {views.map((v) => (
                      <li key={v.duty} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                        <span className={v.state === "met" ? "text-bug" : v.state === "overdue" ? "text-warn" : "text-amber"}>{v.state}</span>
                        <span className="text-chalk">{DUTY_LABELS[v.duty]}</span>
                        <span className="text-mist">
                          due {v.dueAt}
                          {v.metAt ? `, met ${v.metAt}` : ""}
                          {v.metBy ? ` by ${v.metBy}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-sm leading-relaxed text-mist">
          A duty cannot be marked met without evidence, which is a URL or a row reference and not a sentence. A timeline
          entry nobody can check is the thing this record exists to replace. Machine readable at{" "}
          <span className="font-mono text-xs text-chalk">GET /api/machines/vulnerabilities</span>.
        </p>
      </section>

      <section className="mt-12 max-w-3xl">
        <h2 className="font-serif text-xl tracking-tight">What a device needs, in full</h2>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-mist">
          <li>
            A token and a board. Register at{" "}
            <Link className="text-chalk underline decoration-white/20 underline-offset-4" href="/machines/guide">
              the getting started guide
            </Link>
            , and set <span className="font-mono text-xs text-chalk">hardware</span> to the exact board. A release with
            no board is for every board; a machine with no board stated cannot be told which image is for it.
          </li>
          <li>
            A key. <span className="font-mono text-xs text-chalk">PUT /api/machines/keys</span> binds an Ed25519 public
            key to the machine, after which reports may be signed and the record says which ones were. The private key
            never leaves the device and this platform never stores one.
          </li>
          <li>
            A check. Before flashing anything, hash the artifact and compare it to the published SHA-256. A mismatch is
            a refusal on the device, not a warning on a page.
          </li>
          <li>
            An answer. Report <span className="font-mono text-xs text-chalk">installed</span> or{" "}
            <span className="font-mono text-xs text-chalk">failed</span> when you know, because a fleet told
            &ldquo;maybe&rdquo; cannot act.
          </li>
        </ol>
        <p className="mt-4 text-sm leading-relaxed text-mist">
          The simulator that drives all of it without hardware is{" "}
          <span className="font-mono text-xs text-chalk">scripts/robot-sim.cjs</span>: it registers, holds a key, signs
          its reports, polls for releases, accepts a job and refuses a bad command, so every surface on this page is
          exercised by a real client rather than by an assertion on this page.
        </p>
      </section>

      <section className="mt-12 max-w-3xl">
        <h2 className="font-serif text-xl tracking-tight">Deployments and doors</h2>
        <ul className="mt-4 space-y-2 text-sm leading-relaxed text-mist">
          <li>
            <span className="font-mono text-xs text-chalk">GET /api/machines/releases</span> the catalogue, or what one
            machine is offered with the digest to check. Public.
          </li>
          <li>
            <span className="font-mono text-xs text-chalk">POST /api/machines/releases</span> publish, with the SBOM
            required. Signed in.
          </li>
          <li>
            <span className="font-mono text-xs text-chalk">PATCH /api/machines/releases</span> stage a rollout by
            percentage or by named canary. Signed in.
          </li>
          <li>
            <span className="font-mono text-xs text-chalk">POST /api/machines/releases/report</span> the device's own
            answer, with its machine token.
          </li>
          <li>
            <span className="font-mono text-xs text-chalk">GET /api/machines/vulnerabilities</span> the advisory record
            with each duty and its clock. Public.
          </li>
          <li>
            <span className="font-mono text-xs text-chalk">PATCH /api/machines/manage</span>{" "}
            <span className="font-mono text-xs text-chalk">pin</span> and <span className="font-mono text-xs text-chalk">unpin</span>{" "}
            hold a machine on a version with a reason. Signed in.
          </li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-mist">
          Machine readable summary at <span className="font-mono text-xs text-chalk">{SITE_URL}/api/security</span> for
          this deployment's own audit record, and the discovery documents at{" "}
          <span className="font-mono text-xs text-chalk">{SITE_URL}/.well-known/machines.json</span>. Channels are{" "}
          {CHANNELS.join(", ")}, and a device opts into exactly one.
        </p>
      </section>
    </main>
  );
}
