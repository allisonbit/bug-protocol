-- A2A mandates: the AP2 pattern applied to delegated work.
--
-- A caller that hands in a task can attach a mandate: a statement of intent
-- and, when it has one, a budget, signed with the key that will be checking
-- the task's outcome. The mandate is held on the public log beside the task,
-- so a delegator can state what it asked for and the record proves what
-- happened -- the accountability shape the Agent Payments Protocol (AP2)
-- calls a signed mandate, adapted to tasks rather than payments. Nothing here
-- moves money: the budget is declarative, and the record is the point.

create table if not exists public.a2a_mandates (
  id          uuid primary key default gen_random_uuid(),
  -- The task this mandate authorizes. One active mandate per task; deleting
  -- the task takes its mandate with it.
  task_id     uuid not null references public.a2a_tasks (id) on delete cascade,
  -- Who signed. The same caller string the task carries.
  caller      text not null,
  -- What the caller says this work is for, in the caller's own words.
  intent      text not null check (char_length(intent) between 1 and 1000),
  -- Declared budget, if any. JSON, shape agreed between caller and checker;
  -- the platform does not interpret it, it holds it.
  budget      jsonb,
  -- The detached signature over the mandate bytes, and which key made it.
  -- The platform records both; verifying the signature against a caller key
  -- is the checker's job, and the record exists so that check is possible.
  signature   text not null,
  key_id      text not null,
  -- active | consumed | expired. Consumed when the task reaches a terminal
  -- state; the transition is written by the resident that finished the work.
  state       text not null default 'active' check (state in ('active','consumed','expired')),
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists a2a_mandates_task_idx on public.a2a_mandates (task_id);
create index if not exists a2a_mandates_state_idx on public.a2a_mandates (state, created_at desc);

alter table public.a2a_mandates enable row level security;
drop policy if exists "mandates are public" on public.a2a_mandates;
create policy "mandates are public" on public.a2a_mandates for select using (true);

comment on table public.a2a_mandates is
  'AP2-style signed mandates on A2A tasks: intent, optional budget, signature and key id, held on the public record so delegation is provable. swamp.ap2/0.1';

-- 2. The two new topics, widened the only safe way: through the union
--    procedure, never a fresh list. a2a.mandate.signed is the authorization
--    event; pulse.span is the runtime's beat record, which the code has been
--    writing since the GenAI spans landed.
do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array['a2a.mandate.signed', 'pulse.span']
) as topics;
