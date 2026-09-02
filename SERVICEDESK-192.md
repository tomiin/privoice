# Draft: servicedesk report — Custom(192) on a contract call performing `receiveUnshielded`

Status: DRAFT for Jay's review. Do not post until the checklist at the bottom is ticked.

---

## Title

Contract call performing `receiveUnshielded` rejected by the node with `Custom(192) InputsSignaturesLengthMismatch` on Preview

## Summary

On Preview, a contract **deploys** successfully and a **contract call that writes
the ledger succeeds**, but a contract call on the *same deployed contract* that
additionally performs `receiveUnshielded` is rejected at submission with:

```
1010: Invalid Transaction: Custom error: 192
```

Per `midnight-node/ledger/src/versions/common/types.rs` (`impl From<LedgerApiError> for u8`,
checked against `main` on 2026-09-02), 192 is
`Transaction(Malformed(InputsSignaturesLengthMismatch))`.

## Environment

| | |
| --- | --- |
| Network | Preview (`wss://rpc.preview.midnight.network/`) |
| Compact compiler | 0.31.1 |
| Language version | 0.23.0 |
| `@midnight-ntwrk/compact-runtime` | 0.16.0 |
| `@midnight-ntwrk/ledger-v8` | 8.1.0 |
| `@midnight-ntwrk/midnight-js-*` | 4.1.1 |
| `@midnight-ntwrk/compact-js` | 2.5.1 |
| `@midnight-ntwrk/wallet-sdk` | 1.2.0 |
| `@midnight-ntwrk/onchain-runtime-v3` | pinned to 3.0.0 via npm `overrides` (single copy verified) |
| Proof server | local, `:6300`, responding 200 |
| Wallet | 11,000 tNIGHT, NIGHT registered, ~50,276 DUST, synced to chain tip (`isConnected` true on both wallets, dust index at reported tip) |

`contract-info.json` reports `runtime-version: 0.16.0`, matching the installed
`compact-runtime`, so this is not a compiler/runtime version mismatch.

## Contract

Both circuits live in one contract so a single deploy, wallet and block window
covers both. They differ in that `deposit` performs one unshielded-token
operation (and takes two arguments).

```compact
pragma language_version >= 0.23;
import CompactStandardLibrary;

export ledger deposits: Uint<64>;
export ledger bumps: Uint<64>;

constructor() {
  deposits = 0 as Uint<64>;
  bumps = 0 as Uint<64>;
}

// control
export circuit bump(): [] {
  bumps = (bumps + (1 as Uint<64>)) as Uint<64>;
}

// subject
export circuit deposit(color: Bytes<32>, amount: Uint<128>): [] {
  receiveUnshielded(disclose(color), disclose(amount));
  deposits = (deposits + (1 as Uint<64>)) as Uint<64>;
}
```

Compiles clean: `bump` k=7 rows=90, `deposit` k=9 rows=498.

## Observed

Contract deployed on Preview at:

```
c755041b16edcde0fb504e8967317d8de0cb2ef6a8593585877cd2a7e9c6e928
```

| call | arguments | result |
| --- | --- | --- |
| `bump()` | none | **ACCEPTED** |
| `deposit(color = 00..00, amount = 1)` | native tNIGHT colour (32 zero bytes), amount 1 | **REJECTED, `Custom(192)`** |

`deposit` was retried 6 times, each attempt **rebuilt and re-proved from
scratch** rather than resubmitted. All 6 returned `Custom(192)` identically.
`bump` was run first, on the same contract, from the same wallet state, roughly
40 seconds earlier, and was accepted.

Earlier runs against separate deployments of a single-circuit version of the
same contract (`37c78fa6…`, `04e07b50…`) also returned `Custom(192)`.

Failure surfaces from
`@midnight-ntwrk/wallet-sdk-node-client/dist/effect/PolkadotNodeClient.js`
during `submitAndWatchExtrinsic`, i.e. at submission — proving completed
successfully.

## What this report does and does not claim

It claims: on this stack, on Preview, a contract call performing
`receiveUnshielded` is rejected with 192 while an otherwise comparable contract
call from the same wallet is accepted.

It does **not** claim a cause. Noting honestly that the two circuits differ in
more than one respect — the subject also takes two arguments and has a larger
circuit — so if argument arity is a plausible confounder for this check, say so
and I will build a tighter control.

## Related

Possibly related to servicedesk #117 (unshielded token operation from a
contract), but the reported symptom there is `Custom(231)`
`Malformed(FeeCalculation.OutsideTimeToDismiss)`, which is a different check.
Filing separately rather than commenting there for that reason — happy to have
it merged if they are the same underlying issue.

---

## Pre-post checklist

- [x] Control accepted, subject rejected, same contract and wallet
- [x] Subject rebuilt and re-proved on every retry (not resubmitted)
- [x] Version skew ruled out (`contract-info.json` runtime matches installed runtime)
- [x] Single `onchain-runtime-v3` copy verified after clean install
- [x] Wallet verified live against chain tip before spending
- [x] 192 confirmed against `types.rs` on `main` — recheck on the day of posting
- [ ] Confirm servicedesk #117's actual reported code before referencing it
- [ ] Jay has read the whole thing and agrees with every sentence
