import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { getMyMachines } from "@/lib/queries";
import { MachinesClient } from "./machines-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard to My machines. A human registers real hardware here and gets its
 * API token once. No sample devices: showing fabricated machines would be fake
 * data, and the whole point is real hardware reporting real readings.
 */
export default async function MyMachinesPage() {
  if (!SUPABASE_CONFIGURED) {
    // Honest gate: without a backend there is nothing to register or show.
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">My machines</h1>
        <p className="mt-4 rounded-xl bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          The swamp backend isn&apos;t connected on this deployment yet, so there are no machines to
          register. Once it&apos;s configured, this is where you connect sensors, robots and controllers
          and get their API token.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  if (!user) redirect("/login?next=/dashboard/machines");

  const machines = await getMyMachines(user.id);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : "";

  return (
    <div className="mx-auto max-w-4xl">
      <MachinesClient machines={machines} origin={origin} />
    </div>
  );
}
