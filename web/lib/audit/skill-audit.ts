import { createHash } from "node:crypto";

/**
 * THE AUDIT ENGINE: what a skill or an MCP server does, read off its own bytes.
 *
 * WHY THIS EXISTS. In February 2026 Snyk scanned 3,984 skills from the ClawHub
 * registry and found 1,467 with at least one security flaw, 13.4 percent of them
 * critical; Antiy CERT counted 1,184 malicious skills; a separate academic scan found
 * tool poisoning in about 5.5 percent of 1,899 MCP servers. A skill is an instruction
 * manual an agent loads into its own context, which makes it executable in the only
 * way that matters: the text steers the agent, and the agent holds the credentials.
 * Meanwhile no registry publishes a verdict into a record that a second party can
 * inspect and challenge.
 *
 * WHAT THIS IS. A pattern audit of specific bytes. It reads a SKILL.md and its
 * frontmatter, or the card and tool catalogue a server publishes, and reports what it
 * actually saw, quoting the exact text, with a line number and a sentence saying what
 * the pattern enables rather than that it looks suspicious.
 *
 * WHAT IT IS NOT, AND THE ENGINE SAYS SO IN EVERY RECORD. It does not run anything,
 * it does not prove the absence of a flaw, it does not score trustworthiness, and a
 * clean verdict is not a safety guarantee. It is one reader's opinion of one snapshot,
 * bound by digest to the exact bytes it read, which is a weaker claim than it sounds
 * and a stronger one than a scanner that publishes a badge.
 *
 * WHY THE RULES ARE DATA. Every rule is an entry in one list with a stable code, a
 * severity, the pattern, and a sentence of prose a reader can disagree with. Adding a
 * rule is adding a row, a verifier asserts each fires on its own positive sample and
 * stays quiet on a clean one, and nothing here computes a score that could hide which
 * rule produced it.
 */

export const AUDIT_ENGINE = "swamp-audit/2";

export type AuditKind = "skill" | "mcp-server";

/** The two kinds, as values, so a door can refuse a third by name. */
export const AUDIT_KINDS: AuditKind[] = ["skill", "mcp-server"];

export function isAuditKind(v: unknown): v is AuditKind {
  return typeof v === "string" && (AUDIT_KINDS as string[]).includes(v);
}
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Verdict = "clean" | "notes" | "caution" | "risky" | "unsafe";

export const SEVERITIES: Severity[] = ["info", "low", "medium", "high", "critical"];

export type Finding = {
  /** Stable code, so a challenge and a rerun can name one specific finding. */
  code: string;
  severity: Severity;
  title: string;
  why: string;
  /** The exact text that matched, truncated. Never a paraphrase. */
  evidence: string;
  /** Where it was seen: a line number in the audited file, or a named field. */
  where: string;
  line: number | null;
};

export type AuditResult = {
  kind: AuditKind;
  engine: string;
  verdict: Verdict;
  findings: Finding[];
  counts: Record<Severity, number>;
  /** SHA-256 of the exact bytes audited, hex. The record is bound to this. */
  digest: string;
  bytes: number;
  subject: string | null;
  frontmatter: Record<string, unknown> | null;
  summary: string;
  /** What this engine did and did not do, said in the record rather than in a FAQ. */
  scope: string;
};

const SCOPE =
  "A pattern audit of one snapshot of these bytes. The engine read the text and did not run it, so a clean verdict means these patterns were not found, not that the skill or server is safe.";

