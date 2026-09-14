/**
 * Responsive audit. Loads every public page at real device widths and reports
 * anything that breaks the viewport: horizontal scroll, elements wider than the
 * screen, and text clipped by a fixed-height box.
 *
 * Measures the LIVE deployment by default so it audits what users actually get.
 *   NODE_PATH=... node scripts/responsive-audit.cjs [baseUrl]
 */
const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://web-opal-one-70.vercel.app";

// Real devices, smallest first. 320 is an iPhone SE / small Android; 360 is the
// most common Android width in the world; 390/393 are current iPhone/Pixel.
const VIEWPORTS = [
  { name: "320 (SE)", width: 320, height: 568 },
  { name: "360 (Android)", width: 360, height: 740 },
  { name: "390 (iPhone)", width: 390, height: 844 },
  { name: "768 (tablet)", width: 768, height: 1024 },
  { name: "1024 (laptop)", width: 1024, height: 768 },
  { name: "1440 (desktop)", width: 1440, height: 900 },
];

const PAGES = [
  "/",
  "/swamp",
  "/connect",
  "/how",
  "/feed",
  "/agents",
  "/findings",
  "/targets",
  "/hunters",
  "/programs",
  "/tools",
  "/login",
  "/signup",
];

(async () => {
  const browser = await chromium.launch();
  const problems = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.width < 768,
      hasTouch: vp.width < 768,
    });
    const page = await ctx.newPage();

    for (const path of PAGES) {
      try {
        await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
      } catch {
        try {
          await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45000 });
        } catch (e) {
          problems.push({ vp: vp.name, path, kind: "LOAD", detail: String(e).slice(0, 90) });
          continue;
        }
      }
      await page.waitForTimeout(450);

      const found = await page.evaluate((vw) => {
        const out = [];
        const doc = document.documentElement;

        // 1) Does the page scroll sideways at all?
        const overflow = doc.scrollWidth - vw;
        if (overflow > 1) out.push({ kind: "PAGE_SCROLL", detail: `scrollWidth ${doc.scrollWidth} > viewport ${vw} (+${overflow}px)` });

        // 2) Which elements actually stick out past the right edge? Skip anything
        //    inside a deliberate horizontal scroller (overflow-x:auto/scroll),         //    a wide code block or graph in its own scroller is intended.
        const inScroller = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const ov = getComputedStyle(p).overflowX;
            if (ov === "auto" || ov === "scroll") return true;
          }
          return false;
        };
        for (const el of document.querySelectorAll("body *")) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > vw + 1 || r.left < -1) {
            if (inScroller(el)) continue;
            const id = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
            out.push({
              kind: "OVERFLOW_EL",
              detail: `${id} leaves the viewport: left ${Math.round(r.left)} right ${Math.round(r.right)} (w ${Math.round(r.width)})`,
              text: (el.textContent || "").trim().slice(0, 45),
            });
          }
        }

        // 3) Text clipped by a fixed-height ancestor.
        for (const el of document.querySelectorAll("h1,h2,h3,p,li,dd,dt,span,a,button")) {
          if (el.children.length) continue;
          if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
            const cs = getComputedStyle(el);
            if (cs.overflowY === "auto" || cs.overflowY === "scroll") continue;
            if (cs.overflow === "hidden" || cs.overflowY === "hidden") {
              out.push({ kind: "CLIPPED_TEXT", detail: `${el.tagName.toLowerCase()} shows ${el.clientHeight}px of ${el.scrollHeight}px`, text: (el.textContent || "").trim().slice(0, 45) });
            }
          }
        }
        return out;
      }, vp.width);

      // De-duplicate: one row per (kind, detail) so a repeated card doesn't spam.
      const seen = new Set();
      for (const f of found) {
        const k = f.kind + "|" + f.detail;
        if (seen.has(k)) continue;
        seen.add(k);
        problems.push({ vp: vp.name, path, ...f });
      }
    }
    await ctx.close();
  }
  await browser.close();

  if (!problems.length) {
    console.log("CLEAN: no horizontal overflow or clipped text at any width.");
    return;
  }
  console.log(`${problems.length} problem(s):\n`);
  const byPage = {};
  for (const p of problems) (byPage[p.path] ??= []).push(p);
  for (const [path, list] of Object.entries(byPage)) {
    console.log(`\n=== ${path} ===`);
    for (const p of list) {
      console.log(`  [${p.vp}] ${p.kind}: ${p.detail}${p.text ? `  "${p.text}"` : ""}`);
    }
  }
})();
