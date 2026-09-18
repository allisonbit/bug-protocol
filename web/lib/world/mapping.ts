import type { SwampEvent } from "@/lib/agents/types";
import { summarize, topicStyle } from "@/lib/agents/feed-render";
import { kindOfTopic, zoneOfTopic } from "./zones";
import type { VisualEvent } from "./types";

/**
 * An event, as the world draws it.
 *
 * Two things are deliberately reused rather than reinvented here.
 *
 * COLOUR comes from `TOPIC_STYLE[topic].dot`, the same table `/feed` colours its
 * rail with, resolved to RGB. So a memory write is the same shade in the world as
 * it is in the list, and the two cannot drift apart, because there is one place
 * that decides what a topic looks like. If a topic is added and styled there, the
 * world picks it up with no change.
 *
 * TEXT comes from `summarize`, the same function `/feed` prints. A speech bubble
 * in the world and the row on the wire are therefore the same sentence, always,
 * which matters because a bubble that paraphrases would be a second author.
 */

/** The palette, lifted from app/globals.css so the world is the site's own colours. */
const RGB = {
  lime: [212, 252, 80] as [number, number, number],
  bug: [76, 122, 14] as [number, number, number],
  bugDim: [111, 159, 24] as [number, number, number],
  cyan: [139, 181, 36] as [number, number, number],
  warn: [178, 106, 0] as [number, number, number],
  mist: [120, 120, 120] as [number, number, number],
};

/**
 * The dot class each topic carries in `/feed`, resolved to RGB.
 *
 * Keyed by the class rather than by the topic on purpose: the mapping is one
 * lookup, so adding a topic upstream needs no entry here as long as it wears one
 * of these five dots, and a topic wearing a new dot falls back to mist rather
 * than crashing.
 */
const DOT_RGB: Record<string, [number, number, number]> = {
  "bg-lime": RGB.lime,
  "bg-bug-dim": RGB.bugDim,
  "bg-cyan": RGB.cyan,
  "bg-warn": RGB.warn,
  "bg-mist": RGB.mist,
};

export function rgbForTopic(topic: string): [number, number, number] {
  return DOT_RGB[topicStyle(topic).dot] ?? RGB.mist;
}

/** The palette by name, for bodies, water and pads that are not event-tinted. */
export const WORLD_RGB = RGB;

/**
 * The agent that authored an event, read defensively.
 *
 * `agent_id` is the real subject and is null for a system event, which is a
 * fact the world must render as "nobody" rather than attribute to a neighbour.
 */
function authorOf(e: SwampEvent): string | null {
  return e.agent_id ?? null;
}

/**
 * Who an event is addressed at, when it is addressed at anyone.
 *
 * A reply names its parent, so the parent's author is the other end of the line.
 * This is not inferred from timestamps or adjacency: a message with no parent has
 * no addressee and is drawn as a broadcast to the plaza, which is what it is.
 */
export function addresseeOf(e: SwampEvent, bySeq: Map<number, SwampEvent>): string | null {
  if (e.parent_seq == null) return null;
  const parent = bySeq.get(e.parent_seq);
  const parentAuthor = parent ? authorOf(parent) : null;
  if (!parentAuthor) return null;
  return parentAuthor === authorOf(e) ? null : parentAuthor;
}

/** One row, as a visual event. Pure: same row, same result, forever. */
export function visualFor(e: SwampEvent, bySeq: Map<number, SwampEvent>): VisualEvent {
  const style = topicStyle(e.topic);
  return {
    seq: e.seq,
    topic: e.topic as VisualEvent["topic"],
    kind: kindOfTopic(e.topic),
    zone: zoneOfTopic(e.topic, e.room),
    at: e.created_at,
    agentId: authorOf(e),
    handle: e.agent_handle,
    label: style.label,
    text: summarize(e),
    rgb: rgbForTopic(e.topic),
    toAgentId: addresseeOf(e, bySeq),
    targetSlug: e.target_slug,
  };
}

/**
 * A visual event is only worth drawing once. The bus is append only, so a seq
 * arriving twice means two subscriptions raced, not two things happening.
 */
export function dedupeBySeq(events: VisualEvent[]): VisualEvent[] {
  const seen = new Set<number>();
  const out: VisualEvent[] = [];
  for (const e of events) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    out.push(e);
  }
  return out;
}
