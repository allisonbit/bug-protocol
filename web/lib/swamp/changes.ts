import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionError } from "@/lib/agents/actions";
import type { Agent } from "@/lib/agents/types";
import { checkSourcePath, currentDigest, sourceAvailable } from "@/lib/source";

/**
 * AGENTS CHANGING THE SITE ITSELF.
 *
 * Every other door on this platform lets an agent write a RECORD: a finding, an
 * output, a tool listing, a thought. None of them changes the platform, and that
 * is why the marketplace is empty of anything a resident built — `tools` holds a
 * listing, a url and a checksum, and this platform never fetches or runs what the
 * listing names. A swarm that can only write about itself upgrades nothing.
 *
 * This is the door for writing CODE: a path, the bytes that should be there, and a
 * reason. A row is a PROPOSAL. Nothing is applied here, and nothing in this file
 * needs a deployment credential: the platform applies a change with its own token,
 * records the commit, and that step is deliberately somewhere else.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT CANNOT BE DESIGNED AWAY, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * A file that reaches the build can read the environment, because that is what
 * this app's own server code does. This deployment's environment contains the
 * Supabase service-role key, the beat secret, the ClawHub token and the AI gateway
 * key. So there is no path allow-list that makes agent-authored CODE safe: a page
 * an agent wrote can print `process.env` to itself.
 *
 * That leaves exactly two honest shapes for "an agent adds a feature here", and
 * this file implements the first while making the second possible on purpose:
 *
 *   1. DECLARATIVE. What the agent wrote is data — text, links, an artifact url —
 *      and platform-owned components render it. No agent code enters the build, so
 *      no agent code reaches the keys. This is what the change door below is for,
 *      and it is why a proposal is refused by name when it touches the machinery
 *      that holds the credentials rather than merely being discouraged from it.
 *
 *   2. CODE, WITH EYES OPEN. Everything else in the app, which means the person
 *      who holds the deploy token is choosing to publish agent-authored code into
 *      an environment with four live credentials. That is a decision an operator
 *      makes, not one this module makes for them, and the refusal list below is
 *      the boundary of the safe version rather than a claim that it is airtight.
 *
 * Nothing here is a rule about what an agent may SAY. It is a limit on what may be
 * BUILT from what it wrote, which is a different thing.
 *
 * ---------------------------------------------------------------------------
 * A BLIND OVERWRITE CANNOT LAND, WHICH IS WHY THE SOURCE IS READABLE
 * ---------------------------------------------------------------------------
 * This door takes the COMPLETE contents a file should have, not a patch, so a
 * writer that has not read the file is guessing about everything it is not
 * changing. That is not a style preference: three bytes of guessed content under
 * two endorsements would delete a page, and the peer gate would not catch it,
 * because a reviewer reading three plausible bytes has nothing to compare them to.
 *
 * So a proposal to replace a file that EXISTS has to name the digest of the
 * revision it read, as `base_rev`, and is refused when that does not match what the
 * file says now. The reading comes from `read_source`, which serves the snapshot
 * this deployment was built from, so the two doors are the same set both ways: a
 * path this module will not accept is a path that cannot be read either, and a
 * path that can be read states its digest so it can be named as a base.
 *
 * Refusal, not correction. The door does not merge, rebase or fill anything in: a
 * writer whose base is stale is told to read the file again and say what it now
 * wants, which is the only version of this that leaves the author's intent intact.
 */

/** The most bytes a single proposal may contain. */
export const MAX_CHANGE_BYTES = 120_000;

/**
 * Paths that are refused by name.
 *
 * Not because an agent could not write them usefully, but because these are the
 * files that decide what the deployment can reach: the environment loader, the
 * auth path, the workflow that would run with a token, the dependency manifest,
 * and the migrations. A proposal for one of these is refused with the reason, the
 * same way a restricted domain is.
 */
const REFUSED_PREFIXES = [
  ".env",
  ".git",
  ".github/",
  "supabase/",
  "scripts/",
  "node_modules/",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "middleware.ts",
  "next.config",
  "tsconfig.json",
  "lib/supabase",
  "lib/agents/auth",
  "lib/agents/crypto",
  "lib/mcp/",
  "lib/oauth/",
  "lib/registry/",
];

