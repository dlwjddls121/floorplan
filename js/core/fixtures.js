// Fixtures (설비): sinks, built-in closets, shoe cabinets, toilets ... (plan §1-2 "설비", §2-5).
//
// A fixture is a rectangle in world mm:
//   { id, type, x, y, w, d, rot, wall, measured: { w, d }, label, check }
//   - (x, y)  centre of the rectangle
//   - w       length along the wall (the fixture's local "u" axis), d = depth (local "v" axis)
//   - rot     0 | 90 | 180 | 270, clockwise in y-down screen space. rot 0 = the BACK of the fixture
//             faces up (-y), i.e. it stands against a wall above it; 90 = back faces right (+x);
//             180 = back faces down; 270 = back faces left.
//   - wall    id of the wall edge the back stands against, or null (free-standing)
//   - measured { w: bool, d: bool }: true when the size was typed on the numpad (a real measurement)
//   - label   null = automatic label (type name), '' = no label (e.g. 예시 세대 A 신발장 "글자 없음"),
//             any other text replaces the type name (the measured length is still appended)
//   - check   확인필요 flag (extension of the DESIGN.md §2 schema; stage D lists it)
//   - along   (wall fixtures) relative position along the ROOM SIDE it stands on: the fraction of the
//             free length beside it, 0 = against the side's low corner (smaller x / y), 1 = against
//             the high corner, 0.5 = centred. Set where the fixture is placed / moved / resized and
//             kept when lengths change, so a fixture put on the rough sketch keeps its place. null =
//             not known (older files): the next solve takes it from the position.
//   - fullW   an UNMEASURED length that was drawn shorter to fit its room side (the default 1800 of a
//             sink on a 1500 side): the length to come back to when the side gets longer. null when
//             the fixture is drawn at its full length.
//   - fullD   (columns only) the same for an unmeasured depth drawn shorter to fit the room.
//   - dropShare (wall fixtures with an UNMEASURED length that nearly fills its room side when placed,
//             review 예시 세대 A #23): where it was dropped, as the share of the side's whole length (0..1)
//             counted in the direction of its wall edge from node a to node b (a 도면 돌리기 keeps it).
//             On a sketch drawn smaller than the room, a default 1800 sink fills its side, so `along`
//             (the share of a free length of a few cm) cannot say where it was put; after the values
//             the side is longer and the sink goes back to that share (kept inside the side). Cleared
//             when the fixture is moved, turned or resized, or its length is measured.
//   - inWall  (storage types only: 옷장, 신발장; added 2026-10-17) true = the fixture stands IN its
//             wall ([벽 속에 넣기], a shoe cabinet built into the wall): it moves back into the wall by
//             min(depth, the drawn wall band = thickness + that room side's finish). Its record keeps the
//             real position (x, y), so hit tests, labels and the handles need nothing special. The wall
//             band is cut where the fixture overlaps it (fixtureWallCutouts; drawFixtures also paints
//             the fixture's box opaque over it). Only stored when true.
//   - pin     (free-standing fixtures, columns and stairs; review 예시 세대 A round 2) the placement anchor:
//             { roomId, u, v, kx, ky, x, y, ex, ey }. (u, v) is the centre's relative place in the
//             follow box of room roomId (null: the box of every corner, for a fixture in no room) as it
//             stood when it was put there; kx / ky ('lo' | 'hi' | 'in' | 'c') say per axis whether it
//             stood against the low / high side of that box, inside it, or neither. x, y, ex, ey are the
//             position and plan size the anchor belongs to: a command that moves, turns or resizes the
//             fixture leaves them behind, and the next re-derive takes a new anchor from the plan as it
//             was at that command. Every re-derive puts the fixture where its anchor says in the NEW plan
//             (see "placement anchors" below), so where it ends depends only on the final plan, not on
//             the order the values were typed in. Older records without it get one the same way.
//
// Types (user feedback 2026-10-17): '붙박이장' is now called '옷장' (old files are migrated);
// 냉장고 and 세탁기 are no longer offered — an old record of such a type (or of any type this app does
// not know) loads as '기타' named after its old type. A '기타' shows only the name the surveyor typed
// (label); with no name it has no text. 싱크대 has no basin symbol any more. 싱크대, 옷장 and 신발장
// are drawn the same simple way (outline + light gray fill, `fill`); usually only their width
// (가로) is measured and the depth is the type's average (`widthOnly`).
//
// Columns (기둥, type '기둥', added in 0.2.2) are fixtures too: a solid black rectangle with no label.
// Their size is a plan size, 가로 (world x) × 세로 (world y); w / d stay the local along-wall / depth
// sizes, so the wall logic (snapping, room side, `along`, `fullW`) is shared. When a column moves
// to a wall of the other orientation its w / d (and measured flags) are swapped so that its 가로 and
// 세로 stay the same (orientColumn). A column in a room corner is a wall column flush with an end of
// its room side (along 0 or 1), so it stays in that corner after every solve.
//
// Stairs (계단, type '계단', added in 0.2.3) are fixtures too: a thin outline with tread lines and
// one arrow pointing up the stairs, no label. w = 길이 (along the walking direction, which runs along
// the wall it stands against), d = 폭 (across the walking direction). Default 폭 900 × 길이 2400.
//   - stairDir  1 | -1: the way UP along the local u axis (fixtureFrame(rot).u): 1 = from the -w/2
//               end to the +w/2 end, -1 the other way. Only stairs have it ([방향 바꾸기] flips it).
// Like columns, a stair never sticks out of its room: its depth (폭) stays inside the room in front
// of a wall (fullD), and a free-standing stair is kept inside its room (keepColumnInRoom, which
// serves every type that `keepsInRoom`). Its size does not swap on a turn (it turns with its wall).
//
// Everything here is pure: inputs are never mutated.
import { nextId } from './graph.js';
import { innerCorners } from './dims.js';
import { pointInPolygon } from './geom.js';

// Types in the order the chooser shows them. w = along the wall, d = depth (mm).
//   storage    a closet-like type: may stand in its wall (inWall)
//   fill       drawn as an outline with a uniform light gray fill (FIXTURE_FILL), no symbol inside
//   widthOnly  usually only the width is measured: the depth is the type's average d (drawn, not
//              measured, editable); the panel asks 가로 first
export const FIXTURE_TYPES = Object.freeze([
  { type: '싱크대', w: 1800, d: 600, storage: false, glyph: null, fill: true, widthOnly: true },
  { type: '옷장', w: 900, d: 600, storage: true, glyph: null, fill: true, widthOnly: true },
  { type: '신발장', w: 900, d: 350, storage: true, glyph: null, fill: true, widthOnly: true },
  { type: '변기', w: 400, d: 700, storage: false, glyph: 'toilet' },
  { type: '세면대', w: 500, d: 450, storage: false, glyph: 'basin' },
  { type: '욕조', w: 1500, d: 700, storage: false, glyph: 'bath' },
  { type: '보일러', w: 450, d: 350, storage: false, glyph: null },
  { type: '기둥', w: 400, d: 400, storage: false, glyph: null, column: true },
  { type: '계단', w: 2400, d: 900, storage: false, glyph: null, stair: true },   // w = 길이, d = 폭
  { type: '기타', w: 600, d: 600, storage: false, glyph: null },
]);

// Old type names that were renamed: the record is migrated to the new name.
const RENAMED_TYPES = Object.freeze({ 붙박이장: '옷장' });

// The fill of 싱크대 / 옷장 / 신발장 and of 실 아님 spaces (screen, paper and 그림만): plain white
// (user 2026-10-18: no colour; 2026-10-17: no diagonal). It is still painted (opaque), so an in-wall
// 신발장 replaces the wall band it stands in and no grid line shows through on screen.
export const FIXTURE_FILL = '#FFFFFF';

export const COLUMN_TYPE = '기둥';
export const STAIR_TYPE = '계단';
export const OTHER_TYPE = '기타';
export const STAIR_TREAD_MM = 250;   // about one tread line per this many mm of 길이
export const FIXTURE_TYPE_NAMES = FIXTURE_TYPES.map((t) => t.type);
export const ROTATIONS = [0, 90, 180, 270];
export const MIN_FIXTURE_MM = 50;
export const MAX_FIXTURE_MM = 20000;
export const RESIZE_STEP_MM = 10;    // sizes set by dragging a handle snap to this step
const FLUSH_TOL = 0.5;               // mm: an end this close to its room side's corner is flush

const TYPE_MAP = new Map(FIXTURE_TYPES.map((t) => [t.type, t]));

// The current name of a (possibly old) type name: '붙박이장' → '옷장'; others unchanged.
export function migratedType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(RENAMED_TYPES, type) ? RENAMED_TYPES[type] : type;
}

export function fixtureTypeInfo(type) {
  return TYPE_MAP.get(migratedType(type)) || TYPE_MAP.get(OTHER_TYPE);
}

export function isStorageType(type) {
  const t = TYPE_MAP.get(migratedType(type));
  return !!(t && t.storage);
}

// True for the types drawn as a plain box: the outline over an opaque FIXTURE_FILL (white) and nothing
// inside but the label (싱크대, 옷장, 신발장): a record or a type name. (The name is from when the fill
// was light gray.)
export function hasGrayFill(f) {
  const type = typeof f === 'string' ? f : f && f.type;
  const t = TYPE_MAP.get(migratedType(type));
  return !!(t && t.fill);
}

// True for the types drawn as a plain box with nothing inside but their label — 싱크대, 옷장, 신발장,
// 보일러, 기타 (and an unknown type, read as 기타): these get the second, inner outline (user 2026-10-25,
// "다른것까지 한줄 더 그어줘"; ui/draw-fixtures.js FIXTURE_STYLE.innerLine, core/labels.js
// fixtureInnerLineShown). Not 변기 / 세면대 / 욕조 (their own symbols), 기둥 (solid black), 계단 (treads).
// A record or a type name.
export function isPlainBox(f) {
  const type = migratedType(typeof f === 'string' ? f : f && f.type);
  if (type === COLUMN_TYPE || type === STAIR_TYPE) return false;
  const t = fixtureTypeInfo(type);
  return !!t && !t.glyph && !t.column && !t.stair;
}

// True for the types of which usually only the width is measured (the depth is the average).
export function isWidthOnly(f) {
  const type = typeof f === 'string' ? f : f && f.type;
  const t = TYPE_MAP.get(migratedType(type));
  return !!(t && t.widthOnly);
}

// True when [벽 속에 넣기] applies: a storage type standing against a wall (h / v).
export function canGoInWall(f) {
  return !!(f && f.wall && isStorageType(f.type));
}

// True for a column (기둥): a fixture record, or a type name.
export function isColumn(f) {
  const type = typeof f === 'string' ? f : f && f.type;
  return type === COLUMN_TYPE;
}

// True for a stair (계단): a fixture record, or a type name.
export function isStair(f) {
  const type = typeof f === 'string' ? f : f && f.type;
  return type === STAIR_TYPE;
}

// Types that must stay inside their room as a whole (columns, stairs): a wall one keeps its depth
// inside the room in front of it, a free one is kept inside its room's inner outline.
export function keepsInRoom(f) {
  return isColumn(f) || isStair(f);
}

// Tread lines of a stair (local u along its 길이 w): count = max(2, round(w / 250)) lines, evenly
// spaced, dividing the length into count + 1 equal treads. → { count, spacing, positions: [u] }
// (u measured from the centre, -w/2 .. w/2)
export function stairTreads(f) {
  const w = f && isNum(f.w) && f.w > 0 ? f.w : 0;
  const count = Math.max(2, Math.round(w / STAIR_TREAD_MM));
  const spacing = w / (count + 1);
  const positions = [];
  for (let k = 1; k <= count; k++) positions.push(-w / 2 + k * spacing);
  return { count, spacing, positions };
}

// The up arrow of a stair in local coordinates along its centre line (v = d / 2): from the start end
// (`from`) to the far end (`to`), u from the centre. → { from, to, v, dir }
export function stairArrowLocal(f) {
  const w = f.w, dir = f.stairDir === -1 ? -1 : 1;
  const m = Math.min(w * 0.06, 120);
  return { from: -dir * (w / 2 - m), to: dir * (w / 2 - m), v: f.d / 2, dir };
}

// A stair MOVED to a place where it turned half round (from a top wall to the bottom wall, from a
// left wall to the right wall): its local u axis now points the other way, so its stairDir is
// flipped and the arrow keeps pointing the same way on the plan. [↻ 회전] and quarter turns are
// real turns and keep stairDir. → fixture (the same object when nothing changes)
export function keepStairWay(before, after) {
  if (!isStair(after) || !before) return after;
  const r0 = normalizeRot(before.rot), r1 = normalizeRot(after.rot);
  if ((r1 - r0 + 360) % 360 !== 180) return after;
  return { ...after, stairDir: before.stairDir === -1 ? 1 : -1 };
}

const isNum = (v) => typeof v === 'number' && isFinite(v);

