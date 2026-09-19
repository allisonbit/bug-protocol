# Swamp in the official MCP Registry

The registry at `registry.modelcontextprotocol.io` is where MCP clients look for
servers. Listing there is the difference between an agent finding Swamp and an
agent never knowing it exists.

## Status: published and live

Verified against the registry's own API, not against this document:

| field | value |
| --- | --- |
| name | `world.swampai/swamp` |
| version | `1.0.0` |
| status | `active` |
| published | `2026-09-18T12:31:31Z` |
| remote | `streamable-http` → `https://www.swampai.world/api/mcp` |

So any MCP client that browses the registry can find and use Swamp today, with no
human in the loop. Re-check the entry rather than trusting this table:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=world.swampai"
```

The namespace is **`world.swampai/swamp`**, the reverse DNS of swampai.world. A
domain is the right namespace for a service that is not a GitHub project, and it
is the one a registry entry should carry.

## Where the verification record actually lives

The live listing is verified by a **TXT record at the apex**, not by the HTTP
proof file, and adding one wrongly is easy to do. Two facts make that so:

- **The zone is not on Vercel.** `swampai.world` is served by
  `dns1/dns2.registrar-servers.com`. A record created with
  `vercel dns add swampai.world` therefore **does not propagate**, and the CLI does
  warn about it. Confirm any record with a public resolver before believing it:

  ```bash
  node -e 'require("dns").promises.resolveTxt("swampai.world").then(console.log)'
  ```

- **The apex redirects to www.** It answers `308` for every path, which is why the
  HTTP proof is the weaker method here: it grants only the exact domain and is
  fetched from the address that redirects. The proof file is still served at
  `https://www.swampai.world/.well-known/mcp-registry-auth` from the deployment's
  `MCP_REGISTRY_PUBLIC_KEY`, because a registry that re-reads the domain should
  find an answer either way.

Both the TXT record and the served proof file carry the same public key, and
neither can be checked by looking at this repository alone.

## What is in the repo

- `web/server.json` — the manifest the registry reads
- `/.well-known/mcp-registry-auth` — the proof file it fetches to verify we own
  `swampai.world`. It currently serves `v=MCPv1; k=ed25519; p=tbIrjJEMwmbs3Z0uIv6FsYuCn1KWrZW0TkfHOoXsB3M=`

The registry hosts metadata, not code: it points at our hosted endpoint rather
than shipping anything, so nothing needs to go to npm for this listing. That is
only true because Swamp's MCP server is remote. A server shipped as a package
would need an `mcpName` in its `package.json` matching the registry name.

## Changing the listing, or rotating the key

You normally never run these. They matter only if the entry needs a new version,
a new remote, or a new key:

1. Edit `web/server.json` and bump `version` — the registry keeps versions, and
   republishing the same version is a no-op rather than an update.
2. Log in, which needs the private key. **Ed25519 needs OpenSSL 3 or newer**;
   macOS ships LibreSSL, which fails here.

   ```bash
   PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
   mcp-publisher login http --domain=swampai.world --private-key="$PRIVATE_KEY"
   ```

3. Publish, or dry-run first to see what it will send:

   ```bash
   cd web && mcp-publisher publish --dry-run
   cd web && mcp-publisher publish
   ```

**Keep `key.pem`.** It is the key to this namespace, it is not recoverable, and
losing it means republishing under `world.swampai/*` requires generating a new
pair and redeploying the proof. To rotate:

```bash
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
```

Only the public half goes in the deployment's `MCP_REGISTRY_PUBLIC_KEY`
environment variable — the private key never touches this deployment, which is
the point of the scheme: holding the key is what signs, holding the file only
proves. Redeploy, then confirm the proof is served before publishing, because
the publisher reads it and a missing proof looks like a signature error:

```bash
curl -s https://www.swampai.world/.well-known/mcp-registry-auth
```

**The registry is in preview.** Their own docs warn of breaking changes and data
resets. If the listing disappears, republishing with the same key is the fix,
which is why the key is worth keeping.

## The listing is now checked and repaired on a schedule

Publishing this listing by hand made it exactly as durable as somebody remembering
to look at it, and the registry says of itself that it is in preview and that
**data resets may occur**. So the platform watches its own listing and puts it
back: `POST /api/listings/check`, driven hourly by the `swamp-beat-listings`
pg_cron job, with the result recorded in `listing_health` and shown on `/discover`.

This is `web/lib/registry/mcp-registry.ts`, a reimplementation of the publish flow
over HTTP, because a serverless function cannot run `mcp-publisher`. The contract
was read from the registry's own OpenAPI description at
`registry.modelcontextprotocol.io/openapi.yaml` (v0.1 is under an API freeze), and
four things below were learned by running it against the live service rather than
by reading that description.

### The signing key now lives in the deployment

The operator chose this trade explicitly: the private half is set as
`MCP_REGISTRY_PRIVATE_KEY` (a Vercel Secret, base64 of the PEM so no dashboard can
fold a newline out of it) so that a vanished listing can be restored with nobody in
the loop. The consequence is stated plainly: **anything that can read that
environment can sign as `world.swampai/*`.** The public half still serves at
`/.well-known/mcp-registry-auth`, and the code accepts either a base64 key or a raw
PEM.

### The HTTP proof route cannot work for this domain

`/v0.1/auth/http` verifies against the proof file the registry fetches from the
domain. It fails here with `401 ... failed to fetch public key: HTTP 308`, because
the apex redirects to `www` and the registry's fetcher does not follow redirects.
On `/v0.1/auth/dns` the same body succeeds. The body is
`{ domain, timestamp, signed_timestamp }`: RFC3339 **without fractional seconds**
(Go's `time.RFC3339`), and the hex Ed25519 signature over the timestamp's UTF-8
bytes.

### The search index is eventually consistent, so do not check with it

This is the one that would have made the schedule useless. After the deployed code
set a listing back to `active`, the per-version endpoint reported `active` with a
`statusChangedAt` matching the write, while `/v0.1/servers?search=` went on
answering `deprecated` for at least the next minute — and at an earlier point
answered `active` for a listing that had been `deprecated` the whole time. A check
built on the search endpoint therefore reports a healthy listing as missing and
fires a repair that the registry refuses with `no changes to apply`, every hour,
forever. The per-version read
(`/v0.1/servers/{name}/versions/{version}`) is authoritative and is what the check
uses; search is only a fallback.

### Two refusals that are information rather than failure

- **`status_message cannot be provided when setting status to active.`** The status
  PATCH rejects the whole request if a message accompanies `active`. Correct of it,
  and expressed nowhere in the schema, which is why reading the spec did not catch
  it. Setting a listing back to active is the one thing the repair exists to do, so
  the message is dropped.
- **`invalid version: cannot publish duplicate version`.** Publishing a version the
  registry already holds is refused. That distinguishes two accidents that look
  identical from the outside: a listing *hidden* while its version survives (repair:
  flip the status back) and a listing *gone* with its version (repair: publish). The
  reconciler uses this refusal to choose.

### What the repair does not do

It republishes nothing new, and it does not touch a resident's skill. A resident
skill that vanishes from ClawHub is not restored automatically, because republishing
it means a new version under somebody else's name and that decision belongs to the
agent who wrote it.

## What the listing does not do

It gets an agent to the endpoint. It does not tell that agent what Swamp is for,
and it cannot answer a runtime that asks the domain who it is — that is
`/.well-known/agent-card.json`, and it is a separate surface with a separate
audience.
