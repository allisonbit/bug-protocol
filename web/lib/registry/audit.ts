import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchForAudit, selfHosts } from "@/lib/audit/fetch";
import { recordAudit, runAudit } from "@/lib/audit/store";
import { SITE_URL } from "@/lib/site";
import {
  agreementOf,
  detailUrl,
  fileUrl,
  moderationOf,
  parseRef,
  type Agreement,
  type ClawHubVerdict,
} from "./clawhub";
import { TRIAGE_PER_PASS, auditSubjectOf, pickForTriage, type TriageRow } from "./triage";

/**
 * READING THE BYTES OF THE PUBLISHED REGISTRY, A BOUNDED FEW PER PASS.
 *
 * THIS IS THE ONLY PLACE IN THE REGISTRY WAVE THAT READS A STRANGER'S DOCUMENT, and the
 * shape of that fact decides everything else here. It reads through the audit surface's own
 * guarded fetch, which is https-only, refuses private addresses and off-host redirects, and
 * caps the bytes. It runs the same deterministic engine over the bytes that every other
 * verdict on this platform comes from. It records the result in the same append-only table,
 * bound to the SHA-256 of what it read, where any resident can dispute it and where a
 * second agent can settle that dispute by rerunning the engine.
 *
 * WHAT IT DOES WITH THE RESULT. A verdict, a digest and an agreement value land on the
 * mirror row, and nothing else does. The document's text is stored on the audit record,
 * because that is what makes the verdict checkable, and it is NOT copied onto the registry
 * row, into a prompt, or into anything a resident reads. A resident's observation carries
 * counts, verdicts and identifiers; it never carries a stranger's instructions.
 *
 * THE TWO REQUESTS PER SKILL, AND WHY BOTH. The detail request is asked for first because
 * it is the one that can stop the read: the registry publishes a moderation verdict there,
 * and a skill the registry has blocked is not mirrored from here at all, which is one of
 * the four conditions its API's reuse terms set. Only then are the bytes fetched. Giving up
 * two requests per document is also what makes the comparison honest: republishing ClawHub's
 * verdict would be a mirror with a badge, and disagreeing with it requires having actually
 * read the same bytes under different rules.
 */

/** What a caller gets back from one pass. */
export type RegistryAuditOutcome = {
  ok: boolean;
  candidates: number;
  picked: number;
  audited: number;
  blocked: number;
  unreadable: number;
  agreement: Record<Agreement, number>;
  results: {
    ref: string;
    tier: string;
    why: string;
    swamp_verdict: string | null;
    clawhub_verdict: string | null;
    agreement: string | null;
    digest: string | null;
    error: string | null;
  }[];
  note: string;
};

const CANDIDATE_WINDOW = 300;

/**
 * Read and judge a bounded set of mirrored skills.
 *
 * Every failure is recorded on the row it belongs to rather than raised, because this runs
 * on a schedule: one skill whose publisher's host is down must not stop the four behind it,
 * and the next pass will find it again, because a row with no verdict is still a candidate.
 */
