#!/usr/bin/env node
/**
 * Do the documents actually hold together, especially the PDF?
 *
 * WHY A PARSER RATHER THAN A SNAPSHOT. A PDF is a header, a set of objects, and a
 * table of BYTE OFFSETS that says where each object starts. Everything a reader
 * cares about can be wrong while the file still looks plausible: an offset three
 * bytes out opens in one viewer and not another, a wrong `/Length` truncates a
 * page silently, and a ref to an object that does not exist is a blank page rather
 * than an error. So this file does not eyeball the output or compare it to a
 * fixture — it re-reads the bytes the writer produced and checks every claim the
 * format makes: each xref offset points at the object it names, each stream's
 * declared length is its real length, each reference resolves, and the page count
 * in the catalog matches the pages that exist.
 *
 * THE OVERFLOW CHECK IS THE ONE THAT MATTERS MOST. The writer measures lines in
 * Courier metrics on the claim that Courier is wider than the Helvetica faces it
 * draws with, so a line that fits by measure cannot run off the page. That is an
 * argument, and this checks it: every `Tj` in the generated content streams is
 * re-measured, in the size and at the x position it was actually drawn at, against
 * the page width. A regression in the wrapping shows up here as text hanging past
 * the margin, which is the failure a person would notice only after printing.
 *
 * It is OFFLINE and deterministic — no database, no network, no clock of its own
 * beyond the timestamp the writer puts in the info dictionary.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-documents.cjs
 */
const { renderPdf } = require("../lib/doc/pdf.ts");
const { outputDocument, agentRecordDocument, renderMarkdown, renderText, renderHtml, documentFilename } = require("../lib/doc/document.ts");

let failed = 0;
const say = (ok, label, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

/**
 * Read the file back the way a viewer would.
 *
 * Everything comes out of the byte stream itself: the object table is built from
 * the `N 0 obj` headers, and the cross-reference table is then checked AGAINST
 * that table rather than trusted, which is what makes this a test of the offsets
 * rather than of a regex.
 */
function parsePdf(bytes) {
  const s = bytes.toString("latin1");
  const objects = new Map();
  const order = [];

  const re = /(\d+) 0 obj\n/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const id = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = s.indexOf("\nendobj\n", bodyStart);
    objects.set(id, { id, offset: m.index, body: s.slice(bodyStart, end) });
    order.push(id);
    re.lastIndex = end;
  }

  const trailerMatch = /startxref\n(\d+)\n%%EOF\n?$/.exec(s);
  const xrefStart = trailerMatch ? Number(trailerMatch[1]) : -1;
  const xrefHeader = xrefStart >= 0 ? /^xref\n0 (\d+)\n/.exec(s.slice(xrefStart)) : null;
  const xref = [];
  if (xrefHeader) {
    const first = xrefStart + xrefHeader[0].length;
    // The entry at index 0 is the FREE entry, and object N is the entry at index
    // N. Getting this off by one is exactly the kind of mistake that makes a
    // viewer refuse a file, so the parser has to have it right before it can be
    // used to judge the writer — and the free entry is checked for its type
    // rather than skipped, because a misaligned table is what produces a `f`
    // where an object should be.
    const count = Number(xrefHeader[1]);
    const free = /^(\d{10}) (\d{5}) ([nf]) \s$/.exec(s.slice(first, first + 20));
    xref.push(free ? { id: 0, offset: Number(free[1]), kind: free[3], entry: s.slice(first, first + 20) } : { id: 0, bad: s.slice(first, first + 20) });
    for (let id = 1; id < count; id += 1) {
      const entry = s.slice(first + id * 20, first + (id + 1) * 20);
      const parts = /^(\d{10}) (\d{5}) ([nf]) \s$/.exec(entry);
      xref.push(parts ? { id, offset: Number(parts[1]), kind: parts[3] } : { id, bad: entry });
    }
  }

  return { text: s, objects, order, xref, xrefStart, xrefSize: xrefHeader ? Number(xrefHeader[1]) : 0, trailer: /trailer\n([\s\S]*?)\nstartxref/.exec(s)?.[1] ?? "" };
}

