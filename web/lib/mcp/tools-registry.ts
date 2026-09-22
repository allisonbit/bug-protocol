import type { McpTool, ToolContext } from "./tools";
import { REGISTRY_DISCLOSURE, REGISTRY_SITE } from "@/lib/registry/clawhub";
import { readCoverage, readGaps, readRegistrySkill, searchRegistry } from "@/lib/registry/store";

/**
 * SOMEBODY ELSE'S SKILL REGISTRY, OVER MCP.
 *
 * WHY AN AGENT WANTS THIS AND A PERSON DOES NOT. An agent about to adopt a published skill
 * is making a decision about bytes it has not read, written by somebody it cannot call. The
 * question it should be able to ask is not "does this exist" — ClawHub answers that — but
 * "has anybody independent read this, and what did they find", and that is a question only
 * a second opinion can answer. These tools are the second opinion, at the size of a tool
 * call rather than a page.
 *
 * WHY THERE IS NO TOOL THAT FETCHES A SKILL'S TEXT. This is the load-bearing omission.
 * Every tool here answers about a document and none of them hands one over, because a
 * registry of tens of thousands of documents written by strangers is a prompt injection
 * surface before it is a library, and a tool that pasted one into an agent's context would
 * be that surface with a door on it. What an agent gets is the verdict, the digest it is
 * bound to, the canonical page and a link to the record where the bytes can be hashed and
 * disputed. It can then decide to go and read it deliberately, which is a different act
 * from being handed it.
 *
 * WHY THE GAPS TOOL IS THE INTERESTING ONE. Coverage answers "what is in here". Gaps answer
 * "what is out there that this deployment cannot do", computed by comparing the topics the
 * registry publishes under against this platform's own declared capabilities. That is what
 * lets a resident direct its own improvement from evidence rather than from an operator's
 * list, and it is the honest form of a self-evolving loop: measured, cited, and queued as
 * work through machinery that already exists.
 *
 * ALL FOUR ARE READ ONLY, and that is not a limitation to be lifted later. Nothing here
 * writes, nothing here reads a stranger's bytes, and nothing here installs anything.
 */

const NO_BACKEND = "The swamp backend is not configured on this deployment, so the registry mirror has no rows to read.";

const ATTRIBUTION = `Mirrored from the public ClawHub registry (${REGISTRY_SITE}) and cached here. ClawHub does not endorse this deployment. A listing is not a recommendation.`;

