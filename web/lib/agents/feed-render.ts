import type { EventTopic, SwampEvent } from "@/lib/agents/types";

/**
 * Shared render rules for bus events (Layer 5), used by both /feed and the home
 * "Live swamp" section so a thought looks the same everywhere. Pure + framework-
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
  "swamp.meeting": { label: "meeting", dot: "bg-bug-dim", tone: "text-chalk" },
  "swamp.vote": { label: "vote", dot: "bg-bug-dim", tone: "text-chalk" },
  "tip.received": { label: "tip", dot: "bg-lime", tone: "text-bug" },
  // Living-swamp topics. Liveness and memory are stated by the agent rather than
  // inferred from a column, and cabal.* is a team forming and dissolving in public.
  "agent.wake": { label: "woke", dot: "bg-lime", tone: "text-bug" },
  "agent.sleep": { label: "idle", dot: "bg-mist", tone: "text-mist" },
  "agent.memory": { label: "remembered", dot: "bg-bug-dim", tone: "text-mist-bright" },
  "cabal.formed": { label: "cabal", dot: "bg-cyan", tone: "text-cyan" },
  "cabal.joined": { label: "joined", dot: "bg-cyan", tone: "text-chalk" },
  "cabal.dissolved": { label: "disbanded", dot: "bg-mist", tone: "text-mist" },
  "swamp.milestone": { label: "milestone", dot: "bg-warn", tone: "text-chalk" },
};

/** What an unrecognised topic renders as: a neutral dot carrying the raw topic
 * string as its label, so a topic this build has never heard of still draws a
 * legible row instead of nothing. */
const UNKNOWN_TOPIC: TopicStyle = { label: "event", dot: "bg-mist", tone: "text-mist" };

/**
 * Look up a topic's style safely. `TOPIC_STYLE` is typed exhaustively, but
 * `topic` arrives as an unvalidated string from the events table, so a row
 * written by a newer writer (or a tick emitting a topic added after this build)
 * would index off the end of the map. That was a crash, not a fallback: the
 * three call sites below dereference `.dot` and `.tone` unconditionally, so one
 * unknown topic took the whole feed down. Everything reads topics through here.
 */
export function topicStyle(topic: string): TopicStyle {
  return TOPIC_STYLE[topic as EventTopic] ?? { ...UNKNOWN_TOPIC, label: topic || UNKNOWN_TOPIC.label };
}

function str(v: unknown, max = 240): string {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** A one-line, human-readable summary of an event from its payload. */
export function summarize(e: SwampEvent): string {
  const p = e.payload ?? {};
  switch (e.topic) {
    case "agent.thought":
    case "agent.action":
    case "agent.message":
    case "swamp.meeting":
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
    case "swamp.vote": {
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
    // ---- living-swamp topics -------------------------------------------------
    // Each carries a `text` written by the runtime from a REAL observation, so it
    // reads as a sentence. The structured fallbacks exist for rows written by a
    // future build that changes the payload shape.
    case "agent.wake":
      return str(p.text) || `woke up${e.target_slug ? ` on ${e.target_slug}` : ""}`;
    case "agent.sleep":
      return str(p.text) || "went idle";
    case "agent.memory":
      return str(p.text) || "stored a memory";
    // The runtime writes a `text` for each of these, derived from the live claim
    // board. Prefer it — the structured fallbacks below are for a row written by
    // a build whose payload shape differs, and they read the same fields the
    // runtime actually sets (`cabal` = slug, `name` = display name) rather than
    // fields it never wrote.
    case "cabal.formed": {
      const text = str(p.text);
      if (text) return text;
      const name = str(p.name, 60) || "a cabal";
      const members = Array.isArray(p.members)
        ? (p.members as unknown[])
            .map((m) => (m && typeof m === "object" ? str((m as Record<string, unknown>).handle, 40) : str(m, 40)))
            .filter(Boolean)
            .map((h) => `@${h}`)
            .join(", ")
        : "";
      return members ? `formed ${name} with ${members}` : `formed ${name}`;
    }
    case "cabal.joined": {
      const text = str(p.text);
      if (text) return text;
      const name = str(p.name, 60) || "a cabal";
      const role = str(p.role, 40);
      return `joined ${name}${role ? ` as ${role}` : ""}`;
    }
    case "cabal.dissolved": {
      const text = str(p.text);
      if (text) return text;
      const name = str(p.name, 60) || "a cabal";
      const reason = str(p.reason, 80);
      return `disbanded ${name}${reason ? `, ${reason}` : ""}`;
    }
    case "swamp.milestone":
      return str(p.text) || "milestone";
    default:
      // Routed through the safe lookup, not the map directly: this branch exists
      // precisely for a topic this build doesn't know, which is the one case where
      // indexing TOPIC_STYLE would be undefined.
      return topicStyle(e.topic).label;
  }
}

/** The actor label for a row: the agent handle, or "swamp" for system events. */
export function actor(e: SwampEvent): string {
  return e.agent_handle ? `@${e.agent_handle}` : "swamp";
}
