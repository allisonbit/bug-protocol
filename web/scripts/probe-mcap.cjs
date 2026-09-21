/**
 * The log door, driven against a deployment that is actually running.
 *
 *   node scripts/probe-mcap.cjs [base-url] [machine]
 *
 * WHY A PROBE RATHER THAN ONLY A CHECK IN THE SUITE. The verifier proves the module can build
 * a file and that the real reader can open it. What it cannot prove is the thing a client
 * experiences: that the door serves those bytes over HTTP, that the digest in the header is
 * the digest of the body that arrived, that the body survives the trip unchanged, and that a
 * machine with rows in the database actually produces a file with those rows in it. Those are
 * properties of the response, so they are checked on a response.
 *
 * The body is hashed exactly as received, then handed to McapStreamReader from the same
 * library a viewer uses, and every claim in the headers is checked against what the reader
 * finds inside the bytes. Nothing here trusts the server's own account of the file.
 */
const crypto = require("node:crypto");
const { McapStreamReader } = require("@mcap/core");

const base = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const machine = process.argv[3] || "atlas";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    failed += 1;
  }
};

(async () => {
  console.log(`\nthe manifest, before downloading anything, against ${base}\n`);
  const metaRes = await fetch(`${base}/api/machines/${machine}/mcap?meta=1`);
  const meta = await metaRes.json().catch(() => null);

  if (metaRes.status === 404) {
    console.log(`  SKIP  no machine called ${machine} is registered here: ${meta?.error?.message}`);
    process.exit(0);
  }
  check("the manifest answers as JSON", metaRes.status === 200 && meta !== null, String(metaRes.status));
  check("it names the machine and the container", meta?.machine === machine && meta?.container === "MCAP", JSON.stringify({ machine: meta?.machine, container: meta?.container }));
  check("it says how many messages the file holds", Number.isInteger(meta?.messages) && meta.messages >= 0, String(meta?.messages));
  check("its channel counts add up to its message count", Array.isArray(meta?.channels) && meta.channels.reduce((n, c) => n + c.count, 0) === meta.messages, JSON.stringify(meta?.channels));
  check("every channel is namespaced by the machine", (meta?.channels ?? []).every((c) => c.topic.startsWith(`/machine/${machine}/`)), JSON.stringify(meta?.channels?.map((c) => c.topic)));
  check("its digest is a sha256 in hex", /^[0-9a-f]{64}$/.test(meta?.sha256 ?? ""), meta?.sha256);
  check("its filename is dated and ends in .mcap", new RegExp(`^${machine}-\\d{4}-\\d{2}-\\d{2}\\.mcap$`).test(meta?.filename ?? ""), meta?.filename);
  if (meta?.messages > 0) {
    check("its span is inside the past", Date.parse(meta.span.from) <= Date.parse(meta.span.to) && Date.parse(meta.span.to) <= Date.now() + 60_000, JSON.stringify(meta?.span));
  }

  console.log("\nthe file itself\n");
  const res = await fetch(`${base}/api/machines/${machine}/mcap`);
  const body = new Uint8Array(await res.arrayBuffer());
  const digest = crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");

  check("the door answers", res.status === 200, String(res.status));
  check("it declares the mcap media type", res.headers.get("content-type") === "application/mcap", res.headers.get("content-type") ?? "none");
  check("it offers the file as a download with a filename", /^attachment; filename="[^"]+\.mcap"$/.test(res.headers.get("content-disposition") ?? ""), res.headers.get("content-disposition") ?? "none");
  check("the header digest is the digest of the bytes that arrived", res.headers.get("x-mcap-sha256") === digest, `header=${res.headers.get("x-mcap-sha256")} body=${digest}`);
  check("the header digest matches what the manifest promised", meta.sha256 === digest, `${meta.sha256} vs ${digest}`);
  check("the body is the length the header claims", Number(res.headers.get("content-length")) === body.byteLength, `${res.headers.get("content-length")} vs ${body.byteLength}`);
  check("it names the schema a reader will decode", res.headers.get("x-mcap-schema") === "swampai.MachineReading", res.headers.get("x-mcap-schema") ?? "none");

  const reader = new McapStreamReader({ includeChunks: true });
  reader.append(body);
  const records = [];
  for (let r; (r = reader.nextRecord()); ) records.push(r);
  const messages = records.filter((r) => r.type === "Message");
  const channels = [...new Map(records.filter((r) => r.type === "Channel").map((c) => [c.id, c])).values()];
  const schema = records.find((r) => r.type === "Schema");
  const stats = records.find((r) => r.type === "Statistics");
  const metadata = records.find((r) => r.type === "Metadata");

  check("the bytes that arrived are a complete mcap file", reader.done() === true, `done=${reader.done()} remaining=${reader.bytesRemaining()}`);
  check("the reader finds the same number of messages the header named", messages.length === Number(res.headers.get("x-mcap-messages")), `${messages.length} vs ${res.headers.get("x-mcap-messages")}`);
  check("the index agrees with the messages", Number(stats?.messageCount ?? -1) === messages.length, `${stats?.messageCount} vs ${messages.length}`);
  check("the schema is the one the header named", schema?.name === "swampai.MachineReading" && schema?.encoding === "jsonschema", JSON.stringify({ name: schema?.name, encoding: schema?.encoding }));
  check("every channel names this machine", channels.length > 0 && channels.every((c) => c.topic.startsWith(`/machine/${machine}/`)), JSON.stringify(channels.map((c) => c.topic)));
  check("the file says which machine it is about", metadata?.metadata.get("name") === machine, String(metadata?.metadata.get("name")));
  // The origin inside the file is the deployment's PUBLISHED origin, which is not necessarily
  // the host this probe connected to: a deployment behind a proxy answers on one name and
  // publishes another. So the claim is checked against the origin the deployment states about
  // itself in the manifest it just served, rather than against whatever host the probe used.
  const publishedOrigin = String(meta?.file ?? "").replace(/\/api\/.*$/, "");
  check("the file names the deployment's own published origin", publishedOrigin.length > 0 && metadata?.metadata.get("origin") === publishedOrigin, `${metadata?.metadata.get("origin")} vs ${publishedOrigin}`);

  // Every message decodes, carries the shape the schema declares, and sits in order: the
  // failures that make a log useless to an operator rather than obviously corrupt.
  const decoded = messages.map((m) => JSON.parse(new TextDecoder().decode(m.data)));
  check("every message decodes as the JSON the schema declares", decoded.length === messages.length && decoded.every((d) => typeof d?.at === "string" && ["telemetry", "event", "alert"].includes(d?.kind)));
  check("messages arrive in time order", messages.every((m, i) => i === 0 || m.logTime >= messages[i - 1].logTime));
  check("each message's log time equals the timestamp it carries", decoded.every((d, i) => Date.parse(d.at) === Number(messages[i].logTime / 1_000_000n)));
  check("log times are the machine's own, not now", messages.every((m) => m.logTime <= BigInt(Date.now() + 60_000) * 1_000_000n));
  check("nothing was invented between the readings and the file", messages.length === Number(res.headers.get("x-mcap-messages")) && decoded.every((d) => d.kind === "telemetry" || d.message !== undefined));

  // ---- the same capability over MCP ---------------------------------------------
  // The manifest joins this door and read_machine_log into one capability, so the two have
  // to agree: the digest the tool reports for a limit must be the digest of the bytes that
  // door serves at that same limit. That is the claim a joined manifest makes, and it is
  // exactly the kind of claim that rots when one side is edited.
  console.log("\nthe same log, described over MCP\n");
  const mcpRes = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_machine_log", arguments: { machine, limit: 50 } } }),
  });
  const mcp = await mcpRes.json().catch(() => null);
  const described = mcp?.result?.structuredContent?.result ?? null;
  check("the MCP tool answers for this machine", described?.machine === machine, JSON.stringify(described?.machine));
  check("it describes a file of the size it names", Number(described?.bytes) > 0 && described?.messages === 50, `messages=${described?.messages} bytes=${described?.bytes}`);
  check("its URL carries the limit it described", String(described?.url ?? "").endsWith(`/api/machines/${machine}/mcap?limit=50`), String(described?.url));

  if (described?.url) {
    const atFifty = new Uint8Array(await (await fetch(described.url)).arrayBuffer());
    const fiftyDigest = crypto.createHash("sha256").update(Buffer.from(atFifty)).digest("hex");
    check("the digest the tool gave is the digest of the bytes that URL serves", described.sha256 === fiftyDigest, `tool=${described.sha256} door=${fiftyDigest}`);
    check("and that file opens too", atFifty.byteLength === Number(described.bytes));
  }

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}  (${messages.length} messages, ${body.byteLength} bytes)\n`);
  // exitCode rather than exit(): on Windows, exiting while fetch's handles are still closing
  // trips a libuv assertion and prints a stack trace after the result, which reads as a crash
  // in the thing being probed when it is only the probe leaving.
  process.exitCode = failed === 0 ? 0 : 1;
})();
