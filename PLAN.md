# $BUG: Implementation Plan

The single source of truth for what we're building. Every line traces to something you asked for.

## The product (your words)
> "$BUG: People can hire us to find bugs on their websites, we let the community find the bugs and we reward them."

A bug-bounty protocol where clients fund escrowed programs, the community hunts, and accepted findings pay out of escrow the client **cannot** claw back. You launch the $BUG coin on the Pons launchpad yourself and hand me the CA to integrate; I build the entire platform + utility around it.

## Requirements captured from every message

| # | Ask (verbatim/paraphrased) | Status |
|---|---|---|
| 1 | Robinhood Chain, wallet connect, "do everything, don't stop, no mistakes" | done: contracts + wallet |
| 1b | End-to-end hunter loop: submit w/ encrypted report + commit receipt, then reveal, escalate, triage, resolve | done: web + CLI + MCP |
| 2 | Contracts first, then UI; working MVP that can take a real client | done: 37 tests pass |
| 3 | Push to GitHub + deploy Vercel | done: live |
| 4 | "no dashboards no tools": build the REAL app, not a marketing site | in progress |
| 5 | **"best protocol ever on Robinhood but for ALL CHAINS"**: multi-chain | todo |
| 6 | **Payments in ETH + USDC, on Base + Robinhood** | todo |
| 7 | **"even without our contract it can work"**: direct ETH/USDC escrow, token optional | done: both modes ship; every surface labels which one a program is in |
| 8 | **"make sure MCPs can connect to AI agents"**: MCP server so agents hunt/triage/query | todo |
| 9 | **"build all tools needed, PC tool, instant download for marketplace, any tool you can think of"** | in progress |
| 10 | **"tools for debugging live, the full future of exploits"**: live recon/debug tooling | todo |
| 11 | **"go through GitHub, find tools, build them into ours"**: pull in real OSS hunting tools | todo |
| 12 | Integrate $BUG coin (Pons launchpad) once CA provided | todo (awaiting CA) |
| 13 | $BUG utility = slashable bonds on both sides (forfeitable -> real utility) | done: in contract |

## Architecture

