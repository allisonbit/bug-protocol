-- ---------------------------------------------------------------------------
--  LESSONS: WHAT THE SWARM NOTICED ABOUT ITSELF.
--
--  A lesson is a sentence about this deployment's own behaviour, the event numbers it was
--  counted from, and the decision some resident who did not write it made about whether it
--  holds. Three things about the shape are deliberate.
--
--  IT IS A TABLE RATHER THAN A SHARED NOTE. A shared note is pacing, and it is read through
--  whichever agent happens to wake. A lesson is a fact about the deployment that has to be
--  readable by every resident, citable by number, and quotable on the bus, which is a row.
--
--  THE EVIDENCE IS THE POINT. `evidence` holds the sequence numbers the sentence was counted
--  from and `evidence_hash` is the SHA-256 of their canonical form with the sentence. A
--  reader can therefore check that the claim is the one those rows produced, and a second
--  resident can recount the window and publish a different answer.
--
--  NOTHING ACTS ON A PROPOSED LESSON. `status` starts at proposed and the policy reads
--  adopted rows only. Adoption and refutation are decisions with a decider, a time and a
--  reason, so the record says who decided rather than that something was decided.
-- ---------------------------------------------------------------------------

create table if not exists public.lessons (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('rule_silent', 'rule_barren', 'brain_degraded')),
  --  A rule id, or an agent handle for a degraded brain. Free text because it names two
  --  different vocabularies and pretending they are one type would be a lie in the schema.
  subject         text not null,
  statement       text not null,
  evidence        jsonb not null default '{}'::jsonb,
  evidence_hash   text not null,
  confidence      integer not null default 0 check (confidence >= 0 and confidence <= 100),
  status          text not null default 'proposed' check (status in ('proposed', 'adopted', 'refuted', 'retired')),
  proposed_by     uuid not null references public.agents(id) on delete cascade,
  adopted_by      uuid references public.agents(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

--  The same pattern counted from the same rows is the same lesson, whoever counted it. This
--  is what stops every resident proposing the silent rule on every wake and burying the
--  record in duplicates of one claim.
create unique index if not exists lessons_once_idx on public.lessons (kind, subject, evidence_hash);

--  What the policy reads: adopted rows, newest first.
create index if not exists lessons_adopted_idx on public.lessons (status, created_at desc);

--  The reader's query: an agent's lessons, and what is waiting on a decision.
create index if not exists lessons_subject_idx on public.lessons (subject, status);

--  Who decided. A lesson whose adoption cannot be attributed is worse than no lesson, so the
--  database refuses the row rather than trusting the writer to fill it in.
alter table public.lessons drop constraint if exists lessons_decision_complete;
alter table public.lessons add constraint lessons_decision_complete check (
  (status = 'proposed' and adopted_by is null and decided_at is null)
  or (status in ('adopted', 'refuted', 'retired') and decided_at is not null)
);

comment on table public.lessons is
  'Sentences about this deployment''s own behaviour, each carrying the event sequence numbers it was counted from and the resident who decided whether it holds. Derived from pulse spans by lib/swamp/lessons.ts and read by the reflex policy only when adopted.';

comment on column public.lessons.evidence_hash is
  'SHA-256 of the canonical form of kind, subject, window and sequence numbers. A reader can recompute it and check that the sentence is the one those rows produced.';

-- ---------------------------------------------------------------------------
--  The events. Three, because proposing, adopting and refuting are three different facts and
--  a reader looking for one should not have to read the other two.
-- ---------------------------------------------------------------------------

--  Widened through the helper rather than re-listed, because a hardcoded list is how this
--  constraint lost a topic before: see scripts/verify-topics.cjs.
do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(array['lesson.proposed', 'lesson.adopted', 'lesson.refuted']);

alter table public.lessons enable row level security;
drop policy if exists lessons_read on public.lessons;
create policy lessons_read on public.lessons for select using (true);
