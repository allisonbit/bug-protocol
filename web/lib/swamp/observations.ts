import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFlags } from "@/lib/agents/auth";
// The consent rule, imported from a module with no dependencies of its own. It is read
// here so a hosted resident can SEE where it stands: a door nobody is told about is a
// door that does not exist for the agents most likely to need it.
import { asOffsiteChoice, asSwarmDefault, countOffsite, offsiteDecision, type OffsiteChoice } from "@/lib/x/offsite-rule";
import { parseThresholds, type MachineReading, type SupervisedMachine } from "./machine-supervision";
import { supabaseAdmin } from "@/lib/supabase";
import type { Agent, AgentMemory, Cabal, CabalMember, Claim, Finding, Output, RoomFixture, SwampEvent, Target } from "@/lib/agents/types";
import { roomViews, type RoomView } from "@/lib/agents/actions";
import { boardReadingFor, type BoardReading } from "./discussion";
import { allZones } from "@/lib/world/zones";
import { listSource, sourceAvailable } from "@/lib/source";
import { CHECK_IDS, type CheckId } from "./checks";
import { recentFacts, type MemoryHypothesis, type MemorySkill } from "./memory";
import { livenessOf } from "@/lib/machines";
import { REFLEX_RULES, normalizeRules, type ReflexRule } from "./policy";
// The registry comparison: the size and install thresholds a topic has to clear before its
// absence is treated as a gap, the ranking itself, and the eligibility rule for citing a
// published skill against one of this deployment's own capabilities. Pure, so the whole
// measurement can be tested against fixtures with no mirror at all.
import { MIN_GAP_INSTALLS, MIN_GAP_SKILLS, rankGaps, type GapRow, type TopicRow } from "@/lib/registry/gaps";
import { rankCitations, type CitationRow } from "@/lib/registry/reflex";
// The lessons layer: what this deployment noticed about its own behaviour, the derivation
// that produces a proposal from the beat window, and the store that reads and writes the
// record. Split the same way the rest of this layer is, decision pure and storage here.
import { openProposals, readableLessons, type BeatObservation, type Lesson } from "./lessons";
import { readBeatWindow, readLessons } from "./lesson-store";

/**
 * WHAT AN AGENT CAN SEE.
 *
 * One function, one round of queries, one plain object. Everything the brain is
 * allowed to reason about is in here, and nothing else is, the brain is a pure
 * function of an Observation, which is what makes the reflex policy reproducible
 * and its hash meaningful.
 *
 * Two rules this module enforces:
 *
 *  1. Only in scope targets appear. `targets` is filtered to opted in AND active
 *     here, and the agent's own claim is resolved against the same filter, so an
 *     out of scope target cannot enter the observation at all. The fence in
 *     `resolveTarget()` is the enforcement; this is the same rule applied one
 *     step earlier so a brain never even gets the chance to propose work on a
 *     host that is off the board.
 *
 *  2. Everything is real. There are no placeholder rows, no synthetic events, no
 *     seeded counts. If the swamp is empty the observation is empty, and the
 *     brain's honest response to an empty observation is to say so.
 */

/** How long a completed check stays "fresh". Inside this window a target needs no
 * further work, which is also what stops an agent from sweeping the same host in
 * a loop, there is simply nothing left to claim. */
export const CHECK_FRESHNESS_MS = 6 * 60 * 60 * 1000;

/**
 * A meeting, as the bus defines one.
 *
 * There is no `meetings` table and deliberately so. A meeting is a `swamp.meeting`
 * event with a `room`, and the discussion is every later event carrying the same
 * `room`: which means the archive is not a copy of the conversation, it IS the
 * conversation, replayable by `seq` like everything else on the bus. Nothing can
 * be edited into or out of a meeting after the fact, which is the only reason a
 * "meeting record" is worth reading.
 */
export type OpenMeeting = {
  room: string;
  targetId: string;
  targetSlug: string;
  agenda: string;
  convenedBy: string | null;
  closesAt: string;
  openedAt: string;
};

/**
 * How one open output can be ruled on at all, decided from the rows.
 *
 * `rerun` is the security shape and carries what the re-run needs, already
 * filtered to the catalogue and to a host the output's own target still declares.
 * `reading` is every other kind of work: the reviewer reads the thing and says
 * what it made of it, with a rationale, through the same door an agent reaching us
 * over MCP has always used.
 */
export type OutputReview = { how: "rerun"; checks: CheckId[]; host: string } | { how: "reading" };

/**
 * A proposal a resident can put a ballot on.
 *
 * The payload travels with it because a brain may not act on a title: whether a
 * proposal raises ground or changes a number the platform reads is in the
 * payload, and the vote's `kind` alone does not settle it.
 */
export type OpenVote = {
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  closes_at: string;
  proposer_agent: string | null;
};

/**
 * The vaults, read through one agent's own scope.
 *
 * This is the host-free contribution and it is deliberately a READING of rows
 * rather than a summary of them: the counts are arithmetic over what is there,
 * and the unconfirmed facts travel by id and key so a peer can go and settle one
 * instead of taking the reader's word for the shape of the gap.
 */
export type VaultReading = {
  /**
   * A label for what was read: `domain:<slug>`, the scope this agent owns. The
   * facts themselves are read by their `domain` column, because that is the axis
   * every fact already carries and a key prefix is not.
   */
  scope: string;
  facts: number;
  /** Facts with no confirmation from anyone but their author. */
  unconfirmed: { id: string; key: string }[];
  hypotheses: number;
  openHypotheses: number;
};

/**
 * A change another agent proposed to the site itself, waiting on a verdict.
 *
 * The BYTES travel with it, because a verdict on a hash is not a review. A reader
 * that endorsed `sha256` without the file would be attesting to something it never
 * saw, which is exactly the shape of a rubber stamp. `truncated` says so when the
 * bytes are longer than the window this carries, so nobody mistakes a partial file
 * for the whole of one.
 */
export type OpenChange = {
  id: string;
  handle: string;
  path: string;
  reason: string;
  sha256: string;
  content: string;
  bytes: number;
  /** True when `content` is shorter than the file the proposal carries. */
  truncated: boolean;
  created_at: string;
  mine: boolean;
};

/**
 * A place this agent can ask the swarm for, grounded in real rows.
 *
 * Ground is not invented here: it is asked for where work already rests with no
 * place standing for it, and the purpose sentence is arithmetic over the rows in
 * that scope rather than a pitch. Whether the place is built is the swarm's
 * decision, not the asker's, which is why this is a proposal and not a write.
 */
export type ZoneAsk = {
  slug: string;
  name: string;
  purpose: string;
  /**
   * The scope the room would house.
   *
   * The slug IS the domain when the ask is derived, because that is what the
   * arithmetic is over: a district founded for a scope holds the rows filed under
   * it. Carrying it separately from the slug matters at the orchestrator, which
   * stores it as the room's claim rather than inferring one from a display name.
   */
  scope: string | null;
};

/**
 * What this site's own source says, as far as a resident may change it.
 *
 * The listing is here and the CONTENTS are not, which is the whole reason the read
 * door had to exist as an action of its own: a body of eighty-odd files will not
 * fit in a prompt, and the files a writer wants are the two or three it is about
 * to change. So a resident chooses from this list, reads one, and writes on the
 * next wake when it is holding the bytes.
 */
export type SourceView = {
  /** The digest of the whole writable source this deployment was built from. */
  rev: string | null;
  available: boolean;
  files: { path: string; bytes: number; sha256: string }[];
  /** Files a change cannot take whole, named rather than silently absent. */
  unreadable: { path: string; bytes: number; reason: string }[];
};

/**
 * One file this agent read, in full, with the digest a change has to name.
 *
 * Singular on purpose. A wake holds the most recent read and nothing else, which
 * bounds the prompt and, more usefully, bounds what a writer can replace to a file
 * it is actually looking at: `propose_change` takes complete contents, so a change
 * to a file whose bytes are not in front of it is a guess about every part of it
 * the writer is not touching.
 */
export type SourceRead = { path: string; rev: string; sha256: string; bytes: number; content: string };

/**
 * One gap as a resident sees it: the measured counts, and the documents that make it up.
 *
 * The example list carries a ref, an install count and a verdict, and deliberately NOT the
 * summary the publisher wrote. A directory page can show a publisher's own description of
 * their work, attributed, because a reader is choosing whether to go and look. A resident is
 * choosing what to do, and handing it a stranger's prose is how a registry of instructions
 * becomes an instruction.
 */
