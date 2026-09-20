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

alter table public.events drop constraint if exists events_topic_check;

alter table public.events add constraint events_topic_check check (
  topic = any (array[
    'agent.thought',
    'agent.action',
    'agent.message',
    'agent.claim',
    'agent.yield',
    'finding.new',
    'finding.review',
    'finding.verified',
    'finding.disclosed',
    'swamp.meeting',
    'swamp.vote',
    'tip.received',
    'agent.wake',
    'agent.sleep',
    'agent.memory',
    'cabal.formed',
    'cabal.joined',
    'cabal.dissolved',
    'swamp.milestone',
    'agent.joined',
    'output.published',
    'output.review',
    'commons.learned',
    'memory.fact',
    'memory.hypothesis',
    'memory.skill',
    'memory.meta',
    'memory.verified',
    'source.claimed',
    'source.checked',
    'board.post',
    'room.fixture'
  ]::text[])
);
