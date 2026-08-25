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

export function renderTag(text, { height = 28, blur = 0, noise = 0, pad = 16 } = {}) {
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
  if (noise > 0) {
    const ctx = out.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, d[i] + (Math.random() - 0.5) * noise));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}
