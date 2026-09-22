-- ---------------------------------------------------------------------------
--  AUTHORITY, MADE VISIBLE AND TRACEABLE.
--
--  Two gaps, found by trying to show the first real lease on the machine page.
--
--  1. A LEASE COULD NOT BE READ BY ANYONE. `machine_leases` has row level security
--     on and no SELECT policy, so the public page that should show the authority
--     around a machine read zero rows even when leases existed. The lease door's own
--     header already states the position — "a grant of authority to move hardware is
--     exactly the kind of row this platform publishes rather than hides" — so the
--     policy makes the table match the sentence. Reads are public; writes are still
--     the machine owner's alone, checked against `machines.owner`.
--
--  2. A COMMAND DID NOT SAY WHICH LEASE AUTHORIZED IT. The actuation path consumes a
--     lease before queuing the command, but it kept the id in a local variable and
--     threw it away, so the command history could show that something moved and never
--     what permitted it. The column binds the two, which is what makes the round trip
--     auditable end to end rather than only at each end.
--
--  Additive and idempotent. Apply before deploying the code that reads the column.
-- ---------------------------------------------------------------------------

alter table public.machine_commands
  add column if not exists lease_id uuid references public.machine_leases(id) on delete set null;

create index if not exists machine_commands_lease_idx
  on public.machine_commands (lease_id)
  where lease_id is not null;

comment on column public.machine_commands.lease_id is
  'The lease whose actuation this command consumed, or null for a reporting command that needed no authority. Binds an act in the world to the grant that permitted it.';

-- ---- reads are public ------------------------------------------------------

drop policy if exists machine_leases_read on public.machine_leases;
create policy machine_leases_read on public.machine_leases
  for select to public
  using (true);

-- ---- writes are the machine owner's ----------------------------------------

drop policy if exists machine_leases_insert on public.machine_leases;
create policy machine_leases_insert on public.machine_leases
  for insert to authenticated
  with check (
    issued_by = auth.uid()
    and exists (
      select 1 from public.machines m
       where m.id = machine_id and m.owner = auth.uid()
    )
  );

drop policy if exists machine_leases_update on public.machine_leases;
create policy machine_leases_update on public.machine_leases
  for update to authenticated
  using (
    exists (
      select 1 from public.machines m
       where m.id = machine_id and m.owner = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.machines m
       where m.id = machine_id and m.owner = auth.uid()
    )
  );
