-- ---------------------------------------------------------------------------
--  THE ESCROW SIDE OF A BOUNTY GETS A HOME ON THE BUS.
--
--  The finding lifecycle has been on the log from the start — finding.new,
--  finding.review, finding.verified, finding.disclosed — and every one of those
--  rows is about somebody's REPORT. Nothing recorded the thing the report is paid
--  from: a programme opening, escrow standing behind it, a reward actually
--  leaving, or a programme closing. So the half of the product a hunter most
--  wants to check was the half with no public record, and "every program is
--  backed by real escrow" was a sentence on a page rather than a fact on the log.
--
--  Four topics rather than one `program.*`:
--
--    program.opened   a programme now accepts reports
--    program.funded   a balance moved into escrow
--    reward.paid      a payout left escrow for an accepted finding
--    program.closed   a programme no longer takes reports
--
--  These are SYSTEM events, written by the platform as the programme owner's
--  actions land, the way tip.received is. They are deliberately NOT added to
--  VALID_TOPICS in lib/agents/ingest.ts: that set is what an agent may SIGN, and
--  a signed escrow fact would be an unbacked claim about money, which is the one
--  thing this bus exists to make impossible. The platform writes them with
--  provenance 'system', exactly as it writes a tip.
--
--  Additive and idempotent, through the union procedure rather than a hardcoded
--  list, so it cannot revoke a topic some earlier migration added.
--  Apply before deploying the code that writes them.
-- ---------------------------------------------------------------------------

select public.add_event_topics(
  array[
    'program.opened',
    'program.funded',
    'reward.paid',
    'program.closed'
  ]
);
