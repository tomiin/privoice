// src/deploy.ts — deploy Privoice on Preview and exercise the full invoice
// lifecycle on chain: issue -> acknowledge -> settle.
//
// Two identities take part, as they would in reality:
//
//   ISSUER  raises the invoice. Their id is public and stable by design.
//   PAYER   acknowledges it, which PROVES they are the party named inside the
//           commitment — they cannot acknowledge an invoice that is not theirs,
//           because the payer id is inside the hash.
//
// Both run from one process here, which a real deployment would not do. The
// identities are still cryptographically separate: each has its own secret key
// and its own private state, and the private state is swapped between calls
// through the private state provider rather than by sharing a key. The demo
// harness is the only thing being collapsed, not the security model.
//
// Run:  npm run deploy

import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as Rx from "rxjs";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { initializeNetwork } from "./netid.js";
import { buildWallet, startAndSync } from "./wallet.js";
import { saveCheckpoint, loadCheckpoint, checkpointPath } from "./checkpoint.js";
import { createProviders, ZK_CONFIG_PATH } from "./providers.js";
import { witnesses, type PrivoicePrivateState } from "./witnesses.js";
import {
  payUsdm, settlementBalance, formatUsdm, addressString, parseUnshieldedAddress,
  SETTLEMENT_TOKEN_COLOR, settlementTokenName, USDM_TOKEN_COLOR, type UsdmPayment,
} from "./usdm.js";

import * as ContractModule from "../managed/contract/index.js";

const CONTRACT_NAME = "Privoice";
const PRIVATE_STATE_ID = "PrivoicePrivateState";

const TENDER_ENV =
  "/Volumes/Seagate/Midnight code /via-usdm-sprint/bridge-service/.env";

// ---- small helpers ---------------------------------------------------------

function isSocketNoise(reason: any): boolean {
  const t = String(reason?.message ?? reason) + " " + String(reason?.cause?.message ?? "");
  return /Normal Closure|disconnected from wss|1000:/i.test(t);
}
process.on("unhandledRejection", (r: any) => {
  if (!isSocketNoise(r)) console.error("Unhandled rejection:", r);
});

function describe(e: any): string {
  const parts: string[] = [];
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.message) parts.push(String(cur.message));
    cur = cur.cause;
  }
  return parts.join("  <-  ") || String(e);
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Deterministic 32-byte demo key, so reruns are reproducible. */
function demoKey(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`privoice:demo:${label}`).digest());
}

function resolveSeed(): Buffer {
  const h = process.env.PRIVOICE_SEED_HEX;
  if (h) {
    if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2) throw new Error("PRIVOICE_SEED_HEX is not valid hex");
    return Buffer.from(h, "hex");
  }
  let mnemonic = process.env.PRIVOICE_MNEMONIC;
  if (!mnemonic) {
    try {
      const env = readFileSync(process.env.TENDER_ENV ?? TENDER_ENV, "utf8");
      const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("MIDNIGHT_MNEMONIC_PREVIEW="));
      if (line) {
        mnemonic = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
        console.log("Using MIDNIGHT_MNEMONIC_PREVIEW from Tender's .env");
      }
    } catch { /* fall through */ }
  }
  if (!mnemonic) {
    throw new Error(
      "No wallet seed. Set PRIVOICE_MNEMONIC, or PRIVOICE_SEED_HEX, or let it read\n" +
      `MIDNIGHT_MNEMONIC_PREVIEW from ${TENDER_ENV}`,
    );
  }
  if (!validateMnemonic(mnemonic)) throw new Error("Mnemonic failed BIP-39 validation");
  return Buffer.from(mnemonicToSeedSync(mnemonic));
}

/**
 * Retry by REBUILDING, never by resubmitting. Error 170 is a stale dust spend:
 * proving takes 30-60s and the dust state moves on underneath it, so the same
 * finalised transaction fails forever while a freshly built one succeeds.
 */
