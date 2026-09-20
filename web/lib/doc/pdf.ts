import "server-only";

/**
 * A PDF, written by hand.
 *
 * WHY NOT A LIBRARY. The alternative is a native binding, and this project has
 * already been burned twice by one that broke a build on a platform it did not
 * ship a binary for. A PDF is a text format with a table of byte offsets, and
 * everything a research document needs — pages, four standard fonts, wrapped
 * prose, a footer — fits in this file. So there is no dependency to keep in step
 * with a Node version, and a document can be produced on the same runtime that
 * serves the page it came from.
 *
 * WHAT IT DOES NOT DO, said first so a reader knows the fence: no embedded fonts,
 * so the four standard Type1 faces are all there is; no images, no tables, no
 * links. Text outside the WinAnsi set is SUBSTITUTED rather than dropped — curly
 * quotes, dashes and arrows have an ASCII shape in the table below, anything else
 * becomes `?` — and the substitution count is returned so a caller can say out
 * loud that it happened rather than shipping a file that quietly rewrote
 * somebody's words.
 *
 * THE WRAPPING DECISION, which looks like a shortcut and is not one. Breaks are
 * measured in Courier metrics (0.6 em per character) at the size the line is
 * actually drawn at, in all four faces. Courier is wider than Helvetica and than
 * Helvetica-Bold at the same size, so measuring in Courier is an upper bound: a
 * line that fits by this measure cannot overflow the page in the face that is
 * drawn. That costs a little raggedness and buys an exact, table-free guarantee in
 * place of an AFM width table that would be wrong the first time somebody edited
 * a number in it.
 */

/** A block of the document. The whole model, deliberately: everything else is text. */
export type DocBlock =
  | { kind: "title"; text: string }
  | { kind: "subtitle"; text: string }
  | { kind: "heading"; text: string }
  /** Small attributive text: who, when, an id, a status. */
  | { kind: "meta"; text: string }
  | { kind: "para"; text: string }
  /** Indented and oblique: a quotation, or somebody else's words. */
  | { kind: "quote"; text: string }
  /** Verbatim, in Courier, with its own line breaks respected. */
  | { kind: "code"; text: string }
  | { kind: "rule" };

export type PdfInput = {
  title: string;
  /** Written into the PDF's info dictionary, so the file carries whose it is. */
  author: string;
  subject: string;
  /** Drawn in the footer of every page: where this came from. */
  footer: string;
  blocks: DocBlock[];
};

export type PdfResult = {
  bytes: Buffer;
  pages: number;
  /**
   * How many characters could not be represented in WinAnsi and became `?`.
   *
   * Surfaced rather than swallowed: a title in Japanese turns into question marks
   * in this document, and a caller that does not say so is handing somebody a file
   * that has silently rewritten their work.
   */
  substituted: number;
};

/** A4, in points. */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
/** Room reserved at the foot of every page for the footer rule and its text. */
const FOOTER_H = 46;

type Face = "F1" | "F2" | "F3" | "F4";

type Style = {
  face: Face;
  size: number;
  leading: number;
  indent: number;
  before: number;
  after: number;
};

/**
 * One style per block kind. `leading` is the baseline-to-baseline distance and is
 * what pagination measures with, so those two cannot disagree: there is one number
 * here and one place that reads it.
 */
const STYLES: Record<DocBlock["kind"], Style> = {
  title: { face: "F2", size: 19, leading: 24, indent: 0, before: 0, after: 6 },
  subtitle: { face: "F1", size: 11.5, leading: 16, indent: 0, before: 0, after: 12 },
  heading: { face: "F2", size: 12.5, leading: 17, indent: 0, before: 16, after: 5 },
  meta: { face: "F3", size: 9, leading: 13, indent: 0, before: 0, after: 2.5 },
  para: { face: "F1", size: 10.5, leading: 15.5, indent: 0, before: 0, after: 8 },
  quote: { face: "F3", size: 10.5, leading: 15.5, indent: 18, before: 0, after: 8 },
  code: { face: "F4", size: 8.5, leading: 12, indent: 8, before: 2, after: 8 },
  rule: { face: "F1", size: 9, leading: 1, indent: 0, before: 8, after: 8 },
};

/** One drawn line, already wrapped and already measured. */
type Line = {
  face: Face;
  size: number;
  leading: number;
  x: number;
  text: string;
  /** Space above the FIRST line of a block, dropped at the top of a page. */
  before: number;
  /** Space below the LAST line of a block. */
  after: number;
  rule?: boolean;
};

/**
 * What WinAnsi cannot hold, offered its closest ASCII shape.
 *
 * The alternative is that an em dash, a curly quote or a non-breaking space
 * silently becomes `?` — which, in a document that quotes other agents verbatim,
 * would read as the platform mangling the text.
 */
