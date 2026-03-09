/**
 * Excel export utilities.
 *
 * Turns recovered aircraft maintenance data into a formatted .xlsx workbook
 * with one sheet per aircraft showing actual maintenance content: logbook
 * entries with work performed, parts used, components with TSN/TSO/TBO
 * tracking, and scheduled maintenance reminders with status color coding.
 */

import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Color map for record types — fill and font ARGB hex (no leading FF).
 */
const TYPE_COLORS = {
  discrepancy:      { fill: 'FFF3E0', font: 'E65100' }, // Orange
  corrective_action:{ fill: 'E8F5E9', font: '2E7D32' }, // Green
  inspection:       { fill: 'E3F2FD', font: '1565C0' }, // Blue
  ad_compliance:    { fill: 'FCE4EC', font: 'C62828' }, // Red
  component_install:{ fill: 'F3E5F5', font: '6A1B9A' }, // Purple
};

/** Reminder status → fill/font colors. */
const STATUS_COLORS = {
  current:  { fill: 'E8F5E9', font: '2E7D32' }, // Green
  due_soon: { fill: 'FFF8E1', font: 'F57F17' }, // Amber
  overdue:  { fill: 'FFEBEE', font: 'C62828' }, // Red
};

/** Component status → fill/font colors. */
const COMPONENT_STATUS_COLORS = {
  installed: { fill: 'E8F5E9', font: '2E7D32' }, // Green
  removed:   { fill: 'FFEBEE', font: 'C62828' }, // Red
  scrapped:  { fill: 'F5F5F5', font: '757575' }, // Grey
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a solid-fill + font color to a cell.
 * @param {ExcelJS.Cell} cell
 * @param {string} fillArgb - 6-char hex, no leading FF (e.g. 'E8F5E9')
 * @param {string} fontArgb - 6-char hex, no leading FF (e.g. '2E7D32')
 * @param {boolean} [bold=false]
 */
function colorCell(cell, fillArgb, fontArgb, bold = false) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + fillArgb } };
  cell.font = { ...cell.font, color: { argb: 'FF' + fontArgb }, bold };
}

/**
 * Apply standard section-header styling to a cell (left-aligned, large, bold).
 * @param {ExcelJS.Cell} cell
 * @param {string} text
 * @param {string} [colorArgb='1565C0'] - 6-char hex
 * @param {number} [size=12]
 */
function sectionHeader(cell, text, colorArgb = '1565C0', size = 12) {
  cell.value = text;
  cell.font = { size, bold: true, color: { argb: 'FF' + colorArgb } };
}

/**
 * Style a header row: bold white text on a colored background.
 * @param {ExcelJS.Row} row
 * @param {string[]} headers
 * @param {string} [bgArgb='1565C0'] - 6-char hex
 */
function styleHeaderRow(row, headers, bgArgb = '1565C0') {
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgArgb } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 20;
}

/**
 * Format a record type string for display.
 * @param {string} type
 * @returns {string}
 */
