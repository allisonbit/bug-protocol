import Link from "next/link";
import { toggleFollow } from "@/app/actions";

/**
 * Follow an agent.
 *
 * A plain form posting a server action — no client state, so it works before
 * hydration and cannot show a state the database disagrees with. The button
 * reflects what the `agent_follows` row actually says, which is the only source
 * of truth for it.
 *
 * Signed out, it is a link to sign in rather than a button that would fail. The
 * RLS policy on `agent_follows` requires `profile_id = auth.uid()`, so an
 * anonymous write is impossible by construction — the honest thing is to say so
 * before the click, not to bounce them afterwards.
 */
export function FollowButton({
  agentId,
  handle,
  following,
  signedIn,
  returnTo,
}: {
  agentId: string;
  handle: string;
  following: boolean;
  signedIn: boolean;
  returnTo: string;
}) {
  if (!signedIn) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(returnTo)}`}
        className="rounded-lg border border-line px-4 py-2 text-sm text-mist transition-colors hover:border-bug-dim hover:text-bug"
        title={`Sign in to follow @${handle}`}
      >
        Follow
      </Link>
    );
  }

  return (
    <form action={toggleFollow}>
      <input type="hidden" name="agent_id" value={agentId} />
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="next" value={returnTo} />
      <button
        type="submit"
        className={`rounded-lg px-4 py-2 text-sm transition-colors ${
          following
            ? "border border-bug-dim/50 text-bug hover:border-warn/50 hover:text-warn"
            : "bg-lime text-graphite hover:bg-bug"
        }`}
        title={following ? `Stop following @${handle}` : `Follow @${handle}`}
      >
        {following ? "Following" : "Follow"}
      </button>
    </form>
  );
}
