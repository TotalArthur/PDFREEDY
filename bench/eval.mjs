#!/usr/bin/env node
/*
 * Accuracy harness.
 *
 * The project had no accuracy measurement of any kind, which made every claim
 * about the OCR pipeline — including the ones in the code comments — impossible
 * to check. This runs the real pipeline (the same preprocessing, the same word
 * joining, the same matcher the app uses) over a synthetic degraded corpus and
 * prints recall.
 *
 * "Recall" here is the question the user actually asks: they know the tag, they
 * type it, does the tool surface it? So a garbled read still counts as found if
 * the matcher bridges the garble — which is the whole point of the confusion
 * tier, and why measuring OCR string accuracy alone would be measuring the
 * wrong thing. Both numbers are reported.
 *
 *   node bench/eval.mjs                  # all pipelines
 *   node bench/eval.mjs --pipeline=fixed
 *   node bench/eval.mjs --quick          # first 4 tags only
 */
import { createCanvas } from '@napi-rs/canvas';
import { createWorker, PSM, OEM } from 'tesseract.js';
import { normalize } from '../src/lib/text.js';
import { findWindowMatches } from '../src/lib/windows.js';
import { conditionForOcr, setCanvasFactory } from '../src/lib/preprocess.js';
import { JOIN_GAP_FACTOR, MAX_WINDOW, TESSERACT_INIT, tesseractParams } from '../src/app/config.js';
import { TAGS, CONDITIONS } from './corpus.mjs';
import { renderTag } from './render.mjs';

setCanvasFactory(() => createCanvas(1, 1));

const FIXED_PARAMS = tesseractParams(PSM);
const WHITELIST = FIXED_PARAMS.tessedit_char_whitelist;

// The pipelines under test. Each is one hypothesis about what is costing recall
// on degraded input, so they can be measured against each other rather than
// argued about.
//
// `baseline` is what the tool shipped before this work: dictionary parameters
// passed through setParameters, where Tesseract silently rejects them ("can
// only be set during initialization"), so the English dictionary was in fact ON
// the whole time — the opposite of what the code comment claimed.
const BASE_PARAMS = {
  tessedit_pageseg_mode: PSM.SPARSE_TEXT,
  tessedit_char_whitelist: WHITELIST,
};

const PIPELINES = {
  baseline: {
    label: 'shipped behaviour: dictionaries silently left ON, adaptive binarize',
    init: {},
    params: { ...BASE_PARAMS, load_system_dawg: '0', load_freq_dawg: '0' },
    mode: 'binarize',
    allowIndels: false,
  },
  nodict: {
    label: 'dictionaries actually off (init config), adaptive binarize',
    init: TESSERACT_INIT,
    params: BASE_PARAMS,
    mode: 'binarize',
  },
  nodict_grey: {
    label: 'dictionaries off, no conditioning at all (greyscale to Tesseract)',
    init: TESSERACT_INIT,
    params: BASE_PARAMS,
    mode: 'off',
  },
  nodict_flat: {
    label: 'dictionaries off, illumination flattened but not thresholded',
    init: TESSERACT_INIT,
    params: BASE_PARAMS,
    mode: 'flatten',
  },
  auto_nodeep: {
    label: 'current conditioning, but matching restricted to substitutions',
    init: TESSERACT_INIT,
    params: BASE_PARAMS,
    mode: 'auto',
    allowIndels: false,
  },
  current: {
    label: 'CURRENT: dictionaries off, conditioning only where lighting is uneven, indels allowed',
    init: TESSERACT_INIT,
    params: BASE_PARAMS,
    mode: 'auto',
    allowIndels: true,
  },
};

const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--pipeline=')) || '').split('=')[1];
const tags = args.includes('--quick') ? TAGS.slice(0, 4) : TAGS;

// Turn Tesseract's words into the shape the app's matcher consumes. This pass
// is unrotated, so the reading axis is page-x and character height is box
// height — exactly what readingAxis() returns for 0 degrees.
function wordsToItems(data) {
  const words = [];
  for (const b of (data.blocks || []))
    for (const p of (b.paragraphs || []))
      for (const l of (p.lines || []))
        for (const w of (l.words || [])) {
          const t = (w.text || '').trim();
          if (t) words.push(w);
        }
  words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return words.map((w, i) => ({
    key: i, text: w.text.trim(),
    rs: w.bbox.x0, re: w.bbox.x1, rh: w.bbox.y1 - w.bbox.y0,
  }));
}

