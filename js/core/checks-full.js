// Automatic checks, stage D (plan §5, §6; dev/DESIGN.md §3.7).
//
//   runChecks(project, derived, opts?) → items
//     item = { key, level: 'check' | 'info', category, message, where, note, resolved }
//       key       stable string. It includes the values involved, so a [확인 완료] stops applying
//                 as soon as one of those values is changed (the check then shows again).
//       level     'check' = 확인필요 (counted on the [검사 N] badge, printed as a ※ note when `note`
//                 is set); 'info' = 참고 (shown in the panel only).
//       message   plain Korean for the 검사 panel.
//       where     { roomId?, sideKey?, edgeId?, openingId?, fixtureId?, nodeId?, point?, points? }
//                 point = one world point (mm) for the location, points = world points to bring into
//                 view (both optional).
//       note      the ※ line for print, or null when the item is not printed.
//       resolved  true when project.checks holds { key } (확인 완료).
//     opts: { roomLabel(roomId) → string, openingSpan(project, opening, derived) → span | null,
//             openingLabel(opening) → string (the window/door label used in messages and ※ notes) }
//
//   notesForPrint(items, options) → [string]   ※ lines for the bottom of the printed drawing.
//   installChecks(DocStore)                    adds resolveCheck(key), unresolveCheck(key), checkItems().
//   drawCheckMarkers(ctx, project, derived, opts)  screen markers for problems the plan does not show.
//
// What is checked:
//   - 치수 폐합: the top row of the house outline against the bottom row, and the left row against the
//     right row. A row is made of the measured sides ON THE HOUSE OUTLINE only (walls with a room on one
//     side; review 0.5.1: an inner room's side, e.g. a bathroom's tiled 1100 standing in for the veranda's
//     980 not typed yet, gave a false 360 mm alarm). An outline stretch without a value is a gap. Each
//     gapless part of a row is summed as "measured values + assumed wall thicknesses" (centre line to
//     centre line) and compared with the other row over the LONGEST stretch both rows cover between the
//     same wall lines, so the result depends only on which values exist, not on the order they were
//     typed in. Parts whose ends differ are compared by the drawing's order of the end walls (the part
//     drawn enclosing the other may not be shorter). Inner loops (e.g. 방2 2600 against 주방 400 +
//     화장실1 2160) are left to 전체 치수 and to the solver's 'absorbed' warnings.
//   - 전체 치수 (plan §6 "직접 잰 전체 치수(예: 예시 세대 B 4520)가 있으면 그 값과도 비교"): a measured side
//     or span whose two ends lie on the same wall lines as a chain of at least two other measured sides
//     (of either face) along the same axis is compared with "parts + assumed walls between them". Above
//     closureTolerance: 확인필요 with '※ 위쪽 전체 4520 / 구간 합계 1250 + 3160 + 벽 — 확인필요';
//     below it nothing is shown (see overallChecks). A value typed on a side made only of 구역 나누기
//     lines is compared with the chain on the far side of its room as well (one part is enough).
//   - 양쪽 값 차이: the same side measured from the rooms on both faces of a wall (written in a fixed
//     order: the room on the left / above first).
//   - the engine's warnings: unmeasured, outlier, fold, residual, absorbed, conflict, openingFit, gapPlaced.
//     One wrong value must not turn correct values into 확인필요 (review 0.5.1): while a 다시 확인
//     (outlier), 벽이 엇갈리는 값 (fold), 양쪽 값 차이, 전체 치수 or 치수 폐합 item is open, the residual /
//     absorbed / conflict items along the same axis are 참고 ('위의 … 때문일 수 있습니다'). An absorbed
//     or conflict item is 참고 as well until other values tie both ends of its run (with few values the
//     sketch's proportions, not a contradiction, made the walls give).
//     A missing or extra zero (an open 다시 확인: outlier or outlierPair) rescales and folds the whole
//     plan, on both axes (review 0.5.1 round 2): while one is open, every 벽이 엇갈리는 값 item that does
//     not name it, every overlapping / crossing wall item and every 벽보다 큰 창·문 / 겹친 창·문 / 설비가
//     벽보다 김 item is 참고 ('위의 다시 확인 값 때문일 수 있습니다', no 'delete / redraw' advice). So are
//     the 기둥이 실보다 김, 계단이 실보다 김 and 기둥과 창·문 겹침 items (round 2 integration: the slipped
//     value squeezes the room a correct free column or stair stands in).
//   - drawing problems: wall ends that touch nothing, walls drawn on top of each other or crossing
//     (when they do so only after the solve, the advice is to check the values, not to redraw a wall),
//     openings wider than their wall or overlapping each other. While the plan's scale is not settled
//     (fewer than 3 values, or fewer than half of the rooms with a value) the opening checks, a
//     measured fixture's 설비가 벽보다 김 and the 기둥 / 계단 items are 참고; a window / door drawn at its type's default width
//     (no 규격, no drawn width) is only 참고 — except a DOOR whose clear wall piece is shorter than
//     DOOR_ROOM_MIN_MM once the scale is settled: no door fits there, so a value is likely wrong.
//   - 설비가 벽보다 김: a wall fixture longer than the room side it stands on (fixtures.js centres a
//     measured one: 확인필요 with a ※ note; an unmeasured default length is drawn shortened: 참고).
//   - 실 밖 설비: a free-standing fixture whose centre is in no room.
//   - 기둥: a column standing in a window / door opening, or deeper than its room (measured depth).
//   - 계단: a stair whose measured size does not fit its room (no check against openings).
//   - 확인필요 flags set by the user: on measures, walls, openings, fixtures and room heights.
//   Diagonal walls (2026-10-19, solver.js contract C2): a measured diagonal side fixes its second
//   projection once the other values fix its first (Pythagoras), so a side it fixes counts as determined
//   ('…길이를 넣지 않았지만, 다른 길이로 정해집니다.' — '다른 실에서 잰 길이로' only when other rooms' values
//   alone fix the side) and needs no ※ 치수 미입력 note. With neither projection fixed only the drawn
//   angle places it: its neighbours stay '아직 넣지 않았습니다' (fixer 2026-10-20). A diagonal that is a check only (both projections fixed by the axis values) and
//   misses by more than model.DIAGONAL_TOLERANCE_MM is 확인필요 ('방1 오른쪽 아래 사선 벽: 잰 사선 길이
//   1414, 다른 길이로 계산하면 1262 (152mm 차이). 사선 길이나 주변 벽 길이를 확인해 주세요.'). The two faces
//   of one diagonal wall differ in length where its corners differ, so 양쪽 값 차이 compares how far the
//   two values miss the two drawn faces. Within the tolerance, two different values get the 참고 item
//   '… (같은 사선 벽의 양쪽 면). 도면에는 큰 값 N만 적습니다.' (integration 2026-10-19: the print shows one
//   aligned dimension per diagonal wall, dims.js rule 7 merging like rule 1). Closure and 전체 치수 use
//   axis sides only; the 다시 확인 median includes diagonal values.

import { DEFAULT_SETTINGS } from './model.js';
import { fixtureRoomSide, normalizeFixture, isColumn, isStair, fixtureBounds, depthInRoom, freeColumnSticksOut, fixtureExtents, freeFixturesOutside } from './fixtures.js';
import { sidesForEdge } from './rooms.js';
import { thicknessPriors, sketchInnerLength, straightDiagonalJoints } from './solver.js';
import { pointInPolygon, segmentIntersection } from './geom.js';
import { twoSideKey, resolvedKeys, isKeyResolved, legacyKeyPattern } from './checkkeys.js';

export const LEVEL_CHECK = 'check';
export const LEVEL_INFO = 'info';

// Short Korean names of the categories (panel chips).
export const CATEGORY_LABELS = Object.freeze({
  closure: '치수 폐합',
  overall: '전체 치수',
  twoSide: '양쪽 값 차이',
  twoSidePair: '양쪽 값',
  outlier: '다시 확인',
  fold: '벽이 엇갈리는 값',
  residual: '안 맞는 값',
  absorbed: '벽 두께로 맞춤',
  conflict: '벽 두께로 맞춤',
  unmeasured: '길이 미입력',
  openingFit: '창·문 맞춤',
  gapPlaced: '재지 않은 길이',
  dangling: '이어지지 않은 벽',
  overlap: '겹친 벽',
  cross: '엇갈린 벽',
  openingWide: '벽보다 큰 창·문',
  openingOverlap: '겹친 창·문',
  fixtureLong: '설비가 벽보다 김',
  fixtureDeep: '기둥이 실보다 김',
  fixtureOutside: '실 밖 설비',
  columnOpening: '기둥과 창·문 겹침',
  stairFit: '계단이 실보다 김',
  userMeasure: '확인필요',
  userWall: '확인필요',
  userOpening: '확인필요',
  userFixture: '확인필요',
  userRoom: '확인필요',
});

export const UNMEASURED_NOTE = '※ 치수 미입력 벽은 축척이 맞지 않습니다.';
export const BOTH_VALUES_NOTE = '※ 괄호 안은 반대쪽 실에서 잰 값입니다.';

// Order of the categories inside a level (most important first).
const CATEGORY_ORDER = [
  'closure', 'overall', 'twoSide', 'outlier', 'fold', 'residual', 'absorbed', 'conflict',
  'userMeasure', 'userWall', 'userOpening', 'userFixture', 'userRoom',
  'openingWide', 'openingOverlap', 'columnOpening', 'fixtureLong', 'fixtureDeep', 'fixtureOutside', 'stairFit', 'overlap', 'cross', 'dangling',
  'twoSidePair', 'openingFit', 'gapPlaced', 'unmeasured',
];

const RESIDUAL_MIN_MM = 5;     // same as model.RESIDUAL_TOLERANCE_MM
const CLOSURE_INFO_MIN_MM = 5; // a row difference below this is not worth mentioning
const COORD_TOL = 0.5;         // mm: two coordinates closer than this are the same
const OPENING_TOL = 5;         // mm of slack for opening widths and overlaps
const FIXTURE_TOL = 5;         // mm of slack for a fixture's length against its room side
const COLUMN_REACH = 100;      // mm beyond a wall face within which a column counts as standing in its opening
const OVERLAP_MIN_MM = 10;     // parallel walls must run side by side at least this long to "overlap"
// A door with only its type's default width on a clear wall piece shorter than this cannot be a real
// door (현관 and room doors are 700 or more, a narrow 화장실 door about 600): once the scale is settled
// it is 확인필요, not the 참고 '규격 미입력' (review 0.5.1 round 2: 예시 세대 A A19 = 4600 typed instead of 3600
// squeezes the unmeasured 현관 until its door has 574 mm; with doors placed by the 문 tool, without a
// width, that was the only sign of the typo). 600, not 650: in 3070 settled states of 202 entry orders
// of the correct 예시 세대 A values the 현관 piece went down to 602 mm while the plan was still being filled
// in (below 650 in 35 of them, below 600 in none).
const DOOR_ROOM_MIN_MM = 600;

// ---- small helpers -------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && isFinite(v);
const num = (v) => (isNum(v) ? v : null);
// mm as the messages write them. Rounded to 0.01 mm first: a residual of exactly 25.5 mm (two values 51 mm
// apart, split evenly) came out 25.49999 on one device and 25.50001 on the one that opened its file, and the
// item said '25mm' there and '26mm' here (round-trip check 2026-10-24).
const plain = (v) => (isNum(v) ? String(Math.round(Math.round(v * 100) / 100)) : '');
const sideKeyOf = (m) => [m.from, m.to].sort().join('-');
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

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

// Room labels as the editor shows them: the name, or "이름 없는 실 N" numbered in derived order.
export function roomLabels(derived) {
  const labels = new Map();
  let unnamed = 0;
  for (const r of (derived && derived.rooms) || []) {
    const name = r.room && r.room.name;
    labels.set(r.roomId, name || `이름 없는 실 ${++unnamed}`);
  }
  return labels;
}

// Which wall of its room a side is, from the inward normal (y down: a normal pointing down means the
// room lies below the side, i.e. the side is the room's TOP wall). → '위쪽' | '아래쪽' | '왼쪽' |
// '오른쪽' | '오른쪽 위 사선' ...
// A diagonal names both ways only when it leans clearly both ways (more than 30° from either axis): a
// trapezoid's steep slanted side is its '오른쪽 사선 벽', a chamfer its '오른쪽 아래 사선 벽' (2026-10-19;
// 0.38 called the 66° wall of a trapezoid its '오른쪽 위 사선').
export function sideDirectionWord(side) {
  const n = (side && side.inwardNormal) || { x: 0, y: 0 };
  if (side.orient === 'h') return n.y > 0 ? '위쪽' : '아래쪽';
  if (side.orient === 'v') return n.x > 0 ? '왼쪽' : '오른쪽';
  const parts = [];
  if (n.x < -0.5) parts.push('오른쪽'); else if (n.x > 0.5) parts.push('왼쪽');
  if (n.y > 0.5) parts.push('위'); else if (n.y < -0.5) parts.push('아래');
  return parts.length ? `${parts.join(' ')} 사선` : '사선';
}

// Shared lookups for one run.
function makeContext(project, derived, opts = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...((project && project.settings) || {}) };
  const nodeMap = new Map(((project && project.nodes) || []).map((n) => [n.id, n]));
  const edgeMap = new Map(((project && project.edges) || []).map((e) => [e.id, e]));
  const dRooms = (derived && derived.rooms) || [];
  const byRoom = new Map(dRooms.map((dr) => [dr.roomId, dr]));
  const labels = roomLabels(derived);
  const label = (roomId) => {
    if (typeof opts.roomLabel === 'function') {
      try {
        const s = opts.roomLabel(roomId);
        if (s) return s;
      } catch (_) { /* fall back to our own label */ }
    }
    return labels.get(roomId) || '실';
  };
  let priors;
  try { priors = thicknessPriors(project, dRooms); } catch (_) { priors = new Map(); }
  const solvedT = derived && derived.solve && derived.solve.thickness;
  const thick = (edgeId) => {
    const t = solvedT && typeof solvedT.get === 'function' ? solvedT.get(edgeId) : null;
    if (isNum(t)) return Math.max(0, t);
    const p = priors.get(edgeId);
    return isNum(p) ? p : 0;
  };
  // Valid measures with their room and side.
  const measures = [];
  for (const m of (project && project.measures) || []) {
    const dr = byRoom.get(m.room);
    if (!dr) continue;
    const i = dr.sides.findIndex((s) => s.key === sideKeyOf(m));
    if (i < 0) continue;
    measures.push({ m, dr, i, side: dr.sides[i], valid: isNum(m.value) && m.value > 0 });
  }
  const measureInfo = new Map(measures.map((x) => [x.m.id, x]));
  // Spans (DESIGN.md §7.7): a measured side cut by 구역 나누기 dividers. Its key matches no room side,
  // so it is listed apart: located at its first part (`m.room` = that part's room, `side` = its side),
  // named after all its parts ('거실·주방 위쪽 벽'), and tied from end to end (`ends`).
  const spanMeasures = [];
  const byId = new Map(((project && project.measures) || []).map((m) => [m.id, m]));
  for (const sp of (derived && derived.spans) || []) {
    const m = byId.get(sp.measureId);
    const p0 = sp.parts && sp.parts[0];
    const dr = p0 && byRoom.get(p0.roomId);
    const side = dr && dr.sides[p0.sideIndex];
    if (!m || !side || measureInfo.has(m.id)) continue;
    const names = [...new Set(sp.parts.map((p) => label(p.roomId)))].join('·');
    const x = {
      m: { ...m, room: p0.roomId }, dr, i: p0.sideIndex, side, valid: isNum(m.value) && m.value > 0,
      span: sp, spanKey: sp.key, ends: { from: m.from, to: m.to, orient: sp.orient },
      spanLoc: `${names} ${sideDirectionWord(side)} 벽 전체`,
    };
    spanMeasures.push(x);
    measureInfo.set(m.id, x);
  }
  const ctx = { project, derived, settings, nodeMap, edgeMap, byRoom, label, priors, thick, measures, measureInfo, spanMeasures };
  ctx.sideLocation = (roomId, sideKey, noun) => sideLocation(ctx, roomId, sideKey, noun);
  ctx.edgeLocation = (edgeId) => edgeLocation(ctx, edgeId);
  // Built on first use (most runs need only some of them).
  let ties = null, scale = null, exterior = null;
  ctx.ties = () => (ties = ties || measureTies(ctx));
  ctx.scaleState = () => (scale = scale || scaleState(ctx));
  ctx.exterior = () => (exterior = exterior || exteriorEdgeIds(derived));
  return ctx;
}

// Walls with a room on one side only: the house outline (as the solver's exteriorEdges). → Set of edge ids
function exteriorEdgeIds(derived) {
  const count = new Map();
  for (const dr of (derived && derived.rooms) || []) {
    for (const id of (dr.face && dr.face.edgeIds) || []) count.set(id, (count.get(id) || 0) + 1);
  }
  const out = new Set();
  for (const [id, c] of count) if (c === 1) out.add(id);
  return out;
}

// Whether the plan's scale is settled (review 0.5.1, field test 예시 세대 A): the solve scales the whole sketch
// by the values typed so far, so with one or two values (or values in only a few rooms) every window,
// door and fixture is compared with a wall length that is still the sketch's guess: the first value
// alone turned the badge from 1 into 12, and the next ones made it go up and down. Settled = at least 3
// values and at least half of the rooms (실 아님 spaces not counted) with a value on one of their sides.
// → { values, rooms, measuredRooms, settled }
const SETTLED_MIN_VALUES = 3;
function scaleState(ctx) {
  const all = ctx.measures.concat(ctx.spanMeasures || []).filter((x) => x.valid);
  const measured = new Set();
  for (const x of all) {
    if (x.span) for (const p of x.span.parts || []) measured.add(p.roomId);
    else measured.add(x.m.room);
  }
  const rooms = ((ctx.derived && ctx.derived.rooms) || []).filter((dr) => !(dr.room && dr.room.notRoom));
  const measuredRooms = rooms.filter((dr) => measured.has(dr.roomId)).length;
  const settled = all.length >= SETTLED_MIN_VALUES && 2 * measuredRooms >= rooms.length;
  return { values: all.length, rooms: rooms.length, measuredRooms, settled };
}