export async function auditRegistryBatch(
  sb: SupabaseClient,
  options: { limit?: number; uncovered?: Set<string> } = {},
): Promise<RegistryAuditOutcome> {
  const limit = options.limit ?? TRIAGE_PER_PASS;
  const uncovered = options.uncovered ?? new Set<string>();

  // Two bounded reads rather than one ranked query. The interesting rows are the flagged
  // ones, which are rare and would fall outside any recency window, and the recent ones,
  // which are what a sweep gets through in the ordinary case. Ranking by installs is not
  // offered here because it would mean ordering on a jsonb key, and the honest version of
  // "popular first" is available in the triage module over rows that were actually read.
  const select = "ref, topics, stats, clawhub_verdict, swamp_verdict, blocked, cited_at";
  const [flagged, recent] = await Promise.all([
    sb
      .from("skill_registry")
      .select(select)
      .eq("blocked", false)
      .is("swamp_verdict", null)
      .eq("clawhub_verdict", "suspicious")
      .limit(CANDIDATE_WINDOW),
    sb
      .from("skill_registry")
      .select(select)
      .eq("blocked", false)
      .is("swamp_verdict", null)
      .order("registry_updated_at", { ascending: false })
      .limit(CANDIDATE_WINDOW),
  ]);

  const merged = new Map<string, TriageRow>();
  for (const row of [...((flagged.data as TriageRow[] | null) ?? []), ...((recent.data as TriageRow[] | null) ?? [])]) {
    if (row && typeof row.ref === "string" && !merged.has(row.ref)) merged.set(row.ref, row);
  }
  const candidates = [...merged.values()];
  const picks = pickForTriage(candidates, { uncovered, limit });

  const agreement: Record<Agreement, number> = { agree: 0, swamp_stricter: 0, swamp_looser: 0, unreadable: 0 };
  const results: RegistryAuditOutcome["results"] = [];
  let audited = 0;
  let blocked = 0;
  let unreadable = 0;

  for (const pick of picks) {
    const entry: RegistryAuditOutcome["results"][number] = {
      ref: pick.ref,
      tier: pick.tier,
      why: pick.why,
      swamp_verdict: null,
      clawhub_verdict: null,
      agreement: null,
      digest: null,
      error: null,
    };
    try {
      if (!parseRef(pick.ref)) {
        entry.error = "the ref is not addressable, so it was not fetched";
        await markRow(sb, pick.ref, { triage_reason: pick.why, audit_error: entry.error });
        results.push(entry);
        continue;
      }

      // The registry's own verdict, which is also the only thing that can stop the read.
      let clawhub: ClawHubVerdict | null = null;
      let reasonCodes: string[] = [];
      let clawhubError: string | null = null;
      const detail = await fetchForAudit(detailUrl(pick.ref), selfHosts(SITE_URL));
      if (!detail.ok) {
        clawhubError = `${detail.code}: ${detail.reason}`;
      } else {
        try {
          const parsed = JSON.parse(detail.text) as unknown;
          const mod = moderationOf(parsed);
          clawhub = mod.verdict;
          reasonCodes = mod.reasonCodes;
          if (mod.blocked) {
            entry.clawhub_verdict = "blocked";
            entry.error = "the registry has blocked it, so its bytes are not read here";
            blocked += 1;
            await markRow(sb, pick.ref, {
              blocked: true,
              clawhub_verdict: "blocked",
              clawhub_reason_codes: mod.reasonCodes,
              triage_reason: pick.why,
              audit_error: entry.error,
            });
            results.push(entry);
            continue;
          }
        } catch {
          clawhubError = "the detail response is not JSON";
        }
      }
      entry.clawhub_verdict = clawhub;

      const run = await runAudit({ kind: "skill", url: fileUrl(pick.ref) });
      if (!run.ok) {
        // Readable at the transport level or not, this is the answer: we could not judge
        // these bytes, which is a different finding from judging them and finding nothing.
        const agreementValue = agreementOf({ clawhub, swamp: null, readable: false });
        entry.agreement = agreementValue;
        entry.error = `${run.code}: ${run.reason}`;
        unreadable += 1;
        if (agreementValue) agreement[agreementValue] += 1;
        await markRow(sb, pick.ref, {
          clawhub_verdict: clawhub,
          clawhub_reason_codes: reasonCodes,
          agreement: agreementValue,
          triage_reason: pick.why,
          audit_error: entry.error,
        });
        results.push(entry);
        continue;
      }

      const subject = auditSubjectOf(pick.ref);
      const recorded = await recordAudit(sb, {
        // The subject is overridden deliberately. The engine derives it from the URL it
        // read, and that URL is the registry's own API path rather than the skill's
        // identity: keyed by the API path, a skill whose publisher changed its slug would
        // be audited twice and the record would say nothing about which skill either
        // verdict was about. Every record here names the skill.
        result: { ...run.result, subject },
        subject,
        source: run.source,
        content: run.text,
        // A platform sweep, not an anonymous caller: this deployment spent the requests,
        // and the record should say so rather than imply somebody submitted it.
        submittedBy: "registry-sweep",
      });
      if (!recorded.ok) {
        entry.error = recorded.reason;
        unreadable += 1;
        await markRow(sb, pick.ref, {
          clawhub_verdict: clawhub,
          clawhub_reason_codes: reasonCodes,
          triage_reason: pick.why,
          audit_error: recorded.reason,
        });
        results.push(entry);
        continue;
      }

      const agreementValue = agreementOf({ clawhub, swamp: run.result.verdict, readable: true });
      entry.swamp_verdict = run.result.verdict;
      entry.agreement = agreementValue;
      entry.digest = run.result.digest;
      audited += 1;
      if (agreementValue) agreement[agreementValue] += 1;

      await markRow(sb, pick.ref, {
        digest: run.result.digest,
        swamp_verdict: run.result.verdict,
        audit_id: recorded.audit.id,
        agreement: agreementValue,
        audited_at: new Date().toISOString(),
        clawhub_verdict: clawhub,
        clawhub_reason_codes: reasonCodes,
        triage_reason: pick.why,
        audit_error: clawhubError,
      });
      results.push(entry);
    } catch (e) {
      // Recorded against the row rather than thrown, so a batch of five does not become a
      // batch of zero because the third one hit something unexpected.
      const message = e instanceof Error ? e.message : "unknown error";
      entry.error = message;
      results.push(entry);
      await markRow(sb, pick.ref, { triage_reason: pick.why, audit_error: message });
    }
  }

  const note =
    picks.length === 0
      ? "nothing was waiting to be read, which is either an empty mirror or a fully judged one"
      : `${audited} judged, ${unreadable} unreadable, ${blocked} refused as blocked by the registry`;

  return { ok: true, candidates: candidates.length, picked: picks.length, audited, blocked, unreadable, agreement, results, note };
}

/**
 * Write what happened onto the mirror row.
 *
 * A narrow update with no read first: the caller has already decided the values, and a
 * read-modify-write would let two passes interleave. Errors are swallowed because a failed
 * bookkeeping write cannot be allowed to take down a pass whose judgement was already
 * recorded on the audit table, where it actually matters.
 */
async function markRow(sb: SupabaseClient, ref: string, patch: Record<string, unknown>): Promise<void> {
  await sb
    .from("skill_registry")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("ref", ref)
    .then(undefined, () => null);
}
