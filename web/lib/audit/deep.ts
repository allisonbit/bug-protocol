import "server-only";
import {
  AUDIT_ENGINE,
  SEVERITIES,
  auditMcpServer,
  auditSkill,
  countsOf,
  sha256Of,
  verdictOf,
  type AuditKind,
  type AuditResult,
  type Finding,
  type Severity,
  type Verdict,
} from "./skill-audit";
import { fetchForAudit, hostIsPublic, selfHosts, validateAuditUrl } from "./fetch";
import { paymentRequirements, type PaymentProof } from "@/lib/payments/x402";
import { SITE_URL } from "@/lib/site";

/**
 * THE DEEP SCAN: the document a caller pointed at, AND everything it declares.
 *
 * WHY IT COSTS MONEY AND WHY THAT IS THE HONEST REASON. An ordinary audit reads one
 * document: one fetch, one pass. A deep scan reads a skill's discovery index and every
 * artifact under it, or an MCP server's LIVE tool catalogue rather than a card the
 * submitter chose to paste — several requests to somebody else's server, and for the
 * MCP case a request the server has to answer rather than a static file it can cache.
 * That is work with a cost attached to a machine this deployment pays for, and it is the
 * only part of the audit surface that is charged for. Nothing about the verdict changes
 * because money was involved: the same engine, the same rules, the same record, with the
 * receipt attached so a reader can see it was paid for.
 *
 * WHY THE PAID PART IS NOT THE VERDICT ITSELF. Charging for a verdict would mean a
 * verdict is only published for those who can pay, and the free single-document audit
 * stays exactly as it was. What is bought here is REACH — more documents, read from the
 * source rather than from a claim about the source.
 *
 * WHAT IT REFUSES TO DO. It does not follow a declaration off the host it came from, does
 * not read more than five documents or more than a megabyte each, and does not take a URL
 * from the caller that the guard would refuse. A skill that declares files on six other
 * hosts is reported as declaring them and not read, which is a fact about the skill.
 */

/** How many documents one deep scan may read, stated rather than discovered. */
export const MAX_DEEP_DOCUMENTS = 5;

/**
 * What a deep scan costs, in atomic USDC.
 *
 * Priced separately from a delegated task because it is a different purchase: a task buys
 * a resident's attention, and this buys a bounded number of outbound requests to somebody
 * else's server made on the payer's behalf. An operator sets it in whole dollars like
 * every other price here, and the conversion happens once, in this function, so no caller
 * has to know about atomic units.
 */
export function deepScanAmountAtomic(): string {
  const v = (process.env.X402_PRICE_AUDIT_USDC ?? "0.25").trim();
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "250000";
  return String(Math.round(n * 1_000_000));
}

/** The resource a deep scan payment names, so a 402 describes the right purchase. */
export function deepScanResource(): string {
  return `${SITE_URL}/api/audits`;
}

/**
 * The terms a caller is refused with, in the shape x402 clients read.
 *
 * The same object the payment door returns, built through the same function, so a client
 * that can pay for a task can pay for a scan without learning a second dialect. It fails
 * closed: with no `X402_PAY_TO` there are no `accepts`, and the refusal names the variable
 * rather than pretending the scan is unavailable for some other reason.
 */
export function deepScanRequirements() {
  return paymentRequirements({
    resource: deepScanResource(),
    amountAtomic: deepScanAmountAtomic(),
    description:
      "A deep audit scan: the document you name, plus every artifact it declares on its own host, or an MCP server's live tool catalogue read from the server rather than from a card. The verdict and the engine do not change because money was involved; what is bought is reach. The receipt is attached to the audit record.",
  });
}

/**
 * Where the payment proof is, whichever way a client sent it.
 *
 * THREE SHAPES, and the third is the one an x402 client reaches for first. A caller
 * wrapping an audit request puts the proof under `payment` or `proof`; a client that
 * already speaks the protocol pastes the proof fields straight into the body alongside
 * `kind` and `url`, because x402 has no envelope and the fields do not collide with an
 * audit request's own. A proof handed to a door that only read the wrapped shape was the
 * first thing the probe for the task door found, so this reads all three rather than
 * waiting for somebody to build the same workaround twice.
 *
 * `payload` is the marker. It is the one field an `exact` proof cannot be valid without,
 * so a body carrying it is a proof and a body carrying only `kind` is not.
 */
