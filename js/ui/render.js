// Draws the plan onto a 2D canvas context (dev/DESIGN.md §5 "Render").
//
//   renderPlan(ctx, source, view, options)
//     source  : a DocStore, or any { project, derived } pair (stage C passes its own).
//     view    : { scale (canvas units per mm), ox, oy, width, height } - see view.js. The caller sets up
//               the context transform (e.g. devicePixelRatio) so that 1 unit = 1 CSS px on screen.
//     options : see DEFAULTS below. mode 'screen' draws editing aids (grid, "?", selection);
//               mode 'export' draws only the drawing itself (stage C adds dimension lines on top).
//
//   renderOverlay(ctx, view, overlay) draws transient tool feedback (live stroke, rectangle, drag ghost).
//
// Screen mode writes every text in one layer with level of detail (drawScreenText, 2026-10-17): room
// names (+ H), per-side values, and — when the editor asks (openingLabels / fixtureLabels /
// notRoomLabels) — window/door, fixture and 실 아님 labels. Nothing overlaps; what does not fit is left
// out until the user zooms in. Export mode keeps the plain room names (paper text is draw-labels.js).
//
//   drawPaperPlanText(ctx, project, derived, opts) — [출력] 종류 '치수선 없이' (2026-10-18): the same text
//   layer on paper, at paper sizes (the editor's look without 치수선 보기), nothing left out.
import { COLORS, LINES, TEXT_PX, DEFAULT_WALL, canvasFont, formatPlain } from './theme.js';
import {
  finishPolygons, wallPolygons, wallOutline, uprightAngle, rotatedRect, rotatedRectParts, boxOf, boxPoints,
  convexOverlap, polygonBoxArea,
} from '../core/dims.js';
import {
  placeLabels, fixtureObstacles, findFreeSpot, roomBasePoint, scanExtent, wrapName, boxesHit, boxInPolygon,
  roomInnerPolygon,
} from '../core/labels.js';
import { PAPER_STYLE, PT_MM } from '../core/printlayout.js';
import { pointInPolygon } from '../core/geom.js';

const DEFAULTS = {
  mode: 'screen',          // 'screen' | 'export'
  background: COLORS.canvasBg,   // null = leave the canvas as it is
  grid: undefined,         // default: true on screen
  labels: true,            // room names and H (false = '그림만')
  sideLabels: undefined,   // measured values / "?" per side; default: true on screen
  selectedEdges: null,     // array of edge ids to highlight
  selectedNode: null,      // node id to highlight
  activeSide: null,        // { roomId, sideKey } highlighted in the panel colour
  roomLabel: null,         // (roomId) => label for unnamed rooms on screen; default '이름 없음'
  fontPx: null,            // { name, height, measure } in canvas units; default TEXT_PX
  dividerWidth: null,      // canvas units; default LINES.divider on screen, 0.35 mm on paper
  // Layers of the other packages, drawn at the right depth (stage B):
  afterWalls: null,        // (ctx) => …  right after the walls (openings cut the walls here)
  afterLabels: null,       // (ctx) => …  after room names and side values (opening labels)
  notRoomLabels: false,    // true: also write the names of named 실 아님 spaces (normally the
                           // fixtures layer, drawNotRoomSpaces, labels them)
  wallCutouts: null,       // (project, derived) → world polygons ([{x,y}] | { points }) cleared out
                           // of the walls (fixtures put into a wall, 벽 속에 넣기)
  nameBoxes: null,         // array: receives { roomId, x, y, w, h } (canvas units) of every room name
                           // drawn, so a tap on a name can open the room's name field
  // Screen text layer (see drawScreenText):
  openingLabels: false,    // also write the window/door labels (the editor; replaces drawOpeningLabels)
  fixtureLabels: false,    // also write the fixture labels (the editor draws fixtures with drawingOnly)
  worldPerPaperMM: 60,     // print scale: label offsets are paper mm (core/labels.js)
  textObstacles: null,     // world boxes the labels keep clear of (치수선 보기: the dimension numbers)
  textBoxes: null,         // array: receives { key, kind, refId, x, y, w, h (canvas units), base,
                           // center (world) } of every movable label drawn (선택: drag to move)
  forceShow: null,         // label key always shown (the one being dragged)
  textItems: null,         // array: receives { kind, refId, key, x, y, w, h } of EVERY text drawn by the
                           // text layer (checks: nothing overlaps)
  fixtureExclude: null,    // fixture id whose label is left out (its size is being dragged)
};

// 구역 나누기 선 dash pattern on screen (css px) and on paper (paper mm; see output.js).
export const DIVIDER_DASH_PX = [8, 5];
const DIVIDER_DASH_PAPER_MM = [2.0, 1.2];
// Side values computed from a 구역 나누기 position (measure.computed): gray, not the typed blue.
export const COMPUTED_COLOR = '#80868B';

export function renderPlan(ctx, source, view, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const screen = o.mode === 'screen';
  if (o.grid === undefined) o.grid = screen;
  if (o.sideLabels === undefined) o.sideLabels = screen;
  const font = { ...TEXT_PX, ...(o.fontPx || {}) };

  const project = source && source.project;
  const derived = safeDerived(source);
  const w = view.width || ctx.canvas.width;
  const h = view.height || ctx.canvas.height;

  ctx.save();
  if (o.background) {
    ctx.fillStyle = o.background;
    ctx.fillRect(0, 0, w, h);
  }
  if (o.grid) drawGrid(ctx, view, w, h);
  if (!project) {
    ctx.restore();
    return;
  }

  const geo = buildGeometry(project, derived);

  // The gray tint of 실 아님 spaces is an editing aid; the fixtures layer paints their light gray fill.
  if (screen) drawRoomFills(ctx, view, derived);
  if (screen && o.sideLabels) drawUnmeasuredLines(ctx, view, project, derived, geo);
  if (screen && o.activeSide) drawActiveSide(ctx, view, derived, geo, o.activeSide);
  // Finish layers on room faces are drawn as wall (the per-side values and dimensions end there).
  let finishes = [];
  try { finishes = derived ? finishPolygons(project, derived) : []; } catch (err) { console.error('[render] finish', err); }
  drawWalls(ctx, view, geo, null, COLORS.wall, finishes);
  let cutouts = [];
  if (typeof o.wallCutouts === 'function') {
    try { cutouts = o.wallCutouts(project, derived) || []; } catch (err) { console.error('[render] wall cutouts', err); }
  } else if (Array.isArray(o.wallCutouts)) cutouts = o.wallCutouts;
  clearCutouts(ctx, view, cutouts, o.background || COLORS.canvasBg);
  // Export mode: 0.35 paper mm. view.scale is canvas units per WORLD mm, so the paper width must be
  // given by the caller (dividerWidth); without it, assume 1:60 at view.scale.
  const divW = o.dividerWidth != null ? o.dividerWidth : (screen ? LINES.divider : LINES.dividerExport * 60 * view.scale);
  // Dashed (점선): a 구역 나누기 선 is not a wall.
  const paperMM = divW / LINES.dividerExport;   // canvas units per paper mm (export mode)
  drawDividers(ctx, view, geo, divW, screen ? DIVIDER_DASH_PX : DIVIDER_DASH_PAPER_MM.map((v) => v * paperMM));
  if (screen && o.selectedEdges && o.selectedEdges.length) {
    drawWalls(ctx, view, geo, new Set(o.selectedEdges), COLORS.selectWall, finishes);
    clearCutouts(ctx, view, cutouts, o.background || COLORS.canvasBg);
    drawSelectedDividers(ctx, view, geo, new Set(o.selectedEdges));
  }
  layer(o.afterWalls, ctx, 'afterWalls');
  if (screen) drawWallChecks(ctx, view, project, geo, font);
  if (screen) {
    // One text layer with level of detail: names, per-side values, window/door and fixture labels
    // and H never overlap; what does not fit is left out until the user zooms in.
    try {
      drawScreenText(ctx, view, project, derived, geo, font, o);
    } catch (err) {
      console.error('[render] text layer failed', err);
    }
  } else {
    if (o.labels) drawRoomLabels(ctx, view, derived, font, screen, o.roomLabel, o.notRoomLabels, o.nameBoxes);
    if (o.sideLabels) drawSideLabels(ctx, view, project, derived, geo, font, o);
  }
  layer(o.afterLabels, ctx, 'afterLabels');
  if (screen && o.selectedNode) drawNodeMark(ctx, view, geo.nodes.get(o.selectedNode), COLORS.selectWall);
  ctx.restore();
}

// A layer of another package: a failure must not blank the plan.
function layer(fn, ctx, name) {
  if (typeof fn !== 'function') return;
  ctx.save();
  try {
    fn(ctx);
  } catch (err) {
    console.error(`[render] ${name} failed`, err);
  }
  ctx.restore();
}

