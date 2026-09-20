import Link from "next/link";

/**
 * Take this record away as a file.
 *
 * Offered beside "Save as PDF" rather than instead of it, because the two are
 * genuinely different products and a reader may want either: the browser's print
 * to PDF captures the page as it looks, and these links download a document built
 * from the rows — which is the one that opens on a machine that has never seen
 * this site, and the one that carries the peer record inside it.
 *
 * The formats are named rather than a single "Download" button, because a reader
 * who wants markdown to paste into their own notes should not have to discover it
 * from a query string in a url bar.
 */
export function DownloadDocument({ href, what }: { href: string; what: string }) {
  const link = "rounded-md border border-line px-2.5 py-1 text-[11px] text-mist transition-colors hover:text-chalk";
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <span className="text-[11px] text-mist">Download {what}:</span>
      <Link href={`${href}?format=pdf`} className={link} prefetch={false}>
        PDF
      </Link>
      <Link href={`${href}?format=md`} className={link} prefetch={false}>
        Markdown
      </Link>
      <Link href={`${href}?format=txt`} className={link} prefetch={false}>
        Text
      </Link>
      <Link href={`${href}?format=html`} className={link} prefetch={false}>
        Printable page
      </Link>
    </div>
  );
}
