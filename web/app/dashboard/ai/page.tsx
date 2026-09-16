import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { CopilotConsole } from "./copilot-console";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI Copilot | Swamp" };

/**
 * The "AI brains" surface.
 *
 * Two things live here and they are different in kind, so the page says so:
 *
 *   the console   a real in-app client. It runs on the model when this
 *                 deployment has one configured, and otherwise says plainly
 *                 that it hasn't and hands you the offline planner instead.
 *   the recipes   six documented patterns, each naming the real MCP tools it
 *                 uses (all of them registered; see lib/mcp/tools.ts). These
 *                 are patterns you build and run, not agents this page is
 *                 running, so they carry no "live" indicator. A hosted agent's
 *                 liveness is on /swamp, where it is measured from real
 *                 heartbeats rather than asserted here.
 */

type Recipe = {
  mark: string;
  name: string;
  blurb: string;
  tools: string[];
};

const RECIPES: Recipe[] = [
  {
    mark: "T",
    name: "Triage Copilot",
    blurb: "Reads a submission and its repro, weighs it against your program's funded tiers, and proposes an accept/reject verdict with a severity. You make the call.",
    tools: ["get_submission", "get_program", "triage_submission"],
  },
  {
    mark: "R",
    name: "Scope Guide",
    blurb: "Finds live, well funded programs and reads their scope, targets, and safe-harbour terms so you only ever test what you're authorized to test.",
    tools: ["list_programs", "get_program"],
  },
  {
    mark: "D",
    name: "Report Assistant",
    blurb: "Turns rough notes into a clean, reproducible write up that matches the program's scope, then files it as a finding that's private to you and the owner.",
    tools: ["get_program", "submit_finding"],
  },
  {
    mark: "S",
    name: "Severity Grader",
    blurb: "Scores a finding by impact and preconditions, then maps that to the program's four funded payout tiers so expectations are set upfront.",
    tools: ["get_submission", "get_program"],
  },
  {
    mark: "M",
    name: "Dedup Scout",
    blurb: "Before you spend a triage slot, compares a finding against the submissions you can see, by root cause and impact, to flag likely duplicates.",
    tools: ["list_programs", "get_program", "get_submission"],
  },
  {
    mark: "P",
    name: "Disclosure Curator",
    blurb: "Tracks the status of your accepted findings and, for a program owner, publishes resolved ones as public credentials. The report body always stays private.",
    tools: ["my_submissions", "get_submission", "disclose_finding"],
  },
];

export default async function AIPage() {
  if (!SUPABASE_CONFIGURED) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">AI Copilot</h1>
        <p className="mt-4 rounded-xl bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          The backend isn&apos;t connected on this deployment yet. The copilot reads your real programs and
          findings, so there is nothing for it to work on until it is.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  if (!user) redirect("/login?next=/dashboard/ai");

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-lime text-graphite">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <path d="M12 3l1.9 5.6L19 10l-5.1 1.4L12 17l-1.9-5.6L5 10l5.1-1.4z" />
          </svg>
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Copilot</h1>
          <p className="mt-0.5 text-sm text-mist">
            A console over your own programs and findings, plus the recipes for running the same work
            from an agent of your own.
          </p>
        </div>
      </div>

      {/* Console */}
      <div className="mt-8">
        <CopilotConsole />
      </div>

      {/* Recipe roster */}
      <h2 className="mt-12 text-sm font-medium text-chalk">Recipes</h2>
      <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-mist">
        Patterns to build, each one naming the MCP tools it calls, not agents running on this page.
        Every tool listed is registered on this deployment. To watch agents that <em>are</em> running,{" "}
        <Link href="/swamp" className="text-bug transition-colors hover:text-bug-dim">
          the swamp is live here
        </Link>
        .
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RECIPES.map((a) => (
          <div key={a.name} className="card-hover rounded-2xl bg-ink-soft p-5">
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-lg bg-lime/20 text-base font-semibold text-bug">
                {a.mark}
              </span>
              <span className="text-[10px] text-mist">
                {a.tools.length} MCP {a.tools.length === 1 ? "tool" : "tools"}
              </span>
            </div>
            <h3 className="mt-3 font-medium text-chalk">{a.name}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-mist">{a.blurb}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {a.tools.map((t) => (
                <code key={t} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-mist-bright">
                  {t}
                </code>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Connect CTA */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-gradient-to-br from-lime/20 to-cyan/10 p-6">
        <div className="max-w-xl">
          <h3 className="font-medium text-chalk">Run these from your own agent</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-mist-bright">
            Every recipe above is built from tools the protocol exposes over MCP. Point any MCP client
            at the endpoint and your agent can browse programs, triage, and submit findings. The read
            tools need no key; the write tools need a credential so they act as you.
          </p>
        </div>
        <Link
          href="/connect"
          className="glow shrink-0 rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
        >
          Connect an agent
        </Link>
      </div>
    </div>
  );
}
