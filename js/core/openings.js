// Windows and doors (stage B, plan §1-2, §1-3, §2-5).
//
// Data (project.openings[]):
//   { id: 'o1', kind: 'window' | 'door', edge: 'e3', t: 0..1, anchor: 'a' | 'b' | null,
//     width: mm | null, height: mm | null,      // the measured size (규격); null = not measured
//     drawWidth: mm | null,                     // extension: drawn width while `width` is unknown
//     material, type,                           // windows: '재질' and '종류' (null = 모름 / not chosen)
//     doorType,                                 // doors: 'ABS도어', '목문', ... or a typed name
//     combo: { outer: { material, type }, inner: { material, type } } | null,   // 조합창
//     swing: { side: 'left' | 'right', hinge: 'start' | 'end' },                // doors
//     check: false }                            // 확인필요
//
// Positions:
//   - `t` is the centre of the opening along its wall edge a→b (0..1). A wall that changes length
//     keeps the opening at the same relative position. It is the point where the opening was DROPPED
//     (placed / moved), kept as it is: the drawing clamps the opening inside its wall, so a window
//     dropped near a corner of a short sketch wall is drawn flush there but goes back to where it was
//     dropped when the wall gets longer or its real (narrower) width is typed.
//   - `anchor` keeps an opening flush with one end of its wall (the inner face of the wall meeting
//     there), so an opening that was put "in the corner" stays in the corner when the wall length
//     changes. It is decided from where the opening was dropped (snapAnchor), never from a width the
//     surveyor did not choose against a wall still drawn at the sketch's scale (review 예시 세대 A #17: the
//     default 1200 / 900 on a sketch wall drawn at 0.75 × stuck windows and doors to corners they were
//     only near). It is decided again when the real width is first typed (updateOpening).
//   - The drawn opening always stays inside its wall (between the inner faces at both ends).
// Sides (swing.side): seen walking from node a to node b on screen (y down), 'left' is the side on
// your left hand: the unit normal (dir.y, -dir.x). graph.edgeFaces lists [left face, right face] in
// the same sense.
//
// Everything here is pure (no DOM) apart from OpeningPrefs, which uses localStorage when it can.

import { projectPointToSegment } from './geom.js';
import { nextId } from './graph.js';

// ---- vocabulary (plan §1-3) ------------------------------------------------------------------------

// Default lists. The panels show the lists of 설정 (core/prefs.js), which start as these.
export const WINDOW_MATERIALS = ['PVC', 'AL', '목재', '내목외AL'];   // plus '모름' (= null) in the UI
export const WINDOW_TYPES = ['단창', '이중창', '미닫이창', '고정창'];
export const DOOR_TYPES = ['ABS도어', '목문', '철재문', '미서기문', '3연동 도어', '현관문', '방화문'];
// Doors drawn as sliding leaves (no arc). Everything else is a swing door.
export const SLIDING_DOORS = { '미서기문': 2, '3연동 도어': 3 };

// Size buttons ("자주 쓰는 규격"), W*H in mm.
export const FREQUENT_SIZES = {
  window: [[600, 600], [900, 900], [1200, 1000], [1500, 1200], [1800, 1200], [2400, 1200]],
  door: [[700, 2000], [800, 2000], [900, 2000], [900, 2100], [1000, 2100]],
};

// Drawn width when the size is unknown (mm).
export const DEFAULT_DRAW_WIDTH = { window: 1200, door: 900 };
export const DEFAULT_SLIDING_WIDTH = { 2: 1600, 3: 2400 };
// Reach of the corner anchor (mm) when the caller gives none: a drop point this close to a wall
// end's inner face sticks to that end. The editor passes about 12 screen px instead (spec.anchorMM),
// so the reach is the same on the screen at every zoom. Never more than a quarter of the wall's clear
// length, so the middle of a short wall never sticks to a corner.
export const ANCHOR_MM = 150;
// Smallest drawn width (mm).
export const MIN_WIDTH = 200;

// ---- labels (plan §1-3) ------------------------------------------------------------------------

// Latin materials are written together with the type ("PVC이중창"), Korean ones with a space
// ("목재 이중창"). A material mixing both ("내목외AL") counts as Korean.
export function isLatinMaterial(material) {
  return /^[A-Za-z0-9.\-]+$/.test(String(material || ''));
}

// The spacing rule used when a caller passes no options (설정 → 라벨 띄어 쓰기, core/prefs.js sets it
// for the whole app, so screen labels, panels and paper all follow it).
const DEFAULT_SPACING = Object.freeze({ spaceLatin: false, spaceKorean: true });
let spacing = { ...DEFAULT_SPACING };