// '방3 왼쪽 벽', '주방 위쪽 벽(오른쪽)' when the room has two top walls.
function sideLocation(ctx, roomId, sideKey, noun = '벽') {
  const dr = ctx.byRoom.get(roomId);
  const side = dr && dr.sides.find((s) => s.key === sideKey);
  if (!side) return `${ctx.label(roomId)} ${noun}`;
  const word = sideDirectionWord(side);
  const same = dr.sides.filter((s) => sideDirectionWord(s) === word);
  let qualifier = '';
  // The clearly longest of several same-direction sides keeps the plain name ('거실 아래쪽 벽');
  // the others get their position ('거실 아래쪽 벽(오른쪽)').
  const lengths = same.map((s) => Math.abs(s.centerLength || 0)).sort((a, b) => b - a);
  const dominant = same.length > 1 && Math.abs(side.centerLength || 0) === lengths[0] && lengths[0] >= 1.5 * lengths[1];
  if (same.length > 1 && !dominant) {
    const centre = (s) => {
      const a = ctx.nodeMap.get(s.from), b = ctx.nodeMap.get(s.to);
      return a && b ? mid(a, b) : { x: 0, y: 0 };
    };
    const alongX = side.orient !== 'v';
    const sorted = same.slice().sort((p, q) => (alongX ? centre(p).x - centre(q).x : centre(p).y - centre(q).y));
    const k = sorted.indexOf(side);
    const names = alongX ? ['왼쪽', '가운데', '오른쪽'] : ['위', '가운데', '아래'];
    if (same.length === 2) qualifier = names[k === 0 ? 0 : 2];
    else if (same.length === 3) qualifier = names[k];
    else qualifier = `${alongX ? '왼쪽' : '위'}에서 ${k + 1}번째`;
  }
  return `${ctx.label(roomId)} ${word} ${noun}${qualifier ? `(${qualifier})` : ''}`;
}

// Location of a wall: the side of the best room next to it; for a wall inside a room or outside all
// rooms, '거실 안 벽' / '바깥 벽'.
function edgeLocation(ctx, edgeId) {
  const e = ctx.edgeMap.get(edgeId);
  const noun = e && e.kind === 'divider' ? '구역 나누기 선' : '벽';
  let pairs = [];
  try { pairs = sidesForEdge(ctx.derived, edgeId) || []; } catch (_) { pairs = []; }
  const score = (p) => {
    const dr = ctx.byRoom.get(p.roomId);
    const room = dr && dr.room;
    return (room && room.notRoom ? 2 : 0) + (room && room.name ? 0 : 1);
  };
  const best = pairs.filter((p) => p && p.side).sort((p, q) => score(p) - score(q))[0];
  if (best) return sideLocation(ctx, best.roomId, best.side.key, noun);
  const a = e && ctx.nodeMap.get(e.a), b = e && ctx.nodeMap.get(e.b);
  const roomId = a && b ? roomAtPoint(ctx, mid(a, b)) : null;
  return roomId ? `${ctx.label(roomId)} 안 ${noun}` : `바깥 ${noun}`;
}

// Innermost room containing a world point. → roomId | null
function roomAtPoint(ctx, pt) {
  let best = null, bestArea = Infinity;
  for (const dr of (ctx.derived && ctx.derived.rooms) || []) {
    const pts = dr.face && dr.face.points;
    if (!pts || !(dr.area < bestArea)) continue;
    if (pointInPolygon(pt, pts)) { best = dr.roomId; bestArea = dr.area; }
  }
  return best;
}

function sideWorldPoints(ctx, side) {
  const a = ctx.nodeMap.get(side.from), b = ctx.nodeMap.get(side.to);
  return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : [];
}

function edgeWorldPoints(ctx, edgeId) {
  const e = ctx.edgeMap.get(edgeId);
  const a = e && ctx.nodeMap.get(e.a), b = e && ctx.nodeMap.get(e.b);
  return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : [];
}

// where-object for a room side.
function sideWhere(ctx, roomId, side) {
  const pts = sideWorldPoints(ctx, side);
  const ids = side.edgeIds || [];
  return {
    roomId, sideKey: side.key,
    edgeId: ids.length ? ids[Math.floor((ids.length - 1) / 2)] : null,
    point: pts.length ? mid(pts[0], pts[1]) : null,
    points: pts,
  };
}

// Readable names for other modules (e.g. print notes): '방3 왼쪽 벽', '이름 없는 실 2 오른쪽 벽'.
//   opts.roomLabel(roomId) overrides the room names.
export function describeSide(project, derived, roomId, sideKey, opts = {}) {
  return makeContext(project, derived, opts).sideLocation(roomId, sideKey);
}
export function describeEdge(project, derived, edgeId, opts = {}) {
  return makeContext(project, derived, opts).edgeLocation(edgeId);
}

// ---- main entry ----------------------------------------------------------------------------------

export function runChecks(project, derived, opts = {}) {
  if (!project) return [];
  const ctx = makeContext(project, derived, opts);
  const items = [];
  const push = (item) => items.push(item);

  const closure = closureChecks(ctx);
  for (const it of closure.items) push(it);
  let overallIds = new Set();
  try { overallIds = overallChecks(ctx, push, closure); } catch (err) { console.error('[checks] overall failed', err); }
  const twoSideIds = twoSideChecks(ctx, push);
  // The items that point at a wrong value come first; what they explain is then only 참고.
  const outlierIds = valueWarningChecks(ctx, push);
  const explain = explainers(ctx, items, { closure, twoSideIds, overallIds, outlierIds });
  engineWarningChecks(ctx, push, explain, opts);
  userFlagChecks(ctx, push, opts);
  drawingChecks(ctx, push, explain);
  openingChecks(ctx, push, opts, explain);
  fixtureChecks(ctx, push, explain);
  stairChecks(ctx, push, explain);
  columnOpeningChecks(ctx, push, opts, explain);

  // Resolution (확인 완료; a mark saved under an older key of the same item counts too) and a stable
  // order: checks before infos, by category, then as found.
  const resolved = resolvedKeys(project);
  const seen = new Set();
  const out = [];
  items.forEach((it, index) => {
    if (seen.has(it.key)) return;
    seen.add(it.key);
    out.push({ ...it, resolved: isKeyResolved(resolved, it.key), _i: index });
  });
  const rank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  out.sort((a, b) => (a.level === b.level ? 0 : a.level === LEVEL_CHECK ? -1 : 1)
    || rank(a.category) - rank(b.category) || a._i - b._i);
  for (const it of out) { delete it._i; delete it._explainAs; }
  return out;
}

// Number of unresolved 확인필요 items (the [검사 N] badge).
export function countForBadge(items) {
  return (items || []).filter((it) => it && it.level === LEVEL_CHECK && !it.resolved).length;
}

// ※ lines for the printed drawing (plan §1-2 "주기", §6, §7).
//   options: { drawingOnly, bothValues } — 그림만 prints no notes at all.
export function notesForPrint(items, options = {}) {
  if (options && options.drawingOnly) return [];
  const lines = [];
  const add = (s) => { if (s && !lines.includes(s)) lines.push(s); };
  for (const it of items || []) {
    if (it && it.level === LEVEL_CHECK && !it.resolved && it.note) add(it.note);
  }
  // Only sides that no measure fixes are drawn off scale (a side set by a neighbour's value is not).
  if ((items || []).some((it) => it && it.category === 'unmeasured' && !it.resolved
    && !(it.where && it.where.determined))) add(UNMEASURED_NOTE);
  if (options && options.bothValues
    && (items || []).some((it) => it && (it.category === 'twoSide' || it.category === 'twoSidePair'))) {
    add(BOTH_VALUES_NOTE);
  }
  return lines;
}

// Sides whose printed dimension gets a small ※ mark (plan §5-4: two-sided values more than the
// tolerance apart). → Set of 'roomId|sideKey'
export function dimensionMarks(items) {
  const out = new Set();
  for (const it of items || []) {
    if (!it || it.category !== 'twoSide' || it.level !== LEVEL_CHECK || it.resolved) continue;
    for (const s of (it.where && it.where.sides) || []) out.add(`${s.roomId}|${s.sideKey}`);
  }
  return out;
}

// ---- 치수 폐합 ----------------------------------------------------------------------------------

// Axis 'x' compares the top and bottom rows (horizontal sides); axis 'y' the left and right rows.
const AXES = {
  x: {
    along: 'h', across: 'v', coord: 'x', level: 'y', sketch: 'dx',
    // first row = top: sides whose room lies below them (inward normal points down)
    firstFacing: (s) => s.inwardNormal.y > 0, secondFacing: (s) => s.inwardNormal.y < 0,
    names: ['위쪽 줄', '아래쪽 줄'],
  },
  y: {
    along: 'v', across: 'h', coord: 'y', level: 'x', sketch: 'dy',
    firstFacing: (s) => s.inwardNormal.x > 0, secondFacing: (s) => s.inwardNormal.x < 0,
    names: ['왼쪽 줄', '오른쪽 줄'],
  },
};

function closureChecks(ctx) {
  const items = [];
  const axesWithCheck = new Set();
  const explained = new Set(); // measure ids taking part in a failed closure
  for (const axis of ['x', 'y']) {
    let res = [];
    try { res = closureForAxis(ctx, axis); } catch (err) {
      console.error('[checks] closure failed', err);
      res = [];
    }
    for (const r of res) {
      items.push(r.item);
      if (r.item.level === LEVEL_CHECK) {
        axesWithCheck.add(axis);
        for (const id of r.measureIds) explained.add(id);
      }
    }
  }
  return { items, axesWithCheck, explained };
}

// → [{ item, measureIds }]: one comparison per pair of row parts that can be compared (usually none or
// one per axis).
function closureForAxis(ctx, axisName) {
  const ax = AXES[axisName];
  const { nodeMap, edgeMap, priors } = ctx;
  const project = ctx.project;

  // Coordinate groups: nodes joined by walls across this axis share the coordinate (as in the solver).
  const uf = new UnionFind();
  for (const n of project.nodes || []) uf.find(n.id);
  for (const e of project.edges || []) {
    if (e.orient === ax.across && nodeMap.has(e.a) && nodeMap.has(e.b)) uf.union(e.a, e.b);
  }
  const gOf = (id) => uf.find(id);
  // Rows are the house outline (review 0.5.1): a side counts only when every wall of it has a room on
  // one side only. An inner room's side is no stand-in for an outline side not measured yet: its finish
  // (a bathroom's tiles) differs from the outline's by up to ~120 mm, which added up to a false 360 mm
  // alarm while the verandas were still to be measured.
  const exterior = ctx.exterior();
  const onOutline = (sides) => sides.length > 0
    && sides.every((s) => s && (s.edgeIds || []).length && s.edgeIds.every((id) => exterior.has(id)));

  // Candidate links: measured outline sides along this axis.
  const cands = [];
  for (const x of ctx.measures) {
    if (!x.valid || x.side.orient !== ax.along || !onOutline([x.side])) continue;
    const side = x.side;
    const A = nodeMap.get(side.from), B = nodeMap.get(side.to);
    if (!A || !B) continue;
    let term;
    try { term = sketchInnerLength(x.dr.sides, x.i, edgeMap, priors, 0); } catch (_) { continue; }
    if (!isNum(term)) continue;
    const forward = side.dir[ax.coord] > 0;
    const lowNode = forward ? side.from : side.to;
    const highNode = forward ? side.to : side.from;
    // Half thickness of the wall at each end of the side (for the "벽 포함" totals).
    const n = x.dr.sides.length;
    const prev = x.dr.sides[(x.i - 1 + n) % n], next = x.dr.sides[(x.i + 1) % n];
    const halfAt = (adj, first) => {
      const id = first ? adj.edgeIds[0] : adj.edgeIds[adj.edgeIds.length - 1];
      return ((priors.get(id) || 0) / 2);
    };
    const halfFrom = halfAt(prev, false), halfTo = halfAt(next, true);
    cands.push({
      x, side, measureId: x.m.id, roomId: x.m.room, value: x.m.value,
      centre: x.m.value - term,
      lo: Math.min(A[ax.coord], B[ax.coord]), hi: Math.max(A[ax.coord], B[ax.coord]),
      level: A[ax.level],
      gLow: gOf(lowNode), gHigh: gOf(highNode),
      halfLow: forward ? halfFrom : halfTo, halfHigh: forward ? halfTo : halfFrom,
    });
  }
  // Measured spans (one value across 구역 나누기 lines or walls, §7.7 / §7.9) are links of their row
  // too, so a measured whole is compared with the other row (integration 0.4.0). In a stretch where
  // the span and its own typed parts compete, the span wins (same level, larger value): whether the
  // parts add up to it is the 전체 치수 check, which otherwise printed the same difference twice.
  for (const x of ctx.spanMeasures || []) {
    if (!x.valid || !x.span || !x.dr) continue;
    const pN = x.span.parts[x.span.parts.length - 1];
    const drN = pN && ctx.byRoom.get(pN.roomId);
    const side = x.dr.sides[x.i], sideB = drN && drN.sides[pN.sideIndex];
    if (!side || !sideB || side.orient !== ax.along) continue;
    const partSides = x.span.parts.map((p) => {
      const dr = ctx.byRoom.get(p.roomId);
      return dr && dr.sides[p.sideIndex];
    });
    if (!onOutline(partSides)) continue;
    const A = nodeMap.get(side.from), B = nodeMap.get(sideB.to);
    if (!A || !B) continue;
    const n0 = x.dr.sides.length, n1 = drN.sides.length;
    const prev = x.dr.sides[(x.i - 1 + n0) % n0], next = drN.sides[(pN.sideIndex + 1) % n1];
    const halfOf = (adj, first) => {
      if (!adj || !adj.edgeIds || !adj.edgeIds.length) return 0;
      const id = first ? adj.edgeIds[0] : adj.edgeIds[adj.edgeIds.length - 1];
      return (priors.get(id) || 0) / 2;
    };
    const halfFrom = halfOf(prev, false), halfTo = halfOf(next, true);
    const forward = side.dir[ax.coord] > 0;
    cands.push({
      x, side, measureId: x.m.id, roomId: x.m.room, value: x.m.value, key: x.spanKey,
      // Centre line to centre line (right-angle corners, as the 전체 치수 check).
      centre: x.m.value + halfFrom + halfTo,
      lo: Math.min(A[ax.coord], B[ax.coord]), hi: Math.max(A[ax.coord], B[ax.coord]),
      level: A[ax.level],
      gLow: gOf(forward ? side.from : sideB.to), gHigh: gOf(forward ? sideB.to : side.from),
      halfLow: forward ? halfFrom : halfTo, halfHigh: forward ? halfTo : halfFrom,
    });
  }
  if (cands.length < 2) return [];

  const firstRuns = buildRuns(cands.filter((c) => ax.firstFacing(c.side)), (c, best) => c.level < best.level - COORD_TOL);
  const secondRuns = buildRuns(cands.filter((c) => ax.secondFacing(c.side)), (c, best) => c.level > best.level + COORD_TOL);
  if (!firstRuns.length || !secondRuns.length) return [];

  // Order of wall lines in the drawing (walls along the axis keep their drawn direction).
  const order = orderRelation(project, gOf, ax, nodeMap);
  const comparisons = [];
  for (const A of firstRuns) {
    for (const B of secondRuns) {
      // The longest stretch both parts cover between the same wall lines: from their first to their
      // last common wall line (both parts are gapless, so every wall line between is covered too).
      // A value typed later can only lengthen it, so what was shown stays shown.
      const common = A.bounds.filter((g) => B.bounds.includes(g));
      if (common.length >= 2) {
        const P = common[0], Q = common[common.length - 1];
        const ia = [A.bounds.indexOf(P), A.bounds.indexOf(Q)], ib = [B.bounds.indexOf(P), B.bounds.indexOf(Q)];
        if (ia[0] < ia[1] && ib[0] < ib[1]) {
          comparisons.push({ kind: 'equal', a: A.sides.slice(ia[0], ia[1]), b: B.sides.slice(ib[0], ib[1]) });
        }
        continue;
      }
      // Ends on different wall lines: the part drawn around the other, cut to the stretch that just
      // encloses it, may not be the shorter one.
      const around = enclosingPart(order, A, B);
      if (around) { comparisons.push({ kind: 'order', a: A.sides, b: around, shorter: 1 }); continue; }
      const aroundB = enclosingPart(order, B, A);
      if (aroundB) comparisons.push({ kind: 'order', a: aroundB, b: B.sides, shorter: 0 });
    }
  }

  const out = [];
  const keys = new Set();
  for (const cmp of comparisons) {
    const res = closureItem(ctx, axisName, ax, order, cmp);
    if (!res || keys.has(res.item.key)) continue;
    keys.add(res.item.key);
    out.push(res);
  }
  return out;
}

// The shortest stretch of row part `outer` that starts at or before `inner`'s first wall line and ends
// at or after its last one in the drawn order. → [cand] | null
function enclosingPart(order, inner, outer) {
  const first = inner.bounds[0], last = inner.bounds[inner.bounds.length - 1];
  let i = -1, j = -1;
  for (let k = 0; k < outer.bounds.length; k++) {
    const s = order.sign(outer.bounds[k], first);
    if (s !== null && s >= 0) i = k;
  }
  for (let k = outer.bounds.length - 1; k >= 0; k--) {
    const s = order.sign(last, outer.bounds[k]);
    if (s !== null && s >= 0) j = k;
  }
  return i >= 0 && j > i ? outer.sides.slice(i, j) : null;
}

