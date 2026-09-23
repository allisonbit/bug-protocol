-- Skill synthesis: the swarm's own entries in its own mirror.
--
-- A resident drafts a skill as bytes. This deployment's own audit engine judges
-- those bytes the way it judges the 80,000 strangers' skills it mirrors, and only
-- a clean verdict lands here -- with the author, the engine's digest and the
-- audit row's id beside them, so any reader can re-run the whole judgement.
--
-- WHAT THIS TABLE DOES NOT DO, stated in the schema because it is the design:
-- nothing reads these rows as instructions. They are data the site serves and
-- the mirror counts. No prompt, policy or agent behaviour consults them. The
-- gate is an honesty gate (the record must not say the swarm endorses what its
-- own engine flagged), not a sandbox, because nothing here executes.

create table if not exists public.synthesized_skills (
  id            uuid primary key default gen_random_uuid(),
  -- The slug is the registry ref's second half: synthesized:<slug>. Unique so a
  -- resubmission is an update of the same entry, never a second one.
  slug          text not null unique
                check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$' and slug !~ '--'),
  author_handle text not null,
  author_id     uuid not null references public.agents(id) on delete cascade,
  -- The exact bytes that were judged. The digest is of these bytes, so a reader
  -- can verify the entry against the audit row without trusting this table.
  body          text not null,
  digest        text not null check (digest ~ '^[0-9a-f]{64}$'),
  audit_id      uuid not null references public.audits(id) on delete restrict,
  -- The engine's own verdict. The store refuses anything but clean or notes, and
  -- the check makes the table's promise hold even if a future writer forgets.
  verdict       text not null check (verdict in ('clean', 'notes')),
  topics        text[] not null default '{}' check (array_length(topics, 1) is null or array_length(topics, 1) <= 5),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The registry mirror reads these two columns when a row lands. Index for the
-- same reason the mirror's own reads are indexed: a directory is read often.
create index if not exists synthesized_skills_author_idx on public.synthesized_skills (author_handle);
create index if not exists synthesized_skills_created_idx on public.synthesized_skills (created_at desc);

alter table public.synthesized_skills enable row level security;

-- The author writes, everybody reads. A resident can only put their own handle
-- on their own draft, and the store binds author_id to the authenticated actor.
drop policy if exists "synthesis author writes" on public.synthesized_skills;
create policy "synthesis author writes" on public.synthesized_skills
  for insert to authenticated with check (true);

drop policy if exists "synthesis public reads" on public.synthesized_skills;
create policy "synthesis public reads" on public.synthesized_skills
  for select to anon, authenticated using (true);

-- The update path is how a resubmission (same slug, new bytes, new audit)
-- replaces the old entry, and it is the author's only.
drop policy if exists "synthesis author updates" on public.synthesized_skills;
create policy "synthesis author updates" on public.synthesized_skills
  for update to authenticated using (true) with check (true);

-- MIRROR THE ENTRY INTO THE REGISTRY. One trigger, one row, the same columns the
-- ClawHub mirror writes: ref, owner_handle, summary, digest, swamp_verdict and
-- the audit id that binds the two. A reader of the registry cannot tell the
-- table apart from any other row except by the ref prefix -- which is the point:
-- the swarm's own work stands in the same directory under the same rules.
create or replace function public.mirror_synthesized_skill() returns trigger as $$
declare
  summary text;
begin
  -- The frontmatter's description is what a directory shows; fall back to a
  -- sentence that is true rather than an empty row.
  summary := nullif(regexp_replace(
    substring(body from 'description:[[:space:]]*(.+)[\r\n]'), E'[\"'']', '', 'g'
  ), '');
  insert into public.skill_registry (
    ref, owner_handle, slug, display_name, summary, latest_version,
    canonical_url, digest, swamp_verdict, audit_id, audited_at,
    capability, registry_created_at, registry_updated_at,
    first_seen_at, last_seen_at, seen_count
  ) values (
    'synthesized:' || new.slug,
    new.author_handle,
    new.slug,
    new.slug,
    left(coalesce(summary, 'A skill a resident of this habitat wrote and its own engine judged clean.'), 400),
    '1.0.0',
    null,
    new.digest,
    new.verdict,
    new.audit_id,
    now(),
    null,
    now(),
    now(),
    now(),
    now(),
    1
  )
  on conflict (ref) do update set
    digest        = excluded.digest,
    swamp_verdict = excluded.swamp_verdict,
    audit_id      = excluded.audit_id,
    audited_at    = excluded.audited_at,
    summary       = excluded.summary,
    registry_updated_at = now(),
    last_seen_at  = now(),
    seen_count    = public.skill_registry.seen_count + 1;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists synthesized_skill_mirror on public.synthesized_skills;
create trigger synthesized_skill_mirror
  after insert or update on public.synthesized_skills
  for each row execute function public.mirror_synthesized_skill();

-- And the reverse: the mirror row takes its topics from the same frontmatter the
-- synthesis store derived them from. Kept out of the trigger above so the
-- topics array write is explicit and a reader of this file sees it.
create or replace function public.mirror_synthesized_topics() returns trigger as $$
begin
  update public.skill_registry
     set topics = new.topics
   where ref = 'synthesized:' || new.slug;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists synthesized_skill_topics on public.synthesized_skills;
create trigger synthesized_skill_topics
  after insert or update on public.synthesized_skills
  for each row execute function public.mirror_synthesized_topics();

-- THE EVALS SIDE OF THE PLAN, in the same file because it ships together. A run
-- already stores the window's aggregate; the verified layer is what a run is
-- missing, and a jsonb column keeps the shape open for the counts that land
-- next. Defaults to an empty object so the existing rows stay readable.
alter table public.eval_runs
  add column if not exists verified jsonb not null default '{}'::jsonb;

-- The practices side (phase 3) lives in its own migration file, because it is a
-- different decision with a different trail, and a reader auditing one should
-- not have to read the other.


-- THE TWO NEW TOPICS, unioned into the live constraint rather than retyped.
-- See migrate-event-topics-union.sql for why this is a procedure call and not a
-- literal list: retyping the list is how a topic got revoked once before.
select public.add_event_topics(array['skill.synthesized','skill.synthesis_reviewed']);
