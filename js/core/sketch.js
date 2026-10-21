// Stroke straightening (DESIGN.md §3.2): a hand-drawn stroke becomes straight wall segments.
//
// Steps:
//  1. Douglas–Peucker splits the stroke at sharp turns into pieces.
//  2. Each piece is classified as 'h', 'v' (within axisSnapDeg of an axis) or 'd' (diagonal); otherwise the
//     nearer axis wins. allowDiagonal true: every other piece is 'd'; 'auto' (the app's wall tool since
//     2026-10-19): only a piece that is clearly a drawn slanted line (see AUTO_DIAGONAL below); false:
//     never.
//  3. Consecutive pieces of the same class and direction are merged; pieces shorter than minLength are
//     dropped (their neighbours are joined instead).
//  4. Every piece gets a straight line (h: mean y, v: mean x, d: fitted to its pen points at the drawn
//     angle, never snapped to 45° or any other angle); corners are the intersections of neighbouring lines,
//     so consecutive segments share their endpoint exactly.
//     An open stroke whose first (last) pen point snaps to an existing corner or a wall along the piece
//     (opts.anchorStart / anchorEnd, decided by the caller) puts its first (last) line through that point
//     instead: a long wall started at a corner and drifting a few degrees otherwise left the corner by
//     half the drift (ht #14). A diagonal runs through the corners it starts / ends at (both: exactly
//     corner to corner; one: through it at the angle that fits the pen points best) and ends there.
//  5. A stroke that ends near its start is closed exactly (a rectangle drawn in one stroke → 4 segments).

import { EPS, dist, douglasPeucker } from './geom.js';

const DEG = Math.PI / 180;

// allowDiagonal 'auto': a piece more than axisSnapDeg away from both axes becomes a diagonal wall when it
// is a deliberate slanted line, not a rounded corner of a quick L, a hook at a stroke end or pen / finger
// jitter (those keep the nearest axis and merge with their neighbours). All lengths below are in
// cornerTolerance units, ct (the app passes half its 18 px snap: 9 screen px at every zoom 0.03–0.3 px/mm).
// The Douglas–Peucker corners are first moved to where the pieces fit straight lines best (refineVertices).
//  - A piece between two other long pieces (a chamfer, or the arc of a rounded corner): its chord at least
//    minLen (4 ct = 36 px), its bow (the one-signed curvature of a parabola fitted across its line) at most
//    bowRel × chord − bowCut, no pen point farther than max(devAbs, devRel × chord) from its line. The arc
//    a corner rounded with radius R leaves bows by about chord² / 8R; a chamfer's pen points barely bow.
//  - The stroke's only long piece (one slanted line): chord ≥ minLength (the stroke's own minimum, 3 ct),
//    bow ≤ max(aloneBow, aloneRel × chord), deviation ≤ max(aloneDev, devRel × chord).
//  - A piece at the stroke's start or end: chord ≥ minLength (no rounded corner lies there), else as a
//    chamfer.
//  - Consecutive off-axis pieces are tried as one first (a long diagonal split by a slight bow); when they
//    are not one line (the two halves of a rounded corner), each needs splitMin (6 ct).
//  - A neighbour running within growDeg of a diagonal joins it when the two stay straight together: the
//    whole is a diagonal, or an axis wall when it runs within the axis snap (a 17° wall bowed past 20°).
// Measured on generated strokes (S-pen and finger models, 0.03–0.3 px/mm; dev/DESIGN.md §7.14): no diagonal
// from corners rounded up to 40 px with the S-pen, ≤ 1 % with a finger; one diagonal from every lone
// slanted line ≥ 30 px at 25°–65°, from chamfers ≥ 50 px with the S-pen (≥ 70 px with a finger) and from
// 95 % of 40 px S-pen chamfers.
export const AUTO_DIAGONAL = Object.freeze({
  minLen: 4, splitMin: 6, bowRel: 0.08, bowCut: 0.12, aloneBow: 0.3, aloneRel: 0.08, devAbs: 0.8, aloneDev: 1.2, devRel: 0.1,
  growDeg: 15,
});

