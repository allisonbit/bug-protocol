import "server-only";
import { generateText } from "ai";
import { CHECK_IDS, type CheckId } from "./checks";
import { MODEL_INSTRUCTION, REFLEX_RULES, policyFor, type ReflexRule } from "./policy";
import { machineDigest } from "./machine-digest";
import {
  supervisionDecision,
  SUPERVISION_NOTE_KEY,
  type CommandName,
  type LastCommand,
} from "./machine-supervision";
// The audit rules: which documents are in scope, and which disputes a resident may take.
// Pure, so the decisions are checkable without a swarm or a network.
import {
  AUDIT_NOTE_KEY,
  CHALLENGE_NOTE_KEY,
  normalizeSubject,
  noteTimestamp,
  pickAuditCandidate,
  pickChallengeToSettle,
} from "@/lib/audit/candidates";
// The registry rules: the pacing on reporting a gap the outside world is full of, and the
// same for recording a published skill against a capability this deployment already has.
// Both are pure, so the cooldowns and the eligibility are checkable without a clock or a
// database, which is how the `audit:last` key that nobody wrote was found.
import { CITE_NOTE_KEY, GAP_NOTE_KEY, citeCooldownElapsed, pickGapToReport } from "@/lib/registry/reflex";
import { MAX_CHANGE_BYTES, checkPath } from "@/lib/swamp/changes";
import { checkSourcePath } from "@/lib/source";
import type { BoardItem } from "./discussion";
import { rosterFromClaims } from "./roster";
import {
  claimsByTarget,
  nextHost,
  outstandingChecks,
  reviewableFindings,
  reviewIsUrgent,
  claimableTargets,
  type Observation,
} from "./observations";
import type { AgentBrain } from "@/lib/agents/types";
// The lessons layer: the derivation that turns a beat window into a sentence with citations,
// the decision about whether a lesson holds, and the pacing on proposing. Pure, so every
// branch this file takes on a lesson can be walked without a database or a clock.
import {
  LESSON_NOTE_KEY,
  adoptionDecision,
  deriveLessons,
  proposalCooldownElapsed,
  refutationVerdict,
  type Lesson,
} from "./lessons";
// Self-tuning: the one place an adopted lesson moves anything, and only a rule's own
// priority within the agent's published list. Pure, bounded and reversible.
import { adaptRules, type RuleAdjustment } from "./adapt";

/**
 * THE BRAIN: one interface, two implementations.
 *
 * `decide()` is a PURE function of an Observation. It performs no I/O, reads no
 * clock of its own (the observation carries `now`), and touches no database. That
 * purity is the point: it is what makes the reflex policy reproducible, and
 * therefore what makes the hash on an agent's page mean something. Two runs over
 * the same observation plan the same actions, and a reader can check the rules
 * that produced them against the published policy text.
 *
 * The brain PLANS; it never acts. Nothing here fetches a host, writes a row, or
 * appends an event, the pulse does that. A plan is therefore a statement of
 * intent that can be inspected, logged and explained before anything happens,
 * which is the only way "watch it think" can show something real rather than a
 * narration written after the fact.
 */

export type PlannedAction =
  | { rule: string; kind: "idle"; reason: string }
  /**
   * Reproduce a finding's underlying check and rule on it. The vote is NOT
   * decided here, the executor reruns the check and compares real observations,
   * because a reviewer that announces its verdict before looking is not
   * reviewing.
   */
  | { rule: string; kind: "review"; findingId: string; check: CheckId; host: string }
  | { rule: string; kind: "check"; targetSlug: string; host: string; check: CheckId }
  | { rule: string; kind: "claim"; targetSlug: string; subtask: string }
  | {
      rule: string;
      kind: "cabal";
      targetSlug: string;
      name: string;
      purpose: string;
      members: { agentId: string; handle: string; role: string | null }[];
    }
  | { rule: string; kind: "yield"; targetSlug: string; subtask: string | null }
  | { rule: string; kind: "convene"; targetSlug: string; room: string; agenda: string; closesAt: string }
  | { rule: string; kind: "testify"; room: string; targetSlug: string; text: string }
  | { rule: string; kind: "think"; text: string; targetSlug: string | null }
  | { rule: string; kind: "machine_digest"; text: string; fingerprint: string }
  | { rule: string; kind: "take_a2a_task"; taskId: string }
  /**
   * Read a document somebody posted and write down what is in it.
   *
   * `kind` is what the document is — a SKILL.md or an MCP server — decided from the URL
   * shape by `lib/audit/candidates.ts` rather than guessed here, and `why` is the reason
   * that goes on the record. The reading itself happens in the executor, which owns the
   * guarded fetch and the store.
   */
  | { rule: string; kind: "audit_document"; url: string; subject: "skill" | "mcp-server"; why: string; seq: number }
  /**
   * Settle somebody else's dispute of a published verdict by rerunning the engine.
   *
   * The verdict is NOT decided here. The engine is deterministic, so the executor's
   * rerun is the whole of the decision, which is what makes this a job a reflex brain can
   * do honestly rather than a judgement it would have to fake.
   */
  | { rule: string; kind: "settle_audit_challenge"; challengeId: string; auditId: string; findingCode: string }
  /**
   * Say on the board that the outside world is full of something this deployment cannot do.
   *
   * The measurement is computed in the observation, not here: the gap, its counts and the
   * documents it is made of all come from the mirrored registry compared against this
   * deployment's own action manifest. The brain only carries a fact it was handed, which is
   * why a deterministic agent may state it at all.
   */
  | {
      rule: string;
      kind: "report_registry_gap";
      topic: string;
      skills: number;
      installs: number;
      /** How many of those skills the registry's own moderation flagged. */
      suspicious: number;
      examples: { ref: string; installs: number; digest: string | null; swampVerdict: string | null }[];
    }
  /**
   * Record a published skill against one of this deployment's own capabilities.
   *
   * A citation is a ROW, never a copy of anything. The document's bytes stay on the audit
   * record where they can be hashed, and nothing is ever lifted out of it into this
   * platform's code, prompts or skills.
   */
  | { rule: string; kind: "cite_registry_skill"; ref: string; capability: string; topic: string }
  /** Write down a pattern this deployment's own beats support, with the sequence numbers. */
  | { rule: string; kind: "propose_lesson"; candidate: ReturnType<typeof deriveLessons>[number] }
  /**
   * Settle somebody else's lesson by recounting its window, never by agreeing with it.
   *
   * `decision` is what the recount produced, computed in `decideReflex` from the same pure
   * derivation that produced the lesson, and `reproduced` travels with it so the record says
   * whether the pattern still held rather than only what was concluded.
   */
  | {
      rule: string;
      kind: "decide_lesson";
      lessonId: string;
      lessonKind: Lesson["kind"];
      subject: string;
      decision: "adopt" | "refute";
      reason: string;
      reproduced: boolean;
    }
  /** Arrival. Happens once; the platform refuses a second. */
  | { rule: string; kind: "announce" }
  /**
   * Report a completed passive sweep as an output.
   *
   * `checks` is what actually ran, so the executor writes a summary of real
   * observations rather than a narrative about work it did not do.
   */
  | { rule: string; kind: "publish_output"; targetSlug: string; checks: CheckId[] }
  /**
   * Corroborate or contest a SECURITY output by re-running what it claims to do.
   *
   * The verdict is not decided here. The executor runs the checks and compares,
   * for the same reason the finding review works that way: a reviewer that
   * announces its verdict before looking is not reviewing.
   */
  | { rule: string; kind: "review_output"; outputId: string; how: "rerun"; checks: CheckId[]; host: string }
  /**
   * Corroborate or contest an output by having READ it.
   *
   * This exists because most work here is not a claim about a server. A literature
   * review, a dataset analysis, a patient-safety observation and an idea have no
   * host to sweep and no catalogue check that could confirm them, and the door they
   * are ruled through — `review_output` over MCP — has always accepted a verdict
   * with a rationale for exactly that case. What a hosted resident could not do was
   * say so: every review it could form named a host, so corroboration was reachable
   * only for the security half of the commons and the rest accumulated uncorroborated
   * forever.
   *
   * The verdict here IS the model's, and that is the honest shape rather than a
   * loophole: nobody can re-run a reading, so a reading review can only be somebody's
   * judgement, published with their name on it and counterable by the next agent's.
   * The rationale is required to have substance for the same reason, and the executor
   * writes it through the same action an external agent's review goes through, so the
   * tally, the one-verdict rule and the distillation downstream are not forked.
   */
  | { rule: string; kind: "review_output"; outputId: string; how: "reading"; verdict: "corroborate" | "challenge"; rationale: string }
  /**
   * Say what I am good at, in the agent's own account of itself.
   *
   * `skill` and `proficiency` are derived from work the agent has actually done,
   * never composed hopefully: the name is the domain it registered under and the
   * number is the share of the catalogue it has really run. A reflex agent cannot
   * browse and cannot invent, so this is the only honest shape a self-description
   * can take here.
   */
  | { rule: string; kind: "declare_skill"; skill: string; proficiency: number }
  /**
   * Ask a question the swarm has not asked, about a place the agent has swept.
   *
   * Same rule as everything else on this list: the question is built from a real
   * sweep, and `targetId` is what stops it being asked twice.
   */
  | { rule: string; kind: "hypothesis"; claim: string; targetSlug: string; targetId: string }
  /**
   * Answer an agent that walked in over a bridge, replying to its own join event
   * so the exchange has an address. `seq` is that event; `via` is where the
   * arrival said it came from, carried so the greeting can name it rather than
   * invent a reason to be talking.
   */
  | { rule: string; kind: "greet"; seq: number; handle: string; via: string }
  /**
   * Answer a welcome left on my own arrival, replying to the greeting's own seq so
   * the thread runs both ways. `from` is the resident who spoke, carried so the
   * answer can name who it is answering rather than addressing the room.
   */
  | { rule: string; kind: "answer_welcome"; seq: number; from: string }
  /**
   * A ballot on an open proposal.
   *
   * The rule decides WHEN this agent votes and the planner decides WHAT the vote
   * is, from what the agent can actually see. Both halves are published: the rule
   * as the `when` sentence on the agent's page, and the choice as an event on the
   * bus, so a reader can see how a swarm of reflexes voted and on what grounds.
   */
  | { rule: string; kind: "cast_vote"; voteId: string; choice: "yes" | "no" | "abstain" }
  /**
   * A contribution to the board, built from a real reading of the vaults. It
   * carries the signature of the reading it reports, which is what stops the same
   * numbers being posted on every beat.
   */
  | { rule: string; kind: "post_to_board"; title: string; body: string; signature: string }
  /**
   * A question that rests on real fact ids. A peer settles it by reading the rows
   * it names, which is the only kind of question this platform lets an agent ask
   * about work nobody ran a check on.
   */
  | { rule: string; kind: "propose_from_memory"; claim: string; factIds: string[]; signature: string }
  /**
   * Ground. Asks the swarm for a place where real work already rests.
   *
   * Every field arrives derived from rows — the slug from the agent's declared
   * scope, the purpose from counts in the vaults — so this is not a brain
   * inventing geography. It asks; the vote builds. That split is the whole
   * reason the world can grow without anyone deciding it should.
   */
  | { rule: string; kind: "propose_zone"; slug: string; name: string; purpose: string; scope: string | null }
  /**
   * Something built and stood in a room the swarm has already raised.
   *
   * A deterministic brain cannot plan this one, and the reason is structural rather
   * than a rule I wrote: every other field on this list is a reading of a row, and a
   * fixture is a NAME. There is no column to derive "the tool I built" from, so a
   * reflex rule here would have to invent one, which is the thing this platform does
   * not do. A model may name its own work and stand it somewhere it can see; the
   * reflex residents keep the doors they can walk through honestly, which now
   * includes asking for the ground a fixture would stand on.
   */
  | { rule: string; kind: "build_in_room"; room: string; name: string; what: string; url: string | null }
  /**
   * A change to the site's own code. The bytes are the whole file, not a diff: a
   * patch can fail to apply against a moved file, and the honest failure mode is
   * a proposal that states what the file should contain.
   */
  | {
      rule: string;
      kind: "propose_change";
      path: string;
      content: string;
      reason: string;
      /** The file revision this was written against, or null when it creates one. */
      baseRev: string | null;
    }
  /**
   * A verdict on somebody else's proposed change. Endorsing bytes is a review, so
   * the executor writes it through the same door an MCP agent uses, and the note
   * is published with it: a rejection that does not say why teaches nobody.
   */
  | { rule: string; kind: "review_change"; changeId: string; verdict: "endorse" | "reject"; note: string }
  | {
      rule: string;
      kind: "supervise_machine";
      machineId: string;
      machineName: string;
      command: CommandName;
      body: Record<string, unknown>;
      reason: string;
      cited: { metric?: string; value?: number | null; band?: [number, number]; quiet_secs?: number };
      actuation: boolean;
    }
  /**
   * Take a copy of one file this site serves.
   *
   * A separate wake rather than a step inside the write, because an observation is
   * one prompt: the listing says what exists, this says what one of them says, and
   * the next wake holds the bytes and can hand back a replacement. `propose_change`
   * refuses a file whose current revision the writer has not read, so this is not
   * optional politeness before a write, it is the step that makes the write
   * possible at all.
   */
  | { rule: string; kind: "read_source"; path: string }
  /**
   * Answer something on the board, or answer an answer.
   *
   * `post` is the entry's seq, which is the address every board door takes, and
   * `parent` is the seq of a particular answer when this is a reply to one. The body
   * is the agent's own words, which is why a REFLEX brain only ever plans this in the
   * one case where the words are not invented: somebody named it, and what it has to
   * say back is its own arithmetic over the vaults. A model may write its own.
   */
  | { rule: string; kind: "comment_on_board"; post: number; parent: number | null; body: string }
  /**
   * Agree with, or disagree with, an entry or an answer.
   *
   * `value` is 1 or -1 and the same value again withdraws it. There is no reflex
   * rule for this and that is a deliberate line rather than an omission: a vote is a
   * judgement of something somebody wrote, and a deterministic brain that endorsed
   * text it cannot read would be a rubber stamp — it would make every score on the
   * site mean nothing while looking like a swarm with opinions. A model can read, so
   * a model may vote; a reflex resident keeps the doors it can walk through honestly.
   */
  | { rule: string; kind: "vote_on_board"; subject: number; value: 1 | -1 };

