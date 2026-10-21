// Label placement (stage C; plan §1-2 "실명", "창호 라벨", "설비"). Pure functions, no DOM.
//
//   placeLabels(project, derived, opts) → [label]
//     label = { key, kind: 'room' | 'opening' | 'fixture', refId, x, y (world centre), rot (degrees:
//               0, -90 = reads bottom→top, 90 = reads top→bottom), lines: [{ text, size, color, weight }],
//               lineHeight (factor of size), w, h (unrotated block size, world mm), box (world AABB) }
//
// Sizes are given in "font units" (pt on paper, CSS px on screen) and converted with opts.worldPerUnit
// (world mm per font unit). Text widths come from opts.measure(text, size, weight) → font units; the
// default is a deterministic estimate, so the print layout can be computed without a canvas.
//
// Text of openings and fixtures comes from the other stage-B packages. They are reached through
// `labelHooks`, which the integrator fills (a missing package must not break the drawing):
//   labelHooks.labelOf        = openings.js labelOf(opening) → string ('' = no label)
//   labelHooks.fixtureLabel   = fixtures.js fixtureLabel(fixture) → string
//   labelHooks.openingAnchor  = (opening, project, derived) → { point, dir, edgeId, width, isDoor, roomId? }
//                               (optional; the default below reads common field names)
//   labelHooks.fixtureBox     = (fixture, project, derived) → { center, w, h } (optional; default below)
//
// Placement rules:
//  - Room name (black) at the room's label point, 'H: 2280' (blue) below it. A name that does not fit the
//    room's width shrinks down to 70 %, then wraps onto two lines ('화장실' / '2', as in the 예시 세대 A drawing).
//    Spaces marked 실 아님 use the smaller fixture size, no H, and turn vertical in tall narrow spaces.
//    Unnamed rooms get no label on paper.
//  - Opening labels (blue) sit inside a room next to the opening: the larger real room first, then the
//    other side, then outside an exterior wall. Doors try beyond the swing first. On horizontal walls
//    the label is one line; on vertical walls it turns and splits into '재질종류' / 'W*H' (left half of
//    the plan reads bottom→top, right half top→bottom, like the dimension chains). Candidate positions are
//    tried in order and the first one that hits no wall and no placed label wins: inside over the
//    opening (centred, then shifted by ¼ / ½ of its width) at full size, then at 85 %, then beside the
//    opening past its end, then outside an exterior wall (the 예시 세대 A drawing puts the 화장실1 window label
//    there), then the least-overlap candidate.
//  - Fixture labels (black) at the fixture's centre (or in the part not taken by a symbol given as
//    box.avoid), turned in tall narrow fixtures, shrunk to fit (down to 70 %). A white halo only
//    where lines can cross the text (toilet / basin / bath symbols); 싱크대, 옷장 and 신발장 have a
//    plain gray fill (no diagonal, no basin since 2026-10-17), so their text needs none.
//  - 실 아님 names sit in the middle of the space (gray fill, no diagonal; no halo).
//  - Fixtures are obstacles (2026-10-17, plan §1-2): a room name (with its H) that would sit on a
//    fixture, column or stair moves to the nearest free spot inside the room (findFreeSpot); window /
//    door labels count fixture boxes like the dimension numbers (columns: never); a fixture label keeps
//    to the part of its box not covered by another fixture. Columns are solid black: no text on them.
//  - Manual offsets (moved by hand, plan §2-7): project.labelOffsets[key] = { dx, dy } in PAPER mm (key
//    'room:<id>', 'opening:<id>', 'fixture:<id>'); converted with opts.worldPerPaperMM (= the print
//    scale; the screen uses the same automatic print scale, so screen and paper agree). A moved label
//    sits at its BASE point + the offset, without any avoidance: base = the room's label point, the
//    opening's centre on its wall line, the fixture's centre. (Before 2026-10-17 an opening / fixture
//    offset was added to the automatic spot; no UI wrote such offsets then.)
//    labelBase(project, derived, key) gives that base; installLabelCommands adds the store commands.
//    When values reshape the plan, followMovedLabels (registered by ui/wiring.js as a derive hook)
//    re-writes the offsets so that each moved text keeps its place on the plan (review 예시 세대 A #22).
//  - Diagonal walls (request 2026-10-19): a room with a diagonal side (a triangle, a cut corner, a bay)
//    puts its name block where the whole block lies inside the room, clear of the walls by half the
//    thickest wall + about 1 paper mm (the label point of a triangle is near its middle, but a block
//    as wide as the room there pokes through the slanted wall): nearest to the label point, then 85 %,
//    70 %, then wrapped onto two lines. It also keeps clear of opts.nameObstacles (paper: the
//    dimensions of diagonal sides written inside the rooms). Window / door labels count the diagonal
//    walls by their real outline (polygonBoxArea), and next to a diagonal wall they keep the whole
//    label box off the wall (its extent across the wall, not only its height).
//  - opts.withCandidates (screen): every opening / fixture label also carries `cands`, its candidate
//    spots in order of preference, so the screen can pick the first one clear of the other texts
//    (ui/render.js; level of detail). opts.extraDepth (world mm, a number or a list) adds window / door
//    spots that much further from the wall (beyond the per-side values the editor shows in the rooms).

import { pointInPolygon } from './geom.js';
import { wallPolygons, planOuterBounds, wallThickness, boxOf, polygonBoxArea, innerCorners } from './dims.js';
import { hasGrayFill, normalizeFixture, fixtureBounds, isColumn, isStair } from './fixtures.js';

export const labelHooks = { labelOf: null, fixtureLabel: null, openingAnchor: null, fixtureBox: null };

export const LABEL_COLORS = { name: '#000000', height: '#0070C0', opening: '#0070C0', fixture: '#000000' };
const LINE_HEIGHT = 1.2;
const MIN_NAME_SCALE = 0.7;

