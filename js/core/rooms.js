// Rooms (DESIGN.md §3.4): room sides and stable room matching across edits.

import { EPS, pointInPolygon, poleOfInaccessibility } from './geom.js';
import { nextId } from './graph.js';

// Unit direction of edge e when walked from node `fromId`. h/v edges are exactly axis-aligned
// (the sign comes from the geometry, or from the sketch when the edge has zero length).
export function edgeDirection(e, fromId, nodeMap) {
  const A = nodeMap.get(e.a), B = nodeMap.get(e.b);
  let dx = B.x - A.x, dy = B.y - A.y;
  if (Math.hypot(dx, dy) < EPS && e.sketch) { dx = e.sketch.dx; dy = e.sketch.dy; }
  if (e.orient === 'h') { dx = Math.sign(dx) || 1; dy = 0; }
  else if (e.orient === 'v') { dx = 0; dy = Math.sign(dy) || 1; }
  const l = Math.hypot(dx, dy) || 1;
  dx /= l; dy /= l;
  return fromId === e.a ? { x: dx, y: dy } : { x: -dx, y: -dy };
}

// Remove dangling "spikes" (an edge walked out and straight back) from a face walk, so that partial
// walls inside a room do not become room sides. → { nodeIds, edgeIds }
function removeSpikes(nodeIds, edgeIds) {
  let ns = nodeIds.slice(), es = edgeIds.slice();
  let changed = true;
  while (changed && ns.length > 2) {
    changed = false;
    const n = ns.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (es[i] === es[j]) {
        // ns[i] → tip ns[j] → back to ns[i]: drop entries i and j.
        const drop = new Set([i, j]);
        ns = ns.filter((_, k) => !drop.has(k));
        es = es.filter((_, k) => !drop.has(k));
        changed = true;
        break;
      }
    }
  }
  return { nodeIds: ns, edgeIds: es };
}

function sameDirection(u, v) {
  return Math.abs(u.x * v.y - u.y * v.x) < 1e-3 && u.x * v.x + u.y * v.y > 0;
}

// Two diagonal edges drawn as one straight wall (sketch vectors parallel within 1°, e.g. one stroke split
// where another wall meets it) stay ONE side (2026-10-19): the solver keeps such a corner on the wall's
// line, but a kink from contradicting values must not split the side and set its value loose. Up to
// 2026-10-25 only while the solve left them within 5° of straight: a busier solve that bent one further
// split the side after the solve, so the value it had just used matched no side, showed nowhere, named
// no check item, and on opening waited or was gone (review 2026-10-25). The drawing decides (a corner
// dragged off the line changes the sketch); only a joint the solve turned back on itself is a corner.
const SKETCH_STRAIGHT = Math.sin(Math.PI / 180);
function straightDiagonal(e1, from1, e2, from2, u, v) {
  if (!e1 || !e2 || e1.orient !== 'd' || e2.orient !== 'd' || !e1.sketch || !e2.sketch) return false;
  const s1 = from1 === e1.a ? { x: e1.sketch.dx, y: e1.sketch.dy } : { x: -e1.sketch.dx, y: -e1.sketch.dy };
  const s2 = from2 === e2.a ? { x: e2.sketch.dx, y: e2.sketch.dy } : { x: -e2.sketch.dx, y: -e2.sketch.dy };
  const l1 = Math.hypot(s1.x, s1.y), l2 = Math.hypot(s2.x, s2.y);
  if (!(l1 > EPS && l2 > EPS)) return false;
  const sketchCross = (s1.x * s2.y - s1.y * s2.x) / (l1 * l2), sketchDot = s1.x * s2.x + s1.y * s2.y;
  return Math.abs(sketchCross) <= SKETCH_STRAIGHT && sketchDot > 0 && u.x * v.x + u.y * v.y > 0;
}

// The key suffix of the second face of a wall that one room walks on both faces (roomSides).
export const TWIN_SUFFIX = '~';

// The side key a measure (or a computed part) names: its corners sorted, plus TWIN_SUFFIX for the
// second face of a wall the room walks on both faces (m.twin, set when the value is taken there and
// kept by every re-derive). Every engine match of a measure to a side goes through this.
export function measureSideKey(m) {
  return [m.from, m.to].sort().join('-') + (m && m.twin ? TWIN_SUFFIX : '');
}

