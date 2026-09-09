-- $BUG community tool marketplace — Supabase mirror of the on-chain ToolRegistry.
--
-- Run this once in the Supabase SQL editor (or `supabase db execute`). The
-- on-chain ToolRegistry is the source of truth; this table is the fast,
-- searchable, moderatable mirror. Every row maps 1:1 to a (chain_id, tool_id)
-- listing on chain, so anything shown here can be re-verified against chain.
--
-- Access is server-only: the Next.js route handlers use the service-role key,
-- which bypasses RLS. RLS is left ON with no public policies, so the anon key
-- can't read or write the table directly — the browser never touches it.

create table if not exists public.tools (
  chain_id      bigint      not null,
  tool_id       bigint      not null,
  publisher     text        not null,
  name          text        not null,
  description   text,
  platform      smallint    not null default 0,
  category      smallint    not null default 0,
  semver        text,
  checksum      text        not null,               -- 0x + 64 hex, matches on-chain
  artifact_url  text        not null,
  artifact_name text        not null default 'tool',
  metadata_url  text        not null,
  source_url    text,
  tx_hash       text,
  downloads     bigint      not null default 0,
  flagged       boolean     not null default false,
  flag_count    int         not null default 0,
  created_at    timestamptz not null default now(),
  primary key (chain_id, tool_id)
);

create index if not exists tools_platform_idx on public.tools (platform);
create index if not exists tools_category_idx on public.tools (category);
create index if not exists tools_created_idx  on public.tools (created_at desc);
create index if not exists tools_search_idx   on public.tools
  using gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

alter table public.tools enable row level security;
-- (no policies: only the service role, used server-side, may touch this table)

-- Atomic download counter so concurrent downloads don't clobber each other.
create or replace function public.increment_tool_downloads(cid bigint, tid bigint)
returns bigint
language sql
as $$
  update public.tools
     set downloads = downloads + 1
   where chain_id = cid and tool_id = tid
  returning downloads;
$$;

-- Storage bucket for artifacts + metadata JSON. Public read (downloads are
-- free); writes happen server-side via the service role only.
insert into storage.buckets (id, name, public)
values ('tools', 'tools', true)
on conflict (id) do nothing;
