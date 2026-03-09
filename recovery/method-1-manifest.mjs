#!/usr/bin/env node
/**
 * METHOD 1: Full Recovery from Manifest CID
 *
 * WHAT YOU NEED: Just one IPFS CID (e.g., written on paper, saved in email)
 * WHAT YOU GET:  Every single maintenance record, fully verified
 *
 * This is the "golden path" — fastest, most complete recovery method.
 *
 * How it works:
 *   1. Fetch manifest from IPFS (tries local Kubo, then public gateways)
 *   2. Verify manifest integrity (SHA-256 hash check — was it tampered?)
 *   3. For each aircraft, fetch every record from IPFS
 *   4. Verify each record's hash matches (data integrity)
 *   5. Walk the hash chain (detect any missing/reordered records)
 *   6. Output recovered data (ready for DB import or Excel export)
 *
 * Usage:
 *   node recovery/method-1-manifest.mjs <MANIFEST_CID>
 *   node recovery/method-1-manifest.mjs QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW
 */

import { readFile } from 'node:fs/promises';
import { fetchFromIPFS } from './lib/ipfs.mjs';
import { sha256, canonicalJson, verifyRecordHash, validateChain } from './lib/crypto.mjs';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  try {
    config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
    console.log('  (Using config.example.json — copy to config.json and fill in your values)\n');
  } catch {
    console.log('  (No config found — using public IPFS gateways only)\n');
  }
}

// ── Get manifest CID from args ───────────────────────────
const manifestCid = process.argv[2];
if (!manifestCid) {
  console.error('Usage: node recovery/method-1-manifest.mjs <MANIFEST_CID>');
  console.error('Example: node recovery/method-1-manifest.mjs QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW');
  process.exit(1);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  METHOD 1: Full Recovery from Manifest CID             ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Step 1: Fetch manifest ───────────────────────────────
console.log('Step 1: Fetching manifest from IPFS...');
console.log(`  CID: ${manifestCid}`);

const { data: manifest, source } = await fetchFromIPFS(manifestCid, config.ipfs || {});
console.log(`  Source: ${source}`);
console.log(`  Aircraft: ${manifest.aircraft_count}`);
console.log(`  Records:  ${manifest.total_records}`);
console.log(`  Batches:  ${manifest.total_batches}`);
console.log('  Done.\n');

// ── Step 2: Verify manifest integrity ────────────────────
console.log('Step 2: Verifying manifest integrity...');

const { manifest_hash: storedHash, ...manifestBody } = manifest;
const recomputedHash = sha256(canonicalJson(manifestBody));
const manifestOk = recomputedHash === storedHash;

console.log(`  Stored hash:     ${storedHash}`);
console.log(`  Recomputed hash: ${recomputedHash}`);
console.log(`  ${manifestOk ? 'PASS — manifest is authentic' : 'FAIL — MANIFEST HAS BEEN TAMPERED WITH'}`);

if (!manifestOk) {
  console.error('\n  ABORT: Manifest integrity check failed. Data may be corrupted or tampered.');
  process.exit(1);
}
console.log('');

// ── Step 3: Recover each aircraft ────────────────────────
console.log('Step 3: Recovering aircraft records from IPFS...\n');

const recovered = { aircraft: [], totalRecords: 0, ipfsVerified: 0, ipfsFailed: 0 };

for (const aircraft of manifest.aircraft) {
  console.log(`  Aircraft: ${aircraft.aircraft_id} (${aircraft.record_count} records)`);

  const aircraftData = {
    aircraft_id: aircraft.aircraft_id,
    records: [],
    timers: aircraft.maintenance_timers || {},
  };

  for (const rec of aircraft.records) {
    let recordData = null;
    let hashVerified = false;

    // Try to fetch full record from IPFS
    if (rec.ipfs_cid) {
      try {
        const { data } = await fetchFromIPFS(rec.ipfs_cid, config.ipfs || {});
        const result = verifyRecordHash(data, rec.record_hash);
        hashVerified = result.match;
        recordData = data;

        if (hashVerified) {
          recovered.ipfsVerified++;
          process.stdout.write(`    [${rec.record_type}] IPFS hash VERIFIED\n`);
        } else {
          process.stdout.write(`    [${rec.record_type}] IPFS hash MISMATCH — data may be corrupted\n`);
        }
      } catch {
        recovered.ipfsFailed++;
        process.stdout.write(`    [${rec.record_type}] IPFS fetch failed — using manifest metadata only\n`);
      }
    } else {
      process.stdout.write(`    [${rec.record_type}] No IPFS CID — using manifest metadata only\n`);
    }

    aircraftData.records.push({
      ...rec,
      fullData: recordData,
      ipfsVerified: hashVerified,
    });
    recovered.totalRecords++;
  }

  // Walk hash chain for this aircraft
  const chainResult = validateChain(aircraft.records);
  aircraftData.chainIntact = chainResult.intact;
  aircraftData.chainBreaks = chainResult.breaks;

  console.log(
    `    Chain: ${chainResult.intact
      ? `INTACT (${chainResult.length} records linked)`
      : `BROKEN at positions: ${chainResult.breaks.join(', ')}`
    }\n`
  );

  recovered.aircraft.push(aircraftData);
}

// ── Step 4: Recover batches ──────────────────────────────
console.log('Step 4: Recovering blockchain anchor batches...');

recovered.batches = manifest.batches || [];
for (const batch of recovered.batches) {
  const status = batch.anchor_status === 'anchored' ? 'ANCHORED' : 'pending';
  console.log(`  Batch: root=${batch.merkle_root.slice(0, 20)}... status=${status}`);
  if (batch.tx_hash) {
    console.log(`    TX: ${batch.tx_hash}`);
  }
}
console.log('');

// ── Summary ──────────────────────────────────────────────
console.log('═'.repeat(60));
console.log('  RECOVERY SUMMARY');
console.log('═'.repeat(60));
console.log(`  Method:           Manifest CID`);
console.log(`  Manifest CID:     ${manifestCid}`);
console.log(`  Manifest:         ${manifestOk ? 'VERIFIED' : 'FAILED'}`);
console.log(`  Aircraft:         ${recovered.aircraft.length}`);
console.log(`  Records:          ${recovered.totalRecords}`);
console.log(`  IPFS verified:    ${recovered.ipfsVerified}/${recovered.totalRecords}`);
console.log(`  IPFS failed:      ${recovered.ipfsFailed}`);
console.log(`  Batches:          ${recovered.batches.length}`);

const allChainsOk = recovered.aircraft.every((a) => a.chainIntact);
console.log(`  All chains intact: ${allChainsOk ? 'YES' : 'NO'}`);
console.log('═'.repeat(60));

// Output recovered data as JSON for piping to other tools
const outputFile = `recovered-${Date.now()}.json`;
const { writeFile } = await import('node:fs/promises');
await writeFile(outputFile, JSON.stringify({ manifest, recovered }, null, 2));
console.log(`\n  Full data saved to: ${outputFile}`);
console.log('  Pipe to Excel: node recovery/export-excel.mjs ' + outputFile);
console.log('');
