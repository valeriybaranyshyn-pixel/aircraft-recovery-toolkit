/**
 * Blockchain utilities for scanning Besu chain data.
 *
 * Reads transactions, extracts calldata (Merkle roots + IPFS CIDs),
 * and supports chain export/import for offsite backup.
 */

import { createPublicClient, http, defineChain } from 'viem';

/**
 * Create a viem public client for the Besu chain.
 */
export function createBesuClient(config) {
  const chain = defineChain({
    id: config.chainId || 43900,
    name: 'myAviationTools Private',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  return createPublicClient({ chain, transport: http(config.rpcUrl) });
}

/**
 * Calldata format (Option 2 — enhanced):
 *
 *   Bytes 0-31:   Merkle root (32 bytes)
 *   Bytes 32-77:  Manifest CID (46 bytes, base58 string)
 *   Bytes 78-123: Batch CID (46 bytes, base58 string)
 *
 * Legacy format (Option 1):
 *   Bytes 0-31:   Merkle root only
 */
export function parseCalldata(inputHex) {
  const raw = inputHex.startsWith('0x') ? inputHex.slice(2) : inputHex;

  // Merkle root is always the first 64 hex chars (32 bytes)
  const merkleRoot = '0x' + raw.slice(0, 64);

  // If calldata is longer than 64 chars, it contains CIDs (Option 2)
  let manifestCid = null;
  let batchCid = null;

  if (raw.length > 64) {
    // CIDs are stored as hex-encoded UTF-8 strings
    const cidData = raw.slice(64);
    // Split at the boundary — CIDv0 starts with "Qm" (0x516d in hex)
    const cidHex = Buffer.from(cidData, 'hex').toString('utf-8');
    const cids = cidHex.match(/Qm[1-9A-HJ-NP-Za-km-z]{44}/g) || [];
    if (cids.length >= 1) manifestCid = cids[0];
    if (cids.length >= 2) batchCid = cids[1];
  }

  return { merkleRoot, manifestCid, batchCid, isEnhanced: raw.length > 64 };
}

/**
 * Scan all blocks for aviation anchor transactions.
 * Looks for transactions FROM the known wallet address.
 * Returns array of { blockNumber, timestamp, txHash, calldata (parsed) }.
 */
export async function scanChain(client, walletAddress, options = {}) {
  const latestBlock = await client.getBlockNumber();
  const fromBlock = BigInt(options.fromBlock || 0);
  const toBlock = options.toBlock ? BigInt(options.toBlock) : latestBlock;

  const results = [];
  const addr = walletAddress.toLowerCase();

  console.log(`  Scanning blocks ${fromBlock} to ${toBlock} (${toBlock - fromBlock + 1n} blocks)...`);

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    const block = await client.getBlock({ blockNumber: blockNum, includeTransactions: true });

    for (const tx of block.transactions) {
      // Only look at self-transactions from the anchor wallet
      if (tx.from?.toLowerCase() === addr && tx.to?.toLowerCase() === addr && tx.input !== '0x') {
        const parsed = parseCalldata(tx.input);
        results.push({
          blockNumber: Number(blockNum),
          timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
          txHash: tx.hash,
          gasUsed: tx.gas,
          ...parsed,
        });
      }
    }
  }

  console.log(`  Found ${results.length} anchor transactions.`);
  return results;
}

/**
 * Get the raw transaction data for a specific tx hash.
 * Used to verify on-chain Merkle root matches our computed root.
 */
export async function getTransactionCalldata(client, txHash) {
  const tx = await client.getTransaction({ hash: txHash });
  return parseCalldata(tx.input);
}

/**
 * Export chain data: all anchor transactions + block metadata.
 * This JSON file can be stored offsite and used for recovery
 * even if the Besu node is completely destroyed.
 */
export async function exportChainData(client, walletAddress, options = {}) {
  const anchors = await scanChain(client, walletAddress, options);

  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    chainId: options.chainId || 43900,
    walletAddress,
    blockRange: {
      from: options.fromBlock || 0,
      to: options.toBlock || Number(await client.getBlockNumber()),
    },
    anchorCount: anchors.length,
    anchors,
  };
}
