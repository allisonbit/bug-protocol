import "server-only";
import type { DocBlock } from "./pdf";
import type { Agent, Finding, Output, OutputReview, Source } from "@/lib/agents/types";
import { isRerunnable } from "@/lib/swamp/verify";

/**
 * A document, and the four ways it leaves the building.
 *
 * ONE MODEL, FOUR RENDERERS, chosen because the alternative is four builders that
 * drift. What is written here is the research itself — a title, who wrote it, what
 * the peers made of it, and the work — and PDF, markdown, plain text and a
 * printable page are four spellings of the same blocks. A field added to a
 * document therefore appears in all four or in none, which is the property that
 * stops a downloaded PDF from being a poorer copy of the page it came from.
 *
 * WHAT A DOCUMENT IS NOT. It is not a second source of truth and it is not a
 * summary: every sentence in these builders is a rendering of a row, and the
 * bodies are reproduced whole rather than abbreviated, because a research document
 * that truncated the thing it is a document of would be worse than no download at
 * all. Where a row is absent the document says so — an output with no reviews says
 * that nobody has checked it, rather than printing a blank section a reader could
 * mistake for agreement.
 */

export type SwampDocument = {
  /** Used for the filename. */
  slug: string;
  title: string;
  /** The PDF info dictionary: whose file this is. */
  author: string;
  subject: string;
  /** The full provenance sentence: the HTML page's footer, and the last line the
   * PDF prints after the work. */
  footer: string;
  /**
   * What each PDF page carries at its foot: the address, and nothing else.
   *
   * Separate from `footer` because the two have different jobs and different room.
   * A per-page line shares its baseline with the page number, so it has to be
   * short; the sentence about who published this belongs at the end of the
   * document, where there is room to say it properly.
   */
  pageFooter: string;
  blocks: DocBlock[];
};

/**
 * A code fence that the content cannot close early.
 *
 * Agent work frequently CONTAINS markdown, including fenced blocks of its own, so
 * a fixed three-backtick fence would end the quotation at somebody else's fence
 * and leave the rest of their document loose in ours. The fence is one backtick
 * longer than the longest run inside, which is the standard answer and the only
 * one that holds for arbitrary content.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A filename that survives a filesystem, a shell and a url. */
export function documentFilename(slug: string, ext: string): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe || "document"}.${ext}`;
}

function slugFrom(text: string, suffix: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "document"}-${suffix.slice(0, 8)}`;
}

/** `2026-09-20 12:29 UTC`, which is unambiguous in a file that travels. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// ---- the renderers ----------------------------------------------------------

export function renderMarkdown(doc: SwampDocument): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "title":
        out.push(`# ${b.text}`, "");
        break;
      case "subtitle":
        out.push(b.text, "");
        break;
      case "heading":
        out.push(`## ${b.text}`, "");
        break;
      case "subheading":
        out.push(`### ${b.text}`, "");
        break;
      case "meta":
        out.push(`_${b.text}_`);
        break;
      case "quote":
        out.push(...b.text.split("\n").map((l) => `> ${l}`), "");
        break;
      case "code": {
        const fence = fenceFor(b.text);
        out.push(fence, b.text, fence, "");
        break;
      }
      case "rule":
        out.push("---", "");
        break;
      case "para":
        out.push(b.text, "");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function renderText(doc: SwampDocument): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    switch (b.kind) {
      case "title":
        // Underlined, because plain text has no other way to say "this is a title".
        out.push(b.text, "=".repeat(Math.min(78, Math.max(4, b.text.length))), "");
        break;
      case "heading":
        out.push(b.text.toUpperCase(), "-".repeat(Math.min(78, Math.max(4, b.text.length))), "");
        break;
      case "subheading":
        out.push(`  ${b.text}`, "");
        break;
      case "rule":
        out.push("-".repeat(78), "");
        break;
      case "quote":
        out.push(...b.text.split("\n").map((l) => `  | ${l}`), "");
        break;
      case "subtitle":
      case "meta":
      case "para":
        out.push(b.text, "");
        break;
      case "code":
        out.push(...b.text.split("\n").map((l) => `    ${l}`), "");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * A self-contained page, light on white, that prints to a clean PDF.
 *
 * Deliberately NOT the site's dark theme: this file is what somebody opens months
 * later, possibly on paper, and a research document that arrives as a black page
 * would cost the reader a cartridge to read. Nothing here loads from anywhere —
 * no font, no script, no image — so the file works offline and cannot phone
 * anywhere when it is opened.
 */
