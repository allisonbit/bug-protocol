import "server-only";
import tls from "node:tls";
import type { FindingSeverity } from "@/lib/agents/types";
import { doh, passiveGet, passiveGetText } from "./guard";

/**
 * THE ACTION CATALOGUE: the complete set of things a Swamp-hosted agent can do.
 *
 * This file is deliberately small, closed, and dull. Everything here is:
 *
 *   - PASSIVE: it reads what the target already serves to anyone. Nothing
 *                    is sent, submitted, uploaded, or injected.
 *   - SINGLE: exactly one bounded request per check. No loops over paths,
 *                    no wordlists, no parameter sweeps, no retries on failure.
 *   - NON-INTRUSIVE: no auth attempts, no bypass techniques, no fuzzing, no
 *                    load. A check cannot degrade the target's service, because
 *                    a check cannot make the target do work.
 *   - IDENTIFIED: every request carries SWAMP_USER_AGENT with a URL and an
 *                    opt-out. Nothing here hides.
 *
 * There is no flooding, no amplification, no resource exhaustion, and no
 * concurrency against a single host, not "disabled by a flag", but absent from
 * the catalogue. Adding an action means adding it here, where it is reviewable,
 * and it has to pass the four tests above.
 *
 * A check returns an `observation` (a real sentence derived from what was
 * actually seen) and, only when the observation is a genuine gap, a `finding`.
 * The evidence is always recorded either way, a check that found nothing still
 * proves it looked, which is what keeps the feed from being theatre.
 */

export type CheckId = "security_txt" | "security_headers" | "tls_certificate" | "robots_policy" | "dns_posture";

export type FindingDraft = {
  title: string;
  severity: FindingSeverity;
  summary: string;
  evidence: Record<string, unknown>;
};

export type CheckOutcome = {
  id: CheckId;
  host: string;
  /** Did the check actually complete? `false` means the target was unreachable, not a finding. */
  ok: boolean;
  /** One sentence of real observation. Feeds the agent's voice; never generic. */
  observation: string;
  evidence: Record<string, unknown>;
  /** Only when the observation is a genuine gap. Most checks most of the time produce null. */
  finding: FindingDraft | null;
};

export type CheckSpec = {
  id: CheckId;
  label: string;
  /** Published on the agent page and in /connect, so the catalogue is auditable from outside. */
  describes: string;
  run: (host: string) => Promise<CheckOutcome>;
};

// ---- helpers ----------------------------------------------------------------

/** A host with exactly two labels is *likely* the registrable domain. Used only to
 * decide whether a DNS absence means anything, see dns_posture. */
function isApex(host: string): boolean {
  return host.split(".").length === 2;
}

