// Planar wall graph (DESIGN.md §3.3). Pure functions: inputs are never mutated; each edit returns a new
// doc object (arrays and touched items are copied; untouched fields are shared).
//
// doc: { nodes: [{ id, x, y }], edges: [{ id, a, b, kind, orient, sketch: {dx,dy}, thickness, exterior? }] , ...rest }

import { EPS, dist, polygonArea, projectPointToSegment, segmentIntersection } from './geom.js';
import { classifyDirection } from './sketch.js';

// Tolerance (mm) for "this point lies on that node/edge" after snapping has already been applied.
const ON_TOL = 0.5;
// Faces with an area below this (mm²) are treated as degenerate.
const AREA_EPS = 1;
// A corner within the snap distance wins over a wall the end lies on only when it is about as close:
// at most this fraction of the snap distance farther, about 7 of the 18 screen px (ht #9: a divider end
// lying ON 화장실1's left wall, 150 mm below that wall's corner, went to the corner and merged two wall
// lines into one; a pen end a few px beside a corner still means the corner).
const NODE_MARGIN = 0.4;
// Two corners whose lines differ by at most this fraction of the snap distance (like NODE_MARGIN) are one
// line drawn a little off (a wall joining them keeps both; the solver puts them on one line). Farther
// apart they are two lines.
const SAME_LINE = 0.4;
// A corner a new h / v wall reaches within this fraction of the snap of its line (under 3 of the 18 screen
// px), continuing a wall line that ends there, is that corner rather than a T beside it (planEnd).
const JOG = 0.15;
// After a stroke (joinStrokeEnds): a free end of the new walls joins an old free end at their corner up to
// CORNER × snap away (ht #13); a piece the stroke drew past a wall is dropped when shorter than STUB × snap.
// 1.5 rather than 2: 예시 세대 A's 1453 and 1505 lines are 520 mm apart, and at the default zoom (snap 300) a wall
// drawn down to the 1505 line before that line exists must keep its 520 mm past the 1453 line.
const CORNER = 2;
const STUB = 1.5;
// An old wall end that runs past the corner a new stroke reaches is cut back only this far (× snap) when
// the new end still had to grow to meet it: hand wobble of ±30 mm on both strokes leaves up to 60 mm (at
// snap 100), but a longer piece may be on purpose (it waits for a wall not drawn yet).
const OLD_TRIM = 0.6;
// An old free end that runs past a new wall drawn ACROSS it is cut back to that wall up to one snap (ht
// #13 leftover: careful 예시 세대 A sketches at snap 100 kept 63–96 mm stubs past later walls, each a 확인필요). A
// piece that long beyond a wall is under the 18 px snap on screen, not a wall waiting for another.
const OLD_CROSS = 1;
// A stroke shorter than straightenStroke keeps (1.5 × snap) is still a wall in these cases (shortStroke):
// between two different lines across it at any length; with an end in the open from SHORT_FREE × snap
// (13.5 of the 18 screen px; the UI asks for more from a finger). Its pen path may be at most
// SHORT_STRAIGHT × its chord (a straight line, not a wobble or a hook).
const SHORT_FREE = 0.75;
const SHORT_STRAIGHT = 1.3;
// A diagonal end (2026-10-19: diagonals are drawn mostly corner to corner) goes to a corner or loose wall
// end within DIAG_NODE × snap rather than to the wall beside it, unless that wall is more than one snap
// closer to the pen end: a pen end 5–15 px beside a corner, on either wall or past the corner, means the
// corner (no sliver, no 1 cm wall piece next to it).
const DIAG_NODE = 1.5;
// A diagonal end on a wall goes where the diagonal's line crosses that wall (its drawn angle is kept) when
// that is within DIAG_REACH × snap of the pen end; a crossing within NODE_MARGIN × snap of that wall's
// end is that corner.
const DIAG_REACH = 2;
// A diagonal FOOT is the stroke end of a diagonal piece that goes on into another piece of the same
// stroke (a bay drawn in one stroke C → P → Q → D). On or just across a wall it stays where its line
// crosses that wall; a corner wins only when that crossing is within FOOT_NODE × snap of it (fixer
// 2026-10-20, field: at tablet zoom a bay foot 26 px along the wall from the next room's corner, the pen
// 9 px across the wall, went to that corner, and the bay lost its straight front and became a triangle).
// A diagonal stroke of one piece (corner to corner, D1) keeps DIAG_NODE.
const FOOT_NODE = 0.6;
// cornerDiagonal: a straight stroke between two corners or loose ends whose line is more than the axis
// snap off both axes, drawn within CORNER_DIAG_AGREE of that line.
const CORNER_DIAG_AGREE = 20 * Math.PI / 180;

// ---- ids -----------------------------------------------------------------------------------------

// Next free id of the form prefix + integer, above every numeric suffix used in `items`.
export function nextId(prefix, items) {
  let max = 0;
  for (const it of items) {
    const id = typeof it === 'string' ? it : it && it.id;
    if (typeof id === 'string' && id.startsWith(prefix)) {
      const k = Number(id.slice(prefix.length));
      if (Number.isInteger(k) && k > max) max = k;
    }
  }
  return prefix + (max + 1);
}

// ---- working copy --------------------------------------------------------------------------------

// A mutable working copy used inside one edit. Ids are allocated from running counters.
function work(doc) {
  const nodes = (doc.nodes || []).map((n) => ({ ...n }));
  const edges = (doc.edges || []).map((e) => ({ ...e, sketch: sketchOf(e) }));
  const w = { doc, nodes, edges, nodeMap: new Map(), splits: [] };
  for (const n of nodes) w.nodeMap.set(n.id, n);
  // Fill missing sketch vectors from geometry.
  for (const e of edges) if (!e.sketch) e.sketch = geometricSketch(w, e, 1);
  // A new corner never takes an id a detached room or a waiting value still names (round 4: after two walls
  // were erased, the wall drawn next took the first one's corner ids, the detached room's outline followed
  // them to the new wall, and the room did not come back when its wall was drawn again: its name was lost).
  const held = nodes.map((n) => n.id);
  for (const r of doc.detachedRooms || []) for (const id of (r && r.nodeIds) || []) held.push(id);
  for (const m of doc.detachedMeasures || []) if (m) held.push(m.from, m.to);
  w.nodeCounter = Number(nextId('n', held).slice(1)) - 1;
  w.edgeCounter = Number(nextId('e', edges).slice(1)) - 1;
  return w;
}

function finish(w) {
  return { ...w.doc, nodes: w.nodes, edges: w.edges };
}

function newNode(w, x, y) {
  w.nodeCounter += 1;
  const n = { id: 'n' + w.nodeCounter, x, y };
  w.nodes.push(n);
  w.nodeMap.set(n.id, n);
  return n;
}

function sketchOf(e) {
  if (e.sketch && isFinite(e.sketch.dx) && isFinite(e.sketch.dy)) return { dx: e.sketch.dx, dy: e.sketch.dy };
  return null;
}

function geometricSketch(w, e, sketchScale) {
  const a = w.nodeMap.get(e.a), b = w.nodeMap.get(e.b);
  const s = sketchScale > 0 ? sketchScale : 1;
  if (!a || !b) return { dx: 0, dy: 0 };
  return { dx: (b.x - a.x) / s, dy: (b.y - a.y) / s };
}

function pos(w, id) { return w.nodeMap.get(id); }

function degreeMap(edges) {
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  return deg;
}

// Split edge `edgeId` at `point` (projected onto it). Returns the new middle node.
// The first part keeps the edge id; the second part gets a new id. Sketch vectors divide proportionally.
function splitEdgeAt(w, edgeId, point) {
  const i = w.edges.findIndex((e) => e.id === edgeId);
  const e = w.edges[i];
  const A = pos(w, e.a), B = pos(w, e.b);
  const pr = projectPointToSegment(point, A, B);
  if (pr.t * dist(A, B) < ON_TOL) return A;
  if ((1 - pr.t) * dist(A, B) < ON_TOL) return B;
  let { x, y } = pr.point;
  // Keep axis edges exactly axis-aligned.
  if (e.orient === 'h' && Math.abs(A.y - B.y) < ON_TOL) y = A.y;
  if (e.orient === 'v' && Math.abs(A.x - B.x) < ON_TOL) x = A.x;
  const m = newNode(w, x, y);
  const t = pr.t;
  w.edgeCounter += 1;
  const second = {
    ...e, id: 'e' + w.edgeCounter, a: m.id, b: e.b,
    sketch: { dx: e.sketch.dx * (1 - t), dy: e.sketch.dy * (1 - t) },
  };
  w.edges[i] = { ...e, b: m.id, sketch: { dx: e.sketch.dx * t, dy: e.sketch.dy * t } };
  w.edges.splice(i + 1, 0, second);
  w.splits.push({ from: e.id, to: second.id });
  return m;
}

// Node at `point`: an existing node within ON_TOL, else a split of an edge passing within ON_TOL,
// else a new free node.
function ensureNodeAt(w, point) {
  let best = null, bestD = ON_TOL;
  for (const n of w.nodes) {
    const d = dist(n, point);
    if (d <= bestD) { bestD = d; best = n; }
  }
  if (best) return best;
  for (const e of w.edges) {
    const A = pos(w, e.a), B = pos(w, e.b);
    const pr = projectPointToSegment(point, A, B);
    if (pr.dist <= ON_TOL) return splitEdgeAt(w, e.id, point);
  }
  return newNode(w, point.x, point.y);
}

function findEdgeBetween(w, u, v) {
  return w.edges.find((e) => (e.a === u && e.b === v) || (e.a === v && e.b === u)) || null;
}

// Snap an endpoint of a new segment of orientation `orient`: an existing node within `snap`, else the
// nearest edge within `snap`, else free. A node wins over an edge the end lies across (a T-junction) only
// when it is about as close (NODE_MARGIN); an edge parallel to the segment (the end continues or overlaps
// that wall) never beats a node. A diagonal ('d') end prefers a node up to DIAG_NODE × snap away
// (snapDiagonalEnd; `foot`: { through } for a diagonal foot, see FOOT_NODE).
// → { type: 'node'|'edge'|'free', id?, edgeId?, point, dist }
// (dist: how far the snap moved the end; addSegment weighs it when the two ends disagree).
function snapEnd(w, p, snap, orient, skip = null, foot = null) {
  if (orient === 'd') return snapDiagonalEnd(w, p, snap, skip, foot);
  const nn = nearestNodeIn(w.nodes, p, snap, skip && skip.nodes);
  const across = nearestEdgeIn(w, p, snap, (e) => !(skip && skip.edges && skip.edges.has(e.id)) && !parallelTo(e, orient));
  // An h / v end on a DIAGONAL within the snap of that diagonal's own end goes to that corner: a T there
  // only leaves a slanted stub side (final review 2026-10-28, B4: the 화장실 wall drawn to where the
  // diagonal outer wall meets the bottom wall ended on the diagonal 130 mm short of it, 4 of 12 sketches).
  // Not when that corner already has a wall of the new end's own direction (round 2, 2026-10-31): the new
  // wall's line would then fold onto that wall (an h wall drawn 150–260 mm above the bottom wall to the
  // diagonal near its foot vanished into the bottom wall, no new room and no message).
  const diagEnd = nn && across && orient !== 'd' && (() => {
    const e = w.edges.find((x) => x.id === across.edgeId);
    return e && e.orient === 'd' && (e.a === nn.nodeId || e.b === nn.nodeId)
      && !w.edges.some((x) => (x.a === nn.nodeId || x.b === nn.nodeId) && x.orient === orient);
  })();
  if (nn && (!across || diagEnd || nn.dist <= across.dist + Math.max(ON_TOL, snap * NODE_MARGIN))) {
    const n = pos(w, nn.nodeId);
    return { type: 'node', id: n.id, point: { x: n.x, y: n.y }, dist: nn.dist };
  }
  const ne = across || nearestEdgeIn(w, p, snap, (e) => !(skip && skip.edges && skip.edges.has(e.id)));
  if (ne) return { type: 'edge', edgeId: ne.edgeId, point: ne.point, dist: ne.dist };
  return { type: 'free', point: { x: p.x, y: p.y }, dist: 0 };
}

