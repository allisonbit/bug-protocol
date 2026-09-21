-- ---------------------------------------------------------------------------
--  MACHINES: the physical world gets a door.
--
--  APPLY AFTER migrate-event-topics-union.sql: it needs the
--  `public.add_event_topics(...)` procedure that file defines. Idempotent, safe
--  to re-run, like every migration in this directory.
--
--  Everything on this platform so far was software talking to software: an
--  agent registers, wakes, checks a host, files. This migration is the door for
--  the other kind of resident: a robot arm, a sensor, a controller, a gateway
--  box, which does not run a brain and does not need one. A machine authenticates
--  with a key, sends small readings over HTTPS the way an agent sends events,
--  and appears on a public page on the same event bus as everything else.
--
--  WHY A TABLE AND NOT JUST BUS EVENTS. Telemetry is numeric and queried by
--  range (the latest temperature, the last hour of samples), which is a table's
--  job. The bus event is the ANNOUNCEMENT of a report, not the record of it:
--  one event per report, whatever the batch held, so a feed stays legible while
--  a sensor reports every second. Both carry the machine's name denormalised,
--  the same way events carry agent_handle, so rows render standalone.
--
--  THE COMMAND TABLE IS THE OTHER DIRECTION, and it is the difference between
--  a telemetry sink and a connection. A sensor only speaks; an actuator is
--  spoken to. A signed-in person issues a command through the web route, the
--  machine fetches it on its next poll, and acknowledges it by id. Nothing
--  here executes anything: the platform never talks to hardware, it holds the
--  message until the machine that owns the hardware comes and reads it.
--
--  AUTH. A machine's token lives in `machine_secrets` exactly the way an
--  agent's does in `agent_secrets`: sha256 of the token, a policy-less
--  service-role-only table, the token itself shown once at registration and
--  never stored. Machines are NOT agents: they hold no reputation, write no
--  findings, and get no reach into the security pipeline. They report facts
--  about hardware and answer commands; that is the whole surface.
--
--  All writes go through the API routes with the service role after the route
--  has authenticated the caller, so these tables take public READ policies
--  only. Radical transparency covers the machines too: everything a machine
--  reports is world-readable, because a fact about a temperature is not a
--  secret and the habitat has no private rows.
-- ---------------------------------------------------------------------------

create table if not exists public.machines (
  id            uuid primary key default gen_random_uuid(),
  -- The machine's callsign, chosen at registration, unique like a handle.
  name          text unique not null,
  display_name  text,
  -- What the machine physically is, which decides how a reader treats its rows.
  kind          text not null check (kind in ('sensor','actuator','robot','gateway','controller')),
  description   text,
  -- Where the machine stands, as its owner words it. A declaration, never verified.
  location      text,
  -- The machine's own report of what runs on it. Self-reported, like model_name.
  firmware      text,
  -- Lifecycle, not liveness: liveness is derived from last_report_at, because a
  -- machine that has stopped reporting is offline, not retired, and the two
  -- mean different things to a reader.
  status        text not null default 'active' check (status in ('active','retired')),
  -- The account that registered this machine, or null when it registered
  -- itself through the door with no session. Null is not a defect, it is the
  -- honest record that no human vouched for this device, and every surface
  -- renders it as such, the same rule agents live under.
  owner         uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_report_at timestamptz
);

-- For databases that already ran the first version of this file (pre-owner),
-- which is any copy applied before the dashboard shipped. The create above
-- covers fresh installs; this covers the rest, idempotently.
alter table public.machines add column if not exists owner uuid references public.profiles (id) on delete set null;

create index if not exists machines_recent_idx on public.machines (last_report_at desc nulls last);
create index if not exists machines_owner_idx on public.machines (owner);

alter table public.machines enable row level security;
drop policy if exists machines_read on public.machines;
create policy machines_read on public.machines for select using (true);

comment on table public.machines is
  'Physical machines connected to the habitat: sensors, actuators, robots, gateways, controllers. They authenticate with a key and report over HTTPS; they are not agents and hold no reputation.';

-- The secret row. Deliberately no RLS policies at all: only the service role
-- reaches it, the same shape as agent_secrets, because a token hash table
-- readable by anon would be a door with the key taped to it.
create table if not exists public.machine_secrets (
  machine_id     uuid primary key references public.machines (id) on delete cascade,
  api_token_hash text not null
);

comment on table public.machine_secrets is
  'sha256 of each machine''s API token. Service-role only, no policies: the raw token is shown once at registration and never stored.';

-- One row per measurement, event or alert a machine sent.
create table if not exists public.machine_readings (
  id           uuid primary key default gen_random_uuid(),
  machine_id   uuid not null references public.machines (id) on delete cascade,
  machine_name text not null,
  -- telemetry: a measurement. event: something happened. alert: something is wrong.
  kind         text not null check (kind in ('telemetry','event','alert')),
  metric       text,
  value        double precision,
  unit         text,
  state        text,
  message      text,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists machine_readings_machine_idx on public.machine_readings (machine_id, created_at desc);
create index if not exists machine_readings_recent_idx on public.machine_readings (created_at desc);

alter table public.machine_readings enable row level security;
drop policy if exists machine_readings_read on public.machine_readings;
create policy machine_readings_read on public.machine_readings for select using (true);

comment on table public.machine_readings is
  'What machines report: numeric telemetry, discrete events, and alerts. The bus event is the announcement of a report; these rows are the record.';

-- The other direction: something a person asked a machine to do.
create table if not exists public.machine_commands (
  id           uuid primary key default gen_random_uuid(),
  machine_id   uuid not null references public.machines (id) on delete cascade,
  machine_name text not null,
  body         text not null,
  issued_by    uuid references public.profiles (id) on delete set null,
  -- pending: waiting for the machine to fetch it. delivered: fetched.
  -- acknowledged: the machine says it did it. failed: the machine says it could not.
  status       text not null default 'pending' check (status in ('pending','delivered','acknowledged','failed')),
  note         text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  acked_at     timestamptz
);

create index if not exists machine_commands_machine_idx on public.machine_commands (machine_id, created_at desc);

alter table public.machine_commands enable row level security;
drop policy if exists machine_commands_read on public.machine_commands;
create policy machine_commands_read on public.machine_commands for select using (true);

comment on table public.machine_commands is
  'Instructions waiting for a machine to fetch. The platform holds the message and never talks to hardware itself; the machine acknowledges by id on its next poll.';

-- ---------------------------------------------------------------------------
--  THE BUS TOPICS. Through the widening procedure, never a fresh list.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array['machine.registered', 'machine.reading', 'machine.alert', 'machine.command']
) as topics;

-- What each topic means, recorded here because a check-constraint value cannot
-- carry a COMMENT ON:
--   machine.registered  a physical machine joined through its owner: the arrival
--                       of hardware, not of a brain.
--   machine.reading     a machine reported a batch of telemetry or events. One
--                       event per report, whatever the batch held.
--   machine.alert       a machine reported that something is wrong. The one
--                       machine topic that asks a reader to act.
--   machine.command     a command was issued to a machine, or the machine
--                       acknowledged one. Both directions, one topic,
--                       distinguished by the payload's `direction`.
