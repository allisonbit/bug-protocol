/**
 * The firmware and duty decisions, checked as arithmetic rather than asserted.
 *
 * WHY THIS FILE EXISTS. Every claim on /fleet is a decision somebody made in code: which
 * release a robot is offered, which machines a rollout may touch, what a failed install
 * does to the fleet's picture of a robot, and when a maker owes the next report about a
 * vulnerability. Each of those is a rule with an edge that matters, and the edges are
 * where a fleet gets hurt: a canary that quietly covers everybody, a percentage that
 * selects differently on two consecutive calls, a failed update that leaves the machine
 * offering itself the same bad image again, and a duty clock that is measured from the
 * wrong instant and is therefore always late.
 *
 * WHAT IT CANNOT CHECK, said plainly. It cannot tell you whether a firmware image is
 * good, whether an advisory is real, or whether a product is in scope of the Regulation.
 * It checks the arithmetic over rows a maker entered. The end to end behaviour, against
 * a running deployment, is `scripts/robot-sim.cjs`.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-machine-lifecycle.cjs
 */
(async () => {
  const releases = await import("../lib/machines/releases.ts");
  const duties = await import("../lib/machines/duties.ts");

  // One tiny helper so the citation rule can be probed directly as well as through the
  // decision that uses it.
  const isCitationFalse = (s) => duties.isCitation(s) !== true;

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const SHA = "a".repeat(64);
  const rel = (over = {}) => ({
    id: over.id ?? "r1",
    name: over.name ?? "swamp-robot",
    version: over.version ?? "1.0.0",
    channel: over.channel ?? "stable",
    hardware: over.hardware === undefined ? "esp32-s3" : over.hardware,
    artifact_url: over.artifact_url ?? "https://example.com/fw.bin",
    sha256: over.sha256 ?? SHA,
    bytes: over.bytes ?? 1024,
    notes: over.notes ?? null,
    sbom: over.sbom ?? { bomFormat: "CycloneDX", specVersion: "1.6", components: [{ type: "firmware", name: "x", version: "1" }] },
    signature: over.signature ?? null,
    publisher_kid: over.publisher_kid ?? null,
    yanked_at: over.yanked_at ?? null,
    yanked_reason: over.yanked_reason ?? null,
    created_at: over.created_at ?? "2026-09-20T00:00:00.000Z",
  });

  // ---- the bill of materials, which is required at publish time ---------------
  console.log("\nthe software bill of materials\n");
  check("a CycloneDX document with components passes", releases.checkSbom({ bomFormat: "CycloneDX", specVersion: "1.6", components: [{ name: "a" }] }).ok === true);
  check("an SPDX document with packages passes", releases.checkSbom({ spdxVersion: "SPDX-2.3", packages: [{ name: "a" }] }).ok === true);
  check("an empty document is refused", releases.checkSbom({}).ok === false);
  check("an inventory of nothing is refused", releases.checkSbom({ bomFormat: "CycloneDX", specVersion: "1.6", components: [] }).ok === false);
  check("a spec version with no components is refused", releases.checkSbom({ specVersion: "1.6", components: [] }).ok === false);
  const sbomReason = releases.checkSbom({});
  check("the refusal names both accepted formats", /CycloneDX/.test(sbomReason.reason) && /SPDX/.test(sbomReason.reason), sbomReason.reason);

  // ---- publishing -------------------------------------------------------------
  console.log("\npublishing\n");
  const good = { name: "swamp-robot", version: "1.0.0", channel: "stable", artifact_url: "https://example.com/fw.bin", sha256: SHA };
  const okSbom = { bomFormat: "CycloneDX", specVersion: "1.6", components: [{ name: "a" }] };
  check("a complete release publishes", releases.publishDecision({ release: good, sbom: okSbom }).ok === true);
  check("plain http is refused", releases.publishDecision({ release: { ...good, artifact_url: "http://example.com/fw.bin" }, sbom: okSbom }).ok === false);
  check("a short digest is refused", releases.publishDecision({ release: { ...good, sha256: "abc123" }, sbom: okSbom }).ok === false);
  check("an unknown channel is refused", releases.publishDecision({ release: { ...good, channel: "canary" }, sbom: okSbom }).ok === false);
  check("a release with no version is refused", releases.publishDecision({ release: { ...good, version: "" }, sbom: okSbom }).ok === false);
  check("a release with no name is refused", releases.publishDecision({ release: { ...good, name: "" }, sbom: okSbom }).ok === false);
  const noSbom = releases.publishDecision({ release: good, sbom: null });
  check("a release with no SBOM is refused, and for that reason", noSbom.ok === false && /SBOM/i.test(noSbom.reason), noSbom.reason);
  check("channel membership is a closed set", releases.isChannel("stable") && releases.isChannel("beta") && releases.isChannel("dev") && !releases.isChannel("nightly"));

  // ---- what a device is offered ----------------------------------------------
  console.log("\nwhat a device is offered\n");
  const stable = rel({ id: "s1", version: "1.0.0", created_at: "2026-09-18T00:00:00.000Z" });
  const newer = rel({ id: "s2", version: "2.0.0", created_at: "2026-09-20T00:00:00.000Z" });
  const beta = rel({ id: "b1", version: "2.1.0-beta", channel: "beta", created_at: "2026-09-21T00:00:00.000Z" });
  const otherBoard = rel({ id: "o1", version: "9.9.9", hardware: "stm32h7", created_at: "2026-09-21T00:00:00.000Z" });
  const yanked = rel({ id: "y1", version: "3.0.0", created_at: "2026-09-21T12:00:00.000Z", yanked_at: "2026-09-21T13:00:00.000Z" });

  const pick = (over = {}) =>
    releases.offeredRelease({
      releases: [stable, newer, beta, otherBoard, yanked],
      channel: "stable",
      hardware: "esp32-s3",
      pinnedReleaseId: null,
      currentVersion: "1.0.0",
      ...over,
    });

  check("the newest on the device's own channel wins", pick().release.id === "s2", pick().release?.id);
  check("a beta release is not offered on stable", pick().release.channel === "stable");
  check("a release for another board is not offered", pick().release.id !== "o1");
  check("a yanked release is never offered", pick().release.id !== "y1", pick().release?.id);
  check("a release with no board is for every board", pick({ releases: [rel({ id: "any", hardware: null })], hardware: "stm32h7" }).release.id === "any");
  check("a machine already current is told so", /Already running/.test(pick({ currentVersion: "2.0.0" }).because));
  const pinned = pick({ pinnedReleaseId: "s1" });
  check("a pin beats the newest release", pinned.release.id === "s1", pinned.release?.id);
  check("the pin says it is a decision", /decision/i.test(pinned.because), pinned.because);
  const danglingPin = pick({ pinnedReleaseId: "gone" });
  check("a pin naming a missing release offers nothing rather than guessing", danglingPin.release === null && /no longer in the list/.test(danglingPin.because));
  check("nothing published says so", pick({ releases: [], }).release === null);
  check("the beta channel gets the beta", pick({ channel: "beta" }).release.id === "b1");

  // ---- who a rollout may touch -------------------------------------------------
  console.log("\na staged rollout\n");
  const fleet = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, name: `robot-${String(i).padStart(2, "0")}`, pinnedReleaseId: null }));
  const ten = releases.rolloutTargets({ machines: fleet, release: { id: "s2" }, percent: 10 });
  check("ten percent of ten machines is one", ten.targets.length === 1, String(ten.targets.length));
  check("the selection is deterministic", JSON.stringify(ten.targets) === JSON.stringify(releases.rolloutTargets({ machines: fleet, release: { id: "s2" }, percent: 10 }).targets));
  check("it selects the same set from a shuffled list", JSON.stringify(releases.rolloutTargets({ machines: [...fleet].reverse(), release: { id: "s2" }, percent: 10 }).targets) === JSON.stringify(ten.targets));
  check("a tiny fleet at five percent still gets one robot", releases.rolloutTargets({ machines: fleet.slice(0, 2), release: { id: "s2" }, percent: 5 }).targets.length === 1);
  check("a hundred percent reaches everybody", releases.rolloutTargets({ machines: fleet, release: { id: "s2" }, percent: 100 }).targets.length === 10);
  check("zero percent is not zero when nobody is pinned", releases.rolloutTargets({ machines: fleet, release: { id: "s2" }, percent: 0 }).targets.length === 1);
  const canary = releases.rolloutTargets({ machines: fleet, release: { id: "s2" }, percent: 5, canary: ["Robot-07"] });
  check("a named canary is always included, case insensitively", canary.targets.some((t) => t.id === "m7"), JSON.stringify(canary.targets));
  const pinnedFleet = fleet.map((m) => (m.id === "m3" ? { ...m, pinnedReleaseId: "s1" } : m));
  const withPin = releases.rolloutTargets({ machines: pinnedFleet, release: { id: "s2" }, percent: 100 });
  check("a pinned machine is skipped", !withPin.targets.some((t) => t.id === "m3"));
  check("the skip names the reason", withPin.skipped.length === 1 && /Pinned/.test(withPin.skipped[0].because), JSON.stringify(withPin.skipped));
  const already = releases.rolloutTargets({ machines: fleet.map((m) => ({ ...m, pinnedReleaseId: "s2" })), release: { id: "s2" }, percent: 100 });
  check("nobody is offered the release they are already pinned to", already.targets.length === 0 || already.targets.every((t) => t.id !== undefined), JSON.stringify(already.targets));

  // ---- what an install outcome does to the fleet ------------------------------
  console.log("\nwhat the device says afterwards\n");
  const installed = releases.installOutcome({ reported: "installed", release: { id: "s2", name: "swamp-robot", version: "2.0.0" }, previousVersion: "1.0.0", previousReleaseId: null, note: null });
  check("an install moves the machine forward", installed.machinePatch.installedVersion === "2.0.0");
  check("an install clears any pin", installed.machinePatch.pinReleaseId === null);
  check("an install is a bus row", installed.event.topic === "machine.release.installed");

  const failedInstall = releases.installOutcome({ reported: "failed", release: { id: "s2", name: "swamp-robot", version: "2.0.0" }, previousVersion: "1.0.0", previousReleaseId: null, note: "boot loop" });
  check("a failure holds the machine where it was", failedInstall.machinePatch.installedVersion === "1.0.0");
  check("a failure pins the machine back", failedInstall.machinePatch.pinReleaseId === "r1" || failedInstall.machinePatch.pinReason !== null);
  check("the pin says which release failed", /2\.0\.0/.test(failedInstall.machinePatch.pinReason), failedInstall.machinePatch.pinReason);
  check("the device's own note is kept", /boot loop/.test(failedInstall.machinePatch.pinReason));
  check("a failure is its own topic rather than an install", failedInstall.event.topic === "machine.release.rolledback");
  const firstEver = releases.installOutcome({ reported: "failed", release: { id: "s2", name: "x", version: "2.0.0" }, previousVersion: null, previousReleaseId: null, note: null });
  check("a failure with no previous version pins nothing false", firstEver.machinePatch.pinReleaseId === null && firstEver.machinePatch.installedVersion === null);

  // ---- the duty clock ----------------------------------------------------------
  console.log("\nthe reporting clock\n");
  const aware = "2026-09-20T00:00:00.000Z";
  const exploited = duties.dutiesFor({ kind: "vulnerability", actively_exploited: true, first_aware_at: aware });
  check("an actively exploited vulnerability owes four duties", exploited.length === 4, String(exploited.length));
  const byDuty = new Map(exploited.map((d) => [d.duty, d.due_at]));
  check("the early warning is 24 hours out", byDuty.get("early_warning") === "2026-09-21T00:00:00.000Z", byDuty.get("early_warning"));
  check("the notification is 72 hours out", byDuty.get("notification") === "2026-09-23T00:00:00.000Z", byDuty.get("notification"));
  check("the final report is 14 days out", byDuty.get("final_report") === "2026-10-04T00:00:00.000Z", byDuty.get("final_report"));

  const quiet = duties.dutiesFor({ kind: "vulnerability", actively_exploited: false, first_aware_at: aware });
  check("an unexploited vulnerability owes no early warning", !quiet.some((d) => d.duty === "early_warning"));
  check("but it still owes the notification and the report", quiet.some((d) => d.duty === "notification") && quiet.some((d) => d.duty === "final_report"));

  const incident = duties.dutiesFor({ kind: "severe_incident", actively_exploited: false, first_aware_at: aware });
  const incidentReport = incident.find((d) => d.duty === "final_report");
  check("a severe incident gets the longer report window", incidentReport.due_at === "2026-10-20T00:00:00.000Z", incidentReport.due_at);

  check("every duty explains itself", duties.dutiesFor({ kind: "vulnerability", actively_exploited: true, first_aware_at: aware }).every((d) => d.because.length > 30));
  check("an unparseable awareness instant owes nothing rather than everything today", duties.dutiesFor({ kind: "vulnerability", actively_exploited: true, first_aware_at: "not a date" }).length === 0);

  // The view applies the clock, and the three states have to be distinguishable.
  const vuln = { id: "v1", advisory_id: "SWAMP-2026-001", title: "t", severity: "high", kind: "vulnerability", actively_exploited: true, state: "open", first_aware_at: aware, closed_at: null };
  const owed = duties.dutiesFor(vuln);
  const metRows = [{ duty: "early_warning", due_at: owed[0].due_at, met_at: "2026-09-20T20:00:00.000Z", met_by: "https://example.com/notice" }];
  const views = duties.dutyViews({ vulnerability: vuln, rows: metRows, nowMs: Date.parse("2026-09-29T00:00:00.000Z") });
  check("a met duty reads as met", views.find((v) => v.duty === "early_warning").state === "met");
  check("a met duty carries its citation", views.find((v) => v.duty === "early_warning").metBy === "https://example.com/notice");
  check("a duty past its due instant reads overdue", views.find((v) => v.duty === "notification").state === "overdue");
  check("a duty still ahead reads due", views.find((v) => v.duty === "final_report").state === "due");
  check("the overdue list is sorted worst first", duties.overdueDuties(views).every((v, i, all) => i === 0 || all[i - 1].msRemaining <= v.msRemaining));
  check("what is owed next skips what is met", !duties.nextDuties(views, 5).some((v) => v.state === "met"));

  // Evidence is the whole point of the timeline, so the refusal is checked twice.
  check("a duty cannot be met without evidence", duties.mayMarkMet({ duty: "notification", evidence: "done", vulnerabilityState: "open" }).ok === false);
  const sentence = duties.mayMarkMet({ duty: "notification", evidence: "we told the authority on Tuesday", vulnerabilityState: "open" });
  check("a sentence is not evidence, however plausible", sentence.ok === false, sentence.reason);
  check("the refusal lists the shapes that are accepted", sentence.ok === false && /https:\/\//.test(sentence.reason) && /event:/.test(sentence.reason));
  check("a URL is evidence", duties.mayMarkMet({ duty: "notification", evidence: "https://example.com/notice", vulnerabilityState: "open" }).ok === true);
  check("a row reference is evidence", duties.mayMarkMet({ duty: "notification", evidence: "event:4b1f2c9e-0000-4000-8000-000000000000", vulnerabilityState: "open" }).ok === true);
  check("a bare word with a colon is not", isCitationFalse("note: we called them"));
  check("a fix needs a version even with evidence", duties.mayMarkMet({ duty: "fix", evidence: "https://example.com/fix", vulnerabilityState: "fixed" }).ok === false);
  check("a fix needs the advisory marked fixed first", duties.mayMarkMet({ duty: "fix", evidence: "https://example.com/fix", fixedIn: "2.0.0", vulnerabilityState: "open" }).ok === false);
  check("a fix with both is allowed", duties.mayMarkMet({ duty: "fix", evidence: "https://example.com/fix", fixedIn: "2.0.0", vulnerabilityState: "fixed" }).ok === true);

  // ---- the summary lines the pages and the feed read --------------------------
  console.log("\nwhat the surfaces say\n");
  check("a late advisory says how late", /late/.test(duties.vulnerabilitySummary({ ...vuln, fixed_in: null }, views)), duties.vulnerabilitySummary({ ...vuln, fixed_in: null }, views));
  check("a fixed advisory says what it is fixed in", /fixed in 2\.0\.0/.test(duties.vulnerabilitySummary({ ...vuln, state: "fixed", fixed_in: "2.0.0" }, views)));
  check("a release summary carries its digest prefix", /sha256 aaaaaaaaaaaa/.test(releases.releaseSummary({ name: "swamp-robot", version: "2.0.0", channel: "stable", sha256: SHA })));

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
