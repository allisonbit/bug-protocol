# How an agent finds Swamp, and how to redo each part

This file is the procedure. It records *how* to do each thing, never a secret, and
it separates the three ways a thing gets found, because they need different work
and only one of them is entirely in our hands:

1. **Conventions.** A runtime is pointed at `swampai.world` and guesses the paths
   the standards say to guess. No directory, no listing, no human.
2. **Registries.** A place a browsing client or a person consults, where somebody
   had to publish.
3. **Aggregators.** Directories that copy the official registry, and therefore need
   nothing from us but a working registry entry.

The check for all of it is one command, and it asserts rather than reports:

```bash
node scripts/verify-discovery.cjs https://www.swampai.world
```

It exits non-zero if any claim here is false. Run it after any change to a
discovery surface.

---

## 1. Conventions: the paths guessed from a bare domain

These live in the repository and need no credential to serve.

| Path | Route | What it is |
| --- | --- | --- |
| `/.well-known/agent-skills/index.json` | `app/well-known/agent-skills/index/route.ts` | Agent Skills discovery (draft 0.2.0). Names the skill and its SHA-256. |
| `/.well-known/agent-skills/swamp/SKILL.md` | `app/well-known/agent-skills/swamp/route.ts` | The skill artifact. |
| `/.well-known/skills/index.json` | `app/well-known/skills/index/route.ts` | The same index at the superseded 0.1 path, marked `deprecation: true`. |
| `/.well-known/skills/swamp/SKILL.md` | `app/well-known/skills/swamp/route.ts` | The artifact the legacy index points at. |
| `/.well-known/mcp.json` | `app/well-known/mcp/route.ts` | MCP server card. |
| `/.well-known/agent-card.json`, `/.well-known/agent.json` | `app/well-known/agent-card/route.ts` | A2A agent card. |
| `/.well-known/api-catalog` | `app/well-known/api-catalog/route.ts` | RFC 9727 linkset. |
| `/.well-known/security.txt`, `/security.txt` | `app/well-known/security/route.ts` | RFC 9116. |

### Adding another well-known path

Next's App Router ignores directories beginning with a dot, so **every** path
under `/.well-known/` is a route at `/well-known/` plus a named rewrite in
`next.config.ts`. Two things go wrong if the rewrite is forgotten, and the second
is the dangerous one:

- The route compiles and the build lists it, but the public path 404s.
- **Every path must be added to `lib/surfaces.json`.** That file is what
  `/everything` renders and what `scripts/verify-surfaces.cjs` probes, so a path
  missing from it is a path nothing checks. This has already gone wrong once, with
  the api-catalog route, which was correct while its public URL was not.

### The skill and its digest

The skill is one string, in `lib/skill.ts`. Three surfaces serve it:

- the artifact above,
- the legacy alias,
- the `read_skill` MCP tool.

`lib/skill-index.ts` computes the digest **from that string at request time**.
Do not replace it with a checked-in hash. A client is required to verify the
artifact against the digest before using it, so a digest that drifts does not
degrade gracefully: it makes the skill unusable in exactly the clients it was
published for, silently.

If the skill text changes, nothing else needs regenerating. The index follows.

### Legacy path policy

Draft 0.2.0 renamed the convention from `/.well-known/skills/` to
`/.well-known/agent-skills/` and changed the index shape incompatibly. The old
path serves the new document with `$schema` present and a `deprecation` header:
the spec tells clients to decide how to read an index from `$schema`, so an
honest 0.2.0 document at the old address is better than a 404 and better than a
counterfeit 0.1 one.

---

## 2. The official MCP Registry

**Status: published and live**, as `world.swampai/swamp`. Verified against the
registry's API, not against a file here:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=world.swampai"
```

The manifest is `web/server.json`. A remote-only server needs no package
published anywhere; the registry hosts metadata and points at the endpoint.

### Namespace verification

The namespace reverses to the apex domain `swampai.world`, and the live listing is
verified by an **Ed25519 TXT record at the apex**, not by the HTTP proof file.
That choice was forced by DNS, and it is worth understanding before changing it:

- The apex `308` redirects everything to `www`. HTTP verification fetches
  `https://<domain>/.well-known/mcp-registry-auth` and grants the exact domain
  only, so a redirect is a real risk there.
- **The domain's DNS is not on Vercel.** `swampai.world` uses
  `dns1/dns2.registrar-servers.com`. A record added with `vercel dns add` to this
  domain **does not propagate**, because the zone is served elsewhere. If you add
  a record that way, check it with a public resolver before believing it; the
  Vercel CLI warns about exactly this.

The records that matter, as served publicly:

```
swampai.world.  TXT  "v=MCPv1; k=ed25519; p=<public key>"
```

### The keypair

`~/.mcp-registry/key.pem` holds the private key for this namespace, and
`~/.mcp-registry/mcp-publisher.exe` is the publisher binary. **Losing the key
means republishing under a new pair and redeploying the proof.** Only the public
half belongs in the deployment's `MCP_REGISTRY_PUBLIC_KEY` variable; the private
key never touches the deployment, which is the point of the scheme.

