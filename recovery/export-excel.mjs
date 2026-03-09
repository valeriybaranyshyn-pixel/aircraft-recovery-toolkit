#!/usr/bin/env node
/**
 * ONE-CLICK EXCEL EXPORT
 *
 * Turns recovered aircraft maintenance data into a formatted .xlsx file.
 * One sheet per aircraft with full maintenance timeline and timer intervals.
 *
 * Two modes:
 *   1. From recovered JSON (output of any Method 1-4):
 *      node recovery/export-excel.mjs recovered-1741234567890.json
 *
 *   2. Direct from manifest CID (does recovery + export in one step):
 *      node recovery/export-excel.mjs --cid QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW
 *
 *   Options:
 *     --output my-report.xlsx    Custom output filename
 *     --method <1-4>             Tag which recovery method was used
 */

import { readFile } from 'node:fs/promises';
import { buildWorkbook, saveWorkbook } from './lib/excel.mjs';
import { fetchFromIPFS } from './lib/ipfs.mjs';
import { sha256, canonicalJson, validateChain } from './lib/crypto.mjs';

// ── Load config ──────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf-8'));
} catch {
  config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf-8'));
}

// ── Parse arguments ──────────────────────────────────────
const cidFlag = process.argv.includes('--cid');
const cidValue = cidFlag ? process.argv[process.argv.indexOf('--cid') + 1] : null;
const customOutput = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : null;
const methodTag = process.argv.includes('--method')
  ? process.argv[process.argv.indexOf('--method') + 1]
  : null;

// Non-flag argument = JSON file
const jsonFile = process.argv.slice(2).find((arg) =>
  !arg.startsWith('--') &&
  arg !== cidValue &&
  arg !== customOutput &&
  arg !== methodTag
);

if (!cidValue && !jsonFile) {
  console.error('Usage:');
  console.error('  node recovery/export-excel.mjs <recovered-data.json>');
  console.error('  node recovery/export-excel.mjs --cid <MANIFEST_CID>');
  console.error('\nOptions:');
  console.error('  --output <file.xlsx>   Custom output filename');
  console.error('  --method <1-4>         Tag recovery method used');
  process.exit(1);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  One-Click Excel Export                                 ║');
console.log('║  Aircraft maintenance → formatted spreadsheet          ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

let manifest;
let recoveryMethod = methodTag || 'unknown';

// ── Mode 1: Direct from IPFS manifest CID ───────────────
if (cidValue) {
  console.log(`Fetching manifest from IPFS: ${cidValue}...`);
  recoveryMethod = methodTag || 'manifest-cid';

  const { data, source } = await fetchFromIPFS(cidValue, config.ipfs || {});
  console.log(`  Source: ${source}`);
  manifest = data;

  // Verify manifest integrity
  const { manifest_hash: storedHash, ...body } = manifest;
  const recomputed = sha256(canonicalJson(body));
  if (recomputed !== storedHash) {
    console.error('  WARNING: Manifest integrity check FAILED. Data may be tampered.');
    console.error(`    Stored:     ${storedHash}`);
    console.error(`    Recomputed: ${recomputed}`);
  } else {
    console.log('  Manifest integrity: VERIFIED\n');
  }
}

// ── Mode 2: From recovered JSON file ────────────────────
if (jsonFile) {
  console.log(`Loading recovered data from: ${jsonFile}...`);

  const raw = JSON.parse(await readFile(jsonFile, 'utf-8'));

  // Support both formats: { manifest, recovered } or just the manifest directly
  if (raw.manifest) {
    manifest = raw.manifest;
    recoveryMethod = methodTag || 'recovered-json';
  } else if (raw.aircraft && raw.version !== undefined) {
    manifest = raw;
    recoveryMethod = methodTag || 'manifest-json';
  } else if (raw.records && raw.sourcesUsed) {
    // Cross-reference output — reshape into manifest format
    console.log('  Detected cross-reference recovery output. Reshaping...');
    const aircraftMap = new Map();
    for (const rec of raw.records) {
      const id = rec.fullData?.aircraft_id || 'unknown';
      if (!aircraftMap.has(id)) aircraftMap.set(id, []);
      aircraftMap.get(id).push(rec);
    }

    manifest = {
      version: 1,
      created_at: raw.recoveredAt,
      aircraft_count: aircraftMap.size,
      total_records: raw.recordCount,
      total_batches: 0,
      aircraft: [...aircraftMap.entries()].map(([id, records]) => ({
        aircraft_id: id,
        record_count: records.length,
        chain_head: records[records.length - 1]?.record_hash || '',
        records: records.map((r) => ({
          record_hash: r.record_hash,
          previous_hash: r.previous_hash,
          record_type: r.record_type,
          record_id: r.record_id || '',
          ipfs_cid: r.ipfs_cid || '',
          created_at: r.fullData?.created_at || '',
          server_signature: r.fullData?._blockchain?.server_signature || '',
          mechanic_signature: r.fullData?._blockchain?.mechanic_signature || '',
        })),
        maintenance_timers: {},
      })),
      batches: [],
    };
    recoveryMethod = methodTag || 'cross-reference';
  } else {
    console.error('  ERROR: Unrecognized JSON format.');
    console.error('  Expected output from Method 1-4 or a manifest JSON.');
    process.exit(1);
  }

  console.log('  Loaded successfully.\n');
}

// ── Validate hash chains ────────────────────────────────
console.log('Validating hash chains per aircraft...\n');

const chainStatus = {};
for (const aircraft of manifest.aircraft) {
  const result = validateChain(aircraft.records);
  chainStatus[aircraft.aircraft_id] = result;

  const status = result.intact
    ? `INTACT (${result.length} records linked)`
    : `BROKEN at ${result.breaks.length} points`;
  console.log(`  ${aircraft.aircraft_id}: ${status}`);
}
console.log('');

// ── Build Excel workbook ────────────────────────────────
console.log('Building Excel workbook...');

const wb = await buildWorkbook(manifest, {
  chainStatus,
  manifestCid: cidValue || '',
  recoveryMethod,
});

// ── Save ────────────────────────────────────────────────
const outputPath = customOutput ||
  `recovered-${manifest.aircraft.map((a) => a.aircraft_id).join('-')}-${Date.now()}.xlsx`;

await saveWorkbook(wb, outputPath);

const { stat } = await import('node:fs/promises');
const fileSize = (await stat(outputPath)).size;
const sizeKB = (fileSize / 1024).toFixed(1);

console.log('');
console.log('═'.repeat(60));
console.log('  EXCEL EXPORT COMPLETE');
console.log('═'.repeat(60));
console.log(`  File:       ${outputPath}`);
console.log(`  Size:       ${sizeKB} KB`);
console.log(`  Aircraft:   ${manifest.aircraft_count}`);
console.log(`  Records:    ${manifest.total_records}`);
console.log(`  Sheets:     ${manifest.aircraft_count + 1 + (manifest.batches?.length > 0 ? 1 : 0)}`);
console.log(`  Method:     ${recoveryMethod}`);
console.log('═'.repeat(60));
console.log('\n  Sheets in workbook:');
console.log('    1. Recovery Summary (blue tab)');
manifest.aircraft.forEach((a, i) => {
  console.log(`    ${i + 2}. ${a.aircraft_id} — ${a.record_count} records (green tab)`);
});
if (manifest.batches?.length > 0) {
  console.log(`    ${manifest.aircraft.length + 2}. Blockchain Anchors (purple tab)`);
}
console.log('\n  Open the .xlsx file in Excel, Google Sheets, or LibreOffice.\n');