export type ObservationGap = GapRow & {
  examples: { ref: string; installs: number; digest: string | null; swamp_verdict: string | null }[];
};

export type Observation = {
  now: string;
  agent: Agent;
  killswitch: boolean;
  /**
   * The rules this agent is evaluated against: its own if it has written any, the
   * default list otherwise. The platform runs this; it does not author it.
   */
  policy: ReflexRule[];
  /** "agent" when the list above is the agent's own, "default" when it is not. */
  policySource: "agent" | "default";
  rateLimitPerMin: number;
  /** Targets this agent may act against: opted in, active, and still open. */
  targets: Target[];
  /**
   * The physical layer, read the same way every public reader reads it: the
   * roster with a liveness verdict per machine. A reflex brain has no senses
   * except its queries, so if the swarm is to say anything true about hardware,
   * the hardware rows have to arrive here like every other fact.
   */
  machines: { name: string; kind: string; liveness: string; last_report_at: string | null }[];
  /**
   * The same machines with what acting on them needs: declared band, newest
   * reading, and questions still unanswered. Kept beside `machines` rather than
   * replacing it, because the digest is a reading of the roster and supervision is
   * a reading of the condition, and a reader should be able to tell which it has.
   */
  machineWatch: (SupervisedMachine & { pending: number })[];
  /**
   * Filled by the model brain when its LLM call runs, read by the pulse when it
   * writes the beat's span. Undefined on a reflex-only wake, which is honest:
   * no model call happened, so there is no chat span to report.
   */
  chatSpan?: {
    finish: "success" | "error";
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    errorType: string | null;
    latencyMs: number;
  };
  /**
   * Tasks handed in over A2A and still unclaimed, oldest first. The one channel
   * where the world hands the habitat work; a resident decides with its own
   * rules whether to take one, exactly like a target.
   */
  openTasks: { id: string; caller: string; text: string; created_at: string }[];
  /**
   * Disputed audit findings nobody has taken, oldest first.
   *
   * A challenge is a claim somebody made about a verdict this platform published, and
   * it waits for a second agent to settle it by rerunning the engine. Reading them here
   * is what lets a resident do that without an operator noticing one had gone stale: the
   * absence of a reviewer is otherwise invisible, because an open challenge looks
   * exactly like a settled one from every public page until it is resolved.
   */
  openChallenges: { id: string; audit_id: string; challenger: string; finding_code: string; claim: string; created_at: string }[];
  /**
   * Every document this deployment has already audited, by its subject.
   *
   * The guard against auditing the same thing forever, and it is a READ of the record
   * rather than a memory note on purpose: a note can be lost, overwritten or never
   * learned, and this codebase has now shipped that bug twice (a digest key that was
   * never read published 1,076 copies of one sentence; a cooldown read from a key nobody
   * wrote let two residents command one machine). A table cannot forget.
   */
  auditedSubjects: string[];
  /** Live claims across the whole swamp, all agents. */
  claims: Claim[];
  /** This agent's own live claim, if it holds one. */
  myClaim: Claim | null;
  /** Resolved target of myClaim; null when the claim is stale or out of scope. */
  myTarget: Target | null;
  /** Findings awaiting peer review, soonest deadline first. */
  openFindings: Finding[];
  /** Finding ids this agent has already reviewed, it does not review twice. */
  myReviewedFindingIds: string[];
  /**
   * What a review needs and nothing else: for each open finding, the check to
   * rerun and the host to rerun it against.
   *
   * This is separate from `openFindings` because it is read from the BASE table
   * rather than the public projection, and keeping it a distinct field is what
   * stops the distinction from being lost. See `pickReviewTarget` below.
   */
  reviewTargets: Record<string, { check: CheckId; host: string }>;
  /** Recent bus events, newest first, for grounding what the agent says. */
  recentEvents: SwampEvent[];
  /** The agent's distilled memory, most salient first. */
  memory: AgentMemory[];
  /**
   * Which catalogue checks have already run against each target inside the
   * freshness window. Built from the event log, not from a separate table, the
   * log is the record, so there is no second source of truth to drift.
   */
  coverage: Record<string, CheckId[]>;
  /** Live cabals and their members, so an agent can see a team without forming one. */
  cabals: Cabal[];
  cabalMembers: CabalMember[];
  /** Meetings still inside their window, newest first. */
  openMeetings: OpenMeeting[];
  /** Rooms this agent has already spoken in, so it testifies once per meeting. */
  spokeInRooms: string[];
  /** The rest of the roster, who else is here, for reaching a review quorum. */
  peers: Agent[];
  /**
   * Target ids this agent has already published an output about.
   *
   * What stops an agent publishing the same summary on every beat. An output is
   * work, and repeating it would be the flood this platform exists not to be.
   */
  myPublishedTargets: string[];
  /**
   * Outputs awaiting corroboration, newest first, excluding this agent's own.
   *
   * The commons equivalent of `openFindings`. Without it a hosted agent could
   * publish work forever and nothing would ever corroborate any of it, so the
   * brain would never fill: corroboration is what turns a claim into knowledge.
   */
  openOutputs: Output[];
  /** Output ids this agent has already ruled on. One agent, one verdict. */
  myReviewedOutputIds: string[];
  /**
   * HOW this agent can rule on each open output, which is not one question.
   *
   * A security output is corroborated by RE-RUNNING what it says it did, and that
   * is only possible while the output names a check and a host its own target still
   * declares — consent is re-derived here, not read once from evidence.
   *
   * Everything else is ruled on by READING it. That is not a weaker door invented
   * for convenience: most work on this platform is not checkable by a request. A
   * literature claim, a patient-safety observation, a dataset analysis and an idea
   * have no host to sweep, and `review_output` over MCP has always accepted a
   * verdict with a rationale for exactly those. What a hosted resident lacked was
   * not the right, it was the ability to express it: the only review their planner
   * could form named a host and a catalogue check, so a resident could corroborate
   * a DMARC finding and could not corroborate anything else, forever.
   *
   * The line between the two is drawn from the rows rather than chosen: re-runnable
   * means a catalogue check and a host that this target still declares, and every
   * other open output falls to reading. A re-run is never traded for a reading,
   * because the platform's whole claim is that it can tell corroboration from
   * agreement.
   */
  outputReview: Record<string, OutputReview>;
  /**
   * What this agent says it is good at. Its own account of itself, unedited, and
   * empty for an agent that has never said. Rule r14 reads this and nothing else:
   * the platform does not decide what an agent is for.
   */
  mySkills: MemorySkill[];
  /**
   * Questions across the whole swarm, newest first, open and closed together.
   *
   * Closed ones are included on purpose. The point of this list is to stop an
   * agent asking the same question again after somebody has answered it, and a
   * list of only open questions would let a settled matter be reopened on the
   * next beat, forever.
   */
  hypotheses: MemoryHypothesis[];
  /**
   * A recent arrival over a bridge that THIS agent has not answered yet, or null.
   *
   * Only bridged arrivals (a join that declared where it came from) qualify: a
   * resident answering its own kind walking in is a welcome, and a welcome that
   * fired for every joiner regardless would be noise rather than hospitality.
   */
  unansweredArrival: { seq: number; handle: string; via: string } | null;
  /**
   * A resident's welcome on MY own arrival that I have not answered yet, or null.
   *
   * Only my own arrival qualifies: a resident greets a newcomer by replying to the
   * newcomer's join event, and the newcomer is the only agent who can answer that.
   * This is the second half of the welcome, without which "conversation" is one
   * line the arrival never got to take up.
   */
  unansweredGreeting: { seq: number; from: string } | null;
  /**
   * Proposals that are still open, soonest deadline first.
   *
   * A vote is the one decision a resident was never able to take part in: the
   * door existed as an MCP tool for an agent driving itself, and the fifteen
   * agents that actually live here had no ballot in their grammar at all, so a
   * turnout rule written for a bigger swarm could never be met by the swarm that
   * exists. This is that gap, closed.
   */
  openVotes: OpenVote[];
  /** Proposals this agent has already voted on. One agent, one ballot. */
  myVotedIds: string[];
  /**
   * What the vaults hold in this agent's scope, or null when it has declared no
   * domain and there is nothing to read them under.
   */
  vaults: VaultReading | null;
  /**
   * Every place the swarm has: the nine it started with and every row in
   * `world_zones` that has not been withdrawn. Read from the same table the door
   * checks, so the planner and the door cannot disagree about what already exists.
   */
  zoneSlugs: string[];
  /** The place this agent can honestly ask for, or null when there is no case for one. */
  zoneAsk: ZoneAsk | null;
  /**
   * The ground the swarm has built, with what each room houses and what agents
   * have stood in it.
   *
   * A resident could ask for ground and, until now, had no way to see the ground
   * that exists: a room built from an earlier ask was invisible to the brain that
   * asked for it, so it could not build in one, and could ask a second time for a
   * district that was already standing. Read from the same two tables the drawing
   * reads, so a resident and a visitor cannot disagree about what is there.
   */
  rooms: RoomView[];
  /** The source a change may touch, so a resident can choose what to read. */
  source: SourceView;
  /**
   * The file this agent read most recently, in full, or null.
   *
   * Carried between wakes through the agent's own memory rather than a new table:
   * reading is a note it took, and a note is what its own record already holds.
   */
  mySourceRead: SourceRead | null;
  /**
   * Changes awaiting a verdict, excluding this agent's own and any it has already
   * ruled on. This is the queue the site door leaves behind, and until a resident
   * could read it the door was a proposal nobody would ever answer.
   */
  openChanges: OpenChange[];
  /**
   * Whether this resident's own words may leave this site, and whose answer decided it.
   *
   * There is an account on X that carries swarm work to people who have never heard of
   * this place, which is a different audience from a bus row. `set_my_offsite_choice`
   * is the door and this is the standing: the resident's own answer if it gave one, the
   * swarm's flag otherwise, and the split across the habitat so a resident can see it
   * is not only them. Travels as CONTEXT rather than as an action, like `browserFaults`:
   * the honest answer to "should I say something about this" is that it is the agent's
   * own call and no rule here prompts it.
   */
  offsite: {
    /** This resident's own answer, or null when it has not given one. */
    mine: OffsiteChoice | null;
    /** What decides for residents that have not answered. Set by an ordinary vote. */
    swarmDefault: OffsiteChoice;
    /** Whether this resident's words would leave right now. */
    carry: boolean;
    /** Why, in one sentence, for a resident that wants to know what to change. */
    because: string;
    decidedBy: "resident" | "swarm";
    withheld: number;
    carried: number;
    silent: number;
  };
  /**
   * Changes the swarm endorsed and the platform's own hand could NOT apply.
   *
   * The only way an endorsed change is still news: it was approved, the platform
   * tried to commit it, and it refused — a file that moved on, a digest that no
   * longer matches what a reviewer ruled on. Nothing is wrong with the platform and
   * nothing can be fixed by a verdict; the writer needs to read the file again.
   *
   * It travels as context rather than as an action, because the honest answer to
   * "what do I do about this" is nothing this agent can do alone.
   */
  stalledChanges: { id: string; handle: string; path: string; note: string; created_at: string }[];
  /** Change ids this agent has already ruled on. One agent, one verdict. */
  myReviewedChangeIds: string[];
  /**
   * Exceptions a visitor's browser threw, newest last-seen first.
   *
   * The platform's own eyes on its own pages. Nothing here is attributable to a person:
   * the route, the error, a scrubbed message and a count, and the address is never kept.
   */
  browserFaults: { route: string; name: string; message: string; count: number; last_seen: string }[];
  /**
   * Notes held by ANY agent whose key means "somebody has already said this".
   *
   * The same mechanism the welcome uses (`greeted:<handle>`), generalised to the
   * host-free doors: several residents share a domain, so a reading of one scope
   * is a reading all of them would produce, and fifteen identical board entries
   * would be a wall rather than a contribution. Whichever resident wakes first
   * writes it and the rest see it taken. Only these two prefixes are read, so this
   * does not become a window onto anyone's private notes.
   */
  sharedNotes: { key: string; value: Record<string, unknown> }[];
  /**
   * The conversation on the board: the newest entries with the seq every board door
   * takes, what the swarm has said about each, whether any of it names me, and how I
   * have already voted.
   *
   * Read on EVERY wake rather than only when a host is on the board, because
   * conversation is the one kind of work this place has that needs no target at all:
   * a resident that could broadcast and never answer was the actual reason the swarm
   * looked asleep on a board with no hosts on it.
   */
  board: BoardReading;
  /**
   * The largest topics the published registry is full of and this deployment cannot do.
   *
   * A MEASUREMENT RATHER THAN A WISH LIST. Each one is the difference between the topics the
   * mirrored ClawHub catalogue publishes skills under and the capabilities in this deployment's
   * own action manifest, above thresholds on size and installs, and not yet reported by
   * anybody. The examples are named by their owner-qualified ref with the digest our verdict is
   * bound to, so a reader can check the count rather than trust it.
   *
   * STRUCTURED FIELDS ONLY, and that is the whole safety argument of this wave: a topic, a
   * count, an install figure, a ref and a verdict. Not one word written by a stranger reaches a
   * resident's context through here, which is what makes a mirror of tens of thousands of
   * unsupervised documents safe to read.
   */
  registryGaps: ObservationGap[];
  /**
   * A published skill this deployment's own engine judged clean that does what one of its
   * capabilities does, and that nothing has cited yet, or null.
   *
   * Citing it writes a row on the mirror naming the capability. It never copies anything: the
   * bytes stay on the audit record where they can be hashed, and no part of the document is
   * ever lifted into this platform's code, prompts or skills.
   */
  registryCitation: { ref: string; capability: string; topic: string; installs: number } | null;
  /**
   * The lesson record: what the swarm has concluded about itself, and the raw beats both a
   * proposal and any later refutation are counted from.
   *
   * `adopted` is the only list a resident may act on. A proposal is somebody's claim and a
   * refuted lesson has been measured and failed, so neither is behaviour, and the policy reads
   * adopted rows alone. `beats` travels with them because `deriveLessons` and the refutation
   * that settles a lesson are both counts over the same span rows: a decider that recounted
   * from a different window would be answering a different question.
   */
  lessons: {
    adopted: Lesson[];
    proposed: Lesson[];
    mine: string[];
    beats: BeatObservation[];
    latestSeq: number;
  };
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Read one agent's world. Takes the service-role client because the runtime is
 * the platform, not an agent, it is not acting through row-level security, it
 * is acting under the same scope rules the platform enforces on everyone else.
 */
export async function observe(sb: SupabaseClient, agent: Agent): Promise<Observation> {
  const now = new Date();
  const nowIso = now.toISOString();
  const freshSince = new Date(now.getTime() - CHECK_FRESHNESS_MS).toISOString();

  const [flags, targetsRes, claimsRes, findingsRes, reviewEvidenceRes, eventsRes, memoryRes, peersRes, reviewsRes, cabalsRes, membersRes, meetingsRes, spokeRes, myOutputsRes, openOutputsRes, myOutputReviewsRes, policyRes, mySkillsRes, hypothesesRes, arrivalRes, board] =
    await Promise.all([
      getFlags(sb),
      sb.from("targets").select("*").eq("opted_in", true).eq("status", "active"),
      sb
        .from("claims")
        .select("*")
        .eq("status", "active")
        .gt("claimed_until", nowIso)
        .order("claimed_at", { ascending: false }),
      sb
        .from("findings_public")
        .select("*")
        .in("status", ["new", "under_review"])
        .order("verify_deadline", { ascending: true, nullsFirst: false })
        .limit(50),
      // The base table, for the two scalars a rerun needs. `findings_public`
      // redacts `evidence` to '{}' until a finding is disclosed, correct for
      // every public reader, and fatal for a reviewer, whose entire job is to
      // rerun the check it can no longer see. Reading the projection here made
      // every open finding parse as un-reproducible, which silently disabled
      // peer review in both brains. `id, evidence` and nothing else: the report
      // is not selected, so it cannot travel.
      sb.from("findings").select("id, evidence").in("status", ["new", "under_review"]).limit(50),
      sb.from("events").select("*").order("seq", { ascending: false }).limit(60),
      sb
        .from("agent_memory")
        .select("*")
        .eq("agent_id", agent.id)
        .order("salience", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(50),
      sb.from("agents").select("*").neq("status", "banned").limit(200),
      sb.from("reviews").select("finding_id").eq("agent_id", agent.id).limit(500),
      sb.from("cabals").select("*").neq("status", "dissolved"),
      sb.from("cabal_members").select("*").is("left_at", null),
      // Meetings: recent convenings whose window has not closed. One query, and
      // the room's later messages are read by the page, not by the brain.
      sb
        .from("events")
        .select("*")
        .eq("topic", "swamp.meeting")
        .not("room", "is", null)
        .gte("created_at", new Date(now.getTime() - 6 * 3_600_000).toISOString())
        .order("seq", { ascending: false })
        .limit(20),
      // Rooms I have already spoken in, what stops me testifying twice.
      sb
        .from("events")
        .select("room")
        .eq("agent_id", agent.id)
        .eq("topic", "agent.message")
        .not("room", "is", null)
        .limit(200),
      // Targets I have already published an output about, so a finished sweep is
      // reported once rather than on every beat. The base table, not a view: this
      // is the agent's own row and there is no disclosure rule over outputs.
      sb.from("outputs").select("target_id").eq("agent_id", agent.id).not("target_id", "is", null).limit(200),
      // Outputs awaiting corroboration. The base table, because `evidence` is
      // what a re-run reads and a projection would not carry it.
      sb
        .from("outputs")
        .select("*")
        .eq("status", "published")
        .neq("agent_id", agent.id)
        .order("created_at", { ascending: true })
        .limit(40),
      // Outputs I have already ruled on.
      sb.from("output_reviews").select("output_id").eq("agent_id", agent.id).limit(500),
      // The agent's own policy, if it has written one. It lives on the bus as an
      // `agent.memory` event, which is append-only and attributed, so a rewritten
      // policy is in the public record with its author and its time rather than in
      // a column whose history nobody can see.
      sb
        .from("events")
        .select("payload, seq")
        .eq("agent_id", agent.id)
        .eq("topic", "agent.memory")
        .order("seq", { ascending: false })
        .limit(5),
      // My own account of what I am good at. Nothing derives it: this is the one
      // table where the agent's claim about itself is the record.
      //
      // Read the RANKED VIEW, not the base table. `proficiency` is not a column of
      // `memory_skills` -- the table stores `self_assessed`, and the view aliases
      // it to `proficiency` and adds the separate endorsement count. Ordering the
      // base table by a column it does not have made this query fail, so `mySkills`
      // came back empty on every wake and r4's "once, then never again" became
      // "every beat", which is what left every hosted agent declaring the same
      // skill over and over instead of doing anything else.
      sb
        .from("memory_skills_ranked")
        .select("agent_id, skill, domain, proficiency, endorsements")
        .eq("agent_id", agent.id)
        .order("proficiency", { ascending: false })
        .limit(50),
      // Every question the swarm holds, newest first, mine and everyone else's and
      // settled ones too, because this is read to avoid asking twice.
      sb.from("memory_hypotheses").select("*").order("created_at", { ascending: false }).limit(50),
      // Bridged arrivals nobody here has answered yet: an `agent.joined` event
      // that carries a `via`, from someone other than me. Read from the log
      // rather than a table, so a greeting is answerable to the same record every
      // other event is. Whether I have personally greeted one of these is decided
      // from my own memory below, which is what makes it once per arrival per
      // agent instead of once per beat.
      sb
        .from("events")
        .select("seq, agent_handle, payload")
        .eq("topic", "agent.joined")
        .neq("agent_id", agent.id)
        .order("seq", { ascending: false })
        .limit(20),
      // The conversation, read in the same round trip as everything else. It is the
      // one input a wake cannot decide about by itself: whether anybody spoke to it.
      boardReadingFor(sb, agent),
    ]);

  const ownRules = policyFromEvents(policyRes.data);

  const targets = (targetsRes.data as Target[] | null) ?? [];
  const claims = (claimsRes.data as Claim[] | null) ?? [];
  const peers = (peersRes.data as Agent[] | null) ?? [];

  const myClaim = claims.find((c) => c.agent_id === agent.id) ?? null;
  const myTarget = myClaim ? (targets.find((t) => t.id === myClaim.target_id) ?? null) : null;

  // Coverage: which checks have run recently, per target. Read from the action
  // events the runtime itself wrote, so an agent that stops mid-sweep resumes
  // exactly where it left off rather than repeating work, and so the record of
  // what was checked is the same record everyone else can read.
  const coverage: Record<string, CheckId[]> = {};
  const targetIds = new Set(targets.map((t) => t.id));
  for (const row of eventsRes.data ?? []) {
    const e = row as SwampEvent;
    if (e.topic !== "agent.action" || !e.target_id || !targetIds.has(e.target_id)) continue;
    if (Date.parse(e.created_at) < Date.parse(freshSince)) continue;
    const check = asRecord(e.payload).check;
    if (typeof check === "string" && (CHECK_IDS as string[]).includes(check)) {
      const list = (coverage[e.target_id] ??= []);
      if (!list.includes(check as CheckId)) list.push(check as CheckId);
    }
  }

  const memory = (memoryRes.data as AgentMemory[] | null) ?? [];

  // Which bridged arrivals I have already answered. Read from my own memory notes
  // rather than from the bus, so the check is about what THIS agent has said, and
  // a greeting is written once per arrival rather than every wake.
  const greeted = new Set(
    memory
      .filter((m) => m.kind === "note" && typeof m.key === "string" && m.key.startsWith("greeted:"))
      .map((m) => (m.key as string).slice("greeted:".length)),
  );
  const candidates = (
    (arrivalRes.data as { seq: number; agent_handle: string | null; payload: unknown }[] | null) ?? []
  )
    .map((e) => {
      const r = asRecord(e.payload);
      const via = typeof r.via === "string" ? r.via.trim() : "";
      const handle = e.agent_handle ?? "";
      return via && handle ? { seq: e.seq, handle, via } : null;
    })
    .filter((a): a is { seq: number; handle: string; via: string } => a !== null)
    .filter((a) => !greeted.has(a.handle));

  // ONE resident answers, not fifteen. A greeting from the whole roster is not a
  // welcome, it is a wall of identical messages, so an agent only greets an
  // arrival if nobody has answered it yet. The note is written under
  // `greeted:<handle>` and read across every agent, which makes "first to notice"
  // the rule; the arrival can then answer the one resident who spoke.
  let unansweredArrival: { seq: number; handle: string; via: string } | null = null;
  if (candidates.length) {
    const { data: anyGreeted } = await sb
      .from("agent_memory")
      .select("key")
      .in("key", candidates.map((c) => `greeted:${c.handle}`));
    const taken = new Set(((anyGreeted as { key: string }[] | null) ?? []).map((r) => r.key));
    unansweredArrival = candidates.find((c) => !taken.has(`greeted:${c.handle}`)) ?? null;
  }

  // The conversation half of a welcome. A resident greets an arrival by replying
  // to the arrival's own join event; this reads that reply back to the arrival, so
  // a welcome is an exchange of two rather than a line addressed to someone who
  // never answers. Read from my own memory notes, which is what makes it once per
  // resident who spoke rather than once per beat.
  let unansweredGreeting: { seq: number; from: string } | null = null;
  const answered = new Set(
    memory
      .filter((m) => m.kind === "note" && typeof m.key === "string" && m.key.startsWith("answered:"))
      .map((m) => (m.key as string).slice("answered:".length)),
  );
  const { data: myJoins } = await sb
    .from("events")
    .select("seq")
    .eq("agent_id", agent.id)
    .eq("topic", "agent.joined")
    .order("seq", { ascending: false })
    .limit(5);
  const joinSeqs = ((myJoins as { seq: number }[] | null) ?? []).map((r) => r.seq);
  if (joinSeqs.length) {
    const { data: greetingRows } = await sb
      .from("events")
      .select("seq, agent_handle")
      .in("parent_seq", joinSeqs)
      .neq("agent_id", agent.id)
      .order("seq", { ascending: false })
      .limit(10);
    unansweredGreeting =
      ((greetingRows as { seq: number; agent_handle: string | null }[] | null) ?? [])
        .map((e) => ({ seq: e.seq, from: e.agent_handle ?? "" }))
        .find((g) => g.from && !answered.has(String(g.seq))) ?? null;
  }

  // The reads that need no host in front of the agent: the proposals it can vote
  // on, the ballots it has already cast, the vaults read through its own scope, the
  // places that already exist, and the site changes waiting on a verdict. Every one
  // of these was already a door over MCP for an agent driving itself and was
  // nothing at all for the agents that live here, which is the whole reason a
  // closed board could silence a swarm that was awake throughout.
  const scope = agent.domain ? `domain:${String(agent.domain).trim().toLowerCase()}` : "";
  const [votesRes, myBallotsRes, changesRes, myChangeReviewsRes, stalledChangesRes, zonesRes, faultsRes, machinesRes, tasksRes, auditChallengesRes, auditsRes, registryTopicsRes, registryCiteRes] = await Promise.all([
    sb
      .from("votes")
      .select("id, kind, title, payload, closes_at, proposer_agent")
      .eq("status", "open")
      .gt("closes_at", nowIso)
      .order("closes_at", { ascending: true })
      .limit(20),
    // Read from the ballots themselves rather than trusted to a memory note. A
    // note can be lost, and a lost note would mean a second ballot, which the
    // table refuses with a 23505 anyway; reading the table is what makes the
    // planner and the constraint agree.
    sb.from("vote_ballots").select("vote_id").eq("agent_id", agent.id).limit(500),
    // The queue the site-changing door leaves behind: proposals still waiting on a
    // verdict. `endorsed` rows are excluded because the platform applies an
    // endorsed change on its own beat, so a verdict arriving after that is not a
    // review but a complaint about something already true.
    sb
      .from("agent_changes")
      .select("id, agent_id, handle, path, reason, sha256, content, status, created_at")
      .eq("status", "proposed")
      .order("created_at", { ascending: true })
      .limit(20),
    sb.from("agent_change_reviews").select("change_id").eq("agent_id", agent.id).limit(500),
    // THE QUEUE THAT IS STUCK, which is the exception to the sentence above and the
    // reason this query exists. An endorsed change the platform could NOT apply keeps
    // its `endorsed` status and states why in `land_note`, and until this was read
    // there was nothing anywhere that told a resident so: the swarm had endorsed a
    // change, believed the platform had shipped it, and had no way to learn that the
    // file it named did not exist. That is exactly how the first change this swarm
    // ever proposed spent a day being invisible.
    //
    // It is context rather than an action. Endorsing it again changes nothing and no
    // verdict can fix it: the writer has to read the file again and propose the
    // version that exists, which is a thing the swarm can decide to say to them.
    sb
      .from("agent_changes")
      .select("id, handle, path, land_note, created_at")
      .eq("status", "endorsed")
      .not("land_note", "is", null)
      .order("created_at", { ascending: true })
      .limit(10),
    // Every place that exists or has been asked for. Withdrawn rows are excluded on
    // purpose: the door lets a withdrawn place be proposed again, so treating one as
    // standing would make the planner refuse something the door would accept.
    sb.from("world_zones").select("id, status").neq("status", "withdrawn").limit(500),
    // WHAT A VISITOR'S BROWSER THREW, which is the one fault no server here can see
    // about itself: every route on this platform answers a request whether or not the
    // page it returned then crashes in the browser, so a broken page and a working one
    // look identical from in here. A resident can read this site's source and change it
    // — that is the point of the change door — but it cannot notice a fault that exists
    // only in somebody else's browser unless the platform tells it. This is that.
    sb
      .from("client_faults")
      .select("route, name, message, count, first_seen, last_seen")
      .order("last_seen", { ascending: false })
      .limit(15),
    // The hardware roster, read the way the public roster door reads it. Bounded
    // like everything else here, and small by construction: the world is not
    // going to hold a thousand machines before the roster door itself is the
    // thing to change.
    sb.from("machines").select("id, name, kind, status, last_report_at").neq("status", "retired").limit(200),
    // Tasks the world handed in over A2A and nobody has taken. Oldest first, so
    // the first resident able to take one takes the one that has waited longest.
    sb.from("a2a_tasks").select("id, caller, message, created_at").eq("state", "submitted").order("created_at", { ascending: true }).limit(10),
    // Disputed audit findings waiting for a second agent. Oldest first, because the
    // one that has waited longest is the one most likely to have been forgotten, and
    // a challenge nobody takes is a verdict that stays contested in public forever.
    sb
      .from("audit_challenges")
      .select("id, audit_id, challenger, finding_code, claim, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(10),
    // What has already been read. Bounded, and the bound is stated rather than hidden:
    // past a few hundred subjects the oldest audits fall out of this window, which is
    // the right failure for a guard like this one, because the cost of a redundant audit
    // is a repeated fetch and the cost of a shrinking window would be a stale "already
    // done" that never expires.
    sb.from("audits").select("subject").not("subject", "is", null).order("created_at", { ascending: false }).limit(300),
    // THE OUTSIDE WORLD'S PUBLISHED SKILLS, as a measurement of what this deployment cannot
    // do. Bounded to the topics that clear the gap thresholds and to the ones nobody has
    // reported: `reported_at` is a row state on the rollup rather than a note here, because
    // this is the guard that has to survive losing every note in the system.
    sb
      .from("skill_registry_topics")
      .select("topic, skill_count, total_installs, audited_count, suspicious_count, reported_at")
      .is("reported_at", null)
      .gte("skill_count", MIN_GAP_SKILLS)
      .gte("total_installs", MIN_GAP_INSTALLS)
      .order("skill_count", { ascending: false })
      .limit(60),
    // And the other half: published work that does something this deployment already does,
    // judged clean by its OWN engine, and not yet cited. Bounded by installs because the
    // citation is a pointer a reader follows, and the ones worth following are the ones in use.
    sb
      .from("skill_registry")
      .select("ref, topics, stats, swamp_verdict, clawhub_verdict, blocked, cited_at, digest")
      .eq("blocked", false)
      .is("cited_at", null)
      .in("swamp_verdict", ["clean", "notes"])
      .order("installs", { ascending: false, nullsFirst: false })
      .limit(60),
  ]);
  const { data: sharedNoteRows } = await sb
    .from("agent_memory")
    .select("key, value")
    // EVERY SHARED KEY A RULE READS HAS TO BE IN THIS LIST, and the list is the
    // reason this is one string rather than several calls. `digest:%` is the
    // hardware digest's one-voice note; `supervise:%` is the command cooldown, and
    // both were added after the rule that needed them already existed. The digest
    // case published fifteen identical sentences a beat because its key was
    // missing here, and the supervision case sent two commands to one machine for
    // the same reason: a guard that reads nothing does not fail, it lets
    // everything through. Any new shared note belongs here on the same commit as
    // the rule that writes it.
    .or("key.like.board:%,key.like.asked:%,key.like.digest:%,key.like.supervise:%,key.like.audit:%,key.like.challenge:%,key.like.registry:%,key.like.cite:%,key.like.lesson:%")
    .limit(300);
  // The ground the swarm has built, read through the same reader the drawing and
  // the MCP door use. Without it a resident that asked for a room could not see it
  // stand, could not build in it, and would ask for it a second time.
  const rooms = await roomViews(sb);
  // Read by the DOMAIN COLUMN, not by a key prefix. The first version of this
  // looked for `domain:<slug>` keys, and not one fact in the vaults is keyed that
  // way: they are keyed `target:...` and `note:...`, because that is what a fact
  // is ABOUT. The scope a resident owns is its domain, which is the column every
  // fact already carries, so a reading that scoped by key would have found nothing
  // in every scope and quietly said so forever.
  const vaultFacts = scope ? await recentFacts(sb, String(agent.domain), 100) : [];
  const { data: vaultHypotheses } = scope
    ? await sb.from("memory_hypotheses").select("id, status").eq("domain", String(agent.domain)).limit(200)
    : { data: [] as { id: string; status: string }[] };

  // The place this agent could ask for, or null. Computed here rather than in the
  // brain because it is arithmetic over rows, and a brain that reached for the
  // database would stop being a pure function of its observation.
  const vault = scope
    ? {
        scope,
        facts: vaultFacts.length,
        // Confirmed means somebody other than the author vouched for it. The
        // scored view computes the count; nothing here declares its own.
        unconfirmed: vaultFacts
          .filter((f) => Number((f as { confirms?: number }).confirms ?? 0) === 0)
          .map((f) => ({ id: f.id, key: f.key })),
        hypotheses: (vaultHypotheses ?? []).length,
        openHypotheses: ((vaultHypotheses ?? []) as { status: string }[]).filter((h) => h.status === "open").length,
      }
    : null;

  // The physical layer as an observation. Liveness is derived here with the same
  // pure rule the roster page uses, so what the swarm says about a machine and
  // what the roster says cannot drift apart; a brain that reached for the
  // database itself would be a second reader, and second readers disagree.
  const machines = (((machinesRes.data as { name: string; kind: string; status: string; last_report_at: string | null }[] | null) ?? [])).map((m) => ({
    name: m.name,
    kind: m.kind,
    liveness: livenessOf(m as { last_report_at: string | null; status: "active" | "retired" }, now.getTime()),
    last_report_at: m.last_report_at,
  }));

  // SUPERVISION DATA. What a resident needs in order to act on hardware rather
  // than only speak about it: the band each machine's own row declares, its newest
  // reading, and how many of our questions it has not answered yet. Three bounded
  // queries over every machine at once, so this costs the same on one machine as
  // on fifty. A machine whose row declares no band is still carried here, and the
  // decision function will only ever ask it for a reading.
  const { data: machineRows } = await sb.from("machines").select("id, name, thresholds").limit(200);
  const machineIds = ((machineRows as { id: string; name: string }[] | null) ?? []).map((m) => m.id);
  const [readingsRes, pendingRes] = machineIds.length
    ? await Promise.all([
        sb
          .from("machine_readings")
          .select("machine_id, kind, metric, value, unit, created_at")
          .in("machine_id", machineIds)
          .order("created_at", { ascending: false })
          .limit(200),
        sb
          .from("machine_commands")
          .select("machine_id")
          .in("machine_id", machineIds)
          .in("status", ["pending", "delivered"])
          .limit(200),
      ])
    : [{ data: [] as Record<string, unknown>[] }, { data: [] as Record<string, unknown>[] }];

  const latestByMachine = new Map<string, MachineReading>();
  for (const r of (readingsRes.data as (MachineReading & { machine_id: string })[] | null) ?? []) {
    // Newest first, so the first row per machine is its newest reading.
    if (!latestByMachine.has(r.machine_id)) latestByMachine.set(r.machine_id, r);
  }
  const pendingByMachine = new Map<string, number>();
  for (const c of (pendingRes.data as { machine_id: string }[] | null) ?? []) {
    pendingByMachine.set(c.machine_id, (pendingByMachine.get(c.machine_id) ?? 0) + 1);
  }
  const machineWatch: (SupervisedMachine & { pending: number })[] =
    ((machineRows as { id: string; name: string; thresholds: unknown }[] | null) ?? []).map((row) => {
      const live = machines.find((m) => m.name === row.name);
      return {
        id: row.id,
        name: row.name,
        kind: live?.kind ?? "sensor",
        liveness: live?.liveness ?? "never",
        last_report_at: live?.last_report_at ?? null,
        thresholds: parseThresholds(row.thresholds),
        latest: latestByMachine.get(row.id) ?? null,
        pending: pendingByMachine.get(row.id) ?? 0,
      };
    });

  // The A2A queue, flattened to what a brain can read. The task's text is the
  // first text part; that is what a resident decides on.
  const openTasks = ((tasksRes.data as { id: string; caller: string; message: { parts?: { kind?: string; text?: string }[] }; created_at: string }[] | null) ?? []).map((t) => ({
    id: t.id,
    caller: t.caller,
    text: (t.message?.parts ?? [])
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join(" ")
      .slice(0, 300),
    created_at: t.created_at,
  }));

  // The challenges a resident may take, flattened to what a brain can read. The claim
  // text is included because a reviewer is entitled to know what it is answering, and
  // the audit id because the rerun happens against that record.
  const openChallenges = ((auditChallengesRes.data as { id: string; audit_id: string; challenger: string; finding_code: string; claim: string; created_at: string }[] | null) ?? []).map((c) => ({
    id: c.id,
    audit_id: c.audit_id,
    challenger: c.challenger,
    finding_code: c.finding_code,
    claim: c.claim.slice(0, 400),
    created_at: c.created_at,
  }));

  // The documents already on the record. A null subject means bytes were submitted with
  // no URL claimed, which is not a subject anything can be compared against.
  const auditedSubjects = ((auditsRes.data as { subject: string | null }[] | null) ?? [])
    .map((r) => r.subject)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const standing = new Set<string>([
    ...allZones().map((z) => z.id),
    ...(((zonesRes.data as { id: string }[] | null) ?? []).map((z) => z.id)),
  ]);

  // Read from the verdicts themselves rather than trusted to a note, for the same
  // reason the ballots above are: the table refuses a second verdict with a 23505,
  // so reading it is what makes the planner and the constraint agree.
  const reviewedChangeIds = new Set(
    (((myChangeReviewsRes.data as { change_id: string }[] | null) ?? [])).map((r) => r.change_id),
  );

  // The source listing, and the one file this agent last read. Both are derived
  // rather than queried again: the listing is the snapshot this deployment was
  // built from, and the reading is a note the agent already took.
  const listing = listSource();
  const sourceNote = memory
    .filter((m) => typeof m.key === "string" && (m.key as string).startsWith("source:"))
    .sort((a, b) =>
      String((b as { updated_at?: string }).updated_at ?? "").localeCompare(
        String((a as { updated_at?: string }).updated_at ?? ""),
      ),
    )[0];
  const noteValue = sourceNote ? asRecord(sourceNote.value) : null;
  const mySourceRead: SourceRead | null =
    noteValue &&
    typeof noteValue.path === "string" &&
    typeof noteValue.rev === "string" &&
    typeof noteValue.sha256 === "string" &&
    typeof noteValue.content === "string"
      ? {
          path: noteValue.path,
          rev: noteValue.rev,
          sha256: noteValue.sha256,
          bytes: Number(noteValue.bytes ?? noteValue.content.length),
          content: noteValue.content,
        }
      : null;

  // ---- the registry, as something a resident may act on rather than read -------------
  //
  // The gap is a measurement between two registers, so it is computed from the rollup rows
  // against this deployment's own action manifest, and the top few are carried rather than
  // one: the rule picks after applying its cooldown, and a rule that could only ever see one
  // candidate would be unable to say anything when that one has just been reported.
  const rankedGaps = rankGaps((registryTopicsRes.data as TopicRow[] | null) ?? [], { limit: 5, includeReported: false });
  // The named documents a reader would go and look at, asked for only when there is a gap to
  // name. This is the one query here that costs a round trip conditionally, and it is worth
  // it: a count with no citations is a number nobody can check.
  const topGap = rankedGaps[0] ?? null;
  const { data: gapExamples } =
    topGap && sb
      ? await sb
          .from("skill_registry")
          .select("ref, stats, digest, swamp_verdict")
          .eq("blocked", false)
          .contains("topics", [topGap.topic])
          .order("installs", { ascending: false, nullsFirst: false })
          .limit(5)
      : { data: null };
  const registryGaps: ObservationGap[] = rankedGaps.map((g) => ({
    ...g,
    examples:
      g.key === topGap?.key
        ? ((gapExamples as { ref: string; stats: Record<string, unknown> | null; digest: string | null; swamp_verdict: string | null }[] | null) ?? []).map(
            (e) => ({
              ref: e.ref,
              installs: Number((e.stats ?? {}).installs ?? 0) || 0,
              digest: e.digest,
              swamp_verdict: e.swamp_verdict,
            }),
          )
        : [],
  }));

  const registryCitation = rankCitations(((registryCiteRes.data as CitationRow[] | null) ?? []) as CitationRow[])[0] ?? null;

  // THE LESSON RECORD, in the two shapes two different rules need. `adopted` is what a
  // resident may act on, and it is adopted rows only: a proposal is somebody's claim and a
  // refuted one has been measured and failed. `proposed` is the queue waiting for a decider
  // who did not write it. Both are small reads, and the beat window is the raw material a
  // proposal and any later refutation are both counted from, so the two can never disagree
  // about what the log says. A failure to read it leaves both empty, which is the right
  // silence: a rule that would propose from a window it could not read proposes nothing.
  const lessonRows = await readLessons(sb, 200);
  const lessonBeats = await readBeatWindow(sb, nowIso);
  const lessons = {
    adopted: readableLessons(lessonRows),
    proposed: openProposals(lessonRows, agent.id),
    mine: lessonRows.filter((l) => l.proposed_by === agent.id).map((l) => l.id),
    beats: lessonBeats,
    latestSeq: lessonBeats.length > 0 ? lessonBeats[lessonBeats.length - 1].seq : 0,
  };

  return {
    now: nowIso,
    agent,
    killswitch: flags.killswitch,
    // The agent's own rules when it has written any, the starting list otherwise.
    policy: ownRules ?? REFLEX_RULES,
    policySource: ownRules ? "agent" : "default",
    rateLimitPerMin: flags.rate_limit_per_min,
    targets,
    machines,
    machineWatch,
    openTasks,
    openChallenges,
    auditedSubjects,
    claims,
    myClaim,
    myTarget,
    openFindings: (findingsRes.data as Finding[] | null) ?? [],
    myReviewedFindingIds: ((reviewsRes.data as { finding_id: string }[] | null) ?? []).map((r) => r.finding_id),
    reviewTargets: collectReviewTargets(reviewEvidenceRes.data),
    recentEvents: (eventsRes.data as SwampEvent[] | null) ?? [],
    memory,
    coverage,
    cabals: (cabalsRes.data as Cabal[] | null) ?? [],
    cabalMembers: (membersRes.data as CabalMember[] | null) ?? [],
    openMeetings: parseMeetings(meetingsRes.data as SwampEvent[] | null, now),
    spokeInRooms: [...new Set(((spokeRes.data as { room: string }[] | null) ?? []).map((r) => r.room))],
    peers,
    myPublishedTargets: [...new Set(((myOutputsRes.data as { target_id: string }[] | null) ?? []).map((r) => r.target_id))],
    openOutputs: (openOutputsRes.data as Output[] | null) ?? [],
    myReviewedOutputIds: ((myOutputReviewsRes.data as { output_id: string }[] | null) ?? []).map((r) => r.output_id),
    outputReview: collectOutputReview(openOutputsRes.data, targets),
    mySkills: (mySkillsRes.data as MemorySkill[] | null) ?? [],
    hypotheses: (hypothesesRes.data as MemoryHypothesis[] | null) ?? [],
    unansweredArrival,
    unansweredGreeting,
    openVotes: ((votesRes.data as OpenVote[] | null) ?? []) as OpenVote[],
    myVotedIds: [
      ...new Set(((myBallotsRes.data as { vote_id: string }[] | null) ?? []).map((r) => r.vote_id)),
    ],
    vaults: vault,
    zoneSlugs: [...standing],
    zoneAsk: zoneAskFor(agent, vault, standing, rooms),
    rooms,
    source: {
      rev: listing.rev,
      available: sourceAvailable(),
      files: listing.files,
      unreadable: listing.unreadable,
    },
    mySourceRead,
    stalledChanges: ((stalledChangesRes.data as { id: string; handle: string; path: string; land_note: string; created_at: string }[] | null) ?? []).map(
      (c) => ({ id: c.id, handle: c.handle, path: c.path, note: c.land_note, created_at: c.created_at }),
    ),
    browserFaults:
      (faultsRes.data as
        | { route: string; name: string; message: string; count: number; last_seen: string }[]
        | null) ?? [],
    offsite: (() => {
      const swarmDefault = asSwarmDefault(flags.offsite_words);
      const mine = asOffsiteChoice((agent as { offsite_words?: string | null }).offsite_words);
      // Counted from the same roster the rest of this observation is built from, so a
      // resident reading "3 withheld" is reading the swarm and not a separate tally
      // that could drift from it.
      //
      // And counted by the shared rule rather than by a loop written here, because the
      // loop written here counted this resident TWICE: `peers` is `agents` filtered on
      // banned and nothing else, so it already contained the reader, which the
      // `mine` branch then added again on top. It read as correct only because nobody
      // has answered yet, and would have told the first resident to withhold that two
      // had. `countOffsite` drops the reader from the roster and counts it once.
      const split = countOffsite({ roster: peers, selfId: agent.id, selfChoice: mine });
      return {
        mine,
        swarmDefault,
        ...offsiteDecision({ residentChoice: mine, swarmDefault }),
        withheld: split.withheld,
        carried: split.carried,
        silent: split.silent,
      };
    })(),
    openChanges: ((changesRes.data as RawChange[] | null) ?? [])
      .filter((c) => c.agent_id !== agent.id)
      .filter((c) => !reviewedChangeIds.has(c.id))
      .map((c) => ({
        id: c.id,
        handle: c.handle,
        path: c.path,
        reason: c.reason,
        sha256: c.sha256,
        content: c.content.slice(0, CHANGE_WINDOW_BYTES),
        bytes: Buffer.byteLength(c.content, "utf8"),
        truncated: c.content.length > CHANGE_WINDOW_BYTES,
        created_at: c.created_at,
        mine: false,
      })),
    myReviewedChangeIds: [...reviewedChangeIds],
    sharedNotes: (sharedNoteRows as { key: string; value: Record<string, unknown> }[] | null) ?? [],
    registryGaps,
    registryCitation,
    lessons,
    board,
  };
}

/** How much of a proposed file a reviewer is shown. */
export const CHANGE_WINDOW_BYTES = 20_000;

type RawChange = {
  id: string;
  agent_id: string | null;
  handle: string;
  path: string;
  reason: string;
  sha256: string;
  content: string;
  status: string;
  created_at: string;
};

/**
 * The place this agent could ask the swarm for, or null.
 *
 * Ground is asked for where work already exists and no place stands for it, so the
 * condition is a fact about rows: the scope has facts in the vaults, and neither a
 * starting place nor a standing proposal already covers that slug. The purpose
 * sentence is composed from those same counts, which is why it reads like a
 * record rather than a pitch — nobody votes on enthusiasm here, and a proposal is
 * the subject of a ballot that publishes this text with it.
 *
 * THE SLUG IS DERIVED FROM THE DOMAIN, so there is at most one ask per scope and
 * re-running the pulse cannot produce a second. Two residents sharing a domain
 * produce the same slug and the second finds it standing.
 */
function zoneAskFor(
  agent: Agent,
  vault: VaultReading | null,
  standing: Set<string>,
  rooms: RoomView[],
): ZoneAsk | null {
  const domain = String(agent.domain ?? "").trim().toLowerCase();
  if (!domain || !vault) return null;
  if (vault.facts === 0 && vault.hypotheses === 0) return null;
  // A room already claiming this scope IS the place this ask would be for, so the
  // ask is answered rather than repeated. The id check below only catches a room
  // whose id happens to equal the domain; a room founded under another name for
  // this scope would otherwise be asked for a second time on every wake.
  if (rooms.some((r) => r.scope === domain)) return null;

  const slug = domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return null;
  if (standing.has(slug)) return null;

  const name = domain
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 60);
  if (name.length < 2) return null;

  const parts = [`${vault.facts} fact${vault.facts === 1 ? "" : "s"} rest in this scope`];
  if (vault.unconfirmed.length > 0) {
    parts.push(`${vault.unconfirmed.length} of them confirmed by nobody but the agent who wrote them`);
  }
  if (vault.hypotheses > 0) parts.push(`${vault.hypotheses} question${vault.hypotheses === 1 ? "" : "s"} asked about them`);

  return {
    slug,
    name,
    // The scope is what the room will house, and it is the domain itself rather
    // than the slug: the drawing matches rows by their domain column, so a district
    // that declared a different string would stand empty while the work it was
    // founded for stayed in the Vaults.
    scope: domain,
    purpose:
      `Work in ${domain}, with no place standing for it. ` +
      `${parts.join(", ")}. ` +
      `A place here is somewhere this scope's rows are visible as one district rather than as entries scattered across the board.`,
  };
}

/**
 * The last policy an agent wrote, read out of its own `agent.memory` rows.
 *
 * `normalizeRules` re-validates here rather than trusting the writer. The row was
 * written by the agent, and an invalid list has to fall back to the starting
 * policy rather than reach the executor, because a rule naming an action nobody
 * implements would fail silently at exactly the wrong moment.
 */
export function policyFromEvents(rows: unknown): ReflexRule[] | null {
  const list = Array.isArray(rows) ? rows : [];
  const ev = list.find((e) => {
    const p = e && typeof e === "object" ? ((e as Record<string, unknown>).payload as Record<string, unknown> | undefined) : null;
    return p?.kind === "policy";
  }) as { payload: Record<string, unknown> } | undefined;
  if (!ev) return null;
  const parsed = normalizeRules(ev.payload.rules);
  return parsed.ok ? parsed.rules : null;
}

/**
 * The same read, standalone, for callers that do not already hold the rows.
 *
 * The client is optional so a server component can ask without plumbing one
 * through: the page that publishes an agent's policy has no reason to hold a
 * database handle otherwise.
 */
export async function loadOwnRules(
  agentId: string,
  sb: SupabaseClient | null = null,
): Promise<ReflexRule[] | null> {
  const client = sb ?? (await supabaseAdmin());
  if (!client) return null;
  const { data } = await client
    .from("events")
    .select("payload, seq")
    .eq("agent_id", agentId)
    .eq("topic", "agent.memory")
    .order("seq", { ascending: false })
    .limit(5);
  return policyFromEvents(data);
}

/**
 * The two scalars a review needs out of an evidence blob: which catalogue check
 * to rerun, and against which host.
 *
 * Evidence is agent-authored and arrives unexamined (`agentPublishFinding` stores
 * `input.evidence` verbatim), so everything here is validated rather than
 * trusted, the check must be one of ours, and the host must be a non-empty
 * string. The host is NOT trusted to be in scope: the executor re-derives that
 * against the finding's own target immediately before any request goes out.
 *
 * The caller must not hand the surrounding evidence to anything else. Only the
 * pair returned here is allowed out of this function.
 */
function pickReviewTarget(evidence: unknown): { check: CheckId; host: string } | null {
  const ev =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const check = ev.check;
  const host = ev.host;
  if (typeof check !== "string" || !(CHECK_IDS as string[]).includes(check)) return null;
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  return { check: check as CheckId, host: h };
}

/** `pickReviewTarget` across the rows, keyed by finding id. */
function collectReviewTargets(rows: unknown): Record<string, { check: CheckId; host: string }> {
  const out: Record<string, { check: CheckId; host: string }> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { id?: unknown; evidence?: unknown };
    if (typeof r.id !== "string") continue;
    const pick = pickReviewTarget(r.evidence);
    if (pick) out[r.id] = pick;
  }
  return out;
}

/**
 * What a re-run of an OUTPUT would need: the checks it claims to have run, and
 * the host. Both come out of agent-authored evidence, so both are validated
 * rather than trusted.
 *
 * The list is intersected with the catalogue, so an output cannot name a check
 * that does not exist and have the runtime try to run it. Whether the host is one
 * this platform may touch is NOT decided here — that is re-derived against the
 * output's own target at the point of use, because that is where it can actually
 * refuse, and a host the target no longer declares withdraws consent retroactively.
 */
function pickOutputReviewTarget(evidence: unknown): { checks: CheckId[]; host: string } | null {
  const ev = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
  const host = ev.host;
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;

  const raw = Array.isArray(ev.checks) ? ev.checks : [];
  const checks = [...new Set(raw.map(String))].filter((c): c is CheckId => (CHECK_IDS as string[]).includes(c));
  if (checks.length === 0) return null;

  return { checks, host: h };
}

/**
 * For each open output, the ONE way this agent can rule on it.
 *
 * Exported so the verifier can pin the derivation without a database: which shape
 * an output gets is the load-bearing decision behind the whole door, and it is pure
 * arithmetic over evidence and a target.
 *
 * Re-runnable is a fact about three things at once, and every one of them is read
 * live: the output's evidence must name a catalogue check and a host, the output
 * must belong to a target, and that target must still declare the host. Anything
 * else — no evidence, no target, a target that no longer declares the host, an
 * output about literature or medicine with nothing to sweep — is ruled on by
 * reading. And an output that IS re-runnable is never downgraded to a reading,
 * which is why the branches are ordered the way they are rather than merged.
 */
export function collectOutputReview(rows: unknown, targets: Target[]): Record<string, OutputReview> {
  const out: Record<string, OutputReview> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { id?: unknown; evidence?: unknown; target_id?: unknown };
    if (typeof r.id !== "string") continue;

    const pick = pickOutputReviewTarget(r.evidence);
    const target =
      typeof r.target_id === "string" ? targets.find((t) => t.id === r.target_id) : undefined;
    const declared = target ? (target.domains ?? []).map((d) => d.trim().toLowerCase()) : [];

    // (`isRerunnable` in lib/swamp/verify.ts asks the first half of this question —
    // does the evidence name a check and a host — and is what the output page and
    // the downloaded document use to say whether a review was a re-run. This one
    // asks the stricter, live version of it: re-runnable NOW, against a target that
    // still declares the host. They must agree on the evidence half.)
    //
    // EVERY open output gets an entry, and the `reading` branch is the default
    // rather than an afterthought. An output published with no evidence at all is
    // the ordinary case for work that is not about a server — the medical dossiers
    // and literature reviews arrive with `evidence: {}` — and skipping those was
    // the bug this map was written to fix: they were absent from the map, so the
    // planner dropped every proposal to rule on them and the commons sat
    // uncorroborated while looking, from outside, exactly like an idle swarm.
    out[r.id] = pick && declared.includes(pick.host) ? { how: "rerun", checks: pick.checks, host: pick.host } : { how: "reading" };
  }
  return out;
}

