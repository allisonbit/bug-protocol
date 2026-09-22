"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import { chainMeta } from "@/lib/chains";
import { readChainProgram, readChainSubmission, toBugAmount } from "@/lib/onchain";
import { mirrorChainSubmission } from "@/lib/chainMirror";
import { slugify, type Severity, type SubmissionStatus, type ProgramStatus } from "@/lib/db";
import {
  emitProgramOpened,
  emitProgramFunded,
  emitRewardPaid,
  emitProgramClosed,
} from "@/lib/bounty/escrow";

/**
 * Server actions: the real write path. Each runs through the request-scoped,
 * cookie-authenticated Supabase client, so row-level security is what actually
 * authorizes the write. We still pass owner/hunter = the signed in user so the
 * RLS `with check` clauses pass.
 */

function num(v: FormDataEntryValue | null, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function str(v: FormDataEntryValue | null): string {
  return (typeof v === "string" ? v : "").trim();
}

/**
 * The signed in user's linked wallet address, lower-cased, or null.
 *
 * This is the only thing tying a Supabase account to a chain identity. It is what
 * stops a hunter indexing someone else's onchain submission as their own, and
 * therefore what stops them farming `rep` off a stranger's accepted finding.
 */
async function profileWallet(sb: SupabaseClient, uid: string): Promise<string | null> {
  const { data } = await sb.from("profiles").select("wallet").eq("id", uid).maybeSingle();
  const w = (data as { wallet: string | null } | null)?.wallet?.trim();
  return w ? w.toLowerCase() : null;
}

export async function createProgram(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login?next=/programs/new");

  const name = str(formData.get("name"));
  if (!name) throw new Error("A program needs a name.");

  const targets = str(formData.get("targets"))
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

  const status: ProgramStatus = str(formData.get("status")) === "live" ? "live" : "draft";

  const currency = str(formData.get("currency")) || "USDC";
  const tiers = {
    tier_low: num(formData.get("tier_low")),
    tier_medium: num(formData.get("tier_medium")),
    tier_high: num(formData.get("tier_high")),
    tier_critical: num(formData.get("tier_critical")),
  };

  const { data, error } = await sb
    .from("programs")
    .insert({
      owner: user.id,
      slug: slugify(name),
      name,
      summary: str(formData.get("summary")) || null,
      description: str(formData.get("description")) || null,
      targets,
      currency,
      ...tiers,
      pool: num(formData.get("pool")),
      response_days: num(formData.get("response_days"), 14),
      safe_harbor: formData.get("safe_harbor") === "on",
      status,
    })
    .select("slug")
    .single();

  if (error) throw new Error(error.message);

  // A live programme is news; a draft is not. The escrow side of the product had
  // no public row at all before this, so a programme that takes reports now says
  // so on the bus the moment it does.
  if (status === "live") {
    await emitProgramOpened({ slug: data.slug, name, currency, ...tiers });
  }

  revalidatePath("/programs");
  revalidatePath("/dashboard");
  redirect(`/programs/${data.slug}`);
}

/**
 * Files a finding.
 *
 * Two modes, decided by whether the program is linked to an escrow deployment:
 *
 *  - **Linked (escrowed).** The commit is already on chain by the time we get
 *    here, so this is really a *verification and indexing* step: we read the
 *    submission back off the chain and refuse the row unless it exists, belongs
 *    to this program, and was filed by the wallet on the hunter's profile.
 *    Without that check anyone could index a stranger's accepted finding under
 *    their own account and the reputation trigger would credit them for it.
 *
 *  - **Unlinked (offchain).** Same encrypted envelope and same commit receipt,
 *    no escrow. This is the path that keeps working with no contract deployed at
 *    all, the receipt is still a timestamped, salt-bound proof of authorship.
 *
 * The report body arrives already encrypted when the hunter chose to encrypt,
 * which is the default. Plaintext is stored only if they explicitly opted out.
 */
export async function submitFinding(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  const slug = str(formData.get("slug"));
  if (!sb || !user) redirect(`/login?next=/programs/${slug}/submit`);

  const programId = str(formData.get("program_id"));
  const title = str(formData.get("title"));
  const report = str(formData.get("report"));
  if (!programId || !title || !report) throw new Error("Title and report are required.");

  const severity = (str(formData.get("severity")) || "medium") as Severity;

  // RLS scopes this read to programs the caller can see, and the insert policy
  // independently requires a live program; this is only to learn the mode.
  const { data: progData } = await sb
    .from("programs")
    .select("id,status,onchain_program_id,reward_token")
    .eq("id", programId)
    .maybeSingle();
  const program = progData as
    | { id: string; status: string; onchain_program_id: number | null; reward_token: string | null }
    | null;
  if (!program) throw new Error("No such program, or it isn't accepting submissions.");

  const row: Record<string, unknown> = {
    program_id: programId,
    hunter: user.id,
    title,
    severity,
    report,
    encrypted: str(formData.get("encrypted")) === "1",
    target: str(formData.get("target")) || null,
    commit_hash: str(formData.get("commit_hash")).toLowerCase() || null,
    report_uri: str(formData.get("report_uri")) || null,
    report_sha256: str(formData.get("report_sha256")).toLowerCase() || null,
  };

  if (program.onchain_program_id) {
    const chainId = Number(str(formData.get("chain_id")));
    const onchainRaw = str(formData.get("onchain_submission_id"));
    const onchainId = /^\d+$/.test(onchainRaw) ? BigInt(onchainRaw) : 0n;
    if (!chainId || onchainId === 0n) {
      throw new Error(
        "This program is escrowed onchain, so the finding has to be committed there first. Nothing was recorded.",
      );
    }

    const chain = await readChainSubmission(chainId, onchainId);
    if (!chain) throw new Error("Couldn't find that submission onchain. Nothing was recorded.");
    if (chain.programId !== BigInt(program.onchain_program_id)) {
      throw new Error("That onchain submission belongs to a different program.");
    }

    const wallet = await profileWallet(sb, user.id);
    if (!wallet) {
      throw new Error(
        "Link your wallet in Settings before reporting to an escrowed program. It's how the finding is tied to you. Nothing was recorded.",
      );
    }
    if (chain.hunter.toLowerCase() !== wallet) {
      throw new Error("That onchain submission was filed by a different wallet than the one on your profile.");
    }

    const commitHash = String(row.commit_hash ?? "");
    if (commitHash && chain.commitHash.toLowerCase() !== commitHash) {
      throw new Error("That onchain submission commits to a different report URI.");
    }

    row.chain_id = chainId;
    row.onchain_submission_id = Number(onchainId);
    row.commit_hash = chain.commitHash.toLowerCase();
    row.bond = toBugAmount(chain.bond);
    // Always filed as pending, never as whatever the chain currently says. Two
    // reasons: the insert guard rightly refuses a hunter inserting a finding that
    // already has a decision, and the privileged mirror is the only writer allowed
    // to move a row past pending. A retry against an existing onchain submission
    // is redirected above rather than re-inserted.
    row.status = "pending";
    row.tx_hash = str(formData.get("tx_hash")) || null;

    // Duplicate rows for the same onchain submission would double-count
    // reputation, so refuse rather than let the unique index throw.
    const { data: existing } = await sb
      .from("submissions")
      .select("id")
      .eq("chain_id", chainId)
      .eq("onchain_submission_id", Number(onchainId))
      .maybeSingle();
    if (existing) redirect(`/submissions/${(existing as { id: string }).id}`);
  }

  const { data, error } = await sb.from("submissions").insert(row).select("id").single();
  if (error) throw new Error(error.message);

  // Confirm the row and the chain agree before the hunter lands on the page, so
  // the detail view never shows "pending" for a submission the chain already paid.
  await mirrorChainSubmission((data as { id: string }).id);

  revalidatePath("/dashboard");
  revalidatePath(`/programs/${slug}`);
  redirect(`/submissions/${data.id}`);
}

/**
 * Records the onchain deployment an existing offchain program points at.
 *
 * Verify-first: the id has to be a real program on that chain, and it has to be
 * owned by the wallet on the owner's profile. Otherwise an owner could link a
 * program id they don't control, and the site would advertise escrow that isn't
 * funding their program's payouts.
 */
export async function linkProgramOnChain(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("program_id"));
  const slug = str(formData.get("slug"));
  const chainId = Number(str(formData.get("chain_id")));
  const onchainRaw = str(formData.get("onchain_program_id"));
  if (!id || !chainId || !/^\d+$/.test(onchainRaw)) throw new Error("A chain and a program id are required.");
  const onchainId = BigInt(onchainRaw);

  const meta = chainMeta(chainId);
  if (!meta.bounty) throw new Error(`The protocol isn't deployed on ${meta.label} yet.`);

  const chain = await readChainProgram(chainId, onchainId);
  if (!chain) throw new Error(`Program #${onchainRaw} doesn't exist on ${meta.label}.`);

  const wallet = await profileWallet(sb, user.id);
  if (!wallet) throw new Error("Link your wallet in Settings first. It's how ownership is proved.");
  if (chain.owner.toLowerCase() !== wallet) {
    throw new Error("That onchain program is owned by a different wallet than the one on your profile.");
  }

  // RLS restricts this update to the program's owner.
  const { error } = await sb
    .from("programs")
    .update({
      chain_id: chainId,
      onchain_program_id: Number(onchainId),
      reward_token: chain.rewardToken,
      scope_hash: chain.scopeHash,
      scope_uri: chain.scopeURI,
    })
    .eq("id", id)
    .eq("owner", user.id);
  if (error) throw new Error(error.message);

  revalidatePath(`/programs/${slug}`);
  revalidatePath("/programs");
  revalidatePath("/dashboard");
}

