// Layout solver (DESIGN.md §3.5, plan §5). Pure: reads the project, returns new positions and the
// effective wall thickness / finish values. Weighted linear least squares, x and y solved separately.
//
// Unknowns per axis system (x shown; y is symmetric with h/v swapped):
//   X_g   one per x-group (nodes joined by 'v' edges share x)
//   t_e   thickness of each 'v' wall that touches a measured 'h' side (prior: measured or default)
//   f_rs  finish of room r on its 'v' side s next to a measured side (prior 0)
// Rows:
//   measured side (weight W):  value = |B−A| + s_B − s_A
//     A, B = corners, d = unit A→B. Every wall's inner face is its centre line moved into the room by
//     o = t/2 + f (half the thickness of the wall edge touching that corner, plus the room's finish on
//     that side). The inner corner at A is where the measured side's inner line meets the adjacent
//     side's inner line; it lies s_A along d from A (see cornerCoeffs):
//       s = (o_adj − (n_side·n_adj)·o_side) / (d·n_adj)
//     At a right-angle corner this is ±o_adj, which gives the rectangle reduction
//     "centre − t_A/2 − t_B/2 − f_A − f_B" (DESIGN.md §3.5). At a corner with a diagonal wall the
//     coefficients depend on the diagonal's angle, which the solve itself changes, so the solve is
//     repeated with the angles of the previous pass until the geometry settles (MAX_ANGLE_PASSES).
//   priors (weight 1/mm²):     t_e = prior, f = 0
//   sketch (weight 1e-2):      coord_b − coord_a = scale × sketch component, for every edge
//   gauge (weight 1e-6):       X_g = its current value
//   order (weight 1e6, HARD, added only when needed): an h/v edge may not collapse or flip against its
//     sketch direction; it keeps at least min(50 mm, half its sketched length). Without this,
//     contradictory measures could fold the plan over itself. It is stronger than the measures (the
//     예시 세대 A test of 2026-10-18: at the measures' own weight a value 300 mm off split the fold three ways,
//     the wall stub flipped and two rooms merged), so the walls and finishes take a contradiction, and
//     what they cannot take stays in the values (residual).
//   opening (weight 1e6, HARD, added only when needed): a window / door with a TYPED width (o.width)
//     on a wall piece that no measure fixes keeps that piece long enough for it (width + the walls it
//     meets at both ends + 2 × OPENING_JAMB_MM), once a value gives the plan its scale. Only
//     coordinates no measure ties together may move for it, and only as far as the drawing leaves
//     room: a bound that would move measured walls or values, or press another wall piece below half
//     its drawn length, is dropped again (the check then says the window is wider than its wall).
//     Drawn-only widths (drawWidth, the 1200 / 900 defaults) bound nothing: nobody measured them.
//   bounds (weight 1e8, added only when needed, like the order rows): finish ≥ 0 and assumed wall
//     thickness ≥ MIN_WALL_MM, so that what is drawn (walls, plus positive finishes drawn as part of
//     the wall) is what the dimensions measure.
// The one-sided rows (order, opening, bounds) form an active set: a row is added when its edge or
// variable is below its minimum. An order / opening row is released again when the solve pulls its edge
// above the minimum (a stub held in an early round is not held for good). A bound pin stays: releasing
// pins too (2026-10-18) gave another least-squares point for the correct 예시 세대 A plan (finishes moved up to
// 26 mm), and the documented plan is the reference.
// What an active order row cost is measured without the sketch rows ("hard-only" solves: measures,
// priors, finishes and the active rows, with the gauge at the solution): if the hard rows push against
// it, the measures contradict the drawn order (a 'conflict', or a 'fold' when the values would put the
// edge further back than its drawn length); if nothing but the sketch pushes, only coordinates no
// measure fixes were placed by the drawn order (a 'gap', DESIGN.md contract C3).
// Measured diagonal sides (contract C2, 2026-10-19 "대각선으로도 그릴 수 있게"): a diagonal wall keeps its
// drawn angle until values decide it, never a snapped 45°. Which coordinate groups the AXIS values tie
// together (measured h sides / spans tie x-groups, v ones y-groups, through chains) is found first; then,
// for each measured diagonal side (or span of diagonal parts) from corner A to corner B:
//   both projections tied   → a check only (its residual is reported, nothing moves);
//   exactly one tied        → one measure row in the other axis: inner projection = ±√(value² − fixed²),
//                             the fixed inner projection and the corner offsets (inner − centre length
//                             along the side) taken from the previous pass, so the angle passes iterate
//                             it; the sign is the current direction's. A value not longer than the fixed
//                             projection adds no row (the residual says the values disagree);
//   neither tied            → x and y are solved in ONE system (solveAxes(['x', 'y'])) with a length row
//                             d·(B − A) = value − δ over both axes, d the current direction, linearized
//                             again each pass: only the length is held, so the sketch keeps the drawn
//                             angle until other values decide it (a bay's two diagonals turn until the
//                             bay closes). Without such a value the two axes stay apart as before.
// These rows tie their groups like measured sides (opening bounds, the values a fold / conflict names).
// Their scale ratios count only when no axis value exists (a diagonal typed first scales the plan).
// Straight diagonal walls: a corner where one diagonal stroke was split (another wall meets it) is held
// on the line through its neighbours (straightDiagonalJoints, jointRows), else values bend the wall
// there, the room's side splits in two and its value comes loose.
// A measured SPAN (a side cut by 구역 나누기 dividers, DESIGN.md §7.7) is one measured-side row from the
// first part's start corner to the last part's end corner (dividers have no thickness).

import { EPS } from './geom.js';
import { measureSideKey } from './rooms.js';

export const SOLVER_WEIGHTS = Object.freeze({
  measure: 1e4,
  thicknessDefault: 1,
  // An outer wall that grows also pushes the house outline out (a bump in the facade, a larger print);
  // its room side is better moved by a finish, which keeps the outside straight.
  thicknessExterior: 4,
  thicknessMeasured: 100, // a measured thickness is real; absorb differences in assumed walls first
  // A finish is a layer on ONE room's wall face (never negative, see MIN_WALL_MM). It is drawn as part
  // of the wall, so it is the assumed wall growing on that room's side only; that keeps the outside
  // outline straight where a thicker wall would bulge out. Wet rooms (tiles) take it first.
  // (Tried 3, 10 and 100 for dry rooms on 예시 세대 A: the facade walls then bulge to 200-270 mm.)
  finish: 1,
  finishWet: 0.1,         // wet rooms (화장실/욕실) have tiles: their finish absorbs differences first
  sketch: 1e-2,
  gauge: 1e-6,
  order: 1e6,             // hard (see "order" above): 100× the measures
  opening: 1e6,           // hard, like the order rows (see "opening" above)
  bound: 1e8,             // pins a finish / thickness at its bound (see "bounds" below)
});

const DEFAULT_SETTINGS = { extWall: 150, intWall: 100 };
const MIN_EDGE = 50;           // mm, see "order" rows above
// A window / door frame needs a little wall on both sides; it also covers the few mm the assumed walls
// at the ends may still grow after the bound was set.
export const OPENING_JAMB_MM = 50;
// Active set (weighted mm, i.e. weight × mm of the row): a one-sided row is released when the solve
// pulls its edge / variable above the minimum with more than RELEASE_FORCE; in a hard-only solve it
// counts as pushed by the measures / walls when its force exceeds REAL_FORCE (a wet-room finish, the
// softest hard row at 0.1 / mm², moving 0.1 mm). Both are far above the rounding of the dense solve.
const RELEASE_FORCE = 1e-3;
const REAL_FORCE = 1e-2;
const MAX_RESOLVES = 3;        // re-runs of the active set after dropping opening bounds that cannot hold
// An opening bound may not press another wall piece below this fraction of its drawn length.
const OPENING_SQUEEZE = 0.5;
// Bounds (plan §5-1 "각 실은 자기 안쪽 치수대로 그립니다", §5-3 "가정한 벽 두께에서 흡수"):
// a finish is a real layer on the room's wall face (tiles), so it is never negative (a negative one
// would put the inner face inside the drawn wall, and a ruler on the print would disagree with the
// number); an assumed wall is never thinner than MIN_WALL_MM (a 1 mm wall prints as a hairline). A
// difference the bounded walls cannot take stays in the measure and is reported as 'residual'.
export const MIN_WALL_MM = 50;
const MAX_ORDER_ROUNDS = 24;
const MAX_ANGLE_PASSES = 8;    // re-solves when a measured side meets a diagonal wall
// With rows from measured diagonal values the passes also settle the Pythagoras rows and the angles
// that other values decide (a bay's two diagonals turn until the bay closes).
const MAX_DIAGONAL_PASSES = 40;
const ANGLE_SETTLED_MM = 0.01; // stop when no node moved more than this between passes
// ... and with diagonal rows: the dense solve's own rounding (bound pins at 1e8 against the 1e-6
// gauge) moves nodes by a few hundredths of a mm from pass to pass, so these settle at 0.1 mm.
const DIAGONAL_SETTLED_MM = 0.1;
// From this pass on, passes with diagonal rows that turn round without settling are calmed (see the loop).
const RELAX_FROM_PASS = 4;
// The row weight of a measured part of a straight diagonal line whose ends the axis values fix (see
// diagonalRuns' locator): about an assumed wall's (thicknessDefault), far below a value's.
const LOCATOR_WEIGHT = 1;
// A diagonal value must be longer than the projection the axis values fix by at least this much to add
// its row (else the values disagree: the diagonal stays a check, see the header).
const DIAGONAL_MARGIN_MM = 1;
// Two diagonal edges meeting at a corner are one straight wall when their sketch vectors are parallel
// within 1° (a stroke split where another wall meets it divides its sketch vector exactly).
const SKETCH_COLLINEAR = Math.sin(Math.PI / 180);
// Below this |d·n_adj| (consecutive sides within ~11.5° of straight or of a U-turn, e.g. both faces of
// a dangling wall) the exact corner formula blows up; the linear one is used instead.
const MIN_CORNER_SIN = 0.2;
const WET_ROOM = /화장실|욕실/;

