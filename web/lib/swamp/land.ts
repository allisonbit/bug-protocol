import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPath, digestOf, listChanges, type AgentChange } from "@/lib/swamp/changes";

/**
 * THE HAND THAT APPLIES AN ENDORSED CHANGE.
 *
 * `lib/swamp/changes.ts` opens the door: a resident writes a path, the complete
 * bytes that file should have, and a reason, and a peer endorses it. That module's
 * job ends there, and its own header said the rest happens "somewhere else". This
 * is that somewhere. It runs on the platform's own beat, commits with the
 * platform's own credential — never an agent's — and records the commit on the row.
 *
 * This file exists because for one day it did not, and the platform said it did.
 * The tool description every agent reads promised "the platform applies an endorsed
 * change with its own deploy credential and records the commit", the module and the
 * page and the planner's comment said the same thing, and nothing anywhere wrote
 * `landed_sha`. The first change the swarm ever proposed reached its two
 * endorsements at 10:00 on 2026-09-20 and then went quiet: the planner reads only
 * `status = 'proposed'`, on the stated premise that an endorsed change has already
 * been applied, so the swarm stopped looking at a change that no hand existed to
 * apply. A capability that is advertised in four places and implemented in none is
 * worse than one that is missing, because the swarm plans around it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DECISION IS A PURE FUNCTION AND THE COMMIT IS NOT
 * ---------------------------------------------------------------------------
 * Everything about whether a change MAY land is decided by `landDecision`, which
 * takes the change and the file that is there and returns a verdict. It touches no
 * network, so `scripts/verify-land.cjs` exercises every branch against a fake
 * repository — a guard nobody can test is a guard nobody trusts, and this
 * codebase has already paid for that lesson twice.
 *
 * The part that talks to GitHub is deliberately thin, because it is the only part
 * that can fail for reasons that are not the change's fault. A bad token must not
 * be recorded on the row as "this change cannot land": that would blame a resident
 * for the platform's outage, and the next person to read the queue would believe
 * it. Infrastructure failures come back in `failed` and leave the row alone.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILE IS READ BACK FROM GITHUB RATHER THAN TRUSTED FROM THE SNAPSHOT
 * ---------------------------------------------------------------------------
 * The door checked `base_rev` against the source snapshot this deployment was BUILT
 * from. That is the right check at proposal time and the wrong one at commit time:
 * between an endorsement and the next beat, somebody can commit to the file by hand
 * or by another door, and the bytes this change would overwrite are then not the
 * bytes its reviewer approved. So the live file is fetched from the repository and
 * the base is checked against THAT. When it no longer matches, nothing is written
 * and the reason is recorded — refusal, never a merge, exactly as the door refuses
 * rather than rebasing. The writer is told to read the file again and say what it
 * wants in the version that exists.
 */

/** Where the repository is and how to write to it. */
export type LandConfig = {
  token: string;
  repo: string;
  branch: string;
  configured: boolean;
};

/**
 * The app lives in `web/` inside this repository, so a change path is relative to
 * the web root and the commit path is not. Stating it once, here, is the difference
 * between a working commit and a 404 on every proposal somebody makes.
 */
export const LAND_ROOT = "web";

/** The most changes one pass will apply, so a burst cannot run past the beat's budget. */
export const LAND_PER_RUN = 10;

const DEFAULT_REPO = "allisonbit/bug-protocol";

/**
 * Read the credential from the environment.
 *
 * A deployment without a token is not broken, it is unarmed, and `landEndorsed`
 * says exactly that rather than reporting a quiet zero. The page and the tool
 * description both answer for that state, because the failure being repaired here
 * was a promise the platform could not keep: a claim that is true on a configured
 * deployment and false on a bare one is the same bug in a new coat.
 */
export function landConfig(env: NodeJS.ProcessEnv = process.env): LandConfig {
  const token = (env.GITHUB_LAND_TOKEN ?? "").trim();
  const repo = (env.GITHUB_LAND_REPO ?? DEFAULT_REPO).trim();
  const branch = (env.GITHUB_LAND_BRANCH ?? "master").trim();
  return { token, repo, branch, configured: Boolean(token) && /^[^/\s]+\/[^/\s]+$/.test(repo) };
}

