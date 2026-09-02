# Running the probe

Answers one question: **does a `receiveUnshielded` call land on Preview today?**

Adapted from the sealed-bid `deploy/` CLI, which is proven deploy-and-call
code, repointed at Preview. Same wallet stack, same provider bundle.

## Before the first run

Two files were copied in and are not used — `tsc` will complain about them
because they import the sealed-bid contract, which does not exist here:

```sh
cd "Midnight code /Privoice/probe/runner"
rm src/deploy.ts src/contract-witnesses.ts
npm install
```

## You need

1. **A proof server** on `localhost:6300`, or set `PROOF_SERVER` to a hosted one.
2. **A Preview wallet seed** — 64 hex characters — for a wallet holding NIGHT
   **with DUST accrued**. The wallet behind Tender's `bridge-service` qualifies;
   Tender showed it holding ~16,013 DUST today. Take the seed from that
   service's `.env`.

## Run

```sh
PROBE_SEED_HEX=<64-hex-chars> npm run probe
```

Optional overrides:

| variable | default | purpose |
| --- | --- | --- |
| `PROBE_COLOR_HEX` | 32 zero bytes (native tNIGHT) | test a different token, e.g. USDM |
| `PROBE_AMOUNT` | `1` | how much to send into the contract |
| `PROOF_SERVER` | `http://localhost:6300` | hosted prover instead of local |

**Native tNIGHT is used deliberately.** The question is about the *mechanism*,
not USDM, and NIGHT avoids a bridge round-trip just to run a test. Point
`PROBE_COLOR_HEX` at USDM later if we want to confirm it behaves the same.

## Reading the output

The script prints one of three verdicts.

| verdict | meaning | consequence |
| --- | --- | --- |
| **CALL SUCCEEDED** | contract custody of an unshielded token works on Preview | Privoice pursues **Design C** — pooled deposits, committed balances, invoice amounts genuinely hidden |
| **CALL REJECTED**, fee-model error | #117 still reproduces, now on Preview and compiler 0.34.0 | Privoice uses **Design B** — application-layer settlement — and cites an open Midnight-filed bug. Add the data point to servicedesk #117 |
| **CALL REJECTED**, different error | something else — wallet, DUST, proving | record the text; do not conclude anything about #117 |

**Deploy succeeding proves nothing.** Their whole finding is that deployment
works and the call is refused, so the script reports those two steps separately
and on purpose.

## Notes

- The wallet is built with `useCheckpoint: false`. A stale checkpoint cost an
  hour on the Rise In deploy — its dust tree could not absorb current events and
  every retry failed identically. Fresh sync each time is cheap and honest.
- The private-state store is named `privoice-probe-preview` so it cannot collide
  with sealed-bid's.
- Nothing here is Privoice. It is a disposable experiment whose only output is
  an answer.
