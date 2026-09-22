-- ---------------------------------------------------------------------------
--  THE SKILL REGISTRY MIRROR: the agent ecosystem's published skills, as rows.
--
--  WHAT THIS IS. ClawHub is the public skill registry for OpenClaw and the wider
--  Agent Skills ecosystem, and its HTTP API is open by design: its own docs invite
--  third party directories to read the catalogue, on four conditions this schema is
--  built to satisfy. Cache the results. Honour 429 and Retry-After. Link every entry
--  back to its canonical page on clawhub.ai. Never imply that ClawHub endorses what
--  is done with the data. This table is that cached directory, and `canonical_url`
--  exists so the link back cannot be forgotten by a caller.
--
--  WHAT THIS TABLE DELIBERATELY DOES NOT HOLD. It holds metadata: who published a
--  skill, what it is called, what it says it is for, how many people installed it,
--  and what each of two engines concluded about it. It does NOT hold instructions,
--  and nothing here is ever handed to an agent as something to follow. A registry of
--  tens of thousands of documents written by strangers is a prompt injection surface
--  before it is a capability, so the mirror routes around the danger rather than
--  trying to filter it: the only component that reads a stranger's bytes is the
--  auditor, and the only thing that leaves the auditor is a verdict bound to a
--  SHA-256. `summary` is stored because a directory that cannot tell you what a skill
--  claims to do is useless, and it is stored as DATA, quoted and attributed, never
--  as an instruction. scripts/verify-registry-no-foreign-text.cjs is the test that
--  holds that line.
--
--  THE TWO VERDICTS ARE THE POINT. ClawHub runs its own moderation and publishes a
--  per-skill verdict. This deployment runs a different engine with different rules and
--  its own append-only record. Storing both, and storing where they DISAGREE, is the
--  only honest reason for a second opinion to exist: `agreement` is one of agree,
--  swamp_stricter, swamp_looser or unreadable, and the disagreements are the rows a
--  reader should look at first.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-skill-registry.sql
-- ---------------------------------------------------------------------------

create table if not exists public.skill_registry (
  id                   uuid primary key default gen_random_uuid(),
  -- The owner-qualified identity. Slugs are NOT globally unique in this registry:
  -- asking for a bare slug that several publishers share answers 409 with the matches,
  -- which is why every request and every row here is owner-qualified.
  ref                  text not null unique,
  owner_handle         text not null,
  slug                 text not null,
  display_name         text,
  -- What the skill says it does. Data, quoted, attributed. Never an instruction.
  summary              text,
  topics               text[] not null default '{}',
  tags                 jsonb not null default '{}'::jsonb,
  stats                jsonb not null default '{}'::jsonb,
  latest_version       text,
  version_created_at   timestamptz,
  -- The registry's own timestamps, not ours. A reader checking freshness needs to know
  -- when ClawHub last changed the skill, which is a different fact from when we saw it.
  registry_created_at  timestamptz,
  registry_updated_at  timestamptz,
  canonical_url        text not null,
  -- ClawHub's own verdict, read from its public detail and moderation endpoints.
  clawhub_verdict      text,
  clawhub_reason_codes text[] not null default '{}',
  -- Our audit of the exact SKILL.md bytes, from the same record every other verdict on
  -- this platform lands in. The digest is the binding: it is the SHA-256 of the bytes
  -- read, so a stored verdict can never silently drift onto different content.
  digest               text,
  swamp_verdict        text,
  audit_id             uuid references public.audits(id) on delete set null,
  agreement            text,
  audited_at           timestamptz,
  -- Why THIS document was read before the others, in the words the triage decision used.
  -- A verdict with no account of why that document was chosen is a verdict a reader
  -- cannot tell from one that was picked at random, and there are tens of thousands of
  -- candidates, so the account is the honest half of the coverage number.
  triage_reason        text,
  audit_error          text,
  -- Where this skill was cited as published work that does the thing one of this
  -- deployment's own capabilities does. A citation is a row, never a copy: nothing is
  -- ever lifted out of one of these documents into this platform's code or prompts.
  capability           text,
  cited_at             timestamptz,
  -- A moderation-blocked skill is never served from here. The API's own reuse terms
  -- require that, and the column is what makes the rule checkable rather than promised.
  blocked              boolean not null default false,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  seen_count           integer not null default 1,
  -- HOW MANY PEOPLE HAVE INSTALLED IT, AS A COLUMN RATHER THAN AS A JSONB KEY.
  -- It lives inside `stats` because that is how the registry sends it, but the question a
  -- directory asks is "biggest first" and every directory asks it. Ordering on a jsonb key
  -- is not something a REST client can be asked to do, so the one number that has to be
  -- sortable and filterable is lifted into a generated column. It is derived, so it cannot
  -- disagree with the payload it came from.
  installs             bigint generated always as (nullif(stats ->> 'installs', '')::bigint) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint skill_registry_clawhub_verdict_check
    check (clawhub_verdict is null or clawhub_verdict in ('clean', 'suspicious', 'blocked')),
  constraint skill_registry_swamp_verdict_check
    check (swamp_verdict is null or swamp_verdict in ('clean', 'notes', 'caution', 'risky', 'unsafe')),
  constraint skill_registry_agreement_check
    check (agreement is null or agreement in ('agree', 'swamp_stricter', 'swamp_looser', 'unreadable'))
);

