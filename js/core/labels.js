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
//   labelHooks.openingAnchor  = (opening, project, derived) → { point, dir, edgeId, width, isDoor, roomId?,
//                               sliding?, swing? } (optional; the default below reads common field names)
//                               sliding: a sliding door (미서기문, 3연동 도어: no swing);
//                               swing (hinged doors, as draw-openings.js draws it): { normal (unit, the
//                               side the door opens into), hinge (mm along dir from the opening's centre,
//                               −width/2 or +width/2), radius (mm), offset (mm from the wall's centre line
//                               to the hinge, toward normal) } | null. A door with neither is a hinged
//                               door of unknown swing: its swing is kept clear of on both sides.
//   labelHooks.fixtureBox     = (fixture, project, derived) → { center, w, h } (optional; default below)
//
// Placement rules:
//  - Room name (black) at the room's label point, 'H: 2280' (blue) below it. A name that does not fit the
//    room's width shrinks down to 70 %, then wraps onto two lines ('화장실' / '2', as in the 예시 세대 A drawing).
//    Spaces marked 실 아님 use the smaller fixture size, no H, and turn vertical in tall narrow spaces.
//    Unnamed rooms get no label on paper.
//  - Opening labels (blue) are ATTACHED to their opening (user 2026-10-24: "바로 붙어 있어야 알아보잖아";
//    see openingLabelFit for the exact rule): every candidate spot has its near edge about 1.2 paper mm
//    beyond the face of the wall on its side (a finish layer drawn there counts as wall), and on the
//    side a hinged door swings into, 1.2 mm beyond the swing (arc and open leaf) wherever the label lies
//    over it, as the 예시 세대 A drawing writes 'ABS도어 800*2000' just outside its arc. Sliding doors (미서기문,
//    3연동 도어) and windows have no swing; the side a hinged door does not open into has none either.
//    (Before 2026-10-24 every door tried the width of the door beyond the wall first, on whichever side
//    came first: a 미서기문 1800 label floated 1800 mm into the room.) Sides: inside a room, the larger
//    real room first, then the other side, then outside an exterior wall. On horizontal walls the label
//    is one line; on vertical walls it turns and splits into '재질종류' / 'W*H' (left half of the plan
//    reads bottom→top, right half top→bottom, like the dimension chains). Candidate positions are tried
//    in order and the first one that hits no wall, no placed label, no dimension number, no fixture and
//    no other door's swing wins: inside over the opening (centred, then shifted by ¼ / ½ of its width)
//    at full size, then at 85 %, then beside the opening past its end, then outside an exterior wall
//    at full size and at 85 % (the 예시 세대 A drawing puts the 화장실1 window label there, between the wall
//    and the dimension chain; on a diagonal wall outside comes before past the end). In a crowded spot
//    where none of these is clear (recheck 2026-10-25, 예시 세대 A turned: the small 베란다1 jog window), the
//    print slides the label along its wall to the nearest clear attached spot, also written the other way
//    ('AL단창' / '1000*1050' on two lines beside a horizontal wall) and at 70 %, and a room name moves
//    elsewhere in its room (smaller if need be, never into a door's swing) to make room for it
//    (placeOpening crowdedSpot, makeRoomFor). Then the
//    least-overlap candidate — always one of these attached spots, never a spot further into the room.
//    On paper, when such a fallback is written across another label, the labels are placed again with
//    the ones that fell back first, and the arrangement with fewer labels across another is kept
//    (placeOpenings; final check 2026-10-25).
//    In that fallback a wall counts like a dimension number (4×: blue text on a black wall is lost).
//    A spot that reads as ANOTHER opening's label (its centre over an opening in a parallel wall, right
//    at that wall's face, nearer to that opening than to its own: past its end, over the next door) is
//    taken only when there is no other spot at all (checker 2026-10-24).
//  - Fixture labels (black) at the fixture's centre (or in the part not taken by a symbol given as
//    box.avoid), turned in tall narrow fixtures, shrunk to fit (down to 70 %). A white halo only
//    where lines can cross the text (toilet / basin / bath symbols); 싱크대, 옷장 and 신발장 have a
//    plain gray fill (no diagonal, no basin since 2026-10-17), so their text needs none.
//    Plain boxes (fixtures.js isPlainBox: 싱크대, 옷장, 신발장, 보일러, 기타) have a second, inner outline
//    (user 2026-10-25; ui/draw-fixtures.js): with opts.fixtureInner { gap, line } (world mm) their
//    label keeps inside that inner line — the box shrunk by fixtureInnerTextInset on every side (the
//    line, half of it as clearance, and a quarter gap of white: 1.18 paper mm), the text shrunk
//    (down to 70 %) to fit along and across it. Where it would not fit even so, or the inner box is
//    under 2 × gap, the inner line is not drawn (fixtureInnerLineShown; the drawing uses the same rule)
//    and the label fits the outline as before.
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
//    spots that much further from the wall (beyond the per-side values the editor shows in the rooms):
//    over the opening only, inside a room only, after every attached spot, flagged attached: false and
//    stack: { n, face, near } (ui/render.js takes one only where a value of that wall was really written
//    between it and the wall; the least-overlap fallback never takes them). Each candidate carries
//    `attached`; one that reads as another opening's label (see above) comes last, flagged misleading.
//    The label carries dir (its wall's direction) next to base (its opening's centre).

import { pointInPolygon } from './geom.js';
import { wallPolygons, planOuterBounds, wallThickness, boxOf, polygonBoxArea, innerCorners, finishBeside } from './dims.js';
import { hasGrayFill, normalizeFixture, fixtureBounds, isColumn, isStair, isPlainBox } from './fixtures.js';

export const labelHooks = { labelOf: null, fixtureLabel: null, openingAnchor: null, fixtureBox: null };

export const LABEL_COLORS = { name: '#000000', height: '#0070C0', opening: '#0070C0', fixture: '#000000' };
const LINE_HEIGHT = 1.2;
const MIN_NAME_SCALE = 0.7;

// ---- fixture text in its box ---------------------------------------------------------------------

// How a fixture label fits a box w × h (any one unit: world mm, canvas px): tw = the text's width and
// em = its font size, both at full size. Turned (rot -90, reads bottom→top) in a tall narrow box when
// it does not fit across; shrunk to fit along it, down to MIN_NAME_SCALE. inner: the box is the inside
// of a plain box's inner line — the letters must also fit across it (shrunk for that too), and `fits`
// says whether the text at k lies inside. → { rot, k, fits }
export function fixtureTextFit(tw, em, w, h, inner = false) {
  let rot = 0, avail = w, cross = h;
  if (tw > w * 0.95 && h > w) { rot = -90; avail = h; cross = w; }
  let k = tw > avail * 0.95 ? Math.max(MIN_NAME_SCALE, (avail * 0.95) / tw) : 1;
  if (!inner) return { rot, k, fits: tw * k <= avail * 0.95 + 1e-9 };
  if (em > 0 && em * k > cross * 0.95) k = Math.max(MIN_NAME_SCALE, Math.min(k, (cross * 0.95) / em));
  const fits = w > 0 && h > 0 && tw * k <= avail * 0.95 + 1e-9 && em * k <= cross * 0.95 + 1e-9;
  return { rot, k, fits };
}

// How far inside a plain box's outline its label keeps when the inner line (gap inside the outline,
// `line` wide) is drawn: past the inner line by half its width plus another half (clearance) and a
// quarter gap of white, so the letters never touch it (paper: 0.8 + 0.18 + 0.2 = 1.18 mm).
export function fixtureInnerTextInset(gap, line) {
  return gap * 1.25 + Math.max(0, line || 0);
}