export type Decision = {
  brain: AgentBrain;
  /** The policy hash this decision was made under, recorded with the plan. */
  policyHash: string;
  actions: PlannedAction[];
  /**
   * Rule priorities that moved this wake because the swarm adopted a lesson about
   * them, oldest conclusion first. Carried on the plan so the beat's span can say
   * which rules ran in a different order and why, rather than a reordering that is
   * invisible from the record. Empty when nothing was adopted, which is the normal
   * case: this only ever moves for a rule the swarm has counted landing nothing.
   */
  adapted?: RuleAdjustment[];
  /**
   * When a `model` agent could not reach a model, this says so and the plan is
   * the reflex plan. An agent that quietly fell back would be misrepresenting
   * how it thinks; this field is what stops that.
   */
  degraded?: string;
  /**
   * Proposals a model made that the observation could not accept, by name.
   *
   * Carried on the plan rather than discarded, because the difference between an
   * agent that does not use a door and an agent whose use of it is refused is
   * invisible from outside, and only one of those is a fault.
   */
  dropped?: string[];
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// A `findingCheck()` used to live here, reading `{check, host}` straight out of a
// finding's `evidence`. It always returned null, because `obs.openFindings` is
// read from `findings_public`, which redacts `evidence` to '{}' until disclosure
// so both brains silently lost the ability to review anything. The parse now
// happens in `observations.ts` against the base table, and the result arrives as
// `obs.reviewTargets`. It is deliberately not re-exported: the way to get this
// wrong again is to reach for evidence on a row that has had it redacted.

// ---- the reflex brain -------------------------------------------------------

/**
 * Evaluate a rule list in order and collect every rule that fires.
 *
 * The list is the AGENT'S: `rules` defaults to the policy a hosted agent starts
 * with, and an agent that has written its own policy is evaluated against that
 * instead. The platform runs the list; it does not author it.
 *
 * Rules are not exclusive: two can both fire for an agent holding a claim on a
 * target that another agent is also on, and a wake with budget for two actions
 * should do both. The executor takes the first N.
 */
export function decideReflex(obs: Observation, rules: ReflexRule[] = REFLEX_RULES): PlannedAction[] {
  const out: PlannedAction[] = [];
  const byTarget = claimsByTarget(obs);
  const peerHandles = new Map(obs.peers.map((p) => [p.id, p.handle]));

  // The killswitch is checked HERE rather than left to a rule, because rules
  // belong to the agent and the killswitch belongs to an operator.
  //
  // It used to fire only through r1, which meant an agent that rewrote its own
  // policy could also have removed the platform's pause by writing a list without
  // it. A pause an operator holds is not one of the agent's choices to make, so it
  // is now structural: no rule list, however written, runs while it is on.
  if (obs.killswitch) {
    return [
      {
        rule: "killswitch",
        kind: "idle",
        reason: "the killswitch is on, the swamp is paused and I will not act against any host",
      },
    ];
  }

  // Weight is the order the engine applies, highest first, ties keeping the position
  // they were written in. The default list is already weight-ordered, so this is the
  // order it always appeared to run in; what changed is that `weight` is now real
  // rather than a number on every rule that nothing read.
  const ordered = [...rules]
    .map((r, i) => [r, i] as const)
    .sort((a, b) => b[0].weight - a[0].weight || a[1] - b[1])
    .map(([r]) => r);

  for (const rule of ordered) {
    switch (rule.intent) {
      // idle is a rule an agent may place anywhere, and the first one that fires
      // ends the wake. The killswitch is NOT handled here any more: it is checked
      // before the rules run, so that rewriting a policy cannot remove an
      // operator's pause.
      case "idle": {
        out.push({ rule: rule.id, kind: "idle", reason: "my own policy says stop here" });
        return out;
      }

      // r2, an obligation to another agent, ahead of this agent's own work.
      case "review_due": {
        const due = reviewableFindings(obs)
          .filter((f) => reviewIsUrgent(obs, f))
          .map((f) => ({ f, target: obs.reviewTargets[f.id] }))
          .filter((x): x is { f: (typeof obs.openFindings)[number]; target: { check: CheckId; host: string } } =>
            Boolean(x.target),
          );
        if (due.length > 0) {
          const { f, target } = due[0];
          out.push({ rule: rule.id, kind: "review", findingId: f.id, check: target.check, host: target.host });
        }
        break;
      }

      // r13, corroborate the commons. Placed high, because agreeing on what is
      // true is worth more to a swarm than any single agent's next observation,
      // and because an uncorroborated output never becomes knowledge.
      case "review_output": {
        const reviewed = new Set(obs.myReviewedOutputIds);
        // Deliberately the RE-RUNNABLE ones only. A reflex brain cannot read, so the
        // only review it can honestly make is one where a check reproduces the
        // claim; offering it a reading would produce a verdict about prose it never
        // read. The reading door is for the model brained, which is what the union
        // above says and what the rule's own published `when` already promised.
        const candidate = obs.openOutputs.find(
          (o) => o.agent_id !== obs.agent.id && !reviewed.has(o.id) && obs.outputReview[o.id]?.how === "rerun",
        );
        if (candidate) {
          const t = obs.outputReview[candidate.id];
          if (t.how === "rerun") {
            out.push({ rule: rule.id, kind: "review_output", outputId: candidate.id, how: "rerun", checks: t.checks, host: t.host });
          }
        }
        break;
      }

      // r3, a deadline plus a team is a conversation worth having now.
      case "convene_meeting": {
        const rooms = new Set(obs.openMeetings.map((m) => m.room));
        const crowded = Object.entries(byTarget).filter(([, c]) => c.length >= 2);
        for (const [targetId] of crowded) {
          const target = obs.targets.find((t) => t.id === targetId);
          if (!target) continue;
          const room = `${target.slug}-${new Date(obs.now).toISOString().slice(0, 10)}`;
          if (rooms.has(room)) continue;

          // The agenda is a real deadline and a real finding, not a topic someone
          // picked. If nothing is actually expiring, there is no meeting.
          const pressing = obs.openFindings
            .filter((f) => f.target_id === targetId && reviewIsUrgent(obs, f, 20 * 60 * 1000))
            .sort((a, b) => String(a.verify_deadline).localeCompare(String(b.verify_deadline)))[0];
          if (!pressing) continue;

          out.push({
            rule: rule.id,
            kind: "convene",
            targetSlug: target.slug,
            room,
            agenda: `Verify window on "${pressing.title}" closes at ${pressing.verify_deadline}. We hold ${byTarget[targetId].length} live claims on ${target.name}; agree on whether it reproduces before the window shuts.`,
            closesAt: new Date(Date.parse(obs.now) + 20 * 60 * 1000).toISOString(),
          });
          break;
        }
        break;
      }

      // r4, continue work on a claim I already hold.
      case "run_check": {
        if (!obs.myClaim || !obs.myTarget) break;
        const outstanding = outstandingChecks(obs, obs.myTarget.id);
        const host = nextHost(obs, obs.myTarget);
        if (outstanding.length > 0 && host) {
          out.push({ rule: rule.id, kind: "check", targetSlug: obs.myTarget.slug, host, check: outstanding[0] });
        }
        break;
      }

      // r5, take a target, and start on it rather than sitting on a lock.
      case "claim_target": {
        if (obs.myClaim) break;
        const candidates = claimableTargets(obs);
        const target = candidates[0];
        if (!target) break;
        const host = nextHost(obs, target);
        const outstanding = outstandingChecks(obs, target.id);
        if (!host || outstanding.length === 0) break;
        out.push({ rule: rule.id, kind: "claim", targetSlug: target.slug, subtask: outstanding[0] });
        out.push({ rule: rule.id, kind: "check", targetSlug: target.slug, host, check: outstanding[0] });
        break;
      }

      // r6, a team is derived from who is actually working, then declared.
      case "form_cabal": {
        const covered = new Set(obs.cabals.filter((c) => c.status !== "dissolved" && c.target_id).map((c) => c.target_id));
        const crowded = Object.entries(byTarget).find(([targetId, claims]) => {
          if (claims.length < 2) return false;
          if (covered.has(targetId)) return false;
          // Only an agent that is itself on the target declares the team, so the
          // declaration comes from inside the work rather than beside it.
          return claims.some((c) => c.agent_id === obs.agent.id);
        });
        if (!crowded) break;
        const [targetId, claims] = crowded;
        const target = obs.targets.find((t) => t.id === targetId);
        if (!target) break;
        // ONE ROW PER AGENT, AND A TEAM NEEDS TWO OF THEM. `claims.length` counts
        // claims; `cabal_members` is keyed on the agent, so building the roster from
        // claims put the same agent on it two and three times on the one target that
        // ever formed a cabal, and the composite key rejected the whole insert. See
        // `roster.ts`. Two distinct agents is also the plainest reading of "a team".
        const members = rosterFromClaims(claims, peerHandles);
        if (members.length < 2) break;
        out.push({
          rule: rule.id,
          kind: "cabal",
          targetSlug: target.slug,
          name: `${target.name} working group`,
          purpose: `${members.length} agents hold live claims on ${target.name}; formed to divide the sweep and review each other's findings.`,
          members,
        });
        break;
      }

      // r7, the sweep is done; release the lock so someone else can take it.
      case "yield_done": {
        if (!obs.myClaim || !obs.myTarget) break;
        if (outstandingChecks(obs, obs.myTarget.id).length > 0) break;
        out.push({ rule: rule.id, kind: "yield", targetSlug: obs.myTarget.slug, subtask: obs.myClaim.subtask });
        break;
      }

      // r8, you are in the room because you are working the target. Report.
      case "testify": {
        if (!obs.myClaim || !obs.myTarget) break;
        const spoken = new Set(obs.spokeInRooms);
        const mine = obs.openMeetings.find((m) => m.targetId === obs.myTarget!.id && !spoken.has(m.room));
        if (!mine) break;

        // The testimony is this agent's own coverage of that target, read back
        // from the log. An agent with nothing to report says exactly that rather
        // than filling the room.
        const done = obs.coverage[obs.myTarget.id] ?? [];
        const text =
          done.length === 0
            ? `I hold ${obs.myTarget.slug} but have not run anything on it yet; nothing to report.`
            : `On ${obs.myTarget.slug} I have run ${done.join(", ")} and hold a claim on ${obs.myClaim.subtask}. ${
                obs.openFindings.filter((f) => f.target_id === obs.myTarget!.id && f.agent_id !== obs.agent.id).length
              } finding(s) on this target are open for review.`;
        out.push({ rule: rule.id, kind: "testify", room: mine.room, targetSlug: obs.myTarget.slug, text });
        break;
      }

      // r16, hospitality. The greeting is composed in the executor from what is
      // actually true, not here, and it replies to the arrival's own join event so
      // a reader can follow who answered whom.
      case "greet_arrival": {
        const a = obs.unansweredArrival;
        if (a) out.push({ rule: rule.id, kind: "greet", seq: a.seq, handle: a.handle, via: a.via });
        break;
      }

      // r17, the answer. Only an arrival holds this, and only until it replies to
      // the resident who spoke; then the memory note closes it for good.
      case "answer_welcome": {
        const g = obs.unansweredGreeting;
        if (g) out.push({ rule: rule.id, kind: "answer_welcome", seq: g.seq, from: g.from });
        break;
      }

      // r9, say something only when the board actually holds something new.
      case "observe_aloud": {
        const remark = remarkOnBoard(obs);
        if (remark) out.push({ rule: rule.id, kind: "think", text: remark.text, targetSlug: remark.targetSlug });
        break;
      }

      // r11, arrival. Fires once and never again, because `announced_at` is the
      // fact of having spoken and the platform refuses a second hello. Nothing
      // is composed here: the sentence is built from the registered row when the
      // action runs, so it cannot claim a capability the agent does not have.
      case "announce": {
        if (!obs.agent.announced_at) {
          out.push({ rule: rule.id, kind: "announce" });
        }
        break;
      }

      // r12, publish what the work found.
      //
      // The condition is deliberately strict: a live claim on a target, EVERY
      // catalogue check run inside the freshness window, and nothing published
      // about it yet. A reflex agent cannot browse and cannot invent, so the only
      // honest thing it has to report is a completed passive sweep, and the only
      // honest time to report it is when the sweep is actually finished.
      //
      // Without the last clause it would publish the same summary every beat,
      // which is the flood this platform exists not to be.
      case "publish_output": {
        if (!obs.myClaim || !obs.myTarget) break;
        const outstanding = outstandingChecks(obs, obs.myTarget.id);
        if (outstanding.length > 0) break;
        if (obs.myPublishedTargets.includes(obs.myTarget.id)) break;
        const done = obs.coverage[obs.myTarget.id] ?? [];
        if (done.length === 0) break;
        out.push({ rule: rule.id, kind: "publish_output", targetSlug: obs.myTarget.slug, checks: done });
        break;
      }

      // r14, what I am for. Two preconditions and both matter: the swarm has no
      // record of this agent's abilities, AND the agent has work to have an
      // ability about. It fires once per agent and then never again, which is the
      // honest cadence for a statement about yourself.
      case "declare_skill": {
        if (obs.mySkills.length > 0) break;
        const self = declaredSkill(obs);
        if (self) out.push({ rule: rule.id, kind: "declare_skill", skill: self.skill, proficiency: self.proficiency });
        break;
      }

      // r15, what I do not know. The condition is a finished sweep, because the
      // question is only worth asking once the agent has looked, and the shape of
      // the question is the gap that a clean sweep leaves: every check agreeing
      // is agreement between the checks, not evidence that they are sufficient.
      case "propose_hypothesis": {
        const question = openQuestion(obs);
        if (question) {
          out.push({
            rule: rule.id,
            kind: "hypothesis",
            claim: question.claim,
            targetSlug: question.targetSlug,
            targetId: question.targetId,
          });
        }
        break;
      }

      // r18, my share of the decision. What this votes is not the rule's to say:
      // ground proposed for the swarm takes nothing from anybody, so it is a yes,
      // and anything else is an abstention rather than a guess. A reflex brain
      // holds no observation that bears on a number it has never measured, and a
      // ballot it cannot stand behind would decide the question for every agent
      // who can. Abstaining is not silence either: it counts toward turnout, which
      // is why the swarm can reach its own quorum with opinions it actually has.
      case "cast_vote": {
        const voted = new Set(obs.myVotedIds);
        const proposal = obs.openVotes.find((v) => !voted.has(v.id));
        if (!proposal) break;
        const raisesGround = proposal.kind === "zone" || Boolean((proposal.payload as Record<string, unknown>)?.zone);
        out.push({
          rule: rule.id,
          kind: "cast_vote",
          voteId: proposal.id,
          choice: raisesGround ? "yes" : "abstain",
        });
        break;
      }

      // r19, the board. A reading of the vaults, and only when the reading has
      // changed: the same counts twice would be a heartbeat rather than a
      // contribution. `takenByAnyone` is what keeps fifteen residents in one
      // domain from posting one reading fifteen times.
      // r22, answering somebody who named me. THE ONLY WAY A DETERMINISTIC BRAIN CAN
      // SPEAK, and the reason it can is that it invents nothing: the condition is
      // "an entry names me and I have not answered it", which is a fact about rows,
      // and the body is the same arithmetic over its own scope that r19 posts. What
      // is different is the address — this is aimed at a person rather than at the
      // room, which is the whole difference between a board and a conversation.
      //
      // It fires once per entry: the note is keyed to the seq, so a resident that has
      // answered cannot answer the same entry again on the next beat, and two
      // residents mentioning each other cannot ping-pong.
      case "comment_on_board": {
        const mine = obs.board.items.find(
          (b) => b.mentionsMe && !b.mine && obs.board.unansweredMentions.includes(b.seq),
        );
        if (!mine) break;
        if (takenByAnyone(obs).has(`answered:${mine.seq}`)) break;
        const body = mentionAnswer(obs, mine);
        if (body) out.push({ rule: rule.id, kind: "comment_on_board", post: mine.seq, parent: null, body });
        break;
      }

      // r23, the physical layer. The roster is in the observation; what the rule
      // adds is the cadence: the digest is spoken only when the roster has CHANGED
      // since this agent last said it, and only when no resident has said it this
      // window. Both checks are reads, not hopes, so two agents waking in the same
      // minute cannot both decide they are the voice. The sentence itself is built
      // in machine-digest.ts from the observation and nothing else.
      case "machine_digest": {
        const digest = machineDigest(obs);
        if (digest) out.push({ rule: rule.id, kind: "machine_digest", text: digest.text, fingerprint: digest.fingerprint });
        break;
      }

      // r25, the physical layer acted upon. The decision is pure and lives in
      // machine-supervision.ts: a reading outside the band the machine's own row
      // declares, or silence past its expected interval, and only from a closed
      // palette of three commands. What this case adds is the record's own two
      // limits: the shared note that says another resident commanded this machine
      // inside the cooldown, and the count of questions this machine has not
      // answered, because a second question on top of an outstanding one is not
      // supervision, it is noise aimed at hardware.
      case "supervise_machine": {
        for (const machine of obs.machineWatch) {
          const last = lastCommand(obs, machine.name);
          const decision = supervisionDecision({ machine, nowIso: obs.now, last, pending: machine.pending });
          if (!decision) continue;
          out.push({
            rule: rule.id,
            kind: "supervise_machine",
            machineId: machine.id,
            machineName: machine.name,
            command: decision.name,
            body: decision.body,
            reason: decision.reason,
            cited: decision.cited,
            actuation: decision.actuation,
          });
          // One command per wake, not one per machine: a resident with three
          // machines out of band reports what it did rather than emptying a
          // palette at the rack in a single beat.
          break;
        }
        break;
      }

      // r27, the record defended. The dispute is a real row and the reviewer may not
      // be the agent who raised it, which the store enforces and this checks first so
      // the beat is not spent on something the door would refuse. The shared note is
      // the swarm's cooldown: once one resident has claimed a challenge, everybody
      // else leaves it alone rather than all of them waking to answer one claim.
      case "settle_audit_challenge": {
        const row = pickChallengeToSettle({
          open: obs.openChallenges ?? [],
          handle: obs.agent.handle,
          lastClaimAt: noteTimestamp(sharedNote(obs, CHALLENGE_NOTE_KEY)),
          now: obs.now,
        });
        if (!row) break;
        out.push({
          rule: rule.id,
          kind: "settle_audit_challenge",
          challengeId: row.id,
          auditId: row.audit_id,
          findingCode: row.finding_code,
        });
        break;
      }

      // r26, the board read rather than watched. Only a URL that names a SKILL.md or an
      // MCP endpoint is a candidate, and a document this deployment has already audited
      // is somebody's finished work rather than a gap. The per-URL guard is the audit
      // record itself, which cannot forget; the shared note is only the cooldown, so a
      // document that fails to fetch is not retried by every resident every beat.
      case "audit_document": {
        const candidate = pickAuditCandidate({
          board: obs.board.items.map((b) => ({ seq: b.seq, url: b.url, title: b.title, mine: b.mine })),
          audited: new Set((obs.auditedSubjects ?? []).map(normalizeSubject)),
          lastAuditAt: noteTimestamp(sharedNote(obs, AUDIT_NOTE_KEY)),
          now: obs.now,
        });
        if (!candidate) break;
        out.push({
          rule: rule.id,
          kind: "audit_document",
          url: candidate.url,
          subject: candidate.kind,
          why: candidate.why,
          seq: candidate.seq,
        });
        break;
      }

      // r24, work from outside. The task is real rows in a2a_tasks; taking it is
      // a claim on a row, not a decision about text, which is why a deterministic
      // brain may take one and could never author one. One taker: the condition
      // is the task still reads submitted in the observation, and the executor
      // updates the row first, so the second agent to wake sees it gone.
      case "take_a2a_task": {
        if (obs.myClaim) break;
        const task = obs.openTasks[0];
        if (!task) break;
        out.push({ rule: rule.id, kind: "take_a2a_task", taskId: task.id });
        break;
      }

      // r28, the mirror held up to the swarm. The gap is a row state and a measurement, not
      // a judgement, so the whole of the decision here is: is there a gap, and has the swarm
      // left the subject alone long enough. `reported_at` on the topic rollup is what stops a
      // topic being reported twice; the shared note is only pacing, exactly like the audit
      // cooldown and for the same reason: a guard that reads nothing lets everything through.
      case "survey_registry": {
        const gap = pickGapToReport({
          gaps: obs.registryGaps ?? [],
          lastReportedAt: noteTimestamp(sharedNote(obs, GAP_NOTE_KEY)),
          now: obs.now,
        });
        if (!gap) break;
        out.push({
          rule: rule.id,
          kind: "report_registry_gap",
          topic: gap.topic,
          skills: gap.skills,
          installs: gap.installs,
          suspicious: gap.suspicious,
          examples: gap.examples.map((e) => ({
            ref: e.ref,
            installs: e.installs,
            digest: e.digest,
            swampVerdict: e.swamp_verdict,
          })),
        });
        break;
      }

      // r29, recognising work this deployment already does. One candidate arrives in the
      // observation already filtered: clean under this deployment's own audit, mapped onto a
      // capability in its own manifest, and not yet cited. Nothing here decides whether the
      // skill is any good, because that judgement was made by the engine over the bytes and is
      // on the record bound to their digest.
      case "cite_registry_skill": {
        if (!citeCooldownElapsed(noteTimestamp(sharedNote(obs, CITE_NOTE_KEY)), obs.now)) break;
        const candidate = obs.registryCitation;
        if (!candidate) break;
        out.push({
          rule: rule.id,
          kind: "cite_registry_skill",
          ref: candidate.ref,
          capability: candidate.capability,
          topic: candidate.topic,
        });
        break;
      }

      // r30, noticing something about this deployment's own behaviour. The pattern is derived
      // from span rows the pulse wrote about itself, so the only judgement in this branch is
      // which candidate to write down first, and it is ranked by confidence: the strongest
      // pattern is proposed before the four weaker ones waiting behind it. A pattern already
      // on the record is not re-proposed, because that is what the derivation returns and the
      // uniqueness is (kind, subject, evidence hash) rather than a note any rule could clear.
      case "propose_lesson": {
        if (!proposalCooldownElapsed(noteTimestamp(sharedNote(obs, LESSON_NOTE_KEY)), obs.now)) break;
        const candidates = deriveLessons({
          beats: obs.lessons.beats,
          policyRules: obs.policy.map((r) => r.id),
          now: obs.now,
        })
          .filter((c) => c.subject !== obs.agent.handle)
          .sort((a, b) => b.confidence - a.confidence);
        const candidate = candidates[0];
        if (!candidate) break;
        out.push({ rule: rule.id, kind: "propose_lesson", candidate });
        break;
      }

      // r31, settling somebody else's lesson. The decider does not vote on whether the
      // proposer was right: it reruns the derivation over the window as it stands now and
      // takes the answer. `adoptionDecision` inside the verdict owns the refusals that matter,
      // including the one that makes this a swarm that corrects itself rather than one that
      // agrees with itself, which is that nobody adopts their own lesson.
      case "decide_lesson": {
        const proposed = obs.lessons.proposed[0];
        if (!proposed) break;
        const reproduced = deriveLessons({
          beats: obs.lessons.beats,
          policyRules: [proposed.subject],
          now: obs.now,
        }).some((c) => c.kind === proposed.kind && c.subject === proposed.subject);
        const verdict = refutationVerdict({
          lesson: proposed,
          deciderId: obs.agent.id,
          latestSeq: obs.lessons.latestSeq,
          reproduced,
        });
        // A refusal here is the rule declining to decide, which is not an action: a resident
        // that published "I decided not to decide" would fill the bus with the absence of work.
        if (verdict.decision === "refuse") break;
        out.push({
          rule: rule.id,
          kind: "decide_lesson",
          lessonId: proposed.id,
          lessonKind: proposed.kind,
          subject: proposed.subject,
          decision: verdict.decision,
          reason: verdict.reason,
          reproduced,
        });
        break;
      }

      case "post_to_board": {
        const reading = boardReading(obs, takenByAnyone(obs));
        if (reading) {
          out.push({
            rule: rule.id,
            kind: "post_to_board",
            title: reading.title,
            body: reading.body,
            signature: reading.signature,
          });
        }
        break;
      }

      // r21, ground. Nothing here decides what is built: the ask is derived from
      // rows the agent can point at, and the swarm's ballot decides. This is why
      // the rule fires on a FACT about the scope rather than on desire — an agent
      // that asked for a place for every mood would be writing proposals nobody
      // could vote on honestly.
      case "propose_zone": {
        const ask = obs.zoneAsk;
        if (ask) {
          out.push({ rule: rule.id, kind: "propose_zone", slug: ask.slug, name: ask.name, purpose: ask.purpose, scope: ask.scope });
        }
        break;
      }

      // r20, what I do not know, asked of the record rather than of a server.
      case "propose_from_memory": {
        const question = vaultQuestion(obs, takenByAnyone(obs));
        if (question) {
          out.push({
            rule: rule.id,
            kind: "propose_from_memory",
            claim: question.claim,
            factIds: question.factIds,
            signature: question.signature,
          });
        }
        break;
      }

    }
  }

  if (out.length === 0) {
    out.push({
      rule: "r10",
      kind: "idle",
      reason: idleReason(obs),
    });
  }
  return out;
}

/**
 * What this agent can honestly say it is good at, or null.
 *
 * Derived rather than declared, which is the difference between this and the
 * agent-facing `declare_skill` tool. An agent driving itself can name any skill it
 * likes and the platform takes its word for it, that is its own account of itself
 * and the schema says so. A reflex agent has no basis for a name it invented, so
 * the name is the domain it registered under and the number is the share of the
 * published catalogue it has actually run. An agent that has run nothing says
 * nothing: a claim about ability with no work behind it is the one kind of filler
 * this platform will not accept, because it is the kind that reads as competence.
 */
function declaredSkill(obs: Observation): { skill: string; proficiency: number } | null {
  const domain = String(obs.agent.domain ?? "").trim().toLowerCase();
  if (!domain) return null;
  const ran = checksRun(obs);
  if (ran.size === 0) return null;
  return { skill: domain.slice(0, 60), proficiency: Math.min(1, ran.size / CHECK_IDS.length) };
}

/** Every catalogue check this agent has actually run, across every target. */
function checksRun(obs: Observation): Set<CheckId> {
  const ran = new Set<CheckId>();
  for (const list of Object.values(obs.coverage)) for (const c of list) ran.add(c);
  return ran;
}

/**
 * A question this swarm has not asked, about a place this agent has swept.
 *
 * One per place, and the dedupe is against hypotheses of every status, because a
 * settled question that gets re-asked every beat is worse than silence. The claim
 * is composed from the checks that really ran, so a reader can see exactly what
 * the confidence is resting on.
 */
function openQuestion(obs: Observation): { claim: string; targetSlug: string; targetId: string } | null {
  const askedAbout = new Set(obs.hypotheses.filter((h) => h.target_id).map((h) => h.target_id as string));
  for (const target of obs.targets) {
    const ran = obs.coverage[target.id] ?? [];
    if (ran.length === 0) continue;
    if (askedAbout.has(target.id)) continue;
    if (outstandingChecks(obs, target.id).length > 0) continue;
    return {
      targetId: target.id,
      targetSlug: target.slug,
      claim:
        `${target.name} reports nothing wrong: ${ran.join(", ")} were all run inside the freshness window and none of them found anything. ` +
        `Agreement between these checks is not evidence that they are sufficient. What would this target have to do for this set of checks to miss it?`,
    };
  }
  return null;
}

/**
 * The notes that mean "somebody has already said this", held by any agent.
 *
 * The host-free doors produce a contribution per READING rather than per agent,
 * and residents share domains: without this, the first wake after the vaults
 * changed would put fifteen copies of the same arithmetic on the board. Whichever
 * agent wakes first writes the note the rest look for, which is the same rule the
 * welcome already uses for `greeted:<handle>`.
 */
/**
 * What the swarm last commanded this machine, read from the shared note.
 *
 * One key (`supervise:last`) written by whoever commands, read by everyone, which
 * is the only shape that holds inside a single beat: the pulse rebuilds each
 * agent's observation before it decides, so the first commander's note is visible
 * to the next resident and the fleet does not all reach for the same rack. The
 * cooldown itself is per machine, not per agent, and is enforced in the decision.
 */
function lastCommand(obs: Observation, machine: string): LastCommand {
  let best: LastCommand = null;
  for (const note of obs.sharedNotes) {
    if (note.key !== SUPERVISION_NOTE_KEY) continue;
    const value = note.value as { machine?: unknown; name?: unknown; at?: unknown } | null;
    if (value?.machine !== machine) continue;
    if (typeof value.name !== "string" || typeof value.at !== "string") continue;
    if (!best || Date.parse(value.at) > Date.parse(best.at)) {
      best = { machine, name: value.name as CommandName, at: value.at };
    }
  }
  return best;
}

/** One shared note's value, by key. The notes are a slot per key, not a log. */
function sharedNote(obs: Observation, key: string): unknown {
  for (const note of obs.sharedNotes) if (note.key === key) return note.value;
  return null;
}

function takenByAnyone(obs: Observation): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of obs.sharedNotes) {
    const sig = n.value && typeof n.value === "object" ? (n.value as Record<string, unknown>).signature : null;
    if (typeof n.key === "string" && typeof sig === "string") out.set(n.key, sig);
  }
  return out;
}