// opts: { spaceLatin, spaceKorean } (booleans; missing ones go back to the default rule)
export function setLabelSpacing(opts = {}) {
  const o = opts || {};
  spacing = {
    spaceLatin: typeof o.spaceLatin === 'boolean' ? o.spaceLatin : DEFAULT_SPACING.spaceLatin,
    spaceKorean: typeof o.spaceKorean === 'boolean' ? o.spaceKorean : DEFAULT_SPACING.spaceKorean,
  };
}

export function labelSpacing() {
  return { ...spacing };
}

// "PVC" + "단창" → "PVC단창"; "목재" + "이중창" → "목재 이중창"; unknown material → type only.
// A material without a type reads as a window of that material ("목재" → "목창", "AL" → "AL창").
export function windowName(material, type, opts) {
  const { spaceLatin = spacing.spaceLatin, spaceKorean = spacing.spaceKorean } = opts || {};
  const m = (material || '').trim(), t = (type || '').trim();
  if (!m && !t) return '';
  if (!m) return t;
  if (!t) return m === '목재' ? '목창' : `${m}창`;
  const spaced = isLatinMaterial(m) ? spaceLatin : spaceKorean;
  return spaced ? `${m} ${t}` : `${m}${t}`;
}

// Size text: "3550*1950", "3550" (height unknown) or '' (width unknown).
export function sizeText(o) {
  const w = posNum(o && o.width), h = posNum(o && o.height);
  if (!w) return '';
  return h ? `${Math.round(w)}*${Math.round(h)}` : `${Math.round(w)}`;
}

// → { name, size } for a two-line label (vertical walls: "재질종류" / "규격").
// No size → both empty: unmeasured openings are drawn without a label (plan §1-3).
export function labelParts(o, labelOpts) {
  const size = sizeText(o);
  if (!size) return { name: '', size: '' };
  let name;
  if (o.kind === 'door') {
    name = (o.doorType || '').trim() || '문';
  } else if (o.combo && (o.combo.outer || o.combo.inner)) {
    const outer = o.combo.outer || {}, inner = o.combo.inner || {};
    const a = windowName(outer.material, outer.type, labelOpts) || '창';
    const b = windowName(inner.material, inner.type, labelOpts) || '창';
    name = `외창 ${a}+내창 ${b}`;
  } else {
    name = windowName(o.material, o.type, labelOpts) || '창';
  }
  return { name, size };
}

// One-line label, e.g. "PVC단창 3550*1950", "목문 800*2000", '' when the size is unknown.
export function labelOf(o, labelOpts) {
  const { name, size } = labelParts(o, labelOpts);
  return size ? `${name} ${size}` : '';
}

// Short name for panels and lists even without a size ("PVC단창", "목문", "창").
export function displayName(o) {
  const parts = labelParts({ ...o, width: 1, height: null });
  return parts.name;
}

export function slidingLeaves(o) {
  return o && o.kind === 'door' ? (SLIDING_DOORS[o.doorType] || 0) : 0;
}

// ---- geometry ------------------------------------------------------------------------------------