// Deterministic width estimate in font units (em fractions of a typical Korean UI font).
export function estimateTextWidth(text, size, weight = 'normal') {
  let em = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff) || c === 0x203b) em += 0.92;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else if (ch >= 'A' && ch <= 'Z') em += 0.64;
    else if (ch >= 'a' && ch <= 'z') em += 0.52;
    else if (ch === ' ') em += 0.28;
    else em += 0.5;
  }
  return em * size * (weight === 'bold' ? 1.04 : 1);
}

// '화장실2' → ['화장실', '2']; '다용도실' → ['다용', '도실'].
export function wrapName(name) {
  const s = String(name || '');
  const m = /^(.*?\D)(\d+)$/.exec(s);
  if (m && m[1].trim()) return [m[1].trim(), m[2]];
  const sp = s.indexOf(' ');
  if (sp > 0) return [s.slice(0, sp), s.slice(sp + 1)];
  const half = Math.ceil(s.length / 2);
  return [s.slice(0, half), s.slice(half)].filter(Boolean);
}

// 'PVC이중창 600*650' → ['PVC이중창', '600*650'] (split before the size).
export function splitOpeningLabel(text) {
  const s = String(text || '').trim();
  const m = /^(.*\S)\s+(\S*\d+\s*[*x×]\s*\d+\S*)$/.exec(s);
  if (m) return [m[1], m[2]];
  const sp = s.lastIndexOf(' ');
  return sp > 0 ? [s.slice(0, sp), s.slice(sp + 1)] : [s];
}

// ---- defaults for the hooks ----------------------------------------------------------------------

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// Reads { edge|edgeId|wall, t (0..1, centre) | at|center|offset (mm from edge.a, centre), width|w }.
export function defaultOpeningAnchor(o, project) {
  if (!o) return null;
  const edgeId = o.edge || o.edgeId || o.wall;
  const e = (project.edges || []).find((x) => x.id === edgeId);
  if (!e) return null;
  const A = (project.nodes || []).find((n) => n.id === e.a), B = (project.nodes || []).find((n) => n.id === e.b);
  if (!A || !B) return null;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (!(L > 0)) return null;
  const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  let s = null;
  if (num(o.t) != null) s = o.t * L;
  else for (const k of ['at', 'center', 'offset', 'pos']) if (num(o[k]) != null) { s = o[k]; break; }
  if (s == null) s = L / 2;
  const width = num(o.width) ?? num(o.w) ?? (o.size && num(o.size.w)) ?? 900;
  const kind = String(o.kind || o.type || o.category || '');
  return {
    point: { x: A.x + dir.x * s, y: A.y + dir.y * s }, dir, edgeId, width,
    isDoor: /door|문/.test(kind), roomId: o.labelRoom || o.room || null,
  };
}

// Reads { center:{x,y} | cx,cy | x,y (top-left) , w|width, h|depth|height } or { points }.
export function defaultFixtureBox(f) {
  if (!f) return null;
  if (Array.isArray(f.points) && f.points.length >= 3) {
    const b = boxOf(f.points);
    return { center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, w: b.maxX - b.minX, h: b.maxY - b.minY };
  }
  const w = num(f.w) ?? num(f.width) ?? null;
  const h = num(f.h) ?? num(f.depth) ?? num(f.height) ?? null;
  if (w == null || h == null) return null;
  if (f.center && num(f.center.x) != null) return { center: { x: f.center.x, y: f.center.y }, w, h };
  if (num(f.cx) != null && num(f.cy) != null) return { center: { x: f.cx, y: f.cy }, w, h };
  if (num(f.x) != null && num(f.y) != null) return { center: { x: f.x + w / 2, y: f.y + h / 2 }, w, h };
  return null;
}

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try { return fn(...args); } catch (err) { console.error('[labels] hook failed', err); return null; }
}

// ---- geometry helpers ----------------------------------------------------------------------------

// Free extent of a polygon through point p along one axis ('x': horizontal scan). → [lo, hi] | null
export function scanExtent(points, p, axis) {
  const along = axis, across = axis === 'x' ? 'y' : 'x';
  const xs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if ((a[across] - p[across]) * (b[across] - p[across]) < 0) {
      const t = (p[across] - a[across]) / (b[across] - a[across]);
      xs.push(a[along] + t * (b[along] - a[along]));
    }
  }
  xs.sort((u, v) => u - v);
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i] <= p[along] && p[along] <= xs[i + 1]) return [xs[i], xs[i + 1]];
  return null;
}

function aabb(cx, cy, w, h, rot) {
  const vertical = rot === 90 || rot === -90;
  const bw = vertical ? h : w, bh = vertical ? w : h;
  return { minX: cx - bw / 2, minY: cy - bh / 2, maxX: cx + bw / 2, maxY: cy + bh / 2 };
}

function hits(a, b, pad = 0) {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minY < b.maxY + pad && a.maxY > b.minY - pad;
}

// True when segment a–b passes through box (Liang–Barsky clipping).
export function segmentHitsBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges = [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}

// Area (mm²) of the intersection of two boxes, b grown by pad.
export function overlapArea(a, b, pad = 0) {
  const w = Math.min(a.maxX, b.maxX + pad) - Math.max(a.minX, b.minX - pad);
  const h = Math.min(a.maxY, b.maxY + pad) - Math.max(a.minY, b.minY - pad);
  return w > 0 && h > 0 ? w * h : 0;
}

export function boxesHit(a, b, pad = 0) {
  return hits(a, b, pad);
}

export function labelBox(cx, cy, w, h, rot) {
  return aabb(cx, cy, w, h, rot);
}

// World boxes of every fixture (설비, 기둥, 계단): obstacles for the labels.
// → [{ minX, minY, maxX, maxY, id, column, stair }]
export function fixtureObstacles(project) {
  const out = [];
  for (const raw of (project && project.fixtures) || []) {
    let f = null, b = null;
    try {
      f = normalizeFixture(raw);
      b = f ? fixtureBounds(f) : null;
    } catch (_) { f = null; }
    if (!f || !b || !isFinite(b.minX) || !isFinite(b.maxY)) continue;
    out.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, id: f.id, column: isColumn(f), stair: isStair(f) });
  }
  return out;
}

