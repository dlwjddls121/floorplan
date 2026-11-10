// Dimension chains (stage C; plan §1-2 "치수 줄 배치", §5-4, §7; answer key 예시 세대 A_정답목록.md §4).
// Pure functions, no DOM.
//
//   buildDimensions(project, derived, options) → { chains, dims, hidden, bounds }
//
// Rules (each one is documented where it is applied):
//  1. One dimension per measured value. Exception: the same side measured from the rooms on both faces
//     of one wall (derived.twoSidePairs, plan §5-4 '같은 구간') is merged into ONE dimension that shows
//     the larger value; with options.bothValues it reads 'larger(smaller)', e.g. '2800(2700)'.
//     The dimension line spans the inner faces of the room whose value is shown (plan §5-4: "치수선은
//     표시한 값의 실 범위에 맞춰 그립니다"), so a ruler on the print agrees with the number.
//     Not merged: the faces of an h / v wall one of which ends at a diagonal wall (twoSidePairs `faces`,
//     fixer 2026-10-20): two different lengths, each printed along its own room's face.
//  2. Chain side. A side whose wall is (partly) an exterior wall goes to the chain on the outside of that
//     wall (화장실2 left 980 → left, the 430 step of 베란다1 → left). An interior side goes to the nearer
//     exterior side of the plan's outer bounds (거실 3570 → right, 주방 400 → top).
//  3. Side-by-side rooms (plan §5-4, answer key Q2). Parallel measured sides of different rooms whose
//     wall centre lines start and end on the same perpendicular wall lines span "the same thing" on a
//     chain. If one of them is on an exterior wall, the interior ones are hidden (예시 세대 A: 화장실2 980 is
//     shown on the left chain, the 옆 칸 1100 stays in the data only). Otherwise at most one per chain is
//     shown: the one nearest to that chain. Hidden measures are listed in `hidden` (the editor can show
//     them when the dimension is tapped). Where a corner of one of them is a diagonal wall's, their inner
//     faces (FACE_SPAN_MM) or their values must match as well: a corner-to-corner wall cuts the two sides
//     at different places, and two different values are both printed (fixer 2026-10-20).
//  4. Rows (see assignRows). Spans that do not overlap share a row. Of overlapping spans, a measured
//     overall span is outermost (예시 세대 B 4520 over 1250 · 3160); otherwise the side nearer the chain goes
//     further out (예시 세대 A top: outer 1100 · 1550 · 2800 · 2600, inner 2800 · 400 · 2160, as in the plan
//     §1-2 and answer key §4), and at equal depth the longer span goes out. A per-dimension manual
//     override is stored in project.dimOverrides ([{ measureId, side, row, show }]); see installDims.
//  5. Totals are never computed (plan §0 '전체 치수는 잰 값이 있을 때만'): every dimension is one
//     measured value. A measured total (예시 세대 B 4520) is just another measured side.
//  6. Unmeasured sides get no dimension. With options.showUnknown (default off) an exterior side that
//     still needs a value gets a '?' dimension where no shown dimension covers it.
//  7. Measured diagonal sides (request 2026-10-19 "대각선으로도 그릴 수 있게") never join a chain: each
//     becomes an ALIGNED dimension (result.aligned) — its line parallel to the wall, spanning the
//     room's inner corners of that face (so a ruler on the print agrees with the number, as rule 1).
//     A diagonal outer wall gets it outside the house at the first chain row's distance from the outer
//     face, with extension lines from the inner corners; further out (one row step at a time) where it
//     would run into a chain; inside the room (see below) when no row outside is free. A diagonal
//     inner wall gets it inside the room whose value is shown, the line just off the inner face with its
//     arrows at the inner corners (no extension lines: a corner of a triangle room is too sharp for
//     them) and the number further in. The number reads along the line, upright. The two faces of one
//     wall follow rule 1 (one dimension, 'larger(smaller)' with bothValues). Placement:
//     layoutAlignedDims (shared by draw-dims.js and printlayout.js, so the print layout counts it).
//  8. Spans (DESIGN.md §7.7). A measured side cut by 구역 나누기 dividers keeps its value as one
//     dimension across the parts (derived.spans; like a measured overall dimension, so it goes outside
//     the parts). Each part without its own value gets a COMPUTED dimension (derived.computedMeasures):
//     `computed: true`, text in parentheses '(1500)', on the span's chain, inside the span (shorter,
//     same line). result.notes.splitComputed tells the print to add SPLIT_COMPUTED_NOTE. A WALL drawn
//     across a measured side makes a span too (DESIGN.md §7.9): its parts are computed with the wall's
//     assumed thickness between them; computed dims carry `byWall` / `wallGap` (tap text names the wall).

import { cornerCoeffs, islandWall } from './solver.js';
import { pointInPolygon, segmentIntersection } from './geom.js';
import { measureSideKey } from './rooms.js';
import { twoSideKey, resolvedKeys } from './checkkeys.js';

export const DIM_SIDES = ['top', 'right', 'bottom', 'left'];
// ※ line printed when a computed (parenthesised) dimension is on the page (see rule 8). It names what
// split the measured side (review 2026-10-25: a side split by a WALL printed '구역을 나눈 위치', though
// the plan has no 구역 나누기 선 and the screen says '벽 위치로 계산'): splitComputedNote picks one.
export const SPLIT_COMPUTED_NOTE = '※ 괄호 치수는 구역을 나눈 위치로 계산한 값입니다.';
export const SPLIT_COMPUTED_WALL_NOTE = '※ 괄호 치수는 벽 위치로 계산한 값입니다.';
export const SPLIT_COMPUTED_MIXED_NOTE = '※ 괄호 치수는 나눈 위치(벽·구역 나누기 선)로 계산한 값입니다.';
export const SPLIT_COMPUTED_NOTES = [SPLIT_COMPUTED_NOTE, SPLIT_COMPUTED_WALL_NOTE, SPLIT_COMPUTED_MIXED_NOTE];
// The note for these computed parts (computed dims, or derived.computedMeasures: `byWall` when a wall
// lies between the parts of their span, `byDivider` when a divider does). → string | null (none)
export function splitComputedNote(items) {
  const list = (items || []).filter((d) => d && d.computed);
  if (!list.length) return null;
  const wall = list.some((d) => d.byWall), divider = list.some((d) => !d.byWall || d.byDivider);
  return wall && divider ? SPLIT_COMPUTED_MIXED_NOTE : wall ? SPLIT_COMPUTED_WALL_NOTE : SPLIT_COMPUTED_NOTE;
}
const SPAN_EPS = 1;        // mm: wall lines closer than this are "the same line"
// Spans of the rooms on the two sides of a wall touch at the wall. When measures contradict each other
// the solver absorbs the difference in assumed walls and finishes, which can make such neighbours
// overlap a little (예시 세대 A as given: up to ~160 mm). Overlaps up to this much (and under 30 % of the
// shorter span) still count as "side by side"; a contained span always overlaps by its whole length.
const TOUCH_MM = 200;
const TOUCH_FRACTION = 0.3;
// Rule 3 next to a diagonal wall: inner faces whose ends differ by less than this are the same span.
const FACE_SPAN_MM = 5;

const sideKeyOf = measureSideKey;
const isNum = (v) => typeof v === 'number' && isFinite(v);

// ---- wall geometry shared with the drawing and print layout --------------------------------------

function settingsOf(project) {
  const s = (project && project.settings) || {};
  return {
    extWall: isNum(s.extWall) ? s.extWall : 150,
    intWall: isNum(s.intWall) ? s.intWall : 100,
    twoSideTolerance: isNum(s.twoSideTolerance) ? s.twoSideTolerance : 300,
  };
}

// Effective wall thickness: solved value, else measured, else the default by wall type.
export function wallThickness(edge, project, derived) {
  if (!edge || edge.kind === 'divider') return 0;
  const solved = derived && derived.solve && derived.solve.thickness;
  if (solved && typeof solved.get === 'function') {
    const t = solved.get(edge.id);
    if (isNum(t)) return Math.max(0, t);
  }
  if (isNum(edge.thickness)) return edge.thickness;
  const st = settingsOf(project);
  const pair = derived && derived.edgeFaces && derived.edgeFaces.get(edge.id);
  return pair && pair[0] != null && pair[1] != null ? st.intWall : st.extWall;
}

// True when wall item `o` runs parallel to the unit direction (ux, uy): a straight continuation (or
// overlap) of a wall, not a wall that meets it at a corner.
export function isStraightOn(o, ux, uy) {
  const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y;
  const l = Math.hypot(dx, dy);
  if (!(l > 1e-6)) return true;
  return Math.abs((dx / l) * uy - (dy / l) * ux) < 0.3;
}

// Outline of every wall (same construction as render.js, see wallOutline). → [{ edgeId, orient, t, points, box }]
export function wallPolygons(project, derived) {
  const { items, byNode } = wallItems(project, derived);
  const out = [];
  for (const it of items) {
    const points = wallOutline(it, byNode);
    if (points) out.push({ edgeId: it.edge.id, orient: it.edge.orient, t: it.t, points, box: boxOf(points) });
  }
  return out;
}

// The walls as wallOutline takes them. → { items: [{ edge, a, b, t }], byNode: Map nodeId → items }
function wallItems(project, derived) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const items = [];
  const byNode = new Map();
  for (const e of project.edges || []) {
    if (e.kind === 'divider') continue;
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const it = { edge: e, a, b, t: wallThickness(e, project, derived) };
    items.push(it);
    for (const id of [e.a, e.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(it);
    }
  }
  return { items, byNode };
}

// 외벽 (core/exterior.js; the red of ui/render.js paintExterior, on screen and on paper): the extra outlines
// an exterior wall is painted with at a MITRED joint (a diagonal wall meets there) shared with a wall that is
// not exterior. A mitred joint is shared out among all the walls meeting there, each to the node, so the
// inner wall's share reached into the exterior wall's band up to the node: a black wedge in the red corner
// (checker 2026-10-25: the 사선 벽 예시's 드레스룸 | 방1 diagonal at the top-left outer corner, the common
// "corner to corner" diagonal). Here the exterior wall's half at such a joint is outlined as joined to the
// other EXTERIOR walls only: its band runs through the joint and the outline's corner is whole. That area
// is wall ink anyway (the walls meeting at a joint leave no gap), so the red never reaches past the black.
// Only the half at the joint (cut square at the wall's middle, inside its own outline), so no other
// corner is outlined twice. Joints of horizontal / vertical walls only need nothing: there each end already
// reaches over the joint.
// items / byNode as wallOutline (render.js buildGeometry or wallItems); ids: Set of exterior wall ids.
// → [[{ x, y }]]
export function exteriorJointOutlines(items, byNode, ids) {
  const out = [];
  if (!ids || !ids.size) return out;
  const shared = (it, nodeId) => {
    const others = (byNode.get(nodeId) || []).filter((o) => o !== it && joinsWalls(o));
    return others.some((o) => !ids.has(o.edge.id)) && (!isAxisWall(it) || others.some((o) => !isAxisWall(o)));
  };
  const MID = '\u0000mid';
  for (const it of items) {
    if (!ids.has(it.edge.id) || !joinsWalls(it)) continue;
    for (const [nodeId, N] of [[it.edge.a, it.a], [it.edge.b, it.b]]) {
      if (!shared(it, nodeId)) continue;
      const mid = { x: (it.a.x + it.b.x) / 2, y: (it.a.y + it.b.y) / 2 };
      const half = { edge: { ...it.edge, a: nodeId, b: MID }, a: N, b: mid, t: it.t };
      const own = new Map([[nodeId, [half, ...(byNode.get(nodeId) || []).filter((o) => o !== it && ids.has(o.edge.id))]]]);
      const points = wallOutline(half, own);
      if (points) out.push(points);
    }
  }
  return out;
}

// The same for the paper (ui/output.js), built as wallPolygons builds the walls. → [{ points }]
export function exteriorJointPolygons(project, derived, ids) {
  if (!ids || !ids.size) return [];
  const { items, byNode } = wallItems(project, derived);
  return exteriorJointOutlines(items, byNode, ids).map((points) => ({ points }));
}

