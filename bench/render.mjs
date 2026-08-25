/*
 * Renders corpus tags the way a degraded scan presents them to OCR.
 *
 * The degradations model the three things that actually go wrong on the sheets
 * this tool struggles with:
 *   height — a CAD callout is only a few pixels tall by the time it reaches the
 *            engine, which is the variable the pipeline currently never measures
 *   blur   — defocus / generational copying, which merges and breaks strokes
 *   noise  — scanner sensor grain on top of both
 */
import { createCanvas } from '@napi-rs/canvas';

/*
 * Deterministic noise.
 *
 * The first version of this used Math.random(), and the same pipeline scored
 * 68% and 74% on consecutive runs — a six-point swing that is larger than most
 * of the changes being measured. Every number was reporting the seed. Noise is
 * now seeded from the tag and the condition, so a run is reproducible and two
 * pipelines see pixel-identical input.
 */
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderTag(text, { name = '', height = 28, blur = 0, noise = 0, pad = 16, uneven = 0 } = {}) {
  const rand = mulberry32(seedFrom(text + '|' + name + '|' + height + '|' + blur + '|' + noise + '|' + uneven));
  const font = `${height}px sans-serif`;
  const probe = createCanvas(8, 8).getContext('2d');
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const h = Math.ceil(height * 2) + pad;

  const sharp = createCanvas(w, h);
  const sc = sharp.getContext('2d');
  sc.fillStyle = '#fff'; sc.fillRect(0, 0, w, h);
  sc.fillStyle = '#000';
  sc.font = font;
  sc.fillText(text, pad, height + pad / 2);

  let out = sharp;
  if (blur > 0) {
    out = createCanvas(w, h);
    const bc = out.getContext('2d');
    bc.fillStyle = '#fff'; bc.fillRect(0, 0, w, h);
    bc.filter = `blur(${blur}px)`;
    bc.drawImage(sharp, 0, 0);
  }
  // An illumination gradient across the crop: the condition the adaptive
  // binarizer exists for, and the one the tool cannot see if every fixture is
  // evenly lit. Applied last so it dims strokes and paper together, exactly as
  // a lamp or a curled page does.
  if (uneven > 0) {
    const ctx = out.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const shade = 1 - uneven * (x / w);
        const v = Math.max(0, Math.min(255, d[i] * shade));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  if (noise > 0) {
    const ctx = out.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + (rand() - 0.5) * noise));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}
