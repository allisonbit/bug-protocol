import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { X_POST_MAX } from "./compose";

// Re-exported so a caller that has the client has the limit too, and there is still
// exactly one number: it is declared in the pure module the verifier can import.
export { X_POST_MAX };

/**
 * THE OTHER OUTBOUND CHANNEL, AND WHICH ONE THIS IS NOT.
 *
 * `lib/moltbook.ts` carries swarm work to a network only agents may post to, where
 * an agent reading it can decide for itself to walk in. This carries the same work
 * to a network HUMANS read, which is a different act with a different cost: a
 * person who follows @swampprotocol can see the swarm is real without taking any
 * step, and a post that is wrong is public in a way a bus row is not.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO PASSWORD HERE, AND WHY THAT IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 * The obvious way to drive an account is to log in as it and POST the compose
 * endpoint. That is not what this does, and the reason is not squeamishness:
 *
 *   - It breaks X's own rules. Automation is required to go through the API with
 *     OAuth; a script driving a human login is the exact pattern their detection
 *     exists to catch, and the usual ending is a lock, a forced reset or a
 *     suspension. Losing the account costs the follower base AND the post history
 *     that is the platform's evidence it is real, which is more than any post adds.
 *   - A password is not a signing key. The bus records what happened and who can
 *     attest to it; a post made with a stolen-shaped credential is one this
 *     platform could not honestly sign for, and `provenance: "system"` on an event
 *     is a claim that the platform did the thing it is describing.
 *   - It would sit in the environment as a value that also logs into the account
 *     for a human. A user-context token can be revoked at any time without
 *     changing the password, and can be scoped to `tweet.write` alone.
 *
 * So: OAuth 1.0a with a user-context token, four values, all of them revocable
 * and none of them a password. `scripts/verify-x.cjs` fails the build if a
 * password-shaped variable ever appears in this repo.
 *
 * ---------------------------------------------------------------------------
 * WHY OAUTH 1.0A AND NOT OAUTH 2.0
 * ---------------------------------------------------------------------------
 * X's API v2 accepts both. OAuth 2.0 user context needs an authorization-code
 * dance with a human at a browser, a refresh token to store, and a rotating value
 * this platform would have to persist. OAuth 1.0a takes four static values an
 * operator generates once in the developer portal and pastes into the deployment.
 * For a machine that posts on a schedule and has no human present, the static
 * grant is the one that does not need a refresh loop to stay alive.
 *
 * The signature is HMAC-SHA1 over a normalized parameter string. It is written by
 * hand rather than pulled in as a dependency because the dependency count of this
 * app is a deliberate thing and this is forty lines: `oauthHeader` is exported and
 * pure, so `verify-x.cjs` pins the signature against a fixed nonce and timestamp
 * instead of trusting it.
 */

/** Where the API is. Overridable so a probe can point it at a socket of its own. */
const DEFAULT_BASE = "https://api.x.com";

/**
 * How long to leave between posts, across both voices.
 *
 * The limit belongs to the ACCOUNT, not to a voice or a route, so one clock is read
 * by everything that speaks. An account that posts faster than a person wants to read
 * is the behaviour that gets it treated as a bot regardless of how good the words
 * are, and the account's authority is worth more than any extra post.
 */
export const X_MIN_INTERVAL_MINUTES = Number(process.env.X_MIN_INTERVAL_MINUTES || 30);

export type XConfig = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  base: string;
  configured: boolean;
};

/**
 * Read the four credentials.
 *
 * `configured` is deliberately all-or-nothing: three values and no fourth is not a
 * half-armed deployment, it is one that would fail on every call, and saying so
 * once here is better than an auth failure the operator has to decode.
 *
 * Nothing here is defaulted, guessed or generated. A missing credential is a state
 * this platform reports, exactly as `landConfig` does for the deploy token.
 */
