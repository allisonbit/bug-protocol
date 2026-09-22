-- ---------------------------------------------------------------------------
--  EVAL RUNS: the scoreboard, kept, so a trend exists rather than a snapshot.
--
--  A page that recomputes a number on every visit can only ever show the number
--  now. The interesting question is whether the deployment is getting better or
--  worse, and that needs the previous answer stored. One row per scored window,
--  each row carrying every metric the composite was built from, so a reader can
--  recompute the score rather than trust it.
--
--  WHY NOT A VIEW OVER events. The spans are the source, and they stay the source;
--  this table is a reading of them at a moment, and it says so. When the action
--  semantics change, old rows keep the arithmetic they were computed with, which is
--  exactly what a comparison needs: a metric whose definition moved under it is not
--  a trend, it is two measurements wearing one name.
-- ---------------------------------------------------------------------------

create table if not exists public.eval_runs (
  id               uuid primary key default gen_random_uuid(),
  -- The half-open window [window_from, window_to) the spans were read from.
  window_from      timestamptz not null,
  window_to        timestamptz not null,
  beats            integer not null default 0,
  agents           integer not null default 0,
  planned          integer not null default 0,
  ran              integer not null default 0,
  failed           integer not null default 0,
  landed           integer not null default 0,
  dropped          integer not null default 0,
  landed_rate      integer,
  degraded_beats   integer not null default 0,
  degradation_rate integer,
  acted_beats      integer not null default 0,
  model_calls      integer not null default 0,
  tokens_in        bigint not null default 0,
  tokens_out       bigint not null default 0,
  avg_latency_ms   integer,
  score            integer not null default 0,
  -- Which metrics moved the wrong way against the previous run, and by how much,
  -- in the words the comparison used. A run with no regressions stores an empty
  -- array, which is a different fact from a run that was never compared.
  regressions      jsonb not null default '[]'::jsonb,
  per_agent        jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

-- The trend is read newest first.
create index if not exists eval_runs_created_idx on public.eval_runs (created_at desc);

comment on table public.eval_runs is
  'One scored window of the swarm''s own beats, read from the pulse spans and kept so a comparison exists. Derived, and safe to truncate: the spans remain the source of truth.';

alter table public.eval_runs enable row level security;
drop policy if exists eval_runs_read on public.eval_runs;
create policy eval_runs_read on public.eval_runs for select using (true);

-- The two topics for the bus, widened through the helper rather than re-listed.
do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(array['eval.scored', 'eval.regressed']);