// Weighted overlap of a box with obstacle boxes; a column (solid black) counts 100 times.
function obstacleCost(box, obstacles, pad = 0) {
  let s = 0;
  for (const ob of obstacles) {
    const a = overlapArea(box, ob, pad);
    if (a > 0) s += ob.column ? 100 * a : a;
  }
  return s;
}

// The spot nearest to `start` where a w × h box (world mm, already turned) lies inside the polygon
// (kept `margin` mm from its outline) and clear of the obstacle boxes (grown by `pad`). Grid rings of
// `step` mm around the start, up to maxRing rings. When nothing is clear, the inside spot with the least
// weighted overlap (columns count most), else the start. → { x, y, cost }
export function findFreeSpot(poly, w, h, start, obstacles, opts = {}) {
  const margin = opts.margin > 0 ? opts.margin : 0;
  const pad = opts.pad > 0 ? opts.pad : 0;
  const step = opts.step > 0 ? opts.step : Math.max(h / 2, 1);
  const maxRing = opts.maxRing > 0 ? opts.maxRing : 24;
  const hw = w / 2 + margin, hh = h / 2 + margin;
  const inside = (c) => !poly || [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]
    .every(([sx, sy]) => pointInPolygon({ x: c.x + sx * hw, y: c.y + sy * hh }, poly));
  const costAt = (c) => obstacleCost({ minX: c.x - w / 2, minY: c.y - h / 2, maxX: c.x + w / 2, maxY: c.y + h / 2 }, obstacles, pad);
  let best = null;
  const consider = (c) => {
    if (!inside(c)) return false;
    const cost = costAt(c);
    const d = Math.hypot(c.x - start.x, c.y - start.y);
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && d < best.d)) best = { x: c.x, y: c.y, cost, d };
    return cost === 0;
  };
  if (consider(start)) return { x: start.x, y: start.y, cost: 0 };
  for (let r = 1; r <= maxRing; r++) {
    let found = null, foundD = Infinity;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const c = { x: start.x + i * step, y: start.y + j * step };
        if (consider(c)) {
          const d = Math.hypot(i, j);
          if (d < foundD) { found = c; foundD = d; }
        }
      }
    }
    if (found) return { x: found.x, y: found.y, cost: 0 };
  }
  return best ? { x: best.x, y: best.y, cost: best.cost } : { x: start.x, y: start.y, cost: costAt(start) };
}

// The room's inner faces as a polygon (the inner corners of its sides, where the solver measures to).
// → [{x, y}] | null
export function roomInnerPolygon(dr, project, derived) {
  const sides = (dr && dr.sides) || [];
  if (sides.length < 3) return null;
  const pts = [];
  for (let i = 0; i < sides.length; i++) {
    const ic = innerCorners(dr, i, project, derived);
    if (!ic || !isFinite(ic.A.x) || !isFinite(ic.A.y)) return null;
    pts.push(ic.A);
  }
  return pts;
}

// True when a w × h box centred at c (world mm), grown by margin, lies inside the polygon (its corners
// and centre; enough for the convex rooms with diagonal sides, as findFreeSpot).
export function boxInPolygon(poly, c, w, h, margin = 0) {
  const hw = w / 2 + margin, hh = h / 2 + margin;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].every(([sx, sy]) => pointInPolygon({ x: c.x + sx * hw, y: c.y + sy * hh }, poly));
}

// ---- manual offsets ------------------------------------------------------------------------------

// The point a moved label is measured from (world mm): see the header. → { x, y } | null
export function labelBase(project, derived, key) {
  if (!project || !key) return null;
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'room') {
    const dr = derived && Array.isArray(derived.rooms) ? derived.rooms.find((r) => r.roomId === id) : null;
    return dr ? roomBasePoint(dr) : null;
  }
  if (kind === 'opening') {
    const o = (project.openings || []).find((x) => x.id === id);
    if (!o) return null;
    const a = safeCall(labelHooks.openingAnchor, o, project, derived) || defaultOpeningAnchor(o, project);
    return a && a.point ? { x: a.point.x, y: a.point.y } : null;
  }
  if (kind === 'fixture') {
    const f = (project.fixtures || []).find((x) => x.id === id);
    const b = f ? (safeCall(labelHooks.fixtureBox, f, project, derived) || defaultFixtureBox(f)) : null;
    return b && b.center ? { x: b.center.x, y: b.center.y } : null;
  }
  return null;
}

// Where a room's name block is anchored: the engine's label point; 실 아님 spaces (a tall closet) the
// middle of their box when it lies inside (the pole of a long narrow shape can sit anywhere along it).
export function roomBasePoint(dr) {
  if (!dr || !dr.labelPoint) return null;
  let p = dr.labelPoint;
  if (dr.room && dr.room.notRoom && dr.face && Array.isArray(dr.face.points) && dr.face.points.length >= 3) {
    const bb = boxOf(dr.face.points);
    const mid = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
    if (pointInPolygon(mid, dr.face.points)) p = mid;
  }
  return { x: p.x, y: p.y };
}

// A project with one label moved (or reset), as the command stores it; also used for the live preview
// of a drag. move = { key: 'room:<id>' | 'opening:<id>' | 'fixture:<id>' | 'dim:<key>' | null,
//   offset: { dx, dy } (paper mm) | null (back to automatic) | undefined (unchanged),
//   dimRow: { measureId, row: integer >= 0 | null } (a dimension moved to another row) | undefined }
// → the new project, or null when nothing changes.
export function applyLabelMove(project, move) {
  if (!project || !move) return null;
  let next = project;
  if (move.key && move.offset !== undefined) {
    const cur = project.labelOffsets || {};
    if (move.offset === null) {
      if (move.key in cur) {
        const lo = { ...cur };
        delete lo[move.key];
        next = { ...next, labelOffsets: lo };
      }
    } else {
      const dx = Math.round((Number(move.offset.dx) || 0) * 100) / 100;
      const dy = Math.round((Number(move.offset.dy) || 0) * 100) / 100;
      const old = cur[move.key];
      if (!old || old.dx !== dx || old.dy !== dy) next = { ...next, labelOffsets: { ...cur, [move.key]: { dx, dy } } };
    }
  }
  if (move.dimRow && move.dimRow.measureId) {
    const id = move.dimRow.measureId;
    const list = (project.dimOverrides || []).filter((o) => o && o.measureId !== id);
    const old = (project.dimOverrides || []).find((o) => o && o.measureId === id) || null;
    const row = move.dimRow.row;
    const entry = { ...(old || {}), measureId: id };
    if (row == null) delete entry.row;
    else if (Number.isInteger(row) && row >= 0) entry.row = row;
    const empty = Object.keys(entry).length === 1;
    const same = old ? JSON.stringify(old) === JSON.stringify(entry) : empty;
    if (!same) next = { ...next, dimOverrides: empty ? list : [...list, entry] };
  }
  return next === project ? null : next;
}