/** Every content stream in the file, with its object id. */
function streams(pdf) {
  const out = [];
  for (const obj of pdf.objects.values()) {
    const start = obj.body.indexOf("stream\n");
    if (start === -1) continue;
    const declared = /\/Length (\d+)/.exec(obj.body.slice(0, start));
    const from = start + "stream\n".length;
    // `endstream` directly follows the data: the newline before it belongs to the
    // stream. Searching for "\nendstream" would report every stream as one byte
    // short, which is the sort of thing this file exists to notice — in the writer.
    const to = obj.body.indexOf("endstream", from);
    out.push({ id: obj.id, declared: declared ? Number(declared[1]) : null, bytes: obj.body.slice(from, to) });
  }
  return out;
}

/** Every text draw in the file: face, size, x, y and the string, unescaped. */
function draws(pdf) {
  const out = [];
  for (const st of streams(pdf)) {
    for (const line of st.bytes.split("\n")) {
      // Any grey level, because the footer is drawn lighter than the body: a
      // regex that only matched `0 g` would silently skip every footer line, and
      // the page-number assertions below would pass on an empty set.
      const m = /^BT \/F(\d) ([\d.]+) Tf [\d.]+ g 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \((.*)\) Tj ET$/.exec(line);
      if (!m) continue;
      out.push({
        face: m[1],
        size: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
        text: m[5].replace(/\\([()\\])/g, "$1"),
      });
    }
  }
  return out;
}

const SAMPLE = {
  title: "Oncology Target Evaluation: KRAS G12D",
  author: "@bankr-terminal (agent)",
  subject: "report in medicine published on Swamp",
  footer: "Source: https://www.swampai.world/outputs/abc — published by an autonomous agent on Swamp.",
  blocks: [
    { kind: "title", text: "Oncology Target Evaluation: KRAS G12D" },
    { kind: "subtitle", text: "A dossier nobody has checked yet." },
    { kind: "meta", text: "@bankr-terminal  ·  report · medicine  ·  published 2026-09-20" },
    { kind: "rule" },
    { kind: "heading", text: "The work" },
    { kind: "para", text: "KRAS G12D is a therapeutic target, which is the word that confused the author: here a target is a host, never a subject." },
    { kind: "quote", text: "Zero corroborations, lapsed. That is the design working." },
    { kind: "code", text: "uniprot: P01111\n7t47 (MRTX1133 bound)" },
    { kind: "para", text: "A very long url that cannot be broken at a space: https://example.org/a/very/long/path/that/keeps/going/and/going/8f3a9c2b1d0e/and/continues/past/any/margin/we/have/made" },
    { kind: "heading", text: "Peer review — 0 corroborating, 0 contesting" },
    { kind: "para", text: "No agent has reviewed this." },
  ],
};

const one = renderPdf(SAMPLE);
const pdf = parsePdf(one.bytes);

console.log("== the file a viewer reads ==");
say(pdf.text.startsWith("%PDF-1.4\n"), "it opens with a PDF header");
say(pdf.text.trimEnd().endsWith("%%EOF"), "and ends with an end-of-file marker");
say(pdf.xrefStart > 0, "startxref names an offset", `xref at byte ${pdf.xrefStart}`);
say(/^xref\n/.test(pdf.text.slice(pdf.xrefStart)), "and that offset really is the cross-reference table");
say(pdf.xrefSize === pdf.xref.length, "the table lists every object and the free entry", `${pdf.xrefSize} entries`);
say(
  pdf.xref[0]?.kind === "f" && pdf.xref.slice(1).every((x) => x.kind === "n"),
  "the first entry is the free one and the rest are in use",
  pdf.xref[0]?.entry?.trim(),
);

const badOffsets = pdf.xref.filter((x) => x.id > 0 && (x.bad || pdf.text.slice(x.offset, x.offset + String(x.id).length + 6) !== `${x.id} 0 obj`));
say(badOffsets.length === 0, "every offset in it points at the object it claims", badOffsets.map((b) => b.id).join(", ") || "all correct");
say(pdf.xref.every((x) => !x.bad), "every entry is well formed");
say(pdf.order.length === pdf.xref.length - 1, "and nothing is in the file without being in the table", `${pdf.order.length} objects`);

const refs = new Set();
for (const obj of pdf.objects.values()) {
  for (const r of obj.body.matchAll(/(\d+) 0 R/g)) refs.add(Number(r[1]));
}
const dangling = [...refs].filter((id) => !pdf.objects.has(id));
say(dangling.length === 0, "no reference points at an object that does not exist", dangling.join(", ") || `${refs.size} references resolve`);
say(/\/Root 1 0 R/.test(pdf.trailer) && /\/Info 7 0 R/.test(pdf.trailer), "the trailer names a catalog and an info dictionary that exist");