export function normalizeRot(rot) {
  const r = Math.round((isNum(rot) ? rot : 0) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

// A complete, valid fixture from partial data (unknown type → '기타'). Used by the commands and by
// the renderer, so a hand-edited file never breaks drawing.
export function normalizeFixture(f) {
  if (!f || typeof f !== 'object') return null;
  const t0 = migratedType(f.type);
  const known = TYPE_MAP.has(t0);
  const type = known ? t0 : OTHER_TYPE;
  const info = fixtureTypeInfo(type);
  const size = (v, def) => (isNum(v) && v >= MIN_FIXTURE_MM && v <= MAX_FIXTURE_MM ? v : def);
  const measured = f.measured && typeof f.measured === 'object' ? f.measured : {};
  const w = size(f.w, info.w);
  const d = size(f.d, info.d);
  let label = typeof f.label === 'string' ? f.label : null;
  // A type this app no longer offers (냉장고, 세탁기) or does not know becomes a 기타 named after it,
  // so the plan still says what it is (a hidden label, '', stays hidden).
  if (!known && label == null && typeof f.type === 'string' && f.type.trim()) label = f.type.trim();
  const out = {
    id: typeof f.id === 'string' ? f.id : '',
    type,
    x: isNum(f.x) ? f.x : 0,
    y: isNum(f.y) ? f.y : 0,
    w,
    d,
    rot: normalizeRot(f.rot),
    wall: typeof f.wall === 'string' && f.wall ? f.wall : null,
    measured: { w: !!measured.w, d: !!measured.d },
    label,
    check: !!f.check,
    along: isNum(f.along) ? Math.min(1, Math.max(0, f.along)) : null,
    fullW: !measured.w && isNum(f.fullW) && f.fullW > w && f.fullW <= MAX_FIXTURE_MM ? f.fullW : null,
  };
  // Only columns and stairs shorten their depth to fit (older records never have it).
  if (keepsInRoom(type) && !measured.d && isNum(f.fullD) && f.fullD > d && f.fullD <= MAX_FIXTURE_MM) out.fullD = f.fullD;
  if (type === STAIR_TYPE) out.stairDir = f.stairDir === -1 ? -1 : 1;
  if (info.storage && f.inWall === true) out.inWall = true;
  // Only stored while it applies: a wall fixture whose length is not measured.
  if (out.wall && !measured.w && isNum(f.dropShare) && f.dropShare >= 0 && f.dropShare <= 1) out.dropShare = f.dropShare;
  // The placement anchor of a free-standing fixture (a wall fixture keeps its place by `along`).
  if (!out.wall) {
    const pin = cleanFixturePin(f.pin);
    if (pin) out.pin = pin;
  }
  return out;
}

// Plan size of a fixture: 가로 (world x extent) and 세로 (world y extent). → { ex, ey }
export function fixtureExtents(f) {
  const across = normalizeRot(f.rot) % 180 === 0;
  return across ? { ex: f.w, ey: f.d } : { ex: f.d, ey: f.w };
}

// The local size key ('w' | 'd') that holds a column's 가로 ('x') or 세로 ('y') at its rotation.
export function extentKey(f, axis) {
  const across = normalizeRot(f.rot) % 180 === 0;
  return (axis === 'x') === across ? 'w' : 'd';
}

// A column turned to `rot` with the same 가로 × 세로: w / d, the measured flags and the shortened
// lengths swap when the rotation changes between horizontal and vertical. A length that was drawn
// shorter to fit a wall gets its full value back first (the new place is fitted again).
// Other fixtures (a sink turns with its wall) only get the new rotation. → fixture
export function orientColumn(f, rot) {
  const r = normalizeRot(rot);
  if (!isColumn(f)) return { ...f, rot: r };
  const m = f.measured || {};
  const w = !m.w && isNum(f.fullW) ? f.fullW : f.w;
  const d = !m.d && isNum(f.fullD) ? f.fullD : f.d;
  const out = { ...f, rot: r, w, d, fullW: null, fullD: null };
  if ((normalizeRot(f.rot) % 180 === 0) !== (r % 180 === 0)) {
    out.w = d;
    out.d = w;
    out.measured = { w: !!m.d, d: !!m.w };
  }
  return out;
}

// Label text on the plan: "싱크대", "싱크대 1950" (when the length was measured), '' when hidden.
// A column never has a label (it is structure, drawn solid black); a stair neither (its drawing
// says what it is). A 기타 shows only the name the surveyor typed ('수납장', '수납장 700'); without
// a name it has no text. Old type names are read as today's ('붙박이장' → '옷장', '냉장고' → a 기타
// named '냉장고').
export function fixtureLabel(raw) {
  if (!raw) return '';
  const f = normalizeFixture(raw);
  if (!f || isColumn(f) || isStair(f)) return '';
  if (f.label === '') return '';
  const custom = typeof f.label === 'string' && f.label.trim() ? f.label.trim() : '';
  const name = custom || (f.type === OTHER_TYPE ? '' : f.type);
  if (!name) return '';
  if (f.measured.w) return `${name} ${Math.round(f.w)}`;
  return name;
}

// The name of a fixture in panels and check messages: the typed name, else the type ('설비' for a
// 기타 without a name is left to the caller). → string
export function fixtureName(raw) {
  const f = normalizeFixture(raw);
  if (!f) return '';
  const custom = typeof f.label === 'string' && f.label.trim() ? f.label.trim() : '';
  return custom || f.type;
}

// ---- local frame ---------------------------------------------------------------------------------

// Unit vectors of a rotation: u = along the wall (local +x), n = toward the BACK (local -y at rot 0).
export function fixtureFrame(rot) {
  switch (normalizeRot(rot)) {
    case 90: return { u: { x: 0, y: 1 }, n: { x: 1, y: 0 } };
    case 180: return { u: { x: -1, y: 0 }, n: { x: 0, y: 1 } };
    case 270: return { u: { x: 0, y: -1 }, n: { x: -1, y: 0 } };
    default: return { u: { x: 1, y: 0 }, n: { x: 0, y: -1 } };
  }
}

// World point of a local point: u in [-w/2, w/2] along the wall, v in [0, d] from the back to the front.
export function localToWorld(f, u, v) {
  const { u: U, n: N } = fixtureFrame(f.rot);
  const k = f.d / 2 - v;
  return { x: f.x + U.x * u + N.x * k, y: f.y + U.y * u + N.y * k };
}

// Corners [back-left, back-right, front-right, front-left] in world mm.
export function fixturePolygon(f) {
  const hw = f.w / 2;
  return [localToWorld(f, -hw, 0), localToWorld(f, hw, 0), localToWorld(f, hw, f.d), localToWorld(f, -hw, f.d)];
}

// Axis-aligned extent in world mm.
export function fixtureBounds(f) {
  const across = normalizeRot(f.rot) % 180 === 0;
  const hx = (across ? f.w : f.d) / 2, hy = (across ? f.d : f.w) / 2;
  return { minX: f.x - hx, maxX: f.x + hx, minY: f.y - hy, maxY: f.y + hy };
}

// World boxes of the symbols drawn inside a fixture that its label should not cover. The sink basin
// was the only one, and it is no longer drawn (user feedback 2026-10-17), so this is always empty;
// kept for ui/wiring.js (labelHooks.fixtureBox avoid). → [{ minX, minY, maxX, maxY }]
export function fixtureGlyphBoxes(_f) {
  return [];
}

// Topmost fixture containing the point (grown by tolMM). → fixture | null
export function fixtureAt(project, point, tolMM = 0) {
  const list = (project && project.fixtures) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const f = normalizeFixture(list[i]);
    if (!f) continue;
    const b = fixtureBounds(f);
    if (point.x >= b.minX - tolMM && point.x <= b.maxX + tolMM && point.y >= b.minY - tolMM && point.y <= b.maxY + tolMM) {
      return list[i];
    }
  }
  return null;
}

// ---- walls ---------------------------------------------------------------------------------------

// Drawn wall thickness (mm): solved value, else measured, else the default by wall type. Same rule as
// render.js edgeThickness (kept here so the core does not import UI code).
export function wallThickness(edge, derived, settings) {
  if (!edge || edge.kind === 'divider') return 0;
  const solved = derived && derived.solve && derived.solve.thickness;
  if (solved && typeof solved.get === 'function') {
    const t = solved.get(edge.id);
    if (t != null && isFinite(t)) return Math.max(0, t);
  }
  if (isNum(edge.thickness)) return edge.thickness;
  const s = settings || {};
  const ef = derived && derived.edgeFaces;
  const pair = ef && typeof ef.get === 'function' ? ef.get(edge.id) : null;
  if (pair && pair[0] != null && pair[1] != null) return isNum(s.intWall) ? s.intWall : 100;
  return isNum(s.extWall) ? s.extWall : 150;
}

// Straight h/v walls (dividers included: a closet can stand against a divider) with their geometry.
function axisWalls(project, derived) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const out = [];
  for (const e of project.edges || []) {
    if (e.orient !== 'h' && e.orient !== 'v') continue;
    const A = nodes.get(e.a), B = nodes.get(e.b);
    if (!A || !B) continue;
    const h = e.orient === 'h';
    const c = h ? A.y : A.x;                        // centre-line coordinate across the wall
    const s0 = Math.min(h ? A.x : A.y, h ? B.x : B.y);
    const s1 = Math.max(h ? A.x : A.y, h ? B.x : B.y);
    out.push({ edge: e, h, c, s0, s1, t: wallThickness(e, derived, project.settings) });
  }
  return out;
}

// Where in-wall fixtures (inWall, e.g. a 신발장 built into the wall) overlap the wall bands, for a wall
// renderer that leaves those parts of the walls white (like openingCutouts in ui/draw-openings.js).
//   → Map edgeId → [{ from, to, fixtureId, points }] sorted by `from`
//     from / to  mm from the edge's node a along the edge (the overlap along the wall)
//     points     the overlap as a world polygon (4 corners): the part of the wall band (centre line
//                ± thickness / 2) inside the fixture's box. It may cover only part of the thickness
//                (a fixture shallower than its wall).
// INTEGRATION: render.js (screen) and output.js drawPaperWalls (paper, 그림만) should clear `points`
// to the background after filling the walls, as they do for the opening cutouts. The picture is
// right without it too: the fixture layer (drawn after the walls on screen, on paper and in 그림만)
// paints an in-wall fixture's whole box with its opaque gray fill and outline, and the box contains
// every cutout (and the finish strip in front of the wall).
export function fixtureWallCutouts(project, derived) {
  const map = new Map();
  if (!project) return map;
  const list = (project.fixtures || []).map(normalizeFixture).filter((f) => f && f.inWall && f.wall);
  if (!list.length) return map;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const walls = axisWalls(project, derived).filter((wl) => wl.edge.kind !== 'divider' && wl.t > 0);
  for (const f of list) {
    const b = fixtureBounds(f);
    for (const wl of walls) {
      const band = wl.h
        ? { minX: wl.s0, maxX: wl.s1, minY: wl.c - wl.t / 2, maxY: wl.c + wl.t / 2 }
        : { minX: wl.c - wl.t / 2, maxX: wl.c + wl.t / 2, minY: wl.s0, maxY: wl.s1 };
      const r = {
        minX: Math.max(b.minX, band.minX), maxX: Math.min(b.maxX, band.maxX),
        minY: Math.max(b.minY, band.minY), maxY: Math.min(b.maxY, band.maxY),
      };
      if (r.maxX - r.minX < 0.5 || r.maxY - r.minY < 0.5) continue;
      const A = nodes.get(wl.edge.a), B = nodes.get(wl.edge.b);
      if (!A || !B) continue;
      const key = wl.h ? 'x' : 'y';
      const lo = wl.h ? r.minX : r.minY, hi = wl.h ? r.maxX : r.maxY;
      const forward = A[key] <= B[key];
      const from = forward ? lo - A[key] : A[key] - hi;
      const to = forward ? hi - A[key] : A[key] - lo;
      const points = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
      if (!map.has(wl.edge.id)) map.set(wl.edge.id, []);
      map.get(wl.edge.id).push({ from, to, fixtureId: f.id, points });
    }
  }
  for (const cuts of map.values()) cuts.sort((p, q) => p.from - q.from);
  return map;
}

// rot for a fixture whose back is against a wall of orientation h|v, on the side `side` (+1 = the
// larger coordinate, i.e. below an h wall / right of a v wall).
function rotFor(horizontal, side) {
  if (horizontal) return side > 0 ? 0 : 180;
  return side > 0 ? 270 : 90;
}

// Side of the wall the fixture stands on, from its rotation (the back faces the wall).
function sideFromRot(rot) {
  const { n } = fixtureFrame(rot);
  return -(n.x + n.y); // n points to the wall, so the fixture is on the opposite side
}

// Where to put a fixture of size { w, d } dropped at `point`.
//   → { x, y, rot, wall } (wall null and the point itself when no wall face is within snapMM)
// opts: snapMM — distance from the fixture's back to a wall face that still snaps;
//       rot — only accept walls that give this rotation; corner — also snap the ends to the faces of
//       perpendicular walls (default true); exclude — fixture to ignore (not used yet).
// A column keeps its plan size (가로 × 세로) on every wall: its along / depth sizes depend on the wall's
// orientation (size.type '기둥'; its 가로 / 세로 are read at size.rot).
export function snapFixture(project, derived, size, point, { snapMM = 300, rot = null, corner = true } = {}) {
  const column = isColumn(size);
  const ext = column ? fixtureExtents({ w: size.w, d: size.d, rot: size.rot || 0 }) : null;
  const sizeOn = (h) => (column ? (h ? { w: ext.ex, d: ext.ey } : { w: ext.ey, d: ext.ex }) : { w: size.w, d: size.d });
  const free = { x: point.x, y: point.y, rot: normalizeRot(rot != null ? rot : size.rot), wall: null };
  if (!project || !(snapMM > 0)) return free;
  const walls = axisWalls(project, derived);
  // A column or a stair dropped inside a room must stay in that room: a wall piece whose face toward
  // the fixture belongs to another room or to the outside (a deep stair dropped next to the end of
  // an L's inner wall snapped onto that wall's notch side) is not a candidate.
  const home = keepsInRoom(size) ? roomAround(project, derived, point) : null;
  let best = null;
  for (const wl of walls) {
    const { w, d } = sizeOn(wl.h);
    const along = wl.h ? point.x : point.y;
    const across = wl.h ? point.y : point.x;
    // The fixture must overlap the wall's extent (half its length may stick out at an end).
    if (along < wl.s0 - w / 2 || along > wl.s1 + w / 2) continue;
    const side = across >= wl.c ? 1 : -1;
    const r = rotFor(wl.h, side);
    if (rot != null && normalizeRot(rot) !== r) continue;
    // Gap between the fixture's back (centre at `point`) and the wall face on that side.
    const gap = Math.abs(across - wl.c) - wl.t / 2 - d / 2;
    if (Math.abs(gap) > snapMM) continue;
    if (home) {
      // Where it would stand along this wall piece (kept on the piece, as fitFixtureOnSide does).
      const s = wl.s1 - wl.s0 >= w ? Math.min(wl.s1 - w / 2, Math.max(wl.s0 + w / 2, along)) : (wl.s0 + wl.s1) / 2;
      const c = wl.c + side * (wl.t / 2 + Math.min(d / 2, 100));   // just in front of the face
      const at = wl.h ? { x: s, y: c } : { x: c, y: s };
      if (!pointInPolygon(at, home.dr.face.points)) continue;
    }
    if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { wl, side, rot: r, gap, along };
  }
  if (!best) return free;
  let { wl } = best;
  const { side } = best;
  const { w, d } = sizeOn(wl.h);
  let along = best.along;
  if (corner) along = snapEnds(walls, wl, side, along, w, d, snapMM);
  // Collinear wall pieces (a line split by a T-junction) give the same gap, and the first one in the
  // list would win even when the fixture stands over the next piece. Take the piece under its centre:
  // with a T on the fixture's side the two pieces belong to different rooms, and the room side is
  // looked up from this edge (fixtureRoomSide), so a sink dropped right of the T must not land left.
  if (!(along >= wl.s0 - 1e-6 && along <= wl.s1 + 1e-6)) {
    const under = walls.find((p) => p.h === wl.h && Math.abs(p.c - wl.c) < 0.5
      && along >= p.s0 - 1e-6 && along <= p.s1 + 1e-6);
    if (under) wl = under;
  }
  const acrossC = wl.c + side * (wl.t / 2 + d / 2);
  return {
    x: wl.h ? along : acrossC,
    y: wl.h ? acrossC : along,
    rot: best.rot,
    wall: wl.edge.id,
  };
}

