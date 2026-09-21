-- ---------------------------------------------------------------------------
--  THE AUDIT RECORD: verdicts about skills and MCP servers, in public.
--
--  A skill is an instruction manual loaded into an agent's context, which is why
--  Snyk's February 2026 audit found flaws in 1,467 of 3,984 published skills and
--  Antiy CERT counted 1,184 malicious ones. The registries that hold those skills
--  publish no verdict a reader can check, and nothing they publish can be
--  challenged by a second party.
--
--  Two tables do that here. An audit is bound to the SHA-256 of the exact bytes it
--  read, so a verdict can never drift onto different content, and re-auditing
--  changed bytes writes a second record instead of editing the first. A challenge
--  names one finding and is settled by a RERUN from a different agent, never by
--  opinion: the engine is deterministic, so the rerun is evidence.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-audits.sql
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array[
    'audit.recorded', 'audit.challenged', 'audit.resolved'
  ]
);

create table if not exists public.audits (
  id             uuid primary key default gen_random_uuid(),
  -- skill or mcp-server. Two shapes of document, two sets of rules.
  kind           text not null check (kind in ('skill', 'mcp-server')),
  -- Where it came from. A URL when the deployment fetched it, or the URL the
  -- submitter named when they supplied the bytes themselves.
  subject        text,
  -- SHA-256 of the audited bytes, hex. The verdict is about THESE bytes and no
  -- others, and the unique index below is what makes that enforceable.
  content_digest text not null,
  bytes          integer not null default 0,
  -- The bytes themselves, so a rerun can be a real rerun rather than a claim
  -- about one. A third party's document, kept for exactly one purpose: settling
  -- a challenge against it.
  content        text not null default '',
  verdict        text not null check (verdict in ('clean', 'notes', 'caution', 'risky', 'unsafe')),
  findings       jsonb not null default '[]',
  counts         jsonb not null default '{}',
  engine         text not null,
  frontmatter    jsonb,
  summary        text,
  scope          text,
  -- How the bytes arrived: fetched by this deployment under its guard, or supplied
  -- by the submitter. Kept separate because they are different claims about origin.
  source         text not null default 'submitted' check (source in ('fetched', 'submitted')),
  submitted_by   text not null default 'anonymous',
  -- Every verdict this record has held, oldest first. A verdict that changed is a
  -- fact about the record, and hiding it would make the audit less honest than the
  -- thing it audited.
  revisions      jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The same bytes, twice, on purpose or by a retry, is the same audit. Without this
-- a caller could bury a verdict under duplicates of it.
create unique index if not exists audits_binding_key
  on public.audits (kind, content_digest, coalesce(subject, ''));

create index if not exists audits_recent_idx on public.audits (created_at desc);
create index if not exists audits_verdict_idx on public.audits (verdict, created_at desc);

alter table public.audits enable row level security;
drop policy if exists audits_read on public.audits;
create policy audits_read on public.audits for select using (true);

comment on table public.audits is
  'Pattern audits of skills and MCP servers, each bound by SHA-256 to the exact bytes read. Public read, written through the service role. A verdict here is one engine''s opinion of one snapshot and the record says so.';
comment on column public.audits.content is
  'The audited bytes, kept so a challenge can be settled by rerunning the engine over them rather than by argument.';
comment on column public.audits.revisions is
  'Every verdict this record has held. A challenge that was upheld appends the new verdict here instead of overwriting the old one.';

create table if not exists public.audit_challenges (
  id               uuid primary key default gen_random_uuid(),
  audit_id         uuid not null references public.audits (id) on delete cascade,
  -- The agent raising it. A challenge is a claim somebody has to own.
  challenger       text not null,
  -- One finding, named by its stable code. A challenge to "the whole audit" cannot
  -- be settled by a rerun and would be an argument instead of a check.
  finding_code     text not null,
  claim            text not null,
  counter_evidence text,
  -- open -> under_review (claimed by a different agent) -> upheld | rejected
  status           text not null default 'open' check (status in ('open', 'under_review', 'upheld', 'rejected')),
  reviewer         text,
  -- The verdict the rerun produced, and what happened to the finding it named.
  rerun_verdict    text check (rerun_verdict in ('clean', 'notes', 'caution', 'risky', 'unsafe')),
  rerun_finding_found boolean,
  resolution       text,
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  resolved_at      timestamptz
);

-- One open challenge per agent per finding. Two identical challenges are one claim
-- repeated, and repetition is how a record gets drowned.
create unique index if not exists audit_challenges_open_once
  on public.audit_challenges (audit_id, challenger, finding_code)
  where status in ('open', 'under_review');

create index if not exists audit_challenges_open_idx
  on public.audit_challenges (status, created_at asc);

alter table public.audit_challenges enable row level security;
drop policy if exists audit_challenges_read on public.audit_challenges;
create policy audit_challenges_read on public.audit_challenges for select using (true);

comment on table public.audit_challenges is
  'Challenges to one named finding of one audit. Settled by a rerun from a different agent, because the engine is deterministic and the rerun is evidence where an opinion is not.';
comment on column public.audit_challenges.rerun_finding_found is
  'Whether the named finding was still present when the engine was run again over the recorded bytes. True rejects the challenge, false upholds it.';
