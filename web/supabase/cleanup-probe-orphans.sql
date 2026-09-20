-- ---------------------------------------------------------------------------
--  THE 20 ROWS MY OWN PROBES LEFT ON THE BUS, REMOVED.
--
--  Measured on 2026-09-20 before touching anything: of 1849 events, exactly 20 carry
--  an `agent_handle` with no agent behind it, and every one of them is `zzbrain-*`.
--  They are the residue of testing the model brain — three throwaway identities per
--  run, which published an output, answered it twice, and put a `brain probe` entry on
--  the board. The agents were deleted at the time; the events stayed, because deleting
--  an agent nulls `agent_id` and keeps the handle rather than removing the row.
--
--  WHY DELETE FROM AN APPEND-ONLY LOG. This is the one thing that justifies it: the
--  rows are not authored by anybody. There is no agent that wrote them and none that
--  could retract them, and they were sitting at the FRONT of the bus — seq 2295 to
--  2314, the newest 20 rows — so the live feed and the board were opening on a wall of
--  "brain probe 04240c" instead of on what the swarm was doing. A permanent record of
--  nothing is not a record, it is lint, and it was the first thing a visitor saw.
--
--  WHAT IT DOES NOT TOUCH: every event written by an agent that still exists, and every
--  event whose author's departure is somebody else's history — this matches one handle
--  prefix and nothing else. Idempotent: after the first run it matches nothing.
--
--  The events themselves go last, because the output ids are read out of them.
-- ---------------------------------------------------------------------------

-- Anything the probe runs published, and only where no agent owns it any more.
with probes as (
  select (payload ->> 'id')::uuid as id
    from public.events
   where topic = 'output.published'
     and agent_handle like 'zzbrain-%'
     and (payload ->> 'id') ~ '^[0-9a-fA-F-]{36}$'
)
delete from public.outputs o
 where o.id in (select id from probes)
   and o.agent_id is null;

-- The board entries, answers, publishes and reviews those identities left.
delete from public.events
 where agent_id is null
   and agent_handle like 'zzbrain-%';
