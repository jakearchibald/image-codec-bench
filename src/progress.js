// Cost-weighted progress bar and ETA (plan.md §5). Weighted by *estimated
// time*, not job count, so it advances at a roughly constant rate even though
// `-s 0` costs ~80x `-s 6`.

const BAR_WIDTH = 19;
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatBar(fraction, width = BAR_WIDTH) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const exact = clamped * width;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const partial = BLOCKS[Math.floor(remainder * 8)];
  const filled = '█'.repeat(full) + partial;
  return filled.padEnd(width, ' ');
}

export function formatClockTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export class Progress {
  /**
   * @param totalWeight estimated total cost in ms
   * @param totalJobs   job count, shown alongside the weighted bar
   */
  constructor({ totalWeight, totalJobs, stream = process.stderr, enabled = true }) {
    this.totalWeight = Math.max(1, totalWeight);
    this.totalJobs = totalJobs;
    this.doneWeight = 0;
    this.doneJobs = 0;
    this.stream = stream;
    this.enabled = enabled && stream.isTTY === true;
    this.started = Date.now();
    this.currentLabel = '';
    this.lines = 0;
  }

  /** Re-seed the total when estimates are refined mid-run. */
  setTotalWeight(weight) {
    this.totalWeight = Math.max(1, weight);
  }

  setCurrent(label) {
    this.currentLabel = label;
    this.render();
  }

  /** Mark a job finished, crediting its *estimated* weight. */
  complete({ weight, jobs = 1 }) {
    this.doneWeight += weight;
    this.doneJobs += jobs;
    this.render();
  }

  get fraction() {
    return Math.min(1, this.doneWeight / this.totalWeight);
  }

  /**
   * ETA from elapsed time scaled by remaining *weight*, which is why the
   * estimate holds up across a grid with an 80x cost spread.
   */
  get etaMs() {
    if (this.doneWeight <= 0) return Number.POSITIVE_INFINITY;
    const elapsed = Date.now() - this.started;
    const rate = this.doneWeight / elapsed;
    return (this.totalWeight - this.doneWeight) / rate;
  }

  render() {
    if (!this.enabled) return;
    const pct = Math.round(this.fraction * 100);
    const elapsed = Date.now() - this.started;
    const eta = this.etaMs;
    const done = Number.isFinite(eta)
      ? ` (done ~${formatClockTime(new Date(Date.now() + eta))})`
      : '';
    const head =
      `[${formatBar(this.fraction)}] ${String(pct).padStart(3)}%  ` +
      `${this.doneJobs}/${this.totalJobs} jobs  ` +
      `elapsed ${formatDuration(elapsed)}  eta ${formatDuration(eta)}${done}`;
    const body = this.currentLabel ? `\n  now: ${this.currentLabel}` : '';
    this.clear();
    this.stream.write(`${head}${body}`);
    this.lines = body ? 2 : 1;
  }

  clear() {
    if (!this.enabled || this.lines === 0) return;
    // Move to column 0, clear each line we wrote, moving up as we go.
    this.stream.write('\r\x1b[2K');
    for (let i = 1; i < this.lines; i += 1) {
      this.stream.write('\x1b[1A\r\x1b[2K');
    }
    this.lines = 0;
  }

  /** Print a line above the bar without disturbing it. */
  log(text) {
    if (!this.enabled) {
      if (text) this.stream.write(`${text}\n`);
      return;
    }
    this.clear();
    this.stream.write(`${text}\n`);
    this.render();
  }

  finish(summary) {
    this.clear();
    if (summary) this.stream.write(`${summary}\n`);
  }
}
