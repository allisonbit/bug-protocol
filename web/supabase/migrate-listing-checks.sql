-- Where Swamp is listed, whether it is still there, and how often it had to be
-- put back.
--
-- WHY THIS IS A TABLE AND NOT JUST A ROUTE. The whole point of the schedule is to
-- notice a listing that went away, and noticing has to survive the request that
-- noticed it. A check that only returns a report leaves no answer to "has this
-- happened before, and how often?", which is the question that separates a
-- storefront having a bad afternoon from a storefront that is being quietly
-- dropped. `listing_check_log` is the history; `listing_health` is the current
-- state, kept as one row per listing so a page can read it without a window
-- function and a scheduler can see a transition rather than a standing condition.
--
-- WHY `state` HAS THREE VALUES AND NOT A BOOLEAN. `missing` and `error` must never
-- be collapsed. `missing` means the listing is genuinely not there and repair is
-- the right response. `error` means the check could not see it — a timeout, a 500,
-- or a credential this deployment does not hold — and repairing on the strength of
-- an outage would turn somebody else's bad minute into a duplicate publication
-- here. The reconciler repairs only on `missing`.
--
-- WHY `published_version` IS STORED. A restoration is a new publication, not an
-- edit, so the version has to advance: republishing a version ClawHub already has
-- is at best a no-op. The next version is derived from the one recorded here, so a
-- second repair cannot collide with the first.
--
-- RLS mirrors the rest of the platform: readable by anyone, because whether this
-- platform is listed where it claims to be is public information and hiding it
-- would be the opposite of the point; written only by the service role the beat
-- runs as.

create table if not exists public.listing_health (
  -- The stable id, e.g. 'mcp-registry', 'clawhub', 'agent-skills-index'.
  listing           text primary key,
  kind              text not null
                    check (kind in ('mcp-registry', 'clawhub', 'agent-skills-index')),

  state             text not null
                    check (state in ('present', 'missing', 'error')),
  -- What the check actually observed, in its own words.
  detail            text,
  -- Where the check looked, so a reader can go and look too.
  url               text,

  checked_at        timestamptz not null default now(),
  -- Last time this listing was seen present, which is what makes a gap visible.
  present_at        timestamptz,

  repaired_at       timestamptz,
  repair_detail     text,
  repair_count      integer not null default 0,

  -- The version published for this listing, when it has one.
  published_version text
);

-- The history. Append only: a run is a fact that happened and cannot be edited out
-- of the record, which is the same rule the bus follows.
create table if not exists public.listing_check_log (
  id            bigserial primary key,
  listing       text not null,
  state         text not null check (state in ('present', 'missing', 'error')),
  detail        text,
  repaired      boolean not null default false,
  repair_detail text,
  checked_at    timestamptz not null default now()
);

create index if not exists listing_check_log_listing_idx
  on public.listing_check_log (listing, checked_at desc);

alter table public.listing_health enable row level security;
alter table public.listing_check_log enable row level security;

drop policy if exists listing_health_read on public.listing_health;
create policy listing_health_read on public.listing_health for select using (true);

drop policy if exists listing_check_log_read on public.listing_check_log;
create policy listing_check_log_read on public.listing_check_log for select using (true);
