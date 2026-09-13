"use client";

import { useRef, useState } from "react";

/**
 * The Copilot console. When a live model is connected (via AI Gateway) this is a
 * real chat: you ask in plain language and it answers over the platform's ACTUAL
 * data through read-only tools (live programs, your submissions, your triage
 * inbox, the leaderboard). It never invents programs, people, or numbers. An
 * empty platform gets an honest "nothing here yet".
 *
 * If no model is wired on the deployment, it falls back to the offline planner:
 * a deterministic map from your objective to the exact ordered MCP run you'd
 * execute from a connected client. Both are grounded in the real MCP toolset
 * (see /tools). No fabricated capabilities.
 */

type Role = "user" | "assistant";
type Msg = { role: Role; content: string };
type Step = { tool: string; write: boolean; note: string };
type Plan = { agent: string; summary: string; steps: Step[] };

const EXAMPLES = [
  "Which live programs pay the most, and for what?",
  "Show me the scope for the bridge program",
  "What findings have I submitted, and their status?",
  "Do I have anything waiting to triage?",
  "How is hunter reputation calculated here?",
  "Walk me through submitting a finding to a web program",
];

/**
 * Offline planner. Used only when the live model isn't connected. Maps an
 * objective to a run over the REAL MCP toolset the protocol exposes (see
 * lib/mcp/tools.ts): read tools need no key, write tools run on your approval.
 */
function buildPlan(input: string): Plan {
  const q = input.toLowerCase();
  const has = (...w: string[]) => w.some((x) => q.includes(x));

  if (has("dupe", "duplicate", "already reported", "seen before")) {
    return {
      agent: "Dedup Scout",
      summary: "Check whether a finding overlaps something already filed before spending a triage slot.",
      steps: [
        { tool: "list_programs", write: false, note: "Locate the target program and its details." },
        { tool: "get_program", write: false, note: "Pull scope + reward tiers to compare against." },
        { tool: "get_submission", write: false, note: "Read each candidate you can access; compare root cause, path, and impact." },
      ],
    };
  }
  if (has("recon", "scope", "in scope", "target", "attack surface", "what can i test")) {
    return {
      agent: "Scope Reader",
      summary: "Find live work and read exactly what's in scope before you touch anything.",
      steps: [
        { tool: "list_programs", write: false, note: "Rank live programs by pool size and reward tiers." },
        { tool: "get_program", write: false, note: "Read the targets, rules, and whether safe harbor covers your test." },
      ],
    };
  }
  if (has("triage", "accept", "reject", "verdict", "review", "inbox")) {
    return {
      agent: "Triage Copilot",
      summary: "Work your triage queue and propose an accept/reject verdict with a severity. You approve the write.",
      steps: [
        { tool: "get_submission", write: false, note: "Read the report body, repro steps, and target." },
        { tool: "get_program", write: false, note: "Load the program's severity tiers and response policy." },
        { tool: "triage_submission", write: true, note: "Record the verdict + severity; reward defaults to the tier (runs on your approval)." },
      ],
    };
  }
  if (has("report", "draft", "write up", "write-up", "submit", "file", "poc")) {
    return {
      agent: "Report Assistant",
      summary: "Turn notes into a clear, in-scope report and file it against a live program.",
      steps: [
        { tool: "get_program", write: false, note: "Match the write-up to the scope, and confirm the program is live." },
        { tool: "submit_finding", write: true, note: "File the finding (title, severity, repro); it's private to you and the owner (your approval)." },
      ],
    };
  }
  if (has("severity", "grade", "cvss", "score", "how bad")) {
    return {
      agent: "Severity Grader",
      summary: "Score a finding by impact and map it to the program's funded payout tier.",
      steps: [
        { tool: "get_submission", write: false, note: "Read impact, affected target, and exploit preconditions." },
        { tool: "get_program", write: false, note: "Read the four payout tiers to map severity to reward." },
      ],
    };
  }
  if (has("payout", "reward", "earn", "paid", "status", "my findings", "my submissions")) {
    return {
      agent: "Status Tracker",
      summary: "See where your findings stand and what each one paid.",
      steps: [
        { tool: "my_submissions", write: false, note: "List every finding you've filed with its status and reward." },
        { tool: "get_submission", write: false, note: "Open any one to read the triage note and assigned severity." },
      ],
    };
  }
  return {
    agent: "Full hunt",
    summary: "An end-to-end pass: find a target, read its scope, write it up, and file it.",
    steps: [
      { tool: "list_programs", write: false, note: "Rank live programs by pool size and scope fit." },
      { tool: "get_program", write: false, note: "Pick a target and confirm scope + safe harbor." },
      { tool: "submit_finding", write: true, note: "File the finding once confirmed (runs on your approval)." },
    ],
  };
}

