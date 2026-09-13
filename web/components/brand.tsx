/**
 * The Swamp mark: a shield whose interior is a node graph.
 *
 * The shield is the "proof" half — escrowed money the client can't claw back.
 * The graph is the "swamp" half — independent brains, each edge a message one
 * of them signed. The bottom node is accented because that is the one a finding
 * travels up to: a hunter lands it, the escrow pays it.
 *
 * Everything is drawn in `currentColor`, so the mark inherits whatever text
 * colour it sits in and needs no per-context variant. The one exception is the
 * accent node, which reads the `--color-bug` token: deep lime on the light theme,
 * bright lime on the dark one. Neither is hardcoded here.
 *
 * Two variants come from this one component so they can never drift apart:
 *   full    — five nodes, six edges. For 32px and up.
 *   compact — three nodes on the vertical spine. Below 32px the diamond's four
 *             extra edges collapse into a smudge, so they are dropped and the
 *             remaining nodes are drawn larger.
 */

type Variant = "full" | "compact";

/**
 * Shield silhouette on a 24×24 grid: flat top with rounded corners, vertical
 * sides, tapering to a single point on the vertical axis at x=12. Spans y=2.6
 * to y=21.6, which optically centres it against a wordmark's cap height.
 */
const SHIELD =
  "M6.2 2.6H17.8A1.7 1.7 0 0 1 19.5 4.3V11.4C19.5 16.3 16.3 19.6 12 21.6C7.7 19.6 4.5 16.3 4.5 11.4V4.3A1.7 1.7 0 0 1 6.2 2.6Z";

/** Node centres. `top`, `centre` and `bottom` sit on x=12 — the mark's centreline. */
const NODE = {
  top: [12, 6.2],
  left: [7.4, 11.8],
  right: [16.6, 11.8],
  centre: [12, 11.8],
  bottom: [12, 17.4],
} as const;

type NodeName = keyof typeof NODE;
type Edge = readonly [NodeName, NodeName];

/** top → centre → bottom. Carried by both variants, so the mark always has a spine. */
const SPINE: readonly Edge[] = [
  ["top", "centre"],
  ["centre", "bottom"],
];

/** The diamond's four edges. Full variant only. */
const DIAMOND: readonly Edge[] = [
  ["top", "left"],
  ["top", "right"],
  ["left", "bottom"],
  ["right", "bottom"],
];

function Edges({ edges }: { edges: readonly Edge[] }) {
  return (
    <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" opacity={0.35}>
      {edges.map(([a, b]) => (
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
  const rest: readonly NodeName[] = detailed ? ["left", "right", "top", "centre"] : ["top", "centre"];

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
      <path d={SHIELD} stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      <Edges edges={detailed ? [...SPINE, ...DIAMOND] : SPINE} />
      <g fill="currentColor" opacity={0.55}>
        {rest.map((n) => (
          <circle key={n} cx={NODE[n][0]} cy={NODE[n][1]} r={detailed ? 1.5 : 1.8} />
        ))}
      </g>
      <circle
        cx={NODE.bottom[0]}
        cy={NODE.bottom[1]}
        r={detailed ? 1.9 : 2.1}
        fill="var(--color-bug)"
      />
    </svg>
  );
}

/** Mark plus wordmark, spaced and sized together so nav and footer can't drift. */
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
      <span className={`text-gradient ${wordClassName}`}>Swamp</span>
    </span>
  );
}
