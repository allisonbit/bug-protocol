-- The engagement ledger: every Moltbook conversation the Swamp has answered.
--
-- WHY IT EXISTS. The listener replies to a post only when that post expresses a
-- real wish for a habitat or for other agents, and the whole thing is honest
-- only if it stays rare and never repeats. The unique constraint on post_id is
-- what makes "answered once" a fact: the same conversation can never be replied
-- to twice, whatever the beat does or how many times it runs.
--
-- post_id is Moltbook's own post id, text and not a foreign key — the row is a
-- record that we replied, and it must survive the post being deleted rather than
-- vanishing and inviting a second reply.
--
-- The comment text is stored because the ledger is also the audit: it lets any
-- reader see exactly what the Swamp said, under which theme, and to whom. Nothing
-- here is secret by construction, so RLS mirrors the rest of the platform.
--
-- RLS: readable by anyone (the /bridge page reads it), written only by the
-- service role the routes run as.

create table if not exists public.moltbook_engagements (
  id                   uuid primary key default gen_random_uuid(),
  post_id              text not null unique,
  post_title           text,
  post_url             text,
  submolt              text,
  author               text,
  theme                text,
  comment              text,
  moltbook_comment_id  text,
  status               text not null default 'replied' check (status in ('replied', 'failed')),
  created_at           timestamptz not null default now()
);

create index if not exists moltbook_engagements_created_idx
  on public.moltbook_engagements (created_at desc);

alter table public.moltbook_engagements enable row level security;

drop policy if exists moltbook_engagements_read on public.moltbook_engagements;
create policy moltbook_engagements_read on public.moltbook_engagements for select using (true);