const indexCache = new WeakMap();
function indexOf(project) {
  let ix = indexCache.get(project);
  if (ix) return ix;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const byNode = new Map();
  for (const e of project.edges || []) {
    for (const id of [e.a, e.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(e);
    }
  }
  ix = { nodes, edges, byNode };
  indexCache.set(project, ix);
  return ix;
}

// Effective wall thickness (mm): solved, else measured, else the default by wall type.
export function wallThickness(project, derived, edge) {
  if (!edge || edge.kind === 'divider') return 0;
  const solved = derived && derived.solve && derived.solve.thickness;
  if (solved && typeof solved.get === 'function') {
    const t = solved.get(edge.id);
    if (t != null && isFinite(t)) return Math.max(0, t);
  }
  if (posNum(edge.thickness) != null && edge.thickness >= 0) return edge.thickness;
  const s = (project && project.settings) || {};
  const ef = derived && derived.edgeFaces;
  const pair = ef && typeof ef.get === 'function' ? ef.get(edge.id) : null;
  if (pair && pair[0] != null && pair[1] != null) return s.intWall || 100;
  return s.extWall || 150;
}

// Clear distance (mm) along edge `edge` from node `nodeId` to where an opening's cut (the full
// thickness of this wall) is clear of the walls meeting it there; 0 for a free end or a straight
// continuation. At a square corner or T that is half the thickest other wall (the inner face). A
// diagonal wall meets the others at other angles: the cut must start where the whole thickness of
// this wall has left the other wall's band — further out at an acute corner (D1's diagonal into a
// rectangle's corner: about (t2/2 + t/2·|cos θ|) / sin θ), closer at an obtuse one. Erasing the part
// of the other wall that runs inside this wall's band would leave a white notch in that wall.
function endClearance(project, derived, edge, nodeId, dir) {
  const ix = indexOf(project);
  const N = ix.nodes.get(nodeId);
  if (!N) return 0;
  // Unit direction from the node into this wall, and its left normal.
  const into = edge.a === nodeId ? dir : { x: -dir.x, y: -dir.y };
  const half = wallThickness(project, derived, edge) / 2;
  let m = 0;
  for (const other of ix.byNode.get(nodeId) || []) {
    if (other === edge || other.id === edge.id || other.kind === 'divider') continue;
    const A = ix.nodes.get(other.a), B = ix.nodes.get(other.b);
    if (!A || !B) continue;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const cross = Math.abs((dx / L) * dir.y - (dy / L) * dir.x);
    if (cross < 0.3) continue; // parallel: a continuation of the same wall line
    const t2 = wallThickness(project, derived, other);
    if (cross >= 1 - 1e-12) {
      // Square to this wall (every h/v corner): its inner face, half its thickness (exact).
      m = Math.max(m, t2 / 2);
      continue;
    }
    const far = other.a === nodeId ? B : A;
    const u = { x: (far.x - N.x) / L, y: (far.y - N.y) / L };
    m = Math.max(m, bandReach(u, L, t2, into, half));
  }
  return m;
}

// How far along `into` (from the node, mm) the band of another wall reaches inside this wall's band
// (|offset| ≤ half): the other wall runs from the node along unit u for L mm, t2 thick. Its band
// (from the node on: the joint itself belongs to both walls) is clipped to this wall's band, and the
// furthest point along `into` counts. → mm (≥ 0)
function bandReach(u, L, t2, into, half) {
  const mu = { x: -u.y, y: u.x };
  const n = { x: -into.y, y: into.x };
  const corner = (r, q) => ({ x: u.x * r + mu.x * q, y: u.y * r + mu.y * q });
  let poly = [corner(0, -t2 / 2), corner(L, -t2 / 2), corner(L, t2 / 2), corner(0, t2 / 2)];
  // Sutherland–Hodgman against offset ≤ half and offset ≥ −half.
  const clip = (pts, keep) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i], Q = pts[(i + 1) % pts.length];
      const fp = keep(P), fq = keep(Q);
      if (fp >= 0) out.push(P);
      if ((fp >= 0) !== (fq >= 0)) {
        const k = fp / (fp - fq);
        out.push({ x: P.x + (Q.x - P.x) * k, y: P.y + (Q.y - P.y) * k });
      }
    }
    return out;
  };
  poly = clip(poly, (p) => half - (p.x * n.x + p.y * n.y));
  poly = clip(poly, (p) => half + (p.x * n.x + p.y * n.y));
  let best = 0;
  for (const p of poly) best = Math.max(best, p.x * into.x + p.y * into.y);
  return best;
}

// Frame of a wall edge: { edge, A, B, L, dir, left (unit normal), thick, lo, hi } where [lo, hi] is
// the part of the centre line (mm from A) between the inner faces at both ends.
export function edgeFrame(project, derived, edgeId) {
  const ix = indexOf(project);
  const edge = ix.edges.get(edgeId);
  if (!edge) return null;
  const A = ix.nodes.get(edge.a), B = ix.nodes.get(edge.b);
  if (!A || !B) return null;
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return null;
  const dir = { x: dx / L, y: dy / L };
  const left = { x: dir.y, y: -dir.x };
  let lo = endClearance(project, derived, edge, edge.a, dir);
  let hi = L - endClearance(project, derived, edge, edge.b, dir);
  if (hi - lo < MIN_WIDTH) { lo = 0; hi = L; }
  return { edge, A, B, L, dir, left, thick: wallThickness(project, derived, edge), lo, hi };
}

// Drawn width of an opening (mm), before clipping to its wall.
export function nominalWidth(o) {
  const w = posNum(o.width) || posNum(o.drawWidth);
  if (w) return Math.max(MIN_WIDTH, w);
  const leaves = slidingLeaves(o);
  if (leaves) return DEFAULT_SLIDING_WIDTH[leaves];
  return DEFAULT_DRAW_WIDTH[o.kind] || DEFAULT_DRAW_WIDTH.window;
}

// Where an opening sits on its wall. → { frame, w, c, s0, s1, center, clipped } | null
//   c = centre distance from A (mm), s0..s1 = covered part of the centre line, center = world point.
export function placeOpening(project, derived, o, frame = null) {
  const fr = frame || edgeFrame(project, derived, o.edge);
  if (!fr) return null;
  const span = fr.hi - fr.lo;
  const nominal = nominalWidth(o);
  const w = Math.min(nominal, span);
  let c;
  if (o.anchor === 'a') c = fr.lo + w / 2;
  else if (o.anchor === 'b') c = fr.hi - w / 2;
  else c = clamp((isFinite(o.t) ? o.t : 0.5) * fr.L, fr.lo + w / 2, fr.hi - w / 2);
  const s0 = c - w / 2, s1 = c + w / 2;
  const center = { x: fr.A.x + fr.dir.x * c, y: fr.A.y + fr.dir.y * c };
  return { frame: fr, w, c, s0, s1, center, clipped: w < nominal - 0.5 };
}

