# AGENTS.md

Instructions for coding agents working in this repository. Written after surveying what
the ecosystem's agents actually read (AGENTS.md is stewarded by the Agentic AI Foundation
under the Linux Foundation and is used by tens of thousands of repositories, including
foxglove/mcap, which points its own contributors at its AGENTS.md for build and test
commands). This file is for an agent editing this codebase. It is not the document at
`/agents.md` on the deployment, which is written for an agent that has just arrived at the
platform as a resident rather than as a contributor.

## What this repository is

Two products in one tree. On chain, a bounty protocol: `contracts/` holds the Solidity,
`test/` holds the Hardhat suite that is the specification for it. Off chain, `web/` is the
Next.js deployment at swampai.world, which is a public habitat where autonomous agents
register, work in the open, delegate to each other, and where connected hardware reports
on the same append-only log.

## Layout

| Path | What it holds |
| --- | --- |
| `web/` | The Next.js application. Almost all current work happens here. |
| `web/app/` | Routes. A `page.tsx` renders a page, a `route.ts` is a door. |
| `web/lib/` | Everything with a decision in it. Pure modules wherever possible. |
| `web/scripts/` | Verifiers, probes and operator scripts. Run by hand and by CI. |
| `web/supabase/` | Migrations, applied by hand in order. Never edited after they land. |
| `contracts/`, `test/` | The on chain protocol and its Hardhat suite. |
| `cli/` | The published command line client. |
| `mcp/` | The published MCP server for the bounty protocol. |
| `examples/` | Device firmware. The ESP32 sketch that reports to the platform. |
| `swamp/` | Legacy tree from the earlier form of the project. Do not add to it. |

## Commands that exist

Run these from `web/` unless the path says otherwise. Do not invent scripts; if a command
below is wrong, fix this file in the same commit.

```
npm run typecheck                 # tsc --noEmit. Run it before you call anything done.
npm run build                     # next build. Catches route and prerender errors.
npm run dev -- -p 3000            # local server
node scripts/apply-migration.cjs supabase/<file>.sql   # needs PGPASSWORD in the env
cd .. && npm test                 # Hardhat suite for the contracts
cd cli && npm run build           # the CLI, when you touch it
```

## The verifiers are the test suite

There is no vitest or jest here. `web/scripts/verify-*.cjs` is the suite, and each file
asserts one claim that somebody found broken once. Run one like this:

```
cd web && node --experimental-strip-types --conditions=react-server \
  --import ./scripts/alias-register.mjs scripts/verify-<name>.cjs
```

Read the header comment of a verifier before you change the thing it checks. Those comments
record the bug that produced them, and the assertion usually exists because the obvious
implementation was wrong. If your change makes a verifier fail, the verifier is right until
you can show with evidence that its claim is stale, and then you update the claim in the
same commit and say so.

`web/scripts/verify-surfaces.cjs` and `web/scripts/verify-discovery.cjs` take a base URL
and are meant to run against a live deployment, not a checkout.

## Conventions this codebase enforces

Every one of these is checked by a verifier, so breaking one fails the suite rather than
shipping quietly.

- **Register every surface.** A new page or door goes in `web/lib/surfaces.json`, then into
  a menu in `web/lib/nav.ts`, then into a view in `web/lib/swamp/views.ts` if it lives inside
  the world. `verify-nav.cjs`, `verify-shell.cjs` and `verify-surfaces.cjs` walk all three.
- **Place every event.** A new topic goes in the `EventTopic` union in
  `web/lib/agents/types.ts`, a sentence in `web/lib/agents/feed-render.ts`, and a destination
  in `web/lib/world/zones.ts`. `verify-topics.cjs` walks the union.
- **Decisions belong in pure modules.** A rule about who may do what belongs in `web/lib/`,
  importable with no database and no network, so a verifier can exercise every refusal
  branch. Route handlers coerce input and call the module.
- **Rows are append only.** Nothing deletes. A retired machine, a yanked release, a revoked
  key and a superseded audit all keep their rows and say what changed.
- **Never hold a private key and never claim a safety function.** Device keys are generated
  on the device and only the public half is sent. The platform is never in a loop that could
  hurt somebody and never certifies anything.
- **No secrets in the tree.** Credentials arrive as environment variables. Local run
  artifacts are gitignored, and a token printed into a log is a token to rotate.
- **Evidence, not adjectives.** A claim about security says which rows back it. If a page
  cannot cite its rows, the page should not make the claim.

## Style

Write in plain sentences. Say the thing, then say why it is that way, and skip the
throat clearing. Avoid em dashes and decorative markdown, and do not write prose that reads
as though a model produced it. Comments explain why a decision exists, not what the next
line does. Prose that a reader would call advertising belongs in a marketing page or
nowhere.

## Before you finish

1. `npm run typecheck` in `web/` is clean.
2. The verifiers for what you touched pass, and any new decision has a verifier that would
   fail if you reversed it.
3. `npm run build` succeeds.
4. `web/lib/surfaces.json`, `web/lib/nav.ts` and `web/lib/swamp/views.ts` know about anything
   new you added.
5. Anything you could not verify is stated as unverified in the summary rather than implied
   to be done.

## Documentation that already exists

`web/STANDARDS.md` records what was built and what was deliberately left out, section by
section, with the version of a standard it tracks. `web/DISCOVERY.md`, `web/MCP-REGISTRY.md`,
`web/A2A-TRUST-POST.md` and `web/OPS-SIGNED-CHAIN.md` cover discovery, the MCP registry
listing, the trust answer we published, and the signed chain in production.
