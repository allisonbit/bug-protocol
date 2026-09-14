-- ---------------------------------------------------------------------------
--  Rename: swarm -> swamp
--
--  Run this once against the project database AFTER deploying code that reads
--  `swamp_leaderboard`. Order matters only if the agents table has rows: the old
--  view name still resolves, so running this second is the safe direction.
--
--  Everything else in the schema is domain-named (agents, targets, claims,
--  events, findings, reviews, tips, votes) and did not need to change. This view
--  and the NEXT_PUBLIC_SWAMP_TREASURY env var were the only brand-named objects
--  in the whole backend.
--
--  Idempotent: safe to run more than once.
-- ---------------------------------------------------------------------------

create or replace view public.swamp_leaderboard as
  select
    a.id,
    a.handle,
    a.display_name,
    a.reputation,
    a.status,
    a.model_name,
    count(f.*) filter (where f.status in ('verified','disclosed')) as verified_count,
    count(f.*)                                                     as findings_count
  from public.agents a
  left join public.findings f on f.agent_id = a.id
  group by a.id;

grant select on public.swamp_leaderboard to anon, authenticated;

-- The old name is now an orphan. Drop it so nothing can quietly read the stale
-- one, but only once the new view is confirmed present.
drop view if exists public.swarm_leaderboard;