// ---- small helpers -------------------------------------------------------------------------------

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(a) {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    while (this.parent.get(a) !== r) { const n = this.parent.get(a); this.parent.set(a, r); a = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Dense symmetric system N x = r, Gaussian elimination with partial pivoting. N is n×n row-major.
function solveDense(N, r, n) {
  const A = Float64Array.from(N), b = Float64Array.from(r);
  for (let col = 0; col < n; col++) {
    let piv = col, max = Math.abs(A[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row * n + col]);
      if (v > max) { max = v; piv = row; }
    }
    if (max < 1e-300) continue; // singular column: leave the variable at 0 contribution
    if (piv !== col) {
      for (let k = 0; k < n; k++) { const t = A[col * n + k]; A[col * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    const d = A[col * n + col];
    const nz = []; // non-zero columns of the pivot row (the system is sparse)
    for (let k = col; k < n; k++) if (A[col * n + k] !== 0) nz.push(k);
    for (let row = col + 1; row < n; row++) {
      const f = A[row * n + col] / d;
      if (f === 0) continue;
      for (const k of nz) A[row * n + k] -= f * A[col * n + k];
      b[row] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let s = b[row];
    for (let k = row + 1; k < n; k++) s -= A[row * n + k] * x[k];
    const d = A[row * n + row];
    x[row] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}

// Accumulates weighted rows into normal equations. Each row has a tag ('m' measure, 'p' thickness
// prior, 'f' finish, 's' sketch, 'g' gauge) so that a solve can leave a kind out (the hard-only solves).
class NormalSystem {
  constructor() { this.rows = []; this.base = new Map(); }
  row(terms, rhs, w, tag = '') { this.rows.push({ terms, rhs, w, tag }); this.base.clear(); }
  // nFirst: variables [0, nFirst) are eliminated LAST. Thickness/finish variables (indices ≥ nFirst)
  // each touch only a few coordinates, so eliminating them first keeps the fill-in small.
  // extra: rows added for this solve only (the active one-sided rows); skip: tags left out.
  // The fixed rows are summed once per skip set (the active-set loop solves many times).
  solve(n, nFirst = 0, extra = [], skip = '') {
    const perm = (i) => (i >= nFirst ? i - nFirst : i + (n - nFirst));
    const add = (N, r, { terms, rhs, w }) => {
      for (const [i0, ci] of terms) {
        const i = perm(i0);
        r[i] += w * ci * rhs;
        for (const [j0, cj] of terms) N[i * n + perm(j0)] += w * ci * cj;
      }
    };
    let b = this.base.get(skip);
    if (!b) {
      b = { N: new Float64Array(n * n), r: new Float64Array(n) };
      for (const row of this.rows) if (!(skip && row.tag && skip.includes(row.tag))) add(b.N, b.r, row);
      this.base.set(skip, b);
    }
    const N = Float64Array.from(b.N), r = Float64Array.from(b.r);
    for (const row of extra) add(N, r, row);
    const xp = solveDense(N, r, n);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = xp[perm(i)];
    return x;
  }
}

// A one-sided row: Σ c·x ≥ min. → Σ c·x
function rowValue(terms, x) {
  let v = 0;
  for (const [k, c] of terms) v += c * x[k];
  return v;
}

// Merge duplicate column indices of a term list.
function terms(map) { return [...map.entries()].filter(([, c]) => c !== 0); }

function addTerm(map, idx, c) { map.set(idx, (map.get(idx) || 0) + c); }

// Edges of a side walked from side.from, as [{ edge, from }].
function walkSide(side, edgeMap) {
  const out = [];
  let cur = side.from;
  for (const id of side.edgeIds) {
    const e = edgeMap.get(id);
    out.push({ edge: e, from: cur });
    cur = e.a === cur ? e.b : e.a;
  }
  return out;
}

function sketchVec(e, from) {
  const s = e.sketch || { dx: 0, dy: 0 };
  return from === e.a ? { x: s.dx, y: s.dy } : { x: -s.dx, y: -s.dy };
}

// The corner context of side i of a room: adjacent sides, the adjacent wall edge touching each corner,
// and the side's own edges at its two ends.
function cornerContext(sides, i, edgeMap) {
  const n = sides.length;
  const side = sides[i];
  const prev = sides[(i - 1 + n) % n], next = sides[(i + 1) % n];
  return {
    prev, next,
    edgeA: edgeMap.get(prev.edgeIds[prev.edgeIds.length - 1]),
    edgeB: edgeMap.get(next.edgeIds[0]),
    ownA: edgeMap.get(side.edgeIds[0]),
    ownB: edgeMap.get(side.edgeIds[side.edgeIds.length - 1]),
  };
}

// Where the inner corner lies along the side direction d, per mm of inward offset of the adjacent
// side's inner face (kAdj) and of the side's own inner face (kSide):  s = kAdj·o_adj + kSide·o_side.
// Derivation: a point on the side's inner line is P = corner + s·d + o_side·n_side; it is on the
// adjacent inner line when (P − corner)·n_adj = o_adj.
export function cornerCoeffs(d, nSide, nAdj) {
  const dn = d.x * nAdj.x + d.y * nAdj.y;
  if (Math.abs(dn) < MIN_CORNER_SIN) return { kAdj: dn, kSide: 0 }; // linear fallback (see MIN_CORNER_SIN)
  return { kAdj: 1 / dn, kSide: -(nSide.x * nAdj.x + nSide.y * nAdj.y) / dn };
}

// Unit direction and inward normal of a side in the given node positions. The stored side gives which
// way the room lies (the normal's turn from the direction); positions give the current angle.
function sideFrame(side, positions) {
  const A = positions && positions.get(side.from), B = positions && positions.get(side.to);
  if (!A || !B) return { dir: side.dir, normal: side.inwardNormal };
  const dx = B.x - A.x, dy = B.y - A.y;
  const l = Math.hypot(dx, dy);
  if (l < EPS) return { dir: side.dir, normal: side.inwardNormal };
  const dir = { x: dx / l, y: dy / l };
  const turn = (-side.dir.y * side.inwardNormal.x + side.dir.x * side.inwardNormal.y) < 0 ? -1 : 1;
  return { dir, normal: { x: -dir.y * turn, y: dir.x * turn } };
}

const isOblique = (side) => side.orient === 'd';

// ---- public --------------------------------------------------------------------------------------

// Default (prior) thickness of every edge. → Map edgeId → mm
export function thicknessPriors(project, derivedRooms) {
  const settings = { ...DEFAULT_SETTINGS, ...(project.settings || {}) };
  const edgeMap = new Map((project.edges || []).map((e) => [e.id, e]));
  const sidesWithFace = new Map(); // edgeId → { left, right }
  for (const dr of derivedRooms || []) {
    const f = dr.face;
    if (!f) continue;
    for (let k = 0; k < f.edgeIds.length; k++) {
      const e = edgeMap.get(f.edgeIds[k]);
      if (!e) continue;
      const s = sidesWithFace.get(e.id) || { left: false, right: false };
      if (f.nodeIds[k] === e.a) s.right = true; else s.left = true;
      sidesWithFace.set(e.id, s);
    }
  }
  const priors = new Map();
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  for (const e of project.edges || []) {
    if (e.kind === 'divider') { priors.set(e.id, 0); continue; }
    if (e.thickness != null && isFinite(e.thickness)) { priors.set(e.id, Number(e.thickness)); continue; }
    const s = sidesWithFace.get(e.id);
    const inner = s && s.left && s.right;
    priors.set(e.id, inner || (s && islandWall(e, s.left ? -1 : 1, nodes, derivedRooms)) ? settings.intWall : settings.extWall);
  }
  return priors;
}

// A wall with a room on one side only whose other side lies inside another room: the wall of a room
// standing free inside a room (an island; final review 2026-10-28, C5: the 드레스룸 inside the 안방 was
// drawn with 150 mm outer walls). It is an inner wall. Not when the room it encloses is one of several
// rooms joined by their walls (a house standing in a 마당 drawn around it: round 2, 2026-10-31, the house's
// outer walls were taken as 100 mm inner walls and every room drawn 50 mm small on each side), nor inside
// a space named like a yard (YARD_NAME: a 창고 standing in the 마당 keeps outer walls). Inside a room with
// another name (an indoor space: 거실, 방, …) a group of joined rooms is an island too (round 3, 2026-11-01: a
// 화장실 + 샤워실 pod standing in the 거실 was drawn with 150 mm outer walls, its rooms 4 % large); only an
// unnamed host or a yard holds a building. sign: the wall's free side (−1: the left of a → b). dims.js
// rule 2 decides by the same rule. → bool
// Outdoor spaces (round 4, 2026-11-01: a 옥탑방 house of three rooms drawn on its 옥상, or a house in a
// 테라스 / 데크 / 바깥 / 골목 …, got 100 mm outer walls and every value printed twice): YARD_NAME, but not a
// room named after one (INDOOR_NAME: 옥탑방, 바깥방, 뜰방, 실내정원).
const YARD_NAME = /마당|중정|정원|뜰|외부|옥외|대지|공터|텃밭|주차|담장|울타리|옥상|옥탑|테라스|데크|바깥|밖|골목|도로|화단/;
const INDOOR_NAME = /실내|방\s*\d*$/;
function isYardName(name) {
  const n = String(name || '').trim();
  return YARD_NAME.test(n) && !INDOOR_NAME.test(n);
}
export function islandWall(e, sign, nodes, derivedRooms) {
  const A = nodes.get(e.a), B = nodes.get(e.b);
  if (!A || !B) return false;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (!(L > EPS)) return false;
  // The left normal of a → b (y down: (dy, −dx)); the free side is the one without a face.
  const off = 60;
  const p = { x: (A.x + B.x) / 2 + sign * ((B.y - A.y) / L) * off, y: (A.y + B.y) / 2 - sign * ((B.x - A.x) / L) * off };
  const rooms = derivedRooms || [];
  // The host: the SMALLEST room around that point (round 4, 2026-11-01: a 드레스룸 standing in 방1 of a house
  // drawn inside its 마당 took the 마당, the first face found around the point, and got 150 mm walls).
  let host = null, hostArea = Infinity;
  for (const dr of rooms) {
    if (!dr.face || !dr.face.points || dr.face.edgeIds.includes(e.id) || !pointInPolygonSimple(p, dr.face.points)) continue;
    const area = Math.abs(polygonAreaSimple(dr.face.points));
    if (area < hostArea) { host = dr; hostArea = area; }
  }
  if (!host) return false;
  const hostRoom = host.room || null;
  if (hostRoom && isYardName(hostRoom.name)) return false;
  if (hostRoom && String(hostRoom.name || '').trim()) return true;
  // The rooms joined to this wall's room by shared walls, the host aside: more than one is a building.
  const own = rooms.find((dr) => dr.face && dr.face.edgeIds.includes(e.id));
  if (!own) return true;
  const seen = new Set([own.roomId]);
  for (const queue = [own]; queue.length;) {
    const dr = queue.pop();
    const ids = new Set(dr.face.edgeIds);
    for (const o of rooms) {
      if (seen.has(o.roomId) || o.roomId === host.roomId || !o.face || !o.face.edgeIds.some((id) => ids.has(id))) continue;
      seen.add(o.roomId);
      if (seen.size > 1) return false;
      queue.push(o);
    }
  }
  return true;
}

function polygonAreaSimple(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return a / 2;
}

function pointInPolygonSimple(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Walls with a room on one side only (the house's outer walls). → Set of edge ids
function exteriorEdges(project, derivedRooms) {
  const count = new Map();
  for (const dr of derivedRooms || []) {
    for (const id of (dr.face && dr.face.edgeIds) || []) count.set(id, (count.get(id) || 0) + 1);
  }
  const out = new Set();
  for (const [id, c] of count) if (c === 1) out.add(id);
  return out;
}

// Inner length of side `sideIndex` of a room for given positions / thickness / finish maps.
// Exact for any corner angle: the inner faces are the wall centre lines moved inward by t/2 + finish,
// and the inner corners are their intersections (see cornerCoeffs).
export function innerLengthOf(sides, sideIndex, roomId, edgeMap, positions, thickness, finish) {
  const end = { sides, i: sideIndex, roomId };
  return innerLengthBetween(end, end, edgeMap, positions, thickness, finish);
}

// Inner length of a measured SPAN (DESIGN.md §7.7): a straight run of room sides on one face of a line,
// joined across dividers (zero thickness), from the start corner of `first` (its side's `from`) to the
// end corner of `last` (its side's `to`). first / last: { sides, i, roomId } (the room's sides, the
// part's side index, the room id). With first === last this is one side's inner length.
export function innerLengthBetween(first, last, edgeMap, positions, thickness, finish) {
  const sideA = first.sides[first.i], sideB = last.sides[last.i];
  if (!sideA || !sideB || first.sides.length < 3 || last.sides.length < 3) return NaN;
  const A = positions.get(sideA.from), B = positions.get(sideB.to);
  if (!A || !B) return NaN;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const ca = cornerContext(first.sides, first.i, edgeMap);
  const cb = cornerContext(last.sides, last.i, edgeMap);
  const run = { from: sideA.from, to: sideB.to, dir: sideA.dir, inwardNormal: sideA.inwardNormal };
  const fS = sideFrame(run, positions), fP = sideFrame(ca.prev, positions), fN = sideFrame(cb.next, positions);
  const offset = (edge, s, roomId) => {
    if (!edge || edge.kind === 'divider') return 0;
    const t = thickness.get(edge.id) || 0;
    const f = (finish && finish.get(`${roomId}:${s.key}`)) || 0;
    return t / 2 + f;
  };
  const cA = cornerCoeffs(fS.dir, fS.normal, fP.normal);
  const cB = cornerCoeffs(fS.dir, fS.normal, fN.normal);
  const sA = cA.kAdj * offset(ca.edgeA, ca.prev, first.roomId) + cA.kSide * offset(ca.ownA, sideA, first.roomId);
  const sB = cB.kAdj * offset(cb.edgeB, cb.next, last.roomId) + cB.kSide * offset(cb.ownB, sideB, last.roomId);
  return L + sB - sA;
}

// Sketch-based estimate of a side's inner length for a given scale (default thicknesses, no finish).
export function sketchInnerLength(sides, sideIndex, edgeMap, priors, scale) {
  const { sketchCentre, term } = sketchParts(sides, sideIndex, edgeMap, priors);
  return scale * sketchCentre + term;
}

function sketchParts(sides, sideIndex, edgeMap, priors) {
  const end = { sides, i: sideIndex };
  return sketchSpanParts([end], edgeMap, priors);
}

// Sketch centre length and thickness term of a run of parts ([{ sides, i }], see innerLengthBetween).
function sketchSpanParts(parts, edgeMap, priors) {
  const first = parts[0], last = parts[parts.length - 1];
  const side = first.sides[first.i];
  let sc = 0;
  let sx = 0, sy = 0;
  for (const p of parts) {
    for (const { edge, from } of walkSide(p.sides[p.i], edgeMap)) {
      const v = sketchVec(edge, from);
      sc += v.x * side.dir.x + v.y * side.dir.y;
      sx += v.x; sy += v.y;
    }
  }
  // A diagonal's drawn length is its sketch vector's length: the solved direction (side.dir) may be
  // turned far from the drawn one by the values (or by a wrong value, which the 다시 확인 rule must
  // still see as one).
  if (side.orient === 'd') sc = Math.hypot(sx, sy);
  const ca = cornerContext(first.sides, first.i, edgeMap);
  const cb = cornerContext(last.sides, last.i, edgeMap);
  const cA = cornerCoeffs(side.dir, side.inwardNormal, ca.prev.inwardNormal);
  const cB = cornerCoeffs(side.dir, side.inwardNormal, cb.next.inwardNormal);
  const half = (e) => (e ? priors.get(e.id) || 0 : 0) / 2;
  const sA = cA.kAdj * half(ca.edgeA) + cA.kSide * half(ca.ownA);
  const sB = cB.kAdj * half(cb.edgeB) + cB.kSide * half(cb.ownB);
  return { sketchCentre: sc, term: sB - sA };
}

// Scale estimate: median over measured sides of (value − thickness term) / sketch centre length.
// Measures listed in `exclude` (a Set of ids) are skipped. → number | NaN
export function estimateScale(project, derivedRooms, priors, exclude = null) {
  const ratios = [];
  for (const [id, s] of scaleRatios(project, derivedRooms, priors)) {
    if (!(exclude && exclude.has(id))) ratios.push(s);
  }
  return median(ratios);
}

export { median };

// The measured runs of a project: one entry per valid measure that is a room side, or (opts.spans) a
// span across dividers. → [{ m, parts: [{ dr, i }] }] (parts in the sides' direction)
//   spans: Map measureId → [{ roomId, i }] (model.js derive; DESIGN.md §7.7)
function measuredRuns(project, derivedRooms, spans) {
  const byRoom = new Map((derivedRooms || []).map((dr) => [dr.roomId, dr]));
  const out = [];
  for (const m of project.measures || []) {
    if (!(isFinite(m.value) && m.value > 0)) continue;
    const span = spans && spans.get(m.id);
    if (span) {
      const parts = span.map((p) => ({ dr: byRoom.get(p.roomId), i: p.i }));
      if (parts.length && parts.every((p) => p.dr && p.dr.sides.length >= 3 && p.dr.sides[p.i])) out.push({ m, parts });
      continue;
    }
    const dr = byRoom.get(m.room);
    if (!dr || dr.sides.length < 3) continue;
    const key = measureSideKey(m);
    const i = dr.sides.findIndex((s) => s.key === key);
    if (i < 0) continue;
    out.push({ m, parts: [{ dr, i }] });
  }
  return out;
}

// Values that close a LOOP on one axis (final review 2026-10-28: a −500 / +1000 typo spread over several
// values passed silently, each value's own share of the wall changes under closureTolerance; a +500 typo
// named only correct values that happened to take the slack). Every measured h side (or span) ties the
// x of its two end corners: x_B − x_A = value − (its corner terms with the ASSUMED walls, no finish),
// and likewise every v side the y of its ends (corners on one v wall share x, on one h wall y). Where these
// rows form loops, the assumed walls make them close; what does not close is a wrong value (or a wall
// far thicker than assumed). For every value with another path between its corners the rows without it
// are fitted (least squares) and give what the others say its value should be: dev = how far it is off.
// A value off by more than `tol` (plus LOOP_WALL_SLACK_MM for every assumed wall more on one path than on
// the other: round 2, 2026-10-31, a 고시원 row of 7 rooms with real 150 mm walls against its 복도 differed
// by 6 × 50 mm and named the correct 복도), plus LOOP_TAPE_SLACK_MM for every value on its two paths (round
// 3), is in an open loop. The suspects (round 2):
//  - the values without which the rest closes (within tol / 6): one, that value (D4: the 복도 typo, not the
//    15 values of the rows); several, they are interchangeable (one path of one loop: any could be wrong);
//  - else (two mistakes, or walls thicker than assumed): every value off by more than `tol`, the one
//    without which the rest disagrees least first; when that leaves the rest within tol / 2, the loop is
//    worded as one wrong value after all (round 3: 예시 세대 A, whose correct values already disagree by 265 mm).
// A dev of exactly `tol` is not over it (as the 치수 폐합 and 마주 보는 벽 checks: E4's ±300 typo named the
// correct value facing it, whichever float came out 1e-12 larger).
// (Two rows wrong the same way look like one wrong row, the correct third one: C3 with 욕실 and 창고 −500
// names the 방1 · 방2 · 거실 row. Once those are confirmed, the loop no longer explains the others: the wrong
// 욕실's own '벽 두께로 423mm 맞춤' is 확인필요 again, checks-full loopChecks.)
// → [{ axis, suspects: [measureId], members: [measureId] (every value off by more than its tolerance),
//      amount (the largest dev), devs: Map measureId → dev, closes (the suspects alone close the loop),
//      walls (the most assumed walls between a suspect's two paths), soft? (over the tolerance and the
//      walls' slack only by the tape slack: see below) }]
export function valueLoops(project, derivedRooms, spans = null, { tol = 300, priors = null } = {}) {
  const edgeMap = new Map((project.edges || []).map((e) => [e.id, e]));
  const pri = priors || thicknessPriors(project, derivedRooms);
  // Every assumed wall as 1 (its thickness unknown): a row's term in walls.
  const unit = new Map((project.edges || []).map((e) => [e.id, e.kind === 'divider' || (e.thickness != null && isFinite(e.thickness)) ? 0 : 1]));
  const runs = measuredRuns(project, derivedRooms, spans);
  const out = [];
  let ratios = null;
  for (const axis of ['x', 'y']) {
    const along = axis === 'x' ? 'h' : 'v', tie = axis === 'x' ? 'v' : 'h';
    const uf = new UnionFind();
    for (const e of project.edges || []) if (e.orient === tie) uf.union(e.a, e.b);
    const rows = [];
    for (const { m, parts } of runs) {
      const side = parts[0].dr.sides[parts[0].i], last = parts[parts.length - 1].dr.sides[parts[parts.length - 1].i];
      if (side.orient !== along || last.orient !== along) continue;
      const ga = uf.find(side.from), gb = uf.find(last.to);
      const sign = Math.sign(side.dir[axis]);
      if (ga === gb || !sign) continue;
      const ps = parts.map((p) => ({ sides: p.dr.sides, i: p.i }));
      const { term } = sketchSpanParts(ps, edgeMap, pri);
      const walls = sketchSpanParts(ps, edgeMap, unit).term;
      rows.push({ id: m.id, ga, gb, D: sign * (m.value - term), W: -sign * walls });
    }
    if (rows.length < 2) continue;
    // Components of the groups joined by rows.
    const comp = new UnionFind();
    for (const r of rows) comp.union(r.ga, r.gb);
    const byComp = new Map();
    for (const r of rows) {
      const c = comp.find(r.ga);
      if (!byComp.has(c)) byComp.set(c, []);
      byComp.get(c).push(r);
    }
    for (const list of byComp.values()) {
      const groups = [...new Set(list.flatMap((r) => [r.ga, r.gb]))];
      if (list.length < groups.length) continue; // a tree: nothing to compare
      const all = loopFit(list, groups, null);
      if (!all || Math.max(...list.map((r) => Math.abs(all.res.get(r.id)))) <= tol / 6) continue;
      const devs = new Map(), wallsOff = new Map(), closes = new Set(), rests = new Map(), pathVals = new Map();
      for (const r of list) {
        const f = loopFit(list, groups, r);
        if (!f || !f.reached) continue; // a bridge: no other path between its corners
        devs.set(r.id, r.D - (f.P.get(r.gb) - f.P.get(r.ga)));
        const fw = loopFit(list, groups, r, 'W');
        wallsOff.set(r.id, fw ? Math.abs(r.W - (fw.P.get(r.gb) - fw.P.get(r.ga))) : 0);
        // What the others still disagree by without this value (round 3: the order of split suspects).
        const rest = f.res.size === 0 ? 0 : Math.max(...[...f.res.values()].map(Math.abs));
        rests.set(r.id, rest);
        if (rest <= tol / 6) closes.add(r.id);
        pathVals.set(r.id, 1 + shortestChain(list, r));
      }
      // Tape slack (round 3, 2026-11-01): every value of the loop may be 5–10 mm off by the tape; 예시 세대 A typed
      // with tape values crossed the limit by 10–25 mm in the middle of the typing (a 확인필요 naming five
      // correct values came and went). LOOP_TAPE_SLACK_MM for every value on its two paths (the value and the
      // shortest chain of the others between its corners), not the whole component (a long 고시원 row).
      const limit = (id, tape = LOOP_TAPE_SLACK_MM) => tol + LOOP_WALL_SLACK_MM * (wallsOff.get(id) || 0) + tape * (pathVals.get(id) || 0) + LOOP_EPS_MM;
      let bad = [...devs].filter(([id, d]) => Math.abs(d) > limit(id));
      // Over the tolerance only by what the tape may add (round 4, 2026-11-01): a 'soft' loop. It still says
      // what the walls had to take (D5 with 화장실 위쪽 벽 2593 typed 2893: 301 mm, under the slack; the walls
      // took 304 / 303 mm on two correct neighbours, and their 확인필요 named only them): model.js
      // computeWarnings keeps it as a loop where such a 확인필요 stands on its values, else as 참고.
      let soft = false;
      if (!bad.length) {
        bad = [...devs].filter(([id, d]) => Math.abs(d) > limit(id, 0));
        if (!bad.length) continue;
        soft = true;
      }
      const top = Math.max(...bad.map(([, d]) => Math.abs(d)));
      // Several interchangeable suspects: the one the drawing agrees with least first (its value against
      // the plan's median value / drawn length; a hand sketch is too rough to decide by).
      ratios = ratios || scaleRatios(project, derivedRooms, pri, spans);
      const med = median([...ratios.values()]);
      const off = (id) => (ratios.has(id) && med > 0 ? Math.abs(ratios.get(id) / med - 1) : 0);
      const closers = bad.filter(([id]) => closes.has(id));
      // No one value explains it: every value off by more than the plain tolerance (예시 세대 A with 주방 2800 typed
      // 2500: the 2500 is 308 off, its walls' slack aside, the four correct values the walls had already
      // put 265 off now 415).
      const split = closers.length ? null : [...devs].filter(([, d]) => Math.abs(d) > tol + LOOP_EPS_MM);
      let suspects = (closers.length ? closers : split).map(([id]) => id).sort((a, b) => off(b) - off(a));
      // Split suspects (round 3, 2026-11-01): the one without which the others disagree least first (in steps
      // of tol / 6, then as above), and when that leaves the rest within tol / 2 it is one value after all:
      // a household whose correct values already disagree a little (예시 세대 A 265 mm over its y loop) with one
      // typo was worded '틀린 값이 둘 이상이거나 …' and the typo could fall outside the ※ line's first names.
      let rankCloses = false;
      if (split && suspects.length) {
        const rk = (id) => (rests.has(id) ? rests.get(id) : Infinity);
        const step = (id) => Math.floor(rk(id) / (tol / 6));
        suspects = suspects.slice().sort((a, b) => (step(a) - step(b)) || (off(b) - off(a)));
        rankCloses = rk(suspects[0]) <= tol / 2;
      }
      out.push({
        axis, suspects, members: bad.map(([id]) => id), amount: top, devs, closes: closers.length > 0 || rankCloses,
        walls: Math.max(...suspects.map((id) => wallsOff.get(id) || 0)), ...(soft ? { soft: true } : {}),
      });
    }
  }
  return out;
}

// valueLoops: what an assumed wall may be off by (mm; 예시 세대 A as measured: 265 mm over its y loop with
// correct values; 150 mm walls where 100 is assumed), the margin over the tolerance,
const LOOP_WALL_SLACK_MM = 10;
// and what every value on a loop's paths may be off by the tape (round 3: 3 mm; 5 mm cleared 예시 세대 A's typing
// but missed a −400 typo in E3).
const LOOP_TAPE_SLACK_MM = 3;
const LOOP_EPS_MM = 0.01;
// solve() chainTest: only for a diagonal check that misses by more (mm; model.js RESIDUAL_TOLERANCE_MM).
const CHAIN_TEST_MIN_MM = 5;

// The number of rows on a shortest chain between row `skip`'s two groups without it (0 when none).
function shortestChain(rows, skip) {
  const use = rows.filter((r) => r !== skip);
  const depth = new Map([[skip.ga, 0]]);
  for (let queue = [skip.ga]; queue.length;) {
    const next = [];
    for (const u of queue) {
      for (const r of use) {
        if (r.ga !== u && r.gb !== u) continue;
        const v = r.ga === u ? r.gb : r.ga;
        if (depth.has(v)) continue;
        depth.set(v, depth.get(u) + 1);
        if (v === skip.gb) return depth.get(v);
        next.push(v);
      }
    }
    queue = next;
  }
  return 0;
}

// Least squares x_b − x_a = D over rows (without row `skip`), one group held at 0 (key: the rows' value to
// fit, 'D', or 'W' for their assumed walls).
// → { P: Map group → coordinate, res: Map rowId → residual, reached (skip's two groups still joined) } | null
function loopFit(rows, groups, skip, key = 'D') {
  const use = skip ? rows.filter((r) => r !== skip) : rows;
  const idx = new Map(groups.map((g, k) => [g, k]));
  const n = groups.length;
  // Groups reachable from the first one without `skip` (the others are fitted apart, held at 0 each).
  const adj = new Map(groups.map((g) => [g, []]));
  for (const r of use) { adj.get(r.ga).push(r.gb); adj.get(r.gb).push(r.ga); }
  const seen = new Set();
  const comps = [];
  for (const g0 of groups) {
    if (seen.has(g0)) continue;
    comps.push(g0);
    seen.add(g0);
    for (const q = [g0]; q.length;) { const u = q.pop(); for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  }
  const N = new Float64Array(n * n), b = new Float64Array(n);
  for (const r of use) {
    const i = idx.get(r.ga), j = idx.get(r.gb);
    N[i * n + i] += 1; N[j * n + j] += 1; N[i * n + j] -= 1; N[j * n + i] -= 1;
    b[j] += r[key]; b[i] -= r[key];
  }
  for (const g of comps) { const k = idx.get(g); N[k * n + k] += 1e6; }
  const x = solveDense(N, b, n);
  if (!x) return null;
  const P = new Map(groups.map((g, k) => [g, x[k]]));
  const res = new Map(use.map((r) => [r.id, P.get(r.gb) - P.get(r.ga) - r[key]]));
  let reached = true;
  if (skip) {
    // Joined without skip?
    const s2 = new Set([skip.ga]);
    for (const q = [skip.ga]; q.length;) { const u = q.pop(); for (const v of adj.get(u)) if (!s2.has(v)) { s2.add(v); q.push(v); } }
    reached = s2.has(skip.gb);
  }
  return { P, res, reached };
}

// Per-measure scale estimates. → Map measureId → (value − thickness term) / sketch centre length
// spans (optional): see measuredRuns.
// opts.diagonals: 'exclude' (default: the plan's scale comes from the axis values), 'only' (the solve
//   uses these when no axis value exists, so a diagonal typed first scales the plan), 'include' (both,
//   for the 다시 확인 median rule: a missing zero in a diagonal value is caught like any other).
export function scaleRatios(project, derivedRooms, priors, spans = null, opts = {}) {
  const which = (opts && opts.diagonals) || 'exclude';
  const edgeMap = new Map((project.edges || []).map((e) => [e.id, e]));
  const ratios = new Map();
  for (const { m, parts } of measuredRuns(project, derivedRooms, spans)) {
    const diagonal = parts[0].dr.sides[parts[0].i].orient === 'd';
    if (diagonal ? which === 'exclude' : which === 'only') continue;
    const { sketchCentre, term } = sketchSpanParts(parts.map((p) => ({ sides: p.dr.sides, i: p.i })), edgeMap, priors);
    if (sketchCentre > EPS) {
      const s = (m.value - term) / sketchCentre;
      if (s > 0 && isFinite(s)) ratios.set(m.id, s);
    }
  }
  return ratios;
}

// Corners in the middle of a straight diagonal wall (2026-10-19): two diagonal edges meeting at node m
// that were drawn in one line (sketch vectors parallel within 1°, same way), e.g. one stroke split where
// another wall meets it. The solve keeps m on the line A–B; the checks count it as fixed once the line
// and one of its coordinates are. → [{ m, A, B }] (one entry per such pair of edges)
export function straightDiagonalJoints(project) {
  const nodeIds = new Set((project.nodes || []).map((n) => n.id));
  const dAt = new Map();
  for (const e of project.edges || []) {
    if (e.orient !== 'd' || e.kind === 'divider' || !nodeIds.has(e.a) || !nodeIds.has(e.b)) continue;
    for (const id of [e.a, e.b]) { if (!dAt.has(id)) dAt.set(id, []); dAt.get(id).push(e); }
  }
  const out = [];
  for (const [m, list] of dAt) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const e1 = list[i], e2 = list[j];
        const A = e1.a === m ? e1.b : e1.a, B = e2.a === m ? e2.b : e2.a;
        const v1 = sketchVec(e1, A), v2 = sketchVec(e2, m); // A → m, m → B
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        if (!(l1 > EPS && l2 > EPS) || A === B) continue;
        const cr = (v1.x * v2.y - v1.y * v2.x) / (l1 * l2), dt = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
        if (Math.abs(cr) <= SKETCH_COLLINEAR && dt > 0) out.push({ m, A, B });
      }
    }
  }
  return out;
}

// The drawn inner length of a measured side (or span: from side i of dr to side iB of drB) minus its
// value, at these corners, walls and finishes.
function residualOf(m, dr, i, drB, iB, edgeMap, positions, thickness, finish) {
  const len = innerLengthBetween({ sides: dr.sides, i, roomId: dr.roomId }, { sides: drB.sides, i: iB, roomId: drB.roomId },
    edgeMap, positions, thickness, finish);
  return len - m.value;
}

// solve()'s measureResiduals, absorbed sums and gap lengths again, for corners (and walls, finishes) other
// than the solve's own: a household opened as stored keeps its stored corners (model.js derive), and every
// number shown with them must be theirs (final check 2026-10-25: '그림 659 (269mm 차이)' came from the solve
// whose corners were thrown away, on a plan whose drawing had 378). sol: a solve() result whose thickness /
// finish are the ones to use; positions: Map id → { x, y }. → a copy of sol with those positions
export function solutionAt(project, derivedRooms, sol, positions, opts = {}) {
  const edgeMap = new Map((project.edges || []).map((e) => [e.id, e]));
  const measureResiduals = new Map();
  for (const { m, parts } of measuredRuns(project, derivedRooms, (opts && opts.spans) || null)) {
    const last = parts[parts.length - 1];
    measureResiduals.set(m.id, residualOf(m, parts[0].dr, parts[0].i, last.dr, last.i, edgeMap, positions, sol.thickness, sol.finish));
  }
  const coord = (ids, axis) => {
    const q = (ids || []).map((id) => positions.get(id)).find((p) => p && isFinite(p[axis]));
    return q ? q[axis] : NaN;
  };
  const gaps = (sol.gaps || []).map((g) => {
    const L = Math.abs(coord(g.nodesB, g.axis) - coord(g.nodesA, g.axis));
    return isFinite(L) ? { ...g, length: L } : g;
  });
  let absorbed = sol.absorbed;
  if (sol.softTerms) {
    absorbed = new Map();
    for (const [id, terms] of sol.softTerms) {
      let sum = 0;
      for (const q of terms) {
        const v = q.edgeId != null ? sol.thickness.get(q.edgeId) : sol.finish.get(q.finishKey);
        sum += q.c * ((isFinite(v) ? v : 0) - q.prior);
      }
      absorbed.set(id, Math.abs(sum));
    }
  }
  return { ...sol, positions, measureResiduals, absorbed, gaps };
}

// derivedRooms: [{ roomId, room?, face, sides }]
// opts.spans: Map measureId → [{ roomId, i }] — measures that span several room sides across dividers
//   or walls (DESIGN.md §7.7, §7.9). Such a measure is one row like a measured side: from the first
//   part's start inner corner to the last part's end inner corner. What lies between the parts (nothing
//   for a divider, a wall's thickness for a wall drawn across the side) is not in the row: the parts'
//   own rows (typed parts) and the wall's thickness prior place the walls in between.
// → { positions, thickness, finish, scale, measureResiduals, absorbed, diagonalRows, conflicts, folds, gaps,
//     openingFits, info }
//   (see the return statement; the typed widths of project.openings bound their wall pieces, C2)
export function solve(project, derivedRooms, opts = {}) {
  const spans = (opts && opts.spans) || null;
  const nodes = project.nodes || [];
  const edges = project.edges || [];
  const edgeMap = new Map(edges.map((e) => [e.id, e]));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const roomsById = new Map((project.rooms || []).map((r) => [r.id, r]));
  const priors = thicknessPriors(project, derivedRooms);
  const exterior = exteriorEdges(project, derivedRooms);

  // Coordinate groups.
  const ufX = new UnionFind(), ufY = new UnionFind();
  for (const n of nodes) { ufX.find(n.id); ufY.find(n.id); }
  for (const e of edges) {
    if (!nodeMap.has(e.a) || !nodeMap.has(e.b)) continue;
    if (e.orient === 'v') ufX.union(e.a, e.b);
    else if (e.orient === 'h') ufY.union(e.a, e.b);
  }

  // Straight wall runs: the edges of one room side that continue each other over a T-junction are one
  // wall, so they share one thickness unknown. Otherwise a difference absorbed next to a measured corner
  // thickened only the edge at that corner and the room's own face jogged in the middle of the side
  // (예시 세대 A: 방3's bottom face at the 현관 | 거실 corner). Only assumed walls of the same kind (same prior,
  // both outer or both inner) are joined; a measured thickness stays on its own edge.
  const wallRuns = new UnionFind();
  for (const dr of derivedRooms || []) {
    for (const s of dr.sides) {
      if (s.orient !== 'h' && s.orient !== 'v') continue;
      for (let j = 1; j < s.edgeIds.length; j++) {
        const a = edgeMap.get(s.edgeIds[j - 1]), b = edgeMap.get(s.edgeIds[j]);
        if (!a || !b || a.kind === 'divider' || b.kind === 'divider') continue;
        if (a.thickness != null || b.thickness != null) continue;
        if (priors.get(a.id) !== priors.get(b.id) || exterior.has(a.id) !== exterior.has(b.id)) continue;
        wallRuns.union(a.id, b.id);
      }
    }
  }
  const runMembers = new Map(); // representative edge id → [edge ids]
  for (const e of edges) {
    const r = wallRuns.find(e.id);
    if (!runMembers.has(r)) runMembers.set(r, []);
    runMembers.get(r).push(e.id);
  }

  // Scale. Diagonal values count only when no axis value exists (a diagonal typed first).
  let scale = median([...scaleRatios(project, derivedRooms, priors, spans).values()]);
  if (!(scale > 0)) scale = median([...scaleRatios(project, derivedRooms, priors, spans, { diagonals: 'only' }).values()]);
  if (!(scale > 0)) scale = project.sketchScale > 0 ? project.sketchScale : 1;

  // Valid measures with their room side (dr, i) and, for a span, the room side at its end (drB, iB).
  const byRoom = new Map((derivedRooms || []).map((dr) => [dr.roomId, dr]));
  const measured = measuredRuns(project, derivedRooms, spans).map(({ m, parts }) => {
    const last = parts[parts.length - 1];
    return { m, dr: parts[0].dr, i: parts[0].i, drB: last.dr, iB: last.i, parts };
  });

  const finishWeight = (roomId) => {
    const r = roomsById.get(roomId) || (byRoom.get(roomId) || {}).room;
    return r && WET_ROOM.test(r.name || '') ? SOLVER_WEIGHTS.finishWet : SOLVER_WEIGHTS.finish;
  };

  // Windows / doors whose width was typed (contract C2): only these bound their wall piece.
  const typedOpenings = (project.openings || []).filter((o) => o && typeof o.width === 'number'
    && isFinite(o.width) && o.width > 0 && edgeMap.has(o.edge));
  const edgesAt = new Map(); // nodeId → [edge]
  for (const e of edges) for (const id of [e.a, e.b]) { if (!edgesAt.has(id)) edgesAt.set(id, []); edgesAt.get(id).push(e); }
  // What an opening loses at an end of its wall piece: half the thickest wall meeting it there across
  // (as openings.js edgeFrame clips it; a straight continuation or a free end takes nothing).
  const jambClearance = (e, nodeId) => {
    let m = 0;
    for (const f of edgesAt.get(nodeId) || []) {
      if (f === e || f.kind === 'divider' || f.orient === e.orient) continue;
      m = Math.max(m, ((tNow.get(f.id) ?? priors.get(f.id)) || 0) / 2);
    }
    return m;
  };

  // From h / v wall e beyond its end nodeId, on along the one wall of its line while only 구역 나누기 lines
  // meet the corners (openings.js straightRun). → { node, edge }
  const straightRunEnd = (e, nodeId) => {
    let cur = e, at = nodeId;
    const seen = new Set([e.id]);
    for (let guard = 0; guard < 64; guard++) {
      const others = (edgesAt.get(at) || []).filter((f) => f !== cur);
      const walls = others.filter((f) => f.kind !== 'divider');
      if (walls.length !== 1 || walls.length === others.length || seen.has(walls[0].id)) break;
      const next = walls[0];
      if (next.orient !== cur.orient || (next.orient !== 'h' && next.orient !== 'v')) break;
      seen.add(next.id);
      cur = next;
      at = next.a === at ? next.b : next.a;
    }
    return { node: at, edge: cur };
  };

  // Current estimates used for the corner coefficients (updated after each pass): positions give the
  // angles of diagonal walls; thickness/finish give the measured side's own inner-face offset, which
  // belongs to the other axis system.
  let posNow = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  let tNow = priors;
  let fNow = new Map();

  // Measured diagonal sides (see the header). The coordinate groups the AXIS values tie together,
  // through chains (like `tied` in solveAxis, for both axes and before any solve): a measured h side or
  // span ties the x-groups of its two end corners, a v one the y-groups.
  const axisTie = { x: new UnionFind(), y: new UnionFind() };
  for (const { dr, i, drB, iB } of measured) {
    const side = dr.sides[i], sideB = drB.sides[iB];
    if (side.orient === 'h') axisTie.x.union(ufX.find(side.from), ufX.find(sideB.to));
    else if (side.orient === 'v') axisTie.y.union(ufY.find(side.from), ufY.find(sideB.to));
  }
  const axisTied = (axis, a, b) => {
    const uf = axis === 'x' ? ufX : ufY;
    return axisTie[axis].find(uf.find(a)) === axisTie[axis].find(uf.find(b));
  };
  // The diagonal wall pieces of measured diagonal sides (their value fixes them; no opening bound, round 5).
  const measuredDiagEdges = new Set();
  for (const { parts } of measured) {
    for (const p of parts) { const sd = p.dr.sides[p.i]; if (sd && sd.orient === 'd') for (const id of sd.edgeIds || []) measuredDiagEdges.add(id); }
  }
  // The axis values on EVERY chain of values between two corners (round 3, 2026-11-01): what a diagonal that
  // is only a check is compared with, besides its own value. A value in a loop is checked by the loop
  // (valueLoops); one on every chain only by the diagonal (B6 with 거실 아래쪽 벽 2570 typed 5270: the line's
  // 확인필요 named only the correct diagonal parts, and once they were confirmed the wrong value printed
  // silently; B4's corner cut with 거실 아래쪽 벽 +500 the same). → [measureId] along the chain from a
  const tieRows = { x: [], y: [] };
  for (const { m, dr, i, drB, iB } of measured) {
    const side = dr.sides[i], sideB = drB.sides[iB];
    if (side.orient === 'h') tieRows.x.push({ id: m.id, ga: ufX.find(side.from), gb: ufX.find(sideB.to) });
    else if (side.orient === 'v') tieRows.y.push({ id: m.id, ga: ufY.find(side.from), gb: ufY.find(sideB.to) });
  }
  const chainValues = (axis, a, b) => {
    const uf = axis === 'x' ? ufX : ufY;
    const ga = uf.find(a), gb = uf.find(b);
    const rows = tieRows[axis].filter((r) => r.ga !== r.gb);
    if (ga === gb || !rows.length) return [];
    // The rows of a shortest chain from ga to gb without row `skip`, or null.
    const chain = (skip) => {
      const via = new Map([[ga, null]]);
      for (let queue = [ga]; queue.length;) {
        const next = [];
        for (const u of queue) {
          for (const r of rows) {
            if (r === skip || (r.ga !== u && r.gb !== u)) continue;
            const v = r.ga === u ? r.gb : r.ga;
            if (via.has(v)) continue;
            via.set(v, { r, from: u });
            next.push(v);
          }
        }
        queue = next;
      }
      if (!via.has(gb)) return null;
      const out = [];
      for (let at = gb; via.get(at); at = via.get(at).from) out.push(via.get(at).r);
      return out.reverse();
    };
    const path = chain(null);
    return path ? path.filter((r) => !chain(r)).map((r) => r.id) : [];
  };
  // [{ m, dr, i, drB, iB, A, B (corner ids), tied: { x, y } }]
  const diagonals = measured.filter(({ dr, i }) => isOblique(dr.sides[i])).map((g) => {
    const A = g.dr.sides[g.i].from, B = g.drB.sides[g.iB].to;
    return { ...g, A, B, tied: { x: axisTied('x', A, B), y: axisTied('y', A, B) } };
  });
  const diagonalRuns = diagonals.filter((g) => !(g.tied.x && g.tied.y)); // those that may add rows
  // A measured PART of a straight diagonal wall split by T-junctions (straightDiagonalJoints) whose whole
  // line the axis values fix at both ends (final review 2026-10-28, B6: a diagonal 구역 나누기 선 ending on
  // the diagonal outer wall; its two parts typed): the parts only place the T along the fixed line, so
  // their rows are weak (LOCATOR weight) and their sum is a check like a whole diagonal's value. As
  // value rows, 10 mm of tape rounding in them stretched the plan 235 mm through three correct 4500s.
  // Not where the T's third wall is itself a MEASURED diagonal (round 2, 2026-10-31, B6 with the 구역
  // 나누기 선 drawn as a diagonal wall): that value places the T, at about 30° to the line, so 14 mm of tape
  // at its far end moves the T ~50 mm along the line, past what the weak parts' check allows, and the weak
  // rows let the passes run away (lastMoved 124–1344 mm in 23 of 66 tape sets). There the parts stay value
  // rows (as before). A 구역 나누기 선, an unmeasured wall or an h / v wall (whose axis value fixes the T's
  // coordinate on the line) leaves the T to the parts.
  {
    const measuredDiagonalEdges = new Set();
    for (const g of diagonals) {
      for (const s of [g.dr.sides[g.i], g.drB.sides[g.iB]]) for (const { edge } of walkSide(s, edgeMap)) measuredDiagonalEdges.add(edge.id);
    }
    const placedByLeg = (j) => (edgesAt.get(j.m) || []).some((e) => e.orient === 'd' && e.kind !== 'divider'
      && measuredDiagonalEdges.has(e.id) && e.a !== j.A && e.b !== j.A && e.a !== j.B && e.b !== j.B);
    const jointAt = new Map();
    for (const j of straightDiagonalJoints(project)) if (!jointAt.has(j.m) && !placedByLeg(j)) jointAt.set(j.m, j);
    const lineEnd = (node, toward) => {
      let at = node, from = toward;
      for (let guard = 0; guard < 64; guard++) {
        const j = jointAt.get(at);
        if (!j || (j.A !== from && j.B !== from)) break;
        const next = j.A === from ? j.B : j.A;
        from = at;
        at = next;
      }
      return at;
    };
    for (const g of diagonalRuns) {
      const first = walkSide(g.dr.sides[g.i], edgeMap)[0];
      const lastSteps = walkSide(g.drB.sides[g.iB], edgeMap);
      const last = lastSteps[lastSteps.length - 1];
      if (!first || !last) continue;
      const afterA = first.edge.a === g.A ? first.edge.b : first.edge.a;
      const beforeB = last.from;
      const A0 = lineEnd(g.A, afterA), B0 = lineEnd(g.B, beforeB);
      if ((A0 !== g.A || B0 !== g.B) && axisTied('x', A0, B0) && axisTied('y', A0, B0)) {
        g.locator = true;
        g.line = [A0, B0].sort().join('|'); // the whole line's two end corners
        g.lineEnds = [A0, B0];
      }
    }
  }
  // Sketched direction of a diagonal run (A → B), for the sign when the current positions give none.
  const sketchDir = (g) => {
    let x = 0, y = 0;
    const parts = g.dr === g.drB && g.i === g.iB ? [g.dr.sides[g.i]] : null;
    for (const s of parts || [g.dr.sides[g.i], g.drB.sides[g.iB]]) {
      for (const { edge, from } of walkSide(s, edgeMap)) { const v = sketchVec(edge, from); x += v.x; y += v.y; }
    }
    return { x, y };
  };
  // The current direction d (A → B, from `pos`) of a diagonal run and its corner offsets δ (inner −
  // centre length, along d; from tNow / fNow). → { P, Q, L, d, inner, delta } | null
  const diagonalFrame = (g, pos) => {
    const P = pos.get(g.A), Q = pos.get(g.B);
    if (!P || !Q) return null;
    const L = Math.hypot(Q.x - P.x, Q.y - P.y);
    if (!(L > EPS)) return null;
    const d = { x: (Q.x - P.x) / L, y: (Q.y - P.y) / L };
    const inner = innerLengthBetween({ sides: g.dr.sides, i: g.i, roomId: g.dr.roomId },
      { sides: g.drB.sides, i: g.iB, roomId: g.drB.roomId }, edgeMap, pos, tNow, fNow);
    if (!isFinite(inner)) return null;
    return { P, Q, L, d, inner, delta: inner - L };
  };
  // Pythagoras rows of the diagonal values with exactly one projection tied, on the free axis, from the
  // estimates in `pos`: (coord_B − coord_A) = ±√(v² − fixed²) − δ·d_axis, with the inner projection the
  // axis values fix. → Map run → { c: 1, rhs }
  const diagonalTargets = (axis, pos) => {
    const out = new Map();
    const other = axis === 'x' ? 'y' : 'x';
    for (const g of diagonalRuns) {
      if ((!g.tied.x && !g.tied.y) || g.tied[axis]) continue; // neither: the joint length row; tied: fixed
      const f = diagonalFrame(g, pos);
      if (!f) continue;
      const v = g.m.value;
      const fixed = f.inner * f.d[other]; // the inner projection the axis values fix
      if (!(v > Math.abs(fixed) + DIAGONAL_MARGIN_MM)) continue;
      const sign = Math.sign(f.d[axis]) || Math.sign(sketchDir(g)[axis]) || 1;
      out.set(g, { c: 1, rhs: sign * Math.sqrt(v * v - fixed * fixed) - f.delta * f.d[axis] });
    }
    return out;
  };
  // Length rows of the diagonal values with neither projection tied (solved with both axes in one
  // system): d·(B − A) = v − δ along the current direction, linearized again every pass. Only the
  // length is held: the direction is left to the rest of the plan, so the sketch keeps the drawn angle
  // where nothing else decides it and other values turn it where they do (a bay whose two diagonals,
  // front and wall pieces close at one pair of angles). (Rows on each axis apart, the first try, held
  // the old direction, and the assumed walls took what the bay needed: a 110 mm finish on one wall.)
  // → Map run → { cx, cy, rhs }
  const diagonalLengthRows = (pos) => {
    const out = new Map();
    for (const g of diagonalRuns) {
      if (g.tied.x || g.tied.y) continue;
      const f = diagonalFrame(g, pos);
      if (f) out.set(g, { cx: f.d.x, cy: f.d.y, rhs: g.m.value - f.delta });
    }
    return out;
  };
  // Neither projection tied anywhere: x and y are solved together.
  const jointSolve = diagonalRuns.some((g) => !g.tied.x && !g.tied.y);
  let diagTargets = { x: new Map(), y: new Map(), xy: new Map() };

  // Straight diagonal walls through a T-junction or a crossing (2026-10-19): a corner between two
  // diagonal edges drawn in one line (parallel sketch vectors, e.g. one stroke split where another wall
  // meets it) stays on the line through its two neighbours. Nothing else holds it there (each corner
  // has its own x and y line): a kink of a few mm split the room's side in two and its value came
  // loose. The line condition is one equation, so it is one row on ONE axis, exact for the other axis's
  // current coordinates (Gauss–Seidel like the diagonal rows): coord_M = (1 − λ)·coord_A + λ·coord_B,
  // λ = how far M lies from A to B on the other axis. It goes on the axis where the corner is free: the
  // other coordinate is the one values fix (a wall from M to a measured line), so nothing pulls that one
  // back to its old place (a row on both axes kept the old proportions, and the assumed walls took the
  // difference). Where neither or both are fixed, on x for a steep wall and on y for a flat one.
  const straightJoints = straightDiagonalJoints(project);
  {
    // Ties by the axis values and by the diagonal values with rows (they fix both projections).
    const tieAll = { x: new UnionFind(), y: new UnionFind() };
    for (const axis of ['x', 'y']) {
      const uf = axis === 'x' ? ufX : ufY;
      for (const n of nodes) tieAll[axis].union(axisTie[axis].find(uf.find(n.id)), axisTie[axis].find(uf.find(n.id)));
      for (const g of diagonalRuns) tieAll[axis].union(axisTie[axis].find(uf.find(g.A)), axisTie[axis].find(uf.find(g.B)));
    }
    const tiedTo = (axis, a, b) => {
      const uf = axis === 'x' ? ufX : ufY;
      return tieAll[axis].find(axisTie[axis].find(uf.find(a))) === tieAll[axis].find(axisTie[axis].find(uf.find(b)));
    };
    for (const j of straightJoints) {
      const fixedX = tiedTo('x', j.m, j.A) || tiedTo('x', j.m, j.B);
      const fixedY = tiedTo('y', j.m, j.A) || tiedTo('y', j.m, j.B);
      const P = nodeMap.get(j.A), Q = nodeMap.get(j.B);
      const steep = Math.abs(Q.y - P.y) >= Math.abs(Q.x - P.x);
      j.axis = fixedY && !fixedX ? 'x' : fixedX && !fixedY ? 'y' : steep ? 'x' : 'y';
    }
  }
  // → [{ m, A, B, lam }] for one axis from the estimates in `pos`
  const jointRows = (axis, pos) => {
    const other = axis === 'x' ? 'y' : 'x';
    const out = [];
    for (const j of straightJoints) {
      if (j.axis !== axis) continue;
      const A = pos.get(j.A), B = pos.get(j.B), M = pos.get(j.m);
      if (!A || !B || !M) continue;
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (!(L > EPS)) continue;
      const span = B[other] - A[other];
      let lam = Math.abs(span) > EPS ? (M[other] - A[other]) / span : NaN;
      if (!isFinite(lam)) lam = ((M.x - A.x) * (B.x - A.x) + (M.y - A.y) * (B.y - A.y)) / (L * L);
      if (!isFinite(lam)) continue;
      out.push({ ...j, lam: Math.min(1, Math.max(0, lam)) });
    }
    return out;
  };
  let joints = { x: [], y: [] };
  const coupled = diagonalRuns.length > 0 || straightJoints.length > 0;

  // Measured sides next to a diagonal wall, diagonal values with rows and straight diagonal joints
  // need more than one pass.
  // A window / door with a typed width on a diagonal wall piece (round 5, below) is bounded from the other axis's
  // projection as the passes find it.
  const diagOpenings = measured.length > 0 && typedOpenings.some((o) => { const e = edgeMap.get(o.edge); return !!e && e.orient === 'd'; });
  const needsPasses = coupled || diagOpenings || measured.some(({ dr, i, drB, iB }) => {
    const { prev } = cornerContext(dr.sides, i, edgeMap);
    const { next } = cornerContext(drB.sides, iB, edgeMap);
    return !isOblique(dr.sides[i]) && (isOblique(prev) || isOblique(next));
  });
  const maxPasses = !needsPasses ? 1 : coupled ? MAX_DIAGONAL_PASSES : MAX_ANGLE_PASSES;

  let axes = {}, positions = null, thickness = null, finish = null;
  let iterations = 0, orderRows = 0, passes = 0, settled = !needsPasses, lastMoved = 0;
  let prevStep = null; // the last pass's node moves (relaxation, below)
  for (let pass = 0; pass < maxPasses; pass++) {
    passes++;
    if (jointSolve) {
      // Both axes in one system, every row from the current estimates.
      diagTargets = { x: diagonalTargets('x', posNow), y: diagonalTargets('y', posNow), xy: diagonalLengthRows(posNow) };
      joints = { x: jointRows('x', posNow), y: jointRows('y', posNow) };
      const r = solveAxes(['x', 'y']);
      axes = { x: axisView(r, 'x'), y: axisView(r, 'y', false) };
    } else {
      // Diagonal rows: x from the current estimates, then y with the x just solved (Gauss–Seidel).
      diagTargets = { x: diagonalTargets('x', posNow), y: new Map(), xy: new Map() };
      joints = { x: jointRows('x', posNow), y: [] };
      const ax = solveAxis('x');
      if (coupled) {
        const posX = new Map();
        for (const [id, p] of posNow) posX.set(id, { x: ax.x[ax.gOf(id)], y: p.y });
        diagTargets.y = diagonalTargets('y', posX);
        joints.y = jointRows('y', posX);
      }
      axes = { x: ax, y: solveAxis('y') };
    }
    iterations += axes.x.rounds + axes.y.rounds;
    orderRows = axes.x.orderRows + axes.y.orderRows;
    ({ positions, thickness, finish } = assemble(axes));
    if (!needsPasses) break;
    let moved = 0;
    for (const [id, p] of positions) {
      const q = posNow.get(id);
      if (q) moved = Math.max(moved, Math.abs(p.x - q.x), Math.abs(p.y - q.y));
    }
    lastMoved = moved;
    if (moved < (coupled ? DIAGONAL_SETTLED_MM : ANGLE_SETTLED_MM)) {
      posNow = positions; tNow = thickness; fNow = finish;
      settled = true;
      break;
    }
    // The next pass's angles and corner offsets come from these estimates. With diagonal rows (coupled),
    // where the passes turn round without getting shorter, the next estimate is halfway (damped).
    // (Round 2, 2026-10-31: the extrapolation added in round 1 for passes that creep on the same way, up
    // to 10 steps ahead, is gone: on plans with several diagonals it ran ahead and did not come back —
    // 사선 벽 예시 with tape values 22 of 40 with false 확인필요 instead of 16, the plan 342 mm off instead of
    // 220 — and B6 settles without it once its T parts are locators.)
    const step = new Map();
    let dotSum = 0, n1 = 0, n0 = 0;
    for (const [id, p] of positions) {
      const q = posNow.get(id);
      if (!q) continue;
      const v = { x: p.x - q.x, y: p.y - q.y };
      step.set(id, v);
      const u = prevStep && prevStep.get(id);
      if (u) { dotSum += u.x * v.x + u.y * v.y; n0 += u.x * u.x + u.y * u.y; }
      n1 += v.x * v.x + v.y * v.y;
    }
    let k = 0;
    if (coupled && pass >= RELAX_FROM_PASS && prevStep && n0 > 0 && n1 > 0) {
      const cos = dotSum / Math.sqrt(n0 * n1), r = Math.sqrt(n1 / n0);
      if (cos < 0.5 && r > 0.6) k = -0.5;
    }
    prevStep = step;
    const blend = (cur, prev) => {
      if (!k) return cur;
      const out = new Map();
      for (const [id, v] of cur) {
        const p = prev.get(id);
        out.set(id, typeof v === 'number' ? (isFinite(p) ? v + k * (v - p) : v) : p ? { x: v.x + k * (v.x - p.x), y: v.y + k * (v.y - p.y) } : v);
      }
      return out;
    };
    posNow = blend(positions, posNow);
    tNow = blend(thickness, tNow);
    fNow = blend(finish, fNow);
  }

  function assemble(ax) {
    const pos = new Map();
    for (const nd of nodes) pos.set(nd.id, { x: ax.x.x[ax.x.gOf(nd.id)], y: ax.y.x[ax.y.gOf(nd.id)] });
    const th = new Map();
    for (const e of edges) {
      let t = priors.get(e.id) || 0;
      if (e.kind !== 'divider') {
        const a = e.orient === 'v' ? ax.x : e.orient === 'h' ? ax.y : null;
        if (a && a.tIdx.has(e.id)) t = a.x[a.tIdx.get(e.id)];
      }
      th.set(e.id, t);
    }
    const fin = new Map();
    for (const dr of derivedRooms || []) {
      for (const s of dr.sides) {
        const key = `${dr.roomId}:${s.key}`;
        const a = s.orient === 'v' ? ax.x : s.orient === 'h' ? ax.y : null;
        fin.set(key, a && a.fIdx.has(key) ? a.x[a.fIdx.get(key)] : 0);
      }
    }
    return { positions: pos, thickness: th, finish: fin };
  }

  // One axis system as before (the x and y unknowns share nothing), or both in ONE system when diagonal
  // values with neither projection fixed couple them (a length row over both axes). With one axis the
  // rows, unknowns and their order are exactly those of the separate solve.
  function solveAxis(axis) {
    return axisView(solveAxes([axis]), axis);
  }
  // The per-axis result the rest of solve() reads, from solveAxes (several views share one vector).
  function axisView(r, axis, first = true) {
    const mine = (list) => list.filter((c) => c.axis === axis).map(({ axis: _, ...rest }) => rest);
    return {
      x: r.x, gOf: r.gOf[axis], tIdx: r.tIdx, fIdx: r.fIdx, measureSoft: r.measureSoft, nVars: r.nVars,
      rounds: first ? r.rounds : 0, orderRows: r.orderRows[axis] || 0,
      conflicts: mine(r.conflicts), folds: mine(r.folds), gaps: mine(r.gaps), openingFits: mine(r.openingFits),
    };
  }

  function solveAxes(list) {
    const AX = {}; // per axis: { uf, along, across, sk, gOf }
    const groupSum = [], groupCnt = [], groupNodes = [];
    let n = 0;
    for (const axis of list) {
      const uf = axis === 'x' ? ufX : ufY;
      const groupIdx = new Map();
      for (const nd of nodes) {
        const g = uf.find(nd.id);
        if (!groupIdx.has(g)) { groupIdx.set(g, n++); groupSum.push(0); groupCnt.push(0); groupNodes.push([]); }
        const k = groupIdx.get(g);
        groupSum[k] += nd[axis];
        groupCnt[k] += 1;
        groupNodes[k].push(nd.id);
      }
      AX[axis] = {
        uf,
        along: axis === 'x' ? 'h' : 'v',  // measured sides / edges spanning this axis
        across: axis === 'x' ? 'v' : 'h', // walls whose thickness acts along this axis
        sk: axis,
        gOf: (nodeId) => groupIdx.get(uf.find(nodeId)),
      };
    }
    const nGroups = n;
    const tIdx = new Map(), fIdx = new Map();
    // Every edge of a straight wall run maps to the run's one thickness unknown (see wallRuns).
    const tVar = (e) => {
      if (!tIdx.has(e.id)) {
        const k = n++;
        for (const id of runMembers.get(wallRuns.find(e.id)) || [e.id]) tIdx.set(id, k);
      }
      return tIdx.get(e.id);
    };
    const fVar = (key) => { if (!fIdx.has(key)) fIdx.set(key, n++); return fIdx.get(key); };

    const sys = new NormalSystem();
    const measureSoft = new Map(); // measureId → [{ idx, c, prior }]
    const measureRows = [];        // [{ id, terms, rhs, soft, ga, gb (corner groups) }]: who had to give
    // Coordinate groups whose distance a chain of measured rows fixes (up to the assumed walls): an
    // opening bound never stretches such a stretch.
    const tied = new UnionFind();

    for (const axis of list) {
    const { along, across, gOf } = AX[axis];
    for (const { m, dr, i, drB, iB } of measured) {
      const side = dr.sides[i];
      const sideB = drB.sides[iB]; // the same side, or a span's last part (same line, same direction)
      if (side.orient !== along) continue;
      const d = side.dir[axis]; // ±1
      const row = new Map();
      addTerm(row, gOf(sideB.to), d);
      addTerm(row, gOf(side.from), -d);
      let rhs = m.value;
      const soft = [];
      const { prev, edgeA, ownA } = cornerContext(dr.sides, i, edgeMap);
      const { next, edgeB, ownB } = cornerContext(drB.sides, iB, edgeMap);
      // inner length = d·(X_to − X_from) + sB − sA, with s = kAdj·o_adj + kSide·o_own (cornerCoeffs).
      // sign = −1 for the corner at A, +1 at B. roomId / ownSide: the room and side at that corner.
      const corner = (sign, adj, edge, own, roomId, ownSide) => {
        const cc = cornerCoeffs(side.dir, side.inwardNormal, sideFrame(adj, posNow).normal);
        const c = sign * cc.kAdj;
        if (Math.abs(c) > 1e-9 && edge && edge.kind !== 'divider') {
          if (edge.orient === across) {
            const k = tVar(edge);
            addTerm(row, k, c / 2);
            soft.push({ idx: k, c: c / 2, prior: priors.get(edge.id) });
          } else {
            rhs -= c * (tNow.get(edge.id) || 0) / 2;
          }
          if (adj.orient === across) {
            const k = fVar(`${roomId}:${adj.key}`);
            addTerm(row, k, c);
            soft.push({ idx: k, c, prior: 0 });
          }
        }
        // The side's own inner face only matters at a corner that is not a right angle. Its wall and
        // finish belong to the other axis system: use the current estimate.
        const cs = sign * cc.kSide;
        if (Math.abs(cs) > 1e-9 && own && own.kind !== 'divider') {
          rhs -= cs * ((tNow.get(own.id) || 0) / 2 + (fNow.get(`${roomId}:${ownSide.key}`) || 0));
        }
      };
      corner(-1, prev, edgeA, ownA, dr.roomId, side);
      corner(1, next, edgeB, ownB, drB.roomId, sideB);
      const rowTerms = terms(row);
      sys.row(rowTerms, rhs, SOLVER_WEIGHTS.measure, 'm');
      measureSoft.set(m.id, soft);
      measureRows.push({ id: m.id, terms: rowTerms, rhs, soft, ga: gOf(side.from), gb: gOf(sideB.to) });
      tied.union(gOf(sideB.to), gOf(side.from));
    }
    }
    // Measured diagonal sides that fix a projection on this axis (diagonalTargets): B − A = target, as
    // hard as a measured side. They tie their groups like one (opening bounds, chainRows).
    for (const axis of list) {
    const { gOf } = AX[axis];
    for (const g of diagonalRuns) {
      const target = diagTargets[axis].get(g);
      if (!target || !isFinite(target.rhs) || !isFinite(target.c) || Math.abs(target.c) < 1e-9) continue;
      const ga = gOf(g.A), gb = gOf(g.B);
      if (ga === gb) continue;
      const rowTerms = [[gb, target.c], [ga, -target.c]];
      const rhs = target.rhs;
      sys.row(rowTerms, rhs, g.locator ? LOCATOR_WEIGHT : SOLVER_WEIGHTS.measure, 'm');
      measureRows.push({ id: g.m.id, terms: rowTerms, rhs, soft: [], ga, gb });
      tied.union(ga, gb);
    }
    }
    // Diagonal values with neither projection fixed, in the joint system (diagTargets.xy): the length
    // along the current direction, d·(B − A) = v − δ, one row over both axes; the direction itself is
    // left to the rest of the plan. It ties both axes' groups.
    if (AX.x && AX.y) {
      for (const g of diagonalRuns) {
        const target = diagTargets.xy && diagTargets.xy.get(g);
        if (!target || !isFinite(target.rhs)) continue;
        const gx = [AX.x.gOf(g.A), AX.x.gOf(g.B)], gy = [AX.y.gOf(g.A), AX.y.gOf(g.B)];
        const row = new Map();
        addTerm(row, gx[1], target.cx); addTerm(row, gx[0], -target.cx);
        addTerm(row, gy[1], target.cy); addTerm(row, gy[0], -target.cy);
        const rowTerms = terms(row).filter(([, c]) => Math.abs(c) > 1e-12);
        if (!rowTerms.length) continue;
        sys.row(rowTerms, target.rhs, g.locator ? LOCATOR_WEIGHT : SOLVER_WEIGHTS.measure, 'm');
        for (const [ga, gb] of [gx, gy]) {
          if (ga === gb) continue;
          measureRows.push({ id: g.m.id, terms: rowTerms, rhs: target.rhs, soft: [], ga, gb });
          tied.union(ga, gb);
        }
      }
    }
    // Straight diagonal joints (jointRows): the corner stays on its wall's line, as hard as a value.
    for (const axis of list) {
    const { gOf } = AX[axis];
    for (const j of joints[axis]) {
      const row = new Map();
      addTerm(row, gOf(j.m), 1);
      addTerm(row, gOf(j.A), -(1 - j.lam));
      addTerm(row, gOf(j.B), -j.lam);
      const rowTerms = terms(row).filter(([, c]) => Math.abs(c) > 1e-12);
      if (rowTerms.length) sys.row(rowTerms, 0, SOLVER_WEIGHTS.measure, 'c');
    }
    }

    // Priors: one row per thickness unknown. A straight run is one wall (its edges have the same prior
    // and kind), so it costs as much to change as a single edge did.
    const priorDone = new Set();
    for (const [edgeId, k] of tIdx) {
      if (priorDone.has(k)) continue;
      priorDone.add(k);
      const e = edgeMap.get(edgeId);
      const w = e.thickness != null ? SOLVER_WEIGHTS.thicknessMeasured
        : exterior.has(edgeId) ? SOLVER_WEIGHTS.thicknessExterior : SOLVER_WEIGHTS.thicknessDefault;
      sys.row([[k, 1]], priors.get(edgeId), w, 'p');
    }
    for (const [key, k] of fIdx) {
      sys.row([[k, 1]], 0, finishWeight(key.slice(0, key.indexOf(':'))), 'f');
    }

    // Weak sketch proportions.
    const sketchAlongOf = (sk) => (e) => (e.sketch ? (sk === 'x' ? e.sketch.dx : e.sketch.dy) : null);
    for (const axis of list) {
    const { across, gOf, sk } = AX[axis];
    const sketchAlong = sketchAlongOf(sk);
    for (const e of edges) {
      if (e.orient === across || !nodeMap.has(e.a) || !nodeMap.has(e.b)) continue;
      const ga = gOf(e.a), gb = gOf(e.b);
      if (ga === gb) continue;
      const s = e.sketch ? sketchAlong(e) : (nodeMap.get(e.b)[axis] - nodeMap.get(e.a)[axis]) / scale;
      sys.row([[gb, 1], [ga, -1]], scale * s, SOLVER_WEIGHTS.sketch, 's');
    }
    }

    // Gauge.
    for (let k = 0; k < nGroups; k++) sys.row([[k, 1]], groupSum[k] / groupCnt[k], SOLVER_WEIGHTS.gauge, 'g');

    // One-sided rows (see the header): Σ c·x ≥ min, held with weight w while active.
    const cons = [];
    // Lower bounds: finish ≥ 0; thickness ≥ MIN_WALL_MM (a measured wall thinner than that keeps its
    // own value as the bound). The edges of one straight run share one unknown, so one bound each.
    const boundDone = new Set();
    for (const [edgeId, k] of tIdx) {
      if (boundDone.has(k)) continue;
      boundDone.add(k);
      const e = edgeMap.get(edgeId);
      const prior = priors.get(edgeId) || 0;
      const min = e.thickness != null ? Math.max(0, Math.min(MIN_WALL_MM, prior)) : Math.min(MIN_WALL_MM, prior);
      cons.push({ type: 'bound', terms: [[k, 1]], min, w: SOLVER_WEIGHTS.bound });
    }
    for (const k of fIdx.values()) cons.push({ type: 'bound', terms: [[k, 1]], min: 0, w: SOLVER_WEIGHTS.bound });
    // Edges between the same two lines (a room's top and bottom wall across the same step) give the
    // same row: one row per line pair and kind keeps the largest minimum. Two equal rows would each hold
    // the edge without the other, and neither would show what it cost.
    const byPair = new Map();
    const onePerPair = (c, ga, gb, sign) => {
      const k = ga < gb ? `${c.type}|${ga}|${gb}|${sign}` : `${c.type}|${gb}|${ga}|${-sign}`; // b−a ≥ m ≡ −(a−b) ≥ m
      const had = byPair.get(k);
      if (had && had.min >= c.min) return;
      if (had) cons.splice(cons.indexOf(had), 1);
      byPair.set(k, c);
      cons.push(c);
    };
    // Order: every h/v edge spanning this axis keeps its drawn direction; so does a diagonal edge on
    // both axes (2026-10-19: a diagonal value 10× too small turned a bay's diagonal inside out, and the
    // walls kept no order to name the value by).
    for (const axis of list) {
    const { along, gOf, sk } = AX[axis];
    const sketchAlong = sketchAlongOf(sk);
    for (const e of edges) {
      if ((e.orient !== along && e.orient !== 'd') || !nodeMap.has(e.a) || !nodeMap.has(e.b)) continue;
      const ga = gOf(e.a), gb = gOf(e.b);
      const sign = Math.sign(sketchAlong(e) || 0);
      if (ga === gb || !sign) continue;
      const drawn = scale * Math.abs(sketchAlong(e));
      onePerPair({ type: 'order', axis, edgeId: e.id, ga, gb, terms: [[gb, sign], [ga, -sign]], min: Math.min(MIN_EDGE, 0.5 * drawn), drawn, w: SOLVER_WEIGHTS.order }, ga, gb, sign);
    }
    }
    // Openings with a typed width on a wall piece no measure fixes (see the header). Only once a value
    // gives the plan its scale: before that the sketch is in drawn units, and a window would stretch a
    // wall that the first value then rescales anyway.
    for (const axis of list) {
    const { along, gOf, sk } = AX[axis];
    const sketchAlong = sketchAlongOf(sk);
    const other = axis === 'x' ? 'y' : 'x';
    for (const o of measured.length ? typedOpenings : []) {
      const e = edgeMap.get(o.edge);
      // A diagonal wall piece no value measures whose projection on the OTHER axis the axis values fix, and on this
      // one do not (round 5, 2026-11-08: a window typed wider than an unmeasured chamfer was only '창이 벽보다 김'):
      // this projection ≥ √(min² − the fixed one²), from the current estimate of the fixed one (as a measured
      // diagonal's row, again each pass). Both free, or both fixed: nothing, as before.
      if (e && e.kind !== 'divider' && e.orient === 'd' && nodeMap.has(e.a) && nodeMap.has(e.b) && !measuredDiagEdges.has(e.id)) {
        const ga = gOf(e.a), gb = gOf(e.b);
        const sign = Math.sign(sketchAlong(e) || 0);
        if (ga === gb || !sign || tied.find(ga) === tied.find(gb) || axisTied(axis, e.a, e.b) || !axisTied(other, e.a, e.b)) continue;
        const A = posNow.get(e.a), B = posNow.get(e.b);
        const fixed = A && B ? Math.abs(B[other] - A[other]) : NaN;
        const min = o.width + jambClearance(e, e.a) + jambClearance(e, e.b) + 2 * OPENING_JAMB_MM;
        if (!isFinite(fixed) || min <= fixed) continue;
        onePerPair({ type: 'opening', axis, openingId: o.id, edgeId: e.id, terms: [[gb, sign], [ga, -sign]], min: Math.sqrt(min * min - fixed * fixed), fixed, w: SOLVER_WEIGHTS.opening }, ga, gb, sign);
        continue;
      }
      if (!e || e.kind === 'divider' || e.orient !== along || !nodeMap.has(e.a) || !nodeMap.has(e.b)) continue;
      // The straight run through corners only 구역 나누기 lines reach (as openings.js edgeFrame).
      const ra = straightRunEnd(e, e.a), rb = straightRunEnd(e, e.b);
      const ga = gOf(ra.node), gb = gOf(rb.node);
      const sign = Math.sign(sketchAlong(e) || 0);
      if (ga === gb || !sign || tied.find(ga) === tied.find(gb)) continue;
      const min = o.width + jambClearance(ra.edge, ra.node) + jambClearance(rb.edge, rb.node) + 2 * OPENING_JAMB_MM;
      onePerPair({ type: 'opening', axis, openingId: o.id, edgeId: e.id, terms: [[gb, sign], [ga, -sign]], min, w: SOLVER_WEIGHTS.opening }, ga, gb, sign);
    }
    }

    // Measured rows on a shortest chain of measures between coordinate groups g0 and g1 (each row ties
    // the groups of its two corners). → [measure ids]
    const chainRows = (g0, g1) => {
      const adj = new Map();
      for (const r of measureRows) {
        if (r.ga === r.gb) continue;
        for (const [u, v] of [[r.ga, r.gb], [r.gb, r.ga]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u).push(v); }
      }
      const bfs = (start) => {
        const d = new Map([[start, 0]]);
        for (const q = [start]; q.length;) {
          const u = q.shift();
          for (const v of adj.get(u) || []) if (!d.has(v)) { d.set(v, d.get(u) + 1); q.push(v); }
        }
        return d;
      };
      const d0 = bfs(g0), d1 = bfs(g1);
      if (!d0.has(g1)) return [];
      const D = d0.get(g1), at = (d, g) => (d.has(g) ? d.get(g) : Infinity);
      return measureRows.filter((r) => r.ga !== r.gb
        && (at(d0, r.ga) + 1 + at(d1, r.gb) === D || at(d0, r.gb) + 1 + at(d1, r.ga) === D)).map((r) => r.id);
    };
    const rowOf = (c) => ({ terms: c.terms, rhs: c.min, w: c.w });
    const forceOf = (c, xs) => c.w * (c.min - rowValue(c.terms, xs)); // > 0: the row holds the edge up
    const active = new Set(), released = new Set(), dropped = new Set();
    let x = sys.solve(n, nGroups);
    let rounds = 1;
    // Active set: add the rows that are violated; when none is, release the order / opening rows the
    // solve pulls above their minimum (each at most once, so it cannot cycle; bound pins stay, see the
    // header), and re-solve.
    const settle = () => {
      for (let round = 0; round < MAX_ORDER_ROUNDS; round++) {
        let changed = false;
        for (const c of cons) {
          if (active.has(c) || dropped.has(c) || rowValue(c.terms, x) >= c.min - 1e-6) continue;
          active.add(c);
          changed = true;
        }
        if (!changed) {
          for (const c of [...active]) {
            if (c.type === 'bound' || released.has(c) || forceOf(c, x) > -RELEASE_FORCE) continue;
            active.delete(c);
            released.add(c);
            changed = true;
          }
        }
        if (!changed) break;
        x = sys.solve(n, nGroups, [...active].map(rowOf));
        rounds++;
      }
    };
    // Hard-only solve (no sketch rows; the gauge holds every coordinate at the solution x) with the
    // given one-sided rows.
    let gaugeAtX = null;
    const hardSolve = (set) => {
      if (!gaugeAtX) {
        gaugeAtX = [];
        for (let k = 0; k < nGroups; k++) gaugeAtX.push({ terms: [[k, 1]], rhs: x[k], w: SOLVER_WEIGHTS.gauge });
      }
      return sys.solve(n, nGroups, gaugeAtX.concat([...set].map(rowOf)), 'sg');
    };
    // The active order / opening rows the measures, walls or finishes push against.
    const pushedByValues = () => {
      gaugeAtX = null;
      if (![...active].some((c) => c.type !== 'bound')) return new Set();
      const xB = hardSolve(active);
      return new Set([...active].filter((c) => c.type !== 'bound' && forceOf(c, xB) > REAL_FORCE));
    };
    // Does opening row c press another wall piece below OPENING_SQUEEZE of its drawn length (which it
    // was not without c)? The drawing then leaves no room for the window. (Without c, the order rows
    // are left out too: one may hold that piece only because c pressed it.)
    const orders = cons.filter((c) => c.type === 'order');
    const squeezes = (c) => {
      const others = [...active].filter((o) => o !== c && o.type !== 'order');
      const x0 = sys.solve(n, nGroups, others.map(rowOf));
      return orders.some((o) => {
        if (o.edgeId === c.edgeId) return false;
        const now = rowValue(o.terms, x), before = rowValue(o.terms, x0), floor = OPENING_SQUEEZE * o.drawn;
        return now < floor && before >= floor - 1e-6 && now < before - 1;
      });
    };
    settle();
    let real = pushedByValues();
    // An opening bound may only move what no measure fixes, and only take what the drawing leaves: one
    // the values push against, or one that squeezes another wall piece (예시 세대 A field test: A34's 1000
    // typed before A13 stretched the 430 step and pressed 베란다1's left part to 90 mm, its walls into
    // each other), is dropped; the check then says the window is wider than its wall.
    for (let k = 0; k < MAX_RESOLVES; k++) {
      const bad = [...active].filter((c) => c.type === 'opening' && (real.has(c) || squeezes(c)));
      if (!bad.length) break;
      for (const c of bad) { dropped.add(c); active.delete(c); }
      x = sys.solve(n, nGroups, [...active].map(rowOf));
      rounds++;
      settle();
      real = pushedByValues();
    }

    const conflicts = [], folds = [], gaps = [], openingFits = [];
    const orderCount = {};
    const xB = real.size ? hardSolve(active) : null;
    for (const c of active) {
      if (c.type === 'order') orderCount[c.axis] = (orderCount[c.axis] || 0) + 1;
      if (c.type === 'order' && real.has(c)) {
        // Without this row (the others kept), the hard rows alone put the edge `amount` below its
        // minimum: that is what the walls and values took instead.
        const others = new Set(active);
        others.delete(c);
        const xA = hardSolve(others);
        const amount = c.min - rowValue(c.terms, xA);
        if (!(amount > 1e-3)) continue;
        // The values that contradict the drawn order: the measured rows on the shortest chains of
        // measures between the edge's two lines (예시 세대 A A15 2900: 방2 2900 against 주방 / 방3 2800 / 2700;
        // values elsewhere on the same lines only share a wall that grew), most changed first (residual
        // + absorbed change of the row). With no such chain (several gaps squeezed together), the rows
        // that changed most.
        const give = new Map(measureRows.map((r) => {
          const res = (xs) => rowValue(r.terms, xs) - r.rhs;
          const abs = (xs) => r.soft.reduce((s, q) => s + q.c * (xs[q.idx] - q.prior), 0);
          return [r.id, Math.abs(res(xB) - res(xA)) + Math.abs(abs(xB) - abs(xA))];
        }));
        const byGive = (ids) => ids.sort((p, q) => give.get(q) - give.get(p));
        let measureIds = byGive([...new Set(chainRows(c.ga, c.gb))]);
        if (!measureIds.length) {
          const all = byGive([...give.keys()]);
          const top = all.length ? give.get(all[0]) : 0;
          measureIds = all.filter((id) => give.get(id) > Math.max(1, 0.25 * top));
        }
        // Further back than its drawn length: the values reverse the drawn order (a fold), not only
        // squeeze a short step. A fold no value can be named for stays a conflict on the edge.
        (amount > c.drawn && measureIds.length ? folds : conflicts).push({ edgeId: c.edgeId, amount, measureIds, axis: c.axis });
      } else if (c.type === 'order') {
        gaps.push({ edgeId: c.edgeId, nodesA: groupNodes[c.ga], nodesB: groupNodes[c.gb], length: rowValue(c.terms, x), axis: c.axis });
      } else if (c.type === 'opening' && !real.has(c)) {
        const others = new Set(active);
        others.delete(c);
        const x0 = sys.solve(n, nGroups, [...others].map(rowOf));
        // (A diagonal piece's row bounds one projection: the length it gained, with the other one fixed.)
        const amount = isFinite(c.fixed) ? Math.hypot(rowValue(c.terms, x), c.fixed) - Math.hypot(rowValue(c.terms, x0), c.fixed)
          : rowValue(c.terms, x) - rowValue(c.terms, x0);
        if (amount > 0.5) openingFits.push({ openingId: c.openingId, edgeId: c.edgeId, amount, axis: c.axis });
      }
    }
    // Exact bounds (the pins are strong rows, not hard constraints).
    for (const c of active) if (c.type === 'bound' && x[c.terms[0][0]] < c.min) x[c.terms[0][0]] = c.min;

    const gOf = {};
    for (const axis of list) gOf[axis] = AX[axis].gOf;
    return { x, gOf, tIdx, fIdx, measureSoft, nVars: n, rounds, orderRows: orderCount, conflicts, folds, gaps, openingFits };
  }

  // Residuals use the final geometry (exact corner formula, final angles).
  const measureResiduals = new Map(), absorbed = new Map();
  // softTerms: what each measure's absorbed sum is made of, by wall and finish (solutionAt sums it again
  // for other walls and finishes): Map measureId → [{ c, prior, edgeId | finishKey }].
  const softTerms = new Map();
  const reverse = new Map();
  const unknownsOf = (ax) => {
    if (!reverse.has(ax)) {
      const t = new Map(), f = new Map();
      for (const [id, k] of ax.tIdx) if (!t.has(k)) t.set(k, id);
      for (const [key, k] of ax.fIdx) if (!f.has(k)) f.set(k, key);
      reverse.set(ax, { t, f });
    }
    return reverse.get(ax);
  };
  for (const { m, dr, i, drB, iB } of measured) {
    measureResiduals.set(m.id, residualOf(m, dr, i, drB, iB, edgeMap, positions, thickness, finish));
    const side = dr.sides[i];
    const ax = side.orient === 'h' ? axes.x : side.orient === 'v' ? axes.y : null;
    const soft = ax && ax.measureSoft.get(m.id);
    if (soft) {
      let sum = 0;
      for (const { idx, c, prior } of soft) sum += c * (ax.x[idx] - prior);
      absorbed.set(m.id, Math.abs(sum));
      const u = unknownsOf(ax);
      softTerms.set(m.id, soft.map(({ idx, c, prior }) => (u.t.has(idx) ? { c, prior, edgeId: u.t.get(idx) } : { c, prior, finishKey: u.f.get(idx) })));
    }
  }

  // The chain test of a diagonal that is only a check (round 4, 2026-11-01). Its misfit can come from any
  // axis value on a chain between its two ends, not only from those on EVERY chain (`with`): B1 with 거실
  // 왼쪽 벽 5100 typed 5300, in a loop with 방1 / 화장실 오른쪽 벽 and 210 mm off (under the loop tolerance),
  // made the cut corner 157 mm long; '함께 볼 값' named only the three correct values on every chain, after
  // the diagonal was confirmed they were named again, and 5300 printed silently. With the assumed walls (as
  // valueLoops) each axis's values are fitted (least squares) with all of them and without each one on a
  // chain between the ends. res: the diagonal's misfit without that value (one on every chain: 0 whenever
  // the value can be what the diagonal asks; one in a loop: what the rest of its loop says); rest: what the
  // loop values on the chains still disagree by without it (B1: the loop's 210 mm spread over its rows
  // without a value on every chain, ~0 without 5300). model.js computeWarnings names the values that make
  // the diagonal fit, the one that leaves the least first. Only for a misfit over CHAIN_TEST_MIN_MM.
  // → { chain: [{ id, bridge, res, rest }], rest (with every value), res (the misfit with every value) } | null
  let modelRows = null, modelGroups = null;
  const buildModelRows = () => {
    modelRows = { x: [], y: [] };
    for (const { m, parts } of measured) {
      const s0 = parts[0].dr.sides[parts[0].i], s1 = parts[parts.length - 1].dr.sides[parts[parts.length - 1].i];
      if ((s0.orient !== 'h' && s0.orient !== 'v') || s1.orient !== s0.orient) continue;
      const axis = s0.orient === 'h' ? 'x' : 'y';
      const uf = axis === 'x' ? ufX : ufY;
      const ga = uf.find(s0.from), gb = uf.find(s1.to);
      const sign = Math.sign(s0.dir[axis]);
      if (ga === gb || !sign) continue;
      const { term } = sketchSpanParts(parts.map((p) => ({ sides: p.dr.sides, i: p.i })), edgeMap, priors);
      modelRows[axis].push({ id: m.id, ga, gb, D: sign * (m.value - term) });
    }
    modelGroups = { x: [...new Set(modelRows.x.flatMap((r) => [r.ga, r.gb]))], y: [...new Set(modelRows.y.flatMap((r) => [r.ga, r.gb]))] };
  };
  const joinedWithout = (rows, skip, ga, gb) => {
    if (ga === gb) return true;
    const seen = new Set([ga]);
    for (const queue = [ga]; queue.length;) {
      const u = queue.pop();
      for (const r of rows) {
        if (r === skip || (r.ga !== u && r.gb !== u)) continue;
        const v = r.ga === u ? r.gb : r.ga;
        if (v === gb) return true;
        if (!seen.has(v)) { seen.add(v); queue.push(v); }
      }
    }
    return false;
  };
  const r2 = (v) => Math.round(v * 100) / 100;
  // a, b: the diagonal's (or its whole line's) end corners; runs: its measured run(s) (a line: every part).
  const chainTest = (a, b, runs) => {
    if (!modelRows) buildModelRows();
    const P = positions.get(a), Q = positions.get(b);
    if (!P || !Q) return null;
    const L = Math.hypot(Q.x - P.x, Q.y - P.y);
    let inner = 0, cover = 0, value = 0;
    for (const g of runs) {
      const li = innerLengthBetween({ sides: g.dr.sides, i: g.i, roomId: g.dr.roomId }, { sides: g.drB.sides, i: g.iB, roomId: g.drB.roomId },
        edgeMap, positions, priors, null);
      const A1 = positions.get(g.A), B1 = positions.get(g.B);
      if (!isFinite(li) || !A1 || !B1) return null;
      inner += li;
      value += g.m.value;
      cover += Math.hypot(B1.x - A1.x, B1.y - A1.y);
    }
    // A line with a part not measured: the sum of its parts is no check of the whole line.
    if (!(L > EPS) || Math.abs(cover - L) > 1) return null;
    const want = value - (inner - L); // the centre length the value(s) ask for, with the assumed walls
    // The misfit for centre projections p ({ x, y }; null: free, the diagonal fixes it).
    const misfit = (p) => {
      if (p.x != null && p.y != null) return Math.hypot(p.x, p.y) - want;
      const q = p.x != null ? p.x : p.y;
      return q == null ? 0 : Math.max(0, Math.abs(q) - want);
    };
    const proj = { x: null, y: null }, fits = { x: null, y: null }, onChain = { x: [], y: [] };
    for (const axis of ['x', 'y']) {
      if (!axisTied(axis, a, b)) continue;
      const uf = axis === 'x' ? ufX : ufY;
      const ga = uf.find(a), gb = uf.find(b);
      const list = modelRows[axis];
      if (!joinedWithout(list, null, ga, gb)) continue;
      const all = loopFit(list, modelGroups[axis], null);
      if (!all) return null;
      proj[axis] = all.P.get(gb) - all.P.get(ga);
      fits[axis] = all;
      for (const r of list) {
        if (!joinedWithout(list, r, ga, gb)) { onChain[axis].push({ r, p: null, f: null }); continue; }
        const f = loopFit(list, modelGroups[axis], r);
        if (!f) continue;
        const p = f.P.get(gb) - f.P.get(ga);
        // A value in a loop on a chain between the ends: leaving it out moves the ends.
        if (Math.abs(p - proj[axis]) > 0.5) onChain[axis].push({ r, p, f });
      }
    }
    const loopIds = { x: onChain.x.filter((c) => c.p != null).map((c) => c.r.id), y: onChain.y.filter((c) => c.p != null).map((c) => c.r.id) };
    const disagree = (axis, f, skipId) => {
      let mx = 0;
      if (f) for (const id of loopIds[axis]) if (id !== skipId) mx = Math.max(mx, Math.abs(f.res.get(id) || 0));
      return mx;
    };
    const rest = Math.max(disagree('x', fits.x), disagree('y', fits.y));
    const chain = [];
    for (const axis of ['x', 'y']) {
      const other = axis === 'x' ? 'y' : 'x';
      for (const c of onChain[axis]) {
        chain.push({
          id: c.r.id, bridge: c.p == null, res: r2(misfit({ ...proj, [axis]: c.p })),
          rest: r2(c.p == null ? rest : Math.max(disagree(axis, c.f, c.r.id), disagree(other, fits[other]))),
        });
      }
    }
    return { chain, rest: r2(rest), res: r2(misfit(proj)) };
  };

  // What each measured diagonal value did (contract C2): tied = the projections the axis values fix;
  // rows = the axes it fixed itself ('' = a check only: both were fixed, or it is not longer than the
  // fixed projection). with: for a check (and a locator: its whole line), the axis values on every chain
  // between its two ends on the axes they tie (chainValues); chain / chainRest / chainRes: chainTest's (when it
  // misses).
  const diagonalRows = new Map();
  const lineRuns = new Map(); // a locator's line → its measured parts
  for (const g of diagonals) {
    if (!g.locator || !g.line) continue;
    if (!lineRuns.has(g.line)) lineRuns.set(g.line, []);
    lineRuns.get(g.line).push(g);
  }
  const tested = new Map(); // line | measure id → chainTest
  for (const g of diagonals) {
    const both = diagTargets.xy.has(g);
    const rows = (both || diagTargets.x.has(g) ? 'x' : '') + (both || diagTargets.y.has(g) ? 'y' : '');
    let withIds = [];
    let test = null;
    if (!rows || g.locator) {
      const [a, b] = g.locator && g.lineEnds ? g.lineEnds : [g.A, g.B];
      withIds = [...new Set(['x', 'y'].filter((axis) => axisTied(axis, a, b)).flatMap((axis) => chainValues(axis, a, b)))];
      const runs = g.locator && g.line ? lineRuns.get(g.line) : [g];
      const key = g.locator && g.line ? `line:${g.line}` : g.m.id;
      const miss = runs.reduce((s, q) => s + (measureResiduals.get(q.m.id) || 0), 0);
      if (!tested.has(key)) tested.set(key, Math.abs(miss) > CHAIN_TEST_MIN_MM ? chainTest(a, b, runs) : null);
      test = tested.get(key);
    }
    diagonalRows.set(g.m.id, {
      tied: { ...g.tied }, rows, ...(g.locator ? { locator: true, line: g.line } : {}), ...(withIds.length ? { with: withIds } : {}),
      ...(test ? { chain: test.chain, chainRest: test.rest, chainRes: test.res } : {}),
    });
  }

  const both = (key) => [...axes.x[key], ...axes.y[key]];
  return {
    positions, thickness, finish, scale, measureResiduals, absorbed, softTerms,
    // Map measureId → { tied: { x, y }, rows: '' | 'x' | 'y' | 'xy', locator?, line? (a locator's whole
    // straight line: its end corner ids), with? ([measureId]: the axis values on every chain between its
    // ends), chain? ([{ id, bridge, res, rest }]: every axis value on a chain between them, with what the
    // check misses by and what the chains disagree by without it), chainRest? / chainRes? (what the chains
    // disagree by and the check misses by in that fit with every value) }
    // for every measured diagonal side
    diagonalRows,
    // h/v edges the measures pushed below their minimum (they would have folded there): amount = mm
    // the walls and values took instead; measureIds = the values that had to give, most first.
    //   conflicts: squeezed; folds: pushed further back than the edge's drawn length (the values
    //   reverse the drawn order of two walls, DESIGN.md contract C1)
    conflicts: both('conflicts'),
    folds: both('folds'),
    // Edges kept in drawn order although only unmeasured coordinates moved for it (contract C3):
    // { edgeId, axis, nodesA, nodesB (nodes on the coordinate lines at the edge's ends a / b), length }
    gaps: [...axes.x.gaps.map((g) => ({ ...g, axis: 'x' })), ...axes.y.gaps.map((g) => ({ ...g, axis: 'y' }))],
    // Wall pieces lengthened so that a window / door of typed width fits (contract C2):
    // { openingId, edgeId, amount (mm longer than without the bound) }
    openingFits: both('openingFits'),
    info: { xVars: axes.x.nVars, yVars: axes.y.nVars, iterations, orderConstraints: orderRows, anglePasses: passes,
      settled, lastMoved, jointSolve },
  };
}