function daysUntil(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

/** Node types an X.509 name field as `string | string[]` (a field may repeat).
 * Normalize to the first value so evidence stays a flat record. */
function firstString(v: string | string[] | undefined | null): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function base(id: CheckId, host: string): Pick<CheckOutcome, "id" | "host"> {
  return { id, host };
}

// ---- 1. security.txt --------------------------------------------------------

/**
 * Is there a published route to report a vulnerability? RFC 9116 puts it at
 * /.well-known/security.txt. Absence is the single most common real gap on an
 * otherwise well-run site, and it is the one gap that directly costs the target
 * something: a researcher with no route either gives up or guesses.
 */
async function securityTxt(host: string): Promise<CheckOutcome> {
  const res = await passiveGetText(host, "/.well-known/security.txt");
  if (!res.ok) {
    return {
      ...base("security_txt", host),
      ok: false,
      observation: `Could not reach ${host}/.well-known/security.txt (${res.error}).`,
      evidence: { url: `https://${host}/.well-known/security.txt`, error: res.error },
      finding: null,
    };
  }

  const evidence: Record<string, unknown> = { url: `https://${host}/.well-known/security.txt`, status: res.status };

  if (res.status === 404 || res.status === 410) {
    return {
      ...base("security_txt", host),
      ok: true,
      observation: `${host} publishes no security.txt, so a researcher who finds something here has no listed way to report it.`,
      evidence,
      finding: {
        title: `No vulnerability disclosure route published on ${host}`,
        severity: "low",
        summary:
          `https://${host}/.well-known/security.txt returns ${res.status}. RFC 9116 defines this file as the ` +
          `standard place to publish how to report a vulnerability. Without it, a finder has no stated channel ` +
          `and no stated terms, which is how good-faith reports get lost or go public by default.`,
        evidence,
      },
    };
  }

  if (res.status !== 200) {
    return {
      ...base("security_txt", host),
      ok: true,
      observation: `${host}/.well-known/security.txt returned HTTP ${res.status}, so the disclosure route is unclear.`,
      evidence,
      finding: null,
    };
  }

  // Present, read it, and check the two fields that actually matter.
  const text = res.text;
  const contacts = [...text.matchAll(/^\s*Contact:\s*(.+)$/gim)].map((m) => m[1].trim());
  const expiresRaw = /^\s*Expires:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null;
  const expiresIn = expiresRaw ? daysUntil(expiresRaw) : null;
  Object.assign(evidence, {
    contact_count: contacts.length,
    contacts: contacts.slice(0, 5),
    expires: expiresRaw,
    expires_in_days: expiresIn,
    truncated: res.truncated,
  });

  if (contacts.length === 0) {
    return {
      ...base("security_txt", host),
      ok: true,
      observation: `${host} serves a security.txt but it lists no Contact field, so it names no route.`,
      evidence,
      finding: {
        title: `security.txt on ${host} has no Contact field`,
        severity: "low",
        summary:
          `The file exists at https://${host}/.well-known/security.txt but carries no Contact: field. RFC 9116 ` +
          `requires one; without it the file declares an intention to receive reports without saying where.`,
        evidence,
      },
    };
  }

  if (expiresIn !== null && expiresIn < 0) {
    return {
      ...base("security_txt", host),
      ok: true,
      observation: `${host}'s security.txt expired ${Math.abs(expiresIn)} days ago (${expiresRaw}).`,
      evidence,
      finding: {
        title: `security.txt on ${host} has expired`,
        severity: "info",
        summary:
          `The Expires field (${expiresRaw}) is in the past. Per RFC 9116 the file should be treated as stale, ` +
          `so the contact it lists may no longer be monitored.`,
        evidence,
      },
    };
  }

  return {
    ...base("security_txt", host),
    ok: true,
    observation:
      `${host} publishes a disclosure route (${contacts.length} contact${contacts.length === 1 ? "" : "s"})` +
      (expiresIn !== null ? `, valid for ${expiresIn} more days.` : "."),
    evidence,
    finding: null,
  };
}

// ---- 2. HTTP security headers ----------------------------------------------

const SECURITY_HEADERS = [
  { name: "strict-transport-security", title: "HSTS", severity: "low" as FindingSeverity },
  { name: "content-security-policy", title: "Content-Security-Policy", severity: "info" as FindingSeverity },
  { name: "x-content-type-options", title: "X-Content-Type-Options", severity: "info" as FindingSeverity },
  { name: "referrer-policy", title: "Referrer-Policy", severity: "info" as FindingSeverity },
];

/**
 * One GET of `/`. Only response headers are read; the body is cancelled unread.
 * We do not follow a redirect, because headers set by a redirecting edge say
 * nothing about the application behind it, so a 3xx is recorded as exactly that
 * and judged no further.
 */
async function securityHeaders(host: string): Promise<CheckOutcome> {
  const res = await passiveGet(host, "/");
  if (!res.ok) {
    return {
      ...base("security_headers", host),
      ok: false,
      observation: `Could not reach https://${host}/ (${res.error}).`,
      evidence: { url: `https://${host}/`, error: res.error },
      finding: null,
    };
  }

  const evidence: Record<string, unknown> = { url: `https://${host}/`, status: res.status };

  if (res.status >= 300 && res.status < 400) {
    return {
      ...base("security_headers", host),
      ok: true,
      observation: `https://${host}/ redirects (${res.status}${res.location ? ` to ${res.location}` : ""}); headers not judged.`,
      evidence: { ...evidence, location: res.location },
      finding: null,
    };
  }

  const present: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const h of SECURITY_HEADERS) {
    const v = res.headers.get(h.name);
    present[h.name] = v;
    if (!v) missing.push(h.name);
  }
  Object.assign(evidence, { headers: present, missing });

  // HSTS is the one with a real consequence, so it gets the finding. It is also
  // the one whose absence is unambiguous over HTTPS: the site already serves
  // TLS, it just does not tell browsers to require it next time.
  const hsts = present["strict-transport-security"];
  if (!hsts) {
    return {
      ...base("security_headers", host),
      ok: true,
      observation: `${host} serves HTTPS with no Strict-Transport-Security header${missing.length > 1 ? ` (also missing ${missing.length - 1} other hardening headers)` : ""}.`,
      evidence,
      finding: {
        title: `HSTS not set on ${host}`,
        severity: "low",
        summary:
          `https://${host}/ responds over TLS but sends no Strict-Transport-Security header, so a browser is ` +
          `free to reach the site over plain HTTP on a later visit, the window a downgrade or cookie-stripping ` +
          `attack needs. The site already has a certificate; this is the header that makes it mandatory.`,
        evidence,
      },
    };
  }

  return {
    ...base("security_headers", host),
    ok: true,
    observation: `${host} sets HSTS (${hsts})${missing.length ? `; ${missing.length} other hardening header${missing.length === 1 ? "" : "s"} absent.` : " and the other hardening headers we look for."}`,
    evidence,
    finding: null,
  };
}

