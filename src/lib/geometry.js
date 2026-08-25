// Coordinate maths shared by the text layer (transform matrices) and OCR
// (exact 90-degree canvas rotations).

function applyMatrix(m, x, y) {
  return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
}

// A text item's .width/.height from pdf.js getTextContent() are already in
// page-space units (they are NOT glyph-space units to be re-multiplied by
// the transform's a/d). So the quad is built by walking `width` along the
// transform's rotated x-axis and `height` along its rotated y-axis, from
// the baseline origin (transform[4], transform[5]) — then that PDF-space
// quad is mapped to canvas pixels via the viewport transform.
function itemQuadPdfSpace(item) {
  const t = item.transform;
  const fontScale = Math.hypot(t[0], t[1]) || 1;
  const dirX = t[0]/fontScale, dirY = t[1]/fontScale;
  const upX = t[2]/fontScale, upY = t[3]/fontScale;
  const x0 = t[4], y0 = t[5];
  const w = item.width, h = item.height;
  return [
    [x0, y0],
    [x0 + w*dirX, y0 + w*dirY],
    [x0 + w*dirX + h*upX, y0 + w*dirY + h*upY],
    [x0 + h*upX, y0 + h*upY]
  ];
}
function itemQuadCanvas(item, viewport) {
  return itemQuadPdfSpace(item).map(([x,y]) => applyMatrix(viewport.transform, x, y));
}

function boundsOfPoints(pts) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [x,y] of pts) {
    if (x<minX) minX=x; if (x>maxX) maxX=x;
    if (y<minY) minY=y; if (y>maxY) maxY=y;
  }
  return {minX,minY,maxX,maxY};
}

function inverseRotatePoint(x, y, degrees, W, H) {
  if (degrees === 0) return [x, y];
  if (degrees === 180) return [W - x, H - y];
  if (degrees === 90) return [y, H - x];     // Cθ size is H x W
  if (degrees === 270) return [W - y, x];    // Cθ size is H x W
  return [x, y];
}

// Project a page-space box onto the axis the text runs along for this pass, so
// ordering and gap tests are one piece of rotation-independent arithmetic:
//   rs/re = start/end along the reading direction (always increasing)
//   rh    = character height, measured perpendicular to that direction
function readingAxis(b, degrees) {
  if (degrees === 90)  return { rs: -b.y1, re: -b.y0, rh: b.x1 - b.x0 };
  if (degrees === 180) return { rs: -b.x1, re: -b.x0, rh: b.y1 - b.y0 };
  if (degrees === 270) return { rs:  b.y0, re:  b.y1, rh: b.x1 - b.x0 };
  return { rs: b.x0, re: b.x1, rh: b.y1 - b.y0 };
}

function mapBoxBack(bbox, degrees, W, H) {
  const corners = [
    [bbox.x0, bbox.y0], [bbox.x1, bbox.y0], [bbox.x1, bbox.y1], [bbox.x0, bbox.y1]
  ].map(([x,y]) => inverseRotatePoint(x, y, degrees, W, H));
  const b = boundsOfPoints(corners);
  return { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
}

export { applyMatrix, itemQuadPdfSpace, itemQuadCanvas, boundsOfPoints,
         inverseRotatePoint, readingAxis, mapBoxBack };
