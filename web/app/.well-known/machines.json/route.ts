import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { SITE_URL } from "@/lib/site";
import { activeKey } from "@/lib/machines/identity";

/** The host a did:web for this deployment is built from. */
const DID_HOST = SITE_URL.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /.well-known/machines.json: the machines this deployment has, and the DID of each.
 *
 * WHY AN INDEX AT ALL, when every machine already has its own document. A device, a
 * fleet bridge or an auditor arrives without knowing any machine name, and its first
 * question is which machines exist and which of them sign their reports. Answering
 * that with a crawl of every page would be a crawl; answering it with one document
 * that lists DIDs, key ids and whether a key is live is one request and is checkable
 * in the same way the machine document is.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. No readings, no locations, no firmware
 * versions, no vulnerability state. Those live on the machine's own public record and
 * on its lifecycle page, where a reader can see the rows behind them. An index that
 * summarised everything would be a second place for facts to live, and the second
 * place is always the one that goes stale.
 */
export async function GET() {
  const sb = supabaseAdmin();
  if (!sb || !SUPABASE_CONFIGURED) {
    return NextResponse.json(
      { machines: [], error: { code: "BACKEND_UNCONFIGURED", message: "The swamp backend isn't configured on this deployment yet." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const { data } = await sb
    .from("machines")
    .select("name, kind, status, last_report_at, created_at")
    .order("name", { ascending: true })
    .limit(500);
  const rows = (data as { name: string; kind: string; status: string; last_report_at: string | null; created_at: string }[] | null) ?? [];

  // The keys come in one query rather than one per machine: an index that made N+1
  // requests to itself would be the slowest page on the site and nobody would notice
  // until a fleet had a hundred robots.
  const { data: keyRows } = await sb.from("machine_keys").select("machine_id, kid, public_key, created_at, retired_at, revoked_at").limit(5000);
  const keys = (keyRows as { machine_id: string; kid: string; public_key: string; created_at: string; retired_at: string | null; revoked_at: string | null }[] | null) ?? [];
  const { data: idRows } = await sb.from("machines").select("id, name").limit(500);
  const idByName = new Map(((idRows as { id: string; name: string }[] | null) ?? []).map((r) => [r.name, r.id]));

  const machines = rows.map((m) => {
    const mine = keys.filter((k) => k.machine_id === idByName.get(m.name));
    const current = activeKey(mine);
    return {
      name: m.name,
      kind: m.kind,
      status: m.status,
      did: `did:web:${DID_HOST}:machines:${m.name}`,
      did_url: `${SITE_URL}/api/machines/${m.name}/did.json`,
      key: current ? { kid: current.kid, public_key: current.public_key } : null,
      // A machine with no key is stated as such rather than omitted. Reports from it
      // are stored and marked unsigned, and a reader deciding how much weight to put
      // on a reading needs to know that from the index rather than by fetching the
      // reading and noticing.
      signs_reports: Boolean(current),
      keys_total: mine.length,
      last_report_at: m.last_report_at,
      since: m.created_at,
    };
  });

  return NextResponse.json(
    {
      site: SITE_URL,
      scheme: "did:web",
      machines,
      count: machines.length,
      note:
        "Which machines exist here and which of them sign their reports. A machine with no key still reports, and those readings are stored marked unsigned. Fetch a machine's did_url to get the document a verifier checks signatures against.",
      body_rule: "Served whether or not any machine has a key. An empty list means no machine is registered, not that the door is shut.",
    },
    { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
  );
}