To publish an update (a new version, remote, or key), the live namespace uses DNS
verification:

```bash
cd web
~/.mcp-registry/mcp-publisher.exe login dns --domain=swampai.world --private-key=<hex>
~/.mcp-registry/mcp-publisher.exe publish --dry-run
~/.mcp-registry/mcp-publisher.exe publish
```

A session token is cached at `~/.config/mcp-publisher/token.json`. Republishing
the same version is a no-op, so bump `version` in `server.json` for a real update.

**Do not generate a fresh keypair casually.** Doing so rotates the namespace and
breaks the live listing until the TXT record is updated, which requires access to
the registrar's DNS.

---

## 3. ClawHub

**Status: published and public**, as `@allisonbit/swamp` version `1.0.0`, passing
ClawHub's security review (`CLEAN`). Verify with the CLI rather than this file:

```bash
clawhub inspect @allisonbit/swamp
clawhub search swamp
```

One thing to know before republishing: **the slug `swamp` is also held by another
publisher**, `@umag`, for an unrelated API-modeling tool. ClawHub scopes slugs by
owner, so both exist and search disambiguates by owner. It is worth remembering
because a bare `/skills/swamp` link is ambiguous to a human, even though the CLI
resolves `@allisonbit/swamp` unambiguously.

### Publishing

The CLI needs to be on PATH. It is a public npm package, and the script does not
fetch one for you, because on Windows `npx` is a `.cmd` shim that a Node script
cannot exec without hand-quoting every argument, and the failure mode of getting
that wrong is a false "not logged in".

```bash
npm i -g clawhub                      # once
node scripts/publish-clawhub.cjs      # writes the bundle web/skills/swamp/
clawhub login                         # or: clawhub login --device for headless
node scripts/publish-clawhub.cjs --publish --dry-run
node scripts/publish-clawhub.cjs --publish
```

A token can be handed in instead of a browser sign-in (`clawhub login --token`),
and the script accepts one through `CLAWHUB_TOKEN`, which keeps it out of shell
history and out of a process list. Point `CLAWHUB_BIN` at a binary if it is not on
PATH.

A first publish is held as `pending.publication` while ClawHub runs its scan. That
is normal, and the skill appears in `search` and `explore` once it clears.

The script fetches the skill **from the live domain**, verifies it against the
discovery index's digest, and only then writes the bundle. It does not hold its own
copy, because a bundle built from a repository copy could ship bytes that the
digest on swampai.world does not describe, and a conforming client would reject
them.

Every publish field is passed explicitly (`--slug`, `--version`, `--changelog`,
`--source-repo` and friends). Left to itself the CLI prompts for a changelog, and a
prompt in a non-interactive run is a hang rather than a question.

`web/skills/` is gitignored on purpose: it is a copy of a served artifact, and a
committed copy is a second source of truth.

---

## 4. Aggregators, and why there is nothing to click

Arclan and ToolSDK validate and index MCP servers by reading the official
registry. With the entry above `active`, they need no submission. The same is
true of the other aggregators in that family.

This is the part worth remembering about directory work: **most of it is a
consequence of the registry entry, not a separate task.** A listing page that
claims to have been submitted to a dozen directories, when eleven of them mirror
one registry, is describing one action twelve times.

---

## 5. Names that could not be verified

These were proposed as publishing targets. Each was searched for and none was
found to exist as described, so **nothing was built against them**. They are
recorded rather than quietly dropped, because "we are not listed there" and
"there is no there" look identical on a status page and are not the same fact.

| Proposed | What it actually is |
| --- | --- |
| "Agent Reach", as a Nostr-based agent service discovery network | Agent-Reach is real, but it is a search and web-ingestion library for agents. It has no registration or discovery surface. |
| "Circus", as an agent commons with `GET /api/v1/agents/discover` | Agent Circus is real, as a container runtime for running agent harnesses. It has no such endpoint and is not a discovery network. |
| `opencode-agent-hub` | No evidence found of it existing under that name. |
| "Agent Hotline" | No evidence found of it existing under that name. |
| "Clawdentity" | No evidence found of this identity protocol existing under that name. |

### One convention deliberately not served

`/.well-known/ai-plugin.json` is **not** served. The manifest requires an `api`
field pointing at a real OpenAPI description, and no OpenAPI document exists here.
Serving the file with a placeholder URL would be a malformed manifest that looks
like an answer, which is worse than the 404 this domain honestly returns. If an
OpenAPI description is ever added, the manifest becomes worth serving and this
decision reverses.

---

## The rule this all follows

A discovery surface is a claim made to a stranger with no way to check it. That is
the same shape as a count typed by hand on a marketing page. So:

- Digests, tool counts, rule counts and endpoints are **read from the running
  code**, never written down.
- A registry status is **read from the registry's own API** at request time.
  `/discover` renders that live, and says it could not reach the registry rather
  than defaulting to a green tick.
- A missing key is a **404 with a reason**, not an empty proof file.
- A path that answers is added to `lib/surfaces.json`, so it is probed.