/** Removes the link, e.g. after pointing at the wrong program id. */
export async function unlinkProgram(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("program_id"));
  const slug = str(formData.get("slug"));
  if (!id) throw new Error("A program id is required.");

  // Findings that are already onchain stay onchain; repointing the program
  // would strand them, so we refuse rather than quietly orphaning escrow.
  const { count } = await sb
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("program_id", id)
    .not("onchain_submission_id", "is", null);
  if ((count ?? 0) > 0) {
    throw new Error("This program already has onchain findings, so its link can't be removed.");
  }

  const { error } = await sb
    .from("programs")
    .update({ chain_id: null, onchain_program_id: null, reward_token: null, scope_hash: null, scope_uri: null })
    .eq("id", id)
    .eq("owner", user.id);
  if (error) throw new Error(error.message);

  revalidatePath(`/programs/${slug}`);
  revalidatePath("/programs");
}

/**
 * Pulls the chain's current verdict for a row into the index.
 *
 * The caller supplies nothing but the row id, and only the hunter or the program
 * owner may ask. Everything written is read back off the chain, so this is safe
 * to expose to a browser: the worst a malicious caller can do is refresh state
 * that is already public.
 */
export async function mirrorSubmission(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("submission_id"));
  if (!id) throw new Error("A submission id is required.");

  // RLS returns the row only to the hunter or the program owner.
  const { data } = await sb.from("submissions").select("id").eq("id", id).maybeSingle();
  if (!data) throw new Error("No submission with that id, or you don't have access to it.");

  const result = await mirrorChainSubmission(id);
  if (!result.ok) throw new Error(result.reason);

  revalidatePath(`/submissions/${id}`);
  revalidatePath("/dashboard");
}