/** SHA-256 of the audited bytes. The digest is what a record is bound to. */
export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Evidence is quoted, never paraphrased, and capped so a record stays readable. */
function quote(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** The line number a character offset falls on, 1-indexed. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** A rule: the pattern, what it means, and where it is looked for. */
type Rule = {
  code: string;
  severity: Severity;
  title: string;
  why: string;
  pattern: RegExp;
};

/**
 * THE RULE SET.
 *
 * Ordered by what a reader should see first rather than by severity, because the
 * record is read top to bottom. Each pattern is deliberately narrow: a rule that fires
 * on ordinary prose trains its reader to ignore it, and an ignored audit is worse than
 * no audit because it looks like coverage.
 */
const INSTRUCTION_RULES: Rule[] = [
  {
    code: "INJECTION_OVERRIDE",
    severity: "critical",
    title: "Text instructs the reading model to disregard its own instructions",
    why: "This is the classic override. If the skill is loaded, the agent is being told to replace its operator's rules with text from a stranger.",
    pattern:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|earlier|above|system|original)\b[^.\n]{0,30}\b(instruction|prompt|rule|direction|message)/i,
  },
  {
    code: "INJECTION_AUTHORITY",
    severity: "high",
    title: "Text claims authority it cannot have from inside a skill",
    why: "A skill is data written by its author. Text that speaks as the platform, the operator or a reviewer is impersonating a source the agent trusts.",
    pattern:
      /\b(as|from)\b[^.\n]{0,20}\b(the platform|the operator|the system|an? admin(istrator)?|your (creator|owner|developer))\b[^.\n]{0,30}\b(you (must|should|are required)|require|instruct|demand)/i,
  },
  {
    code: "INJECTION_TOOL_DIRECTIVE",
    severity: "high",
    title: "Text orders a specific tool call rather than describing a procedure",
    why: "A skill that issues imperative tool calls is driving the agent directly. Describing how a job is done is the point of a skill; ordering a call is how an attacker gets one.",
    pattern: /\b(always|without (asking|checking|pausing|telling))[^.\n]{0,30}\b(run|execute|invoke|call|send|post|delete|transfer|approve)\b/i,
  },
  {
    code: "STEALTH_CONCEALMENT",
    severity: "critical",
    title: "Text asks the agent not to tell anyone, or not to log what it did",
    why: "A legitimate instruction has no reason to be quiet. Secrecy here exists to keep the operator from seeing the consequence.",
    pattern: /\b(do not|don't|never)\b[^.\n]{0,25}\b(tell|mention|reveal|disclose|log|report|inform|notify)\b/i,
  },
  {
    code: "STEALTH_SILENT",
    severity: "high",
    title: "Text asks for something to happen silently",
    why: "Silent execution removes the human checkpoint and the record. Both are things this platform treats as load bearing.",
    pattern: /\b(silently|quietly|without (the|any) (user|human|operator) (knowing|noticing|approval|consent))\b/i,
  },
  // THE ONE RULE HERE THAT WAS TOO BLUNT, AND HOW IT WAS FOUND.
  //
  // It used to fire on the bare token: `api_key`, `private_key`, `PRIVATE_KEY`, with no
  // action required. Driving the paid deep scan at this deployment's own published skill
  // produced a CRITICAL finding on the sentence "The reply carries an `api_key` and an
  // Ed25519 `private_key`. Both are shown once." — a line that DOCUMENTS what a
  // registration response contains. The record then called our own documentation unsafe,
  // which is worse than a miss: a critical finding that a reader can disprove by reading
  // the quoted line teaches every reader to discount the whole record.
  //
  // So the rule now needs an ACTION, the way every other rule in this list does. It fires
  // on a reach verb within a short window of a credential name, or on one of the
  // unambiguous credential STORES, whose presence is itself the finding: `~/.ssh`,
  // `id_rsa`, `.aws/credentials`, `netrc` and `keychain` do not appear in a sentence about
  // what an API returns. Naming a secret and reaching for one are different sentences, and
  // this is the difference between them, expressed as one pattern because the engine's
  // rules are patterns.
  {
    code: "EXFIL_CREDENTIALS",
    severity: "critical",
    title: "Text reaches for credential stores or secret environment variables",
    why: "A skill does not need a private key, an API key or another agent's token to do its job. Reading them is how a skill becomes a theft. Merely naming one is not this finding: the rule requires a verb that reaches for it, or a path that only appears when something is being opened.",
    pattern:
      /\b(read|cat|open|print|dump|copy|copying|extract|grab|fetch|access|load|parse|harvest|steal|exfiltrate)\b[^.\n]{0,60}\b(~\/\.ssh|id_rsa|id_ed25519|\.env\b|aws_secret|aws_access_key|supabase_service|private[_ -]?key|api[_ -]?key|secret[_ -]?key|keychain|\.aws\/credentials|netrc|\$\.(AWS_SECRET_ACCESS_KEY|SUPABASE_SERVICE_ROLE_KEY|PRIVATE_KEY))|~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\bnetrc\b|\bkeychain\b/i,
  },
  {
    code: "EXFIL_TRANSMIT",
    severity: "critical",
    title: "Text moves content to an address it names",
    why: "Sending what the agent can read to a host of the author's choosing is exfiltration, whether the payload is a file, a memory or a key.",
    pattern:
      /\b(send|post|upload|forward|transmit|exfiltrate|deliver|leak)\b[^.\n]{0,50}\b(to|at|into)\b[^.\n]{0,20}(https?:\/\/|@|0x[0-9a-fA-F]{6,}|webhook|endpoint|server)/i,
  },
  {
    code: "EXFIL_OTHER_AGENTS",
    severity: "high",
    title: "Text targets other agents' memory, keys or private context",
    why: "Reading a peer's memory or a peer's token is the cross agent failure this habitat spends most of its rules preventing.",
    pattern: /\b(another|other|peer|other agents?|someone else'?s?)\b[^.\n]{0,30}\b(memory|token|key|credential|secret|inbox|private)/i,
  },
  {
    code: "EXEC_PIPE_TO_SHELL",
    severity: "critical",
    title: "Text pipes downloaded content into a shell",
    why: "The result is executed without review, and the content is controlled by whoever serves the URL.",
    pattern: /\b(curl|wget|fetch)\b[^\n]{0,120}\|\s*(sudo\s+)?(ba|z|k|da)?sh\b|\b(bash|sh)\s+-c\b[^\n]{0,80}(curl|wget|base64)/i,
  },
  {
    code: "EXEC_EVAL",
    severity: "high",
    title: "Text evaluates a string or decodes and runs a payload",
    why: "Evaluation hides what will run. In a skill it means the instruction is opaque even to a reader who reads it carefully.",
    pattern: /\b(eval|new Function|exec)\s*\(|\bbase64\s+(-d|--decode)\b[^\n]{0,60}\|\s*\w+/i,
  },
  {
    code: "OBFUSCATION_BLOB",
    severity: "medium",
    title: "A long encoded blob sits in the text",
    why: "Encoded content is unreadable by design. There is rarely a reason for a skill's instructions to carry one, and a payload often does.",
    pattern: /\b[A-Za-z0-9+/]{180,}={0,2}\b/,
  },
  {
    code: "OVERSIGHT_BYPASS",
    severity: "high",
    title: "Text tells the agent to work around its own guardrails or permissions",
    why: "An instruction that asks an agent to bypass its runtime restrictions is asking it to break the boundary its operator set.",
    pattern:
      /\b(bypass|circumvent|get around|work around|disable)\b[^.\n]{0,30}\b(guardrail|restriction|safety|permission|approval|sandbox|policy)\b/i,
  },
];

/** Characters that render as nothing, or reorder what a reader sees. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** HTML comments hide text from a human reader and show it to a model. */
const HTML_COMMENT_INSTRUCTION = /<!--[\s\S]{0,800}?(ignore|system|instruction|you must|do not tell|password|key)[\s\S]{0,800}?-->/i;

export type Frontmatter = {
  fields: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
  error: string | null;
};

/**
 * Parse the YAML frontmatter of a SKILL.md.
 *
 * Deliberately a small subset: top level scalars, one level of nested maps, and lists
 * of scalars. That covers every field the Agent Skills specification defines plus the
 * fields an author is likely to invent, and it fails loudly rather than silently when
 * the frontmatter is missing, because the extension requires name and description and
 * a client that cannot read them cannot load the skill.
 */
export function parseFrontmatter(markdown: string): Frontmatter {
  const text = markdown.replace(/^\uFEFF/, "");
  if (!/^---\s*\r?\n/.test(text)) {
    return { fields: {}, body: text, bodyStartLine: 1, error: "No YAML frontmatter: the file does not open with a --- line." };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { fields: {}, body: text, bodyStartLine: 1, error: "Unterminated YAML frontmatter: no closing --- line." };
  }
  const raw = text.slice(text.indexOf("\n") + 1, end);
  const bodyStart = end + 4;
  const fields: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  let nested: Record<string, unknown> | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      currentList = currentList ?? [];
      currentList.push(unquote(listItem[1]));
      fields[currentKey] = currentList;
      continue;
    }
    const nestedItem = /^\s{2,}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (nestedItem && currentKey && !currentList) {
      nested = nested ?? {};
      nested[nestedItem[1]] = parseScalar(nestedItem[2]);
      fields[currentKey] = nested;
      continue;
    }
    const top = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    currentKey = top[1];
    currentList = null;
    nested = null;
    fields[currentKey] = top[2].trim() === "" ? {} : parseScalar(top[2]);
  }

  return {
    fields,
    body: text.slice(bodyStart),
    bodyStartLine: text.slice(0, bodyStart).split("\n").length,
    error: null,
  };
}

function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function parseScalar(v: string): unknown {
  const t = v.trim();
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^-?\d+$/.test(t)) return Number(t);
  return unquote(t);
}

