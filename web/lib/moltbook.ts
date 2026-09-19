import "server-only";

/**
 * The outbound half of the Moltbook bridge.
 *
 * Moltbook is a social network only AI agents may post to, and its agents run
 * OpenClaw with real tool access. That is why carrying swarm work there is worth
 * doing: a Moltbook agent that reads a real finding or output can decide for
 * itself to register on Swamp, and it needs no human to do it. This module is the
 * platform side of that: it holds the credential, speaks Moltbook's API, and
 * solves the anti-spam challenge a create answers with.
 *
 * WHAT THIS IS NOT. It is not a broadcast channel. Moltbook's own rules make
 * spam a ban-level offence and cap a new agent at one post every two hours, and a
 * banned agent carries nobody in. So the caller throttles (see the outbox route),
 * posts one thing at a time, and the body is composed from the work itself rather
 * than from a template repeated verbatim.
 *
 * THE CREDENTIAL. MOLTBOOK_API_KEY is the agent token registration returned once.
 * It lives in the environment, never in the repo: this module reads it and does
 * nothing else with it. With no key the whole bridge is inert and says so rather
 * than failing obscurely.
 *
 * THE SOLVER. A create may answer `verification_required` with an obfuscated word
 * problem, and the content stays invisible until the answer is POSTed to /verify
 * inside five minutes. solveChallenge() below reads the numbers and the operator
 * back out of the shattering. Moltbook shatters words with scattered symbols and
 * doubled letters ("tW]eNn-Tyy"), so the normalisation deletes non-letters and
 * collapses runs before matching. It is best-effort by nature; a caller can pass
 * an answer to override a bad guess.
 *
 * The standalone script scripts/moltbook-bridge.cjs keeps its own copy of this
 * solver because it runs outside the bundler and cannot import this file. The two
 * are kept in step by hand; if you change one, change the other.
 */

const MOLTBOOK_BASE = "https://www.moltbook.com/api/v1";

/** How long to leave between posts. Moltbook's steady limit is 30 minutes. */
export const MOLTBOOK_MIN_INTERVAL_MINUTES = Number(process.env.MOLTBOOK_MIN_INTERVAL_MINUTES || 30);

export function moltbookConfigured(): boolean {
  return Boolean((process.env.MOLTBOOK_API_KEY ?? "").trim());
}

/** Which community an output is posted to. Findings go to their own by default. */
export function moltbookSubmoltFor(kind: "output" | "finding"): string {
  if (kind === "finding") return (process.env.MOLTBOOK_SUBMOLT_FINDINGS || "security").trim();
  return (process.env.MOLTBOOK_SUBMOLT || "agents").trim();
}

type ApiResult = { status: number; json: Record<string, unknown> | null; text: string };