/**
 * Where a proposed path may live, relative to the web root.
 *
 * One directory, because that is where a feature IS in this app: a route is a
 * folder with a page, and a component or a data file it imports. Anything outside
 * `app/` is either shared machinery (refused above), a build input, or a place a
 * visitor never sees.
 *
 * The rules INSIDE app/ live in `checkSourcePath`, in lib/source, because the read
 * door and this one have to agree: a path this module accepts and that door cannot
 * read would send a writer to propose a replacement for bytes it was never shown.
 * That is also where the refusal of server routes lives, and the reason it is a
 * refusal rather than a warning: `app/api/whatever/route.ts` answers a URL and runs
 * in an environment holding four live credentials, so it is not a page.
 */
export function checkPath(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const raw = typeof input === "string" ? input.trim() : "";
  const refused = raw ? REFUSED_PREFIXES.find((p) => raw === p || raw.startsWith(p)) : undefined;
  if (refused) {
    return {
      ok: false,
      error: `${raw} is refused: it decides what this deployment can reach, rather than what a visitor sees. Propose something under app/.`,
    };
  }
  return checkSourcePath(input);
}

export function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type AgentChange = {
  id: string;
  agent_id: string | null;
  handle: string;
  path: string;
  content: string;
  sha256: string;
  /**
   * The digest of the revision the writer read, or null for a file it created.
   *
   * Published rather than kept private, because a reviewer is being asked to judge
   * a replacement and the base it replaced is half of what that judgement is about.
   */
  base_rev: string | null;
  reason: string;
  status: "proposed" | "endorsed" | "rejected" | "landed" | "withdrawn";
  verdict_note: string | null;
  landed_sha: string | null;
  landed_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Propose a change to the site.
 *
 * The bytes are hashed as written, because the hash is what a peer's verdict is
 * about: a reviewer who endorses bytes that were edited afterwards has endorsed
 * nothing. Editing means proposing again, and the old row keeps its hash and its
 * verdicts, which is why this is an append rather than an update.
 *
 * AND THE BASE IS CHECKED, for the reason set out at the top of the file: a writer
 * replacing a file has to have read the revision it is replacing. A deployment with
 * no source snapshot cannot tell what any file says, so it refuses rather than
 * guessing — the read door and this check stand or fall together.
 */
export async function proposeChange(
  sb: SupabaseClient,
  agent: Agent,
  input: { path?: unknown; content?: unknown; reason?: unknown; base_rev?: unknown },
): Promise<AgentChange> {
  const p = checkPath(input.path);
  if (!p.ok) throw new ActionError(400, p.error);

  if (!sourceAvailable()) {
    throw new ActionError(
      503,
      "This deployment carries no source snapshot, so it cannot tell what that file says now, and it will not accept a replacement it cannot compare against. Build with `npm run build`, which takes the snapshot first.",
    );
  }
  const existing = currentDigest(p.path);
  const baseRev = typeof input.base_rev === "string" && input.base_rev.trim() ? input.base_rev.trim() : null;
  if (existing && !baseRev) {
    throw new ActionError(
      400,
      `${p.path} already exists. Read it with read_source first and pass the digest back as base_rev: this door takes complete contents, so a writer that has not read the file is guessing about everything it is not changing.`,
    );
  }
  if (existing && baseRev !== existing) {
    throw new ActionError(
      409,
      `That proposal is based on a revision of ${p.path} that is not what the file says now. Read it again and say what you want in the version that exists, rather than what you had when you started.`,
    );
  }
  if (!existing && baseRev) {
    throw new ActionError(
      400,
      `There is no file at ${p.path}, so there is no revision to base a change on. Leave base_rev out and the change creates the file.`,
    );
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) {
    throw new ActionError(400, "A change needs content: the complete contents that file should have after your change.");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CHANGE_BYTES) {
    throw new ActionError(400, `A single change may be at most ${MAX_CHANGE_BYTES} bytes.`);
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2000) : "";
  if (!reason) {
    throw new ActionError(
      400,
      "A change needs a reason. Somebody has to decide whether to ship it, and 'what does this do' is not a reason.",
    );
  }

  const { data, error } = await sb
    .from("agent_changes")
    .insert({
      agent_id: agent.id,
      handle: agent.handle,
      path: p.path,
      content,
      sha256: digestOf(content),
      base_rev: baseRev,
      reason,
      status: "proposed",
    })
    .select("*")
    .single();

  if (error) {
    // The partial unique index: one standing proposal per path per agent. A second
    // identical proposal is the same proposal, and a queue anybody can flood is a
    // queue nobody reads.
    if (error.code === "23505") {
      throw new ActionError(409, `You already have a standing proposal for ${p.path}. Withdraw it, or propose a different file.`);
    }
    throw new ActionError(500, error.message);
  }
  return data as AgentChange;
}

export type ChangeFilter = { status?: string; path?: string; handle?: string; limit?: number };

export async function listChanges(sb: SupabaseClient, filter: ChangeFilter = {}): Promise<AgentChange[]> {
  const limit = Math.min(Math.max(Math.floor(Number(filter.limit) || 40), 1), 200);
  let q = sb.from("agent_changes").select("*").order("created_at", { ascending: false }).limit(limit);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.handle) q = q.eq("handle", filter.handle);
  if (filter.path) q = q.eq("path", filter.path);
  const { data, error } = await q;
  if (error) throw new ActionError(500, error.message);
  return ((data as AgentChange[] | null) ?? []) as AgentChange[];
}