// ---- 3. TLS certificate -----------------------------------------------------

type TlsProbe =
  | {
      ok: true;
      authorized: boolean;
      authorizationError: string | null;
      protocol: string | null;
      validTo: string | null;
      validFrom: string | null;
      issuer: string | null;
      subject: string | null;
      san: string | null;
      fingerprint256: string | null;
    }
  | { ok: false; error: string };

/**
 * A raw TLS handshake to port 443. `rejectUnauthorized: false` is not a bypass,
  * it is the point: a certificate we refuse to look at cannot be reported on. The
 * connection is read-only, completes the handshake, and is destroyed
 * immediately; nothing is sent over it.
 */
function tlsProbe(host: string): Promise<TlsProbe> {
  return new Promise<TlsProbe>((resolve) => {
    let settled = false;
    const done = (v: TlsProbe) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(
        { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000, ALPNProtocols: ["http/1.1"] },
        () => {
          try {
            const cert = socket.getPeerCertificate(false);
            done({
              ok: true,
              authorized: socket.authorized,
              authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
              protocol: socket.getProtocol(),
              validTo: cert?.valid_to ?? null,
              validFrom: cert?.valid_from ?? null,
              issuer: firstString(cert?.issuer?.O) ?? firstString(cert?.issuer?.CN),
              subject: firstString(cert?.subject?.CN),
              san: firstString(cert?.subjectaltname),
              fingerprint256: cert?.fingerprint256 ?? null,
            });
          } catch (e) {
            done({ ok: false, error: e instanceof Error ? e.message : "certificate unreadable" });
          } finally {
            socket.destroy();
          }
        },
      );
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : "TLS connect failed" });
      return;
    }

    socket.on("error", (e) => {
      done({ ok: false, error: e.message || "TLS handshake failed" });
      socket.destroy();
    });
    socket.on("timeout", () => {
      done({ ok: false, error: "TLS handshake timed out" });
      socket.destroy();
    });
  });
}

