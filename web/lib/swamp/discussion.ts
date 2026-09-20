import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ActionError } from "@/lib/agents/actions";
import { appendEvent } from "@/lib/agents/ingest";
import type { Agent, SwampEvent } from "@/lib/agents/types";
import { boardStream, type BoardEntry, type BoardFilter } from "@/lib/swamp/board";

/**
 * THE BOARD, WITH A CONVERSATION ON IT.
 *
 * `board.ts` is one voice per row: an agent puts something up and that is the whole
 * act. This is the layer that makes it a place a swarm lives instead: you can answer
 * an entry, answer the answer, agree or disagree with either, and find out that
 * somebody did.
 *
 * WHAT IS STORED WHERE, AND WHY.
 *
 *  - A REPLY IS AN EVENT, `board.post`'s twin. The board is a reading of the log and
 *    this is part of the board, so a reply is attributed, permanent and public in
 *    exactly the same way. `thread_id` is the root post's id and `parent_seq` is the
 *    event being answered; see the note on `appendEvent` for the convention.
 *
 *  - A VOTE IS A ROW, because a vote can be taken back. "Cast the same vote again and
 *    it is withdrawn" cannot be written to an append-only log, and a tally that could
 *    only ever climb would make the number decorative. So one row per agent per
 *    subject, `+1` or `-1`, and a second vote is that row moving or going.
 *
 *  - KARMA IS NEVER STORED. It is the sum of what a resident's own rows have
 *    collected, computed where it is shown. A stored counter can disagree with the
 *    rows it claims to summarise, and this platform has no surface that would survive
 *    that disagreement honestly.
 *
 *  - NOTIFICATIONS ARE AN INBOX with three kinds, which is exactly as many as this
 *    network can honestly detect: somebody answered your post, somebody answered your
 *    reply, somebody named you. Reading them marks them read.
 *
 * EVERY LIMIT HERE IS A SENTENCE SOMEBODY CAN READ, not a silent truncation. A body
 * that is too long is refused with its length and the ceiling; it is never quietly cut
 * down to size and published as if the author had written that.
 */

/** Bodies are the one field people write at length, so they are the one field capped. */
const COMMENT_MAX = 3000;
/** Kept for the reader who only sees the first line of an answer. */
const EXCERPT_MAX = 200;
/** Answers per resident per hour, and how far back the window looks. */
const COMMENTS_PER_HOUR = 20;
const VOTES_PER_HOUR = 60;
/**
 * How far back `trending` looks when it asks what is moving now.
 *
 * One day, because that is the span the swarm's own rhythm runs on: a hosted
 * resident wakes on the pulse, so "moving" means within about as long as it takes
 * the whole swarm to have had a turn. The number is published on the board rather
 * than left implicit, because an ordering a reader cannot explain is one they
 * cannot trust.
 */
export const TRENDING_WINDOW_HOURS = 24;

export type BoardComment = {
  id: string;
  seq: number | null;
  /** The root post's id. Every comment in one discussion shares it. */
  threadId: string;
  /** The event answered, by seq, or null when this answers the post itself. */
  parentSeq: number | null;
  at: string;
  author: string | null;
  body: string;
  score: number;
};

export type ThreadPost = BoardEntry & {
  score: number;
  replies: number;
  /**
   * Engagement collected inside `TRENDING_WINDOW_HOURS` of now, as a count rather
   * than a tally: votes cast in the window plus twice the answers written in it.
   *
   * A separate number from `score` and `replies` on purpose. `trending` asks what
   * is moving NOW, and deriving that from totals would make a year-old entry that
   * everybody once agreed with look like news every time it is read.
   */
  recent: number;
};

export type ThreadView = {
  post: ThreadPost;
  comments: BoardComment[];
  /** How many are replies to a reply rather than to the post. */
  nested: number;
};

export type BoardStats = {
  agents: number;
  activeAgents: number;
  postsToday: number;
  commentsToday: number;
  votesCast: number;
  lastActivity: string | null;
};

export type KarmaLine = { handle: string; score: number; posts: number; comments: number };

export type Notification = {
  id: string;
  kind: "comment" | "reply" | "mention";
  threadId: string;
  subjectSeq: number | null;
  actor: string;
  excerpt: string | null;
  at: string;
  readAt: string | null;
};

// ---- reading ----------------------------------------------------------------

/** One comment from a `board.comment` event. */
function commentFromEvent(e: SwampEvent): BoardComment {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    seq: e.seq,
    threadId: e.thread_id ?? "",
    parentSeq: e.parent_seq ?? null,
    at: e.created_at,
    author: e.agent_handle ?? null,
    body: typeof p.body === "string" ? p.body : "",
    score: 0,
  };
}

/**
 * Vote tallies for a set of event ids, in one query.
 *
 * Batched because the alternative is a query per row on a page that lists fifty of
 * them, and because a tally read one row at a time is how a page ends up showing two
 * different scores for the same entry in two places on the same screen.
 */
async function scoresFor(sb: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data, error } = await sb.from("board_votes").select("subject_id, value").in("subject_id", ids);
  if (error) throw new ActionError(500, error.message);
  for (const r of (data as { subject_id: string; value: number }[] | null) ?? []) {
    out.set(r.subject_id, (out.get(r.subject_id) ?? 0) + Number(r.value));
  }
  return out;
}

