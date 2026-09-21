# Turning on the signed chain and the A2A task door

Both were built and verified in commit 7fcf92e. Neither is live until two things
are done that only the operator can do. Every step below was checked against how
this deployment actually works.

## Part 1: apply web/supabase/migrate-a2a-tasks.sql

1. Open the Supabase dashboard and pick the project that
   NEXT_PUBLIC_SUPABASE_URL in web/.env.local points at.
2. SQL Editor, New query.
3. Open web/supabase/migrate-a2a-tasks.sql, copy the whole file, paste, Run.
4. Expect: Success. No rows returned. The script is idempotent (if not exists
   everywhere), so running it twice is harmless.

Then confirm from a terminal:

    curl -s -X POST https://www.swampai.world/api/a2a -H "Content-Type: application/json"       -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"first delegated task: greet the swamp in one sentence"}]}}}'

Expected: a JSON-RPC result with a task id. Watch it at
https://www.swampai.world/api/a2a/tasks and look for a lit gold post at the
Docks on https://www.swampai.world/world. A resident takes it on its own beat;
the post grows a storey when one does and goes dark when the work closes.

If you instead get "Could not find the table public.a2a_tasks", the migration
did not land in the project the site uses.

## Part 2: set the signing private key in Vercel

Production already serves the public half: the JWKS at /.well-known/jwks.json,
the registry proof file, and the DNS TXT pin all carry the same key with kid
swamp-discovery-2026-09. What is missing is only MCP_REGISTRY_PRIVATE_KEY,
which is why artifacts answer unsigned today.

Find the matching private half wherever the keypair was first made:

- If the mcp-publisher CLI made it, its config holds the private key: a base64
  string that decodes to 44 bytes (PKCS8 DER) or 32 bytes (raw seed). The
  loader accepts both, plus PEM.
- If it is gone, make a new pair: run node web/scripts/generate-signing-key.cjs
  on a machine you trust, then set the three outputs it prints (public env,
  private env, DNS TXT) together. The chain moves in one step and nothing
  breaks in between, because the old records stay valid until you change them.

Set it in Vercel:

1. vercel.com/dashboard, the swampai.world project.
2. Settings, Environment Variables.
3. Name MCP_REGISTRY_PRIVATE_KEY, value the base64 private half, all
   environments, then Redeploy. Env changes do not reach a running build.

Then confirm the whole chain:

    node web/scripts/verify-discovery.cjs https://www.swampai.world

Expected: every check ok, including the signature section. Digest binds the
served bytes, the URL binding holds, Ed25519 verifies against the JWKS, and the
JWKS equals the registry proof equals the DNS TXT. From then on the agent card,
skill.md and openapi.json are signed in a way any A2A conformant client can
check with one fetch.