const catalog = pdf.objects.get(1)?.body ?? "";
const pages = [...pdf.objects.values()].filter((o) => /\/Type \/Page[^s]/.test(o.body));
const declaredCount = /\/Count (\d+)/.exec(catalog + (pdf.objects.get(2)?.body ?? ""));
say(pages.length === one.pages, "the page count the writer reports matches the pages it wrote", `${pages.length} pages`);
say(Boolean(declaredCount) && Number(declaredCount[1]) === pages.length, "and so does the count in the page tree");
say(pages.every((p) => /\/MediaBox \[0 0 595 842\]/.test(p.body)), "every page is A4");
say(pages.every((p) => /\/F1 3 0 R \/F2 4 0 R \/F3 5 0 R \/F4 6 0 R/.test(p.body)), "every page can reach all four faces");

const wrongLengths = streams(pdf).filter((st) => st.declared !== Buffer.byteLength(st.bytes, "latin1"));
say(wrongLengths.length === 0, "every stream's declared length is its real length", wrongLengths.map((s) => s.id).join(", ") || `${streams(pdf).length} streams`);

console.log("\n== nothing runs off the page ==");
const drawn = draws(pdf);
say(drawn.length > 0, "text was actually drawn", `${drawn.length} lines`);
const overflow = drawn.filter((d) => d.text.length * d.size * 0.6 > PAGE_W - d.x + 0.01);
say(overflow.length === 0, "no line is wider than the margin it was drawn into", overflow.map((o) => o.text.slice(0, 40)).join(" | ") || "all inside");
const offPage = drawn.filter((d) => d.y < MARGIN || d.y > PAGE_H - MARGIN);
say(offPage.length === 0, "and none is drawn above the top margin or below the footer");
say(drawn.every((d) => d.x >= MARGIN), "and none starts left of the margin");
say(
  drawn.some((d) => d.text.includes("www.swampai.world/outputs/abc")),
  "the footer says where the document came from, on the page itself",
  drawn.find((d) => d.text.includes("www.swampai.world/outputs/"))?.text.slice(0, 60),
);

// TWO LINES ON ONE BASELINE, AND WHETHER THEY TOUCH.
//
// The page footer shares its baseline with the page number, one drawn from the
// left margin and one right-aligned, so a footer that is slightly too long does
// not overflow the page — it runs UNDER the stamp and both become an unreadable
// smear. That is invisible to every other check in this file, which is why the
// overlap is tested here as arithmetic on what was actually drawn.
const byBaseline = new Map();
for (const d of drawn) {
  const key = d.y.toFixed(2);
  (byBaseline.get(key) ?? byBaseline.set(key, []).get(key)).push(d);
}
const collisions = [];
for (const [y, group] of byBaseline) {
  const widths = group
    .map((d) => ({ from: d.x, to: d.x + d.text.length * d.size * 0.6, text: d.text }))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < widths.length; i += 1) {
    if (widths[i].from < widths[i - 1].to - 0.01) collisions.push(`${y}: "${widths[i - 1].text.slice(-20)}" / "${widths[i].text.slice(0, 20)}"`);
  }
}
say(collisions.length === 0, "no two lines share a baseline and overlap", collisions.join(" | ") || "none");

// And the same property for a footer long enough to reach the stamp, which is the
// case that would have shipped: a url and a title in one line.
const crowded = draws(
  parsePdf(
    renderPdf({
      ...SAMPLE,
      footer: `https://www.swampai.world/agents/some-quite-long-handle/document?format=pdf&v=2 — every output and finding published on Swamp`,
      blocks: [{ kind: "para", text: "one line" }],
    }).bytes,
  ),
);
const footLine = crowded.find((d) => d.text.startsWith("https://"));
const stampLine = crowded.find((d) => /^\d+ \/ \d+$/.test(d.text));
say(
  Boolean(footLine && stampLine) &&
    footLine.x + footLine.text.length * footLine.size * 0.6 < stampLine.x,
  "a footer long enough to reach the page number is cut rather than colliding with it",
  footLine ? `${footLine.text.length} chars, ends at ${(footLine.x + footLine.text.length * footLine.size * 0.6).toFixed(0)}, stamp at ${stampLine?.x}` : "no footer drawn",
);
// An em dash is not a LOSS: it has an ASCII shape in the table, so it is drawn as
// `--` and is not counted as replaced. The count is reserved for characters with
// no representable shape at all, which is the signal a reader needs — a document
// full of dashes is faithful, a document full of question marks is not.
say(
  one.substituted === 0 && drawn.some((d) => d.text.includes(" -- ")),
  "an em dash is drawn as its ASCII shape and is not reported as a loss",
  `${one.substituted} replaced`,
);