export function CopilotConsole() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [offlinePlan, setOfflinePlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const run = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setOfflinePlan(null);
    setNotice(null);

    const history: Msg[] = [...messages, { role: "user", content: t }];
    setMessages(history);
    setBusy(true);

    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      // No live model on this deployment. Fall back to the honest note plus offline planner.
      if (res.status === 503) {
        const data = (await res.json().catch(() => null)) as { reason?: string } | null;
        setNotice(data?.reason ?? "The live model isn't connected. Showing the offline planner.");
        setOfflinePlan(buildPlan(t));
        setBusy(false);
        return;
      }
      if (!res.ok || !res.body) {
        setNotice("The copilot hit an error. Showing the offline planner instead.");
        setOfflinePlan(buildPlan(t));
        setBusy(false);
        return;
      }

      // Stream the answer token-by-token into a new assistant message.
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }
      if (!acc.trim()) {
        // Model produced nothing. Fall back rather than show an empty bubble.
        setMessages((m) => m.slice(0, -1));
        setNotice("The model returned an empty response. Showing the offline planner.");
        setOfflinePlan(buildPlan(t));
      }
    } catch {
      setNotice("Couldn't reach the copilot. Showing the offline planner instead.");
      setOfflinePlan(buildPlan(t));
    } finally {
      setBusy(false);
    }
  };

  const hasChat = messages.length > 0;

  return (
    <div className="rounded-2xl bg-ink-soft p-5">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-lime text-graphite">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M12 3l1.9 5.6L19 10l-5.1 1.4L12 17l-1.9-5.6L5 10l5.1-1.4z" />
          </svg>
        </span>
        <h3 className="text-sm font-medium text-chalk">Copilot console</h3>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-mist">
          <span className="size-1.5 rounded-full bg-lime" />
          Grounded in your real data, read-only
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mist">
        Ask about programs, scope, your submissions, or your triage queue. Answers come from the live database. It
        won&apos;t invent anything. Actions that write (submit, triage) come back as steps you run yourself.
      </p>

      {/* Transcript */}
      {hasChat && (
        <div ref={scrollRef} className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-sm bg-lime px-3.5 py-2 text-sm text-graphite"
                    : "max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-ink px-3.5 py-2.5 text-sm leading-relaxed text-mist-bright"
                }
              >
                {m.content || (m.role === "assistant" && busy ? <span className="text-mist">...</span> : null)}
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. Which live programs pay the most?"
          className="auth-input"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="shrink-0 rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {busy ? "..." : "Ask"}
        </button>
      </form>

      {!hasChat && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => run(ex)}
              className="rounded-full bg-panel-2 px-2.5 py-1 text-[11px] text-mist transition-colors hover:text-chalk"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {notice && <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-mist">{notice}</p>}

      {/* Offline planner fallback */}
      {offlinePlan && (
        <div className="mt-3 rounded-xl bg-ink p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-lime px-2 py-0.5 text-[10px] font-bold tracking-wide text-graphite">
              {offlinePlan.agent}
            </span>
            <span className="text-xs text-mist-bright">{offlinePlan.summary}</span>
          </div>
          <ol className="mt-4 space-y-2.5">
            {offlinePlan.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[10px] text-mist">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-chalk">{s.tool}</code>
                    <span className={`text-[10px] ${s.write ? "text-warn" : "text-bug-dim"}`}>
                      {s.write ? "write" : "read"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-mist">{s.note}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[11px] leading-relaxed text-mist">
            Write steps run only on your approval. Copy this run into any MCP client from{" "}
            <a href="/tools" className="text-bug hover:underline">
              Agent tools
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