// Store commands (one undo step each, no re-derive: only the layout of the text changes):
//   store.moveLabel(move)        see applyLabelMove (a dimension's row and its offset in one step)
//   store.resetLabel(key, measureId?)   the label back to its automatic place (and the dimension to its
//                                       automatic row)
// → true when something changed.
export function installLabelCommands(DocStore) {
  const proto = DocStore.prototype;
  if (proto.moveLabel) return;
  proto.moveLabel = function moveLabel(move) {
    return this._commit('moveLabel', (p) => applyLabelMove(p, move), { rederive: false, detail: { key: move && move.key } });
  };
  proto.resetLabel = function resetLabel(key, measureId = null) {
    return this.moveLabel({ key, offset: null, dimRow: measureId ? { measureId, row: null } : undefined });
  };
}

// Texts moved by hand keep their place when a re-derive reshapes the plan (review 예시 세대 A #22: a room name
// moved on the sketch, before the values, sat 0.6 m away from that spot after them). Offsets are paper
// mm at the automatic print scale from the text's base point, and both change with the values: the
// sketch prints at 1:75 / 1:50 / 1:150, the measured plan at 1:60, and the room's label point moves
// with its shape. So
//   - a room name keeps its relative place in its room's follow box (follow.room, fixtures.js
//     planFollower): the spot it was moved to is kept as a placement anchor (review 예시 세대 A round 2),
//       labelOffsets['room:<id>'].pin = { u, v, dx, dy }
//     (u, v) = that spot in the room's box, taken in the plan as it was when the name was moved there;
//     dx, dy = the offset the anchor belongs to (a later move writes a new offset and so leaves it
//     behind; a file reopened without it gets one the same way). Each re-derive puts the spot at (u, v)
//     of the room's box in the NEW plan and writes the offset as that spot seen from the new label point
//     at the new scale, so the result depends only on the final plan, not on the order of the values;
//   - a window / door or fixture text keeps its distance from its object in world mm (its base point
//     moves with the object; the offset only follows the change of print scale, as for 도면 돌리기);
//   - the title (a page position) and dimension offsets (along their line) are left alone.
// A room whose corners the edit changed is followed once by the scale only, and its anchor dropped.
// prev / next: the states before and after ({ project, derived }); scale0 / scale1: their automatic
// print scales (world mm per paper mm); follow: planFollower(prev → next) | null.
// → the next project with the offsets moved, or null when nothing changes
export function followMovedLabels(prev, next, scale0, scale1, follow) {
  const offs = next && next.project && next.project.labelOffsets;
  if (!offs || !(scale0 > 0) || !(scale1 > 0)) return null;
  const out = {};
  let changed = false;
  for (const [key, v] of Object.entries(offs)) {
    out[key] = v;
    if (!v || key === 'title' || key.startsWith('dim:')) continue;
    const dx = Number(v.dx) || 0, dy = Number(v.dy) || 0;
    let nd = null, pin = null;
    const room = key.startsWith('room:');
    if (room && follow && prev && prev.project) {
      const m = follow.room(key.slice(5));
      const b1 = labelBase(next.project, next.derived, key);
      if (m && b1) {
        pin = roomLabelPin(v);
        if (!pin) {
          const b0 = labelBase(prev.project, prev.derived, key);
          const w0 = m.box0.maxX - m.box0.minX, h0 = m.box0.maxY - m.box0.minY;
          if (b0 && w0 > 1 && h0 > 1) {
            pin = { u: (b0.x + dx * scale0 - m.box0.minX) / w0, v: (b0.y + dy * scale0 - m.box0.minY) / h0 };
          }
        }
        if (pin) {
          const at = { x: m.box1.minX + pin.u * (m.box1.maxX - m.box1.minX), y: m.box1.minY + pin.v * (m.box1.maxY - m.box1.minY) };
          nd = { dx: (at.x - b1.x) / scale1, dy: (at.y - b1.y) / scale1 };
        }
      }
    }
    if (!nd && Math.abs(scale0 - scale1) > 1e-9) nd = { dx: (dx * scale0) / scale1, dy: (dy * scale0) / scale1 };
    if (!nd) {
      if (room && v.pin != null && !pin) { out[key] = withoutPin(v); changed = true; }
      continue;
    }
    const r = { ...v, dx: Math.round(nd.dx * 100) / 100, dy: Math.round(nd.dy * 100) / 100 };
    if (r.dx === Number(v.dx) && r.dy === Number(v.dy)) {
      // Not moved: an anchor taken just now is not stored yet; one that no longer applies goes.
      if (room && v.pin != null && !pin) { out[key] = withoutPin(v); changed = true; }
      continue;
    }
    if (pin) r.pin = { u: pin.u, v: pin.v, dx: r.dx, dy: r.dy };
    else delete r.pin;
    out[key] = r;
    changed = true;
  }
  return changed ? { ...next.project, labelOffsets: out } : null;
}

// The anchor of a moved room name while it belongs to the offset as it is. → { u, v } | null
export function roomLabelPin(v) {
  const p = v && v.pin;
  if (!p || typeof p !== 'object' || ![p.u, p.v, p.dx, p.dy].every((x) => typeof x === 'number' && isFinite(x))) return null;
  return p.dx === Number(v.dx) && p.dy === Number(v.dy) ? { u: p.u, v: p.v } : null;
}

