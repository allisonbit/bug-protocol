import { createHash } from "node:crypto";

/**
 * LESSONS: WHAT THE SWARM NOTICED ABOUT ITSELF, AND WHAT IT IS ALLOWED TO DO ABOUT IT.
 *
 * WHAT THIS IS, AND THE ONE THING IT MOVES. No prompt is rewritten, no rule's condition
 * changes, no capability is added, and no model writes a word of any lesson. The single
 * thing an adopted lesson can move is a rule's own PRIORITY within the agent's published
 * list: a rule the swarm counted firing and landing nothing is nudged down behind the work
 * that lands, by a bounded step, recomputed on every wake from the lessons adopted right
 * now, so a refuted lesson stops applying and nothing accumulates. That tuning is in
 * lib/swamp/adapt.ts and it is the whole of the behaviour change. The 2026 literature on
 * self-evolving agents is blunt
 * about the distinction and it belongs in the code rather than in a blog post: almost
 * everything called self-evolving is a stateful system that distils, stores and ranks what
 * happened, and the only honest test of it is whether behaviour changed and whether the
 * change can be traced to evidence. So that is exactly what this module does, and nothing
 * more: it counts what the deployment's own beats did, writes a sentence about the pattern
 * with the event numbers it was counted from, and refuses to let any sentence act on
 * anything until a resident who did not write it has decided whether it holds.
 *
 * WHY THE INPUT IS BEATS RATHER THAN A LOG SCRAPE. A beat already writes a span with what
 * it planned, what ran, what failed, what it dropped and whether the brain degraded. Those
 * are counts of real work, produced by the code that did the work, in one row per beat. A
 * lesson derived from them can be re-derived by anybody holding the same rows, which is
 * what makes a refutation a measurement instead of an argument.
 *
 * WHY EVERY LESSON CARRIES SEQUENCE NUMBERS. A claim about behaviour whose evidence cannot
 * be pointed at is an opinion. Each candidate carries the event sequence numbers it was
 * counted from, the window they sit in, and a SHA-256 over the canonical form of those
 * numbers and the sentence. Two residents can then disagree about a lesson and settle it by
 * looking, and a reader can check that the sentence is the one those rows produced.
 *
 * PURE. No database, no network, no clock of its own: the caller passes the beats and the
 * time. `scripts/verify-lessons.cjs` walks every branch, including the ones that refuse.
 */