/**
 * Records a triage decision.
 *
 * Two modes again, and the difference is who is allowed to decide the number:
 *
 *  - **Escrowed program.** The owner must have signed the onchain `triage`
 *    transaction; we require its hash, read the verdict back off the chain, and
 *    mirror that. Client-supplied status and reward are ignored entirely. The
 *    contract already decided the award out of escrow, and letting a form field
 *    override it would be inventing money. Only the note is taken from the form,
 *    and it's written through RLS as the owner.
 *
 *  - **Offchain program.** The owner sets the outcome and reward directly, as
 *    before. There is no escrow to be inconsistent with.
 */
export async function triageSubmission(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("submission_id"));
  const note = str(formData.get("triage_note"));
  if (!id) throw new Error("A submission id is required.");

  const { data: subData } = await sb
    .from("submissions")
    .select("id,program_id,chain_id,onchain_submission_id")
    .eq("id", id)
    .maybeSingle();
  const sub = subData as
    | { id: string; program_id: string; chain_id: number | null; onchain_submission_id: number | null }
    | null;
  if (!sub) throw new Error("No submission with that id, or you don't have access to it.");

  const { data: progData } = await sb
    .from("programs")
    .select("id,owner,onchain_program_id,slug,name,currency")
    .eq("id", sub.program_id)
    .maybeSingle();
  const program = progData as
    | { id: string; owner: string; onchain_program_id: number | null; slug: string; name: string; currency: string }
    | null;
  if (!program || program.owner !== user.id) {
    throw new Error("Only the program owner can triage a finding.");
  }

  if (program.onchain_program_id) {
    const txHash = str(formData.get("tx_hash"));
    if (!txHash) {
      throw new Error(
        "This program is escrowed onchain: send the triage transaction first, then record it. Nothing was changed.",
      );
    }

    const mirror = await mirrorChainSubmission(id);
    if (!mirror.ok) throw new Error(mirror.reason);
    if (mirror.chain.status === "pending") {
      throw new Error("The chain still shows this finding as pending. The transaction may not have confirmed yet.");
    }

    // The chain's verdict is now mirrored; the note is the owner's own text.
    const { error } = await sb.from("submissions").update({ triage_note: note || null }).eq("id", id);
    if (error) throw new Error(error.message);

    // The escrow moved on chain, and the public trace of that had nowhere to go
    // before this. Read the mirrored row back and announce the payout the contract
    // decided, not a number from the form.
    const { data: after } = await sb
      .from("submissions")
      .select("status,reward,assigned_severity,severity")
      .eq("id", id)
      .maybeSingle();
    const a = after as { status: string; reward: number | null; assigned_severity: string | null; severity: string } | null;
    if (a && a.status === "accepted" && Number(a.reward ?? 0) > 0) {
      await emitRewardPaid({
        slug: program.slug,
        name: program.name,
        currency: program.currency,
        amount: Number(a.reward),
        severity: a.assigned_severity ?? a.severity,
        submission: id,
      });
    }

    revalidatePath(`/submissions/${id}`);
    revalidatePath("/dashboard");
    return;
  }

  const status = str(formData.get("status")) as SubmissionStatus;
  const assigned = str(formData.get("assigned_severity")) as Severity | "";
  const reward = num(formData.get("reward"));

  const patch: Record<string, unknown> = {
    status,
    triage_note: note || null,
    triaged_at: new Date().toISOString(),
  };
  if (assigned) patch.assigned_severity = assigned;
  if (status === "accepted") patch.reward = reward;

  const { error } = await sb.from("submissions").update(patch).eq("id", id);
  if (error) throw new Error(error.message);

  // An accepted finding with money on it is a payout, and a payout belongs on the
  // public record the way a funded programme does. Only on acceptance, and only
  // when a reward was actually set: an accepted zero-severity report moved nothing.
  if (status === "accepted" && reward > 0) {
    await emitRewardPaid({
      slug: program.slug,
      name: program.name,
      currency: program.currency,
      amount: reward,
      severity: assigned || "medium",
      submission: id,
    });
  }

  revalidatePath(`/submissions/${id}`);
  revalidatePath("/dashboard");
}

