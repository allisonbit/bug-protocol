import "server-only";
import type { SwampDocument } from "./document";
import { documentFilename, renderHtml, renderMarkdown, renderText } from "./document";
import { renderPdf } from "./pdf";

/**
 * A document as a download, in whichever of the four shapes was asked for.
 *
 * The formats are a closed set and an unknown one is refused BY NAME rather than
 * quietly answered with the default, because a caller that asked for a `.docx`
 * and got a PDF named `.pdf` would have learned nothing about why.
 *
 * Every response is `attachment`, so a browser saves the file rather than
 * rendering it — which matters for the HTML form in particular: the point of that
 * one is to open it later, on a machine that may be offline, and print it.
 */
export const DOCUMENT_FORMATS = ["pdf", "html", "md", "txt"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export function isDocumentFormat(value: string | null): value is DocumentFormat {
  return value !== null && (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

const CONTENT_TYPES: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const EXTENSIONS: Record<DocumentFormat, string> = { pdf: "pdf", html: "html", md: "md", txt: "txt" };

export function documentResponse(doc: SwampDocument, format: DocumentFormat): Response {
  const headers = new Headers({
    // Nothing here is cacheable: a corroboration that arrives a minute after a
    // download should not leave a stale copy being served from an edge.
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${documentFilename(doc.slug, EXTENSIONS[format])}"`,
    "content-type": CONTENT_TYPES[format],
  });

  if (format === "pdf") {
    const pdf = renderPdf({
      title: doc.title,
      author: doc.author,
      subject: doc.subject,
      // The short line the pages carry, with the full provenance sentence printed
      // once at the end where there is room for it. The other three formats get the
      // sentence only, since a downloaded file has no page footers to fill.
      footer: doc.pageFooter,
      blocks: [...doc.blocks, { kind: "meta", text: doc.footer }],
    });
    // Stated in the headers rather than left silent: this writer has no embedded
    // fonts, so anything outside the WinAnsi set was replaced, and a caller that
    // wants to know whether the file is a faithful copy can read it here.
    headers.set("x-swamp-pdf-pages", String(pdf.pages));
    headers.set("x-swamp-pdf-characters-replaced", String(pdf.substituted));
    return new Response(new Uint8Array(pdf.bytes), { status: 200, headers });
  }

  const body = format === "md" ? renderMarkdown(doc) : format === "txt" ? renderText(doc) : renderHtml(doc);
  return new Response(body, { status: 200, headers });
}
