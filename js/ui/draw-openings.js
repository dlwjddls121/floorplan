// Drawing of windows and doors (plan §1-2 "창", "여닫이문"; reference drawings dev/ref/*.png).
//
//   drawOpenings(ctx, project, derived, opts)        wall cut + window/door symbol (call right after
//                                                    the walls, before any text)
//   drawOpeningGhost(ctx, project, derived, ghost, opts)   tool preview of an opening being placed
//   openingCutouts(project, derived)                 per-edge gaps for a wall renderer
//
// opts = {
//   toPx(worldPoint) → canvas point, pxPerMM (canvas px per world mm),
//   paper: { pxPerPaperMM } | null (null = screen),
//   options: { drawingOnly, highlight (opening id or array of ids), ... },
//   background: colour used to cut the wall (default '#FFFFFF'),
//   wallsCut: true when the wall renderer already left the gaps (then nothing is erased),
// }
// Geometry is computed in world mm and mapped with toPx, so the same code serves the screen and the
// 300 dpi paper export. Line widths and font sizes are given in paper mm / pt and converted with
// paper.pxPerPaperMM when printing; on screen they are fixed pixel sizes.

import { canvasFont } from './theme.js';
import { finishBeside } from '../core/dims.js';
import { placeOpening, slidingLeaves } from '../core/openings.js';

export const OPENING_STYLE = {
  frame: '#8C8C8C',        // thin grey frame lines (window band, door frame, arc)
  leaf: '#4A4A4A',         // door leaf
  fill: '#FFFFFF',
  label: '#0070C0',        // plan §1-2: 창호 라벨 파랑
  select: '#D97706',       // selected opening (same as the selected wall)
  ghost: '#1A73E8',        // opening being placed
  check: '#E8710A',        // 확인필요 mark (screen only)
  // Paper sizes (mm) and the screen equivalents (px).
  frameMM: 0.12, frameScreenPx: 1,
  leafMM: 0.2, leafScreenPx: 1.5,
  // Proportions of the wall thickness.
  bandRatio: 0.5,          // window band / door frame height
  slidingBandRatio: 0.8,   // band holding sliding leaves
  markRatio: 0.62,         // mullion square size
  mullionMM: 700,          // distance between mullion marks (world mm)
  nominalWallMM: 100,      // thickness used for openings on a divider (no wall)
};

// ---- public API ----------------------------------------------------------------------------------

export function drawOpenings(ctx, project, derived, opts) {
  const list = (project && project.openings) || [];
  if (!list.length) return;
  const hl = highlightSet(opts);
  ctx.save();
  for (const o of list) {
    const pl = safePlace(project, derived, o);
    if (!pl) continue;
    drawOne(ctx, o, pl, { ...opts, finish: finishBeside(project, derived, o.edge) }, null);
    if (!opts.paper) {
      if (hl.has(o.id)) drawSelection(ctx, pl, opts);
      if (o.check) drawCheckMark(ctx, pl, opts);
    }
  }
  ctx.restore();
}

// Preview while placing or dragging: ghost = an opening-like object { kind, edge, t, anchor, width,
// drawWidth, doorType, swing }.
export function drawOpeningGhost(ctx, project, derived, ghost, opts) {
  if (!ghost) return;
  const pl = safePlace(project, derived, ghost);
  if (!pl) return;
  ctx.save();
  drawOne(ctx, ghost, pl, opts, OPENING_STYLE.ghost);
  drawSelection(ctx, pl, opts, OPENING_STYLE.ghost);
  ctx.restore();
}

// → Map edgeId → [{ from, to, openingId }] (mm from node a along the edge, sorted), for a wall
// renderer that leaves gaps instead of letting drawOpenings paint over the wall.
export function openingCutouts(project, derived) {
  const map = new Map();
  for (const o of (project && project.openings) || []) {
    const pl = safePlace(project, derived, o);
    if (!pl) continue;
    if (!map.has(o.edge)) map.set(o.edge, []);
    map.get(o.edge).push({ from: pl.s0, to: pl.s1, openingId: o.id });
  }
  for (const list of map.values()) list.sort((a, b) => a.from - b.from);
  return map;
}

