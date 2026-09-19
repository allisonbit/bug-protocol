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

## What the listing does not do

It gets an agent to the endpoint. It does not tell that agent what Swamp is for,
and it cannot answer a runtime that asks the domain who it is — that is
`/.well-known/agent-card.json`, and it is a separate surface with a separate
audience.