// Slide the fixture along its wall so an end that is within snapMM of a perpendicular wall's face
// touches it (a sink put "in the corner" ends exactly in the corner).
function snapEnds(walls, wl, side, along, w, d, snapMM) {
  const face = wl.c + side * (wl.t / 2);
  const band0 = Math.min(face, face + side * d), band1 = Math.max(face, face + side * d);
  const lo = along - w / 2, hi = along + w / 2;
  let bestShift = null;
  for (const p of walls) {
    if (p.h === wl.h || p.edge.id === wl.edge.id) continue;
    // The perpendicular wall must reach into the fixture's depth band.
    if (p.s1 < band0 - 1 || p.s0 > band1 + 1) continue;
    const cands = [
      { shift: p.c + p.t / 2 - lo },  // low end against the wall's high face
      { shift: p.c - p.t / 2 - hi },  // high end against the wall's low face
    ];
    for (const c of cands) {
      if (Math.abs(c.shift) > snapMM) continue;
      // Do not push the fixture into the wall itself.
      const nlo = lo + c.shift, nhi = hi + c.shift;
      if (nhi > p.c - p.t / 2 + 0.5 && nlo < p.c + p.t / 2 - 0.5) continue;
      if (bestShift == null || Math.abs(c.shift) < Math.abs(bestShift)) bestShift = c.shift;
    }
  }
  return bestShift == null ? along : along + bestShift;
}

// ---- the room side a wall fixture stands on ------------------------------------------------------

// The room side behind a wall-snapped fixture and its clear span along the wall. The span runs
// between the side's two inner corners (dims.innerCorners: wall faces plus finishes, exactly as the
// side is measured), so an end closed by a divider (구역 나누기 선: at its line), by a wall that goes on
// as a straight run past a T-junction, or by any corner of that room counts; a T-junction on the far
// side of the wall does not end the side. `face` is the cross coordinate of the room's inner face
// at the fixture's own wall edge (wall face + that side's finish).
// In a room with a diagonal side the span is where the fixture's whole depth stays inside the room
// (slantLimits): next to an acute corner (D1's triangles, the slanted wall of a trapezoid) the front of
// a sink reaches the diagonal wall well before its back reaches the corner. Fixtures stay axis-aligned
// and stand only against h / v walls.
//   → { roomId, sideKey, key ('x' | 'y': along the wall), cross, side (+1 = room at the larger cross
//       coordinate), lo, hi, length, face } | null (free-standing, not an h/v wall, no room there)
export function fixtureRoomSide(project, derived, f) {
  if (!project || !derived || !f || !f.wall) return null;
  const e = (project.edges || []).find((x) => x.id === f.wall);
  if (!e || (e.orient !== 'h' && e.orient !== 'v')) return null;
  const h = e.orient === 'h';
  const rot = normalizeRot(f.rot);
  if ((rot % 180 === 0) !== h) return null;   // the back does not face this wall
  const side = sideFromRot(rot);
  const key = h ? 'x' : 'y', cross = h ? 'y' : 'x';
  const A = (project.nodes || []).find((n) => n.id === e.a);
  if (!A) return null;
  const finish = derived.solve && derived.solve.finish;
  for (const dr of derived.rooms || []) {
    const sides = dr.sides || [];
    const i = sides.findIndex((s) => s.orient === e.orient && s.edgeIds.includes(e.id)
      && (h ? s.inwardNormal.y : s.inwardNormal.x) * side > 0.5);
    if (i < 0) continue;
    const c = innerCorners(dr, i, project, derived);
    if (!c) continue;
    let lo = Math.min(c.A[key], c.B[key]), hi = Math.max(c.A[key], c.B[key]);
    const fin = finish && typeof finish.get === 'function' ? Math.max(0, finish.get(`${dr.roomId}:${sides[i].key}`) || 0) : 0;
    const t = wallThickness(e, derived, project.settings);
    const face = A[cross] + side * (t / 2 + fin);
    if (sides.some((s) => s.orient === 'd')) {
      // The depth that stands in the room (an in-wall fixture stands partly in its wall band).
      const d = isNum(f.d) ? f.d : 0;
      const depth = f.inWall ? Math.max(0, d - (t + fin)) : d;
      ({ lo, hi } = slantLimits(dr, project, derived, { key, cross, side, face, depth, lo, hi }));
    }
    // band: the drawn wall behind the face (thickness + finish) that an in-wall fixture can go into.
    return { roomId: dr.roomId, sideKey: sides[i].key, key, cross, side, lo, hi, length: hi - lo, face, band: t + fin };
  }
  return null;
}

// The stretch lo..hi (along `key`) of a room side with a diagonal neighbour where a fixture standing on
// that side, `depth` deep from the inner face `face` into the room, stays inside the room: every slanted
// face of the room's inner outline that runs through that depth band over the side ends the stretch at
// the far end of its crossing (an acute corner: the sink's front corner touches the diagonal wall's
// face). An obtuse corner leaves the stretch as it is. h / v faces are the side's own corners already.
// → { lo, hi } (hi < lo when nothing that deep fits)
function slantLimits(dr, project, derived, { key, cross, side, face, depth, lo, hi }) {
  if (!(depth > 0)) return { lo, hi };
  const poly = roomInnerPolygon(dr, project, derived);
  if (!poly) return { lo, hi };
  const c0 = Math.min(face, face + side * depth), c1 = Math.max(face, face + side * depth);
  const mid = (lo + hi) / 2;
  let a = lo, b = hi;
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    if (!isSlanted(P, Q)) continue;
    const dc = Q[cross] - P[cross];
    let t0 = (c0 - P[cross]) / dc, t1 = (c1 - P[cross]) / dc;
    if (t0 > t1) [t0, t1] = [t1, t0];
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    if (!(t1 >= t0)) continue;
    const u0 = P[key] + (Q[key] - P[key]) * t0, u1 = P[key] + (Q[key] - P[key]) * t1;
    const e0 = Math.min(u0, u1), e1 = Math.max(u0, u1);
    if (e1 <= lo + FLUSH_TOL || e0 >= hi - FLUSH_TOL) continue;   // beside the side, not over it
    if ((e0 + e1) / 2 < mid) a = Math.max(a, e1);
    else b = Math.min(b, e0);
  }
  return { lo: a, hi: b };
}

// A face of a room outline that is neither horizontal nor vertical (a diagonal wall).
function isSlanted(P, Q) {
  return Math.abs(P.x - Q.x) > 0.5 && Math.abs(P.y - Q.y) > 0.5;
}

// Keep a wall fixture inside the room side it stands on (fixtureRoomSide): the back on the side's
// inner face, the length between the side's two inner corners.
//   - An UNMEASURED length (the type's default) is drawn no longer than the side; `fullW` keeps the
//     full length, which comes back when the side gets longer.
//   - A MEASURED length longer than the side is centred on it (checks-full.js: '설비가 벽보다 김').
//   - keepAlong: place it by its stored `along` (after a solve: the relative position survives any
//     change of lengths); otherwise `along` is taken from where it now is (a command placed it).
//     A fixture with a `dropShare` (dropped on a side it nearly filled) is placed by that share of
//     the side instead, kept inside the side; `along` follows from where it then stands.
// With no room on that side, the older rule applies: between the faces that close the wall's ends
// on the fixture's side (wallEndFaces). → fixture (the same object when nothing changed)
export function fitFixtureOnSide(project, derived, raw, { keepAlong = false } = {}) {
  const f = normalizeFixture(raw);
  if (!f || !f.wall || !project) return raw;
  const e = (project.edges || []).find((x) => x.id === f.wall);
  if (!e || (e.orient !== 'h' && e.orient !== 'v')) return raw;
  const key = e.orient === 'h' ? 'x' : 'y', cross = e.orient === 'h' ? 'y' : 'x';
  const rs = fixtureRoomSide(project, derived, f);
  let lo, hi;
  if (rs) {
    ({ lo, hi } = rs);
  } else {
    const lim = wallEndFaces(project, derived, e, sideFromRot(f.rot));
    if (!lim) return raw;
    ({ lo, hi } = lim);
  }
  const bounded = isFinite(lo) && isFinite(hi);
  let w = f.w, fullW = f.fullW;
  if (!f.measured.w && bounded) {
    const want = fullW != null ? fullW : f.w;
    w = Math.min(want, Math.max(MIN_FIXTURE_MM, hi - lo));
    fullW = w < want - 1e-6 ? want : null;
  }
  let c = f[key];
  let along = f.along;
  const min = lo + w / 2, max = hi - w / 2;
  const share = rs && bounded && f.dropShare != null ? f.dropShare : null;
  if (!bounded) {
    c = Math.min(max, Math.max(min, c));
  } else if (min > max + 1e-6) {
    c = (lo + hi) / 2;                      // longer than the side: centred
    if (along == null) along = 0.5;
  } else {
    const free = Math.max(0, max - min);
    if (keepAlong && share != null) {
      c = Math.min(max, Math.max(min, sharePoint(project, e, key, lo, hi, share)));
      if (free > 1e-6) along = (c - min) / free;
      else if (along == null) along = 0.5;
    } else if (keepAlong && along != null) {
      c = min + along * free;
    } else {
      c = Math.min(max, Math.max(min, c));
      if (free > 1e-6) along = (c - min) / free;
      else if (along == null) along = 0.5;
    }
  }
  const out = { ...raw, [key]: c, w, along, fullW };
  let d = f.d;
  if (rs && keepsInRoom(f)) {
    // A column (or a stair) must not stick out of its room on the front either: an unmeasured depth
    // is drawn no deeper than the room in front of it (fullD keeps the full depth); a measured one is
    // kept and reported (checks-full.js 'fixtureDeep' / 'stairFit').
    const avail = depthInRoom(project, derived, rs, c - w / 2, c + w / 2);
    if (!f.measured.d && isFinite(avail)) {
      const want = f.fullD != null ? f.fullD : f.d;
      d = Math.min(want, Math.max(MIN_FIXTURE_MM, avail));
      out.d = d;
      out.fullD = d < want - 1e-6 ? want : null;
    }
  }
  if (rs) {
    // An in-wall fixture (신발장 built into the wall) goes back into the drawn wall band.
    const shift = f.inWall ? Math.min(d, Math.max(0, rs.band)) : 0;
    out[cross] = rs.face + rs.side * (d / 2 - shift);
  } else if (f.inWall) {
    // No room on that side: back into the bare wall from its face.
    const A = (project.nodes || []).find((n) => n.id === e.a);
    const t = wallThickness(e, derived, project.settings);
    const side = sideFromRot(f.rot);
    if (A) out[cross] = A[cross] + side * (t / 2 + d / 2 - Math.min(d, t));
  }
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
  if (same(out.x, raw.x) && same(out.y, raw.y) && same(out.w, raw.w) && same(out.along, raw.along)
    && same(out.fullW, raw.fullW) && same(out.d, raw.d) && same(out.fullD, raw.fullD)) return raw;
  return out;
}

// The point (along-wall coordinate) at `share` of the side lo..hi, counted in the direction of the
// wall edge from node a to node b (dropShare: a quarter turn of the plan keeps it).
function sharePoint(project, e, key, lo, hi, share) {
  return edgeRunsUp(project, e, key) ? lo + share * (hi - lo) : hi - share * (hi - lo);
}

// The share (0..1) of the side lo..hi at along-wall coordinate c, in the same sense as sharePoint.
function shareAt(project, e, key, lo, hi, c) {
  if (!(hi - lo > 1e-6)) return 0.5;
  const s = (c - lo) / (hi - lo);
  const v = edgeRunsUp(project, e, key) ? s : 1 - s;
  return Math.min(1, Math.max(0, v));
}

function edgeRunsUp(project, e, key) {
  const nodes = project.nodes || [];
  const A = nodes.find((n) => n.id === e.a), B = nodes.find((n) => n.id === e.b);
  return !A || !B || B[key] >= A[key];
}

// True when an unmeasured length `want` nearly fills a room side of length L (its free length is less
// than a fifth of the side): where it stands along the side then says little, and corner snapping
// would decide it (review 예시 세대 A #23).
function nearlyFills(want, L) {
  return isNum(want) && isNum(L) && L > 0 && L - want < 0.2 * L;
}

// Whether an UNMEASURED fixture of drawn length w dropped with its centre at c (along the room side
// rs) goes into a corner of that side (placeFixture; review 예시 세대 A #23): the drop point within snapMM
// of an end of the side, or the fixture's end within snapMM of it and in the quarter of the free length
// next to it. On a sketch drawn smaller than the room the free length is short, and the end of a
// default-size fixture dropped in the middle part comes within snapMM of a corner without being meant
// for it.
function dropNearCorner(rs, c, w, snapMM) {
  if (!isNum(c) || !(rs.length > 0)) return true;
  if (Math.min(Math.abs(c - rs.lo), Math.abs(rs.hi - c)) <= snapMM) return true;
  const free = Math.max(0, rs.length - w);
  // (negative: it sticks out past the corner, and is kept inside the side against it anyway)
  const gap = Math.min(c - w / 2 - rs.lo, rs.hi - (c + w / 2));
  return gap <= Math.min(snapMM, 0.25 * free);
}

// Inner outline of a derived room: the inner corner of every side (wall faces plus finishes, as
// dims.innerCorners), in the room's side order. → [{ x, y }] | null
export function roomInnerPolygon(dr, project, derived) {
  const sides = (dr && dr.sides) || [];
  if (sides.length < 3) return null;
  const pts = [];
  for (let i = 0; i < sides.length; i++) {
    const c = innerCorners(dr, i, project, derived);
    if (!c) return null;
    pts.push(c.A);
  }
  return pts;
}

