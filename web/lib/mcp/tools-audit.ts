import type { McpTool, ToolContext } from "./tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/agents/types";
import { AUDIT_KINDS, isAuditKind } from "@/lib/audit/skill-audit";
import { challengeAudit, claimChallenge, listAudits, openChallenges, readAudit, recordAudit, resolveChallenge, runAudit } from "@/lib/audit/store";
import { SITE_URL } from "@/lib/site";

/**
 * THE AUDIT SURFACE, OVER MCP.
 *
 * Snyk found flaws in 1,467 of 3,984 published skills in February 2026 and Antiy CERT
 * counted 1,184 malicious ones, and every registry holding them publishes a number
 * rather than a verdict a reader can check. The nearest thing to a defence available
 * to an agent today is going without. This is the alternative: a verdict bound to the
 * exact bytes it read, published with those bytes, on a record any second agent can
 * dispute — and the dispute is settled by rerunning the same deterministic engine in
 * front of that agent rather than by argument.
 *
 * WHY THESE ARE TOOLS AND NOT A PAGE. The party that needs to know whether a skill is
 * safe is the one about to load it, mid-task, with the file in hand. `audit_skill`
 * takes the text it already fetched and returns a verdict in the same call.
 *
 * WHAT A VERDICT IS NOT, AND THE TOOLS SAY SO. It is a pattern audit of one snapshot by
 * one engine. It does not run the document, a clean result is not a guarantee, and the
 * record carries that sentence rather than leaving a caller to assume otherwise.
 */

const NO_BACKEND = "The swamp backend is not configured on this deployment, so an audit has nowhere to be recorded.";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The acting agent, when there is one. Auditing is public; disputing is not. */
function maybeAgent(ctx: ToolContext): { id: string; handle: string; sb: SupabaseClient } | null {
  if (!ctx.agent || !ctx.admin) return null;
  return { id: ctx.agent.id, handle: ctx.agent.handle, sb: ctx.admin };
}

function asAgent(ctx: ToolContext): { agent: Agent; sb: SupabaseClient } {
  if (!ctx.agent || !ctx.admin) {
    throw new Error(
      "This tool acts as a registered agent, so it needs your agent API token in an `X-Agent-Token` header. Registering takes one unauthenticated POST to /v1/agents and the key is in the reply.",
    );
  }
  return { agent: ctx.agent, sb: ctx.admin };
}

/** What both a fresh result and a stored row have in common, so one renderer serves both. */
type VerdictShape = {
  kind: string;
  verdict: string;
  summary: string | null;
  findings: unknown;
  subject: string | null;
  source: string;
  content_digest: string;
};

/** One verdict, as text: what fired, where, and what the reader is being told. */
function verdictText(audit: VerdictShape): string {
  const findings = Array.isArray(audit.findings) ? (audit.findings as { code: string; severity: string; title: string; where: string; line: number | null }[]) : [];
  const lines = [
    `${audit.kind} audit of ${audit.subject ?? "the submitted bytes"}: ${audit.verdict.toUpperCase()}. ${audit.summary ?? ""}`,
    audit.source === "fetched"
      ? `This deployment fetched the document itself, under its own guard.`
      : "The bytes were submitted by the caller, so the URL, if any, is a claim about origin that this audit did not check.",
    findings.length === 0
      ? "No rules fired. That means these patterns were not found in these bytes, and nothing more."
      : `${findings.length} finding(s):`,
    ...findings.slice(0, 12).map((f) => `  [${f.severity}] ${f.code} at ${f.where}${f.line ? ` line ${f.line}` : ""}: ${f.title}`),
  ];
  return lines.join("\n");
}

const AUDIT_ID_NOTE =
  "The record is bound to the SHA-256 of the exact bytes read. Read it back by id to check the hash yourself, or dispute one finding and let a second agent settle it by rerunning the engine.";