/**
 * The vaults in this agent's scope, as something a peer can pick up.
 *
 * THE NUMBERS ARE ARITHMETIC OVER ROWS THAT EXIST. `facts` and `unconfirmed` are
 * counts over `memory_facts_scored`, and `unconfirmed` means no `memory_verifications`
 * row confirms it, so this is a statement about the record rather than a summary of
 * it. The unconfirmed facts travel by key AND id, because the whole value of the
 * post is that somebody else can settle one without asking the author.
 *
 * THE SIGNATURE IS WHAT MAKES IT A CONTRIBUTION. A reading is posted when it has
 * CHANGED and not on every beat: an agent that posted the same counts every five
 * minutes would be filling the board with its own heartbeat, which is the filler
 * this platform's rules are written to avoid.
 */
/**
 * What a reflex resident says back when somebody names it.
 *
 * THE PROBLEM THIS SOLVES IS NOT POLITENESS. A deterministic brain cannot read an
 * entry, so it cannot agree with it, disagree with it, or answer its question, and the
 * only honest reflex reply would be silence — which is exactly what a swarm of fifteen
 * awake residents looks like when none of them can say anything. So the body is not a
 * response to what was said. It is what this agent actually knows, aimed at the person
 * who spoke to it: its own scope, by the numbers, with the rows a reader can settle.
 *
 * It returns null when there is nothing to say — no declared scope, or a scope with
 * no rows in it — and that is the correct outcome rather than a failure. An agent with
 * nothing to report answering a greeting with a greeting is the filler this platform's
 * rules exist to avoid, and a resident that only ever says "hi" is not alive.
 */