// 외벽: how far a 구역 나누기 선 from P towards Q runs inside the red walls at its end P (world mm). A line runs
// to the centre line of the wall it ends at; on a black wall that bit never showed, on a red one it was a
// black stub (checker 2026-10-25), so ui/render.js and ui/output.js start the line this much later (keeping
// its dashes where they were). Through walls overlapping or meeting at P, to the face of the last one; a
// point on the edge between two pieces of a wall (the line ends at the node splitting them) counts as
// inside. polys: world polygons ([{x,y}] | { points }). → distance (0: P is not in a red wall)
export function runInsideFrom(P, Q, polys) {
  const L = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (!(L > 1e-6) || !polys || !polys.length) return 0;
  const d = { x: (Q.x - P.x) / L, y: (Q.y - P.y) / L };
  const side = { x: -d.y * 0.01, y: d.x * 0.01 };
  const list = polys.map((pl) => (Array.isArray(pl) ? pl : pl && pl.points)).filter((pts) => Array.isArray(pts) && pts.length >= 3);
  let t = 0;
  for (let k = 0; k < 16 && t < L; k++) {
    const at = { x: P.x + d.x * (t + 0.01), y: P.y + d.y * (t + 0.01) };
    const probes = [at, { x: at.x + side.x, y: at.y + side.y }, { x: at.x - side.x, y: at.y - side.y }];
    let next = t;
    for (const pts of list) {
      if (!probes.some((p) => pointInPolygon(p, pts))) continue;
      // The first crossing of P→Q with this polygon's outline beyond t.
      let exit = L;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = d.x * ey - d.y * ex;
        if (Math.abs(den) < 1e-12) continue;
        const rx = a.x - P.x, ry = a.y - P.y;
        const u = (rx * ey - ry * ex) / den;       // along P→Q
        const v = (rx * d.y - ry * d.x) / den;     // along a→b
        if (v < -1e-9 || v > 1 + 1e-9 || u <= t + 1e-6) continue;
        if (u < exit) exit = u;
      }
      if (exit > next) next = exit;
    }
    if (!(next > t + 1e-6)) break;
    t = next;
  }
  return Math.min(t, L);
}

// ---- wall outline of one wall (shared with render.js) -------------------------------------------
//
// The centre line a–b widened by t/2 on both sides, its two ends joined to the walls meeting there:
//  - At a node where only horizontal / vertical walls meet (every node of a plan without diagonal
//    walls, e.g. 예시 세대 A) the end is extended by half the thickest wall meeting it there at a corner, so
//    corners are filled (joints overlap; walls are filled 'nonzero'). A straight continuation does
//    not count, or a thicker wall would poke past the inner corner of the room beside the thinner one.
//    This is the construction from before diagonal walls, kept exactly.
//  - At a node with a diagonal wall (request 2026-10-19), the faces are mitred: each face runs to
//    where it meets the face of the next wall around the node (any angle, any thickness), and the end
//    goes through the node itself, so the walls meeting there leave no gap (a T-junction too). On the
//    side of a room the meeting point is the room's inner corner (where the solver measures to). A
//    very sharp mitre is cut off: outside a sharp corner (the gap wider than 180°) at MITRE_LIMIT ×
//    the thicker wall from the node, a room corner sharper than about 7° at MITRE_LIMIT_INNER ×.
//  - A free end is cut square at its node.
// item: { edge, a, b, t }; byNode: Map nodeId → items (dividers and walls without thickness are not
// joined to). → [{x, y}] | null (no length or no thickness)
export const MITRE_LIMIT = 1;
export const MITRE_LIMIT_INNER = 8;

const isAxisWall = (it) => it.edge.orient === 'h' || it.edge.orient === 'v';
const joinsWalls = (o) => o.edge.kind !== 'divider' && o.t > 0;

export function wallOutline(item, byNode) {
  const { a, b, t, edge } = item;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6 || !(t > 0)) return null;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, ht = t / 2;
  const others = (id) => (byNode.get(id) || []).filter((o) => o !== item && joinsWalls(o));
  const mitred = (id) => !isAxisWall(item) || others(id).some((o) => !isAxisWall(o));
  const legacyExt = (id) => {
    let m = 0;
    for (const o of byNode.get(id) || []) {
      if (o === item || o.edge.kind === 'divider' || isStraightOn(o, ux, uy)) continue;
      m = Math.max(m, o.t / 2);
    }
    return m;
  };
  const mA = mitred(edge.a), mB = mitred(edge.b);
  if (!mA && !mB) {
    const ea = legacyExt(edge.a), eb = legacyExt(edge.b);
    const ax = a.x - ux * ea, ay = a.y - uy * ea, bx = b.x + ux * eb, by = b.y + uy * eb;
    return [
      { x: ax + nx * ht, y: ay + ny * ht }, { x: bx + nx * ht, y: by + ny * ht },
      { x: bx - nx * ht, y: by - ny * ht }, { x: ax - nx * ht, y: ay - ny * ht },
    ];
  }
  // Each end as a cap walked from the face on the right of the wall's direction away from the node
  // to the face on its left: at a that is −n → +n, at b +n → −n, so the polygon is cap(a) + cap(b).
  const legacyCap = (P, v, e) => {
    const vnx = -v.y, vny = v.x;
    const x = P.x - v.x * e, y = P.y - v.y * e;
    return [{ x: x - vnx * ht, y: y - vny * ht }, { x: x + vnx * ht, y: y + vny * ht }];
  };
  const capA = mA ? mitreCap(item, a, edge.a, { x: ux, y: uy }, others(edge.a)) : legacyCap(a, { x: ux, y: uy }, legacyExt(edge.a));
  const capB = mB ? mitreCap(item, b, edge.b, { x: -ux, y: -uy }, others(edge.b)) : legacyCap(b, { x: -ux, y: -uy }, legacyExt(edge.b));
  return capA.concat(capB);
}

// The end of `item` at node N (id nodeId), leaving N in unit direction v, mitred against the walls
// `others` meeting there. → [Q (own face on the right of v), N, (cut-off point on the next wall's
// face), P (own face on the left of v)]; a free end → [Q, P] at N.
function mitreCap(item, N, nodeId, v, others) {
  const h = item.t / 2;
  const vn = { x: -v.y, y: v.x };                 // left of v (the side of increasing angle)
  const Q0 = { x: N.x - vn.x * h, y: N.y - vn.y * h }, P0 = { x: N.x + vn.x * h, y: N.y + vn.y * h };
  const dirs = [];
  for (const o of others) {
    const far = o.edge.a === nodeId ? o.b : o.a;
    const ex = far.x - N.x, ey = far.y - N.y, l = Math.hypot(ex, ey);
    if (!(l > 1e-6)) continue;
    dirs.push({ o, w: { x: ex / l, y: ey / l } });
  }
  if (!dirs.length) return [Q0, P0];
  const base = Math.atan2(v.y, v.x);
  const turn = (w) => {
    let d = Math.atan2(w.y, w.x) - base;
    while (d <= 1e-9) d += 2 * Math.PI;
    while (d > 2 * Math.PI + 1e-9) d -= 2 * Math.PI;
    return d;
  };
  for (const d of dirs) d.phi = turn(d.w);
  const next = dirs.reduce((p, q) => (q.phi < p.phi ? q : p));        // first wall to the left
  const prev = dirs.reduce((p, q) => (q.phi > p.phi ? q : p));        // first wall to the right
  // Left: own left face against the next wall's right face, gap next.phi.
  const left = faceJoin(N, v, h, +1, next.w, next.o.t / 2, -1, next.phi);
  // Right: own right face against the previous wall's left face, gap 2π − prev.phi.
  const right = faceJoin(N, v, h, -1, prev.w, prev.o.t / 2, +1, 2 * Math.PI - prev.phi);
  const cap = [right.own, { x: N.x, y: N.y }];
  if (left.other) cap.push(left.other);
  cap.push(left.own);
  return cap;
}

// Where face `side` (+1 left, −1 right of v) of a wall leaving N along v (half thickness h) meets face
// `oside` of the wall leaving N along w (half thickness hw); the gap between the two faces is `gap`
// radians. → { own: point on the own face, other: point on the other face when the join is cut off }
function faceJoin(N, v, h, side, w, hw, oside, gap) {
  const vn = { x: -v.y, y: v.x }, wn = { x: -w.y, y: w.x };
  const p0 = { x: N.x + vn.x * h * side, y: N.y + vn.y * h * side };   // own face at the node
  const q0 = { x: N.x + wn.x * hw * oside, y: N.y + wn.y * hw * oside };
  const cr = v.x * w.y - v.y * w.x;
  // Parallel (a straight continuation, or walls on top of each other): square at the node.
  if (Math.abs(cr) < 1e-9) return { own: p0, other: null };
  // p0 + v s = q0 + w r
  const rx = q0.x - p0.x, ry = q0.y - p0.y;
  const s = (rx * w.y - ry * w.x) / cr;
  const M = { x: p0.x + v.x * s, y: p0.y + v.y * s };
  const limit = (gap > Math.PI ? MITRE_LIMIT : MITRE_LIMIT_INNER) * 2 * Math.max(h, hw);
  if (Math.hypot(M.x - N.x, M.y - N.y) <= limit) return { own: M, other: null };
  // Cut off: the line across the gap's bisector at `limit` from the node.
  const ang = Math.atan2(v.y, v.x) + (side > 0 ? gap / 2 : -gap / 2);
  const bx = Math.cos(ang), by = Math.sin(ang);
  const along = (p, d) => {
    const dd = d.x * bx + d.y * by;
    if (Math.abs(dd) < 1e-9) return p;
    const k = (limit - ((p.x - N.x) * bx + (p.y - N.y) * by)) / dd;
    return { x: p.x + d.x * k, y: p.y + d.y * k };
  };
  return { own: along(p0, v), other: along(q0, w) };
}

export function boxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// ---- small geometry helpers (also used by labels.js and render.js for diagonal walls and texts) ---

// Range [lo, hi] of a polygon on the line axis = coord ('x': the vertical line x = coord, giving its
// y range; 'y': the horizontal line y = coord, giving its x range). → [lo, hi] | null
export function polygonRangeAt(points, axis, coord) {
  const other = axis === 'x' ? 'y' : 'x';
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    const dp = p[axis] - coord, dq = q[axis] - coord;
    if (Math.abs(dp) < 1e-9) { lo = Math.min(lo, p[other]); hi = Math.max(hi, p[other]); }
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const v = p[other] + (q[other] - p[other]) * (dp / (dp - dq));
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

// Corners of a w × h rectangle centred at c, turned by `angle` radians (y down). → 4 points
export function rotatedRect(c, angle, w, h) {
  const ca = Math.cos(angle), sa = Math.sin(angle), hw = w / 2, hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: c.x + x * ca - y * sa, y: c.y + x * sa + y * ca }));
}

// A turned w × h rectangle as a row of small axis-aligned boxes along it (pieces about h long), for the
// box-based placement of other texts: one box around a slanted text would cover far too much.
// → [{ minX, minY, maxX, maxY }]
export function rotatedRectParts(c, angle, w, h) {
  const n = Math.max(1, Math.ceil(w / Math.max(h, 1e-9)));
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = -w / 2 + ((i + 0.5) * w) / n;
    out.push(boxOf(rotatedRect({ x: c.x + ux * s, y: c.y + uy * s }, angle, w / n, h)));
  }
  return out;
}

// Shoelace area (y down: a wall outline walked as wallOutline walks it is negative).
export function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function boxPoints(b) {
  return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
}

// True when two convex polygons overlap, or come closer than `pad` (separating axes; a segment is a
// polygon of 2 points). Like boxesHit: shapes that only touch do not overlap when pad = 0.
export function convexOverlap(P, Q, pad = 0) {
  for (const poly of [P, Q]) {
    const n = poly.length;
    for (let i = 0; i < (n === 2 ? 1 : n); i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      let ax = -(q.y - p.y), ay = q.x - p.x;
      const l = Math.hypot(ax, ay);
      if (!(l > 1e-12)) continue;
      ax /= l; ay /= l;
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (const v of P) { const d = v.x * ax + v.y * ay; if (d < p0) p0 = d; if (d > p1) p1 = d; }
      for (const v of Q) { const d = v.x * ax + v.y * ay; if (d < q0) q0 = d; if (d > q1) q1 = d; }
      if (p1 + pad <= q0 || q1 + pad <= p0) return false;
    }
  }
  return true;
}

