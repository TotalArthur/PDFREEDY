#!/usr/bin/env node
/*
 * Bundles src/ into the single deployable page at the repo root.
 *
 * The tool's whole premise is that you double-click one file and it runs, so
 * the build has exactly one job: take the ES modules and inline them back into
 * src/index.template.html as one <script> block. No runtime dependency is
 * added — pdf.js and tesseract.js are still the same two CDN <script> tags.
 *
 *   npm run build          # writes index.html
 *   npm run build -- --check   # fails if index.html is stale (CI guard)
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(root, 'index.html');
const PLACEHOLDER = '<!--BUNDLE-->';

const result = await build({
  entryPoints: [path.join(root, 'src/app/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  // pdfjsLib and Tesseract are globals from the two CDN script tags.
  write: false,
  legalComments: 'none',
});

const js = result.outputFiles[0].text;
const template = await readFile(path.join(root, 'src/index.template.html'), 'utf8');
if (!template.includes(PLACEHOLDER)) throw new Error('template is missing ' + PLACEHOLDER);

const banner =
  '/* GENERATED FILE — do not edit.\n' +
  '   Source lives in src/; rebuild with `npm run build`. */\n';
const page = template.replace(PLACEHOLDER, banner + js);

if (process.argv.includes('--check')) {
  const current = await readFile(OUT, 'utf8').catch(() => '');
  if (current !== page) {
    console.error('index.html is stale — run `npm run build` and commit the result.');
    process.exit(1);
  }
  console.log('index.html is up to date.');
} else {
  await writeFile(OUT, page);
  console.log(`built index.html (${(page.length / 1024).toFixed(0)} kB)`);
}