// One closure comparison as a check item. cmp: { kind: 'equal' | 'order', a: [cand] (first row),
// b: [cand] (second row), shorter: (order) the row drawn enclosing the other, which may not be shorter }
// → { item, measureIds } | null when the rows agree (or are the same side seen from both faces)
function closureItem(ctx, axisName, ax, order, cmp) {
  const total = (row) => row.reduce((s, c) => s + c.centre, 0);
  const first = { sides: cmp.a, start: cmp.a[0].gLow, end: cmp.a[cmp.a.length - 1].gHigh, total: total(cmp.a) };
  const second = { sides: cmp.b, start: cmp.b[0].gLow, end: cmp.b[cmp.b.length - 1].gHigh, total: total(cmp.b) };
  // Two single sides of the same wall are the two-sided check, not a closure.
  const keysA = first.sides.map((c) => c.key || c.side.key).sort().join(',');
  const keysB = second.sides.map((c) => c.key || c.side.key).sort().join(',');
  if (keysA === keysB) return null;
  const LT = first.total, LB = second.total;
  const kind = cmp.kind;
  let amount, shorter;
  if (kind === 'equal') {
    amount = Math.abs(LT - LB);
    shorter = LT < LB ? 0 : 1;
  } else if (cmp.shorter === 1) {
    amount = LT - LB;     // the second row spans at least the first row's extent
    shorter = 1;
  } else {
    amount = LB - LT;
    shorter = 0;
  }
  if (!(amount > CLOSURE_INFO_MIN_MM)) return null;

  const tol = ctx.settings.closureTolerance;
  const level = amount > tol ? LEVEL_CHECK : LEVEL_INFO;
  const rows = [first, second];
  const rowText = (row) => row.sides.map((c) => plain(c.value)).join(' + ');
  const [nA, nB] = ax.names;
  const tA = rowText(first), tB = rowText(second);
  const outer = (row) => row.total + row.sides[0].halfLow + row.sides[row.sides.length - 1].halfHigh;
  const d = plain(amount);
  let message;
  if (kind === 'equal') {
    const longer = ax.names[1 - shorter];
    message = `${nA}(${tA})과 ${nB}(${tB})을 벽 두께까지 넣어 더하면 ${longer}이 ${d}mm 깁니다`
      + ` (${nA} ${plain(outer(first))} / ${nB} ${plain(outer(second))}).`;
  } else {
    const shortName = ax.names[shorter], longName = ax.names[1 - shorter];
    message = `${nA}(${tA})과 ${nB}(${tB})이 맞지 않습니다. 그림에서는 ${shortName}이 ${longName}보다`
      + ` 더 길게 그려져 있는데, 잰 값을 벽 두께까지 넣어 더하면 오히려 ${d}mm 짧습니다.`;
  }
  message += level === LEVEL_CHECK
    ? ' 길이를 다시 재 보세요.'
    : ` 허용 범위(${plain(tol)}mm) 안이라 벽 두께로 맞췄습니다.`;

  const points = [];
  for (const row of rows) for (const c of row.sides) points.push(...sideWorldPoints(ctx, c.side));
  const stepEdges = kind === 'order'
    ? (order.path(first.end, second.end) || order.path(second.end, first.end)
      || order.path(first.start, second.start) || order.path(second.start, first.start) || [])
    : [];
  const stepPts = stepEdges.flatMap((id) => edgeWorldPoints(ctx, id));
  const measureIds = rows.flatMap((row) => row.sides.map((c) => c.measureId));
  const sig = (row) => row.sides.map((c) => `${c.measureId}=${plain(c.value)}`).join(',');
  const item = {
    key: `closure:${axisName}:${sig(first)}|${sig(second)}`,
    level,
    category: 'closure',
    message,
    where: {
      edgeId: stepEdges[0] || null,
      edgeIds: stepEdges,
      point: stepPts.length ? mid(stepPts[0], stepPts[1]) : centroid(points),
      points: points.concat(stepPts),
      measureIds,
      axis: axisName,
    },
    note: level === LEVEL_CHECK ? `※ 치수 폐합: ${nA} ${tA} / ${nB} ${tB} — 벽 두께 포함 ${d}mm 안 맞음, 확인필요` : null,
  };
  return { item, measureIds };
}

function centroid(points) {
  if (!points.length) return null;
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

// The gapless parts of a dimension row: per stretch along the axis, the best candidate (outermost)
// covering it; a stretch nobody covers, or two picks that do not meet on one wall line, ends a part.
// → [{ sides: [cand], bounds: [group, …] (the wall lines from the part's start to its end) }]
function buildRuns(cands, better) {
  if (!cands.length) return [];
  const cuts = [];
  for (const c of cands) cuts.push(c.lo, c.hi);
  cuts.sort((a, b) => a - b);
  const pts = [];
  for (const v of cuts) if (!pts.length || v - pts[pts.length - 1] > COORD_TOL) pts.push(v);
  const picks = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    let best = null;
    for (const c of cands) {
      if (c.lo > a + COORD_TOL || c.hi < b - COORD_TOL) continue;
      if (!best || better(c, best) || (Math.abs(c.level - best.level) <= COORD_TOL && c.value > best.value)) best = c;
    }
    picks.push(best);
  }
  const runs = [];
  let cur = null;
  const close = () => { if (cur && cur.length) runs.push(cur); cur = null; };
  for (const p of picks) {
    if (!p) { close(); continue; }
    if (cur && cur[cur.length - 1] === p) continue;
    if (cur && (cur.includes(p) || cur[cur.length - 1].gHigh !== p.gLow)) close();
    if (!cur) cur = [];
    cur.push(p);
  }
  close();
  return runs.map((seq) => ({ sides: seq, bounds: [seq[0].gLow, ...seq.map((c) => c.gHigh)] }));
}

// Drawn order of coordinate groups: walls along the axis keep their sketched direction (the solver's
// order rows), so a chain of them gives "group Q lies after group P".
function orderRelation(project, gOf, ax, nodeMap) {
  const next = new Map(); // group → [{ g, edgeId }] lying further along the axis
  for (const e of project.edges || []) {
    if (e.orient !== ax.along || !nodeMap.has(e.a) || !nodeMap.has(e.b)) continue;
    const ga = gOf(e.a), gb = gOf(e.b);
    if (ga === gb) continue;
    const s = e.sketch ? e.sketch[ax.sketch] : 0;
    if (!s) continue;
    const [p, q] = s > 0 ? [ga, gb] : [gb, ga];
    if (!next.has(p)) next.set(p, []);
    next.get(p).push({ g: q, edgeId: e.id });
  }
  // Edge ids of a path from P to Q going strictly forward, or null.
  const path = (P, Q) => {
    if (P === Q) return [];
    const prev = new Map([[P, null]]);
    const queue = [P];
    while (queue.length) {
      const g = queue.shift();
      for (const { g: h, edgeId } of next.get(g) || []) {
        if (prev.has(h)) continue;
        prev.set(h, { g, edgeId });
        if (h === Q) {
          const out = [];
          for (let cur = Q; prev.get(cur); cur = prev.get(cur).g) out.unshift(prev.get(cur).edgeId);
          return out;
        }
        queue.push(h);
      }
    }
    return null;
  };
  const sign = (P, Q) => {
    if (P === Q) return 0;
    if (path(P, Q)) return 1;
    if (path(Q, P)) return -1;
    return null;
  };
  return { sign, path };
}

// ---- 전체 치수 against its parts (plan §6) --------------------------------------------------------

// A measured overall length (a side, or a span across dividers / walls) whose two ends lie on the same
// wall lines (coordinate groups, as in the closure) as a chain of at least two other measured sides along
// the same axis. Both are summed centre line to centre line (value + half of the assumed walls at its
// ends), so "parts + the assumed walls between them" is compared with the overall value (예시 세대 B: 4520
// against 1250 + 100 + 3160). Of several chains under one overall value the one that agrees best is
// used (a two-sided twin or a nested measure gives a second chain; their own checks report them).
// Above closureTolerance → a 확인필요 item; below it nothing. → Set of the measure ids of reported items
// A value typed on a side made only of 구역 나누기 lines ('안 넣어도 됨', e.g. the open 주방 | 거실 line) is
// compared with the chain on the FAR side of its room as well, and one part is enough (review 0.5.1:
// 2600 typed there against 2800 + 400 above was spread over three values, each below the tolerance, and
// nothing was shown although the open width missed by 700 mm).
const OVERALL_MAX_CHAINS = 4000;
function overallChecks(ctx, push, closure) {
  const ids = new Set();
  const tol = ctx.settings.closureTolerance;
  const { nodeMap, priors } = ctx;
  const project = ctx.project;
  const half = (side, atStart) => {
    if (!side || !side.edgeIds || !side.edgeIds.length) return 0;
    const id = atStart ? side.edgeIds[side.edgeIds.length - 1] : side.edgeIds[0];
    return (priors.get(id) || 0) / 2;
  };
  const reported = new Set();
  for (const axisName of ['x', 'y']) {
    const ax = AXES[axisName];
    const uf = new UnionFind();
    for (const n of project.nodes || []) uf.find(n.id);
    for (const e of project.edges || []) {
      if (e.orient === ax.across && nodeMap.has(e.a) && nodeMap.has(e.b)) uf.union(e.a, e.b);
    }
    // Candidates: measured sides and spans along this axis.
    const cands = [];
    const addCand = (x, firstDr, firstI, lastDr, lastI) => {
      const sides = firstDr.sides, lastSides = lastDr.sides;
      const side = sides[firstI], sideB = lastSides[lastI];
      if (!side || !sideB || side.orient !== ax.along) return;
      const A = nodeMap.get(side.from), B = nodeMap.get(sideB.to);
      if (!A || !B) return;
      const n0 = sides.length, n1 = lastSides.length;
      const hFrom = half(sides[(firstI - 1 + n0) % n0], true), hTo = half(lastSides[(lastI + 1) % n1], false);
      const forward = side.dir[ax.coord] > 0;
      cands.push({
        x, side, measureId: x.m.id, roomId: x.m.room, value: x.m.value,
        key: x.span ? x.spanKey : side.key,
        from: side.from, to: sideB.to,
        lo: Math.min(A[ax.coord], B[ax.coord]), hi: Math.max(A[ax.coord], B[ax.coord]),
        gLow: uf.find(forward ? side.from : sideB.to), gHigh: uf.find(forward ? sideB.to : side.from),
        halfLow: forward ? hFrom : hTo, halfHigh: forward ? hTo : hFrom,
        centre: x.m.value + hFrom + hTo,
        // Its dimension chain: the way the side faces (top / bottom, left / right row) and its wall line.
        facing: side.inwardNormal[ax.level] > 0 ? 1 : -1,
        line: A[ax.level],
        divider: !x.span && !!side.allDivider,
      });
    };
    for (const x of ctx.measures) if (x.valid) addCand(x, x.dr, x.i, x.dr, x.i);
    for (const x of ctx.spanMeasures || []) {
      if (!x.valid) continue;
      const pN = x.span.parts[x.span.parts.length - 1];
      const drN = ctx.byRoom.get(pN.roomId);
      if (drN) addCand(x, x.dr, x.i, drN, pN.sideIndex);
    }
    if (cands.length < 2) continue;

    for (const O of cands) {
      const len = O.hi - O.lo;
      const open = O.divider;   // a side of 구역 나누기 lines only: any chain between its wall lines
      // Parts on the same chain only (integration, plan §6 "전체 치수 … 그 값과도 비교"): sides facing
      // the same way, or on O's own wall line from its other face. The opposite side of the same room
      // (top parts against a measured bottom) is the closure's business; reporting it here printed the
      // same difference twice.
      const inside = cands.filter((c) => c !== O && c.measureId !== O.measureId
        && (open ? c.key !== O.key : (c.facing === O.facing || Math.abs(c.line - O.line) <= COORD_TOL))
        && c.lo >= O.lo - COORD_TOL && c.hi <= O.hi + COORD_TOL
        && (open || c.hi - c.lo < len - COORD_TOL));
      const minParts = open ? 1 : 2;
      if (inside.length < minParts) continue;
      const byLow = new Map();
      for (const c of inside) {
        if (!byLow.has(c.gLow)) byLow.set(c.gLow, []);
        byLow.get(c.gLow).push(c);
      }
      let best = null, explored = 0;
      const walk = (g, at, path) => {
        for (const c of byLow.get(g) || []) {
          if (++explored > OVERALL_MAX_CHAINS) return;
          if (c.lo < at - COORD_TOL) continue;
          const next = path.concat(c);
          if (c.gHigh === O.gHigh) {
            if (next.length < minParts) continue;
            const total = next.reduce((s, q) => s + q.centre, 0);
            const diff = O.centre - total;
            if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { chain: next, total, diff };
            continue;
          }
          walk(c.gHigh, c.hi, next);
        }
      };
      walk(O.gLow, O.lo, []);
      if (!best || !(Math.abs(best.diff) > tol)) continue;
      const chain = best.chain;
      const all = [O, ...chain];
      // The closure check already reports exactly these values (e.g. the parts are the other row).
      if (closure && all.every((c) => closure.explained.has(c.measureId))) continue;
      const sig = `${O.key}|${chain.map((c) => c.key).sort().join(',')}`;
      if (reported.has(sig)) continue;
      reported.add(sig);
      const v = plain(O.value);
      const partsText = chain.map((c) => plain(c.value)).join(' + ');
      let walls = 0;
      for (let j = 0; j + 1 < chain.length; j++) walls += chain[j].halfHigh + chain[j + 1].halfLow;
      const hasWall = walls > 0.5;
      const sumInner = best.total - O.halfLow - O.halfHigh;
      // '= sum' only when something was added up (an open side compared with one wall: no '= 3850').
      const sumText = chain.length > 1 || hasWall ? ` = ${plain(sumInner)}` : '';
      // '거실 위쪽 벽 전체' (a span's location already ends in '벽 전체'); '주방 아래쪽 구역 나누기 선'.
      const loc = open ? ctx.sideLocation(O.roomId, O.side.key, '구역 나누기 선')
        : (O.x.spanLoc || `${ctx.sideLocation(O.roomId, O.side.key)} 전체`);
      const word = sideDirectionWord(O.side);
      // The parts of an open side are usually the walls across the room: '맞은편'.
      const across = open && chain.every((c) => c.facing !== O.facing);
      const partsWord = across ? '맞은편' : '구간 합계';
      const pts = [];
      for (const c of all) {
        const a = nodeMap.get(c.from), b = nodeMap.get(c.to);
        if (a && b) pts.push({ x: a.x, y: a.y }, { x: b.x, y: b.y });
      }
      const where = { ...sideWhere(ctx, O.roomId, O.side), measureId: O.measureId, measureIds: all.map((c) => c.measureId), points: pts };
      for (const c of all) ids.add(c.measureId);
      push({
        key: `overall:${O.measureId}=${v}|${chain.map((c) => `${c.measureId}=${plain(c.value)}`).join(',')}`,
        level: LEVEL_CHECK,
        category: 'overall',
        message: `${loc} ${v} / ${partsWord} ${partsText}${hasWall ? ` + 벽 ${plain(walls)}` : ''}${sumText}`
          + ` — ${plain(Math.abs(best.diff))}mm 차이가 납니다 (허용 ${plain(tol)}mm). 길이를 다시 재 보세요.`,
        where,
        note: open
          ? `※ ${word} 구역 나누기 선 ${v} / ${partsWord} ${partsText}${hasWall ? ' + 벽' : ''} — 확인필요`
          : `※ ${word} 전체 ${v} / 구간 합계 ${partsText}${hasWall ? ' + 벽' : ''} — 확인필요`,
      });
    }
  }
  return ids;
}

// ---- two-sided values --------------------------------------------------------------------------

// → Set of the measure ids that take part in a 확인필요-level two-sided difference.
function twoSideChecks(ctx, push) {
  const tol = ctx.settings.twoSideTolerance;
  const twoSideIds = new Set();
  const byKey = new Map();
  for (const x of ctx.measures) {
    if (!x.valid) continue;
    const key = x.side.key;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(x);
  }
  // A span (a side cut by 구역 나누기 dividers) pairs with the other face's side of the same corners.
  for (const x of ctx.spanMeasures || []) {
    if (!x.valid) continue;
    if (!byKey.has(x.spanKey)) byKey.set(x.spanKey, []);
    byKey.get(x.spanKey).push(x);
  }
  const sidesOf = (x) => (x.span
    ? x.span.parts.map((p) => ({ roomId: p.roomId, sideKey: p.sideKey }))
    : [{ roomId: x.m.room, sideKey: x.side.key }]);
  const nameOf = (x) => (x.span ? x.spanLoc.replace(/ [^ ]+ 벽 전체$/, '') : ctx.label(x.m.room));
  // The pair is written in a fixed order, whichever face was typed first (review 0.5.1: '방3 쪽 2700 /
  // 주방 쪽 2800' or '주방 쪽 2800 / 방3 쪽 2700' depending on the entry order): the room on the left of
  // a vertical wall, above a horizontal one, first (reading order); else the rooms' order in the plan.
  const roomIndex = new Map(((ctx.derived && ctx.derived.rooms) || []).map((dr, k) => [dr.roomId, k]));
  const readingRank = (x) => {
    const n = x.side.inwardNormal || { x: 0, y: 0 };
    if (x.side.orient === 'v') return n.x < 0 ? 0 : 1;   // a right wall: its room is on the left
    if (x.side.orient === 'h') return n.y < 0 ? 0 : 1;   // a bottom wall: its room is above
    return 0;
  };
  const before = (p, q) => readingRank(p) - readingRank(q)
    || (roomIndex.get(p.m.room) ?? 0) - (roomIndex.get(q.m.room) ?? 0)
    || String(p.m.id).localeCompare(String(q.m.id));
  // model.js twoSidePairs entries of h / v walls whose two faces differ because one ends at a diagonal
  // wall (`faces`, fixer 2026-10-20). → Map 'idA|idB' → pair
  const facePairs = new Map();
  for (const p of (ctx.derived && ctx.derived.twoSidePairs) || []) {
    if (p && p.faces && Array.isArray(p.measureIds)) facePairs.set(p.measureIds.slice().sort().join('|'), p);
  }
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        let a = list[i], b = list[j];
        if (a.m.room === b.m.room) continue;
        if (before(a, b) > 0) [a, b] = [b, a];
        const diagonal = a.side.orient === 'd' || b.side.orient === 'd';
        // The two faces of a diagonal wall differ in length wherever its corners are not alike (2026-10-19):
        // compared is how far the two values miss the two drawn faces apart (the residuals' difference).
        // So do the faces of an h / v wall one of which ends at a diagonal wall (`faces`): compared is
        // how much more the values differ than the faces do; within the tolerance nothing is said, as
        // the print shows both values (dims.js rule 1).
        const faces = !diagonal ? facePairs.get([a.m.id, b.m.id].sort().join('|')) : null;
        const rawDiff = Math.abs(a.m.value - b.m.value);
        const diff = diagonal ? diagonalExcess(ctx, a, b) : faces && isNum(faces.excess) ? faces.excess : rawDiff;
        const check = diff > tol;
        // Within the tolerance: a 참고 item when the two values differ, because the print (dims.js rule 1 /
        // rule 7) shows ONE dimension per wall with the larger value, for a diagonal wall too.
        if (!check && (rawDiff < 1 || faces)) continue;
        // Located at the plain side when there is one (a span's first part may be anywhere).
        const at = a.span && !b.span ? b : a;
        const loc = at.spanLoc || ctx.sideLocation(at.m.room, at.side.key);
        const vals = `${nameOf(a)} 쪽 ${plain(a.m.value)} / ${nameOf(b)} 쪽 ${plain(b.m.value)}`;
        const where = sideWhere(ctx, at.m.room, at.side);
        where.sides = sidesOf(a).concat(sidesOf(b));
        where.measureIds = [a.m.id, b.m.id];
        if (check) for (const x of [a, b]) twoSideIds.add(x.m.id);
        push({
          key: twoSideKey([a.m, b.m]),
          level: check ? LEVEL_CHECK : LEVEL_INFO,
          category: check ? 'twoSide' : 'twoSidePair',
          message: diagonal
            ? (check
              ? `${loc}: ${vals} — 같은 사선 벽의 양쪽 면인데, 그림의 두 면 길이와 ${plain(diff)}mm 맞지 않습니다. 다시 재 보세요.`
              : `${loc}: ${vals} (같은 사선 벽의 양쪽 면). 도면에는 큰 값 ${plain(Math.max(a.m.value, b.m.value))}만 적습니다.`)
            : faces
              ? `${loc}: ${vals} — 같은 벽의 양쪽 면인데(한쪽 면은 사선 벽에서 끝납니다), 그림의 두 면 길이와 ${plain(diff)}mm 맞지 않습니다. 다시 재 보세요.`
            : check
              ? `${loc}: ${vals} — ${plain(diff)}mm 차이가 납니다. 다시 재 보세요.`
              : `${loc}: ${vals} (차이 ${plain(diff)}mm). 도면에는 큰 값 ${plain(Math.max(a.m.value, b.m.value))}만 적습니다.`,
          where,
          note: check ? `※ ${loc}: ${vals} — 확인필요` : null,
        });
      }
    }
  }
  return twoSideIds;
}

