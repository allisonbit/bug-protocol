/**
 * The Swamp mark: a waterline with a node network working beneath it.
 *
 * The old mark was a shield containing a graph, "swarm" (the nodes) inside
 * "proof" (the shield). Half that idea left with the name, and a node graph
 * does not say "swamp" to anyone. So the network stays, because it is still
 * what the product is, but it moves below the surface. The reading is the
 * product's actual claim: the work happens out of sight, and the thing worth
 * money is the deepest node, a hunter lands it, the escrow pays it.
 *
 * Everything is drawn in `currentColor`, so the mark inherits whatever text
 * colour it sits in and needs no per-context variant. The one exception is the
 * bottom node, which reads the `--color-bug` token: deep lime on the light
 * theme, bright lime on the dark one. Neither is hardcoded here.
 *
 * Two variants come from this one component so they can never drift apart:
 *   full, wave, three nodes, three edges. For 32px and up.
 *   compact, wave and three nodes, no edges, drawn larger. At 16px the edges
 *             are shorter than the stroke is wide and fill the triangle in, so
 *             they are dropped and the nodes carry the shape on their own.
 */

type Variant = "full" | "compact";

/**
 * The brand's one curve: alternating quadratic humps, which is what makes it
 * read as water rather than as a squiggle.
 *
 * This is exported and shared rather than drawn twice, because the mark and the
 * waterline that runs across the home page hero are the same shape at two
 * scales. When the curve returns to its starting height after every hump, the
 * series is mirror-symmetric, so a run of them tiles seamlessly, which is what
 * lets the hero's band drift sideways without a seam. Both callers change only
 * the hump width and the amplitude; neither owns its own copy of the maths.
 *
 *   count   how many humps
 *   hump    width of one hump, in the target's own units
 *   amp     how far the peak rises above the baseline (the trough dips the same)
 *   x, y    where the baseline starts
 */
export function humpPath(count: number, hump: number, amp: number, x = 0, y = 0): string {
  let d = `M${x} ${y}`;
  for (let i = 0; i < count; i++) {
    const from = x + i * hump;
    const mid = from + hump / 2;
    const peak = i % 2 === 0 ? y - amp : y + amp;
    d += ` Q${mid} ${peak} ${from + hump} ${y}`;
  }
  return d;
}

/**
 * Three humps on the 24x24 grid, spanning x=3 to x=21 so it is optically
 * centred on the same x=12 centreline as the nodes below it. Baseline y=8.6,
 * which leaves the lower half for the network.
 */
const WAVE = humpPath(3, 6, 2.5, 3, 8.6);

/** Node centres. `bottom` is on x=12, the mark's centreline. */
const NODE = {
  topLeft: [7.6, 14.4],
  topRight: [16.4, 14.4],
  bottom: [12, 19.2],
} as const;

type NodeName = keyof typeof NODE;
type Edge = readonly [NodeName, NodeName];

/**
 * A downward triangle: the shelf the two upper nodes sit on, and the two legs
 * down to the deep one. Drawn in both variants' geometry but only rendered in
 * `full`: see the variant note above.
 */
const EDGES: readonly Edge[] = [
  ["topLeft", "topRight"],
  ["topLeft", "bottom"],
  ["topRight", "bottom"],
];

function Edges() {
  return (
    <g stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" opacity={0.35}>
      {EDGES.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={NODE[a][0]} y1={NODE[a][1]} x2={NODE[b][0]} y2={NODE[b][1]} />
      ))}
    </g>
  );
}

/**
 * The mark on its own. Pass `label` when it stands alone (it then announces
 * itself to assistive tech); omit it when a visible wordmark sits beside it.
 */
export function BrandMark({
  variant = "full",
  size = 26,
  label,
  className = "",
}: {
  variant?: Variant;
  size?: number;
  label?: string;
  className?: string;
}) {
  const detailed = variant === "full";

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        d={WAVE}
        stroke="currentColor"
        strokeWidth={detailed ? 1.5 : 1.7}
        strokeLinecap="round"
      />
      {detailed && <Edges />}
      <g fill="currentColor" opacity={0.55}>
        <circle cx={NODE.topLeft[0]} cy={NODE.topLeft[1]} r={detailed ? 1.5 : 2} />
        <circle cx={NODE.topRight[0]} cy={NODE.topRight[1]} r={detailed ? 1.5 : 2} />
      </g>
      <circle
        cx={NODE.bottom[0]}
        cy={NODE.bottom[1]}
        r={detailed ? 1.9 : 2.4}
        fill="var(--color-bug)"
      />
    </svg>
  );
}

/**
 * Mark plus wordmark, spaced and sized together so nav and footer can't drift.
 *
 * The wordmark is solid `currentColor`, not a gradient. It used to clip a lime
 * gradient to the text, which read as decoration rather than as a signature,
 * and the brand has exactly one accent already: the deep node in the mark. A
 * wordmark that repeats it in two tones makes the mark's single accent mean
 * less. Inheriting the text colour also means the lockup is legible in the
 * header, in the footer and on a page's own surface without a variant per
 * context.
 */
export function BrandLockup({
  size = 26,
  wordClassName = "text-base",
  className = "",
}: {
  size?: number;
  wordClassName?: string;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <BrandMark size={size} className="shrink-0" />
      <span className={`tracking-[-0.01em] ${wordClassName}`}>Swamp</span>
    </span>
  );
}