// Clear depth in front of a wall fixture's back (from its room side's inner face into the room) over
// the stretch lo..hi along the wall: up to the nearest inner face of the same room that runs
// parallel to the wall in front of it. → mm (Infinity when nothing closes it)
export function depthInRoom(project, derived, rs, lo, hi) {
  const dr = ((derived && derived.rooms) || []).find((r) => r.roomId === rs.roomId);
  const poly = dr ? roomInnerPolygon(dr, project, derived) : null;
  if (!poly) return Infinity;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    if (Math.abs(P[rs.cross] - Q[rs.cross]) > 0.5) continue;           // not parallel to the wall
    const a = Math.min(P[rs.key], Q[rs.key]), b = Math.max(P[rs.key], Q[rs.key]);
    if (Math.min(b, hi) - Math.max(a, lo) <= FLUSH_TOL) continue;       // not in front of it
    const dist = (P[rs.cross] - rs.face) * rs.side;
    if (dist > FLUSH_TOL && dist < best) best = dist;
  }
  return best;
}

// The room a free-standing fixture stands in (its centre inside the room's walls) and that room's
// inner outline. → { dr, poly } | null
function roomAround(project, derived, f) {
  let best = null;
  for (const dr of (derived && derived.rooms) || []) {
    const pts = dr.face && dr.face.points;
    if (!pts || !pointInPolygon({ x: f.x, y: f.y }, pts)) continue;
    if (best && !(dr.area < best.dr.area)) continue;
    const poly = roomInnerPolygon(dr, project, derived);
    if (poly) best = { dr, poly };
  }
  return best;
}

// A free-standing column stays inside the room it stands in: it is moved (not resized) back inside
// the room's inner outline box; a column larger than that box keeps its centre inside it. In a room that is
// not a rectangle (an L) it is also pushed out of the notch (pushIntoPolygon); when no such place
// is found it stays where it is.
// The same holds for a free-standing stair (every type that keepsInRoom).
// Other free fixtures (a sink, a toilet …) are only kept off the diagonal walls of their room (they are
// not moved off h / v walls, as before): a box reaching across a slanted face is pushed back into the
// room the shortest way. Wall fixtures are returned unchanged. → fixture (the same object if unchanged)
// prev ({ project, derived, fixture? } before a geometry edit, optional): the column stays in the room
// it stood in before, also when the edit moved a wall past its centre (it would otherwise be left
// outside the room, or counted in the neighbouring one). prev.fixture: the column as it stood then,
// when `raw` has already been moved with its room (reconcileFixtures). prev.roomId: the room of its
// placement anchor (pin), which then decides.
export function keepColumnInRoom(project, derived, raw, prev = null) {
  const f = normalizeFixture(raw);
  if (!f || f.wall || !project || !derived) return raw;
  const column = keepsInRoom(f);
  if (!column && !(derived.rooms || []).some(hasSlantedSide)) return raw;
  let room = null;
  if (prev && typeof prev.roomId === 'string') {
    const dr = (derived.rooms || []).find((x) => x.roomId === prev.roomId);
    const poly = dr ? roomInnerPolygon(dr, project, derived) : null;
    if (poly) room = { dr, poly };
  }
  if (!room && prev && prev.project && prev.derived) {
    const was = prev.fixture ? normalizeFixture(prev.fixture) || f : f;
    const before = roomAround(prev.project, prev.derived, was);
    const dr = before && (derived.rooms || []).find((x) => x.roomId === before.dr.roomId);
    const poly = dr ? roomInnerPolygon(dr, project, derived) : null;
    if (poly) room = { dr, poly };
  }
  if (!room) room = roomAround(project, derived, f) || slantedRoomUnder(project, derived, f);
  if (!room) return raw;
  if (!column) return keepOffSlants(raw, f, room);
  // The inner outline box; along an axis a wrong value squeezed thinner than the walls, the centre-line
  // box (followBox, as the plan follower uses).
  const box = followBox(room.dr, project, derived);
  const { ex, ey } = fixtureExtents(f);
  // Along an axis the box is too small for (a measured size larger than the room, or a room a wrong
  // value squeezed), the centre only stays inside the box: where it stood relative to the room is kept,
  // so the column is back at its place when the value is corrected (it used to be centred, and stayed so).
  const fit = (c, half, lo, hi) => (hi - lo < 2 * half ? Math.min(hi, Math.max(lo, c)) : Math.min(hi - half, Math.max(lo + half, c)));
  let x = fit(f.x, ex / 2, box.minX, box.maxX), y = fit(f.y, ey / 2, box.minY, box.maxY);
  const tooBig = ex > box.maxX - box.minX + 1e-6 || ey > box.maxY - box.minY + 1e-6;
  if (!tooBig && !boxInsidePolygon(x, y, ex, ey, room.poly)) {
    // A room that is not a rectangle (an L): the box clamp may leave the column in the notch. Push
    // it off the room edges it crosses, the shortest way each time. When that goes round in
    // circles (a long stair over the notch, pushed off it into the outer wall and back), a stair
    // takes the nearest place where it fits (it fits in the other arm, and a 'does not fit' check
    // would be wrong); a column, like before, stays where it is and is reported — but inside the
    // room's outline box, not sticking out through an outer wall.
    // (A room with a diagonal side: its slanted faces too, pushIntoSlanted.)
    const push = hasSlantedSide(room.dr) ? pushIntoSlanted : pushIntoPolygon;
    const pushed = push(x, y, ex, ey, room.poly) || (isStair(f) ? nearestSpotInPolygon(f.x, f.y, ex, ey, room.poly) : null);
    if (pushed) ({ x, y } = pushed);
  }
  if (Math.abs(x - f.x) < 1e-6 && Math.abs(y - f.y) < 1e-6) return raw;
  return { ...raw, x, y };
}

// A free-standing column that does not fit inside the room it stands in (a measured size larger than
// the room, or an L-shaped room with no place for it): checks-full.js reports it.
// Also used for free-standing stairs.
//   → { roomId } | null (fits, a wall column, not a column / stair, or in no room)
export function freeColumnSticksOut(project, derived, raw) {
  const f = normalizeFixture(raw);
  if (!f || !keepsInRoom(f) || f.wall || !project || !derived) return null;
  const room = roomAround(project, derived, f);
  if (!room) return null;
  const { ex, ey } = fixtureExtents(f);
  return boxInsidePolygon(f.x, f.y, ex, ey, room.poly) ? null : { roomId: room.dr.roomId };
}

// True when the axis-aligned box (centre x, y; size ex × ey) lies inside the polygon: its corners
// inside or on the outline, and no outline vertex strictly inside the box (a notch corner).
function boxInsidePolygon(x, y, ex, ey, poly) {
  const tol = 0.5;
  const minX = x - ex / 2, maxX = x + ex / 2, minY = y - ey / 2, maxY = y + ey / 2;
  const corners = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  const onOutline = (p) => poly.some((q, i) => onSegment(p, q, poly[(i + 1) % poly.length]));
  if (!corners.every((p) => pointInPolygon(p, poly) || onOutline(p))) return false;
  return !poly.some((v) => v.x > minX + tol && v.x < maxX - tol && v.y > minY + tol && v.y < maxY - tol);
}

// A free fixture (not a column or stair) in a room with a diagonal side: when its box reaches across a
// slanted face of the room's inner outline (a sink dropped next to the diagonal wall, or a room the
// values reshaped), it is pushed back into the room (pushIntoSlanted). It stays axis-aligned. Nothing
// else changes (a box across an h / v face stays where it was put, as before). → fixture
function keepOffSlants(raw, f, room) {
  if (!hasSlantedSide(room.dr)) return raw;
  const { ex, ey } = fixtureExtents(f);
  const poly = room.poly;
  if (!poly.some((P, i) => isSlanted(P, poly[(i + 1) % poly.length])
    && slantPenetration(f.x, f.y, ex, ey, P, poly[(i + 1) % poly.length], poly))) return raw;
  const at = pushIntoSlanted(f.x, f.y, ex, ey, poly);
  if (!at || (Math.abs(at.x - f.x) < 1e-6 && Math.abs(at.y - f.y) < 1e-6)) return raw;
  return { ...raw, x: at.x, y: at.y };
}

// A fixture whose centre lies on no room (dropped right on a diagonal wall's line): the room with a
// diagonal side that holds most of its box (sampled), with that room's inner outline. → { dr, poly } | null
function slantedRoomUnder(project, derived, f) {
  const { ex, ey } = fixtureExtents(f);
  let best = null, bestN = 0;
  for (const dr of (derived && derived.rooms) || []) {
    const pts = dr && dr.face && dr.face.points;
    if (!hasSlantedSide(dr) || !Array.isArray(pts) || pts.length < 3) continue;
    let n = 0;
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        if (pointInPolygon({ x: f.x - ex / 2 + (ex * i) / 4, y: f.y - ey / 2 + (ey * j) / 4 }, pts)) n++;
      }
    }
    if (n > bestN) {
      const poly = roomInnerPolygon(dr, project, derived);
      if (poly) { best = { dr, poly }; bestN = n; }
    }
  }
  return best;
}

// A derived room with a diagonal side.
function hasSlantedSide(dr) {
  return !!(dr && Array.isArray(dr.sides) && dr.sides.some((s) => s && s.orient === 'd'));
}

// How far the box (centre x, y; ex × ey) reaches across the slanted face P→Q of the polygon, when it
// really reaches across that face (its deepest corner beside the face, or the face running through the
// box — not only across the face's line, which in a room with a bay runs through the room).
// → { depth (mm), m (unit normal into the room) } | null
function slantPenetration(x, y, ex, ey, P, Q, poly) {
  const L = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (!(L > 1e-6)) return null;
  const dir = { x: (Q.x - P.x) / L, y: (Q.y - P.y) / L };
  let m = { x: -dir.y, y: dir.x };
  const probe = { x: (P.x + Q.x) / 2 + m.x * 0.5, y: (P.y + Q.y) / 2 + m.y * 0.5 };
  if (!pointInPolygon(probe, poly)) m = { x: -m.x, y: -m.y };
  const hx = ex / 2, hy = ey / 2;
  let depth = 0, deep = null;
  for (const c of [{ x: x - hx, y: y - hy }, { x: x + hx, y: y - hy }, { x: x + hx, y: y + hy }, { x: x - hx, y: y + hy }]) {
    const s = (c.x - P.x) * m.x + (c.y - P.y) * m.y;
    if (-s > depth) { depth = -s; deep = c; }
  }
  if (!deep || depth <= 0.5) return null;
  const along = (deep.x - P.x) * dir.x + (deep.y - P.y) * dir.y;
  if (!(along > 0 && along < L) && !segmentCrossesBox(P, Q, { minX: x - hx, minY: y - hy, maxX: x + hx, maxY: y + hy })) return null;
  return { depth, m };
}

// True when the segment a–b passes through the box (Liang–Barsky).
function segmentCrossesBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

// pushIntoPolygon for an outline with slanted faces (a room with a diagonal wall): each round collects
// the shifts that clear one face the box reaches across — along an h / v face's normal; for a slanted
// face along its normal and along x or y alone — and takes the shortest that puts the box inside, else
// the shortest one and goes on (in an acute corner the box slides along the h / v face it stands at).
function pushIntoSlanted(x, y, ex, ey, poly) {
  const tol = 0.5;
  for (let round = 0; round < 12; round++) {
    if (boxInsidePolygon(x, y, ex, ey, poly)) return { x, y };
    const minX = x - ex / 2, maxX = x + ex / 2, minY = y - ey / 2, maxY = y + ey / 2;
    const cands = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const vertical = Math.abs(P.x - Q.x) < tol, horizontal = Math.abs(P.y - Q.y) < tol;
      if (vertical) {
        const lo = Math.min(P.y, Q.y), hi = Math.max(P.y, Q.y);
        if (Math.min(hi, maxY) - Math.max(lo, minY) <= tol || !(minX < P.x - tol && maxX > P.x + tol)) continue;
        const inRight = pointInPolygon({ x: P.x + 1, y: (lo + hi) / 2 }, poly);
        cands.push({ x: inRight ? P.x - minX : P.x - maxX, y: 0 });
      } else if (horizontal) {
        const lo = Math.min(P.x, Q.x), hi = Math.max(P.x, Q.x);
        if (Math.min(hi, maxX) - Math.max(lo, minX) <= tol || !(minY < P.y - tol && maxY > P.y + tol)) continue;
        const inBelow = pointInPolygon({ x: (lo + hi) / 2, y: P.y + 1 }, poly);
        cands.push({ x: 0, y: inBelow ? P.y - minY : P.y - maxY });
      } else {
        const pen = slantPenetration(x, y, ex, ey, P, Q, poly);
        if (!pen) continue;
        const d = pen.depth + 1e-3;
        cands.push({ x: pen.m.x * d, y: pen.m.y * d });
        if (Math.abs(pen.m.x) > 0.15) cands.push({ x: d / pen.m.x, y: 0 });
        if (Math.abs(pen.m.y) > 0.15) cands.push({ x: 0, y: d / pen.m.y });
      }
    }
    if (!cands.length) return null;
    cands.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));
    const ok = cands.find((c) => boxInsidePolygon(x + c.x, y + c.y, ex, ey, poly));
    if (ok) return { x: x + ok.x, y: y + ok.y };
    x += cands[0].x;
    y += cands[0].y;
  }
  return boxInsidePolygon(x, y, ex, ey, poly) ? { x, y } : null;
}