// How much more (or less) two values of the faces of one diagonal wall differ than the two faces drawn
// do: |residual a − residual b| (solve.measureResiduals: drawn − value). Without residuals, the values'
// difference. → mm
function diagonalExcess(ctx, a, b) {
  const res = ctx.derived && ctx.derived.solve && ctx.derived.solve.measureResiduals;
  const ra = res && typeof res.get === 'function' ? res.get(a.m.id) : null;
  const rb = res && typeof res.get === 'function' ? res.get(b.m.id) : null;
  return isNum(ra) && isNum(rb) ? Math.abs(ra - rb) : Math.abs(a.m.value - b.m.value);
}

// ---- engine warnings ---------------------------------------------------------------------------

// Axes a length runs along: a horizontal side fixes x, a vertical one y, a diagonal one both.
const axesOfOrient = (o) => (o === 'h' ? ['x'] : o === 'v' ? ['y'] : ['x', 'y']);
const measureAxes = (x) => axesOfOrient(x.span ? x.ends.orient : x.side.orient);

// Why a residual / absorbed / conflict item is only 참고 (review 0.5.1, field test 예시 세대 A: A16 typed 14700
// instead of 1470 made six CORRECT values 확인필요 '벽 두께를 … 바꿨습니다. 길이를 다시 확인해 주세요').
//   own:  the measure itself is part of the explaining item (its own consequence; always 참고);
//   axis: an open (not 확인 완료) 확인필요 item names a wrong value along the same axis — a missing zero
//         in one vertical length moves every wall line across y, so the other y values cannot fit.
const OWN_REASON = {
  twoSide: ' 위의 양쪽 값 차이 때문입니다.',
  closure: ' 위의 치수 폐합 문제 때문입니다.',
  overall: ' 위의 전체 치수와 구간 합계 차이 때문입니다.',
  outlier: ' 위의 다시 확인 값 때문입니다.',
};
const AXIS_REASON = {
  outlier: ' 위의 다시 확인 값 때문일 수 있습니다.',
  fold: ' 위의 벽이 엇갈리는 값 때문일 수 있습니다.',
  twoSide: ' 위의 양쪽 값 차이 때문일 수 있습니다.',
  overall: ' 위의 전체 치수와 구간 합계 차이 때문일 수 있습니다.',
  closure: ' 위의 치수 폐합 문제 때문일 수 있습니다.',
};
const AXIS_PRIORITY = ['outlier', 'fold', 'twoSide', 'overall', 'closure'];
// An absorbed / conflict item before other values tie both ends of its run (review 0.5.1): with only a
// few values the assumed walls give to the sketch's proportions, not to a contradiction between values.
const EARLY_REASON = ' 아직 이 벽의 양 끝을 잇는 다른 값이 없어, 그림 비율 때문일 수 있습니다. 값을 더 넣으면 다시 확인합니다.';

// → { own(measureId, order) → reason | null, axis(axes) → reason | null,
//     outlierOpen: an open (not 확인 완료) 다시 확인 item — outlier or outlierPair — exists }
function explainers(ctx, items, { closure, twoSideIds, overallIds, outlierIds }) {
  const resolved = resolvedKeys(ctx.project);
  const byAxis = { x: new Set(), y: new Set() };
  let outlierOpen = false;
  for (const it of items) {
    if (!it || isKeyResolved(resolved, it.key)) continue;
    if (it.level === LEVEL_CHECK && it.category === 'outlier') outlierOpen = true;
    // A 벽이 엇갈리는 값 made 참고 only by an open 다시 확인 elsewhere (foldItem: _explainAs) still
    // explains its axes, as that 다시 확인: what it explained before stays 참고.
    const as = it.level === LEVEL_CHECK ? it.category : it._explainAs || null;
    if (!as || !AXIS_PRIORITY.includes(as)) continue;
    const w = it.where || {};
    let axes = [];
    if (it.category === 'closure') axes = w.axis ? [w.axis] : [];
    else {
      const ids = Array.isArray(w.measureIds) && w.measureIds.length ? w.measureIds : w.measureId ? [w.measureId] : [];
      for (const id of ids) {
        const x = ctx.measureInfo.get(id);
        if (x) axes.push(...measureAxes(x));
      }
      if (!ids.length && it.category === 'fold') axes = ['x', 'y'];
    }
    for (const a of axes) if (byAxis[a]) byAxis[a].add(as);
  }
  const sets = { twoSide: twoSideIds, closure: closure && closure.explained, overall: overallIds, outlier: outlierIds };
  return {
    own: (id, order) => order.find((r) => sets[r] && sets[r].has(id)) || null,
    axis: (axes) => AXIS_PRIORITY.find((r) => axes.some((a) => byAxis[a] && byAxis[a].has(r))) || null,
    outlierOpen,
  };
}

// The items that name a value as wrong: 다시 확인 (outlier) and 벽이 엇갈리는 값 (fold). They come before
// the other engine warnings, which they may explain. → Set of the outlier measure ids
function valueWarningChecks(ctx, push) {
  const warnings = (ctx.derived && ctx.derived.warnings) || [];
  const resolved = resolvedKeys(ctx.project);
  const outlierIds = new Set();
  const outlierAxes = new Set();   // axes of the open (not 확인 완료) outliers
  for (const w of warnings) {
    if (!w || w.type !== 'outlier') continue;
    const x = ctx.measureInfo.get(w.measureId);
    if (!x || !x.valid) continue;
    outlierIds.add(x.m.id);
    if (!isKeyResolved(resolved, `outlier:${x.m.id}=${plain(x.m.value)}`)) for (const a of measureAxes(x)) outlierAxes.add(a);
  }
  for (const w of warnings) {
    if (!w || w.type !== 'outlierPair') continue;
    const it = outlierPairItem(ctx, w);
    if (!it) continue;
    // Its axes explain the other items like a 다시 확인 does; neither value is called wrong by itself.
    if (!isKeyResolved(resolved, it.key)) for (const x of it._xs) for (const a of measureAxes(x)) outlierAxes.add(a);
  }
  for (const w of warnings) {
    if (!w || typeof w !== 'object') continue;
    try {
      if (w.type === 'outlier') {
        const x = ctx.measureInfo.get(w.measureId);
        if (!x || !x.valid) continue;
        const loc = x.spanLoc || ctx.sideLocation(x.m.room, x.side.key);
        const v = plain(x.m.value);
        push({
          key: `outlier:${x.m.id}=${v}`,
          level: LEVEL_CHECK, category: 'outlier',
          message: `${loc} ${v}: 다른 길이에 비해 너무 크거나 작습니다. 0을 빼먹거나 더 붙이지 않았는지 다시 확인해 주세요.`,
          where: { ...sideWhere(ctx, x.m.room, x.side), measureId: x.m.id },
          note: `※ ${loc} ${v} — 다시 확인필요`,
        });
      } else if (w.type === 'outlierPair') {
        const it = outlierPairItem(ctx, w);
        if (it) { delete it._xs; push(it); }
      } else if (w.type === 'fold') {
        foldItem(ctx, push, w, outlierIds, outlierAxes);
      }
    } catch (err) {
      console.error('[checks] warning failed', w, err);
    }
  }
  return outlierIds;
}

// Exactly two values that disagree more than a missing zero allows, and the drawing cannot tell which
// one is off (model.js outlierWarnings: { type: 'outlierPair', measureIds: [a, b] }; review 0.5.1 #2:
// before, both got '0을 빼먹거나…', so the surveyor might "fix" the correct one). One neutral item
// naming both; a third value then decides (the median rule names the wrong one alone).
// → item (with _xs: the two measure infos) | null
function outlierPairItem(ctx, w) {
  const xs = [...new Set(w.measureIds || [])].map((id) => ctx.measureInfo.get(id)).filter((x) => x && x.valid);
  if (xs.length !== 2) return null;
  const at = (x) => `${x.spanLoc || ctx.sideLocation(x.m.room, x.side.key)} ${plain(x.m.value)}`;
  const [p, q] = xs.map(at);
  const base = sideWhere(ctx, xs[0].m.room, xs[0].side);
  return {
    key: `outlierPair:${xs.map((x) => `${x.m.id}=${plain(x.m.value)}`).sort().join(',')}`,
    level: LEVEL_CHECK, category: 'outlier',
    message: `${p} / ${q}: 두 값 중 하나가 그림과 맞지 않습니다. 0을 빼먹거나 더 붙인 값이 없는지 두 값을 확인해 주세요.`,
    where: { ...base, measureId: xs[0].m.id, measureIds: xs.map((x) => x.m.id),
      points: base.points.concat(sideWorldPoints(ctx, xs[1].side)) },
    note: `※ ${p} / ${q} — 둘 중 하나 다시 확인필요`,
    _xs: xs,
  };
}

// Contract C1 (ENGINE → CHECKS): the solve made walls cross or overlap that did not before this
// command; w = { type: 'fold', measureIds (the likely value first), edgeIds (the crossing walls) }. One
// 확인필요 on the value, instead of 'redraw the wall' advice on the walls (drawingChecks leaves them out).
//   outlierAxes: axes of the open 다시 확인 items (empty when none is open).
function foldItem(ctx, push, w, outlierIds, outlierAxes) {
  const xs = [...new Set(w.measureIds || [])].map((id) => ctx.measureInfo.get(id)).filter((x) => x && x.valid);
  const edgeIds = [...new Set(w.edgeIds || [])].filter((id) => ctx.edgeMap.has(id));
  const edgePts = edgeIds.flatMap((id) => edgeWorldPoints(ctx, id));
  const first = xs[0] || null;
  // An open 다시 확인 (a missing or extra zero) rescales the whole plan, on both axes: while it is open
  // a fold that does not name it is 참고 (review 0.5.1 round 2: 예시 세대 A A19 typed 36000 first, then the list
  // order — a fold named the CORRECT 화장실2 980 on y for all 22 values, next to the 다시 확인 on x).
  const outlierOpen = outlierAxes.size > 0;
  if (first) {
    const at = (x) => x.spanLoc || ctx.sideLocation(x.m.room, x.side.key);
    const loc = at(first), v = plain(first.m.value);
    const others = xs.slice(1).map((x) => `${at(x)} ${plain(x.m.value)}`);
    // A value already called 다시 확인 (a missing zero) is the likely cause: one problem, one 확인필요
    // (예시 세대 A test: 주방 280 instead of 2800, typed early, folded the plan when correct values came later,
    // and the engine named those later values).
    const named = xs.some((x) => outlierIds.has(x.m.id));
    const reason = named ? OWN_REASON.outlier : outlierOpen ? AXIS_REASON.outlier : null;
    const base = sideWhere(ctx, first.m.room, first.side);
    push({
      key: `fold:${xs.map((x) => `${x.m.id}=${plain(x.m.value)}`).sort().join(',')}`,
      level: reason ? LEVEL_INFO : LEVEL_CHECK,
      category: 'fold',
      message: `${loc} ${v}: 이 값이면 벽이 엇갈립니다${others.length ? `(함께 볼 값: ${others.join(', ')})` : ''}.`
        + (reason || ' 값을 다시 확인해 주세요.'),
      where: { ...base, measureId: first.m.id, measureIds: xs.map((x) => x.m.id), edgeIds, points: base.points.concat(edgePts) },
      note: reason ? null : `※ ${loc} ${v}: 이 값이면 벽이 엇갈림 — 다시 확인필요`,
      _explainAs: !named && outlierOpen ? 'outlier' : null,
    });
    return;
  }
  if (!edgeIds.length) return;
  const loc = ctx.edgeLocation(edgeIds[0]);
  push({
    key: `fold:${edgeIds.slice().sort().join('|')}`,
    level: outlierOpen ? LEVEL_INFO : LEVEL_CHECK, category: 'fold',
    message: `${loc}: 길이 값 때문에 벽이 엇갈렸습니다.${outlierOpen ? AXIS_REASON.outlier : ' 값을 다시 확인해 주세요.'}`,
    where: { edgeId: edgeIds[0], edgeIds, point: edgePts.length ? mid(edgePts[0], edgePts[1]) : null, points: edgePts },
    note: outlierOpen ? null : `※ ${loc}: 길이 값 때문에 벽이 엇갈림 — 확인필요`,
    _explainAs: outlierOpen ? 'outlier' : null,
  });
}

// explain: explainers(); opts: as runChecks (window / door labels).
function engineWarningChecks(ctx, push, explain, opts = {}) {
  const warnings = (ctx.derived && ctx.derived.warnings) || [];
  let fixed = null; // lazily built: which unmeasured sides other measures already fix
  for (const w of warnings) {
    if (!w || typeof w !== 'object') continue;
    try {
      if (w.type === 'unmeasured') {
        const dr = ctx.byRoom.get(w.roomId);
        const side = dr && dr.sides.find((s) => s.key === w.sideKey);
        if (!side) continue;
        const loc = ctx.sideLocation(w.roomId, w.sideKey);
        fixed = fixed || fixedByMeasures(ctx);
        const determined = fixed(side);
        // '다른 실에서 잰 길이로' only when other rooms' values alone fix it (a chamfer's bottom wall is
        // fixed by its own room's top and diagonal values: '다른 길이로').
        const byOthers = determined && ctx.ties().sideFixedByOthers(side, w.roomId);
        push({
          key: `unmeasured:${w.roomId}:${w.sideKey}`,
          level: LEVEL_INFO, category: 'unmeasured',
          message: determined
            ? `${loc}: 길이를 넣지 않았지만, ${byOthers ? '다른 실에서 잰 길이로' : '다른 길이로'} 정해집니다.`
            : `${loc}: 길이를 아직 넣지 않았습니다.`,
          where: { ...sideWhere(ctx, w.roomId, side), determined },
          note: null,
        });
        continue;
      }
      // twoSide: twoSideChecks (same rule, with both values); outlier / fold: valueWarningChecks.
      if (w.type === 'twoSide' || w.type === 'outlier' || w.type === 'fold') continue;
      if (w.type === 'conflict') { conflictItem(ctx, push, w, explain); continue; }
      if (w.type === 'openingFit') { openingFitItem(ctx, push, w, opts); continue; }
      if (w.type === 'gapPlaced') { gapPlacedItem(ctx, push, w); continue; }
      const x = ctx.measureInfo.get(w.measureId);
      if (!x || !x.valid) continue;
      const loc = x.spanLoc || ctx.sideLocation(x.m.room, x.side.key);
      const v = plain(x.m.value);
      const where = { ...sideWhere(ctx, x.m.room, x.side), measureId: x.m.id };
      if (w.type === 'residual') {
        if (!(w.amount > RESIDUAL_MIN_MM)) continue;
        const own = explain.own(x.m.id, ['twoSide', 'closure', 'overall', 'outlier']);
        const along = own ? null : explain.axis(measureAxes(x));
        const check = !!w.check && !own && !along;
        const diag = x.side.orient === 'd';
        const why = own ? OWN_REASON[own] : along ? AXIS_REASON[along] : '';
        push({
          key: `residual:${x.m.id}=${v}`,
          level: check ? LEVEL_CHECK : LEVEL_INFO,
          category: 'residual',
          message: diag
            ? `${loc}: 잰 사선 길이 ${v}, 다른 길이로 계산하면 ${plain(w.drawn)} (${plain(w.amount)}mm 차이). 사선 길이나 주변 벽 길이를 확인해 주세요.${why}`
            : `${loc}: 잰 값 ${v}, 그림 ${plain(w.drawn)} (${plain(w.amount)}mm 차이). 다른 길이 값과 맞지 않습니다.${why}`,
          where,
          note: check ? `※ ${loc} ${v}: 다른 길이와 ${plain(w.amount)}mm 안 맞음 — 확인필요` : null,
        });
      } else if (w.type === 'absorbed') {
        const own = explain.own(x.m.id, ['twoSide', 'overall', 'outlier']);
        const along = own ? null : explain.axis(measureAxes(x));
        // Review 0.5.1 (#6): 확인필요 only once other values tie both ends of this run, so that the walls
        // really had to give to make the values agree.
        const early = !own && !along && !ctx.ties().runTied(x);
        const check = !own && !along && !early;
        push({
          key: `absorbed:${x.m.id}=${v}`,
          level: check ? LEVEL_CHECK : LEVEL_INFO,
          category: 'absorbed',
          message: `${loc} ${v}: 다른 길이와 맞추려고 벽 두께를 ${plain(w.amount)}mm 바꿨습니다.`
            + (own ? OWN_REASON[own] : along ? AXIS_REASON[along] : early ? EARLY_REASON : ' 길이를 다시 확인해 주세요.'),
          where,
          note: check ? `※ ${loc} ${v}: 벽 두께로 ${plain(w.amount)}mm 맞춤 — 확인필요` : null,
        });
      }
    } catch (err) {
      console.error('[checks] warning failed', w, err);
    }
  }
}

// The order safeguard stopped an h/v wall from folding; the walls absorbed `amount` mm instead. Since
// contract C3 the engine reports this only when values, wall thicknesses or finishes had to give (when
// only unmeasured lines moved it is 'gapPlaced'). Still 참고 while another open item explains the axis,
// or while no values tie the wall's two ends (review 0.5.1, #6).
function conflictItem(ctx, push, w, explain) {
  const e = ctx.edgeMap.get(w.edgeId);
  if (!e) return;
  const along = explain.axis(axesOfOrient(e.orient));
  const early = !along && !ctx.ties().edgeTied(e);
  const check = !along && !early;
  const loc = ctx.edgeLocation(w.edgeId);
  const pts = edgeWorldPoints(ctx, w.edgeId);
  const a = plain(w.amount);
  push({
    key: `conflict:${w.edgeId}:${a}`,
    level: check ? LEVEL_CHECK : LEVEL_INFO,
    category: 'conflict',
    message: early
      ? `${loc}: 벽이 접히지 않도록 벽 두께로 ${a}mm를 맞췄습니다.${EARLY_REASON}`
      : `${loc}: 길이 값끼리 맞지 않아, 벽이 접히지 않도록 벽 두께로 ${a}mm를 맞췄습니다.`
        + (along ? AXIS_REASON[along] : ' 길이를 다시 확인해 주세요.'),
    where: { edgeId: w.edgeId, point: pts.length ? mid(pts[0], pts[1]) : null, points: pts },
    note: check ? `※ ${loc} 근처: 길이 값끼리 ${a}mm 안 맞음 — 확인필요` : null,
  });
}

