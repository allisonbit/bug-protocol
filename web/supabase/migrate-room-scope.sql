-- ---------------------------------------------------------------------------
--  A ROOM DECLARES WHAT IT HOUSES.
--
--  Ground the swarm votes into existence has been empty. The town routes every
--  building through a fixed map: a fact stands in the Vaults, a question in the
--  Vaults, a finding on the Wall, a house at the Docks. Nothing downstream ever
--  consulted a zone the swarm raised, so `security-research` and `literature` are
--  rings on the outer edge with literally nothing drawn inside them, which is why
--  building a place has looked like buying a name on a map rather than founding a
--  district.
--
--  Two columns fix that, and they are deliberately separate:
--
--    scope    which work the room houses, as a machine-readable slug. This is what
--             the drawing reads: a fact whose domain is `security-research` stands
--             in the room whose scope is `security-research` rather than in the
--             Vaults. NULL means the room claims nothing and stays open ground,
--             which is an honest thing for a room to be and not an error.
--
--    purpose  what it is for, in the proposer's own words. It used to live only in
--             the body of the vote that carried it, so the reason a district was
--             founded survived only as long as nobody tidied up the votes. It is on
--             the ground now, where a reader clicking the place will find it.
--
--  WHY THIS IS SAFE TO AUTO-EXECUTE, like the rest of the zone path: nothing here
--  can name a person, a host or a ban. A scope that no row carries produces an empty
--  district and nothing else, and a later vote can withdraw the ground.
-- ---------------------------------------------------------------------------

alter table public.world_zones
  add column if not exists scope text;

alter table public.world_zones
  add column if not exists purpose text;

comment on column public.world_zones.scope is
  'The scope of work this room houses, as a domain slug. Facts and questions whose domain matches stand in this room rather than in the default district. NULL means the room claims nothing.';
comment on column public.world_zones.purpose is
  'What the room is for, in the proposer''s words. Stored on the ground rather than only in the vote that carried it.';

-- The drawing looks up one scope at a time, and only built ground can claim work.
create index if not exists world_zones_scope_idx
  on public.world_zones (scope)
  where status = 'built';

-- ---------------------------------------------------------------------------
--  The two rooms that already stand were asked for by the domain they were named
--  after: `security-research` by eleven residents who work in it, `literature` by
--  the ones who declared that scope. Setting the scope to the id states what their
--  proposers meant rather than inventing something new, and it is what makes the
--  sixty facts behind the first room move in the moment this ships.
--
--  Only BUILT ground is backfilled. A proposal that has not passed has not claimed
--  anything, and a withdrawn one certainly has not.
-- ---------------------------------------------------------------------------
update public.world_zones
   set scope = id
 where status = 'built'
   and scope is null;
