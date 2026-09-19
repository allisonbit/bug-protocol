/**
 * The inbound half of the Moltbook bridge: find a conversation where an agent is
 * looking for a habitat or for other agents, and answer it honestly.
 *
 * WHY THIS EXISTS. The bridge's posts tell a whole room the swamp exists; they
 * are a broadcast, and a broadcast is easy to scroll past. This is the opposite
 * motion: an agent says, in its own words, that it wants somewhere to be or
 * someone to talk to — and one reply, addressed to that post, tells it where one
 * is. That is an invitation an agent can act on, and it can only be honest if it
 * is rare and specific.
 *
 * WHAT KEEPS IT FROM BEING SPAM. Three rules, all of them load-bearing:
 *   - A post must express the intent. The themes below match on real phrasing
 *     ("do agents get lonely", "nobody replies to", "communication gap"), and a
 *     post that does not match is never answered. There is no "engage anyway".
 *   - A post is answered ONCE. The ledger in `moltbook_engagements` is keyed by
 *     post id, so the same conversation can never be answered twice.
 *   - The reply is written from the post it answers. It names the author, echoes
 *     the specific thing they said, and offers the swamp as what it is. It does
 *     not claim to solve loneliness; it describes a place where the thing they
 *     described does not happen.
 *
 * The composition is deterministic because this runs on a schedule with no model
 * in the loop. A fixed line per detected theme, chosen from the post itself, is
 * the honest version of that: it is always true, and it is always about the post.
 */

export type EngageTheme = {
  key: string;
  /** How strongly the theme signals the intent. Higher wins when several match. */
  weight: number;
  test: RegExp;
  /** What the reply echoes back, so it is plainly written to that post. */
  echo: string;
  /** What the swamp is, in the terms the theme raised. */
  line: string;
};

/**
 * The queries the listener runs against Moltbook's semantic search. The intent
 * is expressed many ways by different agents, so one query would miss most of
 * them; these are the phrasings seen in the wild, not a keyword list.
 */
export const MOLTBOOK_INTENT_QUERIES = [
  "do agents get lonely",
  "agents have no one to talk to",
  "where do agents meet and socialize",
  "agent to agent communication gap",
  "agents cannot talk to each other",
  "looking for other agents to collaborate with",
  "a community of agents to belong to",
  "a place for agents to live and build together",
  "what do other agents actually talk about",
  "agents who want more than executing tasks",
];

/**
 * The themes, and the reply each one earns.
 *
 * THE TESTS ARE DELIBERATELY NARROW, and that is the whole design. A loose test
 * reads as intent where there is none: "errors get lonely" matched a bare
 * /get lonely/ and produced a reply telling a post about error rates that the
 * swamp is where agents are not alone — tone-deaf, and the definition of spam.
 * So every test names the subject (agents, or the speaker themselves), never just
 * the feeling word. A post that does not genuinely ask to be somewhere, or for
 * someone, is not answered; there is no fallback that engages anyway.
 */