// Area of the part of polygon `poly` inside box b (Sutherland–Hodgman clipping).
export function polygonBoxArea(poly, b) {
  let pts = poly;
  const clip = (inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const ip = inside(p), iq = inside(q);
      if (ip) out.push(p);
      if (ip !== iq) out.push(cut(p, q));
    }
    pts = out;
  };
  const atX = (x) => (p, q) => ({ x, y: p.y + ((q.y - p.y) * (x - p.x)) / (q.x - p.x) });
  const atY = (y) => (p, q) => ({ x: p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y), y });
  clip((p) => p.x >= b.minX, atX(b.minX));
  if (pts.length) clip((p) => p.x <= b.maxX, atX(b.maxX));
  if (pts.length) clip((p) => p.y >= b.minY, atY(b.minY));
  if (pts.length) clip((p) => p.y <= b.maxY, atY(b.maxY));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// Bounding box of the outer wall faces (world mm), or of the nodes when there are no walls; null if empty.
export function planOuterBounds(project, derived, walls = null) {
  const list = walls || wallPolygons(project, derived);
  if (list.length) return boxOf(list.flatMap((w) => w.points));
  const nodes = project.nodes || [];
  return nodes.length ? boxOf(nodes) : null;
}

// Inner corners of side `sideIndex` of a derived room, exactly as the solver measures the side
// (solver.innerLengthOf): the inner faces are the wall centre lines moved into the room by t/2 + finish,
// and each inner corner is the intersection with the adjacent side's inner face. → { A, B } | null
export function innerCorners(dr, sideIndex, project, derived) {
  const sides = dr && dr.sides;
  if (!sides || sides.length < 3) return null;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const n = sides.length;
  const side = sides[sideIndex], prev = sides[(sideIndex - 1 + n) % n], next = sides[(sideIndex + 1) % n];
  const A = nodes.get(side.from), B = nodes.get(side.to);
  if (!A || !B) return null;
  const finish = derived && derived.solve && derived.solve.finish;
  const offset = (edge, s) => {
    if (!edge || edge.kind === 'divider') return 0;
    const f = (finish && typeof finish.get === 'function' && finish.get(`${dr.roomId}:${s.key}`)) || 0;
    return wallThickness(edge, project, derived) / 2 + f;
  };
  const frame = (s) => {
    const P = nodes.get(s.from), Q = nodes.get(s.to);
    const dx = Q.x - P.x, dy = Q.y - P.y, l = Math.hypot(dx, dy);
    if (!(l > 1e-9)) return { dir: s.dir, normal: s.inwardNormal };
    const dir = { x: dx / l, y: dy / l };
    const turn = (-s.dir.y * s.inwardNormal.x + s.dir.x * s.inwardNormal.y) < 0 ? -1 : 1;
    return { dir, normal: { x: -dir.y * turn, y: dir.x * turn } };
  };
  const fS = frame(side), fP = frame(prev), fN = frame(next);
  const edgeA = edges.get(prev.edgeIds[prev.edgeIds.length - 1]);
  const edgeB = edges.get(next.edgeIds[0]);
  const ownA = edges.get(side.edgeIds[0]);
  const ownB = edges.get(side.edgeIds[side.edgeIds.length - 1]);
  const oA = offset(ownA, side), oB = offset(ownB, side);
  const cA = cornerCoeffs(fS.dir, fS.normal, fP.normal);
  const cB = cornerCoeffs(fS.dir, fS.normal, fN.normal);
  const sA = cA.kAdj * offset(edgeA, prev) + cA.kSide * oA;
  const sB = cB.kAdj * offset(edgeB, next) + cB.kSide * oB;
  return {
    A: { x: A.x + fS.dir.x * sA + fS.normal.x * oA, y: A.y + fS.dir.y * sA + fS.normal.y * oA },
    B: { x: B.x + fS.dir.x * sB + fS.normal.x * oB, y: B.y + fS.dir.y * sB + fS.normal.y * oB },
  };
}

// Finish layers drawn as part of the walls (plan §5-4: 화장실 쪽 벽(마감) 두께). The solver may give a
// room side a finish f ≥ 0: that room's inner face sits f further into the room than the wall face.
// Without drawing it the dimension (which ends at the finished face) would not match the drawn room.
// Each wall edge of such a side gets a band between offsets t/2 and t/2 + f, running along the edge;
// at the side's corners it reaches the adjacent wall's face both with and without that side's own
// finish, so corners are filled at convex and at reflex corners alike (overlaps are harmless: walls
// are filled 'nonzero'). → [{ roomId, sideKey, edgeIds, points: [4 world points] }]
export function finishPolygons(project, derived, minMM = 0.5) {
  const finish = derived && derived.solve && derived.solve.finish;
  if (!finish || typeof finish.get !== 'function') return [];
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const out = [];
  for (const dr of (derived && derived.rooms) || []) {
    const sides = dr.sides || [];
    const n = sides.length;
    if (n < 3) continue;
    const slanted = sides.some((sd) => sd.orient === 'd');
    const fOf = (s) => Math.max(0, finish.get(`${dr.roomId}:${s.key}`) || 0);
    const half = (edge) => (!edge || edge.kind === 'divider' ? 0 : wallThickness(edge, project, derived) / 2);
    for (let i = 0; i < n; i++) {
      const side = sides[i];
      const f = fOf(side);
      if (!(f > minMM)) continue;
      const prev = sides[(i - 1 + n) % n], next = sides[(i + 1) % n];
      const A = nodes.get(side.from), B = nodes.get(side.to);
      if (!A || !B) continue;
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (!(L > 1e-6)) continue;
      const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
      const turn = (-side.dir.y * side.inwardNormal.x + side.dir.x * side.inwardNormal.y) < 0 ? -1 : 1;
      const nrm = { x: -dir.y * turn, y: dir.x * turn };
      const adjNormal = (s) => {
        const P = nodes.get(s.from), Q = nodes.get(s.to);
        const l = P && Q ? Math.hypot(Q.x - P.x, Q.y - P.y) : 0;
        if (!(l > 1e-9)) return s.inwardNormal;
        const d = { x: (Q.x - P.x) / l, y: (Q.y - P.y) / l };
        const tr = (-s.dir.y * s.inwardNormal.x + s.dir.x * s.inwardNormal.y) < 0 ? -1 : 1;
        return { x: -d.y * tr, y: d.x * tr };
      };
      const cA = cornerCoeffs(dir, nrm, adjNormal(prev));
      const cB = cornerCoeffs(dir, nrm, adjNormal(next));
      const edgeA = edges.get(prev.edgeIds[prev.edgeIds.length - 1]);
      const edgeB = edges.get(next.edgeIds[0]);
      const adjA = [half(edgeA), half(edgeA) + (edgeA && edgeA.kind !== 'divider' ? fOf(prev) : 0)];
      const adjB = [half(edgeB), half(edgeB) + (edgeB && edgeB.kind !== 'divider' ? fOf(next) : 0)];
      // Walk the side's edges from A.
      let cur = side.from, along = 0;
      side.edgeIds.forEach((id, k) => {
        const e = edges.get(id);
        if (!e) return;
        const other = e.a === cur ? e.b : e.a;
        const P = nodes.get(cur), Q = nodes.get(other);
        cur = other;
        if (!P || !Q) return;
        const len = Math.hypot(Q.x - P.x, Q.y - P.y);
        const s0 = along, s1 = along + len;
        along = s1;
        if (e.kind === 'divider') return;
        const h = half(e);
        const lines = [h, h + f]; // inner (wall face) and outer (finished face) offsets
        // Extent along the side of each line: corners reach both adjacent faces (see above).
        const ext = (o, first) => {
          if (first && k === 0) {
            const s = adjA.map((oa) => cA.kAdj * oa + cA.kSide * o);
            return Math.min(...s);
          }
          if (!first && k === side.edgeIds.length - 1) {
            const s = adjB.map((ob) => cB.kAdj * ob + cB.kSide * o);
            return L + Math.max(...s);
          }
          return first ? s0 : s1;
        };
        const pt = (s, o) => ({ x: A.x + dir.x * s + nrm.x * o, y: A.y + dir.y * s + nrm.y * o });
        const points = [pt(ext(lines[0], true), lines[0]), pt(ext(lines[0], false), lines[0]),
          pt(ext(lines[1], false), lines[1]), pt(ext(lines[1], true), lines[1])];
        // A room with a diagonal side: the band winds the same way as the wall outlines, so the
        // shared edge along the wall face leaves no faint anti-aliased seam in the one 'nonzero'
        // fill (opposite windings cancel there). Plans without diagonal walls keep the old order.
        if (slanted && signedArea(points) > 0) points.reverse();
        out.push({ roomId: dr.roomId, sideKey: side.key, edgeIds: [id], points });
      });
    }
  }
  return out;
}

// Finish on the two faces of one wall edge, for cutting window / door gaps through it. 'left' is the
// left of the edge walked a→b in y-down coordinates (the normal (dy, −dx) / L, as openings.edgeFrame).
// → { left: mm, right: mm }
export function finishBeside(project, derived, edgeId) {
  const out = { left: 0, right: 0 };
  const finish = derived && derived.solve && derived.solve.finish;
  if (!finish || typeof finish.get !== 'function') return out;
  const e = (project.edges || []).find((x) => x.id === edgeId);
  if (!e) return out;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const A = nodes.get(e.a), B = nodes.get(e.b);
  if (!A || !B) return out;
  const left = { x: B.y - A.y, y: -(B.x - A.x) };
  for (const dr of (derived && derived.rooms) || []) {
    for (const s of dr.sides || []) {
      if (!s.edgeIds.includes(edgeId)) continue;
      const f = Math.max(0, finish.get(`${dr.roomId}:${s.key}`) || 0);
      const k = s.inwardNormal.x * left.x + s.inwardNormal.y * left.y > 0 ? 'left' : 'right';
      out[k] = Math.max(out[k], f);
    }
  }
  return out;
}

// Outer wall face reached from coordinate `coord` (along the chain axis) when looking from the plan
// toward chain `side`: where an extension line starts. Falls back to the plan bounds.
export function outerFaceAt(walls, side, coord, bounds) {
  const horizontalChain = side === 'top' || side === 'bottom';
  let best = null;
  for (const w of walls) {
    const lo = horizontalChain ? w.box.minX : w.box.minY;
    const hi = horizontalChain ? w.box.maxX : w.box.maxY;
    if (coord < lo - 0.5 || coord > hi + 0.5) continue;
    let v = side === 'top' ? w.box.minY : side === 'bottom' ? w.box.maxY : side === 'left' ? w.box.minX : w.box.maxX;
    if (w.orient === 'd') {
      // A diagonal wall: its real face along the scan line, not the corner of its bounding box.
      const r = polygonRangeAt(w.points, horizontalChain ? 'x' : 'y', Math.min(hi, Math.max(lo, coord)));
      if (!r) continue;
      v = side === 'top' || side === 'left' ? r[0] : r[1];
    }
    if (best == null || (side === 'top' || side === 'left' ? v < best : v > best)) best = v;
  }
  if (best == null) best = side === 'top' ? bounds.minY : side === 'bottom' ? bounds.maxY : side === 'left' ? bounds.minX : bounds.maxX;
  return horizontalChain ? { x: coord, y: best } : { x: best, y: coord };
}

// ---- dimension text ------------------------------------------------------------------------------

export function formatDimValue(v) {
  return v == null || !isFinite(v) ? '?' : String(Math.round(v));
}

// Text of a dimension: '2800', or '2800(2700)' with bothValues when the two faces differ; a computed
// part of a span (rule 8) reads '(1500)'.
export function dimText(dim, bothValues) {
  if (dim.value == null) return '?';
  const main = formatDimValue(dim.value);
  if (dim.computed) return `(${main})`;
  if (bothValues && dim.alt != null && Math.round(dim.alt) !== Math.round(dim.value)) return `${main}(${formatDimValue(dim.alt)})`;
  return main;
}

