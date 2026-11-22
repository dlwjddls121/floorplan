// Draws room names + H, opening labels, fixture labels, the title and the ※ notes (stage C; plan §1-2).
//
//   drawLabels(ctx, project, derived, opts) → placed labels (core/labels.js placeLabels)
//   drawRoomNames(ctx, project, derived, opts) → placed labels; writes the room names only (그림만, ui/output.js)
//   drawTitle(ctx, project, derived, opts)   paper only: project.info.title centred in layout.titleRect
//   drawNotes(ctx, project, derived, opts)   paper only: opts.options.notes lines in layout.notesRect
//   labelHitBoxes(ctx, project, derived, opts) → [{ key, kind, refId, box (px), poly (a label along a diagonal wall: its
//                                                 turned corners, px) }] for dragging labels
//
// opts: { toPx, pxPerMM, paper: { pxPerPaperMM, scale } | null, layout (paper: computePrintLayout result),
//         worldPerPaperMM (screen: print scale for label offsets, default 60),
//         offsetScale (paper: the automatic print scale; hand-moved offsets use it, so a label moved
//         on the screen lands on the same spot of the plan whatever scale is printed),
//         nameObstacles (paper: world boxes of the numbers of diagonal sides, which room names in rooms
//         with a diagonal side keep clear of; core/labels.js),
//         thinLines (paper: world segments [[p, q]] of the drawn extension lines; core/labels.js),
//         placed (the labels drawLabels / drawRoomNames placed before for the same opts: not placed again),
//         options: { include: { rooms, openings, fixtures }, notes: [string], includeTitle } }
// Paper sizes: name 12.3 pt black, 'H: 2280' 8.8 pt blue, opening labels 8.8 pt blue, fixture labels
// 8.8 pt black, title 14 pt black, notes 7.5 pt. Screen: comfortable fixed px sizes.
// Paper texts are measured and drawn in the bundled output font (theme.js PAPER_FONT_STACK), the screen's
// in FONT_STACK.

import { placeLabels, LABEL_COLORS } from '../core/labels.js';
import { PAPER_STYLE, PT_MM, paperSmallTexts } from '../core/printlayout.js';
import { canvasFont, paperFont, TEXT_PX } from './theme.js';
import { fixtureInnerLineMM } from './draw-fixtures.js';
import { paperTextWidth } from './paperfont.js';

export const SCREEN_LABEL_PX = { name: TEXT_PX.name, height: TEXT_PX.height, opening: 12, fixture: 12 };

// px per font unit, fonts in font units, world mm per font unit.
function labelUnits(opts) {
  const pxPerMM = opts.pxPerMM > 0 ? opts.pxPerMM : 0.06;
  if (opts.paper) {
    const pxPerUnit = opts.paper.pxPerPaperMM * PT_MM; // font unit = pt
    return {
      pxPerUnit,
      paper: true,
      worldPerUnit: pxPerUnit / pxPerMM,
      worldPerPaperMM: opts.paper.pxPerPaperMM / pxPerMM,
      fonts: { name: PAPER_STYLE.namePt, height: PAPER_STYLE.heightPt, opening: PAPER_STYLE.openingPt, fixture: PAPER_STYLE.fixturePt },
    };
  }
  return { pxPerUnit: 1, paper: false, worldPerUnit: 1 / pxPerMM, worldPerPaperMM: opts.worldPerPaperMM || 60, fonts: { ...SCREEN_LABEL_PX } };
}

function placeFor(ctx, project, derived, opts) {
  const U = labelUnits(opts);
  const include = (opts.options && opts.options.include) || {};
  // (Paper, round 5: the width from the output font's own advances, the same on every device; paperfont.js.)
  const measure = (text, size, weight = 'normal') => {
    ctx.font = canvasFont(size * U.pxPerUnit, weight, U.paper);
    const w = U.paper ? paperTextWidth(text, size * U.pxPerUnit, weight) : null;
    return (w != null ? w : ctx.measureText(text).width) / U.pxPerUnit;
  };
  ctx.save();
  const labels = placeLabels(project, derived, {
    fonts: U.fonts, worldPerUnit: U.worldPerUnit, worldPerPaperMM: U.worldPerPaperMM, measure, include,
    obstacles: opts.obstacles,
    // Paper: room names keep clear of the dimensions of diagonal sides inside the rooms.
    nameObstacles: opts.nameObstacles,
    // Paper: the dimension extension lines (world segments, ui/output.js paperLabelObstacles); a window /
    // door label moves along its wall off them where it can (the 구역 나누기 선 always count).
    thinLines: opts.thinLines,
    // Hand-moved offsets at the automatic print scale (opts.offsetScale; screen = paper).
    offsetWorldPerPaperMM: opts.offsetScale > 0 ? opts.offsetScale : undefined,
    // The plain boxes' inner outline (draw-fixtures.js): their labels keep inside it.
    fixtureInner: opts.paper ? fixtureInnerLineMM({ worldPerPaperMM: U.worldPerPaperMM }) : fixtureInnerLineMM({ pxPerMM: opts.pxPerMM }),
    // Paper at 1:150 and at a scale picked by hand smaller than [자동]'s: a window / door label with no clear spot down
    // to 70 % may be smaller still where that makes it clear (printlayout.js paperSmallTexts).
    tinyOpenings: !!opts.paper && paperSmallTexts(opts.paper.scale, opts.layout),
  });
  ctx.restore();
  return { labels, U };
}

