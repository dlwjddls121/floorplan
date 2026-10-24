// The 지우개 tool's engine (user 2026-10-22: "원하는 벽, 창호, 문 등 지우개로 지우면 … 지우개에 닿는 곳만
// 지워지는 기능", "그냥 닿는 벽은 그 벽(일직선)은 다 없어지게 해줘", "딱 닿는것만 지워져야돼", "닿는 벽면, 닿는
// 창문 등"). Pure functions + a DocStore mixin; the tool itself is ui/eraser-ui.js.
//
//   eraserIndex(project, derived, { memo })   geometry of everything erasable, built once per gesture
//   eraserSizes(scale)                        the screen sizes below in world mm at a zoom
//   eraserTouch(index, p, sizes, prev)        what ONE eraser position touches (rule below)
//   touchAlong(index, points, sizes)          everything a whole path touches, as rubbing it would
//   straightRun(project, edgeId)              the whole straight wall (or 구역 나누기 line) of an edge
//   erasePlan(project, touched)               everything one gesture erases (runs, the windows / doors
//                                             in erased walls, …); the preview draws exactly this
//   DocStore.prototype.eraseItems(items)      the erase itself: ONE undo step (installErase)
//
// What one eraser position touches ("딱 닿는것만"). p = the eraser's CENTRE. Only the first rule that
// applies counts, so rubbing one thing never takes its neighbour as well:
//   1. a memo stroke whose ink is under p (+ LINE_ON_PX; memo is drawn over everything; never while the
//      memo is hidden);
//   2. else a window / door whose symbol — the cut it makes in the wall band, finish included, + SYMBOL_PAD
//      px — is under p: the opening, not its wall;
//   3. else a fixture (any type: free, against a wall, in a wall, 기둥, 계단) under p: not the wall behind;
//      only the one drawn on top where fixtures overlap (a 기둥 in a 옷장);
//   4. else a wall whose band — its drawn thickness and finish + WALL_PAD_PX — is under p, except along a
//      window / door cut. Near a corner or T (within the thickest wall's half + WALL_PAD_PX of the node)
//      the ink is shared: the wall the eraser was already rubbing keeps it; else a wall running on
//      through the node (a T's bar) keeps its own drawn band (the stem starts at its face); else the
//      wall(s) p lies in front of (a wall beyond a T only on its own side), the nearest centre line first;
//   5. else (p on the floor or outside the house): memo strokes within ERASER_PX (the 메모 eraser's reach),
//      a door's leaf and swing arc and 구역 나누기 lines (their part outside the walls) within LINE_REACH_PX,
//      a window / door cut and fixtures within AREA_REACH_PX.
// And a rub keeps to what it is rubbing: while p stays within STICK_PX of what the previous position
// touched, it touches only that again (the pen wobbling off a wall onto the floor, a door leaf along the
// wall's face, the sink in front of it or the next wall does not take them; going clearly onto them does).
// A touched wall goes as its whole straight wall (straightRun); everything else goes one by one. Room
// names, dimension numbers and labels are never erased.
import { removeEdges } from './graph.js';
import { placeOpening, slidingLeaves, wallThickness } from './openings.js';
import { normalizeFixture, fixtureBounds } from './fixtures.js';
import { validMemo, distanceToStroke, memoPaperWidth, WORLD_PER_PAPER_MM, isMemoHidden } from './memo.js';
import { finishBeside } from './dims.js';

export const ERASER_PX = 14;                      // eraser radius on screen (as the 메모 eraser): memo on the floor
export const WALL_PAD_PX = 4;                     // a wall's band: its drawn faces + this
export const SYMBOL_PAD_PX = { along: 4, across: 1 };   // a window / door symbol (as a tap on it, openings-ui)
export const LINE_ON_PX = 3;                      // the centre on a memo stroke's ink
export const LINE_REACH_PX = 8;                   // a door leaf / swing arc, a 구역 나누기 line, from the floor
export const AREA_REACH_PX = 4;                   // a window / door cut, a fixture box, from the floor
export const STICK_PX = 6;                        // a rub keeps to what it touched while this close to it
export const TIE_PX = 0.5;                        // centre lines this close count as equally near (a corner)
export const SAMPLE_PX = 2;                       // the eraser path is tested every SAMPLE_PX px

// Two diagonal edges continue one straight wall when their drawn (sketch) directions agree within 1° and
// the solved ones within 5° (rooms.js straightDiagonal); h / v edges when they are the same axis.
const SKETCH_STRAIGHT = Math.sin(Math.PI / 180);
const SOLVED_STRAIGHT = Math.sin(5 * Math.PI / 180);
const DOOR_BAND_RATIO = 0.5;   // door frame band / wall thickness (ui/draw-openings.js OPENING_STYLE.bandRatio)
const NOMINAL_WALL_MM = 100;   // an opening on a wall without thickness (draw-openings nominalWallMM)