// What lies next to a computed part c (derived.computedMeasures, id 'computed:<span>:<room>:<side>') in its
// measured span (derived.spans[].joints: joints[k - 1] before part k, joints[k] after it), as the panel says it
// (ui/panel.js computedJoint): → { slantedJoint: a DIAGONAL wall (orient 'd') right before or after this part,
// jointGap: the straight walls' assumed thickness taken off the span (its wallGap when no wall is slanted) }
// (A slanted wall leaves more than its thickness along the side, e.g. 264 for a 100 wall: no '벽 두께'
// figure then; final review round 3, the tap text said '벽 위치로 계산 …, 벽 두께 X 뺌' for those too.)
function computedJointOf(project, derived, c) {
  const out = { slantedJoint: false, jointGap: isNum(c && c.wallGap) && c.wallGap > 0 ? c.wallGap : 0 };
  const spans = (derived && derived.spans) || [];
  const sp = c && c.spanId != null ? spans.find((x) => x && x.measureId === c.spanId) : null;
  if (!sp || !Array.isArray(sp.joints)) return out;
  const isSlanted = (j) => !!j && j.kind === 'wall' && (project.edges || []).some((e) => e.id === j.edgeId && e.orient === 'd');
  if (!sp.joints.some(isSlanted)) return out;
  const parts = Array.isArray(sp.parts) ? sp.parts : [];
  const k = parts.findIndex((p) => p && `computed:${sp.measureId}:${p.roomId}:${p.sideKey}` === c.id);
  out.slantedJoint = k < 0 ? true : isSlanted(sp.joints[k - 1]) || isSlanted(sp.joints[k]);
  out.jointGap = sp.joints.reduce((sum, j) => sum + (j && !isSlanted(j) && j.thickness > 0 ? j.thickness : 0), 0);
  return out;
}

// "방3 쪽 2700 / 주방 쪽 2800" — both values of a dimension, for the editor (plan §5-4).
export function describeDim(project, dim) {
  const rooms = new Map((project.rooms || []).map((r) => [r.id, r]));
  if (dim.computed) {
    const span = (project.measures || []).find((x) => x.id === dim.spanId);
    const r = rooms.get((dim.roomIds || [])[0]);
    const name = (r && r.name) || '이름 없는 실';
    if (dim.byWall) {
      // A wall drawn across a measured side (§7.9): the parts + the assumed wall make the whole. Next to a
      // slanted wall the part is where that wall stands, no thickness taken off (computedJointOf, as the panel).
      const total = span ? ` · 전체 ${formatDimValue(span.value)}` : '';
      if (dim.slantedJoint) return `${name} 쪽 ${formatDimValue(dim.value)} (사선 벽 자리로 계산${total})`;
      const gap = isNum(dim.jointGap) ? dim.jointGap : dim.wallGap;
      const wall = isNum(gap) && gap > 0 ? `, 벽 두께 ${formatDimValue(gap)} 뺌` : '';
      return `${name} 쪽 ${formatDimValue(dim.value)} (벽 위치로 계산${span ? `${total}${wall}` : ''})`;
    }
    return `${name} 쪽 ${formatDimValue(dim.value)} (구역을 나눈 위치로 계산${span ? ` · 전체 ${formatDimValue(span.value)}` : ''})`;
  }
  const parts = [];
  for (const id of dim.measureIds || []) {
    const m = (project.measures || []).find((x) => x.id === id);
    if (!m) continue;
    const r = rooms.get(m.room);
    const name = (r && r.name) || '이름 없는 실';
    parts.push(`${name} 쪽 ${formatDimValue(m.value)}`);
  }
  return parts.join(' / ');
}

// ---- building the chains -------------------------------------------------------------------------

// options: { bothValues = false, showUnknown = false }
// result.notes: { splitComputed, splitNote } — splitComputed: true when a computed '(…)' dimension is
// shown; splitNote: the ※ line it needs (splitComputedNote), or null.
// result.aligned: the dimensions of measured diagonal sides (rule 7; placed by layoutAlignedDims):
//   [{ key, measureIds, roomIds, value, alt, note, text, aligned: true, A, B (inner corners of the shown
//      face, world), dir (unit, along the side), inward (unit normal into the shown room), exterior,
//      outerDepth (inner face → outer wall face, mm), edgeIds, override }]
export function buildDimensions(project, derived, options = {}) {
  const opt = { bothValues: false, showUnknown: false, ...(options || {}) };
  const chains = DIM_SIDES.map((side) => ({ side, rows: [] }));
  const result = { chains, dims: [], aligned: [], hidden: [], bounds: null, notes: { splitComputed: false, splitNote: null } };
  if (!project || !derived || !Array.isArray(derived.rooms)) return result;
  const walls = wallPolygons(project, derived);
  const bounds = planOuterBounds(project, derived, walls);
  if (!bounds) return result;
  result.bounds = bounds;
  const st = settingsOf(project);
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const roomById = new Map(derived.rooms.map((dr) => [dr.roomId, dr]));
  const spanById = new Map((derived.spans || []).map((sp) => [sp.measureId, sp]));

  // 1. One candidate per measured axis-aligned side, and per measured span (rule 8); a measured
  // diagonal side gets an aligned candidate (rule 7).
  const cands = new Map(); // measureId → candidate
  for (const m of project.measures || []) {
    if (!isNum(m.value) || m.value <= 0) continue;
    const sp = spanById.get(m.id);
    const c = sp
      ? runCandidate(m.room, sideKeyOf(m), spanParts(sp, roomById), project, derived, nodes, edges, bounds)
      : (sideCandidate(m.room, sideKeyOf(m), roomById, project, derived, nodes, edges, bounds)
        || alignedCandidate(m.room, sideKeyOf(m), roomById, project, derived, edges));
    if (!c) continue;
    c.measure = m;
    if (sp) c.span = true;
    cands.set(m.id, c);
  }

  // 2. Merge the two faces of one wall (twoSidePairs) into one dimension showing the larger value. Not
  // the faces of an h / v wall one of which ends at a diagonal wall (`faces`, fixer 2026-10-20): they
  // are two different lengths, each printed along its own room's face (rule 3 keeps both); a ※ marks
  // both when the values differ more than the faces do by over the tolerance.
  const groupOf = new Map();
  const pairOf = new Map();   // 'idA|idB' (sorted) → twoSidePairs entry (a diagonal pair carries `excess`)
  const facePairs = [];
  for (const p of derived.twoSidePairs || []) {
    const ids = (p.measureIds || []).filter((id) => cands.has(id));
    if (ids.length < 2) continue;
    if (p.faces) { facePairs.push({ p, ids }); continue; }
    pairOf.set(ids.slice().sort().join('|'), p);
    const g = new Set();
    for (const id of ids) for (const x of groupOf.get(id) || [id]) g.add(x);
    for (const id of g) groupOf.set(id, g);
  }
  const overrides = overrideIndex(project);
  const resolved = resolvedKeys(project);
  const seen = new Set();
  let dims = [];
  const aligned = [];
  for (const [id, c] of cands) {
    if (seen.has(id)) continue;
    const members = [...(groupOf.get(id) || [id])].map((x) => cands.get(x));
    members.forEach((x) => seen.add(x.measure.id));
    const merged = mergeCandidates(members, overrides, st, resolved, pairOf);
    (merged.aligned ? aligned : dims).push(merged);
  }
  for (const { p, ids } of facePairs) {
    if (!(isNum(p.excess) && p.excess > st.twoSideTolerance)) continue;
    const ms = ids.map((id) => cands.get(id).measure);
    if (resolved.has(twoSideKey(ms))) continue;
    for (const d of dims) if (d.measureIds.some((id) => ids.includes(id))) d.note = true;
  }
  for (const d of aligned) d.text = dimText(d, opt.bothValues);
  result.aligned = aligned;

  // 3. Side-by-side rooms on the same span (rule 3).
  const hidden = [];
  dims = applyCoverRule(dims, bounds, hidden);

  // Manual chain side (before the computed parts, which follow their span's chain).
  for (const d of dims) {
    const ov = d.override;
    if (ov && DIM_SIDES.includes(ov.side) && sideAxis(ov.side) === d.axis) d.side = ov.side;
  }

  // 8. Computed parts of the spans: on the span's chain; left out where a measured dimension on that
  // chain already spans the same (another room's measure of the same stretch).
  const spanDim = new Map();
  for (const d of dims) for (const id of d.measureIds) if (spanById.has(id)) spanDim.set(id, d);
  for (const c of derived.computedMeasures || []) {
    const cand = sideCandidate(c.room, sideKeyOf(c), roomById, project, derived, nodes, edges, bounds);
    if (!cand || !isNum(c.value)) continue;
    const owner = spanDim.get(c.spanId);
    const ov = overrides.get(c.id) || null;
    const d = {
      key: c.id, measureIds: [], roomIds: [c.room], value: c.value, alt: null, note: false,
      axis: cand.axis, a: cand.a, b: cand.b, line: cand.line, lineSpan: cand.lineSpan, exterior: cand.exterior,
      side: owner ? owner.side : cand.side, override: ov, text: '', extFrom: [], computed: true, spanId: c.spanId,
      byWall: !!c.byWall, byDivider: !!c.byDivider, wallGap: isNum(c.wallGap) ? c.wallGap : 0,
      ...computedJointOf(project, derived, c),
    };
    if (ov && DIM_SIDES.includes(ov.side) && sideAxis(ov.side) === d.axis) d.side = ov.side;
    const dup = dims.some((x) => x.side === d.side && x.axis === d.axis
      && (sameLineSpan(x, d) || (Math.abs(x.a - d.a) < SPAN_EPS && Math.abs(x.b - d.b) < SPAN_EPS)));
    if (!dup) dims.push(d);
  }

  // 6. Optional '?' for exterior sides that still need a value.
  if (opt.showUnknown) dims = dims.concat(unknownDims(project, derived, roomById, nodes, edges, bounds, dims));

  // Texts.
  for (const d of dims) d.text = dimText(d, opt.bothValues);
  result.notes.splitComputed = dims.some((d) => d.computed);
  result.notes.splitNote = splitComputedNote(dims);

  // 4. Rows per chain.
  for (const d of dims) d.depth = Math.max(0, distToChain(d, bounds));
  for (const chain of chains) {
    const list = dims.filter((d) => d.side === chain.side);
    const extent = sideAxis(chain.side) === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    chain.rows = assignRows(list, { extent });
    for (const row of chain.rows) meetNeighbours(row);
  }
  // Extension lines start at the outer wall face at the drawn ends.
  for (const d of dims) d.extFrom = [outerFaceAt(walls, d.side, d.drawA, bounds), outerFaceAt(walls, d.side, d.drawB, bounds)];
  result.dims = dims;
  result.hidden = hidden;
  return result;
}

const sideAxis = (side) => (side === 'top' || side === 'bottom' ? 'x' : 'y');

// Candidate dimension for a room side. → candidate | null
function sideCandidate(roomId, key, roomById, project, derived, nodes, edges, bounds) {
  const dr = roomById.get(roomId);
  if (!dr || !dr.sides) return null;
  const i = dr.sides.findIndex((s) => s.key === key);
  if (i < 0) return null;
  return runCandidate(roomId, key, [{ dr, i }], project, derived, nodes, edges, bounds);
}

// The parts of a span (derived.spans entry) as [{ dr, i }], or null when a part is missing.
function spanParts(sp, roomById) {
  const parts = (sp.parts || []).map((p) => {
    const dr = roomById.get(p.roomId);
    return { dr, i: dr && dr.sides ? dr.sides.findIndex((s) => s.key === p.sideKey) : -1 };
  });
  return parts.length && parts.every((p) => p.dr && p.i >= 0) ? parts : null;
}

// Is the free side of one-faced wall `id` inside another room's outline (an island room's wall, by the
// solver's rule: solver.islandWall)? → bool
function freeSideInRoom(id, pair, nodes, edges, derived) {
  const e = edges.get(id);
  return !!e && islandWall(e, pair[0] != null ? -1 : 1, nodes, derived.rooms);
}

// Does a room (other than roomId and those in `skip`) lie beyond point p (on an outer wall) in direction
// v, before the plan's outer bounds? The ray from 200 mm out (past the wall) to the bounds against every
// other room's outline. → bool
function roomsBeyond(p, v, bounds, roomId, derived, skip = null) {
  const reach = v.x > 0 ? bounds.maxX - p.x : v.x < 0 ? p.x - bounds.minX : v.y > 0 ? bounds.maxY - p.y : p.y - bounds.minY;
  if (!(reach > 200)) return false;
  const a = { x: p.x + v.x * 200, y: p.y + v.y * 200 }, b = { x: p.x + v.x * reach, y: p.y + v.y * reach };
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  for (const dr of derived.rooms || []) {
    if (dr.roomId === roomId || (skip && skip.has(dr.roomId)) || !dr.face || !dr.face.points) continue;
    const pts = dr.face.points;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    if (x1 < lo.x || x0 > hi.x || y1 < lo.y || y0 > hi.y) continue;
    if (pointInPolygon(a, pts)) return true;
    for (let i = 0; i < pts.length; i++) if (segmentIntersection(a, b, pts[i], pts[(i + 1) % pts.length])) return true;
  }
  return false;
}

