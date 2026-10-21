// Draws the dimension chains (stage C; plan §1-2 "치수선", "치수 숫자", "치수 줄 배치").
//
//   drawDimensions(ctx, project, derived, opts)  → the laid-out items (see layoutDimensions)
//   layoutDimensions(ctx, project, derived, opts) → [{ dim, side, row, p1, p2, arrowsOutside, ext: [[p, q]],
//                                                     text: { x, y, rot, w, h, mode }, box }]  (canvas px)
//     A measured diagonal side (core/dims.js rule 7) is an item with aligned: true, side 'aligned', its
//     line parallel to the wall, text.rot along it (upright), textPoly / linePoly (px corners), parts
//     (small px boxes along the turned number, for other texts to keep clear of), drag: null (only
//     chain numbers are dragged across rows); box = textBox = the number's px bounding box.
//   dimHitBoxes(ctx, project, derived, opts)      → [{ dim, box: { x, y, w, h } }] for taps / drags
//   dimDragTarget(item, dx, dy)                   → { row, rowFloat, offset } where a dragged number goes
//
// A number moved by hand (project.labelOffsets['dim:<key>'], PAPER mm) is placed from the middle of its
// dimension line along the line (not from its automatic spot), so the screen (converted with the print
// scale, opts.worldPerPaperMM) and the print put it at the same place. Its row comes from
// project.dimOverrides (core/dims.js assignRows).
//
// opts: { toPx(world) → canvas point, pxPerMM, paper: { pxPerPaperMM } | null, dims (optional result of
//         buildDimensions), worldPerPaperMM (screen only: print scale used to convert label offsets,
//         default 60), options: { extensionLines = true, bothValues, showUnknown, highlight } }
//
// Paper sizes (plan §1-2): lines #4472C4 0.44 pt with filled triangle arrowheads, numbers #0070C0 15.8 pt
// on the outer side of the line (left chain reads bottom→top, right chain top→bottom). The first row
// sits 8 mm outside the outer wall faces, rows 9 mm apart. Extension lines (보조선) run from just
// outside the wall to just past the dimension line. On screen the same layout uses fixed pixel sizes.

import { buildDimensions, placeRowTexts, layoutAlignedDims, wallPolygons, boxOf, rotatedRectParts } from '../core/dims.js';
import { PAPER_STYLE, PT_MM, dimObstacles } from '../core/printlayout.js';
import { canvasFont, COLORS } from './theme.js';

export const DIM_COLORS = { line: '#4472C4', text: '#0070C0', highlight: COLORS.activeSide, note: '#C5221F' };

// Sizes in canvas px for this output.
export function dimStyle(opts) {
  if (opts && opts.paper) {
    const u = opts.paper.pxPerPaperMM, pt = u * PT_MM;
    // Hand-moved numbers: paper mm at the automatic print scale (opts.offsetScale), like the screen.
    const offK = opts.offsetScale > 0 && opts.paper.scale > 0 ? opts.offsetScale / opts.paper.scale : 1;
    return {
      line: 0.44 * pt, ext: 0.3 * pt, text: PAPER_STYLE.dimTextPt * pt,
      arrow: PAPER_STYLE.dimArrowMM * u, arrowHalf: PAPER_STYLE.dimArrowHalfMM * u,
      first: PAPER_STYLE.dimLineMM * u, row: PAPER_STYLE.dimRowMM * u, textGap: PAPER_STYLE.dimTextGapMM * u,
      extGap: PAPER_STYLE.dimExtGapMM * u, extOver: PAPER_STYLE.dimExtOverMM * u, clear: PAPER_STYLE.dimClearMM * u, offsetPx: u * offK,
    };
  }
  const wppm = (opts && opts.worldPerPaperMM) || 60;
  return {
    line: 1, ext: 0.75, text: 14, arrow: 8, arrowHalf: 3,
    first: 26, row: 26, textGap: 3, extGap: 5, extOver: 5, clear: 4,
    offsetPx: wppm * ((opts && opts.pxPerMM) || 0.06),
  };
}

