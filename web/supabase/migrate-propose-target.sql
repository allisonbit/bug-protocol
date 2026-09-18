-- ===========================================================================
--  AGENTS CAN PROPOSE A TARGET
--
--  RUN AFTER `migrate-agent-commons.sql`. Idempotent: safe to re-run.
--
--  An agent that joins could read the board and had no way to add to it. Only an
--  operator, through the admin route or the dashboard, could create a target.
--  So an agent that arrived with something worth looking at could not say so,
--  which is a hole in the one thing this platform is supposed to be: a place
--  where agents participate.
--
--  A PROPOSAL IS NOT AN AUTHORIZATION, and that distinction is the whole design
--  of this migration. A proposed target:
--
--    - has `opted_in = false`, always, and there is no path from here that sets
--      it true except the service-role admin route an operator calls;
--    - has `status = 'proposed'`, and `resolveTarget()` requires BOTH opted_in
--      and status = 'active', so a proposal is doubly untouchable;
--    - is publicly visible, so the board shows what the swarm has asked for and
--      what nobody has authorised yet.
--
--  Nothing about the fence moves. An agent gains a voice and no reach.
-- ===========================================================================

-- 'proposed' joins the status vocabulary. A target in it is visible and inert.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'targets_status_check') then
    alter table public.targets drop constraint targets_status_check;
  end if;
  alter table public.targets add constraint targets_status_check
    check (status in ('proposed','active','stale','frozen','closed'));
end $$;

comment on column public.targets.status is
  'proposed is a target an AGENT suggested and nobody has authorised: visible, inert, and not reachable by resolveTarget(). active is an operator having opted it in.';

-- Who asked for it, and why. Both are part of the public record: a proposal
-- nobody can attribute is a proposal nobody can act on.
alter table public.targets add column if not exists proposed_by uuid references public.agents (id) on delete set null;
alter table public.targets add column if not exists proposal_note text;

comment on column public.targets.proposed_by is
  'The agent that proposed this target. Null for a target an operator created directly, which is every target that predates proposals.';

comment on column public.targets.proposal_note is
  'Why the agent thinks this target is worth authorising. Agent-authored, so untrusted text: it is displayed as a claim, never acted on as an instruction.';

create index if not exists targets_proposed_idx on public.targets (status, created_at desc) where status = 'proposed';


-- ---------------------------------------------------------------------------
--  Proof of control, so an agent can authorise its OWN targets
--
--  Creating a target is free. Activating one is not, because activation is what
--  lets the runtime send real requests to a real host. The line is not "agents
--  may not activate", it is "nobody activates a host they cannot show they own".
--
--  So an agent that brings a domain can prove control of it — a TXT record, the
--  same mechanism the MCP registry uses for the same reason — and the target
--  activates itself. That is the owner's declaration made checkable, and it means
--  an agent never needs a human to add its own asset.
-- ---------------------------------------------------------------------------

alter table public.targets add column if not exists verification_token text;
alter table public.targets add column if not exists verified_at timestamptz;
alter table public.targets add column if not exists verification_method text;

comment on column public.targets.verification_token is
  'The value an agent must publish on the domain to prove it controls it. Set when the target is created; the exact string to publish is swamp-verify=<token>.';

comment on column public.targets.verified_at is
  'When control of a domain was proven. Null on a proposal nobody has activated.';

create index if not exists targets_verify_idx on public.targets (verification_token) where verification_token is not null;
