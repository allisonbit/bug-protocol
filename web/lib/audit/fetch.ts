import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * THE GUARDED FETCH: reading a stranger's document without becoming their client.
 *
 * WHY THIS NEEDS A MODULE OF ITS OWN. The audit surface is asked to look at a skill at
 * a URL, which means this deployment makes an outbound request to an address a caller
 * chose. That is a server side request forgery surface, and the interesting cases are
 * not exotic: `http://169.254.169.254/` is the cloud metadata service, `http://localhost:5432`
 * is a database, `http://10.0.0.5/admin` is whatever is on the private network, and
 * `https://www.swampai.world/api/...` is this deployment asking itself.
 *
 * SO THE RULES ARE NARROW AND THEY FAIL CLOSED. https only, because a payment proof or
 * a token in flight over plain http is readable and changeable. The host must resolve
 * to public addresses only, checked after resolution rather than by string matching,
 * because `https://spoofed.example.com` can resolve to 127.0.0.1 and a name is not an
 * address. Our own hostnames are refused. Redirects are followed only while they stay
 * on the original host, because following one off host is how the first three rules get
 * walked around. A byte cap and a timeout bound what a slow or endless response can do.
 *
 * WHAT IT DOES NOT DO. It does not follow a redirect to a different port or scheme, it
 * does not send credentials, it does not reuse a connection, and it does not retry: a
 * failed read is reported as a failed read, because an audit of bytes we could not
 * fetch is not an audit.
 */

const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 3;

export type FetchRefusal = { ok: false; code: string; reason: string };
export type FetchResult =
  | { ok: true; url: string; status: number; contentType: string; text: string; bytes: number; hops: number }
  | FetchRefusal;

/** IPv4 and IPv6 ranges a public service must never be asked to reach. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return false;
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.replace("::ffff:", ""));
    return true;
  }
  return false;
}

/** Hostnames that name a local or internal destination regardless of resolution. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".test", ".invalid", ".example"];

/**
 * Everything that can be decided about a URL before any DNS query, as a pure function.
 *
 * Separated from the fetch so every refusal is a check a verifier can call directly,
 * with no network involved, which is the only way to be sure the guard is exercised
 * rather than assumed.
 */
export function validateAuditUrl(
  raw: string,
  selfHosts: string[] = [],
): { ok: true; url: URL } | FetchRefusal {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "BAD_URL", reason: "That is not a URL. An absolute https URL is required, including the scheme." };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "NOT_HTTPS",
      reason: `Only https is fetched. ${url.protocol.replace(":", "")} is refused because an audit should not be the reason a document crosses the network unprotected.`,
    };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, code: "BAD_URL", reason: "That URL has no host." };
  if (isIP(host) && !isPublicAddress(host)) {
    return { ok: false, code: "PRIVATE_HOST", reason: `${host} is a private or reserved address, and this deployment will not connect to one on a caller's behalf.` };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, code: "PRIVATE_HOST", reason: `${host} names a local or internal destination.` };
  }
  if (selfHosts.some((h) => host === h.toLowerCase())) {
    return {
      ok: false,
      code: "SELF",
      reason: `${host} is this deployment. Fetching our own host from the audit door would let a caller make the server call itself, so a document here is audited by submitting its bytes instead.`,
    };
  }
  if (url.port && !["", "443"].includes(url.port)) {
    return { ok: false, code: "ODD_PORT", reason: `Only the default https port is fetched, and this URL names ${url.port}.` };
  }
  return { ok: true, url };
}

/** Resolve the host and refuse anything that lands on a non public address. */
async function hostIsPublic(host: string): Promise<{ ok: true } | FetchRefusal> {
  if (isIP(host)) {
    return isPublicAddress(host)
      ? { ok: true }
      : { ok: false, code: "PRIVATE_HOST", reason: `${host} is a private or reserved address.` };
  }
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return { ok: false, code: "DNS_EMPTY", reason: `${host} did not resolve to any address.` };
    const blocked = addresses.filter((a) => !isPublicAddress(a.address));
    if (blocked.length > 0) {
      return {
        ok: false,
        code: "PRIVATE_HOST",
        reason: `${host} resolves to ${blocked[0].address}, which is a private or reserved address.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "DNS_FAILED", reason: `${host} could not be resolved: ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}

/**
 * Fetch one public https document, under the rules above.
 *
 * The response body is read through a streaming reader rather than by `text()`, so the
 * byte cap stops an endless response instead of discovering its size afterwards.
 */
export async function fetchForAudit(raw: string, selfHosts: string[] = []): Promise<FetchResult> {
  const first = validateAuditUrl(raw, selfHosts);
  if (!first.ok) return first;
  const originHost = first.url.hostname.toLowerCase();

  let current = first.url;
  let hops = 0;
  while (hops <= MAX_HOPS) {
    const reachable = await hostIsPublic(current.hostname);
    if (!reachable.ok) return reachable;

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: "text/markdown, text/plain;q=0.9, application/json;q=0.9, */*;q=0.5",
          "user-agent": "swampai-audit/1 (+https://www.swampai.world/audits)",
        },
      });
    } catch (e) {
      return { ok: false, code: "FETCH_FAILED", reason: `${current.hostname} could not be read: ${e instanceof Error ? e.message : "unknown error"}.` };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, code: "FETCH_FAILED", reason: `${current.hostname} answered ${res.status} with no location.` };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, code: "FETCH_FAILED", reason: `The redirect target is not a URL: ${location.slice(0, 120)}` };
      }
      if (next.hostname.toLowerCase() !== originHost) {
        return {
          ok: false,
          code: "REDIRECT_OFF_HOST",
          reason: `${current.hostname} redirects to ${next.hostname}, which is a different host. Following that would let any address reach any other, so it is refused.`,
        };
      }
      const valid = validateAuditUrl(next.toString(), selfHosts);
      if (!valid.ok) return valid;
      current = next;
      hops += 1;
      continue;
    }

    if (!res.ok) {
      return { ok: false, code: "HTTP_ERROR", reason: `${current.hostname} answered ${res.status}. This audits a document, so a document has to be served.` };
    }

    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > MAX_BYTES) {
      return { ok: false, code: "TOO_LARGE", reason: `The document declares ${length} bytes, above the ${MAX_BYTES} byte limit.` };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, code: "FETCH_FAILED", reason: "The response carried no body." };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: "TOO_LARGE", reason: `The document is larger than the ${MAX_BYTES} byte limit. This audits a skill or a card, not an archive.` };
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return {
      ok: true,
      url: current.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
      bytes: total,
      hops,
    };
  }
  return { ok: false, code: "TOO_MANY_HOPS", reason: `More than ${MAX_HOPS} redirects on the same host.` };
}

/** The hostnames this deployment refuses to fetch: itself. */
export function selfHosts(siteUrl: string): string[] {
  const hosts = [siteUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()];
  const extra = (process.env.AUDIT_SELF_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...hosts, ...extra])];
}
