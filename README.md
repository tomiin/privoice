# Privoice

**Private invoices with public, tamper-evident settlement — on Midnight, in USDM.**

Privoice is **built on [Midnight](https://midnight.network)**, using the Compact
language and Midnight's zero-knowledge contract model.

Live on Midnight **Preview**:

| | |
| --- | --- |
| **Contract** | `6c2936b6b77fbd92dbc8fb38071eca080b23f4f72c6cac024136fe1f188f3fe7` |
| Proved on chain | `issue` → `acknowledge` → **pay** → `settle`, all four accepted |
| Invoice in that run | `e024cb6a6ecf41808d479b2f8c88ab81a8d7d267756fe219cc3ce60ef85b6af4` |
| Commitment | `e796f1f035cdb2009b764027c6dd0204a2860ba272518e23efc5fb3de7dd3ef7` |
| Settlement transfer | `00b8593136d3046de72c042b9aea5498613016cebf090ee9593fd40ca2f2139248` |
| Toolchain | compiler 0.31.1 · language 0.23 · runtime 0.16.0 · ledger-v8 8.1.0 · midnight-js 4.1.1 |

> **The settlement transfer in that run moved NIGHT, not USDM.** USDM is the
> payment asset this project is built around and is the code's default, but it
> could not be obtained on Preview on the day — see
> [USDM: handled by the application layer](#usdm-handled-by-the-application-layer)
> for exactly why, and what is and isn't demonstrated.

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

The payment code is [`app/src/usdm.ts`](app/src/usdm.ts), called from
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
that is one way to reach `Custom(192) InputsSignaturesLengthMismatch`.

The contract records **that** settlement happened. It never sees the amount and
never takes custody of the token — because, as measured above, it cannot.

### What the deployed run actually moved, and why

The settlement in the deployed run above moved **0.125 NIGHT**, not USDM.
Being precise about that:

| | |
| --- | --- |
| Demonstrated on chain | the application-layer settlement mechanism — a real unshielded token transfer, wallet to wallet, inside the invoice lifecycle |
| Token moved in that run | NIGHT (`00…00`) |
| Token the code defaults to | USDM (`003bacd9…947d73`) |
| Difference between the two | one 32-byte constant. The transfer code is the same function, same call, same signing path. |

**Why the substitution was necessary.** USDM is minted on Midnight *solely* by
VIA's cross-chain gateway delivering a message from Cardano. There is no faucet
and no other issuance path, so when that gateway is not delivering, USDM cannot
be acquired on Preview at all. On 2 September 2026 it was not delivering:

| Message | Sent with | Amount | Status |
| --- | --- | --- | --- |
| [`…000406`](https://scan.vialabs.tech/tx/d1edfca0edbdb2a7e437e788b8e81d869080960cbeb21db0ed5b423314bc9ccc) | this project's own bridge UI | 10 USDM | stuck at *Awaiting Attestation* |
| [`…000408`](https://scan.vialabs.tech/tx/2834fa408b1ceb5025d0e8889498d60374fdf7964486b18bccfc6f226b74c263) | VIA's own CLI, `@via-labs-tech/usdm-bridge@1.2.0` | 1 USDM | stuck at *Awaiting Attestation* |

Both locks confirmed on Cardano. Both carry routing values matching VIA's
published testnet table — chain ids `2273266 → 64364450`, gateway
`471dfe55…e73e485c`, token colour `003bacd9…947d73`. VIA's documentation states
that validators attest after **1 block on testnet**; Cardano Preprod was
healthy throughout and the first transfer was ~300 blocks deep. On VIA's own
message feed, the last delivered message on that route was `…000405`, roughly
24 hours earlier — these two are the only ones since.

**To reproduce with USDM**, hold USDM on Preview and run the deploy with no
token override. `PRIVOICE_TOKEN_COLOR` is unset by default and the code uses
USDM's colour; the NIGHT run above was produced by passing that variable
explicitly, and the run prints a warning when it is set to anything other than
USDM.

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

### What you need

- **Node 22+** and the Compact compiler (`compact` on your PATH).
- A **Midnight Preview wallet** holding NIGHT, with that NIGHT **registered for
  DUST**. Holding NIGHT is not enough — it must be registered before any DUST
  accrues, and DUST is what pays fees.
- A **local proof server** on `:6300`. Proving happens on your machine, so
  nothing deploys without it:

  ```bash
  docker run -d --name midnight-proof-server -p 6300:6300 \
    midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v
  ```

- **USDM on Preview** for the payment step. Without it the contract lifecycle
  still runs end to end and the script says clearly that the payment leg was
  skipped. USDM can only reach Preview through VIA's cross-chain gateway —
  there is no faucet.

### Point it at your wallet

The runner never reads a key from a file inside this repo. Supply one of these,
in this order of precedence:

| variable | value |
| --- | --- |
| `PRIVOICE_SEED_HEX` | a raw seed as hex |
| `PRIVOICE_MNEMONIC` | a BIP-39 mnemonic for your Preview wallet |

```bash
export PRIVOICE_MNEMONIC="word word word ..."
```

If neither is set, the runner falls back to reading `MIDNIGHT_MNEMONIC_PREVIEW`
from a local `.env` belonging to a different project of mine. That path will not
exist on your machine, and the error message tells you so — set one of the two
variables above instead.

### Run it

```bash
compact compile +0.31.1 contract/src/privoice.compact app/managed
cd app
npm install
npm run balances
npm run deploy
```

`npm run balances` prints every unshielded token this wallet holds, flags
whether USDM is present, and shows the Bech32m address to send USDM to.

`npm run deploy` deploys a fresh contract and drives the whole lifecycle:

1. **issue** as the issuer — publishes only a commitment
2. **acknowledge** as the payer — proves the invoice names them
3. **pay** — a real unshielded token transfer, wallet to wallet (USDM by
   default; see the note on the deployed run above)
4. **settle** as the issuer — records that payment arrived

Useful switches:

| variable | effect |
| --- | --- |
| `PRIVOICE_PAYEE` | Bech32m address to pay; defaults to a self-transfer |
| `PRIVOICE_TOKEN_COLOR` | token colour the settlement moves. **Unset = USDM.** Only set this to demonstrate the settlement when USDM cannot be obtained; the run prints a warning when it is not USDM |
| `PRIVOICE_AMOUNT` | invoice amount in base units (default `125000` = 0.125 USDM) |
| `FRESH_SYNC=1` | ignore the wallet checkpoint and cold-sync from scratch |
| `CHECKPOINT_MAX_HOURS` | how stale a checkpoint may be before it is refused (default 12) |

The first run cold-syncs the DUST wallet, which walks ~180,000 generation
events and takes several minutes. After that a checkpoint is saved and later
runs resume in seconds. A **stale** checkpoint is worse than none — it corrupts
the dust tree — which is why old ones are refused rather than used.

### A note on the two identities

Issuer and payer have separate secret keys and separate private states, swapped
between calls through the private state provider rather than by sharing a key.
Both run in one process here, which a real deployment would not do. The demo
harness is what is collapsed — not the security model.

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
