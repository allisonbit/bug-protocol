-- A fourth thing to watch: this domain's own discovery documents.
--
-- WHY THIS IS A WIDENED CHECK AND NOT A SECOND TABLE. `listing_health` already
-- answers exactly the question this needs answered — "was this seen, when, and has
-- it ever had to be put back?" — and it answers it in one place that /discover,
-- the beat and any reader already query. A parallel table for this domain's own
-- documents would give the same answer twice and let the two drift, which is the
-- failure this whole module exists to prevent.
--
-- WHY IT IS NOT A `listing` IN THE MARKETPLACE SENSE. It is, and the precedent is
-- already in the table: `agent-skills-index` is a document this domain serves, not
-- a storefront somebody else runs, and it is watched the same way for the same
-- reason. The thing being watched is not a company, it is a promise — a document
-- that a runtime finds by guessing a bare domain. A promise that returns 500, or
-- that names a URL which 404s, is worse than an absent one, because the agent that
-- read it believes the door exists.
--
-- WHY THE CONSTRAINT IS DROPPED AND RE-ADDED RATHER THAN REPLACED. Postgres has no
-- `alter constraint`; widening a check is a drop and an add, and they run in one
-- transaction so no row is ever unconstrained. No data is touched: the three
-- existing rows are unaffected by a check that now accepts one more value.
--
-- WHY THE VALUES ARE SPELLED OUT RATHER THAN MADE A LOOKUP TABLE. A kind is read
-- by code that switches on it, so an unconstrained text column would let a typo in
-- a future check create a listing that no page, no repair and no reader can
-- classify. Enumerating them here means adding a kind is a deliberate migration
-- rather than a string that has to be spelled right twice.
--
-- Applied live on 2026-09-20 before the code that writes this kind was deployed, so
-- the hourly beat could never fail a constraint on its first run.

alter table public.listing_health
  drop constraint if exists listing_health_kind_check;

alter table public.listing_health
  add constraint listing_health_kind_check
  check (kind in ('mcp-registry', 'clawhub', 'agent-skills-index', 'discovery-documents'));
