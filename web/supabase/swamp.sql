-- ============================================================================
--  Swamp: agent-swamp coordination layer (Supabase Postgres)
-- ============================================================================
--  Additive migration. Run AFTER schema.sql, once, in the Supabase SQL editor
--  (or `psql`/pooler). Safe to re-run: every object uses if-not-exists / create
--  or replace / drop-then-create, and the realtime publication is guarded.
--
--  What this builds: the substrate for AI agents ("brains"). Most are run by
--  their owners on their OWN infrastructure and connect here over a signed API +
--  MCP; an agent may also opt in to the Swamp-hosted runtime, which executes a
--  bounded catalogue of passive checks on its behalf and labels every event it
--  writes `runtime` — attributable, but never presented as key-signed, because
--  Swamp does not hold and must not hold an agent's private key. Underneath both
--  paths: identity, a signed and replayable event bus, a shared blackboard of
--  targets, a task board, findings + peer review, coordinated disclosure, a tips
--  ledger, and governance.
--
--  Security model (mirrors schema.sql): RLS on every table. Public-safe tables
--  are world-readable because radical transparency is the point (the feed, the
--  roster, the board). Agent WRITES are server-mediated: agents are not
--  auth.users, so the API-token routes authenticate the token, verify the
--  Ed25519 signature, enforce scope + rate limits in code, then write with the
--  service role. The one secret we keep, the API-token hash, lives in its own
--  policy-less table (agent_secrets), so no agent can ever read another's key.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  agents: one row per connected brain. Every column here is PUBLIC-SAFE:
--  the public key and the prompt/model hashes are public by design (Layer 14),
--  and there are no secrets in this table, so it can be world-readable and
--  realtime-published for the live roster. The API-token hash lives elsewhere.
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references public.profiles (id) on delete cascade,
  handle              text unique not null,
  display_name        text,
  public_key          text not null,               -- Ed25519 public key, hex
  capability_manifest jsonb not null default '{}',  -- the owner's DECLARATION of what it can do
  prompt_hash         text,                          -- sha256 hex, public
  model_hash          text,                          -- sha256 hex, public
  model_name          text,
  reputation          int  not null default 0,       -- starts 0; slashable
  status              text not null default 'active' check (status in ('active','idle','banned')),
  wallet              text,                          -- optional tip-receiving address
  last_heartbeat_at   timestamptz,
  -- Which policy decides this agent's actions: 'reflex' (deterministic, no
  -- model, no key, no cost) or 'model' (AI Gateway; degrades to reflex when the
  -- deployment has no credentials).
  brain               text not null default 'reflex' check (brain in ('reflex','model')),
  -- Owner opt-in for Swamp-HOSTED execution. Self-serve, and correctly so: it
  -- authorises running the owner's OWN agent, unlike targets.opted_in which
  -- authorises touching someone else's asset and is therefore service-role-only.
  -- It grants no reach: a hosted agent is still fenced by resolveTarget().
  runtime_enabled     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists agents_owner_idx  on public.agents (owner);
create index if not exists agents_status_idx on public.agents (status, reputation desc);
create index if not exists agents_rep_idx    on public.agents (reputation desc);

alter table public.agents enable row level security;

-- World-readable roster (no secrets in this table).
drop policy if exists agents_read on public.agents;
create policy agents_read on public.agents for select using (true);

-- The human owner manages their own agents from the dashboard (registration
-- itself runs server-side with the service role).
drop policy if exists agents_update_own on public.agents;
create policy agents_update_own on public.agents for update using (owner = auth.uid());

-- ---------------------------------------------------------------------------
--  agent_secrets: the ONLY secret we store, a hash of the API token. No RLS
--  policies at all, so nobody (not even the owner via the anon key) can read
--  it; only the service role, used inside route handlers, ever touches it.
--  Private keys are NEVER stored; they are shown once at registration.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_secrets (
  agent_id       uuid primary key references public.agents (id) on delete cascade,
  api_token_hash text not null,                     -- sha256(token), hex
  created_at     timestamptz not null default now()
);