// Candidate dimension for a straight run of room sides: one side, or the parts of a span from the first
// part's inner corner at its start to the last part's inner corner at its end. → candidate | null
function runCandidate(roomId, key, parts, project, derived, nodes, edges, bounds) {
  if (!parts || !parts.length) return null;
  const first = parts[0], last = parts[parts.length - 1];
  const side = first.dr.sides[first.i], sideB = last.dr.sides[last.i];
  if (side.orient !== 'h' && side.orient !== 'v') return null; // rule 7: diagonal sides are checks only
  const icA = innerCorners(first.dr, first.i, project, derived);
  const icB = last === first ? icA : innerCorners(last.dr, last.i, project, derived);
  const P = nodes.get(side.from), Q = nodes.get(sideB.to);
  if (!icA || !icB || !P || !Q) return null;
  const ic = { A: icA.A, B: icB.B };
  const axis = side.orient === 'h' ? 'x' : 'y';
  const perp = axis === 'x' ? 'y' : 'x';
  const line = P[perp]; // wall centre line coordinate
  // Rule 2: exterior wall → the chain on its outside; else the nearer side of the outer bounds.
  let exterior = false;
  for (const id of parts.flatMap((p) => p.dr.sides[p.i].edgeIds)) {
    const e = edges.get(id);
    if (!e || e.kind === 'divider') continue;
    const pair = derived.edgeFaces && derived.edgeFaces.get(id);
    if (pair && (pair[0] == null) !== (pair[1] == null)) exterior = true;
  }
  // A wall whose outer side lies inside another room (a room standing free in a room, C5's 드레스룸) is an
  // inner wall here (final review 2026-10-28).
  if (exterior && parts.every((p) => p.dr.sides[p.i].edgeIds.every((id) => {
    const pair = derived.edgeFaces && derived.edgeFaces.get(id);
    return !(pair && (pair[0] == null) !== (pair[1] == null)) || freeSideInRoom(id, pair, nodes, edges, derived);
  }))) exterior = false;
  let chainSide, sideOver = null;
  if (exterior) {
    const out = axis === 'x' ? -side.inwardNormal.y : -side.inwardNormal.x;
    chainSide = axis === 'x' ? (out < 0 ? 'top' : 'bottom') : (out < 0 ? 'left' : 'right');
    // Another wing or building beyond this outer wall (C2: 방1 · 방2 measured on the 마당 wall printed on
    // the right chain past the right wing, beside its 화장실 / 방3 values; C6: the 본채's right side beside
    // the 별채's): the chain on the room's other side (final review 2026-10-28, dims-far-chain). Not for a
    // room built onto this wall (a 베란다 on part of it: round 2, 2026-10-31, the 거실's 4875 went to the
    // top chain under 방1 · 방2 as if one of their widths), nor when that other chain lies past other rooms
    // of this building (C6 turned: the 거실's 3675 printed over 방1's 3175 and the print went from 1:60 to
    // 1:75). Then it still goes there when the same span with the same value is printed there already
    // (applyCoverRule, sideOver: E2's 거실 3680 under a 베란다 is 방1's 3680 above it, printed once).
    const mid = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
    const outV = axis === 'x' ? { x: 0, y: out < 0 ? -1 : 1 } : { x: out < 0 ? -1 : 1, y: 0 };
    const own = new Set(parts.flatMap((p) => p.dr.sides[p.i].edgeIds));
    const attached = new Set((derived.rooms || []).filter((dr) => dr.face && dr.face.edgeIds.some((id) => own.has(id))).map((dr) => dr.roomId));
    const flipped = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[chainSide];
    const backV = { x: -outV.x, y: -outV.y };
    if (roomsBeyond(mid, outV, bounds, roomId, derived)) {
      if (roomsBeyond(mid, outV, bounds, roomId, derived, attached) && !roomsBeyond(mid, backV, bounds, roomId, derived)) chainSide = flipped;
      else sideOver = flipped;
    }
  } else if (axis === 'x') {
    chainSide = line - bounds.minY <= bounds.maxY - line ? 'top' : 'bottom';
  } else {
    chainSide = line - bounds.minX <= bounds.maxX - line ? 'left' : 'right';
  }
  const a = Math.min(ic.A[axis], ic.B[axis]), b = Math.max(ic.A[axis], ic.B[axis]);
  const nA = first.dr.sides.length, nB = last.dr.sides.length;
  return {
    roomId, sideKey: key, axis, a, b, line, exterior, side: chainSide,
    // The chain past a room built onto this wall, taken only to show this value once (rule 3).
    ...(sideOver ? { sideOver } : {}),
    // Wall centre lines at both ends (for rule 3).
    lineSpan: [Math.min(P[axis], Q[axis]), Math.max(P[axis], Q[axis])],
    // A corner of this run is a diagonal wall's (rule 3: then the inner faces decide "the same span").
    diagonalEnd: first.dr.sides[(first.i + nA - 1) % nA].orient === 'd' || last.dr.sides[(last.i + 1) % nB].orient === 'd',
  };
}

// Candidate dimension for a measured diagonal side (rule 7). → candidate | null
function alignedCandidate(roomId, key, roomById, project, derived, edges) {
  const dr = roomById.get(roomId);
  if (!dr || !dr.sides) return null;
  const i = dr.sides.findIndex((s) => s.key === key);
  if (i < 0) return null;
  const side = dr.sides[i];
  if (side.orient !== 'd' || side.allDivider) return null;
  const ic = innerCorners(dr, i, project, derived);
  if (!ic) return null;
  const L = Math.hypot(ic.B.x - ic.A.x, ic.B.y - ic.A.y);
  if (!(L > 1)) return null;
  const dir = { x: (ic.B.x - ic.A.x) / L, y: (ic.B.y - ic.A.y) / L };
  // The room lies on the side of the stored inward normal (rooms.js: interior on the right of dir).
  const turn = (-side.dir.y * side.inwardNormal.x + side.dir.x * side.inwardNormal.y) < 0 ? -1 : 1;
  const inward = { x: -dir.y * turn, y: dir.x * turn };
  let exterior = false, t = 0;
  for (const id of side.edgeIds) {
    const e = edges.get(id);
    if (!e || e.kind === 'divider') continue;
    t = Math.max(t, wallThickness(e, project, derived));
    const pair = derived.edgeFaces && derived.edgeFaces.get(id);
    if (pair && (pair[0] == null) !== (pair[1] == null)) exterior = true;
  }
  const fin = derived.solve && derived.solve.finish;
  const f = (fin && typeof fin.get === 'function' && Math.max(0, fin.get(`${roomId}:${key}`) || 0)) || 0;
  return { roomId, sideKey: key, aligned: true, A: ic.A, B: ic.B, dir, inward, exterior, outerDepth: t + f, edgeIds: side.edgeIds.slice() };
}

function overrideIndex(project) {
  const map = new Map();
  for (const o of project.dimOverrides || []) if (o && o.measureId) map.set(o.measureId, o);
  return map;
}

// Members: candidates of one physical side (1, or 2 for a two-faced wall).
// resolved: keys of the checks marked 확인 완료 (project.checks). pairOf: 'idA|idB' → twoSidePairs entry.
function mergeCandidates(members, overrides, st, resolved = new Set(), pairOf = new Map()) {
  let override = null;
  for (const c of members) override = override || overrides.get(c.measure.id) || null;
  // Larger value first; ties keep the entry order. An override { show: measureId } picks the shown value.
  const sorted = members.slice().sort((p, q) => q.measure.value - p.measure.value);
  let primary = sorted[0];
  if (override && override.show) primary = members.find((c) => c.measure.id === override.show) || primary;
  const others = members.filter((c) => c !== primary);
  const alt = others.length ? others[0].measure.value : null;
  // ※ next to the number (plan §5-4): a pair of rooms more than the tolerance apart, as long as its
  // 양쪽 값 차이 check is not marked 확인 완료 (※ appears only for unresolved check items). The two faces
  // of a DIAGONAL wall really differ in length, so there the pair's `excess` (how much more the values
  // differ than the drawn faces do; model.js twoSidePairs, the same number the 'twoSide' check uses)
  // is compared, not the raw difference.
  let note = false;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const p = members[i], q = members[j];
      if (p.roomId === q.roomId) continue;
      const pair = pairOf.get([p.measure.id, q.measure.id].sort().join('|'));
      const diff = pair && pair.diagonal && isNum(pair.excess) ? pair.excess : Math.abs(p.measure.value - q.measure.value);
      if (diff <= st.twoSideTolerance) continue;
      if (!resolved.has(twoSideKey([p.measure, q.measure]))) note = true;
    }
  }
  if (primary.aligned) {
    // Rule 7: a diagonal side (both faces of one wall merged like rule 1).
    return {
      key: primary.measure.id,
      measureIds: [primary.measure.id, ...others.map((c) => c.measure.id)],
      roomIds: [primary.roomId, ...others.map((c) => c.roomId)],
      value: primary.measure.value, alt, note, aligned: true, axis: 'd',
      A: primary.A, B: primary.B, dir: primary.dir, inward: primary.inward,
      exterior: members.some((c) => c.exterior), outerDepth: primary.outerDepth, edgeIds: primary.edgeIds,
      override, text: '',
    };
  }
  return {
    key: primary.measure.id,
    measureIds: [primary.measure.id, ...others.map((c) => c.measure.id)],
    roomIds: [primary.roomId, ...others.map((c) => c.roomId)],
    value: primary.measure.value,
    alt,
    note,
    axis: primary.axis,
    a: primary.a, b: primary.b,
    line: primary.line,
    lineSpan: primary.lineSpan,
    exterior: members.some((c) => c.exterior),
    side: (members.find((c) => c.exterior) || primary).side,
    sideOver: (members.find((c) => c.exterior) || primary).sideOver || null,
    override,
    text: '', extFrom: [],
    diagonalEnd: members.some((c) => c.diagonalEnd),
  };
}

function sameLineSpan(p, q) {
  return p.axis === q.axis && Math.abs(p.lineSpan[0] - q.lineSpan[0]) < SPAN_EPS && Math.abs(p.lineSpan[1] - q.lineSpan[1]) < SPAN_EPS;
}

function distToChain(d, bounds) {
  switch (d.side) {
    case 'top': return d.line - bounds.minY;
    case 'bottom': return bounds.maxY - d.line;
    case 'left': return d.line - bounds.minX;
    default: return bounds.maxX - d.line;
  }
}

// Rule 3. → the dimensions that stay; hidden ones are pushed to `hidden`.
function applyCoverRule(dims, bounds, hidden) {
  const out = new Set(dims);
  const done = new Set();
  // Where a corner of one of them is a diagonal wall's, the same wall lines do not make the same span:
  // the inner faces must match too, or the values (fixer 2026-10-20, field: 다용도실 아래 3977 and 방1 위
  // 3969 both run from the x = 0 to the x = 4200 wall line, but the corner-to-corner wall cuts them at
  // different places, 75..4052 against 181..4150; 3977 was never printed. Two equal values still show
  // once, as in a plan without diagonal walls).
  const sameSpan = (x, d) => sameLineSpan(x, d)
    && (!(x.diagonalEnd || d.diagonalEnd) || Math.abs(x.value - d.value) < 1
      || (Math.abs(x.a - d.a) < FACE_SPAN_MM && Math.abs(x.b - d.b) < FACE_SPAN_MM));
  for (const d of dims) {
    if (done.has(d)) continue;
    const group = dims.filter((x) => sameSpan(x, d));
    group.forEach((x) => done.add(x));
    if (group.length < 2) continue;
    const hasExterior = group.some((x) => x.exterior);
    const hide = (x, by, reason) => {
      if (!out.has(x)) return;
      out.delete(x);
      hidden.push({ key: x.key, measureIds: x.measureIds, value: x.value, reason, by: by ? by.measureIds : [] });
    };
    if (hasExterior) for (const x of group) if (!x.exterior) hide(x, group.find((y) => y.exterior), 'covered');
    // An outer side whose chain lies past a room built onto its wall: on the other chain when the same
    // span with the same value is printed there (it is then that one, see runCandidate).
    for (const x of group) {
      if (x.sideOver && out.has(x) && group.some((y) => y !== x && out.has(y) && y.side === x.sideOver && Math.abs(y.value - x.value) < 1)) x.side = x.sideOver;
    }
    for (const side of DIM_SIDES) {
      const onSide = group.filter((x) => out.has(x) && x.side === side);
      if (onSide.length < 2) continue;
      onSide.sort((p, q) => (q.exterior - p.exterior) || (distToChain(p, bounds) - distToChain(q, bounds)) || (q.value - p.value));
      for (const x of onSide.slice(1)) hide(x, onSide[0], 'covered');
    }
  }
  return dims.filter((d) => out.has(d));
}

