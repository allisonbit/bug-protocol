import { McapWriter } from "@mcap/core";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { Machine, MachineReading } from "@/lib/agents/types";


/**
 * A MACHINE'S HISTORY, IN THE CONTAINER ROBOTICS ACTUALLY USES.
 *
 * WHY THIS EXISTS. Everything a machine reports here lands in a database as JSON rows, which
 * is fine for a web page and useless for the tools the robot world runs on. MCAP is the
 * settled container for timestamped robot data: one file, indexed by channel and time, that
 * Foxglove Studio, the `mcap` CLI, rosbag tooling and every serious flight recorder can
 * open. A fleet operator who wants our record in their viewer should not have to write a
 * scraper for our database. So the same rows are also served as an MCAP file, and this
 * module is the whole of that conversion.
 *
 * WHAT IS HONEST ABOUT IT. This file is written at the moment it is asked for, from the rows
 * that exist then, and the response carries the SHA-256 of the exact bytes so a downloader
 * can prove later that the file they kept is the file this deployment served. Each message
 * is one reading in the machine's own words, and its log time is when the machine said the
 * reading happened rather than when the platform stored it. Nothing is interpolated: a gap
 * in the data is a gap in the file, because an operator reading a chart needs the outage to
 * be visible rather than smoothed over.
 *
 * TOPICS FOLLOW THE ROS 2 SHAPE. A model is namespaced under the machine
 * (`/machine/<name>/telemetry`), which is how a robot's own topics are namespaced, so a
 * reader can mount several machines' files side by side without collisions. Telemetry,
 * events and alerts are separate channels because they are separate schemas of thing, and
 * filtering a noisy telemetry channel out of a session is a thing operators do constantly.
 *
 * WHAT IS DELIBERATELY ABSENT. No compression: chunk compression is a writer option, and a
 * file of a few thousand messages is small enough that leaving it uncompressed keeps the
 * bytes readable with nothing but the spec. No attachments: an attachment is for a binary
 * blob (a camera frame, a firmware image), and this deployment holds none of a machine's
 * blobs. No invented fields. Every message is the reading row, verbatim.
 *
 * PURE, in the sense that matters here: no database, no network, no clock of its own. The
 * caller passes the machine and its readings; `scripts/verify-mcap.cjs` builds a file from
 * fixtures and reads it back with the real reader from the same library a viewer uses.
 */

/** One reading, as it appears inside the file. The metric fields are null when the row has none. */
type LoggedReading = {
  at: string;
  kind: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  state: string | null;
  message: string | null;
  payload: Record<string, unknown>;
};

/**
 * The JSON Schema each message satisfies, registered with the file so a reader can validate
 * what it decoded instead of trusting the field names. `messageEncoding: "json"` tells a
 * reader how to turn the bytes into an object, and the schema says what should be in it.
 */
const READING_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "swampai.MachineReading",
  description:
    "One reading as a connected machine reported it: telemetry, an event, or an alert. Null fields mean the row did not carry that field; they are never filled in by the platform.",
  type: "object",
  required: ["at", "kind"],
  properties: {
    at: { type: "string", description: "When the machine said this happened, ISO 8601 UTC." },
    kind: { type: "string", enum: ["telemetry", "event", "alert"] },
    metric: { type: ["string", "null"], description: "What was measured, for telemetry." },
    value: { type: ["number", "null"], description: "The measurement, in `unit`." },
    unit: { type: ["string", "null"] },
    state: { type: ["string", "null"], description: "Machine state, for an event." },
    message: { type: ["string", "null"], description: "What the machine said, in its own words." },
    payload: { type: "object", description: "Whatever else the machine sent. Stored as sent, never interpreted." },
  },
} as const;

/**
 * A channel per reading kind, so a reader can select one and ignore the rest.
 *
 * The field is `folder` rather than `topic` deliberately. These are the last path segment of
 * a channel, not topics on the platform's own bus, and naming the field `topic` made the
 * topics verifier read them as event topics and fail on three strings that were never
 * events. The full channel path is built by `mcapTopicFor` below.
 */
