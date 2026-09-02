// src/balances.ts — what does this Preview wallet actually hold?
//
// Prints every unshielded token colour with a balance, so USDM is either there
// or it is not. USDM on Preview is colour
// 003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73 (6 dp).
import { Buffer } from "buffer";
import { readFileSync } from "node:fs";
import * as Rx from "rxjs";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { initializeNetwork } from "./netid.js";
import { buildWallet, startAndSync } from "./wallet.js";
import { loadCheckpoint } from "./checkpoint.js";
import { addressString } from "./usdm.js";

const USDM = "003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73";
const NIGHT = "00".repeat(32);
const TENDER_ENV = "/Volumes/Seagate/Midnight code /via-usdm-sprint/bridge-service/.env";

function seed(): Buffer {
  let m = process.env.PRIVOICE_MNEMONIC;
  if (!m) {
    const env = readFileSync(process.env.TENDER_ENV ?? TENDER_ENV, "utf8");
    const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("MIDNIGHT_MNEMONIC_PREVIEW="));
    if (line) m = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!m || !validateMnemonic(m)) throw new Error("No valid mnemonic found");
  return Buffer.from(mnemonicToSeedSync(m));
}

const norm = (s: string) => s.replace(/^0x/i, "").toLowerCase();

async function main() {
  initializeNetwork();
  const cp = loadCheckpoint();
  const fresh = cp ? (Date.now() - cp.savedAt) / 3_600_000 <= 12 : false;
  const bundle = await buildWallet(seed(), { useCheckpoint: fresh });
  await startAndSync(bundle);

  const st: any = await Rx.firstValueFrom(bundle.facade.state());
  const raw = st?.unshielded?.balances;
  const entries: [string, any][] = raw instanceof Map
    ? [...raw.entries()]
    : Object.entries(raw ?? {});

  console.log("\n--- unshielded balances -------------------------------------");
  if (entries.length === 0) console.log("(none)");
  for (const [colour, amount] of entries) {
    const c = norm(String(colour));
    const label = c === norm(USDM) ? "  <= USDM" : c === norm(NIGHT) ? "  <= NIGHT" : "";
    console.log(`${c}  ${String(amount)}${label}`);
  }

  const usdm = entries.find(([c]) => norm(String(c)) === norm(USDM));
  console.log("-------------------------------------------------------------");
  console.log(usdm
    ? `USDM present: ${(Number(usdm[1]) / 1e6).toFixed(6)} USDM`
    : "USDM NOT present in this wallet on Preview.");

  // The address to send USDM to, if a second wallet is needed.
  console.log("\nThis wallet's unshielded address (bridge USDM here):");
  console.log("  " + addressString(st?.unshielded?.address));

  await bundle.facade.stop();
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