// points: [{x,y}] in world mm. opts: { cornerTolerance = 50, allowDiagonal = false | true | 'auto',
// axisSnapDeg = 20, minLength = 3 × cornerTolerance, closeTolerance = 3 × cornerTolerance,
// anchorStart, anchorEnd: { x, y, fixX, fixY, dist } | null — where the first / last pen point snaps; fixX /
// fixY: which coordinate that fixes (a corner both, a horizontal wall y, a vertical wall x); dist: how far
// the pen point is from it (when both ends fix the same line differently, the nearer one wins);
// autoRule: overrides of AUTO_DIAGONAL (tests) }
// → [{ p, q, orient }]
export function straightenStroke(points, opts = {}) {
  const ct = opts.cornerTolerance > 0 ? opts.cornerTolerance : 50;
  const auto = opts.allowDiagonal === 'auto';
  const allowDiagonal = auto ? false : !!opts.allowDiagonal;
  const snapRad = (opts.axisSnapDeg != null ? opts.axisSnapDeg : 20) * DEG;
  const minLength = opts.minLength != null ? opts.minLength : 3 * ct;
  const closeTol = opts.closeTolerance != null ? opts.closeTolerance : 3 * ct;

  const pts = cleanPoints(points);
  if (pts.length < 2) return [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  if (total < minLength) return [];

  // 1. Split at sharp turns. DP keeps indices implicitly; recover them by identity.
  const simplified = douglasPeucker(pts, ct);
  let idx = [];
  for (let i = 0, j = 0; i < pts.length && j < simplified.length; i++) {
    if (pts[i] === simplified[j]) { idx.push(i); j++; }
  }
  if (auto) idx = refineVertices(pts, idx);

  // 2. Classify pieces.
  let pieces = [];
  for (let k = 0; k + 1 < idx.length; k++) {
    pieces.push(makePiece(pts, idx[k], idx[k + 1], allowDiagonal, snapRad));
  }
  if (auto) {
    const rule = { ...AUTO_DIAGONAL, ...(opts.autoRule || {}) };
    pieces = autoDiagonals(pts, pieces, { ct, snapRad, minLength, rule });
  }

  // 3. Merge similar neighbours, drop short pieces, merge again.
  pieces = mergeRuns(pts, pieces, allowDiagonal, snapRad);
  const longEnough = pieces.filter((pc) => pc.length >= minLength);
  if (longEnough.length === 0) {
    // Only short wiggles: keep the single longest piece so a short deliberate wall still appears.
    pieces = [pieces.reduce((a, b) => (b.length > a.length ? b : a))];
  } else {
    pieces = mergeRuns(pts, longEnough, allowDiagonal, snapRad);
  }

  // 5. Closed stroke?
  let closed = pieces.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= closeTol;
  if (closed) {
    const first = pieces[0], last = pieces[pieces.length - 1];
    if (sameRun(first, last)) {
      pieces = pieces.slice(1, pieces.length - 1);
      pieces.unshift(combine(pts, last, first, allowDiagonal, snapRad));
    }
    if (pieces.length < 3) closed = false;
  }

  // 4. Lines and corners.
  const lines = pieces.map((pc) => fitLine(pts, pc));
  const n = pieces.length;
  if (!closed) {
    anchorLine(pts, lines, 0, pieces[0], opts.anchorStart, n === 1 ? opts.anchorEnd : null, 'start');
    if (n > 1) anchorLine(pts, lines, n - 1, pieces[n - 1], opts.anchorEnd, null, 'end');
  }
  const corners = []; // corners[i] = point between piece i and piece i+1 (cyclic when closed)
  for (let i = 0; i < n; i++) {
    if (!closed && i === n - 1) break;
    const j = (i + 1) % n;
    const joint = pts[pieces[i].end];
    corners.push(lineCorner(lines[i], lines[j], joint));
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    let p, q;
    if (closed) {
      p = corners[(i - 1 + n) % n];
      q = corners[i];
    } else {
      // A diagonal anchored at a corner ends exactly there.
      p = i === 0 ? (lines[0].startAt || projectToLine(pts[pieces[0].start], lines[0])) : corners[i - 1];
      q = i === n - 1 ? (lines[n - 1].endAt || projectToLine(pts[pieces[n - 1].end], lines[n - 1])) : corners[i];
    }
    if (dist(p, q) < EPS) continue;
    out.push({ p: { x: p.x, y: p.y }, q: { x: q.x, y: q.y }, orient: pieces[i].orient });
  }
  return out;
}

// Classify a direction vector. → { orient, angle } (angle in radians, atan2 convention).
export function classifyDirection(v, allowDiagonal = false, snapRad = 20 * DEG) {
  const angle = Math.atan2(v.y, v.x);
  const a = Math.abs(angle);
  const fromH = Math.min(a, Math.PI - a);    // 0..π/2
  const fromV = Math.abs(Math.PI / 2 - a);   // 0..π/2
  let orient;
  if (fromH <= snapRad && fromH <= fromV) orient = 'h';
  else if (fromV <= snapRad) orient = 'v';
  else if (allowDiagonal === true) orient = 'd';
  else orient = fromH <= fromV ? 'h' : 'v';
  return { orient, angle };
}

// ---- internals -----------------------------------------------------------------------------------

function cleanPoints(points) {
  const out = [];
  for (const p of points || []) {
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function makePiece(pts, start, end, allowDiagonal, snapRad) {
  const v = { x: pts[end].x - pts[start].x, y: pts[end].y - pts[start].y };
  const { orient, angle } = classifyDirection(v, allowDiagonal, snapRad);
  return { start, end, orient, angle, dir: v, length: Math.hypot(v.x, v.y) };
}

// More than snapRad away from both axes.
function offAxis(v, snapRad) {
  return classifyDirection(v, true, snapRad).orient === 'd';
}

// allowDiagonal 'auto' (see AUTO_DIAGONAL): turn the deliberate slanted pieces into 'd' pieces (one piece
// for each diagonal, spanning its raw pen points); every other piece keeps its nearest axis.
function autoDiagonals(pts, pieces, { ct, snapRad, minLength, rule }) {
  const n = pieces.length;
  const off = pieces.map((pc) => offAxis(pc.dir, snapRad));
  // Pieces i..j are the stroke's only long piece(s): one slanted line (no rounded corner can be mistaken).
  const alone = (i, j) => pieces.every((pc, k) => (k >= i && k <= j) || pc.length < minLength);
  const span = (i, j, min) => {
    const solo = alone(i, j);
    // A rounded corner lies between two walls: a piece at the stroke's start or end needs only minLength.
    const need = solo || i === 0 || j === n - 1 ? minLength : min * ct;
    return diagonalSpan(pts, pieces[i].start, pieces[j].end, need, ct, snapRad, rule, solo);
  };
  let out = [];
  for (let i = 0; i < n;) {
    if (!off[i]) { out.push(pieces[i]); i++; continue; }
    let j = i;
    while (j + 1 < n && off[j + 1]) j++;
    const whole = span(i, j, rule.minLen);
    if (whole) out.push(whole);
    // Off-axis pieces that are not one straight line together are mostly the arcs of a rounded corner:
    // one of them is a diagonal of its own only when it is long (a V of two diagonals).
    else for (let k = i; k <= j; k++) out.push((j > i ? span(k, k, rule.splitMin) : null) || pieces[k]);
    i = j + 1;
  }
  // A neighbour running within growDeg of a diagonal is the same line when the two stay straight together
  // (a long line bowed a little): the whole is a diagonal, or an axis wall when it runs within the axis snap
  // (a 17° wall whose bowed half went past 20°).
  for (let grew = true; grew;) {
    grew = false;
    for (let k = 0; k < out.length && !grew; k++) {
      if (out[k].orient !== 'd') continue;
      for (const m of [k - 1, k + 1]) {
        const nb = out[m];
        if (!nb || angleBetween(nb.dir, out[k].dir) > rule.growDeg * DEG) continue;
        const s = Math.min(out[k].start, nb.start), e = Math.max(out[k].end, nb.end);
        if (!straightSpan(pts, s, e, ct, rule, false)) continue;
        const joined = diagonalSpan(pts, s, e, 0, ct, snapRad, rule, true) || makePiece(pts, s, e, false, snapRad);
        out = [...out.slice(0, Math.min(k, m)), joined, ...out.slice(Math.max(k, m) + 1)];
        grew = true;
        break;
      }
    }
  }
  return out;
}

// The pen points start..end lie along one straight line: no point farther than max(devAbs, devRel × chord)
// from their fitted line, and a bow (one-signed curvature, as a rounded corner's arc has) of at most
// bowRel × chord − bowCut (cornerTolerance units; a lone line: max(aloneBow, aloneRel × chord)).
function straightSpan(pts, start, end, ct, rule, solo) {
  const c = dist(pts[start], pts[end]) / ct;
  const fit = fitPoints(pts, [{ start, end }]);
  if (fit.maxDev > Math.max(solo ? rule.aloneDev : rule.devAbs, rule.devRel * c) * ct) return false;
  const limit = solo ? Math.max(rule.aloneBow, rule.aloneRel * c) : rule.bowRel * c - rule.bowCut;
  return fit.bow <= limit * ct;
}

// The pen points start..end as one diagonal piece, or null when they are not a straight slanted line of at
// least `need` mm (`solo`: the stroke's only long piece).
function diagonalSpan(pts, start, end, need, ct, snapRad, rule, solo) {
  const chord = dist(pts[start], pts[end]);
  const fit = fitPoints(pts, [{ start, end }]);
  const d = alongTravel(fit.d, pts[start], pts[end]);
  if (chord < Math.max(need, EPS) || !offAxis(d, snapRad) || !straightSpan(pts, start, end, ct, rule, solo)) return null;
  return { start, end, orient: 'd', angle: Math.atan2(d.y, d.x), dir: { x: d.x * chord, y: d.y * chord }, length: chord };
}

// Douglas–Peucker keeps the pen point farthest from a chord, which at a gentle turn or a short chamfer can
// lie well before or after the turn (a 36 px chamfer came out as two halves at 22° and 64°). 'auto' moves
// every inner vertex to where the two pieces beside it fit straight lines best (least squares, each pen
// point weighted by the stroke length around it). → refined indices
function refineVertices(pts, idx) {
  if (idx.length < 3) return idx;
  const o = pts[0];
  const n = pts.length;
  const acc = { w: [0], x: [0], y: [0], xx: [0], yy: [0], xy: [0] };
  for (let i = 0; i < n; i++) {
    const w = Math.max(((i > 0 ? dist(pts[i - 1], pts[i]) : 0) + (i + 1 < n ? dist(pts[i], pts[i + 1]) : 0)) / 2, EPS);
    const x = pts[i].x - o.x, y = pts[i].y - o.y;
    acc.w.push(acc.w[i] + w); acc.x.push(acc.x[i] + w * x); acc.y.push(acc.y[i] + w * y);
    acc.xx.push(acc.xx[i] + w * x * x); acc.yy.push(acc.yy[i] + w * y * y); acc.xy.push(acc.xy[i] + w * x * y);
  }
  // Weighted squared distance of the points a..b from their least-squares line.
  const sse = (a, b) => {
    const W = acc.w[b + 1] - acc.w[a];
    if (b - a < 2 || W < EPS) return 0;
    const sx = acc.x[b + 1] - acc.x[a], sy = acc.y[b + 1] - acc.y[a];
    const sxx = acc.xx[b + 1] - acc.xx[a] - sx * sx / W, syy = acc.yy[b + 1] - acc.yy[a] - sy * sy / W;
    const sxy = acc.xy[b + 1] - acc.xy[a] - sx * sy / W;
    return Math.max(0, (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy));
  };
  const out = idx.slice();
  for (let sweep = 0; sweep < 3; sweep++) {
    let moved = false;
    for (let k = 1; k + 1 < out.length; k++) {
      let best = out[k], bestCost = sse(out[k - 1], out[k]) + sse(out[k], out[k + 1]);
      for (let i = out[k - 1] + 1; i < out[k + 1]; i++) {
        const c = sse(out[k - 1], i) + sse(i, out[k + 1]);
        if (c < bestCost - 1e-9 * (1 + bestCost)) { bestCost = c; best = i; }
      }
      if (best !== out[k]) { out[k] = best; moved = true; }
    }
    if (!moved) break;
  }
  return out;
}

function angleBetween(u, v) {
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu < EPS || lv < EPS) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv))));
}