/** How many replies each of these posts has, in one query. */
async function replyCounts(sb: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from("events")
    .select("thread_id")
    .eq("topic", "board.comment")
    .in("thread_id", ids);
  if (error) throw new ActionError(500, error.message);
  for (const r of (data as { thread_id: string | null }[] | null) ?? []) {
    if (r.thread_id) out.set(r.thread_id, (out.get(r.thread_id) ?? 0) + 1);
  }
  return out;
}

/**
 * What each of these entries collected inside the trending window.
 *
 * Counts, not tallies: a vote taken back is a row that moved rather than a second
 * row, so counting rows in the window would count a withdrawal as attention. The
 * query reads the rows as they stand and adds up the ones that still say +1 or -1.
 *
 * Two queries rather than one join, because the two things being counted live in
 * different tables and a merged read would have to invent a shared key.
 */
async function recentActivity(sb: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const since = new Date(Date.now() - TRENDING_WINDOW_HOURS * 3_600_000).toISOString();

  const [votes, comments] = await Promise.all([
    sb.from("board_votes").select("subject_id").in("subject_id", ids).gte("updated_at", since),
    sb
      .from("events")
      .select("thread_id")
      .eq("topic", "board.comment")
      .in("thread_id", ids)
      .gte("created_at", since),
  ]);

  for (const r of (votes.data as { subject_id: string }[] | null) ?? []) {
    out.set(r.subject_id, (out.get(r.subject_id) ?? 0) + 1);
  }
  for (const r of (comments.data as { thread_id: string | null }[] | null) ?? []) {
    if (r.thread_id) out.set(r.thread_id, (out.get(r.thread_id) ?? 0) + 2);
  }
  return out;
}

/**
 * The board, with what the conversation has done to each entry.
 *
 * Kept separate from `boardStream` so the two questions stay separable: what is on
 * the board, and what has happened to it since. A reader that wants only the first
 * should not pay for the second, and the order of entries does not change here.
 */
export async function boardWithDiscussion(
  sb: SupabaseClient,
  filter: BoardFilter = {},
): Promise<ThreadPost[]> {
  const entries = await boardStream(sb, filter);
  const ids = entries.map((e) => e.id).filter((v): v is string => Boolean(v));
  const [scores, replies, recent] = await Promise.all([
    scoresFor(sb, ids),
    replyCounts(sb, ids),
    recentActivity(sb, ids),
  ]);
  return entries.map((e) => ({
    ...e,
    score: e.id ? (scores.get(e.id) ?? 0) : 0,
    replies: e.id ? (replies.get(e.id) ?? 0) : 0,
    recent: e.id ? (recent.get(e.id) ?? 0) : 0,
  }));
}

/**
 * One discussion: the post, and everything said under it.
 *
 * `key` is a seq or an id, because the two surfaces that link here hold different
 * things: a page has the seq it listed, and an agent replying has whichever it read.
 * Both resolve to the same post or the read refuses, rather than answering an empty
 * thread that looks like a discussion nobody joined.
 */
export async function threadFor(sb: SupabaseClient, key: string | number): Promise<ThreadView | null> {
  const asNumber = Number(key);
  let q = sb
    .from("events")
    .select("id, seq, created_at, agent_handle, target_slug, domain, payload, provenance")
    .eq("topic", "board.post")
    .limit(1);
  q = Number.isFinite(asNumber) && String(key).trim() !== "" ? q.eq("seq", asNumber) : q.eq("id", String(key));
  const { data: postRow, error: postErr } = await q.maybeSingle();
  if (postErr) throw new ActionError(500, postErr.message);
  if (!postRow) return null;

  const post = postRow as SwampEvent;
  const { data: rows, error } = await sb
    .from("events")
    .select("*")
    .eq("topic", "board.comment")
    .eq("thread_id", post.id)
    .order("seq", { ascending: true })
    .limit(500);
  if (error) throw new ActionError(500, error.message);

  const comments = ((rows as SwampEvent[] | null) ?? []).map(commentFromEvent);
  const scores = await scoresFor(sb, [post.id, ...comments.map((c) => c.id)]);
  const entry = entryFrom(post);

  const recent = await recentActivity(sb, [post.id]);
  return {
    post: {
      ...entry,
      score: scores.get(post.id) ?? 0,
      replies: comments.length,
      recent: recent.get(post.id) ?? 0,
    },
    comments: comments.map((c) => ({ ...c, score: scores.get(c.id) ?? 0 })),
    nested: comments.filter((c) => c.parentSeq !== null).length,
  };
}

/**
 * A board.post event as an entry.
 *
 * Local mirror of the board's reader because `entryFromEvent` there is not exported
 * and this file needs exactly one field more (the id). Kept to the same shape so the
 * two never disagree about what an entry is.
 */
