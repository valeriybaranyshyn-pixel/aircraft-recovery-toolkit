#!/usr/bin/env node
/**
 * METHOD 3: Blockchain Forensics (myaviationtools.com is GONE)
 *
 * WHAT YOU NEED: Access to the Besu blockchain (RPC or backup file)
 * WHAT YOU GET:  Depends on what was stored on-chain:
 *
 *   Legacy calldata (Merkle root only):
 *     - Timeline of WHEN batches were anchored
 *     - Ability to VERIFY data if someone provides it
 *     - CANNOT recover actual maintenance records
 *
 *   Enhanced calldata (Merkle root + IPFS CIDs):
 *     - Everything above PLUS
 *     - IPFS CIDs to fetch records from public gateways
 *     - Full recovery possible if any IPFS gateway still has the data
 *
 * How it works:
 *   1. Connect to Besu RPC (or load from backup file)
 *   2. Scan ALL blocks for anchor transactions from the known wallet
 *   3. Extract calldata (Merkle roots + CIDs if enhanced)
 *   4. For enhanced: try to fetch manifest/records from public IPFS gateways
 *   5. Output what was recovered
 *
 * Usage:
 *   node recovery/method-3-blockchain-forensics.mjs
 *   node recovery/method-3-blockchain-forensics.mjs --backup chain-export.json
 *   node recovery/method-3-blockchain-forensics.mjs --rpc http://localhost:8545
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createBesuClient, scanChain, parseCalldata } from './lib/blockchain.mjs';
import { fetchFromIPFS } from './lib/ipfs.mjs';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
}

const backupFile = process.argv.includes('--backup')
  ? process.argv[process.argv.indexOf('--backup') + 1]
  : null;

const rpcUrl = process.argv.includes('--rpc')
  ? process.argv[process.argv.indexOf('--rpc') + 1]
  : config.besu?.rpcUrl || 'http://localhost:8545';

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  METHOD 3: Blockchain Forensics                        ║');
console.log('║  Recover from Besu chain when everything else is gone  ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

let anchors = [];

// ── Step 1: Get anchor data ──────────────────────────────
if (backupFile) {
  // Load from backup file (no Besu node needed)
  console.log(`Step 1: Loading chain data from backup: ${backupFile}`);
  const backup = JSON.parse(await readFile(backupFile, 'utf-8'));
  anchors = backup.anchors;
  console.log(`  Loaded ${anchors.length} anchor transactions.`);
  console.log(`  Chain ID: ${backup.chainId}`);
  console.log(`  Block range: ${backup.blockRange.from} - ${backup.blockRange.to}`);
  console.log(`  Exported at: ${backup.exportedAt}\n`);
} else {
  // Scan live Besu node
  console.log(`Step 1: Scanning Besu chain at ${rpcUrl}...`);
  const client = createBesuClient({ rpcUrl, chainId: config.besu?.chainId });
  const walletAddress = config.besu?.walletAddress;

  if (!walletAddress) {
    console.error('  ERROR: No wallet address configured.');
    console.error('  Set besu.walletAddress in config.json');
    process.exit(1);
  }

  anchors = await scanChain(client, walletAddress);
  console.log('');
}

if (anchors.length === 0) {
  console.log('  No anchor transactions found on this chain.');
  console.log('  Either the chain has no data or the wallet address is wrong.');
  process.exit(0);
}

// ── Step 2: Analyze what's on-chain ──────────────────────
console.log('Step 2: Analyzing on-chain data...\n');

const legacy = anchors.filter((a) => !a.isEnhanced);
const enhanced = anchors.filter((a) => a.isEnhanced);

console.log(`  Total anchor transactions: ${anchors.length}`);
console.log(`  Legacy (root only):        ${legacy.length}`);
console.log(`  Enhanced (root + CIDs):    ${enhanced.length}\n`);

console.log('  Anchor timeline:');
for (const anchor of anchors) {
  const type = anchor.isEnhanced ? 'ENHANCED' : 'LEGACY';
  console.log(`    Block ${String(anchor.blockNumber).padStart(6)} | ${anchor.timestamp} | ${type}`);
  console.log(`      Root: ${anchor.merkleRoot}`);
  if (anchor.manifestCid) console.log(`      Manifest CID: ${anchor.manifestCid}`);
  if (anchor.batchCid) console.log(`      Batch CID:    ${anchor.batchCid}`);
  console.log(`      TX: ${anchor.txHash}`);
  console.log('');
}

// ── Step 3: Attempt IPFS recovery (enhanced only) ────────
if (enhanced.length > 0) {
  console.log('Step 3: Attempting recovery via on-chain IPFS CIDs...\n');
  console.log('  Enhanced anchors contain IPFS CIDs. Trying public gateways...\n');

  // Try the most recent enhanced anchor first (most complete manifest)
  const sorted = [...enhanced].sort((a, b) => b.blockNumber - a.blockNumber);

  for (const anchor of sorted) {
    if (anchor.manifestCid) {
      console.log(`  Trying manifest CID: ${anchor.manifestCid}`);
      try {
        const { data, source } = await fetchFromIPFS(anchor.manifestCid, config.ipfs || {});
        console.log(`  SUCCESS — Manifest found on ${source}!`);
        console.log(`    Aircraft: ${data.aircraft_count}`);
        console.log(`    Records:  ${data.total_records}`);
        console.log(`    Batches:  ${data.total_batches}\n`);
        console.log('  ═══════════════════════════════════════════════════');
        console.log('  FULL RECOVERY POSSIBLE — Run Method 1:');
        console.log('  ═══════════════════════════════════════════════════');
        console.log(`\n  node recovery/method-1-manifest.mjs ${anchor.manifestCid}\n`);
        process.exit(0);
      } catch {
        console.log('    Not found on any gateway. Trying next...\n');
      }
    }

    if (anchor.batchCid) {
      console.log(`  Trying batch CID: ${anchor.batchCid}`);
      try {
        const { data, source } = await fetchFromIPFS(anchor.batchCid, config.ipfs || {});
        console.log(`  PARTIAL — Batch metadata found on ${source}`);
        console.log(`    Merkle root: ${data.merkle_root}`);
        console.log(`    Records: ${data.record_count}`);
        if (data.record_hashes) {
          console.log(`    Record hashes: ${data.record_hashes.length}`);
          data.record_hashes.forEach((h) => console.log(`      ${h}`));
        }
        console.log('');
      } catch {
        console.log('    Not found on any gateway.\n');
      }
    }
  }

  console.log('  No manifest found on public gateways.');
  console.log('  The data may have been unpinned or the gateways may not have it cached.\n');
}

// ── Step 4: What CAN we do with just Merkle roots? ───────
if (legacy.length > 0 || enhanced.length > 0) {
  console.log('Step 4: What Merkle roots alone can tell us...\n');

  console.log('  Even without the original data, Merkle roots prove:');
  console.log('    1. WHEN records existed (block timestamp)');
  console.log('    2. HOW MANY batches were anchored');
  console.log('    3. Data HAS NOT been altered (if someone provides the original)\n');

  console.log('  Verification use case:');
  console.log('  If a mechanic has a paper copy of a maintenance record,');
  console.log('  you can hash it and check if it was part of any Merkle tree.\n');

  // Save the forensics data
  const forensicsOutput = {
    scannedAt: new Date().toISOString(),
    chainId: config.besu?.chainId || 43900,
    anchorCount: anchors.length,
    legacyCount: legacy.length,
    enhancedCount: enhanced.length,
    anchors: anchors.map((a) => ({
      blockNumber: a.blockNumber,
      timestamp: a.timestamp,
      txHash: a.txHash,
      merkleRoot: a.merkleRoot,
      manifestCid: a.manifestCid,
      batchCid: a.batchCid,
      isEnhanced: a.isEnhanced,
    })),
    merkleRoots: anchors.map((a) => a.merkleRoot),
  };

  const outputFile = `forensics-${Date.now()}.json`;
  await writeFile(outputFile, JSON.stringify(forensicsOutput, null, 2));

  console.log('═'.repeat(60));
  console.log('  FORENSICS SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Anchor transactions: ${anchors.length}`);
  console.log(`  Legacy (verify only): ${legacy.length}`);
  console.log(`  Enhanced (recoverable): ${enhanced.length}`);
  console.log(`  Unique Merkle roots: ${new Set(anchors.map((a) => a.merkleRoot)).size}`);
  console.log(`  Time range: ${anchors[0].timestamp} to ${anchors[anchors.length - 1].timestamp}`);
  console.log(`\n  Forensics data saved to: ${outputFile}`);
  console.log('═'.repeat(60) + '\n');
}
