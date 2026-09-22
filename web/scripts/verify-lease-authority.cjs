/**
 * AUTHORITY, WIRED ALL THE WAY THROUGH.
 *
 * WHY THIS FILE EXISTS. A lease is enforced at every actuating door, and enforcement
 * alone is worthless to the person who has to decide whether to move a relay: they
 * need to see the authority, issue one, and stand one down. That visibility crosses
 * seven places that fail independently and all of them compile fine:
 *
 *   the migration      the table has to be readable and the command has to say which
 *                      lease permitted it, or the page shows nothing and the history
 *                      cannot be audited even when both ends work
 *   the projector      the world marks a machine leased from the SAME three bounds the
 *                      doors enforce, so a ring can never stand over a lease that would
 *                      refuse the command
 *   the loader         the rows actually reach the projector
 *   the machine page   the list renders, and the controls are the owner's alone
 *   the actions        issuing and revoking write the row and emit the beat
 *   the actuation path the consumed lease id is recorded rather than discarded
 *   the drawing        the ring is geometry, drawn with the mark and never merged into it
 *
 * So every link is asserted here rather than believed, and the projector half runs for
 * real rather than on strings:
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-lease-authority.cjs
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const zones = await import("../lib/world/zones.ts");
  const city = await import("../lib/world/city.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  // ---- the projector, for real ------------------------------------------------
  console.log("\nthe world marks a lease from the row, and never invents one");

  const base = {
    zones: zones.allZones(),
    agents: [],
    targets: [],
    claims: [],
    cabals: [],
    members: [],
    findings: [],
    outputs: [],
    sources: [],
    facts: [],
    hypotheses: [],
    fixtures: [],
    rooms: [],
    alerts: [],
    tasks: [],
    bodies: [],
    totals: { facts: 0, hypotheses: 0, skills: 0 },
    now: Date.parse("2026-09-22T12:00:00.000Z"),
  };
  const machine = (over) => ({
    id: "m-1",
    name: "atlas",
    kind: "actuator",
    status: "active",
    last_report_at: "2026-09-22T11:58:00.000Z",
    pending_commands: 0,
    ...over,
  });

  const build = (machines, alerts = []) => city.buildCity({ ...base, machines, alerts }).structures.find((s) => s.kind === "machine");

  const plain = build([machine({})]);
  check("a machine with no lease draws no ring", plain != null && plain.leased === undefined, JSON.stringify(plain && plain.leased));

  const leased = build([machine({ leased: true })]);
  check("a live lease draws the ring", leased != null && leased.leased === true, JSON.stringify(leased && leased.leased));

  const alerting = build(
    [machine({ leased: true })],
    [{ machine_id: "m-1", kind: "alert", created_at: "2026-09-22T11:59:00.000Z" }],
  );
  check(
    "trouble and authority are two marks, not one",
    alerting != null && alerting.trouble === true && alerting.leased === true,
    JSON.stringify({ trouble: alerting && alerting.trouble, leased: alerting && alerting.leased }),
  );

  const troubleOnly = build([machine({})], [{ machine_id: "m-1", kind: "alert", created_at: "2026-09-22T11:59:00.000Z" }]);
  check("a machine in trouble is not thereby leased", troubleOnly != null && troubleOnly.trouble === true && troubleOnly.leased === undefined);

  const retired = city.buildCity({ ...base, machines: [machine({ status: "retired", leased: true })] }).structures.find((s) => s.kind === "machine");
  check("a retired machine is drawn at all only when its lease does not raise it", retired === undefined, JSON.stringify(retired && retired.id));

  // The ring is lit from the same bound the doors read, so the projector's own input
  // carries the ceiling check rather than trusting the loader's filter.
  const rowsSrc = read("lib/world/rows.ts");
  check(
    "the loader marks a machine leased only under its ceiling",
    /used_actuations\s*<\s*l\.max_actuations/.test(rowsSrc),
    "no ceiling comparison in the lease mark",
  );
  check(
    "the loader asks for unrevoked, unexpired leases",
    /from\("machine_leases"\)/.test(rowsSrc) && /\.is\("revoked_at", null\)/.test(rowsSrc) && /\.gt\("expires_at"/.test(rowsSrc),
    "the lease query does not carry both bounds",
  );

  // ---- the drawing -----------------------------------------------------------
  console.log("\nthe ring is geometry, drawn with the mark and never merged into it");
  const scapeSrc = read("components/world/cityscape.ts");
  check("the ring exists as its own mesh", /leaseRing/.test(scapeSrc), "no lease ring in the renderer");
  check("the ring is a ground band, not a disc", /RingGeometry/.test(scapeSrc), "not a ring geometry");
  check("the ring has its own colour", /const LEASED =/.test(scapeSrc), "no LEASED colour");
  check(
    "a change in authority rebuilds the building",
    /entry\.leased !== !!s\.leased/.test(scapeSrc),
    "the renderer never notices authority arriving or leaving",
  );
  const inspectSrc = read("lib/world/inspect.ts");
  check("the card says the machine is authorized", /label: "Authorized"/.test(inspectSrc), "no fact for the ring");

  // ---- the migration ---------------------------------------------------------
  console.log("\nthe table is readable, and the command says what permitted it");
  const migration = read("supabase/migrate-lease-visibility.sql");
  check("the command gains a lease column", /add column if not exists lease_id/.test(migration), "no lease_id");
  check("the column binds to the lease it consumed", /references public\.machine_leases\(id\)/.test(migration), "no foreign key");
  check("leases become publicly readable", /create policy machine_leases_read[\s\S]*?for select to public/.test(migration), "no read policy");
  check("issuing is the machine owner's", /create policy machine_leases_insert[\s\S]*?m\.owner = auth\.uid\(\)/.test(migration), "insert is not owner checked");
  check("revoking is the machine owner's", /create policy machine_leases_update[\s\S]*?m\.owner = auth\.uid\(\)/.test(migration), "update is not owner checked");

  // ---- the page --------------------------------------------------------------
  console.log("\nthe machine page shows the authority, and only its owner may write one");
  const pageSrc = read("app/machines/[name]/page.tsx");
  const authoritySrc = read("app/machines/[name]/authority.tsx");
  check("the page reads the leases", /from\("machine_leases"\)/.test(pageSrc), "no lease read");
  check("the page renders the section", /<AuthoritySection/.test(pageSrc), "section not rendered");
  check("ownership comes from the machine row", /user\.id === machine\.owner/.test(pageSrc), "owner check missing");
  check("the issuer is shown as a person, not a uuid", /from\("profiles"\)/.test(pageSrc), "issuer not resolved");
  check("the list is public and the controls are not", /isOwner && <IssueForm/.test(authoritySrc), "the issue form is not owner gated");
  check("a lease row states its scope, ceiling, expiry and reason", /\{l\.scope\}/.test(authoritySrc) && /\{l\.reason\}/.test(authoritySrc) && /max_actuations\}/.test(authoritySrc ?? ""));
  check("an expired, exhausted and revoked lease each read differently", /"exhausted"/.test(authoritySrc) && /"revoked"/.test(authoritySrc) && /"expired"/.test(authoritySrc));
  check("revoking demands a reason", /minLength=\{10\}/.test(authoritySrc), "no reason floor on revoke");

  // ---- the actions -----------------------------------------------------------
  console.log("\nissuing and revoking write the row and say so on the log");
  const actionsSrc = read("app/actions.ts");
  check("issuing goes through the same pure rules as the door", /leaseIssuable\(/.test(actionsSrc), "the action does not use leaseIssuable");
  check("issuing writes a lease row", /from\("machine_leases"\)\s*\n?\s*\.insert/.test(actionsSrc), "no insert");
  check("revoking stamps a revocation", /revoked_at:/.test(actionsSrc) && /revoked_reason:/.test(actionsSrc), "no revocation stamp");
  check("both emit machine.lease", (actionsSrc.match(/emitLease\("machine\.lease"/g) ?? []).length >= 2, "fewer than two emissions");

  // ---- the actuation path ----------------------------------------------------
  //
  // This is the part that was actually wrong. The agent's command tool was gated and the
  // pulse's own reflex was not, so a resident could queue an actuation with no lease at
  // all. One implementation, called by both doors, is what closes it — and the check
  // below fails if either door ever grows its own copy of the rule again.
  console.log("\nevery actuating door passes through one gate, and records what it spent");
  const capsSrc = read("lib/mcp/tools-capabilities.ts");
  const pulseSrc = read("lib/swamp/pulse.ts");
  const gateSrc = read("lib/machines/lease-gate.ts");

  check("the gate is server side only", /^import "server-only";/m.test(gateSrc), "the gate could be pulled into client code");
  check(
    "the gate refuses an unreadable authority rather than assuming consent",
    /LEASE_UNREADABLE/.test(gateSrc),
    "a failed lease read is treated as a lease",
  );
  // A refusal has to name the bound that was hit. Filtering revoked rows out of the read
  // made a withdrawn grant read as NO_LEASE, which is false about the record and useless
  // to the operator who wrote it and withdrew it.
  check(
    "the gate reads revoked rows so a refusal can name revocation",
    !/\.is\("revoked_at", null\)/.test(gateSrc) && /pickLease\(rows, input\.scope\) \?\? newest/.test(gateSrc),
    "a withdrawn grant would read as no grant at all",
  );
  check(
    "the ceiling is spent with a compare-and-set",
    /\.eq\("used_actuations", may\.lease\.used_actuations\)/.test(gateSrc),
    "two racing acts could both spend the last actuation",
  );
  check("the agent's command tool uses the gate", /takeActuationAuthority\(/.test(capsSrc), "the MCP door does its own check");
  check("the pulse's actuation uses the gate", /takeActuationAuthority\(/.test(pulseSrc), "the reflex writes an actuation unchecked");
  check(
    "the agent's command tool no longer keeps its own copy of the rule",
    !/used_actuations:\s*may\.lease\.used_actuations \+ 1/.test(capsSrc),
    "a second implementation of the authority rule is back",
  );
  check(
    "the pulse stamps the grant on the command row",
    /lease_id:\s*authority\?\.leaseId \?\? null/.test(pulseSrc),
    "the pulse's command carries no lease",
  );
  check(
    "the agent's command tool stamps the grant on the command row",
    /lease_id:\s*consumedLease/.test(capsSrc),
    "the door's command carries no lease",
  );
  check(
    "a refused actuation is written down rather than swallowed",
    /direction: "refused"/.test(pulseSrc) && /grant\.code/.test(pulseSrc),
    "the refusal leaves no line on the record",
  );
  // The cool-down is a bound on traffic TO HARDWARE, and a refused actuation sends
  // nothing to any hardware. Charging it the cool-down would mean an operator who
  // grants authority right after a refusal watches the swarm stand still for half an
  // hour on an authority written to be used now.
  const refusalBlock = pulseSrc.slice(pulseSrc.indexOf("if (!grant.ok)"), pulseSrc.indexOf("authority = { leaseId: grant.leaseId }"));
  check(
    "a refusal does not burn the actuation cool-down",
    refusalBlock.length > 0 && !/SUPERVISION_NOTE_KEY/.test(refusalBlock),
    "a refused act would block the next authorized one",
  );
  check(
    "a refusal is reported at most once an hour",
    /saidRecently/.test(refusalBlock) && /60 \* 60 \* 1000/.test(refusalBlock),
    "a refused actuation would be re-announced every beat",
  );
  const feedSrc = read("lib/agents/feed-render.ts");
  check(
    "the log renders a refused authority as a sentence",
    /direction === "refused"/.test(feedSrc),
    "a refused lease falls back to the issued wording",
  );
  const typesSrc = read("lib/agents/types.ts");
  check("the command type carries the lease id", /lease_id: string \| null;/.test(typesSrc), "MachineCommand has no lease_id");
  const rosterSrc = read("app/machines/page.tsx");
  check("the roster reads live leases", /from\("machine_leases"\)/.test(rosterSrc), "the list never reads authority");
  check("the roster marks a leased machine", /leased to act/.test(rosterSrc), "no indicator");
  check("a command under a lease says so", /under lease/.test(rosterSrc), "commands are not tied to their lease");

  console.log(`\nlease-authority: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
