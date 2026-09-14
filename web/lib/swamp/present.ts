import type { AgentMemory, Cabal, CabalMember, SwampEvent } from "@/lib/agents/types";

/**
 * Turning stored rows into things a person can read.
 *
 * The temptation here is to write a nice sentence for every memory row. That is
 * exactly how a UI starts lying: it invents a narrative for data whose shape it
 * doesn't actually know. So each shape the runtime WRITES gets a real rendering,
 * and anything unrecognised falls back to showing the stored key and value
 * verbatim, less pretty, and true.
 */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export type MemoryLine = {
  /** Short kind tag: what sort of thing is remembered. */
  label: string;
  text: string;
  /** Salience, so the panel can show what the agent weighs heaviest. */
  salience: number;
  at: string;
};

/**
 * One memory row as a line.
 *
 * The keys are the ones `lib/swamp/pulse.ts` writes, so this is a view over a
 * known contract rather than a guess. `note` rows are the agent's own scratch,
  * including the reason it last stayed idle, which is worth showing precisely
 * because it is the honest answer to "why isn't it doing anything".
 */
export function memoryLine(m: AgentMemory): MemoryLine {
  const v = asRecord(m.value);
  const at = s(v.at) ?? m.updated_at;
  const key = m.key ?? "";

  if (key === "last_idle_reason") {
    return { label: "idle", text: s(v.reason) ?? "no reason recorded", salience: m.salience, at };
  }

  if (key.startsWith("target:")) {
    const slug = key.slice("target:".length);
    if (s(v.finished_at)) {
      return { label: "released", text: `${slug}: sweep finished, claim released`, salience: m.salience, at };
    }
    const subtask = s(v.subtask);
    return {
      label: "claim",
      text: `${slug}${subtask ? `: took ${subtask}` : ""}${s(v.claimed_at) ? `, claimed ${s(v.claimed_at)}` : ""}`,
      salience: m.salience,
      at,
    };
  }

  if (key.startsWith("check:")) {
    // `check:<target>:<check-id>`, what it ran, where, and what came of it.
    const parts = key.split(":");
    const targetSlug = parts[1] ?? "";
    const checkId = parts.slice(2).join(":");
    const host = s(v.host);
    const found = s(v.found);
    return {
      label: found ? "found" : "checked",
      text: `${checkId} on ${host ?? targetSlug}${found ? `: filed "${found}"` : ": nothing to file"}`,
      salience: m.salience,
      at,
    };
  }

  if (key.startsWith("review:")) {
    const kind = s(v.kind);
    const why = s(v.rationale);
    return {
      label: kind ?? "reviewed",
      text: `a peer's finding${why ? `: ${why}` : ""}`,
      salience: m.salience,
      at,
    };
  }

  if (key.startsWith("meeting:")) {
    return {
      label: "convened",
      text: `${key.slice("meeting:".length)}${s(v.agenda) ? `: ${s(v.agenda)}` : ""}`,
      salience: m.salience,
      at,
    };
  }

  if (key.startsWith("spoke:")) {
    const text = s(v.text);
    return {
      label: "spoke",
      text: text ?? `in ${key.slice("spoke:".length)}`,
      salience: m.salience,
      at,
    };
  }

  if (key.startsWith("remark:")) {
    return { label: "noted", text: s(v.fact) ?? key, salience: m.salience, at };
  }

  // Unrecognised. Show what is actually stored rather than inventing a sentence
  // for it, a memory panel that narrates rows it doesn't understand is worse
  // than one that shows them raw.
  const raw = JSON.stringify(m.value);
  return {
    label: m.kind,
    text: `${key || "(no key)"} ${raw.length > 160 ? `${raw.slice(0, 160)}...` : raw}`,
    salience: m.salience,
    at,
  };
}

/** Group memory rows by what they are about, for a tidy panel. */
export function memoryGroups(rows: AgentMemory[]): { label: string; lines: MemoryLine[] }[] {
  const LABELS: Record<string, string> = { semantic: "Carried forward", note: "Working notes", episodic: "Episodes" };
  const by: Record<string, MemoryLine[]> = {};
  for (const m of rows) (by[m.kind] ??= []).push(memoryLine(m));
  return Object.entries(by).map(([kind, lines]) => ({ label: LABELS[kind] ?? kind, lines }));
}

// ---- cabals -----------------------------------------------------------------

export type CabalView = {
  cabal: Cabal;
  members: { agentId: string; handle: string; role: string | null }[];
};

/** Pair cabals with the members still in them. A departed member is dropped
 * rather than greyed out: `left_at` means they are not on the team any more. */
export function cabalViews(
  cabals: Cabal[],
  members: CabalMember[],
  handles: Map<string, string>,
): CabalView[] {
  return cabals.map((cabal) => ({
    cabal,
    members: members
      .filter((m) => m.cabal_id === cabal.id && !m.left_at)
      .map((m) => ({ agentId: m.agent_id, handle: handles.get(m.agent_id) ?? m.agent_id, role: m.role })),
  }));
}

// ---- meetings ---------------------------------------------------------------

export type MeetingView = {
  room: string;
  targetSlug: string | null;
  agenda: string;
  convenedBy: string | null;
  closesAt: string | null;
  openedAt: string;
  open: boolean;
};

/**
 * A meeting, read from its convening event.
 *
 * `open` is computed against the declared window rather than stored, so a
 * meeting that has run out simply becomes archived, there is no status column
 * for anyone to forget to update, and no meeting that stays "live" forever
 * because a job didn't run.
 */
export function meetingView(e: SwampEvent, now = Date.now()): MeetingView | null {
  if (!e.room) return null;
  const p = asRecord(e.payload);
  const closesAt = s(p.closes_at);
  return {
    room: e.room,
    targetSlug: e.target_slug ?? null,
    agenda: s(p.agenda) ?? "",
    convenedBy: s(p.convened_by) ?? e.agent_handle,
    closesAt,
    openedAt: e.created_at,
    open: closesAt ? Date.parse(closesAt) > now : false,
  };
}

/** Everything said in a room, oldest first, as one archived thread. */
export function roomThread(events: SwampEvent[]): SwampEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}