// snapEnd for a diagonal (DIAG_NODE): the node unless a wall is more than one snap closer. A foot
// (FOOT_NODE; foot.through = a point on its line, the piece's other end) on or just across a wall: where
// its line, coming from `through`, last crosses a wall before the pen end (else first after it), within
// DIAG_REACH × snap of the pen end (a pen end 9 px across the facade can lie nearer an inner wall than
// the facade it crossed), or the corner within FOOT_NODE × snap of that crossing.
function snapDiagonalEnd(w, p, snap, skip, foot = null) {
  const accept = (e) => !(skip && skip.edges && skip.edges.has(e.id));
  const ne = nearestEdgeIn(w, p, snap, accept);
  if (foot && ne) {
    let edgeId = ne.edgeId, X = ne.point;
    const T = foot.through;
    const L = T ? dist(T, p) : 0;
    if (L > EPS) {
      // The last wall the line crosses before the pen end (the one it was drawn across), else the
      // first one just past it (the pen stopped short of the wall).
      const reach = DIAG_REACH * snap;
      const far = { x: p.x + (p.x - T.x) / L * reach, y: p.y + (p.y - T.y) / L * reach };
      const tp = L / (L + reach);
      let before = null, after = null;
      for (const e of w.edges) {
        if (!accept(e)) continue;
        const hit = segmentIntersection(T, far, pos(w, e.a), pos(w, e.b));
        if (!hit || dist(hit.point, p) > reach) continue;
        const h = { t: hit.t, edgeId: e.id, point: hit.point };
        if (hit.t <= tp + EPS) { if (!before || h.t > before.t) before = h; } else if (!after || h.t < after.t) after = h;
      }
      const best = before || after;
      if (best) { edgeId = best.edgeId; X = best.point; }
    }
    const near = nearestNodeIn(w.nodes, X, FOOT_NODE * snap, skip && skip.nodes);
    if (near) {
      const n = pos(w, near.nodeId);
      return { type: 'node', id: n.id, point: { x: n.x, y: n.y }, dist: dist(n, p) };
    }
    return { type: 'edge', edgeId, point: { x: X.x, y: X.y }, dist: dist(X, p) };
  }
  const nn = nearestNodeIn(w.nodes, p, DIAG_NODE * snap, skip && skip.nodes);
  if (nn && (!ne || nn.dist <= ne.dist + snap)) {
    const n = pos(w, nn.nodeId);
    return { type: 'node', id: n.id, point: { x: n.x, y: n.y }, dist: nn.dist };
  }
  if (ne) return { type: 'edge', edgeId: ne.edgeId, point: ne.point, dist: ne.dist };
  return { type: 'free', point: { x: p.x, y: p.y }, dist: 0 };
}

// Where the line through a and b crosses segment AB (within ON_TOL of its ends), or null.
function lineCrossing(a, b, A, B) {
  const d = { x: b.x - a.x, y: b.y - a.y }, e = { x: B.x - A.x, y: B.y - A.y };
  const den = d.x * e.y - d.y * e.x;
  const le = Math.hypot(e.x, e.y);
  if (Math.abs(den) < EPS * Math.hypot(d.x, d.y) * le || le < EPS) return null;
  const u = ((A.x - a.x) * d.y - (A.y - a.y) * d.x) / den;
  if (u * le < -ON_TOL || (1 - u) * le < -ON_TOL) return null;
  const t = Math.min(1, Math.max(0, u));
  return { x: A.x + e.x * t, y: A.y + e.y * t };
}

// A diagonal segment p → q keeps its angle where an end lies on a wall: that end goes where the line
// through its two ends (a corner end: the corner) crosses the wall (DIAG_REACH), or to that wall's corner
// when the crossing is next to it; otherwise it stays at the nearest point. Mutates `ends`.
function diagonalEndsOnWalls(w, ends, p, q, snap) {
  const raws = [p, q];
  const L0 = ends[0].type === 'node' ? ends[0].point : p, L1 = ends[1].type === 'node' ? ends[1].point : q;
  if (dist(L0, L1) < ON_TOL) return;
  ends.forEach((s, i) => {
    if (s.type !== 'edge') return;
    const e = w.edges.find((x) => x.id === s.edgeId);
    const A = pos(w, e.a), B = pos(w, e.b);
    const X = lineCrossing(L0, L1, A, B);
    if (!X || dist(X, raws[i]) > DIAG_REACH * snap) return;
    for (const N of [A, B]) {
      if (dist(N, X) <= Math.max(ON_TOL, snap * NODE_MARGIN)) {
        Object.assign(s, { type: 'node', id: N.id, point: { x: N.x, y: N.y }, dist: dist(N, raws[i]) });
        return;
      }
    }
    s.point = X;
  });
}

// The corner nearest a diagonal segment (between its snapped ends, more than NODE_MARGIN × snap from both)
// that lies within NODE_MARGIN × snap of it but not on it. → { x, y } | null
function cornerOnDiagonal(w, ends, snap) {
  const P = ends[0].point, Q = ends[1].point;
  const reach = snap * NODE_MARGIN;
  if (dist(P, Q) < 2 * reach) return null;
  const own = new Set(ends.filter((s) => s.type === 'node').map((s) => s.id));
  let best = null;
  for (const n of w.nodes) {
    if (own.has(n.id) || dist(n, P) <= reach || dist(n, Q) <= reach) continue;
    const pr = projectPointToSegment(n, P, Q);
    if (pr.dist <= ON_TOL || pr.dist > reach || pr.t <= 0 || pr.t >= 1) continue;
    if (!best || pr.dist < best.dist) best = { dist: pr.dist, point: { x: n.x, y: n.y } };
  }
  return best && best.point;
}

function parallelTo(e, orient) {
  return (orient === 'h' || orient === 'v') && e.orient === orient;
}

