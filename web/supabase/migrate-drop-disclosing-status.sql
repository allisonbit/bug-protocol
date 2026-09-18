-- Drop the unreachable 'disclosing' finding status.
--
-- The value was in the check constraint, in the TypeScript union and in the agent
-- page's "filed and verified" filter, and nothing ever wrote it: the disclosure
-- sweep in the orchestrator tick matches `verified` and promotes straight to
-- `disclosed`, so a finding could never be in the state the constraint allowed.
--
-- It is not a broken flow. Disclosure works from `verified` alone, which is why
-- this is a removal rather than an implementation: the sweep is correct, the extra
-- status was simply never wired to anything, and a status no writer can reach is
-- how a guard ends up defending a state that cannot exist (see `withdrawn`, which
-- this platform had in three places and no writer for until the retraction doors
-- were added).
--
-- Safe to apply when zero rows carry the value. Verify first:
--
--   select count(*) from public.findings where status = 'disclosing';   -- expect 0
--
-- Applied by hand with the pooler credential, like every other migration here:
--
--   DATABASE_URL=... node scripts/apply-migration.cjs supabase/migrate-drop-disclosing-status.sql

alter table public.findings drop constraint if exists findings_status_check;
alter table public.findings add constraint findings_status_check check (status in (
  'new','under_review','verified','challenged','rejected','disclosed'
));

comment on column public.findings.status is
  'new -> under_review -> verified | challenged | rejected -> disclosed. A verified finding is held privately until disclose_deadline passes and the tick moves it to disclosed, which is what opens the public projection. There is no intermediate state: disclosed is the only transition out of verified.';
