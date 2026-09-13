import Link from "next/link";
import { CopilotConsole } from "./copilot-console";

export const metadata = { title: "AI Copilot | Swarmproof" };

/**
 * The "AI brains" surface. Six agents, each mapped to the real MCP tools the
 * protocol exposes (see /tools). The console above now runs a live model over
 * the read tools in-app; every tool here is also available over MCP to any
 * client, so an external agent can run the write steps too, on its user's behalf.
 */

type Agent = {
  mark: string;
  name: string;
  blurb: string;
  tools: string[];
};

const AGENTS: Agent[] = [
  {
    mark: "T",
    name: "Triage Copilot",
    blurb: "Reads a submission and its repro, weighs it against your program's funded tiers, and proposes an accept/reject verdict with a severity. You make the call.",
    tools: ["get_submission", "get_program", "triage_submission"],
  },
  {
    mark: "R",
    name: "Scope Guide",
    blurb: "Finds live, well-funded programs and reads their scope, targets, and safe-harbour terms so you only ever test what you're authorized to test.",
    tools: ["list_programs", "get_program"],
  },
  {
    mark: "D",
    name: "Report Assistant",
    blurb: "Turns rough notes into a clean, reproducible write-up that matches the program's scope, then files it as a finding that's private to you and the owner.",
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

export default function AIPage() {
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
          <p className="mt-0.5 text-sm text-mist">A live model over your real data, plus agents that run on the protocol&apos;s MCP tools.</p>
        </div>
      </div>

      {/* Console */}
      <div className="mt-8">
        <CopilotConsole />
      </div>

      {/* Agent roster */}
      <h2 className="mt-12 text-sm font-medium text-chalk">The agents</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AGENTS.map((a) => (
          <div key={a.name} className="card-hover rounded-2xl bg-ink-soft p-5">
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-lg bg-lime/20 text-base font-semibold text-bug">
                {a.mark}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[10px] text-mist">
                <span className="size-1.5 rounded-full bg-lime" />
                Live via MCP
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
            Every agent above is the same set of MCP tools the protocol exposes. Drop the config into Claude Desktop or
            any MCP client and your agent can browse programs, triage, and submit findings. Read tools need no key,
            write tools need a bearer token so they act as you.
          </p>
        </div>
        <Link
          href="/tools"
          className="glow shrink-0 rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
        >
          Get the MCP config
        </Link>
      </div>
    </div>
  );
}
