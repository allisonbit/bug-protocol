/**
 * Does the authority envelope actually refuse what it must, and for the stated reason?
 *
 * WHY THIS FILE EXISTS. A lease is the difference between remote actuation and auditable
 * remote actuation, and its whole value is in the refusals: an expired grant, an exhausted
 * ceiling, a revoked authority, a lease for a different scope. If any of those slipped
 * through, the platform would be moving hardware on an authority that had ended, and the
 * row would look exactly like a legitimate one. So this verifier walks every branch and
 * insists each refusal names which bound was hit.
 *
 * WHAT IT ALSO HOLDS TO ACCOUNT. That a lease cannot be issued without a reason, a ceiling
 * and an expiry that is actually in the future; that a ceiling of one means one; and that a
 * second live lease cannot quietly extend an authority nobody renewed.
 *
 * It needs no database, no network and no server.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-machine-leases.cjs
 */
(async () => {
  const leases = await import("../lib/machines/leases.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const NOW = Date.parse("2026-09-22T10:00:00.000Z");
  const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    machine_id: "22222222-2222-4222-8222-222222222222",
    machine_name: "atlas",
    scope: "pulse_relay",
    expires_at: at(60),
    max_actuations: 2,
    used_actuations: 0,
    issued_by: "a person",
    issued_by_agent: null,
    reason: "certified rig test on the production cell",
    revoked_at: null,
    revoked_reason: null,
    created_at: at(-10),
  };

  console.log("\nwho needs a lease\n");
  check("an actuation needs a lease", leases.needsLease("pulse_relay"));
  check("a reporting command does not", !leases.needsLease("report_now"));
  check("nor does setting an interval", !leases.needsLease("set_interval"));
  check("an unknown command is not an actuation here", !leases.needsLease("nope"));

  console.log("\nthe decision\n");
  const live = leases.leaseMayAct({ lease: base, scope: "pulse_relay", nowMs: NOW });
  check("a live lease authorizes", live.ok === true, JSON.stringify(live));
  check("and reports the remaining actuations", live.ok === true && live.remaining === 1, live.ok ? String(live.remaining) : "");

  const missing = leases.leaseMayAct({ lease: null, scope: "pulse_relay", nowMs: NOW });
  check("no lease is refused", missing.ok === false && missing.code === "NO_LEASE", JSON.stringify(missing));

  const wrong = leases.leaseMayAct({ lease: base, scope: "set_interval", nowMs: NOW });
  check("a lease for another scope is refused", wrong.ok === false && wrong.code === "WRONG_SCOPE", JSON.stringify(wrong));

  const revoked = leases.leaseMayAct({ lease: { ...base, revoked_at: at(-1), revoked_reason: "site stood down" }, scope: "pulse_relay", nowMs: NOW });
  check("a revoked lease is refused", revoked.ok === false && revoked.code === "REVOKED", JSON.stringify(revoked));
  check("and the refusal names the revocation reason", revoked.ok === false && /site stood down/.test(revoked.reason));

  const expired = leases.leaseMayAct({ lease: { ...base, expires_at: at(-1) }, scope: "pulse_relay", nowMs: NOW });
  check("an expired lease is refused", expired.ok === false && expired.code === "EXPIRED", JSON.stringify(expired));

  const exhausted = leases.leaseMayAct({ lease: { ...base, used_actuations: 2 }, scope: "pulse_relay", nowMs: NOW });
  check("an exhausted lease is refused", exhausted.ok === false && exhausted.code === "EXHAUSTED", JSON.stringify(exhausted));

  const notYetFull = leases.leaseMayAct({ lease: { ...base, max_actuations: 1, used_actuations: 0 }, scope: "pulse_relay", nowMs: NOW });
  check("a ceiling of one allows exactly one", notYetFull.ok === true && notYetFull.remaining === 0, JSON.stringify(notYetFull));
  const thenFull = leases.leaseMayAct({ lease: { ...base, max_actuations: 1, used_actuations: 1 }, scope: "pulse_relay", nowMs: NOW });
  check("and refuses the second", thenFull.ok === false && thenFull.code === "EXHAUSTED");

  const badExpiry = leases.leaseMayAct({ lease: { ...base, expires_at: "not a date" }, scope: "pulse_relay", nowMs: NOW });
  check("an unreadable expiry is refused rather than treated as no bound", badExpiry.ok === false && badExpiry.code === "BAD_EXPIRY", JSON.stringify(badExpiry));

  console.log("\npicking among overlapping grants\n");
  const early = { ...base, id: "early", expires_at: at(10) };
  const late = { ...base, id: "late", expires_at: at(600) };
  const picked = leases.pickLease([late, early], "pulse_relay");
  check("the earliest expiry wins, so a second grant cannot extend an authority", picked && picked.id === "early", picked ? picked.id : "null");
  check("a revoked row is never picked", leases.pickLease([{ ...base, id: "revoked", revoked_at: at(-1) }], "pulse_relay") === null);
  check("another scope is never picked", leases.pickLease([base], "report_now") === null);
  check("nothing live means nothing picked", leases.pickLease([], "pulse_relay") === null);

  console.log("\nissuing\n");
  const good = leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW + 3600_000, maxActuations: 3, reason: "certified rig test on the production cell", nowMs: NOW });
  check("a well formed lease is issuable", good.ok === true, JSON.stringify(good));
  check("and its scope is carried", good.ok === true && good.scope === "pulse_relay");

  check("an unknown scope is refused", leases.leaseIssuable({ machineName: "atlas", scope: "open_sesame", expiresAtMs: NOW + 3600_000, maxActuations: 1, reason: "a long enough reason", nowMs: NOW }).code === "BAD_SCOPE");
  check("a missing reason is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW + 3600_000, maxActuations: 1, reason: "short", nowMs: NOW }).code === "REASON_REQUIRED");
  check("a zero ceiling is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW + 3600_000, maxActuations: 0, reason: "a long enough reason", nowMs: NOW }).code === "BAD_CEILING");
  check("an absurd ceiling is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW + 3600_000, maxActuations: 10000, reason: "a long enough reason", nowMs: NOW }).code === "BAD_CEILING");
  check("an expiry in the past is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW - 1, maxActuations: 1, reason: "a long enough reason", nowMs: NOW }).code === "ALREADY_EXPIRED");
  check("an expiry beyond the horizon is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: NOW + 40 * 24 * 3600_000, maxActuations: 1, reason: "a long enough reason", nowMs: NOW }).code === "TOO_LONG");
  check("an unreadable expiry is refused", leases.leaseIssuable({ machineName: "atlas", scope: "pulse_relay", expiresAtMs: Number.NaN, maxActuations: 1, reason: "a long enough reason", nowMs: NOW }).code === "BAD_EXPIRY");

  console.log(`\nmachine-leases: ${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
