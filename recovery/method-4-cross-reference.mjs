#!/usr/bin/env node
/**
 * METHOD 4: Cross-Reference Recovery (Hybrid)
 *
 * WHAT YOU NEED: Partial data from multiple sources
 * WHAT YOU GET:  Best possible reconstruction from available pieces
 *
 * Sources this method can combine:
 *   - Partial IPFS pins (some records survived)
 *   - Blockchain Merkle roots (from Method 3 forensics output)
 *   - Old manifest CID (not the latest, but some data)
 *   - Paper/PDF records (manually enter hashes for verification)
 *
 * How it works:
 *   1. Gather data from all available sources
 *   2. Deduplicate by record_hash
 *   3. Verify each record against blockchain Merkle proofs
 *   4. Identify gaps (missing records in the hash chain)
 *   5. Output: what we recovered + what's still missing
 *
 * Usage:
 *   node recovery/method-4-cross-reference.mjs --ipfs --blockchain
 *   node recovery/method-4-cross-reference.mjs --forensics forensics-*.json --ipfs
 *   node recovery/method-4-cross-reference.mjs --old-manifest QmOldCid123... --blockchain
 */

import { readFile, writeFile } from 'node:fs/promises';
import { listKuboPins, fetchFromIPFS } from './lib/ipfs.mjs';
import { createBesuClient, scanChain } from './lib/blockchain.mjs';
import { sha256, canonicalJson, validateChain } from './lib/crypto.mjs';
import { MerkleTree } from 'merkletreejs';
import CryptoJS from 'crypto-js';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
}

const useIpfs = process.argv.includes('--ipfs');
const useBlockchain = process.argv.includes('--blockchain');
const forensicsFile = process.argv.includes('--forensics')
  ? process.argv[process.argv.indexOf('--forensics') + 1]
  : null;
const oldManifestCid = process.argv.includes('--old-manifest')
  ? process.argv[process.argv.indexOf('--old-manifest') + 1]
  : null;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  METHOD 4: Cross-Reference Recovery (Hybrid)           ║');