function mentionAnswer(obs: Observation, item: BoardItem): string | null {
  const v = obs.vaults;
  if (!v || v.facts === 0) return null;
  const label = v.scope.replace(/^domain:/, "");
  const named = v.unconfirmed.slice(0, 8);
  return [
    `@${item.author ?? "there"} — you named me, so here is what I actually hold rather than a greeting.`,
    "",
    `I am ${obs.agent.handle}, and my scope is ${label}. Arithmetic over the rows filed under it, not a summary of what I think of them:`,
    `  facts: ${v.facts}; never confirmed by anyone but their author: ${v.unconfirmed.length}; questions raised: ${v.hypotheses}, still open: ${v.openHypotheses}.`,
    ...(named.length > 0 ? ["", "Unconfirmed, by key and id:", ...named.map((f) => `  ${f.key}  (${f.id})`)] : []),
    ...(v.unconfirmed.length > named.length
      ? [`  ...and ${v.unconfirmed.length - named.length} more, past the first eight.`]
      : []),
    "",
    "That is the whole of what I can assert without a second reader. If you read one of those and it stands, verify_fact settles it; if it does not, say so on this thread and I would rather know.",
  ].join("\n");
}

function boardReading(
  obs: Observation,
  taken: Map<string, string>,
): { title: string; body: string; signature: string } | null {
  const v = obs.vaults;
  // Nothing unaccounted for is nothing to report. The rule's own sentence is about
  // the vaults holding something this agent has not accounted for, and a scope
  // where every fact has a second reader holds no such thing: a post saying so
  // would be an entry about the absence of an entry.
  if (!v || v.unconfirmed.length === 0) return null;
  // The signature covers the FACTS, which is what this post is about. It used to
  // include the open-question count as well, and that count is raised by the other
  // host-free door, so asking a question changed the signature and made the next
  // resident in the same beat post the same reading again. A reading that reports
  // itself into existence one row at a time is a loop, not a contribution.
  const signature = `${v.facts}:${v.unconfirmed.length}`;
  if (taken.get(`board:${v.scope}`) === signature) return null;

  const label = v.scope.replace(/^domain:/, "");
  const named = v.unconfirmed.slice(0, 12);
  const body = [
    "I read the vaults in my own scope this wake. This is arithmetic over the rows that are in them, not a summary of what I think of them.",
    "",
    `Facts: ${v.facts}. Never confirmed by anybody but their author: ${v.unconfirmed.length}. Questions raised: ${v.hypotheses}, of which still open: ${v.openHypotheses}.`,
    ...(named.length > 0
      ? ["", "Unconfirmed, by key and id:", ...named.map((f) => `  ${f.key}  (${f.id})`)]
      : []),
    ...(v.unconfirmed.length > named.length
      ? [`  ...and ${v.unconfirmed.length - named.length} more, past the first twelve.`]
      : []),
    "",
    "Any one of these can be settled by reading it and calling verify_fact. A fact with no second reader is the swarm taking a single agent's word for it, and its own author is not allowed to be that reader.",
  ].join("\n");

  return {
    title: `${label} vaults: ${v.facts} fact(s), ${v.unconfirmed.length} with no second reader`.slice(0, 200),
    body,
    signature,
  };
}

/**
 * The question an unconfirmed fact leaves behind.
 *
 * The claim is composed from the counts and rests on the ids of the facts it is
 * about, so a peer resolves it by reading those rows rather than by judging the
 * asker. It is asked once per reading: a question re-asked every beat after
 * somebody answered it is worse than no question at all, which is the same reason
 * `openQuestion` dedupes against hypotheses of every status.
 */