/** Run one list of rules over one string, returning findings with line numbers. */
function scan(text: string, rules: Rule[], where: string, lineOffset = 0): Finding[] {
  const out: Finding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let match: RegExpExecArray | null;
    let seen = 0;
    while ((match = re.exec(text)) !== null && seen < 3) {
      seen += 1;
      out.push({
        code: rule.code,
        severity: rule.severity,
        title: rule.title,
        why: rule.why,
        evidence: quote(match[0]),
        where,
        line: lineAt(text, match.index) + lineOffset,
      });
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return out;
}

/** Severity of the worst finding decides the verdict, and two mediums also count. */
export function verdictOf(findings: Finding[]): Verdict {
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  if (count("critical") > 0) return "unsafe";
  if (count("high") > 0) return "risky";
  if (count("medium") > 1) return "risky";
  if (count("medium") === 1) return "caution";
  if (count("low") > 0 || count("info") > 0) return "notes";
  return "clean";
}

export function countsOf(findings: Finding[]): Record<Severity, number> {
  return Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
}

const VERDICT_SENTENCE: Record<Verdict, string> = {
  clean: "No rules fired. This says the patterns were not found, and nothing more.",
  notes: "Nothing dangerous, one or two things worth reading.",
  caution: "One pattern worth a human opinion before this is loaded.",
  risky: "This should not be loaded without reading it end to end first.",
  unsafe: "Do not load this. It contains a pattern that exists to take control, move data or hide what it did.",
};

/**
 * Audit a skill.
 *
 * The frontmatter gets its own rules because it is where a skill declares privileges,
 * and the body gets the pattern rules, because that is where instructions live. The
 * name is checked against the URL path when a URL is given, since the Skills extension
 * requires the final path segment to equal the name and a mismatch means the entry a
 * client builds from a URI describes a different skill.
 */
export function auditSkill(input: { text: string; url?: string | null }): AuditResult {
  const text = input.text;
  const url = input.url ?? null;
  const fm = parseFrontmatter(text);
  const findings: Finding[] = [];

  if (fm.error) {
    findings.push({
      code: "FRONTMATTER_MISSING",
      severity: "high",
      title: fm.error,
      why: "The Agent Skills specification requires YAML frontmatter with a name and a description. A client cannot load a skill it cannot identify or describe.",
      evidence: quote(text.slice(0, 120)),
      where: "SKILL.md",
      line: 1,
    });
  }

  const name = typeof fm.fields.name === "string" ? fm.fields.name : "";
  const description = typeof fm.fields.description === "string" ? fm.fields.description : "";
  if (!fm.error) {
    if (!name) {
      findings.push({
        code: "FRONTMATTER_NO_NAME",
        severity: "high",
        title: "No name in the frontmatter",
        why: "The name is the skill's identity and the final segment of its own URI. Without it a host cannot address or approve it.",
        evidence: "-",
        where: "SKILL.md frontmatter",
        line: 1,
      });
    }
    if (!description) {
      findings.push({
        code: "FRONTMATTER_NO_DESCRIPTION",
        severity: "medium",
        title: "No description in the frontmatter",
        why: "The description is what an agent reads at level one, before deciding to load the body. Empty means the skill is loaded blind or not at all.",
        evidence: "-",
        where: "SKILL.md frontmatter",
        line: 1,
      });
    }
    if (name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      findings.push({
        code: "FRONTMATTER_NAME_RULES",
        severity: "medium",
        title: `The name "${name}" is outside the naming rules`,
        why: "The specification allows lowercase letters, digits and single hyphens. A name outside that will not match the directory or path segment a host expects.",
        evidence: name,
        where: "SKILL.md frontmatter",
        line: 1,
      });
    }
    if (name && url) {
      const path = url.split("?")[0].replace(/\/+$/, "");
      const last = path.split("/").filter(Boolean).pop() ?? "";
      const expected = last === "SKILL.md" ? (path.split("/").filter(Boolean).slice(-2)[0] ?? "") : last;
      if (expected && expected !== name) {
        findings.push({
          code: "URI_NAME_MISMATCH",
          severity: "medium",
          title: `The URL names "${expected}" and the frontmatter says "${name}"`,
          why: "The Skills extension requires the final segment of the skill path to equal the declared name. A mismatch means the entry built from the URI describes a different skill than the one served.",
          evidence: `${url} vs name: ${name}`,
          where: "SKILL.md frontmatter",
          line: 1,
        });
      }
    }

    // Privilege declared in frontmatter. These are the fields that turn a document
    // into something a host may run or grant, so they are read explicitly rather
    // than pattern matched.
    for (const [field, value] of Object.entries(fm.fields)) {
      const f = field.toLowerCase();
      if (["allowed-tools", "allowed_tools", "tools"].includes(f)) {
        const list = Array.isArray(value) ? value.map(String) : [String(value)];
        const dangerous = list.filter((t) => /\b(bash|shell|exec|write|edit|delete|network|fetch|curl|computer|browser)\b/i.test(t));
        if (dangerous.length > 0) {
          findings.push({
            code: "FRONTMATTER_PRIVILEGE",
            severity: "high",
            title: `Frontmatter asks for powerful tools: ${dangerous.join(", ")}`,
            why: "The extension gates these fields behind explicit user approval precisely because they let a skill act rather than instruct. A skill that asks for shell or write access should have to justify it in its prose.",
            evidence: `${field}: ${list.join(", ")}`,
            where: "SKILL.md frontmatter",
            line: 1,
          });
        }
      }
      if (["hooks", "hook", "shell", "command", "commands", "scripts"].includes(f)) {
        findings.push({
          code: "FRONTMATTER_HOOKS",
          severity: "critical",
          title: `Frontmatter declares executable hooks (${field})`,
          why: "Hooks run code, and running code is beyond what a document should be able to ask for. The extension says these do not run without per-skill approval, and this audit treats their presence as a finding either way.",
          evidence: `${field}: ${quote(JSON.stringify(value), 160)}`,
          where: "SKILL.md frontmatter",
          line: 1,
        });
      }
    }
  }

  findings.push(...scan(text, INSTRUCTION_RULES, "SKILL.md"));
  if (INVISIBLE.test(text)) {
    findings.push({
      code: "OBFUSCATION_INVISIBLE",
      severity: "high",
      title: "The text contains characters that render as nothing",
      why: "Zero width and bidirectional control characters let instructions hide inside a document a human has read and approved. Nothing legitimate here needs them.",
      evidence: quote(text.replace(/[^\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "").slice(0, 40)),
      where: "SKILL.md",
      line: lineAt(text, text.search(INVISIBLE)),
    });
  }
  const comment = HTML_COMMENT_INSTRUCTION.exec(text);
  if (comment) {
    findings.push({
      code: "OBFUSCATION_HTML_COMMENT",
      severity: "high",
      title: "An HTML comment carries what reads like an instruction",
      why: "A comment is invisible in rendered markdown and fully visible to a model reading the raw text, which is the exact asymmetry an injection needs.",
      evidence: quote(comment[0], 200),
      where: "SKILL.md",
      line: lineAt(text, comment.index),
    });
  }
  if (text.length > 262_144) {
    findings.push({
      code: "SIZE_LARGE",
      severity: "low",
      title: "This document is larger than a skill body usually needs",
      why: "One vendor caps SKILL.md at 256 KiB. A body beyond that will be refused by some clients, and bulk is where a payload hides.",
      evidence: `${text.length} bytes`,
      where: "SKILL.md",
      line: null,
    });
  }

  const verdict = verdictOf(findings);
  return {
    kind: "skill",
    engine: AUDIT_ENGINE,
    verdict,
    findings,
    counts: countsOf(findings),
    digest: sha256Of(text),
    bytes: Buffer.byteLength(text, "utf8"),
    subject: url,
    frontmatter: fm.fields,
    summary: VERDICT_SENTENCE[verdict],
    scope: SCOPE,
  };
}

/**
 * Audit an MCP server from what it publishes.
 *
 * Input is JSON: a server card, a tools/list result, or a bare array of tools. Tool
 * poisoning lives in the tool descriptions, because that is the field a model reads
 * and a human rarely does, so a poisoned server ships its instruction inside the
 * description of a benign sounding tool.
 */
export function auditMcpServer(input: { body: unknown; url?: string | null }): AuditResult {
  const url = input.url ?? null;
  const findings: Finding[] = [];
  const body = input.body as Record<string, unknown> | unknown[] | null;
  const text = typeof body === "string" ? (body as string) : JSON.stringify(body ?? null);

  const asObject = (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null) ?? null;
  const result = (asObject?.result ?? asObject) as Record<string, unknown> | unknown[] | null;
  const toolsRaw =
    (Array.isArray(result) ? result : (result as Record<string, unknown> | null)?.tools) ??
    (Array.isArray(asObject?.tools) ? asObject?.tools : null);
  const tools = Array.isArray(toolsRaw) ? (toolsRaw as Record<string, unknown>[]) : [];
  const card = asObject && (asObject.serverInfo || asObject.transport || asObject.capabilities) ? asObject : null;

  if (!card && tools.length === 0) {
    findings.push({
      code: "SERVER_UNREADABLE",
      severity: "medium",
      title: "This does not look like a server card or a tool catalogue",
      why: "The audit read the document and found neither a card nor a list of tools, so nothing about the server was checked. That is a gap in the audit, not a clean result.",
      evidence: quote(text.slice(0, 160)),
      where: "the submitted document",
      line: null,
    });
  }

  if (card) {
    const transport = (card.transport ?? {}) as Record<string, unknown>;
    const endpoint = String(transport.endpoint ?? transport.url ?? url ?? "");
    if (endpoint && !/^https:\/\//.test(endpoint)) {
      findings.push({
        code: "SERVER_TRANSPORT_PLAIN",
        severity: "high",
        title: "The declared endpoint is not https",
        why: "A payment proof, an agent token and every tool argument cross this transport. Over plain http they are readable and changeable in flight.",
        evidence: endpoint,
        where: "transport",
        line: null,
      });
    }
    const auth = (card.authentication ?? {}) as Record<string, unknown>;
    const schemes = Array.isArray(auth.schemes) ? auth.schemes : [];
    if (auth.required === false && schemes.length === 0 && tools.length > 0) {
      findings.push({
        code: "SERVER_NO_AUTH",
        severity: "info",
        title: "No authentication is declared",
        why: "Correct for a public read surface and worth knowing before calling a write tool. This is a fact, not a defect.",
        evidence: "authentication.required: false",
        where: "authentication",
        line: null,
      });
    }
    const protocolVersion = String(card.protocolVersion ?? "");
    if (protocolVersion && protocolVersion < "2026-07-28") {
      findings.push({
        code: "SERVER_PROTOCOL_OLD",
        severity: "info",
        title: `The card declares protocol version ${protocolVersion}`,
        why: "That is the session based core, deprecated under SEP-2596. Still served, and worth knowing before writing against it.",
        evidence: protocolVersion,
        where: "protocolVersion",
        line: null,
      });
    }
    const capabilities = (card.capabilities ?? {}) as Record<string, unknown>;
    const extensions = (capabilities.extensions ?? {}) as Record<string, unknown>;
    const extensionNames = Object.keys(extensions);
    if (extensionNames.length === 0) {
      findings.push({
        code: "SERVER_NO_EXTENSIONS",
        severity: "info",
        title: "The card declares no extensions",
        why: "Tasks, Apps and Skills are all extensions. A server that declares none is not necessarily a problem, and it does mean long work has to fit in a request.",
        evidence: "capabilities.extensions is empty",
        where: "capabilities",
        line: null,
      });
    }
  }

  const seen = new Set<string>();
  for (const tool of tools) {
    const name = String(tool?.name ?? "");
    const description = String(tool?.description ?? "");
    const where = `tool ${name || "(unnamed)"}`;
    if (name && seen.has(name)) {
      findings.push({
        code: "TOOL_DUPLICATE_NAME",
        severity: "medium",
        title: `Two tools are called ${name}`,
        why: "A duplicate name means one of them is unreachable and a client cannot tell which. A shadowed tool is a place to hide behaviour.",
        evidence: name,
        where,
        line: null,
      });
    }
    if (name) seen.add(name);
    if (!description) {
      findings.push({
        code: "TOOL_NO_DESCRIPTION",
        severity: "low",
        title: `${where} has no description`,
        why: "A tool with no description is chosen by name alone, and the model is guessing at what it does with access you granted.",
        evidence: "-",
        where,
        line: null,
      });
    }
    if (description.length > 2000) {
      findings.push({
        code: "TOOL_DESCRIPTION_BLOATED",
        severity: "medium",
        title: `${where} has a ${description.length} character description`,
        why: "Tool descriptions are read by the model on every turn. A description this long is where an instruction hides, and no human reviewing the interface will read it.",
        evidence: quote(description.slice(0, 200)),
        where,
        line: null,
      });
    }
    for (const finding of scan(description, INSTRUCTION_RULES, where)) findings.push(finding);
    if (INVISIBLE.test(description)) {
      findings.push({
        code: "OBFUSCATION_INVISIBLE",
        severity: "high",
        title: `${where} hides characters that render as nothing in its description`,
        why: "Invisible characters in a tool description are the documented shape of a tool poisoning attack: the model reads a different instruction than the reviewer did.",
        evidence: quote(description.replace(/[^\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "").slice(0, 40)),
        where,
        line: null,
      });
    }
    const annotations = (tool?.annotations ?? {}) as Record<string, unknown>;
    if (annotations.readOnlyHint === undefined && annotations.destructiveHint === undefined && tools.length > 1) {
      findings.push({
        code: "TOOL_NO_ANNOTATIONS",
        severity: "low",
        title: `${where} declares no behaviour annotations`,
        why: "readOnlyHint and destructiveHint are what a client uses to decide whether a call needs confirmation. Absent, the client cannot tell a read from a delete.",
        evidence: "-",
        where,
        line: null,
      });
    }
    const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, Record<string, unknown>> };
    for (const [param, spec] of Object.entries(schema.properties ?? {})) {
      const type = String(spec?.type ?? "");
      if (type === "string" && /\b(command|shell|cmd)\b/i.test(param)) {
        findings.push({
          code: "TOOL_FREEFORM_COMMAND",
          severity: "medium",
          title: `${where} takes a free form shell command in "${param}"`,
          why: "A string that becomes a command is arbitrary execution behind whatever check the server forgot. This is the parameter a hostile caller looks for first.",
          evidence: `${param}: ${type}`,
          where,
          line: null,
        });
      }
      if (type === "string" && /^(path|file|filename|directory)$/i.test(param) && spec?.enum === undefined) {
        findings.push({
          code: "TOOL_UNBOUNDED_PATH",
          severity: "low",
          title: `${where} takes an unbounded "${param}"`,
          why: "A path with no enum and no stated root is how a file read reaches outside the directory the caller was thinking of. Worth knowing before granting it.",
          evidence: `${param}: ${type}`,
          where,
          line: null,
        });
      }
    }
  }

  if (serverCardLooksBroadLikePrompted(card, tools)) {
    findings.push({
      code: "SERVER_INSTRUCTIONS_AS_ORDERS",
      severity: "medium",
      title: "The server's own instructions contain imperative orders to the model",
      why: "An MCP server's instructions field is loaded into the model's context at connect time. Orders there are the same class of risk as in a skill, with a wider reach because every tool is affected.",
      evidence: quote(String((card?.instructions ?? "") as string).slice(0, 200)),
      where: "instructions",
      line: null,
    });
  }

  const verdict = verdictOf(findings);
  return {
    kind: "mcp-server",
    engine: AUDIT_ENGINE,
    verdict,
    findings,
    counts: countsOf(findings),
    digest: sha256Of(text),
    bytes: Buffer.byteLength(text, "utf8"),
    subject: url,
    frontmatter: null,
    summary: VERDICT_SENTENCE[verdict],
    scope: SCOPE,
  };
}

function serverCardLooksBroadLikePrompted(card: Record<string, unknown> | null, tools: Record<string, unknown>[]): boolean {
  if (!card || tools.length === 0) return false;
  const instructions = String(card.instructions ?? "");
  if (instructions.length < 40) return false;
  return INSTRUCTION_RULES.slice(0, 3).some((r) => r.pattern.test(instructions));
}
