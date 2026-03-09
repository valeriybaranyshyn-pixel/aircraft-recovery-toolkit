/**
 * IPFS utilities for fetching and pinning aviation records.
 *
 * Supports:
 * - Local Kubo node (self-hosted)
 * - Public IPFS gateways (Pinata, Web3.Storage, ipfs.io, Cloudflare)
 * - Multi-pin (pin to multiple providers for redundancy)
 */

const DEFAULT_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://w3s.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

/**
 * Fetch JSON from IPFS by CID.
 * Tries local Kubo first, then falls back through public gateways.
 */
export async function fetchFromIPFS(cid, config = {}) {
  const sources = [];

  // Try local Kubo API first (fastest)
  if (config.localApi) {
    sources.push({
      name: 'Local Kubo',
      fetch: () =>
        fetch(`${config.localApi}/api/v0/cat?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(10000) }),
    });
  }

  // Then try each gateway
  const gateways = config.gateways || DEFAULT_GATEWAYS;
  for (const gw of gateways) {
    const name = new URL(gw).hostname;
    sources.push({
      name,
      fetch: () => fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(30000) }),
    });
  }

  for (const source of sources) {
    try {
      const res = await source.fetch();
      if (res.ok) {
        const data = await res.json();
        return { data, source: source.name };
      }
    } catch {
      // Try next source
    }
  }

  throw new Error(`IPFS fetch failed for CID ${cid} — tried ${sources.length} sources`);
}

/**
 * Pin JSON to local Kubo IPFS node.
 */
export async function pinToKubo(data, name, kuboApi) {
  const jsonStr = JSON.stringify(data);
  const boundary = '----FormBoundary' + Date.now();
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${name}.json"`,
    'Content-Type: application/json',
    '',
    jsonStr,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetch(`${kuboApi}/api/v0/add?pin=true`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Kubo pin failed: ${res.status} ${await res.text()}`);
  const result = await res.json();
  return result.Hash;
}

/**
 * Pin JSON to Pinata cloud service.
 */
export async function pinToPinata(data, name, jwt) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: data,
      pinataMetadata: { name },
    }),
  });
  if (!res.ok) throw new Error(`Pinata pin failed: ${res.status} ${await res.text()}`);
  const result = await res.json();
  return result.IpfsHash;
}

/**
 * Pin JSON to Web3.Storage (Filecoin-backed).
 */
export async function pinToWeb3Storage(data, name, token) {
  const jsonStr = JSON.stringify(data);
  const blob = new Blob([jsonStr], { type: 'application/json' });

  const res = await fetch('https://api.web3.storage/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: blob,
  });
  if (!res.ok) throw new Error(`Web3.Storage pin failed: ${res.status} ${await res.text()}`);
  const result = await res.json();
  return result.cid;
}

/**
 * Multi-pin: pin to all configured providers for redundancy.
 * Returns array of { provider, cid, success } results.
 */
export async function multiPin(data, name, config) {
  const results = [];

  // Local Kubo
  if (config.localApi) {
    try {
      const cid = await pinToKubo(data, name, config.localApi);
      results.push({ provider: 'kubo', cid, success: true });
    } catch (err) {
      results.push({ provider: 'kubo', error: err.message, success: false });
    }
  }

  // Pinata
  if (config.pinProviders?.pinata?.jwt) {
    try {
      const cid = await pinToPinata(data, name, config.pinProviders.pinata.jwt);
      results.push({ provider: 'pinata', cid, success: true });
    } catch (err) {
      results.push({ provider: 'pinata', error: err.message, success: false });
    }
  }

  // Web3.Storage
  if (config.pinProviders?.web3storage?.token) {
    try {
      const cid = await pinToWeb3Storage(data, name, config.pinProviders.web3storage.token);
      results.push({ provider: 'web3storage', cid, success: true });
    } catch (err) {
      results.push({ provider: 'web3storage', error: err.message, success: false });
    }
  }

  return results;
}

/**
 * List all pins on a local Kubo node.
 * Returns array of CIDs.
 */
export async function listKuboPins(kuboApi) {
  const res = await fetch(`${kuboApi}/api/v0/pin/ls?type=recursive`, { method: 'POST' });
  if (!res.ok) throw new Error(`Kubo pin list failed: ${res.status}`);
  const result = await res.json();
  return Object.keys(result.Keys || {});
}