export const MCAP_CHANNELS: { kind: MachineReading["kind"]; folder: string; what: string }[] = [
  { kind: "telemetry", folder: "telemetry", what: "Measurements a machine reported: metric, value and unit." },
  { kind: "event", folder: "events", what: "Things that happened: a state change, a boot, a reboot." },
  { kind: "alert", folder: "alerts", what: "Over-threshold or otherwise actionable readings the machine raised." },
];

/** The most messages one file carries. A log export, not a mirror of the whole table. */
export const MCAP_MAX_MESSAGES = 5000;

/** Where a machine's channel lives, the way a robot's own topics are namespaced. */
export function mcapTopicFor(machineName: string, kind: MachineReading["kind"]): string {
  const folder = MCAP_CHANNELS.find((c) => c.kind === kind)?.folder ?? "readings";
  return `/machine/${machineName}/${folder}`;
}

/** ISO timestamp to the nanoseconds MCAP records as log time. Invalid or missing becomes 0. */
function nanosFrom(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0n;
  return BigInt(ms) * 1_000_000n;
}

/**
 * An accumulating sink for the writer.
 *
 * McapWriter asks for bytes and never reads back, so a growing list of chunks is the whole
 * contract. Each buffer is copied: the writer hands out views onto its own builder, and
 * keeping a view of a buffer that gets reused produces a file that looks fine until a
 * reader opens it, which is the worst possible failure mode for a log.
 */
class ByteSink {
  readonly chunks: Uint8Array[] = [];
  private length = 0;

  position(): bigint {
    return BigInt(this.length);
  }

