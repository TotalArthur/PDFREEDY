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

/*
 * A tag inside a line number, with the tag field degraded harder than what
 * surrounds it.
 *
 * This is the shape of the failure that started this work: a sheet reading
 * 18-6-MC-58134-1C3B1 where the middle field came back as "B81 34" at 0%
 * confidence while everything either side read cleanly at 90%+. The rest of the
 * corpus renders tags in isolation, so it cannot see that case at all — every
 * character is degraded equally and there is never any confident context for a
 * doubtful read to be judged against.
 */
export function renderTagInContext(tag, {
  name = '', prefix = '18-6-MC-', suffix = '-1C3B1',
  height = 14, blur = 0.3, noise = 8, pad = 16,
  fieldBlur = 1.1, fieldNoise = 40, uneven = 0,
} = {}) {
  const rand = mulberry32(seedFrom(tag + '|ctx|' + name + '|' + height + '|' + fieldBlur));
  const font = `${height}px sans-serif`;
  const probe = createCanvas(8, 8).getContext('2d');
  probe.font = font;
  const full = prefix + tag + suffix;
  const w = Math.ceil(probe.measureText(full).width) + pad * 2;
  const h = Math.ceil(height * 2) + pad;
  const x0 = pad + probe.measureText(prefix).width;
  const x1 = x0 + probe.measureText(tag).width;

  const sharp = createCanvas(w, h);
  const sc = sharp.getContext('2d');
  sc.fillStyle = '#fff'; sc.fillRect(0, 0, w, h);
  sc.fillStyle = '#000';
  sc.font = font;
  sc.fillText(full, pad, height + pad / 2);

  // Everything gets the light degradation the sheet as a whole suffered.
  const base = createCanvas(w, h);
  const bc = base.getContext('2d');
  bc.fillStyle = '#fff'; bc.fillRect(0, 0, w, h);
  if (blur > 0) bc.filter = `blur(${blur}px)`;
  bc.drawImage(sharp, 0, 0);
  bc.filter = 'none';

  // The tag field alone gets the smudge, drawn back over the top.
  const fx0 = Math.max(0, Math.floor(x0 - 3)), fx1 = Math.min(w, Math.ceil(x1 + 3));
  const fw = fx1 - fx0;
  if (fw > 0 && fieldBlur > 0) {
    const field = createCanvas(fw, h);
    const fc = field.getContext('2d');
    fc.fillStyle = '#fff'; fc.fillRect(0, 0, fw, h);
    fc.filter = `blur(${fieldBlur}px)`;
    fc.drawImage(sharp, -fx0, 0);
    bc.drawImage(field, fx0, 0);
  }

  // Grain: light across the sheet, heavy over the field.
  const ctx = base.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const amount = (x >= fx0 && x < fx1) ? fieldNoise : noise;
      if (!amount) continue;
      const i = (y * w + x) * 4;
      const v = Math.max(0, Math.min(255, d[i] + (rand() - 0.5) * amount));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return base;
}