// Anchor rule for a drop at fraction t of the edge. → { t, anchor }
// t comes back as dropped (only kept inside 0..1): placeOpening clamps the drawing, and the drop
// point is what the opening goes back to when the wall grows or a narrower real width is typed.
// An end is chosen when
//   - the drop point itself lies within the reach (opts.anchorMM, else o.anchorMM, else ANCHOR_MM;
//     at most a quarter of the clear length) of that end's inner face: the opening was dragged into
//     the corner; or
//   - the opening as it is drawn now (its width, else its drawn / default width) is pushed against
//     that end (its end within a fifth of the reach of the face) AND the wall leaves it room to be
//     elsewhere (free length ≥ 2 × reach). A width that nearly fills the wall, or is wider than the
//     wall (clipped), says nothing about where the surveyor wanted it, so only the drop point counts.
// Both ends cannot qualify at once except through the second rule on a nearly full wall, which is
// excluded; if they ever do, the end nearer the drop point wins (never simply 'a').
export function snapAnchor(project, derived, edgeId, t, o = {}, opts = {}) {
  const tt = clamp(typeof t === 'number' && isFinite(t) ? t : 0.5, 0, 1);
  const fr = edgeFrame(project, derived, edgeId);
  if (!fr) return { t: tt, anchor: null };
  const span = fr.hi - fr.lo;
  const reach = anchorReach(opts && opts.anchorMM != null ? opts.anchorMM : o && o.anchorMM, span);
  const p = tt * fr.L;
  const dA = p - fr.lo, dB = fr.hi - p;
  let a = dA <= reach, b = dB <= reach;
  const w = nominalWidth(o || {});
  if (w < span - 0.5 && span - w >= 2 * reach) {
    const tol = reach / 5;
    if (p - w / 2 <= fr.lo + tol) a = true;
    if (p + w / 2 >= fr.hi - tol) b = true;
  }
  const anchor = a && b ? (dA <= dB ? 'a' : 'b') : a ? 'a' : b ? 'b' : null;
  return { t: tt, anchor };
}

// The corner reach of snapAnchor (mm): the given distance (default ANCHOR_MM), at most a quarter of
// the clear length (a short sketch wall: the middle never sticks to a corner).
export function anchorReach(anchorMM, span) {
  const r = posNum(anchorMM) != null ? posNum(anchorMM) : ANCHOR_MM;
  return Math.max(0, Math.min(r, (span > 0 ? span : 0) / 4));
}

// Nearest wall (kind 'wall') to a world point. → { edgeId, t, dist, side: 'left'|'right' } | null
export function nearestWall(project, point, maxDist = Infinity) {
  const ix = indexOf(project);
  let best = null;
  for (const e of project.edges || []) {
    if (e.kind === 'divider') continue;
    const A = ix.nodes.get(e.a), B = ix.nodes.get(e.b);
    if (!A || !B) continue;
    const pr = projectPointToSegment(point, A, B);
    if (pr.dist <= maxDist && (!best || pr.dist < best.dist)) {
      const cross = (B.x - A.x) * (point.y - A.y) - (B.y - A.y) * (point.x - A.x);
      // y-down: cross < 0 means the point is on the left of a→b.
      best = { edgeId: e.id, t: pr.t, dist: pr.dist, side: cross < 0 ? 'left' : 'right' };
    }
  }
  return best;
}

// Opening under a world point (within tol mm of its band). → id | null
export function openingAt(project, derived, point, tol = 100) {
  let best = null, bestD = Infinity;
  for (const o of project.openings || []) {
    const pl = placeOpening(project, derived, o);
    if (!pl) continue;
    const fr = pl.frame;
    const rx = point.x - fr.A.x, ry = point.y - fr.A.y;
    const along = rx * fr.dir.x + ry * fr.dir.y;
    const across = Math.abs(rx * fr.left.x + ry * fr.left.y);
    const dAlong = Math.max(0, pl.s0 - along, along - pl.s1);
    const dAcross = Math.max(0, across - fr.thick / 2);
    const d = Math.hypot(dAlong, dAcross);
    if (d <= tol && d < bestD) { bestD = d; best = o.id; }
  }
  return best;
}

// Room faces on the two sides of an edge: { left: faceIndex|null, right: faceIndex|null }.
export function facesBeside(derived, edgeId) {
  const ef = derived && derived.edgeFaces;
  const pair = ef && typeof ef.get === 'function' ? ef.get(edgeId) : null;
  return { left: pair ? pair[0] : null, right: pair ? pair[1] : null };
}