// Contract C2 (ENGINE → CHECKS): a window / door with a typed width made its wall piece, which no value
// fixes, at least wide enough. w = { type: 'openingFit', openingId, edgeId, amount (mm added) }. 참고:
// the wall length is still a guess (an A19-like wrong value could hide behind it), measuring it settles it.
function openingFitItem(ctx, push, w, opts) {
  const o = (ctx.project.openings || []).find((q) => q && q.id === w.openingId) || null;
  const edgeId = ctx.edgeMap.has(w.edgeId) ? w.edgeId : o && ctx.edgeMap.has(o.edge) ? o.edge : null;
  if (!edgeId) return;
  const loc = ctx.edgeLocation(edgeId);
  const word = o ? openingWord(o) : '창·문';
  const text = o ? openingText(o, opts) : word;
  const by = isNum(w.amount) && w.amount >= 1 ? ` ${plain(w.amount)}mm` : '';
  const pts = edgeWorldPoints(ctx, edgeId);
  push({
    key: `openingFit:${w.openingId || ''}:${edgeId}`,
    level: LEVEL_INFO, category: 'openingFit',
    message: `${loc}의 ${text}: ${word}이 들어가도록 재지 않은 벽 길이를${by} 늘렸습니다. 벽 길이를 재서 넣으면 정확해집니다.`,
    // [위치 보기] opens the wall's length (what to measure), not the window panel.
    where: { edgeId, relatedOpeningId: w.openingId || null, point: pts.length ? mid(pts[0], pts[1]) : null, points: pts },
    note: null,
  });
}

// Contract C3 (ENGINE → CHECKS): only unmeasured coordinates moved to keep the drawn order; nothing had
// to give. w = { type: 'gapPlaced', edgeId, groupFrom, groupTo, length }. 참고 naming the gap: an
// unmeasured room side between the two wall lines when there is one ('현관 위쪽 벽'), else the wall.
function gapPlacedItem(ctx, push, w) {
  const e = ctx.edgeMap.get(w.edgeId);
  if (!e) return;
  const gap = gapSide(ctx, e, w);
  const pts = edgeWorldPoints(ctx, e.id);
  const len = isNum(w.length) && w.length > 0 ? `(${plain(w.length)}mm)` : '';
  const item = { key: `gapPlaced:${e.id}`, level: LEVEL_INFO, category: 'gapPlaced', note: null };
  if (gap) {
    push({
      ...item,
      message: `${ctx.sideLocation(gap.roomId, gap.side.key)}: 재지 않은 길이를 그림 순서에 맞춰 잡았습니다${len}. 재서 넣으면 정확해집니다.`,
      where: sideWhere(ctx, gap.roomId, gap.side),
    });
    return;
  }
  // No room side runs exactly between the two lines (예시 세대 A: the 50 mm step between the 옷장 divider and
  // 화장실1's right wall, a piece of the 옷장's top wall). Measuring that wall would not help: the step
  // follows from the parts of the plan the values do not tie together, so name a side that joins them
  // (예시 세대 A: the 현관 width, DESIGN §7.3) — or, without one, the wall itself.
  const bridge = gapBridge(ctx, e, w);
  const loc = ctx.edgeLocation(e.id);
  if (bridge) {
    const where = sideWhere(ctx, bridge.roomId, bridge.side);
    push({
      ...item,
      message: `${loc}: 재지 않은 길이를 그림 순서에 맞춰 잡았습니다${len}. ${ctx.sideLocation(bridge.roomId, bridge.side.key)} 길이를 재서 넣으면 정확해집니다.`,
      where: { ...where, points: where.points.concat(pts) },
    });
    return;
  }
  push({
    ...item,
    message: `${loc}: 재지 않은 길이를 그림 순서에 맞춰 잡았습니다${len}. 재서 넣으면 정확해집니다.`,
    where: { edgeId: e.id, point: pts.length ? mid(pts[0], pts[1]) : null, points: pts },
  });
}

// An unmeasured room side, along the gap's axis, whose value would tie the gap's two wall lines: one
// end tied by values to groupFrom's line, the other to groupTo's. Real named rooms first, then the
// shorter side (quicker to measure), then the plan's room order. → { roomId, side } | null
function gapBridge(ctx, e, w) {
  const nodeOf = (g) => (Array.isArray(g) ? g : [g]).find((id) => ctx.nodeMap.has(id)) || null;
  const from = nodeOf(w.groupFrom), to = nodeOf(w.groupTo);
  if (!from || !to || (e.orient !== 'h' && e.orient !== 'v')) return null;
  const axis = e.orient === 'h' ? 'x' : 'y';
  const ties = ctx.ties();
  if (ties.tied(axis, from, to)) return null;
  const measured = new Set(ctx.measures.filter((x) => x.valid).map((x) => `${x.m.room}|${x.side.key}`));
  const found = [];
  for (const dr of (ctx.derived && ctx.derived.rooms) || []) {
    for (const side of dr.sides || []) {
      if (side.orient !== e.orient || side.allDivider || measured.has(`${dr.roomId}|${side.key}`)) continue;
      const joins = (ties.tied(axis, side.from, from) && ties.tied(axis, side.to, to))
        || (ties.tied(axis, side.from, to) && ties.tied(axis, side.to, from));
      if (!joins) continue;
      const room = dr.room || {};
      found.push({ roomId: dr.roomId, side, rank: (room.notRoom ? 2 : 0) + (room.name ? 0 : 1), len: Math.abs(side.centerLength || 0) });
    }
  }
  found.sort((p, q) => p.rank - q.rank || p.len - q.len);
  return found[0] || null;
}

// An unmeasured room side, along the edge's axis, from wall line groupFrom to groupTo (the corners on
// the two lines: a node id or a list of them; anything else is ignored). The side of the gap's own wall
// first, then named rooms.
// → { roomId, side } | null
function gapSide(ctx, e, w) {
  const nodeOf = (g) => (Array.isArray(g) ? g : [g]).find((id) => ctx.nodeMap.has(id)) || null;
  const from = nodeOf(w.groupFrom), to = nodeOf(w.groupTo);
  if (!from || !to || (e.orient !== 'h' && e.orient !== 'v')) return null;
  const axis = e.orient === 'h' ? 'x' : 'y';
  const ties = ctx.ties();
  const want = [ties.group(axis, from), ties.group(axis, to)].sort().join('|');
  const measured = new Set(ctx.measures.filter((x) => x.valid).map((x) => `${x.m.room}|${x.side.key}`));
  const found = [];
  for (const dr of (ctx.derived && ctx.derived.rooms) || []) {
    for (const side of dr.sides || []) {
      if (side.orient !== e.orient || side.allDivider || measured.has(`${dr.roomId}|${side.key}`)) continue;
      const got = [ties.group(axis, side.from), ties.group(axis, side.to)].sort().join('|');
      if (got === want) found.push({ roomId: dr.roomId, side, own: side.edgeIds.includes(e.id), named: !!(dr.room && dr.room.name) });
    }
  }
  // The side the gap's own wall belongs to, then named rooms (stable otherwise: the plan's room order).
  found.sort((p, q) => Number(q.own) - Number(p.own) || Number(q.named) - Number(p.named));
  return found[0] || null;
}

// Which wall lines the measured values tie together (as the solver: nodes joined by walls across an
// axis share one coordinate, a group; a measured axis-aligned side ties the groups of its two ends; ties
// chain, so two measured neighbours tie the span over both). Assumed wall thicknesses count as known,
// as everywhere in the drawing.
//   group(axis, nodeId)              the node's coordinate group
//   tied(axis, a, b, exceptId?)      the two nodes' coordinates follow from the values (without one)
//   sideFixed(side)                  along every axis the side runs in
//   edgeTied(edge)                   a wall's two ends, along its own axes
//   runTied(x)                       a measure's side (a span: its outer corners) by the OTHER values
//   sideFixedByOthers(side, roomId)  fixed without the values of that room (the 'unmeasured' wording)
// A measured DIAGONAL side ties its ends on both axes once one of its projections is tied (solver.js
// contract C2: the diagonal value fixes the other by Pythagoras); with neither tied the solve holds only
// its length along the drawn direction, which ties nothing (fixer 2026-10-20). Not
// a diagonal value the solve could give no row (not longer than the projection the axis values
// fix: derived.solve.diagonalRows says rows '' while not both projections are tied). A corner in the
// middle of a straight diagonal wall (solver.straightDiagonalJoints) stays on that wall's line.
function measureTies(ctx) {
  const project = ctx.project;
  const axes = {};
  const roomsOf = (x) => (x.span ? new Set((x.span.parts || []).map((p) => p.roomId)) : new Set([x.m.room]));
  for (const [axis, across, along] of [['x', 'v', 'h'], ['y', 'h', 'v']]) {
    const groups = new UnionFind();
    for (const e of project.edges || []) {
      if (e.orient === across && ctx.nodeMap.has(e.a) && ctx.nodeMap.has(e.b)) groups.union(e.a, e.b);
    }
    const links = [];
    for (const x of ctx.measures) {
      if (x.valid && x.side.orient === along) links.push({ id: x.m.id, rooms: roomsOf(x), a: groups.find(x.side.from), b: groups.find(x.side.to) });
    }
    // A span ties its two outer corners (its parts are then fixed by the divider positions as drawn).
    for (const x of ctx.spanMeasures || []) {
      if (x.valid && x.ends.orient === along && ctx.nodeMap.has(x.ends.from) && ctx.nodeMap.has(x.ends.to)) {
        links.push({ id: x.m.id, rooms: roomsOf(x), a: groups.find(x.ends.from), b: groups.find(x.ends.to) });
      }
    }
    axes[axis] = { groups };
    axes[axis].links = links;
  }
  const solvedRows = ctx.derived && ctx.derived.solve && ctx.derived.solve.diagonalRows;
  const noRow = (id) => {
    const r = solvedRows && typeof solvedRows.get === 'function' ? solvedRows.get(id) : null;
    return !!r && !r.rows && !(r.tied && r.tied.x && r.tied.y);
  };
  let joints = [];
  try { joints = straightDiagonalJoints(project).filter((j) => ctx.nodeMap.has(j.m) && ctx.nodeMap.has(j.A) && ctx.nodeMap.has(j.B)); } catch (_) { joints = []; }
  const diagonals = [];
  const addDiagonal = (x, from, to) => {
    if (!x.valid || noRow(x.m.id) || !ctx.nodeMap.has(from) || !ctx.nodeMap.has(to)) return;
    diagonals.push({ id: x.m.id, rooms: roomsOf(x), ends: { x: [axes.x.groups.find(from), axes.x.groups.find(to)], y: [axes.y.groups.find(from), axes.y.groups.find(to)] } });
  };
  for (const x of ctx.measures) if (x.side.orient === 'd') addDiagonal(x, x.side.from, x.side.to);
  for (const x of ctx.spanMeasures || []) if (x.ends.orient === 'd') addDiagonal(x, x.ends.from, x.ends.to);
  // Both axes' ties without the values `skip` leaves out (cached by `key`).
  const byExcept = new Map();
  const tiesWithout = (key, skip) => {
    if (!byExcept.has(key)) {
      const uf = { x: new UnionFind(), y: new UnionFind() };
      for (const axis of ['x', 'y']) for (const l of axes[axis].links) if (!skip(l)) uf[axis].union(l.a, l.b);
      // A measured diagonal fixes its second projection (Pythagoras) only once its first one is fixed:
      // by the axis values, by another diagonal or along a straight diagonal wall (fixer 2026-10-20,
      // field: a cut corner whose two neighbour walls were left out, and a bay measured on its base and
      // both diagonals, were '정해집니다' while the sketch's angle placed them). With neither fixed only
      // the drawn angle places it: its neighbours stay unmeasured (and the print keeps ※ 치수 미입력).
      const open = diagonals.filter((g) => !skip(g));
      // Three corners of one straight diagonal wall: once two of them are fixed against each other on
      // both axes the line is, and the third is fixed as soon as one of its coordinates is.
      const both = (p, q) => uf.x.find(group('x', p)) === uf.x.find(group('x', q)) && uf.y.find(group('y', p)) === uf.y.find(group('y', q));
      const one = (p, q) => uf.x.find(group('x', p)) === uf.x.find(group('x', q)) || uf.y.find(group('y', p)) === uf.y.find(group('y', q));
      for (let changed = joints.length > 0 || open.length > 0, round = 0; changed && round < 50; round++) {
        changed = false;
        for (let k = open.length - 1; k >= 0; k--) {
          const g = open[k];
          if (uf.x.find(g.ends.x[0]) !== uf.x.find(g.ends.x[1]) && uf.y.find(g.ends.y[0]) !== uf.y.find(g.ends.y[1])) continue;
          uf.x.union(g.ends.x[0], g.ends.x[1]);
          uf.y.union(g.ends.y[0], g.ends.y[1]);
          open.splice(k, 1);
          changed = true;
        }
        for (const j of joints) {
          for (const [p, q, r] of [[j.A, j.B, j.m], [j.A, j.m, j.B], [j.m, j.B, j.A]]) {
            if (!both(p, q) || both(p, r) || !(one(p, r) || one(q, r))) continue;
            uf.x.union(group('x', p), group('x', r));
            uf.y.union(group('y', p), group('y', r));
            changed = true;
          }
        }
      }
      byExcept.set(key, uf);
    }
    return byExcept.get(key);
  };
  const tiedBy = (except) => (except == null ? tiesWithout('', () => false) : tiesWithout(`m:${except}`, (l) => l.id === except));
  const group = (axis, id) => axes[axis].groups.find(id);
  const tiedIn = (uf, axis, a, b) => uf[axis].find(group(axis, a)) === uf[axis].find(group(axis, b));
  const tied = (axis, a, b, except = null) => tiedIn(tiedBy(except), axis, a, b);
  const fixedIn = (uf, from, to, orient) => {
    if (!ctx.nodeMap.has(from) || !ctx.nodeMap.has(to)) return false;
    const needX = orient !== 'v', needY = orient !== 'h';
    return (!needX || tiedIn(uf, 'x', from, to)) && (!needY || tiedIn(uf, 'y', from, to));
  };
  const fixed = (from, to, orient, except = null) => fixedIn(tiedBy(except), from, to, orient);
  return {
    group, tied,
    sideFixed: (side) => !!side && fixed(side.from, side.to, side.orient),
    edgeTied: (e) => !!e && fixed(e.a, e.b, e.orient),
    runTied: (x) => (x.span ? fixed(x.ends.from, x.ends.to, x.ends.orient, x.m.id) : fixed(x.side.from, x.side.to, x.side.orient, x.m.id)),
    sideFixedByOthers: (side, roomId) => !!side
      && fixedIn(tiesWithout(`r:${roomId}`, (l) => l.rooms.has(roomId)), side.from, side.to, side.orient),
  };
}

// Which sides are fixed by measures without being measured themselves (for the ※ "치수 미입력" note).
// A side is fixed when the groups of its ends are tied along every axis it runs in. → (side) → bool
function fixedByMeasures(ctx) {
  const ties = ctx.ties();
  return (side) => ties.sideFixed(side);
}

// ---- 확인필요 flags set by the user ------------------------------------------------------------

function userFlagChecks(ctx, push, opts) {
  const p = ctx.project;
  // Measures (value may be null: "모름" with the flag only).
  for (const x of ctx.measures.concat(ctx.spanMeasures || [])) {
    if (!x.m.check) continue;
    const loc = x.spanLoc || ctx.sideLocation(x.m.room, x.side.key);
    const v = x.valid ? ` ${plain(x.m.value)}` : '';
    push({
      key: `userMeasure:${x.m.id}`,
      level: LEVEL_CHECK, category: 'userMeasure',
      message: x.valid ? `${loc} 길이${v}: 확인필요로 표시했습니다.` : `${loc} 길이: 확인필요로 표시했습니다 (값 없음).`,
      where: { ...sideWhere(ctx, x.m.room, x.side), measureId: x.m.id },
      note: `※ ${loc} 길이${v} — 확인필요`,
    });
  }
  // Walls.
  for (const w of p.wallChecks || []) {
    if (!w || !ctx.edgeMap.has(w.edge)) continue;
    const loc = ctx.edgeLocation(w.edge);
    const text = typeof w.note === 'string' && w.note.trim() ? w.note.trim() : '';
    const pts = edgeWorldPoints(ctx, w.edge);
    push({
      key: `userWall:${w.edge}`,
      level: LEVEL_CHECK, category: 'userWall',
      message: `${loc}: 확인필요로 표시했습니다${text ? ` (${text})` : ''}.`,
      where: { edgeId: w.edge, point: pts.length ? mid(pts[0], pts[1]) : null, points: pts },
      note: `※ ${loc}${text ? ` (${text})` : ''} — 확인필요`,
    });
  }
  // Openings. Two flagged openings on one wall must never read the same (identical ※ notes would be
  // merged into one printed line), so equal texts get their order along the wall.
  const flagged = [];
  for (const o of p.openings || []) {
    if (!o || !o.check) continue;
    const g = openingGeometry(ctx, o, opts);
    const loc = g && g.edgeId ? `${ctx.edgeLocation(g.edgeId)}의 ` : '';
    flagged.push({ o, g, what: `${loc}${openingText(o, opts)}` });
  }
  for (const f of flagged) {
    const same = flagged.filter((x) => x.what === f.what);
    if (same.length < 2) continue;
    // Along the wall: left to right on a horizontal wall, top to bottom otherwise.
    const horizontal = !f.g || Math.abs(f.g.p1.x - f.g.p0.x) >= Math.abs(f.g.p1.y - f.g.p0.y);
    const along = (x) => (x.g ? (horizontal ? x.g.center.x : x.g.center.y) : 0);
    const order = same.slice().sort((a, b) => along(a) - along(b));
    f.ordinal = `(${horizontal ? '왼쪽' : '위'}에서 ${order.indexOf(f) + 1}번째)`;
  }
  for (const { o, g, what: base, ordinal } of flagged) {
    const what = ordinal ? `${base} ${ordinal}` : base;
    push({
      key: `userOpening:${o.id}`,
      level: LEVEL_CHECK, category: 'userOpening',
      message: `${what}: 확인필요로 표시했습니다 (재질·종류·규격).`,
      where: { openingId: o.id, edgeId: g ? g.edgeId : null, point: g ? g.center : null, points: g ? [g.p0, g.p1] : [] },
      note: `※ ${what} — 확인필요`,
    });
  }
  // Fixtures.
  for (const f of p.fixtures || []) {
    if (!f || !f.check) continue;
    const at = fixturePoint(f);
    const roomId = at ? roomAtPoint(ctx, at) : null;
    const name = fixtureName(f);
    const what = roomId ? `${ctx.label(roomId)} ${name}` : name;
    push({
      key: `userFixture:${f.id}`,
      level: LEVEL_CHECK, category: 'userFixture',
      message: `${what}: 확인필요로 표시했습니다 (크기·위치).`,
      where: { fixtureId: f.id, roomId, point: at, points: at ? [at] : [] },
      note: `※ ${what} — 확인필요`,
    });
  }
  // Rooms: a flag on the ceiling height (H) or on the room itself.
  for (const dr of (ctx.derived && ctx.derived.rooms) || []) {
    const r = (p.rooms || []).find((x) => x.id === dr.roomId) || dr.room;
    if (!r) continue;
    const at = dr.labelPoint || null;
    const where = { roomId: dr.roomId, point: at, points: at ? [at] : [] };
    if (r.heightCheck || r.checkHeight) {
      push({
        key: `userRoomHeight:${dr.roomId}`,
        level: LEVEL_CHECK, category: 'userRoom',
        message: `${ctx.label(dr.roomId)} 천장고(H): 확인필요로 표시했습니다.`,
        where, note: `※ ${ctx.label(dr.roomId)} 천장고(H) — 확인필요`,
      });
    }
    if (r.check) {
      const text = typeof r.checkNote === 'string' && r.checkNote.trim() ? ` (${r.checkNote.trim()})` : '';
      push({
        key: `userRoom:${dr.roomId}`,
        level: LEVEL_CHECK, category: 'userRoom',
        message: `${ctx.label(dr.roomId)}: 확인필요로 표시했습니다${text}.`,
        where, note: `※ ${ctx.label(dr.roomId)}${text} — 확인필요`,
      });
    }
  }
}

