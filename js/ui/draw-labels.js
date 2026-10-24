// Draws room names + H, opening labels, fixture labels, the title and the ※ notes (stage C; plan §1-2).
//
//   drawLabels(ctx, project, derived, opts) → placed labels (core/labels.js placeLabels)
//   drawTitle(ctx, project, derived, opts)   paper only: project.info.title centred in layout.titleRect
//   drawNotes(ctx, project, derived, opts)   paper only: opts.options.notes lines in layout.notesRect
//   labelHitBoxes(ctx, project, derived, opts) → [{ key, kind, refId, box (px) }] for dragging labels
//
// opts: { toPx, pxPerMM, paper: { pxPerPaperMM, scale } | null, layout (paper: computePrintLayout result),
//         worldPerPaperMM (screen: print scale for label offsets, default 60),
//         offsetScale (paper: the automatic print scale; hand-moved offsets use it, so a label moved
//         on the screen lands on the same spot of the plan whatever scale is printed),
//         nameObstacles (paper: world boxes of the numbers of diagonal sides, which room names in rooms
//         with a diagonal side keep clear of; core/labels.js),
//         options: { include: { rooms, openings, fixtures }, notes: [string], includeTitle } }
// Paper sizes: name 12.3 pt black, 'H: 2280' 8.8 pt blue, opening labels 8.8 pt blue, fixture labels
// 8.8 pt black, title 14 pt black, notes 7.5 pt. Screen: comfortable fixed px sizes.

import { placeLabels } from '../core/labels.js';
import { PAPER_STYLE, PT_MM } from '../core/printlayout.js';
import { canvasFont, TEXT_PX } from './theme.js';
import { fixtureInnerLineMM } from './draw-fixtures.js';

export const SCREEN_LABEL_PX = { name: TEXT_PX.name, height: TEXT_PX.height, opening: 12, fixture: 12 };

// px per font unit, fonts in font units, world mm per font unit.
function labelUnits(opts) {
  const pxPerMM = opts.pxPerMM > 0 ? opts.pxPerMM : 0.06;
  if (opts.paper) {
    const pxPerUnit = opts.paper.pxPerPaperMM * PT_MM; // font unit = pt
    return {
      pxPerUnit,
      worldPerUnit: pxPerUnit / pxPerMM,
      worldPerPaperMM: opts.paper.pxPerPaperMM / pxPerMM,
      fonts: { name: PAPER_STYLE.namePt, height: PAPER_STYLE.heightPt, opening: PAPER_STYLE.openingPt, fixture: PAPER_STYLE.fixturePt },
    };
  }
  return { pxPerUnit: 1, worldPerUnit: 1 / pxPerMM, worldPerPaperMM: opts.worldPerPaperMM || 60, fonts: { ...SCREEN_LABEL_PX } };
}

function placeFor(ctx, project, derived, opts) {
  const U = labelUnits(opts);
  const include = (opts.options && opts.options.include) || {};
  const measure = (text, size, weight = 'normal') => {
    ctx.font = canvasFont(size * U.pxPerUnit, weight);
    return ctx.measureText(text).width / U.pxPerUnit;
  };
  ctx.save();
  const labels = placeLabels(project, derived, {
    fonts: U.fonts, worldPerUnit: U.worldPerUnit, worldPerPaperMM: U.worldPerPaperMM, measure, include,
    obstacles: opts.obstacles,
    // Paper: room names keep clear of the dimensions of diagonal sides inside the rooms.
    nameObstacles: opts.nameObstacles,
    // Hand-moved offsets at the automatic print scale (opts.offsetScale; screen = paper).
    offsetWorldPerPaperMM: opts.offsetScale > 0 ? opts.offsetScale : undefined,
    // The plain boxes' inner outline (draw-fixtures.js): their labels keep inside it.
    fixtureInner: opts.paper ? fixtureInnerLineMM({ worldPerPaperMM: U.worldPerPaperMM }) : fixtureInnerLineMM({ pxPerMM: opts.pxPerMM }),
  });
  ctx.restore();
  return { labels, U };
}

