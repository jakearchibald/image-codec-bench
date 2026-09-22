// Console table and CSV output (plan.md §6).

import { codecs } from './codecs/index.js';

/**
 * Depth is only meaningful for codecs that actually code at a chosen depth.
 * Showing "8b" for JXL would imply a setting that does not exist -- see
 * `hasDepthAxis` in src/codecs/jxl.js.
 */
function hasDepthAxis(row) {
  return Boolean(codecs[row?.codec]?.hasDepthAxis);
}

function depthCell(depth, row) {
  return hasDepthAxis(row) ? `${depth}b` : '--';
}

/** CSV keeps the bare number so the column stays machine-readable. */
function depthCsv(depth, row) {
  return hasDepthAxis(row) ? depth : null;
}

const COLUMNS = [
  { key: 'codec', header: 'codec', align: 'left' },
  { key: 'quality', header: 'q', align: 'right' },
  { key: 'effortLabel', header: 'effort', align: 'left' },
  { key: 'depth', header: 'depth', align: 'right', format: depthCell, csv: depthCsv },
  { key: 'yuv', header: 'yuv', align: 'left', format: (v) => v ?? '--' },
  { key: 'bytes', header: 'bytes', align: 'right', format: (v) => v.toLocaleString('en-US') },
  { key: 'bpp', header: 'bpp', align: 'right', format: (v) => v.toFixed(3) },
  { key: 'score', header: 'ssimu2', align: 'right', format: (v) => (v == null ? '--' : v.toFixed(3)) },
  {
    key: 'timings.single.bestMs',
    header: 'single best',
    align: 'right',
    format: (v) => formatMs(v),
  },
  {
    key: 'timings.single.meanMs',
    header: 'single mean',
    align: 'right',
    format: (v) => formatMs(v),
  },
  {
    key: 'timings.multi.bestMs',
    header: 'multi best',
    align: 'right',
    format: (v) => formatMs(v),
  },
  {
    key: 'timings.multi.meanMs',
    header: 'multi mean',
    align: 'right',
    format: (v) => formatMs(v),
  },
];

/**
 * One decode column per browser that measured something. Decode is keyed by
 * browser because the decoders are different software with different costs --
 * the whole reason for measuring more than one.
 */
function decodeColumns(results) {
  const names = new Set();
  for (const row of results) {
    for (const name of Object.keys(row.decode ?? {})) {
      if (row.decode[name]?.meanMs != null) names.add(name);
    }
  }
  return [...names].sort().map((name) => ({
    key: `decode.${name}.meanMs`,
    header: `dec ${name}`,
    align: 'right',
    format: (v) => formatMs(v),
    csvHeader: `decode_${name}_mean_ms`,
  }));
}