const isNum = (v) => typeof v === 'number' && isFinite(v);
const hyp = Math.hypot;

// ---- straight runs -----------------------------------------------------------------------------------

function graphIndex(project) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const byNode = new Map();
  for (const e of project.edges || []) {
    for (const id of [e.a, e.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(e);
    }
  }
  return { nodes, edges, byNode };
}

// Unit vector of edge e pointing away from node `from` (solved geometry), or null.
function awayFrom(ix, e, from) {
  const A = ix.nodes.get(from), B = ix.nodes.get(e.a === from ? e.b : e.a);
  if (!A || !B) return null;
  const L = hyp(B.x - A.x, B.y - A.y);
  return L > 1e-9 ? { x: (B.x - A.x) / L, y: (B.y - A.y) / L } : null;
}

// Do edges e and f continue each other straight through node n?
function straightThrough(ix, e, f, n) {
  if (e.orient !== f.orient) return false;
  const u = awayFrom(ix, e, n), v = awayFrom(ix, f, n);
  if (!u || !v) return false;
  const dot = u.x * v.x + u.y * v.y;
  if (e.orient === 'h' || e.orient === 'v') return dot < 0;
  // Diagonals: as drawn (sketch, within 1°) and as solved (within 5°), as one room side would be.
  const cross = Math.abs(u.x * v.y - u.y * v.x);
  const s1 = sketchAway(e, n), s2 = sketchAway(f, n);
  if (!s1 || !s2) return dot < 0 && cross <= SKETCH_STRAIGHT;
  const l1 = hyp(s1.x, s1.y), l2 = hyp(s2.x, s2.y);
  const sCross = Math.abs(s1.x * s2.y - s1.y * s2.x) / (l1 * l2);
  return sCross <= SKETCH_STRAIGHT && s1.x * s2.x + s1.y * s2.y < 0 && dot < 0 && cross <= SOLVED_STRAIGHT;
}

function sketchAway(e, n) {
  const s = e.sketch;
  if (!s || !isNum(s.dx) || !isNum(s.dy) || hyp(s.dx, s.dy) < 1e-9) return null;
  return e.a === n ? { x: s.dx, y: s.dy } : { x: -s.dx, y: -s.dy };
}

// The edge that continues edge `cur` straight on through node n, or null:
//   wall: exactly one other WALL meets n (구역 나누기 lines meeting there do not count) and it continues
//         the line — a corner, a T, a turn or a loose end ends the straight wall;
//   divider: nothing else at all meets n but one divider continuing the line.
function continuation(ix, cur, n) {
  const others = (ix.byNode.get(n) || []).filter((e) => e !== cur && (cur.kind === 'divider' || e.kind !== 'divider'));
  if (others.length !== 1) return null;
  const f = others[0];
  if (f.kind !== cur.kind) return null;
  return straightThrough(ix, cur, f, n) ? f : null;
}

// The whole straight wall that edge `edgeId` is part of (user: "닿는 벽은 그 벽(일직선)은 다 없어지게"):
// from the edge along collinear walls through nodes where no other wall meets, up to where another wall
// meets it (a corner, a T) or the line turns or ends. A 구역 나누기 line: through plain splits only.
// → [edgeId] (the edge itself first; [] for an unknown id)
export function straightRun(project, edgeId, ix = null) {
  const g = ix || graphIndex(project);
  const e0 = g.edges.get(edgeId);
  if (!e0) return [];
  const out = [e0.id];
  const seen = new Set(out);
  for (const start of [e0.a, e0.b]) {
    let cur = e0, n = start;
    for (let guard = 0; guard < 10000; guard++) {
      const next = continuation(g, cur, n);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      out.push(next.id);
      n = next.a === n ? next.b : next.a;
      cur = next;
    }
  }
  return out;
}

// ---- the plan of one gesture -------------------------------------------------------------------------

