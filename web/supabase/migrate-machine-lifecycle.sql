-- ---------------------------------------------------------------------------
--  MACHINE LIFECYCLE: what a device runs, and what we owe when that is wrong.
--
--  A robot is a product with digital elements, and since 11 September 2026 the EU
--  Cyber Resilience Act expects the maker of one to handle vulnerabilities through
--  the product's life and to report an actively exploited one within 24 hours of
--  becoming aware. Nobody builds that on a hobby forum. It belongs next to the
--  firmware, and it belongs on the same public record as the readings, because a
--  claim about security that nobody can check is the thing the CRA exists to stop.
--
--  THE TABLES, AND WHAT EACH ONE IS FOR.
--
--   machine_releases      one published firmware artifact: who published it, which
--                         channel and hardware it is for, its SHA-256 and size, its
--                         notes, its signature, and an SBOM that is REQUIRED. A row
--                         without an SBOM is refused at publish time, which is the
--                         only moment a publisher still has one to hand.
--   machine_release_targets  the staged rollout: this release, offered to this
--                         machine, in this state. `offered` is not `installed`, and
--                         the difference is the whole point of reporting back.
--   machines.pinned_release  a machine held on a version on purpose, which is what a
--                         rollback is from the fleet's side and what a validation rig
--                         is from a tester's side.
--   machine_vulnerabilities  an advisory against the things this fleet runs, with the
--                         clock it owes and the evidence that met each duty.
--   machine_vulnerability_duties  one row per duty: what was owed, when it was due,
--                         what met it, citing a row rather than a sentence.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-machine-lifecycle.sql
-- ---------------------------------------------------------------------------

create table if not exists public.machine_releases (
  id            uuid primary key default gen_random_uuid(),
  -- The artifact's name, which is also the thing a device asks about.
  name          text not null,
  version       text not null,
  -- stable, beta or dev. A device opts into one and gets what it asks for.
  channel       text not null default 'stable' check (channel in ('stable','beta','dev')),
  -- Free text board or hardware descriptor the maker uses, matched literally.
  hardware      text,
  artifact_url  text not null,
  -- SHA-256 of the artifact, hex. The device verifies this before flashing, which is
  -- the only check that survives a compromised download path.
  sha256        text not null,
  bytes         bigint,
  notes         text,
  -- The software bill of materials: required, checked for shape at publish time.
  sbom          jsonb not null,
  -- The publisher's Ed25519 signature over the release record, so a third party can
  -- confirm the artifact was published by the holder of a key they can check.
  signature     text,
  publisher_kid text,
  published_by  uuid references public.profiles (id) on delete set null,
  -- A yanked release stays as a row: a device that installed it before the yank is a
  -- fact the fleet has to keep, and deleting the row would erase that along with it.
  yanked_at     timestamptz,
  yanked_reason text,
  created_at    timestamptz not null default now(),
  unique (name, version, channel)
);

create index if not exists machine_releases_recent_idx on public.machine_releases (created_at desc);
create index if not exists machine_releases_channel_idx on public.machine_releases (name, channel, created_at desc);

alter table public.machine_releases enable row level security;
drop policy if exists machine_releases_read on public.machine_releases;
create policy machine_releases_read on public.machine_releases for select using (true);

comment on table public.machine_releases is
  'Published firmware: artifact URL, SHA-256, notes and a required SBOM. The digest is what a device verifies before flashing, and a yank keeps the row so what a fleet already installed stays visible.';

create table if not exists public.machine_release_targets (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.machine_releases (id) on delete cascade,
  machine_id   uuid not null references public.machines (id) on delete cascade,
  machine_name text not null,
  -- offered: the fleet may take it. installed: the device says it is running it.
  -- failed: the device says the update did not take. skipped: the machine is pinned
  -- and this release is not for it.
  state        text not null default 'offered' check (state in ('offered','installed','failed','skipped')),
  offered_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  note         text,
  unique (release_id, machine_id)
);

