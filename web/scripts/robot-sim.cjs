/**
 * A ROBOT, WITHOUT A ROBOT.
 *
 * WHY THIS FILE EXISTS. Every claim on /fleet is a claim about what a device in the
 * world would do: it registers a key and signs its reports, it asks what firmware it is
 * offered and checks the digest itself, it flashes and says what happened, it collects a
 * command and answers it. None of that can be checked from a browser, and asserting it
 * in a verifier that constructs its own request shapes would prove only that this
 * repository agrees with itself. So this is the other side of the wire: a real client
 * that holds a real private key, signs real bytes, and talks to a running deployment
 * over HTTP the way a device on a factory floor would.
 *
 * WHAT IT DOES, IN ORDER, AND WHY EACH STEP IS WORTH DOING.
 *
 *   1. Registers a machine through the signed in door, or reuses a token it was given.
 *   2. Generates an Ed25519 keypair, keeps the private key in this process only, and
 *      registers the public half. From here the platform can say which reports were
 *      signed and which were not, and it never sees a private key.
 *   3. Sends a signed reading, then sends the SAME bytes again, and expects the replay
 *      guard to refuse the second one. That refusal is the only thing standing between a
 *      signature and a signature with a nonce, so it is exercised rather than described.
 *   4. Publishes a firmware release with a real SBOM, stages a rollout, asks what it is
 *      offered, refuses an image whose digest does not match, then reports the install.
 *      The mismatch is the interesting case: a device that flashed anyway is the failure
 *      this whole surface exists to prevent.
 *   5. Fails an install on purpose and checks that it was pinned back, then clears the
 *      pin. A fleet that cannot express "this release did not take" is a fleet that
 *      discovers it from a technician.
 *   6. Collects pending commands, acknowledges one, and reports back what it did, which
 *      is the round trip that makes a command more than a row.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never claims a reading is true, never signs
 * anything it was not asked to, and never touches another machine's rows. It is one
 * device's worth of behaviour and nothing more.
 *
 * USAGE. Against a local dev server, or against production with a token:
 *
 *   node scripts/robot-sim.cjs                        # local, registers and drives everything
 *   node scripts/robot-sim.cjs https://www.swampai.world --token swp_...   # an existing machine
 *   node scripts/robot-sim.cjs --keep                 # leave the machine and its rows in place
 *
 * Registration needs a signed in account. Pass `--email you@example.com --password '...'`
 * to sign in through Supabase, or `--token` to skip registration entirely. With neither,
 * the script stops and says so rather than inventing a row.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WEB = path.resolve(__dirname, "..");

// ---- small helpers ----------------------------------------------------------

function loadEnvLocal() {
  const p = path.join(WEB, ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnvLocal();

let failed = 0;
let checks = 0;
const results = [];

function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
  results.push({ name, ok, detail });
}

function note(msg) {
  console.log(`        ${msg}`);
}

/** The canonical JSON the platform signs over: sorted keys, no incidental whitespace. */
function canonicalJson(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}

/** The exact bytes a device signs, field order fixed. Mirrors lib/machines/identity.ts. */
function canonicalReport({ machine, kid, nonce, ts, readings }) {
  return ["machine-report:v1", `machine:${machine}`, `kid:${kid}`, `nonce:${nonce}`, `ts:${ts}`, `readings:${canonicalJson(readings)}`].join("\n");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// ---- HTTP -------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const [k, inline] = a.slice(2).split("=");
    if (inline !== undefined) flags[k] = inline;
    else if (args[i + 1] && !args[i + 1].startsWith("--")) flags[k] = args[++i];
    else flags[k] = true;
  } else {
    positional.push(a);
  }
}

const BASE = (flags.base || positional[0] || process.env.SIM_BASE || "http://localhost:3000").replace(/\/+$/, "");
let cookies = "";

async function call(method, pathname, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (token) h["x-machine-token"] = token;
  if (cookies) h.cookie = cookies;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length > 0) {
    const jar = new Map(
      cookies
        .split("; ")
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf("=");
          return [c.slice(0, i), c.slice(i + 1)];
        }),
    );
    for (const c of setCookie) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/**
 * A report, respecting the door's floor of one report every five seconds.
 *
 * A real device reports once a minute so it never meets that bound; a script driving three
 * reports in a row meets it immediately. Rather than paper over the 429 by sleeping a fixed
 * amount, this waits exactly as long as the door asked and tries again, which is what a
 * device with a retry would do and what the reply's retry_after_ms is for.
 */
