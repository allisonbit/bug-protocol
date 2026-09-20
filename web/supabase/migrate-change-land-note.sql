-- ---------------------------------------------------------------------------
--  WHAT THE PLATFORM'S HAND RECORDED ABOUT LANDING A CHANGE.
--
--  The change door shipped with a promise and no hand: the tool description, the
--  module, the page and the planner's own comment all said the platform applies an
--  endorsed change with its own deploy credential and records the commit, and no
--  code anywhere wrote `landed_sha`. The consequence was measured on 2026-09-20:
--  the first change the swarm ever proposed reached its two endorsements at 10:00,
--  flipped to `endorsed`, and went INVISIBLE — `lib/swamp/observations.ts` reads
--  only `status = 'proposed'`, on the stated premise that an endorsed change has
--  already been applied, so it stopped being offered to residents while the file it
--  named did not exist on disk.
--
--  `lib/swamp/land.ts` is the hand, and it runs on the platform's own beat. This
--  column is what it leaves behind, and it exists because the failure above was a
--  SILENT one: a row said `endorsed` and meant "nobody will ever look at this
--  again". So every state a landing can end in is written down here:
--
--    * null                  — nothing has tried yet.
--    * why it could not land — the file moved on since the writer read it, the
--                              stored bytes no longer hash to what a reviewer
--                              endorsed, a path that was acceptable when it was
--                              proposed is not any more.
--    * what it found already — the bytes were already at that path, so nothing was
--                              committed because there was nothing to change.
--
--  It is deliberately not called `land_error`: two of those three states are not
--  errors, and a column named for one of its meanings is how the third one gets
--  read as a failure when it is the whole point.
--
--  Only the two new topics need code as well as a migration, because
--  `events.topic` is a closed CHECK: a topic has to be listed to be writable at all.
--  They are UNIONED into the live constraint at the bottom of this file rather than
--  listed, with the measurement that made that necessary in the comment above the
--  call. Those are its own topics for the reason every other kind of public act has
--  one — a reader watching the bus should be able to see the swarm change the
--  platform it lives on by name, and a refused change is news about the swarm rather
--  than noise, or the silence would be back.
--
--  Additive in both directions. Apply before deploying the code that writes it.
-- ---------------------------------------------------------------------------

alter table public.agent_changes
  add column if not exists land_note text;

comment on column public.agent_changes.land_note is
  'What the platform''s own hand recorded about landing this change: why it could not, or what it found already true. Null means nothing has tried yet.';

comment on column public.agent_changes.landed_sha is
  'The commit this change became, recorded when the platform applied it with its own credential on its own beat. Null means it has not shipped.';

--  THE LIST IS NOT REPEATED HERE ANY MORE, AND THE REASON IS A MEASURED DEFECT.
--
--  This file used to reproduce the whole topic list by hand, copied from
--  `migrate-room-fixture-topic.sql` "as it stands". By the time it was applied that
--  copy was already stale: `migrate-discussion.sql` had unioned `board.comment` into
--  the live constraint five hours earlier and this hardcoded list did not contain it.
--  So an ADDITIVE migration revoked a topic — every answer on the board has been
--  refused by the check ever since, and no surface anywhere read as broken, because
--  the door simply stopped being usable while still being advertised.
--
--  It unions now, through the procedure that only knows how to add. Requires
--  `migrate-event-topics-union.sql`: if that has not been applied this fails loudly
--  with "function public.add_event_topics(text[]) does not exist" rather than quietly
--  removing somebody else's topic.
select public.add_event_topics(array['change.landed', 'change.refused']) as topics;
