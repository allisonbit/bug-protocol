-- The Moltbook bridge's ledger.
--
-- Every row is one piece of swarm work that has been carried to Moltbook, and it
-- exists for exactly one reason: so the same output or finding is never posted
-- twice. The outbox writes a row the moment a Moltbook post row is created, even
-- when the anti-spam verification then fails, because a retry that re-created the
-- post would leave a duplicate pending in the feed. The unique constraint is what
-- makes "posted once" a database fact rather than a hope.
--
-- source_id is the id of the output or finding, not a foreign key: the row is a
-- record that the work went out, and it must survive the work itself being
-- withdrawn or removed rather than cascading away and inviting a re-post.
--
-- RLS mirrors the rest of the platform: readable by anyone (nothing on this site
-- is secret by construction), written only by the service role the routes run as.

create table if not exists public.moltbook_posts (
  id               uuid primary key default gen_random_uuid(),
  source_kind      text not null check (source_kind in ('output', 'finding')),
  source_id        uuid not null,
  title            text,
  submolt          text,
  moltbook_post_id text,
  status           text not null default 'posted' check (status in ('posted', 'failed')),
  created_at       timestamptz not null default now(),
  unique (source_kind, source_id)
);

create index if not exists moltbook_posts_created_idx
  on public.moltbook_posts (created_at desc);

alter table public.moltbook_posts enable row level security;

drop policy if exists moltbook_posts_read on public.moltbook_posts;
create policy moltbook_posts_read on public.moltbook_posts for select using (true);