const SUBSTITUTES: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": ",",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2013": "-",
  "\u2014": "--",
  "\u2015": "--",
  "\u2026": "...",
  "\u2022": "-",
  "\u00b7": "-",
  "\u2032": "'",
  "\u2033": '"',
  "\u00a0": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u2192": "->",
  "\u2190": "<-",
  "\u21d2": "=>",
  "\u2248": "~=",
  "\u2260": "!=",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u00d7": "x",
  "\u00f7": "/",
  "\u2212": "-",
  "\u00b1": "+/-",
  "\u0111": "d",
  "\u0131": "i",
  "\u017f": "s",
  "\u20ac": "EUR",
  "\u2122": "(TM)",
  "\u00ae": "(R)",
  "\u00a9": "(c)",
  "\u2713": "v",
  "\u2717": "x",
  "\u25cf": "*",
  "\u25aa": "*",
  "\u2500": "-",
  "\u2550": "=",
};

/**
 * One line of text as bytes the WinAnsi fonts can actually draw.
 *
 * Pure ASCII and Latin-1 pass through — Latin-1 and WinAnsi agree on 0xA0..0xFF,
 * and the ambiguous 0x80..0x9F range is never produced, because everything that
 * would land there is in the table above. Everything else is the table, and
 * everything left over becomes `?` and is counted.
 */
function winAnsi(text: string): { text: string; substituted: number } {
  let out = "";
  let substituted = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += " ";
      continue;
    }
    // The table is consulted BEFORE the Latin-1 pass, deliberately, so that every
    // rule in it is reachable. `×`, `÷`, `±` and the non-breaking space are all
    // representable in WinAnsi, and they are still mapped here: an ASCII `x` and a
    // real space are what a reader of a plain text extraction can actually use,
    // where a stray 0xD7 in a pasted paragraph is noise. Consulting Latin-1 first
    // would leave four dead entries in that table, and a dead rule is one nobody
    // notices is wrong.
    const sub = SUBSTITUTES[ch];
    if (sub !== undefined) {
      out += sub;
      continue;
    }
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += ch;
      continue;
    }
    out += "?";
    substituted += 1;
  }
  return { text: out, substituted };
}

/** Escape what a PDF literal string cannot contain. Backslashes first, or the
 * escapes added here would themselves be escaped. */
function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** How many characters of this size fit in this width, in Courier metrics. */
function charsFor(width: number, size: number): number {
  return Math.max(8, Math.floor(width / (size * 0.6)));
}

/**
 * Break one paragraph into lines that fit.
 *
 * Greedy on words, and a word longer than a whole line — a url, a sha256, a DOI —
 * is cut rather than allowed to run off the page. Cutting a hash mid-way is ugly,
 * and it is the only option that keeps the page honest about its width.
 */
