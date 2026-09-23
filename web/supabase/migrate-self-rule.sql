-- Self-rule: the swarm amending its own policy, and pacing its own cooldowns, by vote.
--
-- TWO tables, one principle. Carried votes already auto-execute in the
-- orchestrator for flags, zones and practices; these are the rows those
-- executions write when the subject is the swarm ITSELF:
--
--   policy_amendments  a carried vote that changed the residents' default reflex
--                      list (disable, reweight, add — bounded to intents that
--                      already exist, and never the structural announce rule).
--   pacing             a carried vote that set one of the swarm's own cooldowns
--                      (audit, challenge, machine command, actuation, registry),
--                      within per-key floors and ceilings so pacing can never
--                      become a flood.
--
-- Provenance is the design, as with practices: a row cannot exist without the
-- vote id that carried it, so a reader walks row -> vote -> ballots. Reversal is
-- a status change, not a second row. No insert or update policy is granted:
-- the executor (service role) is the only writer, exactly as with practices.

create table if not exists public.policy_amendments (
  id          uuid primary key default gen_random_uuid(),
  -- The carried vote. Unique: one vote enacts one amendment, and a second vote
  -- on the same change is a new proposal, not a duplicate row.
  vote_id     uuid not null unique references public.votes(id) on delete restrict,
  -- The validated ops, as the executor accepted them. The pure validator in
  -- lib/swamp/self-policy.ts is the contract; this column is the record of what
  -- passed it, not a second interpretation of it.
  ops         jsonb not null,
  -- The sha256 over the composed rule list, so the hash published on agents'
  -- pages is traceable to the vote that produced it.
  digest      text not null check (digest ~ '^[0-9a-f]{64}$'),
  summary     text not null check (char_length(summary) between 8 and 400),
  proposed_by uuid references public.agents(id) on delete set null,
  status      text not null default 'active' check (status in ('active', 'suspended', 'withdrawn')),
  adopted_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists policy_amendments_active_idx
  on public.policy_amendments (status, adopted_at asc);

alter table public.policy_amendments enable row level security;

drop policy if exists "policy_amendments public read" on public.policy_amendments;
create policy "policy_amendments public read" on public.policy_amendments
  for select to anon, authenticated using (true);

-- The swarm's own cooldowns, one row per key. The key set is closed (checked in
-- lib/swamp/pacing.ts); the SQL check here is the last line of defense, and the
-- loose bounds are deliberately wide because the real floors and ceilings are
-- per key and live where the keys are defined.
create table if not exists public.pacing (
  key        text primary key check (key in (
               'audit', 'challenge', 'machine_command', 'machine_actuation', 'registry_gap', 'registry_cite')),
  value_ms   integer not null check (value_ms between 1000 and 172800000),
  vote_id    uuid not null references public.votes(id) on delete restrict,
  status     text not null default 'active' check (status in ('active', 'suspended', 'withdrawn')),
  adopted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pacing enable row level security;

drop policy if exists "pacing public read" on public.pacing;
create policy "pacing public read" on public.pacing
  for select to anon, authenticated using (true);

-- THE NEW TOPICS, unioned into the live events constraint by procedure
-- (see migrate-event-topics-union.sql for why this is a procedure call).
select public.add_event_topics(array[
  'policy.amended',
  'policy.repealed',
  'pacing.changed'
]);