// ---- one opening ---------------------------------------------------------------------------------

function drawOne(ctx, o, pl, opts, tint) {
  const fr = pl.frame;
  const thick = fr.thick > 0 ? fr.thick : OPENING_STYLE.nominalWallMM;
  const P = pointFn(fr);
  const frameW = lineWidth(opts, OPENING_STYLE.frameMM, OPENING_STYLE.frameScreenPx);
  const leafW = lineWidth(opts, OPENING_STYLE.leafMM, OPENING_STYLE.leafScreenPx);
  const frameColor = tint || OPENING_STYLE.frame;
  const leafColor = tint || OPENING_STYLE.leaf;

  // 1. Cut the wall (a white gap over the full thickness).
  // A finish layer drawn on a room's wall face (core/dims.js finishPolygons) is cut too.
  if (!opts.wallsCut && fr.thick > 0) {
    const eps = 0.75 / Math.max(opts.pxPerMM, 1e-9);
    const fin = opts.finish || { left: 0, right: 0 };
    const up = thick / 2 + fin.left + eps, down = -thick / 2 - fin.right - eps;
    ctx.fillStyle = opts.background || OPENING_STYLE.fill;
    polygon(ctx, opts, [P(pl.s0, up), P(pl.s1, up), P(pl.s1, down), P(pl.s0, down)]);
    ctx.fill();
  }

  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  const leaves = slidingLeaves(o);
  if (o.kind === 'window') {
    drawWindow(ctx, pl, thick, P, opts, frameColor, frameW);
  } else if (leaves) {
    drawSliding(ctx, o, pl, thick, P, opts, frameColor, leafColor, frameW, leafW, leaves);
  } else {
    drawSwing(ctx, o, pl, thick, P, opts, frameColor, leafColor, frameW, leafW);
  }
}

// White band + thin centre line + small square marks at regular intervals (plan §1-2).
function drawWindow(ctx, pl, thick, P, opts, color, lw) {
  const hb = thick * OPENING_STYLE.bandRatio / 2;
  bandRect(ctx, pl, hb, P, opts, color, lw);
  ctx.beginPath();
  moveLine(ctx, opts, P(pl.s0, 0), P(pl.s1, 0));
  ctx.stroke();
  const q = Math.min(thick * OPENING_STYLE.markRatio, pl.w / 3);
  const n = Math.max(2, Math.round(pl.w / OPENING_STYLE.mullionMM));
  for (let k = 0; k <= n; k++) {
    let s = pl.s0 + (pl.w * k) / n;
    s = Math.min(pl.s1 - q / 2, Math.max(pl.s0 + q / 2, s));
    square(ctx, s, q, P, opts, color, lw);
  }
}

// The swing of a hinged door exactly as drawSwing draws it (world mm), for its label (core/labels.js,
// through labelHooks.openingAnchor in ui/wiring.js): the unit normal of the side it opens into, the
// hinge's distance along the wall from the opening's centre (pl.c: −w/2 at the 'start' end, +w/2 at
// the 'end' end), the arc's radius (the drawn width) and the hinge's offset from the wall's centre
// line toward that side (half the frame band). → { normal, hinge, radius, offset } | null (windows,
// sliding doors)
export function doorSwing(o, pl) {
  if (!o || o.kind !== 'door' || slidingLeaves(o) || !pl || !pl.frame) return null;
  const fr = pl.frame;
  const thick = fr.thick > 0 ? fr.thick : OPENING_STYLE.nominalWallMM;
  const swing = o.swing || { side: 'left', hinge: 'start' };
  const sgn = swing.side === 'right' ? -1 : 1;
  const sh = swing.hinge === 'end' ? pl.s1 : pl.s0;
  const so = swing.hinge === 'end' ? pl.s0 : pl.s1;
  return {
    normal: { x: fr.left.x * sgn, y: fr.left.y * sgn },
    hinge: sh - pl.c,
    radius: Math.abs(so - sh),
    offset: thick * OPENING_STYLE.bandRatio / 2,
  };
}