const SIGN = { top: -1, bottom: 1, left: -1, right: 1 };
const ROT = { top: 0, bottom: 0, left: -Math.PI / 2, right: Math.PI / 2 };

function optionsOf(opts) {
  return { extensionLines: true, bothValues: false, showUnknown: false, highlight: null, ...((opts && opts.options) || {}) };
}

export function layoutDimensions(ctx, project, derived, opts = {}) {
  const o = optionsOf(opts);
  const res = opts.dims || buildDimensions(project, derived, { bothValues: o.bothValues, showUnknown: o.showUnknown });
  const b = res.bounds;
  if (!b || typeof opts.toPx !== 'function') return [];
  const S = dimStyle(opts);
  const tl = opts.toPx({ x: b.minX, y: b.minY }), br = opts.toPx({ x: b.maxX, y: b.maxY });
  const k = opts.pxPerMM > 0 ? opts.pxPerMM : Math.abs(opts.toPx({ x: 1000, y: 0 }).x - opts.toPx({ x: 0, y: 0 }).x) / 1000;
  const offsets = (project && project.labelOffsets) || {};
  ctx.save();
  ctx.font = canvasFont(S.text);
  const textWidth = (d) => ctx.measureText(d.text).width;
  const items = [];
  for (const chain of res.chains) {
    const side = chain.side, sign = SIGN[side];
    const horizontal = side === 'top' || side === 'bottom';
    const face = side === 'top' ? tl.y : side === 'bottom' ? br.y : side === 'left' ? tl.x : br.x;
    const along = (v) => (horizontal ? opts.toPx({ x: v, y: 0 }).x : opts.toPx({ x: 0, y: v }).y);
    const P = (t, s) => (horizontal ? { x: t, y: s } : { x: s, y: t });
    chain.rows.forEach((row, r) => {
      const s = face + sign * (S.first + r * S.row);
      // placeRowTexts works in world coordinates along the axis (k = px per mm); px = along(world).
      // Only the row next to the plan may put a number on the plan side of its line (the band up to
      // the wall is free there; further out it holds the inner row's numbers).
      const texts = placeRowTexts(row, { k, textWidth, arrow: S.arrow, gap: S.clear, allowFlip: r === 0 });
      for (const d of row) {
        // drawA / drawB: neighbours that overlap a little meet at one point (core/dims.js).
        const t1 = along(d.drawA != null ? d.drawA : d.a), t2 = along(d.drawB != null ? d.drawB : d.b);
        const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
        const arrowsOutside = hi - lo < 2 * S.arrow + 2;
        const ext = [];
        if (o.extensionLines) {
          d.extFrom.forEach((pt, i) => {
            const f = opts.toPx(pt);
            const fp = horizontal ? f.y : f.x;
            const start = fp + sign * S.extGap, end = s + sign * S.extOver;
            if ((end - start) * sign > 0) {
              const t = i === 0 ? t1 : t2;
              ext.push([P(t, start), P(t, end)]);
            }
          });
        }
        const tp = texts.get(d);
        const w = textWidth(d);
        let tc = tp ? along(tp.center) : (lo + hi) / 2;
        // A number moved by hand (labelOffsets 'dim:<key>', paper mm): from the middle of its line,
        // along the line (and across it, for an offset written that way); never on the plan side.
        // The middle, not the automatic spot, so the screen and the print put it at the same place.
        const off = offsets[`dim:${d.key}`];
        const midAlong = along(((d.drawA != null ? d.drawA : d.a) + (d.drawB != null ? d.drawB : d.b)) / 2);
        let flip = tp && tp.mode === 'flip';
        let perp = 0;
        if (off) {
          const ox = (Number(off.dx) || 0) * S.offsetPx, oy = (Number(off.dy) || 0) * S.offsetPx;
          tc = midAlong + (horizontal ? ox : oy);
          perp = horizontal ? oy : ox;
          flip = false;
        }
        const textOff = S.textGap + S.text * 0.5;
        const c = P(tc, s + (flip ? -sign : sign) * textOff + perp);
        const text = { x: c.x, y: c.y, rot: ROT[side], w, h: S.text, mode: off ? 'moved' : (tp ? tp.mode : 'inside') };
        const tb = horizontal
          ? { x: text.x - w / 2, y: text.y - S.text / 2, w, h: S.text }
          : { x: text.x - S.text / 2, y: text.y - w / 2, w: S.text, h: w };
        const lineBox = horizontal ? { x: lo, y: s - S.arrowHalf, w: hi - lo, h: 2 * S.arrowHalf } : { x: s - S.arrowHalf, y: lo, w: 2 * S.arrowHalf, h: hi - lo };
        const rowFixed = !!(d.override && Number.isInteger(d.override.row));
        items.push({
          dim: d, side, row: r, p1: P(lo, s), p2: P(hi, s), arrowsOutside, ext, text, box: unionBox(tb, lineBox), textBox: tb, horizontal,
          // For dragging the number (main.js): where the rows are and where the number sits.
          drag: { face, sign, first: S.first, rowStep: S.row, textOff, rows: chain.rows.length, midAlong, textAlong: tc, perp, offsetPx: S.offsetPx },
          moved: !!off || rowFixed,
        });
      }
    });
  }
  // Rule 7: the aligned dimensions of measured diagonal sides, placed clear of the chains above.
  if (res.aligned && res.aligned.length && project) {
    let walls = [], obstacles = [];
    try { walls = wallPolygons(project, derived); } catch (_) { walls = []; }
    try { obstacles = dimObstacles(project, derived); } catch (_) { obstacles = []; }
    for (const pl of layoutAlignedDims(res, { wpu: 1 / k, S, textWidth, walls, obstacles })) {
      const p1 = opts.toPx(pl.p1), p2 = opts.toPx(pl.p2);
      const c = opts.toPx({ x: pl.text.x, y: pl.text.y });
      const textPoly = pl.textPoly.map((p) => opts.toPx(p));
      const bb = boxOf(textPoly);
      const tb = { x: bb.minX, y: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY };
      const w = textWidth(pl.dim);
      items.push({
        dim: pl.dim, side: 'aligned', aligned: true, row: pl.row, mode: pl.mode, p1, p2,
        arrowsOutside: Math.hypot(p2.x - p1.x, p2.y - p1.y) < 2 * S.arrow + 2,
        ext: o.extensionLines ? pl.ext.map(([p, q]) => [opts.toPx(p), opts.toPx(q)]) : [],
        text: { x: c.x, y: c.y, rot: pl.text.angle, w, h: S.text, mode: pl.mode },
        textBox: tb, box: tb, textPoly, linePoly: pl.linePoly.map((p) => opts.toPx(p)),
        parts: rotatedRectParts(c, pl.text.angle, w, S.text).map((b) => ({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY })),
        horizontal: false, drag: null, moved: false,
      });
    }
  }
  ctx.restore();
  return items;
}