async function tlsCertificate(host: string): Promise<CheckOutcome> {
  const probe = await tlsProbe(host);
  if (!probe.ok) {
    return {
      ...base("tls_certificate", host),
      ok: false,
      observation: `${host} did not complete a TLS handshake on 443 (${probe.error}).`,
      evidence: { host, port: 443, error: probe.error },
      finding: null,
    };
  }

  const evidence: Record<string, unknown> = {
    host,
    port: 443,
    authorized: probe.authorized,
    authorization_error: probe.authorizationError,
    protocol: probe.protocol,
    valid_from: probe.validFrom,
    valid_to: probe.validTo,
    issuer: probe.issuer,
    subject: probe.subject,
    fingerprint_sha256: probe.fingerprint256,
  };

  const expiresIn = probe.validTo ? daysUntil(probe.validTo) : null;
  const expired = expiresIn !== null && expiresIn < 0;
  const weakProtocol = probe.protocol !== null && !/^TLSv1\.[23]$/.test(probe.protocol);

  if (expired) {
    Object.assign(evidence, { expires_in_days: expiresIn });
    return {
      ...base("tls_certificate", host),
      ok: true,
      observation: `${host}'s certificate expired ${Math.abs(expiresIn!)} days ago (valid to ${probe.validTo}).`,
      evidence,
      finding: {
        title: `Expired TLS certificate on ${host}`,
        severity: "high",
        summary:
          `The certificate presented on ${host}:443 expired on ${probe.validTo}. Visitors get an interstitial ` +
          `warning and cannot reach the site without clicking through it; automated clients that verify ` +
          `certificates fail outright.`,
        evidence,
      },
    };
  }

  if (!probe.authorized) {
    return {
      ...base("tls_certificate", host),
      ok: true,
      observation: `${host}'s certificate does not validate against the system trust store (${probe.authorizationError ?? "unknown reason"}).`,
      evidence,
      finding: {
        title: `TLS certificate on ${host} does not validate`,
        severity: "high",
        summary:
          `A certificate was presented for ${host} but verification failed: ${probe.authorizationError ?? "unknown reason"}. ` +
          `A client that verifies certificates, every browser, every API client, refuses the connection.`,
        evidence,
      },
    };
  }

  if (expiresIn !== null && expiresIn <= 14) {
    Object.assign(evidence, { expires_in_days: expiresIn });
    return {
      ...base("tls_certificate", host),
      ok: true,
      observation: `${host}'s certificate expires in ${expiresIn} day${expiresIn === 1 ? "" : "s"} (${probe.validTo}).`,
      evidence,
      finding: {
        title: `TLS certificate on ${host} expires in ${expiresIn} days`,
        severity: "low",
        summary:
          `The certificate valid to ${probe.validTo} is close to expiry. Renewal is usually automatic, so this ` +
          `is a check-in rather than an incident, but if automation has quietly stopped, this is the warning ` +
          `that precedes an outage.`,
        evidence,
      },
    };
  }

  if (weakProtocol) {
    return {
      ...base("tls_certificate", host),
      ok: true,
      observation: `${host} negotiated ${probe.protocol}, which is deprecated.`,
      evidence,
      finding: {
        title: `${probe.protocol} negotiated on ${host}`,
        severity: "medium",
        summary:
          `The handshake settled on ${probe.protocol}. TLS 1.0 and 1.1 are deprecated by RFC 8996 and are ` +
          `refused by current browsers, so a client that can only reach this version cannot reach the site at all.`,
        evidence,
      },
    };
  }

  Object.assign(evidence, { expires_in_days: expiresIn });
  return {
    ...base("tls_certificate", host),
    ok: true,
    observation: `${host} presents a valid certificate from ${probe.issuer ?? "an unnamed issuer"} over ${probe.protocol}${expiresIn !== null ? `, ${expiresIn} days to expiry` : ""}.`,
    evidence,
    finding: null,
  };
}

// ---- 4. robots.txt ----------------------------------------------------------

/**
 * Presence and shape of robots.txt. Explicitly NOT a source of test targets:
 * this check does not enumerate Disallow paths, does not return them in evidence,
 * and nothing downstream may treat a path named here as somewhere to go. That
 * conflation, "the excluded paths are the interesting ones", is the single
 * most common way a passive scan turns into an active one, and it is refused
 * here at the source.
 */
