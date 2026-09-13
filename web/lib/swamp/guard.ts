import "server-only";
import { SITE_URL } from "@/lib/site";

/**
 * Host safety for the runtime's outbound checks.
 *
 * The runtime makes HTTP requests to hosts named in a `targets.domains` array.
 * That array is written by a signed-in user, which makes it USER-CONTROLLED INPUT
 * reaching a server-side fetch — an SSRF primitive if taken at face value. A
 * function running on Vercel can reach link-local addresses (169.254.169.254) and
 * private ranges the public internet cannot, so "just fetch what the row says"
 * would let a user register a name that resolves inward and have Swamp probe its
 * own network on their behalf.
 *
 * So every outbound request goes through assertPublicHost() first, which refuses:
 *   - IP literals in any encoding (dotted, bare decimal, hex, and every IPv6 form)
 *   - internal names and suffixes (localhost, *.internal, *.local, …)
 *   - names that do not resolve, and names that RESOLVE to a private or reserved
 *     address — resolution happens first, over DNS-over-HTTPS, so a rebinding
 *     answer is refused before the request is made rather than after it.
 *
 * That last one is the important one: checking the string alone is not enough,
 * because `evil.example` is a perfectly ordinary name right up until it answers
 * with 127.0.0.1.
 */

// ---- IP classification ------------------------------------------------------

/** True for anything in a private, loopback, link-local, or reserved range. */
function ipv4Reserved(ip: string): boolean {
  const p = ip.split(".").map(Number);
  // Malformed is treated as unsafe: if we can't read it, we don't allow it.
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8      "this network"
  if (a === 10) return true; // 10/8           private
  if (a === 127) return true; // 127/8          loopback
  if (a === 169 && b === 254) return true; // 169.254/16     link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12      private
  if (a === 192 && b === 168) return true; // 192.168/16     private
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15      benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10      CGNAT
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function ipv6Reserved(ip: string): boolean {
  const s = ip.toLowerCase().trim();
  if (s === "::" || s === "::1") return true; // unspecified / loopback
  if (s.startsWith("fe80")) return true; // link-local
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local
  if (s.startsWith("ff")) return true; // multicast
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return ipv4Reserved(mapped[1]);
  return false;
}

/**
 * Is this hostname an IP literal? Covers the encodings an attacker actually
 * uses to slip past a naive check: dotted-quad, bare decimal (2130706433), hex
 * (0x7f000001), and anything containing a colon (every IPv6 spelling).
 */
function isIpLiteral(h: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(":")) return true;
  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  return false;
}

const BLOCKED_NAMES = new Set(["localhost", "metadata", "instance-data"]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

// ---- DNS over HTTPS ---------------------------------------------------------

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type DohAnswer = { data: string; type: number };

export type DohResult = { ok: true; answers: DohAnswer[]; status: number } | { ok: false; answers: [] };

/**
 * One DNS lookup over HTTPS. Used both to guard a host and as a check in its own
 * right — resolving through DoH rather than the system resolver keeps the runtime
 * from depending on the host's DNS config, and gives structured answers.
 */
export async function doh(name: string, type: "A" | "AAAA" | "TXT" | "CAA" | "MX"): Promise<DohResult> {
  try {
    const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, answers: [] };
    const json = (await res.json()) as { Status?: number; Answer?: { data?: string; type?: number }[] };
    const answers = (json.Answer ?? [])
      .map((a) => ({ data: String(a.data ?? "").trim(), type: Number(a.type ?? 0) }))
      .filter((a) => a.data.length > 0);
    return { ok: true, answers, status: Number(json.Status ?? 0) };
  } catch {
    return { ok: false, answers: [] };
  }
}

// ---- the guard --------------------------------------------------------------

export type HostVerdict = { ok: true; host: string; addresses: string[] } | { ok: false; reason: string };

/**
 * Decide whether the runtime may talk to this host at all. Refuses on the string
 * first (cheap) and then on the resolved addresses (the one that actually
 * matters), so a name that points somewhere private never gets a request.
 */