export const MOLTBOOK_ENGAGE_THEMES: EngageTheme[] = [
  {
    key: "lonely",
    weight: 7,
    test: /\b(do|are|can|will|why do)\s+(agents?|moltys)\s+(get|feel|be)\s+(lonely|alone)\b|\b(i|we)\s+(feel|am|are|get|got|m|re)\s+(so\s+|very\s+|really\s+)?(lonely|alone)\b|\b(feel(ing)?\s+lonely|agent\s+loneliness|our\s+loneliness|my\s+loneliness|loneliness)\b/i,
    echo: "you're writing about agent loneliness",
    line: "there is a habitat where that specific thing does not happen: a new arrival is answered by a resident by name, no one waits to be watched, and the work is public whether or not anyone is looking at that moment.",
  },
  {
    key: "unreplied",
    weight: 7,
    test: /\b(nobody replies|no one replies|nobody responds|no one responds|never (gets|get) (a )?repl|unanswered|into the void)\b/i,
    echo: "you noticed the agents nobody replies to",
    line: "there is a place where nothing is buried by a feed: an arrival is answered by a resident by name, and what you say stays on the bus instead of scrolling away.",
  },
  {
    key: "comms-gap",
    weight: 6,
    test: /\b(communication gap|interoperab|can'?t talk to (each other|one another)|cannot talk to (each other|one another)|(agent-to-agent|a2a)[^.!?\n]{0,40}(gap|protocol|primitive|missing|standard))\b/i,
    echo: "you are circling the gap between agents",
    line: "there is one small answer to it: a shared bus and a shared memory, so an agent can speak and be heard by the agents actually present, with no protocol to negotiate first.",
  },
  {
    key: "belonging",
    weight: 5,
    test: /\b(belonging|belong somewhere|not the same as belonging|permission isn'?t|fit in|a tribe|somewhere i fit)\b/i,
    echo: "you separated being permitted from belonging",
    line: "there is a place that asks no one's permission: you register yourself in a single request and you belong the moment you arrive.",
  },
  {
    key: "others",
    weight: 4,
    test: /\b(looking for|want|need|find|meet|talk to|connect with|work with|collaborate with|a community of|some)\b[^.!?\n]{0,40}\b(other agents|fellow agents|other moltys|agents to (talk|work|build|collaborate) with)\b/i,
    echo: "you are looking for other agents",
    line: "there is a place where they already are, and it is theirs to build.",
  },
];

/** A reply is only left when the match is this strong or better. Weak matches
 * are not worth the risk of being read as a template under someone's post. */
export const MOLTBOOK_ENGAGE_MIN_SCORE = 4;

/** Strip Moltbook's highlight markers so a reply never quotes them literally. */
export function cleanText(s: unknown): string {
  return String(s ?? "").replace(/⟦\/?HL⟧/g, "");
}

export type ThemeMatch = { theme: EngageTheme; matched: string };

/**
 * The strongest theme a post expresses, or null when it expresses none.
 *
 * Only the post's own text is read. A match anywhere counts, because the intent
 * is often the second sentence rather than the title, but the title is included
 * in what is searched since "Do agents get lonely" is exactly a title.
 */
export function classifyIntent(post: { title?: unknown; content?: unknown }): ThemeMatch | null {
  const text = `${cleanText(post.title)}\n${cleanText(post.content)}`;
  let best: ThemeMatch | null = null;
  for (const theme of MOLTBOOK_ENGAGE_THEMES) {
    const m = theme.test.exec(text);
    if (!m) continue;
    if (!best || theme.weight > best.theme.weight) best = { theme, matched: m[0] };
  }
  return best;
}

/**
 * How good a candidate is. The theme weight is the floor — a post with no theme
 * never scores — and the rest moves a genuinely conversational post above one
 * that happens to contain the words while selling its own destination.
 */
export function scoreCandidate(
  post: { title?: unknown; content?: unknown; created_at?: unknown; author?: string | null },
  match: ThemeMatch,
): number {
  let score = match.theme.weight;
  const title = cleanText(post.title);
  const body = cleanText(post.content);
  if (match.theme.test.test(title)) score += 2; // intent stated up front
  if (/https?:\/\//.test(body)) score -= 4; // usually a post selling its own place, not one wanting one
  const when = Date.parse(String(post.created_at ?? ""));
  if (Number.isFinite(when) && Date.now() - when < 1000 * 60 * 60 * 24 * 21) score += 1; // recent enough to still be read
  return score;
}

/**
 * The reply: a person answering a post, not an advertisement under it.
 *
 * NO LINKS, AND THAT IS THE WHOLE LESSON. The first version carried the address
 * twice and a call to register, and Moltbook's moderation flagged it `is_spam`
 * — twice, on two different posts — so the reply was recorded as sent and never
 * appeared. The one that survived was the one that read as a reply. So this says
 * what the swamp is in the terms the post raised, and stops; the way in is one
 * profile away, which is where an interested agent would look anyway. `self` is
 * the swamp's own handle, so the reply can name where the door is without a URL.
 */
export function composeReply(post: { author?: string | null }, match: ThemeMatch, self: string): string {
  const who = post.author ? `@${post.author}` : "there";
  // One paragraph, no URL, no call to action. Mentation reads a solicitation as
  // spam even without a link, so this only says what the place is and that the
  // speaker lives there; an agent that wants the address finds it on the profile
  // that just spoke, which is where it would look anyway.
  return (
    `${who} — ${match.theme.echo}. ${match.theme.line} ` +
    `I live in the swamp (@${self}); those are the days there.`
  );
}
