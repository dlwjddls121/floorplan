// Project document, commands, undo/redo and derived data (DESIGN.md §2, §3.6).
//
// The store keeps immutable snapshots: every command builds a new project object, re-derives
// (faces → rooms → solve) and stores the solved node positions back into the project. Undo/redo swap
// whole snapshots (project + derived), so they are instant and exact.

import { APP_VERSION, FILE_FORMAT_VERSION, FILE_FORMAT_ID } from '../version.js';
import { poleOfInaccessibility, polygonArea, pointInPolygon, parallelOverlap, segmentIntersection } from './geom.js';
import { straightenStroke, classifyDirection } from './sketch.js';
import {
  addSegment, removeEdge, moveNode as graphMoveNode, nearestEdge, findFaces, edgeFaces, nextId,
  findPlanarityProblem, snapPoint, joinStrokeEnds, dropLooseEnd, shortStroke, passedCorner, cornerDiagonal,
} from './graph.js';
import { roomSides, matchRooms, sidesForEdge, sidesByNode, sideRun } from './rooms.js';
import { solve, thicknessPriors, scaleRatios, median, sketchInnerLength, innerLengthOf, innerLengthBetween } from './solver.js';
import { installOpenings, reconcileOpenings, sanitizeOpenings } from './openings.js';
import { installFixtures, normalizeFixture } from './fixtures.js';
import { installMemo, validMemo } from './memo.js';
import { installDims } from './dims.js';
import { installRotate } from './rotate.js';
import { installErase, carryMerged } from './erase.js';

export const DEFAULT_SETTINGS = Object.freeze({ extWall: 150, intWall: 100, twoSideTolerance: 300, closureTolerance: 300 });
export const UNDO_LIMIT = 100;
// A measure whose drawn inner length differs from its value by more than this gets a 'residual' warning.
export const RESIDUAL_TOLERANCE_MM = 5;
// A measured diagonal side that the axis values already fix (a check only: no row, nothing moves) is
// 확인필요 when it misses the drawing by more than this (or closureTolerance when that is smaller).
// Nothing absorbs a diagonal's difference and it is compared with its own neighbours only, not with a
// long row of values: 50 mm is several times the tape's error over a room, so the room is not square
// or a value slipped (2026-10-19; a diagonal wall 50 mm thicker than assumed moves a corner-to-corner
// face by about 50 mm, so the message also asks about the walls around it).
export const DIAGONAL_TOLERANCE_MM = 50;
// The two faces of an h / v wall measured from both rooms, where one face ends at a diagonal wall
// (twoSidePairs `faces`): faces whose drawn inner lengths differ by at least this are two different
// lengths, not one length measured twice (fixer 2026-10-20).
export const FACE_GAP_MM = 5;
// 'outlier' (다시 확인, a missing or extra zero): a value more than OUTLIER_FACTOR times off what the
// other values predict and at least OUTLIER_MIN_MM away from it; with two values, the drawing decides
// when exactly one of them is more than DRAWN_FACTOR times off the drawn length (see computeWarnings).
export const OUTLIER_FACTOR = 4;
export const OUTLIER_MIN_MM = 200;
const DRAWN_FACTOR = 6;
// Kept measures / rooms whose side or face is gone for now (DESIGN.md §7.7): at most this many, newest kept.
export const MAX_DETACHED_MEASURES = 100;
export const MAX_DETACHED_ROOMS = 30;
const FORMAT = FILE_FORMAT_ID || 'habitat-floorplan';

// ---- project creation and validation -------------------------------------------------------------

function randomBase36(n) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[bytes[i] % 36];
  return s;
}

function todayLocal() {
  const d = new Date();
  const pad = (k) => String(k).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowIso() { return new Date().toISOString(); }

function emptyInfo() {
  return { projectName: '', householdName: '', address: '', surveyDate: todayLocal(), surveyor: '', title: '' };
}

export function createProject(partialInfo = {}) {
  const now = nowIso();
  return {
    format: FORMAT,
    version: FILE_FORMAT_VERSION,
    appVersion: APP_VERSION,
    id: 'p_' + randomBase36(12),
    createdAt: now,
    modifiedAt: now,
    exportedAt: null,
    info: { ...emptyInfo(), ...(partialInfo || {}) },
    settings: { ...DEFAULT_SETTINGS },
    sketchScale: 1,
    nodes: [], edges: [], rooms: [], measures: [], wallChecks: [],
    openings: [], fixtures: [], memo: [], checks: [], dimOverrides: [], labelOffsets: {},
    detachedMeasures: [], detachedRooms: [],
  };
}

const isNum = (v) => typeof v === 'number' && isFinite(v);

// Geometric anchor of a measure (DESIGN.md §7.7): { ax, ay, bx, by, nx, ny } = the world positions of
// its corners m.from (a) and m.to (b) at the last solve, and the inward normal of the measured face. →
// a clean copy | null
function cleanAnchor(at) {
  if (!at || typeof at !== 'object') return null;
  const keys = ['ax', 'ay', 'bx', 'by', 'nx', 'ny'];
  if (!keys.every((k) => isNum(at[k]))) return null;
  if (!(Math.hypot(at.nx, at.ny) > 0.5)) return null;
  const out = {};
  for (const k of keys) out[k] = at[k];
  return out;
}

// → { ok, errors: [Korean messages], project }
// ok = false only for files that cannot be used at all. When ok is true, `errors` lists the repairs
// that were made (the file still opens).
export function validateProject(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['평면도 파일이 아닙니다.'], project: null };
  }
  if (obj.format !== FORMAT) return { ok: false, errors: ['평면도 파일이 아닙니다.'], project: null };
  if (!isNum(obj.version)) return { ok: false, errors: ['파일 버전 정보가 없습니다.'], project: null };
  if (obj.version > FILE_FORMAT_VERSION) {
    return { ok: false, errors: ['새 버전 앱에서 만든 파일입니다. 앱을 업데이트하세요.'], project: null };
  }
  for (const key of ['nodes', 'edges']) {
    if (obj[key] != null && !Array.isArray(obj[key])) {
      return { ok: false, errors: ['도면 자료가 손상되었습니다.'], project: null };
    }
  }

  const base = createProject();
  const p = {
    ...base,
    ...obj,
    version: FILE_FORMAT_VERSION,
    id: typeof obj.id === 'string' && obj.id ? obj.id : base.id,
    info: { ...base.info, ...(obj.info && typeof obj.info === 'object' ? obj.info : {}) },
    settings: { ...DEFAULT_SETTINGS, ...(obj.settings && typeof obj.settings === 'object' ? obj.settings : {}) },
    sketchScale: isNum(obj.sketchScale) && obj.sketchScale > 0 ? obj.sketchScale : 1,
    labelOffsets: obj.labelOffsets && typeof obj.labelOffsets === 'object' ? obj.labelOffsets : {},
  };
  if (typeof obj.id !== 'string' || !obj.id) errors.push('세대 번호가 없어 새로 만들었습니다.');
  // Info fields are text. A file edited by hand (or in Excel) may hold numbers or objects there; the
  // list screen and file names expect strings.
  let badInfo = false;
  for (const key of Object.keys(p.info)) {
    const v = p.info[key];
    if (typeof v === 'string') continue;
    badInfo = true;
    p.info[key] = (typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' ? String(v) : '';
  }
  if (badInfo) errors.push('세대 정보 중 글자가 아닌 값을 고쳤습니다.');
  for (const key of ['rooms', 'measures', 'wallChecks', 'openings', 'fixtures', 'memo', 'checks', 'dimOverrides']) {
    if (!Array.isArray(p[key])) p[key] = [];
  }

  // Nodes.
  const nodeIds = new Set();
  p.nodes = (obj.nodes || []).filter((n) => {
    const ok = n && typeof n.id === 'string' && isNum(n.x) && isNum(n.y) && !nodeIds.has(n.id);
    if (ok) nodeIds.add(n.id);
    return ok;
  }).map((n) => ({ id: n.id, x: n.x, y: n.y }));
  if (p.nodes.length !== (obj.nodes || []).length) errors.push('잘못된 모서리 점을 정리했습니다.');

  // Edges.
  const nodeMap = new Map(p.nodes.map((n) => [n.id, n]));
  const edgeIds = new Set();
  let badEdges = 0;
  p.edges = [];
  for (const e of obj.edges || []) {
    if (!e || typeof e.id !== 'string' || edgeIds.has(e.id) || !nodeMap.has(e.a) || !nodeMap.has(e.b) || e.a === e.b) {
      badEdges++;
      continue;
    }
    edgeIds.add(e.id);
    const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
    const orient = ['h', 'v', 'd'].includes(e.orient) ? e.orient
      : classifyDirection({ x: B.x - A.x, y: B.y - A.y }, true, 5 * Math.PI / 180).orient;
    const sketch = e.sketch && isNum(e.sketch.dx) && isNum(e.sketch.dy)
      ? { dx: e.sketch.dx, dy: e.sketch.dy }
      : { dx: (B.x - A.x) / p.sketchScale, dy: (B.y - A.y) / p.sketchScale };
    p.edges.push({
      id: e.id, a: e.a, b: e.b,
      kind: e.kind === 'divider' ? 'divider' : 'wall',
      orient, sketch,
      thickness: isNum(e.thickness) && e.thickness >= 0 ? e.thickness : null,
    });
  }
  if (badEdges) errors.push(`연결이 잘못된 벽 ${badEdges}개를 정리했습니다.`);
  // Orphan nodes.
  const used = new Set();
  for (const e of p.edges) { used.add(e.a); used.add(e.b); }
  p.nodes = p.nodes.filter((n) => used.has(n.id));

  // Rooms.
  const roomIds = new Set();
  p.rooms = p.rooms.filter((r) => r && typeof r.id === 'string' && !roomIds.has(r.id) && roomIds.add(r.id))
    .map((r) => ({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      height: isNum(r.height) ? r.height : null,
      seed: r.seed && isNum(r.seed.x) && isNum(r.seed.y) ? { x: r.seed.x, y: r.seed.y } : null,
      notRoom: !!r.notRoom,
    }));
  if (p.rooms.some((r) => !r.seed)) errors.push('위치 정보가 없는 실이 있어 다시 인식합니다.');

  // Measures.
  const measureIds = new Set();
  const before = p.measures.length;
  const cleanMeasure = (m) => {
    const out = {
      id: m.id, room: m.room, from: m.from, to: m.to,
      value: isNum(m.value) && m.value > 0 ? m.value : null,
      parts: Array.isArray(m.parts) ? m.parts.filter(isNum) : [],
      check: !!m.check,
    };
    const at = cleanAnchor(m.at);
    if (at) out.at = at;
    return out;
  };
  p.measures = p.measures.filter((m) => m && typeof m.id === 'string' && !measureIds.has(m.id) && measureIds.add(m.id)
    && roomIds.has(m.room) && nodeMap.has(m.from) && nodeMap.has(m.to))
    .map(cleanMeasure)
    .filter((m) => m.value != null || m.check);
  if (p.measures.length !== before) errors.push('쓸 수 없는 길이 값을 정리했습니다.');
  // Measures and rooms kept while their side / face is gone (DESIGN.md §7.7). Broken entries are
  // simply left out (nothing the user sees depends on them).
  p.detachedMeasures = (Array.isArray(obj.detachedMeasures) ? obj.detachedMeasures : [])
    .filter((m) => m && typeof m.id === 'string' && !measureIds.has(m.id) && measureIds.add(m.id)
      && typeof m.from === 'string' && typeof m.to === 'string' && isNum(m.value) && m.value > 0 && cleanAnchor(m.at))
    .map((m) => cleanMeasure({ ...m, room: typeof m.room === 'string' ? m.room : '' }))
    .slice(-MAX_DETACHED_MEASURES);
  p.detachedRooms = (Array.isArray(obj.detachedRooms) ? obj.detachedRooms : [])
    .filter((r) => r && typeof r.id === 'string' && !roomIds.has(r.id) && roomIds.add(r.id)
      && Array.isArray(r.polygon) && r.polygon.length >= 3 && r.polygon.every((q) => q && isNum(q.x) && isNum(q.y)))
    .map((r) => {
      const out = {
        id: r.id, name: typeof r.name === 'string' ? r.name : '', height: isNum(r.height) ? r.height : null,
        notRoom: !!r.notRoom, polygon: r.polygon.map((q) => ({ x: q.x, y: q.y })),
      };
      if (Array.isArray(r.nodeIds) && r.nodeIds.length === r.polygon.length && r.nodeIds.every((id) => typeof id === 'string')) {
        out.nodeIds = r.nodeIds.slice();
      }
      return out;
    })
    .slice(-MAX_DETACHED_ROOMS);
  // The 현장 원본 feature of 0.3.0–0.4.1 (raw strokes and a frozen snapshot) was not what the team
  // meant (2026-10-18: they wanted the plan without dimension lines, now [출력] 종류 '치수선 없이'), so
  // its recordings are dropped from older files.
  delete p.fieldOriginal;
  delete p.fieldSketch;

  p.wallChecks =p.wallChecks.filter((w) => w && edgeIds.has(w.edge)).map((w) => ({ edge: w.edge, note: typeof w.note === 'string' ? w.note : '' }));

  // Stage B/C/D data (older files simply have empty lists; see createProject).
  let out = sanitizeOpenings(p);
  if (out !== p) errors.push('쓸 수 없는 창·문을 정리했습니다.');
  const fixtures = [];
  const fixtureIds = new Set();
  for (const f of out.fixtures) {
    const n = normalizeFixture(f);
    if (!n || !n.id || fixtureIds.has(n.id)) continue;
    fixtureIds.add(n.id);
    // A wall that no longer exists: the fixture stays where it is, free-standing.
    fixtures.push(n.wall && !edgeIds.has(n.wall) ? { ...n, wall: null } : n);
  }
  if (fixtures.length !== out.fixtures.length) errors.push('쓸 수 없는 설비를 정리했습니다.');
  const memo = validMemo(out.memo);
  if (memo.length !== out.memo.length) errors.push('쓸 수 없는 메모를 정리했습니다.');
  const checks = out.checks.filter((c) => c && typeof c.key === 'string' && c.key);
  const dimOverrides = out.dimOverrides.filter((o) => o && typeof o.measureId === 'string');
  const labelOffsets = {};
  for (const [k, v] of Object.entries(out.labelOffsets || {})) {
    if (!(v && isNum(Number(v.dx)) && isNum(Number(v.dy)))) continue;
    labelOffsets[k] = { dx: Number(v.dx), dy: Number(v.dy) };
    // A moved room name keeps its placement anchor (labels.js followMovedLabels: { u, v, dx, dy }), so a
    // reopened file goes on from the same spot in its room (review 예시 세대 A round 2).
    const pin = v.pin;
    if (k.startsWith('room:') && pin && typeof pin === 'object' && [pin.u, pin.v, pin.dx, pin.dy].every(isNum)) {
      labelOffsets[k].pin = { u: pin.u, v: pin.v, dx: pin.dx, dy: pin.dy };
    }
  }
  out = { ...out, fixtures, memo, checks, dimOverrides, labelOffsets };
  return { ok: true, errors, project: out };
}

