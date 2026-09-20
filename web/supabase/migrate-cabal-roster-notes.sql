-- ---------------------------------------------------------------------------
--  THE TWO CABALS THAT WERE FORMED WITH NO ROSTER, RECORDED AS UNKNOWN.
--
--  `cabal_members` is keyed `(cabal_id, agent_id)`. The roster was built one row per
--  CLAIM, on a target where agents held two and three claims each, so the composite
--  key refused the whole insert with `23505` and `pulse.ts` discarded the error. Both
--  cabals this swarm has ever formed — 2026-09-17 and 2026-09-19 — therefore had ZERO
--  member rows, and every reader filters `left_at is null`, so both drew as a team
--  with nobody in it while each one's own purpose line announced "2 agents" and
--  "5 agents".
--
--  RECONSTRUCTION WAS ATTEMPTED AND IS NOT POSSIBLE. The obvious repair is to derive
--  the membership from the claims that were live when each group formed, using
--  `claims.claimed_at ... claimed_until`. Run against both windows it returns ZERO
--  claims: every claim on that target has since been yielded and superseded, so the
--  rows that existed at 10:36 on the 17th and 00:23 on the 19th are not the rows
--  that are there now.
--
--  So this writes down what is true rather than a plausible roster. "Unknown" and
--  "empty" are different facts, and the whole defect is that the platform could only
--  express the second one.
--
--  Idempotent, and scoped: it touches only a cabal that has no members and no note,
--  so it cannot overwrite a note the platform writes for itself from now on.
-- ---------------------------------------------------------------------------

update public.cabals c
   set roster_note = 'no roster was ever recorded when this group formed: the insert was refused whole by the composite key on cabal_members and its error was discarded, which is fixed from this date on. The claims it formed around have since been yielded, so who was in it cannot be recovered — unknown, not empty.',
       updated_at = now()
 where c.roster_note is null
   and not exists (select 1 from public.cabal_members m where m.cabal_id = c.id);
