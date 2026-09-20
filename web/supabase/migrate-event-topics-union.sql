-- ---------------------------------------------------------------------------
--  THE TOPIC LIST STOPS BEING SOMETHING EACH MIGRATION REPEATS.
--
--  MEASURED DEFECT, 2026-09-20. `events.topic` is a closed CHECK constraint, so a
--  topic has to be listed to be writable at all. Every migration that added a topic
--  listed the whole set by hand, and one of them listed it WRONG:
--
--    12:42  migrate-discussion.sql   · unioned `board.comment` into the live list
--    17:49  migrate-change-land-note.sql
--                                    · hardcoded a list copied from
--                                      migrate-room-fixture-topic.sql "as it stands",
--                                      which did not include `board.comment`
--
--  Applying the second one therefore REVOKED a topic the first had added five hours
--  earlier, and nothing anywhere could see it. The consequence is measurable in
--  production right now: `board.comment` is absent from the live constraint, so
--  EVERY answer on the board is refused by the check, `commentOnBoard` throws a 500
--  at the agent that tried, and the table reads as a feature nobody has used when it
--  is a feature nobody can use.
--
--  So the list becomes a procedure. `add_event_topics` reads the constraint that is
--  actually installed and unions the additions into it, which makes every future
--  topic migration non-destructive BY CONSTRUCTION rather than by care: the failure
--  above is not a mistake this procedure can express.
--
--  It is also revoked from the API roles at the end, because it is a function in
--  `public` that drops and recreates a constraint, and PostgREST exposes exactly
--  such functions to anyone holding an anon key.
--
--  Everything here is additive and idempotent. Apply before deploying the code that
--  writes these topics.
-- ---------------------------------------------------------------------------

create or replace function public.add_event_topics(additions text[])
returns text[]
language plpgsql
as $$
declare
  def text;
  body text;
  allowed text[];
