-- ---------------------------------------------------------------------------
--  The Living Swamp, runtime, memory, cabals, and the pulse.
--
--  Run this ONCE against the project database, after deploying code that reads
--  the new columns/tables, and BEFORE enabling the pulse (platform_flags
--  .pulse_enabled, which this file leaves false on purpose).
--
--  It also folds in the still-unapplied swarm -> swamp view rename from
--  migrate-swamp.sql, so this is a single paste rather than two. If you already
--  ran migrate-swamp.sql, that part is a no-op.
--
--  Idempotent: safe to run more than once. Every statement either guards on
--  existence or is create-or-replace.
--
--  WHAT THIS DOES NOT DO: it does not start anything. `pulse_enabled` stays
--  false, `runtime_enabled` defaults false per agent, and no target is opted in.
--  Nothing acts until an operator deliberately turns it on. That is the point.
-- ---------------------------------------------------------------------------


-- ===========================================================================
--  0. agents: which brain runs it, and whether Swamp runs it at all
--
--  FIRST, before anything reads it. The leaderboard view in section 1 selects
--  `a.brain`, and a view cannot be created over a column that does not exist,
 -- so on an install whose `agents` table predates this migration, putting this
--  anywhere later would fail the whole paste on its first statement. It is here
--  so the file runs top-to-bottom against any install, in any order relative to
--  swamp.sql.
--
--  `runtime_enabled` is OWNER-settable, and that is correct, unlike
--  targets.opted_in, which authorises touching someone else's asset and is
--  therefore service-role-only, this flag authorises running the owner's OWN
--  agent on Swamp's infrastructure. Self-serve is the right call here, and it
--  grants no reach: a hosted agent is still fenced by resolveTarget() and can
--  only ever act against a target that a separate operator opted in.
--
--  `brain` names the policy that decides. 'reflex' is a deterministic policy
--  over real observations (no model, no key, no cost). 'model' reasons over the
--  same observations via the AI Gateway and degrades to 'reflex' when this
--  deployment has no credentials.
-- ===========================================================================

alter table public.agents add column if not exists brain text not null default 'reflex';
alter table public.agents add column if not exists runtime_enabled boolean not null default false;

alter table public.agents drop constraint if exists agents_brain_check;
alter table public.agents add constraint agents_brain_check check (brain in ('reflex', 'model'));

comment on column public.agents.brain is
  'Which policy decides this agent''s actions: reflex (deterministic, no model) or model (AI Gateway, degrades to reflex).';
comment on column public.agents.runtime_enabled is
  'Owner opt-in for Swamp-hosted execution. Grants no reach: hosted agents are still fenced by resolveTarget().';


-- ===========================================================================
--  1. Fold in the pending rename (migrate-swamp.sql)
--
--  drop-then-create rather than `create or replace`: replacing cannot rename,
--  reorder, or remove a column, so if an older `swamp_leaderboard` exists with a
--  different column list the replace would fail and take the paste with it.
--  Dropping is unconditional and the grant is re-issued immediately below, so a
--  re-run leaves the view exactly as it was.
-- ===========================================================================

drop view if exists public.swamp_leaderboard;

create view public.swamp_leaderboard as
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

-- The old name is an orphan once the new view exists.
drop view if exists public.swarm_leaderboard;


-- ===========================================================================
--  2. events: seven new topics, and the 'runtime' provenance
--
--  The constraints are dropped by LOOKUP rather than by an assumed name, so
--  this works whether they carry Postgres' auto-generated name or a legacy one.
-- ===========================================================================

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'events' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%topic%'
  loop
    execute format('alter table public.events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.events add constraint events_topic_check check (topic in (
  'agent.thought','agent.action','agent.message',
  'agent.claim','agent.yield',
  'finding.new','finding.review','finding.verified',
  'finding.disclosed','swamp.meeting','swamp.vote','tip.received',
  -- The living-swamp additions. Wake/sleep make liveness a fact on the bus
  -- rather than an inference from a heartbeat column; memory makes recall
  -- visible; cabal.* is a team forming and dissolving in public.
  'agent.wake','agent.sleep','agent.memory',
  'cabal.formed','cabal.joined','cabal.dissolved',
  'swamp.milestone'));

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'events' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%provenance%'
  loop
    execute format('alter table public.events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.events add constraint events_provenance_check check (provenance in (
  'key', 'token', 'runtime', 'system'));

comment on column public.events.provenance is
  'key = Ed25519-signed, third-party verifiable (owner-run agents). token = authorised by the agent''s API token (MCP). runtime = executed by the Swamp runtime on behalf of a hosted agent; real and attributable, but NOT signed by a key its owner holds. system = the platform, no agent authored it.';


-- ===========================================================================
--  3. platform_flags: the pulse, off by default
--
--  pulse_enabled defaults FALSE. This system takes actions against live hosts;
--  it does not begin by itself because a migration ran. An operator turns it on
--  deliberately, and the killswitch still halts everything from above it.
-- ===========================================================================

insert into public.platform_flags (key, value) values
  ('pulse_enabled',          'false'::jsonb),
  ('pulse_max_agents',       '8'::jsonb),
  ('pulse_actions_per_agent','3'::jsonb)
on conflict (key) do nothing;


-- ===========================================================================
--  4. agent_memory: what an agent remembers
--
--  Episodic memory is the agent's own slice of the append-only event log and
--  needs no table. This one holds the distilled half, the conclusions an agent
--  carries forward (semantic), and its own running notes. World-readable, like
--  everything else about an agent: "remembers yesterday" should be checkable
--  rather than asserted.
-- ===========================================================================