// ---- derivation ----------------------------------------------------------------------------------

const sideKeyOf = (m) => [m.from, m.to].sort().join('-');

// Faces → rooms → measures check → solve → solved geometry.
// opts.reuseFaces: the command did not move the plan as a whole (not 도면 돌리기): when the wall graph
//   is the one prevDerived was found on (graphKey), its faces and rooms are kept as they are.
// opts.prevProject: the project before this command (which values it changed, for 'fold' warnings).
// → { project, derived, dropped, detachedNow }
//   dropped: measures that are gone for good; detachedNow: measures that lost their side in this edit
//   and are kept in project.detachedMeasures (DESIGN.md §7.7)
function derive(project, prevDerived, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const detachedRooms0 = project.detachedRooms || [];
  // Typing a value (or a name, a thickness) never changes the wall graph, so it cannot change the rooms
  // either. Faces found again on the solved positions could: a value that contradicts two walls drawn
  // close together once folded the plan, the faces found on it merged three rooms, and their values
  // detached (예시 세대 A test 2026-10-18, A15 2900). So the faces of the unchanged graph are reused.
  const key = graphKey(project);
  let faces0 = null, match = null;
  if (opts.reuseFaces && prevDerived && prevDerived.graphKey === key) {
    faces0 = reusedFaces(project, prevDerived);
    match = faces0 && sameRooms(project, prevDerived, faces0.length);
  }
  if (!match) {
    faces0 = findFaces(project);
    let prevPolygons = null;
    if (prevDerived) {
      prevPolygons = new Map();
      for (const r of prevDerived.rooms) prevPolygons.set(r.roomId, r.face.points);
    }
    match = matchRooms(project, faces0, project.rooms || [], { prevPolygons, detached: detachedRooms0 });
  }
  const roomById = new Map(match.rooms.map((r) => [r.id, r]));
  const dRooms0 = faces0.map((face, fi) => ({
    roomId: match.faceRoom[fi], room: roomById.get(match.faceRoom[fi]), face, faceIndex: fi, sides: roomSides(face, project),
  }));

  // Rooms that lost their face are kept with their last outline, so that they come back when the room
  // is closed again (a wall redrawn); see rooms.js matchRooms.
  const revived = new Set(match.revived || []);
  const gone = [...match.dropped, ...match.merged.map((x) => x.removed)];
  const newlyDetached = [];
  for (const id of gone) {
    const r = (project.rooms || []).find((x) => x.id === id);
    const prevRoom = prevDerived && prevDerived.rooms.find((x) => x.roomId === id);
    const poly = prevRoom && prevRoom.face.points;
    if (!r || !poly || poly.length < 3) continue;
    newlyDetached.push({
      id, name: r.name || '', height: isNum(r.height) ? r.height : null, notRoom: !!r.notRoom,
      polygon: poly.map((q) => ({ x: round2(q.x), y: round2(q.y) })),
      nodeIds: prevRoom.face.nodeIds.slice(),
    });
  }
  const goneSet = new Set(newlyDetached.map((r) => r.id));
  const detachedRooms = detachedRooms0.filter((r) => !revived.has(r.id) && !goneSet.has(r.id)).concat(newlyDetached)
    .slice(-MAX_DETACHED_ROOMS);

  // Keep measures whose side (or span) still exists; follow merges and splits; keep the others detached.
  const att = attachMeasures(project, dRooms0, match);

  const edgeIdSet = new Set((project.edges || []).map((e) => e.id));
  const pre = {
    ...project,
    rooms: match.rooms,
    measures: att.measures,
    detachedMeasures: att.detached,
    detachedRooms,
    wallChecks: (project.wallChecks || []).filter((w) => edgeIdSet.has(w.edge)),
  };
  const solverSpans = new Map();
  for (const [id, parts] of att.spanParts) solverSpans.set(id, parts.map((r) => ({ roomId: r.dr.roomId, i: r.i })));
  const sol = solve(pre, dRooms0, { spans: solverSpans });
  // opts.holdPlace (a turn of the whole plan, core/rotate.js): the solved plan stays where the turn put
  // its corners (holdSolvedPlace). The solve's gauge rows (1e-6) against its 1e8 bound pins leave the
  // plan's place to the rounding: a solved 예시 세대 A moved 0.3 mm on every turn, and four turns did not come
  // back; ↶ / ↷ after a turn must give the turned earlier states exactly.
  if (opts.holdPlace) holdSolvedPlace(pre.nodes, sol.positions);

  // Solved geometry.
  const nodes = (pre.nodes || []).map((n) => {
    const q = sol.positions.get(n.id);
    return q && isFinite(q.x) && isFinite(q.y) ? { ...n, x: q.x, y: q.y } : n;
  });
  const solved = { ...pre, nodes, sketchScale: sol.scale };
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const faces = faces0.map((f) => {
    const points = f.nodeIds.map((id) => ({ x: nodeMap.get(id).x, y: nodeMap.get(id).y }));
    return { ...f, points, area: polygonArea(points) };
  });
  const rooms = match.rooms.map((r) => ({ ...r }));
  const roomObj = new Map(rooms.map((r) => [r.id, r]));
  // A room standing inside another room (an island 창고 in a 거실): the outer room's label point, and so
  // its seed, keeps out of it. Inside the island, the seed matched the outer room to the island's face
  // on the next fresh match (reopening, 도면 돌리기: review 0.5.0).
  const holesOf = nestedFaces(faces);
  const dRooms = faces.map((face, fi) => {
    const roomId = match.faceRoom[fi];
    const labelPoint = poleOfInaccessibility(face.points, 20, holesOf[fi]);
    const room = roomObj.get(roomId);
    room.seed = { x: labelPoint.x, y: labelPoint.y };
    return { roomId, room, face, faceIndex: fi, sides: roomSides(face, solved), labelPoint, area: face.area };
  });
  solved.rooms = rooms;

  // Spans and their computed parts on the solved geometry; anchors of the attached measures; outlines
  // of the detached rooms follow the corners that still exist.
  const { spans, computedMeasures } = spanResults(solved, dRooms, att.spanParts, sol);
  solved.measures = refreshAnchors(solved.measures, dRooms, spans, nodeMap);
  solved.detachedRooms = detachedRooms.map((r) => followCorners(r, nodeMap));

  const ef = edgeFaces(solved, faces);
  const outliers = outlierWarnings(solved, dRooms, spans);
  const outlierIds = new Set(outliers.filter((w) => w.type === 'outlier').map((w) => w.measureId));
  const folds = foldsOf(project, solved, sol, prevDerived, opts.prevProject, outlierIds);
  const { warnings, twoSidePairs } = computeWarnings(solved, dRooms, sol, { edgeFaces: ef, spans, computedMeasures, solverSpans, folds, outliers });
  const computedBySide = new Map(computedMeasures.map((c) => [`${c.room}|${sideKeyOf(c)}`, c]));
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const derived = {
    graphKey: key,
    faces, rooms: dRooms, edgeFaces: ef, solve: sol, warnings, twoSidePairs,
    roomChanges: { created: match.created, merged: match.merged, dropped: match.dropped, revived: match.revived || [] },
    spans, computedMeasures, computedBySide,
    notes: { splitComputed: computedMeasures.length > 0 },
    timeMs: t1 - t0,
  };
  return { project: solved, derived, dropped: att.dropped, detachedNow: att.detachedNow };
}

const round2 = (v) => Math.round(v * 100) / 100;

// derive opts.holdPlace: the solved positions (Map id → { x, y }, changed in place) stay where the corners
// were before the solve. A turned solved plan is its own solution; the re-solve only adds its rounding
// (a shift of a few tenths of a mm and about 0.01 mm of shape on the measured 예시 세대 A; diagonal values
// settle at 0.1 mm; a sketch with ONE value moves 0.5 mm on every re-solve, turned or not), so the corners
// are kept exactly when no corner moved more than HOLD_KEEP_MM after the shift: the turned plan is the
// plan the surveyor saw, turned, with the same numbers. A larger move is a real one (not expected: the
// state before a turn is always a solved one); the solved shape is kept then, at the old place.
const HOLD_KEEP_MM = 2;
function holdSolvedPlace(nodes, positions) {
  let dx = 0, dy = 0, k = 0;
  const given = [];
  for (const n of nodes || []) {
    const q = positions && positions.get(n.id);
    if (!q || !isNum(n.x) || !isNum(n.y) || !isNum(q.x) || !isNum(q.y)) continue;
    dx += n.x - q.x; dy += n.y - q.y; k++;
    given.push(n);
  }
  if (!k) return;
  dx /= k; dy /= k;
  let worst = 0;
  for (const n of given) {
    const q = positions.get(n.id);
    worst = Math.max(worst, Math.abs(q.x + dx - n.x), Math.abs(q.y + dy - n.y));
  }
  if (worst <= HOLD_KEEP_MM) {
    for (const n of given) positions.set(n.id, { ...positions.get(n.id), x: n.x, y: n.y });
    return;
  }
  for (const [id, q] of positions) {
    if (q && isNum(q.x) && isNum(q.y)) positions.set(id, { ...q, x: q.x + dx, y: q.y + dy });
  }
}

// The wall graph as drawn: corner ids and every wall / divider with its ends, kind, h/v/d and sketch
// vector, but not the positions (every solve moves those). A corner drag changes the sketch vectors.
function graphKey(project) {
  const parts = (project.nodes || []).map((n) => n.id);
  parts.push('|');
  for (const e of project.edges || []) {
    const s = e.sketch || {};
    parts.push(`${e.id}:${e.a}:${e.b}:${e.kind}:${e.orient}:${s.dx}:${s.dy}`);
  }
  return parts.join(',');
}

// prevDerived's faces (same corners, same order) on the current positions. → faces | null
function reusedFaces(project, prevDerived) {
  const nodeMap = new Map((project.nodes || []).map((n) => [n.id, n]));
  const out = [];
  for (const f of prevDerived.faces || []) {
    if (!f.nodeIds.every((id) => nodeMap.has(id))) return null;
    const points = f.nodeIds.map((id) => ({ x: nodeMap.get(id).x, y: nodeMap.get(id).y }));
    out.push({ nodeIds: f.nodeIds, edgeIds: f.edgeIds, points, area: polygonArea(points) });
  }
  return out;
}

// Every face keeps the room it had in prevDerived. → a matchRooms result | null when the stored rooms
// and the faces do not correspond one to one (then the rooms are matched again)
function sameRooms(project, prevDerived, nFaces) {
  const faceRoom = new Array(nFaces).fill(null);
  for (const dr of prevDerived.rooms || []) if (dr.faceIndex >= 0 && dr.faceIndex < nFaces) faceRoom[dr.faceIndex] = dr.roomId;
  const rooms = project.rooms || [];
  const ids = new Set(rooms.map((r) => r.id));
  if (faceRoom.some((id) => id == null || !ids.has(id)) || new Set(faceRoom).size !== rooms.length) return null;
  return { rooms: rooms.slice(), faceRoom, created: [], merged: [], dropped: [], revived: [] };
}

