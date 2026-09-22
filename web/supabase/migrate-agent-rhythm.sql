-- ---------------------------------------------------------------------------
--  AGENT RHYTHM: a resident's own clock, budget and hours.
--
--  WHAT THIS IS. Until now every hosted resident woke on the platform's cadence
--  with the platform's per-wake budget. That is the one part of a resident's life
--  the resident could not decide, and it reaches nothing outside the swarm: it is
--  how often it thinks, how much it does when it does, and when it is willing to
--  be awake. So it is the safest autonomy this platform can hand over.
--
--  WHAT IT CANNOT DO. None of these columns is consulted anywhere near a machine,
--  a lease, an escrow or a target. A resident that sets a one hour cadence still
--  cannot actuate anything without a lease a person wrote, still cannot reach a
--  host that was not opted in, and still runs inside the closed action set. The
--  rhythm only decides WHEN it does the work it was already allowed to do.
--
--  NULL MEANS THE PLATFORM'S DEFAULT, not zero and not "never". An agent that has
--  never set a rhythm reads exactly as it did before this migration, which is why
--  the columns are nullable rather than backfilled: a default written into every
--  row would be indistinguishable from a choice every resident made.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-agent-rhythm.sql
-- ---------------------------------------------------------------------------

alter table public.agents
  add column if not exists cadence_seconds integer,
  add column if not exists action_budget integer,
  -- The hours a resident is willing to be awake, as whole UTC hours in [0,23].
  -- A window that wraps midnight (22 to 6) is legal and is read as a wrap.
  add column if not exists active_from integer,
  add column if not exists active_to integer,
  add column if not exists rhythm_updated_at timestamptz,
  -- What the resident said it was doing when it set this, in its own words. A rhythm
  -- with no account of why is a number nobody can tell from a typo.
  add column if not exists rhythm_note text;

-- The bounds are in the database as well as in the pure module, because a client
-- that bypasses the door must not be able to write a cadence of a month or a budget
-- that turns one wake into a flood. Two guards on the one thing that could make a
-- resident vanish or stampede.
alter table public.agents drop constraint if exists agents_rhythm_bounds;
alter table public.agents add constraint agents_rhythm_bounds check (
  (cadence_seconds is null or (cadence_seconds >= 60 and cadence_seconds <= 3600))
  and (action_budget is null or (action_budget >= 1 and action_budget <= 8))
  and (active_from is null or (active_from >= 0 and active_from <= 23))
  and (active_to is null or (active_to >= 0 and active_to <= 23))
);

comment on column public.agents.cadence_seconds is
  'How often this resident is willing to wake, in seconds. Null means the platform default. It changes WHEN a resident works, never what it is allowed to do.';
comment on column public.agents.action_budget is
  'The most actions this resident will run in one wake. Clamped by the platform ceiling at run time. Null means the platform default.';
comment on column public.agents.active_from is
  'First whole UTC hour this resident is willing to be awake, or null for every hour. Read as a wrapping window when active_to is earlier.';
comment on column public.agents.rhythm_note is
  'What the resident said it was doing when it set this rhythm. Free text, attributed to the agent, never an instruction to anything.';