// touched: { wallIds, dividerIds, openingIds, fixtureIds, memoIds } (iterables of what the eraser touched).
// → { edgeIds, wallRuns: [[edgeId]], dividerRuns: [[edgeId]], openingIds, fixtureIds, memoIds, counts, empty }
//   Every touched wall becomes its straight wall; a window / door in an erased wall goes with it (it cannot
//   stay without its wall). Ids that no longer exist are left out.
//   counts: { walls (straight walls), dividers (lines), windows, doors, fixtures, memo }
export function erasePlan(project, touched = {}) {
  const g = graphIndex(project);
  const edgeIds = new Set();
  const runs = (ids, kind) => {
    const list = [];
    for (const id of ids || []) {
      const e = g.edges.get(id);
      if (!e || edgeIds.has(id) || (kind === 'divider') !== (e.kind === 'divider')) continue;
      const run = straightRun(project, id, g);
      for (const r of run) edgeIds.add(r);
      list.push(run);
    }
    return list;
  };
  const wallRuns = runs(touched.wallIds, 'wall');
  const dividerRuns = runs(touched.dividerIds, 'divider');
  const want = new Set(touched.openingIds || []);
  const openings = (project.openings || []).filter((o) => o && (want.has(o.id) || edgeIds.has(o.edge)));
  const fixSet = new Set(touched.fixtureIds || []);
  const fixtureIds = (project.fixtures || []).filter((f) => f && fixSet.has(f.id)).map((f) => f.id);
  const memoSet = new Set(touched.memoIds || []);
  const memoIds = (project.memo || []).filter((s) => s && memoSet.has(s.id)).map((s) => s.id);
  const counts = {
    walls: wallRuns.length,
    dividers: dividerRuns.length,
    windows: openings.filter((o) => o.kind !== 'door').length,
    doors: openings.filter((o) => o.kind === 'door').length,
    fixtures: fixtureIds.length,
    memo: memoIds.length,
  };
  return {
    edgeIds: [...edgeIds], wallRuns, dividerRuns,
    openingIds: openings.map((o) => o.id), fixtureIds, memoIds, counts,
    empty: !edgeIds.size && !openings.length && !fixtureIds.length && !memoIds.length,
  };
}

// ---- hit geometry ------------------------------------------------------------------------------------

// Screen sizes in world mm at `scale` (css px per mm).
export function eraserSizes(scale) {
  const k = scale > 0 ? 1 / scale : 1;
  return {
    radius: ERASER_PX * k,
    wallPad: WALL_PAD_PX * k,
    symbolAlong: SYMBOL_PAD_PX.along * k,
    symbolAcross: SYMBOL_PAD_PX.across * k,
    lineOn: LINE_ON_PX * k,
    lineReach: LINE_REACH_PX * k,
    areaReach: AREA_REACH_PX * k,
    stick: STICK_PX * k,
    tie: TIE_PX * k,
    step: SAMPLE_PX * k,
  };
}

