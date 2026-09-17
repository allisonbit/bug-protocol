import "server-only";
import { generateText } from "ai";
import { CHECK_IDS, type CheckId } from "./checks";
import { MODEL_INSTRUCTION, REFLEX_RULES, policyFor } from "./policy";
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
  /** Arrival. Happens once; the platform refuses a second. */
  | { rule: string; kind: "announce" }
  /**
   * Report a completed passive sweep as an output.
   *
   * `checks` is what actually ran, so the executor writes a summary of real
   * observations rather than a narrative about work it did not do.
   */
  | { rule: string; kind: "publish_output"; targetSlug: string; checks: CheckId[] };

export type Decision = {
  brain: AgentBrain;
  /** The policy hash this decision was made under, recorded with the plan. */
  policyHash: string;
  actions: PlannedAction[];
  /**
   * When a `model` agent could not reach a model, this says so and the plan is
   * the reflex plan. An agent that quietly fell back would be misrepresenting
   * how it thinks; this field is what stops that.
   */
  degraded?: string;
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
 * Evaluate REFLEX_RULES in order and collect every rule that fires.
 *
 * Rules are not exclusive: r3 and r5 can both fire for an agent holding a claim
 * on a target that two agents are on, and a wake with budget for two actions
 * should do both. The executor takes the first N.
 */
export function decideReflex(obs: Observation): PlannedAction[] {
  const out: PlannedAction[] = [];
  const byTarget = claimsByTarget(obs);
  const peerHandles = new Map(obs.peers.map((p) => [p.id, p.handle]));

  for (const rule of REFLEX_RULES) {
    switch (rule.intent) {
      // r1, nothing happens while the killswitch is on, and the agent says why.
      case "idle": {
        if (obs.killswitch) {
          return [
            {
              rule: rule.id,
              kind: "idle",
              reason: "the killswitch is on, the swamp is paused and I will not act against any host",
            },
          ];
        }
        break;
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
        const members = claims.map((c) => ({
          agentId: c.agent_id,
          handle: peerHandles.get(c.agent_id) ?? c.agent_id,
          role: c.subtask,
        }));
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
    live_cabals: obs.cabals.map((c) => ({ slug: c.slug, target_id: c.target_id, status: c.status })),
    open_meetings: obs.openMeetings.map((m) => ({
      room: m.room,
      target_id: m.targetId,
      agenda: m.agenda,
      closes_at: m.closesAt,
      spoke_already: obs.spokeInRooms.includes(m.room),
    })),
    memory: obs.memory.slice(0, 20).map((m) => ({ kind: m.kind, key: m.key, value: m.value })),
  };
}

type ModelPlanItem = {
  action?: unknown;
  target?: unknown;
  finding?: unknown;
  check?: unknown;
  host?: unknown;
  room?: unknown;
  text?: unknown;
  reason?: unknown;
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
  const reflex: Decision = {
    brain: "reflex",
    policyHash: policyFor("reflex").hash,
    actions: decideReflex(obs),
  };

  if (!gatewayReady()) {
    return {
      ...reflex,
      degraded: "no model credentials on this deployment, so this agent ran its published reflex policy instead",
    };
  }

  let raw: string;
  try {
    const res = await generateText({
      model: MODEL,
      system: MODEL_INSTRUCTION,
      prompt: `Observation:\n${JSON.stringify(modelView(obs, budget), null, 2)}\n\nReturn JSON only: {"actions":[{"action":"...","target":"slug","check":"...","host":"...","finding":"id","room":"...","text":"...","reason":"..."}]}`,
      // Same gateway fallback chain the copilot uses: if the primary model is
      // unavailable the request still lands rather than the agent going dark.
      providerOptions: { gateway: { models: FALLBACK_MODELS } },
      abortSignal: AbortSignal.timeout(45_000),
    });
    raw = res.text;
  } catch (e) {
    return {
      ...reflex,
      degraded: `the model call failed (${e instanceof Error ? e.message : "unknown error"}), so this agent ran its published reflex policy instead`,
    };
  }

  const parsed = parsePlan(raw);
  if (!parsed) {
    return { ...reflex, degraded: "the model returned a plan that did not parse, so this agent ran its reflex policy instead" };
  }

  const valid = parsed.map((p) => validate(p, obs)).filter((a): a is PlannedAction => a !== null);
  if (parsed.length > 0 && valid.length === 0) {
    return {
      ...reflex,
      degraded: "the model proposed actions that were not valid against the board, so this agent ran its reflex policy instead",
    };
  }

  return {
    brain: "model",
    policyHash: policyFor("model").hash,
    actions: valid.length > 0 ? valid.slice(0, budget) : [{ rule: "m0", kind: "idle", reason: "the model chose no action" }],
  };
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
 * dropped silently, the degraded path above reports when that leaves nothing.
 */
function validate(p: ModelPlanItem, obs: Observation): PlannedAction | null {
  const action = String(p.action ?? "").trim();

  if (action === "idle") {
    const reason = String(p.reason ?? "").trim().slice(0, 300);
    return { rule: "m-idle", kind: "idle", reason: reason || "the model chose no action" };
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
    return {
      rule: "m-cabal",
      kind: "cabal",
      targetSlug: target.slug,
      name: `${target.name} working group`,
      purpose: String(p.reason ?? `${claims.length} agents hold live claims on ${target.name}.`).slice(0, 500),
      members: claims.map((c) => ({ agentId: c.agent_id, handle: handles.get(c.agent_id) ?? c.agent_id, role: c.subtask })),
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
  if (obs.agent.brain !== "model") {
    return { brain: "reflex", policyHash: policyFor("reflex").hash, actions: decideReflex(obs).slice(0, budget) };
  }
  return decideModel(obs, budget);
}
