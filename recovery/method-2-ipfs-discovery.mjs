#!/usr/bin/env node
/**
 * METHOD 2: IPFS Pin Discovery
 *
 * WHAT YOU NEED: Access to the IPFS node (Kubo API), but you LOST the manifest CID
 * WHAT YOU GET:  The manifest CID, then full recovery via Method 1
 *
 * How it works:
 *   1. Connect to your Kubo IPFS node
 *   2. List ALL pinned CIDs
 *   3. Fetch each one and categorize (manifest? record? batch metadata?)
 *   4. Find the most recent manifest
 *   5. Hand off to Method 1 for full recovery
 *
 * Usage:
 *   node recovery/method-2-ipfs-discovery.mjs
 *   node recovery/method-2-ipfs-discovery.mjs --kubo http://localhost:5001
 */

import { readFile } from 'node:fs/promises';
import { listKuboPins, fetchFromIPFS } from './lib/ipfs.mjs';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
}

const kuboApi = process.argv.includes('--kubo')
  ? process.argv[process.argv.indexOf('--kubo') + 1]
  : config.ipfs?.localApi || 'http://localhost:5001';

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  METHOD 2: IPFS Pin Discovery                          ║');
console.log('║  Find the manifest CID when you forgot to save it      ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Step 1: List all pins ────────────────────────────────
console.log(`Step 1: Listing all pins on ${kuboApi}...`);

let pins;
try {
  pins = await listKuboPins(kuboApi);
} catch (err) {
  console.error(`  FAIL: Cannot connect to Kubo at ${kuboApi}`);
  console.error(`  Error: ${err.message}`);
  console.error('  Make sure your IPFS node is running.');
  process.exit(1);
}

console.log(`  Found ${pins.length} pinned CIDs.\n`);

if (pins.length === 0) {
  console.log('  No pins found. Nothing to recover.');
  process.exit(0);
}

// ── Step 2: Categorize each pin ──────────────────────────
console.log('Step 2: Categorizing pinned data...\n');

const categories = {
  manifests: [],    // Recovery manifests (contain aircraft + batches)
  records: [],      // Individual maintenance records (contain _blockchain metadata)
  batches: [],      // Batch anchor metadata (contain merkle_root + record_hashes)
  unknown: [],      // Unrecognized data
};

for (const cid of pins) {
  try {
    const { data } = await fetchFromIPFS(cid, { localApi: kuboApi });

    if (data.version && data.aircraft && data.batches && data.manifest_hash) {
      // This is a recovery manifest
      categories.manifests.push({ cid, data, createdAt: data.created_at });
      process.stdout.write(`  [MANIFEST]  ${cid} (${data.total_records} records, ${data.created_at})\n`);
    } else if (data._blockchain?.record_hash) {
      // This is an individual maintenance record
      categories.records.push({ cid, type: data._blockchain.record_type, hash: data._blockchain.record_hash });
      process.stdout.write(`  [RECORD]    ${cid} (${data._blockchain.record_type})\n`);
    } else if (data.merkle_root && data.record_hashes) {
      // This is batch anchor metadata
      categories.batches.push({ cid, root: data.merkle_root, count: data.record_count });
      process.stdout.write(`  [BATCH]     ${cid} (${data.record_count} records)\n`);
    } else {
      categories.unknown.push({ cid });
      process.stdout.write(`  [UNKNOWN]   ${cid}\n`);
    }
  } catch {
    categories.unknown.push({ cid, error: 'Not JSON or fetch failed' });
    process.stdout.write(`  [SKIP]      ${cid} (not JSON)\n`);
  }
}

console.log(`\n  Summary:`);
console.log(`    Manifests: ${categories.manifests.length}`);
console.log(`    Records:   ${categories.records.length}`);
console.log(`    Batches:   ${categories.batches.length}`);
console.log(`    Unknown:   ${categories.unknown.length}\n`);

// ── Step 3: Find the best manifest ───────────────────────
if (categories.manifests.length === 0) {
  console.log('  No manifests found on this IPFS node.');
  console.log('  But we found individual records and batches.');
  console.log('  Try Method 4 (Cross-Reference) to piece them together.');
  console.log(`\n  Individual records found: ${categories.records.length}`);
  categories.records.forEach((r) => console.log(`    ${r.type}: ${r.hash.slice(0, 20)}... (${r.cid})`));
  process.exit(0);
}

// Sort by creation date, newest first
categories.manifests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
const bestManifest = categories.manifests[0];

console.log('Step 3: Best manifest found:');
console.log(`  CID:      ${bestManifest.cid}`);
console.log(`  Created:  ${bestManifest.createdAt}`);
console.log(`  Aircraft: ${bestManifest.data.aircraft_count}`);
console.log(`  Records:  ${bestManifest.data.total_records}`);

if (categories.manifests.length > 1) {
  console.log(`\n  (${categories.manifests.length - 1} older manifests also available)`);
  categories.manifests.slice(1).forEach((m) => {
    console.log(`    ${m.cid} — ${m.createdAt} (${m.data.total_records} records)`);
  });
}

// ── Step 4: Hand off to Method 1 ─────────────────────────
console.log('\n═'.repeat(60));
console.log('  MANIFEST FOUND — Run full recovery:');
console.log('═'.repeat(60));
console.log(`\n  node recovery/method-1-manifest.mjs ${bestManifest.cid}\n`);
console.log('  Or pipe directly to Excel:');
console.log(`  node recovery/method-1-manifest.mjs ${bestManifest.cid} && node recovery/export-excel.mjs recovered-*.json\n`);
