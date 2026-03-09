# Aircraft Recovery Toolkit

Recover aircraft maintenance records from blockchain + IPFS when everything else is gone.

Built for [myAviationTools](https://myaviationtools.com) — an FAR 43.9-compliant digital maintenance logbook with cryptographic proof chains, Ethereum anchoring, and IPFS disaster recovery.

## How It Works

Every maintenance record is:
1. **Hashed** (SHA-256) and linked to the previous record (append-only chain)
2. **Signed** with Ed25519 (server + mechanic)
3. **Pinned to IPFS** (content-addressed, fetachable from any gateway)
4. **Batched** into Merkle trees and **anchored to Ethereum** (immutable timestamp proof)

If myaviationtools.com goes down, this toolkit recovers everything.

## Recovery Decision Tree

```
START: What do you have?
│
├─ "I have the manifest CID"
│   └─ Method 1: Full Recovery (fastest, most complete)
│      node recovery/method-1-manifest.mjs <CID>
│
├─ "I have access to the IPFS node but lost the CID"
│   └─ Method 2: Pin Discovery → finds CID → Method 1
│      node recovery/method-2-ipfs-discovery.mjs
│
├─ "Everything is gone except the blockchain"
│   └─ Method 3: Blockchain Forensics
│      node recovery/method-3-blockchain-forensics.mjs
│      │
│      ├─ Enhanced calldata (CIDs on-chain) → Full recovery via IPFS
│      └─ Legacy calldata (root only) → Verification + timeline only
│
├─ "I have partial data from multiple sources"
│   └─ Method 4: Cross-Reference (hybrid)
│      node recovery/method-4-cross-reference.mjs --ipfs --blockchain
│
└─ "I want to prevent this scenario"
    └─ Besu Backup: Export chain data for offsite storage
       node recovery/besu-backup.mjs
```

## Quick Start

```bash
# Install dependencies
npm install

# Recovery from manifest CID (one command)
node recovery/method-1-manifest.mjs QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW

# Export to Excel (one click)
node recovery/export-excel.mjs recovered-*.json

# Or do both in one step
node recovery/export-excel.mjs --cid QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW
```

## Recovery Methods

### Method 1: Full Recovery from Manifest CID

**Need:** One IPFS CID (written on paper, saved in email, stored on-chain)
**Get:** Every maintenance record, fully verified

```bash
node recovery/method-1-manifest.mjs <MANIFEST_CID>
```

Steps:
1. Fetch manifest from IPFS (tries local Kubo, then public gateways)
2. Verify manifest integrity (SHA-256)
3. Fetch every record per aircraft from IPFS
4. Verify each record hash
5. Walk the hash chain (detect missing/reordered records)
6. Output JSON ready for Excel export

### Method 2: IPFS Pin Discovery

**Need:** Access to the IPFS node (Kubo API), but you lost the manifest CID
**Get:** The manifest CID, then full recovery via Method 1

```bash
node recovery/method-2-ipfs-discovery.mjs
node recovery/method-2-ipfs-discovery.mjs --kubo http://localhost:5001
```

Steps:
1. List all pinned CIDs on the Kubo node
2. Fetch each and categorize (manifest / record / batch / unknown)
3. Find the most recent manifest
4. Print the `Method 1` command to run

### Method 3: Blockchain Forensics

**Need:** Access to Besu RPC or a chain backup file
**Get:** Depends on what was stored on-chain

```bash
# Live Besu node
node recovery/method-3-blockchain-forensics.mjs

# From backup file (no Besu needed)
node recovery/method-3-blockchain-forensics.mjs --backup chain-export.json

# Custom RPC
node recovery/method-3-blockchain-forensics.mjs --rpc http://besu:8545
```

**Enhanced calldata (Option 2: root + CIDs):**
- IPFS CIDs stored permanently on-chain
- Full recovery possible: Besu → extract CIDs → fetch from IPFS → done

**Legacy calldata (root only):**
- Timeline of when batches were anchored
- Ability to verify data someone provides
- Cannot recover actual records

### Method 4: Cross-Reference Recovery

**Need:** Partial data from multiple sources
**Get:** Best possible reconstruction

```bash
# Combine IPFS + blockchain
node recovery/method-4-cross-reference.mjs --ipfs --blockchain

# Use forensics output + IPFS
node recovery/method-4-cross-reference.mjs --forensics forensics-*.json --ipfs

# Old manifest + blockchain
node recovery/method-4-cross-reference.mjs --old-manifest QmOldCid... --blockchain
```

Steps:
1. Gather records from all available sources
2. Deduplicate by `record_hash`
3. Verify against blockchain Merkle roots
4. Identify gaps in hash chains
5. Output: what recovered + what's missing

### Besu Chain Backup

Export all anchor transactions for offsite storage. Run on a cron schedule.

```bash
node recovery/besu-backup.mjs
node recovery/besu-backup.mjs --output my-backup.json
node recovery/besu-backup.mjs --rpc http://besu:8545

# Cron (daily at 3 AM)
0 3 * * * cd /path/to/toolkit && node recovery/besu-backup.mjs
```

Store the backup file somewhere offsite: S3, Google Drive, USB drive, email.

## Excel Export

One-click conversion from recovered data to formatted spreadsheet.

```bash
# From recovered JSON (output of any Method)
node recovery/export-excel.mjs recovered-1741234567890.json

# Direct from manifest CID (recovery + export in one step)
node recovery/export-excel.mjs --cid QmTy79EmEwiMTr24ZUjbjN46kdmaMrBM6v54ehLi3KbsFW

# Custom output filename
node recovery/export-excel.mjs data.json --output my-report.xlsx
```

**Workbook structure:**
| Sheet | Tab Color | Contents |
|-------|-----------|----------|
| Recovery Summary | Blue | Manifest metadata, aircraft overview |
| {Tail Number} | Green | Maintenance timers + color-coded record timeline (one per aircraft) |
| Blockchain Anchors | Purple | Merkle roots, TX hashes, block numbers |

**Record type colors:**
| Type | Color |
|------|-------|
| Discrepancy | Orange |
| Corrective Action | Green |
| Inspection | Blue |
| AD Compliance | Red |
| Component Install | Purple |

Each aircraft sheet includes **maintenance timer intervals** — these are different per aircraft (e.g., 100-hour vs 4-phase progressive inspection).

## Gas Cost Analysis

Compare Option 1 (Merkle root only) vs Option 2 (root + IPFS CIDs) on-chain storage costs.

```bash
node docs/gas-cost-analysis.mjs
node docs/gas-cost-analysis.mjs --eth-price 3500
```

**Summary:** On private Besu, Option 2 costs $0 extra. On public Ethereum at 15 gwei, Option 2 adds ~$0.04/tx (~$13.87/year for daily batches). The extra cost buys full blockchain-based disaster recovery.

## Configuration

Copy `config.example.json` to `config.json` and fill in your values:

```json
{
  "besu": {
    "rpcUrl": "http://localhost:8545",
    "chainId": 43900,
    "walletAddress": "0x..."
  },
  "ipfs": {
    "localApi": "http://localhost:5001",
    "pinataJwt": "...",
    "web3StorageToken": "...",
    "gateways": [
      "https://gateway.pinata.cloud/ipfs/",
      "https://ipfs.io/ipfs/",
      "https://dweb.link/ipfs/"
    ]
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         RECOVERY FLOW                           │
│                                                                  │
│  Method 1          Method 2          Method 3        Method 4   │
│  (CID known)       (scan pins)       (chain only)    (hybrid)   │
│       │                 │                 │              │       │
│       ▼                 ▼                 ▼              ▼       │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐   ┌──────────┐ │
│  │  Fetch   │     │  List    │     │  Scan    │   │  Gather  │ │
│  │ manifest │     │  IPFS    │     │  Besu    │   │  from    │ │
│  │ from CID │     │  pins    │     │  blocks  │   │  all     │ │
│  └────┬─────┘     └────┬─────┘     └────┬─────┘   │  sources │ │
│       │                 │                │          └────┬─────┘ │
│       ▼                 ▼                ▼               │       │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐         │       │
│  │ Verify   │     │ Find     │     │ Extract  │         │       │
│  │ SHA-256  │     │ manifest │     │ calldata │         │       │
│  │ + chain  │     │ → CID    │     │ (CIDs?)  │         │       │
│  └────┬─────┘     └────┬─────┘     └────┬─────┘         │       │
│       │                 │                │               │       │
│       ▼                 ▼                ▼               ▼       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              RECOVERED MAINTENANCE DATA                   │   │
│  │                     (JSON)                                │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│                     ┌──────────────┐                             │
│                     │  Excel       │                             │
│                     │  Export      │                             │
│                     │  (.xlsx)     │                             │
│                     └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

## IPFS Multi-Pin Strategy

Pin data to multiple providers so any single survivor enables full recovery:

| Provider | Type | Durability |
|----------|------|-----------|
| Kubo (local) | Self-hosted | You control it |
| Pinata | Commercial SaaS | Enterprise SLA |
| Web3.Storage | Free (Filecoin) | Filecoin deals |

If Kubo goes down, Pinata still has it. If Pinata goes down, Web3.Storage still has it. Content-addressed means anyone with a pin can re-host.

## File Structure

```
aircraft-recovery-toolkit/
├── config.example.json          # Configuration template
├── package.json                 # Dependencies
├── README.md                    # This file
├── LICENSE                      # MIT
├── recovery/
│   ├── method-1-manifest.mjs    # Full recovery from CID
│   ├── method-2-ipfs-discovery.mjs  # Find CID from pins
│   ├── method-3-blockchain-forensics.mjs  # Chain-only recovery
│   ├── method-4-cross-reference.mjs  # Hybrid from partials
│   ├── export-excel.mjs         # One-click Excel export
│   ├── besu-backup.mjs          # Chain export for offsite
│   └── lib/
│       ├── crypto.mjs           # SHA-256, Ed25519, chain validation
│       ├── ipfs.mjs             # IPFS fetch, multi-pin
│       ├── blockchain.mjs       # Besu client, calldata parsing
│       └── excel.mjs            # ExcelJS workbook builder
├── examples/
│   └── sample-manifest.json     # Example manifest with 2 aircraft
└── docs/
    └── gas-cost-analysis.mjs    # Option 1 vs 2 cost comparison
```

## Requirements

- Node.js 18+
- Access to one or more: IPFS node, Besu RPC, backup file, manifest CID

## License

MIT
