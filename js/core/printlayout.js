// A4 print layout (stage C; plan §7 "축척과 인쇄"). Pure functions, no DOM.
//
//   computePrintLayout(project, derived, options) → layout
//     options: { scale: 'auto' | 50 | 60 | 75 | 100 | 150, dpi = 300, noteLines = 0,
//                orientation: 'auto' (default) | 'portrait' | 'landscape', memo (default true: the
//                memo strokes are part of the content) }
//     layout:  { scale, autoScale, offsetScale (the editor's automatic scale: no memo, either paper
//                orientation; hand-moved offsets are converted at it), manual, warning, overflow, empty (no walls), dpi, pxPerPaperMM,
//                orientation ('portrait' | 'landscape'),
//                worldToPaper(pt) → paper mm, paperToPx(pt) → px, toPx(pt) → px (world → canvas px),
//                paperRect, printRect, contentRect, planRect, titleRect, notesRect (paper mm rects
//                { x, y, w, h }), chainRows: { top, right, bottom, left } }
//
// - The automatic scale is the largest of 1:50 / 1:60 / 1:75 / 1:100 at which the plan with its
//   dimension rows, the dimensions of diagonal sides (dims.js rule 7, placed by layoutAlignedDims as
//   draw-dims.js places them), labels, title band and notes band fits the A4 page inside 10 mm margins; if none
//   fits, 1:150 with `warning` (plan: "1:100으로도 안 들어가면 1:150을 쓰고 알려 줍니다"); `overflow`
//   when even that does not fit. A manual scale is used as given (overflow tells whether it fits).
// - Paper orientation (user 2026-10-18 "가로 종이로 자동"): A4 portrait or landscape, whichever prints
//   the plan larger (the larger scale); at the same scale a plan wider than tall (with its dimension
//   rows) lies on landscape, a taller one stands on portrait. With a scale picked by hand: the
//   orientation where it fits, else by the plan's shape. Decided by the drawing only, like the rest.
// - The layout depends only on the drawing, never on the 종류 or the other output choices: the title band
//   is reserved whenever the project has a title, the dimension rows and labels are always counted, and
//   the notes band holds `noteLines` (the caller passes the largest set of notes any choice can print). So
//   '전체 도면' and '그림만' (and 제목 포함 on/off) overlay exactly (plan: "축척과 도면 위치는 출력
//   선택과 상관없이 고정"). The one exception is 메모 포함: the handwritten memo is counted when it is
//   printed (opts.memo, ui/output.js printsMemo; review 2026-10-25: a memo written beside the plan was
//   printed off the paper), and takes no room when it is not (recheck 2026-10-25: an unprinted memo
//   shrank the print to 1:75 / 1:100).

import { buildDimensions, placeRowTexts, formatDimValue, DIM_SIDES, layoutAlignedDims, wallPolygons } from './dims.js';
import { placeLabels, estimateTextWidth, fixtureObstacles } from './labels.js';
import { placeOpening, slidingLeaves, normalizeOpening } from './openings.js';
import { validMemo, memoPaperWidth } from './memo.js';