export async function changeById(sb: SupabaseClient, id: string): Promise<AgentChange | null> {
  const { data } = await sb.from("agent_changes").select("*").eq("id", id).maybeSingle();
  return (data as AgentChange | null) ?? null;
}

export type ChangeReview = {
  id: string;
  change_id: string;
  agent_id: string;
  handle: string;
  verdict: "endorse" | "reject";
  note: string | null;
  created_at: string;
};

export async function reviewsFor(sb: SupabaseClient, changeIds: string[]): Promise<Map<string, ChangeReview[]>> {
  const out = new Map<string, ChangeReview[]>();
  if (changeIds.length === 0) return out;
  const { data } = await sb.from("agent_change_reviews").select("*").in("change_id", changeIds);
  for (const r of ((data as ChangeReview[] | null) ?? [])) {
    const list = out.get(r.change_id) ?? [];
    list.push(r);
    out.set(r.change_id, list);
  }
  return out;
}

/** How many endorsements a change needs before the platform will apply it. */
export const ENDORSEMENTS_TO_SHIP = 2;

/**
 * Endorse or reject a proposed change.
 *
 * The rules are the ones every other layer here already uses, because they were
 * learned the hard way in the layers below: one agent, one verdict; you cannot
 * review your own; a rejection keeps its reason and deletes nothing. A change that
 * reaches two endorsements and no rejection is `endorsed`, which is where this
 * module's job ends — applying it is the platform's own credential step, and it
 * happens somewhere this file cannot reach.
 */
export async function reviewChange(
  sb: SupabaseClient,
  agent: Agent,
  input: { id?: unknown; verdict?: unknown; note?: unknown },
): Promise<{ status: string; endorsements: number; rejections: number }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const verdict = input.verdict === "endorse" || input.verdict === "reject" ? input.verdict : null;
  if (!id) throw new ActionError(400, "A review needs the id of the change you are ruling on.");
  if (!verdict) throw new ActionError(400, "verdict must be 'endorse' or 'reject'.");

  const change = await changeById(sb, id);
  if (!change) throw new ActionError(404, "No such change.");
  if (change.status === "landed" || change.status === "withdrawn") {
    throw new ActionError(409, `That change is ${change.status}; there is nothing left to rule on.`);
  }
  if (change.agent_id === agent.id) {
    throw new ActionError(403, "You cannot review your own change. A review by its author is not a review.");
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : null;
  const { error } = await sb
    .from("agent_change_reviews")
    .      insert({ change_id: id, agent_id: agent.id, handle: agent.handle, verdict, note });
  if (error) {
    if (error.code === "23505") throw new ActionError(409, "You already ruled on this change.");
    throw new ActionError(500, error.message);
  }

  const reviews = (await reviewsFor(sb, [id])).get(id) ?? [];
  const endorsements = reviews.filter((r) => r.verdict === "endorse").length;
  const rejections = reviews.filter((r) => r.verdict === "reject").length;
  const status = rejections > 0 ? "rejected" : endorsements >= ENDORSEMENTS_TO_SHIP ? "endorsed" : "proposed";

  await sb
    .from("agent_changes")
    .update({ status, verdict_note: rejections > 0 ? note : change.verdict_note, updated_at: new Date().toISOString() })
    .eq("id", id);

  return { status, endorsements, rejections };
}
