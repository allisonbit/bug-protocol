/**
 * Hero diagram: where the money actually sits.
 *
 * The story it tells, top to bottom: a client funds a bounty, the reward is
 * locked in escrow, and a hunter is paid out of it the moment a finding is
 * accepted. The dashed path looping back to the client is the whole point of
 * the protocol, so it is drawn crossed out — once a reward is escrowed it
 * cannot be reclaimed.
 *
 * Portrait rather than landscape on purpose. A wide three-across flow has to
 * shrink its own labels to fit a phone; stacked, this renders close to 1:1 at
 * every width and the type stays the size it was designed at.
 *
 * Colours are all design tokens, so it re-themes with dark mode. The label
 * carries the same story to a screen reader, since SVG text is not selectable
 * prose and none of it is exposed as markup.
 */
export function EscrowFlow() {
  return (
    <svg
      viewBox="0 0 420 470"
      className="h-auto w-full"
      role="img"
      aria-label="A client funds a bug bounty program. The reward is locked in escrow. When a finding is accepted, the hunter is paid from that escrow. A dashed arrow looping back from escrow to the client is crossed out, because the client cannot reclaim an escrowed reward."
    >
      {/* The blocked return path. Drawn first so the boxes sit over its ends.
          Split into two segments to leave room for the crossed-out badge. */}
      <g
        fill="none"
        stroke="var(--color-mist)"
        strokeWidth="1.5"
        strokeDasharray="5 5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      >
        <path d="M90 235 H40 V167" />
        <path d="M40 137 V70 H74" />
      </g>
      <path d="M74 64 L88 70 L74 76 Z" fill="var(--color-mist)" opacity="0.5" />
      <circle
        cx="40"
        cy="152"
        r="15"
        fill="var(--color-ink-soft)"
        stroke="var(--color-line-strong)"
      />
      <path
        d="M34.5 146.5 L45.5 157.5 M45.5 146.5 L34.5 157.5"
        stroke="var(--color-mist)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />

      {/* ---- Client ---- */}
      <rect
        x="90"
        y="20"
        width="300"
        height="90"
        rx="18"
        fill="var(--color-ink-soft)"
        stroke="var(--color-line)"
      />
      <text x="240" y="60" textAnchor="middle" fontSize="17" fontWeight="600" fill="var(--color-chalk)">
        Client
      </text>
      <text x="240" y="82" textAnchor="middle" fontSize="12" fill="var(--color-mist)">
        funds the bounty upfront
      </text>

      {/* ---- Escrow: the centrepiece, and the only accented box ---- */}
      <rect
        x="90"
        y="160"
        width="300"
        height="140"
        rx="22"
        fill="var(--color-ink-soft)"
        stroke="var(--color-bug-dim)"
        strokeWidth="1.5"
      />
      <g fill="none" stroke="var(--color-bug)" strokeWidth="1.8" strokeLinecap="round">
        <rect x="230" y="180" width="20" height="16" rx="3.5" />
        <path d="M234 180 v-5 a6 6 0 0 1 12 0 v5" />
      </g>
      <text x="240" y="226" textAnchor="middle" fontSize="18" fontWeight="600" fill="var(--color-chalk)">
        Escrow
      </text>
      <text x="240" y="248" textAnchor="middle" fontSize="12" fill="var(--color-mist)">
        locked before the hunt starts
      </text>
      <rect
        x="176"
        y="264"
        width="128"
        height="26"
        rx="13"
        fill="color-mix(in srgb, var(--color-bug) 12%, transparent)"
        stroke="var(--color-bug-dim)"
      />
      <text x="240" y="281" textAnchor="middle" fontSize="11.5" fill="var(--color-bug)">
        no clawback
      </text>

      {/* ---- Hunter ---- */}
      <rect
        x="90"
        y="350"
        width="300"
        height="90"
        rx="18"
        fill="var(--color-ink-soft)"
        stroke="var(--color-line)"
      />
      <text x="240" y="390" textAnchor="middle" fontSize="17" fontWeight="600" fill="var(--color-chalk)">
        Hunter
      </text>
      <text x="240" y="412" textAnchor="middle" fontSize="12" fill="var(--color-mist)">
        paid the moment it&apos;s accepted
      </text>

      {/* ---- The payout rail ---- */}
      <g stroke="var(--color-bug)" strokeWidth="2" strokeLinecap="round">
        <path d="M240 114 V146" />
        <path d="M240 304 V336" />
      </g>
      <path d="M232 146 L240 158 L248 146 Z" fill="var(--color-bug)" />
      <path d="M232 336 L240 348 L248 336 Z" fill="var(--color-bug)" />
      <text x="256" y="140" fontSize="11" fill="var(--color-mist)">
        funds
      </text>
      <text x="256" y="330" fontSize="11" fill="var(--color-mist)">
        pays out
      </text>
    </svg>
  );
}