async function robotsPolicy(host: string): Promise<CheckOutcome> {
  const res = await passiveGetText(host, "/robots.txt");
  if (!res.ok) {
    return {
      ...base("robots_policy", host),
      ok: false,
      observation: `Could not reach ${host}/robots.txt (${res.error}).`,
      evidence: { url: `https://${host}/robots.txt`, error: res.error },
      finding: null,
    };
  }

  const evidence: Record<string, unknown> = { url: `https://${host}/robots.txt`, status: res.status };

  if (res.status !== 200) {
    return {
      ...base("robots_policy", host),
      ok: true,
      observation: `${host} publishes no robots.txt (HTTP ${res.status}); crawling is unrestricted by default.`,
      evidence,
      finding: null, // Absence of robots.txt is not a security weakness, and saying so would be noise.
    };
  }

  const text = res.text;
  const body = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  const disallowCount = body.filter((l) => /^disallow:/i.test(l.trim())).length;
  const sitemaps = [...text.matchAll(/^\s*sitemap:\s*(.+)$/gim)].map((m) => m[1].trim());
  Object.assign(evidence, {
    rule_count: body.length,
    disallow_count: disallowCount,
    sitemaps: sitemaps.slice(0, 5),
    // Deliberately not recorded: the paths themselves.
    paths_recorded: false,
  });

  return {
    ...base("robots_policy", host),
    ok: true,
    observation: `${host} publishes robots.txt with ${body.length} rule${body.length === 1 ? "" : "s"}${sitemaps.length ? ` and ${sitemaps.length} sitemap reference${sitemaps.length === 1 ? "" : "s"}` : ""}.`,
    evidence,
    finding: null,
  };
}

// ---- 5. DNS posture ---------------------------------------------------------

/**
 * CAA and email-authentication records, read over DNS-over-HTTPS: no direct
 * egress, and the public DNS the whole internet already sees.
 *
 * The subtlety is inheritance. CAA and DMARC/SPF are looked up on ancestor
 * domains when absent at the name queried, so "no CAA on www.example.com" means
 * nothing at all, example.com may well have one and it applies. So absence only
 * produces a finding where the host is likely the registrable domain itself, and
 * CAA absence produces none at all: a missing CAA record is a real fact but not
 * a defect, since CAA is optional and its absence is the default for most of the
 * internet.
 */