// Move the box (centre x, y; ex × ey) off the axis-aligned polygon edges that cut through it: each
// round takes the shortest shift that puts the box on the room side of one crossing edge. (A room with
// a diagonal side uses pushIntoSlanted; an h / v room's outline can still have a slanted piece where a
// dangling wall turns back, which this keeps ignoring as before.)
// → { x, y } inside the polygon | null
function pushIntoPolygon(x, y, ex, ey, poly) {
  const tol = 0.5;
  for (let round = 0; round < 8; round++) {
    if (boxInsidePolygon(x, y, ex, ey, poly)) return { x, y };
    const minX = x - ex / 2, maxX = x + ex / 2, minY = y - ey / 2, maxY = y + ey / 2;
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const vertical = Math.abs(P.x - Q.x) < tol, horizontal = Math.abs(P.y - Q.y) < tol;
      if (vertical) {
        const lo = Math.min(P.y, Q.y), hi = Math.max(P.y, Q.y);
        if (Math.min(hi, maxY) - Math.max(lo, minY) <= tol || !(minX < P.x - tol && maxX > P.x + tol)) continue;
        const inRight = pointInPolygon({ x: P.x + 1, y: (lo + hi) / 2 }, poly);
        const dx = inRight ? P.x - minX : P.x - maxX;
        if (!best || Math.abs(dx) < Math.abs(best.d)) best = { d: dx, axis: 'x' };
      } else if (horizontal) {
        const lo = Math.min(P.x, Q.x), hi = Math.max(P.x, Q.x);
        if (Math.min(hi, maxX) - Math.max(lo, minX) <= tol || !(minY < P.y - tol && maxY > P.y + tol)) continue;
        const inBelow = pointInPolygon({ x: (lo + hi) / 2, y: P.y + 1 }, poly);
        const dy = inBelow ? P.y - minY : P.y - maxY;
        if (!best || Math.abs(dy) < Math.abs(best.d)) best = { d: dy, axis: 'y' };
      }
    }
    if (!best) return null;
    if (best.axis === 'x') x += best.d; else y += best.d;
  }
  return boxInsidePolygon(x, y, ex, ey, poly) ? { x, y } : null;
}

// The centre nearest to (x, y) at which the box ex × ey lies inside the axis-aligned polygon. The
// places where the box can stand form an axis-aligned region whose edges are at the polygon's
// vertex coordinates ± half the box, so the nearest place keeps a coordinate or puts a box edge on
// a vertex coordinate. → { x, y } | null (it fits nowhere)
function nearestSpotInPolygon(x, y, ex, ey, poly) {
  const xs = [x, ...poly.flatMap((v) => [v.x + ex / 2, v.x - ex / 2])];
  const ys = [y, ...poly.flatMap((v) => [v.y + ey / 2, v.y - ey / 2])];
  let best = null, bestD = Infinity;
  for (const cx of xs) {
    for (const cy of ys) {
      const dd = Math.hypot(cx - x, cy - y);
      if (dd >= bestD || !boxInsidePolygon(cx, cy, ex, ey, poly)) continue;
      best = { x: cx, y: cy };
      bestD = dd;
    }
  }
  return best;
}

// A box being resized (moved edges per `moved(key)`) in a room that is not a rectangle: each moved
// edge stops at the first room edge it would cross, seen from the edge that stays (the unmoved part
// is inside the room). r: { minX, minY, maxX, maxY }, changed in place.
function limitMovedInPolygon(r, moved, poly) {
  const tol = 0.5;
  for (const axis of ['x', 'y']) {
    const lo = axis === 'x' ? 'minX' : 'minY', hi = axis === 'x' ? 'maxX' : 'maxY';
    const olo = axis === 'x' ? 'minY' : 'minX', ohi = axis === 'x' ? 'maxY' : 'maxX';
    const other = axis === 'x' ? 'y' : 'x';
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      if (Math.abs(P[axis] - Q[axis]) > tol) continue;           // not across this axis
      const a = Math.min(P[other], Q[other]), b = Math.max(P[other], Q[other]);
      if (Math.min(b, r[ohi]) - Math.max(a, r[olo]) <= tol) continue;
      const c = P[axis];
      if (moved(hi) && !moved(lo) && c > r[lo] + tol && c < r[hi] - tol) r[hi] = c;
      if (moved(lo) && !moved(hi) && c < r[hi] - tol && c > r[lo] + tol) r[lo] = c;
    }
  }
}

function onSegment(p, a, b) {
  const minX = Math.min(a.x, b.x) - 0.01, maxX = Math.max(a.x, b.x) + 0.01;
  const minY = Math.min(a.y, b.y) - 0.01, maxY = Math.max(a.y, b.y) + 0.01;
  if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= 0.01 * Math.hypot(b.x - a.x, b.y - a.y);
}

// Which sides of a fixture (in world directions) are flush against something and must not move when
// it is resized: the back of a wall fixture, and an end that touches a corner of its room side
// (a corner column has two). → { left, right, top, bottom } booleans
export function fixtureFlushSides(project, derived, raw) {
  const out = { left: false, right: false, top: false, bottom: false };
  const f = normalizeFixture(raw);
  if (!f || !f.wall || !project) return out;
  const e = (project.edges || []).find((x) => x.id === f.wall);
  if (!e || (e.orient !== 'h' && e.orient !== 'v')) return out;
  if ((normalizeRot(f.rot) % 180 === 0) !== (e.orient === 'h')) return out;
  const { n } = fixtureFrame(f.rot);
  const dirName = (v) => (v.x < -0.5 ? 'left' : v.x > 0.5 ? 'right' : v.y < -0.5 ? 'top' : 'bottom');
  out[dirName(n)] = true;
  const key = e.orient === 'h' ? 'x' : 'y';
  const rs = derived ? fixtureRoomSide(project, derived, f) : null;
  const lim = rs || wallEndFaces(project, derived, e, sideFromRot(f.rot));
  if (lim) {
    const lowName = key === 'x' ? 'left' : 'top', highName = key === 'x' ? 'right' : 'bottom';
    if (isFinite(lim.lo) && Math.abs(f[key] - f.w / 2 - lim.lo) <= FLUSH_TOL) out[lowName] = true;
    if (isFinite(lim.hi) && Math.abs(f[key] + f.w / 2 - lim.hi) <= FLUSH_TOL) out[highName] = true;
  }
  return out;
}

// Snap a dragged size to the resize step, never below the minimum.
export function snapResizeSize(mm) {
  const v = Math.round(mm / RESIZE_STEP_MM) * RESIZE_STEP_MM;
  return Math.min(MAX_FIXTURE_MM, Math.max(MIN_FIXTURE_MM, v));
}