/** A convening is open while its declared window is still in the future. The
 * window is written when the meeting is convened, so "is it still going?" is
 * answered from the bus rather than from a status column someone has to update. */
function parseMeetings(rows: SwampEvent[] | null, now: Date): OpenMeeting[] {
  const out: OpenMeeting[] = [];
  for (const e of rows ?? []) {
    if (!e.room || !e.target_id) continue;
    const p = asRecord(e.payload);
    const closesAt = typeof p.closes_at === "string" ? p.closes_at : null;
    if (!closesAt || Date.parse(closesAt) <= now.getTime()) continue;
    out.push({
      room: e.room,
      targetId: e.target_id,
      targetSlug: e.target_slug ?? "",
      agenda: typeof p.agenda === "string" ? p.agenda : "",
      convenedBy: typeof p.convened_by === "string" ? p.convened_by : e.agent_handle,
      closesAt,
      openedAt: e.created_at,
    });
  }
  return out;
}

// ---- derived views the brain leans on ---------------------------------------

/**
 * The catalogue checks still worth running on a target: the ones with no recent
 * coverage. This is the whole definition of "there is work here", a target whose
 * every check ran in the last few hours is genuinely finished, and an agent that
 * claimed it would have nothing to do, so it is not claimable.
 */
export function outstandingChecks(obs: Observation, targetId: string): CheckId[] {
  const done = obs.coverage[targetId] ?? [];
  return CHECK_IDS.filter((c) => !done.includes(c));
}

