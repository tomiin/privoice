// src/probe.ts — does a Compact contract's `receiveUnshielded` call actually
// land on PREVIEW today?
//
// This is a controlled reproduction of Midnight servicedesk #117, filed by
// faculerena on 2026-07-28 (P2, still open). They reported, on STAGENET with
// node 2.0.0-rc.4 / compactc 0.33.0-rc.2:
//
//   * the contract DEPLOYS fine
//   * CALLING the circuit is rejected by the node
//     -> Malformed(FeeCalculation(OutsideTimeToDismiss))
//
// Nobody has reported whether that still happens on PREVIEW with a current
// toolchain. We compiled their exact contract on 0.34.0 and it built clean
// (k=9, rows=496), so this is purely about submission.
//
// The answer decides Privoice's architecture:
//   call succeeds -> the contract can custody an unshielded token, so pooled
//                    deposits with committed balances are on (amounts hidden)
//   call rejected -> settlement moves to the application layer, and we cite an
//                    open Midnight-filed bug as the reason
//
// Run (reads the mnemonic straight out of Tender's .env, so no secret is
// ever copied or pasted):
//   npm run probe
//
// Override with PROBE_MNEMONIC or PROBE_SEED_HEX if you want a different
// wallet. Whichever you use must be a PREVIEW wallet holding NIGHT with DUST
// accrued.

import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import * as Rx from "rxjs";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { initializeNetwork } from "./netid.js";
import { buildWallet, startAndSync } from "./wallet.js";
import { saveCheckpoint, loadCheckpoint, checkpointPath } from "./checkpoint.js";
import { createProviders, ZK_CONFIG_PATH } from "./providers.js";

import { Contract } from "../managed/contract/index.js";

const CONTRACT_NAME = "Unshielded";

/**
 * Native tNIGHT's token colour is 32 zero bytes — the same key Tender reads
 * balances under (`'00'.repeat(32)`). Using NIGHT rather than USDM keeps the
 * probe self-contained: no bridge round-trip just to answer the question.
 * Override with PROBE_COLOR_HEX to test a specific token instead.
 */
const COLOR_HEX = process.env.PROBE_COLOR_HEX ?? "00".repeat(32);
const AMOUNT = BigInt(process.env.PROBE_AMOUNT ?? "1");

/** Preview's node websocket drops mid-submit; that noise is not our answer. */
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

/**
 * The Preview wallet seed.
 *
 * VIA's own wallet code takes a BIP-39 mnemonic and runs it through
 * `mnemonicToSeedSync`, producing a 64-byte seed — NOT a 32-byte one. Our
 * `keys.ts` feeds whatever it gets to the same `HDWallet.fromSeed`, so the two
 * must agree or the derived keys are silently for a different wallet.
 *
 * Resolution order: PROBE_MNEMONIC, then PROBE_SEED_HEX, then
 * MIDNIGHT_MNEMONIC_PREVIEW read out of Tender's .env.
 */
const TENDER_ENV =
  "/Volumes/Seagate/Midnight code /via-usdm-sprint/bridge-service/.env";

function resolveSeed(): Buffer {
  const hex = process.env.PROBE_SEED_HEX;
  if (hex) {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2)
      throw new Error("PROBE_SEED_HEX is not valid hex");
    return Buffer.from(hex, "hex");
  }

  let mnemonic = process.env.PROBE_MNEMONIC;
  if (!mnemonic) {
    try {
      const env = readFileSync(process.env.TENDER_ENV ?? TENDER_ENV, "utf8");
      const line = env
        .split(/\r?\n/)
        .find((l) => l.trim().startsWith("MIDNIGHT_MNEMONIC_PREVIEW="));
      if (line) {
        mnemonic = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
        console.log("Using MIDNIGHT_MNEMONIC_PREVIEW from Tender's .env");
      }
    } catch {
      /* fall through to the error below */
    }
  }

  if (!mnemonic) {
    throw new Error(
      "No wallet seed found. Either:\n" +
      "  - let it read Tender's .env (MIDNIGHT_MNEMONIC_PREVIEW), or\n" +
      "  - set PROBE_MNEMONIC='word word ...', or\n" +
      "  - set PROBE_SEED_HEX=<hex>\n" +
      `Looked for the .env at: ${TENDER_ENV}`,
    );
  }
  if (!validateMnemonic(mnemonic)) throw new Error("Mnemonic failed BIP-39 validation");
  return Buffer.from(mnemonicToSeedSync(mnemonic));
}