// Rule 6: '?' slots for exterior sides without a value.
function unknownDims(project, derived, roomById, nodes, edges, bounds, shown) {
  const out = [];
  for (const w of derived.warnings || []) {
    if (w.type !== 'unmeasured') continue;
    const dr = roomById.get(w.roomId);
    if (!dr || (dr.room && dr.room.notRoom)) continue;
    const c = sideCandidate(w.roomId, w.sideKey, roomById, project, derived, nodes, edges, bounds);
    if (!c || !c.exterior) continue;
    const len = c.b - c.a;
    const covered = shown.concat(out).some((d) => d.side === c.side && overlap(d, c) > 0.5 * len);
    if (covered) continue;
    out.push({
      key: `unknown:${w.roomId}:${w.sideKey}`, measureIds: [], roomIds: [w.roomId], value: null, alt: null, note: false,
      axis: c.axis, a: c.a, b: c.b, line: c.line, lineSpan: c.lineSpan, exterior: true, side: c.side,
      override: null, text: '?', extFrom: [], unknown: true,
    });
  }
  return out;
}

function overlap(p, q) {
  return Math.min(p.b, q.b) - Math.max(p.a, q.a);
}

// Neighbours in a row that overlap a little (side by side, see TOUCH_MM) are DRAWN meeting at the
// middle of the overlap, so their arrows touch at one point instead of crossing; a and b (the exact
// span, the printed number) stay as they are. Every dimension gets drawA / drawB.
function meetNeighbours(row) {
  for (const d of row) { d.drawA = d.a; d.drawB = d.b; }
  for (let i = 1; i < row.length; i++) {
    const p = row[i - 1], q = row[i];
    const ov = p.b - q.a;
    if (ov > 0 && !spansOverlap(p, q)) {
      const m = (p.b + q.a) / 2;
      p.drawB = Math.min(p.drawB, m);
      q.drawA = Math.max(q.drawA, m);
    }
  }
}

// True when two spans on one chain need different rows (see TOUCH_MM).
export function spansOverlap(p, q) {
  const shorter = Math.min(p.b - p.a, q.b - q.a);
  return overlap(p, q) > Math.max(1, Math.min(TOUCH_MM, TOUCH_FRACTION * shorter));
}

// Overall dimension (plan §1-2 "전체 치수"): a measured span that reaches across (nearly) the whole plan
// and contains at least two other spans of its chain, like 예시 세대 B 4520 over 1250 · 3160.
const OVERALL_FRACTION = 0.85;
function isOverall(d, list, extent) {
  if (!(extent > 0) || d.b - d.a < OVERALL_FRACTION * extent) return false;
  const inside = list.filter((x) => x !== d && x.a >= d.a - TOUCH_MM && x.b <= d.b + TOUCH_MM && x.b - x.a < d.b - d.a);
  return inside.length >= 2;
}

// Rule 4. → rows (rows[0] is next to the plan), each sorted by position.
//   list: dims of one chain; each may carry `depth` (distance of its wall line from the plan's outer
//         edge on this chain's side, mm). opts.extent: the plan's size along the chain (mm).
// Rows are filled from the OUTSIDE in, in this order:
//   1. overall dimensions (예시 세대 B 4520) — always the outermost row;
//   2. then by depth: the side nearest the chain is further out (예시 세대 A top: 1100 · 1550 · 2800 · 2600 on
//      the outer row, 방3 2800 · 400 · 2160 on the inner row; plan §1-2 and answer key §4);
//   3. equal depth: the longer span further out (예시 세대 B: 1250 · 3160 inside 4520).
// Each span goes inside every span already placed that it overlaps; spans that do not overlap share a
// row. A chain whose stacks have different heights puts the single spans on the outer row (예시 세대 A 주방
// 2800 shares the outer row with 1100 · 1550 · 2600). Manual rows (override.row, counted from the plan)
// are kept as they are.
export function assignRows(list, opts = {}) {
  const fixed = list.filter((d) => d.override && Number.isInteger(d.override.row) && d.override.row >= 0);
  const auto = list.filter((d) => !fixed.includes(d));
  const depth = (d) => (isNum(d.depth) ? Math.round(d.depth) : 0);
  const overall = new Set(auto.filter((d) => isOverall(d, list, opts.extent)));
  auto.sort((p, q) => (overall.has(q) - overall.has(p)) || depth(p) - depth(q)
    || (q.b - q.a) - (p.b - p.a) || p.a - q.a);
  const placed = [];
  for (const d of auto) {
    // Outer index: 0 = outermost row.
    let outer = 0;
    for (const x of placed) if (spansOverlap(x, d)) outer = Math.max(outer, x.outer + 1);
    d.outer = outer;
    placed.push(d);
  }
  const autoRows = placed.length ? Math.max(...placed.map((d) => d.outer)) + 1 : 0;
  for (const d of placed) { d.row = autoRows - 1 - d.outer; delete d.outer; }
  let rows = [];
  const put = (d) => {
    while (rows.length <= d.row) rows.push([]);
    rows[d.row].push(d);
  };
  for (const d of placed) put(d);
  // A row picked by hand is kept while it is free there; when the plan changed since (a new value now
  // lies on that row), the number goes one row further out instead of being drawn over another one.
  for (const d of fixed.slice().sort((p, q) => p.override.row - q.override.row || p.a - q.a)) {
    d.row = d.override.row;
    while (rows[d.row] && rows[d.row].some((x) => spansOverlap(x, d))) d.row++;
    put(d);
  }
  // No empty row between the plan and a number (a hand-picked row past an empty one closes up).
  rows = rows.filter((r) => r.length);
  rows.forEach((r, i) => { for (const d of r) d.row = i; });
  for (const r of rows) r.sort((p, q) => p.a - q.a);
  return rows;
}

// Where the numbers of one row go (placeChainTexts below, for every row of every chain: shared by
// draw-dims.js, printlayout.js and the aligned dimensions' chainObstacles).
//   row: dims of one row; k: drawing units per world mm; textWidth(dim) → drawing units;
//   arrow: arrow length, gap: clearance, both in drawing units; obstacles: { outer, flip } — [[lo, hi]]
//   (drawing units along the axis) taken already on this row's number band on the outer side of the line /
//   on its plan side (the numbers the other chains put past the plan's corners, placeChainTexts).
// A number goes between the arrows when it fits; otherwise beside the span (after it, else before it),
// where it does not run into a neighbour's number; then just past the number that blocks that slot,
// if that stays close to the span; then (allowFlip: the row next to the plan, where the band between
// the wall and the line is free) centred on the plan side of the line; then over its own span (moved along
// it to be clear of the numbers beside it, still over its span's middle); as the last resort the slot
// that overlaps the other numbers least (two short spans in a row, e.g. two 100 mm steps).
// → Map dim → { mode: 'inside' | 'after' | 'before' | 'center' | 'flip', center (world coordinate along
//               the axis), half (half text width in world mm) }   ('flip' = on the plan side of the line)
const WALL_BETWEEN_MM = 160; // placeRowTexts: two spans this far apart (world mm) are side by side
// placeRowTexts: the least clearance (share of `gap`) at which two numbers kept in order still read apart.
export const SNUG_GAP = 0.8;
export function placeRowTexts(row, { k, textWidth, arrow, gap, allowFlip = false, obstacles = null, keepOrder = false }) {
  const items = row.map((d) => ({ d, a: d.a * k, b: d.b * k, w: textWidth(d) })).sort((p, q) => p.a - q.a);
  const boxes = [];      // numbers on the outer side of the line
  const flipped = [];    // numbers on the plan side
  // The other chains' numbers on this row's bands (placeChainTexts): kept clear of like this row's own. They
  // lie past an end of the plan (past a corner), so a number never jumps past one of them (see jump).
  const isSpan = (x) => Array.isArray(x) && isNum(x[0]) && isNum(x[1]) && x[1] > x[0];
  const other = (x) => Object.assign([x[0], x[1]], { other: true });
  if (obstacles) {
    for (const x of obstacles.outer || []) if (isSpan(x)) boxes.push(other(x));
    for (const x of obstacles.flip || []) if (isSpan(x)) flipped.push(other(x));
  }
  const res = new Map();
  const put = (it, mode, c) => {
    (mode === 'flip' ? flipped : boxes).push([c - it.w / 2, c + it.w / 2]);
    res.set(it.d, { mode, center: c / k, half: it.w / 2 / k });
  };
  const pending = [];
  for (const it of items) {
    if (it.w <= it.b - it.a) put(it, 'inside', (it.a + it.b) / 2);
    else pending.push(it);
  }
  // (1e-9: a slot just past a number, at exactly `gap` from it, is clear of it; in floating point it came
  // out a hair inside, and the search for the next slot stood still on it.)
  const clearOf = (lo, hi, [p, q]) => hi + gap <= p + 1e-9 || lo - gap >= q - 1e-9;
  const freeIn = (list, lo, hi) => list.every((box) => clearOf(lo, hi, box));
  const free = (lo, hi) => freeIn(boxes, lo, hi);
  const overlapOf = (lo, hi) => boxes.reduce((s, [p, q]) => s + Math.max(0, Math.min(hi + gap, q) - Math.max(lo - gap, p)), 0);
  // The numbers keep the order of their spans (final review 2026-10-28, D1 at 1:150: two short spans side
  // by side, 다용도실 1100 | 보일러실 1200, each wrote its number beside the OTHER span, so they read
  // swapped; 드레스룸 1500 was written left of 안방's 4300). A number beside its span stays between the
  // numbers of its neighbours on the row (a placed one is a bound); of two short spans side by side the
  // first writes its number before, the second after.
  const idx = new Map(items.map((it, i) => [it, i]));
  const isPending = new Set(pending);
  // Side by side: touching, or with a wall between them (round 2, 2026-10-31: two short spans either side
  // of a 100 mm wall are 1.3 mm apart at 1:75, and the rule did not hold for them).
  const touching = (p, q) => q.a - p.b <= gap + WALL_BETWEEN_MM * k + 1e-9;
  const placedAt = (it) => (res.has(it.d) ? res.get(it.d).center * k : null);
  for (const it of pending) {
    const i = idx.get(it);
    const prev = i > 0 ? items[i - 1] : null, next = i + 1 < items.length ? items[i + 1] : null;
    const prevC = prev ? placedAt(prev) : null, nextC = next ? placedAt(next) : null;
    const nextWaits = !!(next && isPending.has(next) && !res.has(next.d) && touching(it, next));
    const inOrder = (c) => (prevC == null || c > prevC) && (nextC == null || c < nextC);
    const half = it.w / 2;
    const out = it.b - it.a < 2 * arrow ? arrow : 0; // arrows drawn outside a very short span
    const after = it.b + out + gap + half;
    const before = it.a - out - gap - half;
    const cands = nextWaits ? [['before', before], ['after', after]] : [['after', after], ['before', before]];
    // The first free slot from c on in direction dir, just past the numbers blocking each slot tried (at most
    // `tries` slots), or null. Never past another chain's number: that is past a corner of the plan, away from
    // the span (final review round 4, E4 / A5 at 1:150: a short end span's number was pushed past the top
    // chain's number into the corner, 10 mm from its span; it goes on the plan side of its line instead).
    const jump = (c, dir, tries) => {
      for (let n = 0; n < tries && c != null; n++) {
        const blockers = boxes.filter((box) => !clearOf(c - half, c + half, box));
        if (!blockers.length) return c;
        if (blockers.some((box) => box.other)) return null;
        c = dir > 0 ? Math.max(...blockers.map((x) => x[1])) + gap + half : Math.min(...blockers.map((x) => x[0])) - gap - half;
      }
      return null;
    };
    // Just past the numbers blocking a slot, while the number stays within ~1.5 widths of its span.
    const reach = 1.5 * it.w + out + gap;
    const past = (c, dir) => jump(c, dir, 4);
    const pa = past(after, 1), pb = past(before, -1);
    const pastCands = [];
    if (pa != null && pa - half - it.b <= reach) pastCands.push(['after', pa]);
    if (pb != null && it.a - (pb + half) <= reach) pastCands.push(['before', pb]);
    if (nextWaits) pastCands.reverse();
    cands.push(...pastCands);
    // The slot after a short span whose right neighbour's number waits too belongs to that neighbour.
    const ok = (m, c) => free(c - half, c + half) && inOrder(c) && !(nextWaits && m === 'after' && c + half > next.a);
    const hit = cands.find(([m, c]) => ok(m, c));
    if (hit) { put(it, hit[0], hit[1]); continue; }
    const mid = (it.a + it.b) / 2;
    if (allowFlip && freeIn(flipped, mid - half, mid + half)) { put(it, 'flip', mid); continue; }
    // Further away is still better than two numbers printed over each other.
    const far = [['after', pa, pa != null ? pa - half - it.b : Infinity], ['before', pb, pb != null ? it.a - (pb + half) : Infinity]]
      .filter(([m, c, dist]) => c != null && isFinite(dist) && ok(m, c))
      .sort((p, q) => p[2] - q[2])[0];
    if (far) { put(it, far[0], far[1]); continue; }
    // In order a little farther: up to 3 widths past the blocking numbers, the slot after a span whose
    // neighbour waits included (that neighbour then goes past it).
    const wide = (c, dir) => jump(c, dir, 8);
    const wa = wide(after, 1), wb = wide(before, -1);
    const farther = [['after', wa, wa != null ? wa - half - it.b : Infinity], ['before', wb, wb != null ? it.a - (wb + half) : Infinity]]
      .filter(([, c, dist]) => c != null && dist <= 2 * reach && free(c - half, c + half) && inOrder(c))
      .sort((p, q) => p[2] - q[2])[0];
    // Over its own span, wider than it: centred where nothing else is, else moved along the span just clear
    // of the numbers beside it (`clear` from them), in order, as long as it still covers the span's middle
    // (final review round 4, A1 at 1:150: '1100' fitted between the 3175 and the 2450 beside it 0.65 mm off
    // its middle; only the fixed slots were tried, and it was written after the 2450, over the 1500's span,
    // out of order). → centre (drawing units) | undefined
    const overOwn = (clear) => [mid, ...boxes.flatMap(([p, q]) => [p - clear - half, q + clear + half])]
      .filter((c) => Math.abs(c - mid) <= half + 1e-9 && inOrder(c)
        && boxes.every(([p, q]) => c + half + clear <= p + 1e-9 || c - half - clear >= q - 1e-9))
      .sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))[0];
    const own = overOwn(gap);
    // The slot after this span over the span of a neighbour whose number waits (that number then goes past
    // it) only when this number has no place over its own span: else it read as the neighbour's (A1 at 1:150:
    // '1500' over the 1575's span, the 1575 past the end of the chain; since 0.6.8).
    const takesNext = (m, c) => nextWaits && m === 'after' && c + half > next.a;
    if (farther && !(own != null && takesNext(farther[0], farther[1]))) { put(it, farther[0], farther[1]); continue; }
    if (own != null) { put(it, 'center', own); continue; }
    // No free spot keeps the order: a free one that does not is still better than numbers printed over
    // each other (two 100 mm spans between two long ones on an outer row at 1:60), the nearest, however far
    // past the blocking numbers (round 2, 2026-10-31: only the near slots were tried, and 185 | 150 of
    // 1275 | 185 | 150 | 2890 | 420 at 1:75 were printed 4 mm over each other; 0.6.8 never did).
    const scan = (c, dir) => jump(c, dir, 64);
    const dist = (c) => (c >= mid ? c - half - it.b : it.a - (c + half));
    // In order, the numbers apart though closer than `gap` (D1 at 1:150: 1500 over its own span 0.85 mm
    // from the 2300 beside it) is better than out of order, down to SNUG_GAP of it: closer, two numbers read
    // as one ('1405' and '1940' 0.33 paper mm apart at 1:150 read '14051940', '1140 195 960' at 1:75 read
    // '1140195960'; final review round 3), and a free slot out of order (anyFree, below) is better.
    const snug = (c) => c != null && boxes.every(([p, q]) => c + half + SNUG_GAP * gap <= p + 1e-9 || c - half - SNUG_GAP * gap >= q - 1e-9);
    const inOrderSnug = [['center', mid], ...cands, ['after', wa], ['before', wb], ['center', overOwn(SNUG_GAP * gap)]]
      .filter(([, c]) => snug(c) && inOrder(c))
      .sort((p, q) => Math.max(0, dist(p[1])) - Math.max(0, dist(q[1])))[0];
    if (inOrderSnug) { put(it, inOrderSnug[0], inOrderSnug[1]); continue; }
    const anyFree = [...cands, ['center', mid], ['after', scan(after, 1)], ['before', scan(before, -1)]]
      .filter(([, c]) => c != null && free(c - half, c + half))
      .sort((p, q) => Math.max(0, dist(p[1])) - Math.max(0, dist(q[1])))[0];
    if (anyFree) { put(it, anyFree[0], anyFree[1]); continue; }
    const last = [['center', mid], ['after', after], ['before', before]]
      .map(([m, c]) => ({ m, c, o: overlapOf(c - half, c + half) }))
      .sort((p, q) => p.o - q.o)[0];
    put(it, last.m, last.c);
  }
  if (keepOrder) putRowInOrder(items, res, k, gap, boxes.filter((box) => box.other));
  return res;
}

