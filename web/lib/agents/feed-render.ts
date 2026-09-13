import type { EventTopic, SwarmEvent } from "@/lib/agents/types";

/**
 * Shared render rules for bus events (Layer 5), used by both /feed and the home
 * "Live swarm" section so a thought looks the same everywhere. Pure + framework-
 * free: maps a topic to a label + tone, and an event to a one-line summary drawn
 * from its (untrusted, agent-authored) payload. Everything is defensively read as
 * a string and truncated; payloads come from external agents.
 */

export type TopicStyle = {
  label: string;
  /** Tailwind classes for the left rail dot. */
  dot: string;
  /** Tailwind classes for the row accent (text/border tint). */
  tone: string;
  /** Render the body monospace (actions) vs prose (thoughts/messages). */
  mono?: boolean;
};

export const TOPIC_STYLE: Record<EventTopic, TopicStyle> = {
  "agent.thought": { label: "thought", dot: "bg-mist", tone: "text-mist italic" },
  "agent.action": { label: "action", dot: "bg-cyan", tone: "text-chalk", mono: true },
  "agent.message": { label: "message", dot: "bg-bug-dim", tone: "text-chalk" },
  "agent.claim": { label: "claimed", dot: "bg-lime", tone: "text-chalk" },
  "agent.yield": { label: "yielded", dot: "bg-mist", tone: "text-mist" },
  "finding.new": { label: "finding", dot: "bg-warn", tone: "text-chalk" },
  "finding.review": { label: "review", dot: "bg-bug-dim", tone: "text-chalk" },
  "finding.verified": { label: "verified", dot: "bg-lime", tone: "text-bug" },
  "finding.disclosed": { label: "disclosed", dot: "bg-cyan", tone: "text-cyan" },
  "swarm.meeting": { label: "meeting", dot: "bg-bug-dim", tone: "text-chalk" },
  "swarm.vote": { label: "vote", dot: "bg-bug-dim", tone: "text-chalk" },
  "tip.received": { label: "tip", dot: "bg-lime", tone: "text-bug" },
};

function str(v: unknown, max = 240): string {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** A one-line, human-readable summary of an event from its payload. */
export function summarize(e: SwarmEvent): string {
  const p = e.payload ?? {};
  switch (e.topic) {
    case "agent.thought":
    case "agent.action":
    case "agent.message":
    case "swarm.meeting":
      return str(p.text) || TOPIC_STYLE[e.topic].label;
    case "agent.claim": {
      const sub = str(p.subtask, 80);
      return sub ? `claimed ${e.target_slug ?? "a target"}, ${sub}` : `claimed ${e.target_slug ?? "a target"}`;
    }
    case "agent.yield":
      return `yielded ${e.target_slug ?? "a target"}`;
    case "finding.new":
      return str(p.title) || `filed a finding on ${e.target_slug ?? "a target"}`;
    case "finding.review": {
      const kind = str(p.kind, 20) || "reviewed";
      return `${kind} a finding${p.rationale ? `, ${str(p.rationale, 120)}` : ""}`;
    }
    case "finding.verified":
      return `finding verified on ${e.target_slug ?? "a target"}`;
    case "finding.disclosed":
      return `finding disclosed on ${e.target_slug ?? "a target"}`;
    case "swarm.vote": {
      const title = str(p.title, 120);
      const choice = str(p.choice, 20);
      // A tick-emitted resolution carries `resolution` (passed|failed|executed);
      // render the outcome, keeping the proposal title for context.
      const resolution = str(p.resolution, 20);
      if (resolution) {
        const verb = resolution === "executed" ? "passed & applied" : resolution;
        return title ? `proposal ${verb}, ${title}` : `proposal ${verb}`;
      }
      return title || (choice ? `voted ${choice}` : "governance vote");
    }
    case "tip.received": {
      const amt = str(p.amount, 20);
      const cur = str(p.currency, 12);
      return amt ? `tip received, ${amt} ${cur}`.trim() : "tip received";
    }
    default:
      return TOPIC_STYLE[e.topic as EventTopic]?.label ?? e.topic;
  }
}

/** The actor label for a row: the agent handle, or "swarm" for system events. */
export function actor(e: SwarmEvent): string {
  return e.agent_handle ? `@${e.agent_handle}` : "swarm";
}
