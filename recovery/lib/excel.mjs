/**
 * Excel export utilities.
 *
 * Turns recovered aircraft maintenance data into a formatted .xlsx workbook
 * with one sheet per aircraft, full maintenance timeline, and timer intervals.
 */

import ExcelJS from 'exceljs';

/**
 * Color map for record types.
 */
const TYPE_COLORS = {
  discrepancy: { fill: 'FFF3E0', font: 'E65100' },       // Orange
  corrective_action: { fill: 'E8F5E9', font: '2E7D32' }, // Green
  inspection: { fill: 'E3F2FD', font: '1565C0' },         // Blue
  ad_compliance: { fill: 'FCE4EC', font: 'C62828' },      // Red
  component_install: { fill: 'F3E5F5', font: '6A1B9A' },  // Purple
};

/**
 * Create an Excel workbook from recovered manifest data.
 *
 * @param {object} manifest - The recovery manifest
 * @param {object} options - { verificationResults, chainStatus }
 * @returns {ExcelJS.Workbook}
 */
export async function buildWorkbook(manifest, options = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'aircraft-recovery-toolkit';
  wb.created = new Date();

  // Summary sheet
  addSummarySheet(wb, manifest, options);

  // One sheet per aircraft
  for (const aircraft of manifest.aircraft) {
    addAircraftSheet(wb, aircraft, options);
  }

  // Blockchain anchors sheet
  if (manifest.batches?.length > 0) {
    addAnchorsSheet(wb, manifest.batches);
  }

  return wb;
}

function addSummarySheet(wb, manifest, options) {
  const ws = wb.addWorksheet('Recovery Summary', {
    properties: { tabColor: { argb: 'FF1565C0' } },
  });

  // Title
  ws.mergeCells('A1:F1');
  const title = ws.getCell('A1');
  title.value = 'Aircraft Maintenance Recovery Report';
  title.font = { size: 16, bold: true, color: { argb: 'FF1565C0' } };
  title.alignment = { horizontal: 'center' };

  // Metadata
  const meta = [
    ['Recovery Date', new Date().toISOString()],
    ['Manifest Version', manifest.version],
    ['Manifest Created', manifest.created_at],
    ['Total Aircraft', manifest.aircraft_count],
    ['Total Records', manifest.total_records],
    ['Total Batches', manifest.total_batches],
    ['Manifest Hash', manifest.manifest_hash],
  ];

  if (options.manifestCid) meta.push(['Manifest CID', options.manifestCid]);
  if (options.recoveryMethod) meta.push(['Recovery Method', options.recoveryMethod]);

  let row = 3;
  for (const [label, value] of meta) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`B${row}`).value = value;
    row++;
  }

  // Aircraft table
  row += 2;
  ws.getCell(`A${row}`).value = 'Aircraft Overview';
  ws.getCell(`A${row}`).font = { size: 14, bold: true };
  row++;

  const headerRow = ws.getRow(row);
  const headers = ['Tail Number', 'Records', 'Chain Head', 'Chain Status'];
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
  });
  row++;

  for (const ac of manifest.aircraft) {
    const chainOk = options.chainStatus?.[ac.aircraft_id]?.intact ?? 'Unknown';
    ws.getRow(row).values = [
      ac.aircraft_id,
      ac.record_count,
      ac.chain_head?.slice(0, 16) + '...',
      chainOk === true ? 'Intact' : chainOk === false ? 'BROKEN' : 'Unknown',
    ];
    row++;
  }

  ws.columns = [
    { width: 20 }, { width: 15 }, { width: 30 }, { width: 15 }, { width: 15 }, { width: 15 },
  ];
}