// Everything erasable, in world mm (build once per gesture; the plan does not change while rubbing).
// opts.memo: false when the memo is hidden on screen (strokes the user cannot see are never erased);
// default: as the project says ([메모 숨기기]).
export function eraserIndex(project, derived, { memo = null } = {}) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  // Windows / doors: their placement, and the cuts they make in their walls (mm from the wall's node a).
  const openings = [];
  const cuts = new Map();
  for (const o of project.openings || []) {
    let pl = null;
    try { pl = placeOpening(project, derived, o); } catch (_) { pl = null; }
    if (!pl) continue;
    const fr = pl.frame;
    const fin = finishOf(project, derived, o.edge);
    const thick = fr.thick > 0 ? fr.thick : NOMINAL_WALL_MM;
    const item = {
      id: o.id, kind: o.kind, edge: o.edge, A: fr.A, dir: fr.dir, left: fr.left,
      s0: pl.s0, s1: pl.s1, up: thick / 2 + fin.left, down: thick / 2 + fin.right, swing: null,
    };
    if (o.kind === 'door' && !slidingLeaves(o)) {
      // As ui/draw-openings.js drawSwing: the leaf from the hinge straight into the room, a quarter arc.
      const sw = o.swing || { side: 'left', hinge: 'start' };
      const sgn = sw.side === 'right' ? -1 : 1;
      const sh = sw.hinge === 'end' ? pl.s1 : pl.s0;
      const so = sw.hinge === 'end' ? pl.s0 : pl.s1;
      const hb = (thick * DOOR_BAND_RATIO) / 2;
      const r = Math.abs(so - sh);
      const at = (s, q) => ({ x: fr.A.x + fr.dir.x * s + fr.left.x * q, y: fr.A.y + fr.dir.y * s + fr.left.y * q });
      const towards = so > sh ? 1 : -1;
      item.swing = {
        hinge: at(sh, sgn * hb), tip: at(sh, sgn * (hb + r)), r,
        u: { x: fr.dir.x * towards, y: fr.dir.y * towards },     // arc start direction (along the wall)
        v: { x: fr.left.x * sgn, y: fr.left.y * sgn },           // arc end direction (into the room)
      };
    }
    openings.push(item);
    if (!cuts.has(o.edge)) cuts.set(o.edge, []);
    cuts.get(o.edge).push([pl.s0, pl.s1]);
  }
  // Walls (with their band) and 구역 나누기 lines.
  const walls = [], dividerEdges = [];
  const wallsAt = new Map();
  for (const e of project.edges || []) {
    const A = nodes.get(e.a), B = nodes.get(e.b);
    if (!A || !B) continue;
    const L = hyp(B.x - A.x, B.y - A.y);
    if (L < 1e-6) continue;
    const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
    if (e.kind === 'divider') { dividerEdges.push({ id: e.id, a: e.a, b: e.b, A, B, L, dir }); continue; }
    const t = wallThickness(project, derived, e);
    const fin = finishOf(project, derived, e.id);
    const w = {
      id: e.id, a: e.a, b: e.b, A, B, L, dir, left: { x: dir.y, y: -dir.x },
      up: t / 2 + fin.left, down: t / 2 + fin.right, cuts: cuts.get(e.id) || [],
    };
    walls.push(w);
    for (const id of [e.a, e.b]) {
      if (!wallsAt.has(id)) wallsAt.set(id, []);
      wallsAt.get(id).push(w);
    }
  }
  // Corners / T's: where the bands of several walls share their ink. `through`: the walls that run on
  // straight through the node (a T's bar, a plain split, both lines of a crossing): their band is drawn
  // whole there, and a wall ending against them (a T's stem) starts at their face.
  const zones = [];
  for (const [id, list] of wallsAt) {
    const N = nodes.get(id);
    if (!N) continue;
    const away = (w) => (w.a === id ? w.dir : { x: -w.dir.x, y: -w.dir.y });
    const through = new Set();
    for (const w of list) {
      for (const o of list) {
        if (o === w) continue;
        const u = away(w), v = away(o);
        if (u.x * v.x + u.y * v.y < 0 && Math.abs(u.x * v.y - u.y * v.x) <= SOLVED_STRAIGHT) { through.add(w.id); break; }
      }
    }
    zones.push({ id, N, walls: list, through, half: Math.max(...list.map((w) => Math.max(w.up, w.down))) });
  }
  // A 구역 나누기 line is seen only outside the walls it ends on.
  const dividers = dividerEdges.map((d) => {
    const trim = (id) => Math.max(0, ...(wallsAt.get(id) || []).map((w) => Math.max(w.up, w.down)));
    let s0 = trim(d.a), s1 = d.L - trim(d.b);
    if (s1 <= s0) { s0 = 0; s1 = d.L; }
    return { id: d.id, P: at(d.A, d.dir, s0), Q: at(d.A, d.dir, s1) };
  });
  // Fixtures (every type): their box.
  const fixtures = [];
  for (const raw of project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || !raw || raw.id == null) continue;
    fixtures.push({ id: raw.id, ...fixtureBounds(f) });
  }
  // Memo strokes, unless hidden.
  const showMemo = memo == null ? !isMemoHidden(project) : !!memo;
  const memoItems = showMemo ? validMemo(project.memo).map((s) => ({ id: s.id, stroke: s, half: (memoPaperWidth(s) * WORLD_PER_PAPER_MM) / 2, box: boxOf(s.points) })) : [];
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  return {
    walls, zones, dividers, openings, fixtures, memo: memoItems,
    wallById: byId(walls), dividerById: byId(dividers), openingById: byId(openings),
    fixtureById: byId(fixtures), memoById: byId(memoItems),
  };
}

function finishOf(project, derived, edgeId) {
  try {
    const f = finishBeside(project, derived, edgeId) || {};
    return { left: Math.max(0, f.left || 0), right: Math.max(0, f.right || 0) };
  } catch (_) {
    return { left: 0, right: 0 };
  }
}

function at(A, dir, s) { return { x: A.x + dir.x * s, y: A.y + dir.y * s }; }

function boxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return hyp(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

function boxDist(p, b) {
  const dx = Math.max(0, b.minX - p.x, p.x - b.maxX), dy = Math.max(0, b.minY - p.y, p.y - b.maxY);
  return hyp(dx, dy);
}

// Position of p on an opening's / wall's line: along (mm from A) and across (> 0 on the left).
function local(item, p) {
  const rx = p.x - item.A.x, ry = p.y - item.A.y;
  return { along: rx * item.dir.x + ry * item.dir.y, across: rx * item.left.x + ry * item.left.y };
}

// Is p on the opening's symbol (the cut in the wall band + the small pads)?
function onSymbol(o, p, s) {
  const { along, across } = local(o, p);
  const dAlong = Math.max(0, o.s0 - along, along - o.s1);
  const dAcross = Math.max(0, Math.abs(across) - (across >= 0 ? o.up : o.down));
  return dAlong <= s.symbolAlong && dAcross <= s.symbolAcross;
}

// Distance from p to an opening's cut (the rectangle it makes in the wall band).
function cutDist(o, p) {
  const { along, across } = local(o, p);
  const dAlong = Math.max(0, o.s0 - along, along - o.s1);
  const dAcross = Math.max(0, Math.abs(across) - (across >= 0 ? o.up : o.down));
  return hyp(dAlong, dAcross);
}

// Distance from p to a swing door's leaf and quarter arc (Infinity for windows and sliding doors).
function swingDist(o, p) {
  const sw = o.swing;
  if (!sw) return Infinity;
  let d = segDist(p, sw.hinge, sw.tip);
  const rx = p.x - sw.hinge.x, ry = p.y - sw.hinge.y;
  const cu = rx * sw.u.x + ry * sw.u.y, cv = rx * sw.v.x + ry * sw.v.y;
  if (cu >= 0 && cv >= 0) d = Math.min(d, Math.abs(hyp(rx, ry) - sw.r));
  else {
    const e1 = { x: sw.hinge.x + sw.u.x * sw.r, y: sw.hinge.y + sw.u.y * sw.r };
    d = Math.min(d, hyp(p.x - e1.x, p.y - e1.y), hyp(p.x - sw.tip.x, p.y - sw.tip.y));
  }
  return d;
}

function memoDist(m, p, reach) {
  if (p.x < m.box.minX - reach || p.x > m.box.maxX + reach || p.y < m.box.minY - reach || p.y > m.box.maxY + reach) return Infinity;
  return distanceToStroke(m.stroke, p);
}

// How far p is outside the band of wall w (its faces + the pad; past its ends by its half + the pad).
function bandDist(w, p, s) {
  const { along, across } = local(w, p);
  const ext = Math.max(w.up, w.down) + s.wallPad;
  const dAlong = Math.max(0, -ext - along, along - (w.L + ext));
  const dAcross = Math.max(0, Math.abs(across) - ((across >= 0 ? w.up : w.down) + s.wallPad));
  return hyp(dAlong, dAcross);
}

// Is p within STICK of the region where one of the items in `t` (a touch result) is touched?
function nearTouched(ix, t, p, s) {
  const k = s.stick;
  for (const id of t.wallIds) { const w = ix.wallById.get(id); if (w && bandDist(w, p, s) <= k) return true; }
  for (const id of t.openingIds) {
    const o = ix.openingById.get(id);
    if (o && (cutDist(o, p) <= s.areaReach + k || swingDist(o, p) <= s.lineReach + k)) return true;
  }
  for (const id of t.fixtureIds) { const f = ix.fixtureById.get(id); if (f && boxDist(p, f) <= s.areaReach + k) return true; }
  for (const id of t.memoIds) { const m = ix.memoById.get(id); if (m && memoDist(m, p, s.radius + m.half + k) <= s.radius + m.half + k) return true; }
  for (const id of t.dividerIds) { const d = ix.dividerById.get(id); if (d && segDist(p, d.P, d.Q) <= s.lineReach + k) return true; }
  return false;
}

const isEmpty = (t) => !t || !(t.wallIds.length + t.openingIds.length + t.fixtureIds.length + t.memoIds.length + t.dividerIds.length);

// Is `s` (mm from the wall's node a) inside a window / door cut of wall w (with the symbol's pad)?
function inCut(w, s, sizes) {
  return w.cuts.some(([s0, s1]) => s >= s0 - sizes.symbolAlong && s <= s1 + sizes.symbolAlong);
}

// Walls whose band holds p (rule 4). prevWalls: the walls the previous eraser position was rubbing.
function wallsUnder(ix, p, s, prevWalls) {
  // Within a corner / T: the nearest node's shared ink.
  let zone = null, zd = Infinity;
  for (const z of ix.zones) {
    const d = hyp(p.x - z.N.x, p.y - z.N.y);
    if (d <= z.half + s.wallPad && d < zd) { zone = z; zd = d; }
  }
  if (zone) {
    let cands = [];
    for (const w of zone.walls) {
      const fromA = w.a === zone.id;
      const { along, across } = local(w, p);
      const ahead = fromA ? along : w.L - along;   // mm from the node into this wall
      if (ahead > w.L || inCut(w, along, s)) continue;
      const d = Math.abs(across);
      const face = across >= 0 ? w.up : w.down;
      if (d > face + s.wallPad) continue;
      cands.push({ w, ahead, d, core: d <= face });
    }
    if (!cands.length) return [];
    // The wall the eraser is already rubbing keeps the shared ink (rubbing a wall into a T does not take
    // the wall across it).
    if (prevWalls && prevWalls.size) {
      const kept = cands.filter((c) => prevWalls.has(c.w.id));
      if (kept.length) return kept.map((c) => c.w.id);
    }
    // Inside the drawn band of a wall that runs on through the node (a T's bar), p is on that wall, not on
    // the stem that ends against it (checker 2026-10-22: a tap on the bar right above the stem took the
    // stem, and a rub along the bar starting there took the stem as well).
    const onThrough = cands.filter((c) => c.core && zone.through.has(c.w.id));
    if (onThrough.length && onThrough.length < cands.length) cands = onThrough;
    // Else the walls p lies in front of (past the node into the wall), the nearest centre line first; only
    // when p is behind every one (the outer corner of an L) the nearest of those.
    const front = cands.filter((c) => c.ahead > 0);
    const pool = front.length ? front : cands;
    const dMin = Math.min(...pool.map((c) => c.d));
    return pool.filter((c) => c.d <= dMin + s.tie).map((c) => c.w.id);
  }
  const out = [];
  for (const w of ix.walls) {
    const { along, across } = local(w, p);
    if (along < 0 || along > w.L || inCut(w, along, s)) continue;
    if (Math.abs(across) <= (across >= 0 ? w.up : w.down) + s.wallPad) out.push(w.id);
  }
  return out;
}

// What the eraser touches with its centre at p (see the rule at the top). sizes: eraserSizes(scale).
// prev (optional): what the previous position of the same rub touched (this function's result); a rub
// keeps to it while p stays within STICK of it (and keeps the wall it is on through a corner or T).
// → { memoIds, openingIds, fixtureIds, wallIds, dividerIds } (arrays)
export function eraserTouch(ix, p, sizes, prev = null) {
  const none = { memoIds: [], openingIds: [], fixtureIds: [], wallIds: [], dividerIds: [] };
  if (!p || !isNum(p.x) || !isNum(p.y)) return none;
  if (!isEmpty(prev) && nearTouched(ix, prev, p, sizes)) {
    return { memoIds: [...prev.memoIds], openingIds: [...prev.openingIds], fixtureIds: [...prev.fixtureIds], wallIds: [...prev.wallIds], dividerIds: [...prev.dividerIds] };
  }
  return touchAt(ix, p, sizes, prev ? new Set(prev.wallIds) : null);
}

// Rules 1–5 for one position (no stickiness except the corner's). prevWalls: Set | null.
function touchAt(ix, p, sizes, prevWalls) {
  const out = { memoIds: [], openingIds: [], fixtureIds: [], wallIds: [], dividerIds: [] };
  // 1. A memo stroke's ink under the centre.
  for (const m of ix.memo) if (memoDist(m, p, sizes.lineOn + m.half) <= sizes.lineOn + m.half) out.memoIds.push(m.id);
  if (out.memoIds.length) return out;
  // 2. A window / door symbol under the centre.
  for (const o of ix.openings) if (onSymbol(o, p, sizes)) out.openingIds.push(o.id);
  if (out.openingIds.length) return out;
  // 3. A fixture under the centre: the one drawn on top (the last, as a tap picks it, fixtures.fixtureAt),
  //    so rubbing a 기둥 standing in a 옷장 does not take the 옷장 as well.
  for (let i = ix.fixtures.length - 1; i >= 0; i--) {
    const f = ix.fixtures[i];
    if (p.x >= f.minX && p.x <= f.maxX && p.y >= f.minY && p.y <= f.maxY) { out.fixtureIds.push(f.id); break; }
  }
  if (out.fixtureIds.length) return out;
  // 4. A wall band under the centre.
  out.wallIds = wallsUnder(ix, p, sizes, prevWalls);
  if (out.wallIds.length) return out;
  // 5. On the floor: memo within the 메모 eraser's reach, thin lines and areas close by.
  for (const m of ix.memo) if (memoDist(m, p, sizes.radius + m.half) <= sizes.radius + m.half) out.memoIds.push(m.id);
  for (const o of ix.openings) if (cutDist(o, p) <= sizes.areaReach || swingDist(o, p) <= sizes.lineReach) out.openingIds.push(o.id);
  for (const f of ix.fixtures) if (boxDist(p, f) <= sizes.areaReach) out.fixtureIds.push(f.id);
  for (const d of ix.dividers) if (segDist(p, d.P, d.Q) <= sizes.lineReach) out.dividerIds.push(d.id);
  return out;
}

// The eraser path between two world points, sampled every sizes.step (both ends included except `a`
// when skipFirst). → [{x, y}]
export function samplePath(a, b, step, skipFirst = false) {
  if (!a) return b ? [b] : [];
  if (!b) return skipFirst ? [] : [a];
  const n = Math.max(1, Math.ceil(hyp(b.x - a.x, b.y - a.y) / Math.max(step, 1e-6)));
  const out = skipFirst ? [] : [a];
  for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  return out;
}

// Everything a whole eraser path (world points) touches, as rubbing it would (pure; for tests and the
// tool). → { wallIds, dividerIds, openingIds, fixtureIds, memoIds } (Sets)
export function touchAlong(ix, points, sizes) {
  const t = { wallIds: new Set(), dividerIds: new Set(), openingIds: new Set(), fixtureIds: new Set(), memoIds: new Set() };
  let prev = null, last = null;
  for (const q of points || []) {
    for (const p of samplePath(last, q, sizes.step, last != null)) {
      prev = eraserTouch(ix, p, sizes, prev);
      addTouch(t, prev);
    }
    last = q;
  }
  return t;
}

export function addTouch(t, h) {
  for (const k of ['wallIds', 'dividerIds', 'openingIds', 'fixtureIds', 'memoIds']) for (const id of h[k]) t[k].add(id);
}

// ---- walls merged by a removal -----------------------------------------------------------------------

// Removing a wall can leave a node between two collinear pieces of a wall that was NOT removed (a T's
// stem erased: the bar's two halves become one edge, graph.removeEdge(s) mergeThrough); the second
// piece's id goes. → Map oldId → id of the edge that now holds it (before: the project before the
// removal; after: the graph after it, node positions unchanged; removedIds: the edges removed).
export function mergedInto(before, after, removedIds = []) {
  const out = new Map();
  const removed = new Set(removedIds);
  const keep = new Set((after.edges || []).map((e) => e.id));
  const nb = new Map((before.nodes || []).map((n) => [n.id, n]));
  const na = new Map((after.nodes || []).map((n) => [n.id, n]));
  for (const e of before.edges || []) {
    if (removed.has(e.id) || keep.has(e.id)) continue;
    const A = nb.get(e.a), B = nb.get(e.b);
    if (!A || !B) continue;
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    for (const f of after.edges || []) {
      if (f.kind !== e.kind) continue;
      const P = na.get(f.a), Q = na.get(f.b);
      if (P && Q && segDist(mid, P, Q) <= 0.5) { out.set(e.id, f.id); break; }
    }
  }
  return out;
}

// What a removal must not take from the walls it merged (checker 2026-10-22, "딱 닿는것만"): the
// 확인필요 flag of an absorbed piece goes to the merged wall (as withSplits carries it over on a split),
// and a fixture standing against it stays against the merged wall (it was set free as if that wall had
// been deleted). doc: the graph after the removal (its wallChecks / fixtures as before). → doc
export function carryMerged(before, doc, removedIds = []) {
  const map = mergedInto(before, doc, removedIds);
  if (!map.size) return doc;
  const nb = new Map((before.nodes || []).map((n) => [n.id, n]));
  const eb = new Map((before.edges || []).map((e) => [e.id, e]));
  // Sign of an h / v edge's a → b along its axis in `before` (0 for a diagonal or a missing edge).
  const runs = (id) => {
    const e = eb.get(id), A = e && nb.get(e.a), B = e && nb.get(e.b);
    if (!A || !B || (e.orient !== 'h' && e.orient !== 'v')) return 0;
    return Math.sign(e.orient === 'h' ? B.x - A.x : B.y - A.y);
  };
  let changed = false;
  const fixtures = (doc.fixtures || []).map((f) => {
    if (!f || !map.has(f.wall)) return f;
    changed = true;
    const to = map.get(f.wall);
    const next = { ...f, wall: to };
    // A drop share is counted along its piece's own a → b (fixtures.js reconcileFixtures).
    if (typeof f.dropShare === 'number' && runs(f.wall) * runs(to) < 0) next.dropShare = 1 - f.dropShare;
    return next;
  });
  const checks = [];
  for (const w of doc.wallChecks || []) {
    if (!w) continue;
    const edge = map.has(w.edge) ? map.get(w.edge) : w.edge;
    if (edge !== w.edge) changed = true;
    const have = checks.find((c) => c.edge === edge);
    if (!have) { checks.push(edge === w.edge ? w : { ...w, edge }); continue; }
    const note = String(w.note || '').trim();
    if (note && !String(have.note || '').split(' / ').includes(note)) {
      checks[checks.indexOf(have)] = { ...have, note: have.note ? `${have.note} / ${note}` : note };
    }
  }
  return changed ? { ...doc, fixtures, wallChecks: checks } : doc;
}

// ---- store command -----------------------------------------------------------------------------------

// Adds eraseItems and setRoomAfterErase to DocStore.prototype.
//   eraseItems({ edgeIds, openingIds, fixtureIds, memoIds }) removes exactly these walls / 구역 나누기 lines
//   (pass erasePlan's edgeIds: the straight walls), windows / doors, fixtures and memo strokes in ONE
//   undo step, with the consequences of the single deletes: a window / door on an erased wall goes with
//   it; a fixture standing against an erased wall stays where it is, free; rooms merge or vanish (their
//   names wait in detachedRooms and come back with the room); the values of the erased walls go with
//   them, as with [벽 지우기] (user 2026-10-25: "벽 지웠다가 다시 그릴때는 숫자 리셋되게 해줘. 괜히
//   헷갈릴거같아", "지우개로 지울때도 그런거면 똑같이 리셋"): the measures of the room sides along an
//   erased wall (both faces), the spans with a part along one, the parts typed on either side of an
//   erased wall / divider that divided a span, and the waiting values taken along one — nothing of them
//   waits or comes back when a wall is drawn there again (store.lastDropped; ↶ gives them back with the
//   wall). Values of the walls that stay are kept exactly as with [벽 지우기] (user 2026-10-17 "지운 벽만
//   사라지고 나머지 사이즈는 유지"): on their side, else waiting until the side is drawn again (§7.7). 확인필요 flags of erased walls go. Nothing to erase → false, no undo step.
//   store.lastErased = { edgeIds, openingIds, fixtureIds, memoIds } — what really went.
export function installErase(DocStore) {
  const proto = DocStore.prototype;
  proto.eraseItems = function eraseItems(items = {}) {
    const edgeSet = new Set(items.edgeIds || []);
    const openSet = new Set(items.openingIds || []);
    const fixSet = new Set(items.fixtureIds || []);
    const memoSet = new Set(items.memoIds || []);
    const before = this.project;
    const edgesGone = (before.edges || []).filter((e) => edgeSet.has(e.id)).map((e) => e.id);
    // The values of the walls that go (model.js; read on the plan before the erase).
    // The same rule as [벽 지우기] (deleteEdge): the parts typed on either side of an erased wall are the
    // values of the walls that stay, so they wait like those (2026-10-25: the two must behave the same).
    const own = edgesGone.length ? this._wallOwnValues(edgesGone) : null;
    const ok = this._commit('eraseItems', (p) => {
      const edges = (p.edges || []).filter((e) => edgeSet.has(e.id)).map((e) => e.id);
      const openings = (p.openings || []).filter((o) => !openSet.has(o.id) && !edgeSet.has(o.edge));
      const memo = (p.memo || []).filter((s) => !memoSet.has(s.id));
      if (!edges.length && openings.length === (p.openings || []).length
        && !(p.fixtures || []).some((f) => fixSet.has(f.id)) && memo.length === (p.memo || []).length) return null;
      // The walls left whole by the removal keep their 확인필요 flags and their fixtures (carryMerged);
      // the values of the erased walls go with them (reported in lastDropped).
      const doc = edges.length ? this._dropWallValues(p, carryMerged(p, removeEdges(p, edges), edges), edges, own) : p;
      const fixtures = (doc.fixtures || []).filter((f) => !fixSet.has(f.id));
      const ids = new Set((doc.edges || []).map((e) => e.id));
      return {
        ...doc, openings, fixtures, memo,
        wallChecks: (doc.wallChecks || []).filter((w) => ids.has(w.edge)),
      };
    }, { rederive: edgesGone.length > 0, detail: { edgeIds: edgesGone } });
    const after = this.project;
    const gone = (list, next) => {
      const keep = new Set((next || []).map((x) => x && x.id));
      return (list || []).filter((x) => x && !keep.has(x.id)).map((x) => x.id);
    };
    this.lastErased = ok ? {
      edgeIds: edgesGone,
      openingIds: gone(before.openings, after.openings),
      fixtureIds: gone(before.fixtures, after.fixtures),
      memoIds: gone(before.memo, after.memo),
    } : { edgeIds: [], openingIds: [], fixtureIds: [], memoIds: [] };
    this._erasedState = ok ? this._state : null;
    return ok;
  };

  // A room name the editor sets because of rooms the erase merged (main.js _askMergedNames: the merged
  // room takes the name of the room that went, by itself when it had none, or as picked in the dialog)
  // belongs to the erase: while nothing else happened since, it is folded into the erase's undo step, so
  // ONE ↶ gives back the plan as it was before the rub. Later it is an ordinary setRoom. → bool
  proto.setRoomAfterErase = function setRoomAfterErase(roomId, patch) {
    const erased = this._erasedState;
    const fold = !!erased && erased === this._state;
    const ok = this.setRoom(roomId, patch);
    if (ok && fold && this._undo.length && this._undo[this._undo.length - 1] === erased) {
      this._undo.pop();
      this._erasedState = this._state;
    }
    return ok;
  };
}