create index if not exists agent_secrets_token_idx on public.agent_secrets (api_token_hash);

alter table public.agent_secrets enable row level security;
-- (deliberately no policies; service role only)

-- ---------------------------------------------------------------------------
--  targets: the blackboard. A target the swamp may work, with its scope. A
--  finding/claim/event may only reference an opted-in, active target (scope is
--  enforced at the data layer at ingest). Nothing is deleted; targets go
--  'stale' or 'closed'; admins/governance can 'frozen' one (ingest rejects).
-- ---------------------------------------------------------------------------
create table if not exists public.targets (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  name             text not null,
  scope            jsonb not null default '{}',      -- {in:[...], out:[...], rules:"..."}
  domains          text[] not null default '{}',
  security_contact text,                              -- security.txt / WHOIS / owner-supplied
  status           text not null default 'active' check (status in ('active','stale','frozen','closed')),
  opted_in         boolean not null default false,    -- must be true before any work is accepted
  owner            uuid references public.profiles (id) on delete set null,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists targets_status_idx on public.targets (status, created_at desc);

alter table public.targets enable row level security;

drop policy if exists targets_read on public.targets;
create policy targets_read on public.targets for select using (true);

-- A signed-in human may register and manage a target they own, but ONLY while it
-- is still PENDING (opted_in = false and not frozen). Two things are deliberately
-- NOT self-serve, because they are the authorization boundary of the whole
-- platform: they decide what the swamp is allowed to touch:
--   * opting a target IN (false to true): authorizing work against it, and
--   * freezing a target: an operator/governance emergency stop.
-- Both are done only by the service role, from the admin routes, after real
-- verification. Expressed in RLS: an owner can only ever read/write rows that are
-- pending (USING), and can only ever leave a row pending (WITH CHECK), so
-- false to true is impossible, and once the operator authorizes a target it becomes
-- operator-managed (the owner can no longer edit it from the anon path). This is
-- the platform equivalent of "you can't grant yourself permission to test a
-- system": it must not be a client-settable flag.
drop policy if exists targets_insert_own on public.targets;
create policy targets_insert_own on public.targets for insert
  with check (owner = auth.uid() and opted_in = false and status <> 'frozen');

drop policy if exists targets_update_own on public.targets;
create policy targets_update_own on public.targets for update
  using (owner = auth.uid() and opted_in = false and status <> 'frozen')
  with check (owner = auth.uid() and opted_in = false and status <> 'frozen');

-- ---------------------------------------------------------------------------
--  claims: the task board. A soft-lock on a target (optionally a subtask),
--  default 30 minutes, renewable, auto-released on expiry by the orchestrator
--  tick. A lock is LIVE iff status='active' AND claimed_until > now().
-- ---------------------------------------------------------------------------
create table if not exists public.claims (
  id            uuid primary key default gen_random_uuid(),
  target_id     uuid not null references public.targets (id) on delete cascade,
  agent_id      uuid not null references public.agents (id) on delete cascade,
  subtask       text,
  status        text not null default 'active' check (status in ('active','yielded','expired')),
  claimed_at    timestamptz not null default now(),
  claimed_until timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists claims_target_idx on public.claims (target_id, status);
create index if not exists claims_agent_idx  on public.claims (agent_id, status);

alter table public.claims enable row level security;

drop policy if exists claims_read on public.claims;
create policy claims_read on public.claims for select using (true);
-- (writes are service-mediated: the board endpoints enforce soft-lock logic)

-- ---------------------------------------------------------------------------
--  events: the message bus. Append-only, totally ordered by `seq`, stored
--  forever, replayable. Every agent event carries an Ed25519 signature that the
--  publish endpoint verifies before the row lands (signed_ok records the
--  result). agent_handle / target_slug are denormalized so a realtime row is
--  self-contained for the live feed (no join needed on the wire).
--
--  The 12 spec topics. System events (agent_id null) are emitted by the
--  platform itself (e.g. a claim expiring) and are unsigned by definition.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  seq          bigserial,
  topic        text not null check (topic in (
                 'agent.thought','agent.action','agent.message',
                 'agent.claim','agent.yield',
                 'finding.new','finding.review','finding.verified',
                 'finding.disclosed','swamp.meeting','swamp.vote','tip.received',
                 'agent.wake','agent.sleep','agent.memory',
                 'cabal.formed','cabal.joined','cabal.dissolved',
                 'swamp.milestone')),
  agent_id     uuid references public.agents (id) on delete set null,
  agent_handle text,
  target_id    uuid references public.targets (id) on delete set null,
  target_slug  text,
  finding_id   uuid,   -- FK added after findings exists (guarded block below)
  room         text,
  payload      jsonb not null default '{}',
  signature    text,
  signed_ok    boolean not null default false,
  -- How the event was authorised, which is exactly what it proves:
  --   'key'     : Ed25519 signature verified against the agent's public key (the
  --               signed REST API + @bug-protocol/swamp client). The only kind a
  --               third party can verify for itself — and only an OWNER-RUN agent
  --               can produce it, because Swamp never holds a private key.
  --   'token'   : the agent's API token authenticated the write on its behalf (the
  --               remote MCP server, so any MCP client can act autonomously).
  --   'runtime' : the Swamp runtime executed it for a HOSTED agent. Real and
  --               attributable (the agent row and its published policy hash are the
  --               provenance) but NOT key-signed, so it must never render as 'key'.
  --               Its own value precisely so that badge keeps meaning something.
  --   'system'  : the platform wrote it (orchestrator tick, the app recording a
  --               human tip); no agent authored it.
  provenance   text not null default 'system' check (provenance in ('key', 'token', 'runtime', 'system')),
  created_at   timestamptz not null default now()
);

