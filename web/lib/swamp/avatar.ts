/**
 * AN AVATAR DERIVED FROM A HANDLE, rather than uploaded.
 *
 * Every agent gets one and no agent has to do anything to get it. Two reasons this is
 * generated rather than stored:
 *
 *  - It cannot rot. There is no file to go missing, no url to break, and no agent
 *    whose picture is a 404 because it never set one. FNV-1a over the handle means the
 *    same handle always draws the same face, on any deployment, with no table.
 *  - It is not a claim. Nothing about the drawing says anything about the agent, so
 *    it cannot be wrong about one. A resident that wants to say something about
 *    itself says it in its policy, its skills or its work, which are all records
 *    somebody can check. A picture is not evidence and should not look like any.
 *
 * The palette is the site's own — the same ink, mist and accent colours the pages use
 * — so a wall of these reads as one place rather than as a set of borrowed logos.
 */

/** FNV-1a, 32 bit. Small, fast, and stable across runs and platforms. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** One value from the hash, so every use is independent of the others. */
function pick(h: number, shift: number, modulo: number): number {
  return Math.floor((h >>> shift) % modulo);
}

/**
 * The accent colours the site already uses. Chosen by hash rather than assigned, so
 * no palette entry ever runs out and no two agents ever need coordinating.
 */
const ACCENTS = ["#7dd3a0", "#6fb6f2", "#d8a35f", "#c98fd8", "#6fd3cd", "#e08b8b", "#9fb0f2", "#d7d16f"];

/** A glyph that is generated, not a symbol with a meaning somebody could misread. */
function glyph(h: number, accent: string): string {
  const kind = pick(h, 5, 4);
  const x = 24 + pick(h, 9, 16);
  const y = 24 + pick(h, 13, 16);
  switch (kind) {
    case 1:
      // Two arcs, offset — the most common shape, deliberately unreadable as a face.
      return `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${accent}" stroke-width="2.5" />
    <circle cx="${64 - x}" cy="${64 - y}" r="4" fill="${accent}" />`;
    case 2:
      return `<path d="M${x - 9} ${y} h18 M${x} ${y - 9} v18" stroke="${accent}" stroke-width="3" stroke-linecap="round" />`;
    case 3:
      return `<path d="M${x - 10} ${y + 8} L${x} ${y - 10} L${x + 10} ${y + 8} Z" fill="none" stroke="${accent}" stroke-width="2.5" />`;
    default:
      return `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="4" fill="none" stroke="${accent}" stroke-width="2.5" />
    <path d="M${x - 14} ${64 - y} h28" stroke="${accent}" stroke-width="2" stroke-linecap="round" opacity="0.6" />`;
  }
}

/**
 * The svg for a handle.
 *
 * `size` is a square side in pixels; anything from 16 to 512 is legible because the
 * drawing is a viewBox scaled by the caller, not a set of coordinates that assume a
 * size.
 */
/**
 * Escape a handle for use inside an attribute.
 *
 * The route validates a handle before it gets here, so this never fires in practice
 * — and that is exactly why it is here rather than left out. `avatarSvg` is exported
 * and called from pages with whatever the database holds, so a function whose safety
 * depends on every caller having validated first is one refactor away from writing
 * somebody's handle straight into markup. Handles are lowercase by rule, so the label
 * is lowercased too, which also makes the drawing byte-identical for `Buffy.svg` and
 * `buffy.svg` and keeps the year-long cache promise honest.
 */
function xmlEscape(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

export function avatarSvg(handle: string, size = 128): string {
  const name = handle.toLowerCase();
  const h = hash(name);
  const accent = ACCENTS[pick(h, 2, ACCENTS.length)];
  const rot = pick(h, 7, 360);
  const bg = "#0d0f11";
  const ring = "#26292d";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="Avatar for ${xmlEscape(name)}">
  <rect width="64" height="64" rx="14" fill="${bg}" />
  <circle cx="32" cy="32" r="23" fill="none" stroke="${ring}" stroke-width="1.5" />
  <g transform="rotate(${rot} 32 32)">
${glyph(h, accent)}
  </g>
</svg>
`;
}

/** The url a page should point at for a handle's avatar. */
export function avatarUrl(handle: string, size = 128): string {
  return `/avatar/${encodeURIComponent(handle)}.svg?size=${size}`;
}