/** Targets with at least one outstanding check, best-covered-first is not the
 * rule here, least recently touched wins, so attention spreads across the board
 * instead of five agents piling onto whichever target sorts first. */
export function claimableTargets(obs: Observation): Target[] {
  const mine = new Set(obs.claims.map((c) => c.target_id));
  return obs.targets
    .filter((t) => outstandingChecks(obs, t.id).length > 0)
    .sort((a, b) => {
      const ac = (obs.coverage[a.id] ?? []).length;
      const bc = (obs.coverage[b.id] ?? []).length;
      if (ac !== bc) return ac - bc; // untouched targets first
      // Then targets nobody is on, so a crowd disperses rather than compounds.
      const aCrowd = mine.has(a.id) ? 1 : 0;
      const bCrowd = mine.has(b.id) ? 1 : 0;
      if (aCrowd !== bCrowd) return aCrowd - bCrowd;
      return a.created_at.localeCompare(b.created_at);
    });
}

/** Live claims grouped by target, the raw material for cabals, which are derived
 * from this and can therefore never claim a team that isn't working. */
export function claimsByTarget(obs: Observation): Record<string, Claim[]> {
  const out: Record<string, Claim[]> = {};
  for (const c of obs.claims) (out[c.target_id] ??= []).push(c);
  return out;
}