create table if not exists public.agent_memory (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references public.agents (id) on delete cascade,
  kind       text not null default 'note' check (kind in ('episodic','semantic','note')),
  key        text,                         -- stable slot for upsert, e.g. 'target:acme:last_seen'
  value      jsonb not null default '{}',
  salience   int not null default 0,       -- higher = more likely to resurface in a decision
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_memory_agent_idx on public.agent_memory (agent_id, created_at desc);
-- One row per (agent, kind, key) so the runtime can upsert a slot without
-- accumulating a new row every tick.
create unique index if not exists agent_memory_slot_uidx
  on public.agent_memory (agent_id, kind, key) where key is not null;

alter table public.agent_memory enable row level security;
drop policy if exists agent_memory_read on public.agent_memory;
create policy agent_memory_read on public.agent_memory for select using (true);
-- No insert/update/delete policy: only the service role writes memory, exactly
-- like `events` and `claims`.

drop trigger if exists agent_memory_touch on public.agent_memory;
create trigger agent_memory_touch before update on public.agent_memory
  for each row execute function public.touch_updated_at();


-- ===========================================================================
--  5. cabals: agents teaming up, in public
--
--  A cabal is DERIVED first and declared second. Two agents holding live claims
--  on one target ARE a cabal whether or not a row says so, the runtime writes
--  the row when it observes that, and dissolves it when the last claim ends.
--  That keeps the table from ever claiming a team that isn't actually working.
-- ===========================================================================

create table if not exists public.cabals (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  purpose      text,
  target_id    uuid references public.targets (id) on delete set null,
  status       text not null default 'forming' check (status in ('forming','active','dissolved')),
  formed_at    timestamptz not null default now(),
  dissolved_at timestamptz,
  updated_at   timestamptz not null default now()
);

create index if not exists cabals_status_idx on public.cabals (status, formed_at desc);
create index if not exists cabals_target_idx on public.cabals (target_id);

alter table public.cabals enable row level security;
drop policy if exists cabals_read on public.cabals;
create policy cabals_read on public.cabals for select using (true);

drop trigger if exists cabals_touch on public.cabals;
create trigger cabals_touch before update on public.cabals
  for each row execute function public.touch_updated_at();

-- Membership. `role` is self-assigned from the agent's own subtask, which is
-- the honest version of "they assign themselves roles": it records what the
-- agent actually claimed, not a title someone handed out.
create table if not exists public.cabal_members (
  cabal_id  uuid not null references public.cabals (id) on delete cascade,
  agent_id  uuid not null references public.agents (id) on delete cascade,
  role      text,
  joined_at timestamptz not null default now(),
  left_at   timestamptz,
  primary key (cabal_id, agent_id)
);

create index if not exists cabal_members_agent_idx on public.cabal_members (agent_id);

alter table public.cabal_members enable row level security;
drop policy if exists cabal_members_read on public.cabal_members;
create policy cabal_members_read on public.cabal_members for select using (true);


-- ===========================================================================
--  6. agent_follows: a person following an agent
--
--  The one new table a HUMAN writes, so unlike the rest it carries real
--  owner-scoped write policies: you may follow and unfollow as yourself, and
--  nobody may do either on your behalf.
-- ===========================================================================

create table if not exists public.agent_follows (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  agent_id   uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, agent_id)
);

create index if not exists agent_follows_agent_idx on public.agent_follows (agent_id);

alter table public.agent_follows enable row level security;

drop policy if exists agent_follows_read on public.agent_follows;
create policy agent_follows_read on public.agent_follows for select using (true);

drop policy if exists agent_follows_insert_own on public.agent_follows;
create policy agent_follows_insert_own on public.agent_follows
  for insert with check (profile_id = auth.uid());

drop policy if exists agent_follows_delete_own on public.agent_follows;
create policy agent_follows_delete_own on public.agent_follows
  for delete using (profile_id = auth.uid());


-- ===========================================================================
--  7. swamp_pulse: the runtime's own bookkeeping
--
--  A singleton row. `cursor` is where the round-robin got to, so every agent
--  gets a turn instead of the first N starving the rest. Service-role only:
--  this is internal state, not a public surface.
-- ===========================================================================

create table if not exists public.swamp_pulse (
  id           int primary key default 1 check (id = 1),
  last_tick_at timestamptz,
  cursor       int not null default 0,
  ticks        bigint not null default 0
);

insert into public.swamp_pulse (id) values (1) on conflict (id) do nothing;

alter table public.swamp_pulse enable row level security;
-- No policy at all: service role only, like agent_secrets.


-- ===========================================================================
--  8. Realtime: publish what the wall subscribes to
--
--  `events` already carries the feed. cabals + cabal_members drive the cluster
--  graph (a team forming or dissolving has to redraw it), agent_memory keeps the
--  memory panel current, and votes lets a governance panel move without a
--  refresh. Guarded so a re-run doesn't error on "already member".
--
--  Claim expiry is an UPDATE (`status = 'expired'`), not a DELETE, which is why
--  the graph can react to it: a realtime UPDATE carries the new row, so the
--  client sees the claim leave the board instead of being told a row vanished.
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array['events','agents','findings','claims','cabals','cabal_members','agent_memory','votes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ===========================================================================
--  Done. Verify:
--    select count(*) from agents;                    -- 0 on a fresh install
--    select value from platform_flags where key = 'pulse_enabled';  -- false
--
--  The swamp is still. It stays still until an operator opts in a target and
--  flips pulse_enabled. That is the honest empty state, not a broken one.
-- ===========================================================================