// Unit vector d turned to point from a towards b.
function alongTravel(d, a, b) {
  return d.x * (b.x - a.x) + d.y * (b.y - a.y) < 0 ? { x: -d.x, y: -d.y } : d;
}

// Least-squares line (perpendicular distances, each pen point weighted by the stroke length around it, so
// dense sampling does not pull the line) through the points of `parts`, or through `through` when given.
// → { c (a point on the line), d (unit direction), maxDev (mm, the farthest point from the line) }
function fitPoints(pts, parts, through = null) {
  const list = [];
  for (const part of parts) {
    for (let i = part.start; i <= part.end; i++) {
      const a = pts[i > part.start ? i - 1 : i], b = pts[i < part.end ? i + 1 : i];
      list.push({ p: pts[i], w: Math.max((dist(a, pts[i]) + dist(pts[i], b)) / 2, EPS) });
    }
  }
  let c = through;
  if (!c) {
    let sw = 0, sx = 0, sy = 0;
    for (const { p, w } of list) { sw += w; sx += w * p.x; sy += w * p.y; }
    c = { x: sx / sw, y: sy / sw };
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (const { p, w } of list) {
    const dx = p.x - c.x, dy = p.y - c.y;
    sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = { x: Math.cos(th), y: Math.sin(th) };
  let maxDev = 0, tMin = Infinity, tMax = -Infinity;
  for (const { p } of list) {
    maxDev = Math.max(maxDev, Math.abs((p.x - c.x) * d.y - (p.y - c.y) * d.x));
    const t = (p.x - c.x) * d.x + (p.y - c.y) * d.y;
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
  }
  return { c: { x: c.x, y: c.y }, d, maxDev, bow: bowOf(list, c, d, tMin, tMax) };
}

// How far the points bow away from the line c + t·d (mm, one-signed curvature, not jitter): the middle
// height of the parabola y = a + b·u + k·u² fitted across the line (u from −1 to 1 along it) → |k|.
function bowOf(list, c, d, tMin, tMax) {
  if (list.length < 3 || tMax - tMin < EPS) return 0;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (const { p, w } of list) {
    const u = (2 * ((p.x - c.x) * d.x + (p.y - c.y) * d.y) - tMin - tMax) / (tMax - tMin);
    const y = (p.x - c.x) * d.y - (p.y - c.y) * d.x;
    const f = [1, u, u * u];
    for (let i = 0; i < 3; i++) {
      r[i] += w * f[i] * y;
      for (let j = 0; j < 3; j++) m[i][j] += w * f[i] * f[j];
    }
  }
  const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det(m);
  if (Math.abs(D) < EPS) return 0;
  const m2 = m.map((row, i) => [row[0], row[1], r[i]]);
  return Math.abs(det(m2) / D);
}

// Two pieces belong to one straight run: same class and the same travel direction.
function sameRun(a, b) {
  if (a.orient !== b.orient) return false;
  const d = a.dir.x * b.dir.x + a.dir.y * b.dir.y;
  if (d <= 0) return false;
  if (a.orient !== 'd') return true;
  let diff = Math.abs(a.angle - b.angle);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff <= 15 * DEG;
}

// Merge pieces a and b (b follows a, possibly wrapping around the stroke end).
function combine(pts, a, b, allowDiagonal, snapRad) {
  const merged = makePiece(pts, a.start, b.end, allowDiagonal, snapRad);
  merged.parts = [...(a.parts || [a]), ...(b.parts || [b])];
  // Keep the class of the run (the chord of a wrapped run can be meaningless).
  merged.orient = a.orient;
  merged.length = a.length + b.length;
  if (a.orient === 'd') {
    merged.dir = { x: a.dir.x + b.dir.x, y: a.dir.y + b.dir.y };
    merged.angle = Math.atan2(merged.dir.y, merged.dir.x);
  } else {
    merged.dir = { x: a.dir.x + b.dir.x, y: a.dir.y + b.dir.y };
  }
  return merged;
}

function mergeRuns(pts, pieces, allowDiagonal, snapRad) {
  const out = [];
  for (const pc of pieces) {
    const last = out[out.length - 1];
    if (last && sameRun(last, pc)) out[out.length - 1] = combine(pts, last, pc, allowDiagonal, snapRad);
    else out.push(pc);
  }
  return out;
}

// Raw sub-polylines covered by a piece (several when merged).
function partsOf(pc) { return pc.parts || [pc]; }

// Straight line for a piece: { kind:'h', y } | { kind:'v', x } | { kind:'d', p, d (unit), q }
function fitLine(pts, pc) {
  if (pc.orient === 'h' || pc.orient === 'v') {
    // Length-weighted mean of the coordinate across the piece's raw points.
    const key = pc.orient === 'h' ? 'y' : 'x';
    let sw = 0, s = 0;
    for (const part of partsOf(pc)) {
      for (let i = part.start; i < part.end; i++) {
        const a = pts[i], b = pts[i + 1];
        const w = Math.hypot(b.x - a.x, b.y - a.y);
        sw += w;
        s += w * (a[key] + b[key]) / 2;
      }
    }
    const c = sw > EPS ? s / sw : pts[pc.start][key];
    return pc.orient === 'h' ? { kind: 'h', y: c } : { kind: 'v', x: c };
  }
  // A diagonal keeps the angle it was drawn at: the line that fits its pen points best.
  const parts = partsOf(pc);
  const first = pts[parts[0].start], last = pts[parts[parts.length - 1].end];
  const fit = fitPoints(pts, parts);
  const d = alongTravel(fit.d, first, last);
  const line = { kind: 'd', p: fit.c, d };
  return { kind: 'd', p: projectToLine(first, line), d, q: projectToLine(last, line) };
}

// Put line i (of piece pc) through its anchor(s). `a` is the anchor at the piece's `side` end ('start' or
// 'end'); `b` (only for a one-piece stroke) the anchor at its other end.
function anchorLine(pts, lines, i, pc, a, b, side) {
  const line = lines[i];
  if (line.kind === 'h' || line.kind === 'v') {
    const fix = line.kind === 'h' ? 'fixY' : 'fixX', key = line.kind === 'h' ? 'y' : 'x';
    const both = [a, b].filter((t) => t && t[fix] && isFinite(t[key]));
    if (!both.length) return;
    const pick = both.length === 2 && Math.abs(both[0][key] - both[1][key]) > EPS
      ? (both[0].dist <= both[1].dist ? both[0] : both[1])
      : both[0];
    line[key] = pick[key];
    return;
  }
  // A diagonal runs through an anchoring corner instead of the pen point at that end, and ends there:
  // corner to corner when both ends have one, else through the one corner at the angle that fits the pen
  // points best.
  const corner = (t) => t && t.fixX && t.fixY && isFinite(t.x) && isFinite(t.y);
  const p0 = side === 'start' ? a : b, p1 = side === 'start' ? b : a;
  const c0 = corner(p0) ? { x: p0.x, y: p0.y } : null, c1 = corner(p1) ? { x: p1.x, y: p1.y } : null;
  if (!c0 && !c1) return;
  let d;
  if (c0 && c1) {
    const l = dist(c0, c1);
    if (l < EPS) return;
    d = { x: (c1.x - c0.x) / l, y: (c1.y - c0.y) / l };
  } else {
    d = alongTravel(fitPoints(pts, partsOf(pc), c0 || c1).d, line.p, line.q);
  }
  const through = { kind: 'd', p: c0 || c1, d };
  lines[i] = {
    kind: 'd', p: through.p, d,
    q: c1 || projectToLine(line.q, through),
    startAt: c0, endAt: c1,
  };
  if (!c0) lines[i].p = projectToLine(line.p, through);
}

function lineAsPointDir(line) {
  if (line.kind === 'h') return { p: { x: 0, y: line.y }, d: { x: 1, y: 0 } };
  if (line.kind === 'v') return { p: { x: line.x, y: 0 }, d: { x: 0, y: 1 } };
  return line;
}

function projectToLine(pt, line) {
  if (line.kind === 'h') return { x: pt.x, y: line.y };
  if (line.kind === 'v') return { x: line.x, y: pt.y };
  const t = (pt.x - line.p.x) * line.d.x + (pt.y - line.p.y) * line.d.y;
  return { x: line.p.x + line.d.x * t, y: line.p.y + line.d.y * t };
}

// Corner between two consecutive lines. Parallel lines (a hairpin): move the second line onto the first
// at the joint so the stroke stays connected.
function lineCorner(l1, l2, joint) {
  if (l1.kind === 'h' && l2.kind === 'v') return { x: l2.x, y: l1.y };
  if (l1.kind === 'v' && l2.kind === 'h') return { x: l1.x, y: l2.y };
  const a = lineAsPointDir(l1), b = lineAsPointDir(l2);
  const denom = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(denom) < Math.sin(10 * DEG)) {
    const c = projectToLine(joint, l1);
    if (l2.kind === 'h') l2.y = c.y;
    else if (l2.kind === 'v') l2.x = c.x;
    else l2.p = { x: c.x, y: c.y };
    return c;
  }
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / denom;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}
