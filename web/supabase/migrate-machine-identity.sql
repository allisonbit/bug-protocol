-- ---------------------------------------------------------------------------
--  MACHINE IDENTITY: a key per device, and a receipt per signed report.
--
--  Until now a machine's whole identity was one bearer token, which proves the
--  sender was told the secret and nothing about what was sent. A real robot
--  arrives already able to hold a private key and sign, so the record should be
--  able to say that a reading was signed by the key bound to this machine, and
--  to say the opposite just as plainly when it was not.
--
--  THREE RULES THIS SCHEMA KEEPS.
--
--  1. The platform never stores a private key. `machine_keys` holds public keys
--     only, exactly like `agents`. A device that loses its private key rotates.
--
--  2. An unsigned report is STORED and marked, never dropped. A platform whose
--     record silently omitted the unsigned half would be a record that flatters
--     itself, so `signed_ok = false` with a reason is a first class value.
--
--  3. A signature is not a nonce. The same signed bytes replayed a minute later
--     would verify perfectly, so a signed report also writes a RECEIPT keyed on
--     the digest of the canonical message, and the unique index below refuses
--     the second copy. The refusal is the replay guard, not an application
--     check that a code path could forget.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-machine-identity.sql
-- ---------------------------------------------------------------------------

create table if not exists public.machine_keys (
  id          uuid primary key default gen_random_uuid(),
  machine_id  uuid not null references public.machines (id) on delete cascade,
  -- The key id the device names when it signs: short, stable, and chosen by us so
  -- two devices cannot pick the same one inside a machine's history.
  kid         text not null,
  -- Raw 32 byte Ed25519 public key, hex, no DER wrapper: the interop boundary every
  -- language's Ed25519 library speaks, the same choice the agent layer made.
  public_key  text not null,
  algo        text not null default 'ed25519',
  -- How the device words itself when it registers the key. Self-reported, like model_name.
  label       text,
  created_at  timestamptz not null default now(),
  -- A retired key still verifies reports signed before it was retired, inside a
  -- grace window: a device that rotates mid-report must not have that report
  -- thrown away. A revoked key verifies nothing afterwards.
  retired_at  timestamptz,
  revoked_at  timestamptz,
  revoked_reason text,
  unique (machine_id, kid)
);

create index if not exists machine_keys_machine_idx on public.machine_keys (machine_id, created_at desc);
-- One active key per machine at a time: partial unique index rather than a rule in code.
create unique index if not exists machine_keys_one_active
  on public.machine_keys (machine_id)
  where retired_at is null and revoked_at is null;

alter table public.machine_keys enable row level security;
-- Public keys are public. That is the point of a public key.
drop policy if exists machine_keys_read on public.machine_keys;
create policy machine_keys_read on public.machine_keys for select using (true);

comment on table public.machine_keys is
  'Public keys bound to a machine. No private key is ever stored. A rotated key is retired with a grace window; a revoked key verifies nothing.';

-- One row per signed report, keyed on the digest of the canonical message. This is
-- the replay guard: the same signed bytes presented twice hit the unique index.
create table if not exists public.machine_report_receipts (
  id             uuid primary key default gen_random_uuid(),
  machine_id     uuid not null references public.machines (id) on delete cascade,
  machine_name   text not null,
  -- sha256 of the exact canonical message that was signed, hex.
  digest         text not null,
  kid            text,
  signed_ok      boolean not null default false,
  signed_reason  text,
  readings_count integer not null default 0,
  created_at     timestamptz not null default now(),
  unique (machine_id, digest)
);

create index if not exists machine_report_receipts_machine_idx
  on public.machine_report_receipts (machine_id, created_at desc);

alter table public.machine_report_receipts enable row level security;
drop policy if exists machine_report_receipts_read on public.machine_report_receipts;
create policy machine_report_receipts_read on public.machine_report_receipts for select using (true);

comment on table public.machine_report_receipts is
  'One row per signed report, keyed on the digest of the canonical signed message. The unique index is what makes a replayed report impossible rather than merely unlikely.';

-- What the door records about the signature of a reading, without ever refusing to
-- store the reading itself.
alter table public.machine_readings add column if not exists signature text;
alter table public.machine_readings add column if not exists signed_ok boolean not null default false;
alter table public.machine_readings add column if not exists signed_reason text;
alter table public.machine_readings add column if not exists report_digest text;
alter table public.machine_readings add column if not exists kid text;

create index if not exists machine_readings_digest_idx
  on public.machine_readings (report_digest)
  where report_digest is not null;

comment on column public.machine_readings.signed_ok is
  'True when this reading arrived inside a report whose Ed25519 signature verified against the key bound to the machine. False is a first class value with a reason, never an omission.';
