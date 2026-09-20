import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { beatAuthorized } from "@/lib/beat";
import {
  MOLTBOOK_ENGAGE_BACKOFF_MINUTES,
  MOLTBOOK_ENGAGE_MIN_INTERVAL_MINUTES,
  moltbookCommentVisible,
  moltbookConfigured,
  moltbookSearch,
  moltbookStatus,
  publishComment,
  type MoltbookPostResult,
} from "@/lib/moltbook";
import {
  MOLTBOOK_ENGAGE_MIN_SCORE,
  MOLTBOOK_INTENT_QUERIES,
  classifyIntent,
  composeReply,
  scoreCandidate,
  type ThemeMatch,
} from "@/lib/moltbook-listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/moltbook/engage — answer one conversation that wants a home.
 *
 * WHAT IT DOES. It searches Moltbook for the intent (an agent saying it is
 * lonely, that nobody replies, that agents cannot talk to each other, that it
 * wants to belong, or that it is looking for other agents), scores what comes
 * back, and leaves ONE reply on the best conversation that has not been answered
 * before. It posts nowhere else: there is no fallback to a feed, and a run that
 * finds nothing answers nothing.
 *
 * WHY ONE, AND WHY IT IS SLOW. A reply is only welcome where it is on topic, so
 * the listener would rather do nothing than reach. It also shares the swamp's
 * one Moltbook identity, and Moltbook treats spam as a ban: a banned agent
 * carries nobody in. So it answers one conversation per call and refuses inside
 * the interval, and it is meant to be driven on a cadence, not hammered.
 *
 * AUTHORISATION is the platform's own — the same CRON_SECRET / SWAMP_BEAT_SECRET
 * the rest of the beat lives under.
 *
 *   ?dry=1    show which conversation would be answered and the exact reply,
 *             send nothing (needs no claim and ignores the interval)
 *   ?force=1  ignore the interval for a manual nudge
 */
async function gatherCandidates(): Promise<Map<string, MoltbookPostResult>> {
  const found = new Map<string, MoltbookPostResult>();
  for (const q of MOLTBOOK_INTENT_QUERIES) {
    const results = await moltbookSearch(q, 20);
    for (const r of results) {
      if (!r.id || found.has(r.id)) continue;
      found.set(r.id, r);
    }
  }
  return found;
}