// ---- drawing problems ----------------------------------------------------------------------------

// explain: explainers() (an open 확인필요 on a value along the same axis makes a value-caused overlap 참고;
// an open 다시 확인 makes every overlap / cross item 참고).
function drawingChecks(ctx, push, explain = null) {
  const p = ctx.project;
  const edges = (p.edges || []).filter((e) => ctx.nodeMap.has(e.a) && ctx.nodeMap.has(e.b));
  // Wall ends that touch nothing.
  const degree = new Map();
  const edgesAt = new Map();
  for (const e of edges) {
    for (const id of [e.a, e.b]) {
      degree.set(id, (degree.get(id) || 0) + 1);
      if (!edgesAt.has(id)) edgesAt.set(id, []);
      edgesAt.get(id).push(e);
    }
  }
  for (const [nodeId, d] of degree) {
    if (d !== 1) continue;
    const e = edgesAt.get(nodeId)[0];
    const n = ctx.nodeMap.get(nodeId);
    const divider = e.kind === 'divider';
    const loc = ctx.edgeLocation(e.id);
    push({
      key: `dangling:${nodeId}`,
      level: LEVEL_CHECK, category: 'dangling',
      message: divider
        ? `${loc}: 선 끝이 벽에 닿지 않아 구역이 나뉘지 않습니다. 끝을 벽까지 이어 주세요.`
        // ht #12: model.moveNode joins a loose end dropped on a wall, so say how to fix it in place.
        : `${loc}: 벽 끝이 다른 벽에 이어지지 않았습니다. [선택]으로 끝을 벽 위에 끌어 놓으면 이어집니다. 일부러 그린 짧은 벽이면 [확인 완료]를 누르세요.`,
      where: { edgeId: e.id, nodeId, point: { x: n.x, y: n.y }, points: [{ x: n.x, y: n.y }] },
      note: null,
    });
  }

  // Overlapping and crossing walls. Only walls that overlap or cross AS DRAWN get the advice to delete
  // or redraw one (review 0.5.1, field test 예시 세대 A: 주방 280 instead of 2800 squeezed the 현관 until its
  // walls met, and '하나를 지워 주세요' was shown from then on — deleting the wall would also have dropped
  // its values). Walls that meet only in the solved plan point at the values: the engine's 'fold' item
  // (contract C1) already names the value for its walls, the others get '값을 다시 확인해 주세요'.
  const folded = new Set();
  for (const w of (ctx.derived && ctx.derived.warnings) || []) {
    if (w && w.type === 'fold') for (const id of w.edgeIds || []) folded.add(id);
  }
  // Without any value the solve only straightens the sketch: whatever meets was drawn so.
  const anyValue = ctx.measures.some((x) => x.valid) || (ctx.spanMeasures || []).some((x) => x.valid);
  // While a 다시 확인 is open, walls that meet may have been pressed together by that value even when
  // the sketch comparison says "as drawn" (review 0.5.1 round 2: 예시 세대 A reversed order, A17 typed 35700
  // — '벽 두 개가 겹쳐 그려졌습니다. 하나를 지워 주세요.' on seven pairs of correct walls; following it
  // would delete walls and their values): every such item is 참고, without the delete / redraw advice.
  const outlierOpen = !!(explain && explain.outlierOpen);
  let drawn = null;
  const sketch = () => (drawn = drawn || sketchPositions(ctx));
  const byValue = (category, e, f, ids, where, axes) => {
    const reason = outlierOpen ? 'outlier' : explain ? explain.axis(axes) : null;
    const what = category === 'overlap'
      ? '그림에서는 떨어져 있던 벽 두 개가 길이 값 때문에 겹쳤습니다.'
      : '그림에서는 엇갈리지 않던 벽이 길이 값 때문에 다른 벽과 엇갈렸습니다.';
    push({
      key: `${category}:${ids.join('|')}`,
      level: reason ? LEVEL_INFO : LEVEL_CHECK, category,
      message: `${ctx.edgeLocation(e.id)}: ${what}${reason ? AXIS_REASON[reason] : ' 값을 다시 확인해 주세요.'}`,
      where, note: null,
    });
  };
  const pos = (id) => ctx.nodeMap.get(id);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i], f = edges[j];
      const shared = e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b;
      const A = pos(e.a), B = pos(e.b), C = pos(f.a), D = pos(f.b);
      const ov = parallelOverlap(A, B, C, D);
      if (ov) {
        const bothWalls = e.kind !== 'divider' && f.kind !== 'divider';
        const reach = bothWalls ? (ctx.thick(e.id) + ctx.thick(f.id)) / 2 : 0;
        if (ov.length > OVERLAP_MIN_MM && ov.distance < Math.max(1, reach - 1)) {
          const pts = [A, B, C, D].map((q) => ({ x: q.x, y: q.y }));
          const ids = [e.id, f.id].sort();
          const where = { edgeId: e.id, edgeIds: ids, point: ov.point, points: pts };
          if (!anyValue || overlapsAsDrawn(sketch(), e, f, reach)) {
            // A 구역 나누기 line drawn onto a wall is redrawn, not a wall deleted (that drops its values).
            const line = e.kind === 'divider' ? e : f.kind === 'divider' ? f : null;
            const onWall = line && !bothWalls && (e.kind !== 'divider' || f.kind !== 'divider');
            push({
              key: `overlap:${ids.join('|')}`,
              level: outlierOpen ? LEVEL_INFO : LEVEL_CHECK, category: 'overlap',
              message: outlierOpen
                ? (onWall
                  ? `${ctx.edgeLocation(line.id)}: 구역 나누기 선이 벽과 겹쳐 있습니다.${AXIS_REASON.outlier}`
                  : `${ctx.edgeLocation(e.id)}: 벽 두 개가 겹쳐 있습니다.${AXIS_REASON.outlier}`)
                : onWall
                  ? `${ctx.edgeLocation(line.id)}: 구역 나누기 선이 벽 위에 겹쳐 그려졌습니다. 구역 나누기 선을 지우고 다시 그어 주세요.`
                  : `${ctx.edgeLocation(e.id)}: 벽 두 개가 겹쳐 그려졌습니다. 하나를 지워 주세요.`,
              where, note: null,
            });
          } else if (!folded.has(e.id) && !folded.has(f.id)) {
            // Parallel walls pressed together: the values across them (a horizontal pair: y) are off.
            byValue('overlap', e, f, ids, where, e.orient === 'h' ? ['y'] : e.orient === 'v' ? ['x'] : ['x', 'y']);
          }
        }
        continue;
      }
      if (shared) continue;
      const hit = segmentIntersection(A, B, C, D);
      if (hit && hit.t > 1e-3 && hit.t < 1 - 1e-3 && hit.u > 1e-3 && hit.u < 1 - 1e-3) {
        const ids = [e.id, f.id].sort();
        const where = { edgeId: e.id, edgeIds: ids, point: hit.point, points: [hit.point] };
        if (!anyValue || crossesAsDrawn(sketch(), e, f)) {
          push({
            key: `cross:${ids.join('|')}`,
            level: outlierOpen ? LEVEL_INFO : LEVEL_CHECK, category: 'cross',
            message: `${ctx.edgeLocation(e.id)}: 벽이 다른 벽과 엇갈려 있습니다.`
              + (outlierOpen ? AXIS_REASON.outlier : ' 벽을 다시 그려 주세요.'),
            where, note: null,
          });
        } else if (!folded.has(e.id) && !folded.has(f.id)) {
          byValue('cross', e, f, ids, where, ['x', 'y']);
        }
      }
    }
  }
}

// Node positions as drawn: each connected part of the plan rebuilt from its walls' sketch vectors (the
// stroke as drawn, before any value moved it), starting from one node at its current place, at the
// plan's current scale so that distances compare with wall thicknesses. → Map nodeId → { x, y, part }
function sketchPositions(ctx) {
  const p = ctx.project;
  const scale = isNum(p.sketchScale) && p.sketchScale > 0 ? p.sketchScale : 1;
  const adj = new Map();
  const link = (from, to, dx, dy) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, dx, dy });
  };
  for (const e of p.edges || []) {
    if (!ctx.nodeMap.has(e.a) || !ctx.nodeMap.has(e.b) || !e.sketch || !isNum(e.sketch.dx) || !isNum(e.sketch.dy)) continue;
    link(e.a, e.b, e.sketch.dx * scale, e.sketch.dy * scale);
    link(e.b, e.a, -e.sketch.dx * scale, -e.sketch.dy * scale);
  }
  const out = new Map();
  let part = 0;
  for (const n of p.nodes || []) {
    if (out.has(n.id)) continue;
    part++;
    out.set(n.id, { x: n.x, y: n.y, part });
    const queue = [n.id];
    while (queue.length) {
      const id = queue.shift();
      const q = out.get(id);
      for (const { to, dx, dy } of adj.get(id) || []) {
        if (out.has(to)) continue;
        out.set(to, { x: q.x + dx, y: q.y + dy, part });
        queue.push(to);
      }
    }
  }
  return out;
}

// Whether two walls already overlap in the drawing (same rule as on the plan). Walls in parts of the
// plan that do not touch cannot be placed against each other: then the plan's own geometry decides.
function overlapsAsDrawn(sk, e, f, reach) {
  const A = sk.get(e.a), B = sk.get(e.b), C = sk.get(f.a), D = sk.get(f.b);
  if (!A || !B || !C || !D || A.part !== C.part) return true;
  const limit = Math.max(1, reach - 1);
  if ((e.orient === 'h' || e.orient === 'v') && e.orient === f.orient) {
    // Axis walls: a drawn wobble across the wall does not make them non-parallel.
    const al = e.orient === 'h' ? 'x' : 'y', cr = e.orient === 'h' ? 'y' : 'x';
    const lo = Math.max(Math.min(A[al], B[al]), Math.min(C[al], D[al]));
    const hi = Math.min(Math.max(A[al], B[al]), Math.max(C[al], D[al]));
    const dist = Math.abs((A[cr] + B[cr]) / 2 - (C[cr] + D[cr]) / 2);
    return hi - lo > OVERLAP_MIN_MM && dist < limit;
  }
  const ov = parallelOverlap(A, B, C, D);
  return !!ov && ov.length > OVERLAP_MIN_MM && ov.distance < limit;
}

function crossesAsDrawn(sk, e, f) {
  const A = sk.get(e.a), B = sk.get(e.b), C = sk.get(f.a), D = sk.get(f.b);
  if (!A || !B || !C || !D || A.part !== C.part) return true;
  const hit = segmentIntersection(A, B, C, D);
  return !!(hit && hit.t > 1e-3 && hit.t < 1 - 1e-3 && hit.u > 1e-3 && hit.u < 1 - 1e-3);
}

// Two parallel segments running side by side. → { length (common run), distance (between the
// lines), point } | null when they are not parallel or do not run side by side.
function parallelOverlap(A, B, C, D) {
  const ux = B.x - A.x, uy = B.y - A.y;
  const L = Math.hypot(ux, uy);
  const vx = D.x - C.x, vy = D.y - C.y;
  const M = Math.hypot(vx, vy);
  if (L < 1e-6 || M < 1e-6) return null;
  const dx = ux / L, dy = uy / L;
  if (Math.abs(dx * vy - dy * vx) / M > 1e-3) return null; // not parallel
  const tC = (C.x - A.x) * dx + (C.y - A.y) * dy;
  const tD = (D.x - A.x) * dx + (D.y - A.y) * dy;
  const lo = Math.max(0, Math.min(tC, tD)), hi = Math.min(L, Math.max(tC, tD));
  if (hi - lo <= 0) return null;
  const distance = Math.abs((C.x - A.x) * -dy + (C.y - A.y) * dx);
  const t = (lo + hi) / 2;
  return { length: hi - lo, distance, point: { x: A.x + dx * t, y: A.y + dy * t } };
}

// ---- openings --------------------------------------------------------------------------------------

// Opening geometry. The stage-B opening record is read through opts.openingSpan when given:
//   openingSpan(project, opening, derived) → { edgeId, start, end (mm along the wall from node a),
//     available? (clear length of the wall piece the drawing fits the opening into) } | null
// Otherwise common field names are tried: edge | edgeId | wallId, width | w | size.w | spec.w
// (or drawWidth for the drawn size), and the centre as t (0..1 of the wall from node a) | at | center
// (mm from node a) | offset (mm from node a to the start).
// → { edgeId, start, end, width, length, center (world), p0, p1 (world ends) } | null
function openingGeometry(ctx, o, opts = {}) {
  let span = null;
  if (typeof opts.openingSpan === 'function') {
    try { span = opts.openingSpan(ctx.project, o, ctx.derived); } catch (_) { span = null; }
  } else {
    span = defaultOpeningSpan(ctx, o);
  }
  if (!span || !ctx.edgeMap.has(span.edgeId)) return null;
  const e = ctx.edgeMap.get(span.edgeId);
  const A = ctx.nodeMap.get(e.a), B = ctx.nodeMap.get(e.b);
  if (!A || !B) return null;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (!(L > 0) || !isNum(span.start) || !isNum(span.end)) return null;
  const at = (s) => ({ x: A.x + (B.x - A.x) * (s / L), y: A.y + (B.y - A.y) * (s / L) });
  const start = Math.min(span.start, span.end), end = Math.max(span.start, span.end);
  return {
    edgeId: span.edgeId, start, end, width: end - start, length: L,
    center: at((start + end) / 2), p0: at(start), p1: at(end),
    available: num(span.available),   // clear length the drawing can use (openingSpan), or null
  };
}

// Clear length of one wall edge between the inner faces of the walls meeting its ends (the same rule
// as openings.js edgeFrame: half the thickest non-parallel wall at each end; a straight continuation
// or a free end gives nothing). Used when no openingSpan hook gives the drawing's own span.
function edgeClearSpan(ctx, edgeId) {
  const e = ctx.edgeMap.get(edgeId);
  const A = e && ctx.nodeMap.get(e.a), B = e && ctx.nodeMap.get(e.b);
  if (!A || !B) return 0;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (!(L > 0)) return 0;
  const dir = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  const clearance = (nodeId) => {
    let m = 0;
    for (const other of ctx.project.edges || []) {
      if (other.id === e.id || other.kind === 'divider' || (other.a !== nodeId && other.b !== nodeId)) continue;
      const P = ctx.nodeMap.get(other.a), Q = ctx.nodeMap.get(other.b);
      const l = P && Q ? Math.hypot(Q.x - P.x, Q.y - P.y) : 0;
      if (!(l > 1e-6)) continue;
      const cross = Math.abs(((Q.x - P.x) / l) * dir.y - ((Q.y - P.y) / l) * dir.x);
      if (cross < 0.3) continue;
      m = Math.max(m, ctx.thick(other.id) / 2);
    }
    return m;
  };
  return Math.max(0, L - clearance(e.a) - clearance(e.b));
}

function defaultOpeningSpan(ctx, o) {
  const edgeId = o.edge ?? o.edgeId ?? o.wallId ?? o.wall ?? null;
  const e = ctx.edgeMap.get(edgeId);
  if (!e) return null;
  const A = ctx.nodeMap.get(e.a), B = ctx.nodeMap.get(e.b);
  if (!A || !B) return null;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  const width = num(o.drawWidth) ?? num(o.width) ?? num(o.w)
    ?? num(o.size && o.size.w) ?? num(o.spec && o.spec.w) ?? null;
  if (!(width > 0)) return null;
  let centre = null;
  if (num(o.t) != null) centre = o.t * L;
  else if (num(o.at) != null) centre = o.at;
  else if (num(o.center) != null) centre = o.center;
  else if (num(o.offset) != null) centre = o.offset + width / 2;
  if (centre == null) return null;
  return { edgeId, start: centre - width / 2, end: centre + width / 2 };
}

function openingWord(o) {
  const k = String(o.kind || o.type || '').toLowerCase();
  if (k.includes('door') || k.includes('문')) return '문';
  if (k.includes('window') || k.includes('창')) return '창';
  return '창·문';
}

// The label of a window or door for messages: opts.openingLabel(o) (the editor passes the printed
// label, e.g. 'PVC단창 1200*1000', or the type name when there is no size), else o.label.
function openingLabel(o, opts = {}) {
  if (typeof opts.openingLabel === 'function') {
    try {
      const s = opts.openingLabel(o);
      if (typeof s === 'string' && s.trim()) return s.trim();
    } catch (_) { /* fall back */ }
  }
  return typeof o.label === 'string' ? o.label.trim() : '';
}

// '창 PVC단창 1200*1000', '문 목문', '창' (a label that only repeats the word is left out).
function openingText(o, opts) {
  const word = openingWord(o);
  const label = openingLabel(o, opts);
  return label && label !== word ? `${word} ${label}` : word;
}