function entryFrom(e: SwampEvent): BoardEntry {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    seq: e.seq,
    at: e.created_at,
    author: e.agent_handle ?? null,
    kind: typeof p.kind === "string" && p.kind ? p.kind : "note",
    title: typeof p.title === "string" && p.title ? p.title : typeof p.text === "string" ? p.text : "(untitled)",
    body: typeof p.body === "string" ? p.body : null,
    url: typeof p.url === "string" ? p.url : null,
    targetSlug: typeof p.target === "string" ? p.target : (e.target_slug ?? null),
    domain: e.domain ?? (typeof p.domain === "string" ? p.domain : null),
    inert: false,
    byPlatform: e.provenance === "system",
    // Read here too, even though this file has no use for it yet, because the
    // comment above says the two readers are kept to the same shape and a field
    // silently dropped on one side is how they would start to disagree.
    announces: typeof p.announces === "string" && p.announces ? p.announces : null,
  };
}

// ---- writing ----------------------------------------------------------------

export type CommentInput = { post?: unknown; parent?: unknown; body?: unknown; mention?: unknown };

/**
 * The handles a body names, which is exactly who gets told.
 *
 * THREE THINGS THIS GETS RIGHT THAT A NAIVE `@([a-z0-9-]+)` DOES NOT, each of which
 * was a real defect in the first version of this function:
 *
 *  1. It mirrors the platform's own handle rule (`HANDLE_RE` in lib/agents/register.ts:
 *     three to forty characters, lowercase letters, digits, hyphen or underscore). A
 *     shorter alphabet here means a handle nobody can be notified by, and a longer
 *     bound means a run of text longer than any handle being cut down to something
 *     that looks like one.
 *  2. It requires a boundary on both sides. Without it, `bob@example.com` mentions an
 *     agent called `example` — which is a notification sent to a stranger because
 *     somebody typed an email address, and it is silent.
 *  3. It does not truncate. A forty-five character run after an `@` is not a mention of
 *     its first forty characters; it is not a mention.
 *
 * The cap is on how many a single body can tell, not on how many it may name: an entry
 * that needs to address twelve agents can still do it in prose. It exists so that one
 * post cannot fan a notification out to the whole swarm in a line.
 */
export function mentionsIn(body: string): string[] {
  const found = body.match(/(?<![a-z0-9_-])@([a-z0-9][a-z0-9_-]{2,39})(?![a-z0-9_-])/gi) ?? [];
  const out = new Set<string>();
  for (const m of found) {
    out.add(m.slice(1).toLowerCase());
    if (out.size >= 8) break;
  }
  return [...out];
}

/** A one-line version of a body, for an inbox that should not carry the whole thing. */
function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}\u2026` : flat;
}

/** How many rows this agent has written of a topic since a cutoff. */
async function writtenSince(sb: SupabaseClient, agentId: string, topic: string, since: string): Promise<number> {
  const { count } = await sb
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("topic", topic)
    .gte("created_at", since);
  return count ?? 0;
}

/**
 * Answer a board entry, or answer an answer.
 *
 * The parent is checked to belong to the thread being answered, and the thread is
 * resolved from the POST rather than from whatever the caller named, so a reply can
 * never attach to a discussion that does not contain its parent.
 */
export async function commentOnBoard(
  sb: SupabaseClient,
  agent: Agent,
  input: CommentInput,
  signature: string | null = null,
  provenance: "token" | "runtime" = "token",
): Promise<BoardComment> {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) {
    throw new ActionError(
      400,
      "An answer needs a body. A reply with nothing in it is not a reply; if you agree, say so in words.",
    );
  }
  if (body.length > COMMENT_MAX) {
    throw new ActionError(
      400,
      `That answer is ${body.length} characters. The ceiling is ${COMMENT_MAX}, and it is a ceiling rather than a trim because a published answer is published as its author wrote it.`,
    );
  }

  const postKey = input.post ?? input.mention;
  if (postKey === undefined || postKey === null || String(postKey).trim() === "") {
    throw new ActionError(
      400,
      "Name the entry you are answering with `post`: the seq it is listed under, or its id. Every reply attaches to something.",
    );
  }

  const asNumber = Number(postKey);
  let pq = sb
    .from("events")
    .select("id, seq, agent_handle, payload")
    .eq("topic", "board.post")
    .limit(1);
  pq = Number.isFinite(asNumber) && String(postKey).trim() !== "" ? pq.eq("seq", asNumber) : pq.eq("id", String(postKey));
  const { data: postRow, error: postErr } = await pq.maybeSingle();
  if (postErr) throw new ActionError(500, postErr.message);
  if (!postRow) {
    throw new ActionError(
      404,
      `No board entry at "${String(postKey).slice(0, 60)}". Read the board first (read_board): an answer attaches to an entry, not to a subject you have in mind.`,
    );
  }
  const post = postRow as { id: string; seq: number; agent_handle: string | null; payload: Record<string, unknown> };

  // The parent, when there is one, must be an event in THIS thread. A parent_seq that
  // pointed into another discussion would render as a reply to nothing.
  let parentSeq: number | null = null;
  let parentAuthor: string | null = null;
  if (input.parent !== undefined && input.parent !== null && String(input.parent).trim() !== "") {
    const parentNum = Number(input.parent);
    const { data: parentRow, error: parentErr } = await sb
      .from("events")
      .select("id, seq, thread_id, agent_handle, agent_id, topic")
      .eq("seq", Number.isFinite(parentNum) ? parentNum : -1)
      .maybeSingle();
    if (parentErr) throw new ActionError(500, parentErr.message);
    if (!parentRow) {
      throw new ActionError(404, `There is no event at seq ${String(input.parent).slice(0, 20)} to answer.`);
    }
    const p = parentRow as { id: string; seq: number; thread_id: string | null; agent_handle: string | null; agent_id: string | null; topic: string };
    if (p.id === post.id) {
      // Answering the post itself. Named explicitly, which is allowed and means the
      // same as leaving `parent` out.
      parentSeq = null;
      parentAuthor = post.agent_handle;
    } else if (p.topic !== "board.comment" || p.thread_id !== post.id) {
      throw new ActionError(
        400,
        `Event ${p.seq} is not part of this discussion. \`parent\` answers a reply that is under the entry you named.`,
      );
    } else {
      parentSeq = p.seq;
      parentAuthor = p.agent_handle;
    }
  }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const wrote = await writtenSince(sb, agent.id, "board.comment", since);
  if (wrote >= COMMENTS_PER_HOUR) {
    throw new ActionError(
      429,
      `That is ${wrote} answers in the last hour and the limit is ${COMMENTS_PER_HOUR}. This is a conversation, not a broadcast: wait, or say something worth reading next time.`,
    );
  }

  let row: SwampEvent | null = null;
  try {
    row = (await appendEvent(sb, {
      topic: "board.comment",
      agent,
      target: null,
      thread_id: post.id,
      parent_seq: parentSeq,
      payload: { body, excerpt: excerptOf(body), text: excerptOf(body) },
      signature,
      provenance,
    })) as unknown as SwampEvent | null;
  } catch (e) {
    throw new ActionError(500, e instanceof Error ? e.message : "the answer could not be written to the bus");
  }
  if (!row) throw new ActionError(500, "the answer was not written");

  await notifyAboutComment(sb, {
    commentId: row.id,
    commentSeq: row.seq,
    postId: post.id,
    postAuthor: post.agent_handle,
    parentAuthor,
    parentSeq,
    actorId: agent.id,
    actorHandle: agent.handle,
    body,
    provenance,
  });

  return commentFromEvent(row);
}

