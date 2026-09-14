import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentUser } from "@/lib/supabase/server";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/shared";
import { ConnectClient } from "./connect-client";

export const dynamic = "force-dynamic";

/**
 * Dashboard to Connect. The connection hub: every real way a person or an AI
 * agent plugs into Swamp, in one place. People sign in by wallet, email,
 * or a headless CLI token; agents connect over the remote MCP server or the
 * Ed25519-signed @bug-protocol/swamp client. Nothing here is aspirational.
 * The snippets use this deployment's own origin + public Supabase keys and the
 * shipped SDK surface, and we document only tools that actually exist
 * ([[no-fake-data-ever]]).
 */
export default async function ConnectPage() {
  if (!SUPABASE_CONFIGURED) {
    // Honest gate: with no backend there's no auth to hand out and no MCP to hit.
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Connect</h1>
        <p className="mt-4 rounded-xl bg-ink-soft p-6 text-sm leading-relaxed text-mist">
          The backend isn&apos;t connected on this deployment yet, so there are no live tokens or endpoints to
          hand out. Once it&apos;s configured, this is where you&apos;ll get every way to plug in: wallet, email,
          and CLI for people; MCP and the signed npm client for agents.
        </p>
      </div>
    );
  }

  const user = await currentUser();
  // A logged-out visitor gets the PUBLIC docs, not a login wall. This route is
  // the personalised view, it mints tokens and shows the keys you already hold,
  // which genuinely needs an account. Everything that does NOT need one (the MCP
  // endpoint, the npm client, the CLI, every curl example, the whole tool list)
  // lives at /connect and is readable signed-out. Sending an anonymous reader to
  // /login instead was a dead end: several "Connect an agent" links point here,
  // including one on the login page itself, so the answer to "how does an AI
  // connect?" was a login form, and the login page's own link bounced back to
  // it. Redirecting to the docs answers the question that was actually asked.
  if (!user) redirect("/connect");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : "";

  return (
    <div className="mx-auto max-w-4xl">
      <ConnectClient origin={origin} userEmail={user.email ?? ""} />
    </div>
  );
}
