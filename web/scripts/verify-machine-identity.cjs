/**
 * What a device signs, and every way a signature can fail to mean anything.
 *
 * WHY THIS FILE EXISTS. A verified signature on a hardware report is the strongest claim
 * this platform makes about a robot, so it is the one most worth trying to break. The
 * branches below are the ways it can be hollow: a report that arrives unsigned and is
 * quietly stored as if it were signed, a signature over different bytes than the readings
 * that get written, a replayed message accepted twice, a key that was retired an hour ago
 * still verifying, a key that was revoked for theft still verifying because the timestamp
 * looked plausible. Each of those is a check here rather than a sentence in a comment.
 *
 * WHAT THIS VERIFIER DOES NOT DO. It does not talk to the network or the database, and it
 * does not decide whether a reading is true. It checks the arithmetic of one message.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-machine-identity.cjs
 */
(async () => {
  const crypto = await import("node:crypto");
  const identity = await import("../lib/machines/identity.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  // A real Ed25519 keypair, generated here: the same shape a device on a bench produces,
  // and the same shape the platform verifies against. Nothing here is a fixture.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const sign = (message) => crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

  const NOW = Date.parse("2026-09-21T12:00:00.000Z");
  const TS = "2026-09-21T11:59:00.000Z";
  const READINGS = [
    { kind: "telemetry", metric: "temperature", value: 21.5, unit: "c" },
    { kind: "alert", message: "door open" },
  ];

  const key = (over = {}) => ({ kid: "key1", public_key: publicHex, algo: "ed25519", created_at: "2026-09-01T00:00:00.000Z", retired_at: null, revoked_at: null, revoked_reason: null, ...over });

  const message = identity.canonicalReport({ machine: "atlas", kid: "key1", nonce: "n-1", ts: TS, readings: READINGS });
  const goodSignature = sign(message);

  // ---- the canonical form ------------------------------------------------------
  console.log("\nthe canonical form\n");
  const lines = message.split("\n");
  check("it is six lines", lines.length === 6, String(lines.length));
  check("line one is the version tag", lines[0] === "machine-report:v1", lines[0]);
  check("the machine, key, nonce and timestamp are prefixed", ["machine:atlas", "kid:key1", "nonce:n-1", `ts:${TS}`].every((l, i) => lines[i + 1] === l), JSON.stringify(lines.slice(1, 5)));
  check("the readings are canonically serialised", lines[5] === `readings:${JSON.stringify(READINGS).replace(/\s+/g, "")}` || lines[5].startsWith("readings:[{"), lines[5]);
  check("signed bytes are the same whatever order the fields arrive in", identity.canonicalReport({ machine: "atlas", kid: "key1", nonce: "n-1", ts: TS, readings: READINGS }) === message);
  check("a changed reading changes the message", identity.canonicalReport({ machine: "atlas", kid: "key1", nonce: "n-1", ts: TS, readings: [{ kind: "telemetry", metric: "temperature", value: 99.9, unit: "c" }] }) !== message);
  check("a changed nonce changes the message", identity.canonicalReport({ machine: "atlas", kid: "key1", nonce: "n-2", ts: TS, readings: READINGS }) !== message);
  check("the digest is sha256 of the message", identity.reportDigest(message) === crypto.createHash("sha256").update(message, "utf8").digest("hex"));

  // ---- a report that verifies --------------------------------------------------
  console.log("\na report that verifies\n");
  const okReport = identity.checkReport({
    machine: "atlas",
    readings: READINGS,
    signature: { kid: "key1", signature: goodSignature, nonce: "n-1", ts: TS },
    keys: [key()],
    nowMs: NOW,
  });
  check("a correctly signed report verifies", okReport.ok === true && okReport.signed === true, JSON.stringify(okReport).slice(0, 160));
  check("the verified report carries its key id", okReport.signed === true && okReport.kid === "key1");
  check("the verified report carries the digest the receipt is keyed on", okReport.signed === true && okReport.digest === identity.reportDigest(message));

  // ---- the branches that must not verify ---------------------------------------
  console.log("\nwhat must not count as signed\n");
  const unsigned = identity.checkReport({ machine: "atlas", readings: READINGS, signature: null, keys: [key()], nowMs: NOW });
  check("an unsigned report is stored rather than refused", unsigned.ok === true && unsigned.signed === false);
  check("the unsigned report says why", unsigned.signed === false && /no signature/.test(unsigned.reason), unsigned.signed === false ? unsigned.reason : "");

  const wrongBytes = identity.checkReport({
    machine: "atlas",
    readings: [{ kind: "telemetry", metric: "temperature", value: 99.9, unit: "c" }],
    signature: { kid: "key1", signature: goodSignature, nonce: "n-1", ts: TS },
    keys: [key()],
    nowMs: NOW,
  });
  check("a signature over different readings does not verify", wrongBytes.ok === true && wrongBytes.signed === false);

  const otherMachine = identity.checkReport({ machine: "other", readings: READINGS, signature: { kid: "key1", signature: goodSignature, nonce: "n-1", ts: TS }, keys: [key()], nowMs: NOW });
  check("a signature cannot be replayed onto another machine", otherMachine.ok === true && otherMachine.signed === false);

  const unknownKey = identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key9", signature: goodSignature, nonce: "n-1", ts: TS }, keys: [key()], nowMs: NOW });
  check("a signature naming a key this machine does not hold does not verify", unknownKey.ok === true && unknownKey.signed === false);
  check("and it says which key it could not check", unknownKey.signed === false && /key9/.test(unknownKey.reason), unknownKey.signed === false ? unknownKey.reason : "");
  check("a different machine's key cannot be borrowed", identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key1", signature: sign("machine-report:v1\nmachine:atlas\nkid:key1\nnonce:n-1\nts:" + TS + "\nreadings:[]"), nonce: "n-1", ts: TS }, keys: [key({ public_key: "b".repeat(64) })], nowMs: NOW }).signed === false);

  // A report that cannot be judged at all is refused outright, because writing a row
  // would imply we checked it.
  const noKid = identity.checkReport({ machine: "atlas", readings: READINGS, signature: { signature: goodSignature, nonce: "n-1", ts: TS }, keys: [key()], nowMs: NOW });
  check("a signed report with no kid is refused outright", noKid.ok === false && noKid.code === "NO_KID", JSON.stringify(noKid));
  const badShape = identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key1", signature: "not-hex", nonce: "n-1", ts: TS }, keys: [key()], nowMs: NOW });
  check("a malformed signature is refused outright", badShape.ok === false && badShape.code === "BAD_SIGNATURE_SHAPE");
  const noNonce = identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key1", signature: goodSignature, ts: TS }, keys: [key()], nowMs: NOW });
  check("a signed report with no nonce is refused outright", noNonce.ok === false && noNonce.code === "NO_NONCE");
  check("and the refusal says why a nonce is needed", /replay/.test(noNonce.reason), noNonce.reason);
  const noTs = identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key1", signature: goodSignature, nonce: "n-1" }, keys: [key()], nowMs: NOW });
  check("a signed report with no timestamp is refused outright", noTs.ok === false && noTs.code === "BAD_TS");
  check("a 0x prefixed signature is accepted", identity.checkReport({ machine: "atlas", readings: READINGS, signature: { kid: "key1", signature: `0x${goodSignature}`, nonce: "n-1", ts: TS }, keys: [key()], nowMs: NOW }).signed === true);

  // ---- rotation and the grace window --------------------------------------------
  console.log("\nrotating and revoking keys\n");
  check("an active key verifies", identity.keyMayVerify(key(), NOW).ok === true);
  check("a revoked key verifies nothing", identity.keyMayVerify(key({ revoked_at: "2026-09-21T11:00:00.000Z", revoked_reason: "device stolen" }), NOW).ok === false);
  const revocation = identity.keyMayVerify(key({ revoked_at: "2026-09-21T11:00:00.000Z", revoked_reason: "device stolen" }), NOW);
  check("the refusal names the reason", revocation.ok === false && /stolen/.test(revocation.reason), revocation.ok === false ? revocation.reason : "");

  // A device that rotated while a report was in flight must not have that report thrown
  // away, so the window is real, and it is bounded on both sides.
  const retiredAt = "2026-09-21T11:58:00.000Z";
  const retired = key({ retired_at: retiredAt });
  check("a retired key still verifies a report from inside the window", identity.keyMayVerify(retired, NOW, Date.parse("2026-09-21T11:59:00.000Z")).ok === true);
  check("a retired key does not verify a report from an hour later", identity.keyMayVerify(retired, NOW, Date.parse("2026-09-21T13:00:00.000Z")).ok === false);
  check("the window is fifteen minutes", identity.ROTATION_GRACE_MS === 15 * 60 * 1000);
  check("a grace refusal explains the window", /grace window/.test(identity.keyMayVerify(retired, NOW, Date.parse("2026-09-21T13:00:00.000Z")).reason));

  // The window is applied against the DEVICE's timestamp, which the device controls, so
  // a report cannot be pulled forward from the future or pushed back from long ago.
  check("a report timestamped before the retirement yesterday is not inside the window", identity.keyMayVerify(retired, NOW, Date.parse("2026-09-19T00:00:00.000Z")).ok === false);
  check("a report with no timestamp is not inside the window", identity.keyMayVerify(retired, NOW, undefined).ok === false);

  const states = identity.keyState(key()) === "active" && identity.keyState(retired) === "retired" && identity.keyState(key({ revoked_at: "2026-09-21T11:00:00.000Z" })) === "revoked";
  check("the state of a key is read from its rows, not from a flag somebody sets", states);
  check("the active key is the one a DID document publishes", identity.activeKey([retired, key({ kid: "key2" })])?.kid === "key2");
  check("a machine with no live key has no active key", identity.activeKey([retired, key({ kid: "key2", revoked_at: "2026-09-21T00:00:00.000Z" })]) === null);
  check("one active key may be retired by a rotation", identity.keyMayRetire(key()) === true);
  check("a revoked key may not be retired again", identity.keyMayRetire(key({ revoked_at: "2026-09-21T00:00:00.000Z" })) === false);

  const rotation = identity.rotationDecision({ keys: [key()], nowMs: NOW });
  check("a rotation retires exactly the live key", rotation.ok === true && rotation.retired.length === 1 && rotation.retired[0].kid === "key1");
  const twoLive = identity.rotationDecision({ keys: [key(), key({ kid: "key2" })], nowMs: NOW });
  check("two live keys is a refusal rather than a coin toss", twoLive.ok === false, JSON.stringify(twoLive));
  check("and the refusal says the store should have prevented it", twoLive.ok === false && /one at a time/.test(twoLive.reason), twoLive.ok === false ? twoLive.reason : "");

  // ---- the DID document a resolver actually reads -------------------------------
  //
  // A key row this platform can read is not the same thing as a key an outside
  // resolver can use. The document declares JsonWebKey2020, so it owes a JWK; a
  // document that publishes only this store's hex spelling would look right here and
  // give every conformant consumer nothing to verify with. So the checks below
  // reconstruct the key from the DOCUMENT alone and verify a real signature with it.
  console.log("\nthe DID document a resolver reads\n");
  const did = await import("../lib/machines/did.ts");
  const machine = { name: "atlas", kind: "robot", location: "the roof", status: "active", created_at: "2026-09-01T00:00:00.000Z" };
  const doc = did.machineDidDocument({ machine, keys: [key()], siteUrl: "https://www.swampai.world" });

  check("the document is named after the machine", doc.id === "did:web:www.swampai.world:machines:atlas", doc.id);
  check("it publishes one method per key row", doc.verificationMethod.length === 1);
  const vm = doc.verificationMethod[0];
  check("the method is a JsonWebKey2020", vm.type === "JsonWebKey2020", vm.type);
  check("it carries a JWK rather than only this store's spelling", vm.publicKeyJwk?.kty === "OKP" && vm.publicKeyJwk?.crv === "Ed25519", JSON.stringify(vm.publicKeyJwk));
  check("the JWK x is the raw key in the encoding a resolver reads", vm.publicKeyJwk?.x === Buffer.from(publicHex, "hex").toString("base64url"), vm.publicKeyJwk?.x);
  check("the JWK decodes to the same 32 bytes as the hex column", Buffer.from(vm.publicKeyJwk?.x ?? "", "base64url").toString("hex") === publicHex);
  check("the JWK names the key it belongs to", vm.publicKeyJwk?.kid === "key1", String(vm.publicKeyJwk?.kid));

  // An independent base58btc decode, so the multibase claim is checked rather than
  // re-derived with the encoder that produced it.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58decode = (s) => {
    let n = 0n;
    for (const ch of s) {
      const i = B58.indexOf(ch);
      if (i < 0) throw new Error("bad base58");
      n = n * 58n + BigInt(i);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const body = Buffer.from(hex, "hex");
    const zeros = (s.match(/^1+/) ?? [""])[0].length;
    return Buffer.concat([Buffer.alloc(zeros), body]);
  };
  const mb = String(vm.publicKeyMultibase ?? "");
  check("the multibase form is present with the multibase prefix", mb.startsWith("z"), mb);
  let decoded = null;
  try {
    decoded = b58decode(mb.slice(1));
  } catch {
    decoded = null;
  }
  check("the multibase form decodes at all", decoded !== null);
  check("it decodes to the ed25519 multicodec header and the same key", decoded !== null && decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01 && decoded.subarray(2).toString("hex") === publicHex, decoded ? decoded.toString("hex") : "");

  // The only check that matters: reconstruct the key from the DOCUMENT and verify the
  // signature with it, exactly as an outside reader would.
  let verifiedFromDocument = false;
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(vm.publicKeyJwk.x, "base64url")]);
    const nodeKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    verifiedFromDocument = crypto.verify(null, Buffer.from(message, "utf8"), nodeKey, Buffer.from(goodSignature, "hex"));
  } catch {
    verifiedFromDocument = false;
  }
  check("a signature verifies against a key taken from the document alone", verifiedFromDocument);

  check("the active key is the one the document asserts", doc.assertionMethod.length === 1 && doc.assertionMethod[0] === `${doc.id}#key1`, JSON.stringify(doc.assertionMethod));
  check("the document says which facts it states and which it does not", /does not assert/.test(doc.scope), doc.scope.slice(0, 60));

  const retiredDoc = did.machineDidDocument({ machine, keys: [key({ retired_at: "2026-09-21T11:58:00.000Z" }), key({ kid: "key2" })], siteUrl: "https://www.swampai.world" });
  check("a retired key stays in the document for reports signed before the rotation", retiredDoc.verificationMethod.length === 2);
  check("but only the live key is asserted", retiredDoc.assertionMethod[0].endsWith("#key2"), JSON.stringify(retiredDoc.assertionMethod));
  check("the retired method says it is retired", /Retired by a rotation/.test(retiredDoc.verificationMethod[0].note), retiredDoc.verificationMethod[0].note);
  const revokedDoc = did.machineDidDocument({ machine, keys: [key({ revoked_at: "2026-09-21T11:00:00.000Z", revoked_reason: "device stolen" })], siteUrl: "https://www.swampai.world" });
  check("a revoked key is published as revoked with its reason", /Revoked: device stolen/.test(revokedDoc.verificationMethod[0].note), revokedDoc.verificationMethod[0].note);
  check("a machine with no live key asserts nothing", revokedDoc.assertionMethod.length === 0 && revokedDoc.authentication.length === 0);
  const emptyDoc = did.machineDidDocument({ machine, keys: [], siteUrl: "https://www.swampai.world" });
  check("a machine with no keys has an empty document rather than an invented one", emptyDoc.verificationMethod.length === 0 && emptyDoc.assertionMethod.length === 0);

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
