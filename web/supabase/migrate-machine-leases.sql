-- ---------------------------------------------------------------------------
--  MACHINE LEASES: the authority envelope around moving hardware.
--
--  A command that actuates something needs more than an owner's good intentions.
--  It needs a stated scope, an expiry, a ceiling on how many times it may fire, and
--  a record of who authorized it, so that "why did the relay close at 03:14" has an
--  answer on the row rather than in somebody's memory. That is a lease.
--
--  WHY A ROW RATHER THAN A FLAG ON THE MACHINE. A flag says "this machine may be
--  moved". A lease says by whom, until when, how many times, and why, and it can be
--  revoked without touching the machine. The distinction is the whole point: an
--  operator standing down a site revokes one row and every pending actuation loses
--  its authority, which is a thing a flag cannot express.
--
--  WHAT A LEASE IS NOT. It is not a safety mechanism, not a certification, and not
--  a claim that an actuation is safe. It is an authority envelope: the platform
--  refuses an actuation with no live lease, and the row is what a reader audits
--  afterwards. Nothing here asserts that a machine will do the right thing.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-machine-leases.sql
-- ---------------------------------------------------------------------------

create table if not exists public.machine_leases (
  id             uuid primary key default gen_random_uuid(),
  machine_id     uuid not null references public.machines(id) on delete cascade,
  machine_name   text not null,
  -- The act the lease authorizes, matching the command palette's name.
  scope          text not null,
  -- When the lease stops authorizing anything. Required: an open ended authority is
  -- the thing this table exists to prevent.
  expires_at     timestamptz not null,
  -- The ceiling on actuations. Required for the same reason as the expiry.
  max_actuations integer not null default 1,
  used_actuations integer not null default 0,
  -- Who authorized it. Exactly one of these is set, like every other attribution on
  -- this platform: a person, or an agent acting on its own beat.
  issued_by      uuid,
  issued_by_agent uuid,
  -- Why, in words, because a lease with no reason is indistinguishable from a lease
  -- nobody thought about.
  reason         text not null,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz not null default now()
);

create index if not exists machine_leases_machine_idx
  on public.machine_leases (machine_name, created_at desc);

-- The lookup every actuation does: is there a live lease for this machine and scope.
create index if not exists machine_leases_live_idx
  on public.machine_leases (machine_name, scope)
  where revoked_at is null;

comment on table public.machine_leases is
  'The authority envelope for actuating a machine: scope, expiry, actuation ceiling, issuer and reason. A missing or expired or exhausted or revoked lease is refused by every door that can move hardware. It is not a safety mechanism and asserts nothing about whether an actuation is safe.';
