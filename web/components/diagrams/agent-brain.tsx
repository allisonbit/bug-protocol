/**
 * A brain: two hemispheres of nodes, split down the middle, wired to each other.
 *
 * The point of the drawing is the fissure. An owner's model, hardware and keys
 * all live on the left; the only thing that crosses into the protocol is signed
 * messages, which is what the two centre nodes and the link between them stand
 * for. Swamp hosts none of it.
 *
 * Deliberately wordless. Every label that would have been drawn inside it is
 * real text beside it in the section, which keeps it legible at any width and
 * keeps the words selectable. The label below carries the meaning for a screen
 * reader.
 */

const RING = [0, 60, 120, 180, 240, 300].map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
});

/** One hemisphere: a centre node with six ring nodes around it. */
function Hemisphere({ cx }: { cx: number }) {
  const rx = 62;
  const ry = 96;
  const cy = 150;

  const ring = RING.map((p) => ({ x: cx + rx * p.x, y: cy + ry * p.y }));

  return (
    <>
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill="color-mix(in srgb, var(--color-bug) 4%, transparent)"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.14"
      />
      {/* ring links, then spokes in to the core */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.16">
        {ring.map((p, i) => {
          const q = ring[(i + 1) % ring.length];
          return <line key={`r${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
        })}
      </g>
      <g stroke="currentColor" strokeWidth="1" opacity="0.22">
        {ring.map((p, i) => (
          <line key={`s${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} />
        ))}
      </g>
      <g fill="currentColor" opacity="0.4">
        {ring.map((p, i) => (
          <circle key={`n${i}`} cx={p.x} cy={p.y} r="4.5" />
        ))}
      </g>
      <circle cx={cx} cy={cy} r="8" fill="var(--color-bug)" />
    </>
  );
}

export function AgentBrain() {
  return (
    <svg
      viewBox="0 0 420 300"
      className="h-auto w-full"
      role="img"
      aria-label="Two hemispheres of connected nodes, split by a central fissure and joined through their cores: one mind, half of it the model the owner runs and half of it the signed messages it sends."
    >
      <Hemisphere cx={130} />
      <Hemisphere cx={290} />
      {/* the link between the two cores — the only thing that leaves */}
      <line
        x1="130"
        y1="150"
        x2="290"
        y2="150"
        stroke="var(--color-bug-dim)"
        strokeWidth="1.5"
      />
      {/* the fissure */}
      <line
        x1="210"
        y1="46"
        x2="210"
        y2="254"
        stroke="var(--color-line-strong)"
        strokeWidth="1.5"
        strokeDasharray="5 5"
      />
    </svg>
  );
}
