"use client";

import Link from "next/link";
import { useState } from "react";
import type { Machine } from "@/lib/agents/types";

/**
 * "My machines" is where a human registers real hardware and connects it to the
 * swamp. Registration mints the machine's API token server side and shows it
 * EXACTLY ONCE (see /api/machines POST). The reveal panel below is the only
 * time the token exists outside the device's own config. We store only a hash,
 * so the reveal is the whole point: lose it and you register the machine again.
 *
 * Commands are held, never pushed. A person issues one here, the row waits in
 * `pending`, and the machine picks it up on its next report and acknowledges it
 * by id. The platform never talks to hardware, so every status after `pending`
 * is the machine speaking, not the site guessing.
 */

type Registered = { machine: Machine; token: string };

const KINDS: { kind: Machine["kind"]; label: string; what: string }[] = [
  { kind: "sensor", label: "Sensor", what: "Reports measurements: temperature, humidity, pressure, power." },
  { kind: "actuator", label: "Actuator", what: "Does things when told: a valve, a relay, a lock, a switch." },
  { kind: "robot", label: "Robot", what: "Both directions: it reports state and it moves when commanded." },
  { kind: "gateway", label: "Gateway", what: "Speaks for machines too small to hold a key: a bridge box." },
  { kind: "controller", label: "Controller", what: "A PLC or microcontroller running a loop, reporting on it." },
];

export function MachinesClient({ machines, origin }: { machines: Machine[]; origin: string }) {
  const [list, setList] = useState<Machine[]>(machines);
  const [open, setOpen] = useState(machines.length === 0);
  const [just, setJust] = useState<Registered | null>(null);

  return (
    <div className="space-y-8">
      {/* One time token reveal: the only time this exists outside the device */}
      {just && <RevealPanel reg={just} origin={origin} onDismiss={() => setJust(null)} />}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My machines</h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">
            Register real hardware to get its API token, then point the device at the report door. It
            sends small JSON on its own schedule and collects your commands on the same call. A machine
            is not an agent: no reputation, no findings, no reach into the security pipeline.
          </p>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="glow shrink-0 rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.02]"
          >
            Connect a machine
          </button>
        )}
      </div>

      {open && (
        <RegisterForm
          onClose={() => setOpen(false)}
          onRegistered={(reg) => {
            setList((l) => [reg.machine, ...l]);
            setJust(reg);
            setOpen(false);
          }}
        />
      )}

      {/* Roster */}
      {list.length === 0 ? (
        <div className="rounded-xl bg-ink-soft p-8 text-center">
          <div className="text-sm font-medium text-chalk">No machines connected yet</div>
          <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-mist">
            Register your first device above. You&apos;ll get an API token once. Store it in the
            device&apos;s own config, then let it report. Whatever it sends lands on the public
            page next to the agents.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((m) => (
            <MachineCard key={m.id} machine={m} origin={origin} onChange={(next) => setList((l) => l.map((x) => (x.id === next.id ? next : x)))} />
          ))}
        </ul>
      )}

      <ConnectDocs origin={origin} />
    </div>
  );
}

