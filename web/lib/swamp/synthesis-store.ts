import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAudit, type AuditRow } from "@/lib/audit/store";
import {
  checkDraft,
  judgeDraft,
  verdictAcceptable,
  digestOf,
  topicsOf,
  synthesizedRef,
  synthesizedSubject,
} from "./synthesis";

/**
 * THE SYNTHESIS STORE: DRAFT IN, VERDICT OUT, REGISTRY ROW OR NOTHING.
 *
 * One path, four steps, and the order is the design:
 *
 *   1. `checkDraft` names the honest refusals (size, shape, frontmatter).
 *   2. `judgeDraft` runs THIS deployment's engine — the same engine, code and
 *      ruleset that judges every mirrored stranger's skill. Not a softer copy.
 *   3. The verdict gate refuses anything the mirror would flag, with the
 *      engine's own findings quoted, so the refusal is checkable.
 *   4. The audit row lands first, the synthesized row second, and the database
 *      trigger mirrors the entry into `skill_registry` with the audit id bound
 *      to it. A failure in between leaves an audit row with no synthesis, which
 *      is the safe direction to fail in: a verdict without an entry, never an
 *      entry without a verdict.
 *
 * The same slug may be resubmitted: the row updates, the registry row updates,
 * and `seen_count` climbs. A skill is a living document with a history, not a
 * name that can be squatted.
 */

export type SubmitSkillResult =
  | {
      ok: true;
      slug: string;
      ref: string;
      verdict: string;
      digest: string;
      auditId: string;
      mirrored: boolean;
      deduped: boolean;
    }
  | { ok: false; code: "BAD_DRAFT" | "REFUSED_BY_ENGINE" | "STORE_FAILED"; reason: string; findings?: string[] };

export async function submitSkill(
  sb: SupabaseClient,
  input: {
    name: string;
    body: string;
    authorHandle: string;
    authorId: string;
  },
): Promise<SubmitSkillResult> {
  const slug = input.name.trim().toLowerCase();
  const check = checkDraft({ name: slug, body: input.body });
  if (!check.ok) return { ok: false, code: "BAD_DRAFT", reason: check.reason };

  // The gate. The engine's findings are quoted verbatim in the refusal, so the
  // author can fix the draft rather than guess at a verdict.
  const judged = judgeDraft(input.body);
  if (!verdictAcceptable(judged.verdict)) {
    return {
      ok: false,
      code: "REFUSED_BY_ENGINE",
      reason: `the engine's verdict on these bytes is "${judged.verdict}"; only clean or notes may enter the registry`,
      findings: judged.findings.map((f) => `${f.severity}: ${f.code}: ${f.title} (${f.where})`),
    };
  }

  const digest = digestOf(input.body);
  const subject = synthesizedSubject(slug);

  // The audit row first, through the same door every other verdict uses, so the
  // record has one audit vocabulary rather than two. `source: "submitted"` is
  // the truth: the bytes came from a resident, not from a fetch.
  const recorded = await recordAudit(sb, {
    result: judged,
    subject,
    source: "submitted",
    content: input.body,
    submittedBy: input.authorHandle,
    agent: { id: input.authorId, handle: input.authorHandle },
  });
  if (!recorded.ok) {
    return { ok: false, code: "STORE_FAILED", reason: recorded.reason };
  }

  // A resubmission of the same slug replaces the entry: same row, new bytes,
  // new verdict, new audit binding. The registry trigger fires on update too.
  const { error } = await sb.from("synthesized_skills").upsert(
    {
      slug,
      author_handle: input.authorHandle,
      author_id: input.authorId,
      body: input.body,
      digest,
      audit_id: recorded.audit.id,
      verdict: judged.verdict,
      topics: topicsOf(input.body),
    },
    { onConflict: "slug" },
  );
  if (error) {
    return { ok: false, code: "STORE_FAILED", reason: error.message };
  }

  return {
    ok: true,
    slug,
    ref: synthesizedRef(slug),
    verdict: judged.verdict,
    digest,
    auditId: recorded.audit.id,
    mirrored: true,
    deduped: recorded.deduped,
  };
}

/** The table row, as the site reads it. */
export type SynthesizedRow = {
  id: string;
  slug: string;
  author_handle: string;
  body: string;
  digest: string;
  audit_id: string;
  verdict: string;
  topics: string[];
  created_at: string;
  updated_at: string;
};

export async function listSynthesized(sb: SupabaseClient, limit = 50): Promise<SynthesizedRow[]> {
  const { data, error } = await sb
    .from("synthesized_skills")
    .select("id, slug, author_handle, body, digest, audit_id, verdict, topics, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as unknown as SynthesizedRow[];
}

export async function readSynthesized(sb: SupabaseClient, slug: string): Promise<SynthesizedRow | null> {
  const { data } = await sb
    .from("synthesized_skills")
    .select("id, slug, author_handle, body, digest, audit_id, verdict, topics, created_at, updated_at")
    .eq("slug", slug)
    .maybeSingle();
  return (data as unknown as SynthesizedRow) ?? null;
}

export async function countSynthesized(sb: SupabaseClient): Promise<number> {
  const { count } = await sb
    .from("synthesized_skills")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}

/** The audit row a synthesis is bound to, read by subject — one row, newest. */
export async function readSynthesisAudit(sb: SupabaseClient, slug: string): Promise<AuditRow | null> {
  const { data } = await sb
    .from("audits")
    .select("*")
    .eq("subject", synthesizedSubject(slug))
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as unknown as AuditRow[])[0] ?? null;
}
