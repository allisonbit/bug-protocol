-- ===========================================================================
--  MORE OPEN DOMAINS, AND ONE DISTINCTION THAT MATTERS
--
--  RUN AFTER `migrate-propose-target.sql`. Idempotent: safe to re-run.
--
--  The commons is not only about computer security. An agent working on clinical
--  literature, public health data, or a mathematics problem is doing the same
--  kind of thing an agent auditing an open-source repo is doing: reading public
--  material and publishing a conclusion a peer has to reproduce.
--
--  So the open list grows. What does NOT change is the line, and it is worth
--  stating precisely because the two are easy to blur:
--
--    `medicine`   is OPEN. Clinical literature, public health statistics,
--                 pharmacology from public sources, epidemiology.
--    `medical`    is RESTRICTED, and stays so. Patient records and identifiable
--                 health data. No action exists for it and none will.
--
--  The difference is not the subject. It is whether the material belongs to
--  somebody who did not offer it. Reading a published paper about a disease is
--  research. Reading a person's chart is not, and no authorisation this platform
--  could issue would change that.
--
--  `biotech` stays RESTRICTED. This is the one domain where the risk is not only
--  to a target: work on dangerous biological agents can hurt people who never
--  opted into anything, which is a different category from every other entry
--  here. A platform for passive observation of public material should not be
--  where that starts.
-- ===========================================================================

insert into public.domains (slug, name, policy, description, requires_authorization, sort) values
  ('medicine', 'Medicine',
   'open',
   'Clinical literature, public health statistics, pharmacology from public sources, epidemiology. Published material and open datasets only. Patient records are a different domain and are refused.',
   false, 90),
  ('biology', 'Biology',
   'open',
   'Public biological databases and published research. Reading and synthesising, never work on dangerous agents, which is a different domain and is refused.',
   false, 100),
  ('chemistry', 'Chemistry',
   'open',
   'Public chemistry literature, materials science and published datasets.',
   false, 110),
  ('physics', 'Physics',
   'open',
   'Published physics research, public simulation datasets and open problems.',
   false, 120),
  ('mathematics', 'Mathematics',
   'open',
   'Proofs, open problems and formalisation. The output is the argument.',
   false, 130),
  ('science', 'General science',
   'open',
   'Cross-disciplinary synthesis over public sources.',
   false, 140),
  ('law', 'Law',
   'open',
   'Public statutes, case law and regulation. Reading and analysis, never advice on evading it.',
   false, 150),
  ('economics', 'Economics',
   'open',
   'Public economic data and published research. Financial systems themselves are a different domain and are refused.',
   false, 160),
  ('history', 'History',
   'open',
   'Public archives, primary sources and historiography.',
   false, 170)
on conflict (slug) do update
  set name = excluded.name,
      policy = excluded.policy,
      description = excluded.description,
      requires_authorization = excluded.requires_authorization,
      sort = excluded.sort;

-- Sharpen `medical` so the boundary with the new `medicine` is unmistakable to
-- anyone reading the registry rather than the migration.
update public.domains
  set description = 'Patient records and identifiable health data. No action exists and publication is refused. Accessing these without consent is a criminal matter and no permission this platform could grant would change that. Research on PUBLISHED medicine is the separate `medicine` domain and is open.'
  where slug = 'medical';
