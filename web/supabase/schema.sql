-- ============================================================================
--  $BUG: application database (Supabase Postgres)
-- ============================================================================
--  Run once in the Supabase SQL editor (or `supabase db execute -f`). This is
--  the REAL backend: accounts, programs, submissions and the tool marketplace
--  all live here and work with no blockchain deployed. The chain (escrow +
--  slashable bonds) is an optional layer that links to these rows later.
--
--  Security model: every table has row-level security ON. The browser uses the
--  anon key and can only do what the policies below allow, scoped to the
--  signed-in user (auth.uid()). Privileged/server work uses the service role,
--  which bypasses RLS, and only runs inside route handlers.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
--  profiles: one row per auth user, created automatically on signup
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  handle       text unique,
  display_name text,
  bio          text,
  avatar_url   text,
  website      text,
  wallet       text,                       -- optional linked wallet for on-chain
  role         text not null default 'hunter' check (role in ('hunter', 'client', 'both')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (auth.uid() = id);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (auth.uid() = id);

-- Auto-provision a profile when a user signs up. security definer so it can
-- write past RLS during the auth trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
--  programs: a funded bug-bounty program
-- ---------------------------------------------------------------------------
create table if not exists public.programs (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null references public.profiles (id) on delete cascade,
  slug               text unique not null,
  name               text not null,
  summary            text,
  description        text,                  -- markdown scope + rules
  targets            text[] not null default '{}',
  status             text not null default 'draft' check (status in ('draft','live','paused','closed')),
  currency           text not null default 'USDC',
  tier_low           numeric not null default 0,
  tier_medium        numeric not null default 0,
  tier_high          numeric not null default 0,
  tier_critical      numeric not null default 0,
  pool               numeric not null default 0,   -- escrow funded (off-chain accounting)
  paid_out           numeric not null default 0,
  response_days      int not null default 7,
  safe_harbor        boolean not null default true,
  logo_url           text,
  chain_id           bigint,                -- set when linked on-chain (optional)
  onchain_program_id bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists programs_status_idx on public.programs (status, created_at desc);
create index if not exists programs_owner_idx  on public.programs (owner);

alter table public.programs enable row level security;

-- Anyone can see non-draft programs; owners can see their own drafts too.
drop policy if exists programs_read on public.programs;
create policy programs_read on public.programs for select
  using (status <> 'draft' or owner = auth.uid());

drop policy if exists programs_insert on public.programs;
create policy programs_insert on public.programs for insert with check (owner = auth.uid());

drop policy if exists programs_update on public.programs;
create policy programs_update on public.programs for update using (owner = auth.uid());

drop policy if exists programs_delete on public.programs;
create policy programs_delete on public.programs for delete using (owner = auth.uid());

-- ---------------------------------------------------------------------------
--  submissions: a finding reported against a program
-- ---------------------------------------------------------------------------
create table if not exists public.submissions (
  id                uuid primary key default gen_random_uuid(),
  program_id        uuid not null references public.programs (id) on delete cascade,
  hunter            uuid not null references public.profiles (id) on delete cascade,
  title             text not null,
  severity          text not null default 'none' check (severity in ('none','low','medium','high','critical')),
  assigned_severity text check (assigned_severity in ('none','low','medium','high','critical')),
  status            text not null default 'pending'
                      check (status in ('pending','accepted','rejected','duplicate','spam','disclosed')),
  report            text,                   -- finding body (may be an encrypted envelope)
  encrypted         boolean not null default false,
  target            text,
  reward            numeric not null default 0,
  dupe_of           uuid references public.submissions (id),
  triage_note       text,
  created_at        timestamptz not null default now(),
  triaged_at        timestamptz
);

create index if not exists submissions_program_idx on public.submissions (program_id, created_at desc);
create index if not exists submissions_hunter_idx  on public.submissions (hunter, created_at desc);

alter table public.submissions enable row level security;

-- Visible to the hunter who filed it and the owner of the target program.
drop policy if exists submissions_read on public.submissions;
create policy submissions_read on public.submissions for select using (
  hunter = auth.uid()
  or exists (select 1 from public.programs p where p.id = program_id and p.owner = auth.uid())
);

-- A signed-in user files against a live program as themselves.
drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions for insert with check (
  hunter = auth.uid()
  and exists (select 1 from public.programs p where p.id = program_id and p.status = 'live')
);

-- The hunter may edit their own pending report; the program owner may triage.
drop policy if exists submissions_update on public.submissions;
create policy submissions_update on public.submissions for update using (
  hunter = auth.uid()
  or exists (select 1 from public.programs p where p.id = program_id and p.owner = auth.uid())
);

-- ---------------------------------------------------------------------------
--  updated_at touch trigger for programs + profiles
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists programs_touch on public.programs;
create trigger programs_touch before update on public.programs
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
--  Reputation + payout accounting (derived, maintained by trigger)
-- ---------------------------------------------------------------------------
--  Denormalized onto profiles/programs so the leaderboard and public profiles
--  are a plain, RLS-safe read of public tables, never exposing private report
--  contents. Recomputed from scratch on any submission change, so it can't
--  drift regardless of the status transition.
alter table public.profiles add column if not exists accepted_count int     not null default 0;
alter table public.profiles add column if not exists total_earned   numeric not null default 0;
alter table public.profiles add column if not exists rep            int     not null default 0;

create index if not exists profiles_rep_idx on public.profiles (rep desc, total_earned desc);

-- Credited = accepted or publicly disclosed.
create or replace function public.recompute_hunter(h uuid)
returns void language sql security definer set search_path = public as $$
  update public.profiles p set
    accepted_count = c.n,
    total_earned   = c.earned,
    rep            = c.rep
  from (
    select
      count(*)                 as n,
      coalesce(sum(reward), 0) as earned,
      coalesce(sum(case coalesce(assigned_severity, severity)
        when 'critical' then 40 when 'high' then 20
        when 'medium'   then 8  when 'low'  then 3 else 1 end), 0) as rep
    from public.submissions
    where hunter = h and status in ('accepted', 'disclosed')
  ) c
  where p.id = h;
$$;

create or replace function public.recompute_program(pid uuid)
returns void language sql security definer set search_path = public as $$
  update public.programs p
     set paid_out = coalesce((
       select sum(reward) from public.submissions
        where program_id = pid and status in ('accepted', 'disclosed')), 0)
   where p.id = pid;
$$;

create or replace function public.on_submission_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_hunter(old.hunter);
    perform public.recompute_program(old.program_id);
    return null;
  end if;
  -- INSERT or UPDATE
  perform public.recompute_hunter(new.hunter);
  perform public.recompute_program(new.program_id);
  if tg_op = 'UPDATE' then
    if old.hunter is distinct from new.hunter then
      perform public.recompute_hunter(old.hunter);
    end if;
    if old.program_id is distinct from new.program_id then
      perform public.recompute_program(old.program_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists submissions_stats on public.submissions;
create trigger submissions_stats after insert or update or delete on public.submissions
  for each row execute function public.on_submission_change();

-- Disclosed findings are public, but ONLY a safe projection of them. The base
-- table stays locked to the hunter + program owner: the `report` body and triage
-- notes must never leak. A row-level "status = 'disclosed'" read policy can't do
-- that (RLS is row-level, so it would expose every column, report included), so
-- instead we publish disclosed findings through a curated view. It runs
-- security-definer (as the view owner, bypassing base-table RLS) precisely so it
-- can expose these safe columns, and only these, to everyone. Title, severity,
-- reward and the hunter's public handle become a credential; the write-up doesn't.
drop policy if exists submissions_read_disclosed on public.submissions;

create or replace view public.disclosures with (security_invoker = false) as
  select
    s.id,
    s.title,
    s.severity,
    s.assigned_severity,
    s.reward,
    s.created_at,
    s.triaged_at,
    s.program_id,
    pr.slug         as program_slug,
    pr.name         as program_name,
    pr.currency     as program_currency,
    s.hunter        as hunter_id,
    hp.handle       as hunter_handle,
    hp.display_name as hunter_name,
    hp.avatar_url   as hunter_avatar
  from public.submissions s
  join public.programs pr on pr.id = s.program_id
  join public.profiles hp on hp.id = s.hunter
  where s.status = 'disclosed';

grant select on public.disclosures to anon, authenticated;

-- ---------------------------------------------------------------------------
--  tools: community marketplace (mirror of on-chain ToolRegistry, plus
--  off-chain listings where chain_id = 0). Service-role only; the browser
--  reaches it through /api/tools route handlers.
-- ---------------------------------------------------------------------------
create table if not exists public.tools (
  chain_id      bigint      not null,       -- 0 = published off-chain (no bond)
  tool_id       bigint      not null,
  publisher     text        not null,
  publisher_id  uuid references public.profiles (id) on delete set null,
  name          text        not null,
  description   text,
  platform      smallint    not null default 0,
  category      smallint    not null default 0,
  semver        text,
  checksum      text        not null,
  artifact_url  text        not null,
  artifact_name text        not null default 'tool',
  metadata_url  text        not null,
  source_url    text,
  tx_hash       text,
  downloads     bigint      not null default 0,
  flagged       boolean     not null default false,
  flag_count    int         not null default 0,
  created_at    timestamptz not null default now(),
  primary key (chain_id, tool_id)
);

create index if not exists tools_platform_idx on public.tools (platform);
create index if not exists tools_category_idx on public.tools (category);
create index if not exists tools_created_idx  on public.tools (created_at desc);
create index if not exists tools_search_idx   on public.tools
  using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

alter table public.tools enable row level security;
-- (no policies: only the service role, used server-side, may touch this table)

-- Sequence for off-chain tool ids (chain_id = 0).
create sequence if not exists public.offchain_tool_id_seq;

create or replace function public.next_offchain_tool_id()
returns bigint language sql as $$ select nextval('public.offchain_tool_id_seq'); $$;

create or replace function public.increment_tool_downloads(cid bigint, tid bigint)
returns bigint language sql as $$
  update public.tools set downloads = downloads + 1
   where chain_id = cid and tool_id = tid
  returning downloads;
$$;

-- ---------------------------------------------------------------------------
--  Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('tools',   'tools',   true)  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('reports', 'reports', false) on conflict (id) do nothing;

-- ============================================================================
--  On-chain escrow link: the hunter loop (commit, reveal, escalate, resolve)
-- ============================================================================
--  A program MAY link to a BugBounty deployment (`programs.onchain_program_id`).
--  Once linked, escrow, verdicts, bonds and the disclosure embargo are enforced
--  by the contract, and the columns below INDEX that state so it can be listed,
--  searched and joined like everything else. The chain is the source of truth;
--  this mirror is reconciled by /api/chain/tick.
--
--  A program with `onchain_program_id` null keeps working exactly as before: an
--  off-chain bounty with no escrow and no bond. Every hunter-facing surface must
--  say which mode a program is in (see the mode badge on the program page), or
--  hunters will believe they are bonded and escrowed when they are not.

-- Which asset the on-chain pool is denominated in, plus the scope document the
-- contract hashes. `description` stays the human-readable scope; these are the
-- values `createProgram` committed to, so a hunter can verify they agree.
alter table public.programs add column if not exists reward_token text;
alter table public.programs add column if not exists scope_hash   text;
alter table public.programs add column if not exists scope_uri    text;

-- The submission's chain identity + lifecycle. `report` already holds the
-- AES-GCM envelope for an encrypted finding; `report_sha256` is the hash of that
-- exact envelope, which is what the committed reportURI points at
-- (/api/reports/<sha256>).
alter table public.submissions add column if not exists chain_id             bigint;
alter table public.submissions add column if not exists onchain_submission_id bigint;
alter table public.submissions add column if not exists commit_hash          text;
alter table public.submissions add column if not exists report_uri           text;
alter table public.submissions add column if not exists report_sha256        text;
alter table public.submissions add column if not exists bond                 numeric not null default 0;
alter table public.submissions add column if not exists protocol_fee         numeric not null default 0;
alter table public.submissions add column if not exists revealed_at          timestamptz;
alter table public.submissions add column if not exists escalated_at         timestamptz;
alter table public.submissions add column if not exists dispute_deadline     timestamptz;
alter table public.submissions add column if not exists resolved_at          timestamptz;
alter table public.submissions add column if not exists tx_hash              text;

-- `Escalated` and `Resolved` are real states of the on-chain lifecycle (the
-- contract's SubStatus enum has seven members) and the off-chain row has to be
-- able to represent them, or an escalated finding renders as "pending" forever.
-- The reputation trigger deliberately ignores both: neither is a credit.
alter table public.submissions drop constraint if exists submissions_status_check;
alter table public.submissions add constraint submissions_status_check
  check (status in ('pending','accepted','rejected','duplicate','spam','disclosed','escalated','resolved'));

-- One row per on-chain submission, so the reconciler can upsert idempotently.
create unique index if not exists submissions_onchain_idx
  on public.submissions (chain_id, onchain_submission_id)
  where onchain_submission_id is not null;

create index if not exists submissions_report_hash_idx on public.submissions (report_sha256)
  where report_sha256 is not null;

-- ---------------------------------------------------------------------------
--  Who may decide a finding
-- ---------------------------------------------------------------------------
--  The old `submissions_update` policy let the hunter UPDATE their own row with
--  no column restriction, so a hunter could set status='accepted' and
--  reward=999999 on their own submission, and `recompute_hunter` would then
--  credit accepted_count, total_earned and rep from it. Reputation is the thing
--  the leaderboard ranks on, so that was a live integrity hole. Adding the chain
--  mirror makes it worse: a hunter could also forge an `onchain_submission_id`
--  that never existed.
--
--  Policies are row-level, so they cannot express "the hunter owns their
--  narrative but not the verdict". A guard trigger can.

-- Triage is the program owner's call, and the row must still belong to them
-- afterwards (WITH CHECK, which the old policy omitted entirely).
drop policy if exists submissions_update on public.submissions;
drop policy if exists submissions_triage on public.submissions;
create policy submissions_triage on public.submissions for update
to authenticated
using (
  exists (select 1 from public.programs p where p.id = program_id and p.owner = auth.uid())
)
with check (
  exists (select 1 from public.programs p where p.id = program_id and p.owner = auth.uid())
);

-- The hunter may still edit their own narrative while it is pending.
drop policy if exists submissions_hunter_update on public.submissions;
create policy submissions_hunter_update on public.submissions for update
to authenticated
using (hunter = auth.uid())
with check (hunter = auth.uid());

create or replace function public.guard_submission_columns()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_uid uuid;
  jwt_role  text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  -- The chain reconciler (/api/chain/tick) and the mirror writes run as the
  -- service role. It bypasses RLS, so it must bypass this guard too, or the
  -- chain could never be mirrored.
  --
  -- The test is written to survive both shapes of service credential: a legacy
  -- `service_role` JWT (claim role = 'service_role', uid null) and a non-JWT
  -- secret key (no claim at all, uid null). Only two roles can reach a write
  -- here: `authenticated`, which must pass the owner check below, and the
  -- service path, because `anon` has no UPDATE policy at all and is rejected by
  -- RLS before this trigger ever runs. These functions are SECURITY DEFINER, so
  -- checking `current_user` would just report the function's owner; the request
  -- claims are the honest signal.
  if auth.uid() is null and jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;

  select p.owner into owner_uid from public.programs p where p.id = new.program_id;
  if owner_uid is not null and owner_uid = auth.uid() then
    return new;
  end if;

  -- On INSERT the constraint is simpler but just as necessary: a hunter may file a
  -- finding, and that finding starts undecided. Without this, the same self-award
  -- the UPDATE branch blocks would simply be done at insert time, and
  -- `recompute_hunter` credits accepted rows from either path.
  if tg_op = 'INSERT' then
    if new.status <> 'pending'
       or coalesce(new.reward, 0) <> 0
       or new.assigned_severity is not null
       or new.triage_note is not null
       or new.triaged_at is not null
    then
      raise exception 'A finding is filed as pending; only the program owner can decide its outcome.'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- Everything the protocol decides is off-limits to the hunter. `report_uri`,
  -- `report_sha256`, `revealed_at` and the narrative fields stay writable: those
  -- are the hunter's own side of the loop.
  if new.status                is distinct from old.status
     or new.reward             is distinct from old.reward
     or new.assigned_severity  is distinct from old.assigned_severity
     or new.triage_note        is distinct from old.triage_note
     or new.triaged_at         is distinct from old.triaged_at
     or new.dupe_of            is distinct from old.dupe_of
     or new.protocol_fee       is distinct from old.protocol_fee
     or new.bond               is distinct from old.bond
     or new.resolved_at        is distinct from old.resolved_at
     or new.escalated_at       is distinct from old.escalated_at
     or new.dispute_deadline   is distinct from old.dispute_deadline
     or new.program_id         is distinct from old.program_id
     or new.hunter             is distinct from old.hunter
     or new.chain_id           is distinct from old.chain_id
     or new.onchain_submission_id is distinct from old.onchain_submission_id
     or new.commit_hash        is distinct from old.commit_hash
  then
    raise exception 'Only the program owner can decide the outcome of a finding.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard before insert or update on public.submissions
  for each row execute function public.guard_submission_columns();