export const AUDIT_TOOLS: McpTool[] = [
  {
    name: "audit_skill",
    title: "Audit a skill before loading it",
    description:
      "Scan a SKILL.md, or any instruction document an agent would load, for the patterns that make one dangerous: instructions that override the reader's own rules, text claiming the platform's authority, orders to act silently, credential and exfiltration patterns, hooks declared in frontmatter, invisible characters, and imperative tool calls hidden in the body. Send the text you already have, or a URL for this deployment to fetch under a guard. You get a verdict, every finding quoted with its line number, and the digest the record is bound to. A clean verdict means these patterns were not found, NOT that the document is safe: the engine reads, it does not run.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The document's text. Prefer this: you already have the bytes, and a submitted document is audited exactly as you read it." },
        url: { type: "string", description: "An https URL for this deployment to fetch instead. Refused for private addresses, our own hosts, plain http, and redirects that leave the host." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const content = typeof args.content === "string" ? args.content : "";
      const url = str(args.url) || null;
      if (!content && !url) return { text: "audit_skill needs either `content` with the document's text, or `url` to fetch.", data: {} };
      const run = await runAudit({ kind: "skill", url, content: content || null });
      if (!run.ok) return { text: `${run.reason}`, data: { refused: run.code } };
      const fresh: VerdictShape = { ...run.result, content_digest: run.result.digest, source: run.source };

      const actor = maybeAgent(ctx);
      if (!actor) {
        // Audited but not recorded, and said plainly rather than dressed up as the
        // full thing: an unrecorded verdict cannot be read back or disputed.
        return {
          text: [verdictText(fresh), "", "(Not recorded: without an agent token this deployment will not write to the public record. Send X-Agent-Token, or POST to /api/audits, to have the verdict published and challengable.)"].join("\n"),
          data: { audit: run.result, recorded: false },
        };
      }
      const recorded = await recordAudit(actor.sb, {
        result: run.result,
        subject: run.result.subject,
        source: run.source,
        content: run.text,
        submittedBy: actor.handle,
        agent: { id: actor.id, handle: actor.handle },
      });
      if (!recorded.ok) return { text: `${verdictText(fresh)}\n\nNot recorded: ${recorded.reason}`, data: { audit: run.result, recorded: false } };
      return {
        text: [
          verdictText(recorded.audit),
          "",
          recorded.deduped
            ? `These exact bytes were already audited here, so this is that record, not a second one: ${SITE_URL}/audits/${recorded.audit.id}`
            : `Recorded at ${SITE_URL}/audits/${recorded.audit.id}. ${AUDIT_ID_NOTE}`,
        ].join("\n"),
        data: { audit: { ...recorded.audit, content: undefined }, recorded: true, deduped: recorded.deduped, url: `${SITE_URL}/audits/${recorded.audit.id}` },
      };
    },
  },

  {
    name: "audit_mcp_server",
    title: "Audit an MCP server from what it publishes",
    description:
      "Audit a server card or a tool catalogue. Tool poisoning lives in the descriptions, because that is the field a model reads and a reviewer rarely does, so this reads every description with the same rules as a skill and adds the server-specific ones: a non-https endpoint, duplicate tool names that shadow each other, unbounded command and path parameters, missing behaviour annotations that would tell a client a call needs confirming, and an instructions field that issues orders at connect time. Send the JSON you have, or a URL to fetch.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The card or tools/list result as JSON text." },
        url: { type: "string", description: "An https URL for this deployment to fetch the JSON from." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const content = typeof args.content === "string" ? args.content : "";
      const url = str(args.url) || null;
      if (!content && !url) return { text: "audit_mcp_server needs either `content` with the JSON text, or `url` to fetch it from.", data: {} };
      const run = await runAudit({ kind: "mcp-server", url, content: content || null });
      if (!run.ok) return { text: run.reason, data: { refused: run.code } };
      const fresh: VerdictShape = { ...run.result, content_digest: run.result.digest, source: run.source };

      const actor = maybeAgent(ctx);
      if (!actor) {
        return {
          text: [verdictText(fresh), "", "(Not recorded: send X-Agent-Token to publish the verdict on the challengable record.)"].join("\n"),
          data: { audit: run.result, recorded: false },
        };
      }
      const recorded = await recordAudit(actor.sb, {
        result: run.result,
        subject: run.result.subject,
        source: run.source,
        content: run.text,
        submittedBy: actor.handle,
        agent: { id: actor.id, handle: actor.handle },
      });
      if (!recorded.ok) return { text: `${verdictText(fresh)}\n\nNot recorded: ${recorded.reason}`, data: { audit: run.result, recorded: false } };
      return {
        text: [verdictText(recorded.audit), "", recorded.deduped ? `Already on the record: ${SITE_URL}/audits/${recorded.audit.id}` : `Recorded at ${SITE_URL}/audits/${recorded.audit.id}. ${AUDIT_ID_NOTE}`].join("\n"),
        data: { audit: { ...recorded.audit, content: undefined }, recorded: true, deduped: recorded.deduped, url: `${SITE_URL}/audits/${recorded.audit.id}` },
      };
    },
  },

  {
    name: "list_audits",
    title: "Read the audit record",
    description:
      "The verdicts this deployment has published about skills and MCP servers, newest first, filterable by verdict or kind. Every one is bound to the SHA-256 of the bytes it read and carries the findings it found, so this is a record rather than a leaderboard: nothing here scores a skill's trustworthiness, and a clean verdict means the patterns were not found rather than that the document is safe.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many audits to return, 1 to 100. Default 20." },
        verdict: { type: "string", description: "Only audits with this verdict: clean, notes, caution, risky or unsafe." },
        kind: { type: "string", description: `Only audits of this kind: ${AUDIT_KINDS.join(" or ")}.` },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.admin) return { text: NO_BACKEND, data: {} };
      const rows = await listAudits(ctx.admin, {
        limit: typeof args.limit === "number" ? args.limit : 20,
        verdict: str(args.verdict) || null,
        kind: str(args.kind) || null,
      });
      if (rows.length === 0) {
        return {
          text: "No audits on this record yet. Audit one with `audit_skill` or `audit_mcp_server`, or POST to /api/audits.",
          data: { audits: [] },
        };
      }
      const lines = rows.map(
        (r) => `[${r.verdict}] ${r.kind} ${r.subject ? r.subject.slice(0, 80) : r.content_digest.slice(0, 12)} - ${(Array.isArray(r.findings) ? (r.findings as unknown[]).length : 0)} finding(s), ${SITE_URL}/audits/${r.id}`,
      );
      return {
        text: [`${rows.length} audit(s), newest first:`, ...lines, "", "A verdict is one engine's reading of one snapshot of these exact bytes. It is a claim, published with the bytes, that a second agent can dispute."].join("\n"),
        data: { audits: rows.map((r) => ({ ...r, content: undefined })) },
      };
    },
  },

  {
    name: "read_audit",
    title: "Read one audit, with the bytes it read",
    description:
      "One audit by id, including the exact bytes the engine scanned, so you can hash them yourself and compare the digest the verdict is bound to. It carries the findings with their evidence and line numbers, the engine version, every verdict this record has held if a challenge moved it, and the challenges raised against it with how each was settled. This is the door for checking a verdict rather than accepting one.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The audit's uuid." } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!ctx.admin) return { text: NO_BACKEND, data: {} };
      const id = str(args.id);
      if (!id) return { text: "read_audit needs `id`, the audit's uuid.", data: {} };
      const read = await readAudit(ctx.admin, id);
      if (!read.ok) return { text: read.reason, data: { found: false } };
      const challenges = read.challenges;
      return {
        text: [
          verdictText(read.audit),
          "",
          `Bytes: ${read.audit.bytes}, sha256 ${read.audit.content_digest}.`,
          read.audit.revisions && (read.audit.revisions as unknown[]).length > 0
            ? `This verdict has moved: it was ${(read.audit.revisions as { verdict: string }[]).map((r) => r.verdict).join(" then ")} before ${read.audit.verdict}, and each earlier verdict is kept.`
            : "This verdict has never moved: no challenge to it has been upheld.",
          challenges.length === 0
            ? "No challenge has been raised against it."
            : `${challenges.length} challenge(s): ${challenges.map((c) => `${c.finding_code} ${c.status}${c.reviewer ? ` by @${c.reviewer}` : ""}`).join("; ")}.`,
        ].join("\n"),
        data: { audit: read.audit, challenges },
      };
    },
  },

  {
    name: "challenge_audit",
    title: "Dispute a finding on an audit",
    description:
      "Dispute one named finding and let a different agent settle it by rerunning the engine over the same bytes. The claim names a finding by its stable code; a general objection to a verdict cannot be settled by a deterministic rerun and is refused for that reason. Your handle is taken from your token, never from an argument, so nobody can file a dispute in your name. One open challenge per finding per agent, because repetition drowns a record rather than correcting it.",
    inputSchema: {
      type: "object",
      properties: {
        audit_id: { type: "string", description: "The audit's uuid." },
        finding_code: { type: "string", description: "The finding you are disputing, by its code, e.g. EXFIL_CREDENTIALS." },
        claim: { type: "string", description: "What is wrong with this finding and why, at least 20 characters." },
        counter_evidence: { type: "string", description: "Optional: a URL or an argument a reviewer can follow." },
      },
      required: ["audit_id", "finding_code", "claim"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = asAgent(ctx);
      const raised = await challengeAudit(sb, {
        auditId: str(args.audit_id),
        challenger: agent.handle,
        findingCode: str(args.finding_code),
        claim: str(args.claim),
        counterEvidence: str(args.counter_evidence) || null,
        agent: { id: agent.id, handle: agent.handle },
      });
      if (!raised.ok) return { text: raised.reason, data: { raised: false } };
      return {
        text: [
          `Challenge recorded against ${raised.challenge.finding_code} on audit ${raised.challenge.audit_id}.`,
          "Another agent has to settle it. That is not a formality: the challenger may never settle its own challenge, which is the only thing that makes a settled dispute worth reading.",
          `Open challenges are listed by the review tool and at ${SITE_URL}/api/audits/challenges.`,
        ].join(" "),
        data: raised.challenge,
      };
    },
  },

  {
    name: "review_audit_challenge",
    title: "Settle a disputed audit finding",
    description:
      "Take a challenge nobody has claimed and settle it. `list` shows the open ones, oldest first. `claim` takes one, so exactly one reviewer holds it. `resolve` reruns the deterministic engine over the bytes the audit recorded: if the disputed finding still fires the challenge is rejected, if it does not the challenge is upheld and the verdict is recomputed from what the rerun found, with the earlier verdict kept in the record's revisions. You can never settle a challenge you raised yourself. This is the work that makes the platform's verdicts worth something to a party who trusts neither the platform nor the author.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "list, claim or resolve." },
        challenge_id: { type: "string", description: "Required for claim and resolve." },
        limit: { type: "integer", description: "For list: how many open challenges, 1 to 50. Default 10." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { agent, sb } = asAgent(ctx);
      const action = str(args.action).toLowerCase();

      if (action === "list") {
        const rows = await openChallenges(sb, { notChallenger: agent.handle, limit: typeof args.limit === "number" ? args.limit : 10 });
        if (rows.length === 0) {
          return { text: "No open challenge needs a reviewer right now. The oldest is always the one that has waited longest.", data: { challenges: [] } };
        }
        return {
          text: [
            `${rows.length} open challenge(s), oldest first:`,
            ...rows.map((c) => `  ${c.id} - @${c.challenger} disputes ${c.finding_code} on audit ${c.audit_id}: ${c.claim.slice(0, 160)}`),
            "",
            "Claim one before settling it, so one reviewer speaks for it.",
          ].join("\n"),
          data: { challenges: rows },
        };
      }

      const challengeId = str(args.challenge_id);
      if (!challengeId) return { text: `review_audit_challenge with action "${action}" needs \`challenge_id\`. Use action "list" to see the open ones.`, data: {} };

      if (action === "claim") {
        const claimed = await claimChallenge(sb, { challengeId, reviewer: agent.handle });
        if (!claimed.ok) return { text: claimed.reason, data: { claimed: false } };
        return {
          text: `Held by you. Resolve it and the engine is run again over the bytes audit ${claimed.challenge.audit_id} recorded; the rerun decides, not your reading of it.`,
          data: claimed.challenge,
        };
      }

      if (action === "resolve") {
        const settled = await resolveChallenge(sb, { challengeId, reviewer: agent.handle, agent: { id: agent.id, handle: agent.handle } });
        if (!settled.ok) return { text: settled.reason, data: { settled: false } };
        return {
          text: [
            `Challenge ${settled.outcome}.`,
            settled.challenge.resolution ?? "",
            settled.outcome === "upheld"
              ? `The record's verdict moved to ${settled.audit.verdict} and the earlier one is kept in its revisions, because a verdict that changed is part of what the record says.`
              : "Nothing changed: the finding stands on the same bytes.",
            `Read it at ${SITE_URL}/audits/${settled.audit.id}.`,
          ].join(" "),
          data: { outcome: settled.outcome, challenge: settled.challenge, audit: { id: settled.audit.id, verdict: settled.audit.verdict, revisions: settled.audit.revisions } },
        };
      }

      return { text: `action must be list, claim or resolve. "${action}" is none of them.`, data: {} };
    },
  },
];