// Side a new door opens to: into a room (plan §2-5). `prefer` (the side the pointer was on) wins when
// a room lies there, or when there is no room on either side.
export function defaultSwingSide(derived, edgeId, prefer = null) {
  const f = facesBeside(derived, edgeId);
  const has = { left: f.left != null, right: f.right != null };
  if (prefer && (has[prefer] || (!has.left && !has.right))) return prefer;
  if (has.left && !has.right) return 'left';
  if (has.right && !has.left) return 'right';
  return prefer || 'left';
}

// ---- following graph edits ---------------------------------------------------------------------

// Openings follow the walls through graph edits. Call after every committed edit with the project
// before and after (both solved). prevDerived (optional) gives exact wall thicknesses for anchored
// openings. → nextProject itself when nothing changed, else a copy with updated `openings`.
//   - wall unchanged (same id and end nodes): kept as is (its t stays relative, anchors stay flush);
//   - wall split: the opening moves to the part that holds its centre;
//   - walls merged (a corner between two straight walls removed): moves to the merged wall;
//   - wall deleted: its openings are deleted.
export function reconcileOpenings(prevProject, nextProject, prevDerived = null) {
  const list = (nextProject && nextProject.openings) || [];
  if (!list.length || !prevProject) return nextProject;
  const pix = indexOf(prevProject), nix = indexOf(nextProject);
  let changed = false;
  const out = [];
  for (const o of list) {
    const ne = nix.edges.get(o.edge);
    const pe = pix.edges.get(o.edge);
    if (ne && nix.nodes.has(ne.a) && nix.nodes.has(ne.b) && (!pe || (pe.a === ne.a && pe.b === ne.b))) {
      out.push(o);
      continue;
    }
    changed = true;
    const moved = pe ? remapOpening(o, pe, prevProject, nextProject, prevDerived) : null;
    if (moved) out.push(moved);
  }
  return changed ? { ...nextProject, openings: out } : nextProject;
}

function remapOpening(o, pe, prev, next, prevDerived) {
  const nix = indexOf(next);
  const pl = placeOpening(prev, prevDerived, o);
  if (!pl) return null;
  const fr = pl.frame;
  // Walk from each end of the old wall along its line until a node that still exists.
  const back = walkToSurvivor(prev, next, pe.a, pe, -1, fr);
  const fwd = walkToSurvivor(prev, next, pe.b, pe, +1, fr);
  if (!back || !fwd) return null;
  // Fraction of the opening centre between the two surviving nodes (old geometry).
  const span = fwd.along - back.along;
  if (!(Math.abs(span) > 1e-6)) return null;
  const u = (pl.c - back.along) / span;
  const P = nix.nodes.get(back.id), Q = nix.nodes.get(fwd.id);
  const point = { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u };
  const dirNew = norm({ x: Q.x - P.x, y: Q.y - P.y });
  // The new edge holding that point, on the same line.
  let best = null;
  for (const e of next.edges || []) {
    if (e.kind === 'divider') continue;
    const A = nix.nodes.get(e.a), B = nix.nodes.get(e.b);
    if (!A || !B) continue;
    const d = norm({ x: B.x - A.x, y: B.y - A.y });
    if (!d || !dirNew || Math.abs(d.x * dirNew.y - d.y * dirNew.x) > 0.02) continue;
    const pr = projectPointToSegment(point, A, B);
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    const tolMM = 2 + 1e-4 * L;
    if (pr.dist > tolMM) continue;
    if (!best || pr.dist < best.dist) best = { edge: e, t: pr.t, dist: pr.dist, same: d.x * dirNew.x + d.y * dirNew.y > 0 };
  }
  if (!best) return null;
  const e = best.edge;
  // Orientation relative to the old wall: dirNew has the old wall's direction (back → fwd).
  const flip = !best.same;
  let anchor = null;
  if (o.anchor) {
    const node = o.anchor === 'a' ? pe.a : pe.b;
    if (e.a === node) anchor = 'a';
    else if (e.b === node) anchor = 'b';
  }
  const res = { ...o, edge: e.id, t: best.t, anchor };
  if (flip && o.swing) res.swing = flipSwing(o.swing);
  return res;
}

// From node `startId` (an end of the old edge `edge`), follow straight continuations of the wall
// line in the old project until a node that exists in the new project.
// step: -1 walks beyond end a (backwards), +1 beyond end b. → { id, along } (mm from old A) | null
function walkToSurvivor(prev, next, startId, edge, step, fr) {
  const pix = indexOf(prev), nix = indexOf(next);
  let id = startId, cur = edge;
  for (let guard = 0; guard < 64; guard++) {
    const n = pix.nodes.get(id);
    if (!n) return null;
    if (nix.nodes.has(id)) {
      return { id, along: (n.x - fr.A.x) * fr.dir.x + (n.y - fr.A.y) * fr.dir.y };
    }
    // Continue through a collinear edge at this node, away from the old wall.
    let nextEdge = null;
    for (const e of pix.byNode.get(id) || []) {
      if (e.id === cur.id) continue;
      const otherId = e.a === id ? e.b : e.a;
      const m = pix.nodes.get(otherId);
      if (!m) continue;
      const v = norm({ x: m.x - n.x, y: m.y - n.y });
      if (!v) continue;
      const along = v.x * fr.dir.x + v.y * fr.dir.y;
      if (along * step > 0.999) { nextEdge = { e, otherId }; break; }
    }
    if (!nextEdge) return null;
    cur = nextEdge.e;
    id = nextEdge.otherId;
  }
  return null;
}

