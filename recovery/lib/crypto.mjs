/**
 * Cryptographic utilities for aviation record verification.
 *
 * - SHA-256 hashing (record integrity)
 * - Ed25519 signature verification (server/mechanic authenticity)
 * - Canonical JSON (deterministic serialization for hashing)
 */

import crypto from 'node:crypto';

/** Deterministic JSON — sort keys recursively so hash is always the same */
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const sorted = Object.keys(obj).sort();
  return (
    '{' +
    sorted.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

/** SHA-256 hash of a string, returns hex */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Verify Ed25519 signature */
export function verifySignature(data, signatureHex, publicKeyHex) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a record's hash matches its data.
 * Strips blockchain metadata (_blockchain) before hashing.
 */
export function verifyRecordHash(recordData, expectedHash) {
  const { _blockchain, ...cleanData } = recordData;
  const canonical = canonicalJson(cleanData);
  const computed = sha256(canonical);
  return { match: computed === expectedHash, computed, expected: expectedHash };
}

/**
 * Walk a hash chain and detect breaks.
 * Returns { intact: boolean, breaks: number[], length: number }
 */
export function validateChain(records) {
  const breaks = [];

  if (records.length === 0) return { intact: true, breaks, length: 0 };
  if (records[0].previous_hash !== null) breaks.push(0);

  for (let i = 1; i < records.length; i++) {
    if (records[i].previous_hash !== records[i - 1].record_hash) {
      breaks.push(i);
    }
  }

  return {
    intact: breaks.length === 0,
    breaks,
    length: records.length,
  };
}
