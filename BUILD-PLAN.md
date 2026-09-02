# Privoice — build plan

**A private invoice contract. The amount and the counterparty stay private;
settlement is public and provable.**

VIA Labs sprint, **Quest 10, 200 XP** — the largest single award in the sprint.
Midnight **Preview** (not Preprod). Written 2026-08-29, before any code.

> Lives at `Midnight code /Privoice/`, deliberately **outside**
> `via-usdm-sprint/` — that folder is the `tender-usdm` git repo, and the quest
> requires a repo different from the Quest 9 submission.

---

## 1. The thesis

USDM arrives on Midnight in the **unshielded** pool and cannot be shielded.
Established while building Tender: the wallet SDK exposes no pool-transfer
operation, and VIA's own gateway implements only `bridge`, `process` and admin
calls.

So on a privacy chain, **every USDM amount and every counterparty is public**.

That is the gap. An invoice settled in USDM today publishes your pricing to
your competitors and your customer list to anyone watching the chain. For a
supplier bidding against three others, that is a commercial injury, not a
theoretical one.

Privoice closes the part of that gap which can honestly be closed.

## 2. What is actually private — the honest boundary

This section is written first, deliberately. Getting it wrong and discovering
it late would waste the whole build, and stating the boundary plainly is the
register that got the enterprise-address and checkRoot write-ups accepted.

**USDM transfers are public. The transferred amount is therefore visible.**
No contract can hide a number that is already in the clear on the chain. Any
design claiming otherwise is lying.

What Privoice *can* keep private:

| private | how |
| --- | --- |
| the invoice terms before settlement | only a commitment is published |
| the counterparty relationship | parties are pseudonyms derived by hashing, never addresses |
| line items, memo, due date, penalties | never leave the issuer's machine |
| **which** invoice a given payment settles | settlement proves a match without naming the invoice |
| unsettled invoices, permanently | an invoice never settled reveals nothing but its existence |

What is public, and must be:

- that an invoice exists, and its commitment
- that invoice *N* has been settled
- the USDM transfer itself, including its amount
- issuer and settlement nullifiers

**The residual leak, stated plainly:** an observer who sees a USDM transfer of
exactly *X* in the same block as a settlement can infer that invoice's amount.
Mitigations, in increasing order of effort: settle in a separate transaction
from the transfer; let one payment settle several invoices; pay in standard
denominations. Document the leak rather than pretending it away — a reviewer
who finds an unstated leak assumes there are others.

## 3. The architecture fork — VERIFY BEFORE WRITING ANY CONTRACT

**Can a Compact contract custody an unshielded token?**

VIA's developer docs say receiving tokens into the contract *is* the burn, and
their own client does exactly that on Preview — so it should work. But Midnight's
own servicedesk issue **#117** (filed 2026-07-28 by faculerena, P2 High, still
open) reports `receiveUnshielded` **rejected by the node** with
`FeeCalculation(OutsideTimeToDismiss)`. The contract deploys; the *call* fails.
Their minimal repro:

```compact
pragma language_version >= 0.25.0;
import CompactStandardLibrary;

export ledger deposits: Uint<64>;
constructor() { deposits = 0 as Uint<64>; }

export circuit deposit(color: Bytes<32>, amount: Uint<128>): [] {
  receiveUnshielded(disclose(color), disclose(amount));
  deposits = (deposits + (1 as Uint<64>)) as Uint<64>;
}
```

Repo: `github.com/midnames/bug-reports/tree/main/unshielded-tx-fail-stagenet`

Reported on **stagenet**, node 2.0.0-rc.4, compactc 0.33.0-rc.2. **Nobody has
reported whether it still bites on Preview with the current toolchain.** Run
that exact repro first. Either result is useful: it unblocks contract custody,
or it is a fresh data point on an open Midnight-filed bug and a legitimate
reason to settle at the application layer.

Note the pragma needs language ≥ 0.25.0, which Jay's compactc 0.31.1 will not
accept — so the toolchain upgrade comes first regardless.

**Design A — contract custody** (if the repro passes). The contract receives
USDM, holds it, releases to the issuer on settlement. True escrow.

**Design B — application-layer settlement** (if it fails). The payer transfers
USDM directly; the contract verifies the payment matches the commitment and
marks the invoice settled. The contract never touches the token.

**Design C — pooled deposits with committed balances.** The design that
actually delivers the quest's claim, and the one to aim for if the repro passes.

Designs A and B both leak the amount, because in each the settling transfer is
a USDM movement of exactly the invoice sum. The way out is to **decouple the
payment from the settlement**:

1. A payer deposits USDM into the contract whenever they like, in whatever
   amounts they like. These deposits are public — they are USDM transfers, and
   nothing can change that. But they are **pooled and unlinked** from any
   particular invoice.
