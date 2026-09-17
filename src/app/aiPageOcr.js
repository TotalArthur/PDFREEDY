// "Read this page with AI" — the one deliberate exception to "never send
// anything but short text" in this app. Only runs when someone explicitly
// clicks it, only for the one page currently open, never automatically and
// never for a whole document at once. Renders that page to an image and
// sends it to a Supabase Edge Function (supabase/functions/ocr-page),
// which asks Gemini's vision model for every tag/label on it plus a
// bounding box.
//
// Detections aren't a separate find-once list — they're appended to that
// page's OCR word data (data.ocrLines, tagged rotation:'ai') exactly like
// a local Tesseract pass, so they become real, searchable, highlightable
// results through the app's normal search path from then on.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { getPageProxy } from './pdf.js';
import { logUsageEvent } from './usage.js';
import { runFullSearch } from './search.js';
import { isApproved } from './aiMatch.js';

const $ = id => document.getElementById(id);
const aiPageOcrBtn = $('aiPageOcrBtn');
const aiPageOcrStatus = $('aiPageOcrStatus');

// Vision models don't need Tesseract's high DPI to read text — a page
// rendered far past this just costs more upload/token time for no real
// accuracy gain, so this is deliberately much lower than OCR_SCALE.
const AI_OCR_TARGET_LONG_SIDE = 1600;

function updateAiPageOcrVisibility() {
  aiPageOcrBtn.hidden = !isApproved();
}

async function pageImage(pageNum, data) {
  // Reuse whatever's already rendered (from local OCR, or a results-list
  // thumbnail) so this doesn't re-render the page or shift the coordinate
  // space anything already on screen is using.
  if (data.thumbCanvas && data.thumbScale) {
    return { canvas: data.thumbCanvas, scale: data.thumbScale };
  }
  const page = await getPageProxy(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(AI_OCR_TARGET_LONG_SIDE / Math.max(vp1.width, vp1.height), 3);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  data.thumbCanvas = canvas;
  data.thumbScale = scale;
  return { canvas, scale };
}

async function aiReadPage() {
  if (!S.pdfDoc) return;
  const pageNum = S.currentPage;
  const data = S.pageData.get(pageNum);
  if (!data) return;

  aiPageOcrBtn.disabled = true;
  aiPageOcrStatus.hidden = false;
  aiPageOcrStatus.textContent = 'Reading page ' + pageNum + ' with AI…';
  logUsageEvent('ai_page_ocr_requested', { page: pageNum });

  try {
    const { canvas } = await pageImage(pageNum, data);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

    const { data: resp, error } = await sb.functions.invoke('ocr-page', {
      body: { imageBase64: base64, mimeType: 'image/jpeg' },
    });
    if (error) throw error;
    const detections = (resp && resp.detections) || [];

    // Same shape as one entry of an OCR pass's ocrLines (see ocr.js) so
    // every existing consumer — searchOcr, drawHighlights, buildThumbnail —
    // handles these with no special-casing. rotation:'ai' rides the same
    // "Also scan rotated/vertical text" toggle local rotation passes do:
    // simplest way to give it an on/off switch without a second checkbox,
    // at the cost of coupling two things that aren't really the same kind
    // of "extra pass" — worth splitting out if that ever turns out to
    // matter in practice.
    const words = detections
      .filter(d => d && typeof d.text === 'string' && Array.isArray(d.box_2d) && d.box_2d.length === 4)
      .map(d => {
        const text = d.text.trim();
        const [ymin, xmin, ymax, xmax] = d.box_2d;
        const bbox = {
          x0: xmin / 1000 * canvas.width, y0: ymin / 1000 * canvas.height,
          x1: xmax / 1000 * canvas.width, y1: ymax / 1000 * canvas.height,
        };
        return { text, bbox, confidence: 100, rotation: 'ai', rs: 0, re: text.length, rh: Math.max(1, bbox.y1 - bbox.y0) };
      })
      .filter(w => w.text);

    data.ocrLines = (data.ocrLines || []).filter(l => l.rotation !== 'ai');
    if (words.length) data.ocrLines.push({ rotation: 'ai', words });

    aiPageOcrStatus.textContent = words.length
      ? 'AI found ' + words.length + ' label' + (words.length === 1 ? '' : 's') + ' on this page.'
      : 'AI found nothing new on this page.';
    if (S.currentQuery.norm) runFullSearch();
  } catch (err) {
    console.warn('AI page OCR failed:', err);
    aiPageOcrStatus.textContent = 'AI page read failed (' + (err.message || err) + ').';
  } finally {
    aiPageOcrBtn.disabled = false;
  }
}

function initAiPageOcr() {
  if (!CLOUD_ENABLED) return;
  aiPageOcrBtn.addEventListener('click', aiReadPage);
}

export { initAiPageOcr, updateAiPageOcrVisibility };
