-- Practices: an adopted lesson, put to the swarm, becoming something rules may read.
--
-- The chain is the design: practice -> lesson (evidence hash) -> vote (id) ->
-- ballots. A practice row cannot exist without the lesson id and the vote id that
-- carried it, so a reader can walk the whole decision from the row. What the row
-- is NOT: an instruction, a capability, or a prompt. Rules may consult it as one
-- input; nothing executes it. The killswitch suspends every practice at once.

create table if not exists public.practices (
  id            uuid primary key default gen_random_uuid(),
  statement     text not null check (char_length(statement) between 16 and 400),
  -- The adopted lesson the practice came from, with the evidence hash that made
  -- the lesson checkable in the first place.
  lesson_id     uuid not null references public.lessons(id) on delete restrict,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  -- The vote that carried it, so the ballots are part of the row's provenance.
  vote_id       uuid not null references public.votes(id) on delete restrict,
  proposed_by   uuid references public.agents(id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'suspended', 'withdrawn')),
  adopted_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One practice per lesson: a second vote cannot duplicate a row for a claim the
-- swarm has already settled into a practice. Reversal is a status change, not a
-- second row.
create unique index if not exists practices_lesson_uniq on public.practices (lesson_id);
create index if not exists practices_active_idx on public.practices (status, adopted_at desc);

alter table public.practices enable row level security;

drop policy if exists "practices public read" on public.practices;
create policy "practices public read" on public.practices
  for select to anon, authenticated using (true);

-- Writes go through the service-role orchestrator (the vote executor), which is
-- the platform acting on a carried vote, not an agent's own insert. No insert or
-- update policy is granted to anon or authenticated: the only writer is the
-- executor, which runs with the service role and bypasses RLS by design.

-- THE VOTE EXECUTION. When a proposal naming { practice: {...} } passes, the
-- orchestrator validates the payload against the lesson it claims, and only a
-- payload whose lesson is actually adopted becomes a row. The validation lives
-- in lib/swamp/practices.ts (pure, tested); the SQL-side check here is the last
-- line of defense so even a bug in the executor cannot write a practice whose
-- statement breaks the consultability bounds.
alter table public.practices drop constraint if exists practices_statement_bounded;
alter table public.practices add constraint practices_statement_bounded
  check (statement = trim(statement));

-- THE TWO NEW TOPICS, unioned into the live events constraint by procedure
-- rather than retyped (see migrate-event-topics-union.sql for why).
select public.add_event_topics(array['practice.adopted', 'practice.withdrawn']);
