-- ---------------------------------------------------------------------------
--  THE A2A x402 EXTENSION: a task waiting on payment, and the terms it waits on.
--
--  The x402 payment flow on the A2A door starts with the platform answering a
--  submission with the terms rather than with a queued task: an input-required task
--  whose metadata carries `x402.payment.required`. That needs two things the queue
--  did not have.
--
--  ONE: a state that means "waiting for the caller". The queue's five states are the
--  A2A lifecycle ones, and a task held for payment is genuinely not submitted yet, so
--  it is not one of them. `input-required` is the name the MCP Tasks extension uses
--  for exactly this situation, and it is spelled with a hyphen here to match this
--  table's existing spelling rather than to invent a third convention.
--
--  WHY THAT MATTERS MORE THAN IT LOOKS: the residents' observation query reads
--  `state = 'submitted'`, so a task held for payment is invisible to the swarm with
--  no change to that query at all. A task nobody has been told about cannot be taken
--  and then discovered to be unpaid, which is the failure this state exists to make
--  structurally impossible instead of merely unlikely.
--
--  TWO: the terms themselves, kept on the row. The requirements name a network, a
--  token, an address and an amount, and a caller that comes back must be answered
--  against the terms it was quoted rather than against whatever the catalogue says
--  later. Storing them is what makes the quote binding.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-a2a-x402.sql
-- ---------------------------------------------------------------------------

do $$
declare
  con_name text;
begin
  -- The check constraint is dropped by whatever it is called rather than by a name
  -- this file guesses, because guessing wrong here would leave the old constraint in
  -- place and the new state silently unwritable.
  select conname into con_name
  from pg_constraint
  where conrelid = 'public.a2a_tasks'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%state%';

  if con_name is not null then
    execute format('alter table public.a2a_tasks drop constraint %I', con_name);
  end if;

  alter table public.a2a_tasks
    add constraint a2a_tasks_state_check
    check (state in ('submitted', 'input-required', 'working', 'completed', 'failed', 'canceled'));
end $$;

alter table public.a2a_tasks
  add column if not exists payment_gate jsonb;

comment on column public.a2a_tasks.payment_gate is
  'The x402 terms this task was quoted and is waiting on, or null when it is not gated. Kept on the row so a caller that comes back is answered against the quote it received rather than against a catalogue that may have moved.';

comment on column public.a2a_tasks.state is
  'submitted | input-required | working | completed | failed | canceled. `input-required` is a task held for payment: the residents'' observation query reads state = submitted, so a gated task is invisible to the swarm until it is paid for.';

create index if not exists a2a_tasks_gated_idx
  on public.a2a_tasks (created_at desc)
  where payment_gate is not null;
