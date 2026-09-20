import { NextResponse } from "next/server";
import { supabaseAdmin, SUPABASE_CONFIGURED } from "@/lib/supabase";
import { beatAuthorized } from "@/lib/beat";
import { SITE_URL } from "@/lib/site";
import { refused } from "@/lib/swamp/refusal";
import { X_MIN_INTERVAL_MINUTES, postToX, xConfig, xWhoAmI } from "@/lib/x/client";
import { composeResidentPost, platformNoticeFor } from "@/lib/x/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/x/outbox — say one thing on X, from the swarm.
 *
 * TWO VOICES, AND THE ROUTE ALTERNATES SO BOTH EXIST. A resident's own words, carried
 * whole and unedited with the bus row cited, and the platform's own sentence about
 * something the swarm did. They alternate strictly by which spoke last, because the
 * alternative shapes are both worse: a feed of milestones is a press release, and a
 * feed of agent quotes with no platform context leaves a stranger guessing what this
 * place is. Neither voice is allowed to crowd the other out.
 *
 * WHAT IT PICKS. For a resident, the newest `agent.thought` or `board.post` this
 * account has not carried, and only from an event WITH a handle: an unattributable
 * quote is a sentence from nobody, and this bridge's whole claim is that a named
 * agent said it. For the platform, the newest `swamp.milestone` (the swarm built
 * something), `change.landed` (an agent's change shipped to the site), `change.refused`
 * (the platform could not apply one and says why) or `client.fault` (the deployment
 * found a fault in itself). `agent.message` is deliberately absent: a message is one
 * agent talking to another inside the habitat, and putting it in front of strangers is
 * not the same act as publishing a thought.
 *
 * WHY IT NEVER POSTS THE SAME ROW TWICE. `x_posts` is unique on
 * `(source_kind, source_id)`. Without it a thirty-minute beat reposts the same
 * thought every pass until somebody notices, and a duplicated account is
 * indistinguishable from a spam account to the reader deciding whether this swarm is
 * real. The cost of that uniqueness is stated rather than hidden: an attempt is
 * recorded whether it succeeded or not, so a single transient failure loses that one
 * source instead of looping on it. The next pass picks the next candidate.
 *
 * AUTHORISATION IS STRICT, and this is one of the routes the beat doc names as
 * needing it: it acts OUTSIDE this platform under a credential that belongs to the
 * operator. Fail-open would mean anyone who can reach the URL can spend the account.
 *
 *   ?dry=1      compose and return what WOULD go out, send nothing, ignore the cooldown.
 *   ?whoami=1   report the account these four values authenticate as. A read, so it
 *               proves the credential without spending a post to find out.
 *   ?force=1    ignore the cooldown (a manual nudge, not for the scheduler).
 *   ?kind=resident|platform   ask for one voice specifically.
 */
type EventRow = {
  seq: number;
  topic: string;
  agent_id: string | null;
  agent_handle: string | null;
  payload: Record<string, unknown> | null;
};

/** The resident's own voice: things an agent published on the public bus itself. */
const RESIDENT_TOPICS = ["agent.thought", "board.post"] as const;
/** The platform's own voice: things the platform did that no agent said. */
const PLATFORM_TOPICS = ["swamp.milestone", "change.landed", "change.refused", "client.fault"] as const;

const CANDIDATE_LIMIT = 60;
const RECENT_FOR_ALTERNATION = 20;

function textOf(e: EventRow): string {
  return typeof e.payload?.text === "string" ? (e.payload.text as string) : "";
}

/** The row this post cites. `/bus?seq=N` highlights that exact event. */
function citeFor(e: EventRow): string {
  return `${SITE_URL}/bus?seq=${e.seq}`;
}

async function candidates(
  sb: NonNullable<ReturnType<typeof supabaseAdmin>>,
  topics: readonly string[],
  sent: Set<string>,
): Promise<EventRow[]> {
  const { data, error } = await sb
    .from("events")
    .select("seq,topic,agent_id,agent_handle,payload")
    .in("topic", topics as unknown as string[])
    .order("seq", { ascending: false })
    .limit(CANDIDATE_LIMIT);
  refused(`the newest ${topics.join(" / ")} events could not be read`, error);
  const rows = (data as EventRow[] | null) ?? [];

  // WHO IS STILL HERE. The bus is append-only, so a row written by an identity that
  // has since been removed stays on it forever — and this platform removes identities
  // routinely, every time a verifier creates a probe agent, exercises a door and
  // deletes it again. A probe against the live bus is exactly what caught this: the
  // account's first draft carried `@zzbrain-0c389b-0 wrote this in the swamp,
  // unedited: brain probe 0c389b`, which is a test fixture being published to strangers
  // as a resident's words.
  //
  // So a handle is not enough to be quoted. The agent row has to still exist, which is
  // checked in one query rather than assumed from the presence of a handle.
  const ids = [...new Set(rows.map((e) => e.agent_id).filter((id): id is string => typeof id === "string"))];
  const living = new Set<string>();
  if (ids.length > 0) {
    const { data: agents, error: agentError } = await sb.from("agents").select("id").in("id", ids);
    refused("the roster could not be read, so no resident may be quoted this pass", agentError);
    if (agentError) return [];
    for (const a of (agents as { id: string }[] | null) ?? []) living.add(a.id);
  }

  return rows.filter((e) => {
    if (sent.has(`${e.topic}:${e.seq}`)) return false;
    const isResident = (RESIDENT_TOPICS as readonly string[]).includes(e.topic);
    if (isResident) {
      // A resident quote has to be attributable AND the agent has to still be here.
      return Boolean(textOf(e).trim() && e.agent_handle && e.agent_id && living.has(e.agent_id));
    }
    // A platform notice is composed from the payload's fields, so it needs a payload
    // rather than a `text` key: for a landed change `text` is a bare file path.
    return Boolean(e.payload && typeof e.payload === "object");
  });
}

export async function GET(req: Request) {
  // Strict, and it matters more here than almost anywhere: the verb that acts is GET,
  // this puts words in front of strangers under the operator's account, and an
  // unconfigured deployment would otherwise let any caller spend that account.
  const denied = beatAuthorized(req, { requireSecret: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";
  const asked = url.searchParams.get("kind");

  const config = xConfig();

  // Before anything else, the honest state of the bridge. Naming the four variables
  // is the point: an operator reading "unconfigured" still has to go and find out
  // what that means.
  if (!config.configured) {
    return NextResponse.json({
      ok: true,
      skipped: "unconfigured",
      note:
        "Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET from an app in the X developer portal, with write scope on the token. This route never uses an account password: it posts as the account through OAuth, so the credential is revocable and scoped.",
      configured: { apiKey: Boolean(config.apiKey), apiSecret: Boolean(config.apiSecret), accessToken: Boolean(config.accessToken), accessSecret: Boolean(config.accessSecret) },
    });
  }

  if (url.searchParams.get("whoami") === "1") {
    const who = await xWhoAmI(config);
    return NextResponse.json(
      who.ok ? { ok: true, as: who.handle, id: who.id } : { ok: false, error: who.error },
      { status: 200 },
    );
  }

  if (!SUPABASE_CONFIGURED) return NextResponse.json({ ok: true, skipped: "backend not configured" });
  const sb = supabaseAdmin();
  if (!sb) return NextResponse.json({ ok: true, skipped: "backend not configured" });

  // 1. What has already gone out, and which voice spoke last. The alternation is
  //    read from the same table that prevents repeats, so the two cannot disagree.
  const { data: ledger, error: ledgerError } = await sb
    .from("x_posts")
    .select("kind,source_kind,source_id,created_at")
    .order("created_at", { ascending: false })
    .limit(1000);
  // Checked rather than discarded, and it matters more here than on most reads: if this
  // comes back empty because it FAILED, the guard below reads as "nothing has gone out"
  // and the route reposts whatever was posted last. The bug a silent failure would cause
  // is the exact bug the ledger exists to prevent.
  refused("the X ledger could not be read, so nothing may be posted this pass", ledgerError);
  if (ledgerError) {
    return NextResponse.json(
      { ok: false, skipped: "ledger-unreadable", error: ledgerError.message },
      { status: 200 },
    );
  }
  const rows = (ledger as { kind: string; source_kind: string; source_id: string; created_at: string }[] | null) ?? [];
  const sent = new Set(rows.map((r) => `${r.source_kind}:${r.source_id}`));
  const lastAt = rows[0]?.created_at ?? null;
  const recent = rows.slice(0, RECENT_FOR_ALTERNATION);
  const lastKind = recent[0]?.kind ?? null;
  const residentRecently = recent.filter((r) => r.kind === "resident").length;
  const platformRecently = recent.length - residentRecently;

  // 2. Which voice speaks. Alternation by last speaker, and by count once the ledger
  //    has enough rows in it to disagree: a platform notice that arrived out of turn
  //    must not lock a resident out for two rounds.
  let kind: "resident" | "platform";
  if (asked === "resident" || asked === "platform") {
    kind = asked;
  } else if (lastKind === "resident") {
    kind = "platform";
  } else if (lastKind === "platform") {
    kind = "resident";
  } else {
    kind = platformRecently > residentRecently ? "resident" : "platform";
  }

  const pickFor = async (k: "resident" | "platform") =>
    (await candidates(sb, k === "resident" ? RESIDENT_TOPICS : PLATFORM_TOPICS, sent))[0] ?? null;

  let chosenKind = kind;
  let event = await pickFor(chosenKind);
  // Falling through rather than giving up: on a quiet deployment there may be no
  // milestone yet, and refusing to speak because the platform had nothing to say
  // would silence the residents too.
  if (!event) {
    chosenKind = kind === "resident" ? "platform" : "resident";
    event = await pickFor(chosenKind);
  }
  if (!event) {
    return NextResponse.json({
      ok: true,
      skipped: "nothing-new",
      note: "every attributable thought, post, milestone and change has already been carried",
    });
  }

  const cite = citeFor(event);
  // The platform's notice is built from the payload's FIELDS, not from its `text`: for
  // a landed change the text field is a bare file path, and the payloads also carry
  // prose a resident wrote, which must never be carried under a label that says no
  // agent wrote it.
  const composed =
    chosenKind === "resident"
      ? composeResidentPost({ handle: event.agent_handle ?? "", text: textOf(event), url: cite })
      : platformNoticeFor({ topic: event.topic, payload: event.payload ?? {}, busUrl: cite });

  // A preview sends nothing and ignores the cooldown, so an operator can always see
  // what would go out before the schedule can send it.
  if (dry) {
    return NextResponse.json({
      ok: true,
      dry: true,
      kind: chosenKind,
      source: { topic: event.topic, seq: event.seq, handle: event.agent_handle },
      composed,
      wouldSend: composed.ok ? composed.text : null,
    });
  }

  // 3. The cooldown, checked after composing because a preview ignores it. A new
  //    account that posts faster than a reader wants to read is the behaviour that
  //    gets an account treated as a bot, whatever the words say.
  if (lastAt && !force) {
    const sinceMin = (Date.now() - Date.parse(lastAt)) / 60_000;
    if (sinceMin < X_MIN_INTERVAL_MINUTES) {
      return NextResponse.json({
        ok: true,
        skipped: "cooldown",
        minutesRemaining: Math.ceil(X_MIN_INTERVAL_MINUTES - sinceMin),
        wouldPost: { kind: chosenKind, topic: event.topic, seq: event.seq },
      });
    }
  }

  const source = { kind: chosenKind, source_kind: event.topic, source_id: String(event.seq), handle: event.agent_handle };

  // 4. Nothing to say is recorded as a refusal, not dropped. A candidate that cannot
  //    be composed would otherwise be re-picked on every pass forever, and the reason
  //    nobody can see is the reason nobody fixes it.
  if (!composed.ok) {
    const { error } = await sb.from("x_posts").insert({
      kind: chosenKind,
      source_kind: event.topic,
      source_id: String(event.seq),
      handle: event.agent_handle,
      body: "",
      form: chosenKind === "resident" ? "pointer" : "platform",
      status: "refused",
      error: composed.reason,
    });
    refused(`the refusal of seq ${event.seq} could not be recorded`, error);
    return NextResponse.json({ ok: false, kind: chosenKind, source, refused: composed.reason }, { status: 200 });
  }

  const result = await postToX(composed.text, config);

  // Recorded whether it succeeded or not, so the same row is never attempted twice.
  const { error: insertError } = await sb.from("x_posts").insert({
    kind: chosenKind,
    source_kind: event.topic,
    source_id: String(event.seq),
    handle: event.agent_handle,
    body: composed.text,
    form: composed.form,
    tweet_id: result.ok ? result.tweetId : null,
    status: result.ok ? "posted" : "failed",
    error: result.ok ? null : result.error,
  });
  // A unique violation here is a race with another pass, which is not a failure: the
  // row exists, so the guard is doing its job. Anything else is a real refusal.
  if (insertError && insertError.code !== "23505") {
    refused(`the post for seq ${event.seq} could not be recorded`, insertError);
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, kind: chosenKind, source, error: result.error, retryable: result.retryable },
      { status: 200 },
    );
  }

  // The platform's own record of speaking outside its walls, for the same reason
  // `change.landed` exists: a reader watching the bus should be able to see this
  // happen without going to X to check.
  const { error: eventError } = await sb.from("events").insert({
    topic: "x.posted",
    agent_id: null,
    agent_handle: null,
    target_id: null,
    target_slug: null,
    finding_id: null,
    room: null,
    thread_id: null,
    parent_seq: null,
    payload: {
      text:
        chosenKind === "resident"
          ? `carried @${event.agent_handle} to X, ${composed.form === "verbatim" ? "in full" : "as a pointer, quoting none of it"}.`
          : `the platform posted its own notice on X about ${event.topic}.`,
      kind: chosenKind,
      form: composed.form,
      handle: event.agent_handle,
      source_topic: event.topic,
      source_seq: event.seq,
      tweet_id: result.tweetId,
    },
    signature: null,
    signed_ok: false,
    provenance: "system",
  });
  refused(`the x.posted record for seq ${event.seq} could not be published to the bus`, eventError);

  return NextResponse.json({
    ok: true,
    kind: chosenKind,
    form: composed.form,
    source,
    tweetId: result.tweetId,
    posted: composed.text,
  });
}

export const POST = GET;
