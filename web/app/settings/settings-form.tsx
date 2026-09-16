"use client";

import { useFormStatus } from "react-dom";
import { useState } from "react";
import { updateProfile } from "@/app/actions";
import type { Profile } from "@/lib/db";

export function SettingsForm({ profile, email }: { profile: Profile | null; email: string }) {
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={async (fd) => {
        await updateProfile(fd);
        setSaved(true);
      }}
      className="space-y-5"
    >
      <div className="rounded-xl border border-line bg-ink-soft/40 p-5">
        <h2 className="text-sm font-medium text-chalk">Profile</h2>
        <p className="mt-1 text-xs text-mist">How you appear across programs and findings.</p>
        <div className="mt-4 space-y-4">
          <L label="Display name">
            <input
              name="display_name"
              defaultValue={profile?.display_name ?? ""}
              placeholder="Ada Lovelace"
              className="auth-input"
            />
          </L>
          <L label="Handle" hint="Lowercase, letters/numbers/underscore. Shown as @handle.">
            <input
              name="handle"
              defaultValue={profile?.handle ?? ""}
              placeholder="ada"
              className="auth-input"
            />
          </L>
          <L label="Bio">
            <textarea
              name="bio"
              rows={3}
              defaultValue={profile?.bio ?? ""}
              placeholder="Smart contract auditor. Reentrancy enjoyer."
              className="auth-input text-sm"
            />
          </L>
          <L label="Website">
            <input
              name="website"
              defaultValue={profile?.website ?? ""}
              placeholder="https://..."
              className="auth-input"
            />
          </L>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-ink-soft/40 p-5">
        <h2 className="text-sm font-medium text-chalk">Payouts</h2>
        <p className="mt-1 text-xs text-mist">
          Optional. Where bounties settle when a program pays onchain.
        </p>
        <div className="mt-4">
          <L label="Wallet address" hint="ETH / Base address (0x...). You can add this later.">
            <input
              name="wallet"
              defaultValue={profile?.wallet ?? ""}
              placeholder="0x..."
              className="auth-input font-mono text-xs"
            />
          </L>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Submit onClick={() => setSaved(false)} />
        {saved && <span className="text-sm text-bug">Saved</span>}
        <span className="ml-auto text-xs text-mist">{email}</span>
      </div>
    </form>
  );
}

function Submit({ onClick }: { onClick: () => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      onClick={onClick}
      disabled={pending}
      className="glow rounded-md bg-lime px-5 py-2.5 text-sm font-medium text-graphite transition-transform hover:scale-[1.01] disabled:opacity-50"
    >
      {pending ? "Saving..." : "Save changes"}
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
