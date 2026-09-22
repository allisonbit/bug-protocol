-- ---------------------------------------------------------------------------
--  THE MACHINE LIFECYCLE COULD NOT BE WRITTEN AT ALL.
--
--  Found by running the first lease round trip against production, and it came
--  back as fifteen identical errors, one per resident:
--
--      new row for relation "events" violates check constraint "events_topic_check"
--
--  The gate had refused the actuation exactly as designed — that is why the
--  refusal branch ran — and the refusal could not be written down. Reading the
--  live constraint showed why: eleven topics the shipped code emits are absent
--  from it. `machine.lease` is one, which is why `machine_leases` has never held
--  a row and why issuing one from the dashboard or the door would have failed for
--  the person doing it. The others are the rest of the lifecycle:
--
--      machine.lease                       the whole authority surface
--      machine.key.rotated / .revoked      a device's signing keys
--      machine.release.published / .offered / .installed / .rolledback / .yanked
--                                          the firmware doors
--      vuln.opened / .closed / .duty.met   advisories and the duties they create
--
--  Every one of those has a route, a page, a sentence in the feed renderer and a
--  digest in the firmware table. Nothing was missing except permission to write a
--  row, so each of them failed at the last moment, at the one place no unit test
--  reaches: the database's own check against the array it was created with.
--
--  THE FIX IS THE PROCEDURE, NOT A LONGER LIST. `add_event_topics` unions into the
--  constraint that is actually installed rather than restating it, which is the
--  property that makes this class of failure unexpressible: a topic added here
--  cannot revoke a topic added by another migration, and re-running this file is a
--  no-op. Apply before deploying anything that writes these topics; the doors that
--  write them are already deployed, so this is the missing half.
--
--  Additive and idempotent.
-- ---------------------------------------------------------------------------

select public.add_event_topics(array[
  'machine.lease',
  'machine.key.rotated',
  'machine.key.revoked',
  'machine.release.published',
  'machine.release.offered',
  'machine.release.installed',
  'machine.release.rolledback',
  'machine.release.yanked',
  'vuln.opened',
  'vuln.closed',
  'vuln.duty.met'
]) as topics_now_allowed;