// Is the inner outline of a plain box drawn (user 2026-10-25: "다른것까지 한줄 더 그어줘")? Box w × h,
// the inner line `gap` inside the outline and `line` wide, the label tw wide at font size em (tw 0: no
// label), all in one unit. Not when the inner box would be under 2 × gap (too small at this scale), nor
// when the label would not fit inside the inner line (box shrunk by fixtureInnerTextInset) even at
// 70 %: then the fixture keeps its plain outline and the label fits it as before. The drawing
// (ui/draw-fixtures.js) and the label placement (placeLabels opts.fixtureInner) both decide by this. → bool
export function fixtureInnerLineShown(w, h, gap, line, tw = 0, em = 0) {
  if (!(gap > 0) || !(w > 0) || !(h > 0)) return false;
  if (Math.min(w, h) - 2 * gap < 2 * gap) return false;
  if (!(tw > 0)) return true;
  const inset = fixtureInnerTextInset(gap, line);
  return fixtureTextFit(tw, em, w - 2 * inset, h - 2 * inset, true).fits;
}

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

// Reads { edge|edgeId|wall, t (0..1, centre) | at|center|offset (mm from edge.a, centre), width|w,
// kind, doorType, swing: { side: 'left' | 'right', hinge: 'start' | 'end' } } (the openings.js record:
// 'left' is the side on the left walking a → b on screen, the normal (dir.y, −dir.x); a door without a
// swing opens to the left from the 'start' end, as draw-openings.js draws it). The hinge sits a
// quarter of the wall's thickness off its centre line (draw-openings.js bandRatio 0.5).
export function defaultOpeningAnchor(o, project, derived = null) {
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
  const isDoor = /door|문/.test(kind);
  const sliding = isDoor && /미서기|연동|slid/i.test(String(o.doorType || o.type || ''));
  let swing = null;
  if (isDoor && !sliding) {
    const sw = o.swing || {};
    const sgn = sw.side === 'right' ? -1 : 1;
    const t = wallThickness(e, project, derived) || 100;
    swing = {
      normal: { x: dir.y * sgn, y: -dir.x * sgn }, hinge: sw.hinge === 'end' ? width / 2 : -width / 2,
      radius: width, offset: t / 4,
    };
  }
  return {
    point: { x: A.x + dir.x * s, y: A.y + dir.y * s }, dir, edgeId, width,
    isDoor, sliding, swing, roomId: o.labelRoom || o.room || null,
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

// Length of segment a–b inside box (Liang–Barsky clipping). → mm
export function segmentLengthInBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges = [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return 0; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return 0; if (r > t0) t0 = r; } else { if (r < t0) return 0; if (r < t1) t1 = r; }
  }
  return t0 < t1 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

// Thin drawn lines a window / door label keeps off when a clear attached spot exists (review 2026-10-25:
// the dashed 구역 나누기 선 ran between '2' and '000' of '목문 800*2000', dimension extension lines crossed
// 'PVC이중창 600*650'): counted as this wide (paper mm), at weight 1 (walls and numbers count 4), so the
// least-overlap fallback still works.
const THIN_LINE_PAPER_MM = 0.3;

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
// Weighted overlaps (world mm²) within this are the same: a label right at a wall face, a value or another
// label touches it by construction (0 or a sliver), and spots placed symmetrically about an opening cover
// the same wall area; the solve's rounding (some 1e-4 mm; a household solved again when it is opened, here
// or on another device, rounds differently) decided between them, and a door label jumped by a quarter of
// its door's width between the device it was drawn on and every device that opened its file (round-trip
// check 2026-10-24). The earlier spot in the order of preference wins a tie. 1 mm² is a 1000 mm label
// edge 0.001 mm deep.
const LABEL_COST_EPS = 1;
// The same for lengths (world mm) where a label spot is judged against another opening (placeOpening
// misleads): a spot shifted by half its opening's width lies exactly at the end of the neighbouring window
// of the same width, and the rounding of the solve decided whether it was "over" that window (review
// 2026-10-25: 'AL미닫이창 1200' 287 mm away on the device that drew it and on every device that opened the
// file). Within this much it is not over the other opening, nor nearer to it.
const LABEL_TIE_MM = 0.01;
// Crowded window / door labels (placeOpening crowdedSpot): the step (paper mm) of the slide along the wall,
// and the smallest size (of the 8.8 pt), as for room names.
const CROWDED_STEP_MM = 0.25;
const MIN_OPENING_SCALE = 0.7;
// Paper: how many times the window / door labels are placed again with those that fell back first
// (placeLabels placeOpenings).
const OPENING_REPLACE_PASSES = 3;

// An obstacle with `points` (a door's swing, doorSwingShapes) counts by its real outline, not its box.
function obstacleCost(box, obstacles, pad = 0) {
  let s = 0;
  for (const ob of obstacles) {
    let a = overlapArea(box, ob, pad);
    if (a > 0 && Array.isArray(ob.points)) {
      a = polygonBoxArea(ob.points, { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad });
    }
    if (a > 0) s += ob.column ? 100 * a : a;
  }
  return s;
}

// The spot nearest to `start` where a w × h box (world mm, already turned) lies inside the polygon
// (kept `margin` mm from its outline) and clear of the obstacle boxes (grown by `pad`). Grid rings of
// `step` mm around the start, up to maxRing rings. When nothing is clear, the inside spot with the least
// weighted overlap (columns count most), else the start. → { x, y, cost }
// opts.centre (paper room names, placeLabels fitSlantedName): each grid point is also tried moved to the
// middle of the polygon's free width and of its free height through it. In a strip the box only just
// fits across, the grid stepped over the one line where it fits (recheck 2026-10-25: 예시 세대 A turned, the
// '베란다1' name left its 950 mm strip for the corner where its small window's label belongs).
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
    if (!best || cost < best.cost - LABEL_COST_EPS || (Math.abs(cost - best.cost) <= LABEL_COST_EPS && d < best.d)) best = { x: c.x, y: c.y, cost, d };
    return cost <= LABEL_COST_EPS;
  };
  const centred = (c) => {
    if (!opts.centre || !poly) return [c];
    const out = [c];
    const ex = scanExtent(poly, c, 'x'), ey = scanExtent(poly, c, 'y');
    if (ex) out.push({ x: (ex[0] + ex[1]) / 2, y: c.y });
    if (ey) out.push({ x: c.x, y: (ey[0] + ey[1]) / 2 });
    return out;
  };
  // Ring 0 is the start itself. Without opts.centre the first ring with a clear point gives the spot;
  // with it, a moved point can lie anywhere along its line, so the nearest clear point so far is taken
  // once no later ring can hold a nearer one (ring r + 1 lies at least (r + 1) × step away).
  let near = null;
  for (let r = 0; r <= maxRing; r++) {
    let found = null, foundD = Infinity;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        for (const c of centred({ x: start.x + i * step, y: start.y + j * step })) {
          if (consider(c)) {
            const d = Math.hypot(c.x - start.x, c.y - start.y);
            if (d < foundD - LABEL_TIE_MM) { found = c; foundD = d; }
          }
        }
      }
    }
    if (!opts.centre) {
      if (found) return { x: found.x, y: found.y, cost: 0 };
      continue;
    }
    if (found && (!near || foundD < near.d - LABEL_TIE_MM)) near = { x: found.x, y: found.y, d: foundD };
    if (near && near.d <= (r + 1) * step + LABEL_TIE_MM) return { x: near.x, y: near.y, cost: 0 };
  }
  if (near) return { x: near.x, y: near.y, cost: 0 };
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