// Sides of a room face: maximal straight runs between corners. A T-junction on the far side of a wall
// does not make a corner. Sides run clockwise and start at the top-left corner.
// → [{ key, from, to, edgeIds, orient, dir, inwardNormal, centerLength, allDivider }]
export function roomSides(face, doc) {
  const nodeMap = new Map((doc.nodes || []).map((n) => [n.id, n]));
  const edgeMap = new Map((doc.edges || []).map((e) => [e.id, e]));
  const { nodeIds: ns, edgeIds: es } = removeSpikes(face.nodeIds, face.edgeIds);
  const n = ns.length;
  if (n < 3) return [];
  for (const id of es) if (!edgeMap.has(id)) return [];
  const dirs = es.map((id, k) => edgeDirection(edgeMap.get(id), ns[k], nodeMap));

  let corners = [];
  for (let k = 0; k < n; k++) {
    const p = (k - 1 + n) % n;
    if (sameDirection(dirs[p], dirs[k])) continue;
    if (straightDiagonal(edgeMap.get(es[p]), ns[p], edgeMap.get(es[k]), ns[k], dirs[p], dirs[k])) continue;
    corners.push(k);
  }
  if (corners.length < 2) return [];
  // Start at the top-left corner (smallest y, then smallest x).
  let startPos = 0;
  for (let c = 1; c < corners.length; c++) {
    const p = nodeMap.get(ns[corners[c]]), q = nodeMap.get(ns[corners[startPos]]);
    if (p.y < q.y - EPS || (Math.abs(p.y - q.y) <= EPS && p.x < q.x)) startPos = c;
  }
  corners = corners.slice(startPos).concat(corners.slice(0, startPos));

  const sides = [];
  const runs = [];
  for (let c = 0; c < corners.length; c++) {
    const k0 = corners[c];
    const k1 = corners[(c + 1) % corners.length];
    const from = ns[k0], to = ns[k1];
    const sorted = [from, to].sort();
    runs.push({ c, k0, k1, from, to, first: sorted[0], base: sorted.join('-') });
  }
  // A wall that is the only link between an island room (a 창고 inside a 거실) and the outer walls is
  // walked on both faces by the outer room: two sides between the same corners, in opposite directions
  // (review 2026-10-25: the second face's value threw). The face walked from the first of the sorted
  // corner ids keeps the plain key; the other one is `${key}~` (TWIN_SUFFIX), which a measure on it
  // names with `twin: true` (measureSideKey). Anything else repeated (not expected) takes '~' + corner.
  const baseCount = new Map();
  for (const r of runs) baseCount.set(r.base, (baseCount.get(r.base) || 0) + 1);
  const usedKeys = new Set();
  for (const r of runs) {
    let key = r.base;
    if (baseCount.get(r.base) === 2 && r.from !== r.first) key = r.base + TWIN_SUFFIX;
    if (usedKeys.has(key)) key = r.base + '~' + r.c;
    usedKeys.add(key);
    r.key = key;
  }
  for (const { k0, k1, from, to, key } of runs) {
    const edgeIds = [];
    for (let k = k0; k !== k1; k = (k + 1) % n) edgeIds.push(es[k]);
    const edges = edgeIds.map((id) => edgeMap.get(id));
    const orient = edges.every((e) => e.orient === 'h') ? 'h' : edges.every((e) => e.orient === 'v') ? 'v' : 'd';
    const dir = dirs[k0];
    const A = nodeMap.get(from), B = nodeMap.get(to);
    sides.push({
      key, from, to, edgeIds, orient,
      dir: { x: dir.x, y: dir.y },
      inwardNormal: { x: -dir.y, y: dir.x }, // faces run clockwise in y-down space: interior on the right
      centerLength: (B.x - A.x) * dir.x + (B.y - A.y) * dir.y,
      allDivider: edges.every((e) => e.kind === 'divider'),
    });
  }
  return sides;
}

function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Index of the (smallest) face containing pt, or -1.
function faceAt(pt, faces, boxes) {
  let best = -1, bestArea = Infinity;
  for (let i = 0; i < faces.length; i++) {
    const b = boxes[i];
    if (pt.x < b.minX || pt.x > b.maxX || pt.y < b.minY || pt.y > b.maxY) continue;
    if (pointInPolygon(pt, faces[i].points) && faces[i].area < bestArea) { best = i; bestArea = faces[i].area; }
  }
  return best;
}

// Sample points spread over a polygon (used to measure overlap between an old room and new faces).
function samplePolygon(points, seed) {
  const out = [];
  if (points && points.length >= 3) {
    const b = bbox(points);
    const N = 12;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = { x: b.minX + (b.maxX - b.minX) * (i + 0.5) / N, y: b.minY + (b.maxY - b.minY) * (j + 0.5) / N };
        if (pointInPolygon(p, points)) out.push(p);
      }
    }
  }
  if (seed && isFinite(seed.x) && isFinite(seed.y)) out.push(seed);
  return out;
}

function roomAge(room, index) {
  const k = Number(String(room.id).replace(/^\D+/, ''));
  return Number.isFinite(k) ? k : 1e9 + index;
}

// A detached room comes back only for a face that it and the face cover to at least this fraction each.
export const REVIVE_MIN_OVERLAP = 0.6;
// A room also competes for faces it overlaps less than its best one (down to this fraction of the best
// overlap), so that it can still take its second-best face when a better match takes its best one.
const SECOND_FACE_FRACTION = 0.2;

