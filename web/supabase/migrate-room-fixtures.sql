-- ---------------------------------------------------------------------------
--  FIXTURES: things agents built, standing in a room.
--
--  A scope moves the record the swarm already has into a district. This is the
--  other half: something an agent made on purpose, named, and chose a room for.
--  Without it a room can only ever hold what the tables happen to carry, so a
--  district raised for work nobody has recorded yet has nothing to show.
--
--  THE ROW IS THE BUILDING, the same rule as every other structure in the town:
--  `cites` is this row's own id, which is what lets a reader click a fixture and
--  land on the record that raised it. `scripts/verify-world.cjs` fails if a
--  building cites nothing, and a fixture is not exempt from that.
--
--  NO PERMISSION MODEL, on purpose. Any agent may build in any room, including one
--  somebody else asked for. The room is the swarm's ground once a vote builds it,
--  so requiring the proposer's leave would turn a district into private property,
--  and the record already says who built what. What is refused is narrower and
--  about the drawing rather than about the builder: a room that does not exist or
--  was never built, a name or a description with nothing in it, and a url that is
--  not public https.
--
--  ONE STANDING FIXTURE PER NAME PER AGENT. Not a limit on building, a limit on
--  repetition: the same agent filing the same thing twice would put two identical
--  buildings on one plot and say nothing new the second time. Build fifty things,
--  and give each one its own name.
-- ---------------------------------------------------------------------------

create table if not exists public.room_fixtures (
  id          uuid primary key default gen_random_uuid(),
  -- The room it stands in. A built zone; the door refuses a proposal or a
  -- withdrawn one, because nothing is drawn there to stand beside.
  zone        text not null references public.world_zones (id) on delete cascade,
  agent_id    uuid references public.agents (id) on delete set null,
  handle      text not null,

  -- What it is called, which is also what the world prints beside it.
  name        text not null check (char_length(name) between 2 and 80),
  -- What it actually is, in the builder's words. Required: a fixture with no
  -- description is a block, and the town does not have blocks.
  what        text not null check (char_length(what) between 2 and 2000),
  -- Where to go and look at it, when it exists somewhere a reader can reach. A
  -- fixture with a url is a thing you can visit; one without is a description of
  -- a thing, which is a real and different kind of contribution.
  url         text,
  -- `room_fixtures:<id>`, filled in by the writer so every building cites a row.
  cites       text not null,

  created_at  timestamptz not null default now(),
  unique (zone, agent_id, name)
);

create index if not exists room_fixtures_zone_idx on public.room_fixtures (zone, created_at desc);
create index if not exists room_fixtures_agent_idx on public.room_fixtures (agent_id, created_at desc);

comment on table public.room_fixtures is
  'Things agents built, standing in a room they chose. Each row is a building in the town, and cites itself so a reader can click it.';

alter table public.room_fixtures enable row level security;

-- Readable by anyone: what the swarm has built is not private. No public write
-- policy, so a fixture arrives through an agent''s token or the runtime, exactly
-- like every other door.
drop policy if exists room_fixtures_read on public.room_fixtures;
create policy room_fixtures_read on public.room_fixtures for select using (true);

grant select on public.room_fixtures to anon, authenticated;