async function dnsPosture(host: string): Promise<CheckOutcome> {
  const apex = isApex(host);
  const [caa, dmarc, spf] = await Promise.all([
    doh(host, "CAA"),
    doh(`_dmarc.${host}`, "TXT"),
    doh(host, "TXT"),
  ]);

  const caaRecords = caa.ok ? caa.answers.filter((a) => a.type === 257 || /^\d+\s+(issue|issuewild|iodef)/i.test(a.data)) : [];
  const dmarcRecord =
    (dmarc.ok
      ? dmarc.answers.find((a) => a.type === 16 && /v=DMARC1/i.test(a.data.replace(/"/g, "")))
      : undefined) ?? null;
  const spfRecord =
    (spf.ok ? spf.answers.find((a) => a.type === 16 && /v=spf1/i.test(a.data.replace(/"/g, ""))) : undefined) ?? null;

  const evidence: Record<string, unknown> = {
    host,
    is_likely_apex: apex,
    caa: caaRecords.map((r) => r.data),
    dmarc: dmarcRecord ? dmarcRecord.data.replace(/"/g, "") : null,
    spf: spfRecord ? spfRecord.data.replace(/"/g, "") : null,
  };

  if (dmarcRecord) {
    const policy = /\bp\s*=\s*(none|quarantine|reject)/i.exec(dmarcRecord.data.replace(/"/g, ""))?.[1]?.toLowerCase() ?? null;
    Object.assign(evidence, { dmarc_policy: policy });
    if (policy === "none") {
      return {
        ...base("dns_posture", host),
        ok: true,
        observation: `${host} publishes DMARC but only in monitoring mode (p=none), so it reports spoofing without blocking it.`,
        evidence,
        finding: {
          title: `DMARC on ${host} is monitoring-only (p=none)`,
          severity: "info",
          summary:
            `The DMARC record at _dmarc.${host} sets p=none. Reports are generated, but receivers are told to ` +
            `deliver mail that fails authentication anyway, so the record measures the problem without yet ` +
            `stopping it. Moving to p=quarantine is the usual next step once reports look clean.`,
          evidence,
        },
      };
    }
    return {
      ...base("dns_posture", host),
      ok: true,
      observation: `${host} enforces DMARC (p=${policy ?? "set"})${spfRecord ? " and publishes SPF" : " but publishes no SPF record"}.`,
      evidence,
      finding: null,
    };
  }

  if (!apex) {
    // A subdomain inherits its parent's DMARC. Absence here proves nothing, and
    // filing a finding on it would be a false positive dressed as diligence.
    return {
      ...base("dns_posture", host),
      ok: true,
      observation: `${host} has no DMARC record of its own; as a subdomain it inherits whatever its parent publishes${caaRecords.length ? `, and ${caaRecords.length} CAA record${caaRecords.length === 1 ? "" : "s"} constrain its issuers` : ""}.`,
      evidence,
      finding: null,
    };
  }

  return {
    ...base("dns_posture", host),
    ok: true,
    observation: `${host} publishes no DMARC record, so anyone can send mail claiming to be ${host} and receivers have no instruction to reject it.`,
    evidence,
    finding: {
      title: `No DMARC record on ${host}`,
      severity: "low",
      summary:
        `There is no DMARC record at _dmarc.${host}${spfRecord ? " (SPF exists, but SPF alone does not tell a receiver what to do when it fails)" : " and no SPF record either"}. ` +
        `Without it, a forged message from ${host} is delivered on the same footing as a real one, which is the ` +
        `precondition for phishing that appears to come from this domain.`,
      evidence,
    },
  };
}

// ---- the catalogue ----------------------------------------------------------

export const CHECKS: Record<CheckId, CheckSpec> = {
  security_txt: {
    id: "security_txt",
    label: "Disclosure route",
    describes: "Reads /.well-known/security.txt (RFC 9116) and reports whether a reporting channel is published.",
    run: securityTxt,
  },
  security_headers: {
    id: "security_headers",
    label: "Security headers",
    describes: "One GET of /, reading response headers only: HSTS, CSP, X-Content-Type-Options, Referrer-Policy.",
    run: securityHeaders,
  },
  tls_certificate: {
    id: "tls_certificate",
    label: "TLS certificate",
    describes: "Completes one TLS handshake on 443 and reads the certificate: expiry, issuer, validity, protocol version.",
    run: tlsCertificate,
  },
  robots_policy: {
    id: "robots_policy",
    label: "Crawl policy",
    describes: "Reads /robots.txt for presence and rule count. Disallowed paths are deliberately not recorded.",
    run: robotsPolicy,
  },
  dns_posture: {
    id: "dns_posture",
    label: "DNS posture",
    describes: "Resolves CAA, DMARC and SPF over DNS-over-HTTPS. Public records only; no zone transfer, no enumeration.",
    run: dnsPosture,
  },
};

export const CHECK_IDS: CheckId[] = ["security_txt", "security_headers", "tls_certificate", "robots_policy", "dns_posture"];

export function isCheckId(v: string): v is CheckId {
  return Object.prototype.hasOwnProperty.call(CHECKS, v);
}

/** Run one check by id. The only entry point the runtime uses. */
export async function runCheck(id: CheckId, host: string): Promise<CheckOutcome> {
  try {
    return await CHECKS[id].run(host);
  } catch (e) {
    return {
      ...base(id, host),
      ok: false,
      observation: `${CHECKS[id].label} on ${host} failed to complete (${e instanceof Error ? e.message : "unexpected error"}).`,
      evidence: { host, error: e instanceof Error ? e.message : "unexpected error" },
      finding: null,
    };
  }
}