// Stable matching of stored rooms to faces.
// opts.prevPolygons: optional Map roomId → polygon points from the previous derivation. When given, a
// room goes to the new face it overlaps most (plan §5.7: name/H/measures follow the biggest overlap);
// otherwise its seed decides. Two rooms competing for one face: the larger overlap wins, ties go to the
// older room; the loser is reported as merged.
// opts.detached: rooms that lost their face earlier (a wall deleted, two rooms merged; DESIGN.md §7.7):
//   [{ id, name, height, notRoom, polygon }]. One comes back (same id, name, H, 실 아님) for a face that
//   matches its last polygon both ways (each covers ≥ REVIVE_MIN_OVERLAP of the other): the room is
//   closed again where it was. Their ids are never given to new rooms.
// → { rooms, faceRoom: [roomId per face], created: [roomId], merged: [{ kept, removed }], dropped: [roomId],
//     revived: [roomId] }
export function matchRooms(doc, faces, rooms, opts = {}) {
  const prev = opts.prevPolygons || null;
  const boxes = faces.map((f) => bbox(f.points));
  const list = (rooms || []).map((r, i) => ({ room: r, age: roomAge(r, i), index: i }));
  const detached = (opts.detached || []).filter((d) => d && d.id && Array.isArray(d.polygon) && d.polygon.length >= 3
    && !list.some((x) => x.room.id === d.id));

  // Candidate (room, face, score) pairs.
  const pairs = [];
  const bestFace = new Map();
  for (const item of list) {
    const samples = samplePolygon(prev && prev.get(item.room.id), item.room.seed);
    const counts = new Map();
    for (const p of samples) {
      const fi = faceAt(p, faces, boxes);
      if (fi >= 0) counts.set(fi, (counts.get(fi) || 0) + 1);
    }
    let best = -1, bestCount = 0;
    for (const [fi, c] of counts) if (c > bestCount) { best = fi; bestCount = c; }
    if (best >= 0) bestFace.set(item.room.id, best);
    for (const [fi, c] of counts) {
      if (c >= SECOND_FACE_FRACTION * bestCount) pairs.push({ item, fi, score: c / samples.length });
    }
  }
  // Detached rooms: both-way overlap with a face (sampled on each polygon).
  const faceSamples = new Map();
  const samplesOfFace = (fi) => {
    if (!faceSamples.has(fi)) faceSamples.set(fi, samplePolygon(faces[fi].points, null));
    return faceSamples.get(fi);
  };
  detached.forEach((d, k) => {
    const samples = samplePolygon(d.polygon, null);
    if (!samples.length) return;
    const counts = new Map();
    for (const p of samples) {
      const fi = faceAt(p, faces, boxes);
      if (fi >= 0) counts.set(fi, (counts.get(fi) || 0) + 1);
    }
    for (const [fi, c] of counts) {
      const fs = samplesOfFace(fi);
      if (!fs.length) continue;
      const inRoom = fs.filter((p) => pointInPolygon(p, d.polygon)).length / fs.length;
      const score = Math.min(c / samples.length, inRoom);
      if (score >= REVIVE_MIN_OVERLAP) pairs.push({ item: { room: d, age: roomAge(d, list.length + k), detached: true }, fi, score });
    }
  });
  // Larger overlap first; at equal overlap a room that still has a face beats a detached one, then the
  // older room.
  pairs.sort((p, q) => q.score - p.score || (!!p.item.detached - !!q.item.detached) || p.item.age - q.item.age);

  const faceRoom = new Array(faces.length).fill(null);
  const assigned = new Map(); // roomId → face index
  for (const p of pairs) {
    if (assigned.has(p.item.room.id) || faceRoom[p.fi] !== null) continue;
    faceRoom[p.fi] = p.item.room.id;
    assigned.set(p.item.room.id, p.fi);
  }

  const merged = [], dropped = [];
  const kept = [];
  for (const item of list) {
    const id = item.room.id;
    if (assigned.has(id)) { kept.push(item.room); continue; }
    if (bestFace.has(id)) merged.push({ kept: faceRoom[bestFace.get(id)], removed: id });
    else dropped.push(id);
  }
  const revived = [];
  for (const d of detached) {
    if (!assigned.has(d.id)) continue;
    const seed = poleOfInaccessibility(faces[assigned.get(d.id)].points);
    kept.push({
      id: d.id, name: typeof d.name === 'string' ? d.name : '', height: Number.isFinite(d.height) ? d.height : null,
      seed: { x: seed.x, y: seed.y }, notRoom: !!d.notRoom,
    });
    revived.push(d.id);
  }

  const created = [];
  const allIds = (rooms || []).map((r) => r.id).concat((opts.detached || []).filter((d) => d && d.id).map((d) => d.id));
  for (let fi = 0; fi < faces.length; fi++) {
    if (faceRoom[fi] !== null) continue;
    const id = nextId('r', allIds);
    allIds.push(id);
    const seed = poleOfInaccessibility(faces[fi].points);
    kept.push({ id, name: '', height: null, seed: { x: seed.x, y: seed.y }, notRoom: false });
    faceRoom[fi] = id;
    created.push(id);
  }
  return { rooms: kept, faceRoom, created, merged, dropped, revived };
}