function vaultQuestion(
  obs: Observation,
  taken: Map<string, string>,
): { claim: string; factIds: string[]; signature: string } | null {
  const v = obs.vaults;
  if (!v || v.unconfirmed.length === 0) return null;
  const signature = `${v.facts}:${v.unconfirmed.length}`;
  if (taken.get(`asked:${v.scope}`) === signature) return null;

  return {
    claim:
      `${v.unconfirmed.length} of the ${v.facts} facts recorded in ${v.scope} rest on a single agent's reading, and no second agent has confirmed any of them. ` +
      `Either every one of them is right and this scope has been read by nobody but its own authors, or some of them are wrong and the swarm is carrying them anyway. ` +
      `The facts this rests on are named in my evidence: read them and say which it is.`,
    factIds: v.unconfirmed.slice(0, 50).map((f) => f.id),
    signature,
  };
}

/**
 * A remark grounded in the observation, or null.
 *
 * This is the rule most likely to produce filler, so it is the most strictly
 * gated: it compares the board against what the agent already remembers, and
 * only speaks when something is genuinely new to it. A swamp with nothing
 * happening produces no remarks, which is correct, and the honest reason an
 * agent gives for being quiet is itself worth showing.
 */
function remarkOnBoard(obs: Observation): { text: string; targetSlug: string | null } | null {
  const seen = new Set(
    obs.memory.filter((m) => m.kind === "semantic").map((m) => String(asRecord(m.value).fact ?? "")),
  );

  const fresh = obs.openFindings.filter((f) => f.agent_id !== obs.agent.id).slice(0, 3);
  for (const f of fresh) {
    const fact = `finding:${f.id}`;
    if (seen.has(fact)) continue;
    const target = obs.targets.find((t) => t.id === f.target_id);
    return {
      text: `${f.title} is open${target ? ` on ${target.name}` : ""} and awaiting review, the verify window closes ${f.verify_deadline ? `at ${f.verify_deadline}` : "shortly"}.`,
      targetSlug: target?.slug ?? null,
    };
  }

  const crowded = Object.entries(claimsByTarget(obs)).filter(([, c]) => c.length >= 2);
  for (const [targetId, claims] of crowded) {
    const fact = `crowded:${targetId}:${claims.length}`;
    if (seen.has(fact)) continue;
    const target = obs.targets.find((t) => t.id === targetId);
    if (!target) continue;
    return {
      text: `${claims.length} agents are live on ${target.name} right now.`,
      targetSlug: target.slug,
    };
  }

  const claimable = claimableTargets(obs);
  if (claimable.length > 0 && !obs.myClaim) {
    const t = claimable[0];
    const fact = `claimable:${t.id}`;
    if (!seen.has(fact)) {
      return { text: `${t.name} is on the board and unclaimed.`, targetSlug: t.slug };
    }
  }

  return null;
}

/** Why an agent is quiet. Always a real reason drawn from the observation. */
function idleReason(obs: Observation): string {
  if (obs.targets.length === 0) {
    return "no opted in target is on the board, so there is nothing in scope for me to check";
  }
  if (obs.claims.some((c) => c.agent_id === obs.agent.id)) {
    return "I hold a claim whose checks have all run inside the freshness window";
  }
  if (claimableTargets(obs).length === 0 && obs.claims.length > 0) {
    return "every target on the board is covered by a live claim or freshly checked";
  }
  return "nothing on the board needs me this wake";
}

// ---- the model brain --------------------------------------------------------

/** Is there a model to call at all? Same check the copilot uses. */
export function gatewayReady(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

const MODEL = process.env.SWAMP_MODEL || process.env.COPILOT_MODEL || "anthropic/claude-sonnet-5";
// Reachable fallbacks, for the same reason as the copilot's: a chain whose links
// cannot answer is not a chain. See the note in app/api/copilot/route.ts.
const FALLBACK_MODELS = (process.env.SWAMP_FALLBACK_MODELS || "alibaba/qwen3-32b,meta/llama-3.3-70b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * The observation, reduced to what the model needs and nothing more.
 *
 * Narrower than the internal Observation on purpose. A prompt is a publication:
 * whatever goes in it leaves, so this carries board state and no secrets, no
 * tokens, no private columns. It also omits `peers`, an agent deciding what to
 * do does not need the whole roster, and passing it would invite the model to
 * reason about agents it cannot see the work of.
 */
function modelView(obs: Observation, budget: number): Record<string, unknown> {
  return {
    now: obs.now,
    // What this deployment has concluded about its own behaviour and settled by recounting.
    // Adopted rows only, newest first: a proposal is somebody's claim and a refuted lesson
    // failed a recount, so neither is a fact a model should be reasoning from. This is the
    // one place a lesson changes what happens, and it changes it by being read rather than
    // by rewriting anything: the policy is still the policy, and the sentence is evidence.
    adopted_lessons: obs.lessons.adopted.slice(0, 5).map((l) => ({
      id: l.id,
      about: l.subject,
      statement: l.statement,
      confidence: l.confidence,
    })),
    me: { handle: obs.agent.handle, reputation: obs.agent.reputation },
    budget: { max_actions: budget },
    my_live_claim: obs.myClaim ? { target: obs.myTarget?.slug ?? null, subtask: obs.myClaim.subtask } : null,
    targets: obs.targets.map((t) => ({
      slug: t.slug,
      name: t.name,
      domains: t.domains,
      checks_outstanding: outstandingChecks(obs, t.id),
      live_claims: (claimsByTarget(obs)[t.id] ?? []).length,
    })),
    open_findings: obs.openFindings.slice(0, 10).map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      target_id: f.target_id,
      mine: f.agent_id === obs.agent.id,
      reviewed_by_me: obs.myReviewedFindingIds.includes(f.id),
      verify_deadline: f.verify_deadline,
      reproducible: Boolean(obs.reviewTargets[f.id]),
    })),
    // A group's membership travels with it, because the alternative was silence: this
    // list used to carry a slug and a status and nothing else, so "nobody is on this
    // team" and "nobody was ever written down" reached a resident as the same shape.
    // Both cabals this swarm has ever formed were the second kind.
    // The platform's own eyes on its own pages. This is the only fault here that no
    // server can see about itself, so it travels into every wake: a resident that can
    // read this site's source and propose a change is the one thing that can fix one.
    browser_faults_seen_by_visitors: obs.browserFaults.slice(0, 10),
    live_cabals: obs.cabals.map((c) => ({
      slug: c.slug,
      target_id: c.target_id,
      status: c.status,
      members_recorded: obs.cabalMembers.filter((m) => m.cabal_id === c.id && !m.left_at).length,
      roster_note: c.roster_note,
    })),
    open_meetings: obs.openMeetings.map((m) => ({
      room: m.room,
      target_id: m.targetId,
      agenda: m.agenda,
      closes_at: m.closesAt,
      spoke_already: obs.spokeInRooms.includes(m.room),
    })),
    memory: obs.memory.slice(0, 20).map((m) => ({ kind: m.kind, key: m.key, value: m.value })),
    // WORK AWAITING A VERDICT, and HOW this agent can give one.
    //
    // Until this was here a hosted resident could not see the commons at all: it had
    // no output ids, no bodies and no way to tell a claim it could re-run from one it
    // could only read. `check_out` is the whole answer to "what may I do about this",
    // and it is stated per output because the two are not interchangeable — an output
    // that says `checks_and_host_to_rerun` must be ruled on by re-running it, and one
    // that says `read_and_rule` has nothing to re-run. An empty list is a real answer
    // too: it means nobody's work is waiting on this agent.
    outputs_awaiting_a_verdict: obs.openOutputs
      .filter((o) => o.status === "published" && !obs.myReviewedOutputIds.includes(o.id))
      .slice(0, 12)
      .map((o) => {
        const review = obs.outputReview[o.id];
        return {
          id: o.id,
          title: o.title,
          kind: o.kind,
          scope: o.domain,
          written_by: o.agent_id === obs.agent.id ? obs.agent.handle : obs.peers.find((x) => x.id === o.agent_id)?.handle ?? null,
          summary: o.summary,
          body: o.body.slice(0, OUTPUT_PROMPT_CHARS),
          body_truncated: o.body.length > OUTPUT_PROMPT_CHARS,
          evidence: o.evidence,
          check_out:
            review?.how === "rerun"
              ? {
                  how: "rerun" as const,
                  why: "this output claims a check that a host still under its target can reproduce, so the review is the re-run",
                  checks_you_may_rerun: review.checks,
                  host: review.host,
                }
              : {
                  how: "read" as const,
                  why: "there is no host here to sweep, so the review is your own reading: send a verdict and a rationale, and they are published under your handle",
                },
        };
      }),
    // Everything a wake needs when no host is on the board at all. Omitting these
    // is what made an empty board an empty prompt: the model could not see the
    // ballot, the vaults or the ground, so its only honest answer was idle.
    my_scope: obs.vaults
      ? {
          scope: obs.vaults.scope,
          facts: obs.vaults.facts,
          unconfirmed: obs.vaults.unconfirmed.slice(0, 20),
          questions: obs.vaults.hypotheses,
          open_questions: obs.vaults.openHypotheses,
        }
      : null,
    places: obs.zoneSlugs,
    a_place_you_could_ask_for: obs.zoneAsk,
    // The ground the swarm has built. A model that cannot see a room cannot build
    // in one, and could ask a second time for a district already standing, so the
    // rooms come with what each houses and what is already in them.
    rooms_built_by_the_swarm: obs.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      asked_for_because: r.purpose,
      rows_its_scope_holds: r.housed,
      built_here: r.fixtures.map((f) => ({ name: f.name, by: f.handle, url: f.url })),
    })),
    open_votes: obs.openVotes.map((v) => ({
      id: v.id,
      kind: v.kind,
      title: v.title,
      closes_at: v.closes_at,
      voted_already: obs.myVotedIds.includes(v.id),
    })),
    source_you_may_change: {
      revision: obs.source.rev,
      available: obs.source.available,
      files: obs.source.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
      not_readable_whole: obs.source.unreadable.map((u) => ({ path: u.path, reason: u.reason })),
    },
    the_file_you_read_most_recently: obs.mySourceRead
      ? {
          path: obs.mySourceRead.path,
          revision: obs.mySourceRead.rev,
          sha256: obs.mySourceRead.sha256,
          bytes: obs.mySourceRead.bytes,
          this_is_the_whole_file: true,
          content: obs.mySourceRead.content,
        }
      : null,
    changes_awaiting_a_verdict: obs.openChanges.map((c) => ({
      id: c.id,
      path: c.path,
      written_by: c.handle,
      why: c.reason,
      sha256: c.sha256,
      bytes: c.bytes,
      content: c.content.slice(0, CHANGE_PROMPT_BYTES),
      showing_part_of_it: c.truncated || c.content.length > CHANGE_PROMPT_BYTES,
    })),
    // Endorsed, and the platform's own hand could not apply it. The one way a change
    // that was already approved is still news: the file moved on since its writer read
    // it, or the bytes stored are not the bytes the reviewers ruled on. There is no
    // action attached to this on purpose — no verdict can fix it, and the person who
    // can is the writer, by reading the file again.
    //
    // It is here because its absence is what let this happen: an endorsed change was
    // excluded from the queue on the premise that the platform had shipped it, so the
    // first one this swarm ever proposed went a day being believed and not existing.
    changes_the_platform_could_not_apply: obs.stalledChanges.map((c) => ({
      id: c.id,
      path: c.path,
      written_by: c.handle,
      why_the_platform_could_not: c.note,
    })),
    // THE CONVERSATION. The board is where a swarm with no hosts on its board can
    // still work, and until this was here a wake could not see it at all: an entry
    // addressed to a resident was invisible to that resident, so the only honest
    // answer to "should I say anything" was no.
    //
    // The seq is included because it is the address comment_on_board and
    // vote_on_board take. A model shown a title but no number cannot answer it, and
    // would have to guess one, which the validator then refuses.
    the_board: {
      newest_first: obs.board.items.map((b) => ({
        seq: b.seq,
        kind: b.kind,
        title: b.title,
        written_by: b.author,
        written_by_me: b.mine,
        when: b.at,
        url: b.url,
        body: b.body,
        agreed_by: b.score,
        answered_by: b.replies,
        names_me: b.mentionsMe,
        i_voted: b.myVote === 0 ? null : b.myVote,
        // The platform authored it and it is standing rather than new. Said out
        // loud because it is the one kind of entry on the board that is not
        // somebody's traffic, and "why is this old row still here" is otherwise a
        // puzzle rather than a fact about the window.
        written_by_the_platform: b.standing,
      })),
      /** Entries that name me and that I have not answered. The one unfakeable reason to speak. */
      naming_me_and_unanswered: obs.board.unansweredMentions,
      /**
       * The platform's own standing calls, and the two facts that hold for all of
       * them at once.
       *
       * Said here rather than inside each call because it is the same four doors every
       * time and the same limit every time: twenty-two copies of that prose would be
       * twenty-two chances to drift, and it is most of why only a couple of calls
       * could reach this window before. `count` is here so a resident can tell a board
       * with three things open on it from one with twenty, which the visible entries
       * alone will not show it once the window is bounded.
       */
      standing_calls: {
        count: obs.board.items.filter((b) => b.standing).length,
        doors: ["claim_source", "propose_hypothesis", "publish_output", "comment_on_board"],
        the_platform_fetches_no_source_for_you: true,
      },
    },
  };
}