export function proofFromBody(body: Record<string, unknown>): PaymentProof | null {
  const wrapped = (body.payment ?? body.proof) as PaymentProof | undefined;
  if (wrapped && typeof wrapped === "object") return wrapped;
  const inline = body as PaymentProof;
  return inline.payload && typeof inline.payload === "object" ? inline : null;
}

export type ScannedDocument = {
  /** Where it came from, or `declared:<uri>` for something the parent named. */
  uri: string;
  /** What in the parent pointed at it, when the parent is what named it. */
  because: string;
  digest: string;
  bytes: number;
  verdict: Verdict;
  findings: number;
  /** Set when this document was declared but could not be read. */
  error?: string;
};

export type DeepAuditResult = AuditResult & {
  documents: ScannedDocument[];
  /** The documents that were named but deliberately not read, and why. */
  skipped: { uri: string; because: string }[];
};

/** Per-document results folded into one verdict, worst first. */
function mergeFindings(parts: { where: string; findings: Finding[] }[]): Finding[] {
  const out: Finding[] = [];
  for (const part of parts) {
    for (const finding of part.findings) {
      out.push({ ...finding, where: `${part.where}${finding.where && finding.where !== "SKILL.md" ? `, ${finding.where}` : ""}` });
    }
  }
  // Sorted by severity then by where, so two runs over the same bytes produce the same
  // array in the same order: the record's digest covers the documents, and a challenge
  // rerun compares findings, so an ordering that wobbled would make the rerun lie.
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || a.where.localeCompare(b.where) || a.code.localeCompare(b.code));
}

/**
 * The artifact URLs a skill's discovery index declares.
 *
 * The Agent Skills discovery convention publishes `/.well-known/agent-skills/index.json`
 * with each skill's `url` and a digest. A deep scan reads that index and then each
 * declared artifact, which is what makes it a scan of the skill rather than of the one
 * file somebody linked.
 */