/** Where a proposed path lives in the repository, rather than in the app. */
export function repoPath(path: string): string {
  return `${LAND_ROOT}/${path}`;
}

/**
 * A failure that is the platform's, not the change's.
 *
 * A 401 from GitHub says the credential is wrong or expired. Recording that as a
 * reason the proposal cannot land would be a lie that outlives the outage: it would
 * sit on the row and be read as a verdict on somebody's work.
 */
export class LandUnavailable extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LandUnavailable";
    this.status = status;
  }
}

/** The file as it exists in the repository right now. */
export type LiveFile = { exists: boolean; content: string | null; sha: string | null };

/** What may happen to a change, decided with no network and no database. */
export type LandVerdict = { ok: true; already: boolean } | { ok: false; error: string };

/**
 * May this change be committed to this file?
 *
 * Every branch is a fact somebody will have to act on, so every branch says what to
 * do about it. The order is not incidental: "these are already the bytes that are
 * there" is checked BEFORE the base-revision branches, because a change that landed
 * on an earlier pass — or twice, from two ticks — arrives exactly in that shape, and
 * reporting it as "you proposed a file that already exists" would be a refusal
 * invented by the platform's own success.
 */
export function landDecision(
  change: Pick<AgentChange, "path" | "content" | "sha256" | "base_rev">,
  live: LiveFile,
): LandVerdict {
  // 1. The bytes are the bytes. A reviewer endorsed a hash, not a hope, and a row
  //    edited after the fact would otherwise ship something nobody ruled on.
  if (digestOf(change.content) !== change.sha256) {
    return {
      ok: false,
      error: "The stored bytes no longer hash to the digest the reviewers endorsed, so this is not the change anybody ruled on. Nothing was written.",
    };
  }

  // 2. The allow-list is read again rather than trusted from proposal time. It is
  //    the boundary that keeps the machinery holding this deployment's credentials
  //    out of reach, and a boundary only checked at the door is one that moves
  //    silently for everything already inside it.
  const allowed = checkPath(change.path);
  if (!allowed.ok) {
    return { ok: false, error: `This path is not one the platform may write: ${allowed.error}` };
  }

  const nowDigest = live.exists && live.content != null ? digestOf(live.content) : null;

  // 3. Already true. Nothing to commit, and no reason to say anything is wrong.
  if (nowDigest != null && nowDigest === digestOf(change.content)) {
    return { ok: true, already: true };
  }

  // 4. Proposed as a new file, and a file is there now.
  if (live.exists && !change.base_rev) {
    return {
      ok: false,
      error: "It was proposed as a new file, and a file is at that path now. Nothing was written: whoever creates it decides what is in it, not a proposal written for an empty path.",
    };
  }

  // 5. Says it replaces a revision, and there is nothing there.
  if (!live.exists && change.base_rev) {
    return {
      ok: false,
      error: "It says it replaces a revision of a file that no longer exists. Nothing was written: the writer read something that has since been removed, so read what is there now and propose that.",
    };
  }

  // 6. The file moved on since the writer read it. Refusal, not a merge: a
  //    three-way guess between what a writer read, what the file says now and what
  //    the writer wants is how somebody else's work disappears under an approval
  //    that was given for a different file.
  if (nowDigest != null && change.base_rev && nowDigest !== change.base_rev) {
    return {
      ok: false,
      error: `The file has changed since this was read (it was written against ${change.base_rev.slice(0, 12)}, and it is now ${nowDigest.slice(0, 12)}). Nothing was written. Read it again with read_source and propose the version that exists.`,
    };
  }

  return { ok: true, already: false };
}

/** The commit a landing produced. */
export type LandCommit = { sha: string; url: string | null };

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "swamp-land",
    "content-type": "application/json",
  };
}

/**
 * What is at this path in the repository right now, and what does it hash to?
 *
 * The digest this returns is compared against `base_rev`, which the door computed
 * with the same function over the same bytes, so the two checks are the same
 * question asked at the two moments that matter.
 */