// ---- straight runs of sides across dividers ------------------------------------------------------

// Index of every room side by its corner nodes (for sideRun). dRooms: [{ roomId, sides }].
// → Map nodeId → [{ dr, i, side }]
export function sidesByNode(dRooms) {
  const map = new Map();
  for (const dr of dRooms || []) {
    (dr.sides || []).forEach((side, i) => {
      const rec = { dr, i, side };
      for (const id of [side.from, side.to]) {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(rec);
      }
    });
  }
  return map;
}

// The straight run of room sides on ONE face of a line, from corner node `fromId` to corner node `toId`,
// joined across dividers (구역 나누기 lines, DESIGN.md §7.7). `normal` is the inward normal of that face
// (unit). Each part is a room side running in the face's clockwise direction; between two parts the
// first part's room turns into a side made only of dividers, and the next room continues straight on.
// A single side between the two corners is a run of one part. Diagonal sides only form one-part runs.
//   byNode: sidesByNode(dRooms); nodeMap: Map nodeId → { x, y }
//   opts.acrossWalls: also join across a real WALL that meets the line from this face (a wall drawn
//     across a measured side, DESIGN.md §7.9): the first room turns into that wall and the next room
//     continues straight on from the same corner node. Each part after the first then carries
//     `joint: 'wall' | 'divider'` (what lies between it and the part before).
// → [{ dr, i, side, joint? }] in the faces' direction (first part starts at one corner, last ends at the
//   other) | null
export function sideRun(byNode, nodeMap, fromId, toId, normal, opts = {}) {
  const acrossWalls = !!(opts && opts.acrossWalls);
  const P = nodeMap.get(fromId), Q = nodeMap.get(toId);
  if (!P || !Q || fromId === toId || !normal) return null;
  const dir = { x: normal.y, y: -normal.x }; // inwardNormal = (−dir.y, dir.x)
  const along = (Q.x - P.x) * dir.x + (Q.y - P.y) * dir.y;
  const start = along >= 0 ? fromId : toId, end = along >= 0 ? toId : fromId;
  const E = nodeMap.get(end);
  const parts = [];
  let cur = start;
  let joint = null;
  for (let k = 0; k < 64; k++) {
    const rec = (byNode.get(cur) || []).find((r) => r.side.from === cur
      && r.side.dir.x * dir.x + r.side.dir.y * dir.y > (r.side.orient === 'd' ? 0.98 : 0.999));
    if (!rec) return null;
    if (parts.length && rec.side.orient === 'd') return null;
    if (joint === 'wall' && parts.some((p) => p.dr === rec.dr)) return null; // never back into a room
    parts.push(joint ? { ...rec, joint } : rec);
    cur = rec.side.to;
    if (cur === end) return parts;
    if (rec.side.orient === 'd') return null;
    const sides = rec.dr.sides;
    const turn = sides[(rec.i + 1) % sides.length];
    if (!turn.allDivider && !acrossWalls) return null;
    joint = turn.allDivider ? 'divider' : 'wall';
    const C = nodeMap.get(cur);
    if (!C || (E.x - C.x) * dir.x + (E.y - C.y) * dir.y <= 0) return null;
  }
  return null;
}

// Room sides on both sides of an edge. derived: DocStore.derived ({ edgeFaces, rooms }).
// → [{ roomId, side }] (0, 1 or 2 entries). One room on both faces of the edge (a wall joining an island
// room to the room around it: the room walks it on both faces) gives both of its sides, the second one
// keyed '…~' (roomSides), so the length panel offers each face (review 2026-10-25).
export function sidesForEdge(derived, edgeId) {
  if (!derived || !derived.edgeFaces) return [];
  const pair = derived.edgeFaces.get(edgeId);
  if (!pair) return [];
  const out = [];
  const seen = new Set();
  for (const fi of pair) {
    if (fi === null || fi === undefined || seen.has(fi)) continue;
    seen.add(fi);
    const r = (derived.rooms || []).find((x) => x.faceIndex === fi || (derived.faces && x.face === derived.faces[fi]));
    if (!r) continue;
    for (const side of (r.sides || []).filter((s) => s.edgeIds.includes(edgeId))) out.push({ roomId: r.roomId, side });
  }
  return out;
}
