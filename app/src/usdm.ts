// src/usdm.ts — the USDM payment leg.
//
// THIS FILE IS THE ANSWER TO "is USDM handled by the contract or the
// application layer?"  It is the application layer, and this is the code.
//
// USDM on Midnight is an UNSHIELDED token, named by a 32-byte colour rather
// than a contract address. It cannot be shielded, so the amount of any USDM
// transfer is public. That is a property of the token, not of this design —
// see the README.
//
// Contract custody was tested first and is not available on Preview today: a
// contract call performing `receiveUnshielded` is rejected by the node with
// Custom(192) Malformed(InputsSignaturesLengthMismatch), while an otherwise
// identical call without it is accepted. See ../../probe and
// ../../SERVICEDESK-192.md. So the payment moves wallet-to-wallet here, and
// the contract records only that settlement happened.
//
// The SDK path, all read from the installed type definitions:
//   facade.transferTransaction(outputs, secretKeys, { ttl, payFees })
//     -> UnprovenTransactionRecipe
//   facade.signRecipe(recipe, signSegment)      -> BalancingRecipe
//   facade.finalizeRecipe(recipe)               -> FinalizedTransaction
//   facade.submitTransaction(finalized)         -> TransactionIdentifier

import * as Rx from "rxjs";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { NETWORK_ID } from "./config.js";
import { submitWithRetry } from "./submit.js";

/**
 * USDM's token colour on Midnight PREVIEW, minted by VIA's testnet deployment.
 * Mainnet USDM has a different colour. Verified against the Tender bridge
 * client, which reads live balances under this key.
 */
export const USDM_TOKEN_COLOR =
  "003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73";

/** USDM carries 6 decimal places on every chain it exists on. */
export const USDM_DECIMALS = 6;

const norm = (s: string) => s.replace(/^0x/i, "").toLowerCase();

export function formatUsdm(raw: bigint): string {
  const base = 10n ** BigInt(USDM_DECIMALS);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(USDM_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** USDM held by this wallet, in base units. Zero if the colour is absent. */
export function usdmBalance(state: any): bigint {
  const raw = state?.unshielded?.balances;
  const entries: [string, any][] =
    raw instanceof Map ? [...raw.entries()] : Object.entries(raw ?? {});
  const hit = entries.find(([c]) => norm(String(c)) === norm(USDM_TOKEN_COLOR));
  return hit ? BigInt(hit[1]) : 0n;
}

/** Bech32m form of an UnshieldedAddress, for display. */
export function addressString(addr: any): string {
  try { return MidnightBech32m.encode(NETWORK_ID as any, addr).asString(); }
  catch { /* fall through */ }
  try { return String(addr?.hexString ?? addr); }
  catch { return "<unprintable address>"; }
}

/** Parse a bech32m recipient supplied by the operator. */
export function parseUnshieldedAddress(bech32: string): UnshieldedAddress {
  return MidnightBech32m.parse(bech32.trim())
    .decode(UnshieldedAddress as any, NETWORK_ID as any) as unknown as UnshieldedAddress;
}

export type UsdmPayment = { txId: string; amount: bigint; to: string };

/**
 * Move USDM wallet-to-wallet on Preview and return the transaction id.
 *
 * `amount` is in USDM base units (6 dp), so 125000 is 0.125 USDM.
 */
export async function payUsdm(
  bundle: { facade: any; keystore: any; zswapSecretKeys: any; dustSecretKey: any },
  recipient: UnshieldedAddress,
  amount: bigint,
): Promise<UsdmPayment> {
  const { facade, keystore, zswapSecretKeys, dustSecretKey } = bundle;

  const state: any = await Rx.firstValueFrom(facade.state());
  const held = usdmBalance(state);
  if (held < amount) {
    throw new Error(
      `Not enough USDM: holding ${formatUsdm(held)}, need ${formatUsdm(amount)}.\n` +
      `Bridge USDM to this Preview wallet before settling.`,
    );
  }

  const ttl = new Date(Date.now() + 15 * 60_000);

  const recipe = await facade.transferTransaction(
    [{
      type: "unshielded",
      outputs: [{ amount, type: USDM_TOKEN_COLOR, receiverAddress: recipient }],
    }],
    { shieldedSecretKeys: zswapSecretKeys, dustSecretKey },
    { ttl, payFees: true },
  );

  // Unshielded inputs must each carry a signature. Skipping this is how a
  // transaction reaches the node and is rejected with Custom(192)
  // InputsSignaturesLengthMismatch.
  const signed = await facade.signRecipe(recipe, (data: Uint8Array) => keystore.signData(data));

  const finalized = await facade.finalizeRecipe(signed);
  const txId = await submitWithRetry(facade, finalized);

  return { txId: String(txId), amount, to: addressString(recipient) };
}
