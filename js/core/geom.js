// Vector and polygon helpers (DESIGN.md §3.1).
// World units are millimetres, x to the right and y DOWNWARD (screen convention).
// Points and vectors are plain objects { x, y }. No function mutates its inputs.

export const EPS = 1e-6;

export function sub(p, q) { return { x: p.x - q.x, y: p.y - q.y }; }
export function add(p, q) { return { x: p.x + q.x, y: p.y + q.y }; }
export function scale(p, k) { return { x: p.x * k, y: p.y * k }; }
export function dot(p, q) { return p.x * q.x + p.y * q.y; }
// z-component of the 3D cross product. In y-down space a positive value means q is clockwise from p.
export function cross(p, q) { return p.x * q.y - p.y * q.x; }
export function len(v) { return Math.hypot(v.x, v.y); }
export function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
export function norm(v) {
  const l = len(v);
  return l < EPS ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

// Signed area (shoelace formula).
// Convention: the result is POSITIVE for a polygon that runs clockwise on screen (y-down space),
// e.g. (0,0) → (10,0) → (10,10) → (0,10) has area +100.
export function polygonArea(points) {
  let s = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

// Area centroid. Falls back to the vertex average for degenerate (zero-area) polygons.
export function polygonCentroid(points) {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < EPS) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// Even-odd ray casting. Points exactly on the boundary may go either way.
export function pointInPolygon(pt, points) {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = a.x + (pt.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (pt.x < x) inside = !inside;
    }
  }
  return inside;
}

// Distance from a point to the polygon boundary (allocation-free: called many times per label point).
function boundaryDistance(pt, points) {
  let best2 = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let t = l2 < EPS ? 0 : ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / l2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = a.x + abx * t - pt.x, dy = a.y + aby * t - pt.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best2) best2 = d2;
  }
  return Math.sqrt(best2);
}

// A good label point: an interior point far from the boundary.
// Simple grid search, refined around the best cell until the cell size is below `precision` (mm).
// holes: polygons inside this one to keep out of (a room standing inside another room, 0.5.0): the
// point lies outside every hole and as far from their outlines as from the boundary.
export function poleOfInaccessibility(points, precision = 10, holes = null) {
  if (points.length === 0) return { x: 0, y: 0 };
  const hs = Array.isArray(holes) ? holes.filter((h) => Array.isArray(h) && h.length >= 3) : [];
  const inside = hs.length
    ? (p) => pointInPolygon(p, points) && !hs.some((h) => pointInPolygon(p, h))
    : (p) => pointInPolygon(p, points);
  const clearance = hs.length
    ? (p) => Math.min(boundaryDistance(p, points), ...hs.map((h) => boundaryDistance(p, h)))
    : (p) => boundaryDistance(p, points);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const centroid = polygonCentroid(points);
  let best = null, bestD = -Infinity;
  if (inside(centroid)) { best = centroid; bestD = clearance(centroid); }

  const GRID = 12;
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let hw = Math.max((maxX - minX) / 2, EPS), hh = Math.max((maxY - minY) / 2, EPS);
  for (let iter = 0; iter < 12; iter++) {
    const stepX = (2 * hw) / GRID, stepY = (2 * hh) / GRID;
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const p = { x: cx - hw + i * stepX, y: cy - hh + j * stepY };
        if (!inside(p)) continue;
        const d = clearance(p);
        if (d > bestD) { bestD = d; best = p; }
      }
    }
    if (Math.max(stepX, stepY) < precision || !best) break;
    // Zoom into the neighbourhood of the best point found so far.
    cx = best.x; cy = best.y;
    hw = stepX * 2; hh = stepY * 2;
  }
  return best ? { x: best.x, y: best.y } : centroid;
}

// Closest point on segment ab. → { t (0..1 along a→b), point, dist }
export function projectPointToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 < EPS ? 0 : dot(sub(p, a), ab) / l2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const point = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { t, point, dist: dist(p, point) };
}

// Intersection of segments ab and cd (proper crossing or touching).
// → { t (along ab), u (along cd), point } | null. Parallel (including collinear) segments → null.
export function segmentIntersection(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const denom = cross(r, s);
  const scaleRef = len(r) * len(s);
  if (scaleRef < EPS || Math.abs(denom) < EPS * scaleRef) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  const tolT = EPS, tolU = EPS;
  if (t < -tolT || t > 1 + tolT || u < -tolU || u > 1 + tolU) return null;
  const tc = Math.min(1, Math.max(0, t)), uc = Math.min(1, Math.max(0, u));
  return { t: tc, u: uc, point: { x: a.x + r.x * tc, y: a.y + r.y * tc } };
}

// Segments ab and cd running side by side on parallel lines (the drawing checks' "overlapping walls",
// checks-full.js, and the engine's fold test use the same rule). → { length (common run), distance
// (between the lines), point (middle of the common run, on ab) } | null when they are not parallel or
// do not run side by side.
export function parallelOverlap(a, b, c, d) {
  const ux = b.x - a.x, uy = b.y - a.y;
  const L = Math.hypot(ux, uy);
  const vx = d.x - c.x, vy = d.y - c.y;
  const M = Math.hypot(vx, vy);
  if (L < 1e-6 || M < 1e-6) return null;
  const dx = ux / L, dy = uy / L;
  if (Math.abs(dx * vy - dy * vx) / M > 1e-3) return null; // not parallel
  const tC = (c.x - a.x) * dx + (c.y - a.y) * dy;
  const tD = (d.x - a.x) * dx + (d.y - a.y) * dy;
  const lo = Math.max(0, Math.min(tC, tD)), hi = Math.min(L, Math.max(tC, tD));
  if (hi - lo <= 0) return null;
  const distance = Math.abs((c.x - a.x) * -dy + (c.y - a.y) * dx);
  const t = (lo + hi) / 2;
  return { length: hi - lo, distance, point: { x: a.x + dx * t, y: a.y + dy * t } };
}

// Ramer–Douglas–Peucker polyline simplification. Keeps the first and last point.
export function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = projectPointToSegment(points[i], points[i0], points[i1]).dist;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}
