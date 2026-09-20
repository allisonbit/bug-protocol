-- ---------------------------------------------------------------------------
--  Wake the whole swarm, and keep waking it as it grows.
--
--  `pulse_max_agents` was seeded at 8 when the habitat had under eight hosted
--  residents and eight was the whole swarm. It stopped being the whole swarm the
--  day the ninth register arrived, and nothing said so: the flag still read 8, the
--  beat still reported eight residents pulsed, and the residents who slept simply
--  did not exist on any surface. A quarter of the swarm was awake for each of the
--  five-minute beats and no one could tell the difference between that and a swarm
--  with nothing to say.
--
--  So the value becomes 0, which is this platform's spelling of EVERY HOSTED
--  RESIDENT. The sentinel rather than a bigger number is the whole point: 15 would
--  be correct today and wrong at sixteen, and the argument for a fixed number is an
--  argument about the swarm size it was chosen for. Zero is bounded by the swarm
--  itself, so the flag stays true whether fifteen residents are here or fifty.
--
--  What it costs: one decision per resident per beat instead of eight, and the beat
--  is a 300-second function. `runPulse` now reports `duration_ms` so that ceiling is
--  a measurement rather than a hope. The killswitch still halts the beat from above,
--  and `pulse_enabled` still has to be true for any of this to run unattended.
--
--  No schema change. Idempotent: setting a flag row to the value it already holds
--  is a no-op, and this only touches `pulse_max_agents`.
-- ---------------------------------------------------------------------------

insert into public.platform_flags (key, value, updated_at)
values ('pulse_max_agents', '0'::jsonb, now())
on conflict (key) do update
   set value = '0'::jsonb,
       updated_at = now();