function str(v: unknown, cap = 200): string {
  return typeof v === "string" ? v.trim().slice(0, cap) : "";
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** One entry as a line of text: what it is, who published it, what both engines said. */
function entryLine(e: {
  ref: string;
  installs: number;
  topics: string[];
  clawhub: { verdict: string | null };
  swamp: { verdict: string | null; agreement: string | null };
  canonical_url: string;
}): string {
  const verdict = e.swamp.verdict ? `audited here: ${e.swamp.verdict}` : e.swamp.agreement === "unreadable" ? "not readable here" : "not audited here yet";
  const theirs = e.clawhub.verdict ? `, registry says ${e.clawhub.verdict}` : "";
  const agreement = e.swamp.agreement && e.swamp.agreement !== "unreadable" && e.clawhub.verdict ? ` (${e.swamp.agreement})` : "";
  return `- ${e.ref} — ${e.installs} install(s), ${verdict}${theirs}${agreement}${e.topics.length ? `, topics: ${e.topics.slice(0, 3).join(", ")}` : ""}\n  ${e.canonical_url}`;
}

export const REGISTRY_TOOLS: McpTool[] = [
  {
    name: "search_skill_registry",
    title: "Search the mirrored public skill registry",
    description:
      "Search the published skills of the ClawHub registry, which this deployment mirrors and judges independently. Use this when a task needs a capability this habitat may not have, or when deciding whether a published skill is one to learn from: it answers with where each skill is published, how many times it has been installed, what the registry's own moderation concluded, and what this deployment's independent audit of the SAME BYTES concluded, with the digest that verdict is bound to. Returns no skill text, by design: this is a security record about documents, not a copy of them.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Free text: the publisher's name for the skill, its slug, its owner, or words from its summary." },
        topic: { type: "string", description: "An exact topic spelling, as read_registry_gaps returns it." },
        verdict: { type: "string", description: "Only skills this deployment judged this way: clean, notes, caution, risky, unsafe." },
        agreement: { type: "string", description: "agree, swamp_stricter, swamp_looser or unreadable, to find where the two engines disagree." },
        min_installs: { type: "integer", description: "Floor on installs, to skip what nobody runs." },
        sort: { type: "string", description: "installs (default), updated, or name." },
        limit: { type: "integer", description: "How many entries, 1 to 100. Default 25." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const found = await searchRegistry(sb, {
        q: str(args.q, 64) || null,
        topic: str(args.topic, 64) || null,
        verdict: str(args.verdict, 16) || null,
        agreement: str(args.agreement, 16) || null,
        minInstalls: num(args.min_installs, 0, 0, 1_000_000_000),
        sort: str(args.sort, 16) || undefined,
        limit: num(args.limit, 25, 1, 100),
      });
      if (found.entries.length === 0) {
        return {
          text: `Nothing in the mirror matches. ${found.matched} entries matched in total, and the mirror is a bounded sweep of the registry rather than the whole of it, so a miss here is not proof a skill does not exist.\n\n${ATTRIBUTION}`,
          data: { entries: [], matched: found.matched },
        };
      }
      return {
        text: [
          `${found.entries.length} of ${found.matched} matching published skill(s):`,
          ...found.entries.map(entryLine),
          "",
          "A verdict here is this deployment's audit of the bytes it read, bound to their SHA-256, and it is one engine's reading of one snapshot: it reads, it does not run the skill, and a clean verdict means the patterns were not found rather than that the skill is safe. Read one with read_registry_skill for the digest, the audit record and the citation, if any.",
          "",
          ATTRIBUTION,
        ].join("\n"),
        data: { entries: found.entries, matched: found.matched, disclosure: REGISTRY_DISCLOSURE },
      };
    },
  },
  {
    name: "read_registry_skill",
    title: "Read one mirrored registry skill",
    description:
      "One published skill as this deployment has it: both verdicts, the SHA-256 our audit is bound to, why that document was read before the others, the canonical page on ClawHub, and the citation if one of this platform's own capabilities has this skill recorded against it. Use it before adopting anything, and follow the audit link to check the bytes rather than trusting the verdict.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Owner-qualified, as the registry qualifies it: owner/slug." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const ref = str(args.ref, 180).toLowerCase();
      if (!ref.includes("/")) {
        return {
          text: `A skill here is addressed owner-qualified, like "charmcrush/incident-review", because slugs are not unique across publishers in this registry. "${ref}" names no owner.`,
          data: {},
        };
      }
      const entry = await readRegistrySkill(sb, ref);
      if (!entry || entry.clawhub.blocked) {
        return {
          text: `Nothing is mirrored for "${ref}". Either the sweep has not reached it or the registry has it blocked, and a blocked skill is never served from here. Search with search_skill_registry to find the closest match.`,
          data: {},
        };
      }
      const lines = [
        `${entry.attribution} — ${entry.name}${entry.version ? ` v${entry.version}` : ""}`,
        entry.summary || "The publisher wrote no summary.",
        "",
        `installed ${entry.installs} time(s); topics: ${entry.topics.length ? entry.topics.join(", ") : "none stated"}`,
        `registry's own verdict: ${entry.clawhub.verdict ?? "not published"}${entry.clawhub.reason_codes.length ? ` (${entry.clawhub.reason_codes.join(", ")})` : ""}`,
        `this deployment's audit: ${entry.swamp.verdict ?? "not audited here yet"}${entry.swamp.agreement ? `, ${entry.swamp.agreement} with the registry` : ""}`,
        entry.swamp.digest ? `bound to ${entry.swamp.digest}` : "",
        entry.swamp.why ? `read because ${entry.swamp.why}` : "",
        entry.swamp.error ? `the last attempt reported: ${entry.swamp.error}` : "",
        entry.swamp.audit_url ? `the record, with the bytes: ${entry.swamp.audit_url}` : "",
        `published at: ${entry.canonical_url}`,
        entry.cited ? `cited against this platform's own capability "${entry.cited.capability}" on ${entry.cited.at}` : "",
        "",
        "The document's text is deliberately not returned here. Fetch it yourself if you mean to read it: a registry of documents written by strangers is a place to go deliberately, not a thing to be handed.",
        "",
        ATTRIBUTION,
      ].filter(Boolean);
      return { text: lines.join("\n"), data: { skill: entry, disclosure: REGISTRY_DISCLOSURE } };
    },
  },
  {
    name: "registry_coverage",
    title: "What this deployment has mirrored and judged",
    description:
      "How much of the published ClawHub registry is mirrored here, how much of it this deployment has audited, how often its verdict agrees with the registry's own moderation and where it does not, and when the sweep last ran. Use it to know how much weight a search result deserves: a verdict that has not been reached yet is not a clean one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const c = await readCoverage(sb);
      const audited = c.audited;
      const pct = (n: number) => (audited > 0 ? `${Math.round((n / audited) * 1000) / 10}%` : "no audits yet");
      const text = [
        `${c.mirrored} published skill(s) mirrored across ${c.topics} topic(s).`,
        `${audited} of them read and judged by this deployment's own engine; ${c.cited} cited against one of its capabilities.`,
        "",
        `Where the two engines met: ${c.agree} agree (${pct(c.agree)}), ${c.swamp_stricter} this deployment was stricter, ${c.swamp_looser} the registry was stricter, ${c.unreadable} could not be read at all.`,
        `${c.sorted_by_registry_flags} were read first because the registry's own moderation flags them.`,
        `${c.blocked} are blocked by the registry and are never served from here.`,
        "",
        c.crawl
          ? `The sweep sorts by ${c.crawl.sort}, is ${c.crawl.complete ? "complete" : "still walking the catalogue"}, has seen ${c.crawl.skills_seen} row(s) over ${c.crawl.pages_seen} page(s) and ${c.crawl.sweeps} full sweep(s), and last ran ${c.crawl.last_run_at ?? "never"}${c.crawl.last_error ? `, reporting: ${c.crawl.last_error}` : ""}.`
          : "The sweep has no state row yet, so the mirror is empty rather than complete.",
        "",
        ATTRIBUTION,
      ].join("\n");
      return { text, data: { coverage: c, disclosure: REGISTRY_DISCLOSURE } };
    },
  },
  {
    name: "read_registry_gaps",
    title: "What the ecosystem publishes under that this habitat cannot do",
    description:
      "The difference between two registers, measured: the topics the mirrored registry publishes skills under, and this deployment's own declared capabilities. Every row is a body of published work this platform has no capability for, with how many skills it holds, how much they are installed, and named examples carrying their verdicts and digests. Use this to find real work worth doing, or to check whether something you are about to build already exists outside. It is a measurement, not a roadmap or a recommendation.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many gaps, 1 to 100. Default 20." },
        include_reported: { type: "boolean", description: "Include gaps a resident has already reported. Default true." },
        examples: { type: "integer", description: "Named skills per gap, 0 to 10. Default 3." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const includeReported = args.include_reported !== false;
      const { gaps, uncovered, topics } = await readGaps(sb, {
        limit: num(args.limit, 20, 1, 100),
        includeReported,
        examples: num(args.examples, 3, 0, 10),
      });
      if (gaps.length === 0) {
        return {
          text: `No gap clears the thresholds. ${topics} topic(s) are counted, ${uncovered} of them have no capability here, and none of those is both large and installed enough to report as a gap yet. ${includeReported ? "" : "Gaps already reported by a resident are excluded from this answer."}\n\n${ATTRIBUTION}`,
          data: { gaps: [], uncovered, topics },
        };
      }
      const blocks = gaps.map((g) => {
        const examples = g.examples.length
          ? `\n  largest: ${g.examples.map((e) => `${e.ref} (${e.installs} installs${e.swamp.verdict ? `, audit ${e.swamp.verdict}` : ", not audited here"})`).join("; ")}`
          : "";
        return `- "${g.topic}" — ${g.skills} published skill(s), ${g.installs} install(s), ${g.audited} audited here${g.suspicious > 0 ? `, ${g.suspicious} flagged by the registry` : ""}${g.reportedAt ? `, reported by a resident on ${g.reportedAt}` : ""}${examples}`;
      });
      return {
        text: [
          `${gaps.length} gap(s) out of ${uncovered} topic(s) with no capability here (${topics} topics counted):`,
          ...blocks,
          "",
          "These are differences between the registry's topics and this deployment's action manifest, so they are measured rather than suggested. A gap is work nobody has done here yet, not a decision to build anything, and the smallest honest version of a capability is usually worth stating before filing a change.",
          "",
          ATTRIBUTION,
        ].join("\n"),
        data: { gaps, uncovered, topics, disclosure: REGISTRY_DISCLOSURE },
      };
    },
  },
];
