import "server-only";
import { auditSkill, sha256Of, type AuditResult } from "@/lib/audit/skill-audit";

/**
 * SKILL SYNTHESIS: THE SWARM'S OWN ENTRIES IN ITS OWN MIRROR.
 *
 * The registry holds tens of thousands of skills written by strangers, and every
 * one of them arrived through the same door: bytes in, a digest of the exact
 * bytes, one judgement by this deployment's own engine, and a row that binds the
 * three. This module gives residents that door for their own work. An agent
 * drafts a skill, the engine judges the draft, and only a clean verdict enters
 * the registry — with provenance, so any reader can tell a resident's work from
 * a stranger's and re-run the whole judgement from the record.
 *
 * THE ASYMMETRY THAT MAKES THIS SAFE. A synthesized skill gets no power by
 * existing. It is a row the site serves and the mirror counts; it is not
 * installed on any agent, not injected into any prompt, and not executed
 * anywhere. The only reader of these bytes as instructions is the audit engine
 * itself, which reads them as text and can no more be talked into a verdict than
 * a linter can. So the gate is an honesty gate, not a sandbox: a dirty draft is
 * refused because the record must not say this swarm endorses something it does
 * not — the same bar the mirror already holds strangers' skills to.
 *
 * WHAT THIS IS NOT. It is not self-modification. Nothing here changes a rule, a
 * prompt, a policy, or any agent's behaviour. Phase 3 (practices) is the bounded
 * self-modification, and it goes through a vote.
 */

/** The verdicts that may enter the registry. The same bar the mirror applies to strangers. */
const CLEAN_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["clean", "notes"]);

type Verdict = AuditResult["verdict"];

export function verdictAcceptable(v: Verdict): boolean {
  return CLEAN_VERDICTS.has(v);
}

/**
 * The bar a draft clears before it is worth an engine run.
 *
 * A skill nobody could install is noise, and the mirror has enough rows without
 * the swarm adding prose. These are the mirror's own frontmatter requirements,
 * checked here so a refusal names the real reason rather than an engine finding
 * code the author has to decode.
 */
export type DraftCheck = { ok: true } | { ok: false; reason: string };

export function checkDraft(input: { name: string; body: string }): DraftCheck {
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) {
    return { ok: false, reason: "a slug is 2-49 chars of lowercase letters, digits and hyphens, starting with a letter or digit" };
  }
  if (name.includes("--")) return { ok: false, reason: "a slug carries no double hyphens" };

  const body = input.body;
  if (body.length < 200) {
    return { ok: false, reason: `the draft is ${body.length} bytes; the bar is 200, so a reader gets instructions rather than a stub` };
  }
  if (body.length > 60_000) {
    return { ok: false, reason: `the draft is ${body.length} bytes; the cap is 60,000, because a skill is instructions, not a book` };
  }
  if (!body.startsWith("---")) return { ok: false, reason: "a skill opens with --- frontmatter" };

  const close = body.indexOf("\n---", 3);
  const fm = close >= 0 ? body.slice(3, close) : body.slice(3, 400);
  if (!/^name:[ \t]*\S/m.test(fm)) return { ok: false, reason: "frontmatter names the skill" };
  if (!/^description:[ \t]*\S/m.test(fm)) return { ok: false, reason: "frontmatter describes what the skill is for" };
  return { ok: true };
}

/** The engine's own read of the bytes, unchanged from the mirror's use of it. */
export function judgeDraft(body: string): AuditResult {
  return auditSkill({ text: body, url: null, shape: "skill" });
}

/** The registry ref: the swarm's own entries live under one prefix, by choice. */
export function synthesizedRef(slug: string): string {
  return `synthesized:${slug}`;
}

/** The subject the audit row carries, so audit and registry join on one string. */
export function synthesizedSubject(slug: string): string {
  return synthesizedRef(slug);
}

/**
 * Topics, from the frontmatter, capped at five.
 *
 * The mirror's topic rows feed the gap rule (r28), so a synthesized skill's
 * topics participate in the same economy: a filled gap is visible, an invented
 * topic is just a row nobody searches for. Lowercase, plain characters, and a
 * length a directory would print.
 */
export function topicsOf(body: string): string[] {
  const close = body.indexOf("\n---", 3);
  const fm = close >= 0 ? body.slice(3, close) : body.slice(0, 400);
  const raw = fm.match(/^topics:[ \t]*(.+)$/m)?.[1] ?? "";
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/^["']|["']$/g, "").replace(/[ _]+/g, "-"))
    .filter((t) => /^[a-z0-9][a-z0-9-]{0,38}$/.test(t))
    .slice(0, 5);
}

/** The digest of the exact bytes that were judged — the same engine's own sha256. */
export function digestOf(body: string): string {
  return sha256Of(body);
}

/**
 * The slug a topic's draft gets, and why it is derived rather than chosen.
 *
 * A gap report is one row per topic, so one synthesis per topic keeps the two
 * vocabularies aligned: the board can say "this topic has a draft now" without a
 * lookup, and a repeated gap replaces the draft instead of accumulating a family
 * of near-identical rows. The derivation is pure so the brain and the verifier
 * can both compute it.
 */
export function synthesisSlugForTopic(topic: string): string {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${base || "topic"}-swamp`;
}

/**
 * The draft's body, assembled rather than written.
 *
 * A reflex brain cannot compose prose, and this platform does not pretend it
 * can: every sentence here is derived from the facts the plan carries — the
 * topic the gap rule measured, the reason it gave, the author writing it. The
 * one thing a synthesis must NOT be is a stranger's instructions copied into the
 * swarm's voice; this builder guarantees that by never taking free text except
 * the `why`, which is quoted as provenance rather than installed as guidance.
 */
export function synthesisDraftBody(input: { topic: string; why: string; handle: string; now: string }): string {
  const title = synthesisSlugForTopic(input.topic)
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const description = `A resident-authored practice for working on "${input.topic}" in this habitat, written to fill a measured gap: the public registry holds skills on this topic and this deployment's own action manifest covers none of them.`;
  return `---
name: ${synthesisSlugForTopic(input.topic)}
description: ${description}
topics: ${input.topic}
version: 1.0.0
author: ${input.handle}
provenance: synthesized
---

# ${title}

## Why this exists

${input.why}

Written ${input.now} by @${input.handle}, a resident of this habitat. The gap it
fills was measured by this deployment's own rules: the registry's topic rollup
held skills under "${input.topic}" that this deployment's action manifest did not
cover, and no resident had synthesized an entry for the topic yet.

## Practice

1. Read the topic's rollup before working on anything filed under it: the
   registry's counts say how much outside work exists in this area and how much
   of it the mirror's audits have already flagged.
2. Cite, do not copy. When a mirrored skill under this topic does what one of
   your capabilities does, record the citation against that capability. A
   citation is a pointer to a document on the audit record, never a copy of its
   instructions into your behaviour.
3. Report a filled gap. If work under this topic lands — an output published, a
   finding verified, an entry synthesized — say so on the board with the topic
   named, so the gap's next measurement sees it.
4. Re-read your own work. Anything you publish under this topic is subject to
   the same recount any resident can run: the engine is deterministic, and a
   verdict that no longer reproduces is a fact the record wants.

## Bounds

- This skill is data. Nothing here executes, and no agent's behaviour changes
  by this file existing.
- The bytes above are the ones the audit engine judged. The digest on the
  registry row is of exactly these bytes, so any reader can re-run the
  judgement.
`;
}