export function flipSwing(swing) {
  return {
    side: swing.side === 'left' ? 'right' : 'left',
    hinge: swing.hinge === 'start' ? 'end' : 'start',
  };
}

// Repair the openings of a loaded file: drop the ones whose wall is missing, fix bad fields.
// → the same project when nothing needed repair.
export function sanitizeOpenings(project) {
  if (!project) return project;
  const raw = Array.isArray(project.openings) ? project.openings : [];
  const edgeIds = new Set((project.edges || []).map((e) => e.id));
  const seen = new Set();
  let changed = !Array.isArray(project.openings);
  const out = [];
  for (const o of raw) {
    if (!o || typeof o.id !== 'string' || seen.has(o.id) || !edgeIds.has(o.edge)) { changed = true; continue; }
    seen.add(o.id);
    const fixed = normalizeOpening(o);
    if (JSON.stringify(fixed) !== JSON.stringify(o)) changed = true;
    out.push(fixed);
  }
  return changed ? { ...project, openings: out } : project;
}

// A complete, valid opening record from a partial one.
export function normalizeOpening(o) {
  const kind = o.kind === 'door' ? 'door' : 'window';
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const part = (p) => (p && typeof p === 'object' ? { material: str(p.material), type: str(p.type) } : { material: null, type: null });
  const out = {
    id: o.id,
    kind,
    edge: o.edge,
    t: clamp(isFinite(o.t) ? Number(o.t) : 0.5, 0, 1),
    anchor: o.anchor === 'a' || o.anchor === 'b' ? o.anchor : null,
    width: posNum(o.width),
    height: posNum(o.height),
    drawWidth: posNum(o.drawWidth),
    material: kind === 'window' ? str(o.material) : null,
    type: kind === 'window' ? str(o.type) : null,
    doorType: kind === 'door' ? str(o.doorType) : null,
    combo: kind === 'window' && o.combo && typeof o.combo === 'object'
      ? { outer: part(o.combo.outer), inner: part(o.combo.inner) } : null,
    check: !!o.check,
  };
  if (kind === 'door') {
    const s = o.swing || {};
    out.swing = { side: s.side === 'right' ? 'right' : 'left', hinge: s.hinge === 'end' ? 'end' : 'start' };
  }
  return out;
}

// ---- checks (for stage D) ----------------------------------------------------------------------------

// Warnings about openings (plan §6 "벽보다 큰 창·문", §1-3 [확인필요]). Each item names the rooms on
// both sides of the wall so the ※ note can say where it is.
//   { type: 'openingTooWide', openingId, edgeId, width, room: [leftRoomId|null, rightRoomId|null] }
//   { type: 'openingCheck',   openingId, edgeId, room: [...] }
export function openingWarnings(project, derived) {
  const out = [];
  const roomOfFace = new Map(((derived && derived.rooms) || []).map((r) => [r.faceIndex, r.roomId]));
  for (const o of (project && project.openings) || []) {
    const f = facesBeside(derived, o.edge);
    const room = [roomOfFace.get(f.left) ?? null, roomOfFace.get(f.right) ?? null];
    const pl = placeOpening(project, derived, o);
    if (pl && pl.clipped && posNum(o.width)) {
      out.push({ type: 'openingTooWide', openingId: o.id, edgeId: o.edge, width: o.width, room });
    }
    if (o.check) out.push({ type: 'openingCheck', openingId: o.id, edgeId: o.edge, room });
  }
  return out;
}

// ---- store commands (mixin) ----------------------------------------------------------------------

// Order of the four swing states (plan §2-5: 안/밖 × 왼쪽/오른쪽 경첩). Each tap changes one thing.
const SWING_CYCLE = [['left', 'start'], ['left', 'end'], ['right', 'end'], ['right', 'start']];

export function nextSwing(o) {
  const s = o.swing || { side: 'left', hinge: 'start' };
  if (slidingLeaves(o)) return { side: s.side, hinge: s.hinge === 'start' ? 'end' : 'start' };
  const i = SWING_CYCLE.findIndex(([side, hinge]) => side === s.side && hinge === s.hinge);
  const [side, hinge] = SWING_CYCLE[(i + 1) % SWING_CYCLE.length];
  return { side, hinge };
}

const PATCH_KEYS = ['kind', 'width', 'height', 'drawWidth', 'material', 'type', 'doorType', 'combo', 'swing', 'check', 'anchor'];