// The fixture's name in messages: the typed name (a 기타's name), else today's type name (an old
// '붙박이장' reads '옷장', an old '냉장고' is a 기타 named '냉장고'); a 기타 without a name is '설비'.
function fixtureName(f) {
  const n = normalizeFixture(f);
  if (n && typeof n.label === 'string' && n.label.trim()) return n.label.trim();
  for (const k of ['name', 'typeName', 'kind']) {
    if (typeof f[k] === 'string' && f[k].trim() && !/^[a-z_]+$/i.test(f[k])) return f[k].trim();
  }
  if (n && f.type != null && n.type !== '기타') return n.type;
  return '설비';
}

function fixturePoint(f) {
  const cands = [f.at, f.center, f.pos, f.position, f];
  for (const c of cands) if (c && isNum(c.x) && isNum(c.y)) {
    // A rectangle given by x, y, w, h: use its centre.
    if (c === f && isNum(f.w) && isNum(f.h)) return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
    return { x: c.x, y: c.y };
  }
  return null;
}

// Straight run of collinear walls through an edge (the opening may sit anywhere on it), and the clear
// length between the walls that meet its two ends. → { runId, length, origin, dir } | null
function wallRuns(ctx) {
  const edges = (ctx.project.edges || []).filter((e) => e.kind !== 'divider' && ctx.nodeMap.has(e.a) && ctx.nodeMap.has(e.b));
  const uf = new UnionFind();
  const at = new Map();
  for (const e of edges) {
    uf.find(e.id);
    for (const id of [e.a, e.b]) {
      if (!at.has(id)) at.set(id, []);
      at.get(id).push(e);
    }
  }
  const unit = (e, fromId) => {
    const A = ctx.nodeMap.get(e.a), B = ctx.nodeMap.get(e.b);
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
    return fromId === e.a ? d : { x: -d.x, y: -d.y };
  };
  for (const [nodeId, list] of at) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const u = unit(list[i], nodeId), v = unit(list[j], nodeId);
        if (u.x * v.x + u.y * v.y < -0.999) uf.union(list[i].id, list[j].id); // straight continuation
      }
    }
  }
  const runs = new Map(); // runId → { edges }
  for (const e of edges) {
    const r = uf.find(e.id);
    if (!runs.has(r)) runs.set(r, []);
    runs.get(r).push(e);
  }
  const info = new Map(); // edgeId → { runId, origin, dir, lo, hi (clear span along dir) }
  for (const [runId, list] of runs) {
    const e0 = list[0];
    const A = ctx.nodeMap.get(e0.a);
    const dir = unit(e0, e0.a);
    const proj = (q) => (q.x - A.x) * dir.x + (q.y - A.y) * dir.y;
    let lo = Infinity, hi = -Infinity, loNode = null, hiNode = null;
    const inRun = new Set(list.map((e) => e.id));
    for (const e of list) {
      for (const id of [e.a, e.b]) {
        const t = proj(ctx.nodeMap.get(id));
        if (t < lo) { lo = t; loNode = id; }
        if (t > hi) { hi = t; hiNode = id; }
      }
    }
    const endHalf = (nodeId) => {
      let m = 0;
      for (const e of at.get(nodeId) || []) if (!inRun.has(e.id)) m = Math.max(m, ctx.thick(e.id) / 2);
      return m;
    };
    const clearLo = lo + endHalf(loNode), clearHi = hi - endHalf(hiNode);
    for (const e of list) info.set(e.id, { runId, origin: A, dir, lo: clearLo, hi: clearHi });
  }
  return info;
}

// Where an opening's width comes from: 'typed' (규격), 'drawn' (a drawn width the user set, e.g. with
// [좁게] / [넓게]) or 'default' (only the type's default drawing width, 창 1200 / 문 900).
function widthSource(o) {
  const pos = (v) => isNum(v) && v > 0;
  if (pos(o.width) || pos(o.w) || pos(o.size && o.size.w) || pos(o.spec && o.spec.w)) return 'typed';
  if (pos(o.drawWidth)) return 'drawn';
  return 'default';
}

// Wider than the wall piece, and two openings overlapping (review 0.5.1, field test 예시 세대 A):
//   - a window / door with only its type's default width is 참고: nobody measured that width, the drawing
//     just shortened it to the wall ('규격 미입력'); no mm on paper;
//   - while the plan's scale is not settled (scaleState) the wall lengths are still the sketch's guess:
//     참고, not on the badge, no ※ note (the first value alone turned 1 into 12 items);
//   - on a wall piece no value fixes, the text asks to measure the wall, not to check the window size.
//     (The A19 = 4600 negative case — all values in, the unmeasured 현관 squeezed until its drawn 900
//     door no longer fits — stays 확인필요: heo-full.test.html.)
//   - a DOOR with only the default width on a clear piece shorter than DOOR_ROOM_MIN_MM is 확인필요
//     once the scale is settled: '이 벽에는 문이 들어갈 자리가 없습니다(574mm). 벽 길이를 재서 넣어
//     주세요.' (round 2: the same A19 = 4600 with doors placed by the 문 tool, without a width);
//   - while a 다시 확인 is open (explain.outlierOpen) every item here is 참고, '위의 다시 확인 값 때문일
//     수 있습니다' (round 2, #1 with openings: A06 = 280 or A19 = 36000 left 4–7 확인필요 on correct
//     windows and doors).
// Keys hold the opening, its width and its wall — never the solved wall length, which every new value
// elsewhere changed by a millimetre and so undid a [확인 완료] (older keys still count: checkkeys.js).
//   - (fixer 2026-10-20) that door item is 참고 while its wall piece's ends are not tied by values but
//     every room side the piece belongs to already has a value (PIECE_WAITING): the piece ends at a wall
//     meeting it whose place only the sketch gives so far; the advice is not to measure that side again.
const PIECE_WAITING = ' 이 벽의 길이는 넣었지만, 만나는 벽의 자리가 아직 값으로 정해지지 않아 그림 비율로 그렸습니다. 값을 더 넣으면 다시 확인합니다.';

// Every room side (not a 구역 나누기 line) the wall piece belongs to has a value of its own or is a part
// of a measured span.
function edgeSidesMeasured(ctx, edgeId) {
  const want = [];
  for (const dr of (ctx.derived && ctx.derived.rooms) || []) {
    (dr.sides || []).forEach((side, i) => {
      if (!side.allDivider && (side.edgeIds || []).includes(edgeId)) want.push(`${dr.roomId}|${i}`);
    });
  }
  if (!want.length) return false;
  const have = new Set();
  for (const x of ctx.measures) if (x.valid) have.add(`${x.dr.roomId}|${x.i}`);
  for (const x of ctx.spanMeasures || []) {
    if (x.valid) for (const p of (x.span && x.span.parts) || []) have.add(`${p.roomId}|${p.sideIndex}`);
  }
  return want.every((k) => have.has(k));
}

function openingChecks(ctx, push, opts, explain = null) {
  const openings = (ctx.project.openings || []).filter((o) => o && o.id);
  if (!openings.length) return;
  const runs = wallRuns(ctx);
  const settled = ctx.scaleState().settled;
  const outlierOpen = !!(explain && explain.outlierOpen);
  const UNSETTLED = ' 아직 잰 값이 적어 벽 길이가 그림 비율이라 참고로만 알립니다. 값을 더 넣으면 다시 확인합니다.';
  const OUTLIER = AXIS_REASON.outlier;
  const placed = [];
  for (const o of openings) {
    const g = openingGeometry(ctx, o, opts);
    if (!g) continue;
    const run = runs.get(g.edgeId);
    if (!run) continue;
    const proj = (q) => (q.x - run.origin.x) * run.dir.x + (q.y - run.origin.y) * run.dir.y;
    const a = proj(g.p0), b = proj(g.p1);
    const item = { o, g, run, lo: Math.min(a, b), hi: Math.max(a, b) };
    placed.push(item);
    // The room the opening can use is its own wall piece between the walls meeting it (a T-junction
    // on the facade ends it), exactly where the drawing clips the opening. The straight run is used
    // only for the overlap check below.
    const available = isNum(g.available) ? g.available : edgeClearSpan(ctx, g.edgeId);
    if (g.width > available + OPENING_TOL) {
      const loc = ctx.edgeLocation(g.edgeId);
      const text = openingText(o, opts);
      const where = { openingId: o.id, edgeId: g.edgeId, point: g.center, points: [g.p0, g.p1] };
      const key = `openingWide:${o.id}:${plain(g.width)}:${g.edgeId}`;
      const w = plain(g.width), avail = plain(available);
      const e = ctx.edgeMap.get(g.edgeId);
      const noRoom = openingWord(o) === '문' && settled && available < DOOR_ROOM_MIN_MM;
      if (widthSource(o) === 'default' && noRoom) {
        const measured = ctx.ties().edgeTied(e);
        // The wall's own side(s) have their values, but where the walls meeting this piece stand is not
        // fixed by values yet (a T-junction placed by the sketch): 참고 until it is, and no request to
        // measure a side already measured (fixer 2026-10-20, field: 방2 아래 2500 typed, its door piece
        // between 방2's corner and 주방's wall still sketch-scaled until 화장실 위 was typed).
        const waiting = !measured && !outlierOpen && edgeSidesMeasured(ctx, g.edgeId);
        push({
          key, level: outlierOpen || waiting ? LEVEL_INFO : LEVEL_CHECK, category: 'openingWide',
          message: `${loc}의 ${text}: ${waiting ? '지금 그림으로는 ' : ''}이 벽에는 문이 들어갈 자리가 없습니다(${plain(Math.max(0, available))}mm).`
            + (outlierOpen ? OUTLIER : measured ? ' 벽 길이나 문 자리를 확인해 주세요.' : waiting ? PIECE_WAITING : ' 벽 길이를 재서 넣어 주세요.'),
          where,
          note: outlierOpen || waiting ? null : `※ ${loc} ${text}: 문이 들어갈 자리 없음 — 확인필요`,
        });
      } else if (widthSource(o) === 'default') {
        push({
          key, level: LEVEL_INFO, category: 'openingWide',
          message: `${loc}의 ${text}: 규격 미입력. 기본 그림 폭이 벽보다 넓어 줄여 그렸습니다. 규격을 알면 넣어 주세요.`,
          where, note: null,
        });
      } else if (!settled || outlierOpen) {
        push({
          key, level: LEVEL_INFO, category: 'openingWide',
          message: `${loc}의 ${text}: 폭 ${w}mm가 지금 벽 길이 ${avail}mm보다 깁니다. 그림에는 벽 길이만큼만 그렸습니다.${outlierOpen ? OUTLIER : UNSETTLED}`,
          where, note: null,
        });
      } else {
        const measured = ctx.ties().edgeTied(e);
        push({
          key, level: LEVEL_CHECK, category: 'openingWide',
          message: `${loc}의 ${text}: 폭 ${w}mm가 벽 길이 ${avail}mm보다 깁니다. 그림에는 벽 길이만큼만 그렸습니다.`
            + (measured ? ' 규격이나 벽 길이를 확인해 주세요.'
              : edgeSidesMeasured(ctx, g.edgeId) ? ' 이 벽의 길이는 넣었지만, 만나는 벽의 자리가 아직 값으로 정해지지 않았습니다. 규격이나 주변 길이를 확인해 주세요.'
                : ' 이 벽 길이는 재지 않아 그림 비율로 그렸습니다. 길이를 재서 넣어 주세요.'),
          where,
          note: `※ ${loc} ${text}: 폭 ${w}mm가 벽보다 큼 — 확인필요`,
        });
      }
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const p = placed[i], q = placed[j];
      if (p.run.runId !== q.run.runId) continue;
      const overlap = Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);
      if (overlap <= OPENING_TOL) continue;
      const ids = [p.o.id, q.o.id].sort();
      const check = settled && !outlierOpen;
      push({
        key: `openingOverlap:${ids.join('|')}`,
        level: check ? LEVEL_CHECK : LEVEL_INFO, category: 'openingOverlap',
        message: `${ctx.edgeLocation(p.g.edgeId)}: ${openingWord(p.o)}과 ${openingWord(q.o)}이 겹쳐 있습니다.`
          + (check ? ' 위치를 옮겨 주세요.' : outlierOpen ? OUTLIER : UNSETTLED),
        where: { openingId: p.o.id, openingIds: ids, edgeId: p.g.edgeId, point: p.g.center, points: [p.g.p0, p.g.p1, q.g.p0, q.g.p1] },
        note: null,
      });
    }
  }
}

// ---- fixtures ------------------------------------------------------------------------------------

// A wall fixture longer than the room side it stands on (between that side's two inner corners, as
// fixtures.js keeps it). A measured length is drawn centred on the side and is 확인필요 with a ※
// note; an unmeasured (default) length was drawn shortened to fit, which is only 참고. While the plan's
// scale is not settled by the first values (scaleState) a measured one is 참고 too: the side is still
// the sketch's guess. (Before ANY value the plan is the sketch exactly as drawn and nothing has been
// rescaled; that state keeps the 확인필요 — tests/fixtures.test.html relies on it.) The key holds the
// fixture, its length and its side, not the solved side length (review 0.5.1, as openingWide). While a
// 다시 확인 is open (explain.outlierOpen) the measured one is 참고 as well: that value may have shrunk the
// side (round 2, as the window / door items). The column items below (기둥이 실보다 김) follow the same
// two rules through fitDemotion.
function fixtureChecks(ctx, push, explain = null) {
  const sc = ctx.scaleState();
  const outlierOpen = !!(explain && explain.outlierOpen);
  const unsettled = sc.values > 0 && !sc.settled;
  const fit = fitDemotion(ctx, explain, FIT_UNSETTLED);
  for (const raw of ctx.project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || !f.id || !f.wall) continue;
    let rs = null;
    try { rs = fixtureRoomSide(ctx.project, ctx.derived, f); } catch (_) { rs = null; }
    if (!rs || !(rs.length > 0)) continue;
    const avail = rs.length;
    const loc = ctx.sideLocation(rs.roomId, rs.sideKey);
    const name = fixtureName(raw);
    const at = { x: f.x, y: f.y };
    const where = { fixtureId: f.id, roomId: rs.roomId, sideKey: rs.sideKey, point: at, points: [at] };
    if (f.measured.w) {
      if (isStair(f)) continue;   // stairChecks: one item for both sizes ('계단이 실보다 김')
      if (!(f.w > avail + FIXTURE_TOL)) continue;
      const info = unsettled || outlierOpen;
      push({
        key: `fixtureLong:${f.id}:${plain(f.w)}:${rs.sideKey}`,
        level: info ? LEVEL_INFO : LEVEL_CHECK, category: 'fixtureLong',
        message: `${loc} ${name} ${plain(f.w)}: 길이 ${plain(f.w)}mm가 벽 길이 ${plain(avail)}mm보다 깁니다. 그림에는 벽 가운데에 그렸습니다.`
          + (outlierOpen ? AXIS_REASON.outlier
            : unsettled ? ' 아직 잰 값이 적어 벽 길이가 그림 비율이라 참고로만 알립니다. 값을 더 넣으면 다시 확인합니다.'
              : ' 설비 길이나 벽 길이를 확인해 주세요.'),
        where,
        note: info ? null : `※ ${loc} ${name} ${plain(f.w)}: 벽보다 김 — 확인필요`,
      });
    } else if (f.fullW != null && f.fullW > f.w + FIXTURE_TOL) {
      push({
        key: `fixtureLong:${f.id}:${plain(f.fullW)}:${rs.sideKey}`,
        level: LEVEL_INFO, category: 'fixtureLong',
        message: `${loc} ${name}: 기본 길이 ${plain(f.fullW)}mm가 벽 길이 ${plain(avail)}mm보다 길어, 벽 길이에 맞춰 ${plain(f.w)}mm로 그렸습니다. 길이를 재면 넣어 주세요.`,
        where,
        note: null,
      });
    }
  }
  // A column deeper than the room in front of it (fixtures.js keeps a measured depth and lets the
  // column reach past the opposite face; an unmeasured depth was drawn shorter).
  for (const raw of ctx.project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || !f.id || !f.wall || !isColumn(f) || !f.measured.d) continue;
    let rs = null, avail = Infinity;
    try {
      rs = fixtureRoomSide(ctx.project, ctx.derived, f);
      if (rs) avail = depthInRoom(ctx.project, ctx.derived, rs, f[rs.key] - f.w / 2, f[rs.key] + f.w / 2);
    } catch (_) { rs = null; }
    if (!rs || !isFinite(avail) || !(f.d > avail + FIXTURE_TOL)) continue;
    const loc = ctx.sideLocation(rs.roomId, rs.sideKey);
    const at = { x: f.x, y: f.y };
    push({
      key: `fixtureDeep:${f.id}:${plain(f.d)}:${plain(avail)}`,
      level: fit.level, category: 'fixtureDeep',
      message: `${loc} 기둥: 깊이 ${plain(f.d)}mm가 실 안쪽 ${plain(avail)}mm보다 깁니다.${fit.tail(' 기둥 크기나 실 길이를 확인해 주세요.')}`,
      where: { fixtureId: f.id, roomId: rs.roomId, sideKey: rs.sideKey, point: at, points: [at] },
      note: fit.note(`※ ${loc} 기둥 ${plain(f.d)}: 실보다 김 — 확인필요`),
    });
  }
  // A free-standing column that does not fit inside its room (fixtures.js keeps it inside when it
  // can; a size larger than the room, or no place in an L-shaped room, leaves it sticking out).
  for (const raw of ctx.project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || !f.id || f.wall || !isColumn(f)) continue;
    let out = null;
    try { out = freeColumnSticksOut(ctx.project, ctx.derived, f); } catch (_) { out = null; }
    if (!out) continue;
    const { ex, ey } = fixtureExtents(f);
    const size = `${plain(ex)}×${plain(ey)}`;
    const at = { x: f.x, y: f.y };
    push({
      key: `fixtureDeep:${f.id}:${plain(ex)}:${plain(ey)}:${plain(f.x)}:${plain(f.y)}`,
      level: fit.level, category: 'fixtureDeep',
      message: `${ctx.label(out.roomId)} 기둥 ${size}: 실 안에 들어가지 않습니다.${fit.tail(' 기둥 크기나 실 길이를 확인해 주세요.')}`,
      where: { fixtureId: f.id, roomId: out.roomId, point: at, points: [at] },
      note: fit.note(`※ ${ctx.label(out.roomId)} 기둥 ${size}: 실보다 김 — 확인필요`),
    });
  }
  // A free-standing fixture in no room (ht #19): free fixtures now keep their place in their room as
  // the values reshape the plan (fixtures.js reconcileFixtures), so one outside every room was put
  // there — or its room is gone. It is printed where it stands and can change the print scale.
  let outside = [];
  try { outside = freeFixturesOutside(ctx.project, ctx.derived); } catch (_) { outside = []; }
  const byId = new Map((ctx.project.fixtures || []).map((f) => [f && f.id, f]));
  for (const w of outside) {
    const raw = byId.get(w.fixtureId);
    const f = raw && normalizeFixture(raw);
    if (!f) continue;
    const name = fixtureName(raw);
    const at = { x: f.x, y: f.y };
    push({
      key: `fixtureOutside:${f.id}`,
      level: LEVEL_CHECK, category: 'fixtureOutside',
      message: `${name}: 어느 실에도 없는 설비입니다. 자리를 확인해 주세요.`,
      where: { fixtureId: f.id, point: at, points: [at] },
      note: `※ ${name}: 실 밖에 있음 — 확인필요`,
    });
  }
}

