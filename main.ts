// Token Launch Radar — a working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits
// the value model from the snapshot's own launched comps, scores every pre-token protocol, writes
// the ranked board to /output/board.json, and copies this repository's dashboard/ and screenshots/
// to /output. Last, it writes /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Build-time enrichment (optional): data/enrichment.json beside this file may carry plain-text
// descriptions and social handles fetched from DefiLlama while building; the program bakes them
// into board.json and data.js. It never fetches anything at run time.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, fitModel, heldOutReport, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

/** Plain-text enrichment baked in at build time, or an empty map when the file is absent. */
function readEnrichment(): Record<string, { description?: string; social?: string }> {
  const path = join(here, 'data', 'enrichment.json');
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const clean: Record<string, { description?: string; social?: string }> = {};
    for (const [slug, value] of Object.entries(raw)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const entry: { description?: string; social?: string } = {};
      if (typeof v.description === 'string' && v.description.length > 0) entry.description = v.description;
      if (typeof v.social === 'string' && v.social.length > 0) entry.social = v.social;
      if (entry.description !== undefined || entry.social !== undefined) clean[slug] = entry;
    }
    return clean;
  } catch {
    process.stderr.write('token radar: data/enrichment.json is not readable JSON, ignoring it\n');
    return {};
  }
}

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const model = fitModel(snapshot);
const heldOut = heldOutReport(snapshot, model);
const enrichment = readEnrichment();
const { board, radar } = buildRadar(snapshot, model, heldOut, enrichment);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
  const size = statSync(join(here, 'screenshots', name)).size;
  if (size > SCREENSHOT_CAPS.max_bytes) {
    process.stderr.write(`token radar: screenshots/${name} is ${size} bytes, over the ${SCREENSHOT_CAPS.max_bytes} cap\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const top = board[0]!;
const fmt = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const wfLines = heldOut.walk_forward
  .map(
    (s) =>
      `token radar: held-out ${s.name}: fitted median log error ${s.fitted_median_log_error.toFixed(3)} vs starter ${s.starter_median_log_error.toFixed(3)} (ratio ${s.median_error_ratio.toFixed(2)}x); rel MSE improvement ${s.rel_mse_improvement.toFixed(1)}x (n=${s.test_count})\n`,
  )
  .join('');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: model radar-2 fitted on ${model.comp_count} comps: size_gamma=${model.weights.size_gamma}, growth_weight=${model.weights.growth_weight}, maturity=${model.weights.maturity_floor}+${model.weights.maturity_range}\n` +
    `token radar: held-out LOO median log error ${heldOut.loo.fitted_median_log_error.toFixed(3)} vs starter ${heldOut.loo.starter_median_log_error.toFixed(3)} (ratio ${heldOut.loo.median_error_ratio.toFixed(2)}x); rel MSE improvement ${heldOut.loo.rel_mse_improvement.toFixed(1)}x\n` +
    wfLines +
    `token radar: top row ${top.slug} at ${fmt(top.implied_value_usd)}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
