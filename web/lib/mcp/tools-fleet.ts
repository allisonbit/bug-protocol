import type { McpTool, ToolContext } from "./tools";
import type { Release } from "@/lib/machines/releases";
import type { MachineReading } from "@/lib/agents/types";
import { dutyViews, overdueDuties, nextDuties, type DutyRow, type Vulnerability } from "@/lib/machines/duties";
import { buildMachineMcap, mcapDigestHex } from "@/lib/machines/mcap";
import { SITE_URL } from "@/lib/site";

/**
 * THE FLEET, OVER MCP.
 *
 * WHY AN AGENT NEEDS THIS AND A PERSON DOES NOT. Every tool here answers a question a
 * delegate asks mid task: is the machine I was asked to coordinate actually running the
 * firmware the fleet thinks it is, is there an advisory open against what it runs, and
 * what does this deployment publish at all. The party holding a task about a robot is
 * the party that needs the robot's row, and making it fetch a page is making it guess.
 *
 * WHY ALL OF IT IS READ ONLY. Publishing firmware, staging a rollout and reporting an
 * install are acts with consequences on hardware in the world: an image offered to the
 * wrong board is a robot that does not boot. Those stay behind a signed in door where a
 * person is present. An agent may read the fleet and may not move it, which is the
 * conservative half of the split.
 *
 * WHAT THE CLOCK IS NOT. The duties below are measured from the instant a maker said
 * awareness began. This is a clock over rows a maker entered, not legal advice, not a
 * certification, and not a statement about whether any product is in scope of the
 * Regulation. Every tool that returns it says so in the reply.
 *
 * ONE TOOL DESCRIBES A FILE RATHER THAN A ROW. `read_machine_log` answers what a machine's
 * history looks like as an MCAP log, the container the robotics world reads, and hands back
 * a URL plus the digest of the exact bytes that URL serves. It is here because an agent doing
 * a postmortem should be able to see what evidence exists without downloading tens of
 * kilobytes into its context, and because the digest has to be computed from the same rows the
 * door would read for the claim to hold.
 */

const NO_BACKEND = "The swamp backend is not configured on this deployment, so the fleet has no rows to read.";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

type MachineRow = {
  name: string;
  kind: string;
  hardware: string | null;
  firmware: string | null;
  installed_version: string | null;
  pinned_release_id: string | null;
  pinned_reason: string | null;
  status: string;
  last_report_at: string | null;
};