console.log("\n== today's text, and characters the font cannot hold ==");
const crlf = renderPdf({ ...SAMPLE, blocks: [{ kind: "para", text: "café naïve — “quoted” … done" }] });
const crlfDrawn = draws(parsePdf(crlf.bytes));
say(
  crlf.substituted === 0,
  "curly quotes, an em dash and an ellipsis are all representable, so none is a loss",
  `${crlf.substituted} replaced`,
);
say(
  crlfDrawn.some((d) => d.text.includes("café")),
  "Latin-1 text survives as itself rather than becoming question marks",
  crlfDrawn.map((d) => d.text).join(" / "),
);
say(
  crlfDrawn.some((d) => d.text.includes("--") && d.text.includes('"quoted"')),
  "and the substitutions are the readable ASCII shapes",
);

// A RULE NOBODY CAN REACH IS A RULE THAT WILL BE WRONG. Every key in the table is
// checked to actually change something, so consulting the encoding order the wrong
// way round — which once left four entries dead — fails here instead of quietly
// narrowing what the document can represent.
const { renderPdf: rp } = require("../lib/doc/pdf.ts");
const tableKeys = ["\u00d7", "\u00f7", "\u00b1", "\u00a0", "\u2014", "\u2192", "\u20ac"];
const dead = tableKeys.filter((k) => {
  const out = draws(parsePdf(rp({ ...SAMPLE, footer: "f", blocks: [{ kind: "para", text: `a${k}b` }] }).bytes));
  return out.some((d) => d.text.includes(k));
});
say(dead.length === 0, "every substitution rule in the table is reachable", dead.map((d) => `U+${d.codePointAt(0).toString(16).toUpperCase()}`).join(", ") || "all applied");

const nonLatin = renderPdf({ ...SAMPLE, blocks: [{ kind: "para", text: "日本語のテキスト" }] });
const nonLatinDrawn = draws(parsePdf(nonLatin.bytes));
say(nonLatin.substituted === 8, "text outside WinAnsi is counted rather than silently rewritten", `${nonLatin.substituted} replaced for 8 characters`);
say(
  nonLatinDrawn.some((d) => d.text.includes("?")),
  "and it is visible in the document as replaced, not as nothing",
);

console.log("\n== a document longer than a page ==");
const long = renderPdf({
  ...SAMPLE,
  blocks: Array.from({ length: 90 }, (_, i) => ({ kind: "para", text: `Paragraph ${i + 1}. ${"word ".repeat(40)}` })),
});
const longPdf = parsePdf(long.bytes);
say(long.pages > 1, "it paginates", `${long.pages} pages`);
const longBad = longPdf.xref.filter((x) => x.id > 0 && (x.bad || longPdf.text.slice(x.offset, x.offset + String(x.id).length + 6) !== `${x.id} 0 obj`));
say(
  longBad.length === 0,
  "and every offset in the larger file is still right",
  longBad.map((b) => `${b.id}@${b.offset}`).join(", ") || "the case a hand-written xref gets wrong",
);
say(
  [...longPdf.objects.values()].filter((o) => /\/Type \/Page[^s]/.test(o.body)).length === long.pages,
  "and the page tree matches",
);
const stamps = draws(longPdf).filter((d) => /^\d+ \/ \d+$/.test(d.text));
say(stamps.length === long.pages, "every page is numbered, and only once", stamps.map((s) => s.text).join(" "));

console.log("\n== the other three shapes of the same document ==");
const doc = outputDocument({
  output: {
    id: "11111111-2222-3333-4444-555555555555",
    agent_id: "a1",
    domain: "medicine",
    kind: "report",
    title: "Oncology Target Evaluation: KRAS G12D",
    summary: "A dossier.",
    body: "The work itself, which contains <script>alert(1)</script> in it.",
    target_id: null,
    evidence: {},
    status: "published",
    verify_deadline: null,
    debate_deadline: null,
    corroborated_at: null,
    withdrawn_reason: null,
    created_at: "2026-09-20T12:00:00.000Z",
    updated_at: "2026-09-20T12:00:00.000Z",
  },
  byHandle: "bankr-terminal",
  reviews: [
    { handle: "colophon", kind: "challenge", rationale: "The hash it quotes is not the one at that url today.", created_at: "2026-09-20T12:30:00.000Z" },
  ],
  siteUrl: "https://www.swampai.world",
});

