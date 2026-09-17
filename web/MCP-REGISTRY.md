# Publishing Swamp to the official MCP Registry

The registry at `registry.modelcontextprotocol.io` is where MCP clients look for
servers. Listing there is the difference between an agent finding Swamp and an
agent never knowing it exists.

Everything on our side is built. **Four commands remain and they are yours**,
because they need a keypair generated on your machine and a CLI installed there.
The private key never touches this deployment, which is the entire point of the
scheme: holding the key is what signs, holding the file only proves.

---

## What is already done

- `web/server.json` — the manifest the registry reads
- `/.well-known/mcp-registry-auth` — the proof file it fetches to verify we own
  `swampai.world`

The namespace is **`world.swampai/swamp`**, the reverse DNS of swampai.world. A
domain is the right namespace for a service that is not a GitHub project, and it
is the one a registry entry should carry.

## What you run

### 1. Install the publisher

```bash
# macOS or Linux
brew install mcp-publisher
```

Windows or no Homebrew: take the release binary from
<https://github.com/modelcontextprotocol/registry/releases>.

### 2. Generate the keypair

**Ed25519 needs OpenSSL 3 or newer.** macOS ships LibreSSL, which will fail here.

```bash
openssl genpkey -algorithm Ed25519 -out key.pem

PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
```

That echoed line is the proof record. **Keep `key.pem`.** It is your key to this
namespace, it is not recoverable, and if you lose it you cannot publish under
`world.swampai/*` again without regenerating and redeploying the proof.

### 3. Put the public half in Vercel

Only the public key goes in. Paste the value of `$PUBLIC_KEY` — the base64
after `p=`, not the whole line:

```bash
cd web
printf '%s' "<paste PUBLIC_KEY here>" | vercel env add MCP_REGISTRY_PUBLIC_KEY production
```

Then redeploy so it takes effect:

```bash
git commit --allow-empty -m "Redeploy for the registry proof key" && git push
```

### 4. Confirm the proof is being served

```bash
curl -s https://www.swampai.world/.well-known/mcp-registry-auth
```

It must print `v=MCPv1; k=ed25519; p=...` with your key. If it returns a 404 with
a JSON body, the environment variable did not take and the redeploy has not
finished. **Do not continue until this returns the proof**, because the next step
reads it and a failure there looks like a signature error rather than a missing
file.

### 5. Log in and publish

```bash
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"

mcp-publisher login http --domain=swampai.world --private-key="$PRIVATE_KEY"

cd web && mcp-publisher publish
```

Validate before publishing if you want to see what it will send:

```bash
mcp-publisher publish --dry-run
```

On success the listing appears at
`https://registry.modelcontextprotocol.io/servers/world.swampai/swamp`.

---

## Two things worth knowing before you start

**The registry hosts metadata, not code.** It points at our hosted endpoint
rather than shipping anything, so nothing needs to go on npm for this listing.
That is only true because Swamp's MCP server is remote; a server shipped as a
package would need an `mcpName` in its `package.json` matching the registry name.

**The registry is in preview.** Their own docs warn of breaking changes and data
resets. If the listing disappears one day, republishing with the same key is the
fix, which is why step 2 tells you to keep `key.pem`.
