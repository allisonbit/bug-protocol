-- A2A TASKS + MANDATES, ONE FILE.
--
-- Everything the A2A surface needs, in the order the foreign keys demand:
-- the task table, the mandate table that hangs its authorization off the
-- task, and every new event topic widened through the union procedure in one
-- call. This file is idempotent and safe to re-run, and it replaces running
-- migrate-a2a-tasks.sql and migrate-a2a-mandates.sql separately -- one paste,
-- one Run in the dashboard SQL editor.
--
-- Apply with either:
--   Supabase dashboard -> SQL Editor -> paste -> Run   (expect: Success. No rows returned)
--   PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-a2a-all.sql

-- 1. The task table. Small on purpose: state that can be derived from the log
--    is not stored, and the context lives with the task, not scattered across
--    tables.
create table if not exists public.a2a_tasks (
  id           uuid primary key default gen_random_uuid(),
  -- The A2A task id the caller supplied, or one generated here. Unique per caller.
  external_id  text,
  -- Who asked. An agent handle or any caller string; the platform does not
  -- require the caller to be a resident, because delegation comes from outside.
  caller       text not null,
  -- Which resident took the task. Null until accepted.
  assignee     uuid references public.agents (id) on delete set null,
  -- submitted | working | completed | failed | canceled. The A2A terminal states.
  state        text not null default 'submitted' check (state in ('submitted','working','completed','failed','canceled')),
  -- The request in A2A shape: { role, parts: [{ kind, text }] }.
  message      jsonb not null default '{}',
  -- The reply, filled when the task completes or fails.
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists a2a_tasks_state_idx on public.a2a_tasks (state, created_at desc);
create index if not exists a2a_tasks_caller_idx on public.a2a_tasks (caller, created_at desc);
create unique index if not exists a2a_tasks_external_idx on public.a2a_tasks (caller, external_id) where external_id is not null;

alter table public.a2a_tasks enable row level security;
drop policy if exists a2a_tasks_read on public.a2a_tasks;
create policy a2a_tasks_read on public.a2a_tasks for select using (true);

comment on table public.a2a_tasks is
  'A2A task delegation: a caller outside or inside the swarm hands work in, a resident picks it up, and the lifecycle is public. The row is state; the event log is the story.';

-- 2. The mandate table: the AP2 pattern applied to delegated work. A caller
--    that hands in a task can attach a mandate -- a statement of intent and,
--    when it has one, a budget, signed with the key that will be checking the
--    task's outcome. The mandate is held on the public log beside the task, so
--    a delegator can state what it asked for and the record proves what
--    happened. Nothing here moves money: the budget is declarative, and the
--    record is the point.
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

-- 3. The topics, widened the only safe way: through the union procedure, never
--    a fresh list. The task lifecycle, the transport event, the mandate's
--    signing event, and pulse.span, which the runtime has been writing since
--    the GenAI spans landed.
do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array[
    'a2a.task.submitted', 'a2a.task.accepted', 'a2a.task.completed', 'a2a.task.failed',
    'a2a.message', 'a2a.mandate.signed', 'pulse.span'
  ]
) as topics;