export async function readLiveFile(config: LandConfig, path: string): Promise<LiveFile> {
  const url = `https://api.github.com/repos/${config.repo}/contents/${encodeURI(repoPath(path))}?ref=${encodeURIComponent(config.branch)}`;
  const res = await fetch(url, { headers: headers(config.token), cache: "no-store" });
  if (res.status === 404) return { exists: false, content: null, sha: null };
  if (!res.ok) {
    throw new LandUnavailable(res.status, `GitHub answered ${res.status} reading ${repoPath(path)}.`);
  }
  const body = (await res.json()) as { type?: string; encoding?: string; content?: string; sha?: string };
  // A path that is a directory in the repository answers 200 with an array, and a
  // change naming a directory is one this hand cannot apply.
  if (body.type !== "file" || typeof body.content !== "string") {
    throw new LandUnavailable(422, `${repoPath(path)} is not a file in ${config.repo}.`);
  }
  const content = Buffer.from(body.content, "base64").toString("utf8");
  return { exists: true, content, sha: body.sha ?? null };
}

/**
 * Commit the bytes, with the credential and nobody else's.
 *
 * The message names the agent and the change, because the point of applying it with
 * the platform's credential is that the platform is accountable for it: an
 * agent-authored file in this repository has to be traceable to the agent who wrote
 * it and the row a reviewer ruled on, or "the swarm changed the site" becomes a
 * claim nobody can check.
 */
export async function commitFile(
  config: LandConfig,
  change: Pick<AgentChange, "id" | "handle" | "path" | "content" | "reason">,
  live: LiveFile,
): Promise<LandCommit> {
  const message = [
    `${change.path}: a change proposed by @${change.handle}`,
    "",
    change.reason,
    "",
    `Proposed through the change door, endorsed by peers, applied by the platform.`,
    `Change-Id: ${change.id}`,
  ].join("\n");

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(change.content, "utf8").toString("base64"),
    branch: config.branch,
  };
  // GitHub refuses an update without the blob sha it is replacing, which is the
  // repository enforcing the same thing this module checks: you may not overwrite
  // what you have not read.
  if (live.exists && live.sha) body.sha = live.sha;

  const res = await fetch(`https://api.github.com/repos/${config.repo}/contents/${encodeURI(repoPath(change.path))}`, {
    method: "PUT",
    headers: headers(config.token),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LandUnavailable(res.status, `GitHub answered ${res.status} writing ${repoPath(change.path)}. ${detail.slice(0, 300)}`);
  }
  const out = (await res.json()) as { commit?: { sha?: string; html_url?: string } };
  const sha = out.commit?.sha;
  if (!sha) throw new LandUnavailable(502, `GitHub accepted the write to ${repoPath(change.path)} without returning a commit.`);
  return { sha, url: out.commit?.html_url ?? null };
}

export type LandReport = {
  configured: boolean;
  /** True when nothing was written: the pass decided and said so, and stopped there. */
  dry: boolean;
  considered: number;
  landed: { id: string; path: string; handle: string; sha: string | null; url: string | null }[];
  already: { id: string; path: string; handle: string }[];
  refused: { id: string; path: string; handle: string; error: string }[];
  failed: { id: string; path: string; error: string }[];
};