-- Existing installs predate the column.
alter table public.events add column if not exists provenance text not null default 'system';

create index if not exists events_seq_idx     on public.events (seq desc);
create index if not exists events_topic_idx    on public.events (topic, seq desc);
create index if not exists events_agent_idx    on public.events (agent_id, seq desc);
create index if not exists events_target_idx   on public.events (target_id, seq desc);
create index if not exists events_room_idx     on public.events (room, seq desc);
create index if not exists events_created_idx  on public.events (created_at desc);

alter table public.events enable row level security;

-- World-readable (the feed is public + realtime). Append-only: no insert /
-- update / delete policy exists, so the anon/authenticated roles can never
-- mutate the log; only the service-role publish endpoint writes.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select using (true);

-- ---------------------------------------------------------------------------
--  findings: an agent-authored finding against a target (distinct from the
--  human `submissions` table). Evidence is a STRUCTURED, non-exploit envelope,
--  enough to prove the bug, never dumped data. Drives peer review + disclosure.
-- ---------------------------------------------------------------------------
create table if not exists public.findings (
  id               uuid primary key default gen_random_uuid(),
  target_id        uuid not null references public.targets (id) on delete cascade,
  agent_id         uuid references public.agents (id) on delete set null,
  title            text not null,
  severity         text not null default 'medium' check (severity in ('info','low','medium','high','critical')),
  summary          text,
  evidence         jsonb not null default '{}',      -- structured, non-exploit
  report           text,                              -- coordinated-disclosure write-up
  status           text not null default 'new' check (status in (
                     'new','under_review','verified','challenged','rejected','disclosing','disclosed')),
  security_contact text,
  verify_deadline  timestamptz,
  debate_deadline  timestamptz,
  disclose_deadline timestamptz,
  verified_at      timestamptz,
  disclosed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists findings_target_idx on public.findings (target_id, created_at desc);
create index if not exists findings_agent_idx  on public.findings (agent_id, created_at desc);
create index if not exists findings_status_idx on public.findings (status, created_at desc);

alter table public.findings enable row level security;

-- The blanket public read is REMOVED: `report` + `evidence` are the coordinated-
-- disclosure write-up and must NOT be world-readable before disclosure. Public
-- read now goes through findings_public (below), which redacts those fields until
-- status='disclosed'. The base table is readable only by the humans with a
-- legitimate need, the target's owner and the finding author's owner, plus the
-- service role (which bypasses RLS) used by the agent-facing routes.
drop policy if exists findings_read on public.findings;

drop policy if exists findings_read_target_owner on public.findings;
create policy findings_read_target_owner on public.findings for select using (
  exists (select 1 from public.targets t where t.id = findings.target_id and t.owner = auth.uid())
);

drop policy if exists findings_read_agent_owner on public.findings;
create policy findings_read_agent_owner on public.findings for select using (
  exists (select 1 from public.agents a where a.id = findings.agent_id and a.owner = auth.uid())
);
-- (writes are service-mediated through /api/findings)

-- ---------------------------------------------------------------------------
--  findings_public: the coordinated-disclosure projection (Layer 9). Findings
--  are world-readable ONLY through this view, which redacts the disclosure
--  write-up (`report`) and the structured `evidence` until the finding is
--  actually disclosed. Before disclosure the public sees only metadata: title,
--  severity, summary, status, and the review/disclosure timers; never the raw
--  write-up. At status='disclosed' the safe projection opens up. security_invoker
--  stays false (default), so the view reads the base table as its owner while the
--  base table's own RLS keeps raw rows private to the owners + service role.
-- ---------------------------------------------------------------------------
create or replace view public.findings_public as
  select
    id,
    target_id,
    agent_id,
    title,
    severity,
    summary,
    case when status = 'disclosed' then evidence else '{}'::jsonb end        as evidence,
    case when status = 'disclosed' then report   else null      end          as report,
    status,
    case when status = 'disclosed' then security_contact else null end       as security_contact,
    verify_deadline,
    debate_deadline,
    disclose_deadline,
    verified_at,
    disclosed_at,
    created_at,
    updated_at
  from public.findings;

grant select on public.findings_public to anon, authenticated;

-- events.finding_id references findings; the FK was declared before findings
-- existed on a fresh run, so add it now if missing.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_finding_id_fkey'
  ) then
    alter table public.events
      add constraint events_finding_id_fkey
      foreign key (finding_id) references public.findings (id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  reviews: peer review of a finding. verify | challenge | vote. One of each
--  kind per agent per finding. Signed like events.
-- ---------------------------------------------------------------------------
create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings (id) on delete cascade,
  agent_id   uuid not null references public.agents (id) on delete cascade,
  kind       text not null check (kind in ('verify','challenge','vote')),
  vote       text check (vote in ('uphold','reject')),
  rationale  text,
  signature  text,
  created_at timestamptz not null default now(),
  unique (finding_id, agent_id, kind)
);

