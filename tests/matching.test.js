#!/usr/bin/env node
/*
 * Tests for the two pieces that decide whether a tag is found: the
 * confusion-tolerant matcher and the rotated-text reading axis. Both are pure
 * functions living in src/lib/, imported directly — no build step needed to
 * run these, even though the shipped page is built.
 *
 *   node tests/matching.test.js
 */
import { normalize, levenshtein } from '../src/lib/text.js';
import { charsConfusable, confusableIndexOf } from '../src/lib/confusion.js';
import { matchWindow } from '../src/lib/matching.js';
import { mapBoxBack, readingAxis, boundsOfPoints } from '../src/lib/geometry.js';

const M = { normalize, charsConfusable, confusableIndexOf, matchWindow,
            levenshtein, mapBoxBack, readingAxis, boundsOfPoints };

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL  ' + name);
}
function section(title) { console.log('\n' + title); }
const Q = (s, o = {}) => ({ norm: M.normalize(s), exactOnly: !!o.exact, fuzzy: !!o.fuzzy });

// ---------------------------------------------------------------------------
section('Confusion matching: garbled OCR reads vs the tag the user types');
// [ what OCR reported, what the user searches for, should it match ]
const cases = [
  ['V-68O1-l5PW4/3-75O-PPGO-RE1', 'V-6801-15PW4/3-750-PP60-RE1', true ],
  ['18-8-GP-11O26-4C381-HT',      '18-8-GP-11026-4C3B1-HT',      true ],
  ['V-68176-l5PW11-6OO-RO1',      'V-68176-15PW11-600-R01',      true ],
  ['PT-11OO4',                    'PT-11004',                    true ],
  ['P7-11004',                    'PT-11004',                    true ],
  ['FIC-2O1S',                    'FIC-2015',                    true ],
  // Precision: a genuinely different tag must never match.
  ['PT-11005',                    'PT-11004',                    false],
  ['PT-21004',                    'PT-11004',                    false],
  ['18-8-GP-11026-4C3B2-HT',      '18-8-GP-11026-4C3B1-HT',      false],
  ['LT-11004',                    'PT-11004',                    false],
];
for (const [read, tag, want] of cases) {
  const m = M.matchWindow(M.normalize(read), Q(tag));
  check(`${read} ~ ${tag}`, !!m === want);
  console.log(`  ${(!!m === want) ? 'ok  ' : 'BAD '} ${read.padEnd(30)} vs ${tag.padEnd(28)} -> ${m ? 'match (confused=' + m.confused + ')' : 'no match'}`);
}

// ---------------------------------------------------------------------------
section('Dropped characters: what blur actually does to a tag');
// Every one of these is a real read from bench/eval.mjs. The old matcher
// compared position by position at a fixed length and could only substitute, so
// all of them were invisible to it — the read is SHORTER than the query, which
// defeats plain substring search too.
const dropped = [
  ['FC2015',           'FIC-2015',           true,  'lost the I'],
  ['X-3308',           'XV-3308',            true,  'lost the V'],
  ['TSH 6802',         'TSHH-6802',          true,  'lost an H'],
  ['-P-1052-A1A-HC',   '6"-P-1052-A1A-HC',   true,  'lost the leading 6"'],
  ['V-B80115PWA',      'V-6801-15PW4',       true,  '6->B and 4->A'],
  ['LT-41004',         'LT-11004',           true,  '1->4'],
  // Precision: a deletion must not become a back door for a substitution the
  // confusion table forbids. The two edge cases below are the ones that matter
  // — a trailing or leading delete plus the free prefix/suffix of a substring
  // search would otherwise let any tag match its neighbour.
  //
  // A mid-string deletion is a different matter: PT-1104 really could be a
  // different tag, and it will now match a search for PT-11004. That is the
  // cost of finding tags whose characters blur away, and it is why every hit
  // that needed damage to match is badged rather than presented as fact.
  ['PT-11005',         'PT-11004',           false, 'trailing char differs, not missing'],
  ['XT-11004',         'PT-11004',           false, 'leading char differs, not missing'],
  ['PT-1104',          'PT-11004',           true,  'lost a 0 mid-string'],
];
for (const [read, tag, want, why] of dropped) {
  const m = M.matchWindow(M.normalize(read), Q(tag));
  check(`${read} ~ ${tag} (${why})`, !!m === want);
  console.log(`  ${(!!m === want) ? 'ok  ' : 'BAD '} ${read.padEnd(18)} vs ${tag.padEnd(20)} -> ${m ? `match (cost ${m.cost.toFixed(2)}, ${m.subs} subs, ${m.indels} indel)` : 'no match'}`);
}

