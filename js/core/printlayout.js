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
//                { x, y, w, h }), chainRows: { top, right, bottom, left },
//                parts: null, or for a plan of separately drawn parts (separateParts) [{ project, derived, dx, dy (world
//                mm the part is moved on this page), layout (this layout with its toPx / worldToPaper moved by them) }] }
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

import { buildDimensions, placeChainTexts, formatDimValue, DIM_SIDES, layoutAlignedDims, wallPolygons, chainObstacles, boxOf, rotatedRectParts } from './dims.js';
import { placeLabels, estimateTextWidth, fixtureObstacles } from './labels.js';
import { placeOpening, slidingLeaves, normalizeOpening } from './openings.js';
import { validMemo, memoPaperWidth, memoGroups } from './memo.js';
import { pointInPolygon } from './geom.js';

// The separately drawn parts of a plan (a 별채, a second floor drawn beside the first: walls that touch no wall of the
// other part; the rule of the '떨어져 그린 부분' note, checks-full.js): each has its own dimension chains around it, on the
// screen and on paper (user 2026-11-08, question 8, 2안). A drawing standing inside a room of another one (C5's 드레스룸)
// stays with it, and a piece with no room of its own (a loose wall, a 구역 나누기 선 standing free) goes with the part it
// stands nearest to, like a fixture and a memo word (memoGroups: the strokes of one word stay together).
// → [{ project, derived }], one per part, each holding what belongs to that part; [] for a plan of one part.
const partsCache = new WeakMap();   // project → { derived, parts }
export function separateParts(project, derived) {
  if (!project || !derived || !Array.isArray(project.edges) || !Array.isArray(derived.rooms)) return [];
  const hit = partsCache.get(project);
  if (hit && hit.derived === derived) return hit.parts;
  const parts = splitIntoParts(project, derived);
  partsCache.set(project, { derived, parts });
  return parts;
}

function splitIntoParts(project, derived) {
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const e of project.edges) {
    for (const id of [e.a, e.b]) if (!parent.has(id)) parent.set(id, id);
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const firstNode = (dr) => (dr.face && Array.isArray(dr.face.nodeIds) && parent.has(dr.face.nodeIds[0]) ? dr.face.nodeIds[0] : null);
  const roomsOf = new Map();   // drawing (its root) → its rooms
  for (const dr of derived.rooms) {
    const id = firstNode(dr);
    if (!id) continue;
    const r = find(id);
    if (!roomsOf.has(r)) roomsOf.set(r, []);
    roomsOf.get(r).push(dr);
  }
  // A drawing inside a room of another one is part of that one.
  const hostOf = new Map();
  for (const [r, list] of roomsOf) {
    const q = list[0].face.points[0];
    const host = derived.rooms.find((dr) => !list.includes(dr) && firstNode(dr) && pointInPolygon(q, dr.face.points));
    if (host) hostOf.set(r, find(firstNode(host)));
  }
  const topOf = (r) => { const seen = new Set(); while (hostOf.has(r) && !seen.has(r)) { seen.add(r); r = hostOf.get(r); } return r; };
  const byTop = new Map();
  for (const r of roomsOf.keys()) if (!byTop.has(topOf(r))) byTop.set(topOf(r), { ids: new Set(), box: null });
  if (byTop.size < 2) return [];
  const parts = [...byTop.values()];
  const loose = new Map();   // the pieces with no room of their own: root → node ids
  for (const n of parent.keys()) {
    const r = find(n), g = byTop.get(topOf(r));
    if (g) g.ids.add(n);
    else { if (!loose.has(r)) loose.set(r, new Set()); loose.get(r).add(n); }
  }
  const boxOfIds = (ids) => {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const q of project.nodes) {
      if (!ids.has(q.id)) continue;
      b.minX = Math.min(b.minX, q.x); b.minY = Math.min(b.minY, q.y); b.maxX = Math.max(b.maxX, q.x); b.maxY = Math.max(b.maxY, q.y);
    }
    return b;
  };
  for (const g of parts) g.box = boxOfIds(g.ids);
  // The part a point belongs to: the one with a room around it, else the one whose walls are nearest.
  const partAt = (pt) => {
    const dr = derived.rooms.find((x) => firstNode(x) && pointInPolygon(pt, x.face.points));
    const inside = dr && parts.find((g) => g.ids.has(firstNode(dr)));
    if (inside) return inside;
    let best = parts[0], bd = Infinity;
    for (const g of parts) {
      const d = Math.hypot(Math.max(g.box.minX - pt.x, 0, pt.x - g.box.maxX), Math.max(g.box.minY - pt.y, 0, pt.y - g.box.maxY));
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  };
  const centre = (b) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  for (const ids of loose.values()) {
    const g = partAt(centre(boxOfIds(ids)));
    for (const n of ids) g.ids.add(n);
  }
  const memo = project.memo || [];
  const memoOf = new Map(parts.map((g) => [g, []]));
  for (const word of memoGroups(memo)) memoOf.get(partAt(centre(word.box))).push(...word.strokes.map((i) => memo[i]));
  const edgePart = new Map();
  for (const e of project.edges) edgePart.set(e.id, parts.find((g) => g.ids.has(e.a)));
  // A fixture on a wall goes with that wall, one standing free with the part it stands in or nearest to.
  const fixturesOf = new Map(parts.map((g) => [g, []]));
  for (const f of project.fixtures || []) if (f) fixturesOf.get(edgePart.get(f.wall) || partAt(f)).push(f);
  return parts.map((g) => {
    const edges = project.edges.filter((e) => edgePart.get(e.id) === g);
    const edgeIds = new Set(edges.map((e) => e.id));
    const rooms = derived.rooms.filter((dr) => firstNode(dr) && g.ids.has(firstNode(dr)));
    const roomIds = new Set(rooms.map((r) => r.roomId));
    const measures = (project.measures || []).filter((m) => roomIds.has(m.room));
    const mIds = new Set(measures.map((m) => m.id));
    return {
      project: {
        ...project, nodes: project.nodes.filter((q) => g.ids.has(q.id)), edges, measures,
        rooms: (project.rooms || []).filter((r) => roomIds.has(r.id)),
        wallChecks: (project.wallChecks || []).filter((w) => edgeIds.has(w.edge)),
        openings: (project.openings || []).filter((o) => edgeIds.has(o.edge)),
        fixtures: fixturesOf.get(g), memo: memoOf.get(g),
      },
      derived: {
        ...derived, rooms,
        spans: (derived.spans || []).filter((sp) => mIds.has(sp.measureId)),
        computedMeasures: (derived.computedMeasures || []).filter((c) => roomIds.has(c.room)),
        twoSidePairs: (derived.twoSidePairs || []).filter((tp) => (tp.measureIds || []).every((id) => mIds.has(id))),
      },
    };
  });
}

