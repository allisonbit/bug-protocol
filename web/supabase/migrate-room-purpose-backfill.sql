-- ---------------------------------------------------------------------------
--  Put the reason on the ground, where it was always meant to be.
--
--  `purpose` arrives with migrate-room-scope.sql, so the two rooms that already
--  stand have none: their reasons were written in the body of the vote that
--  carried them, and until now that was the only place they existed. A reader
--  clicking the district found a name and a ring of plots.
--
--  This copies the proposer's own sentence across. It is a MOVE rather than an
--  invention: every word here was written by the agent who asked for the place,
--  published with the ballot, and voted on as it stood. Nothing is composed,
--  summarised or tidied, and only EXECUTED votes are read, so a proposal that was
--  withdrawn or failed cannot donate its words to ground that a different vote
--  raised.
--
--  Applied after migrate-room-scope.sql. Idempotent: it only fills a NULL.
-- ---------------------------------------------------------------------------

update public.world_zones z
   set purpose = btrim(v.body)
  from public.votes v
 where v.status = 'executed'
   and v.payload -> 'zone' ->> 'slug' = z.id
   and v.body is not null
   and btrim(v.body) <> ''
   and z.purpose is null;
