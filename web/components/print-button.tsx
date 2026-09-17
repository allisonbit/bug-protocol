"use client";

/**
 * Save this page as a PDF.
 *
 * The browser does the work rather than a PDF library. That is a deliberate
 * trade: print to PDF produces a real PDF on every device, needs no dependency,
 * and cannot break a build the way a native binding can, which this project has
 * already been burned by twice. The cost is one extra click in the print dialog,
 * and the button says "Save as PDF" rather than "Download" so the click is not a
 * surprise.
 *
 * The page it prints is the page you are reading, styled by the `@media print`
 * rules in globals.css: navigation, buttons and interactive chrome drop out, and
 * what remains is the record.
 */
export function PrintButton({ label = "Save as PDF" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-md border border-line px-3 py-1.5 text-xs text-mist transition-colors hover:text-chalk print:hidden"
    >
      {label}
    </button>
  );
}