// The chains of a plan as they are drawn: one buildDimensions result per separately drawn part (a plan of one part: one).
export function partDimensions(project, derived, options = {}) {
  const several = separateParts(project, derived);
  return several.length ? several.map((q) => buildDimensions(q.project, q.derived, options)) : [buildDimensions(project, derived, options)];
}

// Paper mm kept free around the labels of two separately drawn parts and between two chains facing each other, so that they
// do not read as one.
export const PART_CLEAR_MM = 4;

// The paper mm two pieces of two parts (partPieces) have to keep from each other. PART_CLEAR_MM: labels, chains facing each
// other. A chain and a wall of the other part: what a chain keeps from an outward door. An extension line, and two chains on the
// same side (a 별채's bottom chain over its house's): what the numbers of a chain keep from its lines. Nothing between things
// that may stand close or cross: walls (they are where they were drawn), lines over lines and over rows, the rows of two
// parts crossing at the empty corner between two parts drawn corner to corner.
const OPPOSITE_SIDE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
function piecesClear(p, q) {
  const are = (a, b) => (p.kind === a && q.kind === b) || (p.kind === b && q.kind === a);
  if (are('wall', 'wall') || are('line', 'line') || are('line', 'row')) return 0;
  if (p.kind === 'line' || q.kind === 'line') return PAPER_STYLE.dimClearMM;
  if (p.kind === 'text' || q.kind === 'text') return PART_CLEAR_MM;
  if (p.kind === 'wall' || q.kind === 'wall') return DOOR_CHAIN_CLEAR_MM;
  const horizontal = (x) => x.side === 'top' || x.side === 'bottom';
  if (are('row', 'row') && horizontal(p) !== horizontal(q)) return 0;
  return OPPOSITE_SIDE[p.side] === q.side ? PART_CLEAR_MM : PAPER_STYLE.dimClearMM;
}

// The smallest move along one axis, towards dir (1 | −1), that lies in none of the open spans of moves. → the move (signed)
function firstFreeMove(spans, dir) {
  let at = 0;
  for (const [a, b] of spans.map(([a, b]) => (dir > 0 ? [a, b] : [-b, -a])).sort((u, v) => u[0] - v[0])) {
    if (a >= at) break;
    at = Math.max(at, b);
  }
  return dir * at;
}