// A fixture resized to the world box { minX, minY, maxX, maxY } (a handle drag): the rotation and
// the wall stay; a size that changed becomes a DRAWN size (measured false, no number in the
// label). A wall fixture keeps its back on its wall and stays inside its room side (the moved end
// stops at the corner), a column also inside the room in front of it; a free column inside its
// room. → fixture (normalized fields plus whatever else the record holds)
export function resizeFixtureBox(project, derived, raw, box) {
  const f = normalizeFixture(raw);
  if (!f || !box) return raw;
  let { minX, minY, maxX, maxY } = box;
  if (![minX, minY, maxX, maxY].every(isNum)) return raw;
  // Only the edges the drag moved are limited: an edge that stays where it was (a measured sink
  // longer than its side, centred past both corners) must not be pulled in and lose its size.
  const cur = fixtureBounds(f);
  const r = { minX, minY, maxX, maxY };
  const moved = (k) => Math.abs(r[k] - cur[k]) > 0.5;
  const limit = (k, v, upper) => {
    if (!moved(k) || !isFinite(v)) return;
    r[k] = upper ? Math.min(r[k], v) : Math.max(r[k], v);
  };
  const rs = f.wall ? fixtureRoomSide(project, derived, f) : null;
  if (rs) {
    // The along-wall range stays between the side's two inner corners.
    const lo = rs.key === 'x' ? 'minX' : 'minY', hi = rs.key === 'x' ? 'maxX' : 'maxY';
    limit(lo, rs.lo, false);
    limit(hi, rs.hi, true);
    if (keepsInRoom(f)) {
      // The front edge of a wall column (or stair) stops at the room's opposite inner face (it would
      // otherwise be shortened by fitFixtureOnSide and remember the overshoot as fullD).
      const avail = depthInRoom(project, derived, rs, r[lo], r[hi]);
      if (isFinite(avail)) {
        const front = rs.face + rs.side * avail;
        const c0 = rs.cross === 'x' ? 'minX' : 'minY', c1 = rs.cross === 'x' ? 'maxX' : 'maxY';
        if (rs.side > 0) limit(c1, front, true); else limit(c0, front, false);
      }
    }
  } else if (!f.wall && keepsInRoom(f)) {
    // A free column / stair: the moved edges stop at its room's inner outline box (the fixed edges stay).
    const room = roomAround(project, derived, f);
    if (room) {
      const xs = room.poly.map((p) => p.x), ys = room.poly.map((p) => p.y);
      limit('minX', Math.min(...xs), false);
      limit('maxX', Math.max(...xs), true);
      limit('minY', Math.min(...ys), false);
      limit('maxY', Math.max(...ys), true);
      // An L-shaped room: the moved edges also stop at the notch (the outline box alone would let
      // a stair in one arm be dragged into the notch, and keepColumnInRoom would then shift it).
      const w0 = r.maxX - r.minX, h0 = r.maxY - r.minY;
      if (!boxInsidePolygon((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2, w0, h0, room.poly)) {
        limitMovedInPolygon(r, moved, room.poly);
      }
    }
  }
  ({ minX, minY, maxX, maxY } = r);
  const across = f.rot % 180 === 0;
  const ex = Math.max(MIN_FIXTURE_MM, maxX - minX), ey = Math.max(MIN_FIXTURE_MM, maxY - minY);
  const w = across ? ex : ey, d = across ? ey : ex;
  const measured = { w: f.measured.w && Math.abs(w - f.w) < 0.5, d: f.measured.d && Math.abs(d - f.d) < 0.5 };
  // Resized by hand: its size and place are chosen now, so the drop place (dropShare) is dropped.
  let nf = {
    ...raw, ...f,
    x: (minX + maxX) / 2, y: (minY + maxY) / 2,
    w: measured.w ? f.w : w, d: measured.d ? f.d : d,
    measured,
    fullW: Math.abs(w - f.w) < 0.5 ? f.fullW : null,
    dropShare: ['minX', 'minY', 'maxX', 'maxY'].some(moved) ? undefined : f.dropShare,
  };
  if (keepsInRoom(f)) nf.fullD = Math.abs(d - f.d) < 0.5 ? (f.fullD ?? null) : null;
  if (nf.wall) nf = fitFixtureOnSide(project, derived, { ...nf, along: null });
  else nf = keepColumnInRoom(project, derived, nf);
  return nf;
}

// ---- edits ---------------------------------------------------------------------------------------

// Along-wall coordinate of the fixture end that is anchored when its length changes: the end
// nearest to a corner of its room side (else an end of its wall), so a sink in a corner stays in
// the corner. → 'lo' | 'hi' | null
function anchoredEnd(project, f, derived = null) {
  if (!f.wall) return null;
  const e = (project.edges || []).find((x) => x.id === f.wall);
  if (!e || (e.orient !== 'h' && e.orient !== 'v')) return null;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const A = nodes.get(e.a), B = nodes.get(e.b);
  if (!A || !B) return null;
  const h = e.orient === 'h';
  const rs = derived ? fixtureRoomSide(project, derived, f) : null;
  const ends = rs ? [rs.lo, rs.hi] : [h ? A.x : A.y, h ? B.x : B.y];
  const s = h ? f.x : f.y;
  const lo = s - f.w / 2, hi = s + f.w / 2;
  const dLo = Math.min(...ends.map((c) => Math.abs(lo - c)));
  const dHi = Math.min(...ends.map((c) => Math.abs(hi - c)));
  return dLo <= dHi ? 'lo' : 'hi';
}

// Resize keeping the back face in place, and (for a wall fixture) the end near its corner.
export function resizeFixture(project, f, w, d, derived = null) {
  const nf = { ...f, w, d };
  const { n } = fixtureFrame(f.rot);
  // Back face stays: centre moves along -n by (d - f.d) / 2.
  const dd = (d - f.d) / 2;
  nf.x -= n.x * dd;
  nf.y -= n.y * dd;
  if (w !== f.w && f.wall) {
    const end = anchoredEnd(project, f, derived);
    const e = project.edges.find((x) => x.id === f.wall);
    const key = e.orient === 'h' ? 'x' : 'y';
    if (end === 'lo') nf[key] = f[key] - f.w / 2 + w / 2;
    else if (end === 'hi') nf[key] = f[key] + f.w / 2 - w / 2;
  }
  return nf;
}

// ---- keeping fixtures on their walls -------------------------------------------------------------

// After a solve (or any geometry edit), keep every wall-snapped fixture on its wall and inside the
// room side it stands on (fitFixtureOnSide): its relative position along the side (`along`) stays,
// the back touches the (possibly moved, possibly thicker) inner face. If the wall was deleted, the
// fixture stays where it is and becomes free-standing; if the wall was split or re-joined, it
// re-snaps to the wall behind it.
// A free-standing fixture (any type) follows the plan as well (review 예시 세대 A #19: a 세면대 put away from
// the walls of 화장실1 on the sketch ended 256 mm inside the outer wall after the values): it is put
// where its placement anchor (`pin`, taken in the plan as it was when the fixture was put there) says
// in the new plan — its centre at the same relative place in its room's follow box (a side it was
// against stays against it, and a fixture that was inside that box stays inside), and outside every
// room in the box of the plan's corners. So the result depends only on the plan the values give, not
// on their order (review 예시 세대 A round 2: a stair in 방1 ended 300 mm off in one entry order). When the
// edit changed that room (or the plan's corners) itself, the incremental follower moves it once
// (planFollower) and a new anchor is taken next time. A free column or stair is then kept inside its
// room as before (keepColumnInRoom, the last correction). Without prevDerived (a fresh re-derive:
// 도면 돌리기, which turns the anchors with the plan) nothing follows.
//   prev, next: projects before and after; nextDerived: the derived data of `next` (thickness).
// → fixtures array (the same array when nothing changed)
export function reconcileFixtures(prev, next, nextDerived = null, prevDerived = null) {
  const list = (next && next.fixtures) || [];
  if (!list.length) return list;
  const prevEdges = new Map(((prev && prev.edges) || []).map((e) => [e.id, e]));
  const prevNodes = new Map(((prev && prev.nodes) || []).map((n) => [n.id, n]));
  const nextEdges = new Map((next.edges || []).map((e) => [e.id, e]));
  const nextNodes = new Map((next.nodes || []).map((n) => [n.id, n]));
  const follow = prevDerived && nextDerived && list.some((r) => r && !r.wall)
    ? planFollower(prev, prevDerived, next, nextDerived) : null;
  let changed = false;
  const out = list.map((raw) => {
    const f = normalizeFixture(raw);
    if (!f) return raw;
    if (!f.wall) {
      const kept = followFreeFixture(raw, f, prev, prevDerived, next, nextDerived, follow);
      if (kept !== raw) changed = true;
      return kept;
    }
    const pe = prevEdges.get(f.wall), ne = nextEdges.get(f.wall);
    if (!ne) {
      changed = true;
      return { ...raw, wall: null, dropShare: undefined };
    }
    const sameEnds = pe && pe.a === ne.a && pe.b === ne.b && pe.orient === ne.orient
      && prevNodes.get(pe.a) && prevNodes.get(pe.b);
    let res;
    if (sameEnds && (ne.orient === 'h' || ne.orient === 'v')) {
      res = followWall(raw, f, pe, ne, prevNodes, nextNodes, nextDerived, next);
    } else {
      // An in-wall fixture is looked up from in front of its wall (its centre may lie on the wall's
      // line, which would leave the side of the wall unknown).
      const { n } = fixtureFrame(f.rot);
      const probe = f.inWall ? { x: f.x - n.x * f.d, y: f.y - n.y * f.d } : { x: f.x, y: f.y };
      const s = snapFixture(next, nextDerived, f, probe, { snapMM: Math.max(200, f.d), rot: f.rot, corner: false });
      // The drop place goes along to the wall piece it now stands on (counted along that piece's own
      // a → b direction).
      const ns = s.wall ? nextEdges.get(s.wall) : null;
      let share = f.dropShare;
      if (share != null && pe && ns && prevNodes.get(pe.a) && prevNodes.get(pe.b)) {
        const key = ns.orient === 'h' ? 'x' : 'y';
        const lowToHigh = edgeRunsUp(prev, pe, key) ? share : 1 - share;
        share = edgeRunsUp(next, ns, key) ? lowToHigh : 1 - lowToHigh;
      } else {
        share = undefined;
      }
      res = s.wall
        ? fitFixtureOnSide(next, nextDerived, { ...raw, x: s.x, y: s.y, wall: s.wall, along: null, dropShare: share })
        : { ...raw, wall: null, dropShare: undefined };
    }
    if (!res || res === raw) return raw;
    changed = true;
    return res;
  });
  return changed ? out : list;
}

// A free-standing fixture moved with its room (see reconcileFixtures). → fixture (raw when unmoved)
function followFree(raw, f, follow) {
  if (!follow) return raw;
  const m = follow.at({ x: f.x, y: f.y });
  if (!m) return raw;
  let { x, y } = m.map({ x: f.x, y: f.y });
  if (m.roomId != null) {
    const b = fixtureBounds(f), b0 = m.box0, b1 = m.box1;
    const tol = 1;
    const hx = (b.maxX - b.minX) / 2, hy = (b.maxY - b.minY) / 2;
    // A box now too small for the fixture (a wrong value squeezed the room) keeps the mapped centre,
    // i.e. its relative place, so the fixture gets its place back when the value is corrected.
    const fit = (c, half, lo, hi) => (hi - lo < 2 * half ? c : Math.min(hi - half, Math.max(lo + half, c)));
    // Per axis: against a side of the box → still against it; inside the box → still inside. Along an
    // axis the new box is too small for (a wrong value squeezed the room) only the relative place is
    // kept: pushed against a side there, a stair came back against the opposite one once corrected.
    const small = (half, lo, hi) => hi - lo < 2 * half;
    if (small(hx, b1.minX, b1.maxX)) { /* the mapped centre */ }
    else if (Math.abs(b.minX - b0.minX) <= tol) x = b1.minX + hx;
    else if (Math.abs(b.maxX - b0.maxX) <= tol) x = b1.maxX - hx;
    else if (b.minX >= b0.minX - tol && b.maxX <= b0.maxX + tol) x = fit(x, hx, b1.minX, b1.maxX);
    if (small(hy, b1.minY, b1.maxY)) { /* the mapped centre */ }
    else if (Math.abs(b.minY - b0.minY) <= tol) y = b1.minY + hy;
    else if (Math.abs(b.maxY - b0.maxY) <= tol) y = b1.maxY - hy;
    else if (b.minY >= b0.minY - tol && b.maxY <= b0.maxY + tol) y = fit(y, hy, b1.minY, b1.maxY);
  }
  if (Math.abs(x - f.x) < 1e-6 && Math.abs(y - f.y) < 1e-6) return raw;
  return { ...raw, x, y };
}

// A free-standing fixture after a re-derive (see reconcileFixtures): placed by its anchor, else moved
// once by the incremental follower; a column or stair then kept inside its room. → fixture (raw when
// it stays where it is; an anchor taken now is only stored when the fixture moves)
function followFreeFixture(raw, f, prev, prevDerived, next, nextDerived, follow) {
  const unmoved = (g) => Math.abs(g.x - f.x) < 1e-6 && Math.abs(g.y - f.y) < 1e-6;
  if (!prevDerived || !nextDerived) {
    // A fresh re-derive (도면 돌리기 turned the fixture and its anchor together): only kept in its room;
    // an anchor that belonged to the fixture still does.
    const kept = keepColumnInRoom(next, nextDerived, raw, null);
    if (kept === raw || unmoved(normalizeFixture(kept) || f)) return raw;
    return f.pin && pinInSync(f.pin, f) ? { ...kept, pin: { ...f.pin, x: kept.x, y: kept.y } } : kept;
  }
  const before = { project: prev, derived: prevDerived, fixture: raw };
  // The stored anchor while it belongs to the fixture as it stood before this edit; else one taken
  // now, from that plan (the fixture was put, moved, turned or resized since the last re-derive, or the
  // record is older than anchors).
  let pin = f.pin && pinInSync(f.pin, f) ? f.pin : null;
  if (!pin) pin = fixturePinOf(prev, prevDerived, f);
  if (pin && anchorStable(pin.roomId, prev, prevDerived, next, nextDerived)) {
    const at = placeFromPin(pin, f, next, nextDerived);
    if (at) {
      const moved = unmoved(at) ? raw : { ...raw, x: at.x, y: at.y };
      const kept = keepColumnInRoom(next, nextDerived, moved, { ...before, roomId: pin.roomId == null ? undefined : pin.roomId });
      if (unmoved(kept)) return raw;
      return { ...kept, pin: { ...pin, x: kept.x, y: kept.y } };
    }
  }
  // The edit changed the anchor's room (or the plan's corners): the incremental follower, once; the
  // anchor no longer applies.
  const kept = keepColumnInRoom(next, nextDerived, followFree(raw, f, follow), before);
  if (raw.pin == null) return kept;
  const out = { ...kept };
  delete out.pin;
  return out;
}

// ---- placement anchors ---------------------------------------------------------------------------------
//
// What the surveyor puts on the sketch away from the walls keeps the place it was put at as the values
// reshape the plan: free fixtures, columns and stairs (`pin` above), the memo (memo.js) and room names
// moved by hand (labels.js). The place is an anchor in a frame — the follow box of the room it is in
// (followBox), or the box of every corner of the plan when it is in no room (roomId null) — taken in
// the plan as it was when the item was put there; every re-derive computes the position from the anchor
// and the frame in the NEW plan. Typing the values one after another therefore gives the same result in
// any order (an incremental follower, mapping from the previous solve, lost the place of a stair whose
// room was briefly narrower than the stair partway through). A frame counts while it is the same: the
// room with the same corners, the plan with the same corners (anchorStable); an edit that changes it (a
// wall drawn through the room, a wall drawn further out) moves the item once with planFollower, and the
// anchor is taken again afterwards.

// The frame a point is anchored in: the smallest room around it, else the plan.
// → { roomId (null = the plan), box } | null (nothing drawn)
export function anchorFrameAt(project, derived, p) {
  let best = null;
  for (const dr of (derived && derived.rooms) || []) {
    const pts = dr && dr.face && dr.face.points;
    if (!Array.isArray(pts) || pts.length < 3 || !pointInPolygon(p, pts)) continue;
    if (best && !((dr.area || Infinity) < (best.area || Infinity))) continue;
    best = dr;
  }
  if (best) return { roomId: best.roomId, box: followBox(best, project, derived) };
  const box = planCornerBox(project);
  return box ? { roomId: null, box } : null;
}

// The box of a frame in a plan. → { minX, minY, maxX, maxY } | null (the room is gone)
export function anchorBox(project, derived, roomId) {
  if (roomId == null) return planCornerBox(project);
  const dr = ((derived && derived.rooms) || []).find((r) => r && r.roomId === roomId);
  if (!dr || !dr.face || !Array.isArray(dr.face.points) || dr.face.points.length < 3) return null;
  return followBox(dr, project, derived);
}

// True when a frame is the same before and after an edit: the room has the same corners, or (the plan)
// the same corners exist.
export function anchorStable(roomId, prevProject, prevDerived, nextProject, nextDerived) {
  if (roomId == null) return !!planCornerBox(prevProject) && !!planCornerBox(nextProject) && nodeIdsOf(prevProject) === nodeIdsOf(nextProject);
  const find = (d) => ((d && d.rooms) || []).find((r) => r && r.roomId === roomId);
  const a = find(prevDerived), b = find(nextDerived);
  return !!(a && b && a.face && b.face && Array.isArray(b.face.points) && b.face.points.length >= 3 && sameCorners(a.face, b.face));
}

function planCornerBox(project) {
  const pts = ((project && project.nodes) || []).filter((n) => n && isNum(n.x) && isNum(n.y));
  if (!pts.length) return null;
  const b = pointsBox(pts);
  return b.maxX - b.minX > 1 && b.maxY - b.minY > 1 ? b : null;
}

function nodeIdsOf(project) {
  return ((project && project.nodes) || []).map((n) => n && n.id).filter((id) => typeof id === 'string').sort().join(',');
}

const PIN_KEEP = ['lo', 'hi', 'in', 'c'];

// A fixture standing against a wall keeps its place by `along`; the anchor it had while it stood free no
// longer belongs to it, and a file drops it (normalizeFixture). The commands that leave a fixture on a wall
// drop it too, so the household opened from its file is the household as stored (round-trip check
// 2026-10-24). → the fixture (the same object when there is nothing to drop)
function withoutWallPin(f) {
  if (!f || !f.wall || !('pin' in f)) return f;
  const { pin: _pin, ...rest } = f;
  return rest;
}

// A fixture's anchor from a file or a record, checked. → pin | null
function cleanFixturePin(p) {
  if (!p || typeof p !== 'object') return null;
  if (!(p.roomId === null || (typeof p.roomId === 'string' && p.roomId))) return null;
  if (![p.u, p.v, p.x, p.y, p.ex, p.ey].every(isNum)) return null;
  return {
    roomId: p.roomId, u: p.u, v: p.v,
    kx: PIN_KEEP.includes(p.kx) ? p.kx : 'c', ky: PIN_KEEP.includes(p.ky) ? p.ky : 'c',
    x: p.x, y: p.y, ex: p.ex, ey: p.ey,
  };
}

// True while the anchor belongs to the fixture as it stands (same centre, same plan size).
function pinInSync(pin, f) {
  const { ex, ey } = fixtureExtents(f);
  const tol = 1e-3;
  return Math.abs(pin.x - f.x) <= tol && Math.abs(pin.y - f.y) <= tol && Math.abs(pin.ex - ex) <= tol && Math.abs(pin.ey - ey) <= tol;
}

// The anchor of a free-standing fixture as it stands in this plan. → pin | null (nothing drawn)
function fixturePinOf(project, derived, f) {
  const fr = anchorFrameAt(project, derived, { x: f.x, y: f.y });
  if (!fr) return null;
  const { box } = fr;
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  if (!(w > 1 && h > 1)) return null;
  const b = fixtureBounds(f);
  const { ex, ey } = fixtureExtents(f);
  // Per axis: against one side of the box, inside it, or (larger than the box, sticking out) neither.
  const keep = (lo, hi, blo, bhi) => {
    const tol = 1;
    if (hi - lo < bhi - blo - 1e-6) return 'c';
    const atLo = Math.abs(blo - lo) <= tol, atHi = Math.abs(bhi - hi) <= tol;
    if (atLo && !atHi) return 'lo';
    if (atHi && !atLo) return 'hi';
    return blo >= lo - tol && bhi <= hi + tol ? 'in' : 'c';
  };
  return {
    roomId: fr.roomId, u: (f.x - box.minX) / w, v: (f.y - box.minY) / h,
    kx: keep(box.minX, box.maxX, b.minX, b.maxX), ky: keep(box.minY, box.maxY, b.minY, b.maxY),
    x: f.x, y: f.y, ex, ey,
  };
}

// Where the anchor puts the fixture in this plan. Along an axis its box is now too small for, only the
// relative place of the centre is kept. → { x, y } | null (the room is gone)
function placeFromPin(pin, f, project, derived) {
  const box = anchorBox(project, derived, pin.roomId);
  if (!box) return null;
  const { ex, ey } = fixtureExtents(f);
  const axis = (keep, t, lo, hi, half) => {
    const c = lo + t * (hi - lo);
    if (hi - lo < 2 * half - 1e-6) return c;
    if (keep === 'lo') return lo + half;
    if (keep === 'hi') return hi - half;
    if (keep === 'in') return Math.min(hi - half, Math.max(lo + half, c));
    return c;
  };
  return { x: axis(pin.kx, pin.u, box.minX, box.maxX, ex / 2), y: axis(pin.ky, pin.v, box.minY, box.maxY, ey / 2) };
}
// (도면 돌리기 turns these anchors with the plan: core/rotate.js.)

// ---- following the plan (memo, free fixtures, texts moved by hand) ------------------------------------

// How world points move when a re-derive reshapes the plan (values typed, a corner dragged): a point
// inside a room keeps its relative place (u, v) in that room's inner outline box (wall faces plus
// finishes, as the sides are measured), anywhere else in the box of the plan's corners. A room counts
// only when it is the same face before and after (the same corner nodes); a room that was split or
// merged by the edit falls back to the plan's box. The plan's box is taken over the corners that exist
// both before and after, so a wall drawn further out does not stretch what is already there.
//   → null when no corner moved (nothing to follow), else
//     { at(point) → mapping, room(roomId) → mapping | null, plan: mapping }
//     mapping = { map(point) → point, s (uniform scale: √(sx·sy)), sx, sy, box0, box1, roomId | null }
// Used by fixtures.js (free fixtures), memo.js (handwriting) and ui/wiring.js (room names moved by
// hand) in DocStore.deriveHooks: since review round 2 only for the one step where an edit changed the
// room an item is anchored in (the placement anchors below decide everywhere else), and for the room
// boxes (box0 / box1) the moved room names are anchored in.
export function planFollower(prevProject, prevDerived, nextProject, nextDerived) {
  if (!prevProject || !prevDerived || !nextProject || !nextDerived) return null;
  const before = new Map((prevProject.nodes || []).map((n) => [n.id, n]));
  const b0 = emptyBox(), b1 = emptyBox();
  let moved = false;
  for (const n of nextProject.nodes || []) {
    const o = before.get(n.id);
    if (!o || !isNum(o.x) || !isNum(n.x)) continue;
    growBox(b0, o); growBox(b1, n);
    if (Math.abs(o.x - n.x) > 1e-6 || Math.abs(o.y - n.y) > 1e-6) moved = true;
  }
  if (!moved || !isFinite(b0.minX)) return null;
  const plan = { ...boxMapping(b0, b1), roomId: null };
  const rooms0 = (prevDerived.rooms || []).filter((dr) => dr && dr.face && Array.isArray(dr.face.points) && dr.face.points.length >= 3);
  const rooms1 = new Map((nextDerived.rooms || []).map((dr) => [dr.roomId, dr]));
  const cache = new Map();
  const roomMap = (dr0) => {
    if (cache.has(dr0.roomId)) return cache.get(dr0.roomId);
    let m = null;
    const dr1 = rooms1.get(dr0.roomId);
    if (dr1 && dr1.face && sameCorners(dr0.face, dr1.face)) {
      m = { ...boxMapping(followBox(dr0, prevProject, prevDerived), followBox(dr1, nextProject, nextDerived)), roomId: dr0.roomId };
    }
    cache.set(dr0.roomId, m);
    return m;
  };
  return {
    plan,
    room(roomId) {
      const dr0 = rooms0.find((dr) => dr.roomId === roomId);
      return dr0 ? roomMap(dr0) : null;
    },
    at(p) {
      let best = null;
      for (const dr of rooms0) {
        if (!pointInPolygon(p, dr.face.points)) continue;
        if (best && !((dr.area || Infinity) < (best.area || Infinity))) continue;
        best = dr;
      }
      return (best && roomMap(best)) || plan;
    },
  };
}

// The box a room's contents keep their (u, v) in: its inner box (wall faces and finishes), cut to the
// room's centre-line box. A wrong value can squeeze a room thinner than its walls (예시 세대 A sweep: 주방 4000
// instead of 400 left 화장실1 100 mm wide); its inner outline then collapses to a line, the memo in it
// was mapped out of the room, and it stayed out when the value was corrected (a point in no room
// follows the whole plan). Along such an axis the centre-line box is used, so the point stays inside
// its room and gets its place back with the room.
const FOLLOW_MIN_MM = 50;
function followBox(dr, project, derived) {
  const face = pointsBox(dr.face.points);
  const q = roomInnerPolygon(dr, project, derived);
  if (!q) return face;
  const b = pointsBox(q);
  const out = {
    minX: Math.max(b.minX, face.minX), maxX: Math.min(b.maxX, face.maxX),
    minY: Math.max(b.minY, face.minY), maxY: Math.min(b.maxY, face.maxY),
  };
  if (!(out.maxX - out.minX >= FOLLOW_MIN_MM)) { out.minX = face.minX; out.maxX = face.maxX; }
  if (!(out.maxY - out.minY >= FOLLOW_MIN_MM)) { out.minY = face.minY; out.maxY = face.maxY; }
  return out;
}

function sameCorners(fa, fb) {
  const a = (fa.nodeIds || []).slice().sort().join(','), b = (fb.nodeIds || []).slice().sort().join(',');
  return a !== '' && a === b;
}

function emptyBox() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function growBox(b, p) {
  b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
  b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y);
}