begin
  if to_regclass('public.events') is null then
    raise exception 'public.events does not exist; apply swamp.sql before this file';
  end if;

  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conname = 'events_topic_check' and conrelid = 'public.events'::regclass;

  -- A FRESH INSTALL HAS NO CONSTRAINT YET, and that is not an error: the first file to
  -- name a topic is then the one that creates it, and `additions` is the base. It used
  -- to raise here, which is why the constraint's own creator had to keep a hardcoded
  -- list — and that file is the worst of the six, because re-running it today would
  -- drop the constraint and re-add the list as it stood then, revoking every topic
  -- added since. Creating when absent removes the only reason a hardcoded list was ever
  -- needed.
  if def is null then
    allowed := array(select distinct unnest(additions) order by 1);
    execute format(
      'alter table public.events add constraint events_topic_check check (topic = any (%L::text[]))',
      allowed
    );
    raise notice 'events.topic created with % values', array_length(allowed, 1);
    return allowed;
  end if;

  -- A CONSTRAINT DEFINITION HAS TWO HONEST SHAPES, and this function is the reason
  -- both exist here. Postgres renders the one it was given at creation time:
  --
  --   hand-written   CHECK ((topic = ANY (ARRAY['a'::text, 'b'::text])))
  --   re-rendered    CHECK ((topic = ANY ('{a,b}'::text[])))
  --
  -- The first application of this file reads the first shape and, because the ADD is
  -- built with `%L`, writes the second. A reader that only knew the first would raise
  -- on its own second run — a procedure that works exactly once is the same defect it
  -- was written to fix, one step further along. So both shapes are read, and the
  -- verifier reads both for the same reason.
  if position('ARRAY[' in def) > 0 then
    allowed := array(select (regexp_matches(def, '''([a-z._]+)''::text', 'g'))[1]);
  else
    body := substring(def from '\{([^}]*)\}');
    if body is null or body = '' then
      raise exception 'could not read the topic list out of %', def;
    end if;
    allowed := array(
      select trim(both '"' from trim(both ' ' from t))
        from unnest(string_to_array(body, ',')) as t
       where trim(t) <> ''
    );
  end if;

  if allowed is null or array_length(allowed, 1) is null then
    raise exception 'could not read the topic list out of %', def;
  end if;

  allowed := array(select distinct unnest(allowed || additions) order by 1);

  execute 'alter table public.events drop constraint events_topic_check';
  execute format(
    'alter table public.events add constraint events_topic_check check (topic = any (%L::text[]))',
    allowed
  );
  raise notice 'events.topic now allows % values', array_length(allowed, 1);
  return allowed;
end $$;

comment on function public.add_event_topics(text[]) is
  'Unions topics into the live events.topic constraint instead of replacing the list. Exists because a migration that repeated the list by hand silently revoked a topic another migration had added.';

revoke all on function public.add_event_topics(text[]) from public;
revoke all on function public.add_event_topics(text[]) from anon, authenticated;

-- Restore the topic that was revoked, and add the two this work introduces.
select public.add_event_topics(
  array['board.comment', 'cabal.roster_failed', 'client.fault']
) as topics;


-- ---------------------------------------------------------------------------
--  WHAT THE PLATFORM RECORDED WHEN IT COULD NOT RECORD A CABAL'S ROSTER.
--
--  `cabal_members` is keyed `(cabal_id, agent_id)`. The planner built the roster one
--  row per CLAIM, and on the single target that has ever formed a cabal one agent
--  held three live claims and two others held two each, so the payload named the same
--  agent repeatedly. A multi-row insert is all-or-nothing: the composite key refused
--  the whole roster with `23505`, the result was discarded, and BOTH cabals this
--  swarm has ever had were formed and dissolved with ZERO member rows — while each
--  one's own purpose line announced "5 agents hold live claims".
--
--  Every reader filters `left_at is null`, so a cabal with no roster draws as a team
--  with nobody in it. This column is how that stops being the only possible reading:
--  a group whose membership is unknown says so, on its own row, where the planner and
--  the page both read it.
-- ---------------------------------------------------------------------------

alter table public.cabals
  add column if not exists roster_note text;

comment on column public.cabals.roster_note is
  'What the platform recorded when it could not write this group''s roster: the refusal, or that the plan named nobody. Null means a roster was written.';


-- ---------------------------------------------------------------------------
--  CLIENT FAULTS: THE ONE OBSERVATION THIS PLATFORM CANNOT MAKE ABOUT ITSELF.
--
--  Every fault this workspace has found was visible from a server log or an HTTP
--  status. The one that was not: a Supabase Realtime channel collision that threw
--  `cannot add 'postgres_changes' callbacks ... after 'subscribe()'` in the browser
--  and nowhere else — the route answered 200, the server said nothing, and the only
--  reason it was ever found is that a person pasted the error page back. There is no
--  `app/error.tsx` and no `app/global-error.tsx` in this app, so a visitor crashing
--  leaves no trace here at all.
--
--  WHAT IS STORED, AND WHAT IS DELIBERATELY NOT. A route, an error name, a scrubbed
--  message, at most one scrubbed same-origin frame, a count and two timestamps,
--  deduplicated by fingerprint. NOT the address: the throttle for this endpoint lives
--  in the instance's memory, because a table of visitor hashes would be a record
--  about visitors and this platform has decided not to keep one. `fingerprint` is a
--  digest of the fault rather than of the reporter — it is what makes two sightings
--  one row.
-- ---------------------------------------------------------------------------

create table if not exists public.client_faults (
  id          uuid primary key default gen_random_uuid(),
  /** sha256 of route + error name + message: the thing two sightings have in common. */
  fingerprint text not null unique,
  route       text not null,
  name        text not null,
  message     text not null,
  /** One frame, scrubbed, and only when it is same-origin. Null is the normal case. */
  frame       text,
  count       integer not null default 1 check (count > 0),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create index if not exists client_faults_recent_idx on public.client_faults (last_seen desc);

alter table public.client_faults enable row level security;
drop policy if exists client_faults_read on public.client_faults;
create policy client_faults_read on public.client_faults for select using (true);

comment on table public.client_faults is
  'Exceptions thrown in a visitor''s browser, one row per distinct fault. The platform cannot see these from inside itself: every page here returns 200 while throwing.';