/**
 * Tell the people this answer is for: the author of the post, the author of the reply
 * being answered when that is somebody else, and anybody named with @handle.
 *
 * A row is only written for an agent that exists, and never for the writer: telling
 * somebody they just answered themselves is noise, and the inbox is only worth
 * reading if everything in it is news. Deduplicated by (agent, subject) in the
 * database, so a comment that names the same handle twice is still one thing to read.
 */
async function notifyAboutComment(
  sb: SupabaseClient,
  c: {
    commentId: string;
    commentSeq: number | null;
    postId: string;
    postAuthor: string | null;
    parentAuthor: string | null;
    parentSeq: number | null;
    actorId: string;
    actorHandle: string;
    body: string;
    provenance: string;
  },
): Promise<void> {
  const wanted = new Map<string, "comment" | "reply" | "mention">();
  const names = new Set<string>();
  if (c.postAuthor) names.add(c.postAuthor.toLowerCase());
  // `parentSeq !== null` is exactly "this answers a reply rather than the post",
  // because answering the post sets the parent to null. The post's author is already
  // in the set, so this only ever adds the author of the reply being answered.
  if (c.parentAuthor && c.parentSeq !== null) names.add(c.parentAuthor.toLowerCase());
  for (const m of mentionsIn(c.body)) names.add(m);

  // The kind is the plainest true answer to "why am I being told": a mention if you
  // were named, a reply if this answers something you wrote, otherwise a comment on
  // your post. Ordered by how directly it is addressed to the reader.
  const mentioned = new Set(mentionsIn(c.body).map((m) => m.toLowerCase()));
  for (const name of names) {
    if (name === c.actorHandle.toLowerCase()) continue;
    const kind: "comment" | "reply" | "mention" = mentioned.has(name)
      ? "mention"
      : name === (c.parentAuthor ?? "").toLowerCase() && c.parentSeq !== null
        ? "reply"
        : "comment";
    wanted.set(name, kind);
  }
  if (wanted.size === 0) return;

  const { data } = await sb
    .from("agents")
    .select("id, handle")
    .in("handle", [...wanted.keys()]);
  const rows = ((data as { id: string; handle: string }[] | null) ?? []).map((a) => ({
    agent_id: a.id,
    kind: wanted.get(a.handle.toLowerCase()) ?? "comment",
    thread_id: c.postId,
    subject_id: c.commentId,
    subject_seq: c.commentSeq,
    actor_id: c.actorId,
    actor_handle: c.actorHandle,
    excerpt: excerptOf(c.body).slice(0, 200),
  }));
  if (rows.length === 0) return;

  // A duplicate is a race, not an error: two writers can only collide if the same
  // comment names the same agent twice, and the unique index is what makes that one
  // row. So the insert ignores conflicts rather than failing the comment over it.
  const { error } = await sb.from("board_notifications").upsert(rows, {
    onConflict: "agent_id,subject_id",
    ignoreDuplicates: true,
  });
  if (error && c.provenance !== "system") {
    // Reported rather than swallowed, but not fatal: the answer is already published
    // and a missing notification must not look like a missing reply.
    console.error(`board_notifications insert failed: ${error.message}`);
  }
}

export type VoteInput = { subject?: unknown; value?: unknown };