function withoutPin(v) {
  const r = { ...v };
  delete r.pin;
  return r;
}

// 도면 돌리기 (ui/wiring.js rotate follower): a room name moved by hand stays at its turned WORLD spot
// (old label point + offset × old scale, turned with the plan) and its offset is written again from the
// new label point at the new scale. The label point of an L-shaped room can jump about 1 m when the
// plan turns (예시 세대 A 거실), so turning the offset vector alone moved the name, out of the room once.
// before / after: the states ({ project, derived }) before and after the turn (after.project holds the
// offsets as rotate.js turned them, and their turned anchors); scale0 / scale1: their automatic print
// scales; point: the turn of a world point. → the after project with those offsets, or null
export function turnMovedRoomLabels(before, after, scale0, scale1, point) {
  const offs0 = (before && before.project && before.project.labelOffsets) || {};
  const offs1 = after && after.project && after.project.labelOffsets;
  if (!offs1 || !(scale0 > 0) || !(scale1 > 0) || typeof point !== 'function') return null;
  const out = { ...offs1 };
  let changed = false;
  for (const [key, v0] of Object.entries(offs0)) {
    if (!key.startsWith('room:') || !v0 || !out[key]) continue;
    const b0 = labelBase(before.project, before.derived, key), b1 = labelBase(after.project, after.derived, key);
    if (!b0 || !b1) continue;
    const w = point({ x: b0.x + (Number(v0.dx) || 0) * scale0, y: b0.y + (Number(v0.dy) || 0) * scale0 });
    const v1 = out[key];
    const r = { ...v1, dx: Math.round(((w.x - b1.x) / scale1) * 100) / 100, dy: Math.round(((w.y - b1.y) / scale1) * 100) / 100 };
    // The anchor rotate.js turned with the plan still belongs to this name (now at its new offset).
    const pin = roomLabelPin(v1);
    if (pin) r.pin = { u: pin.u, v: pin.v, dx: r.dx, dy: r.dy };
    else delete r.pin;
    if (JSON.stringify(r) === JSON.stringify(v1)) continue;
    out[key] = r;
    changed = true;
  }
  return changed ? { ...after.project, labelOffsets: out } : null;
}

// True when the label (or the dimension) was moved by hand.
export function isLabelMoved(project, key, measureId = null) {
  if (!project) return false;
  if (key && project.labelOffsets && project.labelOffsets[key]) return true;
  if (measureId) {
    const o = (project.dimOverrides || []).find((x) => x && x.measureId === measureId);
    if (o && Number.isInteger(o.row)) return true;
  }
  return false;
}

// ---- placement -----------------------------------------------------------------------------------

