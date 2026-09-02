# Privoice

**Private invoices with public, tamper-evident settlement — on Midnight, in USDM.**

Privoice is **built on [Midnight](https://midnight.network)**, using the Compact
language and Midnight's zero-knowledge contract model.

Live on Midnight **Preview**:

| | |
| --- | --- |
| Contract | `f80694b6c5cb9bab0cd1246e1cb20fa816e0d4d92234d6017dc90a1fd0ac8494` |
| Proved on chain | `issue` → `acknowledge` → `settle`, all accepted |
| USDM payment leg | implemented in [`app/src/usdm.ts`](app/src/usdm.ts); the run above predates it |
| Toolchain | compiler 0.31.1 · language 0.23 · runtime 0.16.0 · ledger-v8 8.1.0 · midnight-js 4.1.1 |

---

## The problem

USDM arrives on Midnight in the **unshielded** pool, and it cannot be shielded.

So a business that settles invoices in USDM on Midnight publishes, to anyone
watching, **every amount it charges and every counterparty it charges**. For a
supplier bidding against three others, that is not a privacy nicety. It is
handing competitors your price list and your customer book.

Most "private payments" projects would stop reading there and build something
that quietly doesn't work. This one starts there.

## What Privoice does

The invoice never goes on chain. Only a commitment does:

```
commitment = persistentHash(amount, payer, memo, salt)
```

The issuer sends the real invoice to the payer off chain, exactly as they do
today. What the chain holds is a fingerprint of it, published at a known
moment, plus a record of what happened to it.

Three things become provable without revealing anything:

1. **The issuer cannot alter the invoice afterwards.** An auditor holding the
   invoice document recomputes the commitment and checks it against the one
   recorded on chain at issue time. Tamper-evident.
2. **Acknowledgement proves identity.** A payer can only acknowledge an invoice
   by reconstructing a commitment that matches — and the payer's id is *inside*
   the hash. You cannot acknowledge an invoice that does not name you.
3. **Settlement is a public fact** anyone can verify, while the sum settled
   stays private.

## The honest boundary

Read this before believing anything above.

| | |
| --- | --- |
| **Public** | that an invoice exists, its id, its commitment, which issuer raised it, and whether it was acknowledged, settled or voided |
| **Private** | the amount, the payer's identity, the memo, the salt — none is ever transmitted |

**The USDM payment itself is an ordinary unshielded transfer at the application
layer, and its amount is public.** A token movement already in the clear cannot
be hidden by any contract. An observer who sees a transfer of exactly X in the
same window as a settlement can infer that invoice's amount. Settling in a
different transaction from the payment, and letting one payment cover several
invoices, blunt that. They do not eliminate it, and this project does not
pretend otherwise.

What is genuinely removed is **the link** — which invoice, for what, between
whom. That is most of what a competitor wants.

## Why settlement is at the application layer, and not in the contract

The original design had the contract take custody of USDM, so amounts could be
pooled and hidden outright. Before writing it, that was tested rather than
assumed.

A single contract was deployed on Preview carrying two circuits that are
identical except for one line — one performs an unshielded-token operation, the
other does not — so a single deploy, wallet, DUST state and block window covers
both, and the unshielded effect is the only variable:

| circuit | shape | result |
| --- | --- | --- |
| `bump()` | ledger write only, k=7, rows=90 | **ACCEPTED** |
| `deposit()` | ledger write + `receiveUnshielded`, k=9, rows=498 | **REJECTED — `Custom(192)`** |

Six attempts, each rebuilt and re-proved from scratch rather than resubmitted.
All six rejected identically, roughly 40 seconds after the control was
accepted from the same wallet.

`192` is `Transaction(Malformed(InputsSignaturesLengthMismatch))`, read from
`impl From<LedgerApiError> for u8` in `midnight-node/ledger/src/versions/common/types.rs`.

Control contract: `c755041b16edcde0fb504e8967317d8de0cb2ef6a8593585877cd2a7e9c6e928`.
The harness is in [`probe/`](probe/), and the write-up is in
[`SERVICEDESK-192.md`](SERVICEDESK-192.md).

So contract custody of an unshielded token is not available on Preview today.
The architecture reflects a measured constraint, not a guess.

## USDM: handled by the application layer

**USDM is handled at the application layer, not by the contract.**

The payment code is [`app/src/usdm.ts`](app/src/usdm.ts), and it is called from
[`app/src/deploy.ts`](app/src/deploy.ts) as step 3 of 4, between `acknowledge`
and `settle`.

| | |
| --- | --- |
| USDM token colour (Preview) | `003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73` |
| Decimals | 6 |
| Path | `facade.transferTransaction` → `signRecipe` → `finalizeRecipe` → `submitTransaction` |

USDM on Midnight is an **unshielded** token, named by a 32-byte colour rather
than a contract address, and it cannot be shielded. So the amount of any USDM
transfer is public. That is a property of the token, not a limitation of this
design.

Unshielded inputs each require a signature, which is why the transfer is signed
with `keystore.signData` via `facade.signRecipe` before finalising. Omitting
that step is one way to reach `Custom(192) InputsSignaturesLengthMismatch`.

The contract records **that** settlement happened. It never sees the amount and
never takes custody of the token — because, as measured above, it cannot.

## How identity works

Compact has no `msg.sender`. A caller proves who they are by knowing a secret
key supplied through a witness, from which identities are derived by one-way,
**domain-separated** hashing:

```compact
issuerId(sk) = persistentHash([pad(32, "privoice:v1:issuer"), sk])
partyId(sk)  = persistentHash([pad(32, "privoice:v1:party"),  sk])
```

Two different tags, so the same key yields two values that cannot be linked to
each other. One tag for every role means one identity for every role, and that
is how a "private" contract leaks.

The secret key never leaves the caller's machine and never reaches the chain.

## Circuits

| circuit | k | rows | |
| --- | --- | --- | --- |
| `issue` | 14 | 9285 | issuer publishes a commitment |
| `acknowledge` | 14 | 9507 | payer proves the invoice names them |
| `settle` | 14 | 9246 | issuer records payment received |
| `voidInvoice` | 13 | 4469 | issuer withdraws before settlement |
| `exists` / `isSettled` | 9 | 305 | reads |
| `commitmentOf` | 9 | 329 | read, for auditors |

`issuerId`, `partyId` and `termsCommitment` are exported **pure** circuits, so a
dApp, a test, or an auditor can recompute them off chain — which is what makes
the tamper-evidence check independently verifiable.

## Running it

Requires a Preview wallet holding NIGHT with **DUST registered** (holding NIGHT
is not enough — it must be registered to generate DUST), and a local proof
server on `:6300`.

```bash
compact compile +0.31.1 contract/src/privoice.compact app/managed
cd app
npm install
npm run deploy
```

The run deploys a fresh contract and drives the whole lifecycle: issue as the
issuer, acknowledge as the payer, settle as the issuer. Issuer and payer have
separate secret keys and separate private states, swapped between calls through
the private state provider rather than by sharing a key.

Both identities run in one process here, which a real deployment would not do.
The demo harness is what is collapsed — not the security model.

## Known gaps

- **Not audited.**
- One deployment holds many invoices, but there is no pagination or indexing;
  a production version needs an off-chain index keyed by invoice id.
- `issuerId` is deliberately stable, so an observer can count how many invoices
  an issuer raises and when. That is a design choice, not an oversight — a
  business is not trying to hide that it issues invoices — but it is a
  disclosure and it is named here rather than buried.
- No deadline or dispute flow. An invoice is open until settled or voided.
- The demo derives both identities from fixed labels for reproducibility. Real
  keys must come from a wallet.

## Layout

```
contract/src/privoice.compact   the contract
app/src/deploy.ts               deploy + full lifecycle against Preview
app/src/witnesses.ts            witness implementations
probe/                          the unshielded-custody experiment
SERVICEDESK-192.md              the 192 finding, written up
BUILD-PLAN.md                   design notes, written before the code
```

## Licence

MIT.
