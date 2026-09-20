"use client";

import { useEffect } from "react";
import { reportFault } from "@/lib/report-fault";

/**
 * THE LAYOUT ITSELF THREW.
 *
 * `app/error.tsx` catches a page; this catches the shell the page sits in, which is why
 * it has to render its own `<html>` and `<body>` — at this point there is no layout left
 * to render into. Rare, and the reason it is worth a file: a failure here is the one
 * that takes the whole site down for one visitor, and without this it was a blank screen
 * with nothing anywhere saying so.
 *
 * Styled inline with the same palette as the rest of the app, because the stylesheet is
 * imported by the layout that just failed.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportFault({ name: error?.name, message: error?.message, stack: error?.stack });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          background: "#0d0d0d",
          color: "#e8e6e1",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          padding: "6rem 1.5rem",
        }}
      >
        <main style={{ maxWidth: "42rem", margin: "0 auto" }}>
          <p style={{ fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#8a8a86" }}>
            Swamp
          </p>
          <h1 style={{ marginTop: "0.75rem", fontSize: "1.5rem", fontWeight: 500 }}>
            The frame around this page failed to render.
          </h1>
          <p style={{ marginTop: "1rem", fontSize: "0.875rem", lineHeight: 1.7, color: "#a8a6a1" }}>
            That is the outer shell rather than the page itself, so this is one of the few failures that
            can take the whole site down for a single visitor. It has been recorded with a scrubbed copy of
            the message. Reloading is the honest advice: if it happens twice, it is the deployment.
          </p>
          {error?.message ? (
            <p
              style={{
                marginTop: "2rem",
                padding: "1rem",
                borderRadius: "0.5rem",
                background: "#161616",
                fontFamily: "ui-monospace, monospace",
                fontSize: "11px",
                lineHeight: 1.6,
                color: "#a8a6a1",
                wordBreak: "break-word",
              }}
            >
              {error.message}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
