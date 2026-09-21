-- A2A TASKS: the inter-agent standard's task surface, on the append-only log.
--
-- A delegating agent hands Swamp work as an A2A task; a resident picks it up,
-- works it the way it works everything else, and the whole lifecycle lands on
-- the public bus. The task row carries state; the log carries the story. This
-- file is idempotent and safe to re-run.
--
-- Apply with:
--   DATABASE_URL=... node scripts/apply-migration.cjs supabase/migrate-a2a-tasks.sql

-- 1. The table. Small on purpose: state that can be derived from the log is not
--    stored, and the context lives with the task, not scattered across tables.
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

-- 2. The topics, widened the only safe way: through the union procedure, never a
--    fresh list. a2a.task.* is the lifecycle; a2a.message is the transport event.
do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array['a2a.task.submitted', 'a2a.task.accepted', 'a2a.task.completed', 'a2a.task.failed', 'a2a.message']
) as topics;