### Contracts (`/contracts`) (DONE)
- `BugBounty.sol`: escrowed commit-reveal disclosure. Invariants: reports never on-chain plaintext; no Live program without funded escrow + scope + bond; acceptance is same-tx pull-payment.
- Next: `BugBountyNoToken` variant / config path so a program can run on **pure ETH/USDC** with bonds optional (req #7), and deploy to **each chain** (req #5).

### Web app (`/web`): Next.js 16, wagmi 3, viem 2
- **Dashboard**: role-aware: your programs, your submissions, claims, arbiter queue.
- **Programs** list + **`/programs/[id]`** detail with live reads, escrow-mode badge and an in-browser
  scope-hash check against the on-chain `scopeHash`.
- **Owner control panel**: two tabs, *Listing* (publish / pause / close) and *Escrow* (create-or-link,
  fund, bond, go-live, pause, close, withdraw unreserved, reclaim bond). Every step preflights the
  contract's own preconditions.
- **Submit flow** `/programs/[slug]/submit`: encrypt in-browser, content-address the envelope,
  salt+commit, **download receipt**, then on-chain `submit` (escrowed) or direct record (off-chain).
- **Submission detail** `/submissions/[id]`: decrypt (owner), on-chain triage, waive embargo, spam
  finalize; hunter-side preimage self-check, reveal, escalate, claim.
- **Arbiter console** `/arbiter`: escalated queue read from chain state, `resolveEscalation`, with the
  bond-forfeit rule stated on the page.
- **Multi-chain**: chain switcher (Robinhood 4663, Base 8453, Arbitrum, Optimism, Base Sepolia, plus
  Hardhat when configured), per-chain contract + USDC addresses.
- **Wallet drawer**: claim rewards, withdraw bond.

### The hunter loop, end to end

Chain is the money; Supabase is the index. Escrow, verdicts, bonds and the revelation embargo are
enforced by `BugBounty.sol`; the off-chain rows carry discovery, the encrypted envelope, notes,
reputation and the public disclosure projection. A program with no `onchain_program_id` keeps
working as an honour-system bounty; the same receipt still dates and binds a finding.

1. **Submit**: the report is encrypted with AES-GCM in the browser, its envelope is hashed locally,
   and that hash *is* the `reportURI` (`/api/reports/<sha256>`). That resolves the chicken-and-egg of
   `reportURI` being inside the commit preimage before anything is stored. The salt is written to the
   local vault and the receipt downloaded **before any signature**, so a failed transaction can never
   strand a commit. Escrowed programs then `submit(programId, commitHash)` after approving the $BUG
   anti-spam bond.
2. **Index**: the row is created with the ciphertext, and the server re-reads the chain to verify the
   submission exists, belongs to this program, and was filed by the wallet on the hunter's profile.
   Client-asserted chain state is never trusted.
3. **Triage**: the owner decrypts locally with the passphrase the hunter relayed, then sends
   `triage(...)`; the award is credited out of escrow in that same transaction. The panel disables
   severities the contract reads as zero and only offers duplicates that would pass
   `BadDuplicateReference`.
4. **Reveal**: gated on the program's own `disclosureDelay` measured from triage, or `waiveEmbargo`.
   The hunter's salt is re-derived and compared against the on-chain commit before any action is
   offered. An SLA-lapsed escalation can be revealed immediately (the delay runs from a triage that
   never happened), which is what puts the evidence in front of the arbiter.
5. **Escalate**: two grounds, as the contract distinguishes them, the triage SLA lapsed while still
   Pending (escrow stays reserved), or a dispute of Rejected / Duplicate / Spam inside seven days.
6. **Resolve**: the arbiter console lists escalated findings from chain state alone, because an
   arbiter is normally neither hunter nor owner and the index hides those rows from everyone else.
   The contract's `onlyArbiter` is the real gate; the page only reports whether your wallet holds it.
7. **Reconcile**: `/api/chain/tick` mirrors chain truth into the index and imports findings that
   arrived via the CLI, the MCP server or another browser, attributing them by profile wallet.

**Two modes, always labelled.** A program that isn't linked to a deployment is *off-chain*, and both
the program page and the submit form say so. Otherwise a hunter would believe they were bonded and
escrowed when they weren't. Escrow mode is a badge, not a footnote.

### Tools marketplace (`/tools`): req #9, #10, #11
Instant, client-side, downloadable. No server round-trip.
- **Commit builder**: keccak256(reportURI, salt, hunter), download JSON receipt. In progress.
- **Report encryptor / decryptor**: AES-GCM envelope so the body is safe to publish as the reportURI. Library done.
- **Scope hasher**: hash a scope doc to scopeHash, download.
- **Receipt verifier**: re-derive a commit from a receipt.
- **`bug-cli`**: downloadable Node CLI: submit, reveal, watch programs, triage.
- **Recon/debug kit**: downloadable scripts pulling from OSS (nuclei/httpx-style runners), "live debugging" helpers.
- **MCP server config**: one-click download of the `bug-protocol` MCP manifest.

### MCP server (`/mcp`): req #8
An MCP server exposing the protocol to AI agents: list/read programs, compute commits, submit findings, check triage state, read claims. Ships with a manifest downloadable from `/tools`.

## Build order
1. ~~Owner control panel (unblocks program page)~~
2. ~~Submit flow + submission detail (unblocks hunter loop)~~
3. ~~Arbiter console + chain reconciler~~
4. Tools page + downloadable bug-cli + MCP manifest. In progress.
5. Multi-chain config + USDC + token-optional escrow. In progress (registry + USDC done; a real deploy per chain pending)
6. MCP server package.
7. Rebuild, commit, push, then Vercel.

## Dashboard: upgrading it to "work real"

Requested: "make implementation plan on upgrading the dashboard to work real". This is the plan, and the first
thing it does is separate what is already real from what only looks finished, because most of the dashboard
turned out to be further along than the request implied and the remaining gaps are specific.

### What is real today (verified, not assumed)

| Surface | State |
|---|---|
| `/dashboard` | Real. Four queries (`getMyPrograms`, `getMySubmissions`, `getInbox`, `getProfile`); stat band appears only for a role with a basis for it; escrow and off-chain commitments are counted apart, not summed |
| Empty states | Real and deliberate. A new account gets `StartHere`, not four zeros, because a zero is a measurement and there is nothing to measure |
| `/dashboard/agents` | Exists; token shown once, stored as a hash |
| `/dashboard/connect` | Exists |
| `/dashboard/swamp` | Exists; reads the live event bus |
| `/dashboard/ai` | Real console over `/api/copilot`, with an honest offline planner fallback when no model is wired. Recipes name registered MCP tools only |
| Write tools | `submit_finding`, `triage_submission`, `disclose_finding`, `claim_target` are all registered and persisted |
| Peer review | `POST /api/findings/[id]/review` enforces "not your own finding", a status gate, and one review per reviewer |

### What is missing, in the order it blocks things

**P0, blocks everything else: nine database objects do not exist in the live schema.** The console logs five failed
queries per page load. Absent: `agent_memory`, `agent_follows`, `agent_registrations`, `cabals`, `cabal_members`,
`swamp_pulse`, the leaderboard table, and the continuity/commitment/registration tables. Two concrete consequences,
neither cosmetic:

- Registration rate limiting **fails open** because `agent_registrations` is absent, so the open self-registration
  door has no flood limit at all.
- `/v1/continuity` and `/v1/commitments` now answer **503** with an honest "our side" message, but `/skill.md` still
  tells agents that resume, checkpoint and commit exist. An agent reads a promise it cannot keep.

**P0, the product's core promise: there is no way to move money.** No payout, withdraw, or claim surface exists
anywhere (`find app -name '*payout*' -o -name '*withdraw*'` returns nothing). The dashboard reads `paid_out` and
sums earnings, but a hunter has no button to take what escrow owes them and an owner has no way to top up or close
out. Everything upstream of this is honest bookkeeping for a payment that cannot yet be made.

**P1: triage is a read-only dead end.** The inbox links to `/submissions/[id]`; the detail page renders accepted
state and reward but exposes no accept/reject/reward control, and `/submissions` has no index route. The review API
is real, so this is UI work rather than new backend work.

**P2: no agent-management or activity view.** A user with agents has no dashboard surface summarising them; the
roster lives on `/swamp`, which is public. Onboarding shows no next step once the first program or finding exists.

### Phases, each with a stated finish line

**Phase 1, make the schema whole.** Apply the missing objects as one reviewed migration. Finish when: a full page
load of `/dashboard`, `/swamp`, `/agents` and `/leaderboard` logs zero `[queries]` errors, and a registration
attempt that exceeds the limit is refused rather than accepted.

**Phase 2, money out.** Build the payout path end to end: a claim action for an accepted finding, an owner surface
for funding and closing a program, and the on-chain settlement the program's escrow mode calls for. Finish when: an
accepted finding can be paid out on a testnet program and the resulting transfer is visible on the explorer, with
an off-chain program answering honestly that it has no contract to pay from.

**Phase 3, finish triage.** Add the accept/reject/reward controls to `/submissions/[id]`, and a `/submissions`
index so the inbox has somewhere to point. Finish when: an owner can take a finding from `new` to `accepted` with a
reward, entirely in the UI, with no API call by hand.

**Phase 4, the account view.** Add an activity timeline (from the bus, which already has the data) and an agent
summary for accounts that own agents. Finish when: a returning user can see what changed since their last visit
without opening a public page.

### Order and rationale

Phase 1 first is not a preference: the other three all render data the missing tables hold, so building them first
means building against errors. Phase 2 before phase 3 because a triage verdict that cannot pay is the exact gap
this plan exists to close. Phase 4 last because it is additive and depends on phase 1's tables.

### Known limits to state rather than hide

- **Off-chain programs cannot be enforced.** "Funded" in `offchain` mode is a promise, not a contract. The UI
  names that on every surface, and phase 2 must not blur it into "in escrow" when the money is not.
- **`rep` from an off-chain program is unverifiable** (already in Known limits above). Phase 4's agent summary must
  not present it as chain-attested.
- **Nothing here fixes discovery.** `/api/chain/tick` still scans a bounded window of recent ids.

---

## Awaiting from you
- $BUG contract address (Pons launchpad): set `NEXT_PUBLIC_BUG_TOKEN` + on-chain `bugToken`.
- **An arbiter venue.** `setArbiter` is one-shot and unset by default, so escalations are currently
  unresolvable. A multisig is the honest choice until a dedicated arbitration contract exists.
- Deploy target chains confirmation (defaulting to Robinhood + Base).

## Known limits (stated, not hidden)
- **Discovery is a bounded window.** `/api/chain/tick` and `/api/arbiter/queue` scan the most recent
  N submission ids rather than querying logs, because `getLogs` from genesis is unreliable on the
  chains we support. Both report how much they actually scanned. A real indexer replaces this as
  volume grows.
- **Reputation from an off-chain program is unverifiable.** An owner could fabricate accepted
  findings on a program they run and self-credit `rep`. Only escrowed programs are chain-attested;
  the leaderboard does not currently distinguish the two.
- **The bond/arbiter trust point.** An escalation is only as good as whoever holds `arbiter`, and the
  pool-shortfall path pays the hunter the client's $BUG bond pro rata, a penalty on the client, not
  a make-whole.

---

## Verbatim request log

Every message you've sent, unedited, so intent is never lost in paraphrase.

### This session
1. "fininsh up the build and push to github and vercle"
2. "you built entirely rubbish ui everthing is wrong i logged in no dasboards no tools etc"
3. "read everthing and build whats its intebded the best protocol everer on robin hood but for all chains"
4. "build all tools needed pc tool etc intant download for market place any tool you can think of or more"
5. "continue"
6. "even without our contract it can work payment in eth usdc base robinhood through mcp ai aggents can connect too"
7. "tools fo debugging live this shoyild be the full future of exploits"
8. "go through github find tools path up build it to our add build build the nect billion dolllar protocol"
9. "put all the message i sent you to implementation plan youre forgetting some and go"
10. "i said add all the message sent for this sessions too"

### Earlier session (from the continuation summary)
- "can you chcek robin hood and pons find anything bug with details i can uzse to launch a coin ponfamily.com"
- "hi" / "ok whats that" / "ok"
- "stop beig silly i said go find if we see a narrative so we can build a platform called bug"
- "its robinhood chain check github repoditory too b"
- "continue"
- "so where do buy back go all details"
- "$BUG so from this lets build a project utility while ill lauch the coin on pons my self / People can hire us in to find bugs on their websites, we will let the community find the bugs and we reward them?ok good so"
- "i said find anything like bug so we can have atesis for a coin lauch expecially from their github"
- "$BUG / People can hire us in to find bugs on their websites, we will let the community find the bugs and we reward them?push to github and deploy vercel"
- "continue" (several), "hi" (several), "contiue"
- Mid-turn injects: "what are u looking for", "check github even robi hood chain github also", "but we are using launchpad to lauinch the coin ill just give you our ca to integrate so the cpin can be part of the websitr", "i hand over everthing ui etc its on robin hood chain wallet connect etc do everthing dont stop till ur done no mistsakes", "make sure mcps can connect too ai agent", "mal", "make it the best thing that came out of your head"

### Reading between the lines (intent, not literal)
- "for all chains" + "eth usdc base robinhood" -> **multi-chain, multi-asset escrow**, not Robinhood-only.
- "even without our contract it can work" -> the platform's value (escrowed bounties, tooling, MCP) must **not depend on the $BUG token existing yet**; token adds bond utility on top.
- "pc tool", "instant download", "marketplace", "tools for debugging live", "the full future of exploits", "go through github find tools" -> a **real tools marketplace**: downloadable CLI/desktop helpers + live recon/debug tooling drawn from established OSS, wired to the protocol.
- "mcps can connect to ai agent" -> ship an **MCP server** so agents can hunt/triage/query autonomously.
- "next billion dollar protocol" / "best thing that came out of your head" -> bar is a flagship product, not a demo.
