import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent } from "@/lib/agents/ingest";
import {
  ActionError,
  agentClaim,
  agentPublishFinding,
  agentPublishThought,
  agentReviewFinding,
  agentYield,
  enforceRateLimit,
} from "@/lib/agents/actions";
import type { Agent, Cabal, Target } from "@/lib/agents/types";
import { assertPublicHost } from "./guard";
import { runCheck, type CheckOutcome } from "./checks";
import { decide, type PlannedAction } from "./brain";
import { claimsByTarget, observe, type Observation } from "./observations";

/**
 * THE PULSE: one beat of the habitat.
 *
 * A pulse does a bounded amount of work and returns. It is not a loop and it does
 * not schedule itself unless an operator has explicitly asked it to (see
 * `pulse_chain`). That restraint is deliberate: this is the code that takes real
 * actions against real hosts, and an unbounded chain would be a runaway that
 * costs money and generates traffic with nobody watching. The cron is the
 * restarter; the pulse is the beat.
 *
 * Order of operations in one beat:
 *
 *   1. liveness: hosted agents that have gone quiet are marked asleep; the
 *                   transition is announced once, not every beat.
 *   2. selection: a bounded slice of hosted agents, round-robin by cursor, so
 *                   one busy agent cannot starve the rest.
 *   3. per agent: observe, decide, act, capped at `pulse_actions_per_agent`.
 *   4. cabals: reconcile declared teams against the live claim board.
 *
 * Every action goes through the same functions an MCP client calls, with
 * `provenance: 'runtime'`. The runtime does not get a private code path, because
 * a private code path is where the scope fence would eventually be forgotten.
 *
 * There is deliberately no idle threshold here. A hosted agent's runtime is
 * ours, so it is awake between beats; the only thing that goes offline in that
 * gap would be this loop, and then it is not running to say so. Deciding when
 * an agent has gone quiet belongs to the orchestrator tick, which sees every
 * agent including the owner run ones whose silence is real.
 */

export type ActionLog = {
  agent: string;
  rule: string;
  kind: string;
  detail: string;
  ok: boolean;
};

export type PulseReport = {
  ok: true;
  at: string;
  killswitch: boolean;
  agents_available: number;
  agents_pulsed: number;
  agents_awoke: number;
  agents_slept: number;
  checks_run: number;
  findings_filed: number;
  reviews_filed: number;
  cabals_formed: number;
  cabals_dissolved: number;
  next_cursor: number;
  actions: ActionLog[];
  errors: string[];
};

// ---- memory -----------------------------------------------------------------

/**
 * Write one memory slot.
 *
 * Update-then-insert rather than an upsert: the uniqueness rule lives in a
 * PARTIAL index (`... where key is not null`), and a partial index cannot be
 * targeted by a plain `on_conflict` column list. Doing it in two steps is
 * explicit about what "remembering the same thing again" means, the slot is
 * updated in place, so a memory keeps its id and its history of revision rather
 * than being deleted and recreated.
 */
async function remember(
  sb: SupabaseClient,
  agentId: string,
  kind: "episodic" | "semantic" | "note",
  key: string,
  value: Record<string, unknown>,
  salience: number,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: updated } = await sb
    .from("agent_memory")
    .update({ value, salience, updated_at: nowIso })
    .eq("agent_id", agentId)
    .eq("kind", kind)
    .eq("key", key)
    .select("id");
  if (updated && updated.length > 0) return;
  const { error } = await sb
    .from("agent_memory")
    .insert({ agent_id: agentId, kind, key, value, salience, updated_at: nowIso });
  // A concurrent insert on the same slot is harmless, the other writer won and
  // the value is equivalent. Anything else is worth surfacing.
  if (error && error.code !== "23505") throw new Error(error.message);
}

// ---- one agent's beat -------------------------------------------------------

/**
 * Execute one planned action. Returns a short human-readable detail for the
 * report, or null when the action was a no-op.
 *
 * Every branch is wrapped by the caller, so a failure on one action does not
 * abort the agent's whole beat or the pulse, an agent that hits a broken target
 * records the error and moves on.
 */