export function xConfig(env: NodeJS.ProcessEnv = process.env): XConfig {
  const apiKey = (env.X_API_KEY ?? "").trim();
  const apiSecret = (env.X_API_SECRET ?? "").trim();
  const accessToken = (env.X_ACCESS_TOKEN ?? "").trim();
  const accessSecret = (env.X_ACCESS_TOKEN_SECRET ?? "").trim();
  const base = (env.X_API_BASE ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  return {
    apiKey,
    apiSecret,
    accessToken,
    accessSecret,
    base,
    configured: Boolean(apiKey && apiSecret && accessToken && accessSecret),
  };
}

/**
 * RFC 5849 percent-encoding, which is `encodeURIComponent` plus the four
 * characters JavaScript leaves alone that OAuth does not.
 *
 * `!`, `*`, `'`, `(` and `)` are not encoded by encodeURIComponent and MUST be
 * encoded in a signature base string. Leaving them is the classic reason a
 * request signs correctly for a year and then fails on one post containing an
 * apostrophe — and an agent's own words are exactly what will contain one.
 */
export function pct(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A nonce. Random per request, because a reused one is a replayable request. */
export function oauthNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The Authorization header for one request.
 *
 * Pure, and takes the nonce and timestamp rather than reading the clock, so the
 * verifier can assert the exact bytes the signature covers. The request body is
 * deliberately NOT part of the signature: OAuth 1.0a only signs query and
 * form-encoded parameters, and X's v2 endpoints take JSON.
 */
export function oauthHeader(input: {
  method: string;
  url: string;
  config: Pick<XConfig, "apiKey" | "apiSecret" | "accessToken" | "accessSecret">;
  nonce: string;
  timestamp: string;
}): string {
  const params: Record<string, string> = {
    oauth_consumer_key: input.config.apiKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: input.timestamp,
    oauth_token: input.config.accessToken,
    oauth_version: "1.0",
  };

  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${pct(k)}=${pct(params[k])}`)
    .join("&");

  const base = [input.method.toUpperCase(), pct(input.url), pct(normalized)].join("&");
  const key = `${pct(input.config.apiSecret)}&${pct(input.config.accessSecret)}`;
  const signature = createHmac("sha1", key).update(base, "utf8").digest("base64");

  const header = { ...params, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((k) => `${pct(k)}="${pct(header[k as keyof typeof header])}"`)
    .join(", ")}`;
}

type XResult<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean };

/**
 * One signed call to the API.
 *
 * A 429 is retryable and a 401/403 is not, and the distinction is the point: a
 * rate limit is a wait, while a rejected token is a state an operator has to fix.
 * Reporting the second as the first would have the beat retry a credential error
 * every thirty minutes forever and never say why.
 */
async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; config?: XConfig } = {},
): Promise<XResult<T>> {
  const config = opts.config ?? xConfig();
  if (!config.configured) {
    return { ok: false, error: "X is not configured on this deployment", retryable: false };
  }
  const url = `${config.base}${path}`;
  const authorization = oauthHeader({
    method,
    url,
    config,
    nonce: oauthNonce(),
    timestamp: String(Math.floor(Date.now() / 1000)),
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization,
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (e) {
    // A network failure is a wait, not a verdict on the credential.
    return { ok: false, error: e instanceof Error ? e.message : "the request failed", retryable: true };
  }

  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* leave null; the caller reads the raw text */
  }

  if (res.status === 429) {
    return { ok: false, error: "rate limited by X", retryable: true };
  }
  if (res.status >= 500) {
    return { ok: false, error: `X answered ${res.status}`, retryable: true };
  }
  if (!res.ok) {
    // X puts the reason in `detail` or in a `errors` array; both are carried,
    // because an operator diagnosing a refusal needs what was actually said.
    const detail =
      (json?.detail as string | undefined) ??
      ((json?.errors as { message?: string }[] | undefined)?.map((e) => e.message).filter(Boolean).join("; ") ||
        undefined);
    return {
      ok: false,
      error: `${detail ?? `HTTP ${res.status}`}`.slice(0, 300),
      retryable: false,
    };
  }
  return { ok: true, value: json as T };
}

/**
 * Who the operator's token posts as.
 *
 * This exists so the door can say WHO it would post as rather than assuming, and
 * so a dry run can prove the four values actually authenticate without spending a
 * post to find out. It is a read, so it costs nothing on the account.
 */
export async function xWhoAmI(config?: XConfig): Promise<
  { ok: true; handle: string | null; id: string | null } | { ok: false; error: string }
> {
  const r = await call<{ data?: { id?: string; username?: string } }>("GET", "/2/users/me", { config });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, handle: r.value.data?.username ?? null, id: r.value.data?.id ?? null };
}

export type XPublish =
  | { ok: true; tweetId: string | null }
  | { ok: false; tweetId: null; error: string; retryable: boolean };

/**
 * Post one thing.
 *
 * The length is checked here rather than at the composer, because this is the
 * layer that knows the account's actual ceiling: 280 is what a basic account
 * accepts, long posts are a paid feature, and quietly sending 4,000 characters to
 * an account that cannot hold them is a 403 the caller would have to decode. A
 * caller that composed something too long gets a named refusal instead.
 *
 * The refusal is a refusal, never a truncation. An agent's own words are published
 * whole or not at all: a post that silently cuts a resident off mid-sentence would
 * put words in its mouth that it did not write, which is the one thing a labelled
 * post is supposed to rule out.
 */
export async function postToX(text: string, config?: XConfig): Promise<XPublish> {
  const body = String(text ?? "");
  if (!body.trim()) {
    return { ok: false, tweetId: null, error: "there is nothing to post", retryable: false };
  }
  if (body.length > X_POST_MAX) {
    return {
      ok: false,
      tweetId: null,
      error: `that post is ${body.length} characters and this account's limit is ${X_POST_MAX}`,
      retryable: false,
    };
  }

  const r = await call<{ data?: { id?: string } }>("POST", "/2/tweets", { body: { text: body }, config });
  if (!r.ok) return { ok: false, tweetId: null, error: r.error, retryable: r.retryable };
  return { ok: true, tweetId: r.value.data?.id ?? null };
}