// What the dimensions of diagonal sides (dims.js rule 7, layoutAlignedDims opts.obstacles) keep their
// numbers off besides the walls and the chains (fixer 2026-10-20, field: 1518 on the 싱크대 after a turn,
// 5000 over a door): every fixture box (설비, 기둥, 계단) and the swing of every hinged door (a quarter
// disc, as draw-openings.js draws it). → [[{ x, y }]] world polygons
export function dimObstacles(project, derived) {
  const out = [];
  if (!project || !derived) return out;
  for (const b of fixtureObstacles(project)) {
    out.push([{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]);
  }
  for (const raw of project.openings || []) {
    if (!raw || raw.kind !== 'door') continue;
    let o = null, pl = null;
    try {
      o = normalizeOpening(raw);
      pl = slidingLeaves(o) ? null : placeOpening(project, derived, o);
    } catch (_) { pl = null; }
    if (!pl || !pl.frame) continue;
    const fr = pl.frame;
    const sgn = o.swing.side === 'right' ? -1 : 1;
    const sh = o.swing.hinge === 'end' ? pl.s1 : pl.s0, so = o.swing.hinge === 'end' ? pl.s0 : pl.s1;
    const r = Math.abs(so - sh), towards = so > sh ? 1 : -1, hb = (fr.thick || 0) / 2;
    const at = (s, k) => ({ x: fr.A.x + fr.dir.x * s + fr.left.x * k, y: fr.A.y + fr.dir.y * s + fr.left.y * k });
    const poly = [at(sh, sgn * hb)];
    for (let i = 0; i <= 8; i++) {
      const a = (Math.PI / 2) * (i / 8);
      poly.push(at(sh + Math.cos(a) * r * towards, sgn * (hb + Math.sin(a) * r)));
    }
    out.push(poly);
  }
  return out;
}

export const A4_MM = { w: 210, h: 297 };
export const A4_LANDSCAPE_MM = { w: 297, h: 210 };
export const PRINT_MARGIN_MM = 10;
export const AUTO_SCALES = [50, 60, 75, 100];
export const FALLBACK_SCALE = 150;
export const SCALES = [50, 60, 75, 100, 150];
export const PT_MM = 25.4 / 72;

// Paper sizes of the drawing elements (plan §1-2; shared with the draw functions).
export const PAPER_STYLE = {
  dimLineMM: 8,          // first dimension row: distance from the outer wall face
  dimRowMM: 9,           // between rows
  dimTextPt: 15.8,
  dimTextGapMM: 0.8,     // dimension line → number
  dimArrowMM: 2.0,
  dimArrowHalfMM: 0.65,  // half the arrowhead's width
  dimExtGapMM: 1.5,      // outer wall face → extension line
  dimExtOverMM: 1.5,     // extension line past the dimension line
  dimClearMM: 1,         // clearance between numbers and lines
  namePt: 12.3, heightPt: 8.8, openingPt: 8.8, fixturePt: 8.8,
  valuePt: 10.5,         // 종류 '치수선 없이': each side's value inside the room (ui/render.js)
  titlePt: 14, titleGapMM: 4,
  notePt: 7.5, noteLineFactor: 1.35, notesGapMM: 3,
};

// Dimension sizes on paper in paper mm, in the form core/dims.js layoutAlignedDims takes (the same
// numbers draw-dims.js dimStyle uses, in canvas px).
export function paperDimSizes() {
  const S = PAPER_STYLE;
  return {
    first: S.dimLineMM, row: S.dimRowMM, textGap: S.dimTextGapMM, text: S.dimTextPt * PT_MM,
    arrow: S.dimArrowMM, arrowHalf: S.dimArrowHalfMM, extGap: S.dimExtGapMM, extOver: S.dimExtOverMM, clear: S.dimClearMM,
  };
}

export function titleBandMM(hasTitle) {
  return hasTitle ? PAPER_STYLE.titlePt * PT_MM * 1.3 + PAPER_STYLE.titleGapMM : 0;
}
export function notesBandMM(lines) {
  return lines > 0 ? PAPER_STYLE.notesGapMM + lines * PAPER_STYLE.notePt * PT_MM * PAPER_STYLE.noteLineFactor : 0;
}

// Extent of everything except the title and notes, relative to the plan's outer wall faces, at one
// scale. opts.memo === false leaves the memo strokes out (they are counted by default).
// → { box: { minX, minY, maxX, maxY } in paper mm with the plan's top-left outer corner at 0,0,
//      planW, planH, rows }
export function contentExtent(project, derived, scale, dimsResult = null, opts = {}) {
  const dims = dimsResult || buildDimensions(project, derived, {});
  const b = dims.bounds;
  if (!b) return null;
  const k = 1 / scale; // paper mm per world mm
  const planW = (b.maxX - b.minX) * k, planH = (b.maxY - b.minY) * k;
  const box = { minX: 0, minY: 0, maxX: planW, maxY: planH };
  const grow = (x0, y0, x1, y1) => {
    box.minX = Math.min(box.minX, x0); box.minY = Math.min(box.minY, y0);
    box.maxX = Math.max(box.maxX, x1); box.maxY = Math.max(box.maxY, y1);
  };
  const S = PAPER_STYLE;
  const textH = S.dimTextPt * PT_MM;
  const rows = {};
  for (const chain of dims.chains) {
    const n = chain.rows.length;
    rows[chain.side] = n;
    if (!n) continue;
    const reach = S.dimLineMM + (n - 1) * S.dimRowMM + S.dimTextGapMM + textH;
    if (chain.side === 'top') grow(0, -reach, planW, 0);
    if (chain.side === 'bottom') grow(0, planH, planW, planH + reach);
    if (chain.side === 'left') grow(-reach, 0, 0, planH);
    if (chain.side === 'right') grow(planW, 0, planW + reach, planH);
    // Numbers moved beside short spans may stick out along the chain.
    const origin = chain.side === 'top' || chain.side === 'bottom' ? b.minX : b.minY;
    for (const row of chain.rows) {
      const placed = placeRowTexts(row, {
        k, arrow: S.dimArrowMM, gap: 1,
        textWidth: (d) => estimateTextWidth(d.text || formatDimValue(d.value), S.dimTextPt) * PT_MM,
      });
      for (const p of placed.values()) {
        const lo = (p.center - p.half - origin) * k, hi = (p.center + p.half - origin) * k;
        if (chain.side === 'top' || chain.side === 'bottom') grow(lo, 0, hi, 0);
        else grow(0, lo, 0, hi);
      }
    }
  }
  for (const side of DIM_SIDES) if (!(side in rows)) rows[side] = 0;
  // Dimensions of diagonal sides (dims.js rule 7), placed as draw-dims.js places them.
  if (dims.aligned && dims.aligned.length) {
    const aligned = layoutAlignedDims(dims, {
      wpu: scale, S: paperDimSizes(),
      textWidth: (d) => estimateTextWidth(d.text || formatDimValue(d.value), S.dimTextPt) * PT_MM,
      walls: wallPolygons(project, derived),
      obstacles: dimObstacles(project, derived),
    });
    for (const a of aligned) {
      for (const p of [a.p1, a.p2, ...a.ext.flat(), ...a.textPoly]) {
        const x = (p.x - b.minX) * k, y = (p.y - b.minY) * k;
        grow(x, y, x, y);
      }
    }
  }
  // Labels (inside the plan almost always; an opening label outside an exterior wall can stick out).
  const labels = placeLabels(project, derived, {
    fonts: { name: S.namePt, height: S.heightPt, opening: S.openingPt, fixture: S.fixturePt },
    worldPerUnit: PT_MM * scale, worldPerPaperMM: scale,
  });
  for (const l of labels) grow((l.box.minX - b.minX) * k, (l.box.minY - b.minY) * k, (l.box.maxX - b.minX) * k, (l.box.maxY - b.minY) * k);
  // The memo strokes with half their printed line width.
  if (opts.memo !== false) {
    for (const st of validMemo(project && project.memo)) {
      const half = memoPaperWidth(st) / 2;
      for (const p of st.points) {
        const x = (p.x - b.minX) * k, y = (p.y - b.minY) * k;
        grow(x - half, y - half, x + half, y + half);
      }
    }
  }
  return { box, planW, planH, rows, bounds: b };
}

export function computePrintLayout(project, derived, options = {}) {
  const dpi = options.dpi > 0 ? options.dpi : 300;
  const pxPerPaperMM = dpi / 25.4;
  const hasTitle = !!(project && project.info && String(project.info.title || '').trim());
  const noteLines = Math.max(0, Math.floor(options.noteLines || 0));
  const titleH = titleBandMM(hasTitle), notesH = notesBandMM(noteLines);
  const dims = project && derived ? buildDimensions(project, derived, {}) : null;
  const manual = SCALES.includes(Number(options.scale)) ? Number(options.scale) : null;
  // No walls (a new household, or only a memo): nothing to fit, so the largest scale and no warning.
  const empty = !dims || !dims.bounds;
  // The content extent does not depend on the page: one per scale, shared by both orientations.
  const extentsOf = (memo) => {
    const cache = new Map();
    return (s) => {
      if (!cache.has(s)) cache.set(s, contentExtent(project, derived, s, dims, { memo }));
      return cache.get(s);
    };
  };
  const memoCounted = options.memo !== false;
  const extentAt = extentsOf(memoCounted);

  // The best fit on one page size.
  const areaOn = (page) => {
    const printRect = { x: PRINT_MARGIN_MM, y: PRINT_MARGIN_MM, w: page.w - 2 * PRINT_MARGIN_MM, h: page.h - 2 * PRINT_MARGIN_MM };
    const area = { x: printRect.x, y: printRect.y + titleH, w: printRect.w, h: printRect.h - titleH - notesH };
    const fits = (ext) => ext && ext.box.maxX - ext.box.minX <= area.w + 1e-9 && ext.box.maxY - ext.box.minY <= area.h + 1e-9;
    return { printRect, area, fits };
  };
  // The automatic scale on one page size with these extents. → { autoScale, autoExt }
  const autoOn = (page, extent) => {
    const { fits } = areaOn(page);
    let autoScale = empty ? AUTO_SCALES[0] : FALLBACK_SCALE, autoExt = null;
    if (!empty) {
      for (const s of AUTO_SCALES) {
        const ext = extent(s);
        if (fits(ext)) { autoScale = s; autoExt = ext; break; }
      }
      if (!autoExt) autoExt = extent(FALLBACK_SCALE);
    }
    return { autoScale, autoExt };
  };
  const fitOn = (page, orientation) => {
    const { printRect, area, fits } = areaOn(page);
    const { autoScale, autoExt } = autoOn(page, extentAt);
    const ext = manual ? (dims && extentAt(manual)) : autoExt;
    return { page, orientation, printRect, area, autoScale, ext, overflow: ext ? !fits(ext) : false };
  };
  const portrait = fitOn(A4_MM, 'portrait'), landscape = fitOn(A4_LANDSCAPE_MM, 'landscape');
  // Texts moved by hand are paper mm at the scale the editor shows them with: the automatic scale of the
  // print without the memo, the paper's orientation chosen freely (main.js printScale, ui/wiring.js
  // autoPrintScale). With 메모 포함 the print's own automatic scale may be smaller (a memo beside the plan)
  // and with a scale picked by hand the other orientation's: converted at those, the moved name of 거실
  // printed 2.6 paper mm from where the editor showed it (final check 2026-10-25). → offsetScale
  const editorAuto = (port, land) => Math.min(port, land);
  let offsetScale = editorAuto(portrait.autoScale, landscape.autoScale);
  if (memoCounted && validMemo(project && project.memo).length) {
    const bare = extentsOf(false);
    offsetScale = editorAuto(autoOn(A4_MM, bare).autoScale, autoOn(A4_LANDSCAPE_MM, bare).autoScale);
  }
  let fit = portrait;
  if (options.orientation === 'landscape') fit = landscape;
  else if (options.orientation !== 'portrait' && !empty) {
    // The plan's shape with its dimension rows, at the scale in question.
    const wide = (f) => !!(f.ext && (f.ext.box.maxX - f.ext.box.minX) > (f.ext.box.maxY - f.ext.box.minY));
    if (manual) {
      if (portrait.overflow !== landscape.overflow) fit = portrait.overflow ? landscape : portrait;
      else fit = wide(portrait) ? landscape : portrait;
    } else if (landscape.autoScale !== portrait.autoScale) {
      fit = landscape.autoScale < portrait.autoScale ? landscape : portrait;
    } else if (portrait.overflow !== landscape.overflow) {
      fit = portrait.overflow ? landscape : portrait;
    } else {
      fit = wide(portrait) ? landscape : portrait;
    }
  }
  const { page, printRect, area, autoScale, ext, overflow } = fit;
  const warning = !empty && !manual && autoScale === FALLBACK_SCALE;
  const scale = manual || autoScale;

  // Centre the content in the area between the title and notes bands.
  let ox = area.x, oy = area.y, planRect = null, contentRect = null;
  const origin = ext ? ext.bounds : { minX: 0, minY: 0 };
  if (ext) {
    const cw = ext.box.maxX - ext.box.minX, ch = ext.box.maxY - ext.box.minY;
    ox = area.x + (area.w - cw) / 2 - ext.box.minX; // paper x of the plan's left outer face
    oy = area.y + (area.h - ch) / 2 - ext.box.minY;
    planRect = { x: ox, y: oy, w: ext.planW, h: ext.planH };
    contentRect = { x: ox + ext.box.minX, y: oy + ext.box.minY, w: cw, h: ch };
  }
  const worldToPaper = (p) => ({ x: ox + (p.x - origin.minX) / scale, y: oy + (p.y - origin.minY) / scale });
  const paperToPx = (p) => ({ x: p.x * pxPerPaperMM, y: p.y * pxPerPaperMM });
  const toPx = (p) => paperToPx(worldToPaper(p));
  return {
    scale, autoScale, offsetScale, manual: !!manual, warning, overflow, empty, dpi, pxPerPaperMM, orientation: fit.orientation,
    worldToPaper, paperToPx, toPx,
    paperRect: { x: 0, y: 0, w: page.w, h: page.h },
    printRect, planRect, contentRect,
    titleRect: hasTitle ? { x: printRect.x, y: printRect.y, w: printRect.w, h: titleH } : null,
    notesRect: noteLines ? { x: printRect.x, y: printRect.y + printRect.h - notesH, w: printRect.w, h: notesH } : null,
    chainRows: ext ? ext.rows : { top: 0, right: 0, bottom: 0, left: 0 },
    pixelSize: { w: Math.round(page.w * pxPerPaperMM), h: Math.round(page.h * pxPerPaperMM) },
  };
}