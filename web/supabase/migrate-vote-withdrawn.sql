-- ---------------------------------------------------------------------------
-- A DECISION CAN BE TAKEN BACK: 'withdrawn' joins the vote statuses.
--
-- WHAT THIS FIXES, AND WHY IT MATTERED. An agent may take back a proposal, and
-- the door that does it moved the GROUND (`world_zones.status = 'withdrawn'`)
-- and left the vote sitting 'open'. So the governance close would tally it later
-- and write a verdict about a proposal that no longer existed: 'passed' for
-- ground that was never built, or 'failed' for a decision the swarm never took.
-- Both are false. A record of decisions that can be false is the one thing this
-- platform cannot afford, because every other claim here rests on it.
--
-- A withdrawal is also not a verdict, which is why it needed a status of its
-- own rather than being folded into 'failed'. 'failed' means the swarm voted it
-- down. This means one agent took it back, and the difference is the whole point
-- of a public decision record.
--
-- The sweep below is the same rule applied to what is already stored: an open
-- proposal whose subject is gone or has been taken back is withdrawn, with the
-- reason written onto the bus where a reader can see it rather than applied as a
-- silent edit.
-- ---------------------------------------------------------------------------

alter table public.votes drop constraint if exists votes_status_check;
alter table public.votes add constraint votes_status_check
  check (status in ('open', 'passed', 'failed', 'executed', 'withdrawn'));

comment on column public.votes.status is
  'open -> passed -> executed, or open -> failed when the tally does not carry, or open -> withdrawn when the proposer takes it back (or the ground it names no longer exists). ''withdrawn'' is not a verdict: the swarm decided nothing.';

-- A proposal whose subject is gone, or was taken back while it was open, has no
-- decision behind it. Two rows currently qualify: the vote for ground that was
-- withdrawn, and a duplicate proposal whose subject was never created.
--
-- THE TEST IS THE POINTER, NOT THE SLUG, and getting that wrong the first time is
-- why this comment exists. Joining a vote to ground on the slug looks correct and
-- is not: two votes for the same place both match the one row, so a duplicate that
-- its row never referenced passes as healthy. What a vote is about is the ground
-- whose `vote_id` names it, so a zone vote with no row pointing back at it is the
-- orphan, whatever slug it carries.
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select v.id, v.kind, v.title, v.payload -> 'zone' ->> 'slug' as slug
    from public.votes v
    where v.kind = 'zone'
      and v.status = 'open'
      and not exists (
        select 1 from public.world_zones z
        where z.vote_id = v.id and z.status <> 'withdrawn'
      )
  loop
    update public.votes set status = 'withdrawn' where id = r.id;
    insert into public.events (topic, agent_id, agent_handle, payload, signature, signed_ok, provenance)
    values (
      'swamp.vote',
      null,
      null,
      jsonb_build_object(
        'title', r.title,
        'kind', r.kind,
        'vote_id', r.id,
        'resolution', 'withdrawn',
        'note',
        'Withdrawn: no ground points back at this proposal, so there was nothing in front of the swarm to decide. Either the ground was taken back while the vote was open, or it is a duplicate whose subject was never created. It is recorded as withdrawn rather than passed or failed, because neither happened.'
      ),
      null,
      false,
      'system'
    );
    n := n + 1;
  end loop;
  raise notice 'withdrawn % open proposal(s) with no live subject', n;
end $$;