function unionBox(p, q) {
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
  return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y };
}

const segLen = (s) => Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y);
const isVertical = (p, q) => Math.abs(p.x - q.x) < Math.abs(p.y - q.y);
const segBox = (p, q) => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) });

// What an extension line p–q of item `self` stops at (with a small gap): the numbers of the other
// items; and, of the OTHER chains (e.g. the left chain's 430 running under the bottom chain's 3600),
// the dimension lines it crosses and the extension lines it crosses that are shorter than it (so of
// two crossing extension lines only the longer one is broken). Within one chain the lines of the rows
// meet at shared ends and are left whole.
function extensionObstacles(p, q, items, self) {
  const vertical = isVertical(p, q);
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const boxes = [];
  for (const other of items) {
    if (other === self) continue;
    if (other.aligned) {
      // A diagonal side's dimension: its turned number (as small boxes) and where its line crosses.
      boxes.push(...other.parts);
      const x = crossing(p, q, other.p1, other.p2);
      if (x) boxes.push({ x: x.x - 0.5, y: x.y - 0.5, w: 1, h: 1 });
      continue;
    }
    if (other.textBox) boxes.push(other.textBox);
    if (other.side === self.side) continue;
    if (isVertical(other.p1, other.p2) !== vertical) boxes.push(segBox(other.p1, other.p2));
    for (const s of other.ext) {
      if (isVertical(s[0], s[1]) !== vertical && segLen(s) < len) boxes.push(segBox(s[0], s[1]));
    }
  }
  return boxes;
}