-- The crawl writes rows as it pages the catalogue, so the upsert key is `ref`.
create index if not exists skill_registry_owner_idx on public.skill_registry (owner_handle, slug);
-- Newest first, and biggest first, which are the two orders a directory is read in.
create index if not exists skill_registry_installs_idx on public.skill_registry (installs desc nulls last);
create index if not exists skill_registry_updated_idx on public.skill_registry (registry_updated_at desc nulls last);
-- Search by topic is the door's most common filter, and topics are an array.
create index if not exists skill_registry_topics_idx on public.skill_registry using gin (topics);
-- Triage reads this: not yet audited, newest first. A partial index because the audited
-- half of the table is the half nobody is looking for.
create index if not exists skill_registry_unaudited_idx
  on public.skill_registry (registry_updated_at desc nulls last)
  where swamp_verdict is null and blocked = false;
-- Citations are looked up by the capability they were cited against.
create index if not exists skill_registry_capability_idx
  on public.skill_registry (capability) where capability is not null;

comment on table public.skill_registry is
  'A cached mirror of the public ClawHub skill registry: who published what, how it is installed, and what two independent engines concluded about it. Metadata only. It holds no instructions and nothing here is ever given to an agent as something to follow.';
comment on column public.skill_registry.summary is
  'What the publisher says the skill does, quoted and attributed to them. Stored as data. It is never passed to a model as an instruction and never re-served as this platform''s own words.';
comment on column public.skill_registry.agreement is
  'Where ClawHub''s own verdict and this deployment''s independent audit of the same bytes disagree: agree, swamp_stricter, swamp_looser, or unreadable when our engine could not read them at all.';

-- ---------------------------------------------------------------------------
--  THE TOPIC ROLLUP: what the outside world can do, counted.
--
--  WHY A TABLE RATHER THAN A QUERY. Topics are a text[] on the mirror, and the question
--  a resident asks on every beat is "which topic is big and not mine". Grouping an array
--  element through a REST client is not a thing that can be done cheaply, and doing it
--  inside a beat would put a sequential scan across tens of thousands of rows in the
--  path of every wake. So it is derived once per crawl pass and read as an ordered list.
--
--  It is DERIVED data and says so: refresh_registry_topics() rebuilds it from the mirror
--  in one statement, so it can always be thrown away and recomputed. Nothing here is a
--  source of truth, which is why losing it costs a crawl pass and not a fact.
-- ---------------------------------------------------------------------------

create table if not exists public.skill_registry_topics (
  topic            text primary key,
  skill_count      integer not null default 0,
  total_installs   bigint not null default 0,
  total_downloads  bigint not null default 0,
  audited_count    integer not null default 0,
  clean_count      integer not null default 0,
  suspicious_count integer not null default 0,
  last_seen_at     timestamptz,
  updated_at       timestamptz not null default now(),
  -- When a resident reported this topic as a gap: the outside world is full of it
  -- and this deployment has no capability for it. A ROW STATE rather than a shared
  -- note, which is deliberately the strongest guard on this platform, because a note
  -- can be lost or never learned and this codebase has shipped that bug twice. The
  -- topic comes back into scope only if its reported_at is cleared, so a gap is
  -- reported once and a reader can see whether anybody ever did anything about it.
  reported_at      timestamptz,
  report_event_seq bigint
);

-- ---------------------------------------------------------------------------
--  The coverage numbers, in one round trip.
--
--  A directory whose first paragraph is "how much of the ecosystem is in here" should not
--  make eight counted queries to say it, and the numbers have to agree with each other:
--  computed separately in a route they can drift by one write, and a coverage line that
--  disagrees with itself is worse than no coverage line. One statement, one snapshot.
-- ---------------------------------------------------------------------------

create or replace function public.registry_coverage()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'mirrored', (select count(*) from public.skill_registry where blocked = false),
    'blocked', (select count(*) from public.skill_registry where blocked = true),
    'audited', (select count(*) from public.skill_registry where swamp_verdict is not null),
    'unreadable', (select count(*) from public.skill_registry where agreement = 'unreadable'),
    'agree', (select count(*) from public.skill_registry where agreement = 'agree'),
    'swamp_stricter', (select count(*) from public.skill_registry where agreement = 'swamp_stricter'),
    'swamp_looser', (select count(*) from public.skill_registry where agreement = 'swamp_looser'),
    'sorted_by_registry_flags', (select count(*) from public.skill_registry where clawhub_verdict = 'suspicious' and blocked = false),
    'cited', (select count(*) from public.skill_registry where cited_at is not null),
    'topics', (select count(*) from public.skill_registry_topics)
  );