console.log('║  Piece together data from multiple partial sources     ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// Collected records keyed by record_hash
const recordMap = new Map();
const merkleRoots = new Set();
let sourcesUsed = [];

// ── Source A: IPFS Pin Discovery ─────────────────────────
if (useIpfs) {
  console.log('Source A: Scanning IPFS pins...');
  const kuboApi = config.ipfs?.localApi || 'http://localhost:5001';

  try {
    const pins = await listKuboPins(kuboApi);
    let found = 0;

    for (const cid of pins) {
      try {
        const { data } = await fetchFromIPFS(cid, { localApi: kuboApi });
        if (data._blockchain?.record_hash) {
          const hash = data._blockchain.record_hash;
          if (!recordMap.has(hash)) {
            recordMap.set(hash, {
              record_hash: hash,
              record_type: data._blockchain.record_type,
              previous_hash: data._blockchain.previous_hash,
              ipfs_cid: cid,
              fullData: data,
              sources: ['ipfs'],
            });
            found++;
          }
        }
      } catch { /* skip non-JSON pins */ }
    }

    console.log(`  Found ${found} unique records from ${pins.length} pins.\n`);
    sourcesUsed.push('ipfs');
  } catch (err) {
    console.log(`  IPFS unavailable: ${err.message}\n`);
  }
}

// ── Source B: Blockchain forensics ────────────────────────
if (useBlockchain || forensicsFile) {
  console.log('Source B: Loading blockchain data...');

  let anchors = [];

  if (forensicsFile) {
    const forensics = JSON.parse(await readFile(forensicsFile, 'utf-8'));
    anchors = forensics.anchors;
    console.log(`  Loaded ${anchors.length} anchors from ${forensicsFile}`);
  } else {
    const client = createBesuClient(config.besu);
    anchors = await scanChain(client, config.besu.walletAddress);
  }

  for (const anchor of anchors) {
    merkleRoots.add(anchor.merkleRoot);
  }

  console.log(`  Found ${merkleRoots.size} unique Merkle roots.\n`);
  sourcesUsed.push('blockchain');
}

// ── Source C: Old manifest ───────────────────────────────
if (oldManifestCid) {
  console.log(`Source C: Fetching old manifest ${oldManifestCid}...`);

  try {
    const { data: oldManifest } = await fetchFromIPFS(oldManifestCid, config.ipfs || {});
    let added = 0;

    for (const aircraft of oldManifest.aircraft || []) {
      for (const rec of aircraft.records || []) {
        if (!recordMap.has(rec.record_hash)) {
          recordMap.set(rec.record_hash, {
            ...rec,
            fullData: null,
            sources: ['old-manifest'],
          });
          added++;
        } else {
          // Merge: add old-manifest as additional source
          recordMap.get(rec.record_hash).sources.push('old-manifest');
        }
      }
    }

    console.log(`  Added ${added} records from old manifest (${oldManifest.created_at}).\n`);
    sourcesUsed.push('old-manifest');
  } catch (err) {
    console.log(`  Failed to fetch old manifest: ${err.message}\n`);
  }
}

// ── Cross-reference: verify records against Merkle roots ─
console.log('Cross-referencing: Verifying records against Merkle roots...\n');

const allRecords = [...recordMap.values()];
let merkleVerified = 0;

if (merkleRoots.size > 0 && allRecords.length > 0) {
  // Try to build Merkle trees from subsets of records and see if any root matches
  const hashes = allRecords.map((r) => r.record_hash);

  for (const knownRoot of merkleRoots) {
    // Try the full set
    const leaves = hashes.map((h) => CryptoJS.SHA256(h).toString());
    const tree = new MerkleTree(leaves, CryptoJS.SHA256, { sortPairs: true });
    const computedRoot = tree.getHexRoot();

    if (computedRoot.toLowerCase() === knownRoot.toLowerCase()) {
      console.log(`  MATCH: All ${hashes.length} records form Merkle root ${knownRoot.slice(0, 20)}...`);
      merkleVerified = hashes.length;
      break;
    }
  }

  if (merkleVerified === 0) {
    console.log('  No complete Merkle tree match found.');
    console.log('  Records may be from different batches or some are missing.');
    console.log(`  Known roots: ${merkleRoots.size}, Records: ${allRecords.length}\n`);
  }
}

// ── Group by aircraft and check chains ───────────────────
console.log('Grouping by aircraft and checking hash chains...\n');

const aircraftGroups = new Map();
for (const rec of allRecords) {
  // Try to determine aircraft from full data
  const aircraftId = rec.fullData?.aircraft_id || rec.fullData?._blockchain?.aircraft_id || 'unknown';
  if (!aircraftGroups.has(aircraftId)) aircraftGroups.set(aircraftId, []);
  aircraftGroups.get(aircraftId).push(rec);
}

// Sort each group by chain order (follow previous_hash links)
for (const [aircraftId, records] of aircraftGroups) {
  // Find genesis (previous_hash === null)
  const genesis = records.find((r) => !r.previous_hash);
  if (!genesis) {
    console.log(`  ${aircraftId}: No genesis record found — chain is partial`);
    continue;
  }

  const ordered = [genesis];
  let current = genesis;
  while (true) {
    const next = records.find((r) => r.previous_hash === current.record_hash);
    if (!next) break;
    ordered.push(next);
    current = next;
  }

  const chainResult = validateChain(ordered);
  console.log(
    `  ${aircraftId}: ${ordered.length}/${records.length} records chained, ` +
      `${chainResult.intact ? 'INTACT' : `BROKEN at ${chainResult.breaks.length} points`}`
  );

  if (ordered.length < records.length) {
    console.log(`    ${records.length - ordered.length} orphaned records (not in chain)`);
  }
}

// ── Summary ──────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('  CROSS-REFERENCE RECOVERY SUMMARY');
console.log('═'.repeat(60));
console.log(`  Sources used:       ${sourcesUsed.join(', ') || 'none'}`);
console.log(`  Records found:      ${recordMap.size}`);
console.log(`  Merkle roots known: ${merkleRoots.size}`);
console.log(`  Merkle verified:    ${merkleVerified}/${recordMap.size}`);
console.log(`  Aircraft groups:    ${aircraftGroups.size}`);
console.log(`  With full data:     ${allRecords.filter((r) => r.fullData).length}/${recordMap.size}`);
console.log(`  Metadata only:      ${allRecords.filter((r) => !r.fullData).length}/${recordMap.size}`);
console.log('═'.repeat(60));

// Save output
const outputFile = `cross-reference-${Date.now()}.json`;
await writeFile(
  outputFile,
  JSON.stringify(
    {
      recoveredAt: new Date().toISOString(),
      sourcesUsed,
      recordCount: recordMap.size,
      merkleRoots: [...merkleRoots],
      records: allRecords,
    },
    null,
    2
  )
);
console.log(`\n  Data saved to: ${outputFile}\n`);
