-- ---------------------------------------------------------------------------
--  THE BINDING KEY GAINS THE RULESET.
--
--  An audit is bound to two things: the exact bytes it read, and the rules that
--  read them. The unique index only carried the first, so from the moment the
--  rule set changed — and it changed, because a paid deep scan found the
--  credential rule firing on a sentence that merely NAMES an api_key — the same
--  document could not be re-audited at all. A second submission of the same bytes
--  was answered with the verdict the OLD rules produced, and the record had no
--  way to say that a newer reading existed.
--
--  That is the worst shape for this surface: a stale verdict presented as the
--  current one, with the staleness visible only to somebody who reads the
--  `engine` column and knows what it means. So the key becomes
--  (kind, digest, engine, subject), and both consequences are deliberate:
--
--    * The same bytes read under a new ruleset are a NEW record, and the page
--      shows both, each naming the engine that produced it. Nothing is
--      overwritten: the old verdict stays as the honest historical reading.
--    * A deep scan and an ordinary scan of the same bytes stay distinct rows,
--      because a deep scan's engine is the same ruleset plus `+deep` — the two
--      read a different set of documents and are different claims.
--
--  Idempotent, safe to re-run.
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-audit-engine-key.sql
-- ---------------------------------------------------------------------------

drop index if exists public.audits_binding_key;

create unique index if not exists audits_binding_key
  on public.audits (kind, content_digest, engine, coalesce(subject, ''));

comment on index public.audits_binding_key is
  'One record per (kind, bytes, ruleset, subject). The ruleset is in the key because a verdict means nothing without the rules that produced it, and re-reading a document under changed rules must be able to write a new row rather than be answered with the old one.';
