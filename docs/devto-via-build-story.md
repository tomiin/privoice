---
title: Five things I learned moving USDM between Cardano and Midnight
published: false
description: Notes from building a cross-chain USDM transfer app and a private invoice contract on Midnight. Enterprise addresses, explorer link rules, a node error code, and why a contract cannot hold USDM today.
tags: midnight, cardano, zeroknowledge, blockchain
canonical_url:
---

I built two things on VIA's USDM cross-chain transfers over the past two weeks:

- **[Tender](https://github.com/tomiin/tender-usdm)** — a browser app that moves native USDM between Cardano Preprod and Midnight Preview, both directions, signed by the user's own wallets.
- **[Privoice](https://github.com/tomiin/privoice)** — a private invoice contract in Compact, settling in USDM, deployed on Midnight Preview.

Eight transfers landed. One contract deployed with four on-chain interactions. Along the way I hit five things that are either not in the docs or are in the docs in a form that does not warn you about the consequence.

None of this is a criticism of VIA's documentation, which is good. It is the gap between "correctly specified" and "you will not guess this at 2am".

---

## 1. Your USDM arrives at an address your wallet will not show you

This one cost me a day, and I suspect it has cost other people their submissions.

Send USDM from Midnight to Cardano and it will not appear in Lace. The balance does not move. The transfer looks like it failed. It did not fail — the money is at an address your wallet does not watch.

Here is the mechanism, from VIA's own message spec. The VILR payload has fixed-width fields:

| Offset | Width | Field |
| --- | --- | --- |
| 76 | **28** | `source_depositor` — payment key hash of the depositor |
| 136 | **32** | `destination_recipient` |

And the rule:

> `source_token`, `destination_token`, and `destination_recipient` are each **exactly 32 bytes. No shorter, no longer.**

A Cardano **base** address is 57 bytes: a header, a 28-byte payment credential, and a 28-byte stake credential. It does not fit in 32 bytes. What survives is the payment credential — which is exactly what `source_depositor` is defined as.

Reconstruct an address from a payment credential with no stake credential and you get an **enterprise address**. Every time. By design.

So the spec is correct and complete, and the consequence — *your funds land somewhere Lace does not display, and you will think the bridge ate them* — is nowhere.

I built the derivation into Tender so the app shows both balances side by side:

```
Cardano Preprod        990.000000 USDM
  977.000000 at your wallet address
   13.000000 at your enterprise address
```

VIA export `getEnterpriseAddress` from the package, so they know. If you are building anything user-facing on this, derive it and show it.

---

## 2. VIA Scan needs `0x` on Midnight hashes and refuses it on Cardano ones

Same transfer, two URLs:

```
scan.vialabs.tech/tx/3c7daa78…9fda6034      →  Not found
scan.vialabs.tech/tx/0x3c7daa78…9fda6034    →  Delivered
```

A Cardano-source hash must be **bare**. A Midnight-source hash must be **`0x`-prefixed**. Get it wrong and Scan tells you the transaction does not exist, on a transfer that completed.

And one more: **VIA Scan opens on Mainnet.** Every testnet message is invisible until you flip the network toggle.

That is three separate ways to conclude a working transfer failed. I wrote one helper and stopped guessing:

```ts
function viaScanHref(hash: string, fromMidnight: boolean): string {
    const h = fromMidnight && !hash.startsWith("0x") ? `0x${hash}` : hash;
    return `${VIA_SCAN}/tx/${h}`;
}
```

---

## 3. Testnet attests after one block. Mainnet is the fifty-minute one

The docs say it plainly, but it is easy to read the wrong row:

> Validators wait for source-chain confirmations before attesting a message: **1 block on testnet**, 150 Cardano blocks (≈50 minutes) on mainnet.

My fastest Preprod → Preview transfer delivered in **1 minute 52 seconds**. So if you are on testnet and nothing has arrived after ten minutes, something is wrong — do not wait an hour because you saw "~55 min" somewhere.

Which is how I noticed the next thing.

---

## 4. A Compact contract cannot take custody of USDM on Preview today

Privoice was originally designed to pool USDM inside the contract, so amounts could be hidden outright rather than just unlinked. Before writing it, I tested whether that was possible.

I put two circuits in **one contract** — same deploy, same wallet, same DUST state, same block window — differing by a single line:

```compact
export circuit bump(): [] {
  bumps = (bumps + (1 as Uint<64>)) as Uint<64>;
}

export circuit deposit(color: Bytes<32>, amount: Uint<128>): [] {
  receiveUnshielded(disclose(color), disclose(amount));
  deposits = (deposits + (1 as Uint<64>)) as Uint<64>;
}
```

Contract `c755041b16edcde0fb504e8967317d8de0cb2ef6a8593585877cd2a7e9c6e928` on Preview:

| circuit | result |
| --- | --- |
| `bump()` — ledger write only | **ACCEPTED** |
| `deposit()` — ledger write + `receiveUnshielded` | **REJECTED, `Custom(192)`** |

Six attempts, each **rebuilt and re-proved from scratch** rather than resubmitted, all rejected identically, about forty seconds after the control was accepted from the same wallet.

Decoding `1010: Invalid Transaction: Custom error: 192` matters here, so: **`1010` is upstream Substrate and carries no Midnight meaning.** The cause is the inner `u8`. Look it up in `impl From<LedgerApiError> for u8` in `midnight-node/ledger/src/versions/common/types.rs` — not in a blog post, because the mapping changes across ledger versions.

```rust
MalformedError::InputsSignaturesLengthMismatch => 192,
```

`192` sits in a run of four checks that are all specifically about unshielded inputs and outputs: `InputsNotSorted` (189), `OutputsNotSorted` (190), `DuplicateInputs` (191), `InputsSignaturesLengthMismatch` (192).

So Privoice settles at the **application layer** — the contract records that settlement happened and never touches the token. That is a measured constraint, not a design preference, and the README says so with both contract addresses.

Worth knowing if you are designing anything that wants a contract to hold USDM.

---

## 5. Unshielded inputs each need a signature, and forgetting it lands you on 192 too

Related, and the practical version of the above. When you move USDM wallet-to-wallet with the SDK, the recipe must be **signed before it is finalised**:

```ts
const recipe = await facade.transferTransaction(
  [{ type: "unshielded", outputs: [{ amount, type: USDM_TOKEN_COLOR, receiverAddress }] }],
  { shieldedSecretKeys, dustSecretKey },
  { ttl, payFees: true },
);

const signed    = await facade.signRecipe(recipe, (d) => keystore.signData(d));
const finalized = await facade.finalizeRecipe(signed);
const txId      = await facade.submitTransaction(finalized);
```

Skip `signRecipe` and the transaction reaches the node with fewer signatures than inputs — and you get `Custom(192)` again, from a completely different cause than the contract case above. Same code, same error, unrelated bug.

---

## Two smaller ones, for whoever hits them next

**DUST is not automatic.** Holding NIGHT does not generate DUST. It must be **registered**. My wallet and my probe both read zero until I registered, and nothing tells you that is why.

**The DUST wallet syncs separately, and far more slowly.** Most sync helpers wait on `state.unshielded.progress`, which catches up in about a second — then declare success while dust sits at 42 of 183,000 events. A zero DUST balance in that state is correct, not a fault. Wait on `state.dust.progress` explicitly, and save a checkpoint afterwards or you pay the cold sync every run.

---

## What I ended up with

**[Tender](https://github.com/tomiin/tender-usdm)** — eight transfers, both directions, three of them signed in Lace rather than by the service. Enterprise-address derivation and correct explorer links built in.

**[Privoice](https://github.com/tomiin/privoice)** — a Compact contract where only `persistentHash(amount, payer, memo, salt)` goes on chain. The payer proves an invoice names them by reconstructing a commitment that matches, so identity is demonstrated rather than asserted. Deployed on Preview with `issue → acknowledge → pay → settle`, all four accepted.

Both repos have the full working code, the failed experiments, and the addresses to check any of this yourself.

If you are starting on this today: derive the enterprise address, put `0x` on your Midnight hashes, register your NIGHT, and read error codes from `types.rs`. That is most of the day I lost, in one line.