function addAircraftSheet(wb, aircraft, options) {
  const ws = wb.addWorksheet(aircraft.aircraft_id, {
    properties: { tabColor: { argb: 'FF2E7D32' } },
  });

  // Title
  ws.mergeCells('A1:J1');
  const title = ws.getCell('A1');
  title.value = `${aircraft.aircraft_id} — Maintenance Timeline`;
  title.font = { size: 14, bold: true };
  title.alignment = { horizontal: 'center' };

  // Maintenance timers (different per aircraft)
  if (aircraft.maintenance_timers) {
    let row = 3;
    ws.getCell(`A${row}`).value = 'Maintenance Intervals';
    ws.getCell(`A${row}`).font = { size: 12, bold: true, color: { argb: 'FFE65100' } };
    row++;

    const timerHeader = ws.getRow(row);
    ['Task', 'Interval Type', 'Interval Value', 'Unit'].forEach((h, i) => {
      const cell = timerHeader.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE65100' } };
    });
    row++;

    for (const [task, timer] of Object.entries(aircraft.maintenance_timers)) {
      ws.getRow(row).values = [
        task.replace(/_/g, ' '),
        timer.interval_type,
        timer.interval_value,
        timer.unit,
      ];
      row++;
    }
    row++;
  }

  // Records table
  let recRow = ws.lastRow ? ws.lastRow.number + 2 : 3;
  ws.getCell(`A${recRow}`).value = 'Maintenance Records';
  ws.getCell(`A${recRow}`).font = { size: 12, bold: true, color: { argb: 'FF1565C0' } };
  recRow++;

  const recHeaders = [
    '#', 'Date', 'Type', 'Record ID', 'Hash (first 16)',
    'Previous Hash', 'IPFS CID', 'Server Sig', 'Mechanic Sig', 'Batch Linked',
  ];
  const headerRow = ws.getRow(recRow);
  recHeaders.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
  });
  recRow++;

  for (let i = 0; i < aircraft.records.length; i++) {
    const rec = aircraft.records[i];
    const row = ws.getRow(recRow);
    row.values = [
      i + 1,
      rec.created_at,
      rec.record_type,
      rec.record_id?.slice(0, 8) + '...',
      rec.record_hash?.slice(0, 16) + '...',
      rec.previous_hash ? rec.previous_hash.slice(0, 16) + '...' : '(genesis)',
      rec.ipfs_cid || 'N/A',
      rec.server_signature ? 'Yes' : 'No',
      rec.mechanic_signature ? 'Yes' : 'No',
      rec.anchor_batch_id ? 'Yes' : 'No',
    ];

    // Color-code by record type
    const colors = TYPE_COLORS[rec.record_type] || { fill: 'FFFFFF', font: '000000' };
    row.getCell(3).fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FF' + colors.fill },
    };
    row.getCell(3).font = { color: { argb: 'FF' + colors.font }, bold: true };

    recRow++;
  }

  // Chain integrity summary at bottom
  recRow += 2;
  const chainResult = options.chainStatus?.[aircraft.aircraft_id];
  if (chainResult) {
    ws.getCell(`A${recRow}`).value = 'Chain Integrity:';
    ws.getCell(`A${recRow}`).font = { bold: true };
    ws.getCell(`B${recRow}`).value = chainResult.intact ? 'INTACT' : `BROKEN at records: ${chainResult.breaks.join(', ')}`;
    ws.getCell(`B${recRow}`).font = {
      color: { argb: chainResult.intact ? 'FF2E7D32' : 'FFC62828' },
      bold: true,
    };
  }

  ws.columns = [
    { width: 5 }, { width: 22 }, { width: 18 }, { width: 14 },
    { width: 20 }, { width: 20 }, { width: 50 },
    { width: 10 }, { width: 12 }, { width: 12 },
  ];
}

function addAnchorsSheet(wb, batches) {
  const ws = wb.addWorksheet('Blockchain Anchors', {
    properties: { tabColor: { argb: 'FF6A1B9A' } },
  });

  ws.mergeCells('A1:G1');
  const title = ws.getCell('A1');
  title.value = 'Blockchain Anchor Batches';
  title.font = { size: 14, bold: true };
  title.alignment = { horizontal: 'center' };

  const headers = ['#', 'Merkle Root', 'Records', 'Chain', 'TX Hash', 'Block', 'Status'];
  const headerRow = ws.getRow(3);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6A1B9A' } };
  });

  batches.forEach((b, i) => {
    const row = ws.getRow(4 + i);
    row.values = [
      i + 1,
      b.merkle_root,
      b.record_count,
      b.chain || 'private',
      b.tx_hash || 'N/A',
      b.block_number || 'N/A',
      b.anchor_status,
    ];

    // Color status cell
    const statusCell = row.getCell(7);
    if (b.anchor_status === 'anchored') {
      statusCell.font = { color: { argb: 'FF2E7D32' }, bold: true };
    } else {
      statusCell.font = { color: { argb: 'FFE65100' }, bold: true };
    }
  });

  ws.columns = [
    { width: 5 }, { width: 68 }, { width: 10 }, { width: 10 },
    { width: 68 }, { width: 8 }, { width: 12 },
  ];
}

/**
 * Save workbook to file.
 */
export async function saveWorkbook(wb, filename) {
  await wb.xlsx.writeFile(filename);
  return filename;
}