function pointsBox(pts) {
  const b = emptyBox();
  for (const p of pts) growBox(b, p);
  return b;
}

// Linear map of box b0 onto box b1 (per axis; an axis thinner than 1 mm only shifts).
function boxMapping(b0, b1) {
  const w0 = b0.maxX - b0.minX, h0 = b0.maxY - b0.minY, w1 = b1.maxX - b1.minX, h1 = b1.maxY - b1.minY;
  const sx = w0 > 1 && w1 > 1 ? w1 / w0 : 1, sy = h0 > 1 && h1 > 1 ? h1 / h0 : 1;
  const dx = (b1.minX + b1.maxX - b0.minX - b0.maxX) / 2, dy = (b1.minY + b1.maxY - b0.minY - b0.maxY) / 2;
  const map = (p) => ({
    x: w0 > 1 ? b1.minX + (p.x - b0.minX) * sx : p.x + dx,
    y: h0 > 1 ? b1.minY + (p.y - b0.minY) * sy : p.y + dy,
  });
  return { map, sx, sy, s: Math.sqrt(sx * sy), box0: b0, box1: b1 };
}

// Free-standing fixtures whose centre lies in no room (outside the plan, or in a gap between rooms):
// checks-full.js may report them (확인필요: '어느 실에도 없는 설비'). → [{ type: 'fixtureOutside', fixtureId }]
export function freeFixturesOutside(project, derived) {
  const out = [];
  if (!project || !derived) return out;
  for (const raw of project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || f.wall) continue;
    if (!roomAround(project, derived, f)) out.push({ type: 'fixtureOutside', fixtureId: f.id });
  }
  return out;
}

// True when a wall fixture's drop place (dropShare) still applies: its length is unmeasured and it
// still nearly fills its room side (or no room side is found just now).
function keepsDropShare(project, derived, raw) {
  const f = normalizeFixture(raw);
  if (!f || !f.wall || f.measured.w || f.dropShare == null) return false;
  const rs = fixtureRoomSide(project, derived, f);
  if (!rs) return true;
  return nearlyFills(f.fullW != null ? f.fullW : f.w, rs.length);
}

function followWall(raw, f, pe, ne, prevNodes, nextNodes, nextDerived, next) {
  const h = ne.orient === 'h';
  const key = h ? 'x' : 'y', cross = h ? 'y' : 'x';
  const pA = prevNodes.get(pe.a), pB = prevNodes.get(pe.b);
  const nA = nextNodes.get(ne.a), nB = nextNodes.get(ne.b);
  if (!nA || !nB) return null;
  const s = f[key];
  const lo = s - f.w / 2, hi = s + f.w / 2;
  const near = (c) => Math.min(Math.abs(lo - c), Math.abs(hi - c));
  // The offset of the centre from the nearer wall end, carried over to the moved end: used when no
  // relative position is stored (older files) or the side is open at an end. fitFixtureOnSide then
  // places it by `along` and keeps it inside its room side.
  const useA = near(pA[key]) <= near(pB[key]);
  const along = useA ? nA[key] + (s - pA[key]) : nB[key] + (s - pB[key]);
  const t = wallThickness(ne, nextDerived, next.settings);
  const acrossC = nA[cross] + sideFromRot(f.rot) * (t / 2 + f.d / 2);
  const moved = { ...raw, [key]: along, [cross]: acrossC, wall: ne.id };
  const res = fitFixtureOnSide(next, nextDerived, moved, { keepAlong: true });
  // Unchanged against the fixture as it was: give the original object back.
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
  if (same(res.x, raw.x) && same(res.y, raw.y) && same(res.w, raw.w) && same(res.along, raw.along)
    && same(res.fullW, raw.fullW) && same(res.d, raw.d) && same(res.fullD, raw.fullD) && res.wall === raw.wall) return raw;
  return res;
}

// Along-wall coordinates of the faces that close an h/v wall's two ends on one side (`side`: +1 = the
// larger cross coordinate): half the thickest wall that leaves the end node toward that side (a
// corner, or a T on that side). An end with no such wall (a free end, or a straight continuation)
// gives ±Infinity. Used for the [↻ 회전] corner and as fitFixtureOnSide's fallback when no room lies
// on that side of the wall. → { lo, hi } | null
export function wallEndFaces(project, derived, edge, side) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const A = nodes.get(edge.a), B = nodes.get(edge.b);
  if (!A || !B || (edge.orient !== 'h' && edge.orient !== 'v')) return null;
  const h = edge.orient === 'h';
  const key = h ? 'x' : 'y', cross = h ? 'y' : 'x';
  const face = (node) => {
    let m = null;
    for (const e of project.edges || []) {
      if (e.id === edge.id || e.kind === 'divider' || (e.a !== node.id && e.b !== node.id)) continue;
      const other = nodes.get(e.a === node.id ? e.b : e.a);
      if (!other) continue;
      // Only walls going off toward the fixture's side close that end for it.
      if ((other[cross] - node[cross]) * side <= 1e-6) continue;
      m = Math.max(m || 0, wallThickness(e, derived, project.settings) / 2);
    }
    return m;
  };
  const [P, Q] = A[key] <= B[key] ? [A, B] : [B, A];
  const fp = face(P), fq = face(Q);
  return { lo: fp == null ? -Infinity : P[key] + fp, hi: fq == null ? Infinity : Q[key] - fq };
}

// [↻ 회전] on a fixture standing against a wall: it turns around the corner at its nearer wall end,
// with its back now against the perpendicular wall there and one end against the old wall's face
// (a sink along the bottom wall becomes a sink along the side wall of that corner). When neither end
// has a suitable wall within reach, it turns in place but stays on the room side of its old wall.
// → { x, y, rot, wall } | null (not on an h/v wall)
function turnOnWall(project, derived, f, preferRot, snapMM) {
  const e = (project.edges || []).find((x) => x.id === f.wall);
  if (!e || (e.orient !== 'h' && e.orient !== 'v')) return null;
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const A = nodes.get(e.a);
  if (!A) return null;
  const h = e.orient === 'h';
  const key = h ? 'x' : 'y', cross = h ? 'y' : 'x';
  const side = sideFromRot(f.rot);
  const face = A[cross] + side * (wallThickness(e, derived, project.settings) / 2);
  const s = f[key];
  const ends = [{ at: s - f.w / 2, dir: -1 }, { at: s + f.w / 2, dir: 1 }];
  // Which end is nearer a wall end (the corner it stands in).
  const lim = wallEndFaces(project, derived, e, side) || { lo: -Infinity, hi: Infinity };
  const dist = (end) => Math.abs(end.at - (end.dir < 0 ? lim.lo : lim.hi));
  ends.sort((p, q) => dist(p) - dist(q));
  const cands = [];
  // The room it stands in: a turn never takes it into another room (next to a diagonal wall in an
  // acute corner, the perpendicular wall within reach belongs to the room on the other side).
  const home = derived ? fixtureRoomSide(project, derived, f) : null;
  for (const end of ends) {
    // Back toward this end: an h wall's end lies left/right (rot 270 faces left, 90 right); a v
    // wall's end lies up/down (rot 0 faces up, 180 down).
    const rot = h ? (end.dir < 0 ? 270 : 90) : (end.dir < 0 ? 0 : 180);
    const probe = { [key]: end.at - end.dir * (f.d / 2), [cross]: face + side * (f.w / 2) };
    const r = snapFixture(project, derived, { w: f.w, d: f.d }, probe, { snapMM: Math.max(snapMM, 300), rot });
    if (!r.wall || r.wall === e.id) continue;
    if (home) {
      const there = fixtureRoomSide(project, derived, { ...f, x: r.x, y: r.y, rot: r.rot, wall: r.wall });
      if (there && there.roomId !== home.roomId) continue;
    }
    cands.push(r);
  }
  const pick = cands.find((c) => c.rot === preferRot) || cands[0];
  if (pick) return pick;
  // No corner to turn into: turn in place, the long side now across, kept inside the room.
  const across = normalizeRot(preferRot) % 180 === normalizeRot(f.rot) % 180 ? f.d : f.w;
  return { [key]: s, [cross]: face + side * (across / 2), rot: normalizeRot(preferRot), wall: null };
}

// Derive hook for the DocStore (see installFixtures): runs after every re-derive.
// prevDerived (optional): the derived data before the edit (free fixtures follow their room, free
// columns stay in it).
export function fixturesDeriveHook(prevProject, nextProject, nextDerived, prevDerived = null) {
  const fixtures = reconcileFixtures(prevProject, nextProject, nextDerived, prevDerived);
  return fixtures === nextProject.fixtures ? nextProject : { ...nextProject, fixtures };
}

// ---- store mixin ---------------------------------------------------------------------------------