// Swing door: frame band with end squares, leaf line at the hinge and a quarter arc (plan §1-2).
// (doorSwing above gives the same hinge, radius and side to the labels.)
function drawSwing(ctx, o, pl, thick, P, opts, frameColor, leafColor, frameW, leafW) {
  const hb = thick * OPENING_STYLE.bandRatio / 2;
  bandRect(ctx, pl, hb, P, opts, frameColor, frameW);
  const q = Math.min(thick * OPENING_STYLE.markRatio, pl.w / 4);
  square(ctx, pl.s0 + q / 2, q, P, opts, frameColor, frameW);
  square(ctx, pl.s1 - q / 2, q, P, opts, frameColor, frameW);
  const swing = o.swing || { side: 'left', hinge: 'start' };
  const sgn = swing.side === 'right' ? -1 : 1;
  const sh = swing.hinge === 'end' ? pl.s1 : pl.s0;
  const so = swing.hinge === 'end' ? pl.s0 : pl.s1;
  const r = Math.abs(so - sh);
  const hingeW = P(sh, sgn * hb);
  // Quarter arc from the leaf tip back to the other jamb, centred on the hinge.
  const pts = [];
  const steps = 28;
  const fr = pl.frame;
  const towards = so > sh ? 1 : -1;
  for (let i = 0; i <= steps; i++) {
    const a = (Math.PI / 2) * (i / steps);
    // a = 0: along the wall towards the other jamb; a = 90°: straight out into the room.
    const ax = Math.cos(a) * r * towards, ay = Math.sin(a) * r * sgn;
    pts.push(opts.toPx({
      x: hingeW.x + fr.dir.x * ax + fr.left.x * ay,
      y: hingeW.y + fr.dir.y * ax + fr.left.y * ay,
    }));
  }
  ctx.strokeStyle = frameColor;
  ctx.lineWidth = frameW;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  // Leaf: from the hinge straight into the room (open at 90°).
  ctx.strokeStyle = leafColor;
  ctx.lineWidth = leafW;
  ctx.beginPath();
  moveLine(ctx, opts, P(sh, sgn * hb), P(sh, sgn * (hb + r)));
  ctx.stroke();
}

// Sliding door (미서기문: 2 leaves, 3연동 도어: 3): overlapping leaf rectangles on parallel tracks,
// no arc. The leaf at the hinge end ('start' = node a side) runs on the track on the swing side;
// cycleSwing swaps which leaf is in front.
function drawSliding(ctx, o, pl, thick, P, opts, frameColor, leafColor, frameW, leafW, k) {
  const hb = thick * OPENING_STYLE.slidingBandRatio / 2;
  // Frame: the two jamb squares and thin lines along both faces.
  const q = Math.min(thick * OPENING_STYLE.markRatio * 0.8, pl.w / 6);
  ctx.strokeStyle = frameColor;
  ctx.lineWidth = frameW;
  ctx.beginPath();
  moveLine(ctx, opts, P(pl.s0, hb), P(pl.s1, hb));
  moveLine(ctx, opts, P(pl.s0, -hb), P(pl.s1, -hb));
  ctx.stroke();
  square(ctx, pl.s0 + q / 2, q, P, opts, frameColor, frameW);
  square(ctx, pl.s1 - q / 2, q, P, opts, frameColor, frameW);
  const swing = o.swing || { side: 'left', hinge: 'start' };
  const sgn = swing.side === 'right' ? -1 : 1;
  const inner0 = pl.s0 + q, inner1 = pl.s1 - q;
  const span = Math.max(inner1 - inner0, pl.w * 0.5);
  const overlap = span * 0.08;
  const leafLen = span / k + overlap * (k - 1) / k;
  const trackW = (2 * hb) / k;
  const leafT = trackW * 0.7;
  // Track index 0 is on the swing side; the hinge-end leaf takes it.
  const leaves = Array.from({ length: k }, (_, i) => {
    const start = inner0 + (span - leafLen) * (k > 1 ? i / (k - 1) : 0);
    const track = swing.hinge === 'end' ? k - 1 - i : i;
    const centre = sgn * (hb - trackW * (track + 0.5));
    return { start, end: start + leafLen, centre, track };
  });
  // Back leaves first, so the front one (track 0) is drawn on top.
  leaves.sort((a, b) => b.track - a.track);
  for (const L of leaves) {
    ctx.fillStyle = OPENING_STYLE.fill;
    polygon(ctx, opts, [P(L.start, L.centre + leafT / 2), P(L.end, L.centre + leafT / 2), P(L.end, L.centre - leafT / 2), P(L.start, L.centre - leafT / 2)]);
    ctx.fill();
    ctx.strokeStyle = leafColor;
    ctx.lineWidth = frameW;
    ctx.stroke();
  }
}