function formatMs(ms) {
  if (ms == null) return '--';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  // Browser decodes land in the single-digit milliseconds, where rounding to a
  // whole ms throws away most of the difference between codecs.
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(0)}ms`;
}

function get(object, dottedKey) {
  return dottedKey.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
}

/**
 * Only show timing columns for modes that were actually measured, and only show
 * the decode column when something measured it.
 */
function activeColumns(timingModes, results = []) {
  const base = COLUMNS.filter((column) => {
    if (!column.key.startsWith('timings.')) return true;
    const mode = column.key.split('.')[1];
    return timingModes.includes(mode);
  });
  return [...base, ...decodeColumns(results)];
}

/** Browsers with at least one measurement across `rows`. */
export function decodeBrowsersIn(rows) {
  const names = new Set();
  for (const row of rows) {
    for (const [name, measured] of Object.entries(row.decode ?? {})) {
      if (measured?.meanMs != null) names.add(name);
    }
  }
  return [...names].sort();
}

/** Canonical subsampling order, matching how --avif-yuv normalises it. */
const YUV_ORDER = ['444', '422', '420', '400'];

export function sortResults(results) {
  return [...results].sort(
    (a, b) =>
      a.codec.localeCompare(b.codec) ||
      a.depth - b.depth ||
      a.effort - b.effort ||
      // Without this, rows at the same effort and quality but different
      // subsampling came out in whatever order they happened to be measured.
      YUV_ORDER.indexOf(a.yuv ?? '') - YUV_ORDER.indexOf(b.yuv ?? '') ||
      a.quality - b.quality,
  );
}

export function formatTable(results, timingModes = ['single', 'multi']) {
  if (results.length === 0) return '(no results)';
  const columns = activeColumns(timingModes, results);
  const rows = sortResults(results).map((result) =>
    columns.map((column) => {
      const value = get(result, column.key);
      if (value == null && !column.format) return '--';
      return column.format ? column.format(value, result) : String(value);
    }),
  );

  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => row[index].length)),
  );

  const pad = (text, index) =>
    columns[index].align === 'right' ? text.padStart(widths[index]) : text.padEnd(widths[index]);

  const lines = [
    columns.map((c, i) => pad(c.header, i)).join('  '),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((row) => row.map(pad).join('  ')),
  ];
  return lines.join('\n');
}

export function toCsv(results, timingModes = ['single', 'multi']) {
  const columns = activeColumns(timingModes, results);
  const header = columns.map((c) => c.csvHeader ?? csvHeader(c.key)).join(',');
  const lines = sortResults(results).map((result) =>
    columns
      .map((column) => {
        const value = get(result, column.key);
        // Columns with a `csv` formatter need it in the data too, not just the
        // console view: a depth of 8 against a JXL row is the same false claim
        // in a spreadsheet as it is on screen.
        return column.csv ? csvCell(column.csv(value, result)) : csvCell(value);
      })
      .join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}

function csvHeader(key) {
  return key
    .replace(/^timings\./, '')
    .replace(/\.bestMs$/, '_best_ms')
    .replace(/\.meanMs$/, '_mean_ms');
}

function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Lossless table as CSV, kept separate since its columns differ. */
export function losslessToCsv(rows, timingModes = ['single', 'multi']) {
  const browsers = decodeBrowsersIn(rows);
  const header = ['config', 'codec', 'bytes', 'bpp', 'ssimulacra2', 'bit_exact'];
  for (const mode of timingModes) header.push(`${mode}_best_ms`);
  for (const name of browsers) {
    header.push(`decode_${name}_mean_ms`, `decode_${name}_sd_ms`, `decode_${name}_runs`);
  }
  const lines = rows
    .filter((row) => !row.skipped)
    .map((row) => {
      const cells = [
        csvCell(row.label),
        csvCell(row.codec),
        csvCell(row.bytes),
        row.bpp == null ? '' : row.bpp.toFixed(4),
        row.score == null ? '' : String(row.score),
        row.bitExact == null ? '' : String(row.bitExact),
      ];
      for (const mode of timingModes) {
        cells.push(row.timings?.[mode] ? String(row.timings[mode].bestMs) : '');
      }
      for (const name of browsers) {
        const measured = row.decode?.[name];
        cells.push(measured?.meanMs == null ? '' : String(measured.meanMs));
        cells.push(measured?.sdMs == null ? '' : String(measured.sdMs));
        cells.push(measured?.runs == null ? '' : String(measured.runs));
      }
      return cells.join(',');
    });
  return `${[header.join(','), ...lines].join('\n')}\n`;
}

export function formatLosslessTable(rows, timingModes = ['single', 'multi']) {
  const browsers = decodeBrowsersIn(rows);
  const header = ['Config', 'Bytes'];
  for (const mode of timingModes) header.push(mode === 'multi' ? 'Multi' : 'Single');
  for (const name of browsers) header.push(`dec ${name}`);
  header.push('SSIMULACRA2', 'Bit-exact');

  const body = rows.map((row) => {
    if (row.skipped) {
      return [
        row.label ?? row.codec,
        'skipped',
        ...timingModes.map(() => '--'),
        ...browsers.map(() => '--'),
        '--',
        '--',
      ];
    }
    const cells = [row.label, row.bytes.toLocaleString('en-US')];
    for (const mode of timingModes) {
      cells.push(row.timings?.[mode] ? formatMs(row.timings[mode].bestMs) : '--');
    }
    for (const name of browsers) cells.push(formatMs(row.decode?.[name]?.meanMs));
    cells.push(row.score == null ? '--' : row.score.toFixed(2));
    cells.push(row.bitExact == null ? '--' : row.bitExact ? 'yes' : 'NO');
    return cells;
  });

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