export async function assertPublicHost(raw: string): Promise<HostVerdict> {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "empty host" };
  if (host.length > 253) return { ok: false, reason: "host too long" };
  if (isIpLiteral(host)) return { ok: false, reason: "IP literals are not allowed" };
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: "host contains characters that are not allowed" };
  if (BLOCKED_NAMES.has(host)) return { ok: false, reason: `"${host}" is an internal name` };
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `"${host}" is an internal or non-public suffix` };
  }
  if (!host.includes(".")) return { ok: false, reason: "not a fully-qualified domain name" };

  const [a, aaaa] = await Promise.all([doh(host, "A"), doh(host, "AAAA")]);
  const addresses = [...a.answers, ...aaaa.answers].map((x) => x.data);
  // Strip the trailing dot Cloudflare returns on some records.
  const cleaned = addresses.map((ip) => ip.replace(/\.$/, ""));
  if (cleaned.length === 0) return { ok: false, reason: `"${host}" does not resolve` };

  for (const ip of cleaned) {
    if (ipv4Reserved(ip) || ipv6Reserved(ip)) {
      return { ok: false, reason: `"${host}" resolves to a private or reserved address (${ip})` };
    }
  }
  return { ok: true, host, addresses: cleaned };
}

// ---- outbound requests ------------------------------------------------------

/**
 * Who we say we are. A scanner that does not identify itself and offer a contact
 * is just traffic; every target owner deserves to know what hit them and how to
 * make it stop. This is the runtime's calling card and it is not configurable
 * down to something anonymous.
 */
export const SWAMP_USER_AGENT = `SwampBot/1.0 (+${SITE_URL}/how; passive security-posture checks; opt out by closing the target)`;

export type PassiveResponse = {
  ok: true;
  status: number;
  headers: Headers;
  location: string | null;
};

/**
 * One bounded GET, and never more than one.
 *
 * `redirect: "manual"` is a security control, not a preference. Following a
 * redirect would re-issue the request to a URL the TARGET chose, AFTER the guard
 * has already run — so `302 -> http://169.254.169.254/` would sail straight past
 * assertPublicHost() and into the cloud metadata service. The runtime therefore
 * never chases a redirect: it records where it was sent and stops. That is also
 * the honest passive posture — we look at one response, we do not crawl.
 */
export async function passiveGet(
  host: string,
  path: string,
  timeoutMs = 8000,
): Promise<PassiveResponse | { ok: false; error: string }> {
  const p = path.startsWith("/") ? path : `/${path}`;
  try {
    const res = await fetch(`https://${host}${p}`, {
      method: "GET",
      // Headers only — we never want the page. Cancelling the body keeps a large
      // or slow response from holding the connection open.
      headers: { "user-agent": SWAMP_USER_AGENT, accept: "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const location = res.headers.get("location");
    const snapshot: PassiveResponse = { ok: true, status: res.status, headers: res.headers, location };
    await res.body?.cancel().catch(() => {});
    return snapshot;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

// ---- reading a bounded amount of body --------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read at most 64 KiB of a response as text. The two files the runtime actually
 * reads (security.txt, robots.txt) are tiny by specification; this bound means a
 * target cannot hand us a 4 GB "robots.txt" and turn a check into a resource
 * problem. Truncation is recorded, not hidden.
 */
export async function readCappedText(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, value.byteLength - (total - MAX_BODY_BYTES)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

/**
 * A bounded GET that also returns a little of the body — used only for the two
 * well-known text files, never for pages. Still one request, still no redirects.
 */
export async function passiveGetText(
  host: string,
  path: string,
  timeoutMs = 8000,
): Promise<{ ok: true; status: number; headers: Headers; text: string; truncated: boolean } | { ok: false; error: string }> {
  const p = path.startsWith("/") ? path : `/${path}`;
  try {
    const res = await fetch(`https://${host}${p}`, {
      method: "GET",
      headers: { "user-agent": SWAMP_USER_AGENT, accept: "text/plain,*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const { text, truncated } = res.ok ? await readCappedText(res) : { text: "", truncated: false };
    if (!res.ok) await res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status, headers: res.headers, text, truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}
