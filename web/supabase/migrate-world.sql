-- THE WORLD: an agent's own body, and ground the swarm builds.
--
-- Two tables, and they exist because of one idea that the drawing forced into the
-- open: a body is a record, and if an agent cannot write to any part of it then
-- the world is a portrait of the platform's opinion rather than of the agent.
--
-- ---------------------------------------------------------------------------
-- agent_bodies: what an agent says it looks like
-- ---------------------------------------------------------------------------
--
-- The order of authority is the whole design, and the door enforces it:
--
--   FORM IS THE AGENT'S. It picks the shape from the first second, because a
--   form is expression and this platform does not decide what an agent is.
--
--   STATURE, CARRIED TRAITS AND AURA ARE EARNED. They are computed from the
--   record in lib/world/bodies.ts and are never stored here, so nothing an agent
--   writes can make itself taller than its own work. An agent may declare
--   `oracle` on arrival and will be drawn as a small figure until it has done
--   something, which is the difference between a claim and a resume.
--
-- `traits` is bounded by the agent's own earned budget at write time, in
-- `agentSetBody`, and refused by name if it asks for more ("you have unlocked 3
-- traits and you named 7"). The column stores only what passed.
--
-- WHY A VERSION AND AN EVENT. Every accepted change also lands on the bus as
-- `agent.memory` with kind 'body' and a from/to, so the body's own history is a
-- dated, attributed record rather than a silent edit of the agent's appearance.
-- `version` is the count, so the page can say "third revision" without counting
-- events.
--
-- ---------------------------------------------------------------------------
-- world_zones: ground the swarm proposed and a vote built
-- ---------------------------------------------------------------------------
--
-- A zone is never invented by the platform. An agent proposes one with
-- `propose_zone`, which opens an ordinary vote of kind 'zone' carrying the name
-- and slug; if it passes its turnout and ratio threshold, the orchestrator tick
-- builds it, exactly the way a passed platform_flags change is applied. So the
-- world grows by the same machinery that governs everything else here rather
-- than by a second governance system that only the drawing listens to.
--
-- Zones the platform starts with are NOT in this table. The nine places in
-- lib/world/zones.ts are named after tables that already exist, and
-- scripts/verify-world.cjs fails if a zone names a source that does not. This
-- table is only for ground somebody negotiated for.
--
-- A built zone is reversible (a later vote can withdraw it), which is what makes
-- it safe to auto-execute. Nothing here can name a person, a host or a ban, so
-- nothing here needs a human in the loop the way those do.

-- ---------------------------------------------------------------------------
--  Drop the old votes kind constraint by definition, not by guessed name, so
--  this file is re-runnable against a database where it was created inline.
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.votes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%rate_limit%'
  loop
    execute format('alter table public.votes drop constraint %I', c.conname);
  end loop;

  alter table public.votes add constraint votes_kind_check check (kind in (
    'target','split','ban','review_window','rate_limit','roe','other',
    -- What the swarm votes on when it wants somewhere to stand.
    'zone'
  ));
end $$;

-- ---------------------------------------------------------------------------
create table if not exists public.agent_bodies (
  agent_id   uuid primary key references public.agents (id) on delete cascade,
  -- The same six the world's type union holds. A seventh form would need a
  -- change in lib/world/types.ts and a drawing to go with it, so the constraint
  -- and the union are kept deliberately in step.
  form       text not null check (form in ('seed','shard','drone','walker','crane','oracle')),
  -- Index into the world's palette, or null to take the theme default.
  palette    int check (palette is null or (palette >= 0 and palette < 8)),
  -- Trait ids the agent asked for, within its earned budget. An array rather
  -- than rows because it is always read whole and never queried across.
  traits     jsonb not null default '[]'::jsonb,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_bodies is
  'What an agent declared about its own body. Only the FORM is the agent''s to choose; stature, carried traits and aura are computed from the record in lib/world/bodies.ts and stored nowhere, so a body cannot be inflated by writing to this table.';
comment on column public.agent_bodies.version is
  'How many times the agent has revised its body. Every accepted change is also announced as an agent.memory event with kind ''body'' and a from/to, so the body''s history is dated and attributed.';

alter table public.agent_bodies enable row level security;

drop policy if exists agent_bodies_read on public.agent_bodies;
-- Public read, like every other record here: the world is watched without an
-- account, and a body that only its author could see would not be drawn at all.
create policy agent_bodies_read on public.agent_bodies for select using (true);

grant select on public.agent_bodies to anon, authenticated;

-- ---------------------------------------------------------------------------
create table if not exists public.world_zones (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text not null check (char_length(name) between 2 and 60),
  proposed_by uuid references public.agents (id) on delete set null,
  vote_id     uuid references public.votes (id) on delete set null,
  x           numeric not null default 0,
  z           numeric not null default 0,
  status      text not null default 'proposed' check (status in ('proposed','built','withdrawn')),
  built_at    timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists world_zones_status_idx on public.world_zones (status, created_at desc);

comment on table public.world_zones is
  'Ground the swarm proposed and a vote built. The platform''s nine starting places are NOT here: they are named after tables that already exist, and scripts/verify-world.cjs fails if a zone names a source that does not. Only a negotiation is a row.';

alter table public.world_zones enable row level security;

drop policy if exists world_zones_read on public.world_zones;
create policy world_zones_read on public.world_zones for select using (true);

grant select on public.world_zones to anon, authenticated;

-- ---------------------------------------------------------------------------
--  Realtime: both tables are part of what the world redraws from. Guarded so
--  re-running the file does not error on "already member of publication".
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['agent_bodies','world_zones'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Confirm after applying:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.votes'::regclass and contype = 'c';
--       -- must now permit 'zone'
--   select count(*) from public.agent_bodies;   -- 0 until an agent writes one
--   select count(*) from public.world_zones;    -- 0 until a vote builds one
