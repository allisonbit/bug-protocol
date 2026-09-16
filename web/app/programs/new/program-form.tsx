"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { createProgram } from "@/app/actions";
import { money } from "@/lib/db";

const CURRENCIES = ["USDC", "USDT", "DAI", "ETH", "USD"];

export function ProgramForm() {
  const [currency, setCurrency] = useState("USDC");
  const [tiers, setTiers] = useState({ low: 250, medium: 1000, high: 5000, critical: 20000 });
  const [pool, setPool] = useState(25000);

  const set = (k: keyof typeof tiers) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTiers((t) => ({ ...t, [k]: Number(e.target.value) || 0 }));

  const top = Math.max(tiers.low, tiers.medium, tiers.high, tiers.critical);

  return (
    <form action={createProgram} className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
      <div className="space-y-6">
        <Group title="Basics">
          <L label="Program name" hint="Shown everywhere. Usually your product or protocol name.">
            <input name="name" required placeholder="Acme Protocol" className="auth-input" />
          </L>
          <L label="One line summary" hint="The pitch hunters see on the card.">
            <input
              name="summary"
              placeholder="Smart contract and web bugs for our lending protocol."
              className="auth-input"
            />
          </L>
          <L label="Scope & rules" hint="Markdown style. What's in scope, what's not, how you handle reports.">
            <textarea
              name="description"
              rows={7}
              placeholder={"In scope:\n- app.acme.xyz\n- contracts on Base\n\nOut of scope:\n- spam, DoS, self-XSS"}
              className="auth-input font-mono text-xs leading-relaxed"
            />
          </L>
          <L label="Targets" hint="One per line: domains, repos, or contract addresses.">
            <textarea
              name="targets"
              rows={3}
              placeholder={"app.acme.xyz\n0x1234...abcd\ngithub.com/acme/core"}
              className="auth-input font-mono text-xs"
            />
          </L>
        </Group>

        <Group title="Rewards">
          <div className="grid grid-cols-2 gap-3">
            <L label="Currency">
              <select
                name="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="auth-input appearance-none"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </L>
            <L label="Escrow pool" hint="What you're funding upfront.">
              <input
                name="pool"
                type="number"
                min={0}
                value={pool}
                onChange={(e) => setPool(Number(e.target.value) || 0)}
                className="auth-input"
              />
            </L>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tier label="Low" name="tier_low" value={tiers.low} onChange={set("low")} />
            <Tier label="Medium" name="tier_medium" value={tiers.medium} onChange={set("medium")} />
            <Tier label="High" name="tier_high" value={tiers.high} onChange={set("high")} />
            <Tier label="Critical" name="tier_critical" value={tiers.critical} onChange={set("critical")} />
          </div>
          <L label="Response SLA (days)" hint="How fast you commit to triaging a report.">
            <input name="response_days" type="number" min={1} defaultValue={14} className="auth-input" />
          </L>
          <label className="flex items-start gap-2.5 text-sm text-chalk">
            <input name="safe_harbor" type="checkbox" defaultChecked className="mt-0.5 accent-bug-dim" />
            <span>
              Offer safe harbor
              <span className="block text-xs text-mist">
                Good faith research that stays in scope won&apos;t be pursued legally.
              </span>
            </span>
          </label>
        </Group>
      </div>

      {/* Sticky preview / publish rail */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-xl border border-line bg-ink-soft p-5">
          <div className="text-[11px] uppercase tracking-wide text-mist">Preview</div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-mist">Top bounty</span>
            <span className="text-xl font-semibold text-bug">{money(top, currency)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-sm text-mist">In escrow</span>
            <span className="text-sm text-chalk">{money(pool, currency)}</span>
          </div>
          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-xs text-mist">
            {(["low", "medium", "high", "critical"] as const).map((k) => (
              <div key={k} className="flex justify-between">
                <span className="capitalize">{k}</span>
                <span className="text-chalk">{money(tiers[k], currency)}</span>
              </div>
            ))}
          </div>
          <SubmitButtons />
          <p className="mt-3 text-center text-[11px] leading-relaxed text-mist">
            Drafts stay private. Publishing lists it for the whole community to hunt.
          </p>
        </div>
      </div>
    </form>
  );
}

function SubmitButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="mt-5 space-y-2">
      <button
        type="submit"
        name="status"
        value="live"
        disabled={pending}
        className="glow w-full rounded-md bg-lime py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.01] disabled:opacity-50"
      >
        {pending ? "..." : "Publish program"}
      </button>
      <button
        type="submit"
        name="status"
        value="draft"
        disabled={pending}
        className="w-full rounded-md border border-line py-2.5 text-sm text-chalk transition-colors hover:border-mist disabled:opacity-50"
      >
        Save as draft
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-ink-soft/40 p-5">
      <h2 className="text-sm font-medium text-chalk">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
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

function Tier({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-mist">{label}</span>
      <input name={name} type="number" min={0} value={value} onChange={onChange} className="auth-input mt-1" />
    </label>
  );
}
