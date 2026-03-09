#!/usr/bin/env node
/**
 * Besu Chain Backup
 *
 * Exports all anchor transactions from the Besu chain to a JSON file.
 * This file can be stored OFFSITE (S3, Google Drive, USB drive, email to yourself).
 *
 * If your Hetzner server burns down, this backup file + IPFS multi-pin
 * means you can recover everything from scratch on a new server.
 *
 * Usage:
 *   node recovery/besu-backup.mjs                           # Export to ./backups/
 *   node recovery/besu-backup.mjs --output my-backup.json   # Custom output path
 *   node recovery/besu-backup.mjs --rpc http://besu:8545    # Custom RPC
 *
 * Recommended: Run this on a cron schedule (daily/weekly)
 *   0 3 * * * cd /path/to/toolkit && node recovery/besu-backup.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createBesuClient, exportChainData } from './lib/blockchain.mjs';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
}

const rpcUrl = process.argv.includes('--rpc')
  ? process.argv[process.argv.indexOf('--rpc') + 1]
  : config.besu?.rpcUrl || 'http://localhost:8545';

const outputDir = config.backup?.outputDir || './backups';
const customOutput = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : null;

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Besu Chain Backup                                     ║');
console.log('║  Export anchor transactions for offsite storage         ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Connect to Besu ──────────────────────────────────────
console.log(`Connecting to Besu at ${rpcUrl}...`);

const client = createBesuClient({ rpcUrl, chainId: config.besu?.chainId || 43900 });
const walletAddress = config.besu?.walletAddress;

if (!walletAddress) {
  console.error('ERROR: No wallet address configured. Set besu.walletAddress in config.json');
  process.exit(1);
}

// ── Export chain data ────────────────────────────────────
console.log(`Scanning chain for transactions from ${walletAddress}...\n`);

const chainData = await exportChainData(client, walletAddress, {
  chainId: config.besu?.chainId || 43900,
});

console.log(`\n  Anchors found: ${chainData.anchorCount}`);
console.log(`  Block range:   ${chainData.blockRange.from} - ${chainData.blockRange.to}`);

if (chainData.anchorCount === 0) {
  console.log('  No anchor transactions found. Nothing to back up.');
  process.exit(0);
}

// ── Save backup ──────────────────────────────────────────
let outputPath;
if (customOutput) {
  outputPath = customOutput;
} else {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  outputPath = `${outputDir}/besu-backup-${timestamp}.json`;
}

await writeFile(outputPath, JSON.stringify(chainData, null, 2));

const sizeKB = (Buffer.byteLength(JSON.stringify(chainData)) / 1024).toFixed(1);

console.log(`\n  Backup saved to: ${outputPath} (${sizeKB} KB)`);

// ── Cleanup old backups ──────────────────────────────────
if (!customOutput && config.backup?.keepLast) {
  const { readdir, unlink } = await import('node:fs/promises');
  try {
    const files = (await readdir(outputDir))
      .filter((f) => f.startsWith('besu-backup-') && f.endsWith('.json'))
      .sort()
      .reverse();

    const toDelete = files.slice(config.backup.keepLast);
    for (const file of toDelete) {
      await unlink(`${outputDir}/${file}`);
      console.log(`  Cleaned up old backup: ${file}`);
    }
  } catch { /* ignore cleanup errors */ }
}

console.log('\n═'.repeat(60));
console.log('  BACKUP COMPLETE');
console.log('═'.repeat(60));
console.log(`  File:    ${outputPath}`);
console.log(`  Size:    ${sizeKB} KB`);
console.log(`  Anchors: ${chainData.anchorCount}`);
console.log(`  Blocks:  ${chainData.blockRange.from} - ${chainData.blockRange.to}`);
console.log('═'.repeat(60));
console.log('\n  Store this file somewhere OFFSITE:');
console.log('    - Upload to S3/Google Drive/Dropbox');
console.log('    - Email it to yourself');
console.log('    - Copy to a USB drive');
console.log('    - Print the Merkle roots on paper\n');
console.log('  To recover from this backup:');
console.log(`    node recovery/method-3-blockchain-forensics.mjs --backup ${outputPath}\n`);
