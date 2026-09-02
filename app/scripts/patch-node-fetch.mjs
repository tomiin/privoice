/**
 * Turn off gzip in node-fetch, because the Preview indexer truncates it.
 *
 * The problem, in one paragraph: fetching the full state of a large contract
 * from https://indexer.preview.midnight.network fails while DECOMPRESSING the
 * response, with ERR_STREAM_PREMATURE_CLOSE thrown inside Gunzip. Small
 * queries are fine; it only bites on contracts with a lot of accumulated
 * state, which is exactly what the USDM gateway is. It blocks the Midnight to
 * Cardano direction completely.
 *
 * `@midnight-ntwrk/midnight-js-indexer-public-data-provider` builds its Apollo
 * link with `createHttpLink({ fetch, uri })` where `fetch` comes from
 * cross-fetch, which on Node is node-fetch v2. node-fetch asks for compression
 * by default, so every query carries `Accept-Encoding: gzip,deflate`. Asking
 * for the response uncompressed avoids the truncation entirely.
 *
 * A/B tested three times: stock failed, patched succeeded and landed a burn
 * transaction, reverting reproduced the failure at the identical stack frame.
 *
 * The proper fix belongs upstream — the provider could pass
 * `fetchOptions: { compress: false }` to createHttpLink, or the indexer could
 * stop truncating. Reported at midnightntwrk/servicedesk. Until then this runs
 * on postinstall so a fresh clone works, rather than leaving the next person
 * to rediscover it.
 *
 * Idempotent, and a no-op if the file is not where it is expected.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// cross-fetch may keep its own nested copy, or share a hoisted one.
const CANDIDATES = [
    "node_modules/cross-fetch/node_modules/node-fetch/lib/index.js",
    "node_modules/node-fetch/lib/index.js",
];

const BEFORE = "input.compress !== undefined ? input.compress : true";
const AFTER = "input.compress !== undefined ? input.compress : false";

let patched = 0;
let already = 0;
let missing = 0;

for (const rel of CANDIDATES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { missing += 1; continue; }

    const source = fs.readFileSync(file, "utf8");
    if (source.includes(AFTER)) { already += 1; continue; }
    if (!source.includes(BEFORE)) {
        console.warn(`  ? ${rel} — expected default not found, node-fetch may have changed. Left alone.`);
        continue;
    }

    // Keep the original the first time, so the change can be undone and, more
    // usefully, so the A/B test can be repeated by anyone who doubts it.
    const backup = `${file}.orig`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

    fs.writeFileSync(file, source.replace(BEFORE, AFTER));
    console.log(`  ✓ ${rel} — gzip disabled (original kept as .orig)`);
    patched += 1;
}

if (patched === 0 && already > 0) console.log("  ✓ node-fetch already patched, nothing to do");
if (patched === 0 && already === 0 && missing === CANDIDATES.length) {
    console.log("  · node-fetch not found — nothing to patch (fine if dependencies are not installed yet)");
}