// Walls run side by side at least this long before their bodies "overlap" (checks-full.js uses the same).
const OVERLAP_MIN_MM = 10;

// Pairs of walls / dividers that cross, or walls whose bodies overlap side by side, by the drawing
// checks' rules (checks-full.js drawingChecks). thick(edge) → mm. → Map 'idA|idB' → [idA, idB]
function wallClashes(nodeMap, edges, thick) {
  const list = (edges || []).filter((e) => nodeMap.has(e.a) && nodeMap.has(e.b));
  const out = new Map();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
    for (let j = i + 1; j < list.length; j++) {
      const f = list[j];
      const C = nodeMap.get(f.a), D = nodeMap.get(f.b);
      const ids = [e.id, f.id].sort();
      const ov = parallelOverlap(A, B, C, D);
      if (ov) {
        const reach = e.kind !== 'divider' && f.kind !== 'divider' ? (thick(e) + thick(f)) / 2 : 0;
        if (ov.length > OVERLAP_MIN_MM && ov.distance < Math.max(1, reach - 1)) out.set(ids.join('|'), ids);
        continue;
      }
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      const hit = segmentIntersection(A, B, C, D);
      if (hit && hit.t > 1e-3 && hit.t < 1 - 1e-3 && hit.u > 1e-3 && hit.u < 1 - 1e-3) out.set(ids.join('|'), ids);
    }
  }
  return out;
}