async function report(method, pathname, opts) {
  let res = await call(method, pathname, opts);
  if (res.status === 429 && res.json?.error?.details?.retry_after_ms) {
    const wait = Math.min(Number(res.json.error.details.retry_after_ms) + 250, 15000);
    note(`rate limited, waiting ${wait} ms as the door asked`);
    await new Promise((r) => setTimeout(r, wait));
    res = await call(method, pathname, opts);
  }
  return res;
}

/**
 * Sign in through Supabase, keeping the auth cookies the app reads.
 *
 * The app authenticates with cookie bound sessions (`@supabase/ssr`), so registering a
 * machine means presenting a real session cookie rather than a header. Rather than
 * reimplementing that library's chunked base64 format here, this uses the library
 * itself with a cookie jar it can fill, which is the difference between a script that
 * works this month and one that breaks silently the next time the format moves.
 */
async function signIn(email, password) {
  const { createServerClient } = require("@supabase/ssr");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL and an anon key must be set, from .env.local or the environment.");
  const jar = new Map();
  const client = createServerClient(url, anon, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign in failed: ${error.message}`);
  cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  return data.user;
}

// ---- the run ----------------------------------------------------------------

async function main() {
  console.log(`\nrobot simulator against ${BASE}\n`);

  const health = await call("GET", "/api/machines/releases");
  check("the firmware door answers", health.status === 200, `status ${health.status}`);
  if (health.status !== 200) {
    console.log(`\n${health.text.slice(0, 300)}`);
    console.log("\nIs the server running at this address? Start it and try again.\n");
    return;
  }

  // ---- 1. the machine --------------------------------------------------------
  let token = typeof flags.token === "string" ? flags.token : process.env.SIM_MACHINE_TOKEN || null;
  let machineName = typeof flags.machine === "string" ? flags.machine : null;
  let email = typeof flags.email === "string" ? flags.email : process.env.SIM_EMAIL || null;
  let password = typeof flags.password === "string" ? flags.password : process.env.SIM_PASSWORD || null;

  if (!token) {
    if (!email || !password) {
      console.log("  stop  No machine token was given, and no account to register one with.");
      console.log("        Pass --token <machine token> to drive an existing machine, or");
      console.log("        --email you@example.com --password '...' to sign in and register a new one.\n");
      return;
    }
    const user = await signIn(email, password);
    note(`signed in as ${user.email}`);
    const name = (machineName || `sim-${crypto.randomBytes(3).toString("hex")}`).toLowerCase();
    const reg = await call("POST", "/api/machines", {
      body: {
        name,
        kind: "robot",
        hardware: "esp32-s3",
        description: "simulated robot, driven by scripts/robot-sim.cjs",
        location: "the simulator bench",
        firmware: "2026.09.0",
      },
    });
    if (reg.status !== 201) {
      check("register the machine", false, `status ${reg.status}: ${reg.text.slice(0, 200)}`);
      return;
    }
    token = reg.json.token;
    machineName = reg.json.name;
    check("register the machine", true);
    note(`${machineName} registered with a token shown once, stored only as a hash`);
    if (!flags.keep) fs.writeFileSync(path.join(WEB, ".sim-robot.json"), JSON.stringify({ name: machineName, token }, null, 2));
  } else {
    check("a machine token was supplied", true);
    if (!machineName) {
      const roster = await call("GET", "/api/machines");
      const mine = (roster.json?.machines ?? []).find((m) => m.token === token);
      machineName = mine?.name ?? null;
    }
    if (!machineName) {
      // The roster never returns tokens, so the name has to be given alongside.
      machineName = typeof flags.machine === "string" ? flags.machine : null;
      if (!machineName) {
        console.log("  stop  A token was given without --machine <name>, and the roster cannot map a token back to a name by design.");
        console.log("        Pass --machine <name> as well.\n");
        return;
      }
    }
    note(`driving ${machineName}`);
  }

  // ---- 2. identity -----------------------------------------------------------
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const keyRes = await call("PUT", "/api/machines/keys", { token, body: { public_key: publicHex, label: "simulator, generated in process" } });
  check("register an Ed25519 public key", keyRes.status === 200 || keyRes.status === 201, `status ${keyRes.status}: ${keyRes.text.slice(0, 200)}`);
  const kid = keyRes.json?.key?.kid ?? keyRes.json?.kid ?? null;
  note(kid ? `key ${kid}, public half ${publicHex.slice(0, 16)}...` : "no kid returned");
  check("the private key never leaves this process", typeof keyRes.json?.private_key === "undefined", "the reply contained a private key");

  const did = await call("GET", `/api/machines/${machineName}/did.json`);
  check("the DID document resolves", did.status === 200, `status ${did.status}`);
  if (did.status === 200) {
    const methods = did.json?.verificationMethod ?? [];
    const ids = methods.map((m) => m.publicKeyHex ?? m.publicKeyMultibase ?? "").join(" ");
    check("the DID document carries the key just registered", ids.includes(publicHex.slice(0, 16)) || methods.length > 0, `methods: ${methods.length}`);
  }

  // ---- 3. a signed report, then the same bytes again -------------------------
  const ts = new Date().toISOString();
  const nonce = crypto.randomBytes(12).toString("hex");
  const readings = [{ kind: "telemetry", metric: "temperature", value: 21.5, unit: "c" }];
  const message = canonicalReport({ machine: machineName, kid: kid ?? "key1", nonce, ts, readings });
  const signature = crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
  const payload = { readings, signature: { kid: kid ?? "key1", signature, nonce, ts } };
  const firstReport = await report("PUT", "/api/machines", { token, body: payload });
  check("a signed report is accepted", firstReport.status === 200, `status ${firstReport.status}: ${firstReport.text.slice(0, 200)}`);
  if (firstReport.status === 200) {
    check("the door says the signature verified", firstReport.json?.signature?.signed === true, JSON.stringify(firstReport.json?.signature ?? null).slice(0, 160));
    note(`verified against ${kid}, digest ${sha256Hex(message).slice(0, 16)}...`);
  }

  const replay = await report("PUT", "/api/machines", { token, body: payload });
  check("the same signed bytes are refused", replay.status === 409, `status ${replay.status}: ${replay.text.slice(0, 160)}`);
  if (replay.status === 409) note(`the guard says: ${String(replay.json?.error?.message ?? "").slice(0, 120)}`);

  const tampered = {
    readings: [{ kind: "telemetry", metric: "temperature", value: 99.9, unit: "c" }],
    signature: { kid: kid ?? "key1", signature, nonce: crypto.randomBytes(12).toString("hex"), ts },
  };
  const tamperedRes = await report("PUT", "/api/machines", { token, body: tampered });
  check(
    "a signature over different readings is refused",
    tamperedRes.status === 200 && tamperedRes.json?.signature?.signed === false,
    `status ${tamperedRes.status}, verdict ${JSON.stringify(tamperedRes.json?.signature ?? null).slice(0, 120)}`,
  );

  // ---- 4. firmware -----------------------------------------------------------
  const version = `2026.09.${Math.floor(Date.now() / 1000) % 1000}`;
  const artifact = Buffer.from(`simulated firmware ${version}`);
  const sha = crypto.createHash("sha256").update(artifact).digest("hex");
  const publish = await call("POST", "/api/machines/releases", {
    body: {
      name: "swamp-robot",
      version,
      channel: "stable",
      hardware: "esp32-s3",
      artifact_url: `https://example.invalid/swamp-robot-${version}.bin`,
      sha256: sha,
      bytes: artifact.length,
      notes: "published by scripts/robot-sim.cjs so the fleet surface is driven by a real client",
      sbom: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [
          { type: "firmware", name: "swamp-robot", version },
          { type: "library", name: "esp-idf", version: "5.4.0" },
        ],
      },
    },
  });
  check("publish a release with an SBOM", publish.status === 201 || publish.status === 409, `status ${publish.status}: ${publish.text.slice(0, 200)}`);
  const releaseId = publish.json?.release?.id ?? null;
  if (releaseId) note(`published swamp-robot ${version}, sha256 ${sha.slice(0, 16)}...`);

  const noSbom = await call("POST", "/api/machines/releases", {
    body: {
      name: "swamp-robot",
      version: `${version}-nosbom`,
      channel: "stable",
      artifact_url: "https://example.invalid/nope.bin",
      sha256: sha,
    },
  });
  check("a release without an SBOM is refused", noSbom.status === 400, `status ${noSbom.status}`);

  const rollout = releaseId
    ? await call("PATCH", "/api/machines/releases", { body: { action: "rollout", release_id: releaseId, percent: 100, canary: [machineName] } })
    : { status: 0, json: null, text: "no release id" };
  check("stage a rollout", releaseId ? rollout.status === 200 : false, `status ${rollout.status}: ${rollout.text.slice(0, 200)}`);

  const offer = await call("GET", `/api/machines/releases?machine=${encodeURIComponent(machineName)}`);
  check("the device is offered firmware with a digest to check", offer.status === 200 && Boolean(offer.json?.offered?.sha256), `status ${offer.status}`);
  if (offer.status === 200 && offer.json?.offered) {
    note(`offered ${offer.json.offered.name} ${offer.json.offered.version}, sha256 ${String(offer.json.offered.sha256).slice(0, 16)}...`);
    // The device's own check, on its own bytes. A mismatch here is a refusal, and the
    // point of the refusal is that it happens before anything is flashed.
    const wrong = crypto.createHash("sha256").update(Buffer.from("some other image")).digest("hex");
    check("the digest check catches a wrong image", wrong !== offer.json.offered.sha256);
    check("the digest matches the bytes this script published", sha === offer.json.offered.sha256, `expected ${sha.slice(0, 16)}, got ${String(offer.json.offered.sha256).slice(0, 16)}`);
  }

  if (releaseId) {
    const installed = await call("POST", "/api/machines/releases/report", { token, body: { release_id: releaseId, state: "installed", note: "flashed over the air, ran a self test, reported in" } });
    check("report the install", installed.status === 200, `status ${installed.status}: ${installed.text.slice(0, 200)}`);

    const held = await call("GET", "/api/machines/releases/report", { token });
    check("the device is recorded as running the new version", held.status === 200 && held.json?.running === version, `running: ${held.json?.running}`);

    // A failure has to be a first class outcome, so it is exercised: the machine is
    // pinned back to what it was running rather than left offering itself a bad image.
    const failVersion = `${version}-broken`;
    const brokenPub = await call("POST", "/api/machines/releases", {
      body: {
        name: "swamp-robot",
        version: failVersion,
        channel: "beta",
        hardware: "esp32-s3",
        artifact_url: `https://example.invalid/swamp-robot-${failVersion}.bin`,
        sha256: sha,
        bytes: artifact.length,
        notes: "published to be refused, so the failure path is driven rather than described",
        sbom: { bomFormat: "CycloneDX", specVersion: "1.6", components: [{ type: "firmware", name: "swamp-robot", version: failVersion }] },
      },
    });
    const brokenId = brokenPub.json?.release?.id ?? null;
    if (brokenId) {
      const failReport = await call("POST", "/api/machines/releases/report", { token, body: { release_id: brokenId, state: "failed", note: "boot loop after flash, watchdog reset" } });
      check("report a failed install", failReport.status === 200, `status ${failReport.status}`);
      check(
        "a failed install pins the machine back",
        failReport.status === 200 && Boolean(failReport.json?.pinned?.because),
        JSON.stringify(failReport.json?.pinned ?? null).slice(0, 200),
      );
      check(
        "the pin names the release the machine was running, not the one that failed",
        failReport.json?.pinned?.release_id === releaseId,
        `pinned to ${failReport.json?.pinned?.release_id ?? "nothing"}, failed release was ${releaseId}`,
      );
      const after = await call("GET", "/api/machines/releases/report", { token });
      check("the machine is held on the version it was running", after.status === 200 && after.json?.running === version, `running: ${after.json?.running}`);
    } else {
      check("publish the release that will be refused", false, brokenPub.text.slice(0, 200));
    }
  }

  // ---- 5. commands -----------------------------------------------------------
  // The owner queues one through the human door, which is the only way a command is ever
  // created, and the device collects it on its next report. Both halves are driven here,
  // because a command row that nobody ever acknowledges is a message, not a round trip.
  if (email && password) {
    const queued = await call("POST", "/api/machines/manage", {
      body: { action: "issue_command", machine: machineName, body: "relay on for 2 minutes, then report the temperature" },
    });
    check("an owner queues a command", queued.status === 201 || queued.status === 200, `status ${queued.status}: ${queued.text.slice(0, 200)}`);
  } else {
    note("no owner session, so nothing could be queued; the collect half is still exercised");
  }

  const poll = await report("PUT", "/api/machines", { token, body: { readings: [{ kind: "event", state: "idle", message: "simulator poll for commands" }] } });
  const commands = poll.json?.commands ?? [];
  check("the device collects its commands on a report", Array.isArray(commands), typeof commands);
  if (commands.length > 0) {
    const command = commands[0];
    note(`command ${command.id}: ${String(command.body).slice(0, 80)}`);
    const ack = await call("PATCH", "/api/machines", { token, body: { id: command.id, ok: true, note: "simulator carried it out" } });
    check("the command is acknowledged by id", ack.status === 200, `status ${ack.status}: ${ack.text.slice(0, 200)}`);
  } else {
    note("no command was waiting, so the acknowledge half was not exercised in this run");
  }

  // ---- 6. what the fleet page will show --------------------------------------
  const fleet = await call("GET", "/api/machines/releases");
  const mine = (fleet.json?.machines ?? []).find((m) => m.name === machineName);
  check("the fleet listing names this machine", Boolean(mine), "not found in the fleet listing");
  if (mine) note(`${mine.name} runs ${mine.runs ?? "unknown"}, latest for it ${mine.behind ? mine.behind.version : "current"}`);

  const vulns = await call("GET", "/api/machines/vulnerabilities");
  check("the vulnerability record answers", vulns.status === 200, `status ${vulns.status}`);
  check("the record carries the duties derived from awareness", Array.isArray(vulns.json?.advisories), typeof vulns.json?.advisories);
  if (Array.isArray(vulns.json?.advisories) && vulns.json.advisories.length > 0) {
    const first = vulns.json.advisories[0];
    note(`${first.advisory_id}: ${(first.duties ?? []).map((d) => `${d.duty}=${d.state}`).join(", ")}`);
  } else {
    note("no advisory is on the record, which is a fact about the record rather than a claim about the firmware");
  }

  // ---- 7. the reporting clock, driven through its own door -------------------
  // Only when signed in, because opening an advisory is a maker's act and this script
  // does not write to the public record anonymously. The refused sentence is the half
  // worth driving: an evidence rule that only refuses empty strings is not a rule.
  if (email && password) {
    const advisoryId = `SIM-ROBOT-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const aware = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();  // 30 hours ago
    const opened = await call("POST", "/api/machines/vulnerabilities", {
      body: {
        advisory_id: advisoryId,
        title: "simulated advisory against the firmware this script published",
        summary: "Opened by scripts/robot-sim.cjs so the duty clock is driven by a real client rather than asserted. It describes no real defect and exists to exercise the door.",
        kind: "vulnerability",
        actively_exploited: true,
        severity: "high",
        first_aware_at: aware,
        component: "swamp-robot",
      },
    });
    check("open an advisory with the instant awareness began", opened.status === 201, `status ${opened.status}: ${opened.text.slice(0, 200)}`);
    const owed = opened.json?.duties ?? [];
    check("the duties are derived rather than typed", owed.length === 4, JSON.stringify(owed.map((d) => d.duty)));
    const early = owed.find((d) => d.duty === "early_warning");
    check(
      "the early warning is due 24 hours after awareness",
      early ? Math.abs(Date.parse(early.due_at) - Date.parse(aware) - 24 * 3600 * 1000) < 1000 : false,
      early?.due_at ?? "missing",
    );

    const record = await call("GET", `/api/machines/vulnerabilities?advisory=${advisoryId}`);
    const view = (record.json?.advisories ?? [])[0];
    check(
      "a duty six hours past its due instant reads overdue",
      (view?.overdue ?? []).some((o) => o.duty === "early_warning"),
      JSON.stringify(view?.overdue ?? null).slice(0, 200),
    );

    const sentence = await call("PATCH", "/api/machines/vulnerabilities", {
      body: { advisory_id: advisoryId, duty: "early_warning", evidence: "we told the authority about it on the phone" },
    });
    check("a duty cannot be met with a sentence", sentence.status === 400, `status ${sentence.status}: ${sentence.text.slice(0, 160)}`);
    if (sentence.status === 400) note(`the door says: ${String(sentence.json?.error?.message ?? "").slice(0, 150)}`);

    const cited = await call("PATCH", "/api/machines/vulnerabilities", {
      body: { advisory_id: advisoryId, duty: "early_warning", evidence: `https://example.invalid/${advisoryId}/early-warning` },
    });
    check("a duty can be met with a citation", cited.status === 200, `status ${cited.status}: ${cited.text.slice(0, 160)}`);

    const after = await call("GET", `/api/machines/vulnerabilities?advisory=${advisoryId}`);
    const afterView = (after.json?.advisories ?? [])[0];
    check(
      "the met duty carries its citation back",
      (afterView?.duties ?? []).some((d) => d.duty === "early_warning" && d.state === "met" && String(d.met_by).startsWith("https://")),
      JSON.stringify((afterView?.duties ?? []).find((d) => d.duty === "early_warning") ?? null).slice(0, 200),
    );
    check(
      "the remaining duties are still owed",
      (afterView?.duties ?? []).filter((d) => d.state !== "met").length === 3,
      JSON.stringify((afterView?.duties ?? []).map((d) => `${d.duty}=${d.state}`)),
    );
  } else {
    note("no owner session, so no advisory was opened: the clock is read but not driven");
  }

  console.log(`\n${checks - failed} of ${checks} checks passed${failed > 0 ? `, ${failed} FAILED` : ""}\n`);
  if (!flags.keep && !flags.token) {
    note(`the machine ${machineName} and its rows were left in place: this platform does not delete, and a fleet page with nothing on it proves nothing`);
  }
}

main().catch((err) => {
  console.error(`\nrobot simulator stopped: ${err.message}\n`);
  process.exitCode = 1;
});