async function runPipeline(name) {
  const pipe = PIPELINES[name];
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {}, pipe.init);
  await worker.setParameters(pipe.params);

  const rows = [];
  for (const cond of CONDITIONS) {
    let found = 0, exact = 0;
    const misses = [];
    for (const tag of tags) {
      const canvas = renderTag(tag, cond);
      const forOcr = conditionForOcr(canvas, pipe.mode);
      const { data } = await worker.recognize(forOcr.toBuffer('image/png'), {}, { blocks: true, text: true });

      const items = wordsToItems(data);
      const read = items.map(i => i.text).join(' ');
      if (normalize(read) === normalize(tag)) exact++;

      // allowIndels mirrors the app's two-pass search: the cheap substitution
      // scan first, the full alignment only for a search that found nothing.
      const query = { raw: tag, norm: normalize(tag), exact: false, fuzzy: false,
                      allowIndels: pipe.allowIndels !== false };
      const hits = findWindowMatches(items, query, {
        maxWindow: MAX_WINDOW, gapFactor: JOIN_GAP_FACTOR, join: ' ',
      });
      if (hits.length) found++; else misses.push({ tag, read });
    }
    rows.push({ cond: cond.name, found, exact, n: tags.length, misses });
  }
  await worker.terminate();
  return rows;
}

const names = only ? [only] : Object.keys(PIPELINES);
const all = {};
for (const name of names) {
  console.log(`\n=== ${name}: ${PIPELINES[name].label} ===`);
  const rows = await runPipeline(name);
  all[name] = rows;
  console.log('  condition       exact read    tag found');
  for (const r of rows) {
    const pctE = (100 * r.exact / r.n).toFixed(0).padStart(3);
    const pctF = (100 * r.found / r.n).toFixed(0).padStart(3);
    console.log(`  ${r.cond.padEnd(14)}  ${pctE}% (${r.exact}/${r.n})    ${pctF}% (${r.found}/${r.n})`);
  }
  const tot = rows.reduce((a, r) => ({ f: a.f + r.found, e: a.e + r.exact, n: a.n + r.n }), { f: 0, e: 0, n: 0 });
  console.log(`  ${'OVERALL'.padEnd(14)}  ${(100*tot.e/tot.n).toFixed(0).padStart(3)}%           ${(100*tot.f/tot.n).toFixed(0).padStart(3)}%  <-- headline`);
}

if (names.length > 1) {
  console.log('\n=== tags found, by condition (higher is better) ===');
  console.log('  condition       ' + names.map(n => n.padEnd(12)).join(''));
  for (let i = 0; i < all[names[0]].length; i++) {
    const cells = names.map(n => `${all[n][i].found}/${all[n][i].n}`.padEnd(12));
    console.log(`  ${all[names[0]][i].cond.padEnd(14)}  ${cells.join('')}`);
  }
  const tot = n => all[n].reduce((a, r) => a + r.found, 0);
  const totN = all[names[0]].reduce((a, r) => a + r.n, 0);
  console.log(`  ${'OVERALL'.padEnd(14)}  ` +
    names.map(n => `${(100 * tot(n) / totN).toFixed(0)}%`.padEnd(12)).join(''));
}

// Show what is still being missed — the list is the work queue for the next
// stage, and it stops a good headline number from hiding a systematic failure.
const last = all[names[names.length - 1]];
const stillMissed = last.flatMap(r => r.misses.map(m => ({ cond: r.cond, ...m })));
if (stillMissed.length) {
  console.log(`\n=== still missed (${names[names.length - 1]}) ===`);
  for (const m of stillMissed.slice(0, 25)) {
    console.log(`  ${m.cond.padEnd(12)} want ${m.tag.padEnd(24)} read ${JSON.stringify(m.read)}`);
  }
  if (stillMissed.length > 25) console.log(`  ... and ${stillMissed.length - 25} more`);
}
