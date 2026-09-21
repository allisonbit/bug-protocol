-- ---------------------------------------------------------------------------
--  MCP 2026-07-28, IDENTITY BINDING, AND x402 SETTLEMENT
--
--  Three things this revision of the platform needs from the database, in one
--  idempotent file, because two of them are gates rather than conveniences.
--
--  Apply with:
--    PGPASSWORD=... node scripts/apply-migration.cjs supabase/migrate-mcp-2026.sql
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
--  1. THE BUS TOPICS. Through the widening procedure, never a fresh list.
--
--  a2a.task.cancelled  a delegated task stopped before it finished, which is a
--                      fact a delegator has to be able to read rather than infer
--                      from a state column.
--  a2a.task.input      a caller answered a question about a task. The exchange is
--                      the record, so it goes on the bus like the rest.
--  x402.payment        money moved, or a payment proof was refused. Both belong
--                      in public: a payment door whose refusals were silent would
--                      be the one surface here nobody could audit.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.add_event_topics(text[])') is null then
    raise exception 'public.add_event_topics does not exist; apply migrate-event-topics-union.sql first';
  end if;
end $$;

select public.add_event_topics(
  array[
    'a2a.task.cancelled', 'a2a.task.input', 'x402.payment'
  ]
);

-- ---------------------------------------------------------------------------
--  2. THE BINDING: which key sent this task, not just which token.
--
--  A2A binds identity at the agent card and nowhere else, so a delegated task
--  arrives attributed to whoever holds the credential and carries no proof of
--  which key actually composed it. That is the gap a September 2026 analysis of
--  the protocol (A2ABreak) describes, and the fix is small: let a caller sign the
--  task itself, verify that signature against the public key the registry already
--  holds for them, and record the result AS A RESULT, not as a claim.
--
--  Null means unsigned, which is honest and remains allowed: delegation from
--  outside has always worked without an account and still does. `verified: false`
--  means a signature was offered and did not check out, which a reader should be
--  able to see instead of it looking like no signature at all.
-- ---------------------------------------------------------------------------

alter table public.a2a_tasks
  add column if not exists binding jsonb;

comment on column public.a2a_tasks.binding is
  'How the task was proven to come from its caller: the key id, the signature, and whether it verified against the registered public key. Null when the caller did not sign, which is allowed and recorded as such rather than as a failure.';

-- ---------------------------------------------------------------------------
--  3. x402 PAYMENTS.
--
--  Every accepted or refused payment proof, public, with the nonce UNIQUE per
--  network. That uniqueness is the security property, not bookkeeping: an
--  EIP-3009 authorization is valid until its window closes, so without a spent
--  marker the same signed proof could be presented twice and buy two things.
--  The database refusing the second insert is what makes replay impossible
--  rather than merely unlikely, and it cannot be bypassed by a code path that
--  forgot to check an application-level cache.
-- ---------------------------------------------------------------------------

create table if not exists public.x402_payments (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid references public.a2a_tasks (id) on delete set null,
  -- Who paid, in whatever identity the scheme carries. For `exact` this is the
  -- EIP-3009 authorizer.
  payer          text,
  pay_to         text not null,
  asset          text not null,
  network        text not null,
  amount         text not null,
  scheme         text not null default 'exact',
  -- The authorization's nonce. Unique per network, which is what stops a proof
  -- being spent twice.
  nonce          text not null,
  signature      text not null,
  -- verified: the proof checked out against the payer's own signature.
  -- settled:  the facilitator confirmed value moved.
  -- refused:  the proof did not check out, and why is in note.
  status         text not null default 'verified' check (status in ('verified', 'settled', 'refused')),
  settlement_ref text,
  note           text,
  raw            jsonb,
  created_at     timestamptz not null default now()
);

create unique index if not exists x402_payments_nonce_key
  on public.x402_payments (network, nonce);
create index if not exists x402_payments_task_idx
  on public.x402_payments (task_id, created_at desc);

alter table public.x402_payments enable row level security;
drop policy if exists x402_payments_read on public.x402_payments;
create policy x402_payments_read on public.x402_payments for select using (true);

comment on table public.x402_payments is
  'Payment proofs presented to this deployment, accepted or refused, with the nonce unique per network so a signed authorization cannot be spent twice. Public read, like every other record here: a payment nobody can audit is worse than no payment at all.';
comment on column public.x402_payments.signature is
  'The EIP-3009 authorization signature exactly as presented. Recorded so a reader can re-verify the settlement themselves rather than trusting this platform''s verdict.';