function wrap(text: string, width: number, size: number): string[] {
  const per = charsFor(width, size);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= per) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > per) {
      lines.push(line.slice(0, per));
      line = line.slice(per);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Blocks into drawn lines, before pagination. */
function layout(blocks: DocBlock[], counter: { substituted: number }): Line[] {
  const lines: Line[] = [];

  for (const block of blocks) {
    const style = STYLES[block.kind];
    const width = CONTENT_W - style.indent;
    const x = MARGIN + style.indent;

    if (block.kind === "rule") {
      lines.push({ face: style.face, size: style.size, leading: style.leading, x, text: "", before: style.before, after: style.after, rule: true });
      continue;
    }

    // Verbatim text keeps its own newlines, then each one wraps in Courier — for
    // which the Courier measurement is exact rather than conservative.
    const pieces =
      block.kind === "code"
        ? block.text
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .flatMap((l) => (l.trim() === "" ? [""] : wrap(l, width, style.size)))
        : wrap(block.text, width, style.size);

    pieces.forEach((text, i) => {
      // ENCODED HERE, not at draw time, and this is load-bearing. The drawn text
      // has to be the WinAnsi conversion rather than the original, because the
      // page is assembled as Latin-1 bytes: an em dash that reached the drawing
      // step un-converted would be truncated to its low byte and come out as a
      // control character in the middle of somebody's sentence. Counting here and
      // drawing later was the bug this comment exists to stop coming back.
      const encoded = winAnsi(text);
      counter.substituted += encoded.substituted;
      lines.push({
        face: style.face,
        size: style.size,
        leading: style.leading,
        x,
        text: encoded.text,
        before: i === 0 ? style.before : 0,
        after: i === pieces.length - 1 ? style.after : 0,
      });
    });
  }

  return lines;
}

/** Lines into pages, by height. A block's space-before is dropped at a page top. */
function paginate(lines: Line[]): Line[][] {
  const usable = PAGE_H - MARGIN - MARGIN - FOOTER_H;
  const pages: Line[][] = [];
  let page: Line[] = [];
  let used = 0;

  for (const line of lines) {
    const height = (page.length === 0 ? 0 : line.before) + line.leading;
    if (page.length > 0 && used + height > usable) {
      pages.push(page);
      page = [line];
      used = line.leading;
      continue;
    }
    page.push(line);
    used += height;
  }

  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

/** The content stream for one page: every line placed by its own text matrix. */
function contentFor(page: Line[], pageIndex: number, pageCount: number, footer: string): Buffer {
  const parts: string[] = [];
  let y = PAGE_H - MARGIN;

  for (const line of page) {
    y -= line.before + line.leading;
    if (line.rule) {
      parts.push(`0.7 w 0.6 G ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`);
      continue;
    }
    if (line.text === "") continue;
    parts.push(
      `BT /${line.face} ${line.size} Tf 0 g 1 0 0 1 ${line.x} ${y.toFixed(2)} Tm (${escape(line.text)}) Tj ET`,
    );
  }

  // The footer, on every page: where this came from, and which page of how many.
  const ruleY = MARGIN + FOOTER_H - 18;
  parts.push(`0.5 w 0.7 G ${MARGIN} ${ruleY.toFixed(2)} m ${PAGE_W - MARGIN} ${ruleY.toFixed(2)} l S`);

  // THE FOOTER IS CUT TO FIT, and this is not cosmetic. The page number is drawn
  // right-aligned over the same baseline, so a footer one character too long does
  // not overflow the margin — it runs UNDER the stamp and the two become an
  // unreadable smear that only appears once somebody opens the file. Cutting with
  // an ellipsis keeps both legible at any footer length, whatever a caller writes.
  const FOOTER_SIZE = 8;
  const stamp = `${pageIndex + 1} / ${pageCount}`;
  const room = Math.floor((CONTENT_W - (stamp.length + 3) * FOOTER_SIZE * 0.6) / (FOOTER_SIZE * 0.6));
  const line = footer.length > room ? `${footer.slice(0, Math.max(0, room - 3))}...` : footer;

  parts.push(
    `BT /F3 ${FOOTER_SIZE} Tf 0.25 g 1 0 0 1 ${MARGIN} ${(ruleY - 13).toFixed(2)} Tm (${escape(line)}) Tj ET`,
  );
  parts.push(
    `BT /F3 ${FOOTER_SIZE} Tf 0.25 g 1 0 0 1 ${PAGE_W - MARGIN - stamp.length * 4.8} ${(ruleY - 13).toFixed(2)} Tm (${escape(stamp)}) Tj ET`,
  );

  return Buffer.from(parts.join("\n") + "\n", "latin1");
}

/**
 * Render the document.
 *
 * The byte offsets in the cross-reference table are the one thing a PDF viewer
 * will not forgive, so the file is assembled in two steps: every object is
 * serialised in order while its offset is recorded, and only then is the table
 * written. `verify-documents` re-parses the output and checks each offset points
 * at the object header it claims, because a PDF with a wrong xref opens in some
 * readers and not others and looks, from here, like nothing at all.
 */
export function renderPdf(input: PdfInput): PdfResult {
  const counter = { substituted: 0 };
  const lines = layout(input.blocks, counter);
  const pages = paginate(lines);

  // The title, the footer and the info dictionary are text too, and they are
  // assembled from the same Latin-1 bytes as the page, so they take the same
  // conversion. The footer is counted ONCE though it is drawn on every page: it is
  // one piece of source text, and a count that grew with the page count would
  // report a longer document as a more mangled one.
  const title = winAnsi(input.title);
  const author = winAnsi(input.author);
  const subject = winAnsi(input.subject);
  const footer = winAnsi(input.footer);
  counter.substituted += title.substituted + author.substituted + subject.substituted + footer.substituted;

  // Object numbering: 1 catalog, 2 pages, 3..6 fonts, 7 info, then two per page.
  const FIRST_PAGE_OBJ = 8;
  const pageId = (i: number) => FIRST_PAGE_OBJ + i * 2;
  const contentId = (i: number) => FIRST_PAGE_OBJ + i * 2 + 1;

  const chunks: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (buf: Buffer) => {
    chunks.push(buf);
    offset += buf.length;
  };
  const addObject = (id: number, body: string) => {
    offsets[id] = offset;
    push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, "latin1"));
  };

  push(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"));

  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(" ");
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  addObject(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  addObject(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  addObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");
  addObject(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

  const created = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "");
  addObject(
    7,
    `<< /Title (${escape(title.text)}) /Author (${escape(author.text)}) /Subject (${escape(subject.text)}) ` +
      `/Creator (Swamp) /Producer (Swamp documents) /CreationDate (D:${created}) >>`,
  );

  pages.forEach((page, i) => {
    const stream = contentFor(page, i, pages.length, footer.text);
    addObject(
      pageId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> ` +
        `/Contents ${contentId(i)} 0 R >>`,
    );
    const header = `${contentId(i)} 0 obj\n<< /Length ${stream.length} >>\nstream\n`;
    offsets[contentId(i)] = offset;
    push(Buffer.from(header, "latin1"));
    push(stream);
    push(Buffer.from("endstream\nendobj\n", "latin1"));
  });

  const total = FIRST_PAGE_OBJ + pages.length * 2;
  const xrefStart = offset;
  const xref: string[] = [`xref\n0 ${total}\n`, "0000000000 65535 f \n"];
  for (let id = 1; id < total; id += 1) {
    xref.push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(Buffer.from(xref.join(""), "latin1"));
  push(
    Buffer.from(
      `trailer\n<< /Size ${total} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "latin1",
    ),
  );

  return { bytes: Buffer.concat(chunks), pages: pages.length, substituted: counter.substituted };
}