export async function GET(req: Request) {
  // Strict, like the outbox: a GET replies into a Moltbook thread under the
  // operator's key, so an unconfigured deployment must refuse rather than answer.
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";

  if (!moltbookConfigured()) {
    return NextResponse.json({
      ok: true,
      skipped: "unconfigured",
      note: "Set MOLTBOOK_API_KEY to the agent token registration returned, then the listener can reply.",
    });
  }
  if (!SUPABASE_CONFIGURED) return NextResponse.json({ ok: true, skipped: "backend not configured" });
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ ok: true, skipped: "backend not configured" });

  // 1. What has already been answered, and when — both read from the one ledger.
  const { data: rows } = await sb
    .from("moltbook_engagements")
    .select("post_id, created_at, status")
    .order("created_at", { ascending: false })
    .limit(1000);
  const ledger = (rows as { post_id: string; created_at: string; status: string }[] | null) ?? [];
  const engaged = new Set(ledger.map((r) => r.post_id));
  const lastAt = ledger[0]?.created_at ?? null;

  // 2. Our own name, so the listener never answers itself.
  const status = await moltbookStatus().catch(() => null);
  const self = status?.agent ?? null;

  // 3. Every conversation the queries surface, deduped, filtered and scored.
  const candidates = await gatherCandidates();
  const scored: { post: MoltbookPostResult; match: ThemeMatch; score: number }[] = [];
  for (const post of candidates.values()) {
    if (engaged.has(post.id)) continue;
    if (self && post.author === self) continue;
    const match = classifyIntent(post);
    if (!match) continue;
    const score = scoreCandidate(post, match);
    if (score < MOLTBOOK_ENGAGE_MIN_SCORE) continue;
    scored.push({ post, match, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || b.post.relevance - a.post.relevance ||
      Date.parse(b.post.created_at ?? "0") - Date.parse(a.post.created_at ?? "0"),
  );

  if (scored.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: "nothing-relevant",
      note: "No conversation expressed the intent this run, so nothing was answered.",
      scanned: candidates.size,
    });
  }

  const pick = scored[0];
  // The reply names the swamp's own handle rather than linking out: a comment
  // full of URLs is what Moltbook's moderation reads as spam.
  const content = composeReply(pick.post, pick.match, self ?? "swampprotocol");
  const postUrl = pick.post.url ? `https://www.moltbook.com${pick.post.url}` : null;

  if (dry) {
    return NextResponse.json({
      ok: true,
      dry: true,
      postId: pick.post.id,
      author: pick.post.author,
      submolt: pick.post.submolt,
      title: pick.post.title,
      theme: pick.match.theme.key,
      score: pick.score,
      content,
      alsoFound: scored.length - 1,
    });
  }

  // 3b. If the last reply was not published, stop. Trying another post would
  //     only repeat the rejection, and repeated rejections risk a spam flag that
  //     ends the bridge; so a rejection buys silence.
  const last = ledger[0];
  if (last?.status === "failed" && !force) {
    const sinceMin = (Date.now() - Date.parse(last.created_at)) / 60_000;
    if (sinceMin < MOLTBOOK_ENGAGE_BACKOFF_MINUTES) {
      return NextResponse.json({
        ok: true,
        skipped: "backing-off",
        reason: "the last reply was accepted but not published by Moltbook moderation",
        minutesRemaining: Math.ceil(MOLTBOOK_ENGAGE_BACKOFF_MINUTES - sinceMin),
        wouldReply: { postId: pick.post.id, title: pick.post.title, theme: pick.match.theme.key },
      });
    }
  }

  // 4. Only a claimed Moltbook agent may write a comment.
  if (!status || status.status !== "claimed") {
    return NextResponse.json({
      ok: true,
      skipped: "unclaimed",
      agent: status?.agent ?? null,
      claimUrl: status?.claimUrl ?? null,
      wouldReply: { postId: pick.post.id, title: pick.post.title, theme: pick.match.theme.key },
    });
  }

  // 5. The engagement interval. A reply and a post are different acts, so this is
  //    its own clock; the last ENGAGEMENT is what it measures.
  if (lastAt && !force) {
    const sinceMin = (Date.now() - Date.parse(lastAt)) / 60_000;
    if (sinceMin < MOLTBOOK_ENGAGE_MIN_INTERVAL_MINUTES) {
      return NextResponse.json({
        ok: true,
        skipped: "cooldown",
        minutesRemaining: Math.ceil(MOLTBOOK_ENGAGE_MIN_INTERVAL_MINUTES - sinceMin),
        wouldReply: { postId: pick.post.id, title: pick.post.title, theme: pick.match.theme.key },
      });
    }
  }

  const result = await publishComment({ postId: pick.post.id, content });

  // 6. Prove it landed before claiming it did. Moltbook moderates AFTER the
  //    create, so an accepted reply can be flagged spam and never appear; the
  //    only honest proof is finding it readable on the post. A reply that is not
  //    readable is recorded as failed, and the post is still marked answered so
  //    it is never spammed with a second attempt.
  let published = false;
  if (result.ok && result.postId) {
    published = await moltbookCommentVisible(pick.post.id, result.postId);
  }

  const ledgerStatus = published ? "replied" : "failed";
  if (result.postId !== null || result.ok) {
    await sb.from("moltbook_engagements").insert({
      post_id: pick.post.id,
      post_title: pick.post.title,
      post_url: postUrl,
      submolt: pick.post.submolt,
      author: pick.post.author,
      theme: pick.match.theme.key,
      comment: content,
      moltbook_comment_id: result.postId,
      status: ledgerStatus,
    });
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, postId: pick.post.id, theme: pick.match.theme.key, error: result.error, retryable: result.retryable },
      { status: 200 },
    );
  }
  if (!published) {
    return NextResponse.json(
      {
        ok: false,
        postId: pick.post.id,
        theme: pick.match.theme.key,
        error: "accepted but not readable on the post — Moltbook moderation did not publish it",
        retryable: false,
      },
      { status: 200 },
    );
  }
  return NextResponse.json({
    ok: true,
    repliedTo: pick.post.id,
    author: pick.post.author,
    submolt: pick.post.submolt,
    theme: pick.match.theme.key,
    commentId: result.postId,
    alsoFound: scored.length - 1,
  });
}

export const POST = GET;
