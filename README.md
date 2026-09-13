# $BUG: bug bounty protocol

Clients fund a program. Hunters commit to findings on chain and deliver the
plaintext off-chain. Accepted findings pay out of escrow the client cannot
reclaim. `$BUG` bonds both sides' good faith.

Built for **Robinhood Chain** (chain id `4663`, native asset ETH).

## The three constraints that shape the design

**1. A vulnerability report never touches the chain in plaintext.**
A public report is a live exploit handed to everyone. Hunters submit
`keccak256(abi.encode(reportURI, salt, hunter))`; the body travels off-chain,
encrypted to the program owner. Reveal happens only after remediation.

The hunter's address is bound into the commitment. That is what stops a mempool
watcher from copying the hash and claiming priority, since they cannot produce a
preimage that opens to their own address without knowing the report. There's a
test for exactly this (`07-disclosure`).

**2. A program cannot go Live without recorded authorisation and funded escrow.**
`setStatus(Live)` enforces all four: a scope + safe-harbour document hash, at
least one payout tier, escrow covering the top tier, and the client's bond.
Without recorded authorisation this contract would be coordinating unauthorised
access to third-party systems. Without escrow, hunters work for free.

**3. A client cannot accept a finding and then refuse to pay.**
Acceptance credits an unconditional pull-payment claim out of escrow *in the same
transaction*. There is no "pay later" step to default on.

## Escrow solvency

Every un-triaged submission is fully covered. `submit` reverts unless

```
pool >= (pendingCount + 1) * topTier
```

and `withdrawPool` reserves `pendingCount * topTier`. The trade is explicit:
concurrency is capped by how much the client escrowed. It is the only way to
promise an accepted finding is always payable. Clients raise the cap by funding
more.

## Bonds

| Bond | Posted by | Slashed when | Returned when |
| --- | --- | --- | --- |
| `submissionBond` | hunter, per report | `Spam` verdict survives the dispute window, or the arbiter rules bad faith | Accepted, Rejected, Duplicate, or a won dispute |
| `minProgramBond` | client, per program | arbiter upholds a finding escrow can't cover | program Closed with nothing pending |

An honest `Rejected` costs the hunter **nothing**. Charging for good-faith
misses is how a bounty platform loses its hunters.

A `Spam` verdict does not credit the slash immediately. The bond is held for
`DISPUTE_WINDOW` (7 days) so a wrong call is reversible. `finalizeSpamSlash` is
permissionless once that passes.

The client bond is `$BUG` and awards are in the program's reward token. There is
no exchange rate between them and **no oracle anywhere in this system**, so a
default forfeits the bond *pro rata to the unpaid share of the award*, a
dimensionless ratio. It is a penalty, not a make-whole.

## Duplicate handling

`Duplicate` must reference an earlier, already-`Accepted` submission on the same
program. A client cannot dismiss a finding as a dupe of something that was never
reported or never paid. Checked on chain.

## Flow

```
client                     chain                        hunter
  |  createProgram           |                             |
  |  bondProgram             |                             |
  |  fundProgram             |                             |
  |  setStatus(Live) ------> | scope + escrow + bond gate   |
  |                          | <-------- submit(commitHash) |
  |                          |            (+ bond)          |
  | <--- encrypted report off-chain ------------------------|
  |  triage(Accepted, sev) ->| escrow -> claimable          |
  |                          | -------> claim()             |
  |  waiveEmbargo ---------> |                              |
  |                          | <----- reveal(uri, salt)     |
```

If the client goes silent, the hunter calls `escalate` after the SLA lapses and
the arbiter rules. Escrow stays reserved throughout.

## Status

Phase 1 complete: core contract, 37 passing tests, 16,485 bytes deployed
(8 KB under the EIP-170 limit).

Not yet built: `BugArbiter` (staked dispute resolution; `setArbiter` is
deliberately one-shot and stays unset until it exists), the encrypted report
pipeline, and the web app.

## Commands

```bash
npm test                                  # 37 tests
npx hardhat compile
npx hardhat run scripts/deploy.js         # local, deploys a mock $BUG

BUG_TOKEN=0x... BUG_FEE_RECIPIENT=0x... BUG_CONFIRM_DEPLOY=yes \
  npx hardhat run scripts/deploy.js --network robinhood
```

Deploying anywhere but local requires `BUG_CONFIRM_DEPLOY=yes`. The arbiter slot
is one-shot, because a live protocol must not have its dispute venue swapped from
under open escalations.

## Note on tooling

Foundry is blocked on this machine by Windows Application Control (`os error
4551`), so this uses Hardhat. Contracts are plain Solidity 0.8.26 + OpenZeppelin
5 and port to Foundry unchanged.