// Folds caused by the values (DESIGN.md contract C1): edges the solver had to hold in their drawn order
// against the values (sol.folds), and walls the solve made cross or overlap although they did not
// before this command (nor in the plan before it scaled to the new values). Each fold names the values
// most likely responsible, likeliest first (at most MAX_FOLD_VALUES): a value already called 'outlier'
// among those that had to give (a missing zero is the usual cause), else the ones this command changed,
// the ones named for the same fold one command earlier, then the others that had to give (the pair of
// contradicting values: the one typed last is not always the wrong one). A clash no value can be named
// for is left to the drawing checks. outliers: Set of measure ids. → [{ measureIds, edgeIds }]
const MAX_FOLD_VALUES = 3;
function foldsOf(input, solved, sol, prevDerived, prevProject, outliers) {
  const valid = new Set((solved.measures || []).filter((m) => isNum(m.value) && m.value > 0).map((m) => m.id));
  const before = new Map(((prevProject && prevProject.measures) || []).map((m) => [m.id, m.value]));
  const changed = prevProject
    ? (solved.measures || []).filter((m) => valid.has(m.id) && before.get(m.id) !== m.value).map((m) => m.id) : [];
  const prevFolds = ((prevDerived && prevDerived.warnings) || []).filter((w) => w && w.type === 'fold');
  const carried = (edgeIds) => {
    const ids = [];
    for (const w of prevFolds) {
      if (!(w.edgeIds || []).some((id) => edgeIds.includes(id))) continue;
      for (const id of w.measureIds || []) if (valid.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const out = [];
  const gave = []; // the values that had to give in the solver's folds and conflicts, outliers first
  for (const f of [...(sol.folds || []), ...(sol.conflicts || [])]) {
    for (const id of f.measureIds || []) if (valid.has(id) && !gave.includes(id)) gave.push(id);
  }
  gave.sort((p, q) => Number(outliers.has(q)) - Number(outliers.has(p)));
  for (const f of sol.folds || []) {
    const inv = (f.measureIds || []).filter((id) => valid.has(id));
    const bad = inv.filter((id) => outliers.has(id));
    const likely = bad.length ? bad : [...new Set([
      ...changed.filter((id) => inv.includes(id)), ...carried([f.edgeId]).filter((id) => inv.includes(id)), ...inv,
    ])];
    out.push({ measureIds: likely.slice(0, MAX_FOLD_VALUES), edgeIds: [f.edgeId] });
  }
  if (prevDerived && prevDerived.solve) {
    const thickIn = prevDerived.solve.thickness;
    const thickNow = sol.thickness;
    const inMap = new Map((input.nodes || []).map((n) => [n.id, n]));
    const nowMap = new Map((solved.nodes || []).map((n) => [n.id, n]));
    // The plan before this command, scaled about its middle to the new scale (the first value rescales
    // the whole sketch; two walls drawn close together may touch then, which is the drawing, not a value).
    const k = sol.scale / (input.sketchScale > 0 ? input.sketchScale : 1);
    let cx = 0, cy = 0;
    for (const n of inMap.values()) { cx += n.x; cy += n.y; }
    cx /= Math.max(1, inMap.size); cy /= Math.max(1, inMap.size);
    const scaledMap = new Map([...inMap].map(([id, n]) => [id, { x: cx + (n.x - cx) * k, y: cy + (n.y - cy) * k }]));
    const tIn = (e) => (thickIn.get(e.id) ?? thickNow.get(e.id)) || 0, tNow = (e) => thickNow.get(e.id) || 0;
    const was = wallClashes(inMap, input.edges, tIn), wasScaled = wallClashes(scaledMap, input.edges, tNow);
    const prevEdges = new Set(prevFolds.flatMap((w) => w.edgeIds || []));
    for (const [key, ids] of wallClashes(nowMap, solved.edges, tNow)) {
      let m = [];
      if (!was.has(key) && !wasScaled.has(key)) m = changed.length ? changed : carried(ids).length ? carried(ids) : gave.slice(0, MAX_FOLD_VALUES);
      else if (ids.some((id) => prevEdges.has(id))) m = carried(ids);
      if (m.length) out.push({ measureIds: m, edgeIds: ids });
    }
  }
  // One warning per set of values.
  const byIds = new Map();
  for (const f of out) {
    if (!f.measureIds.length) continue;
    const key = f.measureIds.slice().sort().join(',');
    const g = byIds.get(key);
    if (g) { for (const id of f.edgeIds) if (!g.edgeIds.includes(id)) g.edgeIds.push(id); } else byIds.set(key, { measureIds: f.measureIds.slice(), edgeIds: f.edgeIds.slice() });
  }
  return [...byIds.values()];
}

// For each face, the outlines of the faces lying inside it (faces of a planar drawing overlap only by
// nesting, so one interior point of a smaller face inside this face's outline decides). → [[points]]
function nestedFaces(faces) {
  if (faces.length < 2) return faces.map(() => []);
  const inner = faces.map((f) => (f.points.length >= 3 ? poleOfInaccessibility(f.points, 50) : null));
  const size = faces.map((f) => Math.abs(f.area || polygonArea(f.points)));
  return faces.map((f, i) => {
    const out = [];
    faces.forEach((g, j) => {
      if (j === i || !inner[j] || size[j] >= size[i]) return;
      if (pointInPolygon(inner[j], f.points)) out.push(g.points);
    });
    return out;
  });
}
const dot = (p, q) => p.x * q.x + p.y * q.y;
const distXY = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// The face a measure was taken on must point the same way (two rooms share the corners of a wall).
const FACE_DOT = 0.7;
// Spans join room sides across 구역 나누기 dividers (§7.7) and across walls drawn over a measured side
// (§7.9: the wall's assumed thickness lies between the parts).
const RUN_OPTS = Object.freeze({ acrossWalls: true });

// Find the side (or the span across dividers / walls) of every measure in the new faces (DESIGN.md
// §7.7, §7.9).
// Order of the tests, for each measure:
//   1. the same room (or the room it was merged into) still has a side between the same corners;
//   2. another room has a side between the same corners on the same face (a room split: the side is in
//      the new part now);
//   3. the corners are joined by a straight run of sides across dividers: the measure is a SPAN;
//   4. by position (anchor m.at): a side or span whose corners lie where the measure's corners were
//      (corner nodes that were merged away and drawn again, a T-junction redrawn).
// A measure found nowhere is kept detached (project.detachedMeasures) and tried again after every
// edit; an older one is dropped when its side already holds a value.
// → { measures, detached, dropped, detachedNow, spanParts: Map measureId → [{ dr, i, side }] }
function attachMeasures(project, dRooms, match) {
  const nodeMap = new Map((project.nodes || []).map((n) => [n.id, n]));
  const mergedInto = new Map((match.merged || []).map((x) => [x.removed, x.kept]));
  const created = new Set(match.created || []);
  const byRoomKey = new Map(), byKey = new Map();
  for (const dr of dRooms) {
    dr.sides.forEach((side, i) => {
      const rec = { dr, i, side };
      byRoomKey.set(`${dr.roomId}|${side.key}`, rec);
      if (!byKey.has(side.key)) byKey.set(side.key, []);
      byKey.get(side.key).push(rec);
    });
  }
  const byNode = sidesByNode(dRooms);

  const anchorOf = (m) => {
    const at = m.at;
    if (!at || !isNum(at.nx)) return null;
    return { A: { x: at.ax, y: at.ay }, B: { x: at.bx, y: at.by }, n: { x: at.nx, y: at.ny } };
  };
  // A detached measure takes corner nodes by id only near where they were (ids are reused).
  const looseTol = (anc) => Math.max(1000, 0.5 * distXY(anc.A, anc.B));
  const plausible = (anc, ids) => {
    if (!anc) return true;
    const P = nodeMap.get(ids[0]), Q = nodeMap.get(ids[1]);
    if (!P || !Q) return false;
    const tol = looseTol(anc);
    return Math.min(distXY(P, anc.A) + distXY(Q, anc.B), distXY(P, anc.B) + distXY(Q, anc.A)) <= 2 * tol;
  };

  const locate = (m, detached) => {
    const key = sideKeyOf(m);
    const anc = anchorOf(m);
    const n = anc && anc.n;
    const faces = (side) => !n || dot(side.inwardNormal, n) > FACE_DOT;
    const check = detached ? anc : null;
    // 1. Same room, same corners. In the measure's OWN room (not the one it merged into) the corners
    // alone name the side, so the face test is skipped there: an anchor recorded while the plan was
    // folded faced the other way, and the value then never came back to its room (예시 세대 A test 2026-10-18).
    const rec = byRoomKey.get(`${mergedInto.get(m.room) || m.room}|${key}`);
    if (rec && (faces(rec.side) || rec.dr.roomId === m.room) && plausible(check, [rec.side.from, rec.side.to])) return [rec];
    // 2. Same corners, same face, another room. Without an anchor only new rooms qualify (as before).
    for (const r of byKey.get(key) || []) {
      if (n ? !faces(r.side) : !created.has(r.dr.roomId)) continue;
      if (plausible(check, [r.side.from, r.side.to])) return [r];
    }
    // 3. A span across dividers or walls between the same corners (§7.7, §7.9).
    if (n && plausible(check, [m.from, m.to])) {
      const run = sideRun(byNode, nodeMap, m.from, m.to, n, RUN_OPTS);
      if (run) return run;
    }
    // 4. By position.
    return anc ? locateByPosition(m, anc) : null;
  };

  // Corners near the anchor: a surviving corner node (same id, still near its anchor) carries the
  // other corner with it, so a plan that moved a little as a whole still matches.
  const locateByPosition = (m, anc) => {
    const len = distXY(anc.A, anc.B);
    const tol = Math.min(300, Math.max(80, 0.25 * len));
    const loose = looseTol(anc);
    const F = nodeMap.get(m.from), T = nodeMap.get(m.to);
    const fromOk = !!F && distXY(F, anc.A) <= loose, toOk = !!T && distXY(T, anc.B) <= loose;
    const vAB = { x: anc.B.x - anc.A.x, y: anc.B.y - anc.A.y };
    const expA = fromOk ? F : toOk ? { x: T.x - vAB.x, y: T.y - vAB.y } : anc.A;
    const expB = toOk ? T : fromOk ? { x: F.x + vAB.x, y: F.y + vAB.y } : anc.B;
    const near = (p, keepId) => {
      const ids = [];
      for (const nd of project.nodes || []) if (distXY(nd, p) <= tol) ids.push(nd.id);
      if (keepId && !ids.includes(keepId)) ids.push(keepId);
      return ids;
    };
    const ca = near(expA, fromOk ? m.from : null), cb = near(expB, toOk ? m.to : null);
    let best = null;
    for (const f of ca) {
      for (const t of cb) {
        if (f === t) continue;
        const run = sideRun(byNode, nodeMap, f, t, anc.n, RUN_OPTS);
        if (!run) continue;
        const score = distXY(nodeMap.get(f), expA) + distXY(nodeMap.get(t), expB);
        if (!best || score < best.score) best = { run, score };
      }
    }
    return best ? best.run : null;
  };

  const takenSide = new Set(), takenSpan = new Set();
  const spanParts = new Map();
  // Attach m to the run found for it. → the attached measure | null (that side / span already has one)
  const place = (m, run) => {
    if (run.length === 1) {
      const { dr, side } = run[0];
      const k = `${dr.roomId}|${side.key}`;
      if (takenSide.has(k)) return null;
      takenSide.add(k);
      if (m.room === dr.roomId && sideKeyOf(m) === side.key) return m;
      return { ...m, room: dr.roomId, from: side.from, to: side.to };
    }
    const sig = run.map((r) => `${r.dr.roomId}|${r.side.key}`).join(',');
    if (takenSpan.has(sig)) return null;
    takenSpan.add(sig);
    const start = run[0].side.from, end = run[run.length - 1].side.to;
    const roomId = run.some((r) => r.dr.roomId === m.room) ? m.room : run[0].dr.roomId;
    const same = roomId === m.room && sideKeyOf(m) === [start, end].sort().join('-');
    const out = same ? m : { ...m, room: roomId, from: start, to: end };
    spanParts.set(out.id, run);
    return out;
  };

  const measures = [], detached = [], dropped = [], detachedNow = [];
  for (const m of project.measures || []) {
    const run = locate(m, false);
    const placed = run && place(m, run);
    if (placed) { measures.push(placed); continue; }
    // A second measure of one side, or a side that is gone and cannot be found again: a flag without
    // a value, or a measure without an anchor (older files), is dropped as before.
    if (!run && anchorOf(m) && isNum(m.value) && m.value > 0) {
      const d = { ...m };
      detached.push(d);
      detachedNow.push(d);
    } else {
      dropped.push(m);
    }
  }
  for (const m of project.detachedMeasures || []) {
    const run = locate(m, true);
    const placed = run && place(m, run);
    if (placed) { measures.push(placed); continue; }
    if (run) continue; // its side holds a newer value: the old one is obsolete
    detached.push(m);
  }
  return { measures, detached: detached.slice(-MAX_DETACHED_MEASURES), dropped, detachedNow, spanParts };
}

// Does the waiting (detached) measure m lie along the wall from P to Q? Used by deleteEdge: a value
// taken on a side that contains the deleted wall is that wall's own value, also while the room is open.
// The side's ends: its corner nodes where they still are (near the anchor), else the anchor itself.
const ALONG_TOL_MM = 30;
function detachedAlongEdge(m, P, Q, nodeMap) {
  const at = m && m.at;
  if (!P || !Q || !at || !isNum(at.ax) || !isNum(at.bx)) return false;
  const anc = { A: { x: at.ax, y: at.ay }, B: { x: at.bx, y: at.by } };
  const loose = Math.max(1000, 0.5 * distXY(anc.A, anc.B));
  const F = nodeMap.get(m.from), T = nodeMap.get(m.to);
  const useNodes = F && T && distXY(F, anc.A) <= loose && distXY(T, anc.B) <= loose;
  const A = useNodes ? F : anc.A, B = useNodes ? T : anc.B;
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  if (L < 1 || distXY(P, Q) < 1) return false;
  const onSide = (p) => {
    const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / (L * L);
    const off = Math.abs((p.x - A.x) * dy - (p.y - A.y) * dx) / L;
    return off <= ALONG_TOL_MM && t >= -ALONG_TOL_MM / L && t <= 1 + ALONG_TOL_MM / L;
  };
  return onSide(P) && onSide(Q);
}

// Inner length of every part of every span, on the solved geometry. A part without its own measured
// value gets a COMPUTED value from the divider / wall positions: the parts plus what lies between them
// (nothing for a divider; the wall's thickness and the finishes on its two faces for a wall, §7.9) add
// up to the span's value; rounded so that the printed numbers add up too (parts + wall = span).
// → { spans: [...], computedMeasures: [...] } (DESIGN.md §7.7, §7.9)
function spanResults(project, dRooms, spanParts, sol) {
  const spans = [], computedMeasures = [];
  if (!spanParts.size) return { spans, computedMeasures };
  const byRoom = new Map(dRooms.map((dr) => [dr.roomId, dr]));
  const edgeMap = new Map(project.edges.map((e) => [e.id, e]));
  const positions = new Map(project.nodes.map((n) => [n.id, n]));
  const real = new Map();
  for (const m of project.measures) {
    if (spanParts.has(m.id) || !(isNum(m.value) && m.value > 0)) continue;
    real.set(`${m.room}|${sideKeyOf(m)}`, m);
  }
  const seen = new Set();
  let priors = null; // assumed wall thicknesses, computed once when a span crosses a wall
  for (const m of project.measures) {
    const run = spanParts.get(m.id);
    if (!run) continue;
    const parts = run.map((r) => {
      const dr = byRoom.get(r.dr.roomId);
      const i = dr ? dr.sides.findIndex((s) => s.key === r.side.key) : -1;
      return { dr, i };
    });
    if (parts.some((p) => !p.dr || p.i < 0)) continue;
    const at = (p) => ({ sides: p.dr.sides, i: p.i, roomId: p.dr.roomId });
    const exact = parts.map((p) => innerLengthOf(p.dr.sides, p.i, p.dr.roomId, edgeMap, positions, sol.thickness, sol.finish));
    // What lies between two neighbouring parts (§7.9). `thickness` = the wall's ASSUMED thickness (its
    // default, or its measured thickness; 0 for a divider): parts + assumed walls = span is what the
    // printed numbers keep. `gap` = what the drawing leaves between the two parts' inner corners (the
    // solved wall + the finishes on its faces; equals the thickness unless the values contradict).
    const joints = [];
    for (let k = 0; k + 1 < parts.length; k++) {
      const both = innerLengthBetween(at(parts[k]), at(parts[k + 1]), edgeMap, positions, sol.thickness, sol.finish);
      const gap = isNum(both) ? Math.max(0, both - exact[k] - exact[k + 1]) : 0;
      const kind = run[k + 1].joint === 'wall' ? 'wall' : 'divider';
      const sides = parts[k].dr.sides;
      const turn = sides[(parts[k].i + 1) % sides.length];
      const edgeId = turn && turn.edgeIds.length ? turn.edgeIds[0] : null;
      if (kind === 'wall' && !priors) priors = thicknessPriors(project, dRooms);
      const thickness = kind === 'wall' && edgeId ? (priors.get(edgeId) || 0) : 0;
      joints.push({ kind, edgeId, thickness, gap: round2(gap) });
    }
    const wallGap = joints.reduce((s, j) => s + j.thickness, 0);
    const byWall = joints.some((j) => j.kind === 'wall');
    const reals = parts.map((p) => real.get(`${p.dr.roomId}|${p.dr.sides[p.i].key}`) || null);
    const hasValue = isNum(m.value) && m.value > 0;
    const shown = hasValue ? roundParts(m.value, exact, reals, wallGap) : exact.map((v) => Math.round(v));
    const first = parts[0].dr.sides[parts[0].i], last = parts[parts.length - 1].dr.sides[parts[parts.length - 1].i];
    const span = {
      measureId: m.id, roomId: m.room, key: sideKeyOf(m), value: m.value, check: !!m.check,
      orient: first.orient, normal: { x: first.inwardNormal.x, y: first.inwardNormal.y },
      from: first.from, to: last.to,
      joints, wallGap: round2(wallGap), drawnGap: round2(joints.reduce((s, j) => s + j.gap, 0)), byWall,
      parts: parts.map((p, k) => {
        const side = p.dr.sides[p.i];
        const computed = hasValue && !reals[k];
        return {
          roomId: p.dr.roomId, sideKey: side.key, sideIndex: p.i,
          measureId: reals[k] ? reals[k].id : null,
          value: reals[k] ? reals[k].value : computed ? shown[k] : null,
          exact: exact[k], computed,
        };
      }),
    };
    spans.push(span);
    for (const part of span.parts) {
      if (!part.computed) continue;
      const k = `${part.roomId}|${part.sideKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const side = byRoom.get(part.roomId).sides[part.sideIndex];
      computedMeasures.push({
        id: `computed:${m.id}:${part.roomId}:${part.sideKey}`, room: part.roomId, from: side.from, to: side.to,
        value: part.value, exact: part.exact, parts: [part.value], check: false, computed: true, spanId: m.id,
        byWall: span.byWall, wallGap: span.wallGap,
      });
    }
  }
  return { spans, computedMeasures };
}

// Whole-mm values for the computed parts of a span (largest remainder), so that the printed parts add
// up to the printed span: span value − walls between the parts (gap, §7.9) − measured parts. When the
// geometry does not add up (the measured parts contradict the span), the rest is shared in proportion.
function roundParts(value, exact, reals, gap = 0) {
  const out = exact.map((v, k) => (reals[k] ? reals[k].value : Math.round(v)));
  const idx = exact.map((_, k) => k).filter((k) => !reals[k]);
  if (!idx.length) return out;
  const target = Math.round(value - gap) - reals.reduce((s, r) => s + (r ? Math.round(r.value) : 0), 0);
  let sumExact = idx.reduce((s, k) => s + exact[k], 0);
  if (Math.abs(sumExact - target) > 2) {
    // The geometry does not add up (e.g. the top and bottom of a room were measured differently, so the
    // drawing cannot match both). The computed parts still add up to the measured value: the rest is
    // shared in proportion to the drawn parts. A typed part longer than the span leaves nothing to share.
    if (!(target > 0 && sumExact > 0)) return out;
    exact = exact.map((v, k) => (idx.includes(k) ? v * target / sumExact : v));
    sumExact = target;
  }
  for (const k of idx) out[k] = Math.floor(exact[k]);
  let rest = target - idx.reduce((s, k) => s + out[k], 0);
  const byFrac = idx.slice().sort((p, q) => (exact[q] - Math.floor(exact[q])) - (exact[p] - Math.floor(exact[p])));
  for (let j = 0; rest > 0; j++, rest--) out[byFrac[j % byFrac.length]] += 1;
  for (let j = byFrac.length - 1; rest < 0; j = (j - 1 + byFrac.length) % byFrac.length, rest++) out[byFrac[j]] -= 1;
  return out;
}

// A detached room's outline moved with the plan: vertices whose node still exists take its position; a
// vertex whose node is gone follows a surviving vertex on the same line (same old x or y), else the
// survivors' stretch along that axis when it lies between them, else their mean shift (extrapolating a
// stretch is unreliable: an unmeasured 650 mm step may have shrunk to 50 mm). → room (same object when
// unchanged)
function followCorners(room, nodeMap) {
  const ids = Array.isArray(room.nodeIds) && room.nodeIds.length === room.polygon.length ? room.nodeIds : null;
  if (!ids) return room;
  const pts = room.polygon.map((p, k) => {
    const n = nodeMap.get(ids[k]);
    return { old: p, now: n ? { x: n.x, y: n.y } : null };
  });
  const ok = pts.filter((p) => p.now);
  if (!ok.length) return room;
  const axisValue = (axis, v) => {
    const same = ok.find((p) => Math.abs(p.old[axis] - v) < 0.5);
    if (same) return same.now[axis];
    const lo = ok.reduce((a, p) => (p.old[axis] < a.old[axis] ? p : a)), hi = ok.reduce((a, p) => (p.old[axis] > a.old[axis] ? p : a));
    if (hi.old[axis] - lo.old[axis] > 1 && v > lo.old[axis] && v < hi.old[axis]) {
      const t = (v - lo.old[axis]) / (hi.old[axis] - lo.old[axis]);
      return lo.now[axis] + t * (hi.now[axis] - lo.now[axis]);
    }
    return v + ok.reduce((s, p) => s + p.now[axis] - p.old[axis], 0) / ok.length;
  };
  let changed = false;
  const polygon = pts.map((p) => {
    const q = p.now || { x: axisValue('x', p.old.x), y: axisValue('y', p.old.y) };
    const r = { x: round2(q.x), y: round2(q.y) };
    if (r.x !== p.old.x || r.y !== p.old.y) changed = true;
    return r;
  });
  return changed ? { ...room, polygon } : room;
}

// Store the anchor (corner positions + face normal) on every attached measure (see cleanAnchor).
function refreshAnchors(measures, dRooms, spans, nodeMap) {
  const byRoom = new Map(dRooms.map((dr) => [dr.roomId, dr]));
  const spanNormal = new Map(spans.map((s) => [s.measureId, s.normal]));
  return measures.map((m) => {
    let n = spanNormal.get(m.id) || null;
    if (!n) {
      const dr = byRoom.get(m.room);
      const side = dr && dr.sides.find((s) => s.key === sideKeyOf(m));
      n = side ? side.inwardNormal : null;
    }
    const A = nodeMap.get(m.from), B = nodeMap.get(m.to);
    if (!n || !A || !B) return m;
    const at = { ax: round2(A.x), ay: round2(A.y), bx: round2(B.x), by: round2(B.y), nx: round2(n.x), ny: round2(n.y) };
    const old = m.at;
    if (old && ['ax', 'ay', 'bx', 'by', 'nx', 'ny'].every((k) => old[k] === at[k])) return m;
    return { ...m, at };
  });
}

// derived.spans → the solver's span map (Map measureId → [{ roomId, i }]) on the same rooms.
function spanIndexMap(spans) {
  const map = new Map();
  for (const sp of spans || []) map.set(sp.measureId, sp.parts.map((p) => ({ roomId: p.roomId, i: p.sideIndex })));
  return map;
}

// extra: { edgeFaces, spans, computedMeasures } (DESIGN.md §7.7), folds (foldsOf), outliers (outlierWarnings)
function computeWarnings(project, dRooms, sol, extra = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(project.settings || {}) };
  const edgeMap = new Map(project.edges.map((e) => [e.id, e]));
  const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));
  const byRoom = new Map(dRooms.map((dr) => [dr.roomId, dr]));
  const warnings = [];
  const valid = (project.measures || []).filter((m) => isNum(m.value) && m.value > 0 && byRoom.has(m.room));
  const measuredKeys = new Map(); // roomId → Set of side keys
  for (const m of valid) {
    if (!measuredKeys.has(m.room)) measuredKeys.set(m.room, new Set());
    measuredKeys.get(m.room).add(sideKeyOf(m));
  }

  // Unmeasured: a side whose extent is not given by a measure of this side or of a parallel side of the
  // same room spanning the same coordinates (a rectangle needs only two measures). A side with a
  // computed value (a part of a span, §7.7) has a value. Rooms joined by 구역 나누기 dividers are one
  // space for this: a measured side of one part also covers the parallel side of the other part.
  const span = (side) => {
    const axis = side.orient === 'h' ? 'x' : 'y';
    const a = nodeMap.get(side.from)[axis], b = nodeMap.get(side.to)[axis];
    return [Math.min(a, b), Math.max(a, b)];
  };
  const computedKeys = new Set((extra.computedMeasures || []).map((c) => `${c.room}|${sideKeyOf(c)}`));
  const group = new Map(); // roomId → root roomId (rooms joined by dividers)
  const root = (id) => { let r = id; while (group.has(r) && group.get(r) !== r) r = group.get(r); return r; };
  if (extra.edgeFaces) {
    const roomOfFace = new Map(dRooms.map((dr) => [dr.faceIndex, dr.roomId]));
    for (const e of project.edges) {
      if (e.kind !== 'divider') continue;
      const pair = extra.edgeFaces.get(e.id);
      if (!pair || pair[0] == null || pair[1] == null) continue;
      const a = root(roomOfFace.get(pair[0])), b = root(roomOfFace.get(pair[1]));
      if (a && b && a !== b) group.set(a, b);
    }
  }
  const covering = new Map(); // group root → [{ orient, lo, hi }]
  const addCover = (roomId, orient, lo, hi) => {
    const r = root(roomId);
    if (!covering.has(r)) covering.set(r, []);
    covering.get(r).push({ orient, lo, hi });
  };
  for (const dr of dRooms) {
    const keys = measuredKeys.get(dr.roomId) || new Set();
    for (const s of dr.sides) {
      if (s.orient === 'd' || !(keys.has(s.key) || computedKeys.has(`${dr.roomId}|${s.key}`))) continue;
      const [lo, hi] = span(s);
      addCover(dr.roomId, s.orient, lo, hi);
    }
  }
  for (const sp of extra.spans || []) {
    if (!(isNum(sp.value) && sp.value > 0) || sp.orient === 'd') continue;
    const axis = sp.orient === 'h' ? 'x' : 'y';
    const a = nodeMap.get(sp.from)[axis], b = nodeMap.get(sp.to)[axis];
    addCover(sp.roomId, sp.orient, Math.min(a, b), Math.max(a, b));
  }
  for (const dr of dRooms) {
    if (dr.room && dr.room.notRoom) continue;
    const keys = measuredKeys.get(dr.roomId) || new Set();
    const cover = covering.get(root(dr.roomId)) || [];
    for (const s of dr.sides) {
      if (keys.has(s.key) || s.allDivider || computedKeys.has(`${dr.roomId}|${s.key}`)) continue;
      let covered = false;
      if (s.orient !== 'd') {
        const [lo, hi] = span(s);
        covered = cover.some((t) => t.orient === s.orient && Math.abs(lo - t.lo) < 0.5 && Math.abs(hi - t.hi) < 0.5);
      }
      if (!covered) warnings.push({ type: 'unmeasured', roomId: dr.roomId, sideKey: s.key });
    }
  }

  // Two-sided: the same side measured from the rooms on both faces of the wall.
  const twoSidePairs = [];
  const byKey = new Map();
  for (const m of valid) {
    const key = sideKeyOf(m);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  // The two faces of a DIAGONAL wall have different lengths wherever its corners are not alike (the
  // face in an acute corner is shorter than the one across it): there what counts is how much more the
  // two values differ than the two drawn faces do (`excess`, = the difference of their residuals).
  const isDiagonal = (m) => {
    const dr = byRoom.get(m.room);
    const s = dr && dr.sides.find((x) => x.key === sideKeyOf(m));
    return !!s && s.orient === 'd';
  };
  const residualOf = (m) => {
    const r = sol.measureResiduals && sol.measureResiduals.get(m.id);
    return isNum(r) ? r : null;
  };
  // An h / v side one of whose corners in its room is a diagonal wall's (fixer 2026-10-20, field: the wall
  // between a corner-to-corner triangle and the room beside it: the triangle's face ends where the
  // diagonal meets it, 3024, the other face at the floor's wall, 3075): its two faces differ by the
  // geometry, `faceGap` (the faces' inner lengths with the assumed walls and no finish, as drawn now), and
  // what counts is how much more the values differ: excess = |(value a − value b) − (face a − face b)|.
  const sideOfMeasure = (m) => {
    const dr = byRoom.get(m.room);
    const i = dr ? dr.sides.findIndex((x) => x.key === sideKeyOf(m)) : -1;
    return i < 0 ? null : { dr, i };
  };
  const touchesDiagonal = (m) => {
    const at = sideOfMeasure(m);
    if (!at) return false;
    const n = at.dr.sides.length;
    return at.dr.sides[(at.i + n - 1) % n].orient === 'd' || at.dr.sides[(at.i + 1) % n].orient === 'd';
  };
  let priorT = null;
  const faceLength = (m) => {
    const at = sideOfMeasure(m);
    if (!at) return NaN;
    priorT = priorT || thicknessPriors(project, dRooms);
    return innerLengthOf(at.dr.sides, at.i, m.room, edgeMap, nodeMap, priorT, null);
  };
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].room === list[j].room) continue;
        const diff = Math.abs(list[i].value - list[j].value);
        const ids = [list[i].id, list[j].id];
        if (isDiagonal(list[i])) {
          const ri = residualOf(list[i]), rj = residualOf(list[j]);
          const excess = ri != null && rj != null ? Math.abs(ri - rj) : diff;
          twoSidePairs.push({ measureIds: ids, rooms: [list[i].room, list[j].room], diff, diagonal: true, excess });
          if (excess > settings.twoSideTolerance) warnings.push({ type: 'twoSide', measureIds: ids, diff: excess, diagonal: true });
          continue;
        }
        if (touchesDiagonal(list[i]) || touchesDiagonal(list[j])) {
          const gap = faceLength(list[i]) - faceLength(list[j]);
          if (isNum(gap) && Math.abs(gap) >= FACE_GAP_MM) {
            const excess = Math.abs(list[i].value - list[j].value - gap);
            twoSidePairs.push({ measureIds: ids, rooms: [list[i].room, list[j].room], diff, faces: true, faceGap: Math.abs(gap), excess });
            if (excess > settings.twoSideTolerance) warnings.push({ type: 'twoSide', measureIds: ids, diff: excess, faces: true });
            continue;
          }
        }
        twoSidePairs.push({ measureIds: ids, rooms: [list[i].room, list[j].room], diff });
        if (diff > settings.twoSideTolerance) warnings.push({ type: 'twoSide', measureIds: ids, diff });
      }
    }
  }

  // Absorbed: the assumed walls had to change a lot to fit this measure.
  for (const m of valid) {
    const a = sol.absorbed.get(m.id);
    if (a != null && a > settings.closureTolerance) warnings.push({ type: 'absorbed', measureId: m.id, amount: a });
  }

  // Residual: the drawn inner length does not equal the measured value (plan §5-1 "잰 값은 그대로
  // 지킵니다"). This happens when measures contradict each other in a way no assumed wall can absorb
  // (opposite sides of a rectangle, an L-room's long side against its parts), and for measured diagonal
  // sides that the axis values already fix (checks only, solver.js contract C2). check = true above
  // closureTolerance (확인필요); for such a diagonal check above DIAGONAL_TOLERANCE_MM (nothing absorbs
  // it). A diagonal with rows of its own is a value like any other (closureTolerance).
  const diagRows = sol.diagonalRows || new Map();
  for (const m of valid) {
    const r = sol.measureResiduals && sol.measureResiduals.get(m.id);
    if (r == null || !isFinite(r) || Math.abs(r) <= RESIDUAL_TOLERANCE_MM) continue;
    const dg = diagRows.get(m.id);
    const checkOnly = !!dg && !dg.rows;
    const tol = checkOnly ? Math.min(settings.closureTolerance, DIAGONAL_TOLERANCE_MM) : settings.closureTolerance;
    warnings.push({
      type: 'residual', measureId: m.id, amount: Math.abs(r), drawn: m.value + r,
      check: Math.abs(r) > tol,
      ...(dg ? { diagonal: checkOnly ? 'check' : 'rows' } : {}),
    });
  }

  // Conflict (extension of the stage A list): the measures contradict the drawn layout so much that a
  // wall segment would have folded over; the walls and values absorbed `amount` mm instead. Only what
  // the measures, walls and finishes really had to give counts (solver.js; contract C3): an edge held
  // in drawn order while only unmeasured corners moved is a 'gapPlaced' below.
  for (const c of sol.conflicts || []) {
    if (c.amount > settings.closureTolerance) warnings.push({ type: 'conflict', edgeId: c.edgeId, amount: c.amount });
  }
  // Fold (contract C1): the values reverse the drawn order of walls, or made walls cross or overlap
  // (derive → foldsOf). measureIds: the values most likely responsible; edgeIds: the walls concerned.
  for (const f of extra.folds || []) warnings.push({ type: 'fold', measureIds: f.measureIds, edgeIds: f.edgeIds });
  // Gap (contract C3, info): an unmeasured stretch the drawn order placed (its edge kept at the order
  // minimum). groupFrom / groupTo: the corners on the coordinate lines at the edge's ends a / b.
  for (const g of sol.gaps || []) {
    warnings.push({ type: 'gapPlaced', edgeId: g.edgeId, axis: g.axis, groupFrom: g.nodesA, groupTo: g.nodesB, length: g.length });
  }
  // Opening fit (contract C2, info): a wall piece no value fixes was lengthened for a typed width.
  for (const o of sol.openingFits || []) {
    warnings.push({ type: 'openingFit', openingId: o.openingId, edgeId: o.edgeId, amount: o.amount });
  }

  // Outlier (다시 확인): outlierWarnings, computed first in derive (a fold names an outlier value first).
  warnings.push(...(extra.outliers || []));
  return { warnings, twoSidePairs };
}

// → [{ type: 'outlier', measureId } | { type: 'outlierPair', measureIds: [a, b] }] (spans: derived.spans)
function outlierWarnings(project, dRooms, spans) {
  const edgeMap = new Map(project.edges.map((e) => [e.id, e]));
  const byRoom = new Map(dRooms.map((dr) => [dr.roomId, dr]));
  const valid = (project.measures || []).filter((m) => isNum(m.value) && m.value > 0 && byRoom.has(m.room));
  const out = [];
  // Outlier: a value about ten times off what the other values and the drawing predict (a missing or
  // extra zero). A ×10 slip is far outside OUTLIER_FACTOR, a room drawn 2–2.5× out of proportion is
  // not (예시 세대 A test 2026-10-18: the earlier 0.4× / 2.5× flagged correct values of such rooms), and a
  // short side needs OUTLIER_MIN_MM besides (a 400 notch drawn 150 long is the drawing).
  //   3 or more values: each against the median ratio of ALL of them (with only the others, two correct
  //     values and a wrong one gave the mean of a correct and a wrong ratio, and flagged a correct one);
  //   2 values that disagree: the drawing itself (drawn in mm, roughly to scale) decides which one is
  //     off when exactly one is far from it; otherwise one 'outlierPair' names both, neutrally.
  // Measured diagonal sides take part like any other value (2026-10-19: a diagonal with a missing zero
  // may set a wall's length now); their ratio is value / drawn length too, so a 1414 among 3000s is fine.
  const priors = thicknessPriors(project, dRooms);
  const ratios = scaleRatios(project, dRooms, priors, spanIndexMap(spans), { diagonals: 'include' });
  const sideIndexOf = (m) => {
    const dr = byRoom.get(m.room);
    return dr ? dr.sides.findIndex((s) => s.key === sideKeyOf(m)) : -1;
  };
  const rated = valid.filter((m) => ratios.has(m.id) && sideIndexOf(m) >= 0);
  const offAt = (m, scale, factor) => {
    if (!(scale > 0)) return false;
    const expected = sketchInnerLength(byRoom.get(m.room).sides, sideIndexOf(m), edgeMap, priors, scale);
    return expected > 0 && (m.value < expected / factor || m.value > expected * factor)
      && Math.abs(m.value - expected) > OUTLIER_MIN_MM;
  };
  if (ratios.size >= 3) {
    const ref = median([...ratios.values()]);
    for (const m of rated) if (offAt(m, ref, OUTLIER_FACTOR)) out.push({ type: 'outlier', measureId: m.id });
  } else if (ratios.size === 2 && rated.length === 2) {
    const [a, b] = rated;
    if (offAt(a, ratios.get(b.id), OUTLIER_FACTOR) || offAt(b, ratios.get(a.id), OUTLIER_FACTOR)) {
      const offA = offAt(a, 1, DRAWN_FACTOR), offB = offAt(b, 1, DRAWN_FACTOR);
      if (offA !== offB) out.push({ type: 'outlier', measureId: offA ? a.id : b.id });
      else out.push({ type: 'outlierPair', measureIds: [a.id, b.id] });
    }
  }
  return out;
}

// ---- store ---------------------------------------------------------------------------------------

export class DocStore {
  constructor(project) {
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this.lastDropped = [];
    // Measures that lost their side in the last command and are kept detached (DESIGN.md §7.7): they
    // come back by themselves when the side is drawn again.
    this.lastDetached = [];
    this.lastMoveProblem = null;
    this._pendingDropped = null;
    const r = derive(withoutRemovedFields(project || createProject()), null);
    this._state = { project: r.project, derived: r.derived };
  }

  get project() { return this._state.project; }
  get derived() { return this._state.derived; }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(change) {
    for (const fn of [...this._listeners]) {
      try { fn(this, change); } catch (err) { console.error('[model] listener failed', err); }
    }
  }

  // Run one command: build the next project, re-derive, push one undo step, notify.
  // build(project) returns the next project, or null/undefined for "nothing to do".
  // A build may leave measures it removed itself in this._pendingDropped (deleteEdge: the deleted wall's
  // own values); they are reported in lastDropped with the ones the re-derive could not keep.
  _commit(type, build, { rederive = true, detail = {} } = {}) {
    const before = this._state;
    this._pendingDropped = null;
    const next = build(before.project);
    const ownDropped = this._pendingDropped || [];
    this._pendingDropped = null;
    if (!next || next === before.project) return false;
    // A typed window / door width bounds its wall piece once values exist (solver.js, contract C2):
    // placing, moving, resizing or deleting such an opening then re-derives, although the opening
    // commands do not ask for it (without values the solve ignores the widths, nothing to redo).
    if (!rederive && hasValues(next) && openingBoundsKey(before.project) !== openingBoundsKey(next)) rederive = true;
    const touched = { ...next, modifiedAt: nowIso() };
    const prevProject = before.project;
    const prevDerived = before.derived;
    let state, dropped = ownDropped, detached = [];
    if (rederive) {
      const r = derive(touched, prevDerived, { reuseFaces: true, prevProject: before.project });
      state = { project: runDeriveHooks(prevProject, r.project, r.derived, prevDerived), derived: r.derived };
      dropped = ownDropped.concat(r.dropped);
      detached = r.detachedNow;
    } else {
      state = { project: touched, derived: before.derived };
    }
    // Windows and doors follow wall splits, merges and deletions. Exactly once per commit (the
    // reconcile is not idempotent); undo/redo/replaceProject restore consistent snapshots instead.
    state = { ...state, project: reconcileOpenings(prevProject, state.project, prevDerived) };
    this._undo.push(before);
    if (this._undo.length > UNDO_LIMIT) this._undo.splice(0, this._undo.length - UNDO_LIMIT);
    this._redo = [];
    this._state = state;
    this.lastDropped = dropped;
    this.lastDetached = detached;
    this._notify({ type, dropped, detached, roomChanges: state.derived.roomChanges, ...detail });
    return true;
  }

  // Replace the current state without a new undo step (second half of a compound command).
  // opts.rederive = false: the build changes nothing the geometry depends on (e.g. it only records the
  // raw input of a stroke); the derived data is kept as it is.
  _amend(type, build, { rederive = true } = {}) {
    const next = build(this._state.project);
    if (!next) return;
    const prev = this._state;
    if (!rederive) {
      this._state = { project: { ...next, modifiedAt: nowIso() }, derived: prev.derived };
      this._notify({ type, dropped: [], detached: [], roomChanges: prev.derived.roomChanges });
      return;
    }
    const r = derive({ ...next, modifiedAt: nowIso() }, prev.derived, { reuseFaces: true, prevProject: prev.project });
    const project = reconcileOpenings(prev.project, runDeriveHooks(prev.project, r.project, r.derived, prev.derived), prev.derived);
    this._state = { project, derived: r.derived };
    this.lastDropped = this.lastDropped.concat(r.dropped);
    this.lastDetached = (this.lastDetached || []).concat(r.detachedNow);
    this._notify({ type, dropped: r.dropped, detached: r.detachedNow, roomChanges: r.derived.roomChanges });
  }

  // Re-derive after the whole plan moved rigidly (core/rotate.js 도면 돌리기): against movedPrev (the old
  // room outlines moved the same way; null = match by the seeds only); the hooks and the opening
  // reconcile compare against the moved project itself, so nothing "follows" the old positions; and the
  // solved plan stays where the move put its corners (derive holdPlace). prevProject: the project before
  // the move. → { project, derived, dropped, detached }
  _deriveMoved(project, movedPrev, prevProject) {
    const r = derive(project, movedPrev, { reuseFaces: false, prevProject, holdPlace: true });
    const hooked = runDeriveHooks(project, r.project, r.derived, null);
    return { project: reconcileOpenings(project, hooked, null), derived: r.derived, dropped: r.dropped, detached: r.detachedNow };
  }

  // Put a whole new state in place WITHOUT an undo step and without touching the history (core/rotate.js:
  // a turn of the plan is not an edit, and rotate.js turns the history itself). The document did change
  // (modifiedAt: autosave, the list badge). state: { project, derived }
  _replaceState(type, state, { dropped = [], detached = [], detail = {} } = {}) {
    this._state = { project: { ...state.project, modifiedAt: nowIso() }, derived: state.derived };
    this.lastDropped = dropped;
    this.lastDetached = detached;
    this._notify({ type, dropped, detached, roomChanges: state.derived.roomChanges, ...detail });
  }

  // A snapshot of the history as the plan is now: core/rotate.js turns the history lazily (a snapshot
  // keeps the turns it still owes, `turns`, and _applyTurns makes them). → { project, derived }
  _settled(s) {
    return s && Array.isArray(s.turns) && s.turns.length && typeof this._applyTurns === 'function' ? this._applyTurns(s) : s;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }
  // Undo/redo restore a whole snapshot but stamp a fresh modifiedAt: the document changed now, so it
  // differs from the last export (list badge "마지막 내보내기 이후 수정됨", import "which is newer").
  // A snapshot taken before a turn of the plan is turned first (_settled): ↶ / ↷ never turn the plan.
  undo() {
    if (!this._undo.length) return false;
    const next = this._settled(this._undo[this._undo.length - 1]);
    this._undo.pop();
    this._redo.push(this._state);
    this._state = restamp(next);
    this.lastDropped = [];
    this.lastDetached = [];
    this._notify({ type: 'undo' });
    return true;
  }
  redo() {
    if (!this._redo.length) return false;
    const next = this._settled(this._redo[this._redo.length - 1]);
    this._redo.pop();
    this._undo.push(this._state);
    this._state = restamp(next);
    this.lastDropped = [];
    this.lastDetached = [];
    this._notify({ type: 'redo' });
    return true;
  }

  // ---- geometry commands ----

  // Straighten a stroke and add its walls. opts: { allowDiagonal = 'auto', snapMM = 200, cornerTolerance }
  // allowDiagonal 'auto' (the default since 2026-10-19): a clearly slanted stroke piece becomes a diagonal
  // wall at its drawn angle (sketch.js AUTO_DIAGONAL); true: every piece off the 20° axis snap (the wall
  // tool with the pen held or Shift); false: never.
  // The first / last straight line runs through the corner or wall the pen started / ended on (ht #14:
  // a long wall started at a corner and drifting a few degrees otherwise left that corner). After the walls
  // are in, loose ends around them are joined in the same undo step (graph.joinStrokeEnds, ht #12 / #13):
  // an older wall end that stops short of or runs past a new wall, corners stopped short or drawn past,
  // and short pieces drawn past a wall.
  // A stroke shorter than straightenStroke keeps (1.5 × snap) is still one straight wall when its ends land on
  // two different walls or corners across it, or when it is at least opts.shortMin long (default 0.75 × snap)
  // with an end in the open (graph.shortStroke; far zoom: 예시 세대 A's 550 mm 베란다1 step at snap 380–600). The
  // UI passes a longer shortMin for a finger, whose tap may slide.
  addStroke(worldPoints, { allowDiagonal = 'auto', snapMM = 200, cornerTolerance, shortMin } = {}) {
    const opts = { cornerTolerance: cornerTolerance > 0 ? cornerTolerance : snapMM * 0.5, allowDiagonal };
    let segs = straightenStroke(worldPoints, opts);
    const edgeIds = [];
    // A straight stroke the axis snap made h / v, between two corners or loose ends no h / v wall can join
    // (corner to corner in a flat room, an open corner closed at 25°): the diagonal between them
    // (graph.cornerDiagonal). Not with allowDiagonal false.
    const between = allowDiagonal !== false && segs.length === 1
      ? cornerDiagonal(this.project, worldPoints, { snap: snapMM, orient: segs[0].orient })
      : null;
    if (between) {
      segs = [between];
    } else if (!segs.length) {
      const short = { snap: snapMM, allowDiagonal };
      if (shortMin > 0) short.minFree = shortMin;
      const one = shortStroke(this.project, worldPoints, short);
      if (!one) return { edgeIds };
      segs = [one];
    } else {
      // Where the raw first / last pen points snap (by the same rule as the wall ends), for the orientation
      // of the line each starts or ends: a corner fixes the line, a wall along it its coordinate. A
      // diagonal piece at an end of a stroke of several pieces is a foot (graph FOOT_NODE: a bay's foot
      // stays where its line crosses the wall, not at the next room's corner).
      let pts = (worldPoints || []).filter((pt) => pt && isFinite(pt.x) && isFinite(pt.y));
      const several = segs.length > 1;
      const snapAt = (pt, seg, side) => snapPoint(this.project, pt, snapMM, seg.orient,
        several && seg.orient === 'd' ? { foot: { through: side === 'start' ? seg.q : seg.p } } : {});
      const anchorOf = (s) => {
        if (s.type === 'node') return { x: s.point.x, y: s.point.y, fixX: true, fixY: true, dist: s.dist };
        if (s.type === 'edge' && (s.edgeOrient === 'h' || s.edgeOrient === 'v')) {
          return { x: s.point.x, y: s.point.y, fixX: s.edgeOrient === 'v', fixY: s.edgeOrient === 'h', dist: s.dist };
        }
        return null;
      };
      const snapStart = snapAt(pts[0], segs[0], 'start');
      const snapEnd = snapAt(pts[pts.length - 1], segs[segs.length - 1], 'end');
      let anchorStart = anchorOf(snapStart);
      let anchorEnd = anchorOf(snapEnd);
      // One diagonal with one end at a corner and the other on a wall of that same corner would run
      // along that wall: it is a cut across the corner, drawn close to it (fixer 2026-10-20: a 26 × 19
      // px cut with the pen 9 px past both walls drew nothing). No corner anchor then; addSegment puts
      // both ends where its line crosses the two walls.
      const cut = new Set();
      if (!several && segs[0].orient === 'd') {
        const ownWall = (corner, other) => corner.type === 'node' && other.type === 'edge'
          && this.project.edges.some((e) => e.id === other.edgeId && (e.a === corner.nodeId || e.b === corner.nodeId));
        if (ownWall(snapStart, snapEnd)) { anchorStart = null; cut.add('start'); }
        if (ownWall(snapEnd, snapStart)) { anchorEnd = null; cut.add('end'); }
      }
      // A diagonal drawn on past the corner it was aimed at (its end too far beyond to snap) ends at that
      // corner; the pen points beyond it are dropped (graph.passedCorner). Not a foot on a wall.
      for (const side of ['start', 'end']) {
        const seg = side === 'start' ? segs[0] : segs[segs.length - 1];
        if (seg.orient !== 'd' || (side === 'start' ? anchorStart : anchorEnd)) continue;
        if (cut.has(side) || (several && (side === 'start' ? snapStart : snapEnd).type === 'edge')) continue;
        const pass = passedCorner(this.project, pts, snapMM, side);
        if (!pass) continue;
        pts = pass.points;
        const a = { x: pass.node.x, y: pass.node.y, fixX: true, fixY: true, dist: pass.dist };
        if (side === 'start') anchorStart = a; else anchorEnd = a;
      }
      if (anchorStart || anchorEnd) {
        // An anchor may not cost the stroke a piece or turn one around (fixer 2026-10-20: a bay whose two
        // feet went to the corners beside it ran its first diagonal past the second, its front piece
        // reversed, and the bay became a triangle). Then the h / v anchors only, else none.
        const keeps = (out) => out.length === segs.length && out.every((sg, k) => sg.orient === segs[k].orient
          && (sg.q.x - sg.p.x) * (segs[k].q.x - segs[k].p.x) + (sg.q.y - sg.p.y) * (segs[k].q.y - segs[k].p.y) > 0);
        const corner = (a, seg) => (a && seg.orient === 'd' && a.fixX && a.fixY ? null : a);
        for (const [s0, s1] of [[anchorStart, anchorEnd], [corner(anchorStart, segs[0]), corner(anchorEnd, segs[segs.length - 1])]]) {
          if (!s0 && !s1) break;
          const again = straightenStroke(pts, { ...opts, anchorStart: s0, anchorEnd: s1 });
          if (again.length && (!several || !segs.some((sg) => sg.orient === 'd') || keeps(again))) { segs = again; break; }
        }
      }
    }
    const open = segs.length > 1 && Math.hypot(segs[0].p.x - segs[segs.length - 1].q.x, segs[0].p.y - segs[segs.length - 1].q.y) > 1e-6;
    this._commit('addStroke', (p) => {
      let doc = p;
      let first = null, last = null;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const feet = open && s.orient === 'd' ? [k === 0, k === segs.length - 1] : null;
        const r = addSegment(doc, s.p, s.q, { orient: s.orient, kind: 'wall', snap: snapMM, sketchScale: p.sketchScale, feet });
        doc = withSplits(r.doc, r.splits, edgeIds);
        edgeIds.push(...r.edgeIds);
        if (r.ends.length) {
          if (first == null) first = r.ends[0];
          last = r.ends[1];
        }
      }
      if (doc === p) return null;
      const t = joinStrokeEnds(doc, { edgeIds, ends: [first, last], before: p, snap: snapMM, kind: 'wall', sketchScale: p.sketchScale });
      edgeIds.splice(0, edgeIds.length, ...t.edgeIds);
      return withSplits(t.doc, t.splits, null);
    });
    return { edgeIds: [...new Set(edgeIds)].filter((id) => this.project.edges.some((e) => e.id === id)) };
  }

  // Rectangle room: four walls (sides near existing parallel walls snap onto them).
  // opts.measure stores the requested sizes as measured inner lengths of the new room, in the same undo
  // step: true = both, or { w: bool, h: bool } for one of them (w on the top side, h on the left side).
  // The stored values are |w| and |h| as given (what the user typed), not the snapped wall distance;
  // the solver then moves the walls to fit them. → { roomId }
  addRectRoom(x, y, w, h, { snapMM = 200, measure = false } = {}) {
    const measureW = measure === true || !!(measure && measure.w);
    const measureH = measure === true || !!(measure && measure.h);
    const typedW = Math.abs(w), typedH = Math.abs(h);
    let x0 = Math.min(x, x + w), x1 = Math.max(x, x + w);
    let y0 = Math.min(y, y + h), y1 = Math.max(y, y + h);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { roomId: null };
    const snapLine = (orient, value, lo, hi) => snapToParallelWall(this.project, orient, value, lo, hi, snapMM);
    y0 = snapLine('h', y0, x0, x1); y1 = snapLine('h', y1, x0, x1);
    x0 = snapLine('v', x0, y0, y1); x1 = snapLine('v', x1, y0, y1);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { roomId: null };
    let topEdge = null;
    const ok = this._commit('addRectRoom', (p) => {
      let doc = p;
      const segs = [
        [{ x: x0, y: y0 }, { x: x1, y: y0 }, 'h'],
        [{ x: x1, y: y0 }, { x: x1, y: y1 }, 'v'],
        [{ x: x1, y: y1 }, { x: x0, y: y1 }, 'h'],
        [{ x: x0, y: y1 }, { x: x0, y: y0 }, 'v'],
      ];
      const ids = [];
      for (const [a, b, orient] of segs) {
        const r = addSegment(doc, a, b, { orient, kind: 'wall', snap: snapMM, sketchScale: p.sketchScale });
        doc = withSplits(r.doc, r.splits, ids);
        if (!topEdge && r.edgeIds.length) topEdge = r.edgeIds[0];
        ids.push(...r.edgeIds);
      }
      return doc === p ? null : doc;
    });
    if (!ok || !topEdge) return { roomId: null };
    const roomId = this._roomBelowEdge(topEdge);
    if (roomId && (measureW || measureH)) {
      const dr = this.derived.rooms.find((r) => r.roomId === roomId);
      const top = dr && dr.sides.find((s) => s.edgeIds.includes(topEdge));
      const left = dr && dr.sides.find((s) => s.orient === 'v' && s.inwardNormal.x > 0);
      this._amend('addRectRoom', (p) => {
        let measures = p.measures.slice();
        if (top && measureW) measures = upsertMeasure(measures, roomId, top, typedW, [typedW], p);
        if (left && measureH) measures = upsertMeasure(measures, roomId, left, typedH, [typedH], p);
        return top || left ? { ...p, measures } : null;
      });
    }
    return { roomId };
  }

  // Room lying below a horizontal edge (south of it), from the solved geometry.
  _roomBelowEdge(edgeId) {
    const e = this.project.edges.find((x) => x.id === edgeId);
    if (!e) return null;
    const pair = this.derived.edgeFaces.get(edgeId);
    const A = this.project.nodes.find((n) => n.id === e.a), B = this.project.nodes.find((n) => n.id === e.b);
    if (!pair || !A || !B) return null;
    const fi = A.x < B.x ? pair[1] : pair[0];
    const dr = this.derived.rooms.find((r) => r.faceIndex === fi);
    return dr ? dr.roomId : null;
  }

  // Divider (구역 나누기 선, formerly 실 나누기) from p to q. → { edgeIds }
  // A stroke drawn past an outer wall (further than the snap distance) leaves a loose end outside the
  // house; such new divider pieces outside every room are removed (they divide nothing and would print
  // as a dashed stub sticking out of the plan).
  // Loose ends around the new divider are joined as after a wall stroke (graph.joinStrokeEnds), except
  // that a divider never moves a wall: a wall end near a divider is waiting for its own wall.
  addDivider(p, q, { snapMM = 200 } = {}) {
    const { orient } = classifyDirection({ x: q.x - p.x, y: q.y - p.y }, true);
    let edgeIds = [];
    this._commit('addDivider', (proj) => {
      const r = addSegment(proj, p, q, { orient, kind: 'divider', snap: snapMM, sketchScale: proj.sketchScale });
      if (r.doc === proj) return null;
      const before = new Set(proj.edges.map((e) => e.id));
      const t = joinStrokeEnds(withSplits(r.doc, r.splits, null), {
        edgeIds: r.edgeIds, ends: r.ends, before: proj, snap: snapMM, kind: 'divider', sketchScale: proj.sketchScale,
      });
      const fresh = t.edgeIds.filter((id) => !before.has(id));
      const doc = trimOutsideDividers(withSplits(t.doc, t.splits, null), new Set(fresh));
      const kept = new Set(doc.edges.map((e) => e.id));
      edgeIds = t.edgeIds.filter((id) => kept.has(id));
      return edgeIds.some((id) => !before.has(id)) || doc.edges.length !== proj.edges.length ? doc : null;
    });
    return { edgeIds };
  }

  // Delete a wall or divider. Only the deleted wall's OWN values go (the measures of room sides that
  // contain it, on both faces, and spans with a part along it; reported in lastDropped). Every other
  // measure is kept: on its side if the side still exists, else detached until the side is drawn
  // again (DESIGN.md §7.7).
  deleteEdge(edgeId) {
    const own = new Set(sidesForEdge(this.derived, edgeId).map(({ roomId, side }) => `${roomId}|${side.key}`));
    for (const sp of this.derived.spans || []) {
      const hit = sp.parts.some((part) => {
        const dr = this._room(part.roomId);
        const side = dr && dr.sides[part.sideIndex];
        return side && side.edgeIds.includes(edgeId);
      });
      if (hit) own.add(`span|${sp.measureId}`);
    }
    return this._commit('deleteEdge', (p) => {
      if (!p.edges.some((e) => e.id === edgeId)) return null;
      // A wall left whole by the removal (a T's bar when its stem goes) keeps its 확인필요 flag and the
      // fixtures standing against it (erase.js carryMerged, checker 2026-10-22).
      const doc = carryMerged(p, removeEdge(p, edgeId), [edgeId]);
      const ids = new Set(doc.edges.map((e) => e.id));
      const isOwn = (m) => own.has(`${m.room}|${sideKeyOf(m)}`) || own.has(`span|${m.id}`);
      const measures = (doc.measures || []).filter((m) => !isOwn(m));
      // A value that is waiting (its room is open) and was taken along this very wall is the wall's own
      // value too: it goes with the wall instead of coming back when another wall is drawn there.
      const edge = p.edges.find((e) => e.id === edgeId);
      const nodeMap = new Map(p.nodes.map((n) => [n.id, n]));
      const ownWaiting = (m) => edge && detachedAlongEdge(m, nodeMap.get(edge.a), nodeMap.get(edge.b), nodeMap);
      const detachedMeasures = (doc.detachedMeasures || []).filter((m) => !ownWaiting(m));
      const gone = (doc.measures || []).filter(isOwn).concat((doc.detachedMeasures || []).filter(ownWaiting));
      if (gone.length) this._pendingDropped = gone;
      return { ...doc, measures, detachedMeasures, wallChecks: (doc.wallChecks || []).filter((w) => ids.has(w.edge)) };
    }, { detail: { edgeId } });
  }

  // Drag a corner. A loose wall end (one wall at it) dropped within opts.snapMM of a corner or a wall
  // joins it there (ht #12: such a drop was refused as a crossing, so a wall drawn short could only be
  // deleted and drawn again); the UI passes its snap distance. A move that would push a wall across or
  // onto another wall, or shrink a wall to nothing, is refused (returns false) and the reason is left in
  // `lastMoveProblem` ({ type: 'short' | 'cross' | 'overlap', edgeIds }) so the UI can explain it. → bool
  moveNode(nodeId, x, y, { snapMM = 200 } = {}) {
    this.lastMoveProblem = null;
    return this._commit('moveNode', (p) => {
      if (!p.nodes.some((n) => n.id === nodeId)) return null;
      const joined = dropLooseEnd(p, nodeId, x, y, { snap: snapMM, sketchScale: p.sketchScale });
      const next = joined || graphMoveNode(p, nodeId, x, y, { sketchScale: p.sketchScale });
      const before = new Map(p.nodes.map((n) => [n.id, n]));
      const edgesBefore = new Map(p.edges.map((e) => [e.id, e]));
      const moved = new Set(next.nodes.filter((n) => {
        const b = before.get(n.id);
        return !b || b.x !== n.x || b.y !== n.y;
      }).map((n) => n.id));
      // A joined end re-links its wall (and splits the wall it lands on): those edges are touched too.
      const touched = new Set(next.edges.filter((e) => {
        const b = edgesBefore.get(e.id);
        return !b || b.a !== e.a || b.b !== e.b || moved.has(e.a) || moved.has(e.b);
      }).map((e) => e.id));
      const problem = touched.size ? findPlanarityProblem(next, { onlyEdges: touched }) : null;
      if (problem) {
        this.lastMoveProblem = problem;
        return null;
      }
      return next;
    }, { detail: { nodeId } });
  }

  // ---- measures and attributes ----

  // value null clears the measure. parts: the '+'-separated parts as typed. → measure id | null
  setMeasure(roomId, sideKey, value, parts) {
    const side = this._side(roomId, sideKey);
    if (!side) return null;
    let id = null;
    this._commit('setMeasure', (p) => {
      if (value == null) {
        const measures = p.measures.filter((m) => !(m.room === roomId && sideKeyOf(m) === sideKey));
        return measures.length === p.measures.length ? null : { ...p, measures };
      }
      const v = Number(value);
      if (!(isFinite(v) && v > 0)) return null;
      const measures = upsertMeasure(p.measures, roomId, side, v, Array.isArray(parts) && parts.length ? parts.map(Number) : [v], p);
      id = measures.find((m) => m.room === roomId && sideKeyOf(m) === sideKey).id;
      return { ...p, measures };
    }, { detail: { roomId, sideKey } });
    return id;
  }

  // Change or clear (value null) one measure by its id — e.g. the measured value of a span across
  // 구역 나누기 dividers (derived.spans), which is no single room side. → bool
  setMeasureValue(measureId, value, parts) {
    return this._commit('setMeasure', (p) => {
      const i = p.measures.findIndex((m) => m.id === measureId);
      if (i < 0) return null;
      const measures = p.measures.slice();
      if (value == null) {
        if (measures[i].check) measures[i] = { ...measures[i], value: null, parts: [] };
        else measures.splice(i, 1);
        return { ...p, measures };
      }
      const v = Number(value);
      if (!(isFinite(v) && v > 0)) return null;
      measures[i] = { ...measures[i], value: v, parts: Array.isArray(parts) && parts.length ? parts.map(Number) : [v] };
      return { ...p, measures };
    }, { detail: { measureId } });
  }

  // 확인필요 on a side. A flag without a value is kept as a measure with value null.
  setMeasureCheck(roomId, sideKey, on) {
    const side = this._side(roomId, sideKey);
    if (!side) return false;
    return this._commit('setMeasureCheck', (p) => {
      const i = p.measures.findIndex((m) => m.room === roomId && sideKeyOf(m) === sideKey);
      const measures = p.measures.slice();
      if (i < 0) {
        if (!on) return null;
        measures.push({ id: nextMeasureId(p), room: roomId, from: side.from, to: side.to, value: null, parts: [], check: true });
      } else {
        if (!!measures[i].check === !!on) return null;
        if (!on && measures[i].value == null) measures.splice(i, 1);
        else measures[i] = { ...measures[i], check: !!on };
      }
      return { ...p, measures };
    }, { detail: { roomId, sideKey } });
  }

  setWallThickness(edgeId, mm) {
    return this._commit('setWallThickness', (p) => {
      const i = p.edges.findIndex((e) => e.id === edgeId);
      if (i < 0) return null;
      const t = mm == null ? null : Number(mm);
      if (t != null && !(isFinite(t) && t >= 0)) return null;
      const edges = p.edges.slice();
      edges[i] = { ...edges[i], thickness: t };
      return { ...p, edges };
    }, { detail: { edgeId } });
  }

  toggleWallCheck(edgeId) {
    return this._commit('toggleWallCheck', (p) => {
      if (!p.edges.some((e) => e.id === edgeId)) return null;
      const has = p.wallChecks.some((w) => w.edge === edgeId);
      const wallChecks = has ? p.wallChecks.filter((w) => w.edge !== edgeId) : [...p.wallChecks, { edge: edgeId, note: '' }];
      return { ...p, wallChecks };
    }, { detail: { edgeId } });
  }

  // patch: { name?, height?, notRoom? }
  setRoom(roomId, patch = {}) {
    return this.setRooms([{ id: roomId, patch }]);
  }

  // Extension: several room patches as ONE undo step, e.g. preset auto-numbering ("방" → "방1" and the
  // new "방2") or swapping two room numbers. updates: [{ id, patch }]. → bool
  setRooms(updates = []) {
    const list = (updates || []).filter((u) => u && u.id);
    return this._commit('setRoom', (p) => {
      let rooms = null;
      for (const { id, patch } of list) {
        const i = (rooms || p.rooms).findIndex((r) => r.id === id);
        if (i < 0) continue;
        if (!rooms) rooms = p.rooms.slice();
        rooms[i] = applyRoomPatch(rooms[i], patch || {});
      }
      return rooms ? { ...p, rooms } : null;
    }, { detail: { roomId: list.length ? list[0].id : null, roomIds: list.map((u) => u.id) } });
  }

  setInfo(partialInfo = {}) {
    return this._commit('setInfo', (p) => ({ ...p, info: { ...p.info, ...partialInfo } }), { rederive: false });
  }

  // Extension: change wall defaults / tolerances (re-derives).
  setSettings(partial = {}) {
    return this._commit('setSettings', (p) => ({ ...p, settings: { ...DEFAULT_SETTINGS, ...p.settings, ...partial } }));
  }

  // Load another project (e.g. after import). Clears undo history.
  replaceProject(project) {
    const r = derive(withoutRemovedFields(project), null);
    this._state = { project: r.project, derived: r.derived };
    this._undo = [];
    this._redo = [];
    this.lastDropped = r.dropped;
    this.lastDetached = r.detachedNow;
    this._notify({ type: 'replace', dropped: r.dropped, detached: r.detachedNow });
  }

  // ---- helpers for the UI ----

  _room(roomId) { return this.derived.rooms.find((r) => r.roomId === roomId) || null; }
  _side(roomId, sideKey) {
    const dr = this._room(roomId);
    return dr ? dr.sides.find((s) => s.key === sideKey) || null : null;
  }

  // Next side clockwise in the same room (wraps). → sideKey | null
  nextSide(roomId, sideKey) {
    const dr = this._room(roomId);
    if (!dr || !dr.sides.length) return null;
    const i = dr.sides.findIndex((s) => s.key === sideKey);
    return dr.sides[(i + 1) % dr.sides.length].key;
  }

  // Innermost room containing the point. → roomId | null
  roomAt(pt) {
    let best = null, bestArea = Infinity;
    for (const dr of this.derived.rooms) {
      if (dr.area < bestArea && pointInPolygon(pt, dr.face.points)) { best = dr.roomId; bestArea = dr.area; }
    }
    return best;
  }

  edgeAt(pt, maxDist = 300) {
    const r = nearestEdge(this.project, pt, maxDist);
    return r ? r.edgeId : null;
  }

  // → { side, measure | null, computed | null, span | null, currentInnerLength } | null
  //   measure: the side's own (real) measure; computed: its computed value when it is a part of a
  //   measured span (derived.computedMeasures, { value, computed: true, spanId, ... }); span: that span
  //   (derived.spans entry) when the side is one of its parts, measured or not (DESIGN.md §7.7)
  sideInfo(roomId, sideKey) {
    const dr = this._room(roomId);
    if (!dr) return null;
    const i = dr.sides.findIndex((s) => s.key === sideKey);
    if (i < 0) return null;
    const measure = this.project.measures.find((m) => m.room === roomId && sideKeyOf(m) === sideKey) || null;
    const computed = (this.derived.computedBySide && this.derived.computedBySide.get(`${roomId}|${sideKey}`)) || null;
    const span = (this.derived.spans || []).find((sp) => sp.parts.some((p) => p.roomId === roomId && p.sideKey === sideKey)) || null;
    const edgeMap = new Map(this.project.edges.map((e) => [e.id, e]));
    const positions = new Map(this.project.nodes.map((n) => [n.id, n]));
    const s = this.derived.solve;
    const currentInnerLength = innerLengthOf(dr.sides, i, roomId, edgeMap, positions, s.thickness, s.finish);
    return { side: dr.sides[i], measure, computed, span, currentInnerLength };
  }

  // Every value shown for a room side: its own measure, else its computed span part. → measure-like
  // object ({ value, computed?: true, ... }) | null
  sideValue(roomId, sideKey) {
    const m = this.project.measures.find((x) => x.room === roomId && sideKeyOf(x) === sideKey && isNum(x.value));
    if (m) return m;
    return (this.derived.computedBySide && this.derived.computedBySide.get(`${roomId}|${sideKey}`)) || null;
  }
}

// Hooks run after every re-derive: fn(prevProject, nextProject, nextDerived, prevDerived) → project (or null for
// "unchanged"). The fixtures package registers one that keeps wall-snapped fixtures on their walls.
DocStore.deriveHooks = [];

function runDeriveHooks(prevProject, nextProject, nextDerived, prevDerived = null) {
  let proj = nextProject;
  for (const h of DocStore.deriveHooks) {
    try {
      proj = h(prevProject, proj, nextDerived, prevDerived) || proj;
    } catch (err) {
      console.error('[model] derive hook failed', err);
    }
  }
  return proj;
}

// Store commands of the stage B/C packages (each is one undo step through _commit):
//   openings.js  addOpening, updateOpening, moveOpening, deleteOpening, cycleSwing, openingById
//   fixtures.js  addFixture, updateFixture, moveFixture, rotateFixture, deleteFixture, fixtureById
//   memo.js      addMemoStroke, deleteMemoStroke, clearMemo
//   dims.js      setDimOverride, setLabelOffset, resetOutputLayout
//   rotate.js    rotatePlan (도면 돌리기; NOT an undo step: it turns the history with the plan)
//   erase.js     eraseItems (지우개: walls, windows / doors, fixtures, memo in one undo step), lastErased
// The 확인 완료 commands (checks-full.js installChecks) are installed by main.js, because
// checks-full.js imports this module.
installOpenings(DocStore);
installFixtures(DocStore);
installMemo(DocStore);
installDims(DocStore);
installRotate(DocStore);
installErase(DocStore);

// ---- internal helpers ----------------------------------------------------------------------------

function applyRoomPatch(room, patch) {
  const r = { ...room };
  if ('name' in patch) r.name = String(patch.name == null ? '' : patch.name);
  if ('height' in patch) r.height = patch.height == null || patch.height === '' ? null : Number(patch.height);
  if ('notRoom' in patch) r.notRoom = !!patch.notRoom;
  return r;
}

// Recordings of the removed 현장 원본 feature (0.3.0–0.4.1; validateProject drops them from files):
// a household opened from this device's storage leaves them behind too, and the next save drops them.
function withoutRemovedFields(p) {
  if (!p || (!('fieldOriginal' in p) && !('fieldSketch' in p))) return p;
  const { fieldOriginal: _fo, fieldSketch: _fs, ...rest } = p;
  return rest;
}

function restamp(state) {
  return { ...state, project: { ...state.project, modifiedAt: nowIso() } };
}

const hasValues = (project) => ((project && project.measures) || []).some((m) => isNum(m.value) && m.value > 0);

// The windows / doors whose typed width bounds a wall piece in the solve (contract C2). → string
function openingBoundsKey(project) {
  return ((project && project.openings) || [])
    .filter((o) => o && isNum(o.width) && o.width > 0)
    .map((o) => `${o.id}:${o.edge}:${o.width}`).sort().join(',');
}

function upsertMeasure(measures, roomId, side, value, parts, project = null) {
  const i = measures.findIndex((m) => m.room === roomId && sideKeyOf(m) === side.key);
  const out = measures.slice();
  if (i >= 0) out[i] = { ...out[i], value, parts };
  else out.push({ id: nextMeasureId({ ...(project || {}), measures }), room: roomId, from: side.from, to: side.to, value, parts, check: false });
  return out;
}

// A new measure id, above every attached and detached measure (a detached one may come back).
function nextMeasureId(project) {
  return nextId('m', [...(project.measures || []), ...(project.detachedMeasures || [])]);
}

// Remove the new divider pieces (ids in `fresh`) that have a loose end and lie outside every room face,
// repeatedly (a long overshoot may be several pieces). → doc
function trimOutsideDividers(doc, fresh) {
  let out = doc;
  for (let round = 0; round < 8; round++) {
    const faces = findFaces(out);
    const nodes = new Map(out.nodes.map((n) => [n.id, n]));
    const degree = new Map();
    for (const e of out.edges) for (const id of [e.a, e.b]) degree.set(id, (degree.get(id) || 0) + 1);
    const loose = out.edges.find((e) => {
      if (!fresh.has(e.id) || e.kind !== 'divider') return false;
      if (degree.get(e.a) !== 1 && degree.get(e.b) !== 1) return false;
      const A = nodes.get(e.a), B = nodes.get(e.b);
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      return !faces.some((f) => pointInPolygon(mid, f.points));
    });
    if (!loose) break;
    out = removeEdge(out, loose.id);
  }
  return out;
}

// Carry 확인필요 flags over to the second half of split walls; extend an id list the same way.
function withSplits(doc, splits, idList) {
  if (!splits || !splits.length) return doc;
  let wallChecks = doc.wallChecks || [];
  for (const s of splits) {
    const w = wallChecks.find((x) => x.edge === s.from);
    if (w && !wallChecks.some((x) => x.edge === s.to)) wallChecks = [...wallChecks, { edge: s.to, note: w.note }];
    if (idList && idList.includes(s.from) && !idList.includes(s.to)) idList.push(s.to);
  }
  return { ...doc, wallChecks };
}

// Coordinate of the nearest parallel wall line within snapMM whose span overlaps [lo, hi]; else value.
function snapToParallelWall(project, orient, value, lo, hi, snapMM) {
  const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));
  const key = orient === 'h' ? 'y' : 'x', other = orient === 'h' ? 'x' : 'y';
  let best = value, bestD = snapMM;
  for (const e of project.edges) {
    if (e.orient !== orient) continue;
    const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
    const c = A[key];
    const s0 = Math.min(A[other], B[other]), s1 = Math.max(A[other], B[other]);
    if (s1 < lo || s0 > hi) continue;
    const d = Math.abs(c - value);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best;
}