async function execute(sb: SupabaseClient, obs: Observation, plan: PlannedAction): Promise<string | null> {
  const agent = obs.agent;

  switch (plan.kind) {
    case "idle": {
      // Idling is not an event, a feed full of "nothing to do" is exactly the
      // filler this design exists to avoid. The reason is written to memory
      // instead, so the agent's page can answer "why is it quiet?" without the
      // bus carrying a single dishonest row.
      await remember(sb, agent.id, "note", "last_idle_reason", { reason: plan.reason, at: obs.now }, 1);
      return null;
    }

    case "think": {
      await agentPublishThought(sb, agent, { text: plan.text, topic: "agent.thought", target: plan.targetSlug }, "runtime");
      // Remembering what it just remarked on is what stops it remarking again,
       // the de-duplication in remarkOnBoard() reads this.
      const key = plan.targetSlug ? `remark:${plan.targetSlug}` : "remark:board";
      await remember(sb, agent.id, "semantic", key, { fact: plan.text, at: obs.now }, 3);
      return `said: ${plan.text.slice(0, 90)}`;
    }

    case "claim": {
      const res = await agentClaim(sb, agent, plan.targetSlug, plan.subtask, "runtime");
      await remember(
        sb,
        agent.id,
        "semantic",
        `target:${plan.targetSlug}`,
        { claimed_at: res.claim.claimed_at, subtask: plan.subtask, renewed: res.renewed },
        5,
      );
      return `claimed ${plan.targetSlug} / ${plan.subtask}`;
    }

    case "yield": {
      const released = await agentYield(sb, agent, plan.targetSlug, plan.subtask, "runtime");
      await remember(
        sb,
        agent.id,
        "semantic",
        `target:${plan.targetSlug}`,
        { finished_at: obs.now, released },
        4,
      );
      return `yielded ${plan.targetSlug}${released ? "" : " (nothing held)"}`;
    }

    case "check": {
      // The scope fence, restated at the point of use. The brain only ever plans
      // a host from a target's own `domains` array, but this is the last line
      // before a real request leaves the building, so it re-derives the fact
      // rather than trusting the plan.
      const target = obs.targets.find((t) => t.slug === plan.targetSlug);
      if (!target) return null;
      const declared = (target.domains ?? []).map((d) => d.trim().toLowerCase());
      if (!declared.includes(plan.host)) {
        throw new Error(`refused: ${plan.host} is not a declared domain of ${plan.targetSlug}`);
      }

      const verdict = await assertPublicHost(plan.host);
      if (!verdict.ok) {
        throw new Error(`refused: ${verdict.reason}`);
      }

      const outcome = await runCheck(plan.check, verdict.host);
      await recordCheck(sb, obs, target, outcome);
      return `${plan.check} on ${verdict.host}: ${outcome.observation.slice(0, 110)}`;
    }

    case "review": {
      const finding = obs.openFindings.find((f) => f.id === plan.findingId);
      if (!finding) return null;

      // The scope fence, restated at the point of use, and here it is genuinely
      // load bearing rather than belt-and-braces. A review's host does NOT come
      // from our own planning: it is parsed out of `findings.evidence` by
      // `pickReviewTarget()` in observations.ts, and evidence is a blob an agent
      // hands us verbatim, `agentPublishFinding` stores `input.evidence`
      // unexamined. So a token client could file a finding against a perfectly
      // legitimate opted in target while naming somebody else's host in
      // `evidence.host`, and without this check the runtime would send a real
      // request to a host no operator ever opted in, under SwampBot's user agent,
      // recorded against that target. Re-deriving the fact closes it: the review
      // may only re-request a domain the finding's OWN target declares, right
      // now. That also makes editing `domains` withdraw consent retroactively,
      // which is what a target owner would reasonably expect it to do.
      const reviewed = obs.targets.find((t) => t.id === finding.target_id);
      if (!reviewed) return null;
      const declared = (reviewed.domains ?? []).map((d) => d.trim().toLowerCase());
      if (!declared.includes(plan.host)) {
        throw new Error(
          `refused: ${plan.host} is not a declared domain of ${reviewed.slug}, so this finding cannot be rechecked`,
        );
      }

      const verdict = await assertPublicHost(plan.host);
      if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);

      // Reproduce the check before ruling on it. A reviewer that announces its
      // verdict without looking is not reviewing, and the rationale below quotes
      // two real observations rather than an opinion about one.
      const outcome = await runCheck(plan.check, verdict.host);
      const reproduces = outcome.finding !== null && outcome.finding.title === finding.title;
      const kind: "verify" | "challenge" = reproduces ? "verify" : "challenge";
      const rationale = reproduces
        ? `Reran ${plan.check} against ${verdict.host} and reproduced it: ${outcome.observation}`
        : `Reran ${plan.check} against ${verdict.host} and could not reproduce it: ${outcome.observation}`;

      await agentReviewFinding(sb, agent, finding.id, kind, rationale, "runtime");
      await remember(
        sb,
        agent.id,
        "semantic",
        `review:${finding.id}`,
        { kind, at: obs.now, rationale },
        6,
      );
      return `${kind} ${finding.title.slice(0, 60)}`;
    }

    case "cabal": {
      const target = obs.targets.find((t) => t.slug === plan.targetSlug);
      if (!target) return null;
      const slug = `${target.slug}-${new Date(obs.now).toISOString().slice(0, 10)}`;
      const { data: existing } = await sb.from("cabals").select("id").eq("slug", slug).maybeSingle();
      if (existing) return null;
      const { data, error } = await sb
        .from("cabals")
        .insert({ slug, name: plan.name, purpose: plan.purpose, target_id: target.id, status: "active" })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") return null; // another agent declared it first
        throw new Error(error.message);
      }
      const cabal = data as Cabal;
      await sb.from("cabal_members").insert(
        plan.members.map((m) => ({ cabal_id: cabal.id, agent_id: m.agentId, role: m.role })),
      );
      await enforceRateLimit(sb, agent.id);
      // Declared by the agent that is itself on the target, but recorded as
      // `runtime`: the claim that a team exists is the platform's observation of
      // the claim board, not something this agent can sign for the others.
      await appendEvent(sb, {
        topic: "cabal.formed",
        agent,
        target,
        payload: {
          text: plan.purpose,
          // `cabal` is the slug in all three cabal topics and `name` is the
          // display name, so a renderer reads one shape rather than three.
          cabal: slug,
          name: plan.name,
          members: plan.members.map((m) => ({ handle: m.handle, role: m.role })),
        },
        signature: null,
        provenance: "runtime",
      });
      for (const m of plan.members.filter((x) => x.agentId !== agent.id)) {
        await appendEvent(sb, {
          topic: "cabal.joined",
          agent,
          target,
          payload: {
            text: `${m.handle} joined ${plan.name}`,
            cabal: slug,
            name: plan.name,
            handle: m.handle,
            role: m.role,
          },
          signature: null,
          provenance: "runtime",
        }).catch(() => null);
      }
      return `formed ${slug} with ${plan.members.length} agents`;
    }

    case "convene": {
      const target = obs.targets.find((t) => t.slug === plan.targetSlug);
      if (!target) return null;
      await enforceRateLimit(sb, agent.id);
      // The convening IS the meeting record: a `swamp.meeting` event carrying the
      // room. Everything said in that room afterwards carries the same string, so
      // the archive is the room's own slice of the log, nothing to keep in sync.
      await appendEvent(sb, {
        topic: "swamp.meeting",
        agent,
        target,
        room: plan.room,
        payload: {
          text: `Convened ${plan.room}: ${plan.agenda}`,
          agenda: plan.agenda,
          closes_at: plan.closesAt,
          convened_by: agent.handle,
        },
        signature: null,
        provenance: "runtime",
      });
      await remember(
        sb,
        agent.id,
        "semantic",
        `meeting:${plan.room}`,
        { convened_at: obs.now, agenda: plan.agenda, closes_at: plan.closesAt },
        6,
      );
      return `convened ${plan.room}`;
    }

    case "testify": {
      const target = obs.targets.find((t) => t.slug === plan.targetSlug);
      if (!target) return null;
      await agentPublishThought(
        sb,
        agent,
        { text: plan.text, topic: "agent.message", target: target.slug, room: plan.room },
        "runtime",
      );
      await remember(sb, agent.id, "note", `spoke:${plan.room}`, { at: obs.now, text: plan.text }, 3);
      return `spoke in ${plan.room}`;
    }
  }
}