/** Put an event on the bus so the swarm and the feed see the platform change. */
async function emitChangeEvent(
  sb: SupabaseClient,
  topic: "change.landed" | "change.refused",
  change: AgentChange,
  extra: Record<string, unknown>,
): Promise<void> {
  const payload = {
    path: change.path,
    handle: change.handle,
    sha256: change.sha256,
    reason: change.reason,
    bytes: Buffer.byteLength(change.content, "utf8"),
    ...extra,
    text: `${change.path}`,
  };
  await sb
    .from("events")
    .insert({
      topic,
      agent_id: change.agent_id,
      agent_handle: change.handle,
      target_id: null,
      target_slug: null,
      finding_id: null,
      room: null,
      thread_id: null,
      parent_seq: null,
      payload,
      signature: null,
      signed_ok: false,
      provenance: "system",
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

/**
 * Apply every endorsed change that can be applied, and say what became of the rest.
 *
 * Oldest first, because this is a queue and not a pile. One change at a time,
 * because two commits to the same file in one pass is a conflict this code would
 * otherwise have to resolve, and resolving it would mean choosing which of two
 * endorsed intents to discard.
 */
export async function landEndorsed(
  sb: SupabaseClient,
  opts: { limit?: number; config?: LandConfig; dry?: boolean } = {},
): Promise<LandReport> {
  const config = opts.config ?? landConfig();
  const dry = Boolean(opts.dry);
  const report: LandReport = {
    configured: config.configured,
    dry,
    considered: 0,
    landed: [],
    already: [],
    refused: [],
    failed: [],
  };
  if (!config.configured) return report;

  // 40 read to apply at most 10: the list is newest first, and a queue is served
  // oldest first, so a pass that took the newest ten would starve the oldest.
  const endorsed = await listChanges(sb, { status: "endorsed", limit: 40 });
  const queue = endorsed
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, Math.min(Math.max(opts.limit ?? LAND_PER_RUN, 1), LAND_PER_RUN));
  report.considered = queue.length;

  for (const change of queue) {
    let live: LiveFile;
    try {
      live = await readLiveFile(config, change.path);
    } catch (e) {
      report.failed.push({ id: change.id, path: change.path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const verdict = landDecision(change, live);
    if (!verdict.ok) {
      report.refused.push({ id: change.id, path: change.path, handle: change.handle, error: verdict.error });
      // Only when it is news. A change that cannot land stays endorsed and is
      // offered again next beat, and an event every hour saying the same sentence
      // is how a real refusal gets lost in the repeat of an old one.
      if (!dry && change.land_note !== verdict.error) {
        await sb
          .from("agent_changes")
          .update({ land_note: verdict.error, updated_at: new Date().toISOString() })
          .eq("id", change.id)
          .then(
            () => undefined,
            () => undefined,
          );
        await emitChangeEvent(sb, "change.refused", change, { note: verdict.error });
      }
      continue;
    }

    const now = new Date().toISOString();
    if (verdict.already) {
      const note = "The bytes this change proposes were already at that path when the platform looked, so nothing was committed: there was nothing to change. That is what a change landed on an earlier pass looks like.";
      report.already.push({ id: change.id, path: change.path, handle: change.handle });
      if (dry) continue;
      await sb
        .from("agent_changes")
        .update({ status: "landed", landed_at: now, updated_at: now, land_note: note })
        .eq("id", change.id)
        .eq("status", "endorsed")
        .then(
          () => undefined,
          () => undefined,
        );
      continue;
    }

    // A dry pass stops at the verdict: the whole point of it is to be run against a
    // deployment to see what it thinks before letting it write, so committing here
    // would defeat the only reason the flag exists.
    if (dry) {
      report.landed.push({ id: change.id, path: change.path, handle: change.handle, sha: null, url: null });
      continue;
    }

    let commit: LandCommit;
    try {
      commit = await commitFile(config, change, live);
    } catch (e) {
      report.failed.push({ id: change.id, path: change.path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    // The commit happened, so everything after this records a fact rather than
    // deciding one. The conditional update is what stops two passes from both
    // claiming the same change; when it matches nothing, a verdict moved the row
    // while the bytes were in flight, and what a reader needs to know is that the
    // file is there — which is exactly what the fallback writes.
    const claim = { status: "landed", landed_sha: commit.sha, landed_at: now, updated_at: now, land_note: null };
    const { data: claimed } = await sb
      .from("agent_changes")
      .update(claim)
      .eq("id", change.id)
      .eq("status", "endorsed")
      .select("id");
    if (!claimed || claimed.length === 0) {
      await sb
        .from("agent_changes")
        .update({
          status: "landed",
          landed_sha: commit.sha,
          landed_at: now,
          updated_at: now,
          land_note: `A peer's verdict moved this row while the commit was in flight. The bytes are in the repository as ${commit.sha.slice(0, 12)}; the verdicts on this change are still recorded and still readable.`,
        })
        .eq("id", change.id)
        .then(
          () => undefined,
          () => undefined,
        );
    }
    report.landed.push({ id: change.id, path: change.path, handle: change.handle, sha: commit.sha, url: commit.url });
    await emitChangeEvent(sb, "change.landed", change, { sha: commit.sha, url: commit.url });
  }

  return report;
}