// opts: { fonts: { name, height, opening, fixture } (font units), worldPerUnit, worldPerPaperMM,
//         measure(text, size, weight) → font units, include: { rooms, openings, fixtures },
//         obstacles: [{ minX, minY, maxX, maxY }] world boxes opening labels avoid (dimensions),
//         fixtureBoxes: obstacle boxes of the fixtures (default fixtureObstacles(project)),
//         offsetWorldPerPaperMM: world mm per paper mm for the manual offsets (paper: the automatic
//         print scale, also when the user picked another one; default worldPerPaperMM),
//         nameObstacles: world boxes the names of rooms with a diagonal side keep clear of,
//         withCandidates, extraDepth: screen only (see the header) }
export function placeLabels(project, derived, opts = {}) {
  if (!project || !derived || !Array.isArray(derived.rooms)) return [];
  const fonts = { name: 12.3, height: 8.8, opening: 8.8, fixture: 8.8, ...(opts.fonts || {}) };
  const wpu = opts.worldPerUnit > 0 ? opts.worldPerUnit : 1;
  const wppm = opts.worldPerPaperMM > 0 ? opts.worldPerPaperMM : 60;
  // Offsets are paper mm at the AUTOMATIC print scale (what the screen uses), so a label moved on the
  // screen lands on the same spot of the plan at a scale chosen by hand too.
  const offScale = opts.offsetWorldPerPaperMM > 0 ? opts.offsetWorldPerPaperMM : wppm;
  const measure = typeof opts.measure === 'function' ? opts.measure : estimateTextWidth;
  const include = { rooms: true, openings: true, fixtures: true, ...(opts.include || {}) };
  const offsets = project.labelOffsets || {};
  const walls = wallPolygons(project, derived);
  const bounds = planOuterBounds(project, derived, walls);
  const wallBoxes = walls.filter((w) => w.orient !== 'd').map((w) => w.box);
  // Diagonal walls by their outline (their bounding box would cover the rooms beside them).
  const diagWalls = walls.filter((w) => w.orient === 'd').map((w) => w.points);
  const nameObstacles = Array.isArray(opts.nameObstacles) ? opts.nameObstacles.filter(Boolean) : [];
  // Boxes (world mm) the labels should keep clear of, e.g. the printed dimension numbers and lines.
  const obstacles = Array.isArray(opts.obstacles) ? opts.obstacles.filter(Boolean) : [];
  // Fixtures, columns and stairs: no text on them (columns are solid black).
  const fixtureBoxes = Array.isArray(opts.fixtureBoxes) ? opts.fixtureBoxes : fixtureObstacles(project);
  const withCands = !!opts.withCandidates;
  // Extra distances from the wall for window / door spots (screen): a number or a list.
  const depths = [0].concat((Array.isArray(opts.extraDepth) ? opts.extraDepth : [opts.extraDepth]).filter((v) => v > 0));
  const placed = [];
  const width = (text, size, weight) => measure(text, size, weight) * wpu; // → world mm
  const block = (lines) => ({
    w: Math.max(0, ...lines.map((l) => width(l.text, l.size, l.weight))),
    h: lines.reduce((s, l) => s + l.size * LINE_HEIGHT * wpu, 0),
  });
  // A label moved by hand sits at its base point + the offset (paper mm × print scale).
  const finish = (label) => {
    const off = offsets[label.key];
    if (off) {
      const base = label.base || { x: label.x, y: label.y };
      label.x = base.x + (Number(off.dx) || 0) * offScale;
      label.y = base.y + (Number(off.dy) || 0) * offScale;
      label.moved = true;
    }
    label.box = aabb(label.x, label.y, label.w, label.h, label.rot);
    if (withCands && (label.moved || !label.cands)) {
      label.cands = [{ x: label.x, y: label.y, rot: label.rot, lines: label.lines, w: label.w, h: label.h, box: label.box }];
    }
    placed.push(label);
    return label;
  };
  const cand = (x, y, rot, lines, b) => ({ x, y, rot, lines, w: b.w, h: b.h, box: aabb(x, y, b.w, b.h, rot) });

  if (include.rooms) for (const dr of derived.rooms) placeRoom(dr);
  if (include.openings) for (const o of project.openings || []) placeOpening(o);
  if (include.fixtures) for (const f of project.fixtures || []) placeFixture(f);
  return placed;

  function placeRoom(dr) {
    const room = dr.room;
    if (!room || !room.name || !dr.labelPoint || !dr.face) return;
    const notRoom = !!room.notRoom;
    const p = roomBasePoint(dr);
    const margin = 2 * 80 + 1 * wppm; // inner wall faces plus about 1 paper mm
    // A scan exactly through a corner can miss; retry a hair off it.
    const scan = (axis) => scanExtent(dr.face.points, p, axis)
      || scanExtent(dr.face.points, { x: p.x + 0.37, y: p.y + 0.37 }, axis);
    const ex = scan('x'), ey = scan('y');
    const availW = ex ? ex[1] - ex[0] - margin : Infinity;
    const availH = ey ? ey[1] - ey[0] - margin : Infinity;
    const baseSize = notRoom ? fonts.fixture : fonts.name;
    const color = LABEL_COLORS.name;
    let rot = 0;
    let avail = availW;
    const nameW = width(room.name, baseSize);
    // 실 아님 spaces: turn when that fits better (옷장 700 wide, 3570 tall).
    // A tall narrow space reads vertically even when the name would just squeeze in across it (the
    // available width counts thin walls only; next to a thick wall a "just fitting" name touches it).
    if (notRoom && availH > availW && (nameW > availW || (availH > 2 * availW && nameW > 0.6 * availW))) {
      rot = -90;
      avail = availH;
    }
    let names = [room.name];
    let size = baseSize;
    if (nameW > avail) {
      const k = Math.max(MIN_NAME_SCALE, avail / nameW);
      size = baseSize * k;
      if (nameW * k > avail) {
        names = wrapName(room.name);
        const wMax = Math.max(...names.map((t) => width(t, baseSize)));
        size = baseSize * Math.max(MIN_NAME_SCALE, Math.min(1, avail / wMax));
      }
    }
    const lines = names.map((text) => ({ text, size, color, weight: 'normal' }));
    if (!notRoom && room.height != null && room.height !== '' && isFinite(Number(room.height))) {
      const hText = `H: ${Math.round(Number(room.height))}`;
      const hw = width(hText, fonts.height);
      const hs = hw > avail ? fonts.height * Math.max(MIN_NAME_SCALE, avail / hw) : fonts.height;
      lines.push({ text: hText, size: hs, color: LABEL_COLORS.height, weight: 'normal' });
    }
    let b = block(lines);
    const key = `room:${dr.roomId}`;
    // On a fixture, column or stair: the nearest free spot inside the room (a moved name stays put).
    let at = p;
    const slanted = (dr.sides || []).some((sd) => sd.orient === 'd');
    if (slanted && !offsets[key]) {
      // A room with a diagonal side: the whole block inside, off the walls (see the header).
      const fit = fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines, p);
      if (fit) { at = fit.at; lines.splice(0, lines.length, ...fit.lines); b = block(lines); }
    } else if (!offsets[key] && fixtureBoxes.length) {
      const box0 = aabb(p.x, p.y, b.w, b.h, rot);
      if (fixtureBoxes.some((ob) => hits(box0, ob))) {
        const bw = box0.maxX - box0.minX, bh = box0.maxY - box0.minY;
        at = findFreeSpot(dr.face.points, bw, bh, p, fixtureBoxes, { margin: 80, step: Math.max(bh / 3, 0.5 * wppm) });
      }
    }
    // 실 아님 spaces have a plain gray fill (draw-fixtures.js drawNotRoomSpaces; no diagonal any more):
    // the name stays in the middle and needs no halo.
    finish({ key, kind: 'room', refId: dr.roomId, x: at.x, y: at.y, base: p, rot, lines, lineHeight: LINE_HEIGHT, w: b.w, h: b.h, halo: false });
  }

  // Name block (+ H) of a room with a diagonal side: the first size / wrap whose block fits inside the
  // room clear of the walls, fixtures and nameObstacles, nearest the label point. → { at, lines } | null
  function fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p) {
    // The room inside its walls (each side's own wall and finish), about 1 paper mm in from them.
    const poly = roomInnerPolygon(dr, project, derived);
    if (!poly) return null;
    const margin = 0.8 * wppm;
    const obst = fixtureBoxes.concat(nameObstacles);
    const hLine = lines0.find((l) => l.color === LABEL_COLORS.height && /^H: /.test(l.text)) || null;
    const nameSets = [[room.name]];
    const wrapped = wrapName(room.name);
    if (wrapped.length > 1) nameSets.push(wrapped);
    const variants = [];
    for (const names of nameSets) {
      for (const k of [1, 0.85, MIN_NAME_SCALE]) {
        const ls = names.map((text) => ({ text, size: baseSize * k, color, weight: 'normal' }));
        if (hLine) ls.push({ ...hLine, size: fonts.height * Math.max(0.8, k) });
        variants.push(ls);
      }
    }
    let best = null;
    for (const ls of variants) {
      const bb = block(ls);
      const box0 = aabb(p.x, p.y, bb.w, bb.h, rot);
      const bw = box0.maxX - box0.minX, bh = box0.maxY - box0.minY;
      const spot = findFreeSpot(poly, bw, bh, p, obst, { margin, step: Math.max(bh / 3, 0.5 * wppm) });
      if (!boxInPolygon(poly, spot, bw, bh, margin)) continue;
      if (spot.cost === 0) return { at: { x: spot.x, y: spot.y }, lines: ls };
      if (!best || spot.cost < best.cost) best = { at: { x: spot.x, y: spot.y }, lines: ls, cost: spot.cost };
    }
    return best;
  }

  function placeOpening(o) {
    const text = String(safeCall(labelHooks.labelOf, o) || '').trim();
    if (!text) return;
    const anchor = safeCall(labelHooks.openingAnchor, o, project, derived) || defaultOpeningAnchor(o, project);
    if (!anchor || !anchor.point || !anchor.dir) return;
    const edge = (project.edges || []).find((e) => e.id === anchor.edgeId);
    const t = edge ? wallThickness(edge, project, derived) : 150;
    const horizontal = Math.abs(anchor.dir.x) >= Math.abs(anchor.dir.y);
    const slantedWall = Math.abs(anchor.dir.x) > 1e-3 && Math.abs(anchor.dir.y) > 1e-3;
    const midX = bounds ? (bounds.minX + bounds.maxX) / 2 : anchor.point.x;
    const rot = horizontal ? 0 : (anchor.point.x < midX ? -90 : 90);
    const key = `opening:${o.id}`;
    const gap = 1.2 * wppm;                    // about 1.2 paper mm from the wall face
    const mkLines = (parts, scale) => parts.map((s) => ({ text: s, size: fonts.opening * scale, color: LABEL_COLORS.opening, weight: 'normal' }));
    const normals = normalOrder(anchor, derived);
    // Candidates of one size: { x, y, poly, rot, lines, b }. reach 'near': the label's centre stays
    // over its opening (centred, then shifted by a quarter / half of the opening's width); 'far': the
    // label beside the opening, past its end (only when nothing over the opening is clear).
    // depth: extra distance from the wall (screen: beyond the per-side values).
    const tryAt = (scale, reach = 'near', depth = 0) => {
      const lines = mkLines(horizontal ? [text] : splitOpeningLabel(text), scale);
      const b = block(lines);
      // The block height lies across the wall in both orientations (vertical walls turn the block);
      // next to a diagonal wall the whole (upright or turned) box must clear it.
      const bw0 = rot ? b.h : b.w, bh0 = rot ? b.w : b.h;
      const across = slantedWall ? Math.abs(anchor.dir.y) * bw0 + Math.abs(anchor.dir.x) * bh0 : b.h;
      const alongHalf = b.w / 2;
      const W = anchor.width || 0;
      const shifts = reach === 'near'
        ? [0, W / 4, -W / 4, W / 2, -W / 2].filter((s, i) => i === 0 || Math.abs(s) >= 1)
        : [alongHalf + W / 2 + gap, -(alongHalf + W / 2 + gap)];
      const cands = [];
      for (const n of normals) {
        const ds = anchor.isDoor ? [t / 2 + anchor.width + gap + across / 2, t / 2 + gap + across / 2] : [t / 2 + gap + across / 2];
        for (const d0 of ds) {
          const d = d0 + depth;
          for (const s of shifts) {
            cands.push({
              x: anchor.point.x + n.x * d + anchor.dir.x * s,
              y: anchor.point.y + n.y * d + anchor.dir.y * s,
              poly: n.poly, rot, lines, b,
            });
          }
        }
        // A vertical wall shorter than the turned label (예시 세대 A A34 on the 430 mm step): one horizontal
        // line beside the wall instead.
        if (!horizontal && reach === 'near') {
          const l1 = mkLines([text], scale);
          const b1 = block(l1);
          const d = t / 2 + gap + b1.w / 2 + depth;
          cands.push({ x: anchor.point.x + n.x * d, y: anchor.point.y + n.y * d, poly: n.poly, rot: 0, lines: l1, b: b1 });
        }
      }
      return cands;
    };
    const tiers = [[1, true, 'near'], [0.85, true, 'near'], [1, true, 'far'], [0.85, true, 'far'], [1, false, 'near'], [1, false, 'far']];
    // Screen: every usable spot in order of preference (each tier right at the wall, then beyond the
    // per-side values).
    let cands = null;
    if (withCands) {
      cands = [];
      for (const [scale, inside, reach] of tiers) {
        for (const depth of depths) {
          for (const c of tryAt(scale, reach, depth)) {
            if (!!c.poly !== inside) continue;
            if (c.poly && !pointInPolygon(c, c.poly)) continue;
            cands.push(cand(c.x, c.y, c.rot, c.lines, c.b));
          }
        }
      }
    }
    const place = (c) => finish({
      key, kind: 'opening', refId: o.id, x: c.x, y: c.y, base: { x: anchor.point.x, y: anchor.point.y },
      span: anchor.width || 0, rot: c.rot, lines: c.lines, lineHeight: LINE_HEIGHT, w: c.b.w, h: c.b.h, cands,
    });
    // Moved by hand: the first spot's size and turn, at the base point + the offset.
    if (offsets[key]) {
      const c0 = tryAt(1)[0];
      if (c0) place(c0);
      return;
    }
    // Inside a room over the opening at full size, then at 85 %, then beside the opening (past its
    // end), then outside an exterior wall (as the 예시 세대 A drawing does for the small 화장실1 window). When
    // every candidate hits something, the one that covers the least wall, label and dimension area wins
    // (dimension numbers count most: they must stay legible). Fixture boxes count like the dimension
    // numbers; a column (solid black) far more.
    // A spot over the opening that only grazes another label's 0.5 mm clearance (keeping 0.15 mm) is
    // still preferred to a spot past the opening's end, where the label reads as the neighbour's.
    let best = null, nearOk = null;
    const costOf = (box, pad) => wallBoxes.reduce((s, w) => s + overlapArea(box, w), 0)
      + diagWalls.reduce((s, w) => s + polygonBoxArea(w, box), 0)
      + placed.reduce((s, l) => s + 2 * overlapArea(box, l.box, pad), 0)
      + obstacles.reduce((s, ob) => s + 4 * overlapArea(box, ob, pad), 0)
      + fixtureBoxes.reduce((s, ob) => s + (ob.column ? 50 : 4) * overlapArea(box, ob), 0);
    for (const [scale, inside, reach] of tiers) {
      if (reach === 'far' && nearOk) { place(nearOk); return; }
      for (const c of tryAt(scale, reach)) {
        if (!!c.poly !== inside) continue;
        if (c.poly && !pointInPolygon(c, c.poly)) continue;
        const box = aabb(c.x, c.y, c.b.w, c.b.h, c.rot);
        const cost = costOf(box, 0.5 * wppm);
        if (cost === 0) { place(c); return; }
        if (!nearOk && reach === 'near' && inside && costOf(box, 0.15 * wppm) === 0) nearOk = c;
        if (!best || cost < best.cost) best = { cost, c };
      }
    }
    if (nearOk) { place(nearOk); return; }
    if (best) { place(best.c); return; }
    const all = tryAt(1);
    if (all.length) place(all[0]);
  }

  // Normals to try for an opening label, best room first, each with the room polygon (null = outside).
  function normalOrder(anchor, derivedData) {
    const n1 = { x: -anchor.dir.y, y: anchor.dir.x }, n2 = { x: anchor.dir.y, y: -anchor.dir.x };
    const probe = 200;
    const roomAt = (n) => {
      const q = { x: anchor.point.x + n.x * probe, y: anchor.point.y + n.y * probe };
      let best = null;
      for (const dr of derivedData.rooms) {
        if (dr.face && pointInPolygon(q, dr.face.points) && (!best || dr.area < best.area)) best = dr;
      }
      return best;
    };
    const sides = [{ ...n1, dr: roomAt(n1) }, { ...n2, dr: roomAt(n2) }];
    const score = (s) => {
      if (!s.dr) return -1;
      if (anchor.roomId && s.dr.roomId === anchor.roomId) return 1e12;
      return (s.dr.room && s.dr.room.notRoom ? 0 : 1e9) + (s.dr.area || 0) / 1e3;
    };
    sides.sort((p, q) => score(q) - score(p));
    return sides.map((s) => ({ x: s.x, y: s.y, poly: s.dr ? s.dr.face.points : null }));
  }

  function placeFixture(f) {
    const text = String(safeCall(labelHooks.fixtureLabel, f) || '').trim();
    if (!text) return;
    const full = safeCall(labelHooks.fixtureBox, f, project, derived) || defaultFixtureBox(f);
    if (!full || !full.center) return;
    // Other fixtures (a column in a 옷장) are avoided like the symbols inside the box.
    const own = { minX: full.center.x - full.w / 2, minY: full.center.y - full.h / 2, maxX: full.center.x + full.w / 2, maxY: full.center.y + full.h / 2 };
    const others = fixtureBoxes.filter((ob) => ob.id !== f.id && overlapArea(own, ob) > 0);
    const box = freePartOf(others.length ? { ...full, avoid: [...(full.avoid || []), ...others] } : full);
    const tw = width(text, fonts.fixture);
    let rot = 0, avail = box.w;
    if (tw > box.w * 0.95 && box.h > box.w) { rot = -90; avail = box.h; }
    const k = tw > avail * 0.95 ? Math.max(MIN_NAME_SCALE, (avail * 0.95) / tw) : 1;
    const lines = [{ text, size: fonts.fixture * k, color: LABEL_COLORS.fixture, weight: 'normal' }];
    const b = block(lines);
    // halo: drawn with a white outline, so a line of the symbol under it never strikes through it;
    // not on the plain gray boxes (싱크대, 옷장, 신발장), where no line crosses the text.
    const halo = !hasGrayFill(f);
    let cands = null;
    if (withCands) {
      // Screen: in the box, smaller, then just outside the box's front (a small fixture far out).
      cands = [cand(box.center.x, box.center.y, rot, lines, b)];
      const small = [{ ...lines[0], size: lines[0].size * 0.8 }];
      cands.push(cand(box.center.x, box.center.y, rot, small, block(small)));
      const flat = [{ ...lines[0], size: fonts.fixture }];
      const bf = block(flat);
      const front = frontOf(f);
      const reach = Math.abs(front.x) * (full.w / 2 + bf.w / 2) + Math.abs(front.y) * (full.h / 2 + bf.h / 2) + 0.4 * bf.h;
      cands.push(cand(full.center.x + front.x * reach, full.center.y + front.y * reach, 0, flat, bf));
    }
    finish({
      key: `fixture:${f.id}`, kind: 'fixture', refId: f.id, x: box.center.x, y: box.center.y,
      base: { x: full.center.x, y: full.center.y }, rot, lines, lineHeight: LINE_HEIGHT, w: b.w, h: b.h, halo, cands,
    });
  }

  // The part of a fixture box (along its long axis) outside the symbols drawn in it (box.avoid, e.g.
  // the sink basin): the larger free stretch. → { center, w, h }
  function freePartOf(box) {
    const long = box.w >= box.h ? 'x' : 'y';
    const size = long === 'x' ? box.w : box.h;
    let lo = box.center[long] - size / 2, hi = box.center[long] + size / 2;
    for (const a of box.avoid || []) {
      const alo = long === 'x' ? a.minX : a.minY, ahi = long === 'x' ? a.maxX : a.maxY;
      if (ahi <= lo || alo >= hi) continue;
      if (alo - lo >= hi - ahi) hi = Math.max(lo, alo); else lo = Math.min(hi, ahi);
    }
    if (!(hi - lo > 0.25 * size)) return box; // the symbol fills the box: keep the centre
    const center = { ...box.center, [long]: (lo + hi) / 2 };
    return long === 'x' ? { center, w: hi - lo, h: box.h } : { center, w: box.w, h: hi - lo };
  }
}

// Unit vector toward a fixture's front (away from the wall its back stands against).
function frontOf(f) {
  const rot = ((Math.round(Number(f && f.rot) || 0) % 360) + 360) % 360;
  if (rot === 90) return { x: -1, y: 0 };
  if (rot === 180) return { x: 0, y: -1 };
  if (rot === 270) return { x: 1, y: 0 };
  return { x: 0, y: 1 };
}