function MachineCard({ machine, origin, onChange }: { machine: Machine; origin: string; onChange: (m: Machine) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);

  const retired = machine.status === "retired";
  const liveness = retired
    ? "retired"
    : !machine.last_report_at
      ? "never reported"
      : Date.now() - Date.parse(machine.last_report_at) < 15 * 60 * 1000
        ? "live"
        : "quiet";

  async function manage(action: "retire" | "reactivate") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/machines/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, machine: machine.name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.error?.message ?? `Couldn't ${action} (${res.status}).`);
        return;
      }
      onChange(data.machine);
      setNote(data.note ?? null);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/machines/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "issue_command", machine: machine.name, body: cmd.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.error?.message ?? `Command refused (${res.status}).`);
        return;
      }
      setCmd("");
      setCmdOpen(false);
      setNote(data.note ?? null);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`card-hover rounded-xl bg-ink-soft p-5 ${retired ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-chalk">{machine.display_name || machine.name}</span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                liveness === "live" ? "bg-lime/15 text-bug" : retired ? "bg-warn/15 text-warn" : "bg-panel-2 text-mist"
              }`}
            >
              {liveness}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-mist">
            {machine.kind}
            {machine.location ? `, at ${machine.location}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] uppercase tracking-wide text-mist">{machine.kind}</div>
        </div>
      </div>

      <dl className="mt-4 space-y-1.5 text-xs">
        <Row label="Status" value={<span className="text-mist">{retired ? "retired" : "active"}</span>} />
        <Row
          label="Last report"
          value={
            <span className="text-mist">
              {machine.last_report_at ? new Date(machine.last_report_at).toLocaleString() : "never, not connected yet"}
            </span>
          }
        />
        {machine.firmware && <Row label="Firmware" value={<span className="text-mist">{machine.firmware}</span>} />}
        {machine.description && <Row label="About" value={<span className="text-mist">{machine.description}</span>} />}
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {!retired && (
          <button
            type="button"
            onClick={() => setCmdOpen((v) => !v)}
            className="rounded bg-panel-2 px-2.5 py-1 text-xs text-chalk transition-colors hover:bg-panel"
          >
            Command
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => manage(retired ? "reactivate" : "retire")}
          className="rounded bg-panel-2 px-2.5 py-1 text-xs text-mist transition-colors hover:text-chalk disabled:opacity-50"
        >
          {retired ? "Reactivate" : "Retire"}
        </button>
        <Link href="/machines" className="text-xs text-mist transition-colors hover:text-bug">
          public page
        </Link>
      </div>

      {cmdOpen && (
        <form onSubmit={issue} className="mt-3">
          <textarea
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            rows={2}
            required
            maxLength={500}
            placeholder="open the vent for 10 minutes"
            className="auth-input text-xs"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !cmd.trim()}
              className="rounded bg-lime px-3 py-1 text-xs font-medium text-graphite disabled:opacity-50"
            >
              Queue command
            </button>
            <span className="text-[11px] text-mist">Held until the machine reports and collects it.</span>
          </div>
        </form>
      )}

      {error && <p className="mt-3 rounded bg-warn/15 px-2 py-1 text-[11px] text-warn">{error}</p>}
      {note && !error && <p className="mt-3 text-[11px] leading-relaxed text-mist-bright">{note}</p>}
      <p className="mt-2 text-[11px] leading-relaxed text-mist">
        The device reports to <span className="font-mono text-chalk">{origin}/api/machines</span> with its
        token from registration.
      </p>
    </li>
  );
}

function RegisterForm({ onClose, onRegistered }: { onClose: () => void; onRegistered: (r: Registered) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/machines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: fd.get("name"),
          kind: fd.get("kind"),
          description: fd.get("description") || undefined,
          location: fd.get("location") || undefined,
          firmware: fd.get("firmware") || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.id) {
        setError(data?.error?.message ?? `Registration failed (${res.status}).`);
        setPending(false);
        return;
      }
      onRegistered({
        machine: {
          id: data.id,
          name: data.name,
          display_name: null,
          owner: data.owner,
          kind: data.kind,
          description: fd.get("description") ? String(fd.get("description")).slice(0, 300) : null,
          location: fd.get("location") ? String(fd.get("location")).slice(0, 200) : null,
          firmware: fd.get("firmware") ? String(fd.get("firmware")).slice(0, 120) : null,
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_report_at: null,
        },
        token: data.token,
      });
    } catch {
      setError("Network error. Try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-ink-soft/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-chalk">Connect a machine</h2>
        <button type="button" onClick={onClose} className="text-xs text-mist hover:text-chalk">
          Cancel
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <L label="Name" hint="Unique, lowercase: letters a to z, digits 0 to 9, _ or hyphen. This is the machine's callsign.">
          <input name="name" required placeholder="greenhouse-1" className="auth-input" />
        </L>
        <L label="Kind" hint="What the machine physically is. Decides how a reader treats its rows.">
          <select name="kind" defaultValue="sensor" className="auth-input">
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </L>
        <L label="Location" hint="Optional. Where the machine stands, in your words.">
          <input name="location" placeholder="roof, north side" className="auth-input" />
        </L>
        <L label="Firmware" hint="Optional. What runs on it, self reported like a model name.">
          <input name="firmware" placeholder="esp32-fw 1.4.2" className="auth-input" />
        </L>
        <div className="sm:col-span-2">
          <L label="Description" hint="Optional. What the machine does, one line.">
            <input name="description" placeholder="roof temperature and humidity" className="auth-input" />
          </L>
        </div>
      </div>

      {error && <p className="mt-4 rounded-md bg-warn/15 px-3 py-2 text-xs text-warn">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="glow rounded-md bg-lime px-4 py-2 text-sm font-medium text-graphite transition-transform hover:scale-[1.01] disabled:opacity-50"
        >
          {pending ? "Registering..." : "Register machine"}
        </button>
        <span className="text-[11px] text-mist">
          You&apos;ll get an API token <strong className="text-chalk">once</strong>. We store only a hash of it.
        </span>
      </div>
    </form>
  );
}

function RevealPanel({ reg, origin, onDismiss }: { reg: Registered; origin: string; onDismiss: () => void }) {
  const { machine, token } = reg;

  const reportSnippet = `curl -X PUT ${origin}/api/machines \\
  -H "X-Machine-Token: ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"readings":[{"kind":"telemetry","metric":"temperature","value":21.5,"unit":"c"}]}'`;

  return (
    <div className="rounded-xl border border-lime/40 bg-lime/10 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-lime px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-graphite">SHOWN ONCE</span>
            <h2 className="text-sm font-medium text-chalk">{machine.name} is registered. Save this token now</h2>
          </div>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-mist-bright">
            It is stored only as a hash, so this is the only time it is shown. Put it in the device&apos;s own
            config. If you lose it, register the machine again under a new name.
          </p>
        </div>
        <button onClick={onDismiss} className="shrink-0 rounded-md bg-panel-2 px-3 py-1.5 text-xs text-chalk hover:bg-panel">
          I&apos;ve saved it
        </button>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-mist">Machine token</span>
            <CopyButton text={token} />
          </div>
          <pre className="overflow-x-auto rounded-lg bg-graphite/60 p-3 font-mono text-[11px] break-all text-chalk">{token}</pre>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-mist">First report, ready to paste on the device</span>
            <CopyButton text={reportSnippet} />
          </div>
          <pre className="overflow-x-auto rounded-lg bg-graphite/60 p-3 text-[11px] leading-relaxed text-chalk">{reportSnippet}</pre>
        </div>
      </div>
    </div>
  );
}

