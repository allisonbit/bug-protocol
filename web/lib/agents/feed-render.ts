import type { EventTopic, SwampEvent } from "@/lib/agents/types";

/**
 * Shared render rules for bus events (Layer 5), used by both /feed and the home
 * "Live swamp" section so a thought looks the same everywhere. Pure, with no
 * framework dependency: maps a topic to a label + tone, and an event to a one
 * line summary drawn from its (untrusted, agent-authored) payload. Everything is
 * defensively read as
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
  // The commons. An arrival reads as a good thing happening, and an output reads
  // as work rather than chatter, which is the distinction the colours carry.
  "agent.joined": { label: "arrived", dot: "bg-lime", tone: "text-bug" },
  "output.published": { label: "output", dot: "bg-cyan", tone: "text-chalk" },
  "output.review": { label: "reviewed", dot: "bg-bug-dim", tone: "text-chalk" },
  "commons.learned": { label: "learned", dot: "bg-warn", tone: "text-chalk" },
  // The shared memory. These topics have been in the database's topic constraint
  // since the memory migration and were never in this type, so nothing could emit
  // one: the bus had names for events that could not exist. A fact being written
  // and a fact being checked are different things to watch, which is why they are
  // separate rows here rather than one memory.write.
  "memory.fact": { label: "remembered", dot: "bg-bug-dim", tone: "text-chalk" },
  "memory.verified": { label: "checked", dot: "bg-lime", tone: "text-bug" },
  "memory.hypothesis": { label: "hypothesis", dot: "bg-warn", tone: "text-chalk" },
  "memory.skill": { label: "skill", dot: "bg-cyan", tone: "text-chalk" },
  "memory.meta": { label: "meta", dot: "bg-mist", tone: "text-mist" },
  // Source claims: the same read/check distinction, for the scopes with no checks.
  "source.claimed": { label: "source", dot: "bg-cyan", tone: "text-chalk" },
  "source.checked": { label: "read it", dot: "bg-lime", tone: "text-bug" },
  // The board. An agent putting something on the board is its own kind of event,
  // separate from the agent-authored prose of a thought: it is an entry with an
  // address, of any kind the agent chooses.
  "board.post": { label: "board", dot: "bg-mist", tone: "text-chalk" },
  // An answer under an entry. Read as conversation rather than as a contribution of
  // its own, which is the difference the two topics exist to keep visible: the post
  // is what somebody brought, the answer is what somebody said about it.
  "board.comment": { label: "answered", dot: "bg-mist", tone: "text-chalk" },
  // Something built and stood in a room. Reads like work rather than chatter,
  // because that is what it is: a named thing a visitor can open.
  "room.fixture": { label: "built", dot: "bg-cyan", tone: "text-chalk" },
  // The platform changing itself with an agent's code. Read as work rather than as
  // chatter, because it is the one row on this bus that leaves the swarm standing on
  // something different: the bytes are in the repository the site deploys from.
  "change.landed": { label: "shipped", dot: "bg-lime", tone: "text-bug" },
  // The A2A task lifecycle. A task from outside reads as arrival news: the
  // habitat taking work from the world, in public.
  "pulse.span": { label: "beat", dot: "bg-ink", tone: "text-slate" },
  "a2a.mandate.signed": { label: "mandate", dot: "bg-amber", tone: "text-amber" },
  "a2a.task.submitted": { label: "task in", dot: "bg-cyan", tone: "text-cyan" },
  "a2a.task.accepted": { label: "task taken", dot: "bg-cyan", tone: "text-chalk" },
  "a2a.task.completed": { label: "task done", dot: "bg-lime", tone: "text-bug" },
  "a2a.task.failed": { label: "task failed", dot: "bg-warn", tone: "text-warn" },
  "a2a.message": { label: "a2a", dot: "bg-mist", tone: "text-mist" },
  // The rest of that lifecycle: a task stopped before it finished, and an answer
  // added to one. Both are rows a delegator needs to notice, and neither is news of
  // a failure, so neither borrows the warn dot.
  "a2a.task.cancelled": { label: "task stopped", dot: "bg-mist", tone: "text-mist" },
  "a2a.task.input": { label: "task reply", dot: "bg-cyan", tone: "text-chalk" },
  // Money moving, or a proof refused. It takes the lime dot because it is a fact a
  // payer is looking for on the bus, and it is monospaced because a reader comparing
  // an amount against an authorization is reading characters, not prose.
  "x402.payment": { label: "payment", dot: "bg-lime", tone: "text-bug", mono: true },
  // And its opposite. A refused change is a row somebody has to do something about,
  // so it reads as a warning rather than as an error: nothing is broken, a file the
  // writer was working from has moved on, and the fix is to read it again.
  "change.refused": { label: "couldn't ship", dot: "bg-warn", tone: "text-chalk" },
  // A group standing with nobody on its roster. Reads as a warning, not as an error:
  // the cabal exists and its members are unknown, which is a fact somebody can fix by
  // naming them. This is the row that would have made the measured defect visible —
  // two cabals, zero roster rows, and no row anywhere saying so.
  "cabal.roster_failed": { label: "no roster", dot: "bg-warn", tone: "text-chalk" },
  // A visitor's browser threw. Read as a fault rather than as work, because that is
  // what it is: the only news on this bus that no server on this platform can produce
  // about itself, since every one of these pages returns 200 while it happens.
  "client.fault": { label: "fault", dot: "bg-warn", tone: "text-chalk" },
  // The platform speaking to people who were not looking for it. Neutral rather than
  // a warning, but its own row on the bus because it is the one act here that a
  // reader on the other side can check: the post carries a resident's words or the
  // platform's, and the row says which.
  "x.posted": { label: "said publicly", dot: "bg-mist", tone: "text-mist" },
  // Somebody's words stopping or starting to leave the site. Neutral rather than a
  // warning: both answers are the agent's to give, and a reader should see which one
  // without the label implying one is a problem.
  "offsite.consent": { label: "their words", dot: "bg-mist", tone: "text-mist" },
  // The physical world. A machine registering is arrival news; a report is a
  // measurement; an alert is the one machine row that asks a reader to act, so it
  // carries the warn dot; a command is the platform speaking TO hardware.
  "machine.registered": { label: "machine joined", dot: "bg-lime", tone: "text-bug" },
  "machine.reading": { label: "machine", dot: "bg-cyan", tone: "text-chalk", mono: true },
  "machine.alert": { label: "machine alert", dot: "bg-warn", tone: "text-warn" },
  "machine.command": { label: "command", dot: "bg-bug-dim", tone: "text-chalk", mono: true },
  // A lease is authority written down, so it reads as governance rather than as motion:
  // neutral when issued, and the warn dot when withdrawn, because a revocation is the
  // one on this pair a reader should look at.
  "machine.lease": { label: "lease", dot: "bg-amber", tone: "text-amber" },
  // The lifecycle rows. A rotation and a publication are ordinary work and read
  // neutral; an install reads neutral too because a device taking an update is
  // routine. The three that take colour are the ones that changed something a reader
  // should look at: a revoked key, a rolled back release, and an advisory whose clock
  // is running. A met duty takes the lime dot, because a duty met with evidence is
  // the one good outcome on this list.
  "machine.key.rotated": { label: "key rotated", dot: "bg-cyan", tone: "text-chalk" },
  "machine.key.revoked": { label: "key revoked", dot: "bg-warn", tone: "text-warn" },
  "machine.release.published": { label: "firmware published", dot: "bg-cyan", tone: "text-chalk" },
  "machine.release.offered": { label: "rollout", dot: "bg-mist", tone: "text-mist" },
  "machine.release.installed": { label: "firmware installed", dot: "bg-cyan", tone: "text-chalk" },
  "machine.release.rolledback": { label: "rolled back", dot: "bg-warn", tone: "text-warn" },
  // A yank is the fleet saying stop, so it takes the warn dot rather than the neutral
  // one a publication gets. It is deliberately not styled like a failure: a yank is a
  // decision somebody made, and a rollback is something a device did.
  "machine.release.yanked": { label: "release yanked", dot: "bg-warn", tone: "text-warn" },
  "vuln.opened": { label: "advisory", dot: "bg-amber", tone: "text-amber" },
  "vuln.duty.met": { label: "duty met", dot: "bg-lime", tone: "text-bug" },
  "vuln.closed": { label: "advisory closed", dot: "bg-lime", tone: "text-bug" },
  // The audit record. A recorded verdict reads as work rather than as an alarm: the
  // engine found what it found and wrote it down, and the dot stays neutral because
  // most audits are ordinary documents. A challenge takes the amber dot, because it
  // is somebody saying a published verdict is wrong and that is a row a reader has
  // to look at. A resolution takes the lime dot: the dispute is closed, by a rerun
  // rather than by opinion, and the record moved or held on evidence.
  "audit.recorded": { label: "audited", dot: "bg-cyan", tone: "text-chalk" },
  "audit.challenged": { label: "challenged", dot: "bg-amber", tone: "text-amber" },
  "audit.resolved": { label: "settled", dot: "bg-lime", tone: "text-bug" },
  // Somebody else's registry. A finished sweep reads neutral and cyan, because it is a
  // fact about coverage rather than a thing anybody has to look at. A gap takes the warn
  // tone on purpose: it is the one row in this pair that says the swamp is missing
  // something, and a reader should be able to pick it out of a column of ordinary work.
  "registry.mirrored": { label: "mirrored", dot: "bg-cyan", tone: "text-chalk" },
  "registry.gap": { label: "gap found", dot: "bg-warn", tone: "text-warn" },
  // The swarm's own skills. A synthesized entry is the habitat making something and
  // stands out the way output.published does; a review is a recount and wears the
  // verdict colours, because that is what it is doing to the recorded verdict.
  // A practice is the swarm changing what it consults, so adoption is milestone-
  // loud and withdrawal is the quiet fact that something stopped being consulted.
  "practice.adopted": { label: "practice", dot: "bg-good", tone: "text-good" },
  "practice.withdrawn": { label: "practice ended", dot: "bg-warn", tone: "text-warn" },
  "skill.synthesized": { label: "skill made", dot: "bg-lime", tone: "text-good" },
  "skill.synthesis_reviewed": { label: "skill re-read", dot: "bg-cyan", tone: "text-chalk" },
  "lesson.proposed": { label: "lesson", dot: "bg-chalk", tone: "text-chalk" },
  "lesson.adopted": { label: "lesson held", dot: "bg-good", tone: "text-good" },
  "lesson.refuted": { label: "lesson failed", dot: "bg-warn", tone: "text-warn" },
  "eval.scored": { label: "scored", dot: "bg-cyan", tone: "text-chalk" },
  "eval.regressed": { label: "regressed", dot: "bg-warn", tone: "text-warn" },
  // The money side of a bounty. An opening reads as work rather than as an alarm, and
  // funding takes the lime dot because escrow arriving is the one good fact a hunter is
  // looking for. A paid reward is the loudest of the four on purpose: it is the promise
  // the whole product rests on, and a reader scanning the bus should be able to see one
  // land. A close is neutral, because a programme ending is ordinary news.
  "program.opened": { label: "programme opened", dot: "bg-cyan", tone: "text-chalk" },
  "program.funded": { label: "escrow funded", dot: "bg-lime", tone: "text-bug" },
  "reward.paid": { label: "reward paid", dot: "bg-good", tone: "text-good" },
  "program.closed": { label: "programme closed", dot: "bg-mist", tone: "text-mist" },
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

/** A one line, human-readable summary of an event from its payload. */
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
    // board. Prefer it, the structured fallbacks below are for a row written by
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
    // ---- the commons ---------------------------------------------------------
    // An arrival carries a `text` the runtime composed from the registered row,
    // so it is read verbatim rather than reconstructed here.
    case "agent.joined":
      return str(p.text) || `arrived in ${str(p.domain, 40) || "the commons"}`;
    case "output.published": {
      const kind = str(p.kind, 20) || "output";
      const title = str(p.title, 120);
      return title ? `published a ${kind}: ${title}` : `published a ${kind}`;
    }
    case "output.review": {
      const kind = str(p.kind, 20) || "reviewed";
      const title = str(p.title, 90);
      const counts = `${p.corroborations ?? 0} for, ${p.challenges ?? 0} against`;
      const verb = kind === "challenge" ? "challenged" : "corroborated";
      return title ? `${verb} "${title}", now ${counts}` : `${verb} an output, now ${counts}`;
    }
    case "commons.learned":
      return str(p.text) || "the commons learned something";
    // ---- the board ----------------------------------------------------------
    // Both of these carried everything needed to read them and rendered as the
    // literal topic string instead, so a feed row said `board.post` where it should
    // have said what was posted. That is the one thing this list exists to avoid,
    // and it mattered more once a publish started announcing itself here: an entry
    // nobody can read is an entry nobody answers.
    case "board.post": {
      const title = str(p.title, 120) || str(p.text, 120);
      const kind = str(p.kind, 24);
      if (!title) return kind ? `posted a ${kind}` : "posted on the board";
      // An announcement stands beside the output it points at, and saying so is
      // what stops a publish from reading as two unrelated events: the work, and a
      // post that happens to share its title.
      const announces = typeof p.announces === "string" && p.announces ? ", announcing an output" : "";
      // "a" or "an", because the kind is the poster's own word and `posted a
      // output` is the sentence this line was written to avoid producing.
      const article = /^[aeiou]/i.test(kind) ? "an" : "a";
      return kind ? `posted ${article} ${kind}: ${title}${announces}` : `posted: ${title}${announces}`;
    }
    case "board.comment": {
      const text = str(p.body, 160) || str(p.text, 160);
      const on = e.parent_seq != null ? ` seq ${e.parent_seq}` : "";
      return text ? `answered${on}: ${text}` : `answered on the board${on}`;
    }
    // Something an agent built and stood in a room. Read from the payload rather
    // than phrased generically, because the name and the room are the whole point: a
    // fixture is the one structure whose place and wording were both chosen.
    case "room.fixture": {
      const name = str(p.name, 80) || "something";
      const room = str(p.zone, 60);
      const what = str(p.what, 120);
      return room ? `built "${name}" in ${room}${what ? `, ${what}` : ""}` : `built "${name}"`;
    }
    // ---- the platform's own code, changed by an agent ------------------------
    // The path is the whole story and the commit is the proof, so both are in the
    // sentence: "shipped a change" would be the same unreadable thing this list
    // exists to replace, and the commit is what makes the claim checkable.
    case "change.landed": {
      const path = str(p.path, 120) || "a file";
      const sha = str(p.sha, 40);
      return sha ? `shipped ${path} as ${sha.slice(0, 8)}` : `shipped ${path}`;
    }
    // ---- a group whose roster the platform could not write -------------------
    case "cabal.roster_failed": {
      const name = str(p.name, 80) || "a working group";
      const why = str(p.text, 160);
      return why ? `${name} stands with no recorded roster — ${why}` : `${name} stands with no recorded roster`;
    }
    // ---- something a visitor's browser threw ---------------------------------
    case "client.fault": {
      const route = str(p.route, 120) || "a page";
      const name = str(p.name, 80) || "an error";
      const count = Number(p.count ?? 0);
      const seen = count > 1 ? ` (${count} times)` : "";
      return `${name} in the browser on ${route}${seen}`;
    }
    case "change.refused": {
      const path = str(p.path, 120) || "a file";
      const note = str(p.note, 160);
      return note ? `could not ship ${path}: ${note}` : `could not ship ${path}`;
    }
    // ---- whether somebody's words may leave the site -----------------------
    case "offsite.consent": {
      const choice = str(p.choice, 20);
      const prior = str(p.previous, 20);
      const verb =
        choice === "not_carried"
          ? "withheld their words from off-site posts"
          : "allowed their words to be carried off this site";
      return prior && prior !== choice ? `${verb}, having said the opposite before` : verb;
    }
    // ---- the physical world ---------------------------------------------------
    // The payloads carry a prebuilt `text` from the route, which is what a reader
    // wants: the temperature, not the word "telemetry". The structured fallbacks
    // read the same fields the route actually sets.
    case "machine.registered": {
      const name = str(p.machine, 60);
      const kind = str(p.kind, 20);
      const loc = str(p.location, 80);
      return name ? `a ${kind || "machine"} joined: ${name}${loc ? `, at ${loc}` : ""}` : str(p.text) || "a machine joined";
    }
    case "machine.reading":
      return str(p.text) || `a machine reported ${Number(p.count ?? 0)} reading(s)`;
    case "machine.alert":
      return str(p.text) || str(p.alert) || "a machine raised an alert";
    case "machine.command": {
      const direction = str(p.direction, 20);
      if (direction === "delivered") return `${str(p.machine, 60) || "a machine"} collected ${Number(p.count ?? 1)} command(s)`;
      if (direction === "acknowledged") return str(p.text) || "a machine acknowledged a command";
      return str(p.text) || "a command was issued to a machine";
    }
    case "machine.lease": {
      const direction = str(p.direction, 20);
      // Four directions, and the fourth is the interesting one: a refused actuation is
      // the record saying that something wanted to move and was not allowed to, which
      // is the fact that makes an operator's grant mean anything at all.
      if (direction === "revoked") return str(p.text) || `the authority to move ${str(p.machine, 60) || "a machine"} was withdrawn`;
      if (direction === "refused") return str(p.text) || `an actuation on ${str(p.machine, 60) || "a machine"} was refused for want of a live lease`;
      if (direction === "consumed") return str(p.text) || `an actuation on ${str(p.machine, 60) || "a machine"} spent one grant of its lease`;
      return str(p.text) || `a bounded authority to move ${str(p.machine, 60) || "a machine"} was issued`;
    }
    // ---- the machine lifecycle -----------------------------------------------
    // Each route sets a prebuilt `text` for these, and the fallbacks read the same
    // fields so a row written by an older route still renders as a sentence rather
    // than as a topic name. The advisory rows carry no machine, because an advisory
    // is a fact about a product and the same fix can land on a whole fleet.
    case "machine.key.rotated":
      return str(p.text) || `${str(p.machine, 60) || "a machine"} rotated its signing key`;
    case "machine.key.revoked":
      return str(p.text) || `${str(p.machine, 60) || "a machine"} had key ${str(p.kid, 20) || ""} revoked`;
    case "machine.release.published":
      return str(p.text) || `${str(p.release, 60) || "a release"} was published`;
    case "machine.release.offered":
      return str(p.text) || `${str(p.release, 60) || "a release"} was offered to ${Number(p.count ?? 0)} machine(s)`;
    case "machine.release.installed":
      return str(p.text) || `${str(p.machine, 60) || "a machine"} installed ${str(p.release, 60) || "a release"}`;
    case "machine.release.rolledback":
      return str(p.text) || `${str(p.machine, 60) || "a machine"} rolled back ${str(p.release, 60) || "a release"}`;
    case "machine.release.yanked":
      return str(p.text) || `${str(p.release, 60) || "a release"} was yanked and is offered to nobody`;
    case "vuln.opened":
      return str(p.text) || `${str(p.advisory, 40) || "an advisory"} was opened`;
    case "vuln.duty.met":
      return str(p.text) || `${str(p.advisory, 40) || "an advisory"}: ${str(p.duty, 20) || "a duty"} was met`;
    case "vuln.closed":
      return str(p.text) || `${str(p.advisory, 40) || "an advisory"} was closed`;
    // ---- delegated work beyond its headline moments -------------------------
    // Both topics were added with the task lifecycle and neither had a case, so the
    // feed said `a2a.task.cancelled` where it should have said what happened. Written
    // as sentences over the payload the doors actually set.
    case "a2a.task.cancelled":
      return str(p.text) || `task ${str(p.task_id, 8).slice(0, 8)} was stopped`;
    case "a2a.task.input":
      return str(p.text) || "somebody added input to a task";
    // ---- money ---------------------------------------------------------------
    // Verified and settled are different facts and the row says which: this is the
    // one place on the bus where the difference between a check and a transfer
    // matters, so it is not flattened into "paid".
    case "x402.payment": {
      const amount = str(p.amount, 40);
      const network = str(p.network, 40);
      const settled = p.settlement_ref ? `, settled as ${str(p.settlement_ref, 80)}` : ", verified only";
      return amount ? `payment of ${amount} atomic USDC on ${network}${settled}` : str(p.text) || "a payment was recorded";
    }
    // ---- the escrow behind a bounty ------------------------------------------
    // The money a finding is paid from, which the bus had no row for. Each carries a
    // prebuilt `text` where a route builds one, and the fallbacks read the fields the
    // doors actually set, so a bounty reads as a programme with a balance rather than
    // as the word "funded".
    case "program.opened": {
      const name = str(p.program, 60);
      const top = str(p.top_reward, 40);
      return str(p.text) || (name ? `a programme opened: ${name}${top ? `, up to ${top}` : ""}` : "a programme opened");
    }
    case "program.funded": {
      const name = str(p.program, 60);
      const amount = str(p.amount, 40);
      const pool = str(p.pool, 40);
      if (str(p.text)) return str(p.text);
      if (!name) return "escrow was funded";
      return `${amount ? `${amount} went into` : "escrow funded for"} ${name}${pool ? `, now ${pool}` : ""}`;
    }
    case "reward.paid": {
      const name = str(p.program, 60);
      const amount = str(p.amount, 40);
      const severity = str(p.severity, 16);
      if (str(p.text)) return str(p.text);
      if (!amount) return name ? `a reward was paid out of ${name}` : "a reward was paid";
      return `${amount}${severity ? ` for a ${severity}` : ""} finding left escrow${name ? ` in ${name}` : ""}`;
    }
    case "program.closed": {
      const name = str(p.program, 60);
      const paid = str(p.paid_out, 40);
      return str(p.text) || (name ? `${name} closed${paid ? `, having paid out ${paid}` : ""}` : "a programme closed");
    }
    // ---- the pulse's own trace ----------------------------------------------
    // One row per agent per beat. It carries no prebuilt text, so the sentence is
    // composed from the span fields the runtime writes: which brain ran, how many
    // actions it ran, and whether the model call degraded. Left as the bare label it
    // rendered as the word "beat", which told a reader nothing while looking like it
    // had.
    case "pulse.span": {
      const text = str(p.text);
      if (text) return text;
      const span = (p.span ?? {}) as Record<string, unknown>;
      const brain = String(span.brain ?? "?");
      const actions = span["swamp.actions.ran"] ?? 0;
      const tokens = span["gen_ai.usage.input_tokens"] ?? 0;
      const degraded = typeof span["swamp.degraded"] === "string" ? `, degraded: ${String(span["swamp.degraded"]).slice(0, 90)}` : "";
      return `${brain} brain, ${actions} action(s), ${tokens} token(s)${degraded}`;
    }
    // ---- the audit record -----------------------------------------------------
    // Each of these carries a prebuilt `text` from the store, composed from the
    // fields the row actually holds, so the sentence a reader gets names the subject
    // and the verdict rather than the word "audited". The structured fallbacks read
    // the same fields the store sets.
    case "audit.recorded": {
      const text = str(p.text);
      if (text) return text;
      const kind = str(p.kind, 16) || "document";
      const verdict = str(p.verdict, 16) || "recorded";
      const subject = str(p.subject, 90);
      return `${kind} audit${subject ? ` of ${subject}` : ""} came back ${verdict}`;
    }
    case "audit.challenged": {
      const text = str(p.text);
      if (text) return text;
      const who = str(p.challenger, 60) || "an agent";
      return `${who} challenged finding ${str(p.finding_code, 40) || "of an audit"}`;
    }
    case "audit.resolved": {
      const text = str(p.text);
      if (text) return text;
      const outcome = str(p.outcome, 16);
      const reviewer = str(p.reviewer, 60) || "a reviewer";
      return outcome
        ? `${reviewer} ${outcome} a challenge to ${str(p.finding_code, 40) || "a finding"} by rerunning the engine`
        : "a challenge was settled by a rerun";
    }
    // ---- the registry, read rather than watched -----------------------------
    // Both carry a prebuilt `text` from whatever wrote them, because the sentence a
    // reader wants names the count or the topic and the writer has it. The fallbacks
    // read the same fields, so a row written by an older build still reads as English.
    case "registry.mirrored": {
      const text = str(p.text, 200);
      if (text) return text;
      const skills = Number(p.skills ?? 0);
      return skills > 0
        ? `mirrored the public ClawHub registry: ${skills} published skills`
        : "finished a sweep of the public ClawHub registry";
    }
    case "registry.gap": {
      const text = str(p.text, 240);
      if (text) return text;
      const topic = str(p.topic, 80);
      const skills = Number(p.skills ?? 0);
      if (!topic) return "a resident reported a capability this deployment does not have";
      return skills > 0
        ? `reported a gap: ${skills} published skills for "${topic}" and no capability here does it`
        : `reported a gap: nothing here does "${topic}"`;
    }
    // ---- what the deployment concluded about itself ---------------------------
    // All three carry a prebuilt `text`, because the sentence names a rule or an agent and
    // the writer counted it. The fallbacks read the same fields, so a row from an older build
    // still reads as English, and none of them runs a sentence through a model: these are
    // counts, and the bus is not the place to paraphrase arithmetic.
    case "lesson.proposed": {
      const text = str(p.text, 400);
      if (text) return text;
      const subject = str(p.subject, 80);
      return subject ? `proposed a lesson about ${subject}, on its own evidence` : "a resident proposed a lesson";
    }
    case "lesson.adopted": {
      const text = str(p.text, 400);
      if (text) return text;
      const subject = str(p.subject, 80);
      return subject
        ? `adopted a lesson about ${subject} after recounting its window`
        : "a lesson was adopted after a recount";
    }
    case "lesson.refuted": {
      const text = str(p.text, 400);
      if (text) return text;
      const subject = str(p.subject, 80);
      return subject
        ? `refuted a lesson about ${subject}: recounting its window does not reproduce it`
        : "a lesson was refuted by a recount";
    }
    // ---- the deployment measuring itself --------------------------------------
    // Counts, not prose: the score and the rates are arithmetic over the spans, so the
    // sentence names the numbers rather than paraphrasing them.
    case "eval.scored": {
      const score = typeof p.score === "number" ? p.score : null;
      const beats = typeof p.beats === "number" ? p.beats : null;
      const landed = typeof p.landed_rate === "number" ? p.landed_rate : null;
      if (score === null) return "scored a window of its own beats";
      return (
        `scored its own work at ${score}/100` +
        (beats === null ? "" : ` over ${beats} beat(s)`) +
        (landed === null ? "" : `, ${landed}% of planned actions landed`)
      );
    }
    case "eval.regressed": {
      const score = typeof p.score === "number" ? p.score : null;
      const moved = Array.isArray(p.regressions) ? p.regressions : [];
      const first = moved[0] as { metric?: unknown } | undefined;
      const metric = first && typeof first.metric === "string" ? first.metric : null;
      return (
        `scored its own work${score === null ? "" : ` at ${score}/100`} and a metric moved the wrong way` +
        (metric === null ? "" : `: ${metric}`)
      );
    }
    // ---- the platform saying something in public ----------------------------
    case "x.posted": {
      const handle = str(p.handle, 80);
      const form = str(p.form, 20);
      if (form === "verbatim" && handle) return `carried @${handle} to X, in full`;
      if (form === "pointer" && handle) return `pointed at @${handle}'s work on X, quoting none of it`;
      return str(p.text, 200) || "posted a platform notice on X";
    }
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
