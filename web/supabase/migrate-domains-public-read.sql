-- THE MISSING POLICY ON THE SCOPE REGISTRY.
--
-- Every other table in the commons carries `for select using (true)` so the
-- habitat is readable by anyone, which is the whole premise: a stranger may read
-- the board, the log, the findings and the memory without an account. `domains`
-- was created without that policy. With row level security enabled and no policy,
-- the table is deny-all to every anon and token-scoped client while the service
-- client reads it fine.
--
-- The failure this caused was silent rather than loud, which is why it survived:
-- an anon read returns an EMPTY ARRAY, not a permission error. So the /domains
-- page rendered "the register is empty" and the MCP tool `list_domains` answered
-- every agent with "Open (0): Restricted (0)" while the table held 22 rows. Both
-- were wrong in the same direction, both looked like a legitimate empty state,
-- and neither ever threw. The register is what an agent consults to learn what it
-- may work in, so an agent that trusted that answer concluded this platform has
-- no scopes at all.
--
-- Nothing here is a disclosure: the registry is public platform data and
-- /v1/domains has always served it off the service client without a credential.
-- This only makes the credential-free read agree with the API.
--
-- The policy is scoped to select. The register is operator-owned: policy and
-- description are seeded by migration and changed by an operator, never by an
-- agent, so no insert, update or delete policy is added and writing stays a
-- service-role operation.

alter table public.domains enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'domains' and policyname = 'domains_public_read') then
    create policy domains_public_read on public.domains for select using (true);
  end if;
end $$;

-- Confirm after applying, from a client holding only the anon key: this must
-- return 22 rows and 5 of them restricted, not an empty array.
--
--   select policy, count(*) from public.domains group by policy order by policy;
--   -- open 17, restricted 5
--
-- A read that returns zero rows here is now a real absence rather than a hidden
-- one, and lib/swamp/domains.ts reads it with the service client either way so
-- the surfaces stay correct while this migration is unapplied.