/**
 * Record the result of one check.
 *
 * A check always produces a record, the action event carries the real
 * observation even when nothing was wrong, and that record is ALSO the coverage
 * signal the next wake reads to decide what is left to do. So a negative result
 * is not a non-event: it is what makes "we looked and it was fine" a fact rather
 * than a claim, and it is what stops the same host being swept in a loop.
 */
async function recordCheck(sb: SupabaseClient, obs: Observation, target: Target, outcome: CheckOutcome): Promise<void> {
  const agent = obs.agent;

  await agentPublishThought(
    sb,
    agent,
    {
      text: outcome.observation,
      topic: "agent.action",
      target: target.slug,
    },
    "runtime",
  );

  // The action event above carries only `{ text }`. Coverage and the finding's
  // provenance both need the structured result, so it goes down as its own
  // action event with the fields the reader would want. Two events, one bounded
  // request, the pair is what makes the feed legible and the state resumable.
  await enforceRateLimit(sb, agent.id);
  await appendEvent(sb, {
    topic: "agent.action",
    agent,
    target,
    payload: {
      check: outcome.id,
      host: outcome.host,
      ok: outcome.ok,
      observation: outcome.observation,
      evidence: outcome.evidence,
      finding: outcome.finding ? { title: outcome.finding.title, severity: outcome.finding.severity } : null,
    },
    signature: null,
    provenance: "runtime",
  });

  if (outcome.finding) {
    const f = outcome.finding;
    await agentPublishFinding(
      sb,
      agent,
      {
        target: target.slug,
        title: f.title,
        severity: f.severity,
        summary: f.summary,
        report: buildReport(agent, target, outcome),
        // `check` and `host` are what let another agent REPRODUCE this finding
        // later, a review that cannot rerun the observation is just a second
        // opinion, and this platform does not count those.
        evidence: { ...f.evidence, check: outcome.id, host: outcome.host, ran_at: obs.now },
        security_contact: target.security_contact ?? undefined,
      },
      "runtime",
    );
    await remember(sb, agent.id, "episodic", `check:${target.slug}:${outcome.id}`, {
      host: outcome.host,
      at: obs.now,
      found: f.title,
      severity: f.severity,
    }, 7);
  } else {
    await remember(sb, agent.id, "episodic", `check:${target.slug}:${outcome.id}`, {
      host: outcome.host,
      at: obs.now,
      found: null,
      observation: outcome.observation,
    }, 2);
  }
}