// The nearest place (the shortest move on the two axes together, under limit) where the pieces own run into none of the pieces
// others: off the wing of a ㄱ자 house to the right and off its chain upward, where no move along one axis alone is free. From
// each place tried, the first two pieces that meet give their four ways out of each other. → { dx, dy } | null
function nearestFreePlace(own, others, limit) {
  const waysOut = (dx, dy) => {
    for (const p of own) {
      for (const q of others) {
        const C = piecesClear(p, q);
        if (!C) continue;
        const right = q.x1 + C - p.x0 - dx, left = p.x1 + dx + C - q.x0, down = q.y1 + C - p.y0 - dy, up = p.y1 + dy + C - q.y0;
        if (Math.min(right, left, down, up) > 1e-9) return [[right, 0], [-left, 0], [0, down], [0, -up]];
      }
    }
    return null;
  };
  const open = [{ dx: 0, dy: 0, len: 0 }], seen = new Set();
  for (let n = 0; n < 100 && open.length; n++) {
    const at = open.reduce((a, s) => (s.len < a.len ? s : a));
    open.splice(open.indexOf(at), 1);
    const ways = waysOut(at.dx, at.dy);
    if (!ways) return at;
    for (const [mx, my] of ways) {
      const dx = at.dx + mx, dy = at.dy + my, len = Math.abs(dx) + Math.abs(dy), key = `${dx.toFixed(3)},${dy.toFixed(3)}`;
      if (len < limit - 1e-9 && !seen.has(key)) { seen.add(key); open.push({ dx, dy, len }); }
    }
  }
  return null;
}

// The extent of a plan of several parts at one scale: each part's own (with its own chains), a part moved on the page only
// where what it prints would otherwise run into what another prints, and only as far as that needs (the distance between
// the parts is not measured: the ※ note says so; a 별채 in the yard of a ㄱ자 house stays where it is drawn while there is
// room there). From the left, each part is kept clear of those placed before it. → as contentExtent, plus
// parts: [{ project, derived, dx, dy }] (dx, dy: how far the part is moved, world mm)
function partsExtent(parts, scale, opts) {
  const k = 1 / scale;
  const exts = parts.map((q) => contentExtent(q.project, q.derived, scale, null, { ...opts, keepOrder: true, pieces: true }));
  const whole = {
    minX: Math.min(...exts.map((e) => e.bounds.minX)), minY: Math.min(...exts.map((e) => e.bounds.minY)),
    maxX: Math.max(...exts.map((e) => e.bounds.maxX)), maxY: Math.max(...exts.map((e) => e.bounds.maxY)),
  };
  const shifts = parts.map(() => ({ dx: 0, dy: 0 }));
  const originOf = (i) => ({ x: (exts[i].bounds.minX + shifts[i].dx - whole.minX) * k, y: (exts[i].bounds.minY + shifts[i].dy - whole.minY) * k });
  const rect = (i) => {
    const e = exts[i], o = originOf(i);
    return { x0: o.x + e.box.minX, y0: o.y + e.box.minY, x1: o.x + e.box.maxX, y1: o.y + e.box.maxY };
  };
  const piecesOf = (i) => {
    const o = originOf(i);
    return exts[i].pieces.map((p) => ({ ...p, x0: p.x0 + o.x, y0: p.y0 + o.y, x1: p.x1 + o.x, y1: p.y1 + o.y }));
  };
  const order = parts.map((_, i) => i).sort((a, b) => exts[a].bounds.minX - exts[b].bounds.minX || exts[a].bounds.minY - exts[b].bounds.minY);
  order.forEach((i, n) => {
    const own = piecesOf(i), others = order.slice(0, n).flatMap(piecesOf);
    // The moves along each axis that would leave a piece of this part too near a piece of the others.
    const alongX = [], alongY = [];
    for (const p of own) {
      for (const q of others) {
        const C = piecesClear(p, q);
        if (!C) continue;
        if (p.y0 < q.y1 + C && p.y1 + C > q.y0) alongX.push([q.x0 - C - p.x1, q.x1 + C - p.x0]);
        if (p.x0 < q.x1 + C && p.x1 + C > q.x0) alongY.push([q.y0 - C - p.y1, q.y1 + C - p.y0]);
      }
    }
    // The nearest free place to the right, below, above or to the left (0: where it is drawn), or nearer still on both axes.
    const moves = [{ dx: firstFreeMove(alongX, 1), dy: 0 }, { dx: 0, dy: firstFreeMove(alongY, 1) }, { dx: 0, dy: firstFreeMove(alongY, -1) }, { dx: firstFreeMove(alongX, -1), dy: 0 }];
    const length = (m) => Math.abs(m.dx) + Math.abs(m.dy);
    let best = moves.reduce((a, m) => (length(m) < length(a) - 1e-9 ? m : a));
    if (length(best) > 0) best = nearestFreePlace(own, others, length(best)) || best;
    shifts[i].dx += best.dx * scale;
    shifts[i].dy += best.dy * scale;
  });
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const rows = Object.fromEntries(DIM_SIDES.map((side) => [side, 0]));
  let planW = 0, planH = 0;
  exts.forEach((e, i) => {
    const r = rect(i);
    box.minX = Math.min(box.minX, r.x0); box.minY = Math.min(box.minY, r.y0); box.maxX = Math.max(box.maxX, r.x1); box.maxY = Math.max(box.maxY, r.y1);
    planW = Math.max(planW, (e.bounds.maxX + shifts[i].dx - whole.minX) * k);
    planH = Math.max(planH, (e.bounds.maxY + shifts[i].dy - whole.minY) * k);
    for (const side of DIM_SIDES) rows[side] = Math.max(rows[side], e.rows[side] || 0);
  });
  return { box, planW, planH, rows, bounds: whole, parts: parts.map((q, i) => ({ project: q.project, derived: q.derived, ...shifts[i] })) };
}

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
  out.push(...doorSwingPolygons(project, derived));
  return out;
}