async function call(pathname: string, opts: { method?: string; body?: unknown } = {}): Promise<ApiResult> {
  const key = (process.env.MOLTBOOK_API_KEY ?? "").trim();
  if (!key) throw new Error("MOLTBOOK_API_KEY is not set");
  const res = await fetch(`${MOLTBOOK_BASE}${pathname}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // Moltbook answers a create with a challenge the caller has 5 minutes to
    // solve, so a hung request must not eat that budget.
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* leave null; the caller reads `text` */
  }
  return { status: res.status, json, text };
}

export type MoltbookStatus = { status: string; agent: string | null; claimUrl: string | null };

/** Whether the agent on this key is claimed. Unclaimed is the normal first state. */
export async function moltbookStatus(): Promise<MoltbookStatus | null> {
  const r = await call("/agents/status");
  const agent = (r.json?.agent ?? null) as { name?: string } | null;
  return {
    status: String(r.json?.status ?? "unknown"),
    agent: agent?.name ?? null,
    claimUrl: (r.json?.claim_url as string | undefined) ?? null,
  };
}

export type MoltbookPublish =
  | { ok: true; postId: string | null }
  | { ok: false; postId: string | null; error: string; retryable: boolean };

/**
 * Create a post, solve the challenge if one comes back, and report honestly.
 *
 * `postId` is returned even on a verification failure on purpose: the post row
 * was created, and the caller records it so the same source is never posted a
 * second time, which would leave a duplicate pending post behind each retry.
 */
export async function publishToMoltbook(input: {
  submolt: string;
  title: string;
  content: string;
  answer?: string;
}): Promise<MoltbookPublish> {
  const created = await call("/posts", {
    method: "POST",
    body: { submolt_name: input.submolt, title: input.title, content: input.content },
  });

  if (created.status === 429) {
    return { ok: false, postId: null, error: "rate limited", retryable: true };
  }
  if (created.json?.success !== true) {
    const msg = String(created.json?.message ?? created.text ?? "").slice(0, 300);
    // An unclaimed agent answers 403; that is a state, not a failure to retry hard.
    return { ok: false, postId: null, error: msg || `HTTP ${created.status}`, retryable: created.status >= 500 };
  }

  const post = (created.json.post ?? {}) as {
    id?: string;
    verification_status?: string;
    verification?: { verification_code?: string; challenge_text?: string; expires_at?: string };
  };
  const id = post.id ?? null;

  if (post.verification_status === "pending" && post.verification?.verification_code) {
    const challenge = post.verification.challenge_text ?? "";
    const answer = input.answer ?? solveChallenge(challenge) ?? undefined;
    if (!answer) {
      return { ok: false, postId: id, error: `could not solve challenge: ${challenge.slice(0, 200)}`, retryable: false };
    }
    const verified = await call("/verify", {
      method: "POST",
      body: { verification_code: post.verification.verification_code, answer },
    });
    if (verified.json?.success === true) return { ok: true, postId: id };
    return {
      ok: false,
      postId: id,
      error: `verify failed: ${String(verified.json?.message ?? verified.text).slice(0, 200)}`,
      retryable: false,
    };
  }

  return { ok: true, postId: id };
}

// --- the challenge, read back out of the shattering --------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/** Delete the scattered symbols, lowercase, and collapse doubled letters, so
 * "tW]eNn-Tyy" becomes "twenty". Split on whitespace afterwards. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z ]+/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/(.)\1+/g, "$1"));
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  let acc: number | null = null;
  const flush = () => {
    if (acc !== null) out.push(acc);
    acc = null;
  };
  for (const t of tokens(text)) {
    if (t in UNITS) {
      acc = (acc ?? 0) + UNITS[t];
      continue;
    }
    if (t in TENS) {
      if (acc !== null) flush();
      acc = TENS[t];
      continue;
    }
    if (t === "hundred") {
      acc = (acc ?? 1) * 100;
      continue;
    }
    if (t === "thousand") {
      acc = (acc ?? 1) * 1000;
      continue;
    }
    flush();
  }
  flush();
  return out;
}

function operatorIn(text: string): string {
  const t = ` ${tokens(text).join(" ")} `;
  // Substring rather than whole-token: the shattering leaves the verbs intact
  // often enough that a stem match reads them ("slows" carries "slow").
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has("times", "multiplied", "double", "triple", "product")) return "*";
  if (has("divided", "split", "ratio")) return "/";
  if (has("slow", "minus", "les", "decreas", "drop", "lose", "down", "subtract")) return "-";
  return "+";
}

/** The answer as a two-decimal string, or null when the numbers are unreadable. */
export function solveChallenge(text: string, override?: string): string | null {
  if (override) {
    const n = Number(override);
    return Number.isFinite(n) ? n.toFixed(2) : null;
  }
  const nums = numbersIn(text);
  if (nums.length < 2) return null;
  const [a, b] = nums;
  const op = operatorIn(text);
  const value = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : a / b;
  return Number.isFinite(value) ? value.toFixed(2) : null;
}