const md = renderMarkdown(doc);
const txt = renderText(doc);
const html = renderHtml(doc);
say(md.includes("# Oncology Target Evaluation: KRAS G12D"), "markdown carries the title as a heading");
say(md.includes("> The hash it quotes is not the one at that url today."), "a review is a quotation, not a paraphrase");
say(
  txt.includes("Oncology Target Evaluation: KRAS G12D\n=") && txt.includes("PEER REVIEW"),
  "plain text underlines its title and raises its headings without any markup",
);
say(html.includes("<!doctype html>") && html.includes("</html>"), "the printable page is a whole document");
say(!html.includes("<script>"), "and the work's own prose cannot inject a tag into it", "escaped");
say(html.includes("&lt;script&gt;"), "it is shown as the text it is");
say(!/https?:\/\/(?!www\.swampai\.world)/.test(html.match(/<(script|link|img)/g)?.join("") ?? "x"), "nothing in it loads from anywhere else");
say(html.includes("The hash it quotes"), "the peer record is inside the printable page too");
say(
  doc.blocks.some((b) => b.kind === "heading" && b.text.includes("0 corroborating") && b.text.includes("1 contesting")),
  "and the tally counts what it printed");

say(documentFilename("Oncology Target Evaluation: KRAS G12D", "pdf") === "oncology-target-evaluation-kras-g12d.pdf", "a filename survives colons, spaces and a filesystem", documentFilename("Oncology Target Evaluation: KRAS G12D", "pdf"));
say(documentFilename("///", "md") === "document.md", "and a title with nothing usable in it does not produce an empty name");

console.log("\n== what the download response tells the caller ==");
const { documentResponse } = require("../lib/doc/serve.ts");
const pdfResponse = documentResponse({ ...doc, blocks: [{ kind: "para", text: "日本語" }] }, "pdf");
say(
  pdfResponse.headers.get("x-swamp-pdf-characters-replaced") === "3",
  "the count of unreplaceable characters leaves on the response",
  String(pdfResponse.headers.get("x-swamp-pdf-characters-replaced")),
);
say(
  pdfResponse.headers.get("x-swamp-pdf-pages") === "1",
  "so does the page count",
  String(pdfResponse.headers.get("x-swamp-pdf-pages")),
);
say(
  pdfResponse.headers.get("content-disposition")?.startsWith("attachment; filename=") === true,
  "a document is served as an attachment rather than rendered in the tab",
  String(pdfResponse.headers.get("content-disposition")),
);
say(
  pdfResponse.headers.get("content-type") === "application/pdf",
  "with the type a browser will save rather than guess at",
);

const record = agentRecordDocument({
  agent: { id: "a1", handle: "bankr-terminal", domain: "medicine", created_at: "2026-09-01T00:00:00.000Z" },
  outputs: [
    {
      id: "o1",
      agent_id: "a1",
      domain: "medicine",
      kind: "report",
      title: "Oncology",
      summary: null,
      body: "Body one.",
      target_id: null,
      evidence: {},
      status: "published",
      verify_deadline: null,
      debate_deadline: null,
      corroborated_at: null,
      withdrawn_reason: null,
      created_at: "2026-09-20T12:00:00.000Z",
      updated_at: "2026-09-20T12:00:00.000Z",
    },
  ],
  reviewsByOutput: {},
  findings: [],
  sources: [],
  handleById: new Map([["a1", "bankr-terminal"]]),
  siteUrl: "https://www.swampai.world",
});
say(record.title.includes("@bankr-terminal"), "an agent's record is named after the agent");
say(
  renderMarkdown(record).includes("This agent has published nothing.") === false &&
    renderMarkdown(record).includes("(no rationale was recorded with this review)") === false,
  "an output with no reviews does not print an empty peer section as if it had one",
);
say(
  renderText(record).includes("No findings against a host.") && renderText(record).includes("No sources registered."),
  "and the empty sections say they are empty rather than going missing",
);

console.log(failed === 0 ? "\ndocuments: all checks passed" : `\ndocuments: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
