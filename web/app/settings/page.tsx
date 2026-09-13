import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/queries";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings | Swamp" };

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/settings");

  const profile = await getProfile(user.id);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-sm text-mist">Manage your profile and payout details.</p>
      <div className="mt-8">
        <SettingsForm profile={profile} email={user.email ?? ""} />
      </div>
    </div>
  );
}