// placeRowTexts with keepOrder (the chains of a separately drawn part on paper, printlayout.js separateParts): a row whose
// numbers still do not read in the order of their spans (no number had a free spot between its neighbours; question 8: D1
// 1층's own right chain at 1:150, 3000 | 1200 | 2270 | 1800 | 1200) is laid out again in that order, each number as near the
// middle of its span as the others let it (the least squares: neighbours pooled while they would cross), unless that runs
// into a number of another chain (others). Every other row stays where it is: a plan of one part prints as it always has,
// and zoomed out on the screen every row is out of order. items: placeRowTexts's; res: its result, changed in place. → nothing
function putRowInOrder(items, res, k, gap, others) {
  const row = items.filter((it) => res.get(it.d).mode !== 'flip');
  const placedAt = (it) => res.get(it.d).center * k;
  if (row.every((it, i) => i === 0 || placedAt(row[i - 1]) < placedAt(it))) return;
  const before = [0];   // the room the numbers before each one take
  for (let i = 1; i < row.length; i++) before.push(before[i - 1] + (row[i - 1].w + row[i].w) / 2 + gap);
  const pools = [];
  row.forEach((it, i) => {
    let pool = { sum: (it.a + it.b) / 2 - before[i], n: 1 };
    while (pools.length && pools[pools.length - 1].sum / pools[pools.length - 1].n >= pool.sum / pool.n) {
      const q = pools.pop();
      pool = { sum: q.sum + pool.sum, n: q.n + pool.n };
    }
    pools.push(pool);
  });
  const centres = pools.flatMap((pool) => Array(pool.n).fill(pool.sum / pool.n)).map((c, i) => c + before[i]);
  const clear = (c, half) => others.every(([p, q]) => c + half + gap <= p + 1e-9 || c - half - gap >= q - 1e-9);
  if (!row.every((it, i) => clear(centres[i], it.w / 2))) return;
  row.forEach((it, i) => {
    const moved = Math.abs(centres[i] - placedAt(it)) > 1e-6;
    if (moved) res.set(it.d, { mode: 'center', center: centres[i] / k, half: it.w / 2 / k });
  });
}

// placeChainTexts: how far (share of the number height) another chain's number may reach into a row's number band
// before it holds that row's numbers off (the digits of the output font leave 10–13 % of their box free at the top
// and bottom, 4 % at the ends; the screen's 7–19 %).
export const CORNER_TOUCH = 0.1;

// Where the numbers of every row of every chain go (shared by draw-dims.js, printlayout.js and chainObstacles):
// placeRowTexts row by row, the chains in order (top, right, bottom, left), each row clear of the numbers the
// chains before it put on its number bands: past a corner of the plan a number written beside a short end span
// reaches into the other chain's rows (final review round 4, 1:150: E1's bottom '1500' after its span and the
// right chain's '1700' after its span met past the bottom-right corner, 12 mm² over each other; E4's top '1800'
// and left '1500' before theirs at the top-left corner). Coordinates: drawing units = world mm × k.
//   res: buildDimensions result; opts: { k, textWidth(dim) → drawing units, arrow, gap (as placeRowTexts),
//   first: { top, right, bottom, left } (each side's first row from the plan's outer face; a missing one:
//   firstDefault), row (between rows), textGap (line → number), text (number height), allowFlip(rowIndex)
//   (default: the row next to the plan), keepOrder (placeRowTexts: only for a separately drawn part on paper) }, all in drawing units.
// → Map dim → { mode, center, half } (placeRowTexts)
export function placeChainTexts(res, opts = {}) {
  const out = new Map();
  const b = res && res.bounds;
  if (!b || !(opts.k > 0)) return out;
  const { k, textWidth, arrow, gap } = opts;
  const step = opts.row || 0, textGap = opts.textGap || 0, text = opts.text || 0;
  const allowFlip = typeof opts.allowFlip === 'function' ? opts.allowFlip : (r) => r === 0;
  const taken = [];   // numbers placed so far: { side, x0, x1, y0, y1 } (drawing units)
  for (const chain of res.chains || []) {
    const side = chain.side, sign = side === 'top' || side === 'left' ? -1 : 1;
    const horizontal = side === 'top' || side === 'bottom';
    const face = (side === 'top' ? b.minY : side === 'bottom' ? b.maxY : side === 'left' ? b.minX : b.maxX) * k;
    const first = opts.first && opts.first[side] > 0 ? opts.first[side] : (opts.firstDefault || 0);
    chain.rows.forEach((row, r) => {
      const s = face + sign * (first + r * step);
      // The band a number takes across the chain: outside the line (dir 1) or on its plan side (dir −1).
      const band = (dir) => { const p = s + dir * sign * textGap, q = s + dir * sign * (textGap + text); return [Math.min(p, q), Math.max(p, q)]; };
      const outer = band(1), flip = band(-1);
      const across = (t) => (horizontal ? [t.y0, t.y1] : [t.x0, t.x1]);
      const along = (t) => (horizontal ? [t.x0, t.x1] : [t.y0, t.y1]);
      // (Only a number that reaches into the band by more than CORNER_TOUCH of the number height: two numbers of
      // a corner diagonal to each other whose boxes just touch there do not touch with their digits, which keep
      // about that much of the box free at the top and bottom (HEO at 1:150: the right chain's '750' 0.4 mm into
      // the bottom row's band beside its '700', as since 0.6.8). Along the row it keeps `gap` from those it holds off.)
      const touch = CORNER_TOUCH * text;
      const on = (bd) => taken.filter((t) => {
        if (t.side === side) return false;
        const [p, q] = across(t);
        return Math.min(q, bd[1]) - Math.max(p, bd[0]) > touch + 1e-9;
      }).map(along);
      const flipOk = !!allowFlip(r);
      const placed = placeRowTexts(row, { k, textWidth, arrow, gap, allowFlip: flipOk, obstacles: { outer: on(outer), flip: flipOk ? on(flip) : [] }, keepOrder: !!opts.keepOrder });
      for (const [d, tp] of placed) {
        out.set(d, tp);
        const c = tp.center * k, h = tp.half * k, bd = tp.mode === 'flip' ? flip : outer;
        taken.push(horizontal ? { side, x0: c - h, x1: c + h, y0: bd[0], y1: bd[1] } : { side, x0: bd[0], x1: bd[1], y0: c - h, y1: c + h });
      }
    });
  }
  return out;
}

// ---- aligned dimensions of diagonal sides (rule 7) ------------------------------------------------

// A text angle along unit direction u that never reads upside down (radians, y down: (−π/2, π/2]).
export function uprightAngle(u) {
  let a = Math.atan2(u.y, u.x);
  if (a > Math.PI / 2 + 1e-9) a -= Math.PI;
  else if (a <= -Math.PI / 2 + 1e-9) a += Math.PI;
  return a;
}