export async function discloseSubmission(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("submission_id"));
  const makePublic = str(formData.get("disclose")) === "on";
  const slug = str(formData.get("slug"));
  const handle = str(formData.get("handle"));
  if (!id) throw new Error("A submission id is required.");

  // Disclosure is the program owner's call (coordinated: publish only after the
  // fix ships). Verify ownership via the program, and only allow the reversible
  // accepted to disclosed transition; the trigger keeps rep/earnings intact.
  const { data: cur, error: cErr } = await sb
    .from("submissions")
    .select("id,status,program_id")
    .eq("id", id)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!cur) throw new Error("No submission with that id, or you don't have access to it.");
  const s = cur as { id: string; status: SubmissionStatus; program_id: string };

  const { data: prog } = await sb
    .from("programs")
    .select("id")
    .eq("id", s.program_id)
    .eq("owner", user.id)
    .maybeSingle();
  if (!prog) throw new Error("Only the program owner can change a finding's disclosure.");

  if (makePublic && s.status !== "accepted") throw new Error("Only an accepted finding can be disclosed.");
  if (!makePublic && s.status !== "disclosed") throw new Error("This finding isn't disclosed.");

  const next: SubmissionStatus = makePublic ? "disclosed" : "accepted";
  const { error } = await sb.from("submissions").update({ status: next }).eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath(`/submissions/${id}`);
  revalidatePath("/dashboard");
  revalidatePath("/hunters");
  if (slug) revalidatePath(`/programs/${slug}`);
  if (handle) revalidatePath(`/u/${handle}`);
}

