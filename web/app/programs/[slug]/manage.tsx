"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { setProgramStatus, fundProgram } from "@/app/actions";
import type { Program, ProgramStatus } from "@/lib/db";
import { OnchainPanel } from "./onchain-panel";

/**
 * Owner-only controls, in two tabs because they are genuinely two different
 * things: the listing (publish / pause / close, which is what makes a program
 * appear on /programs) and the escrow deployment (which is what makes an accepted
 * finding actually payable). Conflating them is how an owner ends up believing a
 * paused-on-chain program stopped accepting findings when it didn't.
 */
export function ManagePanel({ program }: { program: Program }) {
  const [tab, setTab] = useState<"listing" | "escrow">("listing");
  const escrowed = program.onchain_program_id !== null;

  return (
    <div className="rounded-xl border border-bug-dim/40 bg-bug-dim/[0.05] p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-chalk">Manage</h2>
        <span className="text-[11px] text-mist">owner only</span>
      </div>

      <div className="mt-3 flex gap-1 text-xs">
        <TabButton active={tab === "listing"} onClick={() => setTab("listing")}>
          Listing
        </TabButton>
        <TabButton active={tab === "escrow"} onClick={() => setTab("escrow")}>
          Escrow
          <span className={`ml-1.5 size-1.5 rounded-full ${escrowed ? "bg-bug" : "bg-mist"}`} />
        </TabButton>
      </div>

      {tab === "listing" ? <ListingTab program={program} /> : <OnchainPanel program={program} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center rounded border px-2.5 py-1 transition-colors ${
        active ? "border-bug-dim bg-ink text-bug" : "border-line text-mist hover:text-chalk"
      }`}
    >
      {children}
    </button>
  );
}

function ListingTab({ program }: { program: Program }) {
  const s = program.status;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {s === "draft" && <StatusButton program={program} to="live" label="Publish" primary />}
        {s === "live" && <StatusButton program={program} to="paused" label="Pause" />}
        {s === "paused" && <StatusButton program={program} to="live" label="Resume" primary />}
        {s !== "closed" && <StatusButton program={program} to="closed" label="Close" danger />}
        {s === "closed" && <StatusButton program={program} to="draft" label="Reopen as draft" />}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-mist">
        {s === "draft"
          ? "This program is private. Publish it to let hunters submit."
          : s === "live"
            ? "Listed and accepting submissions."
            : s === "paused"
              ? "Hidden from hunters; existing reports stay visible."
              : "Closed. No new submissions."}
      </p>
      <FundForm program={program} />
      <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-mist">
        This tab controls the <span className="text-chalk">listing</span>. It does not pause anything on chain. An
        escrowed program keeps accepting commits until you pause it in the Escrow tab too.
      </p>
    </div>
  );
}

/**
 * Top up the escrow a programme pays from.
 *
 * The pool used to be settable only once, at creation, so a programme that wanted
 * to raise its rewards had to be closed and recreated — losing its history and its
 * findings. Every top-up is recorded on the public log, so the balance a hunter is
 * weighing is something they can watch grow rather than take on trust.
 */
function FundForm({ program }: { program: Program }) {
  return (
    <form action={fundProgram} className="mt-4 border-t border-line pt-4">
      <input type="hidden" name="program_id" value={program.id} />
      <input type="hidden" name="slug" value={program.slug} />
      <label className="block text-[11px] tracking-wide text-mist uppercase" htmlFor="fund-amount">
        Add to escrow
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="fund-amount"
          name="amount"
          type="number"
          min="1"
          step="1"
          required
          placeholder={`amount in ${program.currency}`}
          className="min-w-0 flex-1 rounded-md border border-line bg-ink px-3 py-2 text-sm text-chalk outline-none focus:border-bug-dim"
        />
        <Submit label="Fund" primary />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-mist">
        Recorded on the public log as <span className="text-chalk">program.funded</span>, with the new total. It does
        not move anything on chain by itself; link an escrowed programme below for that.
      </p>
    </form>
  );
}

function StatusButton({
  program,
  to,
  label,
  primary,
  danger,
}: {
  program: Program;
  to: ProgramStatus;
  label: string;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <form action={setProgramStatus}>
      <input type="hidden" name="program_id" value={program.id} />
      <input type="hidden" name="slug" value={program.slug} />
      <input type="hidden" name="status" value={to} />
      <Submit label={label} primary={primary} danger={danger} />
    </form>
  );
}

function Submit({ label, primary, danger }: { label: string; primary?: boolean; danger?: boolean }) {
  const { pending } = useFormStatus();
  const cls = primary
    ? "border-bug-dim bg-bug-dim/15 text-bug hover:bg-bug-dim/25"
    : danger
      ? "border-red-500/40 bg-red-500/5 text-red-400 hover:bg-red-500/10"
      : "border-line text-chalk hover:border-mist";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md border px-3.5 py-1.5 text-sm transition-colors disabled:opacity-50 ${cls}`}
    >
      {pending ? "..." : label}
    </button>
  );
}