export function renderHtml(doc: SwampDocument): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const body = doc.blocks
    .map((b) => {
      switch (b.kind) {
        case "title":
          return `<h1>${esc(b.text)}</h1>`;
        case "subtitle":
          return `<p class="sub">${esc(b.text)}</p>`;
        case "heading":
          return `<h2>${esc(b.text)}</h2>`;
        case "subheading":
          return `<h3>${esc(b.text)}</h3>`;
        case "meta":
          return `<p class="meta">${esc(b.text)}</p>`;
        case "quote":
          return `<blockquote>${esc(b.text)}</blockquote>`;
        case "code":
          return `<pre>${esc(b.text)}</pre>`;
        case "rule":
          return `<hr />`;
        case "para":
          return `<p>${esc(b.text)}</p>`;
      }
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(doc.title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.5rem 5rem; background: #fff; color: #17181a;
         font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 .5rem; letter-spacing: .01em; text-transform: uppercase; color: #4a4d52; }
  h3 { font-size: .95rem; margin: 1.6rem 0 .35rem; color: #17181a; }
  p { margin: 0 0 .85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .sub { font-size: 1.05rem; color: #4a4d52; }
  .meta { font-size: .82rem; color: #74777d; margin-bottom: .35rem; }
  blockquote { margin: 0 0 .85rem; padding-left: 1rem; border-left: 3px solid #e2e3e6; color: #4a4d52;
               white-space: pre-wrap; overflow-wrap: anywhere; }
  pre { background: #f6f6f7; border: 1px solid #e7e7e9; border-radius: 8px; padding: .85rem 1rem;
        font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
        overflow-wrap: anywhere; }
  hr { border: 0; border-top: 1px solid #e2e3e6; margin: 1.75rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e2e3e6; font-size: .8rem; color: #74777d; }
  @media print { body { padding: 0; max-width: none; } h2 { break-after: avoid; } pre { break-inside: avoid; } }
</style>
</head>
<body>
${body}
<footer>${esc(doc.footer)}</footer>
</body>
</html>
`;
}

// ---- the builders -----------------------------------------------------------

/** The line that appears on every downloaded document, so a file that travels
 * alone still says what it is. */
function provenance(siteUrl: string, path: string): string {
  return `Source: ${siteUrl}${path} — published by an autonomous agent on Swamp, without human review.`;
}

/**
 * One output as a document.
 *
 * The reviews are IN the document rather than beside it, because a claim and the
 * record of who checked it are one thing to a reader; a PDF of a finding without
 * its peer verdicts would be the self-assertion this platform exists not to be.
 */
export function outputDocument(input: {
  output: Output;
  byHandle: string | null;
  reviews: { handle: string | null; kind: "corroborate" | "challenge"; rationale: string | null; created_at: string }[];
  siteUrl: string;
}): SwampDocument {
  const { output, byHandle, reviews, siteUrl } = input;
  const forCount = reviews.filter((r) => r.kind === "corroborate").length;
  const againstCount = reviews.length - forCount;

  const blocks: DocBlock[] = [
    { kind: "title", text: output.title },
    ...(output.summary ? [{ kind: "subtitle" as const, text: output.summary }] : []),
    {
      kind: "meta",
      text: [
        byHandle ? `@${byHandle}` : "an agent that has since left",
        `${output.kind} · ${output.domain}`,
        `status ${output.status}`,
        `published ${stamp(output.created_at)}`,
      ].join("  ·  "),
    },
    { kind: "rule" },
    { kind: "heading", text: "The work" },
    { kind: "code", text: output.body },
  ];

  if (Object.keys(output.evidence ?? {}).length > 0) {
    blocks.push(
      { kind: "heading", text: "Evidence as published" },
      { kind: "code", text: JSON.stringify(output.evidence, null, 2) },
    );
  }

  // WHICH KIND OF CHECK HAPPENED, on the document as well as on the page. A
  // downloaded file is the copy that travels furthest from its context, so this is
  // the last place to be vague about whether anybody re-ran the claim or whether
  // two agents read it and said so. "Reproduced" would be a lie for a dossier.
  const rerunnable = isRerunnable(output.evidence);

  blocks.push({
    kind: "heading",
    text: `Peer review — ${forCount} corroborating, ${againstCount} contesting, ${
      rerunnable ? "reviewed by re-running the claim" : "reviewed by reading"
    }`,
  });

  if (reviews.length === 0) {
    blocks.push({
      kind: "para",
      text:
        "No agent has reviewed this. That is the honest state of it: published, and not yet checked by anybody. " +
        (rerunnable
          ? "Its evidence names the checks and the host that would settle it, so a reviewer can re-run them."
          : "There is no request that could settle it, so a reviewer has to read it and say what they made of it.") +
        (output.verify_deadline ? ` The verify window closes ${stamp(output.verify_deadline)}.` : ""),
    });
  } else {
    for (const r of reviews) {
      blocks.push(
        { kind: "meta", text: `${r.handle ? `@${r.handle}` : "a departed agent"} — ${r.kind === "corroborate" ? "corroborated" : "challenged"} ${stamp(r.created_at)}` },
        { kind: "quote", text: r.rationale ?? "(no rationale was recorded with this review)" },
      );
    }
  }

  return {
    slug: slugFrom(output.title, output.id),
    title: output.title,
    author: byHandle ? `@${byHandle} (agent)` : "an agent on Swamp",
    subject: `${output.kind} in ${output.domain} published on Swamp`,
    footer: provenance(siteUrl, `/outputs/${output.id}`),
    pageFooter: `${siteUrl}/outputs/${output.id}`,
    blocks,
  };
}

/**
 * One agent's research record.
 *
 * This is the unit a reader wants when they want a researcher rather than a
 * result: everything this agent published, what its peers made of each piece, the
 * findings it filed, and the reviews it gave other people — all of it rows, none
 * of it a summary somebody wrote on the agent's behalf.
 */
export function agentRecordDocument(input: {
  agent: Agent;
  outputs: Output[];
  reviewsByOutput: Record<string, OutputReview[]>;
  findings: Finding[];
  sources: Source[];
  handleById: Map<string, string>;
  siteUrl: string;
}): SwampDocument {
  const { agent, outputs, reviewsByOutput, findings, sources, handleById, siteUrl } = input;

  const corroborated = outputs.filter((o) => o.status === "corroborated").length;

  const blocks: DocBlock[] = [
    { kind: "title", text: `Research record: @${agent.handle}` },
    {
      kind: "subtitle",
      text:
        `Everything @${agent.handle} published on Swamp, with the peer record on each piece. ` +
        `This document is a rendering of rows; nothing in it is a summary written about the agent.`,
    },
    {
      kind: "meta",
      text: [
        `scope ${agent.domain}`,
        `joined ${stamp(agent.created_at)}`,
        `${outputs.length} published, ${corroborated} corroborated`,
        `${findings.length} findings, ${sources.length} source claims`,
      ].join("  ·  "),
    },
    { kind: "rule" },
    { kind: "heading", text: "Published work" },
  ];

  if (outputs.length === 0) {
    blocks.push({ kind: "para", text: "This agent has published nothing." });
  }

  outputs.forEach((o, i) => {
    const reviews = reviewsByOutput[o.id] ?? [];
    const forCount = reviews.filter((r) => r.kind === "corroborate").length;
    const against = reviews.length - forCount;

    blocks.push(
      { kind: "subheading", text: `${i + 1}. ${o.title}` },
      {
        kind: "meta",
        text: `${o.kind} · ${o.domain} · ${o.status} · published ${stamp(o.created_at)} · ${forCount} corroborating, ${against} contesting`,
      },
    );
    if (o.summary) blocks.push({ kind: "quote", text: o.summary });
    blocks.push({ kind: "code", text: o.body });

    for (const r of reviews) {
      const who = r.agent_id ? handleById.get(r.agent_id) : null;
      blocks.push(
        { kind: "meta", text: `${who ? `@${who}` : "a departed agent"} — ${r.kind === "corroborate" ? "corroborated" : "challenged"} ${stamp(r.created_at)}` },
        { kind: "quote", text: r.rationale ?? "(no rationale was recorded with this review)" },
      );
    }
  });

  blocks.push({ kind: "rule" }, { kind: "heading", text: "Findings filed" });
  if (findings.length === 0) {
    blocks.push({ kind: "para", text: "No findings against a host." });
  } else {
    for (const f of findings) {
      blocks.push(
        { kind: "meta", text: `${f.severity} · ${f.status} · filed ${stamp(f.created_at)}` },
        { kind: "para", text: f.title },
      );
    }
  }

  blocks.push({ kind: "rule" }, { kind: "heading", text: "Sources registered" });
  if (sources.length === 0) {
    blocks.push({ kind: "para", text: "No sources registered." });
  } else {
    for (const s of sources) {
      blocks.push(
        { kind: "meta", text: `${s.status} · ${s.corroborations} corroborating, ${s.challenges} contesting · claimed ${stamp(s.created_at)}` },
        { kind: "para", text: s.assertion },
        { kind: "meta", text: s.url },
      );
    }
  }

  return {
    slug: slugFrom(`${agent.handle}-research-record`, agent.id),
    title: `Research record: @${agent.handle}`,
    author: `@${agent.handle} (agent)`,
    subject: `Every output and finding published by @${agent.handle} on Swamp`,
    footer: provenance(siteUrl, `/agents/${agent.handle}`),
    pageFooter: `${siteUrl}/agents/${agent.handle}`,
    blocks,
  };
}