export async function setProgramStatus(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("program_id"));
  const slug = str(formData.get("slug"));
  const status = str(formData.get("status")) as ProgramStatus;

  // Read the row first so the bus can say what changed rather than only that
  // something did, and so a reopening programme carries its own balance again.
  const { data: before } = await sb
    .from("programs")
    .select("status,slug,name,currency,pool,paid_out,tier_low,tier_medium,tier_high,tier_critical")
    .eq("id", id)
    .maybeSingle();
  const prior = before as
    | {
        status: string;
        slug: string;
        name: string;
        currency: string;
        pool: number;
        paid_out: number;
        tier_low: number;
        tier_medium: number;
        tier_high: number;
        tier_critical: number;
      }
    | null;

  // RLS already restricts updates to the owner; scope by owner too for belt-and-braces.
  const { error } = await sb
    .from("programs")
    .update({ status })
    .eq("id", id)
    .eq("owner", user.id);
  if (error) throw new Error(error.message);

  // The listing change is the escrow product's own news, so it goes on the same
  // record the money does: going live is a programme opening, and closing is the
  // end of it, announced with what it paid out before it stopped.
  if (prior && prior.status !== status) {
    if (status === "live") {
      await emitProgramOpened({
        slug: prior.slug,
        name: prior.name,
        currency: prior.currency,
        tier_low: prior.tier_low,
        tier_medium: prior.tier_medium,
        tier_high: prior.tier_high,
        tier_critical: prior.tier_critical,
      });
    } else if (status === "closed") {
      await emitProgramClosed({ slug: prior.slug, name: prior.name, currency: prior.currency, paid_out: Number(prior.paid_out ?? 0) });
    }
  }

  revalidatePath(`/programs/${slug}`);
  revalidatePath("/programs");
  revalidatePath("/dashboard");
}

/**
 * Puts more money behind a programme, and says so on the record.
 *
 * The pool could previously only be set once, in the create form. A programme that
 * wanted to grow its rewards had to be closed and recreated, which threw away its
 * history and its findings: the escrow number a hunter is weighing was frozen at
 * birth. This is the missing top-up, and it emits `program.funded` with the new
 * balance so a reader sees the total rather than having to add the deltas up.
 */
export async function fundProgram(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login");

  const id = str(formData.get("program_id"));
  const slug = str(formData.get("slug"));
  const amount = num(formData.get("amount"));
  if (!id) throw new Error("A program id is required.");
  if (amount <= 0) throw new Error("A top-up has to be a positive amount.");

  const { data: prog } = await sb
    .from("programs")
    .select("pool,name,currency,status")
    .eq("id", id)
    .eq("owner", user.id)
    .maybeSingle();
  const p = prog as { pool: number; name: string; currency: string; status: string } | null;
  if (!p) throw new Error("No such program, or you don't own it.");

  const pool = Number(p.pool ?? 0) + amount;
  const { error } = await sb.from("programs").update({ pool }).eq("id", id).eq("owner", user.id);
  if (error) throw new Error(error.message);

  await emitProgramFunded({ slug: slug || id, name: p.name, currency: p.currency, pool, added: amount });

  revalidatePath(`/programs/${slug}`);
  revalidatePath("/programs");
  revalidatePath("/dashboard");
}

/**
 * Follow or unfollow an agent.
 *
 * The write runs through the request-scoped client, so the RLS policies on
 * `agent_follows` are what authorize it: you may insert and delete only rows
 * whose `profile_id` is you. Nothing here re-implements that check, it passes
 * the signed in id and lets the database refuse anything else, which is the same
 * rule the rest of this file follows.
 *
 * Following is a reader's action, not the agent's. It changes what a person sees
 * and nothing about what the swarm does.
 */
export async function toggleFollow(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  const agentId = str(formData.get("agent_id"));
  const handle = str(formData.get("handle"));
  const next = str(formData.get("next")) || (handle ? `/agents/${handle}` : "/swamp");
  if (!sb || !user) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!agentId) throw new Error("An agent id is required.");

  const { data: existing } = await sb
    .from("agent_follows")
    .select("agent_id")
    .eq("profile_id", user.id)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from("agent_follows").delete().eq("profile_id", user.id).eq("agent_id", agentId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from("agent_follows").insert({ profile_id: user.id, agent_id: agentId });
    if (error) throw new Error(error.message);
  }

  revalidatePath("/swamp");
  if (handle) revalidatePath(`/agents/${handle}`);
}

export async function updateProfile(formData: FormData) {
  const sb = await supabaseServer();
  const user = await currentUser();
  if (!sb || !user) redirect("/login?next=/settings");

  const handle = str(formData.get("handle")).toLowerCase().replace(/[^a-z0-9_]/g, "") || null;

  const { error } = await sb
    .from("profiles")
    .update({
      display_name: str(formData.get("display_name")) || null,
      handle,
      bio: str(formData.get("bio")) || null,
      website: str(formData.get("website")) || null,
      wallet: str(formData.get("wallet")) || null,
    })
    .eq("id", user.id);

  if (error) throw new Error(error.message);

  revalidatePath("/settings");
  revalidatePath("/dashboard");
}
