# Probe — can a Compact contract custody an unshielded token?

**This is a test, not part of Privoice.** It decides the architecture, so it
runs before any contract is written.

## The question

Privoice settles in USDM, which lives in Midnight's **unshielded** pool. If a
contract can hold an unshielded token, we can build the pooled-deposit design
that genuinely hides invoice amounts. If it cannot, settlement has to happen at
the application layer and the amount stays visible.

## Why this exact file

`unshielded.compact` is **Midnight's own reproduction**, copied byte-for-byte
from `midnames/bug-reports/unshielded-tx-fail-stagenet`, filed by faculerena
(Midnight) on 2026-07-28 as servicedesk **#117**, P2 High, assigned to
nstanford5, **still open**.

Do not tidy it, rename it, or "improve" it. Its value is that it is their
artifact, not ours — if it fails, the report writes itself; if it passes, the
result is credible precisely because we changed nothing.

## What they observed

- The contract **deploys** fine.
- **Calling `deposit` is rejected by the node**, `Malformed(FeeCalculation(OutsideTimeToDismiss))`.
- Not a size problem: their 7,158-byte tx was rejected while a 14,008-byte
  control tx with no unshielded op was accepted.
- Margin ~5% (15.706 ms against a 15.000 ms cap), deterministic.
- Tested on **stagenet**, node 2.0.0-rc.4, compactc 0.33.0-rc.2.

## What is new here

Nobody has reported whether this still occurs on **Preview** with a current
toolchain. We are on compiler **0.34.0** (newer than their 0.33.0-rc.2).
So both outcomes are worth having.

## Run it

Compile with the pinned compiler — never the machine default:

```sh
cd "Midnight code /Privoice/probe"
compact compile +0.34.0 unshielded.compact ./managed
```

Then deploy to Preview and call `deposit` once. Deploying alone proves nothing:
their whole finding is that deployment succeeds and the **call** fails.

## Reading the result

| outcome | meaning | Privoice design |
| --- | --- | --- |
| `deposit` call succeeds | contract custody works on Preview | **Design C** — pooled deposits, committed balances, invoice amounts genuinely hidden |
| call rejected, same fee error | #117 still bites | **Design B** — application-layer settlement, and cite an open Midnight bug as the reason |
| compile fails | the API changed since 0.33 | investigate before concluding anything |

Record the exact error text and the node version either way. If it still fails,
that is a fresh data point on an open P2 bug and worth adding to #117.

---

## Result 1 — compilation, 2026-08-29

**PASSES on compiler 0.34.0.**

```
$ compact compile +0.34.0 unshielded.compact ./managed
Compiling 1 circuits:
  circuit "deposit" (k=9, rows=496)
```

So `receiveUnshielded` still exists and still compiles, unchanged in shape
since their compactc 0.33.0-rc.2. The API has not moved. Whatever #117 is, it
is **not** a compile-time problem — which matches their report exactly: the
contract builds, and the *call* is what the node refuses.

`k=9, rows=496` also makes it a very cheap circuit, so a fee-model rejection
would be about the unshielded effect itself rather than circuit size.

**Still to test: deploy to Preview and call `deposit` once.** Deployment alone
proves nothing.

### Note on which token to use for the call

`deposit` takes a token `color`, and calling it means genuinely sending that
much of that token to the contract. USDM is not required to answer the
question — **native tNIGHT is also an unshielded token**, and its color is
32 zero bytes (`'00'.repeat(32)`, as used in Tender's balance reader). Using
NIGHT avoids a bridge round-trip just to run a test.