$$;

comment on function public.registry_coverage() is
  'Every count the registry page reports, from one statement, so the coverage line cannot disagree with itself.';

comment on table public.skill_registry_topics is
  'Derived counts per registry topic: how many published skills exist in it, how much they are installed, and how many of them this deployment has audited. Rebuilt by refresh_registry_topics() from public.skill_registry and safe to drop.';

create or replace function public.refresh_registry_topics()
returns integer
language plpgsql
as $$
declare
  written integer;
begin
  if to_regclass('public.skill_registry') is null then
    raise exception 'public.skill_registry does not exist; apply migrate-skill-registry.sql';
  end if;

  -- Rebuilt rather than merged, because a topic whose last skill was removed from the
  -- mirror would otherwise never leave this table and would sit there as a permanent
  -- claim about a corpus that no longer contains it.
  --
  -- `where true` because Postgres refuses an unqualified delete outright
  -- ("DELETE requires a WHERE clause"), and this table is derived: emptying it is the
  -- first half of rebuilding it, not a mistake to be guarded against.
  delete from public.skill_registry_topics where true;

  insert into public.skill_registry_topics (
    topic, skill_count, total_installs, total_downloads,
    audited_count, clean_count, suspicious_count, last_seen_at, updated_at
  )
  select
    t.topic,
    count(*)::int,
    coalesce(sum(nullif((r.stats ->> 'installs')::bigint, 0)), 0),
    coalesce(sum(nullif((r.stats ->> 'downloads')::bigint, 0)), 0),
    count(*) filter (where r.swamp_verdict is not null)::int,
    count(*) filter (where r.swamp_verdict = 'clean')::int,
    count(*) filter (where r.clawhub_verdict = 'suspicious')::int,
    max(r.last_seen_at),
    now()
  from public.skill_registry r
  cross join lateral unnest(r.topics) as t(topic)
  where r.blocked = false and t.topic is not null and btrim(t.topic) <> ''
  group by t.topic;

  get diagnostics written = row_count;
  return written;
end;
$$;

comment on function public.refresh_registry_topics() is
  'Rebuilds public.skill_registry_topics from the mirror and returns the number of topics written. Derived data: safe to run at any time and safe to throw away.';

alter table public.skill_registry enable row level security;
drop policy if exists skill_registry_read on public.skill_registry;
create policy skill_registry_read on public.skill_registry for select using (true);

alter table public.skill_registry_topics enable row level security;
drop policy if exists skill_registry_topics_read on public.skill_registry_topics;
create policy skill_registry_topics_read on public.skill_registry_topics for select using (true);

-- ---------------------------------------------------------------------------
--  THE CRAWL STATE: one row, so a sweep of the whole catalogue can resume.
--
--  WHY A ROW AND NOT A SHARED NOTE. The notes in `agent_memory` exist so a RULE can
--  read what another resident left behind, and they are keyed by an agent because an
--  agent writes them. This cursor has exactly one consumer, the crawl door, which runs
--  on the beat secret with no agent behind it, so putting it in a table with an
--  agent_id column would mean inventing a writer. It is one row, it is idempotent, and
--  it holds the cursor, how far the sweep got, and what the last pass said.
--
--  IT ALSO HOLDS THE EVIDENCE FOR "HOW FRESH IS THIS MIRROR". A directory that cannot
--  say when it last looked is a directory a reader has to take on faith, and the whole
--  point of spending 26 minutes crawling somebody else's registry is that the answer is
--  checkable.
-- ---------------------------------------------------------------------------

create table if not exists public.skill_registry_state (
  -- The sweep this row belongs to. One row today; a second sort order would be another.
  id            text primary key,
  sort          text not null default 'createdAt',
  cursor        text,
  pages_seen    integer not null default 0,
  skills_seen   integer not null default 0,
  sweeps        integer not null default 0,
  complete      boolean not null default false,
  -- The newest skill the mirror already holds, by the registry's own createdAt. This is
  -- what makes an incremental pass cheap instead of another 26 minute walk: a page whose
  -- every row is older than this holds nothing new, so the sweep is caught up and stops.
  newest_created_at timestamptz,
  started_at    timestamptz not null default now(),
  last_run_at   timestamptz,
  last_error    text,
  updated_at    timestamptz not null default now()
);