// ---- window / door labels: attached to their opening ------------------------------------------------
//
// ATTACHED (user 2026-10-24) — a window / door label box B (world AABB) is attached to its opening when
//   - B lies on one side n of the wall (the side of its centre), and its near edge (the corner of B
//     nearest the wall, measured along n from the wall's centre line) is at least the CLEARANCE of
//     that side and at most `tol` beyond it; and
//   - B's extent along the wall overlaps the opening's [−W/2, W/2] (from its centre), or ends within
//     `tol` of one of its ends (a label beside the opening, past its end).
// CLEARANCE of side n over B's extent along the wall [a0, a1]: half the wall's thickness plus the finish
// layer drawn on that side; on the side a hinged door opens into, at least the reach of its swing over
// [a0, a1] (the quarter disc of radius W around the hinge, which sits `offset` off the centre line:
// offset + √(W² − d²), d = the distance along the wall from the hinge to the nearest point of [a0, a1]
// over the disc; the open leaf is its edge at d = 0). A label over the hinge therefore keeps W + offset
// from the centre line, one beside the free jamb less.
// tol = ATTACH_TOL_MM paper mm (world: × the print scale; the screen uses 1:60). The automatic spots are
// LABEL_GAP_MM beyond the clearance. Labels moved by hand are not automatic and are not judged.
// STACKED — only where the per-side values are written inside the rooms at the walls (the editor, 치수선
// 없이: opts.extraDepth): when no attached spot is free, a label may sit over the opening right beyond
// that wall's value (face + depth + LABEL_GAP_MM, the first depth with a value really between: ui/render.js
// valueBehind), never past its ends, never outside. Before it, a value that alone takes an attached spot
// moves along its wall (render.js displaceValue). When nothing is free, the least-overlapping ATTACHED
// spot is taken, not a stacked one.
export const ATTACH_TOL_MM = 2;
export const LABEL_GAP_MM = 1.2;

// Unit vector, or null.
function unitOf(v) {
  const L = v ? Math.hypot(v.x, v.y) : 0;
  return L > 1e-9 ? { x: v.x / L, y: v.y / L } : null;
}

// The swing of a hinged door from its anchor: { normal (null = side unknown: both), hinge (null =
// unknown: the whole opening), radius, offset, lo, hi (its extent along the wall from the centre) }.
function swingOfAnchor(anchor, t) {
  if (!anchor || !anchor.isDoor || anchor.sliding) return null;
  const W = anchor.width || 0;
  const s = anchor.swing;
  const radius = s && s.radius > 0 ? s.radius : W;
  const offset = s && isFinite(s.offset) ? s.offset : t / 4;
  const hinge = s && isFinite(s.hinge) ? s.hinge : null;
  const normal = s ? unitOf(s.normal) : null;
  let lo = -W / 2, hi = W / 2;
  if (hinge != null) {
    const towards = hinge <= 0 ? 1 : -1;     // from the hinge toward the other jamb
    lo = Math.min(hinge, hinge + towards * radius);
    hi = Math.max(hinge, hinge + towards * radius);
  }
  return { normal, hinge, radius, offset, lo, hi };
}

// Geometry of an opening for its label: { anchor, edge, t, W, face(n), clearance(n, a0, a1), swing }
// (see the rule above; n a unit normal of the wall, a0..a1 mm along anchor.dir from the centre).
export function openingLabelGeometry(o, project, derived) {
  if (!o || !project) return null;
  const anchor = safeCall(labelHooks.openingAnchor, o, project, derived) || defaultOpeningAnchor(o, project, derived);
  if (!anchor || !anchor.point || !anchor.dir) return null;
  const edge = (project.edges || []).find((e) => e.id === anchor.edgeId) || null;
  const t = edge ? wallThickness(edge, project, derived) : 150;
  const W = anchor.width || 0;
  // A finish layer (drawn as wall) on either side: finishBeside keys them by the edge's own left
  // (dir.y, −dir.x) walking a → b.
  let fin = { left: 0, right: 0 }, eLeft = null;
  if (edge) {
    try { fin = finishBeside(project, derived, edge.id) || fin; } catch (_) { /* none */ }
    const A = (project.nodes || []).find((n) => n.id === edge.a), B = (project.nodes || []).find((n) => n.id === edge.b);
    if (A && B) eLeft = { x: B.y - A.y, y: -(B.x - A.x) };
  }
  const face = (n) => {
    if (!eLeft) return t / 2;
    const f = n.x * eLeft.x + n.y * eLeft.y > 0 ? fin.left : fin.right;
    return t / 2 + (f > 0 ? f : 0);
  };
  const swing = swingOfAnchor(anchor, t);
  const clearance = (n, a0, a1) => {
    let c = face(n);
    if (swing && (!swing.normal || n.x * swing.normal.x + n.y * swing.normal.y > 0.5)) {
      const lo = Math.max(a0, swing.lo), hi = Math.min(a1, swing.hi);
      if (lo <= hi) {
        const d = swing.hinge == null ? 0 : Math.abs(Math.min(hi, Math.max(lo, swing.hinge)) - swing.hinge);
        if (d <= swing.radius) c = Math.max(c, swing.offset + Math.sqrt(swing.radius * swing.radius - d * d));
      }
    }
    return c;
  };
  return { anchor, edge, t, W, face, clearance, swing };
}

// How a label box (world AABB) sits against its opening (see ATTACHED above). opts: { worldPerPaperMM
// (default 60), tol (world mm; default ATTACH_TOL_MM paper mm) }. → { attached, gap (mm of the near edge
// beyond the clearance; < 0: on the wall or the swing), alongGap (mm past the opening's nearer end; 0 =
// over it), normal, clearance, swingSide (true: the side the door opens into) } | null
export function openingLabelFit(project, derived, o, box, opts = {}) {
  return labelFitOf(openingLabelGeometry(o, project, derived), box, opts);
}

// openingLabelFit for an opening's geometry already at hand (openingLabelGeometry). → fit | null
function labelFitOf(g, box, opts = {}) {
  if (!g || !box) return null;
  const wppm = opts.worldPerPaperMM > 0 ? opts.worldPerPaperMM : 60;
  const tol = opts.tol > 0 ? opts.tol : ATTACH_TOL_MM * wppm;
  const P = g.anchor.point, dir = g.anchor.dir;
  const nL = { x: -dir.y, y: dir.x };
  const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
  const along = corners.map(([x, y]) => (x - P.x) * dir.x + (y - P.y) * dir.y);
  const across = corners.map(([x, y]) => (x - P.x) * nL.x + (y - P.y) * nL.y);
  const a0 = Math.min(...along), a1 = Math.max(...along);
  const c0 = Math.min(...across), c1 = Math.max(...across);
  const sgn = c0 + c1 >= 0 ? 1 : -1;
  const normal = { x: nL.x * sgn, y: nL.y * sgn };
  const near = sgn > 0 ? c0 : -c1;
  const clearance = g.clearance(normal, a0, a1);
  const gap = near - clearance;
  const alongGap = Math.max(0, a0 - g.W / 2, -g.W / 2 - a1);
  const swingSide = !!(g.swing && (!g.swing.normal || normal.x * g.swing.normal.x + normal.y * g.swing.normal.y > 0.5));
  const attached = gap >= -1 && gap <= tol && alongGap <= tol;
  // STACKED (screen and 치수선 없이, opts.valueBand = the per-side value band in world mm): over the
  // opening, clear of the wall and the swing, its near edge within `tol` beyond face + valueBand —
  // the wall's own measured value written between it and the wall.
  const band = opts.valueBand > 0 ? opts.valueBand : 0;
  const stacked = !attached && band > 0 && gap >= -1 && alongGap <= 1 && near - (g.face(normal) + band) <= tol;
  return { attached, stacked, gap, alongGap, normal, clearance, swingSide, near, face: g.face(normal) };
}

