#!/usr/bin/env node
/*
 * Tests for the two pieces that decide whether a tag is found: the
 * confusion-tolerant matcher and the rotated-text reading axis. Both are pure
 * functions living in src/lib/, imported directly — no build step needed to
 * run these, even though the shipped page is built.
 *
 *   node tests/matching.test.js
 */
import { normalize, uniformConfidence } from '../src/lib/text.js';
import { charsConfusable, confusableIndexOf } from '../src/lib/confusion.js';
import { matchWindow } from '../src/lib/matching.js';
import { findWindowMatches } from '../src/lib/windows.js';
import { scoreResult } from '../src/lib/evidence.js';
import { mapBoxBack, readingAxis, boundsOfPoints } from '../src/lib/geometry.js';

const M = { normalize, charsConfusable, confusableIndexOf, matchWindow,
            uniformConfidence, mapBoxBack, readingAxis, boundsOfPoints };

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL  ' + name);
}
function section(title) { console.log('\n' + title); }
const Q = (s, o = {}) => ({ norm: M.normalize(s), exact: !!o.exact, fuzzy: !!o.fuzzy });

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

// ---------------------------------------------------------------------------
section('Confidence: "I could not read this" is not evidence against a match');
// From a real sheet. The user searched 58134; the drawing says
// 18-6-MC-58134-1C3B1. Three results came back, all in the same tier, sorted by
// page number, and the only thing that distinguished the right one was the user
// having already typed the correction in by hand.
//
// What separates them is not what the characters look like — it is that OCR
// SAID it could not read the one that differs. A glyph reported at 0% is an
// unknown; a glyph reported at 87% is a confident disagreement. Those are not
// the same claim and must not cost the same.
const screenshot = [
  // [ what OCR read, its confidence, should 58134 match it, why ]
  ['B81 34',               0,  true,  'the real tag: 4 of 5 exact, the 5th unreadable'],
  ['18-6-MC-B81 34-1C3B1', 0,  true,  'the same read, with its context — context must not disqualify it'],
  ['58116',                87, false, 'a confident read that genuinely disagrees'],
  ['18-12-',               0,  false, 'unreadable, but nothing like the tag either'],
];
for (const [read, conf, want, why] of screenshot) {
  const m = M.matchWindow(M.normalize(read), Q('58134'), { conf: M.uniformConfidence(read, conf / 100) });
  check(`${read} @ ${conf}% ~ 58134 (${why})`, !!m === want);
  console.log(`  ${(!!m === want) ? 'ok  ' : 'BAD '} ${read.padEnd(22)} @ ${String(conf).padStart(3)}%  -> ${m ? `match (cost ${m.cost.toFixed(2)}, ${m.unknowns || 0} unreadable)` : 'no match'}`);
}
check('a confident read is not rescued by lowering the bar elsewhere',
  !M.matchWindow(M.normalize('58116'), Q('58134'), { conf: M.uniformConfidence('58116', 0.87) }));

// ---------------------------------------------------------------------------
section('The whole screenshot, end to end: right answer must come first');
// The sheet as OCR actually read it. Three candidate lines, one of them the
// real 18-6-MC-58134-1C3B1 with its middle field unreadable.
{
  const LINES = [
    // [ [word, confidence%], ... ]  laid out left to right, 20px tall
    [['18-6-MC-', 94], ['B81', 0], ['34', 0], ['-1C3B1', 91]],
    [['58116', 87]],
    [['18-12-', 0]],
  ];
  const layout = (line) => {
    let x = 0;
    return line.map(([text, conf], i) => {
      const w = text.length * 10;
      const item = { key: i, text, conf: conf / 100, rs: x, re: x + w, rh: 20 };
      x += w + 4;   // tight spacing: these words belong to one another
      return item;
    });
  };

  const query = { norm: M.normalize('58134'), exact: false, fuzzy: false, allowIndels: false };
  const hits = [];
  for (const line of LINES) {
    for (const h of findWindowMatches(layout(line), query, { maxWindow: 6, gapFactor: 2.2, join: ' ' })) {
      const res = { source: 'ocr', text: h.text, matchLen: h.match.len, subs: h.match.subs,
                    unknowns: h.match.unknowns, indels: h.match.indels, cost: h.match.cost,
                    contextChars: h.contextChars, contextConf: h.contextConf,
                    matchConf: h.matchConf, delimited: h.delimited };
      hits.push({ ...res, ...scoreResult(res) });
    }
  }
  hits.sort((a, b) => b.score - a.score);

  check('the real tag is found', hits.length >= 1 && hits[0].text.replace(/\s/g, '') === 'B8134');
  check('and it is the only thing found — the two wrong answers do not match at all',
        hits.length === 1);
  console.log(`  found ${hits.length} candidate(s):`);
  for (const h of hits) {
    console.log(`    "${h.text}"  score ${h.score.toFixed(2)}`);
    for (const r of h.reasons) console.log(`      - ${r}`);
  }
  check('and it can say why: it names the unreadable character',
        hits[0] && hits[0].reasons.some(r => /could not make it out/.test(r)));
  check('and it names the corroborating context',
        hits[0] && hits[0].reasons.some(r => /Surrounded by \d+ characters/.test(r)));
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