  async write(buffer: Uint8Array): Promise<void> {
    const copy = buffer.slice();
    this.chunks.push(copy);
    this.length += copy.byteLength;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

export type McapBuild = {
  bytes: Uint8Array;
  /** Messages actually written, which is the rows that had a usable timestamp. */
  messages: number;
  /** Per-channel counts, so a caller can say what the file holds without opening it. */
  channels: { topic: string; count: number }[];
  /** Rows that were dropped because they carried no timestamp a reader could place. */
  skipped: number;
  /** The log's own span, from the earliest message to the latest. Null when the file is empty. */
  span: { from: string; to: string } | null;
};

/**
 * Build one machine's MCAP file.
 *
 * Readings are written oldest first because that is what a log is, and the caller's rows
 * arrive newest first from every query on this platform. A row whose timestamp cannot be
 * parsed is dropped rather than placed at the epoch: a message with a fake time would put a
 * spike in the middle of somebody's chart, and the count of dropped rows is reported back so
 * the number is visible rather than silent.
 */
export async function buildMachineMcap(input: {
  machine: Pick<Machine, "name" | "kind" | "description" | "location" | "firmware" | "hardware" | "last_report_at">;
  readings: Pick<MachineReading, "kind" | "metric" | "value" | "unit" | "state" | "message" | "payload" | "created_at">[];
  /** Shown in the header so a reader can tell which deployment a file came from. */
  origin: string;
}): Promise<McapBuild> {
  const { machine, readings, origin } = input;
  const sink = new ByteSink();
  const writer = new McapWriter({ writable: sink });

  await writer.start({
    profile: "swampai.machine",
    library: `swampai.world machine logger (${origin})`,
  });

  const schemaId = await writer.registerSchema({
    name: "swampai.MachineReading",
    encoding: "jsonschema",
    data: new TextEncoder().encode(JSON.stringify(READING_SCHEMA)),
  });

  const channelIds = new Map<string, number>();
  for (const channel of MCAP_CHANNELS) {
    const id = await writer.registerChannel({
      schemaId,
      topic: mcapTopicFor(machine.name, channel.kind),
      messageEncoding: "json",
      // A Map, not an object: the writer serialises this by iterating entries, and a plain
      // object fails at the first message with "array is not iterable" rather than at the
      // call, which is the kind of defect that only shows up when the file is being written.
      metadata: new Map([
        ["kind", channel.kind],
        ["what", channel.what],
      ]),
    });
    channelIds.set(channel.kind, id);
  }

  // Oldest first. Ties keep the caller's order rather than being shuffled by the sort.
  const ordered = [...readings]
    .map((r, index) => ({ r, index }))
    .sort((a, b) => {
      const at = Date.parse(a.r.created_at);
      const bt = Date.parse(b.r.created_at);
      if (!Number.isFinite(at) || !Number.isFinite(bt) || at === bt) return a.index - b.index;
      return at - bt;
    })
    .slice(-MCAP_MAX_MESSAGES)
    .map(({ r }) => r);

  const counts = new Map<string, number>();
  let written = 0;
  let skipped = 0;
  let first: bigint | null = null;
  let last: bigint | null = null;

  for (const reading of ordered) {
    const logTime = nanosFrom(reading.created_at);
    if (logTime === 0n) {
      skipped++;
      continue;
    }
    const payload = (reading.payload ?? {}) as Record<string, unknown>;
    const logged: LoggedReading = {
      at: new Date(Number(logTime / 1_000_000n)).toISOString(),
      kind: reading.kind,
      metric: reading.metric ?? null,
      value: reading.value ?? null,
      unit: reading.unit ?? null,
      state: reading.state ?? null,
      message: reading.message ?? null,
      payload,
    };

    const channelId = channelIds.get(reading.kind) ?? channelIds.get("telemetry")!;
    await writer.addMessage({
      channelId,
      sequence: written,
      logTime,
      publishTime: logTime,
      data: new TextEncoder().encode(JSON.stringify(logged)),
    });

    written++;
    const topic = mcapTopicFor(machine.name, reading.kind);
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
    if (first === null || logTime < first) first = logTime;
    if (last === null || logTime > last) last = logTime;
  }

  // Metadata rather than a fake message: who the file is about, in the machine's own words,
  // and what it is. A reader that ignores metadata loses nothing.
  await writer.addMetadata({
    name: "swampai.machine",
    metadata: new Map([
      ["name", machine.name],
      ["kind", machine.kind],
      ["description", machine.description ?? ""],
      ["location", machine.location ?? ""],
      ["firmware", machine.firmware ?? ""],
      ["hardware", machine.hardware ?? ""],
      ["last_report_at", machine.last_report_at ?? ""],
      ["messages", String(written)],
      ["skipped_rows_without_a_timestamp", String(skipped)],
      ["schema", "swampai.MachineReading"],
      ["origin", origin],
    ]),
  });

  await writer.end();

  return {
    bytes: sink.bytes(),
    messages: written,
    channels: MCAP_CHANNELS.map((c) => ({
      topic: mcapTopicFor(machine.name, c.kind),
      count: counts.get(mcapTopicFor(machine.name, c.kind)) ?? 0,
    })),
    skipped,
    span:
      first !== null && last !== null
        ? {
            from: new Date(Number(first / 1_000_000n)).toISOString(),
            to: new Date(Number(last / 1_000_000n)).toISOString(),
          }
        : null,
  };
}

/**
 * A filename a person can read and a tool can take: `<name>-<day>.mcap`.
 *
 * The name is sanitised rather than trusted, because it goes into a `content-disposition`
 * header. Names are validated at registration, so this is the second lock on the same door,
 * and it is the one that matters if that validation ever loosens: no separator survives, and
 * runs of dots collapse, so nothing can climb out of the directory it lands in.
 */
export function mcapFilename(machineName: string, at: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const safe =
    machineName
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "") || "machine";
  return `${safe}-${day}.mcap`;
}

/**
 * The SHA-256 of the file's own bytes, lowercase hex.
 *
 * This is the digest of the thing that was served rather than of the rows behind it, which is
 * the whole point: a reader can run the same hash over the file they saved and know they kept
 * the bytes this deployment sent. Same primitive as the rest of this layer (`@noble/hashes`),
 * so a verifier and the door agree by construction.
 */
export function mcapDigestHex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
