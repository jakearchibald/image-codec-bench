// The page src/animation.js writes for looking at its kept files.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

const formatBytes = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${(bytes / 1e3).toFixed(1)} KB`);

const video = (src) => `<video src="${escapeHtml(src)}" autoplay loop muted playsinline></video>`;

/**
 * One file at a time in the same place, so flipping between them (or to the
 * original) shows the difference. Each AVIF is followed by its AV1 stream as
 * an MP4 in <video>, to tell an encoding artefact from the browser's
 * animated-image rendering. Shown `width` CSS px wide, as the video will be
 * on the page, or by default at one video pixel per device pixel. The
 * original is the input video, or a ProRes copy of it when browsers can't play
 * the input; ProRes only plays in Safari. The animations aren't in sync with
 * each other.
 *
 * `runs` is one or more `{ output, dir }` (a results.json and its directory),
 * so runs can be compared on one page written to `pageDir`.
 */
export function viewerHtml({ runs, pageDir, input, width = null }) {
  // The input itself, or the run's playable copy of it (see `original` in results.json).
  const original = runs[0].output.original ? path.join(runs[0].dir, runs[0].output.original) : input;
  const items = [{ label: runs[0].output.original ? 'Original (ProRes 4444 XQ copy)' : 'Original', html: video(path.relative(pageDir, original)) }];
  const href = (dir, file) => path.relative(pageDir, path.join(dir, file));
  // Targets are JODs; a hand-made results.json can use any label instead.
  const targets = [...new Set(runs.flatMap(({ output }) => output.settings.targets))].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  );
  for (const target of targets) {
    for (const { output, dir } of runs) {
      for (const s of output.results) {
        const r = s.targets.find((t) => t.target === target);
        if (!r?.file) continue;
        const score = r.jod == null ? '' : ` (${r.jod.toFixed(2)} JOD)`;
        const label = `${typeof target === 'number' ? `${target} JOD` : target} · ${s.label}${score} · ${formatBytes(r.bytes)}`;
        items.push({ label, html: `<img src="${escapeHtml(href(dir, r.file))}" alt="">` });
        if (r.mp4) items.push({ label: `${label} · MP4`, html: video(href(dir, r.mp4.file)) });
      }
    }
  }
  const { output } = runs[0];
  const buttons = items
    .map(
      (item, i) =>
        `<button data-i="${i}"${i === 0 ? ' aria-pressed="true"' : ''}>${i < 9 ? `${i + 1}: ` : ''}${escapeHtml(item.label)}</button>`,
    )
    .join('\n');
  const stack = items.map((item, i) => `<div class="layer"${i === 0 ? '' : ' hidden'}>${item.html}</div>`).join('\n');
  const ppd = output.cvvdp?.ppd ?? 75.4;
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(path.basename(input))} animation comparison</title>
<style>
  body { font: 14px system-ui; margin: 1em; background: #222; color: #ddd; }
  nav { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 1em; }
  button { font: inherit; background: #333; color: inherit; border: 1px solid #555; padding: 4px 8px; }
  button[aria-pressed="true"] { background: #4a6; color: #000; }
  input { font: inherit; width: 6em; }
  .stack { display: grid; }
  .layer { grid-area: 1 / 1; }
  .layer[hidden] { display: block; visibility: hidden; }
  .stack img, .stack video { display: block; }
</style>
<nav>
${buttons}
</nav>
<p><label>Width <input type="number" id="width" step="any" min="1" value="${width ?? ''}"> CSS px</label>
  (empty: one video pixel per device pixel) · Number keys or ←/→ to flip. The animations aren't in sync.
  Scores assume ${ppd} video pixels per degree.</p>
<div class="stack">
${stack}
</div>
<script>
  const buttons = [...document.querySelectorAll('button')];
  const layers = [...document.querySelectorAll('.layer')];
  let current = 0;
  function show(i) {
    current = (i + layers.length) % layers.length;
    layers.forEach((layer, j) => { layer.hidden = j !== current; });
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === current)));
  }
  buttons.forEach((b, i) => b.addEventListener('click', () => show(i)));
  addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowRight') show(current + 1);
    else if (event.key === 'ArrowLeft') show(current - 1);
    else if (/^[1-9]$/.test(event.key) && Number(event.key) <= layers.length) show(Number(event.key) - 1);
  });
  const width = document.querySelector('#width');
  function size() {
    const css = Number(width.value) > 0 ? Number(width.value) : ${output.video.width} / devicePixelRatio;
    for (const el of document.querySelectorAll('.stack img, .stack video')) el.style.width = css + 'px';
  }
  width.addEventListener('input', size);
  size();
</script>
`;
}

/**
 * Run directly to put several runs on one page:
 *   node src/animation-viewer.js out/a/clip-animation out/b/clip-animation --width 742.5 --out compare.html
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { width: { type: 'string' }, out: { type: 'string', default: 'compare.html' } },
  });
  if (positionals.length === 0) {
    process.stderr.write('Usage: node src/animation-viewer.js <run dir>... [--width CSS_PX] [--out FILE]\n');
    process.exit(1);
  }
  const runs = await Promise.all(
    positionals.map(async (dir) => ({
      dir: path.resolve(dir),
      output: JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8')),
    })),
  );
  const pageFile = path.resolve(values.out);
  const html = viewerHtml({
    runs,
    pageDir: path.dirname(pageFile),
    input: path.resolve(runs[0].output.settings.input),
    width: values.width == null ? null : Number(values.width),
  });
  await writeFile(pageFile, html);
  process.stdout.write(`${pageFile}\n`);
}