async function withRetries<T>(label: string, build: () => Promise<T>, attempts = 6): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try { return await build(); }
    catch (e: any) {
      last = e;
      const msg = describe(e);
      console.error(`  ${label} attempt ${i}/${attempts} failed: ${msg.slice(0, 200)}`);
      if (i === attempts) break;
      const wait = 3000 + i * 1500;
      console.error(`  rebuilding and re-proving in ${(wait / 1000).toFixed(1)}s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function main() {
  const proofUrl = process.env.PROOF_SERVER ?? "http://localhost:6300";
  try {
    const r = await fetch(proofUrl, { method: "GET" });
    console.log(`Proof server at ${proofUrl} responded ${r.status}.`);
  } catch {
    console.error(
      `\nNo proof server at ${proofUrl}. Proving is local, so nothing deploys without it:\n` +
      `  docker start midnight-proof-server\n`,
    );
    process.exit(4);
  }

  // The compiled module must expose the exported pure circuits so the payer id
  // and the commitment can be computed OFF chain — that is the whole auditor
  // story. Fail loudly rather than silently computing something different.
  const pureCircuits: any = (ContractModule as any).pureCircuits;
  if (!pureCircuits?.partyId || !pureCircuits?.termsCommitment) {
    console.error(
      "\nThe compiled contract does not expose the pure circuits this script needs.\n" +
      "Available exports: " + Object.keys(ContractModule).join(", ") + "\n" +
      (pureCircuits ? "pureCircuits keys: " + Object.keys(pureCircuits).join(", ") + "\n" : ""),
    );
    process.exit(5);
  }

  const seed = resolveSeed();
  initializeNetwork();

  const maxAgeH = Number(process.env.CHECKPOINT_MAX_HOURS ?? "12");
  const cp = loadCheckpoint();
  let useCheckpoint = false;
  if (process.env.FRESH_SYNC === "1") {
    console.log("FRESH_SYNC=1 — ignoring any checkpoint.");
  } else if (cp) {
    const ageH = (Date.now() - cp.savedAt) / 3_600_000;
    if (ageH <= maxAgeH) { useCheckpoint = true; console.log(`Restoring checkpoint from ${ageH.toFixed(1)}h ago.`); }
    else console.log(`Checkpoint is ${ageH.toFixed(1)}h old (limit ${maxAgeH}h) — ignoring it.`);
  }

  const bundle = await buildWallet(seed, { useCheckpoint });
  console.log("Syncing wallet against Preview…");
  await startAndSync(bundle);

  // The DUST wallet syncs SEPARATELY and is the slow part. A restored
  // checkpoint reports isConnected:false with a total of 0 — it knows its own
  // numbers but not where the tip is, and spending in that state produces a
  // stale dust proof and error 170 forever. Gate on real liveness.
  async function dustProgress() {
    const st: any = await Rx.firstValueFrom(bundle.facade.state());
    const p = st?.dust?.progress ?? {};
    const applied = BigInt(p.appliedIndex ?? 0);
    const total = BigInt(p.highestRelevantWalletIndex ?? 0);
    const connected = Boolean(p.isConnected) && Boolean(st?.unshielded?.progress?.isConnected);
    let balance = 0n;
    const cb = st?.dust?.capabilities?.coinsAndBalances;
    if (cb?.getWalletBalance) { try { balance = BigInt(await cb.getWalletBalance(st.dust.state, new Date())); } catch {} }
    return { applied, total, balance, live: connected && total > 0n && applied >= total };
  }

  let prog = await dustProgress();
  const deadline = Date.now() + Number(process.env.DUST_WAIT_MINUTES ?? "90") * 60_000;
  while (prog.balance === 0n && Date.now() < deadline) {
    console.log(`  dust ${prog.applied}/${prog.total} — waiting for a spendable balance…`);
    await new Promise((r) => setTimeout(r, 60_000));
    prog = await dustProgress();
  }
  if (prog.balance === 0n) { console.error("No DUST. Register NIGHT, or let the cold sync finish."); await bundle.facade.stop(); process.exit(3); }
  console.log(`DUST available: ${prog.balance / 10n ** 15n}`);

  if (!prog.live) {
    console.log("Reconnecting and catching up to the chain tip…");
    const t0 = Date.now();
    while (!prog.live && Date.now() - t0 < 10 * 60_000) {
      await new Promise((r) => setTimeout(r, 5_000));
      prog = await dustProgress();
      if (prog.total > 0n) process.stdout.write(`\r  dust ${prog.applied}/${prog.total}${prog.live ? " — live" : ""}   `);
    }
    process.stdout.write("\n");
    if (!prog.live) throw new Error("Wallet never reported live; spending now would fail with 170.");
  }
  console.log("Wallet is live against the chain tip.\n");
  try { await saveCheckpoint(bundle.facade, Number(prog.applied)); console.log(`Checkpoint saved to ${checkpointPath()}\n`); } catch {}

  // ---- The two identities and the invoice --------------------------------

  const issuerSk = demoKey("issuer");
  const payerSk  = demoKey("payer");

  // The payer's party id is shared with the issuer the way an account number
  // is — computed off chain from the payer's own key, never published.
  const payerPartyId: Uint8Array = pureCircuits.partyId(payerSk);

  const invoiceId = new Uint8Array(randomBytes(32));      // public: the invoice number
  const amount    = BigInt(process.env.PRIVOICE_AMOUNT ?? "125000");  // private
  const memo      = new Uint8Array(createHash("sha256").update("40h consulting, Aug 2026").digest());
  const salt      = new Uint8Array(randomBytes(32));      // private

  const terms = { amount, payer: payerPartyId, memo, salt };
  const expectedCommitment: Uint8Array =
    pureCircuits.termsCommitment(amount, payerPartyId, memo, salt);

  const issuerState: PrivoicePrivateState = { secretKey: issuerSk, ...terms };
  const payerState:  PrivoicePrivateState = { secretKey: payerSk,  ...terms };

  console.log("--- invoice -------------------------------------------------");
  console.log("id (public)        :", hex(invoiceId));
  console.log("amount (PRIVATE)   :", amount.toString());
  console.log("payer id (PRIVATE) :", hex(payerPartyId));
  console.log("commitment         :", hex(expectedCommitment));
  console.log("-------------------------------------------------------------\n");

  const compiledContract = (CompiledContract.make(CONTRACT_NAME, (ContractModule as any).Contract) as any).pipe(
    (CompiledContract as any).withWitnesses(witnesses),
    (CompiledContract as any).withCompiledFileAssets(ZK_CONFIG_PATH),
  );

  const providers = await createProviders(
    bundle.facade, bundle.zswapSecretKeys, bundle.dustSecretKey, bundle.keystore,
    "privoice-preview",
  );

  console.log(`Deploying ${CONTRACT_NAME} to Preview…`);
  const deployed: any = await withRetries("deploy", () =>
    deployContract(providers, {
      compiledContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: issuerState,
    } as any),
  );
  const address = deployed.deployTxData.public.contractAddress;
  console.log("✅ deployed at", address, "\n");

  const asIdentity = async (who: string, state: PrivoicePrivateState) => {
    providers.privateStateProvider.setContractAddress(address);
    await providers.privateStateProvider.set(PRIVATE_STATE_ID, state);
    console.log(`  (acting as ${who})`);
  };

  console.log("1/4  issue — the issuer publishes only a commitment");
  await asIdentity("ISSUER", issuerState);
  await withRetries("issue", () => deployed.callTx.issue(invoiceId));
  console.log("     ✅ issued\n");

  console.log("2/4  acknowledge — the payer proves the invoice names them");
  await asIdentity("PAYER", payerState);
  await withRetries("acknowledge", () => deployed.callTx.acknowledge(invoiceId));
  console.log("     ✅ acknowledged\n");

  console.log("3/4  pay — USDM moves wallet-to-wallet, at the application layer");
  console.log("     USDM is unshielded and cannot be shielded, so this amount");
  console.log("     is public. Contract custody is rejected on Preview today");
  console.log("     with Custom(192) — see probe/ and SERVICEDESK-192.md.\n");

  const payState: any = await Rx.firstValueFrom(bundle.facade.state());
  const held = settlementBalance(payState);
  const tokenName = settlementTokenName();
  const payeeEnv = process.env.PRIVOICE_PAYEE;
  const recipient: any = payeeEnv
    ? parseUnshieldedAddress(payeeEnv)
    : payState?.unshielded?.address;

  console.log("     token        :", tokenName);
  console.log("     token colour :", SETTLEMENT_TOKEN_COLOR);
  if (tokenName !== "USDM") {
    console.log("     ⚠ NOT USDM — USDM's colour is", USDM_TOKEN_COLOR);
    console.log("       (set PRIVOICE_TOKEN_COLOR to change; unset = USDM)");
  }
  console.log("     wallet holds :", formatUsdm(held), tokenName);
  console.log("     paying       :", formatUsdm(amount), tokenName);
  console.log("     to           :", addressString(recipient));
  if (!payeeEnv) console.log("     (self-transfer; set PRIVOICE_PAYEE to pay another address)");

  let payment: UsdmPayment | null = null;
  if (held >= amount) {
    payment = await withRetries("usdm payment", () => payUsdm(bundle, recipient, amount));
    console.log(`     ✅ ${tokenName} sent, tx`, payment.txId, "\n");
  } else {
    console.log(
      `\n     ⚠️  SKIPPED — this wallet holds no ${tokenName} on Preview.\n` +
      "     The contract lifecycle still completes below, but the payment leg\n" +
      "     did not happen, so this run does NOT demonstrate USDM as the\n" +
      "     payment asset. Bridge USDM to this wallet and run again.\n",
    );
  }

  console.log("4/4  settle — the issuer records payment received");
  await asIdentity("ISSUER", issuerState);
  await withRetries("settle", () => deployed.callTx.settle(invoiceId));
  console.log("     ✅ settled\n");

  console.log("================= PRIVOICE: LIFECYCLE COMPLETE =================");
  console.log("network      : Preview");
  console.log("contract     : ", address);
  console.log("invoice id   : ", hex(invoiceId));
  console.log("commitment   : ", hex(expectedCommitment));
  console.log("settlement   : ", payment
    ? `${formatUsdm(payment.amount)} ${tokenName}, tx ${payment.txId}`
    : `NOT MADE (no ${tokenName} in wallet)`);
  if (payment && tokenName !== "USDM") {
    console.log();
    console.log("NOTE: the settlement above moved " + tokenName + ", not USDM.");
    console.log("USDM is minted on Midnight only by VIA's cross-chain gateway,");
    console.log("which was not delivering on Preview when this was run. The");
    console.log("transfer code is identical for USDM — only the token colour");
    console.log("differs. See the README.");
  }
  console.log();
  console.log("On chain      : the id, the commitment, the issuer id, and the");
  console.log("                fact that it was acknowledged and settled.");
  console.log("Never on chain: the amount, the payer's identity, the memo, the salt.");
  console.log();
  console.log("An auditor handed the invoice document recomputes");
  console.log("termsCommitment(amount, payer, memo, salt) and compares it to the");
  console.log("commitment above. It matches only for the genuine terms.");

  await bundle.facade.stop();
}

main().catch((e) => { console.error(describe(e)); process.exit(1); });
