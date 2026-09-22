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
  // Browser decode, always all-cores wall clock: createImageBitmap gives no
  // thread control, so there is no single-thread counterpart here.
  { key: 'decode.bestMs', header: 'decode', align: 'right', format: (v) => formatMs(v) },
];

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
function activeColumns(timingModes, { decode = true } = {}) {
  return COLUMNS.filter((column) => {
    if (column.key === 'decode.bestMs') return decode;
    if (!column.key.startsWith('timings.')) return true;
    const mode = column.key.split('.')[1];
    return timingModes.includes(mode);
  });
}

const hasDecode = (results) => results.some((r) => r.decode?.bestMs != null);

export function sortResults(results) {
  return [...results].sort(
    (a, b) =>
      a.codec.localeCompare(b.codec) ||
      a.depth - b.depth ||
      a.effort - b.effort ||
      a.quality - b.quality,
  );
}

export function formatTable(results, timingModes = ['single', 'multi']) {
  if (results.length === 0) return '(no results)';
  const columns = activeColumns(timingModes, { decode: hasDecode(results) });
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
  const columns = activeColumns(timingModes, { decode: hasDecode(results) });
  const header = columns.map((c) => csvHeader(c.key)).join(',');
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
  if (key === 'decode.bestMs') return 'decode_best_ms';
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
  const header = ['config', 'codec', 'bytes', 'bpp', 'ssimulacra2', 'bit_exact'];
  for (const mode of timingModes) header.push(`${mode}_best_ms`);
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
      return cells.join(',');
    });
  return `${[header.join(','), ...lines].join('\n')}\n`;
}

export function formatLosslessTable(rows, timingModes = ['single', 'multi']) {
  const header = ['Config', 'Bytes'];
  for (const mode of timingModes) header.push(mode === 'multi' ? 'Multi' : 'Single');
  header.push('SSIMULACRA2', 'Bit-exact');

  const body = rows.map((row) => {
    if (row.skipped) return [row.label ?? row.codec, 'skipped', ...timingModes.map(() => '--'), '--', '--'];
    const cells = [row.label, row.bytes.toLocaleString('en-US')];
    for (const mode of timingModes) {
      cells.push(row.timings?.[mode] ? formatMs(row.timings[mode].bestMs) : '--');
    }
    cells.push(row.score == null ? '--' : row.score.toFixed(2));
    cells.push(row.bitExact == null ? '--' : row.bitExact ? 'yes' : 'NO');
    return cells;
  });

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