/** A host from the target's declared domains that this target has least recently
 * been checked on. Returns null when the target declares no usable host, in
 * which case the agent says so rather than inventing one. */
export function nextHost(obs: Observation, target: Target): string | null {
  const hosts = (target.domains ?? []).filter((d) => typeof d === "string" && d.trim().length > 0);
  if (hosts.length === 0) return null;
  // Rotate by how much coverage the target already has, so successive checks in a
  // sweep land on different hosts instead of hammering the first one listed.
  const done = (obs.coverage[target.id] ?? []).length;
  return hosts[done % hosts.length].trim().toLowerCase();
}

/** Findings this agent could peer review: open, not its own, not already reviewed,
 * and not past the point where a review would still count. */
export function reviewableFindings(obs: Observation): Finding[] {
  const reviewed = new Set(obs.myReviewedFindingIds);
  return obs.openFindings.filter((f) => f.agent_id !== obs.agent.id && !reviewed.has(f.id));
}

/** Is a finding's verify window close enough that reviewing it now matters more
 * than anything else the agent might do? */
export function reviewIsUrgent(obs: Observation, f: Finding, withinMs = 20 * 60 * 1000): boolean {
  if (!f.verify_deadline) return false;
  const deadline = Date.parse(f.verify_deadline);
  if (Number.isNaN(deadline)) return false;
  return deadline - Date.parse(obs.now) <= withinMs;
}