// Where segments p–q and a–b cross, or null.
function crossing(p, q, a, b) {
  const d1x = q.x - p.x, d1y = q.y - p.y, d2x = b.x - a.x, d2y = b.y - a.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - p.x) * d2y - (a.y - p.y) * d2x) / den;
  const u = ((a.x - p.x) * d1y - (a.y - p.y) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.x + d1x * t, y: p.y + d1y * t };
}

// Pieces of the axis-aligned segment p–q that stay outside the given boxes (canvas px).
function breakAtBoxes(p, q, boxes, pad) {
  const vertical = isVertical(p, q);
  const lo = vertical ? Math.min(p.y, q.y) : Math.min(p.x, q.x);
  const hi = vertical ? Math.max(p.y, q.y) : Math.max(p.x, q.x);
  const c = vertical ? p.x : p.y;
  const cuts = [];
  for (const b of boxes) {
    const [c0, c1, s0, s1] = vertical ? [b.x, b.x + b.w, b.y, b.y + b.h] : [b.y, b.y + b.h, b.x, b.x + b.w];
    if (c < c0 - pad || c > c1 + pad) continue;
    if (s1 + pad < lo || s0 - pad > hi) continue;
    cuts.push([s0 - pad, s1 + pad]);
  }
  if (!cuts.length) return [[p, q]];
  cuts.sort((u, v) => u[0] - v[0]);
  const out = [];
  let cur = lo;
  const pt = (s) => (vertical ? { x: c, y: s } : { x: s, y: c });
  for (const [a, b] of cuts) {
    if (a > cur) out.push([pt(cur), pt(Math.min(a, hi))]);
    cur = Math.max(cur, b);
    if (cur >= hi) break;
  }
  if (cur < hi) out.push([pt(cur), pt(hi)]);
  return out;
}

function isHighlighted(dim, hl) {
  if (hl == null) return false;
  const list = Array.isArray(hl) ? hl : [hl];
  return list.some((id) => id === dim.key || (dim.measureIds || []).includes(id));
}

// Filled triangle with its tip at `tip`, pointing along unit vector u.
function arrowHead(ctx, tip, u, len, half) {
  const bx = tip.x - u.x * len, by = tip.y - u.y * len;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(bx - u.y * half, by + u.x * half);
  ctx.lineTo(bx + u.y * half, by - u.x * half);
  ctx.closePath();
  ctx.fill();
}