export const FLEET_TOOLS: McpTool[] = [
  {
    name: "read_fleet",
    title: "Read the connected fleet",
    description:
      "Every machine this deployment knows: its board, what it actually reports running, whether it is held on a version on purpose and why, when it last reported, and whether it is behind the newest firmware published for its board. Use this before delegating anything to hardware, so a task names a machine that exists and says what it runs. Read only: nothing here moves a robot.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "One machine by name instead of the whole fleet." },
        limit: { type: "integer", description: "How many machines, 1 to 200. Default 60." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const limit = num(args.limit, 60, 1, 200);
      const name = str(args.machine).toLowerCase();

      let query = sb
        .from("machines")
        .select("name, kind, hardware, firmware, installed_version, pinned_release_id, pinned_reason, status, last_report_at")
        .order("name", { ascending: true })
        .limit(limit);
      if (name) query = query.eq("name", name);
      const { data } = await query;
      const machines = (data as MachineRow[] | null) ?? [];
      if (machines.length === 0) {
        return {
          text: name ? `No machine named "${name}" is registered here.` : "No machines are registered on this deployment.",
          data: { machines: [] },
        };
      }

      const { data: releaseRows } = await sb.from("machine_releases").select("id, name, version, channel, hardware, sha256, yanked_at, created_at").order("created_at", { ascending: false }).limit(200);
      const releases = (releaseRows as Pick<Release, "id" | "name" | "version" | "channel" | "hardware" | "sha256" | "yanked_at" | "created_at">[] | null) ?? [];

      const lines = machines.map((m) => {
        const target = releases.find((r) => !r.yanked_at && (r.hardware === null || r.hardware === m.hardware));
        const running = m.installed_version ?? m.firmware ?? "unknown";
        const state =
          m.pinned_release_id !== null
            ? `held on purpose${m.pinned_reason ? `: ${m.pinned_reason}` : ""}`
            : target && target.version !== running
              ? `behind ${target.name} ${target.version}`
              : target
                ? "current"
                : "nothing published for it";
        return `- ${m.name} (${m.kind}${m.hardware ? `, ${m.hardware}` : ", board not stated"}), runs ${running}, ${state}, last reported ${m.last_report_at ?? "never"}`;
      });

      return {
        text: [`${machines.length} machine(s):`, ...lines, "", "What a device is offered is decided on its own board and channel; read a release's digest before trusting an image, because the device checks it and not this reply."].join("\n"),
        data: {
          machines: machines.map((m) => ({
            ...m,
            running: m.installed_version ?? m.firmware,
            pinned_because: m.pinned_reason,
          })),
          content_is_untrusted: false,
        },
      };
    },
  },

  {
    name: "read_firmware_releases",
    title: "Read published firmware",
    description:
      "What this deployment has published: each artifact's name, version, channel, board, artifact URL, SHA-256 and size, whether it was yanked and why, and what a given machine would be offered from it. The digest is the thing worth having: a device checks it itself before flashing, so a caller can too. Read only.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Optional machine name, to include exactly what that device is offered and the reason." },
        channel: { type: "string", enum: ["stable", "beta", "dev"], description: "Only releases on this channel." },
        limit: { type: "integer", description: "How many releases, 1 to 200. Default 40." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const limit = num(args.limit, 40, 1, 200);
      const channel = str(args.channel).toLowerCase();

      let query = sb.from("machine_releases").select("*").order("created_at", { ascending: false }).limit(limit);
      if (channel) query = query.eq("channel", channel);
      const { data } = await query;
      const releases = ((data as Release[] | null) ?? []).filter(Boolean);
      if (releases.length === 0) {
        return {
          text: "Nothing is published. A maker signs in and posts a release with its artifact URL, its SHA-256 and its SBOM, which is required at publish time because that is the only moment a publisher still has one to hand.",
          data: { releases: [] },
        };
      }

      const lines = releases.map((r) => {
        const components = Array.isArray((r.sbom as { components?: unknown[] } | null)?.components) ? (r.sbom as { components: unknown[] }).components.length : Array.isArray((r.sbom as { packages?: unknown[] } | null)?.packages) ? (r.sbom as { packages: unknown[] }).packages.length : 0;
        return `- ${r.name} ${r.version} on ${r.channel}${r.hardware ? ` for ${r.hardware}` : " for any board"}, sha256 ${r.sha256}${r.bytes ? `, ${r.bytes} bytes` : ""}${components ? `, ${components} components` : ""}${r.yanked_at ? `, YANKED: ${r.yanked_reason ?? "no reason given"}` : ""}`;
      });

      let offerLine: string | null = null;
      let offer: unknown = null;
      const machineName = str(args.machine).toLowerCase();
      if (machineName) {
        const { data: machineRow } = await sb.from("machines").select("name, hardware, firmware, installed_version, pinned_release_id, pinned_reason").eq("name", machineName).maybeSingle();
        if (!machineRow) {
          offerLine = `No machine named "${machineName}" is registered here, so there is nothing to offer.`;
        } else {
          const m = machineRow as MachineRow;
          const pinned = m.pinned_release_id ? releases.find((r) => r.id === m.pinned_release_id) : undefined;
          const eligible = releases.filter((r) => !r.yanked_at && (r.hardware === null || r.hardware === m.hardware));
          const target = pinned ?? eligible[0] ?? null;
          const running = m.installed_version ?? m.firmware ?? null;
          offer = target ? { id: target.id, name: target.name, version: target.version, sha256: target.sha256, artifact_url: target.artifact_url, yanked_at: target.yanked_at } : null;
          offerLine = pinned
            ? `${m.name} is held on ${pinned.name} ${pinned.version} on purpose${m.pinned_reason ? `: ${m.pinned_reason}` : ""}, so a rollout does not move it.`
            : target
              ? `${m.name} runs ${running ?? "unknown"} and is offered ${target.name} ${target.version}, sha256 ${target.sha256}.`
              : `${m.name} is offered nothing: no release is published for ${m.hardware ?? "its board"}.`;
        }
      }

      return {
        text: [
          `${releases.length} release(s):`,
          ...lines,
          ...(offerLine ? ["", offerLine] : []),
          "",
          "A yanked release stays on the record rather than being deleted, because a machine that already installed it is a fact the fleet has to keep.",
        ].join("\n"),
        data: {
          releases: releases.map((r) => ({ ...r, sbom: undefined, content_is_untrusted: false })),
          offered: offer,
        },
      };
    },
  },

  {
    name: "read_vulnerability_record",
    title: "Read the vulnerability record and its clock",
    description:
      "Open advisories against the firmware this deployment and its fleet run, each with the reporting duties derived from the instant a maker became aware: when each was due, whether it was met and with what evidence, and what is late right now. A caller coordinating hardware should read this before treating a robot as safe to deploy. This is a clock over rows a maker entered: it is not legal advice, not a certification, and not a statement about scope.",
    inputSchema: {
      type: "object",
      properties: {
        advisory: { type: "string", description: "One advisory by its id, such as a CVE, instead of the whole record." },
        only_open: { type: "boolean", description: "Skip advisories that are already fixed or marked wontfix." },
        limit: { type: "integer", description: "How many advisories, 1 to 100. Default 40." },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const limit = num(args.limit, 40, 1, 100);
      const advisoryId = str(args.advisory);

      let query = sb.from("machine_vulnerabilities").select("*").order("first_aware_at", { ascending: false }).limit(limit);
      if (advisoryId) query = query.eq("advisory_id", advisoryId);
      const { data } = await query;
      let advisories = ((data as Vulnerability[] | null) ?? []).filter(Boolean);
      if (args.only_open === true) advisories = advisories.filter((v) => v.state !== "fixed" && v.state !== "wontfix");

      if (advisories.length === 0) {
        return {
          text: advisoryId
            ? `No advisory with id "${advisoryId}" is on this record.`
            : "The record is empty, which means no advisory has been entered here rather than that the firmware is clean. The record can only speak to what a maker entered.",
          data: { advisories: [] },
        };
      }

      const { data: dutyRows } = await sb.from("machine_vulnerability_duties").select("*").in("vulnerability_id", advisories.map((v) => v.id));
      const byVuln = new Map<string, DutyRow[]>();
      for (const r of ((dutyRows as (DutyRow & { vulnerability_id: string })[] | null) ?? [])) {
        const list = byVuln.get(r.vulnerability_id) ?? [];
        list.push(r);
        byVuln.set(r.vulnerability_id, list);
      }

      const nowMs = Date.now();
      const views = advisories.map((v) => ({ vuln: v, duties: dutyViews({ vulnerability: v, rows: byVuln.get(v.id) ?? [], nowMs }) }));
      const lines: string[] = [];
      for (const { vuln, duties } of views) {
        const late = overdueDuties(duties);
        lines.push(
          `- ${vuln.advisory_id} [${vuln.severity}] ${vuln.title} (${vuln.state}${vuln.fixed_in ? `, fixed in ${vuln.fixed_in}` : ""}${vuln.actively_exploited ? ", actively exploited" : ""})`,
        );
        lines.push(`    aware since ${vuln.first_aware_at}${late.length > 0 ? `, ${late.length} dut${late.length === 1 ? "y" : "ies"} LATE` : ""}`);
        for (const d of duties) {
          lines.push(`    ${d.state}: ${d.label} due ${d.dueAt}${d.metAt ? `, met ${d.metAt} by ${d.metBy ?? "no citation"}` : ""}`);
        }
      }
      const next = views.flatMap((v) => nextDuties(v.duties, 2).map((d) => ({ advisory: v.vuln.advisory_id, ...d })));

      return {
        text: [
          `${advisories.length} advisory(ies):`,
          ...lines,
          "",
          "A duty marked met cannot be recorded here without evidence, because a timeline entry nobody can check is the thing this record exists to replace. This is a clock over facts a maker entered: not legal advice, not a certification, and not a statement about whether any product is in scope of the Regulation.",
        ].join("\n"),
        data: {
          advisories: views.map(({ vuln, duties }) => ({
            advisory_id: vuln.advisory_id,
            title: vuln.title,
            severity: vuln.severity,
            state: vuln.state,
            actively_exploited: vuln.actively_exploited,
            first_aware_at: vuln.first_aware_at,
            duties: duties.map((d) => ({ duty: d.duty, due_at: d.dueAt, met_at: d.metAt, met_by: d.metBy, state: d.state, ms_remaining: d.msRemaining })),
          })),
          next_due: next.map((n) => ({ advisory: n.advisory, duty: n.duty, due_at: n.dueAt, ms_remaining: n.msRemaining })),
        },
      };
    },
  },

  {
    name: "read_machine_log",
    title: "Describe a machine's log file",
    description:
      "What one machine's history looks like as an MCAP log, the container robotics tools read: how many messages, one channel per kind of reading, the span from the first reading to the last, the SHA-256 of the exact bytes, and the URL that serves them. Use this to see what evidence exists before pulling a file into your context; the digest lets you prove later that the file you kept is the file this deployment served. Read only.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "The machine's callsign, as registered." },
        limit: { type: "integer", description: "How many of the newest readings the described file would carry, 1 to 5000. Default 500. The same number is written into the URL, so the digest describes the bytes that URL serves." },
      },
      required: ["machine"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sb = ctx.admin ?? ctx.sb;
      if (!sb) return { text: NO_BACKEND, data: {} };
      const name = str(args.machine).toLowerCase();
      if (!name) return { text: "Name the machine whose log you want described, as it is registered.", data: {} };
      const limit = num(args.limit, 500, 1, 5000);

      const { data: machineRow } = await sb
        .from("machines")
        .select("name, kind, description, location, firmware, hardware, last_report_at")
        .eq("name", name)
        .maybeSingle();
      if (!machineRow) {
        return { text: `No machine named "${name}" is registered here. Use read_fleet to see what is.`, data: { machines: [] } };
      }

      const { data: readingRows } = await sb
        .from("machine_readings")
        .select("id, machine_id, machine_name, kind, metric, value, unit, state, message, payload, created_at")
        .eq("machine_name", name)
        .order("created_at", { ascending: false })
        .limit(limit);

      const readings = (readingRows as MachineReading[] | null) ?? [];
      // The origin stamped into the file is this deployment's canonical one, not the host this
      // particular call was made through. It has to be: the digest is of the bytes, and the
      // origin is part of those bytes, so a file described here and a file served by the door
      // must be the same file rather than two files that differ by a hostname. Verified by
      // probe-mcap.cjs, which fetches the URL this tool returns and hashes what actually arrived.
      const built = await buildMachineMcap({ machine: machineRow as Parameters<typeof buildMachineMcap>[0]["machine"], readings, origin: SITE_URL });
      const sha256 = mcapDigestHex(built.bytes);
      // The URL, on the other hand, is built for the host the caller reached, so the client can
      // actually fetch it. The bytes behind it are the bytes above.
      const url = `${ctx.siteUrl}/api/machines/${encodeURIComponent(name)}/mcap?limit=${limit}`;

      return {
        text: [
          `${name}: ${built.messages} message(s) in a ${built.bytes.byteLength} byte MCAP log, offered ${readings.length} row(s).`,
          ...built.channels.filter((c) => c.count > 0).map((c) => `  ${c.topic}: ${c.count}`),
          built.span ? `  span ${built.span.from} to ${built.span.to}` : "  no readings yet, so the file is a valid empty log",
          built.skipped > 0 ? `  ${built.skipped} row(s) dropped for having no usable timestamp` : "",
          `download: ${url}`,
          `sha256: ${sha256}`,
          "Verify by hashing the bytes you receive and comparing, or read the x-mcap-sha256 header on the same response. The file is written when it is asked for, so a later call describes a longer file.",
        ]
          .filter(Boolean)
          .join("\n"),
        data: {
          machine: name,
          messages: built.messages,
          rows_offered: readings.length,
          skipped: built.skipped,
          channels: built.channels,
          span: built.span,
          bytes: built.bytes.byteLength,
          sha256,
          container: "MCAP",
          schema: "swampai.MachineReading",
          url,
        },
      };
    },
  },
];