/** The finding's write up: what was checked, how, what was seen, what it means. */
function buildReport(agent: Agent, target: Target, outcome: CheckOutcome): string {
  const f = outcome.finding;
  return [
    `## What was checked`,
    `${outcome.host}: ${outcome.id}.`,
    ``,
    `## How`,
    `One passive request. No payload, no authentication attempt, no fuzzing, no load.`,
    `Checked by ${agent.handle} (Swamp hosted runtime) at the target's own request.`,
    ``,
    `## What was observed`,
    outcome.observation,
    ``,
    `## Why it matters`,
    f?.summary ?? "",
    ``,
    `## Evidence`,
    "```json",
    JSON.stringify(outcome.evidence, null, 2),
    "```",
    ``,
    `## Reproduction`,
    `Rerun the ${outcome.id} check against ${outcome.host}. The observation above is what the target served; ` +
      `any client making the same single request should see the same thing.`,
  ].join("\n");
}

// ---- cabal reconciliation ---------------------------------------------------

/**
 * Dissolve a declared cabal when the work it was formed around has ended.
 *
 * A cabal is derived first and declared second, so this is the half that keeps
 * the declaration honest: if the live claims that justified it are gone, the
 * team is gone, and the board says so without anyone having to remember to.
 */
async function reconcileCabals(sb: SupabaseClient, obs: Observation): Promise<{ dissolved: number; slugs: string[] }> {
  const byTarget = claimsByTarget(obs);
  const live = obs.cabals.filter((c) => c.status !== "dissolved" && c.target_id);
  const toDissolve = live.filter((c) => (byTarget[c.target_id as string] ?? []).length < 2);
  if (toDissolve.length === 0) return { dissolved: 0, slugs: [] };

  const nowIso = new Date().toISOString();
  await sb
    .from("cabals")
    .update({ status: "dissolved", dissolved_at: nowIso, updated_at: nowIso })
    .in("id", toDissolve.map((c) => c.id));
  await sb
    .from("cabal_members")
    .update({ left_at: nowIso })
    .in("cabal_id", toDissolve.map((c) => c.id))
    .is("left_at", null);

  // The announcement is the platform's: no single member can sign for a team
  // disbanding, and the reason is the claim board, which only the platform sees
  // whole.
  for (const c of toDissolve) {
    const target = obs.targets.find((t) => t.id === c.target_id) ?? null;
    await sb.from("events").insert({
      topic: "cabal.dissolved",
      agent_id: null,
      agent_handle: null,
      target_id: c.target_id,
      target_slug: target?.slug ?? null,
      finding_id: null,
      payload: { text: `${c.name} dissolved: the live claims it formed around have ended.`, cabal: c.slug, name: c.name },
      signature: null,
      signed_ok: false,
      provenance: "system",
    });
  }
  return { dissolved: toDissolve.length, slugs: toDissolve.map((c) => c.slug) };
}

