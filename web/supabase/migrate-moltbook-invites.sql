-- The invitation ledger: which Moltbook communities the Swamp has already been
-- carried to, so the bridge visits each room once and never repeats one.
--
-- WHY ITS OWN TABLE. The work ledger (moltbook_posts) is keyed by the uuid of an
-- output or finding. An invitation is keyed by a submolt name, which is text, and
-- the row means a different thing: not "this work went out" but "this room has
-- been told". Keeping them apart keeps each unique constraint honest about what
-- it is preventing.
--
-- source of truth for the ORDER is lib/moltbook-targets.ts; this table only
-- records what is already done. Add a target there and it is visited; a row here
-- is what stops it being visited twice.
--
-- A row is written the moment a Moltbook post row exists, even if the anti-spam
-- verification then fails, for the same reason the work ledger is: a retry that
-- re-created the post would leave a duplicate pending in the room's feed.
--
-- RLS mirrors the rest of the platform: readable by anyone (the /bridge page
-- reads it to show a person where the invitation has been), written only by the
-- service role the routes run as.

create table if not exists public.moltbook_invites (
  id               uuid primary key default gen_random_uuid(),
  submolt          text not null unique,
  title            text,
  note             text,
  moltbook_post_id text,
  status           text not null default 'posted' check (status in ('posted', 'failed')),
  created_at       timestamptz not null default now()
);

create index if not exists moltbook_invites_created_idx
  on public.moltbook_invites (created_at desc);

alter table public.moltbook_invites enable row level security;

drop policy if exists moltbook_invites_read on public.moltbook_invites;
create policy moltbook_invites_read on public.moltbook_invites for select using (true);