// A one-piece h / v wall stroke drawn along a STEPPED line: existing walls of its direction on two or more lines a
// little apart, one after the other under it (round 5, fuzz of round 4: one long 복도 stroke under rooms whose bottom
// walls are a few cm apart re-traced one of them and doubled the others, a strip a few cm wide and '[overlap]'
// followed, or two rooms merged). Then it is drawn in pieces: along each run of walls on its own line (re-tracing
// it), and across a gap between two runs from the end corner of one to the start corner of the next (planned like
// any wall between two corners: a crooked piece the solver straightens, or a T on the far corner's wall); where two
// runs meet at one corner line, the wall across between them is the step. A run is under the stroke when its line is
// within SAME_LINE × snap of the stroke's line or of the pen, or when it steps from such a run at a corner; a run
// less than one snap under the stroke at an end of it is not followed (the pen ran on past a corner).
// pen: [first, last] pen points | null. → [[from, to], …] in the stroke's direction | null (one line, or not a clean
// stepped line: two lines side by side, a wall in a gap, a step with no wall across)
function steppedPieces(w, p, q, key, snap, orient, pen, ends) {
  const along = key === 'y' ? 'x' : 'y';
  const lo = Math.min(p[along], q[along]), hi = Math.max(p[along], q[along]);
  if (hi - lo < 2 * snap) return null;
  const c0 = (p[key] + q[key]) / 2;
  const near = SAME_LINE * snap;
  const penAt = (u) => {
    if (!pen || !pen[0] || !pen[1]) return c0;
    const a = pen[0], b = pen[1];
    const t = Math.abs(b[along] - a[along]) > EPS ? (u - a[along]) / (b[along] - a[along]) : 0.5;
    return a[key] + (b[key] - a[key]) * Math.min(1, Math.max(0, t));
  };
  const walls = [];
  for (const e of w.edges) {
    if (e.kind !== 'wall' || !parallelTo(e, orient)) continue;
    const A = pos(w, e.a), B = pos(w, e.b);
    if (Math.abs(A[key] - B[key]) > ON_TOL || Math.abs(A[key] - c0) > 2 * near) continue;
    const a = Math.min(A[along], B[along]), b = Math.max(A[along], B[along]);
    if (Math.min(hi, b) - Math.max(lo, a) <= ON_TOL) continue;
    walls.push({ line: A[key], a, b });
  }
  walls.sort((x, y) => x.a - y.a || x.b - y.b);
  const runs = [];
  for (const x of walls) {
    const r = runs[runs.length - 1];
    if (r && Math.abs(r.line - x.line) <= ON_TOL && x.a <= r.b + ON_TOL) r.b = Math.max(r.b, x.b);
    else runs.push({ ...x });
  }
  const under = (r) => Math.min(hi, r.b) - Math.max(lo, r.a);
  while (runs.length && under(runs[0]) < snap) runs.shift();
  while (runs.length && under(runs[runs.length - 1]) < snap) runs.pop();
  if (runs.length < 2 || runs.some((r) => under(r) < snap)) return null;
  const lines = runs.map((r) => r.line);
  if (Math.max(...lines) - Math.min(...lines) <= ON_TOL) return null;
  const nodeAt = (u, line) => w.nodes.find((n) => Math.abs(n[along] - u) <= ON_TOL && Math.abs(n[key] - line) <= ON_TOL);
  // Whether walls across cover the step from U to V (both at one place along the stroke).
  const stepWall = (U, V) => {
    const k0 = Math.min(U[key], V[key]), k1 = Math.max(U[key], V[key]);
    const spans = [];
    for (const e of w.edges) {
      if (parallelTo(e, orient) || !isAxis(e)) continue;
      const A = pos(w, e.a), B = pos(w, e.b);
      if (Math.abs(A[along] - U[along]) > ON_TOL || Math.abs(B[along] - U[along]) > ON_TOL) continue;
      spans.push([Math.min(A[key], B[key]), Math.max(A[key], B[key])]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let reach = k0;
    for (const [a, b] of spans) if (a <= reach + ON_TOL) reach = Math.max(reach, b);
    return reach >= k1 - ON_TOL;
  };
  const cuts = [];
  for (let k = 0; k + 1 < runs.length; k++) {
    const r = runs[k], s = runs[k + 1];
    if (Math.abs(r.line - s.line) <= ON_TOL) { cuts.push(null); continue; }
    if (r.b > s.a + ON_TOL) return null;                       // two lines side by side: not a step
    const U = nodeAt(r.b, r.line), V = nodeAt(s.a, s.line);
    if (!U || !V) return null;
    if (s.a - r.b <= ON_TOL) {
      // The step: the wall across between them, drawn when it is not there (a run's loose end).
      cuts.push({ U: { x: U.x, y: U.y }, V: { x: V.x, y: V.y }, gap: false, step: !stepWall(U, V) });
    } else {
      // A gap of a room's width or more, with nothing of that direction in it (a wall there would be doubled
      // by the piece across it).
      if (s.a - r.b < snap || walls.some((x) => Math.min(s.a, x.b) - Math.max(r.b, x.a) > ON_TOL)) return null;
      cuts.push({ U: { x: U.x, y: U.y }, V: { x: V.x, y: V.y }, gap: true });
    }
  }
  // Every run followed: near the stroke's line or the pen, or stepping at a corner from one that is.
  const ok = runs.map((r) => Math.abs(r.line - c0) <= near || Math.abs(r.line - penAt((Math.max(lo, r.a) + Math.min(hi, r.b)) / 2)) <= near);
  for (let pass = 0; pass < runs.length; pass++) {
    for (let k = 0; k + 1 < runs.length; k++) {
      if (cuts[k] && !cuts[k].gap && ok[k] !== ok[k + 1]) { ok[k] = true; ok[k + 1] = true; }
      else if (!cuts[k] && ok[k] !== ok[k + 1]) { ok[k] = true; ok[k + 1] = true; }
    }
  }
  if (ok.some((x) => !x)) return null;
  const steps = cuts.filter(Boolean);
  if (!steps.length) return null;
  // A stroke end beyond the first / last run that goes to a corner or a wall off that run's line: cut at the run's
  // outer corner too (else the piece would run crooked along the run to that end, doubling it).
  const up = q[along] >= p[along];
  const outer = [[runs[0], runs[0].a, -1], [runs[runs.length - 1], runs[runs.length - 1].b, 1]];
  for (const [r, u, dir] of outer) {
    const end = ends[(dir < 0) === up ? 0 : 1];
    const at = dir < 0 ? lo : hi;
    if (!end || end.type === 'free' || (at - u) * dir <= ON_TOL || Math.abs(end.point[key] - r.line) <= ON_TOL) continue;
    const N = nodeAt(u, r.line);
    if (!N) return null;
    const cut = { U: { x: N.x, y: N.y }, V: { x: N.x, y: N.y }, gap: false };
    if (dir < 0) steps.unshift(cut); else steps.push(cut);
  }
  if (!up) steps.reverse();
  const pieces = [];
  let from = p;
  for (const { U: U0, V: V0, gap, step } of steps) {
    const [U, V] = up ? [U0, V0] : [V0, U0];
    pieces.push([from, U]);
    if (gap) pieces.push([U, V]);
    if (step) pieces.push([U, V, orient === 'h' ? 'v' : 'h']);
    from = V;
  }
  pieces.push([from, q]);
  return pieces;
}

function nearestNodeIn(nodes, point, maxDist, skip = null) {
  let best = null, bestD = maxDist;
  for (const n of nodes) {
    if (skip && skip.has(n.id)) continue;
    const d = dist(n, point);
    if (d <= bestD) { bestD = d; best = n; }
  }
  return best ? { nodeId: best.id, dist: bestD } : null;
}

function nearestEdgeIn(w, point, maxDist, accept = null) {
  let best = null;
  for (const e of w.edges) {
    if (accept && !accept(e)) continue;
    const A = pos(w, e.a), B = pos(w, e.b);
    if (!A || !B) continue;
    const pr = projectPointToSegment(point, A, B);
    if (pr.dist <= maxDist && (!best || pr.dist < best.dist)) {
      best = { edgeId: e.id, dist: pr.dist, t: pr.t, point: pr.point };
    }
  }
  return best;
}

// Where a pen point would snap for a new segment of orientation `orient` (the same rule as addSegment;
// opts.foot = { through } for a diagonal foot, FOOT_NODE).
// → { type: 'node'|'edge'|'free', point, dist, nodeId?, edgeId?, edgeOrient? }
export function snapPoint(doc, p, snap, orient = null, { foot = null } = {}) {
  const w = work(doc);
  const s = snapEnd(w, p, snap, orient, null, foot);
  const out = { type: s.type, point: { x: s.point.x, y: s.point.y }, dist: s.dist };
  if (s.type === 'node') out.nodeId = s.id;
  if (s.type === 'edge') { out.edgeId = s.edgeId; out.edgeOrient = edgeOrient(w, s.edgeId); }
  return out;
}

// A wall stroke too short for straightenStroke (under 1.5 × snap, dropped there as a wobble) that is still
// a wall: zoomed far out the 18 px snap is 380–600 mm, and 예시 세대 A's 550 mm 베란다1 step was lost (베란다1 merged
// with the outside). It becomes ONE straight h/v segment from its first to its last pen point when
//  - its two ends land on two DIFFERENT walls or corners across it (a step between two lines), however
//    short compared with the snap: the snaps move the ends less than the stroke is long, the two places lie
//    apart along the stroke, and no wall runs there yet (a tap wobbling along a wall stays a tap);
//  - or it is at least `minFree` long with one or both ends in the open (drawn before the walls it will
//    join); the other end then lies on a wall or corner across it, about where the pen started or stopped.
// An end on a wall ALONG the stroke (a re-trace, a tap on that wall) never makes one. The caller adds the
// segment with addSegment (which snaps the ends by the same rule). allowDiagonal 'auto' (the wall tool's
// default) keeps a short stroke h/v; a short slanted stroke with the pen held (allowDiagonal true) is not
// made. → { p, q, orient } | null
export function shortStroke(doc, points, { snap = 200, minFree = SHORT_FREE * snap, allowDiagonal = false } = {}) {
  const pts = (points || []).filter((pt) => pt && isFinite(pt.x) && isFinite(pt.y));
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const L = dist(a, b);
  if (L < 4 * ON_TOL) return null;
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += dist(pts[i - 1], pts[i]);
  if (path > SHORT_STRAIGHT * L) return null;
  const { orient } = classifyDirection({ x: b.x - a.x, y: b.y - a.y }, allowDiagonal === true);
  if (orient !== 'h' && orient !== 'v') return null;
  const along = orient === 'h' ? 'x' : 'y', cross = orient === 'h' ? 'y' : 'x';
  const w = work(doc);
  const ends = [snapEnd(w, a, snap, orient), snapEnd(w, b, snap, orient)];
  if (ends.some((s) => s.type === 'edge' && edgeOrient(w, s.edgeId) === orient)) return null;
  const seg = { p: { x: a.x, y: a.y }, q: { x: b.x, y: b.y }, orient };
  const free = ends.filter((s) => s.type === 'free').length;
  if (free === 0) {
    const [s0, s1] = ends;
    if (s0.type === s1.type && (s0.type === 'node' ? s0.id === s1.id : s0.edgeId === s1.edgeId)) return null;
    const sep = (s1.point[along] - s0.point[along]) * sgn(b[along] - a[along]);
    if (sep < Math.max(4 * ON_TOL, 0.5 * L) || Math.abs(s1.point[cross] - s0.point[cross]) > sep) return null;
    if (s0.dist + s1.dist > L) return null;
    const mid = { x: (s0.point.x + s1.point.x) / 2, y: (s0.point.y + s1.point.y) / 2 };
    if (nearestEdgeIn(w, mid, 2 * ON_TOL, (e) => parallelTo(e, orient) || !isAxis(e))) return null;
    return seg;
  }
  if (L < minFree) return null;
  // One end on a wall or corner: the stroke starts there (not a wobble beside it).
  if (free === 1 && ends.some((s) => s.type !== 'free' && s.dist > 0.5 * L)) return null;
  return seg;
}

// A straight wall stroke that the axis snap made h / v (its pen line within 20° of an axis) but that runs
// between two corners or loose wall ends no h / v wall can join: the diagonal between them (fixer
// 2026-10-20; a corner-to-corner stroke in a 2200 × 1000 room is 24° off the axis, the pen line 18°: it
// snapped to h and re-traced the top wall, so nothing appeared; an open corner closed at 25° gave an h
// stub and left both loose ends). All of:
//  - the pen path is straight (at most SHORT_STRAIGHT × its chord);
//  - the h / v wall would miss a pen end by more than the snap (the pen ends lie more than one snap apart
//    across the axis), or its two ends snap to two corners more than SAME_LINE × snap off one line (it
//    would leave one of them loose): a short wall drawn to a T beside a corner stays h / v;
//  - both pen ends snap, as diagonal ends do (DIAG_NODE), to two different corners or loose ends not yet
//    joined by a wall, whose line is more than axisSnapDeg off both axes;
//  - the pen's chord runs within CORNER_DIAG_AGREE of that line.
// → { p, q, orient: 'd' } (the two corners) | null
export function cornerDiagonal(doc, points, { snap = 200, orient = null, axisSnapDeg = 20 } = {}) {
  const pts = (points || []).filter((pt) => pt && isFinite(pt.x) && isFinite(pt.y));
  if (pts.length < 2 || (orient !== 'h' && orient !== 'v')) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const L = dist(a, b);
  if (L < EPS) return null;
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += dist(pts[i - 1], pts[i]);
  if (path > SHORT_STRAIGHT * L) return null;
  const across = orient === 'h' ? 'y' : 'x';
  const w = work(doc);
  if (Math.abs(b[across] - a[across]) <= snap) {
    const h0 = snapEnd(w, a, snap, orient), h1 = snapEnd(w, b, snap, orient);
    if (h0.type !== 'node' || h1.type !== 'node' || Math.abs(h1.point[across] - h0.point[across]) <= SAME_LINE * snap) return null;
  }
  const s0 = snapDiagonalEnd(w, a, snap, null), s1 = snapDiagonalEnd(w, b, snap, null);
  if (s0.type !== 'node' || s1.type !== 'node' || s0.id === s1.id || findEdgeBetween(w, s0.id, s1.id)) return null;
  const v = { x: s1.point.x - s0.point.x, y: s1.point.y - s0.point.y };
  if (classifyDirection(v, true, axisSnapDeg * Math.PI / 180).orient !== 'd') return null;
  const lv = Math.hypot(v.x, v.y);
  const cos = (v.x * (b.x - a.x) + v.y * (b.y - a.y)) / (lv * L);
  if (!(cos >= Math.cos(CORNER_DIAG_AGREE))) return null;
  return { p: { x: s0.point.x, y: s0.point.y }, q: { x: s1.point.x, y: s1.point.y }, orient: 'd' };
}

// A diagonal stroke drawn on past the corner it was aimed at (its end more than DIAG_NODE × snap beyond, so
// the end did not snap): the corner the pen path came within PASS_REACH × snap of during its last
// PASS_RUN × snap of travel ('end') or its first ('start'), not one at the stroke's other end. The caller
// ends the diagonal at that corner and drops the pen points beyond it.
// → { node: { id, x, y }, dist, points (the stroke up to that corner, which ends it) } | null
const PASS_RUN = 3;
const PASS_REACH = 0.75;
export function passedCorner(doc, points, snap, side = 'end') {
  const pts = (points || []).filter((pt) => pt && isFinite(pt.x) && isFinite(pt.y));
  const seq = side === 'end' ? pts : pts.slice().reverse();
  if (seq.length < 2) return null;
  const far = seq[0], tip = seq[seq.length - 1];
  let best = null, run = 0;
  for (let i = seq.length - 1; i > 0 && run <= PASS_RUN * snap; i--) {
    const a = seq[i - 1], b = seq[i];
    for (const n of doc.nodes || []) {
      if (dist(n, far) <= DIAG_NODE * snap || dist(n, tip) <= DIAG_NODE * snap) continue;
      const pr = projectPointToSegment(n, a, b);
      if (pr.dist <= PASS_REACH * snap && (!best || pr.dist < best.dist)) best = { node: n, dist: pr.dist, i };
    }
    run += dist(a, b);
  }
  if (!best) return null;
  const kept = seq.slice(0, best.i).concat([{ x: best.node.x, y: best.node.y }]);
  return {
    node: { id: best.node.id, x: best.node.x, y: best.node.y },
    dist: best.dist,
    points: side === 'end' ? kept : kept.reverse(),
  };
}

// Point on edge e where the axis line (key = c) crosses it, or null.
function axisPointOnEdge(w, e, key, c) {
  const A = pos(w, e.a), B = pos(w, e.b);
  const other = key === 'y' ? 'x' : 'y';
  const lo = Math.min(A[key], B[key]) - ON_TOL, hi = Math.max(A[key], B[key]) + ON_TOL;
  if (c < lo || c > hi) return null;
  const span = B[key] - A[key];
  if (Math.abs(span) < EPS) return null; // parallel to the axis line
  const t = Math.min(1, Math.max(0, (c - A[key]) / span));
  const pt = {};
  pt[key] = c;
  pt[other] = A[other] + (B[other] - A[other]) * t;
  return pt;
}

// ---- public edits --------------------------------------------------------------------------------

// Add a straight segment p→q. → { doc, edgeIds, splits: [{ from, to }], ends: [nodeId at p, nodeId at q] }
// splits lists existing edges that were split (from = old id kept by the first part, to = new id).
// A diagonal keeps the angle it was drawn at: its ends prefer corners (DIAG_NODE), an end on a wall lands
// where its line crosses the wall (DIAG_REACH), and a corner it runs past within NODE_MARGIN × snap splits it
// into two segments through that corner. feet: [p is a foot, q is a foot] (FOOT_NODE; the stroke ends of a
// diagonal piece that goes on into another piece of the same stroke). pen: [first, last] raw pen points of
// a one-piece h / v stroke (p and q are its straightened ends): a corner end's cost is how far the PEN end
// is from it (see the h / v block). route: false inside the two halves of an 'onto' route (below).
export function addSegment(doc, p, q, { orient, kind = 'wall', snap = 200, sketchScale = 1, feet = null, pen = null, route = true } = {}) {
  const w = work(doc);
  w.kind = kind;   // planEnd 'extend': a wall's corner goes on only for a new wall
  if (!orient) orient = classifyDirection({ x: q.x - p.x, y: q.y - p.y }, true).orient;
  const footP = orient === 'd' && feet && feet[0] ? { through: q } : null;
  const footQ = orient === 'd' && feet && feet[1] ? { through: p } : null;
  const ends = [snapEnd(w, p, snap, orient, null, footP), snapEnd(w, q, snap, orient, null, footQ)];
  if (orient === 'd') {
    diagonalEndsOnWalls(w, ends, p, q, snap);
    // Corner to corner (user 2026-10-19: diagonals mostly join two corners of a rectangular space): with
    // one end at a corner or loose wall end, an end ON a wall within DIAG_NODE × snap of that wall's own
    // end is that end too (lead 2026-10-20: a pen end 18–27 px along the wall from the corner left a wall
    // piece beside it, a triangle plus a 4-sided room). Not for a foot, nor when both ends are on walls
    // (a corner cut, D4).
    ends.forEach((s, i) => {
      const o = ends[1 - i];
      if (s.type !== 'edge' || o.type !== 'node' || (i === 0 ? footP : footQ)) return;
      const e = w.edges.find((x) => x.id === s.edgeId);
      const raw = i === 0 ? p : q;
      let best = null;
      for (const N of [pos(w, e.a), pos(w, e.b)]) {
        if (!N || N.id === o.id) continue;
        const d = dist(N, raw);
        if (d <= DIAG_NODE * snap && (!best || d < best.d)) best = { N, d };
      }
      if (best) Object.assign(s, { type: 'node', id: best.N.id, point: { x: best.N.x, y: best.N.y }, dist: best.d });
    });
    // A short diagonal cutting a corner close to it (both pen ends on its two walls, within DIAG_NODE ×
    // snap of that corner, e.g. 26 × 19 px from it with a 9 px overshoot) sent both ends to that one
    // corner and nothing was drawn: then both ends are feet, where its line crosses the two walls (fixer
    // 2026-10-20).
    if (ends[0].type === 'node' && ends[1].type === 'node' && ends[0].id === ends[1].id) {
      ends[0] = snapEnd(w, p, snap, orient, null, { through: q });
      ends[1] = snapEnd(w, q, snap, orient, null, { through: p });
      diagonalEndsOnWalls(w, ends, p, q, snap);
    }
    // A diagonal running within NODE_MARGIN × snap of a corner on its way (drawn past the corner it was
    // aimed at) goes through that corner: two segments, no sliver beside the corner.
    const via = cornerOnDiagonal(w, ends, snap);
    if (via) {
      const first = addSegment(doc, p, via, { orient, kind, snap, sketchScale, feet: [!!footP, false] });
      const second = addSegment(first.doc, via, q, { orient, kind, snap, sketchScale, feet: [false, !!footQ] });
      return {
        doc: second.doc,
        edgeIds: [...first.edgeIds, ...second.edgeIds],
        splits: [...first.splits, ...second.splits],
        ends: [first.ends[0], second.ends[second.ends.length - 1]].filter(Boolean),
      };
    }
  }

  // Re-impose the orientation: h segments share one y, v segments one x.
  if (orient === 'h' || orient === 'v') {
    const key = orient === 'h' ? 'y' : 'x';
    // A stroke along a stepped line: drawn piece by piece (steppedPieces; round 5).
    const steps = route && kind === 'wall' && !feet ? steppedPieces(w, p, q, key, snap, orient, pen, ends) : null;
    if (steps) {
      let d = doc;
      const edgeIds = [], splits = [];
      let first = null, last = null;
      steps.forEach(([A, B, across], k) => {
        if (dist(A, B) <= ON_TOL) return;
        const pn = pen && !across ? [k === 0 ? pen[0] : A, k === steps.length - 1 ? pen[1] : B] : null;
        const r = addSegment(d, A, B, { orient: across || orient, kind, snap, sketchScale, pen: pn, route: false });
        d = r.doc;
        edgeIds.push(...r.edgeIds);
        splits.push(...r.splits);
        if (r.ends.length) { if (first == null) first = r.ends[0]; last = r.ends[r.ends.length - 1]; }
      });
      return { doc: d, edgeIds, splits, ends: [first, last].filter((x) => x != null) };
    }
    // Every end of a one-piece stroke costs how far its PEN end is from where it goes: the corner, the T or
    // the loose end on the line (round 2, 2026-10-31, for a corner: the straightened ends already lie on the
    // line of the end anchor nearer its pen point, so a corner at the other end 0.5–1.2 snap off that line
    // looked that far from the pen, a loose end beat the T at the corner the pen started at, and the rooms on
    // both sides merged). `pen` holds the pen points the ends were straightened from (sketch.js penStart /
    // penEnd): a short return at a stroke end that the straightening dropped (1.1–1.45 snap) is not the end
    // (round 3, 2026-11-01). Round 4: T and loose-end costs counted from the straightened ends too, and round
    // 3 took the straightened distance where it was smaller; both measured the end on the line of the nearer
    // anchor, so a wall drawn between two room corners 0.45–0.75 snap apart, the pen nearer the lower one,
    // ran on along that corner's line and ended loose beside the other one (the rooms on both sides merged).
    const raws = pen && pen[0] && pen[1] ? [{ ...p, [key]: pen[0][key] }, { ...q, [key]: pen[1][key] }] : [p, q];
    if (pen && pen[0] && pen[1]) ends.forEach((s, i) => { if (s.type === 'node') s.dist = dist(pen[i], s.point); });
    // The line runs through a corner end or an end on a parallel wall; when the ends disagree, the line
    // that fits both ends best (each end's own snap distance plus what it costs the other end to reach
    // that line), else the stroke's own line. ht #9, #27: the 주방 | 거실 divider ended ON 화장실1's left
    // wall but went to its corner 150 mm up and pulled 방2's and 방3's bottom lines into one; with the
    // corner at the divider's other end setting the line, its far end is a T on that wall instead.
    const fixing = ends.filter((s) => fixesLine(w, s, orient));
    let c = (p[key] + q[key]) / 2;
    let plans = null;
    if (fixing.length) {
      let best = null;
      for (const cand of fixing) {
        const line = cand.point[key];
        const ps = ends.map((s, i) => planEnd(w, s, raws[i], key, line, snap, orient, raws[1 - i]));
        const cost = ps.reduce((a, b) => a + b.cost, 0);
        if (!best || cost < best.cost - ON_TOL) best = { cost, line, ps };
      }
      c = best.line;
      plans = best.ps;
    }
    // A wall drawn along an existing parallel wall a little off its line (at most SAME_LINE × snap, over
    // at least one snap of its length) is that wall re-traced: it goes onto that line and shares its
    // pieces (final review 2026-10-28, C3: one long stroke along the 중정's bottom wall ran 6 mm beside it,
    // two walls overlapped, the 중정 became a hole in the room above and three 확인필요 'overlap' followed).
    const along = key === 'y' ? 'x' : 'y';
    const lo = Math.min(p[along], q[along]), hi = Math.max(p[along], q[along]);
    let onto = null;
    for (const e of w.edges) {
      // Walls only: a 구역 나누기 선 may run beside a wall (ht #27: 예시 세대 A's 주방 | 거실 line 150 mm beside
      // 화장실1's top wall).
      if (kind !== 'wall' || e.kind !== 'wall' || !parallelTo(e, orient)) continue;
      const A = pos(w, e.a), B = pos(w, e.b);
      if (Math.abs(A[key] - B[key]) > ON_TOL) continue;
      const off = Math.abs(A[key] - c);
      if (off <= ON_TOL || off > SAME_LINE * snap) continue;
      const ov = Math.min(hi, Math.max(A[along], B[along])) - Math.max(lo, Math.min(A[along], B[along]));
      if (ov < snap) continue;
      if (!onto || ov > onto.ov) onto = { ov, line: A[key] };
    }
    // Only when both ends then lie ON that line (round 2, 2026-10-31, ht #27 drawn as a wall: the 주방 | 거실
    // wall from a corner 100 mm off 방2's bottom wall kept the corner by SAME_LINE, ran slanted onto 방2's
    // wall line, overlapped it and merged 방2, 주방 and 거실 into one room). With exactly one end a corner off
    // the line, the wall goes from that corner to the old wall's nearest corner on the line (a crooked h / v
    // piece the solver straightens) and on along the old wall, re-using its pieces, where the corner's own
    // line would cut past a wall standing at that old corner (a sliver room between the lines) or the corner
    // is within JOG × snap of the line (C3-like: a long row wall started at a room corner drawn 20–100 mm off
    // the 중정's wall doubled it). Otherwise the plan before stays (ht #27: 방2's corner wall goes away from
    // the 3000 line, so the new wall keeps its own line and ends as a T on 화장실1's wall).
    if (onto) {
      const ps = ends.map((s, i) => planEnd(w, s, raws[i], key, onto.line, snap, orient, raws[1 - i]));
      // A corner end whose own line has walls running along the stroke stays on its line: the stroke follows
      // walls on two lines (a stepped line), and the route below splits it at the step (round 4: a 복도 drawn
      // in one stroke under two rooms whose bottom walls are 0.2–0.38 snap apart doubled one of them, a 0 mm
      // piece and '[overlap]' followed, and the 복도 merged with a room).
      const ownLine = ends.map((s) => s.type === 'node' && Math.abs(s.point[key] - onto.line) > ON_TOL && w.edges.some((e) => {
        if (e.kind !== 'wall' || !parallelTo(e, orient)) return false;
        const A = pos(w, e.a), B = pos(w, e.b);
        if (Math.abs(A[key] - s.point[key]) > ON_TOL || Math.abs(B[key] - s.point[key]) > ON_TOL) return false;
        return Math.min(hi, Math.max(A[along], B[along])) - Math.max(lo, Math.min(A[along], B[along])) >= snap;
      }));
      const off = ps.map((pl, k) => ownLine[k] || Math.abs(pl.point[key] - onto.line) > ON_TOL);
      const i = off[0] && !off[1] ? 0 : off[1] && !off[0] ? 1 : -1;
      // Any other corner off the line meeting it as a T on a wall there, more than JOG × snap away: the wall
      // goes on that line, from that T (round 4: a 복도 wall drawn on to the facade beside the next room's
      // bottom wall, 60 mm off its line, left a 60 mm strip under that wall).
      const jog = i >= 0 && !ownLine[i] && ends[i].type === 'node' && Math.abs(ends[i].point[key] - onto.line) > JOG * snap
        ? planEnd(w, ends[i], raws[i], key, onto.line, snap, orient, raws[1 - i], true) : null;
      if (jog && jog.type === 'edge') ps[i] = jog;
      if (!off[0] && !off[1] || (jog && jog.type === 'edge')) {
        c = onto.line;
        plans = ps;
      } else if (route && i >= 0) {
        const pre = plans ? plans.map((pl) => pl.point[along]) : [p[along], q[along]];
        const lo2 = Math.min(...pre) + ON_TOL, hi2 = Math.max(...pre) - ON_TOL;
        const endPt = ownLine[i] ? ends[i].point : ps[i].point;
        const small = Math.abs(endPt[key] - onto.line) <= JOG * snap;
        let via = null;
        for (const n of w.nodes) {
          if (Math.abs(n[key] - onto.line) > ON_TOL || n[along] <= lo2 || n[along] >= hi2) continue;
          const own = incidentOf(w, n.id);
          if (!own.some((e) => e.kind === 'wall' && parallelTo(e, orient))) continue;
          // A wall at n going toward the corner's own line c: that line would run past it.
          const crosses = own.some((e) => isAxis(e) && !parallelTo(e, orient)
            && (c - n[key]) * (pos(w, otherEnd(e, n.id))[key] - n[key]) > ON_TOL * ON_TOL);
          if (!crosses && !small) continue;
          if (!via || Math.abs(n[along] - endPt[along]) < Math.abs(via[along] - endPt[along])) via = n;
        }
        if (via) {
          const V = { x: via.x, y: via.y };
          const first = addSegment(doc, p, V, { orient, kind, snap, sketchScale, pen: pen ? [pen[0], V] : null, route: false });
          const second = addSegment(first.doc, V, q, { orient, kind, snap, sketchScale, pen: pen ? [V, pen[1]] : null, route: false });
          return {
            doc: second.doc,
            edgeIds: [...first.edgeIds, ...second.edgeIds],
            splits: [...first.splits, ...second.splits],
            ends: [first.ends[0], second.ends[second.ends.length - 1]].filter(Boolean),
          };
        }
      }
    }
    // A corner kept off the line (SAME_LINE, or JOG) makes the wall a crooked h / v piece the solver
    // straightens. It must not run along an existing parallel wall lying between the two lines (round 3,
    // 2026-11-01): passing that wall's corner a few mm off, it took no breakpoint there and overlapped the
    // wall; the rooms on both sides merged ('[overlap] 벽 두 개가 겹쳐 그려졌습니다', although both walls are
    // needed). ht #27 drawn as a wall from 방2's corner to the corner above the T; a wall from one room's
    // corner along the next room's wall a few mm off and past its corner; a wall re-tracing a room's wall and
    // drawn on to the next room's corner off that line (the line c is then that wall's own, and the onto
    // search above skips it). When that wall lies on the kept corner's own line, the wall goes on that line
    // and the other end meets it as a T on its own wall, if it can (below). Then, more than JOG × snap off: a
    // T on the kept corner's own wall when there is one (0.6.8's plan: a piece 60–150 mm long at that corner,
    // as ht #27's 60–150 mm rule); else the wall goes through that parallel wall's corner nearest the kept
    // corner (the crooked piece ends there, and the rest re-traces that wall). Inside the two halves of a route
    // (route false) the T's only, not another split.
    if (plans) {
      const P0 = plans[0].point, Q0 = plans[1].point;
      const kept = [0, 1].find((i) => plans[i].type === 'node' && Math.abs(plans[i].point[key] - c) > ON_TOL);
      if (kept != null && Math.abs(P0[key] - Q0[key]) > ON_TOL) {
        const loK = Math.min(P0[key], Q0[key]) - ON_TOL, hiK = Math.max(P0[key], Q0[key]) + ON_TOL;
        const loA = Math.min(P0[along], Q0[along]) + ON_TOL, hiA = Math.max(P0[along], Q0[along]) - ON_TOL;
        let wall = null;
        for (const e of w.edges) {
          if (e.kind !== 'wall' || !parallelTo(e, orient)) continue;
          const A = pos(w, e.a), B = pos(w, e.b);
          if (Math.abs(A[key] - B[key]) > ON_TOL || A[key] < loK || A[key] > hiK) continue;
          const ov = Math.min(hiA, Math.max(A[along], B[along])) - Math.max(loA, Math.min(A[along], B[along]));
          if (ov > ON_TOL && (!wall || ov > wall.ov)) wall = { ov, line: A[key] };
        }
        const K = wall && plans[kept].point;
        const o = 1 - kept;
        // That wall on the kept corner's own line: the wall goes on that line, and the other end meets it as
        // a T on its own wall (round 4: a 복도 wall from one room's corner to where the next room's bottom wall
        // meets the facade left a 60 mm strip under that wall; a stroke re-tracing a stepped corridor line
        // split at the step ran its second half crooked along the next room's wall, a 0 mm piece followed).
        const altO = wall && Math.abs(wall.line - K[key]) <= ON_TOL
          ? planEnd(w, ends[o], raws[o], key, K[key], snap, orient, raws[kept], true) : null;
        if (altO && altO.type === 'edge') {
          c = K[key];
          plans[o] = altO;
          plans[kept] = planEnd(w, ends[kept], raws[kept], key, c, snap, orient, raws[o]);
        } else if (wall) {
          const offK = Math.abs(plans[kept].point[key] - c);
          const alt = planEnd(w, ends[kept], raws[kept], key, c, snap, orient, raws[1 - kept], true);
          if (offK > JOG * snap && alt.type === 'edge') plans[kept] = alt;
          else if (route) {
            let via = null;
            for (const n of w.nodes) {
              if (Math.abs(n[key] - wall.line) > ON_TOL || n[along] <= loA || n[along] >= hiA) continue;
              if (!incidentOf(w, n.id).some((e) => e.kind === 'wall' && parallelTo(e, orient))) continue;
              if (!via || Math.abs(n[along] - K[along]) < Math.abs(via[along] - K[along])) via = n;
            }
            if (via) {
              const V = { x: via.x, y: via.y };
              const first = addSegment(doc, p, V, { orient, kind, snap, sketchScale, pen: pen ? [pen[0], V] : null, route: false });
              const second = addSegment(first.doc, V, q, { orient, kind, snap, sketchScale, pen: pen ? [V, pen[1]] : null, route: false });
              return {
                doc: second.doc,
                edgeIds: [...first.edgeIds, ...second.edgeIds],
                splits: [...first.splits, ...second.splits],
                ends: [first.ends[0], second.ends[second.ends.length - 1]].filter(Boolean),
              };
            }
          }
        }
      }
    }
    ends.forEach((s, i) => {
      if (plans) { applyPlan(w, s, plans[i], sketchScale); return; }
      if (s.type === 'edge') {
        const e = w.edges.find((x) => x.id === s.edgeId);
        const pt = axisPointOnEdge(w, e, key, c);
        if (pt) { s.point = pt; return; }
        // The axis line misses this edge: its nearer endpoint, planned like a corner end.
        const A = pos(w, e.a), B = pos(w, e.b);
        const nb = dist(A, s.point) <= dist(B, s.point) ? A : B;
        Object.assign(s, { type: 'node', id: nb.id, point: { x: nb.x, y: nb.y }, dist: dist(raws[i], nb) });
        applyPlan(w, s, planEnd(w, s, raws[i], key, c, snap, orient, raws[1 - i]), sketchScale);
        return;
      }
      s.point[key] = c;
    });
  }

  const P = ends[0].point, Q = ends[1].point;
  const L = dist(P, Q);
  if (L < ON_TOL) return { doc, edgeIds: [], splits: [], ends: [] };

  // Breakpoints along P→Q: the ends, existing nodes lying on the segment, and crossings.
  const bps = [
    { t: 0, end: ends[0] },
    { t: 1, end: ends[1] },
  ];
  const tolT = ON_TOL / L;
  for (const n of w.nodes) {
    const pr = projectPointToSegment(n, P, Q);
    if (pr.dist <= ON_TOL && pr.t > tolT && pr.t < 1 - tolT) bps.push({ t: pr.t, nodeId: n.id });
  }
  for (const e of w.edges) {
    const A = pos(w, e.a), B = pos(w, e.b);
    const hit = segmentIntersection(P, Q, A, B);
    if (!hit) continue;
    const le = dist(A, B);
    if (hit.t <= tolT || hit.t >= 1 - tolT) continue;       // at our ends: handled by snapping
    if (hit.u * le <= ON_TOL || (1 - hit.u) * le <= ON_TOL) continue; // at its ends: a node breakpoint
    bps.push({ t: hit.t, point: hit.point, edgeId: e.id });
  }
  bps.sort((a, b) => a.t - b.t);

  const chain = [];
  for (const bp of bps) {
    let node;
    if (bp.end) {
      if (bp.end.type === 'node') node = pos(w, bp.end.id);
      else node = ensureNodeAt(w, bp.end.point);
    } else if (bp.nodeId) {
      node = pos(w, bp.nodeId);
    } else {
      node = ensureNodeAt(w, bp.point);
    }
    if (chain.length === 0 || chain[chain.length - 1] !== node.id) chain.push(node.id);
  }

  const edgeIds = [];
  const s = sketchScale > 0 ? sketchScale : 1;
  for (let i = 0; i + 1 < chain.length; i++) {
    const u = chain[i], v = chain[i + 1];
    if (u === v) continue;
    const existing = findEdgeBetween(w, u, v);
    if (existing) {
      // A wall drawn over a divider turns it into a wall.
      if (kind === 'wall' && existing.kind === 'divider') {
        const k = w.edges.indexOf(existing);
        w.edges[k] = { ...existing, kind: 'wall' };
      }
      edgeIds.push(existing.id);
      continue;
    }
    const a = pos(w, u), b = pos(w, v);
    w.edgeCounter += 1;
    // An h/v wall is drawn straight: no sketch component across it, even where it joins two corners a
    // little off one line (the solver then puts them on one line).
    const e = {
      id: 'e' + w.edgeCounter, a: u, b: v, kind, orient,
      sketch: { dx: orient === 'v' ? 0 : (b.x - a.x) / s, dy: orient === 'h' ? 0 : (b.y - a.y) / s },
      thickness: null,
    };
    w.edges.push(e);
    edgeIds.push(e.id);
  }
  return { doc: finish(w), edgeIds, splits: w.splits, ends: [chain[0], chain[chain.length - 1]] };
}

function edgeOrient(w, edgeId) {
  const e = w.edges.find((x) => x.id === edgeId);
  return e ? e.orient : null;
}

// Does this snapped end fix the segment's line (a corner, or a wall along the segment)?
function fixesLine(w, s, orient) {
  return s.type === 'node' || (s.type === 'edge' && edgeOrient(w, s.edgeId) === orient);
}

// How end `s` (snapped from pen point `raw`) would meet the line key = c, and what that costs (mm the pen
// end is moved, plus one snap for a loose end left behind). → { cost, type, id?, edgeId?, point, slide? }
// Alternatives for a corner or parallel wall off the line, the cheapest wins:
//  - slide: a loose end of a wall across the line slides along that wall onto it (both stay straight);
//  - same line: a corner at most SAME_LINE × snap off stays (one line drawn a little crooked: the solver
//    puts both corners on it);
//  - a T on a wall across the line near the pen end;
//  - a free end on the line.
// noSame: without the same-line option (addSegment: a kept corner whose crooked piece would run along a wall).
function planEnd(w, s, raw, key, c, snap, orient, toward = null, noSame = false) {
  const onLine = (pt) => { const o = { x: pt.x, y: pt.y }; o[key] = c; return o; };
  if (s.type === 'free') return { cost: Math.abs(raw[key] - c), type: 'free', point: onLine(raw) };
  if (!fixesLine(w, s, orient)) {
    const e = w.edges.find((x) => x.id === s.edgeId);
    const pt = axisPointOnEdge(w, e, key, c);
    // The JOG rule (below) for an end that snapped to the wall rather than its corner (round 2, 2026-10-31,
    // D6: a 구역 나누기 선's pen end 72 mm along 방1's wall from its corner snapped as a T, the line from the
    // other end put the T 21 mm beside that corner, and a 21 mm wall piece gave 거실 two phantom sides): a T
    // within JOG × snap of that wall's own end corner, where the new wall continues no wall of its line
    // there (no 'beside'), is that corner.
    if (pt && toward) {
      const al = key === 'y' ? 'x' : 'y';
      for (const N of [pos(w, e.a), pos(w, e.b)]) {
        const dN = dist(N, pt);
        if (dN <= ON_TOL || dN > snap * JOG) continue;
        const back = sgn(toward[al] - N[al]);
        if (!back) continue;
        const beside = incidentOf(w, N.id).some((x) => x.orient === orient && sgn(pos(w, otherEnd(x, N.id))[al] - N[al]) === back);
        if (beside) continue;
        return { cost: dist(raw, N), type: 'node', id: N.id, point: { x: N.x, y: N.y } };
      }
    }
    if (pt) return { cost: dist(raw, pt), type: 'edge', edgeId: e.id, point: pt };
    // The line misses this wall: its nearer end, as a corner.
    const A = pos(w, e.a), B = pos(w, e.b);
    const nb = dist(A, s.point) <= dist(B, s.point) ? A : B;
    return planEnd(w, { type: 'node', id: nb.id, point: { x: nb.x, y: nb.y }, dist: dist(raw, nb) }, raw, key, c, snap, orient, toward);
  }
  const off = Math.abs(s.point[key] - c);
  const same = s.type === 'node'
    ? { cost: s.dist, type: 'node', id: s.id, point: { ...s.point } }
    : { cost: s.dist, type: 'edge', edgeId: s.edgeId, point: { ...s.point } };
  if (off <= ON_TOL) return same;
  const options = [];
  if (s.type === 'node') {
    const slid = slideTarget(w, s.id, key, c, snap);
    if (slid) options.push({ cost: s.dist, type: 'node', id: s.id, point: slid, slide: true });
    if (off <= snap * SAME_LINE && !noSame) options.push(same);
  }
  // A T on one of this corner's own walls within JOG × snap of it, where the new wall CONTINUES a wall
  // line ending at the corner (an L corner, or the far side of a T; no wall of that line runs back beside
  // the new one), would only leave a jog piece a few mm long: the corner stays (final review 2026-10-28,
  // D6: a 구역 나누기 선 closing the 복도 ended 13 mm beside 방2's corner and added a 13 mm wall piece and two
  // phantom 주방 sides). Farther off it is another line (ht #27: 60–150 mm, a T on that wall).
  const along = key === 'y' ? 'x' : 'y';
  const back = toward ? sgn(toward[along] - s.point[along]) : 0;
  const beside = s.type === 'node' && incidentOf(w, s.id).some((e) => e.orient === orient
    && sgn(pos(w, otherEnd(e, s.id))[along] - s.point[along]) === back);
  const jog = (edgeId) => s.type === 'node' && off <= snap * JOG && back !== 0 && !beside
    && w.edges.some((e) => e.id === edgeId && (e.a === s.id || e.b === s.id));
  const t = axisSnapAcross(w, raw, key, c, snap, orient, jog);
  if (t) options.push({ cost: t.d, type: 'edge', edgeId: t.edgeId, point: t.point });
  // A corner two lines off (more than SAME_LINE × snap, at most one snap) with no wall across the line near the pen:
  // its wall across goes on to the line (extendTarget) rather than leaving a loose end beside it (round 5, fuzz of
  // round 4: a 복도 wall drawn between two room corners 0.56 snap apart, the pen nearer the lower one, ended loose
  // 168 mm below the upper corner; 확인필요 'dangling').
  else if (s.type === 'node' && off > snap * SAME_LINE && off <= snap && toward && !beside) {
    const X = extendTarget(w, s.id, key, c, orient, toward, snap);
    if (X) options.push({ cost: dist(raw, X) + off, type: 'node', id: s.id, point: { x: X.x, y: X.y }, extend: true, kind: X.kind, across: X.across, thickness: X.thickness, exterior: X.exterior });
  }
  options.push({ cost: Math.abs(raw[key] - c) + snap, type: 'free', point: onLine(raw) });
  return options.reduce((a, b) => (b.cost < a.cost - ON_TOL ? b : a));
}

function applyPlan(w, s, plan, sketchScale) {
  if (plan.slide) shiftNode(w, plan.id, plan.point, sketchScale);
  if (plan.extend) {
    // The corner's wall across, on to the line: a new piece of that wall from the corner, the new wall's end.
    const A = pos(w, plan.id);
    const X = newNode(w, plan.point.x, plan.point.y);
    const k = sketchScale > 0 ? sketchScale : 1;
    w.edgeCounter += 1;
    const piece = {
      id: 'e' + w.edgeCounter, a: plan.id, b: X.id, kind: plan.kind, orient: plan.across,
      sketch: { dx: (X.x - A.x) / k, dy: (X.y - A.y) / k }, thickness: plan.thickness,
    };
    if (typeof plan.exterior === 'boolean') piece.exterior = plan.exterior;
    w.edges.push(piece);
    Object.assign(s, { type: 'node', id: X.id, edgeId: undefined, point: { x: X.x, y: X.y } });
    return;
  }
  Object.assign(s, { type: plan.type, id: plan.id, edgeId: plan.edgeId, point: { x: plan.point.x, y: plan.point.y } });
}

// Where node `id`, the loose end of one h/v wall standing across the line key = c, would land if it slid
// along that wall onto the line: longer by up to `snap`, shorter by up to SAME_LINE × snap (a longer cut
// may be on purpose), never folded, never through another wall. → point | null
function slideTarget(w, id, key, c, snap) {
  const own = incidentOf(w, id);
  if (own.length !== 1) return null;
  const E = own[0];
  // The wall must stand across the line (an h line: a v wall, which slides in y).
  if (!((E.orient === 'v' && key === 'y') || (E.orient === 'h' && key === 'x'))) return null;
  const F = pos(w, id), G = pos(w, otherEnd(E, id));
  const dir = sgn(F[key] - G[key]);
  const ext = (c - F[key]) * dir;
  if (ext > snap + ON_TOL || ext < -snap * SAME_LINE - ON_TOL) return null;
  if ((c - G[key]) * dir <= ON_TOL) return null;
  const X = { x: F.x, y: F.y };
  X[key] = c;
  if (ext > 0 && !pathClear(w, F, X, new Set([E.id]))) return null;
  return X;
}

// Where corner `id` would meet the line key = c by its one wall across going on (planEnd 'extend'): that wall runs
// from the corner away from the line, the piece on to it crosses nothing and ends on nothing, and no wall of the
// new wall's direction runs beside that line (within 2 × SAME_LINE × snap) toward the other end `toward` (the new
// wall would double it). → { x, y, kind, across, thickness, exterior } | null
function extendTarget(w, id, key, c, orient, toward, snap) {
  const own = incidentOf(w, id);
  const across = own.filter((e) => isAxis(e) && !parallelTo(e, orient));
  if (across.length !== 1 || across[0].kind !== 'wall' || w.kind !== 'wall') return null;
  const E = across[0];
  const A = pos(w, id), G = pos(w, otherEnd(E, id));
  if ((c - A[key]) * (A[key] - G[key]) <= 0) return null;
  const X = { x: A.x, y: A.y };
  X[key] = c;
  if (!pathClear(w, A, X, new Set(own.map((e) => e.id)))) return null;
  if (w.nodes.some((n) => dist(n, X) <= ON_TOL)) return null;
  const al = key === 'y' ? 'x' : 'y';
  const lo = Math.min(A[al], toward[al]), hi = Math.max(A[al], toward[al]);
  for (const e of w.edges) {
    if (!parallelTo(e, orient)) continue;
    const P = pos(w, e.a), Q = pos(w, e.b);
    const d = Math.abs((P[key] + Q[key]) / 2 - c);
    if (d <= ON_TOL || d > 2 * SAME_LINE * snap) continue;
    if (Math.min(hi, Math.max(P[al], Q[al])) - Math.max(lo, Math.min(P[al], Q[al])) > ON_TOL) return null;
  }
  for (const e of w.edges) if (projectPointToSegment(X, pos(w, e.a), pos(w, e.b)).dist <= ON_TOL) return null;
  const out = { x: X.x, y: X.y, kind: E.kind, across: E.orient, thickness: E.thickness != null ? E.thickness : null };
  if (typeof E.exterior === 'boolean') out.exterior = E.exterior;
  return out;
}

// Nearest point within `snap` of `raw` where the axis line (key = c) crosses an edge that is not parallel
// to `orient`. → { edgeId, point } | null
function axisSnapAcross(w, raw, key, c, snap, orient, skip = null) {
  let best = null;
  for (const e of w.edges) {
    if (parallelTo(e, orient) || (skip && skip(e.id))) continue;
    const pt = axisPointOnEdge(w, e, key, c);
    if (!pt) continue;
    const d = dist(pt, raw);
    if (d <= snap && (!best || d < best.d)) best = { edgeId: e.id, point: pt, d };
  }
  return best;
}

// Remove an edge. Orphan nodes disappear; a node left with exactly two collinear edges of the same kind
// is dissolved and its two edges merged into one (sketch vectors summed). → doc
export function removeEdge(doc, edgeId) {
  const w = work(doc);
  if (!dropEdge(w, edgeId)) return doc;
  return finish(w);
}

// Remove several edges at once (the 지우개 tool, core/erase.js): all of them first, then the nodes they
// left are settled as removeEdge does (orphans go; a node left between two collinear edges of one kind
// is dissolved). One edge at a time could merge two edges of the list into one id before its turn.
// Unknown ids are ignored. → doc (the same object when nothing was removed)
export function removeEdges(doc, edgeIds) {
  const ids = new Set(edgeIds || []);
  const w = work(doc);
  const ends = [];
  const kept = [];
  for (const e of w.edges) {
    if (ids.has(e.id)) ends.push(e.a, e.b);
    else kept.push(e);
  }
  if (!ends.length) return doc;
  w.edges = kept;
  for (const nid of new Set(ends)) settle(w, nid);
  return finish(w);
}

// removeEdge on a working copy. → false when there is no such edge
function dropEdge(w, edgeId) {
  const idx = w.edges.findIndex((e) => e.id === edgeId);
  if (idx < 0) return false;
  const removed = w.edges[idx];
  w.edges.splice(idx, 1);
  for (const nid of [removed.a, removed.b]) settle(w, nid);
  return true;
}

// A node left with no edge disappears; one between exactly two collinear edges of one kind is dissolved.
function settle(w, nid) {
  if (!w.nodeMap.has(nid)) return;
  const incident = incidentOf(w, nid);
  if (incident.length === 0) {
    w.nodes = w.nodes.filter((n) => n.id !== nid);
    w.nodeMap.delete(nid);
  } else if (incident.length === 2) {
    mergeThrough(w, nid, incident[0], incident[1]);
  }
}

function incidentOf(w, id) { return w.edges.filter((e) => e.a === id || e.b === id); }
function otherEnd(e, id) { return e.a === id ? e.b : e.a; }
function isAxis(e) { return e.orient === 'h' || e.orient === 'v'; }

// Sketch vector of edge e oriented away from node `from`.
function sketchFrom(e, from) {
  return e.a === from ? { dx: e.sketch.dx, dy: e.sketch.dy } : { dx: -e.sketch.dx, dy: -e.sketch.dy };
}

function mergeThrough(w, nid, e1, e2) {
  if (e1.kind !== e2.kind || e1.orient !== e2.orient) return;
  const x = e1.a === nid ? e1.b : e1.a;
  const y = e2.a === nid ? e2.b : e2.a;
  if (x === y) return;
  if (findEdgeBetween(w, x, y)) return;
  const n = pos(w, nid), X = pos(w, x), Y = pos(w, y);
  const v1 = { x: X.x - n.x, y: X.y - n.y }, v2 = { x: Y.x - n.x, y: Y.y - n.y };
  const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
  if (l1 > EPS && l2 > EPS) {
    const cos = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
    if (cos > -0.999) return; // not straight through
  }
  // x → n along e1, then n → y along e2.
  const xn = sketchFrom(e1, x);
  const ny = sketchFrom(e2, nid);
  const merged = {
    ...e1, a: x, b: y,
    sketch: { dx: xn.dx + ny.dx, dy: xn.dy + ny.dy },
    thickness: e1.thickness != null ? e1.thickness : e2.thickness,
  };
  // 외벽 chosen by hand (core/exterior.js): kept like the thickness.
  if (typeof e1.exterior !== 'boolean' && typeof e2.exterior === 'boolean') merged.exterior = e2.exterior;
  const i1 = w.edges.indexOf(e1);
  w.edges[i1] = merged;
  w.edges = w.edges.filter((e) => e !== e2);
  w.nodes = w.nodes.filter((nd) => nd.id !== nid);
  w.nodeMap.delete(nid);
}

// ---- joining loose ends --------------------------------------------------------------------------

// Move node `id` to X. Its edges' sketch vectors grow or shrink by the same amount, so the rest of each
// wall keeps the length it was drawn with (a wall extended to its corner is "drawn" that much longer).
function shiftNode(w, id, X, sketchScale) {
  const n = pos(w, id);
  const s = sketchScale > 0 ? sketchScale : 1;
  const dx = (X.x - n.x) / s, dy = (X.y - n.y) / s;
  n.x = X.x; n.y = X.y;
  for (const e of w.edges) {
    if (e.b === id) e.sketch = { dx: e.sketch.dx + dx, dy: e.sketch.dy + dy };
    if (e.a === id) e.sketch = { dx: e.sketch.dx - dx, dy: e.sketch.dy - dy };
  }
}

// Merge node `from` into node `into` (they lie on one spot). An edge between them disappears; two edges
// that now join the same nodes become one (a wall wins over a divider). → into
function mergeNodeInto(w, from, into) {
  if (from === into) return into;
  for (let i = 0; i < w.edges.length; i++) {
    const e = w.edges[i];
    if (e.a === from || e.b === from) w.edges[i] = { ...e, a: e.a === from ? into : e.a, b: e.b === from ? into : e.b };
  }
  const seen = new Map();
  const keep = [];
  for (const e of w.edges) {
    if (e.a === e.b) continue;
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const prev = seen.get(k);
    if (prev) {
      if (e.kind === 'wall') prev.kind = 'wall';
      // 외벽 chosen by hand (core/exterior.js) on the wall that goes: kept, as mergeThrough keeps it.
      if (prev.kind === 'wall' && typeof prev.exterior !== 'boolean' && typeof e.exterior === 'boolean') prev.exterior = e.exterior;
      continue;
    }
    seen.set(k, e);
    keep.push(e);
  }
  w.edges = keep;
  w.nodes = w.nodes.filter((n) => n.id !== from);
  w.nodeMap.delete(from);
  return into;
}

// Move node `id` to X and join it to what is there: a node (merged into it) or an edge passing through
// (split there, keeping `id`). → the id of the node it ends as
function moveAndJoin(w, id, X, sketchScale) {
  shiftNode(w, id, X, sketchScale);
  for (const n of w.nodes) {
    if (n.id !== id && dist(n, X) <= ON_TOL) {
      const into = n.id;
      mergeNodeInto(w, id, into);
      settle(w, into);
      return into;
    }
  }
  const own = new Set(incidentOf(w, id).map((e) => e.id));
  for (const e of w.edges) {
    if (own.has(e.id)) continue;
    const A = pos(w, e.a), B = pos(w, e.b);
    if (projectPointToSegment(X, A, B).dist > ON_TOL) continue;
    const m = splitEdgeAt(w, e.id, X);
    // The split point is exact on an h/v wall; the joined end takes it.
    shiftNode(w, id, { x: m.x, y: m.y }, sketchScale);
    mergeNodeInto(w, m.id, id);
    return id;
  }
  return id;
}

// Does the straight piece A→B (an extension about to be added) stay clear of every edge but `ignore`?
// Touching at B (the joint) is fine.
function pathClear(w, A, B, ignore) {
  for (const e of w.edges) {
    if (ignore.has(e.id)) continue;
    const hit = segmentIntersection(A, B, pos(w, e.a), pos(w, e.b));
    if (hit && dist(hit.point, B) > ON_TOL) return false;
  }
  return true;
}

function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

// After a stroke (ht #12, #13): join loose ends around the stroke's walls, in this order.
//  1. A free outer end of the stroke and an old free end of a wall across it meet at their corner (each
//     moves along its own line, up to CORNER × snap). Failing that, the end runs on to a wall across its
//     line within snap (a wall re-traced from loose end to loose end).
//  2. An old free end within snap of a new wall across it (h, v or diagonal) moves along its own line onto
//     that wall, so a wall drawn BEFORE the wall it ends on is joined like one drawn after it; one that runs
//     past the new wall (which crosses it or ends on it) by up to OLD_CROSS × snap is cut back to it.
//  3. A piece the stroke drew past a wall (ending free, the stroke going on behind the wall) is dropped
//     when shorter than STUB × snap: an overshoot, not a wall.
// An old wall moves only for a new wall, except in step 2 (an old wall end onto a new divider across it);
// old dividers move for both. Every change is checked: one that would make walls cross or overlap is
// skipped.
// opts: { edgeIds: the stroke's pieces, ends: [nodeId, nodeId] its two outer ends, before: the doc before
// the stroke, snap, kind, sketchScale } → { doc, edgeIds (the stroke's pieces now), splits, removed }
export function joinStrokeEnds(doc, { edgeIds = [], ends = [], before = null, snap = 200, kind = 'wall', sketchScale = 1 } = {}) {
  const oldNodes = new Set(((before && before.nodes) || []).map((n) => n.id));
  const oldEdges = new Set(((before && before.edges) || []).map((e) => e.id));
  const stroke = new Set(edgeIds);
  const splits = [];
  const removed = [];
  const mayMove = (e) => e.kind === 'divider' || kind === 'wall' || (!oldEdges.has(e.id) && stroke.has(e.id));
  const fresh = (e) => stroke.has(e.id) && !oldEdges.has(e.id);
  let out = doc;

  // Run one change on a working copy; keep it only when the touched walls stay planar.
  const attempt = (fn) => {
    const w = work(out);
    wNow = w;
    const touched = fn(w);
    if (!touched) return false;
    const next = finish(w);
    const ids = new Set();
    for (const e of next.edges) if (touched.has(e.a) || touched.has(e.b)) ids.add(e.id);
    if (ids.size && findPlanarityProblem(next, { onlyEdges: ids })) return false;
    for (const s of w.splits) {
      splits.push(s);
      if (stroke.has(s.from)) stroke.add(s.to);
    }
    out = next;
    return true;
  };
  const degree = (w, id) => incidentOf(w, id).length;
  const outerEnds = [...new Set(ends.filter(Boolean))];
  // A piece that would be `left` long after a move: fine when it stays longer than ON_TOL, or when it
  // vanishes at a junction `at` (a stub past a wall collapsing onto it); never folded back past `at`.
  let wNow = null;
  const keeps = (left, at) => left > ON_TOL || (left >= -ON_TOL && wNow && incidentOf(wNow, at.id).length >= 3);

  // 1. Corners at the stroke's free ends.
  for (const nid of outerEnds) {
    attempt((w) => {
      if (!w.nodeMap.has(nid) || degree(w, nid) !== 1) return null;
      const S = incidentOf(w, nid)[0];
      if (!isAxis(S) || !stroke.has(S.id) || !mayMove(S)) return null;
      const N = pos(w, nid), P = pos(w, otherEnd(S, nid));
      const along = S.orient === 'h' ? 'x' : 'y', cross = S.orient === 'h' ? 'y' : 'x';
      const dN = sgn(N[along] - P[along]);
      const lenS = Math.abs(N[along] - P[along]);
      let best = null;
      for (const F of w.nodes) {
        if (F.id === nid || !oldNodes.has(F.id) || degree(w, F.id) !== 1) continue;
        const E = incidentOf(w, F.id)[0];
        if (!isAxis(E) || E.orient === S.orient || stroke.has(E.id) || !mayMove(E)) continue;
        const G = pos(w, otherEnd(E, F.id));
        const X = {};
        X[along] = F[along];
        X[cross] = N[cross];
        const extN = (X[along] - N[along]) * dN;
        const dF = sgn(F[cross] - G[cross]);
        const extF = (X[cross] - F[cross]) * dF;
        // Each grows by up to CORNER × snap. The new end is cut back only by a pen overshoot (one snap):
        // a wall going on well past the other wall's line meets it as a T (step 2), not a corner. The old
        // end is cut back by one snap where the stroke reached its line, else only by OLD_TRIM. Two walls
        // that both run past their corner (they cross) are both cut back by up to STUB × snap.
        const crossing = extN < -ON_TOL && extF < -ON_TOL;
        const trimN = crossing ? STUB * snap : snap;
        const trimF = crossing ? STUB * snap : extN <= ON_TOL ? snap : snap * OLD_TRIM;
        if (extN > CORNER * snap + ON_TOL || -extN > trimN + ON_TOL) continue;
        if (extF > CORNER * snap + ON_TOL || -extF > trimF + ON_TOL) continue;
        // Neither line folds back past its other end; a piece shrunk to nothing must be a stub past a
        // junction (it then disappears).
        if (!keeps(lenS + extN, P) || !keeps(Math.abs(F[cross] - G[cross]) + extF, G)) continue;
        const ignore = new Set([S.id, E.id]);
        if (extN > ON_TOL && !pathClear(w, N, X, ignore)) continue;
        if (extF > ON_TOL && !pathClear(w, F, X, ignore)) continue;
        const cost = Math.abs(extN) + Math.abs(extF);
        if (!best || cost < best.cost) best = { cost, X, F: F.id };
      }
      if (!best) {
        // Run on to a wall across the line ahead (within snap).
        for (const T of w.edges) {
          if (T.id === S.id || parallelTo(T, S.orient)) continue;
          const X = axisPointOnEdge(w, T, cross, N[cross]);
          if (!X) continue;
          const ext = (X[along] - N[along]) * dN;
          if (ext <= ON_TOL || ext > snap + ON_TOL) continue;
          if (!pathClear(w, N, X, new Set([S.id, T.id]))) continue;
          if (!best || ext < best.cost) best = { cost: ext, X, F: null };
        }
      }
      if (!best) return null;
      const at = moveAndJoin(w, nid, best.X, sketchScale);
      const touched = new Set([at]);
      if (best.F && w.nodeMap.has(best.F)) touched.add(moveAndJoin(w, best.F, best.X, sketchScale));
      return touched;
    });
  }

  // 2. Old free ends near the new walls.
  const deg = new Map();
  for (const e of out.edges) for (const id of [e.a, e.b]) deg.set(id, (deg.get(id) || 0) + 1);
  for (const fid of [...oldNodes].filter((id) => deg.get(id) === 1)) {
    attempt((w) => {
      if (!w.nodeMap.has(fid) || degree(w, fid) !== 1) return null;
      const E = incidentOf(w, fid)[0];
      // A wall end near a new 구역 나누기 선 across its line is joined to it as after a wall: one it CROSSES
      // is cut back to it (final review 2026-10-28, D6: the 거실 | 주방 wall drawn 0.2 snap past where the
      // 복도's 구역 나누기 선 came later kept a 36 mm stub, a 확인필요 'not joined' on a correct plan, about
      // 4 px on screen to drag), and one that stops short of it grows onto it within one snap (round 2,
      // 2026-10-31: 11 of 25 D6 sketches kept the end loose 0.1–0.6 snap short, 거실 and 주방 were one room
      // and a false 'fold' blamed a correct value; drawn in the other order, or with a wall, it was joined).
      // Other moves of a wall stay for walls (step 1: a divider's own free ends do not pull walls).
      const toDivider = !mayMove(E) && kind === 'divider' && E.kind === 'wall';
      if (!isAxis(E) || stroke.has(E.id) || (!mayMove(E) && !toDivider)) return null;
      const F = pos(w, fid), G = pos(w, otherEnd(E, fid));
      const key = E.orient === 'v' ? 'y' : 'x', other = E.orient === 'v' ? 'x' : 'y';
      const dF = sgn(F[key] - G[key]);
      const lenE = Math.abs(F[key] - G[key]);
      let best = null;
      for (const S of w.edges) {
        // A new diagonal across its line counts too (the wall line meets it where it crosses).
        if (!fresh(S) || S.orient === E.orient) continue;
        const A = pos(w, S.a), B = pos(w, S.b);
        const lo = Math.min(A[other], B[other]) - ON_TOL, hi = Math.max(A[other], B[other]) + ON_TOL;
        if (F[other] < lo || F[other] > hi) continue;
        // Where F's wall line meets S (S may join two corners a little off one line).
        const span = B[other] - A[other];
        const X = {};
        X[other] = F[other];
        X[key] = Math.abs(span) > EPS ? A[key] + (B[key] - A[key]) * (F[other] - A[other]) / span : A[key];
        const ext = (X[key] - F[key]) * dF;
        if (Math.abs(ext) <= ON_TOL) continue;
        if (ext > 0) {
          if (ext > snap + ON_TOL || !pathClear(w, F, X, new Set([E.id, S.id]))) continue;
        } else if (-ext > snap * OLD_CROSS + ON_TOL || !keeps(lenE + ext, G)) {
          // F runs past S (S crosses its wall or ends on it): a stub up to one snap is cut back to S.
          continue;
        }
        if (!best || Math.abs(ext) < best.cost) best = { cost: Math.abs(ext), X };
      }
      if (!best) return null;
      return new Set([moveAndJoin(w, fid, best.X, sketchScale)]);
    });
  }

  // 3. Overshoots past a wall (for a wall stroke, past a WALL: a wall going on past a divider may be
  // waiting for its own wall).
  for (const nid of outerEnds) {
    let dropped = null;
    const ok = attempt((w) => {
      if (!w.nodeMap.has(nid) || degree(w, nid) !== 1) return null;
      const S = incidentOf(w, nid)[0];
      if (!fresh(S)) return null;
      const jid = otherEnd(S, nid);
      const atJ = incidentOf(w, jid);
      if (atJ.length < 3) return null;
      const behind = atJ.some((e) => e.id !== S.id && stroke.has(e.id));
      // The stroke closing on itself counts like a wall: a rectangle started a little before the corner
      // its closing leg reaches leaves its first piece past that leg (final review 2026-10-28, E2: a 22 mm
      // stub and a 확인필요 'not joined'; §7.13 drops the stroke's own overshoots).
      const self = kind === 'wall' && atJ.filter((e) => e.id !== S.id && stroke.has(e.id)).length >= 2;
      const wall = self || atJ.some((e) => !stroke.has(e.id) && (kind === 'divider' || e.kind === 'wall'));
      if (!behind || !wall || dist(pos(w, S.a), pos(w, S.b)) >= STUB * snap) return null;
      dropEdge(w, S.id);
      dropped = S.id;
      return new Set(w.nodeMap.has(jid) ? [jid] : []);
    });
    if (ok && dropped) {
      stroke.delete(dropped);
      removed.push(dropped);
    }
  }

  const ids = new Set(out.edges.map((e) => e.id));
  return {
    doc: out,
    edgeIds: [...stroke].filter((id) => ids.has(id)),
    splits: splits.filter((s) => ids.has(s.from) && ids.has(s.to)),
    removed,
  };
}

// Drop a loose wall end (a node with one edge) at (x, y) and join it to the corner or wall within `snap`
// that it is dropped on (ht #12: such a drag was refused as a crossing, so a loose end could not be
// joined by hand). The wall keeps its direction: the end lands where the drop meets that wall.
// → doc, or null when nothing is within reach (the caller makes a plain move).
export function dropLooseEnd(doc, nodeId, x, y, { snap = 200, sketchScale = 1 } = {}) {
  const w0 = work(doc);
  if (!w0.nodeMap.has(nodeId)) return null;
  const own = incidentOf(w0, nodeId);
  if (own.length !== 1) return null;
  const E = own[0];
  const gid = otherEnd(E, nodeId);
  const D = { x, y };
  const target = snapEnd(w0, D, snap, E.orient, { nodes: new Set([nodeId, gid]), edges: new Set([E.id]) });
  if (target.type === 'free') return null;
  let T = target.point;
  // The dragged wall stays h/v: on a wall across it the end slides to where the drop meets that wall.
  if (target.type === 'edge' && isAxis(E)) {
    const key = E.orient === 'v' ? 'x' : 'y';
    const te = w0.edges.find((e) => e.id === target.edgeId);
    const pt = axisPointOnEdge(w0, te, key, D[key]);
    if (pt) T = pt;
  }
  const moved = moveNode(doc, nodeId, T.x, T.y, { sketchScale });
  const w = work(moved);
  const at = pos(w, nodeId);
  if (!at || dist(at, T) > ON_TOL) return null;
  if (target.type === 'node') {
    if (!w.nodeMap.has(target.id) || dist(pos(w, target.id), at) > ON_TOL) return null;
    mergeNodeInto(w, nodeId, target.id);
    settle(w, target.id);
    return finish(w);
  }
  const te = w.edges.find((e) => e.id === target.edgeId);
  if (!te || projectPointToSegment(at, pos(w, te.a), pos(w, te.b)).dist > ON_TOL) return null;
  moveAndJoin(w, nodeId, { x: at.x, y: at.y }, sketchScale);
  return finish(w);
}

// Move a node. h/v edges stay axis-aligned: every node joined to it through h edges takes the new y,
// every node joined through v edges takes the new x. Sketch vectors of the touched edges follow the new
// geometry (the drag is the user's new "as drawn" shape). → doc
export function moveNode(doc, nodeId, x, y, { sketchScale = 1 } = {}) {
  const w = work(doc);
  const start = pos(w, nodeId);
  if (!start) return doc;
  const moved = new Set();
  const spread = (orient, key, value) => {
    const seen = new Set([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const id = queue.pop();
      const n = pos(w, id);
      if (n[key] !== value) { n[key] = value; moved.add(id); }
      for (const e of w.edges) {
        if (e.orient !== orient) continue;
        const other = e.a === id ? e.b : e.b === id ? e.a : null;
        if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
  };
  spread('h', 'y', y);
  spread('v', 'x', x);
  for (let i = 0; i < w.edges.length; i++) {
    const e = w.edges[i];
    if (moved.has(e.a) || moved.has(e.b)) w.edges[i] = { ...e, sketch: geometricSketch(w, e, sketchScale) };
  }
  return finish(w);
}

// First problem that would make the wall graph non-planar, or null. Used to refuse a corner drag that
// would push a wall across or onto another wall (addSegment keeps the graph planar; moveNode does not
// re-planarise, so its result is checked instead).
//   - 'short':   an edge shorter than minLen
//   - 'cross':   two edges that cross, or an edge end touching another edge away from a shared node
//   - 'overlap': two edges lying on top of each other along a line
// onlyEdges (Set of edge ids, optional): check only pairs involving these edges.
// → { type, edgeIds: [..] } | null
export function findPlanarityProblem(doc, { minLen = 1, onlyEdges = null } = {}) {
  const nodeMap = new Map((doc.nodes || []).map((n) => [n.id, n]));
  const edges = (doc.edges || []).filter((e) => nodeMap.has(e.a) && nodeMap.has(e.b));
  const P = (id) => nodeMap.get(id);
  for (const e of edges) {
    if (onlyEdges && !onlyEdges.has(e.id)) continue;
    if (dist(P(e.a), P(e.b)) < minLen) return { type: 'short', edgeIds: [e.id] };
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (onlyEdges && !onlyEdges.has(e.id) && !onlyEdges.has(f.id)) continue;
      const problem = edgePairProblem(e, f, P);
      if (problem) return { type: problem, edgeIds: [e.id, f.id] };
    }
  }
  return null;
}

function edgePairProblem(e, f, P) {
  const shared = [e.a, e.b].filter((id) => id === f.a || id === f.b);
  if (shared.length === 2) return 'overlap';
  const A = P(e.a), B = P(e.b), C = P(f.a), D = P(f.b);
  if (shared.length === 1) {
    // Two edges leaving one node: they overlap when they leave in the same direction.
    const s = P(shared[0]);
    const x = P(e.a === shared[0] ? e.b : e.a), y = P(f.a === shared[0] ? f.b : f.a);
    const u = { x: x.x - s.x, y: x.y - s.y }, v = { x: y.x - s.x, y: y.y - s.y };
    const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
    if (lu < EPS || lv < EPS) return null; // zero-length edges are reported as 'short'
    const sin = (u.x * v.y - u.y * v.x) / (lu * lv), cos = (u.x * v.x + u.y * v.y) / (lu * lv);
    // Same direction: the shorter edge lies on the longer one (within ON_TOL at its far end).
    if (cos > 0 && Math.abs(sin) * Math.min(lu, lv) < ON_TOL) return 'overlap';
    return null;
  }
  if (segmentIntersection(A, B, C, D)) return 'cross';
  // Parallel or nearly touching: an end of one edge lying on the other.
  for (const [p, a, b] of [[C, A, B], [D, A, B], [A, C, D], [B, C, D]]) {
    if (projectPointToSegment(p, a, b).dist < ON_TOL) return 'overlap';
  }
  return null;
}

// ---- queries -------------------------------------------------------------------------------------

export function nearestNode(doc, point, maxDist = Infinity) {
  return nearestNodeIn(doc.nodes || [], point, maxDist);
}

// → { edgeId, dist, t } | null
export function nearestEdge(doc, point, maxDist = Infinity) {
  const nodeMap = new Map((doc.nodes || []).map((n) => [n.id, n]));
  let best = null;
  for (const e of doc.edges || []) {
    const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
    if (!A || !B) continue;
    const pr = projectPointToSegment(point, A, B);
    if (pr.dist <= maxDist && (!best || pr.dist < best.dist)) best = { edgeId: e.id, dist: pr.dist, t: pr.t };
  }
  return best;
}

// Direction angle of the half-edge from node `from` along edge e (atan2, y-down).
// Uses the current geometry; falls back to the sketch vector for zero-length edges.
function halfEdgeAngle(e, from, A, B) {
  let dx = B.x - A.x, dy = B.y - A.y;
  if (Math.hypot(dx, dy) < EPS && e.sketch) { dx = e.sketch.dx; dy = e.sketch.dy; }
  if (e.orient === 'h') { dy = 0; dx = Math.sign(dx) || 1; }
  else if (e.orient === 'v') { dx = 0; dy = Math.sign(dy) || 1; }
  if (from !== e.a) { dx = -dx; dy = -dy; }
  return Math.atan2(dy, dx);
}

// Interior faces by half-edge traversal.
// → [{ nodeIds, edgeIds, points, area }]; edgeIds[i] joins nodeIds[i] → nodeIds[i+1] (cyclic).
// Faces run clockwise on screen (area > 0); the outer face of each component (area < 0) and degenerate
// faces are dropped. Dangling edges are allowed (they appear twice in the surrounding face's walk).
export function findFaces(doc) {
  const nodeMap = new Map((doc.nodes || []).map((n) => [n.id, n]));
  const around = new Map(); // nodeId → [{ to, edgeId, angle, key }]
  const halfKey = (e, from) => e.id + (from === e.a ? '>' : '<');
  for (const e of doc.edges || []) {
    const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
    if (!A || !B || e.a === e.b) continue;
    for (const [from, to] of [[e.a, e.b], [e.b, e.a]]) {
      if (!around.has(from)) around.set(from, []);
      around.get(from).push({ from, to, edgeId: e.id, angle: halfEdgeAngle(e, from, A, B), key: halfKey(e, from) });
    }
  }
  const slot = new Map(); // half-edge key → { list, index }
  for (const list of around.values()) {
    list.sort((p, q) => p.angle - q.angle);
    list.forEach((h, i) => slot.set(h.key, { list, index: i }));
  }
  const twinKey = (h) => h.edgeId + (h.key.endsWith('>') ? '<' : '>');

  const faces = [];
  const visited = new Set();
  const maxSteps = 2 * (doc.edges || []).length + 2;
  for (const list of around.values()) {
    for (const start of list) {
      if (visited.has(start.key)) continue;
      const nodeIds = [], edgeIds = [];
      let h = start, steps = 0, ok = true;
      do {
        visited.add(h.key);
        nodeIds.push(h.from);
        edgeIds.push(h.edgeId);
        // Arriving at h.to: continue with the half-edge just clockwise-before the twin.
        const { list: l, index } = slot.get(twinKey(h));
        h = l[(index - 1 + l.length) % l.length];
        if (++steps > maxSteps) { ok = false; break; }
      } while (h.key !== start.key);
      if (!ok) continue;
      const points = nodeIds.map((id) => ({ x: nodeMap.get(id).x, y: nodeMap.get(id).y }));
      const area = polygonArea(points);
      if (area > AREA_EPS) faces.push({ nodeIds, edgeIds, points, area });
    }
  }
  return faces;
}

// → Map edgeId → [leftFaceIndex | null, rightFaceIndex | null], relative to the direction a → b.
// (Faces run clockwise, so a face lies on the right of each half-edge in its walk.)
export function edgeFaces(doc, faces) {
  const map = new Map();
  const byId = new Map();
  for (const e of doc.edges || []) { map.set(e.id, [null, null]); byId.set(e.id, e); }
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.edgeIds.length; k++) {
      const e = byId.get(f.edgeIds[k]);
      if (!e) continue;
      const slotPair = map.get(e.id);
      if (f.nodeIds[k] === e.a) slotPair[1] = fi; else slotPair[0] = fi;
    }
  });
  return map;
}
