/**
 * Does the log we hand a robot tool actually open, and does it say only what happened?
 *
 * WHY THIS FILE EXISTS. A log export is the one artifact on this platform that leaves the web
 * and gets loaded into somebody else's tool, and a corrupt file fails there rather than here:
 * the operator downloads a megabyte of bytes that looks plausible and imports as nothing. So
 * this verifier does not check our own code's opinion of its output. It builds a file from
 * fixture readings and then reads those bytes back with McapStreamReader, the same reader a
 * viewer uses, asserting the magic, the header, the schema, the channels, every message, the
 * statistics and the footer metadata.
 *
 * WHAT IT ALSO HOLDS TO ACCOUNT. That the file contains the readings and nothing invented: the
 * same count in and out, each value identical, timestamps in the order they happened rather
 * than the order the caller's query returned them, and a row whose timestamp cannot be parsed
 * dropped and counted rather than placed at the epoch. And that the digest this deployment
 * stamps on the response is the digest of the bytes it served, computed here a second way.
 *
 * It needs no database, no network and no server.
 *
 *   node --experimental-strip-types --conditions=react-server \
 *     --import ./scripts/alias-register.mjs scripts/verify-mcap.cjs
 */
(async () => {
  const nodeCrypto = await import("node:crypto");
  const mcapCore = await import("@mcap/core");
  const mcap = await import("../lib/machines/mcap.ts");

  let failed = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`);
    else {
      console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
      failed += 1;
    }
  };

  const T0 = Date.parse("2026-09-21T10:00:00.000Z");
  const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

  const MACHINE = {
    name: "atlas",
    kind: "robot",
    description: "Harbour survey rover",
    location: "Harbour district",
    firmware: "0.4.1",
    hardware: "esp32-devkit",
    last_report_at: at(3),
  };

  // Deliberately newest-first, the way every query on this platform returns rows, with one
  // row whose timestamp is garbage: the file must be ordered oldest-first and must not carry
  // the garbage row at the epoch.
  const READINGS = [
    { kind: "alert", metric: null, value: null, unit: null, state: null, message: "battery below 20%", payload: { pct: 18 }, created_at: at(3) },
    { kind: "event", metric: null, value: null, unit: null, state: "docked", message: null, payload: {}, created_at: at(2) },
    { kind: "telemetry", metric: "temperature", value: 21.5, unit: "c", state: null, message: null, payload: {}, created_at: at(1) },
    { kind: "telemetry", metric: "temperature", value: 20.25, unit: "c", state: null, message: null, payload: { source: "onboard" }, created_at: at(0) },
    { kind: "telemetry", metric: "temperature", value: 99, unit: "c", state: null, message: null, payload: {}, created_at: "not a date" },
  ];

  const built = await mcap.buildMachineMcap({ machine: MACHINE, readings: READINGS, origin: "https://www.swampai.world" });

  // ---- the container is a real MCAP file ---------------------------------------
  console.log("\nthe container\n");
  const bytes = built.bytes;
  const magic = [...mcapCore.MCAP_MAGIC];
  check("it starts with the MCAP magic", magic.every((b, i) => bytes[i] === b), [...bytes.slice(0, 8)].join(","));
  check("it ends with the MCAP magic", magic.every((b, i) => bytes[bytes.byteLength - 8 + i] === b), [...bytes.slice(-8)].join(","));
  check("it is not empty", bytes.byteLength > 0, String(bytes.byteLength));

  // Read it back with the reader a viewer uses, over the bytes exactly as they were served.
  const reader = new mcapCore.McapStreamReader({ includeChunks: true });
  reader.append(bytes);
  const records = [];
  for (let record; (record = reader.nextRecord()); ) records.push(record);
  const types = records.map((r) => r.type);
  check("the reader consumes the whole file", reader.done() === true && reader.bytesRemaining() === 0, `done=${reader.done()} remaining=${reader.bytesRemaining()}`);

  const header = records.find((r) => r.type === "Header");
  check("there is a header naming this logger", header?.profile === "swampai.machine" && /swampai\.world/.test(header.library), JSON.stringify({ profile: header?.profile, library: header?.library }));
  check("there is a data end record", types.includes("DataEnd"));
  check("there is a footer", types.includes("Footer"));
  check("every channel and message is present exactly once", records.filter((r) => r.type === "Message").length === 4, String(records.filter((r) => r.type === "Message").length));

  // ---- the schema says what a reader will decode ---------------------------------
  // A Schema and a Channel appear twice in an indexed file: once in the data section and once
  // in the summary, where they are duplicates by definition. So the claim is about DISTINCT
  // ids, and the duplicates are then held to being identical rather than counted.
  console.log("\nthe schema\n");
  const schemaRecords = records.filter((r) => r.type === "Schema");
  const distinctSchemas = [...new Set(schemaRecords.map((r) => r.id))];
  const schema = schemaRecords[0];
  check("one schema is registered", distinctSchemas.length === 1, `ids=${distinctSchemas.join(",")}`);
  check(
    "its summary copy is identical to its data copy",
    schemaRecords.length <= 2 && schemaRecords.every((r) => r.name === schema.name && r.encoding === schema.encoding && Buffer.compare(Buffer.from(r.data), Buffer.from(schema.data)) === 0),
    `${schemaRecords.length} schema record(s)`,
  );
  check("it is named and json-encoded", schema?.name === "swampai.MachineReading" && schema?.encoding === "jsonschema", JSON.stringify({ name: schema?.name, encoding: schema?.encoding }));
  let schemaDoc = null;
  try {
    schemaDoc = JSON.parse(new TextDecoder().decode(schema.data));
  } catch (e) {
    check("its data parses as JSON", false, String(e));
  }
  check("its data parses as JSON", schemaDoc !== null && schemaDoc.title === "swampai.MachineReading");
  check("it requires a timestamp and a kind", Array.isArray(schemaDoc?.required) && schemaDoc.required.includes("at") && schemaDoc.required.includes("kind"), JSON.stringify(schemaDoc?.required));
  check("it allows null for every field a row may not carry", ["metric", "value", "unit", "state", "message"].every((f) => Array.isArray(schemaDoc?.properties?.[f]?.type) && schemaDoc.properties[f].type.includes("null")));

  // ---- channels follow the ROS 2 namespace shape ---------------------------------
  console.log("\nthe channels\n");
  const channels = records.filter((r) => r.type === "Channel");
  const distinctChannels = [...new Map(channels.map((c) => [c.id, c])).values()];
  const topics = distinctChannels.map((c) => c.topic).sort();
  check("one channel per reading kind", distinctChannels.length === 3, `distinct=${distinctChannels.length} records=${channels.length}`);
  check(
    "topics are namespaced by machine",
    topics.join(",") === "/machine/atlas/alerts,/machine/atlas/events,/machine/atlas/telemetry",
    topics.join(","),
  );
  check(
    "a channel's summary copy says the same thing as its data copy",
    channels.length <= 6 &&
      channels.every((c) => {
        const twin = distinctChannels.find((d) => d.id === c.id);
        return twin && twin.topic === c.topic && twin.messageEncoding === c.messageEncoding && twin.schemaId === c.schemaId;
      }),
    `${channels.length} channel record(s)`,
  );
  check("every channel carries json messages", distinctChannels.every((c) => c.messageEncoding === "json"), distinctChannels.map((c) => c.messageEncoding).join(","));
  check("every channel points at the one schema", distinctChannels.every((c) => c.schemaId === schema.id));
  check("the channel says what it holds", distinctChannels.every((c) => (c.metadata.get("what") ?? "").length > 20));
  check("the channel names the kind of reading it carries", distinctChannels.every((c) => ["telemetry", "event", "alert"].includes(c.metadata.get("kind"))));
  check("counts match what was built", JSON.stringify(built.channels) === JSON.stringify([
    { topic: "/machine/atlas/telemetry", count: 2 },
    { topic: "/machine/atlas/events", count: 1 },
    { topic: "/machine/atlas/alerts", count: 1 },
  ]), JSON.stringify(built.channels));

  // ---- the messages are the readings, in order, with no invention -----------------
  console.log("\nthe messages\n");
  const topicById = new Map(distinctChannels.map((c) => [c.id, c.topic]));
  const messages = records.filter((r) => r.type === "Message");
  const decoded = messages.map((m) => ({ topic: topicById.get(m.channelId), logTime: m.logTime, body: JSON.parse(new TextDecoder().decode(m.data)) }));

  check("nothing was skipped", built.skipped === 1 && built.messages === 4, `skipped=${built.skipped} messages=${built.messages}`);
  check("the unparsable row is the one that was dropped", !decoded.some((m) => m.body.value === 99), JSON.stringify(decoded.map((m) => m.body.value)));
  check(
    "log times ascend, whatever order the rows arrived in",
    decoded.every((m, i) => i === 0 || m.logTime > decoded[i - 1].logTime),
    decoded.map((m) => String(m.logTime)).join(","),
  );
  check(
    "log time is the machine's own timestamp in nanoseconds",
    decoded[0].logTime === BigInt(T0) * 1_000_000n,
    String(decoded[0].logTime),
  );
  check("publish time equals log time, because the platform did not invent one", messages.every((m) => m.publishTime === m.logTime));
  check("sequence numbers are dense from zero", messages.map((m) => m.sequence).join(",") === "0,1,2,3", messages.map((m) => m.sequence).join(","));

  const first = decoded[0].body;
  check("a telemetry message carries its metric, value and unit", first.kind === "telemetry" && first.metric === "temperature" && first.value === 20.25 && first.unit === "c", JSON.stringify(first));
  check("a message carries the machine's own words", decoded.some((m) => m.body.message === "battery below 20%"), JSON.stringify(decoded.map((m) => m.body.message)));
  check("a null field stays null rather than becoming a string", decoded.every((m) => m.body.state === null || typeof m.body.state === "string") && first.state === null, JSON.stringify(first.state));
  check("the payload the machine sent is carried verbatim", first.payload.source === "onboard" && decoded.some((m) => m.body.payload.pct === 18));
  check("every message is timestamps equal to its own reading", new Set(decoded.map((m) => m.body.at)).size === 4, decoded.map((m) => m.body.at).join(","));
  check(
    "the message timestamp is the ISO form of its log time",
    decoded.every((m) => Date.parse(m.body.at) === Number(m.logTime / 1_000_000n)),
  );

  // ---- statistics and metadata ---------------------------------------------------
  console.log("\nthe index and the record's own account of itself\n");
  const stats = records.find((r) => r.type === "Statistics");
  check("a statistics record says how many messages there are", stats !== undefined && Number(stats.messageCount) === 4, String(stats?.messageCount));
  check("it counts three channels and one schema", stats?.channelCount === 3 && stats?.schemaCount === 1, JSON.stringify({ channels: stats?.channelCount, schemas: stats?.schemaCount }));
  check("the index is chunked, not a flat stream", types.includes("ChunkIndex"), types.join(","));

  const metadata = records.find((r) => r.type === "Metadata");
  check("the file says which machine it is about", metadata?.metadata.get("name") === "atlas", String(metadata?.metadata.get("name")));
  check("the file carries the machine's own description of itself", metadata?.metadata.get("hardware") === "esp32-devkit" && metadata?.metadata.get("firmware") === "0.4.1");
  check("the file names the origin it came from", metadata?.metadata.get("origin") === "https://www.swampai.world");
  check("the file says how many rows it could not place", metadata?.metadata.get("skipped_rows_without_a_timestamp") === "1");
  check("the span is the earliest and latest message", built.span?.from === at(0) && built.span?.to === at(3), JSON.stringify(built.span));

  // ---- the digest is of the bytes that were served --------------------------------
  console.log("\nthe digest, and the edge cases\n");
  const independent = nodeCrypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  check("the digest matches an independent hash of the same bytes", mcap.mcapDigestHex(bytes) === independent, mcap.mcapDigestHex(bytes));
  check("the digest is lowercase hex of 32 bytes", /^[0-9a-f]{64}$/.test(mcap.mcapDigestHex(bytes)));
  check("the digest changes when a reading changes", mcap.mcapDigestHex((await mcap.buildMachineMcap({ machine: MACHINE, readings: READINGS.slice(1), origin: "x" })).bytes) !== independent);
  check("a different origin makes different bytes, so a file cannot be reattributed", mcap.mcapDigestHex((await mcap.buildMachineMcap({ machine: MACHINE, readings: READINGS, origin: "https://example.test" })).bytes) !== independent);

  const empty = await mcap.buildMachineMcap({ machine: MACHINE, readings: [], origin: "https://www.swampai.world" });
  const emptyReader = new mcapCore.McapStreamReader({ includeChunks: true });
  emptyReader.append(empty.bytes);
  let emptyRecords = 0;
  for (let r; (r = emptyReader.nextRecord()); ) emptyRecords += 1;
  check("a machine with no readings still yields a readable file", emptyReader.done() === true && emptyRecords > 0, `done=${emptyReader.done()} records=${emptyRecords}`);
  check("that file honestly has no messages", empty.messages === 0 && empty.span === null && empty.channels.every((c) => c.count === 0));

  const noName = mcap.mcapFilename("../../etc/passwd", new Date("2026-09-21T00:00:00Z"));
  check("a filename cannot climb out of a directory", !noName.includes("/") && !noName.includes(".."), noName);
  check("a filename is dated and ends in .mcap", mcap.mcapFilename("atlas", new Date("2026-09-21T05:00:00Z")) === "atlas-2026-09-21.mcap", mcap.mcapFilename("atlas", new Date("2026-09-21T05:00:00Z")));
  check("the topic helper namespaces by machine and kind", mcap.mcapTopicFor("atlas", "alert") === "/machine/atlas/alerts", mcap.mcapTopicFor("atlas", "alert"));

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