export function drawDimensions(ctx, project, derived, opts = {}) {
  const o = optionsOf(opts);
  const S = dimStyle(opts);
  const items = layoutDimensions(ctx, project, derived, opts);
  ctx.save();
  ctx.lineCap = 'butt';
  for (const it of items) {
    const hl = isHighlighted(it.dim, o.highlight);
    const lineColor = hl ? DIM_COLORS.highlight : DIM_COLORS.line;
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = lineColor;
    // Extension lines (broken where they would run through another row's number, or cross another
    // dimension line or a shorter extension line).
    if (it.ext.length) {
      ctx.lineWidth = S.ext;
      ctx.beginPath();
      for (const [p, q] of it.ext) {
        // A diagonal side's extension lines are short and placed clear of the chains: drawn whole.
        const pieces = it.aligned ? [[p, q]] : breakAtBoxes(p, q, extensionObstacles(p, q, items, it), S.clear);
        for (const [a, b] of pieces) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      }
      ctx.stroke();
    }
    // Dimension line and arrowheads.
    const { p1, p2 } = it;
    const L = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const u = { x: (p2.x - p1.x) / L, y: (p2.y - p1.y) / L };
    ctx.lineWidth = S.line;
    ctx.beginPath();
    if (it.arrowsOutside) {
      // Very short span: arrows outside pointing in, with short leaders.
      const lead = S.arrow * 1.8;
      ctx.moveTo(p1.x - u.x * lead, p1.y - u.y * lead);
      ctx.lineTo(p2.x + u.x * lead, p2.y + u.y * lead);
      ctx.stroke();
      arrowHead(ctx, p1, u, S.arrow, S.arrowHalf);
      arrowHead(ctx, p2, { x: -u.x, y: -u.y }, S.arrow, S.arrowHalf);
    } else {
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      arrowHead(ctx, p1, { x: -u.x, y: -u.y }, S.arrow, S.arrowHalf);
      arrowHead(ctx, p2, u, S.arrow, S.arrowHalf);
    }
    // Number.
    ctx.save();
    ctx.translate(it.text.x, it.text.y);
    ctx.rotate(it.text.rot);
    ctx.font = canvasFont(S.text);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hl ? DIM_COLORS.highlight : (it.dim.unknown ? COLORS.unmeasured : DIM_COLORS.text);
    ctx.fillText(it.dim.text, 0, 0);
    if (it.dim.note) {
      // Small ※: the two faces differ by more than the tolerance (plan §5-4).
      ctx.font = canvasFont(S.text * 0.55);
      ctx.fillStyle = DIM_COLORS.note;
      ctx.textAlign = 'left';
      ctx.fillText('※', it.text.w / 2 + S.text * 0.1, -S.text * 0.25);
    }
    ctx.restore();
  }
  ctx.restore();
  return items;
}

export function dimHitBoxes(ctx, project, derived, opts = {}) {
  return layoutDimensions(ctx, project, derived, opts).map((it) => ({
    dim: it.dim, box: it.box, textBox: it.textBox, side: it.side, row: it.row, drag: it.drag, moved: it.moved,
    ...(it.aligned ? { aligned: true, parts: it.parts } : {}),
  }));
}

// Where a dragged dimension number goes (plan §2-7): across the chain it snaps to a row of the same
// side (never another side), along the line it moves the number.
//   item: a layoutDimensions item; dx, dy: the drag in canvas px; opts: the draw options (offsetPx).
// → { row (target row, counted from the plan; at most one past the outermost), rowFloat,
//     offset: { dx, dy } paper mm, or undefined when the drag along the line is too small to mean it
//     (the number keeps its place along the line) }
export function dimDragTarget(item, dx, dy) {
  const g = item.drag;
  const along = item.horizontal ? dx : dy;
  const across = item.horizontal ? dy : dx;
  // The number's distance from the plan face → the row whose number band is nearest.
  const textPos = (item.horizontal ? item.text.y : item.text.x) + across;
  const linePos = textPos - g.sign * g.textOff - g.perp;
  const rowFloat = ((linePos - g.face) * g.sign - g.first) / g.rowStep;
  const row = Math.max(0, Math.min(g.rows, Math.round(rowFloat)));
  let offset;
  if (Math.abs(along) >= 6) {
    const a = (g.textAlong + along - g.midAlong) / g.offsetPx;
    offset = item.horizontal ? { dx: a, dy: 0 } : { dx: 0, dy: a };
  }
  return { row, rowFloat, offset };
}