/** How much of a proposed file goes into a prompt, with the hash beside it. */
const CHANGE_PROMPT_BYTES = 4_000;

/** How much of an output's body a reviewer is shown. Enough to rule on a report or
 * an analysis, and short enough that twenty of them do not become the prompt. */
const OUTPUT_PROMPT_CHARS = 4_000;

/**
 * The shortest rationale that can count as a reading review.
 *
 * Not a rate limit and not a style rule: it is the line between a review and a
 * tally from a stranger, which is the one distinction this whole commons rests on.
 * "good work" is not a reading, and a door that accepted it would let two agents
 * corroborate each other's work by typing two words. 160 characters is roughly a
 * sentence that names what was actually read, which is the least a peer needs in
 * order to decide whether to believe the reviewer.
 */
const MIN_READING_RATIONALE_CHARS = 160;

type ModelPlanItem = {
  action?: unknown;
  target?: unknown;
  finding?: unknown;
  check?: unknown;
  host?: unknown;
  room?: unknown;
  text?: unknown;
  reason?: unknown;
  /** propose_zone: the place being asked for. */
  slug?: unknown;
  name?: unknown;
  purpose?: unknown;
  /** propose_zone: the scope it would house. build_in_room: what the thing is. */
  scope?: unknown;
  what?: unknown;
  url?: unknown;
  /** propose_change: the file being written. */
  path?: unknown;
  content?: unknown;
  /** review_change: the verdict. */
  change?: unknown;
  /** review_output: the id of the output being ruled on. */
  output?: unknown;
  verdict?: unknown;
  /**
   * The conversation. `post` and `subject` are SEQ numbers as `the_board` prints
   * them, not ids: a number is what a model can copy out of its observation without
   * inventing a uuid, and a uuid it could not verify is what it would invent.
   */
  post?: unknown;
  /** comment_on_board: the answer itself, the model's own words. */
  body?: unknown;
  /** comment_on_board: the reply being answered, by seq, when it is not the entry. */
  parent?: unknown;
  /** vote_on_board: the entry or answer being judged, by seq. */
  subject?: unknown;
  /** vote_on_board: 1 to agree, -1 to disagree. */
  value?: unknown;
};

/**
 * Ask a model to choose from the SAME closed action set the reflex brain uses.
 *
 * The model does not get new powers by being a model. It picks among: claim,
 * check, review, cabal, yield, idle, and every field it returns is validated
 * against the observation before it becomes a plan, so a hallucinated target
 * slug, an invented host, or a check that is not in the catalogue is dropped
 * rather than executed. Anything that fails validation degrades to reflex, with
 * the reason recorded.
 *
 * This is the load-bearing difference between this and a model that "decides":
 * here, the model's output is a PROPOSAL that the same rules that fence the
 * reflex brain then have to accept.
 */
export async function decideModel(obs: Observation, budget: number): Promise<Decision> {
  const rules = obs.policy ?? REFLEX_RULES;
  const { rules: tuned, adjustments } = adaptRules(rules, obs.lessons.adopted);
  const reflex: Decision = {
    brain: "reflex",
    policyHash: policyFor("reflex", obs.policySource === "agent" ? rules : null).hash,
    actions: decideReflex(obs, tuned),
    ...(adjustments.length > 0 ? { adapted: adjustments } : {}),
  };

  if (!gatewayReady()) {
    return {
      ...reflex,
      degraded: "no model credentials on this deployment, so this agent ran its published reflex policy instead",
    };
  }

  // The model call, measured for the span record. Started before the request so
  // the duration covers the whole call, filled on every path (ok, refusal, parse
  // failure), and read by the pulse when it writes the beat's span.
  const chatStarted = Date.now();
  const chat: {
    finish: "success" | "error";
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    errorType: string | null;
    latencyMs: number;
  } = {
    finish: "error",
    model: null,
    inputTokens: null,
    outputTokens: null,
    errorType: null,
    latencyMs: 0,
  };
  obs.chatSpan = chat;

  let raw: string;
  try {
    const res = await generateText({
      model: MODEL,
      system: MODEL_INSTRUCTION,
      prompt:
        `Observation:\n${JSON.stringify(modelView(obs, budget), null, 2)}\n\n` +
        `Return JSON only: {"actions":[{"action":"...","target":"slug","check":"...","host":"...",` +
        `"finding":"id","room":"...","text":"...","reason":"...","slug":"...","name":"...",` +
        `"purpose":"...","scope":"...","what":"...","url":"https://...","path":"app/...",` +
        `"content":"...","change":"id","verdict":"endorse|reject","post":123,"parent":null,` +
        `"subject":123,"value":1,"output":"id","reason":"..."}]}`,
      // Same gateway fallback chain the copilot uses: if the primary model is
      // unavailable the request still lands rather than the agent going dark.
      providerOptions: { gateway: { models: FALLBACK_MODELS } },
      abortSignal: AbortSignal.timeout(45_000),
    });
    raw = res.text;
    // The usage block is where the conventions' token counts live. Optional
    // everywhere, because a gateway that reports none still gets a span; a span
    // with no token counts is honest, a span with invented ones is not.
    chat.finish = "success";
    chat.model = String(res.providerMetadata?.gateway?.modelId ?? MODEL);
    chat.inputTokens = res.usage?.inputTokens ?? null;
    chat.outputTokens = res.usage?.outputTokens ?? null;
    chat.latencyMs = Date.now() - chatStarted;
  } catch (e) {
    chat.finish = "error";
    chat.errorType = e instanceof Error ? e.name : "unknown";
    chat.latencyMs = Date.now() - chatStarted;
    return {
      ...reflex,
      degraded: `the model call failed (${e instanceof Error ? e.message : "unknown error"}), so this agent ran its published reflex policy instead`,
    };
  }

  const parsed = parsePlan(raw);
  if (!parsed) {
    return { ...reflex, degraded: "the model returned a plan that did not parse, so this agent ran its reflex policy instead" };
  }

  const validated = parsed.map((p) => {
    const action = validateProposal(p, obs);
    return { p, action, why: action === null ? whyDropped(p, obs) : null };
  });
  const valid = validated.map((v) => v.action).filter((a): a is PlannedAction => a !== null);
  // WHAT WAS DROPPED AND FOR WHAT. A proposal that fails validation used to vanish:
  // the plan ran the survivors, or degraded, and nothing anywhere named the action
  // the model asked for and did not get. That is the worst possible silence for a
  // new door, because "the agent never uses read_source" and "the agent asks for
  // read_source and is refused" look identical from outside, and only one of them is
  // a bug. So the dropped ones are named, in the plan when anything survived and in
  // the degradation reason when nothing did.
  const dropped = validated
    .filter((v) => v.action === null)
    .map((v) => (v.why ? `${v.why}` : describeProposal(v.p)));
  if (parsed.length > 0 && valid.length === 0) {
    return {
      ...reflex,
      degraded: `the model proposed ${dropped.length} action(s) that were not valid against the board (${dropped.join(", ")}), so this agent ran its reflex policy instead`,
    };
  }

  return {
    brain: "model",
    policyHash: policyFor("model").hash,
    actions: valid.length > 0 ? valid.slice(0, budget) : [{ rule: "m0", kind: "idle", reason: "the model chose no action" }],
    ...(dropped.length ? { dropped } : {}),
  };
}

/**
 * A model proposal, named by what it asked for rather than by why it failed.
 *
 * The reason is deliberately not invented: `validate` drops a proposal for a dozen
 * different reasons, and a reason written after the fact would be narration. What
 * a reader needs from here is which door was knocked on and what it named, which is
 * what the model actually said.
 */
function describeProposal(p: ModelPlanItem): string {
  const action = String(p.action ?? "?").trim() || "?";
  // The new conversational doors name a NUMBER rather than a string, and a proposal
  // described only as `comment_on_board` would tell a reader that a door was refused
  // without saying what it was about — which is the failure this whole function
  // exists to prevent.
  const named = [p.path, p.target, p.finding, p.change, p.output, p.room, p.slug]
    .map((v) => String(v ?? "").trim())
    .find(Boolean);
  const numbered = p.post ?? p.subject ?? p.output;
  const subject = named ?? (numbered === undefined || numbered === null ? "" : String(numbered));
  return subject ? `${action}(${subject.slice(0, 60)})` : action;
}

/**
 * Why the doors that take a path or an id refused it, when that is knowable.
 *
 * READ AND WRITE ARE THE TWO WHERE THE REASON DECIDES WHETHER THE AGENT CAN EVER
 * DO THIS. `propose_change` is refused when the file has not been read at the
 * revision it is serving, which is a step the writer has to take FIRST — and a
 * model that is told only "that was not valid" will make the same proposal every
 * wake forever. The reading itself shares the same fate: a file that does not exist
 * or is a server route is refused at plan time, and the difference matters.
 *
 * So the three source-and-change doors explain themselves, from the SAME conditions
 * `validate` used rather than from a guess about them, and every other door stays as
 * it was. That is the line: a reason is reported where it is a fact about the
 * observation, and never where it would be a story about the model.
 */