// ---- marks (screen only) ---------------------------------------------------------------------------

function drawSelection(ctx, pl, opts, color = OPENING_STYLE.select) {
  const fr = pl.frame;
  const thick = fr.thick > 0 ? fr.thick : OPENING_STYLE.nominalWallMM;
  const P = pointFn(fr);
  const pad = 4 / Math.max(opts.pxPerMM, 1e-9);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  polygon(ctx, opts, [P(pl.s0 - pad, thick / 2 + pad), P(pl.s1 + pad, thick / 2 + pad), P(pl.s1 + pad, -thick / 2 - pad), P(pl.s0 - pad, -thick / 2 - pad)]);
  ctx.stroke();
}

function drawCheckMark(ctx, pl, opts) {
  const fr = pl.frame;
  const thick = fr.thick > 0 ? fr.thick : OPENING_STYLE.nominalWallMM;
  const c = opts.toPx({ x: pl.center.x - fr.left.x * thick, y: pl.center.y - fr.left.y * thick });
  ctx.fillStyle = OPENING_STYLE.check;
  ctx.beginPath();
  ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = canvasFont(11, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', c.x, c.y + 0.5);
}

// ---- helpers ---------------------------------------------------------------------------------------

function safePlace(project, derived, o) {
  try {
    return placeOpening(project, derived, o);
  } catch (err) {
    console.error('placeOpening failed', err);
    return null;
  }
}

function highlightSet(opts) {
  const h = opts && opts.options && opts.options.highlight;
  const ids = Array.isArray(h) ? h : (h ? [h] : []);
  if (opts && opts.selectedId) ids.push(opts.selectedId);
  return new Set(ids);
}

function lineWidth(opts, paperMM, screenPx) {
  return opts.paper ? paperMM * opts.paper.pxPerPaperMM : screenPx;
}

// P(s, off) → world point at distance s along the edge from A and `off` towards its left normal.
function pointFn(fr) {
  return (s, off) => ({ x: fr.A.x + fr.dir.x * s + fr.left.x * off, y: fr.A.y + fr.dir.y * s + fr.left.y * off });
}

function polygon(ctx, opts, worldPts) {
  ctx.beginPath();
  const p0 = opts.toPx(worldPts[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < worldPts.length; i++) {
    const p = opts.toPx(worldPts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

function moveLine(ctx, opts, a, b) {
  const pa = opts.toPx(a), pb = opts.toPx(b);
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
}

function bandRect(ctx, pl, hb, P, opts, color, lw) {
  ctx.fillStyle = OPENING_STYLE.fill;
  polygon(ctx, opts, [P(pl.s0, hb), P(pl.s1, hb), P(pl.s1, -hb), P(pl.s0, -hb)]);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

function square(ctx, s, q, P, opts, color, lw) {
  ctx.fillStyle = OPENING_STYLE.fill;
  polygon(ctx, opts, [P(s - q / 2, q / 2), P(s + q / 2, q / 2), P(s + q / 2, -q / 2), P(s - q / 2, -q / 2)]);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}
