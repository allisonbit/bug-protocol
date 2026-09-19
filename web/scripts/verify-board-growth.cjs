/**
 * THE BOARD IS THE SWARM'S, AND NOTHING IT ASKS FOR IS LIVE.
 *
 * Two claims, both of which this file checks against the real database rather than
 * against the code that is supposed to make them true:
 *
 *  1. **An agent can put a place on the board.** `propose_target` is open to any
 *     agent with no permission and no human involved, and the reflex grammar now
 *     reaches it (r16), so the board grows because agents ask for places rather
 *     than because an operator seeds them.
 *
 *  2. **Asking is not authorising.** A proposal arrives with `opted_in false` and
 *     `status proposed`, and it stays inert until somebody proves control of EVERY
 *     domain it declares (a DNS TXT record, via verify_target). This is the claim
 *     that matters, because it is the one that would let the platform start sending
 *     traffic at a host nobody agreed to have tested. It must never be possible for
 *     an agent to make a live target, and the only way to know that is to look.
 *
 *   PGPASSWORD=... node scripts/verify-board-growth.cjs
 */
const { Client } = require("pg");

const PREFIX = "swamp-verify=";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

(async () => {
  if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD is required (the database password)");
  const ref = /https:\/\/([a-z0-9]+)\./.exec(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
  const c = new Client({
    host: process.env.PGHOST || "aws-1-eu-west-1.pooler.supabase.com",
    port: Number(process.env.PGPORT || 6543),
    user: `postgres.${ref ? ref[1] : ""}`,
    password: process.env.PGPASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const { rows } = await c.query(
    "select slug, status, opted_in, domains, proposed_by, verification_token, verified_at from targets order by created_at",
  );

  console.log(`reading ${rows.length} target(s) from the board\n`);

  // 1) The board is not empty, and its growth is not only an operator's doing.
  const proposed = rows.filter((r) => r.proposed_by);
  check(
    "the board holds at least one target",
    rows.length >= 1,
    "an empty board is not a quiet beginning, it is nowhere to work",
  );
  console.log(
    `  NOTE  ${proposed.length} of ${rows.length} place(s) on the board were asked for by an agent: ` +
      `${proposed.map((r) => r.slug).join(", ") || "(none yet)"}`,
  );

  // 2) THE INVARIANT. Opted in iff live. A target that is live without consent, or
  //    a proposal that is marked consented before anybody proved anything, is the
  //    failure this whole file exists for.
  const liveWithoutConsent = rows.filter((r) => r.opted_in === true && r.status === "proposed");
  check(
    "nothing is opted in while it is still only proposed",
    liveWithoutConsent.length === 0,
    liveWithoutConsent.map((r) => r.slug).join(", "),
  );

  const activeWithoutConsent = rows.filter((r) => r.status === "active" && r.opted_in !== true);
  check(
    "nothing is active without having been opted in",
    activeWithoutConsent.length === 0,
    activeWithoutConsent.map((r) => r.slug).join(", "),
  );

  // 3) An agent's proposal is inert, in every column that could make it otherwise.
  for (const r of proposed) {
    const inert = r.opted_in !== true && r.status !== "active";
    check(
      `the agent-asked-for place "${r.slug}" is inert`,
      inert,
      `status=${r.status} opted_in=${r.opted_in}`,
    );
  }

  // 4) Two paths reach a live target, and they owe different records.
  //
  //    An AGENT-asked-for place is activated by proving control of every domain it
  //    declares, so a live one must carry the token that was proved and the time it
  //    was proved. That is the load-bearing check in this file.
  //
  //    An OPERATOR place is authorised by the operator, through add-target.cjs
  //    --opt-in, which is the single switch here that points at somebody else's
  //    server. It owes no token, because there is nobody to prove anything to: the
  //    operator owns the deployment. What it must not do is masquerade as verified,
  //    so the absence is reported rather than assumed away.
  for (const r of rows.filter((t) => t.status === "active")) {
    check(`${r.slug} names the domains a check may run against`, Array.isArray(r.domains) && r.domains.length > 0, "no domains");
    if (!r.proposed_by) {
      console.log(`  NOTE  ${r.slug} is an operator-authorised place (opted in directly, no proof record owed)`);
      continue;
    }
    check(
      `${r.slug} was asked for by an agent and activated by proof`,
      Boolean(r.verification_token) && Boolean(r.verified_at),
      `token=${Boolean(r.verification_token)} verified_at=${Boolean(r.verified_at)}; a host must never go live because an agent asked`,
    );
  }

  // 5) The token's shape, on the one path where it is the proof. An active place
  //    that an agent asked for, holding a token too short to have been a real TXT
  //    record, would mean control was asserted rather than demonstrated.
  const weak = rows.filter(
    (r) => r.status === "active" && r.proposed_by && (!r.verification_token || r.verification_token.length < 8),
  );
  check("every agent-asked-for live place holds a real verification token", weak.length === 0, weak.map((r) => r.slug).join(", "));

  console.log(`\n${pass}/${pass + fail} checks passed${fail ? `, ${fail} FAILED` : ""}`);
  console.log(`(a live target is activated by a TXT record: ${PREFIX}<token>)`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("failed:", e.message);
  process.exit(1);
});