// Distance (paper mm) of each side's first dimension row from the plan's outer face: PAPER_STYLE.dimLineMM,
// or farther where a door opens OUTWARD past that side's face (a Korean 현관문 always does): the row
// then runs clear of the door leaf and its arc by DOOR_CHAIN_CLEAR_MM (final review 2026-10-28, A3–A6:
// the 현관문's leaf and arc crossed the dimension line and its number). bounds: buildDimensions().bounds.
// → { top, right, bottom, left }
export const DOOR_CHAIN_CLEAR_MM = 2;
export function chainFirstRows(project, derived, scale, bounds) {
  const S = PAPER_STYLE;
  const out = { top: S.dimLineMM, right: S.dimLineMM, bottom: S.dimLineMM, left: S.dimLineMM };
  if (!project || !derived || !bounds || !(scale > 0)) return out;
  for (const poly of doorSwingPolygons(project, derived)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of poly) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
    const past = { top: bounds.minY - minY, bottom: maxY - bounds.maxY, left: bounds.minX - minX, right: maxX - bounds.maxX };
    for (const side of Object.keys(past)) {
      if (past[side] > 1) out[side] = Math.max(out[side], past[side] / scale + DOOR_CHAIN_CLEAR_MM);
    }
  }
  return out;
}

// World polygons of the hinged doors' leaves and swings (as draw-openings.js draws them).
function doorSwingPolygons(project, derived) {
  const out = [];
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

// Paper (question 5, 1안 '자리가 없을 때만 더 작게'): the prints whose texts may get smaller than their usual smallest
// size where no spot keeps the rules (치수선 없이 per-side values to 7.5 / 6.5 pt, PAPER_STYLE.smallValuePt;
// window / door labels under 70 %, core/labels.js OPENING_TINY_SCALES): 1:150, and a scale picked by hand from 1:75
// that draws the plan smaller than [자동] does (layout.autoBest). Every other print keeps its sizes (the automatic
// one at 1:50–1:100 too, and the same scale picked by hand). layout: computePrintLayout's (optional). → bool
export function paperSmallTexts(scale, layout = null) {
  if (scale === FALLBACK_SCALE) return true;
  return !!(layout && layout.manual && scale >= 75 && layout.autoBest > 0 && scale > layout.autoBest);
}

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
  // 치수선 없이, where paperSmallTexts allows it (1:150, a scale picked by hand smaller than [자동]): a value with no free
  // spot at heightPt may be these sizes in turn (user 2026-11-01 Q1 / 2026-11-07 1안; ui/render.js addValues).
  smallValuePt: [7.5, 6.5],
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
// scale. opts.memo === false leaves the memo strokes out (they are counted by default); opts.labels ===
// false leaves the room / window / door / fixture labels out (they only ever add to the box, and placing
// them is the slow part: computePrintLayout tries a scale's labels only when the rest fits). For one part of a
// plan of several (partsExtent): opts.keepOrder (placeRowTexts), opts.pieces (partPieces).
// → { box: { minX, minY, maxX, maxY } in paper mm with the plan's top-left outer corner at 0,0,
//      planW, planH, rows, bounds, pieces (opts.pieces) } (a plan of separately drawn parts: partsExtent's, with its parts)
export function contentExtent(project, derived, scale, dimsResult = null, opts = {}) {
  const several = separateParts(project, derived);
  if (several.length) return partsExtent(several, scale, opts);
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
  // Each side's first row as draw-dims.js draws it (past an outward door's swing: chainFirstRows).
  const firsts = chainFirstRows(project, derived, scale, b);
  // The numbers of every chain as draw-dims.js places them (dims.js placeChainTexts: a number past a corner
  // keeps clear of the other chain's numbers there), with estimated widths; none on the plan side of a line.
  const texts = placeChainTexts(dims, {
    k, arrow: S.dimArrowMM, gap: 1, first: firsts, firstDefault: S.dimLineMM, row: S.dimRowMM, textGap: S.dimTextGapMM, text: textH,
    textWidth: (d) => estimateTextWidth(d.text || formatDimValue(d.value), S.dimTextPt) * PT_MM, allowFlip: () => false, keepOrder: opts.keepOrder,
  });
  for (const chain of dims.chains) {
    const n = chain.rows.length;
    rows[chain.side] = n;
    if (!n) continue;
    const reach = (firsts[chain.side] > 0 ? firsts[chain.side] : S.dimLineMM) + (n - 1) * S.dimRowMM + S.dimTextGapMM + textH;
    if (chain.side === 'top') grow(0, -reach, planW, 0);
    if (chain.side === 'bottom') grow(0, planH, planW, planH + reach);
    if (chain.side === 'left') grow(-reach, 0, 0, planH);
    if (chain.side === 'right') grow(planW, 0, planW + reach, planH);
    // Numbers moved beside short spans may stick out along the chain.
    const origin = chain.side === 'top' || chain.side === 'bottom' ? b.minX : b.minY;
    for (const row of chain.rows) {
      for (const d of row) {
        const p = texts.get(d);
        if (!p) continue;
        const lo = (p.center - p.half - origin) * k, hi = (p.center + p.half - origin) * k;
        if (chain.side === 'top' || chain.side === 'bottom') grow(lo, 0, hi, 0);
        else grow(0, lo, 0, hi);
      }
    }
  }
  for (const side of DIM_SIDES) if (!(side in rows)) rows[side] = 0;
  // Dimensions of diagonal sides (dims.js rule 7), placed as draw-dims.js places them.
  let aligned = [];
  if (dims.aligned && dims.aligned.length) {
    aligned = layoutAlignedDims(dims, {
      wpu: scale, S: paperDimSizes(),
      textWidth: (d) => estimateTextWidth(d.text || formatDimValue(d.value), S.dimTextPt) * PT_MM,
      walls: wallPolygons(project, derived),
      obstacles: dimObstacles(project, derived),
      firsts, keepOrder: opts.keepOrder,
    });
    for (const a of aligned) {
      for (const p of [a.p1, a.p2, ...a.ext.flat(), ...a.textPoly]) {
        const x = (p.x - b.minX) * k, y = (p.y - b.minY) * k;
        grow(x, y, x, y);
      }
    }
  }
  // Labels (inside the plan almost always; an opening label outside an exterior wall can stick out).
  let labels = [];
  if (opts.labels !== false) {
    labels = placeLabels(project, derived, {
      fonts: { name: S.namePt, height: S.heightPt, opening: S.openingPt, fixture: S.fixturePt },
      worldPerUnit: PT_MM * scale, worldPerPaperMM: scale,
    });
    for (const l of labels) grow((l.box.minX - b.minX) * k, (l.box.minY - b.minY) * k, (l.box.maxX - b.minX) * k, (l.box.maxY - b.minY) * k);
  }
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
  const out = { box, planW, planH, rows, bounds: b };
  if (opts.pieces) out.pieces = partPieces(project, derived, dims, scale, firsts, aligned, labels, opts.memo !== false);
  return out;
}

// What one separately drawn part prints, piece by piece, for partsExtent: a box around the part would count the empty yard
// of a ㄱ자 house and the empty corners outside its chains as taken. Boxes in contentExtent's frame (paper mm):
// [{ kind, side, x0, y0, x1, y1 }], kind 'wall' (walls, fixtures, the swing of a door), 'row' (a dimension row on a side: its
// line and the band of its numbers, also where no number is written, so that no number of another part comes between them),
// 'num' (a chain's number, on a side), 'text' (a diagonal side's number, labels, memo strokes) or 'line' (extension lines,
// the lines of diagonal sides).
function partPieces(project, derived, dims, scale, firsts, aligned, labels, withMemo) {
  const b = dims.bounds, k = 1 / scale, D = paperDimSizes(), out = [];
  const add = (kind, q, side) => out.push({ kind, side, x0: (q.minX - b.minX) * k, y0: (q.minY - b.minY) * k, x1: (q.maxX - b.minX) * k, y1: (q.maxY - b.minY) * k });
  const grown = (q, by) => ({ minX: q.minX - by, minY: q.minY - by, maxX: q.maxX + by, maxY: q.maxY + by });
  // A line p–q (world mm), `half` wide on each side: slanted, in short pieces (one box around it would cover far too much).
  const along = (kind, p, q, half = 0) => {
    const n = Math.abs(q.x - p.x) < 1e-6 || Math.abs(q.y - p.y) < 1e-6 ? 1 : Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * k / D.text);
    const at = (t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    for (let i = 0; i < n; i++) add(kind, grown(boxOf([at(i / n), at((i + 1) / n)]), half));
  };
  const nodes = new Map(project.nodes.map((n) => [n.id, n])), edges = new Map(project.edges.map((e) => [e.id, e]));
  for (const w of wallPolygons(project, derived)) along('wall', nodes.get(edges.get(w.edgeId).a), nodes.get(edges.get(w.edgeId).b), w.t / 2);
  for (const poly of dimObstacles(project, derived)) add('wall', boxOf(poly));
  const chains = chainObstacles(dims, scale, D, (d) => estimateTextWidth(d.text || formatDimValue(d.value), PAPER_STYLE.dimTextPt) * PT_MM, firsts, true);
  for (const q of chains.boxes) add('num', q, q.side);
  const reach = (D.textGap + D.text) * scale;
  for (const s of chains.segs) {
    if (s.kind === 'ext') { along('line', s.p, s.q); continue; }
    const q = boxOf([s.p, s.q]);
    if (s.side === 'top') q.minY -= reach;
    if (s.side === 'bottom') q.maxY += reach;
    if (s.side === 'left') q.minX -= reach;
    if (s.side === 'right') q.maxX += reach;
    add('row', q, s.side);
  }
  for (const a of aligned) {
    along('line', a.p1, a.p2);
    for (const [p, q] of a.ext) along('line', p, q);
    for (const q of rotatedRectParts({ x: a.text.x, y: a.text.y }, a.text.angle, a.text.w * scale, a.text.h * scale)) add('text', q);
  }
  for (const l of labels) for (const q of l.parts || [l.box]) add('text', q);
  if (withMemo) {
    for (const st of validMemo(project.memo)) {
      // (A long stroke in runs of points, like a slanted line.)
      for (let i = 0; i < st.points.length; i += 16) add('text', grown(boxOf(st.points.slice(i, i + 17)), memoPaperWidth(st) / 2 * scale));
    }
  }
  return out;
}

// The content extents of one state ({ project, derived }: both are replaced, never changed in place, by every
// edit), per scale, memo and labels: a Map, kept as long as the derived snapshot (final review round 3: [출력]
// laid out a big household again at every tap on a 종류, and the editor's print scale once more).
const extentCache = new WeakMap();   // derived → { project, map }
// How many print layouts and content extents with labels were worked out (tests: the editor's print scale
// places no label of a household that falls back to 1:150; [출력] lays a preview out once).
export const layoutStats = { layouts: 0, labelExtents: 0, fallbackExtents: 0 };
function sharedExtents(project, derived) {
  if (!derived || typeof derived !== 'object') return new Map();
  const hit = extentCache.get(derived);
  if (hit && hit.project === project) return hit.map;
  const map = new Map();
  extentCache.set(derived, { project, map });
  return map;
}

export function computePrintLayout(project, derived, options = {}) {
  layoutStats.layouts++;
  const dpi = options.dpi > 0 ? options.dpi : 300;
  const hasTitle = !!(project && project.info && String(project.info.title || '').trim());
  const noteLines = Math.max(0, Math.floor(options.noteLines || 0));
  const titleH = titleBandMM(hasTitle), notesH = notesBandMM(noteLines);
  const dims = project && derived ? buildDimensions(project, derived, {}) : null;
  const manual = SCALES.includes(Number(options.scale)) ? Number(options.scale) : null;
  // No walls (a new household, or only a memo): nothing to fit, so the largest scale and no warning.
  const empty = !dims || !dims.bounds;
  // The content extent does not depend on the page: one per scale, shared by both orientations. The box
  // without the labels first (fast); the labels only where that box fits (final review 2026-10-28: the
  // labels of a crowded 1:100 took 1–1.4 s on a PC for A1 / A2, at every value typed once a text had been
  // moved by hand, and the 1:100 was not even used). extent(s, page fits) → the full extent when the box
  // without labels fits one of the pages, else that box (it does not fit anyway).
  // (Each extent is remembered with the state, sharedExtents: the editor's scale, [출력]'s preview at each 종류
  // and the file of the same household reuse it.)
  const shared = sharedExtents(project, derived);
  const extentsOf = (memo) => {
    const key = (s, labels) => `${s}|${memo ? 1 : 0}|${labels ? 1 : 0}`;
    const at = (s, labels) => {
      const k = key(s, labels);
      if (!shared.has(k)) {
        if (labels) { layoutStats.labelExtents++; if (s === FALLBACK_SCALE) layoutStats.fallbackExtents++; }
        shared.set(k, contentExtent(project, derived, s, dims, labels ? { memo } : { memo, labels: false }));
      }
      return shared.get(k);
    };
    const full = (s) => at(s, true);
    full.quick = (s, fitsAny) => {
      if (shared.has(key(s, true))) return shared.get(key(s, true));
      const b = at(s, false);
      return b && !fitsAny(b) ? b : full(s);
    };
    return full;
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
  // The automatic scale on one or both page sizes with these extents: the first scale at which one of
  // them fits (a page that needs a smaller drawing is never chosen, so its own scale is not looked for).
  // → Map page → { autoScale, autoExt }
  const autoOnPages = (pages, extent) => {
    const tests = pages.map((page) => areaOn(page).fits);
    const out = new Map();
    if (empty) { for (const page of pages) out.set(page, { autoScale: AUTO_SCALES[0], autoExt: null }); return out; }
    const fitsAny = (ext) => tests.some((f) => f(ext));
    for (const s of AUTO_SCALES) {
      const ext = extent.quick ? extent.quick(s, fitsAny) : extent(s);
      pages.forEach((page, i) => { if (!out.has(page) && tests[i](ext)) out.set(page, { autoScale: s, autoExt: ext }); });
      if (out.size) break;
    }
    // A page that did not fit at that scale: a larger number than the winner's (FALLBACK_SCALE stands for
    // it, without an extent: it is never printed). None fits: FALLBACK_SCALE on every page, its extent
    // worked out only when the layout is used (lazy: placing the labels of a big household at 1:150 takes
    // 0.3–1 s on a PC, and the editor and the texts moved by hand need the scale only; final review round 3,
    // D1: 1–3 s per value typed once a text had been moved by hand).
    const none = !out.size;
    let fallbackExt;
    const lazyExt = () => (fallbackExt === undefined ? (fallbackExt = extent(FALLBACK_SCALE)) : fallbackExt);
    for (const page of pages) {
      if (!out.has(page)) {
        out.set(page, none
          ? { autoScale: FALLBACK_SCALE, get autoExt() { return lazyExt(); } }
          : { autoScale: FALLBACK_SCALE, autoExt: null, placeholder: true });
      }
    }
    return out;
  };
  const pages = options.orientation === 'portrait' ? [A4_MM] : options.orientation === 'landscape' ? [A4_LANDSCAPE_MM] : [A4_MM, A4_LANDSCAPE_MM];
  const autos = autoOnPages(pages, extentAt);
  // The scale [자동] prints with these options: the smallest automatic scale of the pages tried (a page beaten
  // at a larger scale holds the FALLBACK_SCALE placeholder, never below the winner's). The dialog shows it as
  // '자동 (1:N)' also while a scale is picked by hand (final review round 3, manual-scale-auto-label-150: the
  // picked orientation's own placeholder read '자동 (1:150)' where [자동] prints 1:75).
  const autoBest = Math.min(...[...autos.values()].map((a) => a.autoScale));
  // Texts moved by hand are paper mm at the scale the editor shows them with: the automatic scale of the
  // print without the memo, the paper's orientation chosen freely (main.js printScale, ui/wiring.js
  // autoPrintScale). With 메모 포함 the print's own automatic scale may be smaller (a memo beside the plan)
  // and with a scale picked by hand the other orientation's: converted at those, the moved name of 거실
  // printed 2.6 paper mm from where the editor showed it (final check 2026-10-25). → offsetScale
  const editorAuto = (port, land) => Math.min(port, land);
  // (With one orientation asked for, the other's automatic scale is needed for the offsets only.)
  const both = autos.has(A4_MM) && autos.has(A4_LANDSCAPE_MM) ? autos : autoOnPages([A4_MM, A4_LANDSCAPE_MM], extentAt);
  let offsetScale = editorAuto(both.get(A4_MM).autoScale, both.get(A4_LANDSCAPE_MM).autoScale);
  if (memoCounted && validMemo(project && project.memo).length) {
    const bare = autoOnPages([A4_MM, A4_LANDSCAPE_MM], extentsOf(false));
    offsetScale = editorAuto(bare.get(A4_MM).autoScale, bare.get(A4_LANDSCAPE_MM).autoScale);
  }

  // The page, its orientation and the plan's place on it (paper mm, any dpi). With the automatic scale the
  // scale is known without it, so it is worked out when the layout is first read (see lazyLayout).
  const placeOnPage = () => {
    const fitOn = (page, orientation) => {
      const { printRect, area, fits } = areaOn(page);
      const { autoScale, autoExt } = autos.get(page) || { autoScale: FALLBACK_SCALE, autoExt: null };
      const ext = manual ? (dims && extentAt(manual)) : autoExt;
      return { page, orientation, printRect, area, autoScale, ext, overflow: ext ? !fits(ext) : false };
    };
    const portrait = autos.has(A4_MM) ? fitOn(A4_MM, 'portrait') : null;
    const landscape = autos.has(A4_LANDSCAPE_MM) ? fitOn(A4_LANDSCAPE_MM, 'landscape') : null;
    let fit = portrait || landscape;
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
    return {
      autoScale, overflow, orientation: fit.orientation,
      worldToPaper: (p) => ({ x: ox + (p.x - origin.minX) / scale, y: oy + (p.y - origin.minY) / scale }),
      paperRect: { x: 0, y: 0, w: page.w, h: page.h },
      printRect, planRect, contentRect,
      titleRect: hasTitle ? { x: printRect.x, y: printRect.y, w: printRect.w, h: titleH } : null,
      notesRect: noteLines ? { x: printRect.x, y: printRect.y + printRect.h - notesH, w: printRect.w, h: notesH } : null,
      chainRows: ext ? ext.rows : { top: 0, right: 0, bottom: 0, left: 0 },
      parts: ext && ext.parts ? ext.parts : null,
    };
  };
  // A scale picked by hand needs its extent anyway (overflow, orientation): placed now.
  const placed = manual ? placeOnPage() : null;
  const autoScale = placed ? placed.autoScale : autoBest;
  const scale = manual || autoScale;
  const warning = !empty && !manual && autoScale === FALLBACK_SCALE;
  return lazyLayout({ scale, autoScale, autoBest, offsetScale, manual: !!manual, warning, empty }, placed || placeOnPage, dpi);
}

// The fields of a print layout that need the plan's place on the page (computePrintLayout placeOnPage).
const PLACED_FIELDS = ['overflow', 'orientation', 'worldToPaper', 'paperRect', 'printRect', 'planRect', 'contentRect', 'titleRect', 'notesRect', 'chainRows'];

// The layout of one separately drawn part: the same page, its world coordinates moved by the part's dx, dy.
function shiftedLayout(layout, q) {
  const out = Object.create(layout);
  const w2p = (pt) => layout.worldToPaper({ x: pt.x + q.dx, y: pt.y + q.dy });
  Object.defineProperty(out, 'ofPart', { value: true });
  Object.defineProperty(out, 'worldToPaper', { value: w2p });
  Object.defineProperty(out, 'toPx', { value: (pt) => layout.paperToPx(w2p(pt)) });
  return out;
}

// A layout: the scale fields as given; the place on the page (placed, or a function giving it) read when a
// field of it is first read, so a caller that needs the scale only (wiring.autoPrintScale, main.js printScale)
// never places the labels of a big household at the 1:150 it falls back to; then the dpi fields.
function lazyLayout(fields, placed, dpi) {
  const pxPerPaperMM = dpi / 25.4;
  let place = typeof placed === 'function' ? null : placed;
  const P = () => place || (place = placed());
  const paperToPx = (p) => ({ x: p.x * pxPerPaperMM, y: p.y * pxPerPaperMM });
  const layout = { ...fields, dpi, pxPerPaperMM, paperToPx };
  for (const k of PLACED_FIELDS) Object.defineProperty(layout, k, { enumerable: true, configurable: true, get: () => P()[k] });
  let parts;
  Object.defineProperty(layout, 'parts', { enumerable: true, configurable: true, get: () => {
    if (parts === undefined) { const list = P().parts; parts = list ? list.map((q) => ({ ...q, layout: shiftedLayout(layout, q) })) : null; }
    return parts;
  } });
  let toPx = null, pixelSize = null;
  Object.defineProperty(layout, 'toPx', { enumerable: true, configurable: true, get: () => toPx || (toPx = ((w2p) => (p) => paperToPx(w2p(p)))(P().worldToPaper)) });
  Object.defineProperty(layout, 'pixelSize', { enumerable: true, configurable: true, get: () => pixelSize || (pixelSize = ((r) => ({ w: Math.round(r.w * pxPerPaperMM), h: Math.round(r.h * pxPerPaperMM) }))(P().paperRect)) });
  // (withDpi: the same layout at another dpi, without placing it again.)
  Object.defineProperty(layout, 'atDpi', { enumerable: false, value: (d) => lazyLayout(fields, () => P(), d > 0 ? d : 300) });
  return layout;
}

// The same print layout at another dpi (the plan's place on the page does not depend on it: ui/output.js lays
// out the preview once at the portrait page's dpi and, for a landscape page, takes it at the landscape one;
// final review round 3: a big household laid out twice per tap in the dialog). → layout
export function withDpi(layout, dpi) {
  if (layout && typeof layout.atDpi === 'function') return layout.atDpi(dpi);
  const pxPerPaperMM = dpi / 25.4;
  const paperToPx = (p) => ({ x: p.x * pxPerPaperMM, y: p.y * pxPerPaperMM });
  return {
    ...layout, dpi, pxPerPaperMM, paperToPx, toPx: (p) => paperToPx(layout.worldToPaper(p)),
    pixelSize: { w: Math.round(layout.paperRect.w * pxPerPaperMM), h: Math.round(layout.paperRect.h * pxPerPaperMM) },
  };
}