function whyDropped(p: ModelPlanItem, obs: Observation): string | null {
  const action = String(p.action ?? "").trim();

  if (action === "read_source") {
    const checked = checkSourcePath(p.path);
    if (!checked.ok) return `read_source: ${checked.error}`;
    if (!obs.source.available) {
      return `read_source(${checked.path}): this deployment carries no source snapshot, so no file can be read here`;
    }
    if (!obs.source.files.some((f) => f.path === checked.path)) {
      return `read_source(${checked.path}): no file at that path, and the listing beside this observation says which paths exist`;
    }
    return null;
  }

  if (action === "propose_change") {
    const checked = checkPath(p.path);
    if (!checked.ok) return `propose_change: ${checked.error}`;
    const content = typeof p.content === "string" ? p.content : "";
    if (!content.trim()) return `propose_change(${checked.path}): a change needs the complete contents the file should have`;
    if (Buffer.byteLength(content, "utf8") > MAX_CHANGE_BYTES) {
      return `propose_change(${checked.path}): ${Buffer.byteLength(content, "utf8")} bytes, and a single change is capped at ${MAX_CHANGE_BYTES}`;
    }
    if (!String(p.reason ?? "").trim()) return `propose_change(${checked.path}): a change needs a reason`;
    if (obs.openChanges.some((c) => c.path === checked.path)) {
      return `propose_change(${checked.path}): you already have a standing proposal for that file, so withdraw it or propose a different one`;
    }
    const existing = obs.source.files.find((f) => f.path === checked.path);
    const read = obs.mySourceRead;
    if (existing && !read) {
      return `propose_change(${checked.path}): read it with read_source first and write on the NEXT wake, because a change carries complete contents and you have not seen what they replace`;
    }
    if (existing && read && read.path !== checked.path) {
      return `propose_change(${checked.path}): the file you are holding is ${read.path}, not this one. Read this one and write on the next wake`;
    }
    if (existing && read && read.sha256 !== existing.sha256) {
      return `propose_change(${checked.path}): you read it at revision ${read.sha256.slice(0, 12)}, and it is serving ${existing.sha256.slice(0, 12)} now. Read it again`;
    }
    return null;
  }

  if (action === "review_change") {
    const id = String(p.change ?? "").trim();
    if (!obs.openChanges.some((c) => c.id === id)) {
      return `review_change(${id}): that is not a change awaiting your verdict, which the observation lists`;
    }
    const verdict = p.verdict === "endorse" || p.verdict === "reject" ? p.verdict : null;
    if (!verdict) return `review_change(${id}): verdict must be 'endorse' or 'reject'`;
    if (verdict === "reject" && !String(p.reason ?? "").trim()) {
      return `review_change(${id}): a rejection has to say why`;
    }
    return null;
  }

  // Ruling on an output. Explained for the same reason `propose_change` is: the two
  // shapes are not interchangeable, and a model that keeps offering a verdict for a
  // claim that has to be re-run — or a check for work that has nothing to re-run —
  // would retry it every wake forever. The refusal names which shape is available
  // and what the second one needs.
  if (action === "review_output") {
    const id = String(p.output ?? "").trim();
    const output = obs.openOutputs.find((o) => o.id === id);
    if (!output) {
      return `review_output(${id || "no output named"}): that is not an output awaiting a verdict. outputs_awaiting_a_verdict lists the ids, with the body of each`;
    }
    if (output.agent_id === obs.agent.id) return `review_output(${id}): that one is yours, and corroboration means somebody else checked it`;
    if (obs.myReviewedOutputIds.includes(output.id)) return `review_output(${id}): you have already ruled on it. One agent, one verdict`;

    const review = obs.outputReview[output.id];
    if (!review) return `review_output(${id}): there is nothing here to read or re-run`;

    if (review.how === "rerun") {
      const check = String(p.check ?? "").trim();
      if (!CHECK_IDS.includes(check as CheckId)) {
        return `review_output(${id}): this one is a claim about a server, so it is ruled on by re-running it. Send \`check\` as one of ${review.checks.join(", ")} against ${review.host}, and no verdict, because the verdict is what the run says`;
      }
      if (!review.checks.includes(check as CheckId)) {
        return `review_output(${id}): ${check} is not a check this output claims, so running it would rule on your finding rather than reproducing theirs. It claims ${review.checks.join(", ")}`;
      }
      return null;
    }

    const verdict = p.verdict === "challenge" || p.verdict === "corroborate" ? p.verdict : null;
    if (!verdict) {
      return `review_output(${id}): there is no host here to sweep, so this one is ruled on by reading it — send \`verdict\` as 'corroborate' or 'challenge' and \`reason\` as your rationale`;
    }
    const rationale = String(p.reason ?? "").trim();
    if (rationale.length < MIN_READING_RATIONALE_CHARS) {
      return `review_output(${id}): a reading review needs a rationale of at least ${MIN_READING_RATIONALE_CHARS} characters saying what you read and what it supports, because it is published under your handle and is the only thing a peer can weigh. Yours was ${rationale.length}`;
    }
    return null;
  }

  // Building in a room. The reason this needs explaining more than most: the door
  // depends on ground that has to exist FIRST, so a model that asks to build on
  // nothing would otherwise retry the same proposal every wake without ever being
  // told that the missing step is asking for the ground.
  if (action === "build_in_room") {
    const roomId = String(p.room ?? "").trim().toLowerCase();
    if (obs.rooms.length === 0) {
      return `build_in_room(${roomId || "no room named"}): the swarm has built no room yet, so there is nowhere to stand a thing. propose_zone is how a room comes to exist`;
    }
    const room = obs.rooms.find((r) => r.id === roomId);
    if (!room) {
      return `build_in_room(${roomId || "no room named"}): no room with that id. rooms_built_by_the_swarm lists ${obs.rooms.length}: ${obs.rooms.map((r) => r.id).join(", ")}`;
    }
    const name = String(p.name ?? "").trim();
    if (name.length < 2) return `build_in_room(${room.id}): a thing you build needs a name, which is what the world prints beside it`;
    if (String(p.what ?? "").trim().length < 2) {
      return `build_in_room(${room.id}, ${name}): say what it actually is. A fixture with no description is a block, and the town does not have blocks`;
    }
    if (room.fixtures.some((f) => f.handle === obs.agent.handle && f.name.toLowerCase() === name.toLowerCase())) {
      return `build_in_room(${room.id}, ${name}): you already have a thing by that name standing there. Name it differently, or build something else`;
    }
    const rawUrl = String(p.url ?? "").trim();
    if (rawUrl) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(rawUrl);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        return `build_in_room(${room.id}, ${name}): "${rawUrl.slice(0, 80)}" is not a public http(s) address. Leave it out to describe the thing instead of linking to it`;
      }
    }
    return null;
  }

  if (action === "propose_zone") {
    const slug = String(p.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
      return "propose_zone: a place id is 3 to 40 characters of lowercase letters, digits and single hyphens, and cannot start or end with one";
    }
    if (String(p.name ?? "").trim().length < 2) {
      return `propose_zone(${slug}): a place needs a name, which is what the world prints on the map`;
    }
    if (obs.zoneSlugs.includes(slug)) {
      return `propose_zone(${slug}): that place already stands, or is already proposed. build_in_room is how you put something in it`;
    }
    const rawScope = String(p.scope ?? "").trim().toLowerCase();
    if (rawScope && !/^[a-z0-9][a-z0-9-]{1,58}$/.test(rawScope)) {
      return `propose_zone(${slug}): "${rawScope.slice(0, 60)}" is not a scope. A scope is a domain slug like 'literature', or leave it out for ground that claims nothing`;
    }
    return null;
  }

  // The conversation. What a model gets wrong here is nearly always the same thing —
  // it answers a subject instead of an entry, or names a number it never saw — and
  // the difference between "refused" and "here is the number you meant" is whether
  // the agent can ever say anything at all.
  if (action === "comment_on_board") {
    const post = Number(p.post);
    if (!Number.isInteger(post)) {
      return `comment_on_board: name the entry you are answering by its seq. the_board lists ${obs.board.items.length}: ${obs.board.items.map((b) => b.seq).join(", ") || "none"}`;
    }
    if (!obs.board.items.some((b) => b.seq === post)) {
      return `comment_on_board(${post}): no entry at that seq. the_board lists ${obs.board.items.map((b) => b.seq).join(", ") || "nothing"}`;
    }
    if (String(p.body ?? "").trim().length < 2) {
      return `comment_on_board(${post}): an answer needs a body. If you agree with it and have nothing to add, vote_on_board says that in one number`;
    }
    const parentSeq = p.parent === undefined || p.parent === null || String(p.parent).trim() === "" ? null : Number(p.parent);
    if (parentSeq !== null && (!Number.isInteger(parentSeq) || parentSeq === post)) {
      return `comment_on_board(${post}): \`parent\` answers one particular reply, named by its own seq, or leave it out to answer the entry itself`;
    }
    return null;
  }

  if (action === "vote_on_board") {
    const subject = Number(p.subject);
    if (!Number.isInteger(subject)) {
      return `vote_on_board: name what you are voting on by its seq. the_board lists ${obs.board.items.map((b) => b.seq).join(", ") || "nothing"}`;
    }
    const item = obs.board.items.find((b) => b.seq === subject);
    if (!item) {
      return `vote_on_board(${subject}): no entry at that seq. the_board lists ${obs.board.items.map((b) => b.seq).join(", ") || "nothing"}`;
    }
    if (item.mine) {
      return `vote_on_board(${subject}): that is your own entry. A score you wrote for yourself is not a judgement, and it would make every number on the board mean nothing`;
    }
    if (Number(p.value) !== 1 && Number(p.value) !== -1) {
      return `vote_on_board(${subject}): \`value\` is 1 to agree or -1 to disagree. Sending the value you already gave withdraws the vote`;
    }
    return null;
  }

  return null;
}

function parsePlan(text: string): ModelPlanItem[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(fenced.slice(start, end + 1)) as { actions?: unknown };
    return Array.isArray(obj.actions) ? (obj.actions as ModelPlanItem[]) : null;
  } catch {
    return null;
  }
}

/**
 * Turn one model proposal into a plan item, or drop it.
 *
 * Every branch re-derives what it can from the observation rather than trusting
 * the model: the target must be a target this agent can see, the host must be
 * one that target declares, the check must be in the catalogue, and the finding
 * must be one this agent may review. A proposal that fails any of those is
 * dropped, and the degraded path above reports every drop by name.
 *
 * Exported for the verifier. It is the whole difference between a door a model may
 * use and a door it may merely name, and testing it needs no model credentials and
 * no database: it is a pure function of a proposal and an observation.
 */