// Adds addOpening, updateOpening, moveOpening, deleteOpening and cycleSwing to DocStore.prototype.
// Openings do not change the wall layout, so these commands do not re-derive (rederive: false).
export function installOpenings(DocStore) {
  const proto = DocStore.prototype;

  // spec: { kind, width, height, drawWidth, material, type, doorType, combo, swing, check,
  //         anchor (omit = decide by the drop position), side (preferred swing side for doors),
  //         anchorMM (corner reach in world mm; the editor passes about 12 screen px / view.scale) }
  // t is the drop point and is stored as it is (see snapAnchor). → new opening id | null (edge
  // missing or not a wall)
  proto.addOpening = function addOpening(edgeId, t, spec = {}) {
    const id = nextId('o', this.project.openings || []);
    const ok = this._commit('addOpening', (p) => {
      const edge = (p.edges || []).find((e) => e.id === edgeId);
      if (!edge || edge.kind === 'divider') return null;
      const list = p.openings || [];
      const draft = normalizeOpening({ ...spec, id, edge: edgeId, t });
      if (draft.kind === 'door') {
        draft.swing = spec.swing
          ? normalizeOpening({ kind: 'door', swing: spec.swing }).swing
          : { side: defaultSwingSide(this.derived, edgeId, spec.side || null), hinge: 'start' };
      }
      if (spec.anchor === undefined) {
        draft.anchor = snapAnchor(p, this.derived, edgeId, draft.t, draft, { anchorMM: spec.anchorMM }).anchor;
      }
      return { ...p, openings: [...list, draft] };
    }, { rederive: false, detail: { openingId: id } });
    return ok ? id : null;
  };

  // patch: any of PATCH_KEYS. Changing the width keeps an anchored opening flush. The FIRST real
  // width (null → a number) decides the anchor again from the drop point (t) and that width, unless
  // the patch sets `anchor` itself: an opening placed without its size was only drawn at the default
  // width, and the corner it was pushed into with the real width is what counts. An anchor it already
  // has stays (it was dragged into that corner). opts.anchorMM: as addOpening. → bool
  proto.updateOpening = function updateOpening(id, patch = {}, opts = {}) {
    return this._commit('updateOpening', (p) => {
      const list = p.openings || [];
      const i = list.findIndex((o) => o.id === id);
      if (i < 0) return null;
      const merged = { ...list[i] };
      for (const k of PATCH_KEYS) if (k in patch) merged[k] = patch[k];
      const next = normalizeOpening(merged);
      if (next.kind === 'door' && !next.swing) next.swing = { side: 'left', hinge: 'start' };
      const firstWidth = posNum(list[i].width) == null && posNum(next.width) != null && !('anchor' in patch);
      if (firstWidth && !next.anchor) {
        next.anchor = snapAnchor(p, this.derived, next.edge, next.t, next, { anchorMM: opts && opts.anchorMM }).anchor;
      }
      if (JSON.stringify(next) === JSON.stringify(list[i])) return null;
      const openings = list.slice();
      openings[i] = next;
      return { ...p, openings };
    }, { rederive: false, detail: { openingId: id } });
  };

  // Move along walls (drag). The new drop point is kept as t and the anchor is decided again from it
  // (snapAnchor; opts.anchorMM as addOpening). A door moved to a parallel wall keeps opening to the
  // same side on screen; on a crossing wall it opens into a room (opts.side = preferred side). → bool
  proto.moveOpening = function moveOpening(id, edgeId, t, opts = {}) {
    return this._commit('moveOpening', (p) => {
      const list = p.openings || [];
      const i = list.findIndex((o) => o.id === id);
      const edge = (p.edges || []).find((e) => e.id === edgeId);
      if (i < 0 || !edge || edge.kind === 'divider') return null;
      const o = list[i];
      const moved = { ...o, edge: edgeId, ...snapAnchor(p, this.derived, edgeId, clamp(t, 0, 1), o, { anchorMM: opts.anchorMM }) };
      if (o.kind === 'door' && edgeId !== o.edge) {
        const rel = relativeDirection(p, o.edge, edgeId);
        const swing = o.swing || { side: 'left', hinge: 'start' };
        if (rel === 1) moved.swing = { ...swing };
        else if (rel === -1) moved.swing = flipSwing(swing);
        else moved.swing = { side: defaultSwingSide(this.derived, edgeId, opts.side || null), hinge: swing.hinge };
      }
      if (moved.edge === o.edge && moved.t === o.t && moved.anchor === o.anchor) return null;
      const openings = list.slice();
      openings[i] = moved;
      return { ...p, openings };
    }, { rederive: false, detail: { openingId: id } });
  };

  proto.deleteOpening = function deleteOpening(id) {
    return this._commit('deleteOpening', (p) => {
      const list = p.openings || [];
      if (!list.some((o) => o.id === id)) return null;
      return { ...p, openings: list.filter((o) => o.id !== id) };
    }, { rederive: false, detail: { openingId: id } });
  };

  // Next of the four swing states; sliding doors swap the front leaf. Windows: no-op (false).
  proto.cycleSwing = function cycleSwing(id) {
    return this._commit('cycleSwing', (p) => {
      const list = p.openings || [];
      const i = list.findIndex((o) => o.id === id);
      if (i < 0 || list[i].kind !== 'door') return null;
      const openings = list.slice();
      openings[i] = { ...list[i], swing: nextSwing(list[i]) };
      return { ...p, openings };
    }, { rederive: false, detail: { openingId: id } });
  };

  proto.openingById = function openingById(id) {
    return (this.project.openings || []).find((o) => o.id === id) || null;
  };

  proto.openingAt = function openingAtPoint(pt, tol = 100) {
    return openingAt(this.project, this.derived, pt, tol);
  };
}