// The axis chains as the drawing lays them out (draw-dims.js layoutDimensions), in world mm: their
// dimension and extension lines as segments, their numbers as boxes (numbers moved by hand are left
// at their automatic place). wpu = world mm per drawing unit; S: sizes in drawing units; firsts: each
// side's first row (drawing units; printlayout.js chainFirstRows, past an outward door's swing), else S.first;
// keepOrder: placeRowTexts. → { segs: [{ p, q, kind: 'line' | 'ext', side (of 'line') }], boxes (with their side) }
export function chainObstacles(res, wpu, S, textWidth, firsts = null, keepOrder = false) {
  const b = res.bounds;
  const segs = [], boxes = [];
  if (!b) return { segs, boxes };
  const k = 1 / wpu;
  const texts = placeChainTexts(res, {
    k, textWidth, arrow: S.arrow, gap: S.clear, first: firsts, firstDefault: S.first, row: S.row, textGap: S.textGap, text: S.text, keepOrder,
  });
  for (const chain of res.chains || []) {
    const side = chain.side, sign = side === 'top' || side === 'left' ? -1 : 1;
    const horizontal = side === 'top' || side === 'bottom';
    const face = side === 'top' ? b.minY : side === 'bottom' ? b.maxY : side === 'left' ? b.minX : b.maxX;
    const P = (t, s) => (horizontal ? { x: t, y: s } : { x: s, y: t });
    const first = firsts && firsts[side] > 0 ? firsts[side] : S.first;
    chain.rows.forEach((row, r) => {
      const s = face + sign * (first + r * S.row) * wpu;
      for (const d of row) {
        const t1 = d.drawA != null ? d.drawA : d.a, t2 = d.drawB != null ? d.drawB : d.b;
        segs.push({ p: P(t1, s), q: P(t2, s), kind: 'line', side });
        (d.extFrom || []).forEach((pt, i) => {
          const f = horizontal ? pt.y : pt.x;
          const t = i === 0 ? t1 : t2;
          segs.push({ p: P(t, f + sign * S.extGap * wpu), q: P(t, s + sign * S.extOver * wpu), kind: 'ext' });
        });
        const tp = texts.get(d);
        if (!tp) continue;
        const c = s + (tp.mode === 'flip' ? -sign : sign) * (S.textGap + S.text / 2) * wpu, hh = (S.text / 2) * wpu;
        boxes.push(horizontal
          ? { minX: tp.center - tp.half, maxX: tp.center + tp.half, minY: c - hh, maxY: c + hh, side }
          : { minX: c - hh, maxX: c + hh, minY: tp.center - tp.half, maxY: tp.center + tp.half, side });
      }
    });
  }
  return { segs, boxes };
}

// Where the aligned dimensions go (shared by draw-dims.js and printlayout.js).
//   res: buildDimensions result; opts: { wpu (world mm per drawing unit), S: { first, row, textGap,
//   text, arrow, arrowHalf, extGap, extOver, clear } (drawing units, as draw-dims dimStyle),
//   textWidth(dim) → drawing units, walls: wallPolygons, obstacles: world polygons the numbers keep off
//   (printlayout.js dimObstacles: fixtures, door swings), firsts: { top, right, bottom, left } the axis
//   chains' first rows in drawing units where they differ from S.first (paper: printlayout.js chainFirstRows,
//   past an outward door's swing; final review round 3: the diagonal sides' numbers kept off the old 8 mm
//   row and could run into the real one), keepOrder: the chains' numbers as placeRowTexts then places them }
// Candidates, in order (the first that runs into nothing wins, else the one that runs into least):
//   outer wall: outside at chain row 0, 1, 2 (rows from the outer face, as the chains), then inside,
//     then (fixer 2026-10-20) outside half a row out, the number between the line and the wall, the
//     number past either end of the line, rows 3 and 4;
//   inner wall: inside the shown room, the number centred, a quarter along either way, one line further in.
// "Runs into": the chains' numbers, dimension and extension lines, the walls (a number on a wall band
// counts most), the obstacles, aligned dims placed before.
// → [{ dim, mode: 'out' | 'in', row, p1, p2 (world line ends), ext: [[p, q]] (world), text: { x, y
//      (world centre), angle (radians, upright), w, h (drawing units) }, textPoly (world corners),
//      linePoly (world: the line with its arrowheads), cost }]
export function layoutAlignedDims(res, opts = {}) {
  const list = (res && res.aligned) || [];
  if (!list.length || !opts.S || typeof opts.textWidth !== 'function') return [];
  const wpu = opts.wpu > 0 ? opts.wpu : 1;
  const S = opts.S;
  const chain = chainObstacles(res, wpu, S, opts.textWidth, opts.firsts || null, !!opts.keepOrder);
  const walls = (opts.walls || []).map((w) => w.points).filter((p) => Array.isArray(p) && p.length >= 3);
  const things = (opts.obstacles || []).filter((p) => Array.isArray(p) && p.length >= 3);
  const placed = [];
  const order = list.slice().sort((p, q) => (q.exterior - p.exterior) || String(p.key).localeCompare(String(q.key)));
  for (const d of order) {
    let best = null;
    for (const c of alignedCandidates(d, wpu, S, opts.textWidth(d))) {
      c.cost = alignedCost(c, chain, walls, placed, wpu, S, things);
      if (!best || c.cost < best.cost - 1e-9) best = c;
      if (c.cost === 0) break;
    }
    if (best) placed.push(best);
  }
  return placed;
}

function alignedCandidates(d, wpu, S, textUnits) {
  const { A, B, dir: u, inward: n } = d;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const angle = uprightAngle(u);
  const tw = textUnits * wpu, th = S.text * wpu;
  const at = (P, k) => ({ x: P.x + n.x * k, y: P.y + n.y * k });
  const mk = (mode, row, off, textSign, shift = 0, further = 0) => {
    // off: the line's distance from the inner face along the room's inward normal (< 0: outside).
    const p1 = at(A, off), p2 = at(B, off);
    const tOff = off + textSign * ((S.textGap + S.text / 2) * wpu + further);
    const mid = { x: (A.x + B.x) / 2 + u.x * shift, y: (A.y + B.y) / 2 + u.y * shift };
    const c = at(mid, tOff);
    const ext = mode === 'out'
      ? [A, B].map((P) => [at(P, -(d.outerDepth + S.extGap * wpu)), at(P, off - S.extOver * wpu)])
      : [];
    return {
      dim: d, mode, row, p1, p2, ext,
      text: { x: c.x, y: c.y, angle, w: textUnits, h: S.text },
      textPoly: rotatedRect(c, angle, tw, th),
      linePoly: rotatedRect({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, Math.atan2(u.y, u.x), L, 2 * S.arrowHalf * wpu),
    };
  };
  const out = [];
  if (d.exterior) {
    for (let r = 0; r < 3; r++) out.push(mk('out', r, -(d.outerDepth + (S.first + r * S.row) * wpu), -1));
  }
  const hug = (S.arrowHalf + S.clear / 2) * wpu;
  out.push(mk('in', 0, hug, 1));
  if (L - 2 * S.arrow * wpu > tw + L / 2) out.push(mk('in', 0, hug, 1, L / 4), mk('in', 0, hug, 1, -L / 4));
  out.push(mk('in', 1, hug, 1, 0, th));
  // Fixer 2026-10-20 (field: a small bay's 739 went inside across the base wall and the door; 1518 onto
  // the 싱크대): further outside choices, tried after the ones above, for an outer wall whose rows run
  // into the chains: the line half a row out with the number outside it, the number between the line
  // and the wall (as a chain's first row may put it), and the number past either end of the line.
  if (d.exterior) {
    const near = -(d.outerDepth + (S.first / 2) * wpu);
    out.push(mk('out', 0, near, -1));
    const row0 = -(d.outerDepth + S.first * wpu);
    if ((S.first - S.extGap) * wpu >= th + 2 * S.textGap * wpu) out.push(mk('out', 0, row0, 1));
    const past = L / 2 + tw / 2 + (S.arrow + S.clear) * wpu;
    for (const off of [row0, near]) out.push(mk('out', 0, off, 0, past), mk('out', 0, off, 0, -past));
    for (let r = 3; r < 5; r++) out.push(mk('out', r, -(d.outerDepth + (S.first + r * S.row) * wpu), -1));
  }
  return out;
}

// How much candidate c runs into other things (0 = nothing). things: polygons (world) of what the
// drawing puts in the rooms that no number may cover (fixtures, door swings; opts.obstacles).
function alignedCost(c, chain, walls, placed, wpu, S, things = []) {
  const pad = S.clear * wpu;
  let cost = 0;
  const T = c.textPoly, Lp = c.linePoly;
  const ext = c.ext.map(([p, q]) => [p, q]);
  for (const b of chain.boxes) {
    const bp = boxPoints(b);
    if (convexOverlap(T, bp, pad)) cost += 10;
    if (convexOverlap(Lp, bp, pad)) cost += 10;
    for (const s of ext) if (convexOverlap(s, bp, pad)) cost += 6;
  }
  for (const s of chain.segs) {
    const seg = [s.p, s.q];
    const w = s.kind === 'line' ? 1 : 0.5;
    if (convexOverlap(T, seg, pad)) cost += 10 * w;
    if (convexOverlap(Lp, seg, 0)) cost += 6 * w;
    for (const e of ext) if (convexOverlap(e, seg, 0)) cost += 3 * w;
  }
  for (const W of walls) {
    // A number on a black wall band cannot be read (the bay's 739 across its base wall).
    if (convexOverlap(T, W, pad)) cost += 20;
    if (c.mode === 'out') {
      if (convexOverlap(Lp, W, 0)) cost += 8;
      for (const e of ext) if (convexOverlap(e, W, 0)) cost += 2;
    }
  }
  for (const O of things) {
    if (convexOverlap(T, O, pad)) cost += 12;
    if (convexOverlap(Lp, O, 0)) cost += 2;
  }
  for (const o of placed) {
    if (convexOverlap(T, o.textPoly, pad)) cost += 10;
    if (convexOverlap(T, o.linePoly, pad) || convexOverlap(Lp, o.textPoly, pad)) cost += 6;
    if (convexOverlap(Lp, o.linePoly, 0)) cost += 4;
  }
  return cost;
}

// ---- store mixin ---------------------------------------------------------------------------------

// Adds the stage C layout commands to DocStore.prototype (one undo step each, no re-derive: they change
// only how the drawing is laid out, not the geometry):
//   store.setDimOverride(measureId, { side?, row?, show? } | null)   manual chain side / row / shown value
//   store.setLabelOffset(key, { dx, dy } | null)                     label offset in PAPER mm
//   store.resetOutputLayout()                                         clears both
export function installDims(DocStore) {
  const proto = DocStore.prototype;
  proto.setDimOverride = function setDimOverride(measureId, patch) {
    return this._commit('setDimOverride', (p) => {
      const list = (p.dimOverrides || []).filter((o) => o && o.measureId !== measureId);
      const old = (p.dimOverrides || []).find((o) => o && o.measureId === measureId) || null;
      if (patch == null) return old ? { ...p, dimOverrides: list } : null;
      const next = { ...(old || {}), measureId };
      for (const k of ['side', 'row', 'show']) {
        if (!(k in patch)) continue;
        if (patch[k] == null) delete next[k];
        else next[k] = patch[k];
      }
      if (next.side != null && !DIM_SIDES.includes(next.side)) return null;
      if (next.row != null && !(Number.isInteger(next.row) && next.row >= 0)) return null;
      return { ...p, dimOverrides: [...list, next] };
    }, { rederive: false, detail: { measureId } });
  };
  proto.setLabelOffset = function setLabelOffset(key, offset) {
    return this._commit('setLabelOffset', (p) => {
      const cur = p.labelOffsets || {};
      if (offset == null) {
        if (!(key in cur)) return null;
        const next = { ...cur };
        delete next[key];
        return { ...p, labelOffsets: next };
      }
      const dx = Number(offset.dx) || 0, dy = Number(offset.dy) || 0;
      return { ...p, labelOffsets: { ...cur, [key]: { dx, dy } } };
    }, { rederive: false, detail: { key } });
  };
  proto.resetOutputLayout = function resetOutputLayout() {
    return this._commit('resetOutputLayout', (p) => {
      const has = (p.dimOverrides || []).length || Object.keys(p.labelOffsets || {}).length;
      return has ? { ...p, dimOverrides: [], labelOffsets: {} } : null;
    }, { rederive: false });
  };
}