// The swing of every hinged door (a quarter disc around its hinge, as draw-openings.js draws it), for
// the other window / door labels to keep clear of. → [{ id, points: [{x, y}], minX, minY, maxX, maxY }]
export function doorSwingShapes(project, derived) {
  const out = [];
  for (const o of (project && project.openings) || []) {
    if (!o || o.kind !== 'door') continue;
    const g = openingLabelGeometry(o, project, derived);
    const sw = g && g.swing;
    if (!sw || !sw.normal || sw.hinge == null) continue;
    const { point: P, dir } = g.anchor;
    const at = (s, k) => ({ x: P.x + dir.x * s + sw.normal.x * k, y: P.y + dir.y * s + sw.normal.y * k });
    const towards = sw.hinge <= 0 ? 1 : -1;
    const points = [at(sw.hinge, sw.offset)];
    for (let i = 0; i <= 8; i++) {
      const a = (Math.PI / 2) * (i / 8);
      points.push(at(sw.hinge + Math.cos(a) * sw.radius * towards, sw.offset + Math.sin(a) * sw.radius));
    }
    out.push({ id: o.id, points, ...boxOf(points) });
  }
  return out;
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
//         fixtureInner: { gap, line } world mm of the plain boxes' inner outline (null: none; the
//         label keeps inside that line where it is drawn, see fixtureInnerLineShown),
//         thinLines: world segments [[p, q]] (or [{ a, b }]) of thin drawn lines the opening labels
//         keep off where they can, e.g. the dimension extension lines (the 구역 나누기 선 always count),
//         withCandidates, extraDepth: screen only (see the header) }
// Paper mm a room's name block keeps from the room's inner faces when it has to be fitted (rooms with a
// diagonal side always; other rooms when the block does not fit where it stands).
const ROOM_NAME_WALL_CLEAR_MM = 0.8;

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
  // Thin lines (THIN_LINE_PAPER_MM): every 구역 나누기 선, and opts.thinLines (world segments [[p, q]] or
  // [{ a, b }]: the dimension extension lines on paper, ui/output.js).
  const nodeAt = new Map((project.nodes || []).map((nd) => [nd.id, nd]));
  const asSeg = (s) => (Array.isArray(s) ? s : s && [s.a, s.b]);
  const thinLines = (project.edges || []).filter((e) => e.kind === 'divider').map((e) => [nodeAt.get(e.a), nodeAt.get(e.b)])
    .concat((Array.isArray(opts.thinLines) ? opts.thinLines : []).map(asSeg))
    .filter((s) => s && s[0] && s[1] && isFinite(s[0].x) && isFinite(s[0].y) && isFinite(s[1].x) && isFinite(s[1].y));
  const thinHalf = (THIN_LINE_PAPER_MM / 2) * wppm;
  const thinCost = (box) => {
    if (!thinLines.length) return 0;
    const g = { minX: box.minX - thinHalf, minY: box.minY - thinHalf, maxX: box.maxX + thinHalf, maxY: box.maxY + thinHalf };
    return thinLines.reduce((s, [a, b]) => s + segmentLengthInBox(a, b, g) * 2 * thinHalf, 0);
  };
  // The swings of the hinged doors: window / door labels keep off the other doors' arcs.
  const swings = include.openings ? doorSwingShapes(project, derived) : [];
  // Every opening's label geometry: a label must not sit where it reads as ANOTHER opening's (checker
  // 2026-10-24: past the end of a 다용도실 door its label lay over the 화장실 door next to it).
  const geos = include.openings
    ? (project.openings || []).map((o) => ({ id: o.id, g: openingLabelGeometry(o, project, derived) })).filter((x) => x.g)
    : [];
  const withCands = !!opts.withCandidates;
  const fixtureInner = opts.fixtureInner && opts.fixtureInner.gap > 0 ? opts.fixtureInner : null;
  // Extra distances from the wall for window / door spots (screen): a number or a list.
  const depths = [0].concat((Array.isArray(opts.extraDepth) ? opts.extraDepth : [opts.extraDepth]).filter((v) => v > 0));
  const placed = [];
  const roomFits = new Map();
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
  const cand = (x, y, rot, lines, b, attached, extra = null) => {
    const c = { x, y, rot, lines, w: b.w, h: b.h, box: aabb(x, y, b.w, b.h, rot) };
    if (attached !== undefined) c.attached = attached;
    if (extra) Object.assign(c, extra);
    return c;
  };

  if (include.rooms) for (const dr of derived.rooms) placeRoom(dr);
  if (include.openings) placeOpenings((project.openings || []).filter(Boolean));
  if (include.fixtures) for (const f of project.fixtures || []) placeFixture(f);
  return placed;

  // Window / door labels, each taking its first clear spot in the project's order. On paper, a label that
  // finds none and is written across another label (the least-overlap fallback) may have lost its spot
  // to an earlier one that had another (final check 2026-10-25: once a room name made room, an earlier
  // 'AL이중창 1175*1700' took the spot inside 다용도실 and '미서기문 1475*2100' was written across it,
  // where before the window had stood clear outside). Then the labels are placed again with those first
  // (the latest ones first), up to OPENING_REPLACE_PASSES times while some still fall back, and the
  // arrangement with the fewest labels written across another label (then the least overlap of
  // anything) is kept; the first one on a tie. The screen picks among the candidates itself (ui/render.js).
  function placeOpenings(list) {
    const n0 = placed.length;
    const names = () => placed.slice(0, n0).map((l) => ({ l, s: { x: l.x, y: l.y, lines: l.lines, w: l.w, h: l.h, box: l.box, cands: l.cands } }));
    const before = withCands ? null : names();
    let fell = [];
    for (const o of list) placeOpening(o, withCands ? null : fell);
    if (withCands || !fell.length) return;
    const keep = () => ({ labels: placed.slice(n0), names: names(), score: arrangementScore(n0) });
    let best = keep(), ahead = [];
    for (let pass = 0; pass < OPENING_REPLACE_PASSES && fell.length; pass++) {
      ahead = fell.concat(ahead.filter((id) => !fell.includes(id)));
      placed.length = n0;
      for (const { l, s } of before) Object.assign(l, s);
      const first = new Set(ahead);
      const order = ahead.map((id) => list.find((x) => x.id === id)).filter(Boolean).concat(list.filter((x) => !first.has(x.id)));
      fell = [];
      for (const o of order) placeOpening(o, fell);
      const now = keep();
      if (now.score.across < best.score.across || (now.score.across === best.score.across && now.score.cost < best.score.cost - LABEL_COST_EPS)) best = now;
      if (!best.score.across) break;
    }
    const at = new Map(list.map((o, i) => [o.id, i]));
    placed.length = n0;
    for (const { l, s } of best.names) Object.assign(l, s);
    placed.push(...best.labels.slice().sort((a, b) => at.get(a.refId) - at.get(b.refId)));
  }

  // The window / door labels placed after placed[n0]: how many are written across another label, and
  // what they overlap in all (weighted as placeOpening's least-overlap fallback). → { across, cost }
  function arrangementScore(n0) {
    let across = 0, cost = 0;
    for (const l of placed.slice(n0)) {
      if (l.kind !== 'opening') continue;
      const texts = placed.reduce((s, x) => s + (x === l ? 0 : overlapArea(l.box, x.box)), 0);
      if (texts > LABEL_COST_EPS) across++;
      cost += 2 * texts + openingClutter(l.box, l.refId);
    }
    return { across, cost };
  }

  // What a window / door label box overlaps besides the other labels: walls (4×), other doors' swings,
  // dimension numbers (4×), fixtures (4×, columns 50×), as placeOpening counts it.
  function openingClutter(box, ownId) {
    return wallBoxes.reduce((s, w) => s + 4 * overlapArea(box, w), 0)
      + diagWalls.reduce((s, w) => s + 4 * polygonBoxArea(w, box), 0)
      + swings.reduce((s, sw) => s + (sw.id !== ownId && hits(box, sw) ? polygonBoxArea(sw.points, box) : 0), 0)
      + obstacles.reduce((s, ob) => s + 4 * overlapArea(box, ob), 0)
      + fixtureBoxes.reduce((s, ob) => s + (ob.column ? 50 : 4) * overlapArea(box, ob), 0);
  }

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
    // What makeRoomFor needs to place this name again (the lines before any fitting).
    roomFits.set(key, { dr, room, notRoom, rot, baseSize, color, lines0: lines.slice(), p });
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
    // A rectangular room the block does not fit in where it stands (a narrow 베란다 / 다용도실 strip, or the
    // end of a long room where its label point lies): placed as a room with a diagonal side, inside its
    // inner faces off the walls, smaller or wrapped when needed (review 2026-10-25: on paper the 'ㅂ' of
    // '베란다1' stood on its wall at 1:75, a 1 m strip's 'H: 2300' on the wall below at 1:100).
    if (!slanted && !offsets[key]) {
      const poly = roomInnerPolygon(dr, project, derived);
      const box1 = aabb(at.x, at.y, b.w, b.h, rot);
      const bw = box1.maxX - box1.minX, bh = box1.maxY - box1.minY;
      if (poly && !boxInPolygon(poly, at, bw, bh, ROOM_NAME_WALL_CLEAR_MM * wppm)) {
        // Then a narrow strip (a 900 베란다 at 1:100): closer to the faces, then H at the name's size too.
        const fit = fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines, at)
          || fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines, at, { margin: 0.2 })
          || fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines, at, { margin: 0.2, tight: true });
        if (fit) { at = fit.at; lines.splice(0, lines.length, ...fit.lines); b = block(lines); }
      }
    }
    // 실 아님 spaces have a plain gray fill (draw-fixtures.js drawNotRoomSpaces; no diagonal any more):
    // the name stays in the middle and needs no halo.
    finish({ key, kind: 'room', refId: dr.roomId, x: at.x, y: at.y, base: p, rot, lines, lineHeight: LINE_HEIGHT, w: b.w, h: b.h, halo: false });
  }

  // Name block (+ H) of a room with a diagonal side: the first size / wrap whose block fits inside the
  // room clear of the walls, fixtures and nameObstacles, nearest the label point. → { at, lines, cost } |
  // null. opt (rooms without a diagonal side, as a fallback): margin (paper mm from the faces), tight (H as
  // small as the name, down to 60 %), smallest (55 % / 50 %, H at 60 %: makeRoomFor only); extra: more
  // boxes to keep clear of (a window / door label the name makes room for, see placeOpening); clearOnly:
  // null unless a size fits clear of everything.
  // The search also tries each spot moved to the middle of the room's free width / height (findFreeSpot
  // opts.centre): in a strip the block only just fits across, the grid stepped over the one line where it
  // fits (recheck 2026-10-25: 예시 세대 A turned, the '베란다1' name went 2.8 m from its label point at the top
  // of its 950 mm strip to the corner where its small window's label belongs).
  function fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p, opt = {}) {
    // The room inside its walls (each side's own wall and finish), about 1 paper mm in from them.
    const poly = roomInnerPolygon(dr, project, derived);
    if (!poly) return null;
    const margin = (opt.margin != null ? opt.margin : ROOM_NAME_WALL_CLEAR_MM) * wppm;
    const obst = fixtureBoxes.concat(nameObstacles, Array.isArray(opt.extra) ? opt.extra : []);
    const hLine = lines0.find((l) => l.color === LABEL_COLORS.height && /^H: /.test(l.text)) || null;
    const nameSets = [[room.name]];
    const wrapped = wrapName(room.name);
    if (wrapped.length > 1) nameSets.push(wrapped);
    const variants = [];
    for (const names of nameSets) {
      for (const k of opt.smallest ? [0.55, 0.5] : opt.tight ? [MIN_NAME_SCALE, 0.6] : [1, 0.85, MIN_NAME_SCALE]) {
        const ls = names.map((text) => ({ text, size: baseSize * k, color, weight: 'normal' }));
        if (hLine) ls.push({ ...hLine, size: fonts.height * (opt.smallest ? 0.6 : opt.tight ? k : Math.max(0.8, k)) });
        variants.push(ls);
      }
    }
    let best = null;
    for (const ls of variants) {
      const bb = block(ls);
      const box0 = aabb(p.x, p.y, bb.w, bb.h, rot);
      const bw = box0.maxX - box0.minX, bh = box0.maxY - box0.minY;
      const spot = findFreeSpot(poly, bw, bh, p, obst, { margin, step: Math.max(bh / 3, 0.5 * wppm), centre: true });
      if (!boxInPolygon(poly, spot, bw, bh, margin)) continue;
      if (spot.cost <= LABEL_COST_EPS) return { at: { x: spot.x, y: spot.y }, lines: ls, cost: 0 };
      if (!best || spot.cost < best.cost - LABEL_COST_EPS) best = { at: { x: spot.x, y: spot.y }, lines: ls, cost: spot.cost };
    }
    return opt.clearOnly ? null : best;
  }

  // A room name makes room for a window / door label (placeOpening, crowded spots): the block placed
  // again as a name that does not fit where it stands (fitSlantedName: off the walls, then closer to
  // them, then smaller; last at 55 % / 50 % with H at 60 %, which only a name making room gets), clear
  // of `extra` too, and clear of every door's swing (final check 2026-10-25: names that stood clear were
  // moved into a door's arc, often at 70 %, to make room — the arc then ran through the name). When the
  // only free place is on a swing the name stays where it was, and the window / door label takes its
  // other spots. Names moved by hand never move. → true when moved
  function makeRoomFor(label, extra) {
    const info = roomFits.get(label.key);
    if (!info || label.moved) return false;
    const { dr, room, notRoom, rot, baseSize, color, lines0, p } = info;
    extra = (extra || []).concat(swings);
    const fit = fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p, { extra, clearOnly: true })
      || fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p, { extra, clearOnly: true, margin: 0.2 })
      || fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p, { extra, clearOnly: true, margin: 0.2, tight: true })
      || fitSlantedName(dr, room, notRoom, rot, baseSize, color, lines0, p, { extra, clearOnly: true, margin: 0.2, smallest: true });
    if (!fit) return false;
    const b = block(fit.lines);
    Object.assign(label, { x: fit.at.x, y: fit.at.y, lines: fit.lines, w: b.w, h: b.h, box: aabb(fit.at.x, fit.at.y, b.w, b.h, label.rot) });
    if (label.cands) label.cands = [{ x: label.x, y: label.y, rot: label.rot, lines: label.lines, w: label.w, h: label.h, box: label.box }];
    return true;
  }

  function placeOpening(o, fell = null) {
    const text = String(safeCall(labelHooks.labelOf, o) || '').trim();
    if (!text) return;
    const geo = openingLabelGeometry(o, project, derived);
    if (!geo) return;
    const { anchor } = geo;
    const horizontal = Math.abs(anchor.dir.x) >= Math.abs(anchor.dir.y);
    const midX = bounds ? (bounds.minX + bounds.maxX) / 2 : anchor.point.x;
    const rot = horizontal ? 0 : (anchor.point.x < midX ? -90 : 90);
    const key = `opening:${o.id}`;
    const gap = LABEL_GAP_MM * wppm;           // about 1.2 paper mm beyond the wall face / the swing
    const mkLines = (parts, scale) => parts.map((s) => ({ text: s, size: fonts.opening * scale, color: LABEL_COLORS.opening, weight: 'normal' }));
    const normals = normalOrder(anchor, derived);
    // The spot of a label block (rot, b) on side n, shifted s mm along the wall: its near edge `gap`
    // beyond the clearance of that side over the label's extent along the wall (the wall face, or the
    // door's swing on the side it opens into). depth > 0 (screen and 치수선 없이: STACKED beyond the
    // per-side value written at the wall face): `gap` beyond face + depth, or beyond the swing where
    // that reaches further; null when the swing alone already clears the values (the plain spot
    // beyond the swing is that spot). The box is upright or turned; next to a diagonal wall its whole
    // extent across the wall counts.
    const spotAt = (n, s, rotC, b, depth) => {
      const bw0 = rotC ? b.h : b.w, bh0 = rotC ? b.w : b.h;
      const acrossHalf = (Math.abs(n.x) * bw0 + Math.abs(n.y) * bh0) / 2;
      const alongHalf = (Math.abs(anchor.dir.x) * bw0 + Math.abs(anchor.dir.y) * bh0) / 2;
      let c = geo.clearance(n, s - alongHalf, s + alongHalf);
      if (depth > 0) {
        const stacked = geo.face(n) + depth;
        if (stacked <= c + 1) return null;
        c = stacked;
      }
      const d = c + gap + acrossHalf;
      return { x: anchor.point.x + n.x * d + anchor.dir.x * s, y: anchor.point.y + n.y * d + anchor.dir.y * s, near: c + gap };
    };
    // Candidates of one size: { x, y, poly, rot, lines, b, attached, stack? }. reach 'near': the
    // label's centre stays over its opening (centred, then shifted by a quarter / half of the
    // opening's width); 'far': the label beside the opening, past its end (only when nothing over the
    // opening is clear). depth > 0 (stacked beyond the per-side values): 'near' only, inside a room
    // only (no values are written outside), attached: false, with stack: { n, face, near } (the side,
    // its wall face and the label's near edge, mm from the wall's centre line) so that ui/render.js
    // can take it only where a value of that wall really lies between.
    const tryAt = (scale, reach = 'near', depth = 0) => {
      const cands = [];
      if (depth > 0 && reach !== 'near') return cands;
      const lines = mkLines(horizontal ? [text] : splitOpeningLabel(text), scale);
      const b = block(lines);
      const W = anchor.width || 0;
      // 'far': the box's extent along the wall starts `gap` past the opening's end (its upright box
      // next to a diagonal wall: that box's extent along the wall, so it still touches the end).
      const bw0 = rot ? b.h : b.w, bh0 = rot ? b.w : b.h;
      const alongHalf = (Math.abs(anchor.dir.x) * bw0 + Math.abs(anchor.dir.y) * bh0) / 2;
      const shifts = reach === 'near'
        ? [0, W / 4, -W / 4, W / 2, -W / 2].filter((s, i) => i === 0 || Math.abs(s) >= 1)
        : [alongHalf + W / 2 + gap, -(alongHalf + W / 2 + gap)];
      const push = (at, n, rotC, ls, bb) => {
        if (!at) return;
        const c = { x: at.x, y: at.y, poly: n.poly, rot: rotC, lines: ls, b: bb, attached: depth === 0 };
        if (depth > 0) c.stack = { n: { x: n.x, y: n.y }, face: geo.face(n), near: at.near };
        cands.push(c);
      };
      for (const n of normals) {
        if (depth > 0 && !n.poly) continue;
        for (const s of shifts) push(spotAt(n, s, rot, b, depth), n, rot, lines, b);
        // A vertical wall shorter than the turned label (예시 세대 A A34 on the 430 mm step): one horizontal
        // line beside the wall instead.
        if (!horizontal && reach === 'near') {
          const l1 = mkLines([text], scale);
          const b1 = block(l1);
          push(spotAt(n, 0, 0, b1, depth), n, 0, l1, b1);
        }
      }
      return cands;
    };
    // A diagonal wall (a cut corner, a bay side) is short and meets the next wall at an angle: past its
    // ends an upright label sits in that corner and reads as the next wall's, so right outside it at
    // its face comes first there. Outside also at 85 % (checker 2026-10-24: a small 화장실 window
    // between its wall and the dimension chain, as the 예시 세대 A drawing writes 'PVC이중창 600*650').
    const slanted = Math.abs(anchor.dir.x) > 1e-3 && Math.abs(anchor.dir.y) > 1e-3;
    const tiers = slanted
      ? [[1, true, 'near'], [0.85, true, 'near'], [1, false, 'near'], [0.85, false, 'near'], [1, true, 'far'], [0.85, true, 'far'], [1, false, 'far'], [0.85, false, 'far']]
      : [[1, true, 'near'], [0.85, true, 'near'], [1, true, 'far'], [0.85, true, 'far'], [1, false, 'near'], [0.85, false, 'near'], [1, false, 'far'], [0.85, false, 'far']];
    // A spot that reads as ANOTHER opening's label: that opening in a wall parallel to this one's
    // (the same wall line, or across a narrow room), the label's centre over it (along its wall), the
    // box right at that wall's face (attached to it), and nearer to it than to its own. Taken only
    // when there is no other spot at all. (Openings in a perpendicular wall do not count: the 예시 세대 A
    // A34 label is written on one line beside its 430 step, over the end of the A35 window.)
    const tolW = ATTACH_TOL_MM * wppm;
    const segDist = (c, a) => {
      const W = a.width || 0;
      const u = Math.max(-W / 2, Math.min(W / 2, (c.x - a.point.x) * a.dir.x + (c.y - a.point.y) * a.dir.y));
      return Math.hypot(c.x - (a.point.x + a.dir.x * u), c.y - (a.point.y + a.dir.y * u));
    };
    // Only the openings in parallel walls near enough for a spot of this label to lie over them (the
    // label at full size, its reach past the opening's end, the walls and the tolerance).
    const reach0 = (anchor.width || 0) / 2 + Math.max(block(mkLines([text], 1)).w, block(mkLines(splitOpeningLabel(text), 1)).h) + 2 * gap + tolW;
    const rivals = geos.filter(({ id, g }) => id !== o.id
      && Math.abs(g.anchor.dir.x * anchor.dir.y - g.anchor.dir.y * anchor.dir.x) <= 0.2
      && Math.hypot(g.anchor.point.x - anchor.point.x, g.anchor.point.y - anchor.point.y) < reach0 + (g.anchor.width || 0) / 2 + geo.t + g.t + 2 * reach0);
    // The crowded spots (crowdedSpot) can be written across their wall: there a spot also must not read as
    // the label of an opening in a wall along which the label reads (its longer side), its centre over
    // that opening or right at its end, right at it by the attached rule itself (openingLabelFit, also
    // beyond a door's swing), and nearer to it than to its own.
    const crossRivals = geos.filter(({ id, g }) => id !== o.id && !rivals.some((r) => r.id === id)
      && Math.hypot(g.anchor.point.x - anchor.point.x, g.anchor.point.y - anchor.point.y) < reach0 + (g.anchor.width || 0) / 2 + geo.t + g.t + 2 * reach0);
    const misleadsAcross = (box) => {
      const readsH = box.maxX - box.minX > box.maxY - box.minY;
      const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      let own = null;
      for (const { g } of rivals.concat(crossRivals)) {
        const a2 = g.anchor;
        if ((Math.abs(a2.dir.x) > Math.abs(a2.dir.y)) !== readsH) continue;
        // Centred right at its end counts as over it too (between two windows it reads as either's).
        const u = (c.x - a2.point.x) * a2.dir.x + (c.y - a2.point.y) * a2.dir.y;
        if (!(Math.abs(u) <= (a2.width || 0) / 2 + LABEL_TIE_MM)) continue;
        const fit = labelFitOf(g, box, { worldPerPaperMM: wppm });
        if (!fit || !fit.attached) continue;
        if (own == null) own = segDist(c, anchor);
        if (segDist(c, a2) < own - LABEL_TIE_MM) return true;
      }
      return false;
    };
    const misleads = (box) => {
      if (!rivals.length) return false;
      const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      let own = null;
      for (const { g } of rivals) {
        const a2 = g.anchor, W2 = a2.width || 0;
        const u = (c.x - a2.point.x) * a2.dir.x + (c.y - a2.point.y) * a2.dir.y;
        if (!(Math.abs(u) < W2 / 2 - LABEL_TIE_MM)) continue;
        const nL = { x: -a2.dir.y, y: a2.dir.x };
        const v = (c.x - a2.point.x) * nL.x + (c.y - a2.point.y) * nL.y;
        const half = (Math.abs(nL.x) * (box.maxX - box.minX) + Math.abs(nL.y) * (box.maxY - box.minY)) / 2;
        if (Math.abs(v) - half > g.face(v >= 0 ? nL : { x: -nL.x, y: -nL.y }) + tolW - LABEL_TIE_MM) continue;
        if (own == null) own = segDist(c, anchor);
        if (segDist(c, a2) < own - LABEL_TIE_MM) return true;
      }
      return false;
    };
    // Screen: every usable spot in order of preference: every attached spot (each tier right at the
    // wall or the swing), then the spots over the opening beyond the per-side values, then (flagged
    // misleading) the spots that read as another opening's.
    let cands = null;
    if (withCands) {
      cands = [];
      const late = [];
      for (const depth of depths) {
        for (const [scale, inside, reach] of tiers) {
          for (const c of tryAt(scale, reach, depth)) {
            if (!!c.poly !== inside) continue;
            if (c.poly && !pointInPolygon(c, c.poly)) continue;
            const k = cand(c.x, c.y, c.rot, c.lines, c.b, c.attached, c.stack ? { stack: c.stack } : null);
            if (misleads(k.box)) { k.misleading = true; late.push(k); } else cands.push(k);
          }
        }
      }
      cands.push(...late);
    }
    // The other doors' swings, for the screen (ui/render.js keeps the label off them where it can).
    const avoid = swings.filter((sw) => sw.id !== o.id);
    const place = (c) => finish({
      key, kind: 'opening', refId: o.id, x: c.x, y: c.y, base: { x: anchor.point.x, y: anchor.point.y },
      dir: { x: anchor.dir.x, y: anchor.dir.y },
      span: anchor.width || 0, rot: c.rot, lines: c.lines, lineHeight: LINE_HEIGHT, w: c.b.w, h: c.b.h, cands,
      attached: c.attached !== false, avoid: avoid.map((sw) => ({ minX: sw.minX, minY: sw.minY, maxX: sw.maxX, maxY: sw.maxY, poly: sw.points })),
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
    // (dimension numbers count most: they must stay legible). A wall counts like a dimension number
    // (blue text on a black wall cannot be read; checker 2026-10-24: it counted 1× and a label crossed
    // a wall rather than touch a dimension line). Fixture boxes count like the dimension numbers; a
    // column (solid black) far more; another door's swing like a wall did. Every candidate is
    // attached (see openingLabelFit), so this fallback is too. A spot that reads as another opening's
    // label (misleads) is never taken while there is any other.
    // A spot over the opening that only grazes another label's 0.5 mm clearance (keeping 0.15 mm) is
    // still preferred to a spot past the opening's end, where the label reads as the neighbour's.
    // Thin lines (a 구역 나누기 선, dimension extension lines: thinCost) only move a label along its wall:
    // the first spot clear of everything else is kept unless a spot of the same size, side and turn
    // further along the wall (the next shifts) is clear of them too (review 2026-10-25), so a label
    // never turns, shrinks or changes side for a dashed line (예시 세대 A A40 reads top → bottom as drawn).
    // Among spots that overlap something, they decide a tie.
    let best = null, nearOk = null, misled = null, pending = null;
    // A spot clear of everything but thin lines that no shift along the wall could avoid: on paper the
    // lines stop at the label, as drafting does (ui/draw-labels.js knockout; recheck 2026-10-25: extension
    // lines and the dashed 구역 나누기 선 ran through 'PVC이중창 600*650', '목문 800*2000', 'AL단창 2520*1050').
    const placeClear = (c) => {
      const l = place(c);
      if (l && !l.moved && thinCost(l.box) > LABEL_COST_EPS) l.knockout = true;
    };
    // CROWDED spots (recheck 2026-10-25: 예시 세대 A turned, the label 'AL단창 1000*1050' of the small window in
    // the 550 mm jog of 베란다1 lay on the frames of the two long windows beside it; every spot above hit
    // a wall, a window frame or the 베란다1 name). When no spot above is clear, the label slides along
    // its wall to the nearest spot clear of everything — walls and so the other openings' frames, door
    // swings, labels, numbers, fixtures — keeping LABEL_GAP_MM from them along the wall as well (the end
    // of a frame never touches a letter); it stays attached: first with its centre over the opening, then
    // further, up to just past the opening's end. Forms: as it is at 100 % and 85 %, then written the
    // other way (a horizontal wall: 'AL단창' / '1000*1050' on two lines; a vertical wall: one line
    // across) at 100 % and 85 %; the same at 70 % only after those. At 100 / 85 %, then at 70 %:
    //   a. inside the rooms (both sides of an inner wall, the larger room first);
    //   b. outside an exterior wall (between the wall and the chain, as the 예시 세대 A drawing writes a small
    //      화장실 window's label);
    //   c. inside where only room names are in the way, if each of those names finds another place in its
    //      room (makeRoomFor) clear of every window / door label placed so far and out of the band where
    //      this label could stand: a name may go anywhere in its room, smaller or wrapped; a window / door
    //      label has to stay at its opening, and a name making room comes before a smaller label
    //      (예시 세대 A turned at 1:60: 'AL단창 / 1000*1050' at full size below its window, not at 70 % outside).
    // Thin lines only choose among the shifts of one form (a label is never turned or shrunk for them);
    // a spot over one gets the knockout. Nothing clear: the least-overlap spot below, as before.
    // → candidate | null
    const crowdedSpot = () => {
      const W = anchor.width || 0;
      const parts1 = horizontal ? [text] : splitOpeningLabel(text);
      const parts2 = horizontal ? splitOpeningLabel(text) : [text];
      const other = !horizontal || parts2.length > 1;
      const formsAt = (scales) => scales.map((k) => [parts1, rot, k]).concat(other ? scales.map((k) => [parts2, 0, k]) : []);
      const big = formsAt([1, 0.85]), small = formsAt([MIN_OPENING_SCALE]);
      const gx = Math.abs(anchor.dir.x) * gap, gy = Math.abs(anchor.dir.y) * gap;
      const grown = (box) => ({ minX: box.minX - gx, minY: box.minY - gy, maxX: box.maxX + gx, maxY: box.maxY + gy });
      const pad = 0.5 * wppm;
      const step = CROWDED_STEP_MM * wppm;
      // The nearest clear shift of one form on side n, thin-line free first: near, the centre over the
      // opening (|shift| ≤ W/2); far, beyond that up to just past the opening's end. → candidate | null
      const slide = (n, [parts, rotC, scale], yieldingNames, far) => {
        const lines = mkLines(parts, scale);
        const b = block(lines);
        const bw0 = rotC ? b.h : b.w, bh0 = rotC ? b.w : b.h;
        const sEnd = (Math.abs(anchor.dir.x) * bw0 + Math.abs(anchor.dir.y) * bh0) / 2 + W / 2 + gap;
        const lo = far ? W / 2 : -1, hi = far ? sEnd : W / 2;
        let kept = null;
        for (let i = 0; i <= Math.ceil(hi / step); i++) {
          const d = Math.min(hi, i * step);
          if (!(d > lo)) continue;
          for (const sg of d > 0 ? [1, -1] : [1]) {
            const at = spotAt(n, sg * d, rotC, b, 0);
            if (!at || (n.poly && !pointInPolygon(at, n.poly))) continue;
            const box = aabb(at.x, at.y, b.w, b.h, rotC);
            if (misleads(box) || misleadsAcross(box) || costOf(grown(box), pad, yieldingNames) > LABEL_COST_EPS) continue;
            const c = { x: at.x, y: at.y, poly: n.poly, rot: rotC, lines, b, attached: true, box };
            if (thinCost(box) <= LABEL_COST_EPS) return c;
            if (!kept) kept = c;
          }
        }
        return kept;
      };
      // The first clear spot of these forms on these sides, near then far.
      const first = (forms, sides, yieldingNames, accept = () => true) => {
        for (const far of [false, true]) {
          for (const form of forms) {
            for (const n of sides) {
              const c = slide(n, form, yieldingNames, far);
              if (c && accept(c, n)) return c;
            }
          }
        }
        return null;
      };
      // The opening itself (along its wall, through the wall), for the names that make room.
      const P = anchor.point, nL = { x: -anchor.dir.y, y: anchor.dir.x };
      const opening = boxOf([-1, 1].flatMap((a) => [-1, 1].map((k) => ({
        x: P.x + (anchor.dir.x * a * W) / 2 + (nL.x * k * geo.t) / 2, y: P.y + (anchor.dir.y * a * W) / 2 + (nL.y * k * geo.t) / 2,
      }))));
      const padded = (box, d) => ({ minX: box.minX - d, minY: box.minY - d, maxX: box.maxX + d, maxY: box.maxY + d });
      // The room names in the way of spot c make room (all of them, or none moves). → bool
      const makeRoom = (c, n) => {
        const inWay = placed.filter((l) => yieldingName(l) && overlapArea(grown(c.box), l.box, pad) > 0);
        // The name keeps the label gap from the label it makes room for (they must not read as one
        // block), the usual 0.5 mm from the other window / door labels, and it does not move next to
        // that opening instead: it keeps out of the band where the label could stand (the opening
        // grown along its wall by the label's length, across it by the label's depth, and the gap).
        const bw = c.box.maxX - c.box.minX, bh = c.box.maxY - c.box.minY;
        const ax = Math.abs(n.x), ay = Math.abs(n.y);
        const across = ax * bw + ay * bh + gap, along = ax * bh + ay * bw + gap;
        const zone = {
          minX: opening.minX - ax * across - ay * along, maxX: opening.maxX + ax * across + ay * along,
          minY: opening.minY - ay * across - ax * along, maxY: opening.maxY + ay * across + ax * along,
        };
        const keep = [padded(c.box, gap), zone, ...placed.filter((l) => l.kind === 'opening').map((l) => padded(l.box, pad))];
        const was = inWay.map((l) => ({ l, s: { x: l.x, y: l.y, lines: l.lines, w: l.w, h: l.h, box: l.box, cands: l.cands } }));
        if (inWay.every((l) => makeRoomFor(l, keep))) return true;
        for (const { l, s } of was) Object.assign(l, s);
        return false;
      };
      const inside = normals.filter((n) => n.poly), outside = normals.filter((n) => !n.poly);
      return first(big, inside, false) || first(big, outside, false) || first(big, inside, true, makeRoom)
        || first(small, inside, false) || first(small, outside, false) || first(small, inside, true, makeRoom);
    };
    // yieldingNames: the room names that may make room (not counted; see crowdedSpot).
    const yieldingName = (l) => l.kind === 'room' && !l.moved && roomFits.has(l.key);
    const costOf = (box, pad, yieldingNames = false) => wallBoxes.reduce((s, w) => s + 4 * overlapArea(box, w), 0)
      + diagWalls.reduce((s, w) => s + 4 * polygonBoxArea(w, box), 0)
      + avoid.reduce((s, sw) => s + (hits(box, sw) ? polygonBoxArea(sw.points, box) : 0), 0)
      + placed.reduce((s, l) => s + (yieldingNames && yieldingName(l) ? 0 : 2 * overlapArea(box, l.box, pad)), 0)
      + obstacles.reduce((s, ob) => s + 4 * overlapArea(box, ob, pad), 0)
      + fixtureBoxes.reduce((s, ob) => s + (ob.column ? 50 : 4) * overlapArea(box, ob), 0);
    for (const [scale, inside, reach] of tiers) {
      if (pending) { placeClear(pending); return; }
      if ((reach === 'far' || !inside) && nearOk) { place(nearOk); return; }
      for (const c of tryAt(scale, reach)) {
        if (!!c.poly !== inside) continue;
        if (c.poly && !pointInPolygon(c, c.poly)) continue;
        if (pending && (c.poly !== pending.poly || c.rot !== pending.rot || c.lines.length !== pending.lines.length)) { placeClear(pending); return; }
        const box = aabb(c.x, c.y, c.b.w, c.b.h, c.rot);
        if (misleads(box)) { if (!misled) misled = c; continue; }
        const cost = costOf(box, 0.5 * wppm);
        if (cost <= LABEL_COST_EPS) {
          if (thinCost(box) <= LABEL_COST_EPS) { place(c); return; }
          if (!pending) pending = c;
          continue;
        }
        if (pending) continue;
        if (!nearOk && reach === 'near' && inside && costOf(box, 0.15 * wppm) <= LABEL_COST_EPS) nearOk = c;
        const thin = thinCost(box);
        if (!best || cost < best.cost - LABEL_COST_EPS || (cost <= best.cost + LABEL_COST_EPS && thin < best.thin - LABEL_COST_EPS)) best = { cost, thin, c };
      }
    }
    if (pending) { placeClear(pending); return; }
    if (nearOk) { place(nearOk); return; }
    // The print only (the screen picks among `cands` itself, ui/render.js).
    if (!withCands) {
      const crowd = crowdedSpot();
      if (crowd) { placeClear(crowd); return; }
    }
    // fell (paper, placeOpenings): the openings whose fallback is written across another label.
    const fellBack = (l) => {
      if (fell && l && placed.some((x) => x !== l && overlapArea(l.box, x.box) > LABEL_COST_EPS)) fell.push(o.id);
    };
    if (best) { fellBack(place(best.c)); return; }
    if (misled) { fellBack(place(misled)); return; }
    const all = tryAt(1);
    if (all.length) fellBack(place(all[0]));
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
    // Other fixtures (a column in a 옷장) are avoided like the symbols inside the box.
    const area = fixtureTextArea(f, project, derived, fixtureBoxes);
    if (!area) return;
    const { full } = area;
    let box = area.box;
    const tw = width(text, fonts.fixture);
    // A plain box with its inner line drawn: the text keeps inside that line (user 2026-10-25). The
    // drawing decides by the same rule (fixtureInnerLineDrawn), also for the part of the box another
    // fixture leaves free (checker 2026-10-25: a 수납장 with a 보일러 over its end had its label pushed
    // across the inner line).
    const em = fonts.fixture * wpu;
    const inner = !!fixtureInner && isPlainBox(f) && fixtureInnerLineDrawn(area, fixtureInner.gap, fixtureInner.line, tw, em);
    if (inner) {
      const inset = fixtureInnerTextInset(fixtureInner.gap, fixtureInner.line);
      box = { ...box, w: Math.max(0, box.w - 2 * inset), h: Math.max(0, box.h - 2 * inset) };
    }
    const { rot, k } = fixtureTextFit(tw, em, box.w, box.h, inner);
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
}

// The part of a fixture box (along its long axis) outside the boxes given as box.avoid (symbols drawn
// in it, other fixtures over it): the larger free stretch. → { center, w, h }
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

// Where the label of fixture f goes (world mm): `full`, its whole box (labelHooks.fixtureBox, else read
// from the record), and `box`, the part of it no other fixture covers (fixtureBoxes: fixtureObstacles of
// the project; a column standing in a 옷장). placeLabels and the drawing of the inner outline
// (ui/draw-fixtures.js) both use it. → { full, box } | null
export function fixtureTextArea(f, project, derived, fixtureBoxes = null) {
  let full = safeCall(labelHooks.fixtureBox, f, project, derived) || defaultFixtureBox(f);
  if (!full || !full.center) {
    const n = normalizeFixture(f);
    const b = n ? fixtureBounds(n) : null;
    if (!b) return null;
    full = { center: { x: n.x, y: n.y }, w: b.maxX - b.minX, h: b.maxY - b.minY, avoid: [] };
  }
  const own = { minX: full.center.x - full.w / 2, minY: full.center.y - full.h / 2, maxX: full.center.x + full.w / 2, maxY: full.center.y + full.h / 2 };
  const id = f && f.id;
  const others = (fixtureBoxes || fixtureObstacles(project)).filter((ob) => ob.id !== id && overlapArea(own, ob) > 0);
  const box = freePartOf(others.length ? { ...full, avoid: [...(full.avoid || []), ...others] } : full);
  return { full, box };
}

// Is the inner outline of a plain box drawn, its label area being `area` (fixtureTextArea)? As
// fixtureInnerLineShown for the whole box, and the label (tw wide at size em; 0: none) must also fit
// inside the line in the part of the box other fixtures leave free (else the label would be pushed
// across the line: the fixture keeps its plain outline, its label as in 0.6.5). gap / line / tw / em in
// world mm. → bool
export function fixtureInnerLineDrawn(area, gap, line, tw = 0, em = 0) {
  if (!area || !area.full) return false;
  const { full, box } = area;
  if (!fixtureInnerLineShown(full.w, full.h, gap, line, tw, em)) return false;
  if (!(tw > 0) || !box) return true;
  const inset = fixtureInnerTextInset(gap, line);
  return fixtureTextFit(tw, em, box.w - 2 * inset, box.h - 2 * inset, true).fits;
}

// Unit vector toward a fixture's front (away from the wall its back stands against).
function frontOf(f) {
  const rot = ((Math.round(Number(f && f.rot) || 0) % 360) + 360) % 360;
  if (rot === 90) return { x: -1, y: 0 };
  if (rot === 180) return { x: 0, y: -1 };
  if (rot === 270) return { x: 1, y: 0 };
  return { x: 0, y: 1 };
}