/** The patterns this deployment is willing to notice. Three, and each is countable. */
export const LESSON_KINDS = ["rule_silent", "rule_barren", "brain_degraded"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** A rule that has not fired, a rule that fires and lands nothing, a brain that keeps degrading. */
export const LESSON_KIND_MEANING: Record<LessonKind, string> = {
  rule_silent: "a rule in the reflex policy that has not fired once in the window",
  rule_barren: "a rule that fired and whose every planned action failed or was dropped",
  brain_degraded: "an agent whose model brain degraded repeatedly in the window",
};

/**
 * How much evidence a pattern needs before it may become a lesson.
 *
 * The numbers are the whole editorial decision in this file, so they are named rather than
 * inlined. A window with fewer than twenty-four beats cannot tell a silent rule from a quiet
 * afternoon, a rule needs three firings before "it never lands" is a pattern rather than an
 * accident, and a brain needs three degradations before it is worth a resident's attention.
 */
export const LESSON_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MIN_BEATS = 24;
export const MIN_FIRINGS = 3;
export const MIN_DEGRADED = 3;

/**
 * One beat as the log holds it. Everything here is a count the pulse wrote about itself.
 *
 * TWO FIELDS CAN SAY "I CANNOT ANSWER", and that is the most important thing about this type.
 * `swamp.rules.fired` was added on 2026-09-22, so every span written before it carries no such
 * field, and reading those as "no rule fired" would propose a lesson about all thirty rules in
 * the policy on the first beat of a deployment that had simply not been writing the field yet.
 * That is the same class of error as reading an absent install count as zero, which the
 * registry projection refuses by name. So a span that predates the field has `rules: null` and
 * is excluded from every rule pattern and from the beat floor, rather than counted as silence.
 *
 * `degraded` is null when the beat wrote that it did not degrade and undefined when the span
 * cannot say, because those two arrive as the same JSON when a field is missing.
 */
export type BeatObservation = {
  seq: number;
  at: string;
  agent_handle: string;
  brain: string | null;
  planned: number;
  ran: number;
  failed: number;
  dropped: number;
  degraded?: string | null;
  /** The reflex rules that fired, or null when the span predates the field and cannot say. */
  rules: string[] | null;
};

/** The numbers a lesson is counted from, exactly as they will be published. */
export type LessonEvidence = {
  seqs: number[];
  from: string;
  to: string;
  /** How many times the pattern was seen in the window. */
  count: number;
  /** How many beats the window held, so a reader can judge the denominator. */
  beats: number;
  window_ms: number;
};

export type LessonCandidate = {
  kind: LessonKind;
  /** What the lesson is about: a rule id, or an agent handle for a degraded brain. */
  subject: string;
  statement: string;
  evidence: LessonEvidence;
  /** Deterministic, so the same counts always produce the same number. */
  confidence: number;
};

/**
 * The bytes the hash covers.
 *
 * Sorted and explicit rather than JSON.stringify of the object as it happens to be built:
 * key order is a property of the code that assembles a value, and a digest that changes when
 * somebody reorders a literal would make every stored lesson unverifiable for no reason.
 */
export function canonicalEvidence(kind: LessonKind, subject: string, evidence: LessonEvidence): string {
  return [
    `lesson=${kind}`,
    `subject=${subject}`,
    `from=${evidence.from}`,
    `to=${evidence.to}`,
    `count=${evidence.count}`,
    `beats=${evidence.beats}`,
    `window_ms=${evidence.window_ms}`,
    `seqs=${[...evidence.seqs].sort((a, b) => a - b).join(",")}`,
  ].join("\n");
}

export function lessonEvidenceHash(kind: LessonKind, subject: string, evidence: LessonEvidence): string {
  return createHash("sha256").update(canonicalEvidence(kind, subject, evidence), "utf8").digest("hex");
}

/** Beats inside the window, newest last. A beat with no parseable time is dropped, not guessed. */
export function windowBeats(beats: BeatObservation[], now: string): BeatObservation[] {
  const end = Date.parse(now);
  if (!Number.isFinite(end)) return [];
  const from = end - LESSON_WINDOW_MS;
  return beats
    .filter((b) => {
      const t = Date.parse(b.at);
      return Number.isFinite(t) && t >= from && t <= end;
    })
    .sort((a, b) => a.seq - b.seq);
}

function confidence(cap: number, base: number, per: number): number {
  return Math.min(cap, base + per);
}

/** The sequence numbers of the beats a pattern was seen in, in order. */
function seqsOf(beats: BeatObservation[]): number[] {
  return beats.map((b) => b.seq);
}

function evidenceOf(beats: BeatObservation[], matched: BeatObservation[]): LessonEvidence {
  return {
    seqs: seqsOf(matched),
    from: beats[0]?.at ?? "",
    to: beats[beats.length - 1]?.at ?? "",
    count: matched.length,
    beats: beats.length,
    window_ms: LESSON_WINDOW_MS,
  };
}

/**
 * Turn a window of beats into the lessons those beats support.
 *
 * Every branch below is a count and a threshold. Nothing here is asked about intent, quality
 * or meaning, because the log cannot answer those and a module that guesses is the thing
 * this whole layer exists to avoid. A rule that never fired either has a condition nobody
 * reaches or a rule nobody needs; this code says which of the two it can see, which is the
 * first half of the sentence, and leaves the second half to whoever adopts it.
 */
export function deriveLessons(input: {
  beats: BeatObservation[];
  policyRules: string[];
  now: string;
}): LessonCandidate[] {
  // Only spans that can answer are counted for rule patterns, and the beat floor is measured
  // against those rather than against every span. A beat that cannot say which rule fired is
  // not evidence that a rule did not fire.
  const beats = windowBeats(input.beats, input.now).filter((b) => b.rules !== null) as (BeatObservation & {
    rules: string[];
  })[];
  const out: LessonCandidate[] = [];

  // Not enough happened to say anything. An empty window and a quiet one look identical, so
  // neither produces a lesson, and that refusal is the most important branch in the function.
  if (beats.length < MIN_BEATS) return out;

  for (const rule of input.policyRules) {
    const fired = beats.filter((b) => b.rules.includes(rule));
    if (fired.length === 0) {
      const evidence = evidenceOf(beats, beats);
      out.push({
        kind: "rule_silent",
        subject: rule,
        statement:
          `the reflex rule ${rule} did not fire in ${beats.length} consecutive beats. ` +
          `Either its condition is never reached in this deployment or the rule is dead weight in the policy.`,
        evidence,
        confidence: confidence(90, 40, Math.floor(beats.length / 4)),
      });
      continue;
    }
    if (fired.length < MIN_FIRINGS) continue;

    // Barren means it fired and nothing landed: the beat planned at least one action and every
    // one of them failed or was dropped. A beat that planned nothing is not evidence either
    // way, so it is left out of the denominator rather than counted as a success.
    const decided = fired.filter((b) => b.planned > 0);
    const barren = decided.filter((b) => b.failed + b.dropped >= b.planned);
    if (decided.length >= MIN_FIRINGS && barren.length === decided.length) {
      out.push({
        kind: "rule_barren",
        subject: rule,
        statement:
          `the reflex rule ${rule} fired in ${decided.length} beat(s) and every action it planned failed or was dropped. ` +
          `The condition is reached and the work does not land.`,
        evidence: { ...evidenceOf(beats, barren), count: barrierCount(barren) },
        confidence: confidence(95, 50, fired.length * 5),
      });
    }
  }

  // A brain that keeps degrading. The lesson is about the agent rather than the rule because
  // the model path is per agent, and the honest subject is whoever kept falling back.
  const degradedAgents = new Set(beats.filter((b) => b.degraded).map((b) => b.agent_handle));
  for (const handle of degradedAgents) {
    const degraded = beats.filter((b) => b.agent_handle === handle && b.degraded);
    if (degraded.length < MIN_DEGRADED) continue;
    const reasons = [...new Set(degraded.map((b) => b.degraded))].filter(Boolean);
    out.push({
      kind: "brain_degraded",
      subject: handle,
      statement:
        `the agent ${handle} fell back from its model brain ${degraded.length} time(s) in the window` +
        (reasons.length > 0 ? ` (${reasons.join(", ")})` : "") +
        `. The reflex path carried those beats.`,
      evidence: evidenceOf(beats, degraded),
      confidence: confidence(95, 50, degraded.length * 5),
    });
  }

  return out;
}

function barrierCount(beats: BeatObservation[]): number {
  return beats.reduce((n, b) => n + Math.max(0, b.failed + b.dropped), 0);
}

/** Where a lesson stands. Nothing acts on a lesson that is not adopted. */
export const LESSON_STATUSES = ["proposed", "adopted", "refuted", "retired"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

/** The row as the database holds it, which is what a reader and a decider both see. */
export type Lesson = {
  id: string;
  kind: LessonKind;
  subject: string;
  statement: string;
  evidence: LessonEvidence;
  evidence_hash: string;
  confidence: number;
  status: LessonStatus;
  proposed_by: string;
  adopted_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

/** A sentence longer than this is not a lesson, it is an essay, and it is refused at the door. */
export const MAX_STATEMENT = 600;

/** The least confidence a lesson may carry and still be worth a resident's decision. */
export const MIN_CONFIDENCE = 30;

/** What a first decision can be: a lesson is adopted or it is refused. Nothing else. */
export type AdoptionDecision =
  | { decision: "adopt"; reason: string }
  | { decision: "refuse"; reason: string };

/**
 * What settling a lesson can be, which has one more answer than adopting one.
 *
 * Refusing and refuting are different acts and the record must not blur them. Refusing is a
 * decider declining to decide, because the lesson is closed, unevidenced, uncounted, too
 * weak, or its own author's. Refuting is a decider who did decide, recounted the window and
 * found the pattern does not reproduce. A refusal writes nothing; a refutation is a fact.
 */
export type LessonVerdict =
  | { decision: "adopt"; reason: string }
  | { decision: "refuse"; reason: string }
  | { decision: "refute"; reason: string };

/**
 * Whether a resident may adopt a lesson another resident proposed.
 *
 * The refusals matter more than the permission, and there are five of them. A lesson that is
 * already decided is not reopened by a second decider, because the record would then hold two
 * answers to one question. A lesson with no evidence never becomes behaviour. A lesson counted
 * from a window too small to mean anything is the same as no evidence. A proposer cannot adopt
 * their own lesson: that single rule is the difference between a swarm that corrects itself
 * and a swarm that agrees with itself, and it is why the rule exists rather than a courtesy.
 * And a lesson nobody could act on, below the confidence floor, is left proposed.
 */
export function adoptionDecision(input: {
  lesson: Pick<Lesson, "status" | "proposed_by" | "evidence" | "confidence" | "statement">;
  deciderId: string;
}): AdoptionDecision {
  const { lesson, deciderId } = input;
  if (lesson.status !== "proposed") {
    return { decision: "refuse", reason: `the lesson is already ${lesson.status}` };
  }
  if (!lesson.evidence || lesson.evidence.seqs.length === 0) {
    return { decision: "refuse", reason: "the lesson cites no events, so there is nothing to check" };
  }
  if (lesson.evidence.beats < MIN_BEATS) {
    return {
      decision: "refuse",
      reason: `the lesson was counted from ${lesson.evidence.beats} beat(s), below the ${MIN_BEATS} a window needs`,
    };
  }
  if (lesson.confidence < MIN_CONFIDENCE) {
    return { decision: "refuse", reason: `confidence ${lesson.confidence} is below the floor of ${MIN_CONFIDENCE}` };
  }
  if (lesson.proposed_by === deciderId) {
    return { decision: "refuse", reason: "I proposed this lesson, and a resident cannot adopt its own" };
  }
  if (lesson.statement.trim().length > MAX_STATEMENT) {
    return { decision: "refuse", reason: "the statement is longer than a lesson may be" };
  }
  return { decision: "adopt", reason: "counted from the deployment's own beats and nobody else has decided it" };
}

/**
 * Settling a proposed lesson, by rerunning the derivation rather than by arguing about it.
 *
 * This is the same shape the audit record uses for a disputed verdict: a second agent does not
 * vote on whether the first agent was right, it reruns the check and publishes what it got.
 * So the decider re-derives the pattern over the window as it stands now and the answer is
 * whichever the recount says. The guard above it is the interesting one: if nothing has been
 * recorded since the lesson's own evidence, there is nothing new to count, and a decision made
 * on the same rows the proposer used is not a second opinion. That is refused rather than
 * dressed up as agreement.
 */
export function refutationVerdict(input: {
  lesson: Pick<Lesson, "status" | "proposed_by" | "evidence" | "confidence" | "statement" | "kind" | "subject">;
  deciderId: string;
  /** The newest event sequence the decider can see in the window. */
  latestSeq: number;
  /** Whether the same derivation still produces this pattern from the current window. */
  reproduced: boolean;
}): LessonVerdict {
  const admission = adoptionDecision({ lesson: input.lesson, deciderId: input.deciderId });
  if (admission.decision === "refuse") return admission;

  const newest = input.lesson.evidence.seqs.length > 0 ? Math.max(...input.lesson.evidence.seqs) : 0;
  if (input.latestSeq <= newest) {
    return {
      decision: "refuse",
      reason: "nothing has been recorded since this lesson was counted, so rerunning it would read the same rows",
    };
  }
  if (input.reproduced) {
    return { decision: "adopt", reason: `the pattern still holds when recounted over the window as it stands now` };
  }
  return {
    decision: "refute",
    reason: "recounting the window does not reproduce the pattern, so the lesson does not hold",
  };
}

/**
 * The lessons a resident may act on, and the only ones the policy will ever read.
 *
 * Adopted and nothing else. A proposed lesson is somebody's claim, a refuted one has been
 * measured and failed, and a retired one was true and is not any more. Reading a claim as if
 * it were settled is how a swarm talks itself into something, and the ordering here is
 * newest first so that a policy reading a handful of them reads the recent state of things.
 */
export function readableLessons(lessons: Lesson[], limit = 8): Lesson[] {
  return lessons
    .filter((l) => l.status === "adopted" && l.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => (a.decided_at ?? a.created_at) < (b.decided_at ?? b.created_at) ? 1 : -1)
    .slice(0, limit);
}

/**
 * The key a resident writes when it proposes a lesson, which is how the cooldown is kept.
 *
 * A note rather than a row because this is pacing: the lesson itself is deduped by the
 * uniqueness of its kind, subject and evidence hash, so the record cannot fill with copies
 * of one claim no matter what this key says. The key only stops a resident proposing
 * something on every wake, and `digest:%` and `supervise:%` are the same arrangement.
 */
export const LESSON_NOTE_KEY = "lesson:last";

/** How long a resident waits between proposals. Proposal is cheap and the record is public. */
export const LESSON_PROPOSAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Whether enough time has passed to propose another lesson.
 *
 * A missing note means never proposed, and never proposed is due: the failure that made this
 * codebase stop trusting "guard reads a key nobody wrote" is that it silently lets everything
 * through, so the absent case is decided explicitly here rather than left to comparison.
 */
export function proposalCooldownElapsed(
  lastAt: string | null,
  now: string,
  /** Optional override, so a caller with its own window (r34's metabolism note) reuses this instead of duplicating the arithmetic. Defaults to the lesson cadence. */
  cooldownMs: number = LESSON_PROPOSAL_COOLDOWN_MS,
): boolean {
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return false;
  return at - last >= cooldownMs;
}

/** The note value a proposal writes, which is only ever read back as a timestamp. */
export function lessonNoteValue(input: { lessonId: string }, at: string): Record<string, unknown> {
  return { at, lesson: input.lessonId };
}

/** The proposals waiting for somebody other than their author. */
export function openProposals(lessons: Lesson[], deciderId: string): Lesson[] {
  return lessons
    .filter((l) => l.status === "proposed" && l.proposed_by !== deciderId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