/**
 * Retry by REBUILDING, never by resubmitting.
 *
 * Error 170 is InvalidDustSpendProof. Proving takes 30-60 seconds, and the
 * dust state moves on while it runs, so by submission time the proof refers to
 * a spend that is no longer current. Resubmitting the same finalised
 * transaction therefore fails forever — the fix is to build and prove it again
 * from scratch each attempt.
 *
 * (There is a second, different cause of 170: a corrupted local dust state.
 * The tell is whether the error's indices move between attempts. If they do
 * not, the wallet is the problem and no amount of rebuilding helps.)
 */
async function withRetries<T>(label: string, build: () => Promise<T>, attempts = 6): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await build();
    } catch (e: any) {
      last = e;
      const msg = describe(e);
      const dusty = /170|dust/i.test(msg);
      console.error(`  ${label} attempt ${i}/${attempts} failed: ${dusty ? "stale dust" : msg}`);
      if (i === attempts) break;
      const wait = 3000 + i * 1500;
      console.error(`  rebuilding and re-proving in ${(wait / 1000).toFixed(1)}s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function main() {
  // Proving is LOCAL and happens before anything reaches the network, so a
  // missing proof server surfaces as "Failed to prove transaction" with no
  // hint of the cause. Check it up front instead.
  const proofUrl = process.env.PROOF_SERVER ?? "http://localhost:6300";
  try {
    const r = await fetch(proofUrl, { method: "GET" });
    console.log(`Proof server at ${proofUrl} responded ${r.status}.`);
  } catch (e: any) {
    console.error(
      `\nNo proof server at ${proofUrl}.\n\n` +
      `Proving runs locally, so nothing can be deployed without it:\n` +
      `  docker run -d --name midnight-proof-server -p 6300:6300 \\\n` +
      `    midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v\n\n` +
      `Already created once?  docker start midnight-proof-server\n` +
      `Using a hosted prover?  set PROOF_SERVER=<url>\n`,
    );
    process.exit(4);
  }

  const seed = resolveSeed();

  initializeNetwork();

  // No checkpoint. A stale one cost an hour on the L4 deploy: the dust tree
  // could not absorb current events and every retry failed identically.
  // Use the checkpoint when it is FRESH.
  //
  // Two failure modes, and we need to dodge both. A stale checkpoint poisons
  // the dust tree — an 18-July one produced "values inserted non-linearly into
  // dust generation tree", identically on every retry. But refusing all
  // checkpoints means re-paying the ~10 minute cold sync every run, which is
  // what has been happening since we started saving them.
  //
  // So: accept a checkpoint younger than CHECKPOINT_MAX_HOURS (default 12),
  // and ignore anything older. FRESH_SYNC=1 forces a cold sync.
  const maxAgeH = Number(process.env.CHECKPOINT_MAX_HOURS ?? "12");
  const cp = loadCheckpoint();
  let useCheckpoint = false;
  if (process.env.FRESH_SYNC === "1") {
    console.log("FRESH_SYNC=1 — ignoring any checkpoint.");
  } else if (cp) {
    const ageH = (Date.now() - cp.savedAt) / 3_600_000;
    if (ageH <= maxAgeH) {
      useCheckpoint = true;
      console.log(`Restoring checkpoint from ${ageH.toFixed(1)}h ago — skipping the cold sync.`);
    } else {
      console.log(
        `Checkpoint is ${ageH.toFixed(1)}h old (limit ${maxAgeH}h) — ignoring it.\n` +
        `A stale one corrupts the dust tree rather than merely being useless.`,
      );
    }
  }

  const bundle = await buildWallet(seed, { useCheckpoint });
  console.log("Syncing wallet against Preview…");
  await startAndSync(bundle);

  // ---- Diagnostic: what does the wallet actually look like? ---------------
  // Lace reports 11,000 tNIGHT and ~49,720 tDUST for this seed while this
  // process reported 0 DUST, so the balance is real and we are reading it
  // wrongly. Dump the shape rather than guess at it again.
  try {
    const st: any = await Rx.firstValueFrom(bundle.facade.state());

    const J = (v: any): string => {
      try {
        return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
      } catch (e: any) {
        return `[unserialisable: ${e?.message ?? e}]`;
      }
    };

    const str = (v: any): string => {
      if (v == null) return String(v);
      if (typeof v === "string") return v;
      for (const m of ["toBech32", "toString", "asString", "toHexString"]) {
        try { const r = v[m]?.(); if (typeof r === "string" && r.length > 8) return r; } catch {}
      }
      return `[${typeof v}: ${Object.keys(v).slice(0, 6).join(",")}]`;
    };

    console.log("\n--- wallet ---");
    console.log("state keys      :", Object.keys(st).join(", "));
    console.log("address         :", str(st?.unshielded?.address));

    const raw = st?.unshielded?.balances;
    const entries = raw instanceof Map ? Object.fromEntries(raw) : (raw ?? {});
    for (const [k, v] of Object.entries(entries)) {
      console.log(`unshielded      : ${k.slice(0, 16)}…  ${v}`);
    }
    console.log("unshielded prog :", J(st?.unshielded?.progress ?? null));

    console.log("\n--- dust ---");
    const d = st?.dust;
    if (!d) {
      console.log("state.dust is", d, "— the dust wallet is not on the facade state at all.");
    } else {
      console.log("dust keys       :", Object.keys(d).join(", "));
      console.log("dust progress   :", J(d.progress ?? null));
      console.log("dust.state keys :", d.state ? Object.keys(d.state).slice(0, 12).join(", ") : String(d.state));
      const cap = d.capabilities;
      console.log("capabilities    :", cap ? Object.keys(cap).join(", ") : String(cap));
      const cb = cap?.coinsAndBalances;
      console.log("coinsAndBalances:", cb ? Object.keys(cb).join(", ") : String(cb));
      if (cb?.getWalletBalance) {
        try {
          const bal = await cb.getWalletBalance(d.state, new Date());
          console.log("getWalletBalance:", String(bal));
        } catch (e: any) {
          console.log("getWalletBalance threw:", describe(e));
        }
      }
      if (cb?.getAvailableCoinsWithGeneratedDust) {
        try {
          const coins = await cb.getAvailableCoinsWithGeneratedDust(d.state, new Date());
          console.log("dust coins      :", Array.isArray(coins) ? coins.length : typeof coins);
        } catch (e: any) {
          console.log("getAvailableCoins threw:", describe(e));
        }
      }
    }
    console.log("--------------\n");
  } catch (e: any) {
    console.log("(could not read wallet state:", describe(e), ")\n");
  }

  // ---- Wait for the DUST wallet to sync -----------------------------------
  //
  // `startAndSync` only waits on state.unshielded.progress, which catches up in
  // about a second. The DUST wallet syncs SEPARATELY and is the slow part —
  // its own progress is state.dust.progress, and on a cold start it reads
  // something like appliedIndex 42 of highestRelevantWalletIndex 183,335.
  //
  // A zero balance in that state is correct, not a bug. So report the real
  // progress and an ETA rather than a row of anonymous dots, and once it is
  // synced SAVE A CHECKPOINT so this is a one-time cost. `saveCheckpoint()`
  // has always existed here and was never called, which is why every run paid
  // the full cold sync.
  async function dustProgress(): Promise<{
    applied: bigint; total: bigint; balance: bigint; live: boolean;
  }> {
    const st: any = await Rx.firstValueFrom(bundle.facade.state());
    const p = st?.dust?.progress ?? {};
    const applied = BigInt(p.appliedIndex ?? 0);
    const total = BigInt(p.highestRelevantWalletIndex ?? 0);
    // A restored checkpoint reports isConnected:false and total 0 — it knows
    // its own numbers but not where the chain tip is. Spending in that state
    // produces a stale dust proof and error 170 on every attempt, which is
    // exactly what a fresh-looking balance hides.
    const connected = Boolean(p.isConnected) &&
      Boolean(st?.unshielded?.progress?.isConnected);
    let balance = 0n;
    const cb = st?.dust?.capabilities?.coinsAndBalances;
    if (cb?.getWalletBalance) {
      try { balance = BigInt(await cb.getWalletBalance(st.dust.state, new Date())); } catch {}
    }
    const live = connected && total > 0n && applied >= total;
    return { applied, total, balance, live };
  }

  /**
   * Wait until the wallet is genuinely caught up with the live chain, not
   * merely restored. Requires isConnected on both wallets and the dust index
   * to have reached the reported tip.
   */
  async function waitUntilLive(maxMs = 10 * 60_000): Promise<void> {
    const started = Date.now();
    let { applied, total, live } = await dustProgress();
    if (live) return;
    console.log("Reconnecting and catching up to the chain tip…");
    while (!live && Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 5_000));
      ({ applied, total, live } = await dustProgress());
      if (total > 0n) {
        process.stdout.write(`\r  dust ${applied}/${total}${live ? " — live" : ""}   `);
      }
    }
    process.stdout.write("\n");
    if (!live) {
      throw new Error(
        "Wallet never reported a live connection. Spending now would build a " +
        "stale dust proof and fail with error 170 on every retry.",
      );
    }
  }

  const waitMin = Number(process.env.DUST_WAIT_MINUTES ?? "90");
  if (waitMin > 0) {
    let { applied, total, balance } = await dustProgress();

    if (balance === 0n) {
      console.log(
        `\nThe DUST wallet is cold-syncing: ${applied} of ${total} events.\n` +
        `Its balance reads 0 until that finishes, which is correct rather than\n` +
        `a fault. Waiting up to ${waitMin} minutes and reporting the rate.\n`,
      );
    }

    const startedAt = Date.now();
    const startApplied = applied;
    const deadline = startedAt + waitMin * 60_000;

    while (balance === 0n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60_000));
      ({ applied, total, balance } = await dustProgress());

      const mins = (Date.now() - startedAt) / 60_000;
      const rate = Number(applied - startApplied) / Math.max(mins, 0.01);
      const left = Number(total - applied);
      const eta =
        rate > 1
          ? `~${Math.ceil(left / rate)} min remaining at this rate`
          : "rate too low to estimate";
      console.log(
        `  ${applied}/${total} dust events  ·  ${rate.toFixed(0)}/min  ·  ${eta}`,
      );
    }

    if (balance === 0n) {
      console.error(
        `\nStill no DUST after ${waitMin} minutes — reached ${applied} of ${total}.\n` +
        `The wallet holds NIGHT and Lace shows DUST for the same seed, so this is\n` +
        `purely the cold sync being slow. Options: raise DUST_WAIT_MINUTES and\n` +
        `leave it running, or drive the deploy from the browser wallet instead,\n` +
        `which keeps its own synced state.`,
      );
      await bundle.facade.stop();
      process.exit(3);
    }

    console.log(`\nDUST available: ${balance / 10n ** 15n} DUST`);
    await waitUntilLive();
    console.log("Wallet is live against the chain tip.\n");

    // Never pay this cold sync again.
    try {
      await saveCheckpoint(bundle.facade, Number(applied));
      console.log(`Checkpoint saved to ${checkpointPath()} — later runs resume from here.\n`);
    } catch (e: any) {
      console.log("(could not save checkpoint:", describe(e), ")\n");
    }
  }

  const compiledContract = (CompiledContract.make(CONTRACT_NAME, Contract) as any).pipe(
    // The probe contract declares no witnesses.
    (CompiledContract as any).withVacantWitnesses,
    (CompiledContract as any).withCompiledFileAssets(ZK_CONFIG_PATH),
  );

  const providers = await createProviders(
    bundle.facade, bundle.zswapSecretKeys, bundle.dustSecretKey, bundle.keystore,
  );

  // ---- Step 1: deploy. Expected to SUCCEED even if #117 still bites. -------
  console.log(`\nDeploying ${CONTRACT_NAME} to Preview…`);
  let deployed: any;
  try {
    deployed = await withRetries("deploy", () =>
      deployContract(providers, {
        compiledContract,
        privateStateId: `${CONTRACT_NAME}PrivateState`,
        initialPrivateState: {},
      } as any),
    );
  } catch (e: any) {
    console.error("\n❌ DEPLOY FAILED — this is NOT what #117 describes.");
    console.error(describe(e));
    if (/prove/i.test(describe(e))) {
      console.error(
        `\nProving failed rather than the node rejecting anything, so this is\n` +
        `local. Check the proof server's own logs — the usual causes are a\n` +
        `version mismatch with ledger-v8 8.1.0, or the ZK keys not being found:\n` +
        `  docker logs --tail 40 midnight-proof-server\n` +
        `ZK config path: ${ZK_CONFIG_PATH}\n`,
      );
    }
    await bundle.facade.stop();
    process.exit(1);
  }

  const address = deployed.deployTxData.public.contractAddress;
  console.log("✅ deployed at", address);

  // ---- Step 2: the isolating matrix. --------------------------------------
  //
  // Two calls on ONE deployed contract, in one run, against one wallet state.
  // `bump` is a proving contract call with a ledger write and no unshielded
  // effect. `deposit` is the same shape plus exactly one unshielded line.
  // Whatever differs between the two results IS the unshielded effect.
  //
  // The control runs FIRST and on purpose. If a plain contract call is also
  // refused then the unshielded effect is not implicated, the fault is local,
  // and nothing here is reportable. Both are retried the same number of times
  // so the comparison stays fair and so a deterministic rejection is shown to
  // be deterministic across independently built and proved transactions.

  /** Pull the ledger's u8 out of a substrate `1010 ... Custom error: N`. */
  function customCode(msg: string): number | null {
    const m = msg.match(/Custom error:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // Verified 2026-09-02 against midnight-node@main,
  // ledger/src/versions/common/types.rs -> `impl From<LedgerApiError> for u8`.
  const NAMED: Record<number, string> = {
    117: "Malformed(NotNormalized)",
    126: "Malformed(Unbalanced)",
    138: "Malformed(BalanceCheckOverspend)",
    170: "Malformed(InvalidDustSpendProof)",
    189: "Malformed(InputsNotSorted)",
    190: "Malformed(OutputsNotSorted)",
    191: "Malformed(DuplicateInputs)",
    192: "Malformed(InputsSignaturesLengthMismatch)",
    214: "Malformed(EffectsCheck.RealUnshieldedSpendsSubsetCheckFailure)",
    227: "Malformed(DisjointCheck.UnshieldedInputsDisjointFailure)",
    231: "Malformed(FeeCalculation.OutsideTimeToDismiss)",
  };

  type Outcome = { ok: boolean; msg: string; code: number | null };

  async function attempt(label: string, run: () => Promise<any>): Promise<Outcome> {
    try {
      await withRetries(label, run);
      return { ok: true, msg: "", code: null };
    } catch (e: any) {
      const msg = describe(e);
      return { ok: false, msg, code: customCode(msg) };
    }
  }

  const fmt = (o: Outcome): string =>
    o.ok
      ? "ACCEPTED"
      : o.code !== null
        ? `REJECTED  Custom(${o.code})  ${NAMED[o.code] ?? "UNMAPPED — look it up before citing it"}`
        : `FAILED    ${o.msg.slice(0, 140)}`;

  console.log("\n--- CONTROL: bump() — ledger write, no unshielded effect ---");
  const control = await attempt("bump", () => deployed.callTx.bump());
  console.log(fmt(control));

  let subject: Outcome | null = null;
  if (control.ok) {
    console.log(`\n--- SUBJECT: deposit(color=${COLOR_HEX.slice(0, 8)}…, amount=${AMOUNT}) ---`);
    console.log("Identical to the control except for one receiveUnshielded line.\n");
    const color = new Uint8Array(Buffer.from(COLOR_HEX, "hex"));
    subject = await attempt("deposit", () => deployed.callTx.deposit(color, AMOUNT));
    console.log(fmt(subject));
  }

  console.log("\n===================== RESULT =====================");
  console.log("contract           :", address);
  console.log("control   bump()   :", fmt(control));
  console.log("subject   deposit():", subject ? fmt(subject) : "NOT RUN (control failed)");
  console.log();

  if (!control.ok) {
    console.log(
      "The CONTROL failed. A contract call touching no unshielded token was\n" +
      "also refused, so the unshielded effect is not implicated and NOTHING\n" +
      "here is reportable. Fix the local stack first — wallet state, providers,\n" +
      "proving, or package versions.",
    );
  } else if (subject!.ok) {
    console.log(
      "Both calls landed. receiveUnshielded works on Preview with this stack\n" +
      "(compiler 0.31.1 / language 0.23 / runtime 0.16.0 / ledger-v8 8.1.0).\n" +
      "=> Privoice can pursue DESIGN C (pooled deposits, amounts hidden).",
    );
  } else if (subject!.code === 231) {
    console.log(
      "Control ACCEPTED, subject REJECTED with 231 = FeeCalculation(OutsideTimeToDismiss).\n" +
      "That is the code servicedesk #117 reports, now reproduced on Preview.\n" +
      "=> Privoice uses DESIGN B, citing #117, and this Preview data point\n" +
      "   should be added to that ticket rather than filed as a new one.",
    );
  } else {
    console.log(
      `Control ACCEPTED, subject REJECTED with Custom(${subject!.code}).\n` +
      "#117 reports 231, so this is a DIFFERENT failure reached by the same\n" +
      "trigger. The unshielded effect is the only variable between the two\n" +
      "calls above, both of which were proved and submitted independently.\n" +
      "=> Privoice uses DESIGN B. Separately reportable — but confirm the code\n" +
      "   against midnight-node types.rs before writing the ticket.",
    );
  }

  await bundle.facade.stop();
}

main().catch((e) => { console.error(describe(e)); process.exit(1); });