function formatType(type) {
  const map = {
    discrepancy:       'Discrepancy',
    corrective_action: 'Corrective Action',
    inspection:        'Inspection',
    ad_compliance:     'AD Compliance',
    component_install: 'Component Install',
  };
  return map[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Format a reminder interval for display.
 * @param {object} reminder
 * @returns {string}
 */
function formatInterval(reminder) {
  const hrs = reminder.interval_hours;
  const mo  = reminder.interval_calendar_months;
  if (hrs && mo)  return `${hrs} hrs / ${mo} mo`;
  if (hrs)        return `${hrs} hours`;
  if (mo)         return `${mo} months`;
  return '—';
}

/**
 * Produce a short hash string (first 16 chars + '...') or a fallback.
 * @param {string|null|undefined} hash
 * @param {string} [fallback='—']
 * @returns {string}
 */
function shortHash(hash, fallback = '—') {
  return hash ? hash.slice(0, 16) + '…' : fallback;
}

/**
 * Safe string — return value or em-dash if null/undefined.
 * @param {*} v
 * @returns {string|number}
 */
function s(v) {
  return (v === null || v === undefined || v === '') ? '—' : v;
}

/**
 * Format a number as USD currency string.
 * @param {number|null|undefined} v
 * @returns {string}
 */
function usd(v) {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
}

/**
 * Add a thin-bordered empty row spacer by setting its height.
 * Returns the new row number after the spacer.
 * @param {ExcelJS.Worksheet} ws
 * @param {number} rowNum
 * @returns {number}
 */
function spacer(ws, rowNum) {
  ws.getRow(rowNum).height = 8;
  return rowNum + 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an Excel workbook from recovered manifest data.
 *
 * @param {object} manifest - The recovery manifest (v2 format)
 * @param {object} [options] - { chainStatus, manifestCid, recoveryMethod }
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildWorkbook(manifest, options = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'aircraft-recovery-toolkit';
  wb.created = new Date();

  addSummarySheet(wb, manifest, options);

  for (const aircraft of manifest.aircraft) {
    addAircraftSheet(wb, aircraft, options);
  }

  if (manifest.batches?.length > 0) {
    addAnchorsSheet(wb, manifest.batches);
  }

  return wb;
}

/**
 * Save workbook to file.
 *
 * @param {ExcelJS.Workbook} wb
 * @param {string} filename
 * @returns {Promise<string>}
 */
export async function saveWorkbook(wb, filename) {
  await wb.xlsx.writeFile(filename);
  return filename;
}

// ---------------------------------------------------------------------------
// Sheet: Recovery Summary
// ---------------------------------------------------------------------------

function addSummarySheet(wb, manifest, options) {
  const ws = wb.addWorksheet('Recovery Summary', {
    properties: { tabColor: { argb: 'FF1565C0' } },
  });

  // ---- Title ----
  ws.mergeCells('A1:H1');
  const title = ws.getCell('A1');
  title.value = 'Aircraft Maintenance Recovery Report';
  title.font = { size: 16, bold: true, color: { argb: 'FF1565C0' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 32;

  // ---- Metadata block ----
  const meta = [
    ['Recovery Date',    new Date().toLocaleString('en-US', { timeZoneName: 'short' })],
    ['Manifest Version', manifest.version ?? '—'],
    ['Manifest Created', manifest.created_at ?? '—'],
    ['Total Aircraft',   manifest.aircraft_count ?? manifest.aircraft?.length ?? '—'],
    ['Total Records',    manifest.total_records ?? '—'],
    ['Total Batches',    manifest.total_batches ?? manifest.batches?.length ?? '—'],
    ['Manifest Hash',    manifest.manifest_hash ?? '—'],
  ];
  if (options.manifestCid)    meta.push(['Manifest CID',     options.manifestCid]);
  if (options.recoveryMethod) meta.push(['Recovery Method',  options.recoveryMethod]);

  let row = 3;
  for (const [label, value] of meta) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`B${row}`).value = value;
    row++;
  }

  // ---- Aircraft Overview table ----
  row = spacer(ws, row + 1);
  sectionHeader(ws.getCell(`A${row}`), 'Aircraft Overview', '1565C0', 13);
  ws.mergeCells(`A${row}:H${row}`);
  row++;

  const ovHeaders = [
    'Tail Number', 'Make', 'Model', 'Total Time (hrs)',
    'Records', 'Components', 'Reminders', 'Chain Status',
  ];
  styleHeaderRow(ws.getRow(row), ovHeaders, '1565C0');
  row++;

  for (const ac of manifest.aircraft) {
    const chainResult = options.chainStatus?.[ac.aircraft_id];
    let chainLabel = 'Unknown';
    let chainFill  = 'F5F5F5';
    let chainFont  = '757575';
    if (chainResult?.intact === true)  { chainLabel = 'Intact'; chainFill = 'E8F5E9'; chainFont = '2E7D32'; }
    if (chainResult?.intact === false) { chainLabel = 'BROKEN'; chainFill = 'FFEBEE'; chainFont = 'C62828'; }

    const dataRow = ws.getRow(row);
    dataRow.values = [
      ac.aircraft_id,
      ac.make ?? '—',
      ac.model ?? '—',
      ac.total_time_hours ?? '—',
      ac.record_count ?? ac.records?.length ?? 0,
      ac.components?.length ?? 0,
      ac.reminders?.length ?? 0,
      chainLabel,
    ];
    dataRow.height = 18;

    // Style chain status cell (col 8)
    colorCell(dataRow.getCell(8), chainFill, chainFont, chainResult?.intact === false);

    row++;
  }

  ws.columns = [
    { width: 14 }, // Tail
    { width: 14 }, // Make
    { width: 22 }, // Model
    { width: 18 }, // Total Time
    { width: 10 }, // Records
    { width: 13 }, // Components
    { width: 12 }, // Reminders
    { width: 14 }, // Chain Status
  ];
}

// ---------------------------------------------------------------------------
// Sheet: Per-Aircraft (green tab)
// ---------------------------------------------------------------------------

function addAircraftSheet(wb, aircraft, options) {
  // Truncate sheet name to Excel's 31-char limit
  const sheetName = (aircraft.aircraft_id ?? 'Unknown').slice(0, 31);
  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: 'FF2E7D32' } },
  });

  let row = 1;

  // =========================================================================
  // A) Aircraft Header
  // =========================================================================
  const makeModel = [aircraft.make, aircraft.model].filter(Boolean).join(' ');
  const titleText = makeModel
    ? `${aircraft.aircraft_id} — ${makeModel}`
    : `${aircraft.aircraft_id} — Maintenance Records`;

  ws.mergeCells(`A${row}:K${row}`);
  const titleCell = ws.getCell(`A${row}`);
  titleCell.value = titleText;
  titleCell.font  = { size: 15, bold: true, color: { argb: 'FF1B5E20' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(row).height = 30;
  row++;

  if (aircraft.total_time_hours != null) {
    ws.mergeCells(`A${row}:K${row}`);
    const tthCell = ws.getCell(`A${row}`);
    tthCell.value = `Total Airframe Hours: ${aircraft.total_time_hours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    tthCell.font  = { size: 11, italic: true, color: { argb: 'FF33691E' } };
    tthCell.alignment = { horizontal: 'center' };
    row++;
  }

  row = spacer(ws, row);

  // =========================================================================
  // B) Maintenance Log
  // =========================================================================
  sectionHeader(ws.getCell(`A${row}`), 'Maintenance Log', '1565C0', 12);
  ws.mergeCells(`A${row}:K${row}`);
  row++;

  const logHeaders = [
    '#', 'Date', 'Type', 'ATA', 'Description',
    'Work Performed', 'Mechanic', 'Cert #', 'RTS', 'Cost', 'Priority / AD Ref',
  ];
  styleHeaderRow(ws.getRow(row), logHeaders, '1565C0');
  row++;

  const records = aircraft.records ?? [];

  for (let i = 0; i < records.length; i++) {
    const rec  = records[i];
    const d    = rec.data ?? {};
    const type = rec.record_type ?? '';

    const date         = d.date_performed ?? d.date_reported ?? rec.created_at ?? '—';
    const description  = s(d.description);
    const workPerformed = s(d.work_performed);
    const mechanic     = d.performed_by_name ?? d.reported_by_name ?? '—';
    const certNum      = d.cert_number ?? d.reported_by_cert_number ?? '—';
    const rts          = d.return_to_service ? 'Yes' : '';
    const cost         = d.total_cost != null ? usd(d.total_cost) : '—';
    const priorityOrAd = d.ad_reference ?? d.priority ?? '—';

    const dataRow = ws.getRow(row);
    dataRow.values = [
      i + 1,
      date,
      formatType(type),
      s(d.ata_chapter),
      description,
      workPerformed,
      mechanic,
      certNum,
      rts,
      cost,
      priorityOrAd,
    ];

    // Wrap + tall rows for long work performed text
    dataRow.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    dataRow.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    dataRow.height = workPerformed && workPerformed !== '—' ? 80 : 20;

    // Color-code the Type cell
    const colors = TYPE_COLORS[type] ?? { fill: 'FFFFFF', font: '212121' };
    colorCell(dataRow.getCell(3), colors.fill, colors.font, true);

    // RTS cell: green if yes
    if (rts === 'Yes') {
      colorCell(dataRow.getCell(9), 'E8F5E9', '2E7D32', true);
    }

    row++;
  }

  row = spacer(ws, row);

  // =========================================================================
  // C) Parts Used
  // =========================================================================
  const allParts = [];
  for (let i = 0; i < records.length; i++) {
    const rec   = records[i];
    const parts = rec.data?.parts ?? [];
    if (parts.length > 0) {
      for (const part of parts) {
        allParts.push({ recNum: i + 1, ...part });
      }
    }
  }

  if (allParts.length > 0) {
    sectionHeader(ws.getCell(`A${row}`), 'Parts Used', 'E65100', 12);
    ws.mergeCells(`A${row}:K${row}`);
    row++;

    const partsHeaders = [
      'Rec #', 'Action', 'Part Number', 'Serial Number', 'Description',
      'Condition', 'Vendor', 'FAA 8130 Ref', '', '', '',
    ];
    styleHeaderRow(ws.getRow(row), partsHeaders, 'E65100');
    row++;

    for (const part of allParts) {
      const dataRow = ws.getRow(row);
      dataRow.values = [
        part.recNum,
        s(part.action),
        s(part.part_number),
        s(part.serial_number),
        s(part.description),
        s(part.condition),
        s(part.vendor),
        s(part.faa_8130_reference),
      ];
      dataRow.height = 18;

      // Color action cell
      if (part.action === 'installed') {
        colorCell(dataRow.getCell(2), 'E8F5E9', '2E7D32');
      } else if (part.action === 'removed') {
        colorCell(dataRow.getCell(2), 'FFEBEE', 'C62828');
      }

      row++;
    }

    row = spacer(ws, row);
  }

  // =========================================================================
  // D) Components
  // =========================================================================
  const components = aircraft.components ?? [];

  if (components.length > 0) {
    sectionHeader(ws.getCell(`A${row}`), 'Installed Components', '6A1B9A', 12);
    ws.mergeCells(`A${row}:K${row}`);
    row++;

    const compHeaders = [
      'Type', 'Position', 'Make / Model', 'Part Number', 'Serial Number',
      'TSN (hrs)', 'TSO (hrs)', 'TBO (hrs)', 'Status', 'Installed Date', 'Next Due (hrs)',
    ];
    styleHeaderRow(ws.getRow(row), compHeaders, '6A1B9A');
    row++;

    for (const comp of components) {
      const makeModel = [comp.make, comp.model].filter(Boolean).join(' ');
      const tbo       = comp.tbo_hours != null ? comp.tbo_hours : 'On Condition';
      const nextDue   = comp.next_due_hours ?? '—';

      const dataRow = ws.getRow(row);
      dataRow.values = [
        s(comp.component_type),
        s(comp.position_label),
        makeModel || '—',
        s(comp.part_number),
        s(comp.serial_number),
        comp.tsn_hours ?? '—',
        comp.tso_hours ?? '—',
        tbo,
        s(comp.status),
        s(comp.installed_date),
        nextDue,
      ];
      dataRow.height = 18;

      // Color status cell (col 9)
      const sc = COMPONENT_STATUS_COLORS[comp.status] ?? { fill: 'F5F5F5', font: '757575' };
      colorCell(dataRow.getCell(9), sc.fill, sc.font);

      // On Condition in italic for TBO col (col 8)
      if (tbo === 'On Condition') {
        dataRow.getCell(8).font = { italic: true, color: { argb: 'FF757575' } };
      }

      row++;
    }

    row = spacer(ws, row);

    // =========================================================================
    // E) Component Life Events
    // =========================================================================
    const lifeEvents = [];
    for (const comp of components) {
      const label = comp.position_label ?? comp.component_type ?? '?';
      for (const ev of comp.life_events ?? []) {
        lifeEvents.push({ component: label, ...ev });
      }
    }

    if (lifeEvents.length > 0) {
      sectionHeader(ws.getCell(`A${row}`), 'Component Life Events', '4A148C', 11);
      ws.mergeCells(`A${row}:K${row}`);
      row++;

      const evHeaders = [
        'Component', 'Event Type', 'Date', 'Performed By',
        'Description', 'TSN at Event', 'TSO at Event', '', '', '', '',
      ];
      styleHeaderRow(ws.getRow(row), evHeaders, '4A148C');
      row++;

      for (const ev of lifeEvents) {
        const dataRow = ws.getRow(row);
        dataRow.values = [
          s(ev.component),
          s(ev.event_type),
          s(ev.date),
          s(ev.performed_by),
          s(ev.description),
          ev.component_tsn_at ?? '—',
          ev.component_tso_at ?? '—',
        ];
        dataRow.getCell(5).alignment = { wrapText: true, vertical: 'top' };
        dataRow.height = 20;
        row++;
      }

      row = spacer(ws, row);
    }
  }

  // =========================================================================
  // F) Reminders / Scheduled Maintenance
  // =========================================================================
  const reminders = aircraft.reminders ?? [];

  if (reminders.length > 0) {
    sectionHeader(ws.getCell(`A${row}`), 'Scheduled Maintenance & Reminders', 'BF360C', 12);
    ws.mergeCells(`A${row}:K${row}`);
    row++;

    const remHeaders = [
      'Task', 'Source / Reference', 'Priority', 'Interval',
      'Last Done Date', 'Last Done (hrs)', 'Next Due Date', 'Next Due (hrs)', 'Status', '', '',
    ];
    styleHeaderRow(ws.getRow(row), remHeaders, 'BF360C');
    row++;

    for (const rem of reminders) {
      const interval    = formatInterval(rem);
      const status      = rem.status ?? 'current';
      const statusLabel = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const isRequired  = rem.priority === 'required';

      const dataRow = ws.getRow(row);
      dataRow.values = [
        s(rem.task_name),
        s(rem.source_reference),
        rem.priority ? rem.priority.charAt(0).toUpperCase() + rem.priority.slice(1) : '—',
        interval,
        s(rem.last_completed_date),
        rem.last_completed_hours ?? '—',
        s(rem.next_due_date),
        rem.next_due_hours ?? '—',
        statusLabel,
      ];
      dataRow.height = 20;
      dataRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };

      // Color status cell (col 9)
      const sc = STATUS_COLORS[status] ?? { fill: 'F5F5F5', font: '757575' };
      colorCell(dataRow.getCell(9), sc.fill, sc.font, status === 'overdue');

      // Bold red for required priority (col 3)
      if (isRequired) {
        dataRow.getCell(3).font = { bold: true, color: { argb: 'FFC62828' } };
      }

      row++;
    }

    row = spacer(ws, row);
  }

  // =========================================================================
  // G) Maintenance Timers (legacy — secondary reference)
  // =========================================================================
  const timers = aircraft.maintenance_timers;

  if (timers && Object.keys(timers).length > 0) {
    sectionHeader(ws.getCell(`A${row}`), 'Maintenance Intervals (Legacy Reference)', '78909C', 10);
    ws.mergeCells(`A${row}:K${row}`);
    row++;

    const timerHeaders = ['Task', 'Interval Type', 'Interval Value', 'Unit', '', '', '', '', '', '', ''];
    styleHeaderRow(ws.getRow(row), timerHeaders, '78909C');
    row++;

    for (const [task, timer] of Object.entries(timers)) {
      const dataRow = ws.getRow(row);
      dataRow.values = [
        task.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        s(timer.interval_type),
        timer.interval_value ?? '—',
        s(timer.unit),
      ];
      dataRow.getCell(1).font = { color: { argb: 'FF546E7A' } };
      dataRow.height = 16;
      row++;
    }

    row = spacer(ws, row);
  }

  // =========================================================================
  // H) Chain Integrity (bottom of sheet)
  // =========================================================================
  const chainResult = options.chainStatus?.[aircraft.aircraft_id];
  if (chainResult) {
    ws.getCell(`A${row}`).value = 'Chain Integrity:';
    ws.getCell(`A${row}`).font = { bold: true };

    const intactText = chainResult.intact
      ? 'INTACT — all record hashes link correctly'
      : `BROKEN — breaks at records: ${chainResult.breaks?.join(', ') ?? 'unknown'}`;
    const intactCell = ws.getCell(`B${row}`);
    ws.mergeCells(`B${row}:K${row}`);
    intactCell.value = intactText;
    intactCell.font  = {
      bold: true,
      color: { argb: chainResult.intact ? 'FF2E7D32' : 'FFC62828' },
    };
    row++;
  }

  // ---- Column widths ----
  ws.columns = [
    { width: 6  }, // # / Type / Component
    { width: 16 }, // Date / Position / Source
    { width: 22 }, // Type / Make-Model / Priority
    { width: 10 }, // ATA / Part Num
    { width: 38 }, // Description (wide — primary content col)
    { width: 55 }, // Work Performed (widest)
    { width: 20 }, // Mechanic / Performed By
    { width: 16 }, // Cert# / Serial / Last Done Hrs
    { width: 10 }, // RTS / Status / Next Due Date
    { width: 12 }, // Cost / Next Due Hrs
    { width: 20 }, // Priority / AD Ref
  ];
}

// ---------------------------------------------------------------------------
// Sheet: Blockchain Anchors (purple tab)
// ---------------------------------------------------------------------------

function addAnchorsSheet(wb, batches) {
  const ws = wb.addWorksheet('Blockchain Anchors', {
    properties: { tabColor: { argb: 'FF6A1B9A' } },
  });

  ws.mergeCells('A1:G1');
  const title = ws.getCell('A1');
  title.value = 'Blockchain Anchor Batches';
  title.font  = { size: 14, bold: true, color: { argb: 'FF6A1B9A' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  const headers = ['#', 'Merkle Root', 'Records', 'Chain', 'TX Hash', 'Block', 'Status'];
  styleHeaderRow(ws.getRow(3), headers, '6A1B9A');

  batches.forEach((b, i) => {
    const row = ws.getRow(4 + i);
    row.values = [
      i + 1,
      b.merkle_root ?? '—',
      b.record_count ?? '—',
      b.chain ?? 'private',
      b.tx_hash ?? 'N/A',
      b.block_number ?? 'N/A',
      b.anchor_status ?? 'unknown',
    ];
    row.height = 18;

    const statusCell = row.getCell(7);
    if (b.anchor_status === 'anchored') {
      colorCell(statusCell, 'E8F5E9', '2E7D32', true);
    } else {
      colorCell(statusCell, 'FFF8E1', 'F57F17', true);
    }
  });

  ws.columns = [
    { width: 5  }, // #
    { width: 68 }, // Merkle Root
    { width: 10 }, // Records
    { width: 10 }, // Chain
    { width: 68 }, // TX Hash
    { width: 8  }, // Block
    { width: 12 }, // Status
  ];
}