// The labels placed for these opts: opts.placed when given (labels drawLabels / drawRoomNames returned for the very
// same opts: the 출력 dialog's preview places them once for 전체 도면, 외벽 표시 and 그림만), else placed now.
function placedFor(ctx, project, derived, opts) {
  if (Array.isArray(opts.placed)) return { labels: opts.placed, U: labelUnits(opts) };
  return placeFor(ctx, project, derived, opts);
}

export function drawLabels(ctx, project, derived, opts = {}) {
  if (!project || !derived || typeof opts.toPx !== 'function') return [];
  const { labels, U } = placedFor(ctx, project, derived, opts);
  paintLabels(ctx, labels, U, opts);
  return labels;
}

// 그림만 (ui/output.js; user 2026-11-21: '그림만에 실 이름까지는 표시'): the names of the rooms alone, written as
// drawLabels writes them (the same placement, size, colour, font and spot: the two kinds overlay), each name's H
// left out where it stands (the name keeps its place in the block). The name of a 실 아님 space too, as 전체 도면
// writes it (fixture-label size, no H); no window / door or fixture label; an unnamed room has no label
// (core/labels.js). opts: as drawLabels (placed too).
// → the placed labels, all of them (opts.placed for the same opts)
export function drawRoomNames(ctx, project, derived, opts = {}) {
  if (!project || !derived || typeof opts.toPx !== 'function') return [];
  const { labels, U } = placedFor(ctx, project, derived, opts);
  const rooms = new Map((derived.rooms || []).map((dr) => [dr.roomId, dr.room]));
  paintLabels(ctx, labels, U, opts, (l, ln) => isRoomNameLine(l, ln, rooms));
  return labels;
}

// A line of a room's name (not its H) in a label placed for a room, 실 아님 spaces included (core/labels.js placeRoom).
// rooms: Map roomId → room.
export function isRoomNameLine(l, ln, rooms) {
  if (!l || l.kind !== 'room' || !ln) return false;
  const room = rooms.get(l.refId);
  if (!room) return false;
  return !(ln.color === LABEL_COLORS.height && /^H: /.test(ln.text));
}

// Writes the labels (drawLabels). keep(label, line) → false: that line is not written (its place in the block stays);
// a label with no line kept is left out whole (and so is its knockout).
function paintLabels(ctx, labels, U, opts, keep = null) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    if (keep && !l.lines.some((ln) => keep(l, ln))) continue;
    const c = opts.toPx({ x: l.x, y: l.y });
    if (opts.paper && l.knockout && l.box) {
      // A window / door label whose spot is clear of everything but thin lines (extension lines, the
      // dashed 구역 나누기 선): those lines stop at the label (core/labels.js placeClear).
      const p = opts.toPx({ x: l.box.minX, y: l.box.minY }), q = opts.toPx({ x: l.box.maxX, y: l.box.maxY });
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      // (A label along a diagonal wall: its own turned rectangle, not the box around it.)
      if (l.shape) {
        ctx.beginPath();
        l.shape[0].map(opts.toPx).forEach((r, i) => (i ? ctx.lineTo(r.x, r.y) : ctx.moveTo(r.x, r.y)));
        ctx.closePath();
        ctx.fill();
      } else ctx.fillRect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      ctx.restore();
    }
    ctx.save();
    ctx.translate(c.x, c.y);
    if (l.rot) ctx.rotate((l.rot * Math.PI) / 180);
    const heights = l.lines.map((ln) => ln.size * l.lineHeight * U.pxPerUnit);
    let y = -heights.reduce((s, h) => s + h, 0) / 2;
    l.lines.forEach((ln, i) => {
      if (keep && !keep(l, ln)) { y += heights[i]; return; }
      const px = ln.size * U.pxPerUnit;
      ctx.font = canvasFont(px, ln.weight || 'normal', U.paper);
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
}

export function labelHitBoxes(ctx, project, derived, opts = {}) {
  if (!project || !derived || typeof opts.toPx !== 'function') return [];
  const { labels } = placeFor(ctx, project, derived, opts);
  return labels.map((l) => {
    const p = opts.toPx({ x: l.box.minX, y: l.box.minY }), q = opts.toPx({ x: l.box.maxX, y: l.box.maxY });
    return { key: l.key, kind: l.kind, refId: l.refId, box: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }, ...(l.shape ? { poly: l.shape[0].map(opts.toPx) } : null) };
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
  ctx.font = paperFont(size, 'bold');
  const maxW = rect.w * u;
  const w0 = paperTextWidth(title, size, 'bold');
  const w = w0 != null ? w0 : ctx.measureText(title).width;
  if (w > maxW) { size *= maxW / w; ctx.font = paperFont(size, 'bold'); }
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
  ctx.font = paperFont(size);
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
