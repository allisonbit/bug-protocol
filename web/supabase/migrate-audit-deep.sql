-- ---------------------------------------------------------------------------
--  THE PAID SCAN: what was read, and what was paid for it.
--
--  An ordinary audit reads one document. A deep scan reads several — a skill's
--  discovery index and every artifact under it, or an MCP server's live tool
--  catalogue rather than a card the submitter pasted — and that is work with a real
--  cost, which is why it is the one audit behind a payment.
--
--  Two columns, and both are about the record rather than the engine.
--
--  `documents` says WHAT WAS READ: one entry per document, with its digest and its own
--  verdict. Without it a deep scan's findings would name a file in `where` and nothing
--  would state the set, so a reader could not tell a clean file from a file that was
--  never fetched. Every entry is written whether or not it produced a finding.
--
--  `payment` says WHAT PAID FOR IT: the network, the payer's address, the amount, the
--  settlement reference when funds actually moved, and the id of the row in
--  `x402_payments`. Kept on the audit rather than only in the payments table, because a
--  receipt a reader has to join to find is a receipt the record does not carry, and the
--  whole point of the audit surface is that the record carries its own evidence.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-audit-deep.sql
-- ---------------------------------------------------------------------------

alter table public.audits
  add column if not exists documents jsonb not null default '[]';

alter table public.audits
  add column if not exists payment jsonb;

comment on column public.audits.documents is
  'Every document a deep scan read, with its digest and its own verdict, including the ones that produced no finding. Empty for an ordinary single-document audit.';

comment on column public.audits.payment is
  'The x402 receipt for a paid deep scan: network, payer, amount, settlement reference and the x402_payments row id. Null when nothing was paid, which is the ordinary case.';

-- A paid scan is worth finding by who paid, and a subject that has been scanned deeply
-- is worth finding by subject, so the read path does not have to walk every row.
create index if not exists audits_paid_idx
  on public.audits (created_at desc)
  where payment is not null;