2. The contract holds each payer's balance as a **commitment**, not a public
   integer.
3. Settling an invoice is then a commitment-to-commitment operation: prove in
   zero knowledge that the balance is at least the invoice amount, debit it,
   and mark the invoice settled — **without disclosing either number**.

Under this design the invoice amount never appears on chain at all. An observer
sees deposits going in over time and invoices being marked settled, and cannot
match one to the other. That is genuinely *"the amount and counterparty remain
private while settlement is public"*, not a softened version of it.

**Cost, stated honestly.** It needs contract custody of an unshielded token
(so §3's repro is decisive), a committed-balance representation with a
range-proof style comparison, and careful handling of the balance-update
nullifier so a balance cannot be double-spent. Materially more work than B, and
the strongest possible answer if it lands. **Verify the repro first, then
decide** — do not start C on the assumption that custody works.

The quest asks the README to explain *"whether USDM is handled by the contract
or application layer"* — which reads as the graders knowing custody may be
unavailable and accepting either, provided it is explained.

## 3b. Ecosystem intel, 2026-08-29 — and why it does not block us

From a community answer to the **TacitPay** team, who are building *private
invoicing* on Preview for Buildathon Wave 1. Same product idea, different
programme. Treat the specifics below as leads, not facts — but the version
numbers check out against npm, so the source is credible.

**Their blocker: shielded tNIGHT cannot be obtained on Preview today.**
- The faucet dispenses **unshielded** tNIGHT; Lace 4.0.1 has no shield UI.
- `WalletFacade.initSwap` drops the counter-leg on **mixed** shielded/unshielded
  swaps, so the shielded output is silently never built
  (servicedesk #99, midnight-wallet #554).
- Fixed in midnight-wallet **PR #615**, merged 18 Aug — **not in stable**.
  Verified on npm 2026-08-29: `latest` is **1.1.0**; `canary` is
  **1.2.1-canary.20260821172758-6e1050e**; there is also `beta: 2.0.0-beta.2`.
- Shielded *kernel* ops (`receiveShielded`, `mintShieldedToken`) are separately
  reported failing with proof-server 400 on Preprod.

**Why Privoice is unaffected.** Privoice never touches a shielded coin. USDM
arrives on Midnight unshielded and cannot be shielded, so privacy here comes
from **commitments in contract state**, not from shielded coins. Designs A, B
and C all hold. If anything this is an argument *for* the Design C approach:
it achieves amount privacy without needing a shielding primitive that does not
currently work.

It does raise the stakes on §3 though. The shielded/unshielded boundary is
visibly shaky across the stack right now, so run the `receiveUnshielded` repro
before committing to contract custody rather than assuming it works.

**Other useful bits from the same answer, unverified:**
- Error **199 = `InvariantViolation`**, not `AllCommitmentsSubsetCheckFailure`
  (that is **213** on node 2.0+). Worth confirming if we hit either.
- **`testnet-02` is retired** — only `preview` and `preprod` exist.
- Preprod first sync can take 40–60 min over ~500k events; `batchUpdates: 5000`
  in the facade config is the reported mitigation. (Our own cold sync ran
  575,721 transactions in ~1s once the stale checkpoint was removed, so this
  may be Lace-specific.)
- **Fallback for demos:** local devnet (`undeployed`) via
  `github.com/midnightntwrk/midnight-local-dev` — pre-funded genesis wallet.
  Useful if Preview misbehaves, though Quest 10 requires a **Preview**
  deployment, so this is a development aid only, not a submission path.

**Preview endpoints** (we will need these; confirm before use):
```
node     https://rpc.preview.midnight.network
indexer  https://indexer.preview.midnight.network/api/v4/graphql
ws       wss://indexer.preview.midnight.network/api/v4/graphql/ws
proof    http://localhost:6300  (or proof-server.preview.midnight.network)
```

## 4. Contract sketch

Not final. Written to be checked against the compiler, not trusted.

**Public ledger**
- `invoices: Map<Bytes<32>, Bytes<32>>` — invoice id → terms commitment
- `settled: Set<Bytes<32>>` — settlement nullifiers, the double-settle guard
- `issuerOf: Map<Bytes<32>, Bytes<32>>` — invoice id → issuer nullifier
- `invoiceCount: Uint<64>`

**Private witnesses**
- `localSecretKey()` — the caller's identity key
- `localAmount()`, `localSalt()`, `localCounterparty()` — the invoice terms

**Circuits**
- `issueInvoice()` — publishes a commitment; no terms disclosed
- `settleInvoice()` — recomputes the commitment from re-supplied terms, checks
  it matches, inserts a settlement nullifier
- `isSettled(id)` — public read

**Non-negotiables, all learned the hard way on earlier contracts**
- **Domain-separate every hash.** Distinct tags per role:
  `privoice:v1:issuer`, `privoice:v1:payer`, `privoice:v1:terms`,
  `privoice:v1:settle`. Same key must never yield the same value in two roles.
- **Bind nullifiers to the invoice**, not just the key. The sealed-bid contract
  derives `bidNullifier(sk)` from the tag and key alone, so one bidder produces
  the same nullifier in every deployment and can be tracked across auctions.
  Do not repeat that here — mix in the invoice id.
- **Never use `ownPublicKey()` for roles.** VIA's docs say it outright: it is
  not a `msg.sender` and is unrelated to stored identities. Prove roles by key
  derivation.
- **Assert on `checkRoot` immediately**, never store its result and branch on it.
- **Export the derivation circuits as `pure`** so tests exercise the real thing
  rather than a hand-written TypeScript mirror of `persistentHash`.
- A witness-supplied Merkle path carries its own leaf — if a tree is used
  anywhere, bind the leaf.

## 5. Build order

1. **Toolchain — contained to this project, nothing global.**

   Other projects pin older compilers (sealed-bid CI pins 0.31.0, Kuira pins
   0.31.0, this Mac's default is 0.31.1). A global `compact update` would move
   the default under all of them. Do not do that. Instead:

   ```sh
   compact list --installed          # what is already here
   compact list                      # is 0.34.0 available to the current CLI?
   compact update --no-set-default 0.34.0
   ```

   `--no-set-default` downloads the compiler **without** changing the global
   default. Then compile Privoice with an explicit version prefix every time:

   ```sh
   compact compile +0.34.0 contracts/privoice.compact src/managed
   ```

   The `+VERSION` prefix requires full semver. Verify the isolation held:

   ```sh
   compact compile --version         # should still report 0.31.1
   compact compile +0.34.0 --version # should report 0.34.0
   ```

   **Do NOT run `compact self update`.** That upgrades the CLI tool itself and
   is global — the CLI and the compiler version independently. Only consider it
   if `compact list` cannot see 0.34.0 at all.

   Pin `+0.34.0` in the project's own scripts and in CI, and record the pin in
   the README so a reviewer can reproduce the build exactly.

   For total isolation `COMPACT_DIRECTORY` / `--directory` would put the
   compilers inside the project folder, but that re-downloads the toolchain per
   project for no real benefit here.
2. **Run the #117 repro on Preview.** This decides Design A vs B. Do not skip.
3. **Write the contract**, then compile *and execute* — compilation alone
   proves nothing. Verify with `/midnight-verify`.
4. **Witnesses + tests.** Simulator-backed, minimum three passing, ideally more.
5. **Deploy on Preview**, then make **at least one successful circuit call
   after deployment** — a hard requirement. Watch for error 170: rebuild the
   transaction on each retry, never resubmit a finalised one. And do not rely
   on a stale wallet checkpoint; that cost an hour on the L4 deploy.
6. **Interface.** Web, reusing what already works from Tender: the CIP-30 and
   DApp Connector wiring, the preflight checks, the honest empty and error
   states.
7. **README.** Built on Midnight · deployed contract address matching the
   submitted one · **whether USDM is handled by the contract or the application
   layer, with links to the exact code** · the privacy boundary from §2,
   including the residual leak · setup instructions someone can actually follow.
8. **Topics** `midnightntwrk` and `compact`. Signed commits.

## 6. Submission checklist

- [ ] Public repo, separate from `tender-usdm`, structured so others can run it
- [ ] Topics `midnightntwrk` + `compact`
- [ ] README states it was built on Midnight
- [ ] Original Compact contract, not a fork
- [ ] Deployed on **Preview**, with ≥1 successful interaction *after* deploy
- [ ] Contract address in the README, matching the submitted address
- [ ] Usable web interface or CLI
- [ ] USDM as the payment asset
- [ ] README explains contract-layer vs application-layer USDM, with code links

Form: URL (repo) + Text (contract address).

## 7. Open questions

- Does the #117 rejection still occur on Preview with the current toolchain?
- Does VIA's pinned SDK set clash with the installed stack? Their docs list
  `compact-runtime` 0.15.0 and `onchain-runtime-v2` 2.0.1; Jay is on
  `compact-runtime` 0.16.0. Check before building.
- `compact-js` **2.5.3 is uninstallable** — it depends on
  `@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`, and that package has only ever
  published `1.0.0-rc.3` and `1.0.0-rc.4`. Stay on 2.5.1.
- Can settlement and transfer be decoupled enough to blunt the amount
  correlation, or is that honestly out of scope for the MVP?