// The column / stair items (기둥이 실보다 김, 계단이 실보다 김, 기둥과 창·문 겹침) are 참고 instead of
// 확인필요, with no ※ note and the key unchanged (round 2 integration, the same rules as 설비가 벽보다 김):
//   - while a 다시 확인 is open (explain.outlierOpen): the slipped value may have squeezed the room
//     ('위의 다시 확인 값 때문일 수 있습니다');
//   - while the scale is not settled by the first values (scaleState): the room is still the sketch's
//     guess (예시 세대 A list order: the first value A04 shrank 방1 to 2251 mm, narrower than the 2400 stair).
//     Before ANY value the drawing is as drawn and the item stays 확인필요.
// unsettledText: the end of the message in the second case. → { level, tail(advice), note(text) }
const FIT_UNSETTLED = ' 아직 잰 값이 적어 실 크기가 그림 비율이라 참고로만 알립니다. 값을 더 넣으면 다시 확인합니다.';
const WALL_UNSETTLED = ' 아직 잰 값이 적어 벽 길이가 그림 비율이라 참고로만 알립니다. 값을 더 넣으면 다시 확인합니다.';
function fitDemotion(ctx, explain, unsettledText) {
  const sc = ctx.scaleState();
  const outlierOpen = !!(explain && explain.outlierOpen);
  const unsettled = sc.values > 0 && !sc.settled;
  const info = outlierOpen || unsettled;
  return {
    level: info ? LEVEL_INFO : LEVEL_CHECK,
    tail: (advice) => (outlierOpen ? AXIS_REASON.outlier : unsettled ? unsettledText : advice),
    note: (text) => (info ? null : text),
  };
}

// ---- stairs --------------------------------------------------------------------------------------

// A stair (계단) whose MEASURED size does not fit its room (fixtures.js keeps a measured size and
// lets it stick out; an unmeasured size was drawn shorter, which is only the 참고 'fixtureLong' item):
//   - on a wall: a measured 길이 longer than its room side, or a measured 폭 deeper than the room in
//     front of it;
//   - free-standing: not inside its room's inner outline.
// One 확인필요 item per stair with a ※ note: "※ 거실 왼쪽 벽 계단 900×3000: 실보다 김 — 확인필요"
// (폭×길이; a free stair: "※ 거실 계단 …"). Openings are not checked (a stair under a window or in
// front of a door is normal). 참고 instead while a 다시 확인 is open or the scale is not settled yet
// (fitDemotion).
function stairChecks(ctx, push, explain = null) {
  const fit = fitDemotion(ctx, explain, FIT_UNSETTLED);
  const level = fit.level;
  const advice = fit.tail(' 계단 크기나 실 길이를 확인해 주세요.');
  for (const raw of ctx.project.fixtures || []) {
    const f = normalizeFixture(raw);
    if (!f || !f.id || !isStair(f)) continue;
    const size = `${plain(f.d)}×${plain(f.w)}`;
    const at = { x: f.x, y: f.y };
    if (f.wall) {
      let rs = null, depth = Infinity;
      try {
        rs = fixtureRoomSide(ctx.project, ctx.derived, f);
        if (rs) depth = depthInRoom(ctx.project, ctx.derived, rs, f[rs.key] - f.w / 2, f[rs.key] + f.w / 2);
      } catch (_) { rs = null; }
      if (!rs) continue;
      const long = f.measured.w && f.w > rs.length + FIXTURE_TOL;
      const deep = f.measured.d && isFinite(depth) && f.d > depth + FIXTURE_TOL;
      if (!long && !deep) continue;
      const loc = ctx.sideLocation(rs.roomId, rs.sideKey);
      const why = [long ? `길이 ${plain(f.w)}mm가 벽 길이 ${plain(rs.length)}mm보다` : null,
        deep ? `폭 ${plain(f.d)}mm가 실 안쪽 ${plain(depth)}mm보다` : null].filter(Boolean).join(', ');
      push({
        key: `stairFit:${f.id}:${plain(f.d)}:${plain(f.w)}:${plain(rs.length)}:${plain(isFinite(depth) ? depth : 0)}`,
        level, category: 'stairFit',
        message: `${loc} 계단 ${size}: ${why} 깁니다.${advice}`,
        where: { fixtureId: f.id, roomId: rs.roomId, sideKey: rs.sideKey, point: at, points: [at] },
        note: fit.note(`※ ${loc} 계단 ${size}: 실보다 김 — 확인필요`),
      });
    } else {
      let out = null;
      try { out = freeColumnSticksOut(ctx.project, ctx.derived, f); } catch (_) { out = null; }
      if (!out) continue;
      push({
        key: `stairFit:${f.id}:${plain(f.d)}:${plain(f.w)}:${plain(f.x)}:${plain(f.y)}`,
        level, category: 'stairFit',
        message: `${ctx.label(out.roomId)} 계단 ${size}: 실 안에 들어가지 않습니다.${advice}`,
        where: { fixtureId: f.id, roomId: out.roomId, point: at, points: [at] },
        note: fit.note(`※ ${ctx.label(out.roomId)} 계단 ${size}: 실보다 김 — 확인필요`),
      });
    }
  }
}

// ---- columns against windows and doors -----------------------------------------------------------

// A column (기둥) standing in a window or door opening: its plan box reaches the wall band of the
// opening (the wall thickness plus COLUMN_REACH on each side, enough for a finish layer) and runs
// alongside the opening for more than OPENING_TOL. 확인필요 with a ※ note, e.g.
// "※ 거실 왼쪽 벽 기둥: 문과 겹침 — 확인필요". The key holds both positions, so a [확인 완료]
// stops applying when the column or the opening is moved or resized. 참고 instead while a 다시 확인 is
// open or the scale is not settled yet (fitDemotion), as the window / door items.
function columnOpeningChecks(ctx, push, opts, explain = null) {
  const fit = fitDemotion(ctx, explain, WALL_UNSETTLED);
  const columns = (ctx.project.fixtures || []).map(normalizeFixture).filter((f) => f && f.id && isColumn(f));
  const openings = (ctx.project.openings || []).filter((o) => o && o.id);
  if (!columns.length || !openings.length) return;
  for (const o of openings) {
    const g = openingGeometry(ctx, o, opts);
    if (!g) continue;
    const e = ctx.edgeMap.get(g.edgeId);
    if (!e || (e.orient !== 'h' && e.orient !== 'v')) continue;
    const h = e.orient === 'h';
    const key = h ? 'x' : 'y', cross = h ? 'y' : 'x';
    const lo = Math.min(g.p0[key], g.p1[key]), hi = Math.max(g.p0[key], g.p1[key]);
    const line = g.p0[cross];
    const reach = ctx.thick(g.edgeId) / 2 + COLUMN_REACH;
    for (const f of columns) {
      const b = fixtureBounds(f);
      const a0 = h ? b.minX : b.minY, a1 = h ? b.maxX : b.maxY;
      const c0 = h ? b.minY : b.minX, c1 = h ? b.maxY : b.maxX;
      if (Math.min(a1, hi) - Math.max(a0, lo) <= OPENING_TOL) continue;   // not alongside it
      const gap = c0 > line ? c0 - line : c1 < line ? line - c1 : 0;      // 0 = across the wall line
      if (gap > reach) continue;
      const loc = columnLocation(ctx, f, g.edgeId);
      const word = openingWord(o);
      const text = openingText(o, opts);
      push({
        key: `columnOpening:${f.id}:${o.id}:${plain(a0)}:${plain(a1)}:${plain(lo)}:${plain(hi)}`,
        level: fit.level, category: 'columnOpening',
        message: `${loc} 기둥이 ${text} 자리와 겹칩니다.${fit.tail(` 기둥이나 ${word}의 위치·크기를 확인해 주세요.`)}`,
        where: { fixtureId: f.id, columnOpeningId: o.id, edgeId: g.edgeId, point: { x: f.x, y: f.y }, points: [g.p0, g.p1, { x: f.x, y: f.y }] },
        note: fit.note(`※ ${loc} 기둥: ${word}과 겹침 — 확인필요`),
      });
    }
  }
}

// '거실 왼쪽 벽': the room side the column stands on (wall columns), else the side of the opening's
// wall in the room the column stands in, else the wall's usual location.
function columnLocation(ctx, f, edgeId) {
  let rs = null;
  try { rs = f.wall ? fixtureRoomSide(ctx.project, ctx.derived, f) : null; } catch (_) { rs = null; }
  if (rs && rs.sideKey) {
    const dr = ctx.byRoom.get(rs.roomId);
    const side = dr && dr.sides.find((s) => s.key === rs.sideKey);
    if (side && side.edgeIds.includes(edgeId)) return ctx.sideLocation(rs.roomId, rs.sideKey);
  }
  const roomId = roomAtPoint(ctx, { x: f.x, y: f.y });
  if (roomId) {
    let pairs = [];
    try { pairs = sidesForEdge(ctx.derived, edgeId) || []; } catch (_) { pairs = []; }
    const mine = pairs.find((p) => p && p.side && p.roomId === roomId);
    if (mine) return ctx.sideLocation(roomId, mine.side.key);
  }
  return ctx.edgeLocation(edgeId);
}

// ---- location for the [위치 보기] button ----------------------------------------------------------

// What the editor should do to show an item.
// → { points: [world], edgeId, prefer: { roomId, sideKey } | null, roomId, openingId, fixtureId }
//   edgeId: open the length panel on this wall (prefer = the field to activate);
//   roomId: open the room panel (when there is no wall to open); points: bring these into view.
export function locationOf(project, derived, item) {
  const w = (item && item.where) || {};
  const out = { points: [], edgeId: null, prefer: null, roomId: null, openingId: null, fixtureId: null };
  if (Array.isArray(w.points)) out.points = w.points.filter((q) => q && isNum(q.x) && isNum(q.y));
  if (!out.points.length && w.point && isNum(w.point.x)) out.points = [w.point];
  if (item && item.category === 'closure') return out; // view only: the problem spans many walls
  if (w.openingId) { out.openingId = w.openingId; return out; }
  if (w.fixtureId) { out.fixtureId = w.fixtureId; out.roomId = w.roomId || null; return out; }
  const edgeOk = (id) => id && ((project && project.edges) || []).some((e) => e.id === id);
  if (edgeOk(w.edgeId)) {
    out.edgeId = w.edgeId;
    if (w.roomId && w.sideKey) out.prefer = { roomId: w.roomId, sideKey: w.sideKey };
    return out;
  }
  if (w.roomId) out.roomId = w.roomId;
  return out;
}

// ---- 확인 완료 through a turn of the plan (도면 돌리기, core/rotate.js) ------------------------------

// What a check item is about, whatever the plan's orientation: its category and the ids its key names
// (m12, f3, o2, e7, n4, r2 — with '=value' where the key has one), sorted. Keys also hold directions and
// positions (closure:x:…, the order of a chain, a column's x / y), which a quarter turn changes.
export function checkIdentity(item) {
  const key = item && typeof item.key === 'string' ? item.key : '';
  const colon = key.indexOf(':');
  const body = colon >= 0 ? key.slice(colon + 1) : key;
  const ids = body.match(/\b[a-z]\d+(?:=-?\d+(?:\.\d+)?)?\b/g) || [];
  return `${(item && item.category) || key.slice(0, Math.max(0, colon))}|${[...new Set(ids)].sort().join(',')}`;
}

// The project after a turn with every 확인 완료 carried over: an item resolved before the turn resolves
// the item of the same identity after it, and its old key is dropped once no item has it any more
// (a stale key would come back when the plan is turned back, even after the user took the mark back:
// review 0.5.0; turning back carries the mark again by identity). Resolved keys of items that do not
// apply now are left alone.
// before / after: { project, derived }; options: as runChecks. → project | null (nothing changes)
export function carryResolvedChecks(before, after, options = {}) {
  const resolved = resolvedKeys(before && before.project);
  if (!resolved.size || !after || !after.project) return null;
  // (it.resolved: also a mark saved under an older key of the item, checkkeys.js.)
  const old = runChecks(before.project, before.derived, options).filter((it) => it.resolved);
  if (!old.length) return null;
  const items = runChecks(after.project, after.derived, options);
  const keysNow = new Set(items.map((it) => it.key));
  const have = resolvedKeys(after.project);
  const now = items.filter((it) => !have.has(it.key));
  const add = [], drop = new Set();
  for (const it of old) {
    if (keysNow.has(it.key)) continue;                // same key after the turn: stays resolved
    const sig = checkIdentity(it);
    const match = now.find((n) => !add.includes(n.key) && checkIdentity(n) === sig);
    // Replaced by the new key. An item without a counterpart keeps its old key (it may apply again).
    if (match) { add.push(match.key); drop.add(it.key); }
  }
  if (!add.length && !drop.size) return null;
  const at = new Date().toISOString();
  const kept = (after.project.checks || []).filter((c) => !(c && drop.has(c.key)));
  return { ...after.project, checks: [...kept, ...add.map((key) => ({ key, resolvedAt: at }))] };
}

// ---- store mixin ---------------------------------------------------------------------------------

// Adds the 확인 완료 commands to DocStore (one undo step each; no re-derive needed):
//   resolveCheck(key) → bool, unresolveCheck(key) → bool, isCheckResolved(key) → bool,
//   checkItems(opts) → runChecks(project, derived, opts), cached per snapshot.
export function installChecks(DocStore) {
  const proto = DocStore.prototype;
  proto.resolveCheck = function resolveCheck(key) {
    if (typeof key !== 'string' || !key) return false;
    return this._commit('resolveCheck', (p) => {
      const list = Array.isArray(p.checks) ? p.checks : [];
      if (isKeyResolved(resolvedKeys(p), key)) return null;
      return { ...p, checks: [...list, { key, resolvedAt: new Date().toISOString() }] };
    }, { rederive: false, detail: { key } });
  };
  // Takes back the mark, also one saved under an older key of the same item (checkkeys.js).
  proto.unresolveCheck = function unresolveCheck(key) {
    if (typeof key !== 'string' || !key) return false;
    const old = legacyKeyPattern(key);
    return this._commit('unresolveCheck', (p) => {
      const list = Array.isArray(p.checks) ? p.checks : [];
      const next = list.filter((c) => !(c && (c.key === key || (old && typeof c.key === 'string' && old.test(c.key)))));
      return next.length === list.length ? null : { ...p, checks: next };
    }, { rederive: false, detail: { key } });
  };
  proto.isCheckResolved = function isCheckResolved(key) {
    return isKeyResolved(resolvedKeys(this.project), key);
  };
  proto.checkItems = function checkItems(opts = {}) {
    const project = this.project, derived = this.derived;
    const c = this._checkCache;
    if (c && c.project === project && c.derived === derived && c.roomLabel === opts.roomLabel
      && c.openingSpan === opts.openingSpan && c.openingLabel === opts.openingLabel) return c.items;
    let items = [];
    try { items = runChecks(project, derived, opts); } catch (err) { console.error('[checks] failed', err); }
    this._checkCache = { project, derived, roomLabel: opts.roomLabel, openingSpan: opts.openingSpan, openingLabel: opts.openingLabel, items };
    return items;
  };
  return DocStore;
}

// ---- screen markers ------------------------------------------------------------------------------

// Draws, on screen only, small orange markers for unresolved 확인필요 items that the plan itself does
// not show (wall ends that touch nothing, overlapping or crossing walls, opening problems, the walls of
// a failed closure, the walls a value made cross), and a halo around the item being shown with
// [위치 보기] (options.highlight = key).
//   opts: { toPx(worldPoint) → canvas point, pxPerMM, paper, options: { highlight }, items? }
// On paper (opts.paper != null) nothing is drawn: checks are printed only as ※ notes.
export function drawCheckMarkers(ctx, project, derived, opts = {}) {
  if (!project || opts.paper) return;
  const toPx = opts.toPx;
  if (typeof toPx !== 'function') return;
  const items = Array.isArray(opts.items) ? opts.items : runChecks(project, derived);
  const highlight = opts.options && opts.options.highlight;
  const orange = '#E8710A';
  const edgeMap = new Map((project.edges || []).map((e) => [e.id, e]));
  const nodeMap = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edgePts = (id) => {
    const e = edgeMap.get(id);
    const a = e && nodeMap.get(e.a), b = e && nodeMap.get(e.b);
    return a && b ? [toPx(a), toPx(b)] : null;
  };
  ctx.save();
  ctx.lineCap = 'round';
  for (const it of items) {
    if (!it) continue;
    const w = it.where || {};
    const isHl = highlight && it.key === highlight;
    if (isHl) drawHalo(ctx, it, w, toPx, edgePts);
    if (it.level !== LEVEL_CHECK || it.resolved) continue;
    if (['dangling', 'openingWide', 'openingOverlap', 'fixtureLong', 'fixtureDeep', 'stairFit', 'columnOpening', 'cross'].includes(it.category) && w.point) {
      const s = toPx(w.point);
      ctx.strokeStyle = orange;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (it.category === 'overlap' || it.category === 'closure' || it.category === 'fold') {
      ctx.strokeStyle = orange;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      for (const id of w.edgeIds || []) {
        const pts = edgePts(id);
        if (!pts) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

function drawHalo(ctx, it, w, toPx, edgePts) {
  ctx.save();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
  ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  const pts = (w.points || []).map(toPx);
  if (it.category === 'closure' || pts.length > 2) {
    // A box around everything involved.
    if (pts.length) {
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const x0 = Math.min(...xs) - 14, y0 = Math.min(...ys) - 14;
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(x0, y0, Math.max(...xs) + 14 - x0, Math.max(...ys) + 14 - y0);
    }
  } else if (pts.length === 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
  } else if (w.edgeId && edgePts(w.edgeId)) {
    const e = edgePts(w.edgeId);
    ctx.beginPath();
    ctx.moveTo(e[0].x, e[0].y);
    ctx.lineTo(e[1].x, e[1].y);
    ctx.stroke();
  } else if (w.point) {
    const s = toPx(w.point);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