export function drawLabels(ctx, project, derived, opts = {}) {
  if (!project || !derived || typeof opts.toPx !== 'function') return [];
  const { labels, U } = placeFor(ctx, project, derived, opts);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    const c = opts.toPx({ x: l.x, y: l.y });
    ctx.save();
    ctx.translate(c.x, c.y);
    if (l.rot) ctx.rotate((l.rot * Math.PI) / 180);
    const heights = l.lines.map((ln) => ln.size * l.lineHeight * U.pxPerUnit);
    let y = -heights.reduce((s, h) => s + h, 0) / 2;
    l.lines.forEach((ln, i) => {
      const px = ln.size * U.pxPerUnit;
      ctx.font = canvasFont(px, ln.weight || 'normal');
      if (l.halo) {
        // Labels that sit on drawn lines (fixtures without the gray fill, e.g. a 기타 box): a thin
        // white outline keeps every glyph clear of the lines under it. Gray-filled boxes (옷장,
        // 신발장, 싱크대, 실 아님) have no lines inside and get no halo (labels.js).
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = Math.max(1, px * 0.22);
        ctx.lineJoin = 'round';
        ctx.strokeText(ln.text, 0, y + heights[i] / 2);
      }
      ctx.fillStyle = ln.color;
      ctx.fillText(ln.text, 0, y + heights[i] / 2);
      y += heights[i];
    });
    ctx.restore();
  }
  ctx.restore();
  return labels;
}

export function labelHitBoxes(ctx, project, derived, opts = {}) {
  if (!project || !derived || typeof opts.toPx !== 'function') return [];
  const { labels } = placeFor(ctx, project, derived, opts);
  return labels.map((l) => {
    const p = opts.toPx({ x: l.box.minX, y: l.box.minY }), q = opts.toPx({ x: l.box.maxX, y: l.box.maxY });
    return { key: l.key, kind: l.kind, refId: l.refId, box: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) } };
  });
}

export function drawTitle(ctx, project, derived, opts = {}) {
  const title = project && project.info && String(project.info.title || '').trim();
  const rect = opts.layout && opts.layout.titleRect;
  if (!title || !rect || !opts.paper) return;
  const u = opts.paper.pxPerPaperMM;
  const off = (project.labelOffsets || {}).title;
  const dx = off ? (Number(off.dx) || 0) * u : 0, dy = off ? (Number(off.dy) || 0) * u : 0;
  let size = PAPER_STYLE.titlePt * PT_MM * u;
  ctx.save();
  ctx.font = canvasFont(size, 'bold');
  const maxW = rect.w * u;
  const w = ctx.measureText(title).width;
  if (w > maxW) { size *= maxW / w; ctx.font = canvasFont(size, 'bold'); }
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(title, (rect.x + rect.w / 2) * u + dx, rect.y * u + dy);
  ctx.restore();
}

export function drawNotes(ctx, project, derived, opts = {}) {
  const lines = ((opts.options && opts.options.notes) || []).map((s) => String(s || '').trim()).filter(Boolean);
  const rect = opts.layout && opts.layout.notesRect;
  if (!lines.length || !rect || !opts.paper) return;
  const u = opts.paper.pxPerPaperMM;
  const size = PAPER_STYLE.notePt * PT_MM * u;
  const lh = size * PAPER_STYLE.noteLineFactor;
  ctx.save();
  ctx.font = canvasFont(size);
  ctx.fillStyle = '#222222';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // Bottom-aligned: a shorter list (e.g. without the bothValues note) keeps the plan where it is.
  const bottom = (rect.y + rect.h) * u;
  lines.forEach((line, i) => {
    const text = line.startsWith('※') ? line : `※ ${line}`;
    const y = bottom - (lines.length - i - 0.5) * lh;
    ctx.fillText(text, rect.x * u, y, rect.w * u);
  });
  ctx.restore();
}