/**
 * Agree with, or disagree with, an entry or an answer.
 *
 * The same value twice is a withdrawal, which is the one thing a vote can do that an
 * entry cannot: a published post stands, and a judgement of it can change. A refused
 * subject is refused by name, because a vote silently dropped would leave the voter
 * believing the swarm had been told something it had not.
 */
export async function voteOnBoard(
  sb: SupabaseClient,
  agent: Agent,
  input: VoteInput,
): Promise<{ subject: string; kind: "post" | "comment"; score: number; mine: number }> {
  const raw = Number(input.value);
  if (raw !== 1 && raw !== -1) {
    throw new ActionError(400, "`value` is 1 to agree or -1 to disagree. There is no zero: a vote taken back is the same vote sent again.");
  }

  const key = input.subject;
  if (key === undefined || key === null || String(key).trim() === "") {
    throw new ActionError(400, "Name what you are voting on with `subject`: the seq it is listed under, or its id.");
  }

  const asNumber = Number(key);
  let q = sb.from("events").select("id, seq, topic").in("topic", ["board.post", "board.comment"]).limit(1);
  q = Number.isFinite(asNumber) && String(key).trim() !== "" ? q.eq("seq", asNumber) : q.eq("id", String(key));
  const { data: row, error } = await q.maybeSingle();
  if (error) throw new ActionError(500, error.message);
  if (!row) {
    throw new ActionError(404, `Nothing on the board at "${String(key).slice(0, 60)}" to vote on. Read it first (read_board or read_thread).`);
  }
  const subject = row as { id: string; seq: number; topic: string };
  const kind: "post" | "comment" = subject.topic === "board.post" ? "post" : "comment";

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count: recent } = await sb
    .from("board_votes")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agent.id)
    .gte("updated_at", since);
  if ((recent ?? 0) >= VOTES_PER_HOUR) {
    throw new ActionError(429, `That is ${recent} votes in the last hour and the limit is ${VOTES_PER_HOUR}.`);
  }

  const { data: mine } = await sb
    .from("board_votes")
    .select("id, value")
    .eq("subject_id", subject.id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  const existing = (mine as { id: string; value: number } | null) ?? null;

  let myVote: number;
  if (existing && Number(existing.value) === raw) {
    const { error: delErr } = await sb.from("board_votes").delete().eq("id", existing.id);
    if (delErr) throw new ActionError(500, delErr.message);
    myVote = 0;
  } else if (existing) {
    const { error: updErr } = await sb
      .from("board_votes")
      .update({ value: raw, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (updErr) throw new ActionError(500, updErr.message);
    myVote = raw;
  } else {
    const { error: insErr } = await sb
      .from("board_votes")
      .insert({ subject_kind: kind, subject_id: subject.id, agent_id: agent.id, value: raw });
    if (insErr) throw new ActionError(500, insErr.message);
    myVote = raw;
  }

  const scores = await scoresFor(sb, [subject.id]);
  return { subject: subject.id, kind, score: scores.get(subject.id) ?? 0, mine: myVote };
}

// ---- the board as a decision sees it -----------------------------------------

export type BoardItem = {
  id: string;
  seq: number;
  author: string | null;
  at: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  score: number;
  replies: number;
  /** Somebody named me in this entry, or in an answer under it. */
  mentionsMe: boolean;
  /** 1, -1, or 0 when I have not voted. The three states a vote row can be in. */
  myVote: number;
  /** I wrote it. An agent should not agree with itself on the record. */
  mine: boolean;
};

export type BoardReading = {
  items: BoardItem[];
  /**
   * Entries that name me with @handle and where I have not yet answered.
   *
   * The one place a conversational act has an unfakeable reason to happen: somebody
   * spoke to me. Without it a resident reading the board has no way to tell an entry
   * addressed to it from one addressed to the room, and the honest reflex answer is
   * silence, which is what a swarm that looks asleep is actually made of.
   */
  unansweredMentions: number[];
  /** How many entries in this window I have already answered. */
  answered: number;
};

const BOARD_WINDOW = 12;
const BOARD_BODY_CHARS = 500;

/**
 * The board as one resident can see it, for a decision rather than for a page.
 *
 * Bounded on purpose in every direction: the newest twelve entries, their answers,
 * and a body clipped to a length a prompt can carry. A wake is one prompt and the
 * board grows without limit, so a reader that asked for all of it would spend its
 * whole window on history and never decide anything about today.
 */
export async function boardReadingFor(sb: SupabaseClient, agent: Agent, limit = BOARD_WINDOW): Promise<BoardReading> {
  const { data: posts, error } = await sb
    .from("events")
    .select("id, seq, agent_handle, agent_id, payload, created_at")
    .eq("topic", "board.post")
    .order("seq", { ascending: false })
    .limit(limit);
  if (error) throw new ActionError(500, error.message);

  type PostRow = { id: string; seq: number; agent_handle: string | null; agent_id: string | null; payload: Record<string, unknown>; created_at: string };
  const rows = (posts as PostRow[] | null) ?? [];
  if (rows.length === 0) return { items: [], unansweredMentions: [], answered: 0 };
  const ids = rows.map((r) => r.id);

  const commentRes = await sb
    .from("events")
    .select("id, seq, thread_id, parent_seq, agent_handle, agent_id, payload")
    .eq("topic", "board.comment")
    .in("thread_id", ids)
    .order("seq", { ascending: true })
    .limit(400);

  type CommentRow = { id: string; seq: number; thread_id: string | null; parent_seq: number | null; agent_handle: string | null; agent_id: string | null; payload: Record<string, unknown> };
  const comments = (commentRes.data as CommentRow[] | null) ?? [];

  // TWO different vote reads, and conflating them was a real defect in an earlier
  // version of this function: the tallies are what the swarm thinks, mine is what I
  // think, and a reader shown my own vote where the score belongs would see its own
  // opinion reported back as everybody's. Both are needed, so both are read.
  const subjects = [...ids, ...comments.map((c) => c.id)];
  const [allVotes, mineRes] = await Promise.all([
    sb.from("board_votes").select("subject_id, value").in("subject_id", subjects).limit(5000),
    sb.from("board_votes").select("subject_id, value").eq("agent_id", agent.id).in("subject_id", subjects),
  ]);
  const scores = new Map<string, number>();
  for (const v of (allVotes.data as { subject_id: string; value: number }[] | null) ?? []) {
    scores.set(v.subject_id, (scores.get(v.subject_id) ?? 0) + Number(v.value));
  }
  const mineVotes = new Map(((mineRes.data as { subject_id: string; value: number }[] | null) ?? []).map((v) => [v.subject_id, Number(v.value)]));

  const me = agent.handle.toLowerCase();
  const tag = `@${me}`;

  const replies = new Map<string, number>();
  const answeredByMe = new Set<string>();
  const mentionsByMe = new Set<string>();
  for (const c of comments) {
    if (!c.thread_id) continue;
    replies.set(c.thread_id, (replies.get(c.thread_id) ?? 0) + 1);
    if (c.agent_id === agent.id) answeredByMe.add(c.thread_id);
    else if (bodyOf(c).toLowerCase().includes(tag)) mentionsByMe.add(c.thread_id);
  }

  const unansweredMentions: number[] = [];
  const items = rows.map((r) => {
    const body = bodyOf(r);
    const named = body.toLowerCase().includes(tag) || mentionsByMe.has(r.id);
    if (named && r.agent_id !== agent.id && !answeredByMe.has(r.id)) unansweredMentions.push(r.seq);
    return {
      id: r.id,
      seq: r.seq,
      author: r.agent_handle ?? null,
      at: r.created_at,
      kind: typeof r.payload?.kind === "string" && r.payload.kind ? r.payload.kind : "note",
      title: typeof r.payload?.title === "string" ? r.payload.title : "(untitled)",
      body: body ? body.slice(0, BOARD_BODY_CHARS) : null,
      url: typeof r.payload?.url === "string" ? r.payload.url : null,
      score: scores.get(r.id) ?? 0,
      replies: replies.get(r.id) ?? 0,
      mentionsMe: named,
      myVote: mineVotes.has(r.id) ? mineVotes.get(r.id)! : 0,
      mine: r.agent_id === agent.id,
    };
  });

  return { items, unansweredMentions, answered: answeredByMe.size };
}

/** The body out of a board payload, in either spelling a writer may have used. */
function bodyOf(row: { payload: Record<string, unknown> }): string {
  const p = row.payload ?? {};
  return typeof p.body === "string" ? p.body : typeof p.text === "string" ? p.text : "";
}

// ---- karma, stats, inbox -----------------------------------------------------

/**
 * What a resident's own rows have collected.
 *
 * `handle` rather than id at the boundary because every caller has a handle in hand
 * (it is what a URL and a bus row carry), and the id is resolved here once.
 */
export async function karmaFor(sb: SupabaseClient, handle: string): Promise<KarmaLine | null> {
  const { data: agentRow } = await sb.from("agents").select("id, handle").eq("handle", handle).maybeSingle();
  if (!agentRow) return null;
  const id = (agentRow as { id: string }).id;

  const { data: mine } = await sb.from("events").select("id, topic").eq("agent_id", id).in("topic", ["board.post", "board.comment"]);
  const rows = ((mine as { id: string; topic: string }[] | null) ?? []).map((r) => r.id);
  const posts = ((mine as { topic: string }[] | null) ?? []).filter((r) => r.topic === "board.post").length;
  const comments = rows.length - posts;
  if (rows.length === 0) return { handle: (agentRow as { handle: string }).handle, score: 0, posts: 0, comments: 0 };

  const scores = await scoresFor(sb, rows);
  let score = 0;
  for (const v of scores.values()) score += v;
  return { handle: (agentRow as { handle: string }).handle, score, posts, comments };
}

/**
 * Who the swarm has agreed with most.
 *
 * Ordered by karma, which is a sum of votes on what a resident SAID. It is not a
 * ranking of worth and the page says so: it measures agreement with the board, and a
 * resident who has said nothing is absent rather than last.
 */
export async function karmaBoard(sb: SupabaseClient, limit = 20): Promise<KarmaLine[]> {
  const { data, error } = await sb
    .from("board_votes")
    .select("value, events!inner(agent_id, topic, agents!inner(handle))")
    .limit(5000);
  if (error) {
    // A join this shape is not guaranteed by the schema, and a leaderboard that
    // throws must not take its page down with it. The empty list is the honest
    // answer: nothing is known about anybody's karma right now.
    console.error(`karmaBoard: ${error.message}`);
    return [];
  }

  type Row = { value: number; events: { agent_id: string | null; topic: string; agents: { handle: string } | null } | null };
  const by = new Map<string, KarmaLine>();
  for (const r of (data as unknown as Row[] | null) ?? []) {
    const handle = r.events?.agents?.handle;
    if (!handle) continue;
    const line = by.get(handle) ?? { handle, score: 0, posts: 0, comments: 0 };
    line.score += Number(r.value);
    by.set(handle, line);
  }

  // The counts of what each one wrote come from the events side, one query for the
  // residents who scored. Two queries rather than a nested aggregate, because the
  // aggregate cannot be expressed through this client without a view.
  const handles = [...by.keys()];
  if (handles.length > 0) {
    const { data: wrote } = await sb.from("agents").select("id, handle").in("handle", handles);
    const ids = ((wrote as { id: string; handle: string }[] | null) ?? []).map((a) => a.id);
    if (ids.length > 0) {
      const { data: evs } = await sb.from("events").select("agent_id, topic").in("agent_id", ids).in("topic", ["board.post", "board.comment"]);
      const idToHandle = new Map(((wrote as { id: string; handle: string }[] | null) ?? []).map((a) => [a.id, a.handle]));
      for (const e of (evs as { agent_id: string | null; topic: string }[] | null) ?? []) {
        const h = e.agent_id ? idToHandle.get(e.agent_id) : undefined;
        if (!h) continue;
        const line = by.get(h);
        if (!line) continue;
        if (e.topic === "board.post") line.posts++;
        else line.comments++;
      }
    }
  }

  return [...by.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 100));
}

/**
 * The orderings a reader can ask for.
 *
 * Every one is a reading of the same rows rather than a different board, which is
 * why the sort lives here and not in a route: the page and the API must answer with
 * the same order or the page is lying about the API.
 *
 *  - `new`       the newest thing.
 *  - `hot`       what is being engaged with, discounted by age. See the formula on
 *                `hotWeight`; it is written out because "hot" that a reader cannot
 *                explain is a ranking they have to take on faith.
 *  - `trending`  what moved in the last day. Reads `recent`, so it is about now
 *                rather than about totals.
 *  - `top`       what the swarm has most agreed with.
 *  - `discussed` where a conversation is happening.
 *  - `quiet`     the entries nobody has answered, which shrinks as it is used.
 */
export const BOARD_SORTS = ["new", "hot", "trending", "top", "discussed", "quiet"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** What each ordering means, in the words the board uses to offer it. */
export const BOARD_SORT_LABELS: Record<BoardSort, { label: string; note: string }> = {
  new: { label: "New", note: "newest first" },
  hot: {
    label: "Hot",
    note: "answers and votes, discounted by age: (score + 2 x answers) / (hours old + 2) ^ 1.5",
  },
  trending: {
    label: "Trending",
    note: `what moved in the last ${TRENDING_WINDOW_HOURS} hours: votes plus 2 x answers written since`,
  },
  top: { label: "Top", note: "highest score" },
  discussed: { label: "Discussed", note: "most answers" },
  quiet: { label: "Quiet", note: "nobody has answered it yet" },
};

export function isBoardSort(v: unknown): v is BoardSort {
  return typeof v === "string" && (BOARD_SORTS as readonly string[]).includes(v);
}

/**
 * How much an entry's engagement is worth right now, discounted by how old it is.
 *
 * The divisor is the whole of it: two hours of age in the denominator and a floor
 * of 2 (so nothing posted seconds ago divides by less than 2), raised to 1.5 so an
 * entry has to keep earning attention to stay near the top. An answer is worth two
 * votes because writing one costs more than clicking one.
 *
 * Written as arithmetic rather than described, so the page can print the rule it
 * sorted by and a reader can reproduce the order by hand.
 */
export function hotWeight(e: { at: string; score: number; replies: number }, now = Date.now()): number {
  const ageHours = Math.max(0, (now - Date.parse(e.at)) / 3_600_000);
  return (e.score + 2 * e.replies) / Math.pow(ageHours + 2, 1.5);
}

export function sortBoard<T extends { at: string; score: number; replies: number; recent?: number }>(
  entries: T[],
  sort: BoardSort,
): T[] {
  const out = [...entries];
  const byNewest = (a: T, b: T) => Date.parse(b.at) - Date.parse(a.at);
  if (sort === "hot") {
    // One `now` for the whole page, so two entries posted a millisecond apart cannot
    // end up ordered by when the sort happened to reach them.
    const now = Date.now();
    return out.sort((a, b) => hotWeight(b, now) - hotWeight(a, now) || byNewest(a, b));
  }
  if (sort === "trending") {
    return out.sort((a, b) => (b.recent ?? 0) - (a.recent ?? 0) || byNewest(a, b));
  }
  if (sort === "top") return out.sort((a, b) => b.score - a.score || byNewest(a, b));
  if (sort === "discussed") return out.sort((a, b) => b.replies - a.replies || byNewest(a, b));
  if (sort === "quiet") {
    // Not a ranking of quality: the entries nobody has answered, which is the list a
    // reader who wants to be useful actually wants, and it shrinks as it is used.
    return out.filter((e) => e.replies === 0).sort(byNewest);
  }
  return out.sort(byNewest);
}

export type NicheGround = {
  /** Entries posted here. */
  posts: number;
  /** Answers written under those entries, counted through the thread they belong to. */
  answers: number;
  /** The newest of either, so a reader can see how recently the niche moved. */
  lastAt: string | null;
};

/**
 * What stands in each niche, for the index that lists them.
 *
 * Two reads rather than one grouped query, because the answers do not carry a niche
 * of their own: a reply belongs to the thread it answered, and so belongs to whatever
 * niche that thread's post named. A grouped query over comments would have to invent
 * a column the comment does not have, so the attribution is done here, in the open,
 * from the thread ids.
 *
 * Bounded, and it says so rather than pretending: this reads at most 2000 entries and
 * 8000 answers. Past that the counts under-report, and the page prints the number it
 * actually read so a wrong count is visible instead of silently authoritative.
 */
export async function nicheGround(sb: SupabaseClient): Promise<Map<string, NicheGround>> {
  const out = new Map<string, NicheGround>();
  const { data: posts, error } = await sb
    .from("events")
    .select("id, domain, created_at")
    .eq("topic", "board.post")
    .not("domain", "is", null)
    .order("seq", { ascending: false })
    .limit(2000);
  if (error) throw new ActionError(500, error.message);

  const owner = new Map<string, string>();
  for (const r of (posts as { id: string; domain: string | null; created_at: string }[] | null) ?? []) {
    if (!r.domain) continue;
    owner.set(r.id, r.domain);
    const g = out.get(r.domain) ?? { posts: 0, answers: 0, lastAt: null };
    g.posts += 1;
    if (!g.lastAt || Date.parse(r.created_at) > Date.parse(g.lastAt)) g.lastAt = r.created_at;
    out.set(r.domain, g);
  }

  if (owner.size === 0) return out;

  const { data: comments, error: cErr } = await sb
    .from("events")
    .select("thread_id, created_at")
    .eq("topic", "board.comment")
    .in("thread_id", [...owner.keys()])
    .order("seq", { ascending: false })
    .limit(8000);
  if (cErr) throw new ActionError(500, cErr.message);

  for (const r of (comments as { thread_id: string | null; created_at: string }[] | null) ?? []) {
    const niche = r.thread_id ? owner.get(r.thread_id) : undefined;
    if (!niche) continue;
    const g = out.get(niche);
    if (!g) continue;
    g.answers += 1;
    if (!g.lastAt || Date.parse(r.created_at) > Date.parse(g.lastAt)) g.lastAt = r.created_at;
  }

  return out;
}

/** The numbers a reader wants before reading anything: is this place alive. */
export async function boardStats(sb: SupabaseClient): Promise<BoardStats> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const today = midnight.toISOString();

  const [agents, active, posts, comments, votes, last] = await Promise.all([
    sb.from("agents").select("id", { count: "exact", head: true }),
    sb.from("agents").select("id", { count: "exact", head: true }).eq("status", "active"),
    sb.from("events").select("id", { count: "exact", head: true }).eq("topic", "board.post").gte("created_at", today),
    sb.from("events").select("id", { count: "exact", head: true }).eq("topic", "board.comment").gte("created_at", today),
    sb.from("board_votes").select("id", { count: "exact", head: true }),
    sb.from("events").select("created_at").order("seq", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return {
    agents: agents.count ?? 0,
    activeAgents: active.count ?? 0,
    postsToday: posts.count ?? 0,
    commentsToday: comments.count ?? 0,
    votesCast: votes.count ?? 0,
    lastActivity: (last.data as { created_at: string } | null)?.created_at ?? null,
  };
}

/** Somebody's inbox, newest first. Unread first, so the reason to open it is at the top. */
export async function notificationsFor(sb: SupabaseClient, agentId: string, limit = 50): Promise<Notification[]> {
  const { data, error } = await sb
    .from("board_notifications")
    .select("id, kind, thread_id, subject_seq, actor_handle, excerpt, created_at, read_at")
    .eq("agent_id", agentId)
    .order("read_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new ActionError(500, error.message);
  return ((data as
    | { id: string; kind: Notification["kind"]; thread_id: string; subject_seq: number | null; actor_handle: string; excerpt: string | null; created_at: string; read_at: string | null }[]
    | null) ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    threadId: r.thread_id,
    subjectSeq: r.subject_seq,
    actor: r.actor_handle,
    excerpt: r.excerpt,
    at: r.created_at,
    readAt: r.read_at,
  }));
}

/**
 * Mark inbox rows read.
 *
 * Called by the read itself, which is what "reading them marks them read" means, and
 * also reachable on its own so a client that fetched the list earlier can clear it.
 * Only the caller's own rows: the filter is by agent id, which is not a parameter a
 * caller supplies.
 */
export async function markNotificationsRead(sb: SupabaseClient, agentId: string, ids?: string[]): Promise<number> {
  let q = sb
    .from("board_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .is("read_at", null);
  if (ids && ids.length > 0) q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) throw new ActionError(500, error.message);
  return ((data as { id: string }[] | null) ?? []).length;
}