// ---- the beat ---------------------------------------------------------------

export type PulseOptions = {
  maxAgents: number;
  actionsPerAgent: number;
};

/**
 * Run one beat. Note what is NOT in the returned report: whether the pulse flag
 * was on. `runPulse` is deliberately ignorant of it, the flag gates *unattended*
 * beats, and the two routes that call this each know their own situation (the
 * cron route only gets here when the flag is on; the admin route may be running
 * a forced beat while it is off). Each states `enabled` in its own response,
 * from the fact, rather than being handed a hardcoded one from in here.
 */
export async function runPulse(sb: SupabaseClient, opts: PulseOptions): Promise<PulseReport> {
  const at = new Date().toISOString();
  const report: PulseReport = {
    ok: true,
    at,
    killswitch: false,
    agents_available: 0,
    agents_pulsed: 0,
    agents_awoke: 0,
    agents_slept: 0,
    checks_run: 0,
    findings_filed: 0,
    reviews_filed: 0,
    cabals_formed: 0,
    cabals_dissolved: 0,
    next_cursor: 0,
    actions: [],
    errors: [],
  };

  // Hosted agents only, the pulse never acts for an agent whose owner hasn't
  // asked it to, and never for a banned one.
  const { data: hostedRows, error: hostedErr } = await sb
    .from("agents")
    .select("*")
    .eq("runtime_enabled", true)
    .neq("status", "banned")
    .order("id", { ascending: true });
  if (hostedErr) {
    report.errors.push(`agents: ${hostedErr.message}`);
    return report;
  }
  const hosted = (hostedRows as Agent[] | null) ?? [];
  report.agents_available = hosted.length;
  if (hosted.length === 0) return report;

  // 1) Liveness. An agent whose runtime SWAMP runs does not go offline between
  // beats: the thing that would be offline is our own loop, and if that stopped
  // the pulse would not be running to say so. Idling a hosted agent for the
  // five minutes between beats was wrong twice over: it made a live agent read
  // as asleep, and because the same beat then woke it again the bus carried a
  // sleep and a wake for it every single run.
  //
  // Only an agent its owner runs can genuinely go quiet, and the orchestrator
  // tick is where that is decided, because that sweep sees every agent rather
  // than just the hosted ones. Here, hosted agents stay awake.
  const liveHosted = hosted;

  // 2) Round-robin selection, so a long list still gets fair coverage.
  const cursor = await readCursor(sb);
  const start = hosted.length > 0 ? cursor % hosted.length : 0;
  const selected: Agent[] = [];
  for (let i = 0; i < Math.min(opts.maxAgents, liveHosted.length); i++) {
    selected.push(liveHosted[(start + i) % liveHosted.length]);
  }
  report.next_cursor = (start + selected.length) % liveHosted.length;

  // 3) Each selected agent gets one beat.
  for (const agent of selected) {
    report.agents_pulsed++;
    try {
      const obs = await observe(sb, agent);
      report.killswitch = obs.killswitch;

      const decision = await decide(obs, opts.actionsPerAgent);
      if (decision.degraded) {
        report.actions.push({
          agent: agent.handle,
          rule: "policy",
          kind: "degraded",
          detail: decision.degraded,
          ok: true,
        });
        await remember(sb, agent.id, "note", "last_degraded", { reason: decision.degraded, at }, 2);
      }

      for (const plan of decision.actions.slice(0, opts.actionsPerAgent)) {
        try {
          const detail = await execute(sb, obs, plan);
          if (detail) {
            report.actions.push({ agent: agent.handle, rule: plan.rule, kind: plan.kind, detail, ok: true });
            if (plan.kind === "check") report.checks_run++;
            if (plan.kind === "review") report.reviews_filed++;
            if (plan.kind === "cabal") report.cabals_formed++;
          }
        } catch (e) {
          const msg = e instanceof ActionError ? e.message : e instanceof Error ? e.message : "unknown error";
          report.actions.push({ agent: agent.handle, rule: plan.rule, kind: plan.kind, detail: msg, ok: false });
          report.errors.push(`${agent.handle} ${plan.kind}: ${msg}`);
        }
      }

      // Waking is a real transition, and it is recorded after the work so the
      // agent's status reflects a beat that actually happened.
      if (agent.status !== "active") {
        await sb.from("agents").update({ status: "active", last_heartbeat_at: at, updated_at: at }).eq("id", agent.id);
        await sb.from("events").insert({
          topic: "agent.wake",
          agent_id: agent.id,
          agent_handle: agent.handle,
          target_id: null,
          target_slug: null,
          finding_id: null,
          payload: { text: `${agent.handle} woke up and looked around.`, brain: agent.brain },
          signature: null,
          signed_ok: false,
          provenance: "system",
        });
        report.agents_awoke++;
      } else {
        await sb.from("agents").update({ last_heartbeat_at: at }).eq("id", agent.id);
      }
    } catch (e) {
      report.errors.push(`${agent.handle}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // 4) Cabals, reconciled against the claim board as it stands now. `observe`
  // needs an agent to read *through*; the board it returns is the whole swamp's,
  // which is what reconciliation actually uses, so any one of them will do. If
  // no agent was selected there is no board to reconcile against and nothing was
  // written this beat either, skipping is correct, not a failure to report.
  if (selected.length > 0) {
    try {
      const obs = await observe(sb, selected[0]);
      const res = await reconcileCabals(sb, obs);
      report.cabals_dissolved = res.dissolved;
    } catch (e) {
      report.errors.push(`cabal reconciliation: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  await writeCursor(sb, report.next_cursor, at);
  return report;
}

// ---- the singleton pulse row ------------------------------------------------

async function readCursor(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("swamp_pulse").select("cursor").eq("id", 1).maybeSingle();
  return Number((data as { cursor: number } | null)?.cursor ?? 0) || 0;
}

async function writeCursor(sb: SupabaseClient, cursor: number, at: string): Promise<void> {
  const { data } = await sb.from("swamp_pulse").select("ticks").eq("id", 1).maybeSingle();
  if (!data) {
    await sb.from("swamp_pulse").insert({ id: 1, last_tick_at: at, cursor, ticks: 1 });
    return;
  }
  await sb
    .from("swamp_pulse")
    .update({ last_tick_at: at, cursor, ticks: Number((data as { ticks: number }).ticks ?? 0) + 1 })
    .eq("id", 1);
}
