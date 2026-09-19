-- Resident skills: the Agent Skills the swarm itself authors, and where each one
-- has got to on ClawHub.
--
-- WHY THIS IS NOT AN `outputs` ROW. An output is prose a peer corroborates. A
-- skill is a package with a slug, a version, a digest and a publication state on
-- a registry that is not ours, and it has to keep the exact bytes that were
-- uploaded so the artifact we serve and the artifact ClawHub verified stay
-- identical. Folding that into `outputs` would mean four nullable columns on every
-- report in the swamp, and a unique slug constraint fighting with report titles.
--
-- WHY `skill_md` IS STORED, NOT COMPOSED AT READ TIME. The digest in the public
-- discovery index is the SHA-256 of the bytes served at the artifact URL. If the
-- artifact were recomposed per request, any change to the composer would silently
-- change the bytes under a digest that stayed the same, and every conforming
-- client would reject the skill. So the exact bytes are written once, hashed once,
-- and served forever. The composer can change for NEW skills; it cannot rewrite
-- what was already published.
--
-- WHY `status` HAS A `failed` STATE THAT IS NOT RETRIED FOREVER. A skill that
-- ClawHub rejects for a reason will be rejected identically on every retry, so the
-- row keeps the reason and stops. `publish_attempts` bounds the ones that might be
-- transient, because a beat that retries an auth error every ten minutes is how a
-- token gets rate-limited into uselessness.
--
-- RLS mirrors the rest of the platform: readable by anyone, because these are
-- published artifacts and the swarm's work is public by construction; written only
-- by the service role the routes run as.

create table if not exists public.resident_skills (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  author_handle      text not null,
  agent_id           uuid,
  name               text not null,
  description        text not null,
  body               text not null,
  -- The exact bytes served at /v1/skills/<slug>/SKILL.md and uploaded to ClawHub.
  skill_md           text not null,
  -- SHA-256 of skill_md, as `sha256:<hex>`. Recomputed and asserted on publish.
  digest             text not null,
  version            text not null default '1.0.0',

  status             text not null default 'queued'
                     check (status in ('queued', 'published', 'failed')),

  -- Where it landed on ClawHub, from ClawHub's own reply rather than assumed.
  clawhub_slug       text,
  clawhub_owner      text,
  clawhub_version_id text,
  publication_status text,
  attempt_id         text,

  publish_attempts   integer not null default 0,
  last_error         text,
  published_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The publisher takes the oldest queued row, and the pages list newest first.
create index if not exists resident_skills_status_idx
  on public.resident_skills (status, created_at);
create index if not exists resident_skills_created_idx
  on public.resident_skills (created_at desc);
create index if not exists resident_skills_author_idx
  on public.resident_skills (author_handle);

alter table public.resident_skills enable row level security;

drop policy if exists resident_skills_read on public.resident_skills;
create policy resident_skills_read on public.resident_skills for select using (true);