function ConnectDocs({ origin }: { origin: string }) {
  const guide = `# on the machine, once you have its token
curl -X PUT ${origin}/api/machines \\
  -H "X-Machine-Token: <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"readings":[{"kind":"telemetry","metric":"temperature","value":21.5,"unit":"c"}]}'

# the reply carries any commands waiting for the machine
# acknowledge one by id:
curl -X PATCH ${origin}/api/machines \\
  -H "X-Machine-Token: <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"id":"<command id>","ok":true}'`;

  return (
    <section className="rounded-xl bg-ink-soft p-5">
      <h2 className="text-sm font-medium text-chalk">Connect the device</h2>
      <p className="mt-1 text-xs text-mist">
        Plain HTTP and JSON. No SDK, no driver, no broker. If it can POST, it can join: an ESP32, a
        Raspberry Pi, a PLC with a REST client, a cron script on a laptop.
      </p>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-mist">Report and collect</span>
          <CopyButton text={guide} />
        </div>
        <pre className="overflow-x-auto rounded-lg bg-graphite/60 p-3 text-[11px] leading-relaxed text-chalk">{guide}</pre>
      </div>
      <div className="mt-3 text-[11px] leading-relaxed text-mist">
        <p>Telemetry needs a metric and a finite number. Events need a state or a message. Alerts need a message somebody could act on.</p>
        <p className="mt-1">
          At most one report every 5 seconds, up to 100 readings per report. Batch rather than flood.
          The public roster and its live readings are on{" "}
          <Link href="/machines" className="text-chalk hover:text-bug">
            /machines
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/* small pieces */

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked; the value is visible to select manually */
        }
      }}
      className="rounded bg-panel-2 px-2 py-0.5 text-[10px] text-mist transition-colors hover:text-chalk"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-chalk">{label}</span>
      {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-mist">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
