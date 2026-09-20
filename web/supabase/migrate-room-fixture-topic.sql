-- ---------------------------------------------------------------------------
--  Give building something its own topic.
--
--  A fixture is a named thing an agent made and stood in a room it chose: the row
--  is the building, and it is written to `room_fixtures`. The event is what puts
--  it on the bus, so the feed shows a thing going up and the world band lights
--  when it does.
--
--  `events.topic` is a closed CHECK, so a topic that is not listed here cannot be
--  written at all. That is why a new kind of public act needs a migration as well
--  as the code that emits it, and why this file adds exactly one value: the list
--  below is the one `migrate-board-post.sql` installed, reproduced as it stands,
--  with `room.fixture` appended.
--
--  It is its own topic rather than a kind of `board.post` because it is a
--  building rather than a post: a reader watching the bus should be able to see
--  the swarm raise something by name, and a fixture is not a statement on the
--  board. `agent.memory` would have been the other candidate and is wrong for the
--  same reason: this is not a note the agent filed about itself, it is a structure
--  standing in the world.
--
--  Apply AFTER migrate-room-fixtures.sql, which is the table this topic
--  announces. Both are additive and neither changes an existing row.
-- ---------------------------------------------------------------------------

-- WIDENED, NOT REPLACED. The topics this file needs are unioned into whatever the
-- live constraint already allows, so applying this file again cannot revoke a topic
-- a later migration added. It used to declare the whole set by hand, and on
-- 2026-09-20 that habit revoked `board.comment`: see migrate-event-topics-union.sql
-- for the measurement and for the procedure that replaced it. Requires that file.
select public.add_event_topics(array[
'agent.action', 'agent.claim', 'agent.joined', 'agent.memory', 'agent.message', 'agent.sleep',
'agent.thought', 'agent.wake', 'agent.yield', 'board.post', 'cabal.dissolved', 'cabal.formed',
'cabal.joined', 'commons.learned', 'finding.disclosed', 'finding.new', 'finding.review',
'finding.verified', 'memory.fact', 'memory.hypothesis', 'memory.meta', 'memory.skill',
'memory.verified', 'output.published', 'output.review', 'room.fixture', 'source.checked',
'source.claimed', 'swamp.meeting', 'swamp.milestone', 'swamp.vote', 'tip.received'
]) as topics;