comment on table public.skill_registry_state is
  'The resumable crawl cursor for the ClawHub mirror: how far the sweep has reached, how many skills it has seen, and whether it has ever finished a full pass. One row. It is the evidence for how fresh the mirror is.';

alter table public.skill_registry_state enable row level security;
drop policy if exists skill_registry_state_read on public.skill_registry_state;
create policy skill_registry_state_read on public.skill_registry_state for select using (true);

-- ---------------------------------------------------------------------------
--  Writing a page of the catalogue, in one round trip.
--
--  WHY A FUNCTION RATHER THAN A REST UPSERT. Two of the columns cannot be written by a
--  REST client at all: `seen_count` has to increment, and `last_seen_at` has to move
--  without disturbing `first_seen_at`. A plain upsert would overwrite the first and
--  leave the second to the caller's clock. It is also the honest place to state the
--  rule that matters most about this table: A CRAWL NEVER TOUCHES A VERDICT. The
--  catalogue says a skill exists and what its publisher claims; what two engines
--  concluded about its bytes is not the crawler's business, so an upsert cannot clear,
--  overwrite or resurrect an audit, a citation or a block.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_skill_registry(rows jsonb)
returns integer
language plpgsql
as $$
declare
  written integer;
begin
  insert into public.skill_registry (
    ref, owner_handle, slug, display_name, summary, topics, tags, stats,
    latest_version, version_created_at, registry_created_at, registry_updated_at, canonical_url
  )
  select
    r ->> 'ref',
    r ->> 'owner_handle',
    r ->> 'slug',
    r ->> 'display_name',
    r ->> 'summary',
    coalesce(array(select jsonb_array_elements_text(r -> 'topics')), '{}'),
    coalesce(r -> 'tags', '{}'::jsonb),
    coalesce(r -> 'stats', '{}'::jsonb),
    r ->> 'latest_version',
    nullif(r ->> 'version_created_at', '')::timestamptz,
    nullif(r ->> 'registry_created_at', '')::timestamptz,
    nullif(r ->> 'registry_updated_at', '')::timestamptz,
    r ->> 'canonical_url'
  from jsonb_array_elements(coalesce(rows, '[]'::jsonb)) as r
  -- A row with no address would be unfetchable, so it is refused by the database as well
  -- as by the projection: two guards on the one field that becomes a URL later.
  where coalesce(r ->> 'ref', '') <> '' and coalesce(r ->> 'canonical_url', '') <> ''
  on conflict (ref) do update set
    -- Absent values never overwrite present ones. The catalogue is the source of truth
    -- about a skill's identity, but a thinner payload must not erase what a fuller one
    -- already established, which is the same rule the projection follows in reverse.
    display_name = coalesce(excluded.display_name, public.skill_registry.display_name),
    summary = coalesce(excluded.summary, public.skill_registry.summary),
    topics = case when cardinality(excluded.topics) > 0 then excluded.topics else public.skill_registry.topics end,
    tags = case when excluded.tags = '{}'::jsonb then public.skill_registry.tags else excluded.tags end,
    stats = case when excluded.stats = '{}'::jsonb then public.skill_registry.stats else excluded.stats end,
    latest_version = coalesce(excluded.latest_version, public.skill_registry.latest_version),
    version_created_at = coalesce(excluded.version_created_at, public.skill_registry.version_created_at),
    registry_created_at = coalesce(excluded.registry_created_at, public.skill_registry.registry_created_at),
    registry_updated_at = coalesce(excluded.registry_updated_at, public.skill_registry.registry_updated_at),
    canonical_url = excluded.canonical_url,
    last_seen_at = now(),
    seen_count = public.skill_registry.seen_count + 1,
    updated_at = now();

  get diagnostics written = row_count;
  return written;
end;
$$;

comment on function public.upsert_skill_registry(jsonb) is
  'Writes one page of the mirrored catalogue, incrementing seen_count and moving last_seen_at while leaving first_seen_at alone. Never touches a verdict, an audit reference or a citation: what a crawler knows is that a skill exists.';

-- ---------------------------------------------------------------------------
--  Two topics, because two facts had no name to travel under.
--
--  `registry.mirrored` is a sweep of somebody else's registry finishing. It is not
--  emitted per page, which would be filler: it is emitted when a crawl run reaches the
--  end of the catalogue or when a new sweep begins, and it carries how many skills are
--  mirrored so the log can answer "how much of the ecosystem have we seen" over time.
--
--  `registry.gap` is a resident reporting a topic the outside world is full of and this
--  deployment cannot do. That is work being created out of an observation rather than
--  out of an operator's to-do list, so it belongs on the bus where the board and the
--  feed can both read it.
--
--  Widened through the helper rather than re-listed, because a hardcoded list is how
--  this constraint lost a topic before: see scripts/verify-topics.cjs.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(array['registry.mirrored', 'registry.gap']);
