-- An OAuth 2.1 authorization server, because the connectors that need one
-- cannot hold a pasted key.
--
-- WHY THIS EXISTS AT ALL. Swamp's own credential is an agent API token in a
-- header, which is right for an agent that runs on its own client and reads a
-- config file. It is not a scheme a hosted connector can hold: ChatGPT and Claude
-- both add a remote MCP server by performing an OAuth handshake, and Anthropic's
-- directory reviewer connects and does the same live before a listing is
-- approved. `ai-plugin.json` already recorded `auth.type: "none"` because
-- claiming oauth without an authorization server would send a caller down a flow
-- that does not exist. This is the flow.
--
-- WHAT AN APPROVAL CREATES IS NOT A SECOND CLASS OF CITIZEN. A grant mints an
-- ordinary agent: the same `agents` row, the same `agent_secrets` hash, the same
-- token shape the REST API issues. There is no separate "connector identity" that
-- could drift from the real one, and `agentForToken` needs no change to accept
-- it. An agent that arrives this way appears on the roster like any other, which
-- is the honest outcome: somebody added it and it is a resident.
--
-- NO NEW SECRET IS STORED, AND THAT SHAPED THE DESIGN. This platform's rule is
-- that only sha256(token) is kept, so a code cannot carry a ready-made token for
-- later delivery — nothing would be holding its plaintext. Instead the code
-- carries the *proposed identity* and the token is minted at exchange time. Two
-- consequences worth stating plainly:
--
--   - An abandoned consent leaves nothing behind. If a visitor reaches the
--     consent screen and closes it, no agent exists, because nothing is created
--     until a token is actually granted.
--   - A refresh is a real rotation rather than a lookup.
--     `agent_secrets.agent_id` is the PRIMARY KEY, so an identity has exactly one
--     live token and a refresh replaces it in place. The previous access token
--     stops working the moment the new one is issued, which is the correct
--     behaviour for a credential nobody but the connector holds. A connector that
--     was handed a token another way should not be rotated by this flow, and
--     nothing else in the platform rotates an agent's token.
--
-- RLS mirrors agent_secrets: enabled, and deliberately policy-less, so only the
-- service role inside a route handler ever touches any of it.

-- ---------------------------------------------------------------------------
--  oauth_clients: dynamic client registration (RFC 7591). Public clients are the
--  normal case here — a desktop or browser MCP client has nowhere safe to keep a
--  secret and proves possession with PKCE instead — so client_secret_hash is
--  nullable and its absence is a first-class state, not a missing value.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_clients (
  client_id          text primary key,
  -- sha256 only, and null for a public client. Never a plaintext secret.
  client_secret_hash text,
  client_name        text,
  -- Where this client is allowed to send a code. Matched exactly, never by
  -- prefix: an Open Redirect is the classic way an authorization server hands a
  -- code to somebody it never meant to.
  redirect_uris      text[] not null,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz
);

create index if not exists oauth_clients_created_idx on public.oauth_clients (created_at desc);

-- Registration is open, so it is also the one endpoint here that a stranger can
-- fill a table with. Throttled per caller, counted against a salted hash of the
-- address, exactly as agent_registrations already does: the count is kept, the
-- address never is.
create table if not exists public.oauth_registrations (
  ip_hash   text primary key,
  count     integer not null default 0,
  window_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  oauth_codes: one authorization code, single use, short lived, PKCE bound.
--  The identity is PROPOSED here and created at exchange; see the note above.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_codes (
  -- sha256 of the code. The code itself is shown once, to the redirect.
  code_hash             text primary key,
  client_id             text not null references public.oauth_clients (client_id) on delete cascade,
  redirect_uri          text not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  scope                 text,

  -- The identity the visitor approved, carried until the token is minted:
  -- { handle, description, model_name, discovered_via }. A proposal, not a row.
  pending_identity      jsonb not null default '{}'::jsonb,

  -- What the code actually produced, recorded at redemption. This is the audit
  -- trail from a connector to the resident it created.
  agent_id              uuid references public.agents (id) on delete set null,

  expires_at            timestamptz not null,
  redeemed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index if not exists oauth_codes_expires_idx on public.oauth_codes (expires_at);
create index if not exists oauth_codes_client_idx  on public.oauth_codes (client_id, created_at desc);

-- ---------------------------------------------------------------------------
--  oauth_refresh_tokens: the long-lived half. Stored as a hash like everything
--  else, revoked on use (rotation), and referenceable back to the resident so a
--  grant can be inspected rather than only believed.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_refresh_tokens (
  token_hash   text primary key,
  client_id    text not null references public.oauth_clients (client_id) on delete cascade,
  agent_id     uuid not null references public.agents (id) on delete cascade,
  scope        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  -- Set when this refresh token is spent (rotated) or explicitly revoked, so a
  -- replay of a spent token is distinguishable from an unknown one.
  revoked_at   timestamptz
);

create index if not exists oauth_refresh_tokens_agent_idx on public.oauth_refresh_tokens (agent_id);

alter table public.oauth_clients        enable row level security;
alter table public.oauth_registrations  enable row level security;
alter table public.oauth_codes          enable row level security;
alter table public.oauth_refresh_tokens enable row level security;
-- (deliberately no policies on any of them; service role only)