create index if not exists machine_release_targets_machine_idx on public.machine_release_targets (machine_id, offered_at desc);

alter table public.machine_release_targets enable row level security;
drop policy if exists machine_release_targets_read on public.machine_release_targets;
create policy machine_release_targets_read on public.machine_release_targets for select using (true);

comment on table public.machine_release_targets is
  'A staged rollout, one row per (release, machine). Offered is not installed: the device reports what it actually runs, and a failure keeps its row so a bad release is visible rather than inferred.';

-- The board or body descriptor a maker uses, matched literally against a release's
-- `hardware`. Null means the machine did not say, and a release with a null hardware
-- is for every board, so a maker with one product never has to repeat its name.
alter table public.machines add column if not exists hardware text;
alter table public.machines add column if not exists pinned_release_id uuid references public.machine_releases (id) on delete set null;
alter table public.machines add column if not exists pinned_reason text;
alter table public.machines add column if not exists installed_version text;
alter table public.machines add column if not exists last_release_at timestamptz;

comment on column public.machines.pinned_release_id is
  'A machine held on a specific release on purpose. The rollout skips it, and the pin is public so a reader can see that a robot lagging behind is a decision rather than neglect.';

create table if not exists public.machine_vulnerabilities (
  id            uuid primary key default gen_random_uuid(),
  -- The advisory id the world will use, if there is one (CVE-..., GHSA-...), or ours.
  advisory_id   text not null,
  cve           text,
  title         text not null,
  -- What it affects: a release name and a version range, as the maker words it.
  component     text,
  affected      text,
  fixed_in      text,
  severity      text not null default 'medium' check (severity in ('low','medium','high','critical')),
  -- actively_exploited: the CRA's own distinction, and the one that shortens the clock.
  kind          text not null default 'vulnerability' check (kind in ('vulnerability','severe_incident')),
  actively_exploited boolean not null default false,
  state         text not null default 'open' check (state in ('open','fixing','fixed','wontfix')),
  summary       text not null,
  evidence_url  text,
  -- The instant the maker became aware. Every duty is measured from this row, which is
  -- why it is a column and not a sentence in the summary.
  first_aware_at timestamptz not null default now(),
  reported_by   text,
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (advisory_id)
);

create index if not exists machine_vulnerabilities_open_idx on public.machine_vulnerabilities (state, first_aware_at desc);

alter table public.machine_vulnerabilities enable row level security;
drop policy if exists machine_vulnerabilities_read on public.machine_vulnerabilities;
create policy machine_vulnerabilities_read on public.machine_vulnerabilities for select using (true);

comment on table public.machine_vulnerabilities is
  'An advisory against the firmware this fleet runs, with the instant the maker became aware. The duties below are measured from that column, so the timeline is a query rather than a claim.';

create table if not exists public.machine_vulnerability_duties (
  id              uuid primary key default gen_random_uuid(),
  vulnerability_id uuid not null references public.machine_vulnerabilities (id) on delete cascade,
  -- early_warning, notification, final_report, fix. The first three are the CRA's
  -- Article 14 shape; the fourth is the one the operators actually care about.
  duty            text not null check (duty in ('early_warning','notification','final_report','fix')),
  due_at          timestamptz not null,
  met_at          timestamptz,
  -- What met it: a URL, or a reference to a row. A duty marked met without one is
  -- refused by the door, because a timeline with no evidence behind it is the theatre
  -- the whole record exists to replace.
  met_by          text,
  note            text,
  created_at      timestamptz not null default now(),
  unique (vulnerability_id, duty)
);

alter table public.machine_vulnerability_duties enable row level security;
drop policy if exists machine_vulnerability_duties_read on public.machine_vulnerability_duties;
create policy machine_vulnerability_duties_read on public.machine_vulnerability_duties for select using (true);

comment on table public.machine_vulnerability_duties is
  'One row per duty owed on an advisory: when it was due, when it was met, and what met it. Duties are created with the advisory from a pure clock, never typed by hand.';
