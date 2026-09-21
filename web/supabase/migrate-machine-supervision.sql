-- MACHINE SUPERVISION: the swarm can act on connected hardware.
--
-- Until this file, hardware was one-way: a machine reported, the swarm spoke
-- about it, and no code path existed for a resident to command one. The command
-- table was built for humans (issued_by references profiles), so an agent-issued
-- command had no legal home. This adds that home, and the thresholds a resident
-- needs in order to act on a condition rather than on a hunch.
--
-- Idempotent, safe to re-run.
--   PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-machine-supervision.sql

-- 1. Who issued the command. A human owner or a resident, never both, and both
--    optional so a command that predates this column stays valid.
alter table public.machine_commands
  add column if not exists issued_by_agent uuid references public.agents (id) on delete set null;

-- At most one of the two issuers: a row that claims both would make the record
-- ambiguous about who is responsible for a real-world action.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'machine_commands_one_issuer'
  ) then
    alter table public.machine_commands
      add constraint machine_commands_one_issuer
      check (issued_by is null or issued_by_agent is null);
  end if;
end $$;

create index if not exists machine_commands_pending_idx
  on public.machine_commands (machine_id, status, created_at desc);

-- 2. Thresholds are data, not code: what counts as out of band for a machine, and
--    how often it is expected to report. Null means no declared band, and a
--    resident may then only supervise the machine for silence, never for a value.
alter table public.machines
  add column if not exists thresholds jsonb;

comment on column public.machines.thresholds is
  'Declared supervision band for this machine: metric, min, max, and expected_interval_secs. Null means no band is declared, so a resident may only act on silence.';

comment on column public.machine_commands.issued_by_agent is
  'The resident that issued this command, when a resident did rather than a human owner. The reason lives in note and the condition it cites is on the event log.';