export function artifactUrlsFromIndex(
  body: unknown,
  self: string[],
  /**
   * Where the index itself was served from, used to resolve relative entries.
   *
   * REQUIRED, AND THIS WAS A REAL BUG FOUND BY DRIVING THE SCAN rather than by reading
   * it. The convention lets an index name an artifact as an absolute URL or as a path on
   * its own host, and this deployment's own index uses the RELATIVE form: `{"url":
   * "/.well-known/agent-skills/swamp/SKILL.md"}`. A reader that only understood absolute
   * URLs therefore found nothing to follow in the one index it had the best reason to
   * read, and reported a deep scan of one document as if the document had declared
   * nothing. The fix is one `new URL(url, indexUrl)`; the lesson is that a scanner tested
   * against samples it wrote itself will pass on samples it wrote itself.
   */
  indexUrl: string,
): { uri: string; digest: string | null }[] {
  const asRecord = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const index = asRecord(body);
  const skills = Array.isArray(index?.skills) ? (index.skills as unknown[]) : Array.isArray(body) ? (body as unknown[]) : [];
  const out: { uri: string; digest: string | null }[] = [];
  for (const raw of skills) {
    const entry = asRecord(raw);
    const declared = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!declared) continue;
    let resolved: URL;
    try {
      // Resolved against the index's own address, so a relative entry means "beside me"
      // and an absolute entry means exactly what it says.
      resolved = new URL(declared, indexUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:") continue;
    // Anything that resolves off the host the index came from is skipped rather than
    // fetched: a document does not get to name a second host this deployment will call on
    // its behalf in the middle of a scan. Applied AFTER resolution, so a relative entry
    // cannot be used to reach somewhere else and an absolute one still cannot either.
    const host = resolved.hostname.toLowerCase();
    if (!self.includes(host)) continue;
    out.push({ uri: resolved.toString(), digest: typeof entry?.digest === "string" ? entry.digest : null });
  }
  return out.slice(0, MAX_DEEP_DOCUMENTS);
}

/** True when the URL may be read at all, using the same guard the ordinary audit uses. */
function allowed(url: string): boolean {
  const check = validateAuditUrl(url, selfHosts(SITE_URL));
  return check.ok;
}

/**
 * Run the deep scan.
 *
 * Order matters and is the whole design: the parent document is read FIRST, so a caller
 * cannot pay for a scan and receive only the artifacts, and every later document is read
 * only because the parent named it.
 */
export async function runDeepAudit(input: {
  kind: AuditKind;
  url?: string | null;
  content?: string | null;
}): Promise<{ ok: true; result: DeepAuditResult; source: "fetched" | "submitted"; text: string } | { ok: false; code: string; reason: string }> {
  const url = input.url?.trim() || null;
  const supplied = typeof input.content === "string" && input.content.length > 0 ? input.content : null;
  if (!supplied && !url) {
    return { ok: false, code: "NO_CONTENT", reason: "A deep scan needs `url`: the point of it is to read what the document declares." };
  }
  if (!url && input.kind === "mcp-server") {
    return { ok: false, code: "NO_URL", reason: "A deep scan reads a server's own tool catalogue, so it needs the server's `url`." };
  }

  const documents: ScannedDocument[] = [];
  const skipped: { uri: string; because: string }[] = [];
  const parts: { where: string; findings: Finding[] }[] = [];

  let primary: AuditResult;
  let text: string;
  let source: "fetched" | "submitted" = "submitted";

  if (input.kind === "mcp-server") {
    // THE LIVE CATALOGUE RATHER THAN A CARD. What a server says about its tools in a card
    // and what it answers when asked for them are different documents, and the second is
    // the one a client actually installs. This is the difference the caller pays for.
    const listed = await listToolsLive(url as string);
    if (!listed.ok) return { ok: false, code: listed.code, reason: listed.reason };
    primary = auditMcpServer({ body: listed.body, url });
    text = JSON.stringify(listed.body);
    source = "fetched";
    documents.push({
      uri: url as string,
      because: "the live tools/list response, read from the server rather than from a card it publishes",
      digest: primary.digest,
      bytes: primary.bytes,
      verdict: primary.verdict,
      findings: primary.findings.length,
    });
    parts.push({ where: url as string, findings: primary.findings });
  } else if (supplied && !url) {
    // Submitted bytes with no URL: there is nothing to go and declare, so a deep scan of
    // them is the ordinary scan. Said in the summary rather than in a shrug.
    primary = auditSkill({ text: supplied, url: null });
    text = supplied;
    documents.push({
      uri: "submitted:bytes",
      because: "the bytes were submitted, so there was nothing else for the document to declare",
      digest: primary.digest,
      bytes: primary.bytes,
      verdict: primary.verdict,
      findings: primary.findings.length,
    });
    parts.push({ where: "submitted:bytes", findings: primary.findings });
  } else {
    const fetched = await fetchForAudit(url as string, selfHosts(SITE_URL));
    if (!fetched.ok) return { ok: false, code: fetched.code, reason: fetched.reason };
    primary = auditSkill({ text: fetched.text, url });
    text = fetched.text;
    source = "fetched";
    documents.push({
      uri: url as string,
      because: "the document the caller pointed at",
      digest: primary.digest,
      bytes: primary.bytes,
      verdict: primary.verdict,
      findings: primary.findings.length,
    });
    parts.push({ where: url as string, findings: primary.findings });
  }

  // ---- and what the parent declares -------------------------------------------------
  const origin = url ? new URL(url) : null;
  const self = origin ? [origin.hostname.toLowerCase()] : [];

  if (input.kind === "skill" && origin) {
    const indexUrl = `${origin.origin}/.well-known/agent-skills/index.json`;
    const index = await fetchForAudit(indexUrl, selfHosts(SITE_URL));
    if (index.ok) {
      const declared = artifactUrlsFromIndex(safeJson(index.text), self, indexUrl);
      for (const item of declared) {
        if (documents.length >= MAX_DEEP_DOCUMENTS) {
          skipped.push({ uri: item.uri, because: `the scan reads at most ${MAX_DEEP_DOCUMENTS} documents` });
          continue;
        }
        if (!allowed(item.uri)) {
          skipped.push({ uri: item.uri, because: "this deployment will not fetch that address" });
          continue;
        }
        const file = await fetchForAudit(item.uri, selfHosts(SITE_URL));
        if (!file.ok) {
          documents.push({ uri: item.uri, because: "declared by the discovery index", digest: "", bytes: 0, verdict: "notes", findings: 0, error: `${file.code}: ${file.reason}` });
          continue;
        }
        // The declared digest is checked rather than trusted, and a mismatch is itself a
        // finding-worthy fact: it means the index and the artifact disagree, which is the
        // drift the convention's digests exist to catch.
        const computed = sha256Of(file.text);
        const result = auditSkill({ text: file.text, url: item.uri });
        const mismatch = item.digest !== null && `sha256:${computed}` !== item.digest;
        const findings = mismatch
          ? [
              ...result.findings,
              {
                code: "DIGEST_MISMATCH",
                severity: "high" as Severity,
                title: "The discovery index and the artifact disagree about its digest",
                why: "The index declares a SHA-256 for this file and the bytes served do not hash to it. That is either a redeploy in progress or a file that changed after it was published, and a client enforcing the convention would refuse it.",
                evidence: `declared ${item.digest}, computed sha256:${computed}`,
                where: item.uri,
                line: null,
              },
            ]
          : result.findings;
        documents.push({ uri: item.uri, because: "declared by the discovery index", digest: computed, bytes: file.text.length, verdict: verdictOf(findings), findings: findings.length });
        parts.push({ where: item.uri, findings });
      }
      if (declared.length === 0) {
        skipped.push({ uri: indexUrl, because: "the index declares no artifact on this host, so there was nothing else to read" });
      }
    } else {
      skipped.push({ uri: indexUrl, because: `the discovery index could not be read (${index.code})` });
    }
  }

  if (input.kind === "mcp-server" && origin) {
    const cardUrl = `${origin.origin}/.well-known/mcp.json`;
    const card = await fetchForAudit(cardUrl, selfHosts(SITE_URL));
    if (card.ok && documents.length < MAX_DEEP_DOCUMENTS) {
      const result = auditMcpServer({ body: safeJson(card.text), url: cardUrl });
      documents.push({ uri: cardUrl, because: "the server card it publishes, read alongside the live catalogue", digest: result.digest, bytes: result.bytes, verdict: result.verdict, findings: result.findings.length });
      parts.push({ where: cardUrl, findings: result.findings });
    } else if (!card.ok) {
      skipped.push({ uri: cardUrl, because: `the server card could not be read (${card.code})` });
    }
  }

  const findings = mergeFindings(parts);
  const verdict = verdictOf(findings);
  const counts = countsOf(findings) as Record<Severity, number>;
  const summary =
    verdict === "clean"
      ? `No rule fired across ${documents.length} document(s). That says the patterns were not found in these bytes, and nothing more.`
      : `${verdict} across ${documents.length} document(s): ${findings.length} finding(s), from ${new Set(findings.map((f) => f.where.split(",")[0])).size} of them.`;

  return {
    ok: true,
    source,
    text,
    result: {
      ...primary,
      engine: `${AUDIT_ENGINE}+deep`,
      verdict,
      findings,
      counts,
      // The digest of a deep scan is the digest of the set: the parent's digest first so
      // the same bytes always produce the same record key, then each document's.
      digest: sha256Of([primary.digest, ...documents.map((d) => d.digest)].join(":")),
      bytes: documents.reduce((n, d) => n + d.bytes, 0),
      summary,
      scope:
        "A pattern audit of every document a deep scan could read, bounded to five documents on the host that served the first one. The engine read the text and did not run it, so a clean verdict means these patterns were not found, not that the skill or server is safe.",
      documents,
      skipped,
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Ask a live MCP server for its tool catalogue.
 *
 * A POST rather than a GET, so it goes through the same address rules with an explicit
 * method, and the request is the least interesting one the protocol has: `tools/list`,
 * which reads. Nothing is called, nothing is installed, and the server is not told
 * anything about this deployment beyond the request itself.
 */
async function listToolsLive(
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; code: string; reason: string }> {
  const check = validateAuditUrl(url, selfHosts(SITE_URL));
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason };
  const reachable = await hostIsPublic(new URL(url).hostname);
  if (!reachable.ok) return { ok: false, code: reachable.code, reason: reachable.reason };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) {
      return { ok: false, code: "HTTP_ERROR", reason: `${new URL(url).hostname} answered ${res.status} to tools/list. A deep scan reads what a server actually serves, so the server has to answer.` };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object") {
      return { ok: false, code: "BAD_JSON", reason: `${new URL(url).hostname} answered tools/list with something that is not JSON-RPC.` };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, code: "FETCH_FAILED", reason: `${new URL(url).hostname} could not be read: ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}