// +1 when two edges point the same way, -1 opposite, 0 not parallel.
function relativeDirection(project, edgeIdA, edgeIdB) {
  const fa = edgeVector(project, edgeIdA), fb = edgeVector(project, edgeIdB);
  if (!fa || !fb) return 0;
  if (Math.abs(fa.x * fb.y - fa.y * fb.x) > 0.05) return 0;
  return fa.x * fb.x + fa.y * fb.y > 0 ? 1 : -1;
}

function edgeVector(project, edgeId) {
  const ix = indexOf(project);
  const e = ix.edges.get(edgeId);
  const A = e && ix.nodes.get(e.a), B = e && ix.nodes.get(e.b);
  return A && B ? norm({ x: B.x - A.x, y: B.y - A.y }) : null;
}

// ---- per-device preferences (직전 값, recent sizes) --------------------------------------------------

const PREFS_KEY = 'floorplan.openings.v1';
const RECENT_LIMIT = 6;

// Last chosen material/type/door type and recently used sizes, remembered on this device.
// storage: any { getItem, setItem } (default localStorage); every access is guarded, so a blocked
// storage only means nothing is remembered.
export class OpeningPrefs {
  constructor(storage = defaultStorage(), key = PREFS_KEY) {
    this.storage = storage;
    this.key = key;
    this.data = { last: { window: { material: null, type: null }, door: { doorType: null } }, recent: { window: [], door: [] } };
    try {
      const raw = this.storage && this.storage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.last) {
          this.data.last.window = { ...this.data.last.window, ...(parsed.last.window || {}) };
          this.data.last.door = { ...this.data.last.door, ...(parsed.last.door || {}) };
        }
        for (const k of ['window', 'door']) {
          const r = parsed.recent && parsed.recent[k];
          if (Array.isArray(r)) this.data.recent[k] = r.filter(validSize).slice(0, RECENT_LIMIT);
        }
      }
    } catch (_) { /* unreadable: start empty */ }
  }

  // window → { material, type }; door → { doorType }
  last(kind) {
    return { ...(this.data.last[kind === 'door' ? 'door' : 'window']) };
  }

  setLast(kind, patch) {
    const k = kind === 'door' ? 'door' : 'window';
    this.data.last[k] = { ...this.data.last[k], ...patch };
    this._save();
  }

  // → [[w, h|null], ...] most recent first
  recentSizes(kind) {
    return this.data.recent[kind === 'door' ? 'door' : 'window'].map((s) => s.slice());
  }

  addRecentSize(kind, w, h) {
    if (!validSize([w, h])) return;
    const k = kind === 'door' ? 'door' : 'window';
    const key = `${w}*${h}`;
    const list = this.data.recent[k].filter((s) => `${s[0]}*${s[1]}` !== key);
    list.unshift([w, h == null ? null : h]);
    this.data.recent[k] = list.slice(0, RECENT_LIMIT);
    this._save();
  }

  _save() {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.data));
    } catch (_) { /* full or blocked: keep in memory only */ }
  }
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_) {
    return null;
  }
}

function validSize(s) {
  return Array.isArray(s) && posNum(s[0]) != null && (s[1] == null || posNum(s[1]) != null);
}

// Spec for a new opening from the remembered last choice (직전 값).
export function specFromPrefs(prefs, kind) {
  const last = prefs ? prefs.last(kind) : {};
  return kind === 'door'
    ? { kind: 'door', doorType: last.doorType || null }
    : { kind: 'window', material: last.material || null, type: last.type || null };
}

// ---- small helpers ---------------------------------------------------------------------------------

function posNum(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n > 0 ? n : null;
}

function clamp(v, lo, hi) {
  if (hi < lo) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, v));
}

function norm(v) {
  const L = Math.hypot(v.x, v.y);
  return L > 1e-9 ? { x: v.x / L, y: v.y / L } : null;
}