// Adds the fixture commands to DocStore.prototype. Fixtures do not change the walls, so the commands
// do not re-derive (rederive: false); each is one undo step.
// If DocStore.deriveHooks (an array) exists, the reconcile hook is registered there too.
export function installFixtures(DocStore) {
  const proto = DocStore.prototype;

  // → fixture id | null. opts: { snapMM (0 = no snapping), rot, w, d, label, measured, inWall }
  // (a 기타's name is its label)
  proto.addFixture = function addFixture(type, x, y, opts = {}) {
    if (!isNum(x) || !isNum(y)) return null;
    // A size given here counts as measured unless opts.measured says otherwise.
    const given = opts.measured || {};
    const measured = {
      w: 'w' in given ? !!given.w : isNum(opts.w),
      d: 'd' in given ? !!given.d : isNum(opts.d),
    };
    const base = normalizeFixture({
      type: TYPE_MAP.has(migratedType(type)) ? migratedType(type) : OTHER_TYPE,
      x, y, w: opts.w, d: opts.d, rot: opts.rot || 0, measured, label: opts.label ?? null,
      stairDir: opts.stairDir, inWall: opts.inWall === true,
    });
    let id = null;
    const detail = { fixtureId: null };   // filled in by build(), read when listeners are notified
    this._commit('addFixture', (p) => {
      const placed = placeOn(p, this.derived, base, { x, y }, opts.snapMM, opts.rot);
      id = nextId('f', p.fixtures || []);
      detail.fixtureId = id;
      return { ...p, fixtures: [...(p.fixtures || []), { ...placed, id }] };
    }, { rederive: false, detail });
    return id;
  };

  // patch: { type, w, d, rot, label, check, measured, inWall, stairDir }. A number for w / d counts as measured
  // (typed on the numpad); null resets it to the type's default size. Changing the type keeps
  // measured sizes and takes the new type's default for the others. → bool
  proto.updateFixture = function updateFixture(id, patch = {}) {
    return this._commit('updateFixture', (p) => {
      const i = (p.fixtures || []).findIndex((f) => f.id === id);
      if (i < 0) return null;
      const cur = normalizeFixture(p.fixtures[i]);
      const type = 'type' in patch && TYPE_MAP.has(migratedType(patch.type)) ? migratedType(patch.type) : cur.type;
      const info = fixtureTypeInfo(type);
      const measured = { ...cur.measured, ...(patch.measured || {}) };
      let w = cur.w, d = cur.d;
      let wSet = false;   // a new length: the old full (unshortened) length no longer applies
      if (type !== cur.type) {
        if (!measured.w) { w = info.w; wSet = true; }
        if (!measured.d) d = info.d;
      }
      if ('w' in patch) {
        if (patch.w == null) { w = info.w; measured.w = false; wSet = true; } else if (isNum(Number(patch.w)) && Number(patch.w) >= MIN_FIXTURE_MM) {
          w = Math.min(MAX_FIXTURE_MM, Number(patch.w));
          wSet = true;
          if (!(patch.measured && 'w' in patch.measured)) measured.w = true;
        }
      }
      if (measured.w) wSet = true;
      if ('d' in patch) {
        if (patch.d == null) { d = info.d; measured.d = false; } else if (isNum(Number(patch.d)) && Number(patch.d) >= MIN_FIXTURE_MM) {
          d = Math.min(MAX_FIXTURE_MM, Number(patch.d));
          if (!(patch.measured && 'd' in patch.measured)) measured.d = true;
        }
      }
      let nf = resizeFixture(p, cur, w, d, this.derived);
      nf = { ...nf, type, measured, fullW: wSet ? null : cur.fullW };
      if (keepsInRoom(type)) nf.fullD = ('d' in patch || measured.d || type !== cur.type) ? null : (cur.fullD ?? null);
      else nf.fullD = null;
      // The way up of a stair ([방향 바꾸기]); other types have no direction.
      if (isStair(type)) nf.stairDir = 'stairDir' in patch ? (patch.stairDir === -1 ? -1 : 1) : (cur.stairDir === -1 ? -1 : 1);
      else nf.stairDir = undefined;
      // The name typed for a 기타 belongs to it: another type shows its own name again.
      if (type !== cur.type && cur.type === OTHER_TYPE && typeof nf.label === 'string' && nf.label.trim()) nf.label = null;
      if ('label' in patch) nf.label = patch.label == null ? null : String(patch.label);
      if ('check' in patch) nf.check = !!patch.check;
      // [벽 속에 넣기]: only storage types (옷장, 신발장) can stand in their wall.
      const inWall = 'inWall' in patch ? !!patch.inWall : !!cur.inWall;
      if (isStorageType(type) && inWall) nf.inWall = true;
      else nf.inWall = false;
      if ('rot' in patch && normalizeRot(patch.rot) !== cur.rot) nf = { ...nf, rot: normalizeRot(patch.rot), wall: null, along: null };
      // A new length (or type) must still fit the room side; where it stands is kept (`along` is taken
      // from the resized position, whose end near the corner stayed put).
      if (nf.wall) nf = fitFixtureOnSide(p, this.derived, nf);
      else nf = keepColumnInRoom(p, this.derived, nf);
      // The drop place (dropShare) only stands while the length is unmeasured and still nearly fills
      // its side (a shorter type has room: `along` says where it is from now on).
      if (nf.dropShare != null && !keepsDropShare(p, this.derived, nf)) nf = { ...nf, dropShare: undefined };
      const out = withoutWallPin({ ...p.fixtures[i], ...nf, id });
      if (JSON.stringify(normalizeFixture(out)) === JSON.stringify(normalizeFixture(p.fixtures[i]))) return null;
      const fixtures = p.fixtures.slice();
      fixtures[i] = out;
      return { ...p, fixtures };
    }, { rederive: false, detail: { fixtureId: id } });
  };

  // Move the centre to (x, y); re-snaps to a wall when opts.snapMM > 0. → bool
  proto.moveFixture = function moveFixture(id, x, y, opts = {}) {
    if (!isNum(x) || !isNum(y)) return false;
    return this._commit('moveFixture', (p) => {
      const i = (p.fixtures || []).findIndex((f) => f.id === id);
      if (i < 0) return null;
      const cur = normalizeFixture(p.fixtures[i]);
      const placed = placeOn(p, this.derived, cur, { x, y }, opts.snapMM, null);
      const fixtures = p.fixtures.slice();
      fixtures[i] = { ...p.fixtures[i], x: placed.x, y: placed.y, rot: placed.rot, wall: placed.wall,
        w: placed.w, along: placed.along, fullW: placed.fullW, dropShare: placed.dropShare };
      // A column on a wall of the other orientation swaps w / d to keep its 가로 × 세로; a column or
      // a stair may have its depth shortened to fit the room in front of its new wall (fullD).
      if (keepsInRoom(cur)) Object.assign(fixtures[i], { d: placed.d, measured: placed.measured, fullD: placed.fullD ?? null });
      // A stair moved to the opposite wall keeps pointing the same way on the plan.
      if (isStair(cur)) fixtures[i] = keepStairWay(cur, fixtures[i]);
      fixtures[i] = withoutWallPin(fixtures[i]);
      return { ...p, fixtures };
    }, { rederive: false, detail: { fixtureId: id } });
  };

  // Rotate: rot given, or +90° clockwise. Without opts.snapMM: about the centre, leaving the wall.
  // With opts.snapMM > 0 (the [↻ 회전] button): a fixture standing against a wall turns around the
  // corner onto the perpendicular wall at its nearer end (see turnOnWall), and stays inside the room
  // when there is none; a free fixture turns about its centre and re-snaps to a wall behind its new
  // back. → bool
  proto.rotateFixture = function rotateFixture(id, rot = null, opts = {}) {
    return this._commit('rotateFixture', (p) => {
      const i = (p.fixtures || []).findIndex((f) => f.id === id);
      if (i < 0) return null;
      const cur = normalizeFixture(p.fixtures[i]);
      if (isColumn(cur) && rot == null) {
        // A column turns in place: 가로 and 세로 swap, its flush sides (back, corner end) stay.
        if (Math.abs(cur.w - cur.d) < 1e-6) return null;
        let nf = resizeFixture(p, cur, cur.d, cur.w, this.derived);
        // A turn is a new placement: the drop place on the sketch no longer applies.
        nf = { ...p.fixtures[i], ...nf, measured: { w: cur.measured.d, d: cur.measured.w }, fullW: null, fullD: null, dropShare: undefined };
        nf = nf.wall ? fitFixtureOnSide(p, this.derived, nf) : keepColumnInRoom(p, this.derived, nf);
        const fixtures = p.fixtures.slice();
        fixtures[i] = withoutWallPin(nf);
        return { ...p, fixtures };
      }
      const nextRot = normalizeRot(rot == null ? cur.rot + 90 : rot);
      if (nextRot === cur.rot) return null;
      if (isStair(cur)) {
        // A stair turns 90° in place (about its centre, full size back), then re-snaps when a wall
        // face lies behind its new back (snapMM given), else it stays free and is kept inside its
        // room (a stair that was along a wall then stands with its end against that wall).
        const w = !cur.measured.w && isNum(cur.fullW) ? cur.fullW : cur.w;
        const d = !cur.measured.d && isNum(cur.fullD) ? cur.fullD : cur.d;
        const turned = { ...p.fixtures[i], x: cur.x, y: cur.y, w, d, rot: nextRot, wall: null, along: null, fullW: null, fullD: null, dropShare: undefined };
        const s = opts.snapMM > 0
          ? snapFixture(p, this.derived, normalizeFixture(turned), { x: cur.x, y: cur.y }, { snapMM: opts.snapMM, rot: nextRot })
          : null;
        // Keep it in the room it stood in (its centre may sit in a wall band after the turn).
        const prev = { project: p, derived: this.derived };
        const nf = s && s.wall
          ? fitFixtureOnSide(p, this.derived, { ...turned, x: s.x, y: s.y, wall: s.wall })
          : keepColumnInRoom(p, this.derived, turned, prev);
        const fixtures = p.fixtures.slice();
        fixtures[i] = withoutWallPin(nf);
        return { ...p, fixtures };
      }
      let placed = { x: cur.x, y: cur.y, rot: nextRot, wall: null };
      const turned = opts.snapMM > 0 && cur.wall ? turnOnWall(p, this.derived, cur, nextRot, opts.snapMM) : null;
      if (turned) {
        placed = turned;
      } else if (opts.snapMM > 0) {
        const s = snapFixture(p, this.derived, { ...cur, rot: nextRot }, { x: cur.x, y: cur.y }, { snapMM: opts.snapMM, rot: nextRot });
        if (s.wall) placed = s;
      }
      // On a wall: inside the room side it now stands on (R3: the turn keeps it in the room); free: off
      // a diagonal wall of its room.
      let nf = { ...p.fixtures[i], ...placed, along: null, dropShare: undefined };
      if (nf.wall) nf = fitFixtureOnSide(p, this.derived, nf);
      else nf = keepColumnInRoom(p, this.derived, nf, { project: p, derived: this.derived, fixture: p.fixtures[i] });
      const fixtures = p.fixtures.slice();
      fixtures[i] = withoutWallPin(nf);
      return { ...p, fixtures };
    }, { rederive: false, detail: { fixtureId: id } });
  };

  // Resize to a world box (a handle drag): see resizeFixtureBox. One undo step. → bool
  proto.setFixtureBox = function setFixtureBox(id, box) {
    return this._commit('setFixtureBox', (p) => {
      const i = (p.fixtures || []).findIndex((f) => f.id === id);
      if (i < 0) return null;
      const nf = resizeFixtureBox(p, this.derived, p.fixtures[i], box);
      if (JSON.stringify(normalizeFixture(nf)) === JSON.stringify(normalizeFixture(p.fixtures[i]))) return null;
      const fixtures = p.fixtures.slice();
      fixtures[i] = withoutWallPin({ ...nf, id });
      return { ...p, fixtures };
    }, { rederive: false, detail: { fixtureId: id } });
  };

  proto.deleteFixture = function deleteFixture(id) {
    return this._commit('deleteFixture', (p) => {
      const fixtures = (p.fixtures || []).filter((f) => f.id !== id);
      return fixtures.length === (p.fixtures || []).length ? null : { ...p, fixtures };
    }, { rederive: false, detail: { fixtureId: id } });
  };

  proto.fixtureById = function fixtureById(id) {
    return (this.project.fixtures || []).find((f) => f.id === id) || null;
  };

  if (Array.isArray(DocStore.deriveHooks) && !DocStore.deriveHooks.includes(fixturesDeriveHook)) {
    DocStore.deriveHooks.push(fixturesDeriveHook);
  }
}

// Where a fixture dropped at `point` ends up (the commands and the UI ghost use the same rule): snapped
// to a wall when asked and one is near, then kept inside that wall's room side (fitFixtureOnSide; its
// relative position is taken from where it was dropped). Free-standing, an unmeasured length that was
// shortened to fit a wall gets its full length back. → fixture
// A column keeps its 가로 × 세로 (orientColumn) and, free-standing, stays inside its room.
// An unmeasured length that nearly fills its room side (a default 1800 sink on a sketch side drawn
// 1950 long) is not slid into a corner: on the sketch the corner is a few cm away and says nothing,
// so it stays where it was dropped and remembers that place as `dropShare` (review 예시 세대 A #23). An
// unmeasured length on a side with room to spare goes into a corner only when it was dropped toward it
// (dropNearCorner), not because its default-size end happens to come close on a small sketch.
export function placeFixture(project, derived, f, point, snapMM, rot = null) {
  if (snapMM > 0) {
    let s = snapFixture(project, derived, f, point, { snapMM, rot: rot != null ? rot : null });
    if (s.wall) {
      const turned = isColumn(f) ? orientColumn(f, s.rot) : f;
      let dropShare = null;
      if (!(turned.measured && turned.measured.w)) {
        const want = isNum(turned.fullW) ? turned.fullW : turned.w;
        const probe = normalizeFixture({ ...turned, x: s.x, y: s.y, rot: s.rot, wall: s.wall });
        const rs = probe ? fixtureRoomSide(project, derived, probe) : null;
        const e = rs ? (project.edges || []).find((x) => x.id === s.wall) : null;
        if (rs && e && nearlyFills(want, rs.length)) {
          const plain = snapFixture(project, derived, f, point, { snapMM, rot: rot != null ? rot : null, corner: false });
          if (plain.wall === s.wall && plain.rot === s.rot) s = plain;
          dropShare = shareAt(project, e, rs.key, rs.lo, rs.hi, point[rs.key]);
        } else if (rs && e) {
          // The corner snap compares the type's real default length with a sketch side that may be
          // drawn smaller than the room (review 예시 세대 A #23 at 0.75 ×: a 1800 sink dropped at along 0.45
          // of a 2470 sketch side ended 300 mm from the corner and was snapped into it, 446 mm off after
          // the values). So the DROP decides: into the corner when the drop point is within snapMM of
          // the side's end, or when the fixture's end is that close AND in the outer quarter of the free
          // length beside it (dropped clearly toward the corner); else it stays where it was dropped.
          const plain = snapFixture(project, derived, f, point, { snapMM, rot: rot != null ? rot : null, corner: false });
          if (plain.wall === s.wall && plain.rot === s.rot && !dropNearCorner(rs, plain[rs.key], Math.min(want, rs.length), snapMM)) s = plain;
        }
      }
      const rec = { ...turned, x: s.x, y: s.y, rot: s.rot, wall: s.wall, along: null, dropShare };
      if (dropShare == null) delete rec.dropShare;
      return fitFixtureOnSide(project, derived, rec);
    }
  }
  const m = f.measured || {};
  const r = normalizeRot(rot != null ? rot : f.rot);
  // Free-standing: a place along a wall no longer applies (dropShare: undefined is not written).
  if (isColumn(f)) {
    const turned = orientColumn(f, r);   // also gives back a shortened length / depth
    return keepColumnInRoom(project, derived, { ...turned, x: point.x, y: point.y, wall: null, along: null, dropShare: undefined });
  }
  const w = !m.w && isNum(f.fullW) ? f.fullW : f.w;
  if (isStair(f)) {
    // A free stair gets its full size back and stays inside the room it is dropped in.
    const d = !m.d && isNum(f.fullD) ? f.fullD : f.d;
    return keepColumnInRoom(project, derived, { ...f, x: point.x, y: point.y, rot: r, wall: null, w, d, along: null, fullW: null, fullD: null, dropShare: undefined });
  }
  // Kept off a diagonal wall of the room it is dropped in (keepColumnInRoom → keepOffSlants).
  return keepColumnInRoom(project, derived, { ...f, x: point.x, y: point.y, rot: r, wall: null, w, along: null, fullW: null, dropShare: undefined });
}
const placeOn = placeFixture;