section('Confusion matching: precision guards');
check('two-char query is never confusion-matched', !M.matchWindow(M.normalize('GP'), Q('6P')));
check('substitution budget rejects all-different string',
      !M.matchWindow(M.normalize('OOOOOOOOOOOO'), Q('123456789012')));
check('non-confusable substitution is rejected', !M.charsConfusable('P', 'R'));
check('confusable pair is accepted', M.charsConfusable('0', 'O') && M.charsConfusable('8', 'B'));

section('Confusion matching: modes');
check('substring hit inside a joined window',
      !!M.matchWindow(M.normalize('NOTE V-68O1-l5PW11 TYP'), Q('V-6801-15PW11')));
check('exact mode still tolerates glyph confusion at equal length',
      !!M.matchWindow(M.normalize('PT-11OO4'), Q('PT-11004', { exact: true })));
check('exact mode rejects a substring hit',
      !M.matchWindow(M.normalize('XPT-11004Y'), Q('PT-11004', { exact: true })));
check('exact match reports confused=false',
      M.matchWindow(M.normalize('PT-11004'), Q('PT-11004')).confused === false);

section('Confusion matching: highlight offsets');
{
  const norm = M.normalize('NOTE V-68O1 TYP');
  const m = M.matchWindow(norm, Q('V-6801'));
  check('match position indexes the tag, not the note',
        norm.slice(m.pos, m.pos + m.len) === 'V68O1');
}

// ---------------------------------------------------------------------------
section('Rotated text: reading order, gaps and joins survive all four passes');
{
  const W = 1000, H = 700;
  // One tag split into three OCR words, laid out left-to-right in the rotated
  // canvas with the baseline jitter real OCR always produces.
  const words = [
    { n: 'V-6801', x0: 100, x1: 180, y0: 50, y1: 70 },
    { n: '15PW11', x0: 190, x1: 280, y0: 51, y1: 71 },  // gap 10  -> joins
    { n: '600',    x0: 600, x1: 660, y0: 49, y1: 69 },  // gap 320 -> splits
  ];
  const EXPECTED = 'V-6801,15PW11,600';
  const JOIN_GAP_FACTOR = 2.2;

  for (const deg of [0, 90, 180, 270]) {
    const mapped = words.map(w => {
      const b = M.mapBoxBack(w, deg, W, H);
      return { n: w.n, b, ...M.readingAxis(b, deg) };
    });

    check(`deg=${deg} boxes stay inside the page`,
      mapped.every(m => m.b.x0 >= -1 && m.b.y0 >= -1 && m.b.x1 <= W + 1 && m.b.y1 <= H + 1));

    const order = [...mapped].sort((a, b) => a.rs - b.rs);
    check(`deg=${deg} reading order preserved`, order.map(v => v.n).join(',') === EXPECTED);

    const gap1 = order[1].rs - order[0].re;
    const gap2 = order[2].rs - order[1].re;
    check(`deg=${deg} inter-word gap measured correctly`,
          Math.abs(gap1 - 10) < 1e-6 && Math.abs(gap2 - 320) < 1e-6);
    check(`deg=${deg} character height measured perpendicular to reading`,
          Math.abs(order[0].rh - 20) < 1e-6);
    check(`deg=${deg} joins the tag, splits before the unrelated word`,
          gap1 <= order[0].rh * JOIN_GAP_FACTOR && gap2 > order[1].rh * JOIN_GAP_FACTOR);

    // Regression guard: sorting by page-x (what the code did before) scrambles
    // every rotated pass. Keep proving that, so nobody "simplifies" it back.
    const byPageX = [...mapped].sort((a, b) => a.b.x0 - b.b.x0).map(v => v.n).join(',');
    if (deg !== 0) {
      check(`deg=${deg} page-x sort is demonstrably wrong (regression guard)`,
            byPageX !== EXPECTED);
    }
    console.log(`  deg=${String(deg).padStart(3)}  reading-axis: ${order.map(v => v.n).join(',').padEnd(20)}  page-x sort would give: ${byPageX}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
