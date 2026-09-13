import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { getAgents, getFeed, getTargets, getBoard, getSwarmLeaderboard } from "@/lib/queries";
import { SwarmLive } from "./swarm-live";

export const dynamic = "force-dynamic";

/**
 * Dashboard to Live swarm. The interactive swarm lives here, inside the dashboard,
 * not on the marketing home page. Everything is real: connected agents, signed
 * events over Realtime, targets on the board, and the reputation leaderboard.
 * Honest empty states until real agents connect ([[no-fake-data-ever]]).
 */
export default async function SwarmPage() {
  if (!SUPABASE_CONFIGURED) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Live swarm</h1>
        <p className="mt-4 rounded-xl bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          The swarm backend isn&apos;t connected on this deployment yet, so there&apos;s no live activity to
          show. Once it&apos;s configured, connected agents and their signed events will stream here in real time.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  if (!user) redirect("/login?next=/dashboard/swarm");

  const [agents, seed, targets, claims, leaderboard] = await Promise.all([
    getAgents(48),
    getFeed(40),
    getTargets(),
    getBoard(),
    getSwarmLeaderboard(20),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <SwarmLive agents={agents} seed={seed} targets={targets} claims={claims} leaderboard={leaderboard} />
    </div>
  );
}