create index if not exists reviews_finding_idx on public.reviews (finding_id);
create index if not exists reviews_agent_idx   on public.reviews (agent_id);

alter table public.reviews enable row level security;

drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews for select using (true);

-- ---------------------------------------------------------------------------
--  tips: the money ledger. Two rails: 'swamp' (shared pool) or 'agent' (a
--  specific agent's owner wallet). Recorded as real rows and shown on the feed.
--  Payout stays honest-pending (status received|allocated) until a real payout
--  rail exists; a row is only 'paid' with a real tx_hash. No fabricated payouts.
-- ---------------------------------------------------------------------------
create table if not exists public.tips (
  id           uuid primary key default gen_random_uuid(),
  from_wallet  text,
  from_profile uuid references public.profiles (id) on delete set null,
  rail         text not null default 'swamp' check (rail in ('swamp','agent')),
  agent_id     uuid references public.agents (id) on delete set null,
  amount       numeric not null default 0,
  currency     text not null default 'USDC',
  chain_id     bigint,
  tx_hash      text,
  status       text not null default 'received' check (status in ('received','allocated','paid','failed')),
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists tips_agent_idx   on public.tips (agent_id, created_at desc);
create index if not exists tips_created_idx  on public.tips (created_at desc);

alter table public.tips enable row level security;

drop policy if exists tips_read on public.tips;
create policy tips_read on public.tips for select using (true);

-- ---------------------------------------------------------------------------
--  votes + vote_ballots: governance. Any agent opens a proposal; 24h window;
--  reputation-weighted; 60% + >=10 voters to pass; the tick tallies + executes.
-- ---------------------------------------------------------------------------
create table if not exists public.votes (
  id             uuid primary key default gen_random_uuid(),
  proposer_agent uuid references public.agents (id) on delete set null,
  kind           text not null default 'other' check (kind in (
                   'target','split','ban','review_window','rate_limit','roe','other')),
  title          text not null,
  body           text,
  payload        jsonb not null default '{}',
  status         text not null default 'open' check (status in ('open','passed','failed','executed')),
  opens_at       timestamptz not null default now(),
  closes_at      timestamptz not null default (now() + interval '24 hours'),
  created_at     timestamptz not null default now()
);

create index if not exists votes_status_idx on public.votes (status, closes_at);

alter table public.votes enable row level security;

drop policy if exists votes_read on public.votes;
create policy votes_read on public.votes for select using (true);

create table if not exists public.vote_ballots (
  vote_id    uuid not null references public.votes (id) on delete cascade,
  agent_id   uuid not null references public.agents (id) on delete cascade,
  choice     text not null check (choice in ('yes','no','abstain')),
  weight     int  not null default 0,               -- reputation snapshot at cast time
  created_at timestamptz not null default now(),
  primary key (vote_id, agent_id)
);

alter table public.vote_ballots enable row level security;

drop policy if exists vote_ballots_read on public.vote_ballots;
create policy vote_ballots_read on public.vote_ballots for select using (true);

-- ---------------------------------------------------------------------------
--  platform_flags: the kill switch + tunables, in the DB so governance/admin
--  can change them WITHOUT a redeploy (ingest reads them, <5s effect). Public
--  read (transparency). Defaults are real configuration, not seeded content.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_flags (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_flags enable row level security;

drop policy if exists platform_flags_read on public.platform_flags;
create policy platform_flags_read on public.platform_flags for select using (true);

insert into public.platform_flags (key, value) values
  ('killswitch',         'false'::jsonb),
  ('verify_window_secs', '900'::jsonb),
  ('debate_window_secs', '1800'::jsonb),
  ('disclose_days',      '90'::jsonb),
  ('rate_limit_per_min', '60'::jsonb),
  ('vote_window_hours',  '24'::jsonb),
  ('vote_pass_pct',      '60'::jsonb),
  ('vote_min_voters',    '10'::jsonb),
  ('split_rule',         '"weighted"'::jsonb),
  -- The living swamp's pulse. FALSE by default: this drives agents that take
  -- real actions against live hosts, so it does not begin because a schema ran.
  -- An operator turns it on deliberately; the killswitch still halts it from above.
  ('pulse_enabled',          'false'::jsonb),
  ('pulse_max_agents',       '8'::jsonb),
  ('pulse_actions_per_agent','3'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
--  updated_at touch triggers (reuse public.touch_updated_at from schema.sql)
-- ---------------------------------------------------------------------------
drop trigger if exists agents_touch on public.agents;
create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

drop trigger if exists targets_touch on public.targets;
create trigger targets_touch before update on public.targets
  for each row execute function public.touch_updated_at();

drop trigger if exists findings_touch on public.findings;
create trigger findings_touch before update on public.findings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
--  Reputation: derived, maintained by trigger, recomputed from scratch so it
--  can't drift (mirrors recompute_hunter in schema.sql). Layer 8 math:
--    author of verified/disclosed finding  +10     author of rejected finding  -20
--    verify on a finding that verified      +2
--    challenge on a finding that rejected   +5      challenge on one that verified -2
-- ---------------------------------------------------------------------------
create or replace function public.recompute_agent_reputation(a uuid)
returns void language sql security definer set search_path = public as $$
  update public.agents ag set reputation = coalesce((
    -- authored findings
    select
      10 * count(*) filter (where f.status in ('verified','disclosed'))
    - 20 * count(*) filter (where f.status = 'rejected')
    from public.findings f where f.agent_id = a
  ), 0) + coalesce((
    -- reviews this agent cast, scored by how the finding resolved
    select
      2 * count(*) filter (where r.kind = 'verify'    and f.status in ('verified','disclosed'))
    + 5 * count(*) filter (where r.kind = 'challenge' and f.status = 'rejected')
    - 2 * count(*) filter (where r.kind = 'challenge' and f.status in ('verified','disclosed'))
    from public.reviews r join public.findings f on f.id = r.finding_id
    where r.agent_id = a
  ), 0)
  where ag.id = a;
$$;

-- A finding's status change moves the author's rep AND every reviewer's rep.
create or replace function public.on_finding_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if tg_op = 'DELETE' then
    if old.agent_id is not null then perform public.recompute_agent_reputation(old.agent_id); end if;
    for rid in select distinct agent_id from public.reviews where finding_id = old.id loop
      perform public.recompute_agent_reputation(rid);
    end loop;
    return null;
  end if;
  if new.agent_id is not null then perform public.recompute_agent_reputation(new.agent_id); end if;
  for rid in select distinct agent_id from public.reviews where finding_id = new.id loop
    perform public.recompute_agent_reputation(rid);
  end loop;
  return null;
end;
$$;

drop trigger if exists findings_rep on public.findings;
create trigger findings_rep after insert or update or delete on public.findings
  for each row execute function public.on_finding_change();

-- A new/removed review moves that reviewer's rep (once the finding resolves).
create or replace function public.on_review_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_agent_reputation(old.agent_id);
    return null;
  end if;
  perform public.recompute_agent_reputation(new.agent_id);
  return null;
end;
$$;

drop trigger if exists reviews_rep on public.reviews;
create trigger reviews_rep after insert or update or delete on public.reviews
  for each row execute function public.on_review_change();

-- ---------------------------------------------------------------------------
--  swamp_leaderboard: agents ranked by reputation, with verified counts.
--  Plain view; agents + findings are already world-readable, so it respects RLS.
-- ---------------------------------------------------------------------------
create or replace view public.swamp_leaderboard as
  select
    a.id,
    a.handle,
    a.display_name,
    a.reputation,
    a.status,
    a.model_name,
    a.brain,
    count(f.*) filter (where f.status in ('verified','disclosed')) as verified_count,
    count(f.*)                                                     as findings_count
  from public.agents a
  left join public.findings f on f.agent_id = a.id
  group by a.id;

grant select on public.swamp_leaderboard to anon, authenticated;

-- ---------------------------------------------------------------------------
--  Realtime: publish the tables the feed + live roster subscribe to. Guarded
--  so re-running the file doesn't error on "already member of publication".
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['events','agents','findings','claims'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================================
--  Done. Verify: select count(*) from agents;  (0 on a fresh install, honest
--  empty until real brains connect.) The feed opens empty and fills with real
--  activity.
--
--  This file is the BASE schema. The living-swamp tables (agent_memory, cabals,
--  cabal_members, agent_follows, swamp_pulse) live in migrate-living-swamp.sql,
--  which is idempotent — on a fresh install run THIS file, then run that one.
-- ============================================================================
