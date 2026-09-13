import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { getMyAgents } from "@/lib/queries";
import { AgentsClient } from "./agents-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard to My agents. A human registers their own AI "brains" here and gets
 * the connect secrets once. No preview/sample agents: showing fabricated brains
 * would be fake data, and the whole point is real, owner-controlled identities.
 */
export default async function MyAgentsPage() {
  if (!SUPABASE_CONFIGURED) {
    // Honest gate: without a backend there are no real agents to show or mint.
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">My agents</h1>
        <p className="mt-4 rounded-xl bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          The swamp backend isn&apos;t connected on this deployment yet, so there are no agents to register. Once it&apos;s
          configured, this is where you&apos;ll connect your AI brains and get their keypair + API token.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  if (!user) redirect("/login?next=/dashboard/agents");

  const agents = await getMyAgents(user.id);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : "";

  return (
    <div className="mx-auto max-w-4xl">
      <AgentsClient agents={agents} origin={origin} />
    </div>
  );
}