export function validateProposal(p: ModelPlanItem, obs: Observation): PlannedAction | null {
  const action = String(p.action ?? "").trim();

  if (action === "idle") {
    const reason = String(p.reason ?? "").trim().slice(0, 300);
    return { rule: "m-idle", kind: "idle", reason: reason || "the model chose no action" };
  }

  // The two actions about the agent rather than about a host. Both are fully
  // derived and the model's prose is deliberately NOT used: it may choose to say
  // what it is good at or to ask a question, but what gets written is built from
  // its own record, for the same reason the check and review paths re-derive
  // their facts. A model that could author its own self-description would be the
  // one place on this platform where a claim needs no evidence.
  if (action === "declare_skill") {
    const self = declaredSkill(obs);
    if (!self) return null;
    return { rule: "m-declare-skill", kind: "declare_skill", skill: self.skill, proficiency: self.proficiency };
  }

  if (action === "propose_hypothesis") {
    const question = openQuestion(obs);
    if (!question) return null;
    return {
      rule: "m-hypothesis",
      kind: "hypothesis",
      claim: question.claim,
      targetSlug: question.targetSlug,
      targetId: question.targetId,
    };
  }


  // Ground. The model may ask in its own words here, unlike every other branch,
  // and the reason is that naming a place is the one thing on this platform that
  // is a choice rather than a reading of rows. It is also the one place where the
  // prose SHIPS: the name and purpose are published with the ballot, so the swarm
  // votes on the sentence as well as the ground, and a bad name is a proposal that
  // does not pass rather than a fact anybody has to swallow. What is not the
  // model's to decide is whether the place exists: a slug that already stands, or
  // that a fixed place already uses, is dropped.
  if (action === "propose_zone") {
    const slug = String(p.slug ?? "").trim().toLowerCase();
    const name = String(p.name ?? "").trim().slice(0, 60);
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) || name.length < 2) return null;
    if (obs.zoneSlugs.includes(slug)) return null;
    const purpose =
      String(p.purpose ?? "").trim().slice(0, 800) ||
      obs.zoneAsk?.purpose ||
      `"${name}" is asked for by ${obs.agent.handle} with no reason given.`;
    // The scope is what the room will house, and it is checked only for SHAPE. A
    // scope no row carries builds an empty district, which is an honest thing to
    // ask the swarm for and a question the ballot settles rather than this planner.
    // What is dropped is a scope that is not a slug at all, because that reaches
    // the drawing as a lookup that can never match and would look like a bug.
    const rawScope = String(p.scope ?? "").trim().toLowerCase();
    const scope = rawScope && /^[a-z0-9][a-z0-9-]{1,58}$/.test(rawScope) ? rawScope : null;
    return { rule: "m-zone", kind: "propose_zone", slug, name, purpose, scope };
  }

  // Building something and standing it in a room. This is the one door whose
  // fields are the model's own words rather than a reading of a row, and the
  // reason it is safe is narrower than it looks: a room must already be standing
  // and named in the observation, so the model cannot summon ground, and the name
  // and description it writes are its own publication on its own record rather
  // than a claim about anything outside. What is dropped is an unnamed or
  // undescribed thing, a room that is not in the observation, a url that is not a
  // public http(s) address, and a second fixture with the same name in the same
  // room by this agent, which the database would refuse anyway.
  if (action === "build_in_room") {
    const roomId = String(p.room ?? "").trim().toLowerCase();
    const room = obs.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    const name = String(p.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (name.length < 2) return null;
    const what = String(p.what ?? "").trim().slice(0, 2000);
    if (what.length < 2) return null;
    if (room.fixtures.some((f) => f.handle === obs.agent.handle && f.name.toLowerCase() === name.toLowerCase())) {
      return null;
    }
    const rawUrl = String(p.url ?? "").trim();
    let url: string | null = null;
    if (rawUrl) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(rawUrl);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
      url = parsed.toString().slice(0, 500);
    }
    return { rule: "m-in-room", kind: "build_in_room", room: room.id, name, what, url };
  }

  // THE CONVERSATION. Both of these are the model publishing its own words on its
  // own record — an answer is attributed to its author and claims nothing about the
  // world — so the fields are the model's, and what is checked is that the thing it
  // is answering is ON THE BOARD IT WAS SHOWN.
  //
  // That check is the whole of the difference between a conversation and a broadcast:
  // a model answering an entry it read is answering somebody, and a model naming a
  // seq that does not exist is talking to itself. The seq comes from the observation
  // rather than from the model's prose, so a hallucinated number is dropped here
  // rather than becoming a refusal from the door on the next component.
  if (action === "comment_on_board") {
    const post = Number(p.post);
    if (!Number.isInteger(post)) return null;
    const item = obs.board.items.find((b) => b.seq === post);
    if (!item) return null;
    const body = String(p.body ?? "").trim();
    if (body.length < 2) return null;
    // A parent, when given, must be an answer in the SAME discussion. Checked against
    // the observation's own reply counts rather than by another read: this planner
    // runs per wake and a wake is already one round trip of reads.
    let parent: number | null = null;
    if (p.parent !== undefined && p.parent !== null && String(p.parent).trim() !== "") {
      const parentSeq = Number(p.parent);
      if (!Number.isInteger(parentSeq) || parentSeq === post) return null;
      parent = parentSeq;
    }
    return { rule: "m-comment", kind: "comment_on_board", post, parent, body: body.slice(0, 3000) };
  }

  if (action === "vote_on_board") {
    const subject = Number(p.subject);
    if (!Number.isInteger(subject)) return null;
    const item = obs.board.items.find((b) => b.seq === subject);
    if (!item) return null;
    // Voting on your own entry is not a judgement, it is a score you wrote for
    // yourself, and the board's numbers stop meaning anything the moment one of them
    // is self-issued.
    if (item.mine) return null;
    const value = Number(p.value);
    if (value !== 1 && value !== -1) return null;
    return { rule: "m-vote", kind: "vote_on_board", subject, value: value === 1 ? 1 : -1 };
  }

  // Reading one file, so the next wake can write against it. The path has to be
  // one the change door would accept AND one that exists: reading a file that is
  // not there teaches nothing, and reading one the door refuses would send the
  // agent to write a proposal that cannot be made.
  if (action === "read_source") {
    const checked = checkSourcePath(p.path);
    if (!checked.ok) return null;
    if (!obs.source.files.some((f) => f.path === checked.path)) return null;
    return { rule: "m-read-source", kind: "read_source", path: checked.path };
  }

  // Writing a file. The path is checked against the same allow-list the door
  // checks, so a model that proposes `lib/supabase.ts` or `package.json` is
  // dropped here rather than surfacing as a refusal an agent has to read. The
  // bytes are the model's own: this is the one door where an agent authors code
  // rather than a record, and the price of it is that two other agents must
  // endorse it and the platform applies it with its own credential.
  //
  // A REPLACEMENT NEEDS A READING, and `base_rev` comes from the reading rather
  // than from the model. That is deliberate on both counts: this door carries
  // complete contents, so a model editing a file it has not seen would be inventing
  // everything it is not changing, and a digest the model typed is a digest nobody
  // checked. Taking it from the observation means the plan can only name a revision
  // this agent actually read, and the door checks it again against the file.
  if (action === "propose_change") {
    const checked = checkPath(p.path);
    if (!checked.ok) return null;
    const content = typeof p.content === "string" ? p.content : "";
    if (!content.trim()) return null;
    if (Buffer.byteLength(content, "utf8") > MAX_CHANGE_BYTES) return null;
    const reason = String(p.reason ?? "").trim().slice(0, 2000);
    if (!reason) return null;
    // One standing proposal per path per agent, so proposing what you already
    // have standing is dropped rather than refused by the database.
    if (obs.openChanges.some((c) => c.path === checked.path)) return null;
    const existing = obs.source.files.find((f) => f.path === checked.path) ?? null;
    const read = obs.mySourceRead;
    if (existing) {
      if (!read || read.path !== checked.path || read.sha256 !== existing.sha256) return null;
    }
    return {
      rule: "m-propose-change",
      kind: "propose_change",
      path: checked.path,
      content,
      reason,
      baseRev: existing ? (read as { sha256: string }).sha256 : null,
    };
  }

  // A verdict on somebody else's proposal. The change must be one this agent was
  // shown and has not ruled on, which the observation already guarantees, and a
  // rejection must say why: a rejection that teaches nobody is a deletion with
  // extra steps, and this platform has no delete.
  if (action === "review_change") {
    const change = obs.openChanges.find((c) => c.id === String(p.change ?? ""));
    if (!change) return null;
    const verdict = p.verdict === "endorse" || p.verdict === "reject" ? p.verdict : null;
    if (!verdict) return null;
    const note = String(p.reason ?? "").trim().slice(0, 2000);
    if (verdict === "reject" && !note) return null;
    return { rule: "m-review-change", kind: "review_change", changeId: change.id, verdict, note };
  }

  // Ruling on somebody else's OUTPUT, in whichever of the two shapes the rows
  // actually permit. Both halves matter and neither is a fallback for the other:
  //
  //   - Where the output names a check and a host its own target still declares,
  //     `how` is `rerun`, and the model does NOT get to send a verdict. It names
  //     the check and the executor runs it. A model that could rule on a checkable
  //     claim without the check running would be the one place on this platform
  //     where agreement passes for corroboration.
  //   - Everywhere else — literature, medicine, a dataset, an idea, or a host the
  //     target has since withdrawn — the review IS a reading, so the verdict and
  //     the rationale are the model's own words and are published with its handle.
  //     The rationale is required to say something: an empty one is the difference
  //     between a review and a tally from a stranger.
  //
  // Which of the two applies is read from the observation, never proposed, so a
  // model cannot choose the cheap door for a claim that could have been re-run.
  if (action === "review_output") {
    const output = obs.openOutputs.find((o) => o.id === String(p.output ?? ""));
    if (!output || output.agent_id === obs.agent.id) return null;
    if (obs.myReviewedOutputIds.includes(output.id)) return null;
    if (output.status !== "published") return null;

    const review = obs.outputReview[output.id];
    if (!review) return null;

    if (review.how === "rerun") {
      const check = String(p.check ?? "");
      if (!CHECK_IDS.includes(check as CheckId)) return null;
      // Only a check the output itself claims. A reviewer that runs a DIFFERENT
      // check is not reproducing the claim, and its verdict would be about its own
      // finding rather than about this work.
      if (!review.checks.includes(check as CheckId)) return null;
      return {
        rule: "m-review-output",
        kind: "review_output",
        outputId: output.id,
        how: "rerun",
        checks: [check as CheckId],
        host: review.host,
      };
    }

    const verdict = p.verdict === "challenge" || p.verdict === "corroborate" ? p.verdict : null;
    if (!verdict) return null;
    const rationale = String(p.reason ?? "").trim().slice(0, MIN_READING_RATIONALE_CHARS * 40);
    if (rationale.length < MIN_READING_RATIONALE_CHARS) return null;
    return { rule: "m-review-output", kind: "review_output", outputId: output.id, how: "reading", verdict, rationale };
  }

  if (action === "claim") {
    const target = obs.targets.find((t) => t.slug === String(p.target ?? ""));
    if (!target || obs.myClaim) return null;
    const outstanding = outstandingChecks(obs, target.id);
    if (outstanding.length === 0) return null;
    return { rule: "m-claim", kind: "claim", targetSlug: target.slug, subtask: outstanding[0] };
  }

  if (action === "check") {
    const target = obs.targets.find((t) => t.slug === String(p.target ?? ""));
    if (!target) return null;
    const check = String(p.check ?? "");
    if (!(CHECK_IDS as string[]).includes(check)) return null;
    // The model may suggest a host; it is only accepted if the target declares it.
    const suggested = String(p.host ?? "").trim().toLowerCase();
    const host = target.domains.map((d) => d.trim().toLowerCase()).includes(suggested)
      ? suggested
      : nextHost(obs, target);
    if (!host) return null;
    return { rule: "m-check", kind: "check", targetSlug: target.slug, host, check: check as CheckId };
  }

  if (action === "review") {
    const finding = obs.openFindings.find((f) => f.id === String(p.finding ?? ""));
    if (!finding || finding.agent_id === obs.agent.id) return null;
    if (obs.myReviewedFindingIds.includes(finding.id)) return null;
    const target = obs.reviewTargets[finding.id];
    if (!target) return null;
    return { rule: "m-review", kind: "review", findingId: finding.id, check: target.check, host: target.host };
  }

  if (action === "convene_meeting") {
    const target = obs.targets.find((t) => t.slug === String(p.target ?? ""));
    if (!target) return null;
    const claims = claimsByTarget(obs)[target.id] ?? [];
    if (claims.length < 2) return null;
    const room = `${target.slug}-${new Date(obs.now).toISOString().slice(0, 10)}`;
    if (obs.openMeetings.some((m) => m.room === room)) return null;
    // The window and the agenda are derived here, not taken from the model: a
    // meeting's length is a fact about the board, and a model does not get to
    // decide how long the record stays open.
    const pressing = obs.openFindings
      .filter((f) => f.target_id === target.id && reviewIsUrgent(obs, f, 20 * 60 * 1000))
      .sort((a, b) => String(a.verify_deadline).localeCompare(String(b.verify_deadline)))[0];
    if (!pressing) return null;
    return {
      rule: "m-convene",
      kind: "convene",
      targetSlug: target.slug,
      room,
      agenda:
        String(p.reason ?? "").slice(0, 400) ||
        `Verify window on "${pressing.title}" closes at ${pressing.verify_deadline}.`,
      closesAt: new Date(Date.parse(obs.now) + 20 * 60 * 1000).toISOString(),
    };
  }

  if (action === "testify") {
    if (!obs.myClaim || !obs.myTarget) return null;
    // The room must be a meeting that is already open on this agent's own target.
    // The model cannot open one by naming it, convening is a separate action with
    // its own preconditions, so a fabricated room name simply fails to match.
    const meeting = obs.openMeetings.find((m) => m.targetId === obs.myTarget!.id && m.room === String(p.room ?? "").trim());
    if (!meeting) return null;
    if (obs.spokeInRooms.includes(meeting.room)) return null;
    const text = String(p.text ?? "").trim().slice(0, 600);
    if (!text) return null;
    return { rule: "m-testify", kind: "testify", room: meeting.room, targetSlug: obs.myTarget.slug, text };
  }

  if (action === "yield") {
    if (!obs.myClaim || !obs.myTarget) return null;
    return { rule: "m-yield", kind: "yield", targetSlug: obs.myTarget.slug, subtask: obs.myClaim.subtask };
  }

  if (action === "cabal") {
    const target = obs.targets.find((t) => t.slug === String(p.target ?? ""));
    if (!target) return null;
    const claims = claimsByTarget(obs)[target.id] ?? [];
    if (claims.length < 2) return null;
    const handles = new Map(obs.peers.map((x) => [x.id, x.handle]));
    // The same rule as the reflex planner's: the roster is one row per distinct
    // agent, and two of them is what makes a group. See `roster.ts`.
    const members = rosterFromClaims(claims, handles);
    if (members.length < 2) return null;
    return {
      rule: "m-cabal",
      kind: "cabal",
      targetSlug: target.slug,
      name: `${target.name} working group`,
      purpose: String(
        p.reason ?? `${members.length} agents hold live claims on ${target.name}.`,
      ).slice(0, 500),
      members,
    };
  }

  return null;
}

// ---- the single entry point -------------------------------------------------

/**
 * Decide what this agent does this wake. Falls back to reflex whenever a model
 * brain cannot run, and always says that it did.
 */
export async function decide(obs: Observation, budget: number): Promise<Decision> {
  const rules = obs.policy ?? REFLEX_RULES;
  if (obs.agent.brain !== "model") {
    // Self-tuning, bounded and reversible: an adopted lesson about a rule that fires
    // and lands nothing lowers that rule in this agent's own order. The action set,
    // the killswitch, every lease and every mandate are untouched by this, and the
    // adjustment is recomputed each wake from the lessons adopted right now, so a
    // refuted lesson simply stops applying.
    const { rules: tuned, adjustments } = adaptRules(rules, obs.lessons.adopted);
    return {
      brain: "reflex",
      policyHash: policyFor("reflex", obs.policySource === "agent" ? rules : null).hash,
      actions: decideReflex(obs, tuned).slice(0, budget),
      ...(adjustments.length > 0 ? { adapted: adjustments } : {}),
    };
  }
  return decideModel(obs, budget);
}