// Transient tool feedback on top of the plan (screen only).
//   overlay = { stroke: { points, held }, rect: { a, b, label }, ghost: { at, links: [points] },
//               line: { a, b } }
export function renderOverlay(ctx, view, overlay) {
  if (!overlay) return;
  ctx.save();
  if (overlay.stroke && overlay.stroke.points.length > 1) {
    const pts = overlay.stroke.points.map((p) => view.toScreen(p));
    ctx.strokeStyle = overlay.stroke.held ? COLORS.inkDiagonal : COLORS.ink;
    ctx.lineWidth = LINES.ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    if (overlay.stroke.held) {
      const end = pts[pts.length - 1];
      pill(ctx, end.x + 14, end.y - 30, '사선', COLORS.inkDiagonal, '#FFFFFF');
    }
  }
  if (overlay.line) {
    const a = view.toScreen(overlay.line.a);
    const b = view.toScreen(overlay.line.b);
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (overlay.rect) {
    const a = view.toScreen(overlay.rect.a);
    const b = view.toScreen(overlay.rect.b);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const rw = Math.abs(a.x - b.x), rh = Math.abs(a.y - b.y);
    ctx.fillStyle = 'rgba(26, 115, 232, 0.06)';
    ctx.fillRect(x, y, rw, rh);
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = LINES.preview;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(x + 0.5, y + 0.5, rw, rh);
    ctx.setLineDash([]);
    if (overlay.rect.label) pill(ctx, x + rw / 2, y + rh / 2, overlay.rect.label, COLORS.preview, '#FFFFFF', true);
  }
  if (overlay.ghost) {
    const at = view.toScreen(overlay.ghost.at);
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    for (const p of overlay.ghost.links || []) {
      const s = view.toScreen(p);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(at.x, at.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    drawNodeMark(ctx, view, overlay.ghost.at, COLORS.preview);
  }
  ctx.restore();
}

// ---- helpers ---------------------------------------------------------------------------------

function safeDerived(source) {
  try {
    return (source && source.derived) || null;
  } catch (err) {
    // A failing derive must never blank the editor; draw what the project holds.
    console.error('derived failed', err);
    return null;
  }
}

// Wall thickness used for drawing: solved value, else measured, else the default by wall type.
export function edgeThickness(edge, derived) {
  if (edge.kind === 'divider') return 0;
  const solved = derived && derived.solve && derived.solve.thickness;
  if (solved && typeof solved.get === 'function') {
    const t = solved.get(edge.id);
    if (t != null && isFinite(t)) return Math.max(0, t);
  }
  if (edge.thickness != null) return edge.thickness;
  const ef = derived && derived.edgeFaces;
  if (ef && typeof ef.get === 'function') {
    const sides = ef.get(edge.id);
    if (sides && sides[0] != null && sides[1] != null) return DEFAULT_WALL.int;
  }
  return DEFAULT_WALL.ext;
}

function buildGeometry(project, derived) {
  const nodes = new Map();
  for (const n of project.nodes || []) nodes.set(n.id, n);
  const edges = [];
  const byNode = new Map();
  for (const e of project.edges || []) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const item = { edge: e, a, b, t: edgeThickness(e, derived) };
    edges.push(item);
    for (const id of [e.a, e.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(item);
    }
  }
  const edgeById = new Map(edges.map((it) => [it.edge.id, it]));
  return { nodes, edges, byNode, edgeById };
}

// Outline of a thick wall: core/dims.js wallOutline (the same construction as the print): the centre
// line widened by t/2; where only horizontal / vertical walls meet, each end extended by half the
// thickest wall meeting it at a corner (a straight continuation does not count); where a diagonal
// wall meets, the faces are mitred (no gaps, no long points).
function wallPolygon(item, geo) {
  return wallOutline(item, geo.byNode);
}

// finishes: polygons of the finish layers on room faces (core/dims.js finishPolygons), drawn as wall.
function drawWalls(ctx, view, geo, onlyIds, color, finishes = []) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const add = (poly) => {
    const s0 = view.toScreen(poly[0]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < poly.length; i++) {
      const s = view.toScreen(poly[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
  };
  for (const item of geo.edges) {
    if (item.edge.kind === 'divider') continue;
    if (onlyIds && !onlyIds.has(item.edge.id)) continue;
    const poly = wallPolygon(item, geo);
    if (poly) add(poly);
  }
  for (const f of finishes) {
    if (onlyIds && !f.edgeIds.some((id) => onlyIds.has(id))) continue;
    add(f.points);
  }
  ctx.fill('nonzero');
}

// Clears the wall parts taken by fixtures put into a wall (the fixture is drawn over the gap later).
function clearCutouts(ctx, view, cutouts, color) {
  if (!cutouts || !cutouts.length) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const c of cutouts) {
    const pts = Array.isArray(c) ? c : (c && c.points);
    if (!Array.isArray(pts) || pts.length < 3) continue;
    const s0 = view.toScreen(pts[0]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = view.toScreen(pts[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
  }
  ctx.fill('nonzero');
}

// Each divider is its own dashed path, so the dashes start at its end and look the same on every line.
function drawDividers(ctx, view, geo, width, dash = []) {
  ctx.save();
  ctx.strokeStyle = COLORS.divider;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.setLineDash(dash);
  for (const item of geo.edges) {
    if (item.edge.kind !== 'divider') continue;
    const a = view.toScreen(item.a), b = view.toScreen(item.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSelectedDividers(ctx, view, geo, ids) {
  ctx.strokeStyle = COLORS.selectWall;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const item of geo.edges) {
    if (item.edge.kind !== 'divider' || !ids.has(item.edge.id)) continue;
    const a = view.toScreen(item.a), b = view.toScreen(item.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function drawGrid(ctx, view, w, h) {
  const s = view.scale;
  let major = 1000;
  while (major * s < 24) major *= 10;
  const minor = major / 10;
  const drawLines = (step, color) => {
    const tl = view.toWorld({ x: 0, y: 0 });
    const br = view.toWorld({ x: w, y: h });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const sx = Math.round(x * s + view.ox) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
      const sy = Math.round(y * s + view.oy) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();
  };
  if (minor * s >= 10) drawLines(minor, COLORS.gridMinor);
  drawLines(major, COLORS.gridMajor);
}

function roomsOf(derived) {
  return (derived && Array.isArray(derived.rooms)) ? derived.rooms : [];
}

function drawRoomFills(ctx, view, derived) {
  for (const r of roomsOf(derived)) {
    if (!r.room || !r.room.notRoom || !r.face || !r.face.points) continue;
    fillPolygon(ctx, view, r.face.points, COLORS.notRoomFill);
  }
}

function fillPolygon(ctx, view, points, color) {
  if (!points.length) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  const s0 = view.toScreen(points[0]);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < points.length; i++) {
    const s = view.toScreen(points[i]);
    ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  ctx.fill();
}

// roomLabel(roomId) (optional) names unnamed rooms on screen the way the panels do ("이름 없는 실 2").
function drawRoomLabels(ctx, view, derived, font, screen, roomLabel, notRoomLabels, nameBoxes) {
  const box = (roomId, cx, cy, tw, th) => {
    if (Array.isArray(nameBoxes)) nameBoxes.push({ roomId, x: cx - tw / 2, y: cy - th / 2, w: tw, h: th });
  };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of roomsOf(derived)) {
    if (!r.labelPoint || !r.room) continue;
    // A named 실 아님 space (예시 세대 A 옷장) is labelled like a fixture by drawNotRoomSpaces.
    if (r.room.notRoom && r.room.name && !notRoomLabels) continue;
    const p = view.toScreen(r.labelPoint);
    const name = r.room.name || '';
    const hasHeight = r.room.height != null && r.room.height !== '';
    const nameY = hasHeight ? p.y - font.height * 0.6 : p.y;
    if (name) {
      ctx.font = canvasFont(font.name, 'bold');
      ctx.fillStyle = COLORS.roomName;
      ctx.fillText(name, p.x, nameY);
      box(r.roomId, p.x, nameY, ctx.measureText(name).width, font.name * 1.2);
    } else if (screen) {
      const px = Math.round(font.name * 0.8);
      ctx.font = canvasFont(px);
      ctx.fillStyle = COLORS.roomNameEmpty;
      let label = '이름 없음';
      if (r.room.notRoom) label = '실 아님';
      else if (typeof roomLabel === 'function') label = roomLabel(r.roomId) || label;
      ctx.fillText(label, p.x, nameY);
      box(r.roomId, p.x, nameY, ctx.measureText(label).width, px * 1.2);
    }
    if (hasHeight) {
      ctx.font = canvasFont(font.height);
      ctx.fillStyle = COLORS.height;
      ctx.fillText(`H: ${formatPlain(r.room.height)}`, p.x, nameY + font.name * 0.6 + font.height * 0.7);
    }
  }
}

// Index measures by "roomId|sortedNodeKey". The parts of a measured side cut by a 구역 나누기 선 are
// computed by the engine (derived.computedMeasures, `computed: true`); a typed value of the same side
// wins over them.
function measureIndex(project, derived) {
  const map = new Map();
  const computed = derived && Array.isArray(derived.computedMeasures) ? derived.computedMeasures : [];
  for (const m of computed) {
    if (m && m.room && m.value != null) map.set(`${m.room}|${sideKeyOf(m.from, m.to)}`, m);
  }
  for (const m of project.measures || []) {
    const key = `${m.room}|${sideKeyOf(m.from, m.to)}`;
    if (m.value == null && map.has(key)) continue;   // a bare 확인필요 flag does not hide a computed value
    map.set(key, m);
  }
  return map;
}

export function sideKeyOf(a, b) {
  return [a, b].sort().join('-');
}

// → (roomId, sideKey) => true when the side still needs a value: the engine's 'unmeasured' warnings
// when available (a side covered by a measured parallel side of the same span is not "missing"),
// else every side without a measured value.
function missingTest(project, derived, measures) {
  const warnings = derived && derived.warnings;
  if (Array.isArray(warnings)) {
    const set = new Set(warnings.filter((w) => w.type === 'unmeasured').map((w) => `${w.roomId}|${w.sideKey}`));
    return (roomId, key) => set.has(`${roomId}|${key}`);
  }
  return (roomId, key) => {
    const m = measures.get(`${roomId}|${key}`);
    return !(m && m.value != null);
  };
}

// Geometry of one room side for labels: end points, unit direction, inward normal, inner offset (mm).
function sideFrame(side, roomId, derived, geo) {
  const A = geo.nodes.get(side.from), B = geo.nodes.get(side.to);
  if (!A || !B) return null;
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return null;
  const dir = { x: dx / L, y: dy / L };
  let n = side.inwardNormal;
  if (!n || !isFinite(n.x)) n = { x: -dir.y, y: dir.x };
  const ids = side.edgeIds || [];
  const mid = geo.edgeById.get(ids[Math.floor(ids.length / 2)]);
  const t = mid ? mid.t : DEFAULT_WALL.int;
  const finishMap = derived && derived.solve && derived.solve.finish;
  const f = (finishMap && typeof finishMap.get === 'function') ? (finishMap.get(`${roomId}:${side.key}`) || 0) : 0;
  return { A, B, L, dir, n, inner: t / 2 + Math.max(0, f), t };
}

function drawUnmeasuredLines(ctx, view, project, derived, geo) {
  const measures = measureIndex(project, derived);
  const missing = missingTest(project, derived, measures);
  ctx.strokeStyle = COLORS.unmeasured;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(LINES.unmeasuredDash);
  ctx.beginPath();
  for (const r of roomsOf(derived)) {
    if (!r.sides || (r.room && r.room.notRoom)) continue;
    for (const side of r.sides) {
      if (!missing(r.roomId, side.key)) continue;
      const fr = sideFrame(side, r.roomId, derived, geo);
      if (!fr) continue;
      const off = fr.inner + 4 / view.scale;
      const trim = Math.min(fr.L / 3, fr.t / 2 + 4 / view.scale);
      const p = { x: fr.A.x + fr.dir.x * trim + fr.n.x * off, y: fr.A.y + fr.dir.y * trim + fr.n.y * off };
      const q = { x: fr.B.x - fr.dir.x * trim + fr.n.x * off, y: fr.B.y - fr.dir.y * trim + fr.n.y * off };
      const sp = view.toScreen(p), sq = view.toScreen(q);
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sq.x, sq.y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function findSide(derived, roomId, sideKey) {
  for (const r of roomsOf(derived)) {
    if (r.roomId !== roomId || !r.sides) continue;
    return r.sides.find((s) => s.key === sideKey) || null;
  }
  return null;
}

function drawActiveSide(ctx, view, derived, geo, active) {
  const side = findSide(derived, active.roomId, active.sideKey);
  if (!side) return;
  const fr = sideFrame(side, active.roomId, derived, geo);
  if (!fr) return;
  const off = fr.inner + (LINES.activeSide / 2 + 1) / view.scale;
  const p = view.toScreen({ x: fr.A.x + fr.n.x * off, y: fr.A.y + fr.n.y * off });
  const q = view.toScreen({ x: fr.B.x + fr.n.x * off, y: fr.B.y + fr.n.y * off });
  ctx.strokeStyle = COLORS.activeSide;
  ctx.lineWidth = LINES.activeSide;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(q.x, q.y);
  ctx.stroke();
}

function drawSideLabels(ctx, view, project, derived, geo, font, o) {
  const measures = measureIndex(project, derived);
  const missing = missingTest(project, derived, measures);
  const outliers = new Set(), misfits = new Set();
  for (const w of (derived && derived.warnings) || []) {
    if (w.type === 'outlier' && w.measureId) outliers.add(w.measureId);
    // Drawn length differs from the measure by more than the tolerance (확인필요 level).
    if (w.type === 'residual' && w.check && w.measureId) misfits.add(w.measureId);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of roomsOf(derived)) {
    if (!r.sides) continue;
    const notRoom = r.room && r.room.notRoom;
    for (const side of r.sides) {
      const m = measures.get(`${r.roomId}|${side.key}`);
      const hasValue = m && m.value != null;
      if (notRoom && !hasValue) continue;
      // A side fixed by its measured opposite side shows nothing (unless flagged 확인필요).
      if (!hasValue && !(m && m.check) && !missing(r.roomId, side.key)) continue;
      const fr = sideFrame(side, r.roomId, derived, geo);
      if (!fr) continue;
      // Skip labels on sides too short to read at this zoom.
      if (fr.L * view.scale < 18) continue;
      const text = hasValue ? formatPlain(m.value) : '?';
      const flag = m && m.check ? ' !' : '';
      ctx.font = canvasFont(font.measure, hasValue && !m.computed ? 'bold' : 'normal');
      const tw = ctx.measureText(text + flag).width;
      // Distance from the inner face to the label centre, in screen px: half the text extent
      // across the side, plus a small gap.
      const across = Math.abs(fr.n.x) * (tw / 2) + Math.abs(fr.n.y) * (font.measure * 0.6) + 5;
      const mid = { x: (fr.A.x + fr.B.x) / 2, y: (fr.A.y + fr.B.y) / 2 };
      const off = fr.inner + across / view.scale;
      const c = view.toScreen({ x: mid.x + fr.n.x * off, y: mid.y + fr.n.y * off });
      const isActive = o.activeSide && o.activeSide.roomId === r.roomId && o.activeSide.sideKey === side.key;
      if (isActive) {
        ctx.fillStyle = COLORS.activeSideBg;
        roundRect(ctx, c.x - tw / 2 - 5, c.y - font.measure * 0.75, tw + 10, font.measure * 1.5, 4);
        ctx.fill();
      }
      // A value computed from where a 구역 나누기 선 cuts a measured side (not typed): gray.
      ctx.fillStyle = hasValue ? (m.computed ? COMPUTED_COLOR : COLORS.measure) : COLORS.unmeasured;
      if (flag) {
        const mainW = ctx.measureText(text).width;
        ctx.textAlign = 'left';
        const x0 = c.x - tw / 2;
        ctx.fillText(text, x0, c.y);
        ctx.fillStyle = COLORS.check;
        ctx.font = canvasFont(font.measure, 'bold');
        ctx.fillText(flag, x0 + mainW, c.y);
        ctx.textAlign = 'center';
      } else {
        ctx.fillText(text, c.x, c.y);
      }
      const note = m && (outliers.has(m.id) ? '다시 확인' : misfits.has(m.id) ? '안 맞음' : '');
      if (note) {
        ctx.font = canvasFont(Math.max(10, font.measure - 2), 'bold');
        ctx.fillStyle = COLORS.outlier;
        const dy = font.measure * 1.1 * (fr.n.y < -0.5 ? -1 : 1);
        ctx.fillText(note, c.x, c.y + dy);
      }
    }
  }
}

// ---- screen text layer (level of detail) -------------------------------------------------------
//
// Every text the editor writes on the plan, laid out per zoom level in world mm (panning reuses the
// layout) and drawn in screen px. Items are placed in order of priority; each takes its first
// candidate spot that overlaps no text placed before it (2 px apart) and no column (solid black);
// window/door labels also keep off the walls; fixtures and stairs are avoided when a spot allows it.
// An item that finds no spot is left out until the user zooms in (shrunk spots come before that).
// Priority (2026-10-17): the value of the side being edited, room names (larger rooms first), texts
// placed by hand (labels, the H of a moved name), measured values, '?', names of unnamed rooms (gray),
// window/door labels, fixture labels, H.
// Labels moved by hand (project.labelOffsets, paper mm × print scale) sit at their base point + the
// offset, exactly where the print puts them (core/labels.js).
// Diagonal walls (request 2026-10-19): a diagonal side's value (or '?') is written along the side,
// upright (valueCandAlong; collisions by its turned rectangle), first among the values; diagonal walls
// are obstacles by their real outline (poly), not their bounding box; a room with a diagonal side puts
// its name where the whole block lies inside its inner faces (slantedNameCands).

const TEXT_GAP_PX = 2;
// Window/door spots beyond the per-side values (screen px / paper pt from the wall face): every depth
// from just past a horizontal wall's value (20) to past a wide value on a vertical wall (44); the first
// one with a value really between it and the wall is taken (valueBehind), so a stacked label sits
// right beyond that value. (Before 2026-10-24: [20, 38] for any wall, with or without a value.)
export const SIDE_VALUE_BAND_PX = [20, 26, 32, 38, 44];
const SCREEN_LABEL_PX = { opening: 12, fixture: 12 };
const MIN_LABEL_SCALE = 0.02;          // px per mm below which labels and H are left out
const FIXTURE_TEXT = '#111111';
const OPENING_TEXT = '#0070C0';
const PRIO = { active: 0, name: 1, moved: 1.5, value: 2, unknown: 2.4, placeholder: 2.5, opening: 3, fixture: 3.5, height: 4 };
// Paper ('치수선 없이'): the measured values are the content, so they go first (near their walls);
// texts placed by hand before them; then each room's name with its H finds a free spot in the room.
const PAPER_PRIO = { active: 0, moved: 0.8, value: 1, unknown: 1.1, name: 2, placeholder: 2.5, height: 2.1, opening: 3, fixture: 3.5 };

let textCache = null;

function drawScreenText(ctx, view, project, derived, geo, font, o) {
  if (!derived || (!o.labels && !o.sideLabels)) return;
  const key = {
    project, derived, scale: view.scale, labels: !!o.labels, sideLabels: !!o.sideLabels,
    openingLabels: !!o.openingLabels, fixtureLabels: !!o.fixtureLabels, notRoomLabels: !!o.notRoomLabels,
    wppm: o.worldPerPaperMM, roomLabel: o.roomLabel, obstacles: o.textObstacles, forceShow: o.forceShow,
    exclude: o.fixtureExclude || null,
    active: o.activeSide ? `${o.activeSide.roomId}|${o.activeSide.sideKey}` : '', font: JSON.stringify(font),
  };
  let layout = textCache && sameKeys(textCache.key, key) ? textCache.layout : null;
  if (!layout) {
    layout = layoutScreenText(ctx, view, project, derived, geo, font, o);
    textCache = { key, layout };
  }
  drawTextLayout(ctx, view, layout, o);
}

function sameKeys(a, b) {
  for (const k of Object.keys(b)) if (a[k] !== b[k]) return false;
  return true;
}

// → [{ it, c }] the items shown and the spot each took (world mm).
// o.paperText (drawPaperPlanText): font units are pt on paper; { labelPx: { opening, fixture } (pt),
// gapWorldPerPaperMM (the print scale) }. Then every item is placed (mustShow), unnamed rooms and '?'
// are left out, values are written as on the print (no bold, no 확인필요 marks, computed as '(1500)').
export function layoutScreenText(ctx, view, project, derived, geo, font, o) {
  const k = view.scale;
  const W = (px) => px / k;     // screen px → world mm
  const wppm = o.worldPerPaperMM > 0 ? o.worldPerPaperMM : 60;
  const paper = !!o.paperText;
  const LP = paper ? o.paperText.labelPx : SCREEN_LABEL_PX;
  const P = paper ? PAPER_PRIO : PRIO;
  const offsets = project.labelOffsets || {};
  const measure = (text, px, weight = 'normal') => {
    ctx.font = canvasFont(px, weight);
    return ctx.measureText(text).width;
  };
  const fixtures = fixtureObstacles(project);
  const columns = fixtures.filter((f) => f.column);
  const soft = fixtures.filter((f) => !f.column);
  let wallBoxes = [];
  // Diagonal walls by their real outline (poly; their bounding box would cover the rooms beside them).
  try { wallBoxes = wallPolygons(project, derived).map((w) => (w.orient === 'd' ? { ...w.box, poly: w.points } : w.box)); } catch (_) { wallBoxes = []; }
  const extra = Array.isArray(o.textObstacles) ? o.textObstacles.filter(Boolean) : [];
  const items = [];
  let order = 0;
  const add = (it) => { it.order = order++; it.gap = W(TEXT_GAP_PX); items.push(it); };
  const boxAt = (x, y, w, h, rot = 0) => {
    const v = rot === 90 || rot === -90;
    const bw = v ? h : w, bh = v ? w : h;
    return { minX: x - bw / 2, minY: y - bh / 2, maxX: x + bw / 2, maxY: y + bh / 2 };
  };
  // Very far out (12 px of text cover more than 600 mm of plan) only names and values are written:
  // labels and H would be as large as the rooms they belong to.
  const tiny = !paper && k < MIN_LABEL_SCALE;
  ctx.save();
  if (o.labels) addRooms();
  if (o.sideLabels) addValues();
  if (o.labels && !tiny && (o.openingLabels || o.fixtureLabels)) addLabels();
  ctx.restore();
  return resolveText(items);

  // Room names (+ H below), 실 아님 names, gray names of unnamed rooms.
  function addRooms() {
    const rooms = roomsOf(derived).filter((r) => r.labelPoint && r.room && r.face && Array.isArray(r.face.points));
    for (const r of rooms) {
      const room = r.room;
      const notRoom = !!room.notRoom;
      const named = !!room.name;
      // A named 실 아님 space is labelled by the fixtures layer unless the caller asks for it here.
      if (notRoom && named && !o.notRoomLabels) continue;
      // Paper: no gray '이름 없음' placeholders.
      if (paper && !named) continue;
      const base = roomBasePoint(r) || r.labelPoint;
      let text = room.name;
      if (!named) text = notRoom ? '실 아님' : ((typeof o.roomLabel === 'function' && o.roomLabel(r.roomId)) || '이름 없음');
      // Paper: room names in the print's normal weight (draw-labels.js).
      const style = named
        ? (notRoom ? { px: LP.fixture, weight: 'normal', color: FIXTURE_TEXT } : { px: font.name, weight: paper ? 'normal' : 'bold', color: COLORS.roomName })
        : { px: Math.round(font.name * 0.8), weight: 'normal', color: COLORS.roomNameEmpty };
      const hasH = !notRoom && room.height != null && room.height !== '' && isFinite(Number(room.height));
      const hText = hasH ? `H: ${formatPlain(Number(room.height))}` : '';
      const scan = (axis) => scanExtent(r.face.points, base, axis) || scanExtent(r.face.points, { x: base.x + 0.37, y: base.y + 0.37 }, axis);
      const ex = scan('x'), ey = scan('y');
      const freeW = ex ? (ex[1] - ex[0]) * k - 10 : Infinity;
      const freeH = ey ? (ey[1] - ey[0]) * k - 10 : Infinity;
      const tw = measure(text, style.px, style.weight);
      // A 실 아님 name turns in a tall narrow space (예시 세대 A 옷장).
      const rot = notRoom && named && tw > freeW && freeH > freeW ? -90 : 0;
      const avail = rot ? freeH : freeW;
      let scale = 1, texts = [text];
      if (tw > avail) {
        scale = Math.max(0.7, avail / tw);
        if (tw * scale > avail && named) {
          texts = wrapName(text);
          const wMax = Math.max(...texts.map((t) => measure(t, style.px, style.weight)));
          scale = Math.max(0.7, Math.min(1, avail / wMax));
        }
      }
      const key = `room:${r.roomId}`;
      const mk = (s, at) => roomCand(at, texts, style, s, rot, hText);
      let cands;
      const off = offsets[key];
      if (off && named) {
        cands = [mk(scale, { x: base.x + (Number(off.dx) || 0) * wppm, y: base.y + (Number(off.dy) || 0) * wppm })];
      } else {
        const c0 = mk(scale, base);
        const bw = c0.box.maxX - c0.box.minX, bh = c0.box.maxY - c0.box.minY;
        // Keep the whole name inside the room (the label point of a long narrow room can lie near
        // one end, and the screen text is large next to a small room).
        let spot = keepInside(r.face.points, base, bw, bh, W(4) + 80);
        if (fixtures.some((f) => boxesHit(boxAt(spot.x, spot.y, bw, bh), f))) {
          spot = findFreeSpot(r.face.points, bw, bh, spot, fixtures, { margin: W(4), step: Math.max(bh / 3, W(4)) });
        }
        cands = [mk(scale, spot)];
        if (scale * 0.85 >= 0.6) cands.push(mk(scale * 0.85, spot));
        // A room with a diagonal side (a triangle, a cut corner): spots where the whole block lies
        // inside the room, off the slanted walls, at this size and smaller (request 2026-10-19).
        const slanted = (r.sides || []).some((sd) => sd.orient === 'd');
        if (slanted) {
          const inner = slantedNameCands(r, base, scale, mk);
          if (inner.length) cands = inner;
        }
        // Paper: nothing may be left out, so a crowded room tries other spots and smaller sizes
        // before a name would be written over a value.
        let innerPoly = null;
        if (slanted) { try { innerPoly = roomInnerPolygon(r, project, derived); } catch (_) { innerPoly = null; } }
        if (paper) cands.push(...paperNameSpots(r.face.points, spot, scale, mk, innerPoly));
      }
      const id = `name:${r.roomId}`;
      const moved = !!(off && named);
      add({
        id, kind: 'name', key: named ? key : null, refId: r.roomId, base, cands,
        // Paper: a name placed by hand goes with the other texts placed by hand, before the values,
        // and its H right after it (review 0.5.0: the H came first, found no name and was lost).
        prio: named ? (paper && moved ? P.moved : P.name) : P.placeholder, sub: -(r.area || 0),
        mustShow: paper || o.forceShow === key, hard: columns.concat(extra), soft,
        boxOf: paper ? (c) => c.box : (c) => c.nameBox,
      });
      if (hText && !tiny) {
        add({
          // The H of a name placed by hand stays with it (before the values).
          id: `h:${r.roomId}`, kind: 'height', refId: r.roomId, prio: moved ? (paper ? P.moved + 0.05 : P.moved) : P.height, sub: 0, ignore: id,
          cands: (chosen) => (chosen.has(id) ? [chosen.get(id)] : []),
          mustShow: paper || o.forceShow === key, hard: columns.concat(extra), soft, boxOf: (c) => c.hBox,
        });
      }
    }
  }

  // The name block of a room centred at `at`: name line(s), then H (world mm).
  function roomCand(at, texts, style, s, rot, hText) {
    const px = style.px * s;
    const lineH = W(px * 1.2);
    const nameW = W(Math.max(...texts.map((t) => measure(t, px, style.weight))));
    const nameH = lineH * texts.length;
    const hPx = font.height * Math.max(0.8, s);
    const hH = hText ? W(hPx * 1.2) : 0;
    const hW = hText ? W(measure(hText, hPx)) : 0;
    // Turned (실 아님) names have no H.
    const nameC = rot ? { x: at.x, y: at.y } : { x: at.x, y: at.y - hH / 2 };
    const hC = { x: at.x, y: at.y + nameH / 2 };
    const nameBox = boxAt(nameC.x, nameC.y, nameW, nameH, rot);
    const hBox = hText ? boxAt(hC.x, hC.y, hW, hH) : null;
    const box = hBox ? unionBox(nameBox, hBox) : nameBox;
    return {
      x: at.x, y: at.y, rot, box, nameBox, hBox, nameC, hC,
      nameLines: texts.map((t) => ({ text: t, px, weight: style.weight, color: style.color })),
      hLine: hText ? { text: hText, px: hPx, weight: 'normal', color: COLORS.height } : null,
    };
  }

  // A room with a diagonal side: for each size (this, 0.85, 0.7 of it) the spot nearest the label
  // point where the name block lies inside the room, clear of its walls and the fixtures. → [cand]
  function slantedNameCands(r, base, scale, mk) {
    // The room inside its walls (each side's own wall and finish), 4 px in from them.
    let poly = null;
    try { poly = roomInnerPolygon(r, project, derived); } catch (_) { poly = null; }
    if (!poly) return [];
    const margin = W(4);
    const out = [];
    for (const s of [scale, scale * 0.85, scale * 0.7]) {
      if (s < 0.5) break;
      const c0 = mk(s, base);
      const bw = c0.box.maxX - c0.box.minX, bh = c0.box.maxY - c0.box.minY;
      const at = findFreeSpot(poly, bw, bh, base, fixtures, { margin, step: Math.max(bh / 3, W(4)) });
      if (boxInPolygon(poly, at, bw, bh, margin)) out.push(mk(s, { x: at.x, y: at.y }));
    }
    return out;
  }

  // Paper: more candidate spots for a room's name block — a grid over the room at the given scale,
  // then smaller (0.85, 0.7, 0.55), nearest to `spot` first; each kept inside the room (a room with a
  // diagonal side: only spots whose whole block lies inside its inner faces, inner, when there are such).
  function paperNameSpots(poly, spot, scale, mk, inner = null) {
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const out = [];
    for (const s of [scale, scale * 0.85, scale * 0.7, Math.min(scale * 0.7, 0.55)]) {
      const c0 = mk(s, spot);
      const bw = c0.box.maxX - c0.box.minX, bh = c0.box.maxY - c0.box.minY;
      let spots = [];
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 10; j++) {
          const at = { x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * j) / 10 };
          if (!pointInPolygon(at, poly)) continue;
          spots.push(keepInside(poly, at, bw, bh, W(1)));
        }
      }
      if (inner) {
        const inside = spots.filter((at) => boxInPolygon(inner, at, bw, bh, W(1)));
        if (inside.length) spots = inside;
      }
      spots.sort((a, b) => Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y));
      if (s !== scale) out.push(mk(s, spot));
      for (const at of spots) out.push(mk(s, at));
    }
    return out;
  }

  // A room with a diagonal side whose mean width (2 × area / perimeter, centre lines) is under 2.5
  // text heights of the values (paper; see addValues): a 600 mm deep bay at 1:50–1:60, not the
  // triangles of a 3 × 2.4 m room split corner to corner (they keep their values inside).
  function smallSlanted(r) {
    if (!(r.sides || []).some((sd) => sd.orient === 'd') || !r.face || !Array.isArray(r.face.points)) return false;
    const pts = r.face.points;
    let per = 0;
    for (let i = 0; i < pts.length; i++) per += Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
    const area = Math.abs(r.area || 0);
    return per > 0 && (2 * area) / per < 2.5 * W(font.measure * 1.2);
  }
  // A side all of whose walls have a room on one face only (the house outline).
  function outerSide(side) {
    const ids = (side.edgeIds || []).filter((id) => { const e = geo.edgeById.get(id); return e && e.edge && e.edge.kind !== 'divider'; });
    return ids.length > 0 && ids.every((id) => {
      const pair = derived.edgeFaces && derived.edgeFaces.get(id);
      return pair && (pair[0] == null) !== (pair[1] == null);
    });
  }

  // Each side's measured value (or '?') inside the room, near the side.
  function addValues() {
    const measures = measureIndex(project, derived);
    const missing = missingTest(project, derived, measures);
    const outliers = new Set(), misfits = new Set();
    for (const w of derived.warnings || []) {
      if (w.type === 'outlier' && w.measureId) outliers.add(w.measureId);
      if (w.type === 'residual' && w.check && w.measureId) misfits.add(w.measureId);
    }
    for (const r of roomsOf(derived)) {
      if (!r.sides) continue;
      const notRoom = r.room && r.room.notRoom;
      for (const side of r.sides) {
        const m = measures.get(`${r.roomId}|${side.key}`);
        const hasValue = !!(m && m.value != null);
        if (notRoom && !hasValue) continue;
        // Paper: measured (and computed) values only.
        if (paper && !hasValue) continue;
        // A side fixed by its measured opposite side shows nothing (unless flagged 확인필요).
        if (!hasValue && !(m && m.check) && !missing(r.roomId, side.key)) continue;
        const fr = sideFrame(side, r.roomId, derived, geo);
        if (!fr) continue;
        // Skip labels on sides too short to read at this zoom (paper: nothing is left out).
        if (!paper && fr.L * k < 18) continue;
        const active = !!(o.activeSide && o.activeSide.roomId === r.roomId && o.activeSide.sideKey === side.key);
        const v = paper ? {
          // As the printed dimension numbers: the blue, normal weight; a computed part in brackets.
          text: m.computed ? `(${formatPlain(m.value)})` : formatPlain(m.value),
          flag: '', bold: false, color: COLORS.measure, note: '', active: false, noteSign: 1,
          halo: true,   // readable where it crosses a door swing or a window line
        } : {
          text: hasValue ? formatPlain(m.value) : '?',
          flag: m && m.check ? ' !' : '',
          bold: hasValue && !m.computed,
          color: hasValue ? (m.computed ? COMPUTED_COLOR : COLORS.measure) : COLORS.unmeasured,
          note: m ? (outliers.has(m.id) ? '다시 확인' : misfits.has(m.id) ? '안 맞음' : '') : '',
          active, noteSign: fr.n.y < -0.5 ? -1 : 1,
        };
        // A diagonal side: the value written along it, upright (request 2026-10-19), like the
        // dimension of a diagonal side on the print.
        const along = side.orient === 'd' || (Math.abs(fr.dir.x) > 1e-3 && Math.abs(fr.dir.y) > 1e-3);
        const mk = (s, shift, extra = 0) => (along ? valueCandAlong(v, fr, s, shift, extra) : valueCand(v, fr, s, shift, extra));
        const cands = [mk(1, 0), mk(0.85, 0)];
        // Long sides: also a quarter of the way along (off a column standing at the middle).
        if (!active && fr.L * k > 120) cands.push(mk(1, fr.L / 4), mk(1, -fr.L / 4));
        // A sink or cupboard standing against this side: just in front of it (verifier 0.4.0: the
        // 예시 세대 A 주방 2800 was written on the 싱크대).
        const front = frontOfFixtures(fr, cands[0].box, soft);
        if (front > 0) cands.push(mk(1, 0, front), mk(0.85, 0, front));
        const tw0 = W(measure(v.text, font.measure));
        if (paper) {
          // Paper (nothing is left out): along the side, as long as the number stays on it (a
          // diagonal side, often the long side of a small triangle: finer steps too).
          const half = (fr.L - fr.t) / 2 - tw0 / 2;
          const steps = along ? [fr.L / 8, -fr.L / 8, fr.L / 4, -fr.L / 4, fr.L / 3, -fr.L / 3] : [fr.L / 4, -fr.L / 4, fr.L / 3, -fr.L / 3];
          for (const sh of steps) {
            if (Math.abs(sh) <= half) cands.push(mk(1, sh), mk(0.85, sh));
          }
        }
        // Last: smaller (a crowded small room), before the value is left out at this zoom.
        cands.push(mk(0.7, 0));
        if (paper) {
          for (const sh of along ? [fr.L / 8, -fr.L / 8, fr.L / 4, -fr.L / 4] : [fr.L / 4, -fr.L / 4]) cands.push(mk(0.7, sh));
          cands.push(mk(0.55, 0), mk(0.55, fr.L / 4), mk(0.55, -fr.L / 4));
          // A side shorter than its number (a 120 step): just past either end, along the side (not
          // along a diagonal side: past its ends lie the sharp corners of the room).
          if (tw0 > fr.L - fr.t && !along) {
            const past = fr.L / 2 + tw0 / 2 + W(3);
            cands.push(mk(0.85, past), mk(0.85, -past), mk(0.7, past), mk(0.7, -past));
          }
          // In a room with a diagonal side (a shallow bay, a cut corner) an h / v side's value may be
          // turned along its side as well, which takes one text height across it, not its width
          // (fixer 2026-10-20, field: after a turn the 600 mm deep bay's base 1597 found no spot
          // inside and went over the bay's window, outside the room). Last, so plans without
          // diagonal walls (예시 세대 A) never get them.
          if (!along && (r.sides || []).some((sd) => sd.orient === 'd')) {
            for (const s of [1, 0.85, 0.7]) cands.push(valueCandAlong(v, fr, s, 0), valueCandAlong(v, fr, s, fr.L / 4), valueCandAlong(v, fr, s, -fr.L / 4));
          }
        }
        // A value along a diagonal side never sits on a wall when any spot is clear of the walls
        // (its shifted spots run into the sharp corners of a triangle room).
        let vCands = cands;
        if (along) {
          const clear = cands.filter((c) => !wallBoxes.some((wb) => obstacleHit(c.box, c.shape, wb)));
          if (clear.length) vCands = clear;
        }
        // Paper, a small room with a diagonal side (a bay 600 deep has room for its name and one
        // value, not four): an outer wall's value goes just outside that wall first, beside it, so the
        // inside keeps the name and the inner walls' values (fixer 2026-10-20, field: the bay's 739 /
        // 1597 / 580 crowded inside, 739 away from its wall, and after a turn 1597 over the window).
        if (paper && smallSlanted(r) && outerSide(side)) {
          const out = (s, shift) => (along ? valueCandAlong(v, fr, s, shift, 0, true) : valueCand(v, fr, s, shift, 0, true));
          vCands = [out(1, 0), out(1, fr.L / 4), out(1, -fr.L / 4), out(0.85, 0)].concat(vCands);
        }
        add({
          id: `v:${r.roomId}|${side.key}`, kind: 'value', refId: r.roomId, v, cands: vCands,
          // A diagonal side's value first among the values (the long side of a triangle has the
          // fewest free spots).
          prio: active ? P.active : (hasValue ? P.value : P.unknown), sub: along ? -0.1 : 0,
          // Paper: walls are avoided too where a spot allows it (a number on a black wall is lost).
          mustShow: paper || active, hard: columns, soft: paper ? soft.concat(wallBoxes) : soft,
        });
      }
    }
    if (paper) addSpanTotals();
  }

  // Paper: a value measured across a 구역 나누기 선 or a wall (a span, DESIGN.md §7.7 / §7.9) belongs
  // to no single room side, so it is written once as '전체 5000', in the longest part's room, one band
  // further in than that side's own value (review 0.5.0: the measured total was missing on paper).
  function addSpanTotals() {
    const byRoom = new Map(roomsOf(derived).map((r) => [r.roomId, r]));
    for (const sp of derived.spans || []) {
      if (!sp || sp.value == null || !(sp.value > 0) || !Array.isArray(sp.parts) || !sp.parts.length) continue;
      const part = sp.parts.reduce((a, b) => ((b.exact || 0) > (a.exact || 0) ? b : a));
      const dr = byRoom.get(part.roomId);
      const side = dr && dr.sides && (dr.sides[part.sideIndex] && dr.sides[part.sideIndex].key === part.sideKey
        ? dr.sides[part.sideIndex] : dr.sides.find((s) => s.key === part.sideKey));
      if (!side) continue;
      const fr = sideFrame(side, part.roomId, derived, geo);
      if (!fr) continue;
      const v = { text: `전체 ${formatPlain(sp.value)}`, flag: '', bold: false, color: COLORS.measure, note: '', active: false, noteSign: 1, halo: true };
      const band = W(font.measure * 1.35 + 3);
      const mk = (s, shift, extra = band) => valueCand(v, fr, s, shift, extra);
      const cands = [mk(1, 0), mk(0.85, 0), mk(1, fr.L / 4), mk(1, -fr.L / 4), mk(1, 0, 2 * band), mk(0.7, 0), mk(0.7, fr.L / 4), mk(0.7, -fr.L / 4)];
      add({
        id: `t:${sp.measureId}`, kind: 'value', refId: part.roomId, v, cands,
        prio: P.value, sub: 0.5, mustShow: true, hard: columns, soft: soft.concat(wallBoxes),
      });
    }
  }

  // How far (mm, from the inner face) the fixtures under a value's spot reach into the room, so the
  // value can sit just in front of them; 0 when none is in the way.
  function frontOfFixtures(fr, box, list) {
    let reach = 0;
    for (const f of list) {
      if (!boxesHit(box, f)) continue;
      const corners = [[f.minX, f.minY], [f.maxX, f.minY], [f.minX, f.maxY], [f.maxX, f.maxY]];
      const far = Math.max(...corners.map(([x, y]) => (x - fr.A.x) * fr.n.x + (y - fr.A.y) * fr.n.y));
      reach = Math.max(reach, far - fr.inner);
    }
    return reach > 0 ? reach + W(3) : 0;
  }

  function valueCand(v, fr, s, shift, extra = 0, outside = false) {
    const px = font.measure * s;
    const tw = measure(v.text + v.flag, px, v.bold ? 'bold' : 'normal');
    // Distance from the inner face to the label centre, in screen px: half the text extent across
    // the side, plus a small gap (extra: past a fixture standing against the side, mm). outside: as
    // far beyond the wall's outer face instead (an outer wall of a small room, paper).
    const across = Math.abs(fr.n.x) * (tw / 2) + Math.abs(fr.n.y) * (px * 0.6) + 5;
    const off = outside ? -fr.t / 2 - W(across) : fr.inner + extra + W(across);
    const mid = { x: (fr.A.x + fr.B.x) / 2 + fr.dir.x * shift, y: (fr.A.y + fr.B.y) / 2 + fr.dir.y * shift };
    const c = { x: mid.x + fr.n.x * off, y: mid.y + fr.n.y * off };
    let box = boxAt(c.x, c.y, W(tw + (v.active ? 10 : 0)), W(px * (v.active ? 1.5 : 1.2)));
    let noteC = null, notePx = 0;
    if (v.note) {
      notePx = Math.max(10, font.measure - 2) * s;
      noteC = { x: c.x, y: c.y + W(font.measure * s * 1.1) * v.noteSign };
      box = unionBox(box, boxAt(noteC.x, noteC.y, W(measure(v.note, notePx, 'bold')), W(notePx * 1.2)));
    }
    return { x: c.x, y: c.y, px, tw, box, noteC, notePx };
  }

  // A value written along a diagonal side: turned to the side (upright), its centre half its height
  // + 5 px inside the inner face (as valueCand for a horizontal side); the note goes further in.
  // Collisions use `shape` (the turned rectangles); overlap areas `parts` (small boxes along them).
  function valueCandAlong(v, fr, s, shift, extra = 0, outside = false) {
    const px = font.measure * s;
    const tw = measure(v.text + v.flag, px, v.bold ? 'bold' : 'normal');
    const rot = uprightAngle(fr.dir);
    const w = W(tw + (v.active ? 10 : 0)), h = W(px * (v.active ? 1.5 : 1.2));
    const off = outside ? -fr.t / 2 - W(px * 0.6 + 5) : fr.inner + extra + W(px * 0.6 + 5);
    const mid = { x: (fr.A.x + fr.B.x) / 2 + fr.dir.x * shift, y: (fr.A.y + fr.B.y) / 2 + fr.dir.y * shift };
    const c = { x: mid.x + fr.n.x * off, y: mid.y + fr.n.y * off };
    let poly = rotatedRect(c, rot, w, h);
    const shape = [poly];
    let parts = rotatedRectParts(c, rot, w, h);
    // Which way "into the room" is in the text's own frame (its y axis is (-sin, cos)).
    const noteSign = fr.n.x * -Math.sin(rot) + fr.n.y * Math.cos(rot) < 0 ? -1 : 1;
    let noteC = null, notePx = 0;
    if (v.note) {
      notePx = Math.max(10, font.measure - 2) * s;
      const d = W(font.measure * s * 1.1);
      noteC = { x: c.x + fr.n.x * d, y: c.y + fr.n.y * d };
      const nw = W(measure(v.note, notePx, 'bold')), nh = W(notePx * 1.2);
      const np = rotatedRect(noteC, rot, nw, nh);
      shape.push(np);
      poly = poly.concat(np);
      parts = parts.concat(rotatedRectParts(noteC, rot, nw, nh));
    }
    return { x: c.x, y: c.y, px, tw, box: boxOf(poly), shape, parts, rot, noteSign, noteC, notePx };
  }

  // Window/door and fixture labels (core/labels.js candidates, in screen sizes).
  function addLabels() {
    const labels = placeLabels(project, derived, {
      fonts: { name: font.name, height: font.height, opening: LP.opening, fixture: LP.fixture },
      // Gaps keep their 1:60 size on screen whatever the print scale; only texts moved by hand use the
      // print scale (so they land where the print puts them). Before, moving one text changed the
      // print scale used here and other labels moved on the screen. Paper: the printed scale.
      worldPerUnit: 1 / k, worldPerPaperMM: paper ? o.paperText.gapWorldPerPaperMM : 60, offsetWorldPerPaperMM: wppm,
      measure: (text, size, weight) => measure(text, size, weight),
      include: { rooms: false, openings: !!o.openingLabels, fixtures: !!o.fixtureLabels },
      withCandidates: true,
      extraDepth: o.sideLabels ? SIDE_VALUE_BAND_PX.map(W) : 0,
      fixtureBoxes: fixtures, obstacles: extra,
    });
    for (const l of labels) {
      if (l.kind === 'fixture' && o.fixtureExclude && l.refId === o.fixtureExclude) continue;
      const opening = l.kind === 'opening';
      // Zoomed far out, a label pushed away from its window / door (or fixture) would read as
      // someone else's: only spots near it count; otherwise it waits for a closer zoom.
      // Window / door spots attached to their opening (core/labels.js openingLabelFit: right at the
      // wall face, or just beyond a door's swing on the side it opens into) are near at every zoom;
      // the spots beyond the per-side values only within 48 px.
      const near = (c) => {
        if (l.moved || paper) return true;
        if (opening && c.attached) return true;
        if (opening) return distToBox(l.base, c.box) <= (l.span || 0) / 2 + W(48);
        const own = fixtures.find((f) => f.id === l.refId);
        return !own || boxGap(own, c.box) <= W(24);
      };
      const cands = (l.cands || []).filter(near).map((c) => ({ ...c, rotDeg: c.rot }));
      if (!cands.length) continue;
      // Other fixtures (a sink, a stair) block these labels on screen: with no free spot near its
      // window / door the label waits for a closer zoom instead of being written over the fixture
      // (plan §2-7 / 0.4.0 (f), (j)). A label placed by hand stays where it was put.
      const others = opening ? soft : soft.filter((f) => f.id !== l.refId);
      // Window / door labels keep off the other doors' swings where a spot allows it (l.avoid).
      const swings = opening && !l.moved && Array.isArray(l.avoid) ? l.avoid : [];
      // When every spot overlaps something (paper; the text being dragged), the least overlapping
      // ATTACHED one is taken, never one beyond the per-side values, and one that reads as another
      // opening's label (core/labels.js misleading) only when there is no other.
      const attached = opening ? cands.filter((c) => c.attached !== false) : null;
      const clean = attached ? attached.filter((c) => !c.misleading) : null;
      // A stacked spot (beyond the per-side values) only where a value of that wall was really
      // written between it and the wall (checker 2026-10-24: without one, e.g. beyond a 옷장 or outside
      // an exterior wall, the label floated 8–15 paper mm from its opening, as the user's complaint).
      // (Checked lazily, in groupsOf, only when no attached spot is free; with no attached spot at all
      // the whole list is filtered at once.)
      const stackOk = (chosen) => { const vals = valueBoxes(chosen); return (c) => !c.stack || valueBehind(c, l, vals); };
      const pick = attached && !attached.length && cands.some((c) => c.stack) ? (chosen) => cands.filter(stackOk(chosen)) : cands;
      add({
        id: l.key, kind: l.kind, key: l.key, refId: l.refId, base: l.base, cands: pick, halo: !!l.halo,
        // A label placed by hand is wanted where it is: it goes before the values.
        prio: l.moved ? P.moved : (opening ? P.opening : P.fixture), sub: 0,
        mustShow: paper || o.forceShow === l.key,
        // A label moved by hand shows where it was put, as on paper, also over a wall (checker
        // 2026-10-24: one dragged partly onto a wall vanished from the screen but still printed).
        hard: (opening && !l.moved ? columns.concat(wallBoxes, extra) : columns.concat(extra)).concat(l.moved ? [] : others),
        soft: (l.moved ? others.concat(opening ? wallBoxes : []) : []).concat(swings),
        fallback: clean && clean.length ? clean : attached && attached.length ? attached : null,
        // Tried in this order in each pass: the attached spots; the stacked spots (only beyond a
        // value, see pick); the spots that read as another opening's label. When no attached spot
        // is free because ONE per-side value takes it, that value moves along its wall instead
        // (resolveText displaceValue), before any stacked spot.
        groupsOf: opening && !l.moved
          ? (cs, chosen) => [
            cs.filter((c) => c.attached !== false && !c.misleading),
            () => cs.filter((c) => c.attached === false).filter(stackOk(chosen)),
            () => cs.filter((c) => c.attached !== false && c.misleading),
          ]
          : null,
        displace: opening && !l.moved,
        stillValid: opening ? (c, chosen) => !c.stack || valueBehind(c, l, valueBoxes(chosen)) : null,
      });
    }
  }

  // The boxes of the per-side values placed so far (items 'v:…', and span totals 't:…').
  function valueBoxes(chosen) {
    const out = [];
    for (const [id, v] of chosen) if (v && v.box && /^[vt]:/.test(id)) out.push(v.box);
    return out;
  }

  // True when one of the value boxes `vals` lies between the wall and the stacked spot c of window /
  // door label l (c.stack: its side n, the wall face and its near edge, mm from the wall's centre
  // line), under c along the wall.
  function valueBehind(c, l, vals) {
    const P = l.base, d = l.dir, n = c.stack && c.stack.n;
    if (!P || !d || !n || !c.box) return false;
    const proj = (b) => {
      let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
      for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
        const a = (x - P.x) * d.x + (y - P.y) * d.y, q = (x - P.x) * n.x + (y - P.y) * n.y;
        if (a < a0) a0 = a;
        if (a > a1) a1 = a;
        if (q < c0) c0 = q;
        if (q > c1) c1 = q;
      }
      return { a0, a1, c0, c1 };
    };
    const L = proj(c.box), eps = W(2);
    for (const vb of vals) {
      const V = proj(vb);
      if (V.c0 >= c.stack.face - eps && V.c1 <= L.c0 + eps && V.a0 < L.a1 && V.a1 > L.a0) return true;
    }
    return false;
  }
}

function unionBox(a, b) {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

// Distance from a point to a box (0 inside), and the gap between two boxes (0 when they touch).
function distToBox(p, b) {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX), dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}
function boxGap(a, b) {
  const dx = Math.max(a.minX - b.maxX, 0, b.minX - a.maxX), dy = Math.max(a.minY - b.maxY, 0, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

// Moves a w × h box centred at p (world mm) along x, then y, so that it lies inside the polygon's
// free extent through it, `margin` from the outline, where the room is wide / tall enough for it.
function keepInside(poly, p, w, h, margin) {
  const out = { x: p.x, y: p.y };
  const fit = (axis, half) => {
    const ext = scanExtent(poly, out, axis) || scanExtent(poly, { x: out.x + 0.37, y: out.y + 0.37 }, axis);
    if (!ext) return;
    const lo = ext[0] + margin + half, hi = ext[1] - margin - half;
    if (lo <= hi) out[axis] = Math.min(hi, Math.max(lo, out[axis]));
  };
  fit('x', w / 2);
  fit('y', h / 2);
  return out;
}

// Places the items in priority order (see the section comment). → [{ it, c }]
// A candidate may carry `shape` (a text turned along a diagonal side: its turned rectangles, with
// `parts`, small boxes along them, for overlap areas) and an obstacle a `poly` (a diagonal wall's
// outline): then those decide, after the bounding boxes.
// it.groupsOf(cands, chosen) (window / door labels): the candidates in groups (arrays, or functions
// giving one when first reached) tried in order within each pass (attached spots, stacked spots,
// misleading spots). it.displace: after the first group of pass 0, a
// per-side value that alone takes the label's spot may move to another of its own spots (displaceValue).
function resolveText(items) {
  items.sort((a, b) => a.prio - b.prio || a.sub - b.sub || a.order - b.order);
  const placed = [];
  const shown = [];
  const chosen = new Map();
  const itemOf = new Map();
  for (const it of items) {
    const cands = typeof it.cands === 'function' ? it.cands(chosen) : it.cands;
    if (!cands || !cands.length) continue;
    const boxOf = it.boxOf || ((c) => c.box);
    const shapeOf = it.boxOf ? () => null : (c) => c.shape || null;
    const partsOf = it.boxOf ? () => null : (c) => c.parts || null;
    let pick = null;
    const ignore = it.ignore || null;
    // A group may be a function: its candidates are worked out when it is first reached.
    const groups = typeof it.groupsOf === 'function' ? it.groupsOf(cands, chosen) : [cands];
    const groupAt = (g) => (typeof groups[g] === 'function' ? (groups[g] = groups[g]()) : groups[g]);
    search: for (const pass of [0, 1]) {
      for (let g = 0; g < groups.length; g++) {
        for (const c of groupAt(g)) {
          const b = boxOf(c);
          if (!b) continue;
          const sh = shapeOf(c);
          if (placed.some((p) => p.id !== ignore && pairHit(b, sh, p.box, p.shape, it.gap))) continue;
          if (it.hard.some((h) => obstacleHit(b, sh, h))) continue;
          if (pass === 0 && it.soft.some((o) => obstacleHit(b, sh, o))) continue;
          pick = c;
          break search;
        }
        if (pass === 0 && g === 0 && it.displace) {
          pick = displaceValue(it, groupAt(0), placed, chosen, shown, itemOf);
          if (pick) break search;
        }
      }
    }
    // Nothing free: the spot that overlaps least (columns count four times), not simply the first
    // (review 0.5.0: on paper, where everything is shown, crowded rooms piled texts on one spot).
    // it.fallback: the candidates this choice may take (window / door labels: the attached ones).
    if (!pick && it.mustShow) pick = leastOverlap(it.fallback || cands, boxOf, placed, it, partsOf);
    if (!pick) continue;
    chosen.set(it.id, pick);
    itemOf.set(it.id, it);
    placed.push({ id: it.id, box: boxOf(pick), shape: shapeOf(pick), parts: partsOf(pick) });
    shown.push({ it, c: pick });
  }
  return shown;
}

// A window / door label (it) none of whose own spots (cands, in order) is free: the first spot that is
// clear of everything but ONE per-side value already placed, when that value has another spot of its
// own (at least 85 % of its size, along its wall) clear of everything, the label's box included, and
// moving it leaves every stacked label placed before with a value between it and its wall
// (it.stillValid). The value is moved (placed / chosen / shown updated) and that label spot returned.
// (Checker 2026-10-24: in 치수선 없이 a wall's value sat at its middle, exactly where the label of a
// window in the middle of that wall belongs; the label then went beyond the value or onto it.)
function displaceValue(it, cands, placed, chosen, shown, itemOf) {
  for (const c of cands) {
    const b = c.box;
    if (!b || c.shape) continue;
    if (it.hard.some((h) => obstacleHit(b, null, h)) || it.soft.some((o) => obstacleHit(b, null, o))) continue;
    const blockers = placed.filter((p) => p.id !== it.ignore && pairHit(b, null, p.box, p.shape, it.gap));
    if (blockers.length !== 1) continue;
    const p = blockers[0];
    const vi = itemOf.get(p.id);
    if (!vi || vi.kind !== 'value' || !Array.isArray(vi.cands) || (vi.v && vi.v.active)) continue;
    const cur = chosen.get(p.id);
    const maxPx = vi.cands[0] && vi.cands[0].px;
    const gap = Math.max(vi.gap || 0, it.gap || 0);
    for (const vc of vi.cands) {
      if (vc === cur || !vc.box) continue;
      if (maxPx && vc.px < 0.84 * maxPx) continue;
      const vs = vc.shape || null;
      if (pairHit(vc.box, vs, b, null, gap)) continue;
      if (placed.some((q) => q.id !== p.id && pairHit(vc.box, vs, q.box, q.shape, vi.gap))) continue;
      if (vi.hard.some((h) => obstacleHit(vc.box, vs, h)) || vi.soft.some((o) => obstacleHit(vc.box, vs, o))) continue;
      chosen.set(p.id, vc);
      if (!shown.every((s) => typeof s.it.stillValid !== 'function' || s.it.stillValid(s.c, chosen))) {
        chosen.set(p.id, cur);
        continue;
      }
      p.box = vc.box;
      p.shape = vs;
      p.parts = vc.parts || null;
      const sv = shown.find((s) => s.it.id === p.id);
      if (sv) sv.c = vc;
      return c;
    }
  }
  return null;
}

// Two placed texts: their boxes, then (a turned text) their turned rectangles.
function pairHit(b, shape, pb, pshape, pad) {
  if (!boxesHit(b, pb, pad)) return false;
  if (!shape && !pshape) return true;
  const A = shape || [boxPoints(b)], B = pshape || [boxPoints(pb)];
  return A.some((x) => B.some((y) => convexOverlap(x, y, pad)));
}

// A text and an obstacle box (or a diagonal wall's outline, ob.poly).
function obstacleHit(b, shape, ob) {
  if (!boxesHit(b, ob)) return false;
  if (!shape && !ob.poly) return true;
  const B = ob.poly || boxPoints(ob);
  return (shape || [boxPoints(b)]).some((x) => convexOverlap(x, B));
}

function overlapArea(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX), h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

// Overlap of a text (box, or its parts) with a box or a diagonal wall's outline.
function shapeOverlap(b, parts, ob, obParts = null) {
  if (!parts && !obParts && !ob.poly) return overlapArea(b, ob);
  let s = 0;
  for (const x of parts || [b]) {
    if (ob.poly) s += polygonBoxArea(ob.poly, x);
    else for (const y of obParts || [ob]) s += overlapArea(x, y);
  }
  return s;
}

function leastOverlap(cands, boxOf, placed, it, partsOf = () => null) {
  let best = cands[0], bestCost = Infinity;
  for (const c of cands) {
    const b = boxOf(c);
    if (!b) continue;
    const parts = partsOf(c);
    let cost = 0;
    for (const p of placed) if (p.id !== it.ignore) cost += shapeOverlap(b, parts, p.box, p.parts);
    for (const h of it.hard) cost += 4 * shapeOverlap(b, parts, h);
    for (const s of it.soft) cost += 0.25 * shapeOverlap(b, parts, s);
    if (cost < bestCost - 1e-9) { bestCost = cost; best = c; }
  }
  return best;
}

function drawTextLayout(ctx, view, shown, o) {
  const toPx = (p) => view.toScreen(p);
  const pxBox = (b) => {
    const p = toPx({ x: b.minX, y: b.minY }), q = toPx({ x: b.maxX, y: b.maxY });
    return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y };
  };
  const roomBoxes = new Map();   // roomId → { item, c, boxes }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { it, c } of shown) {
    if (Array.isArray(o.textItems)) {
      const b = it.kind === 'name' ? c.nameBox : it.kind === 'height' ? c.hBox : c.box;
      o.textItems.push({ kind: it.kind, refId: it.refId, key: it.key || null, ...pxBox(b) });
    }
    if (it.kind === 'name') {
      drawLines(ctx, toPx(c.nameC), c.rot, c.nameLines, false);
      if (Array.isArray(o.nameBoxes)) o.nameBoxes.push({ roomId: it.refId, ...pxBox(c.nameBox) });
      if (it.key) roomBoxes.set(it.refId, { it, c, box: c.nameBox });
    } else if (it.kind === 'height') {
      drawLines(ctx, toPx(c.hC), 0, [c.hLine], false);
      const rb = roomBoxes.get(it.refId);
      if (rb) rb.box = unionBox(rb.box, c.hBox);
    } else if (it.kind === 'value') {
      drawValue(ctx, toPx(c), it.v, c);
    } else {
      drawLines(ctx, toPx(c), c.rotDeg || 0, c.lines.map((l) => ({ text: l.text, px: l.size, weight: l.weight, color: l.color })), it.halo);
      if (Array.isArray(o.textBoxes)) {
        o.textBoxes.push({ key: it.key, kind: it.kind, refId: it.refId, ...pxBox(c.box), base: it.base, center: { x: c.x, y: c.y } });
      }
    }
  }
  if (Array.isArray(o.textBoxes)) {
    for (const { it, c, box } of roomBoxes.values()) {
      o.textBoxes.push({ key: it.key, kind: 'room', refId: it.refId, ...pxBox(box), base: it.base, center: { x: c.x, y: c.y } });
    }
  }
  ctx.restore();
}

// Lines centred at screen point p, turned by rot degrees (0, -90, 90).
function drawLines(ctx, p, rot, lines, halo) {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  const heights = lines.map((l) => l.px * 1.2);
  let y = -heights.reduce((s, h) => s + h, 0) / 2;
  lines.forEach((l, i) => {
    ctx.font = canvasFont(l.px, l.weight || 'normal');
    const cy = y + heights[i] / 2;
    if (halo) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(2, l.px * 0.28);
      ctx.lineJoin = 'round';
      ctx.strokeText(l.text, 0, cy);
    }
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, 0, cy);
    y += heights[i];
  });
  ctx.restore();
}

function drawValue(ctx, c, v, cand) {
  if (cand.rot) {
    // Along a diagonal side: the same drawing in the text's own turned frame.
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(cand.rot);
    drawValue(ctx, { x: 0, y: 0 }, { ...v, noteSign: cand.noteSign }, { ...cand, rot: 0 });
    ctx.restore();
    return;
  }
  const px = cand.px;
  const tw = cand.tw;
  if (v.active) {
    ctx.fillStyle = COLORS.activeSideBg;
    roundRect(ctx, c.x - tw / 2 - 5, c.y - px * 0.75, tw + 10, px * 1.5, 4);
    ctx.fill();
  }
  ctx.font = canvasFont(px, v.bold ? 'bold' : 'normal');
  if (v.halo && !v.flag) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, px * 0.22);
    ctx.lineJoin = 'round';
    ctx.strokeText(v.text, c.x, c.y);
  }
  // A value computed from where a 구역 나누기 선 cuts a measured side (not typed): gray.
  ctx.fillStyle = v.color;
  if (v.flag) {
    const mainW = ctx.measureText(v.text).width;
    ctx.textAlign = 'left';
    const x0 = c.x - tw / 2;
    ctx.fillText(v.text, x0, c.y);
    ctx.fillStyle = COLORS.check;
    ctx.font = canvasFont(px, 'bold');
    ctx.fillText(v.flag, x0 + mainW, c.y);
    ctx.textAlign = 'center';
  } else {
    ctx.fillText(v.text, c.x, c.y);
  }
  if (v.note && cand.noteC) {
    ctx.font = canvasFont(cand.notePx, 'bold');
    ctx.fillStyle = COLORS.outlier;
    const dy = px * 1.1 * v.noteSign;
    ctx.fillText(v.note, c.x, c.y + dy);
  }
}

// [출력] 종류 '치수선 없이' (user 2026-10-18: "치수선 보기를 끈 화면 그대로 뽑고 싶다"): on paper, the
// texts of the editor without 치수선 보기 — room names with H, each side's measured value inside the
// room near its wall, window/door, fixture and 실 아님 labels — placed by the same text layer as the
// screen, at paper sizes (font units = pt: the context is scaled by canvas px per pt). Nothing is left
// out (paperText: every item mustShow). opts: the paper draw options of output.js renderPaper
// ({ toPx, pxPerMM, paper: { pxPerPaperMM, scale }, offsetScale }). → the shown items
export function drawPaperPlanText(ctx, project, derived, opts) {
  if (!project || !derived || !opts || !opts.paper || typeof opts.toPx !== 'function') return [];
  const pxPerPt = opts.paper.pxPerPaperMM * PT_MM;
  if (!(pxPerPt > 0) || !(opts.pxPerMM > 0)) return [];
  const view = {
    scale: opts.pxPerMM / pxPerPt,
    toScreen: (p) => { const q = opts.toPx(p); return { x: q.x / pxPerPt, y: q.y / pxPerPt }; },
  };
  const font = { name: PAPER_STYLE.namePt, height: PAPER_STYLE.heightPt, measure: PAPER_STYLE.valuePt };
  const o = {
    ...DEFAULTS, mode: 'paper', labels: true, sideLabels: true,
    openingLabels: true, fixtureLabels: true, notRoomLabels: true,
    // Texts moved by hand: paper mm at the automatic print scale, as the editor and the full drawing.
    worldPerPaperMM: opts.offsetScale > 0 ? opts.offsetScale : opts.paper.scale,
    paperText: {
      labelPx: { opening: PAPER_STYLE.openingPt, fixture: PAPER_STYLE.fixturePt },
      gapWorldPerPaperMM: opts.paper.scale,
    },
  };
  const geo = buildGeometry(project, derived);
  let shown = [];
  ctx.save();
  try {
    ctx.scale(pxPerPt, pxPerPt);
    shown = layoutScreenText(ctx, view, project, derived, geo, font, o);
    drawTextLayout(ctx, view, shown, o);
  } finally {
    ctx.restore();
  }
  return shown;
}

function drawWallChecks(ctx, view, project, geo, font) {
  for (const wc of project.wallChecks || []) {
    const item = geo.edgeById.get(wc.edge);
    if (!item) continue;
    const p = view.toScreen({ x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 });
    ctx.fillStyle = COLORS.check;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = canvasFont(Math.max(11, font.measure - 1), 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', p.x, p.y + 0.5);
  }
}

function drawNodeMark(ctx, view, p, color) {
  if (!p) return;
  const s = view.toScreen(p);
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function pill(ctx, x, y, text, bg, fg, centered = false) {
  ctx.font = canvasFont(13, 'bold');
  const tw = ctx.measureText(text).width;
  const pw = tw + 16, ph = 24;
  const px = centered ? x - pw / 2 : x;
  const py = centered ? y - ph / 2 : y;
  ctx.fillStyle = bg;
  roundRect(ctx, px, py, pw, ph, 12);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + pw / 2, py + ph / 2 + 0.5);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
