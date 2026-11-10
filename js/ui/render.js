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
  convexOverlap, polygonBoxArea, exteriorJointOutlines, runInsideFrom,
} from '../core/dims.js';
import {
  placeLabels, fixtureObstacles, findFreeSpot, roomBasePoint, roomNamePoint, roomOpenPart, nameSpotClear, openingLabelSpots,
  labelSpotGroups, nameTakesLabelSpots, doorSwingShapes, scanExtent, wrapName, boxesHit, boxInPolygon, roomInnerPolygon,
  openingLabelGeometry, fixtureCore, LABEL_GAP_MM, NAME_SPOT_TIE_PAPER_MM, NAME_SWING_MIN_PAPER_MM2, OPENING_TINY_SCALES,
} from '../core/labels.js';
import { PAPER_STYLE, PT_MM, paperSmallTexts } from '../core/printlayout.js';
import { pointInPolygon } from '../core/geom.js';
import { measureSideKey } from '../core/rooms.js';
import { resolvedKeys, residualCheckNow } from '../core/checkkeys.js';
import { FIXTURE_STYLE, fixtureInnerLineMM } from './draw-fixtures.js';
import { paperTextWidth } from './paperfont.js';

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
  textBoxes: null,         // array: receives { key, kind, refId, x, y, w, h (canvas units), poly (a text along a diagonal: its turned corners), base,
                           // center (world) } of every movable label drawn (선택: drag to move)
  forceShow: null,         // label key always shown (the one being dragged)
  textItems: null,         // array: receives { kind, refId, key, id, x, y, w, h, poly (as textBoxes) } of EVERY text drawn by
                           // the text layer (checks: nothing overlaps; id 'v:<roomId>|<sideKey>' a value)
  fixtureExclude: null,    // fixture id whose label is left out (its size is being dragged)
  exterior: null,          // Set of wall ids drawn as 외벽 (외벽 보기; core/exterior.js exteriorIds), in COLORS.exterior
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
  let redWalls = null;   // world polygons painted red (the 구역 나누기 선 keep out of them)
  if (o.exterior && o.exterior.size) {
    // At a joint with a diagonal wall the exterior walls also take the joint (dims.js exteriorJointOutlines).
    const joints = exteriorJointOutlines(geo.edges, geo.byNode, o.exterior);
    paintExterior(ctx, COLORS.wall, (c) => drawWalls(c, view, geo, o.exterior, c.fillStyle, finishes, joints));
    redWalls = geo.edges.filter((it) => it.edge.kind !== 'divider' && o.exterior.has(it.edge.id))
      .map((it) => wallPolygon(it, geo)).filter(Boolean)
      .concat(finishes.filter((f) => f.edgeIds.some((id) => o.exterior.has(id))).map((f) => f.points), joints);
  }
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
  drawDividers(ctx, view, geo, divW, screen ? DIVIDER_DASH_PX : DIVIDER_DASH_PAPER_MM.map((v) => v * paperMM), redWalls);
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
// extra: more world polygons in the same path (외벽: dims.js exteriorJointOutlines).
function drawWalls(ctx, view, geo, onlyIds, color, finishes = [], extra = []) {
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
  for (const poly of extra || []) if (poly && poly.length >= 3) add(poly);
  ctx.fill('nonzero');
}

// 외벽 (core/exterior.js): the exterior walls, already drawn in the wall colour `under` with all the others,
// turned COLORS.exterior. fill(ctx) fills their outlines (with their finish layers) as ONE path in
// ctx.fillStyle. The colour is ADDED ('lighter') to the wall ink: inside a wall the result is exactly
// COLORS.exterior, and on the anti-aliased edges it is the edge the wall would have in that colour, so an
// exterior wall gets no dark rim from the black under it and meets the black walls without a seam (at a
// corner or T the shared ink is red where an exterior wall covers it, black elsewhere). Shared with
// ui/output.js (paper: walls in #000000).
export function paintExterior(ctx, under, fill) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = colorDifference(COLORS.exterior, under);
  fill(ctx);
  ctx.restore();
}

// '#rrggbb' a − b per channel (≥ 0).
function colorDifference(a, b) {
  const ch = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.max(0, ch(a, i) - ch(b, i)).toString(16).padStart(2, '0');
  return out;
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
// redWalls: world polygons of the walls drawn red (외벽 보기): a line ending in one starts at its face
// (dims.js runInsideFrom), its dashes where they were.
function drawDividers(ctx, view, geo, width, dash = [], redWalls = null) {
  ctx.save();
  ctx.strokeStyle = COLORS.divider;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.setLineDash(dash);
  for (const item of geo.edges) {
    if (item.edge.kind !== 'divider') continue;
    let A = item.a, B = item.b, offset = 0;
    if (redWalls && redWalls.length) {
      const t = trimmedLine(item.a, item.b, redWalls);
      if (!t) continue;
      ({ A, B } = t);
      offset = t.from * view.scale;
    }
    const a = view.toScreen(A), b = view.toScreen(B);
    ctx.lineDashOffset = offset;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// A 구역 나누기 선 from P to Q without its ends inside the red walls (외벽; dims.js runInsideFrom). Shared with
// ui/output.js. → { A, B, from (world mm cut at P) } | null (nothing left outside them)
export function trimmedLine(P, Q, redWalls) {
  const L = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (!(L > 0)) return null;
  const s = runInsideFrom(P, Q, redWalls), e = runInsideFrom(Q, P, redWalls);
  if (s + e >= L - 1e-6) return null;
  const ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L;
  return { A: { x: P.x + ux * s, y: P.y + uy * s }, B: { x: Q.x - ux * e, y: Q.y - uy * e }, from: s, to: e };
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
    // The middle of the room's largest open part (core/labels.js roomNamePoint), as on the screen.
    const p = view.toScreen(roomNamePoint(r, derived) || r.labelPoint);
    const name = r.room.name || '';
    const hasHeight = r.room.height != null && r.room.height !== '';
    const nameY = hasHeight ? p.y - font.height * 0.6 : p.y;
    // Export mode is paper: the bundled output font (theme.js PAPER_FONT_STACK); the screen its own.
    if (name) {
      ctx.font = canvasFont(font.name, 'bold', !screen);
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
      ctx.font = canvasFont(font.height, 'normal', !screen);
      ctx.fillStyle = COLORS.height;
      ctx.fillText(`H: ${formatPlain(r.room.height)}`, p.x, nameY + font.name * 0.6 + font.height * 0.7);
    }
  }
}

// Index measures by "roomId|side key" (core/rooms.js measureSideKey: the sorted corners, plus '~' for the
// second face of a wall the room walks on both faces, m.twin). The parts of a measured side cut by a
// 구역 나누기 선 are computed by the engine (derived.computedMeasures, `computed: true`); a typed value of
// the same side wins over them.
function measureIndex(project, derived) {
  const map = new Map();
  const computed = derived && Array.isArray(derived.computedMeasures) ? derived.computedMeasures : [];
  for (const m of computed) {
    if (m && m.room && m.value != null) map.set(`${m.room}|${measureSideKey(m)}`, m);
  }
  for (const m of project.measures || []) {
    if (!m) continue;
    const key = `${m.room}|${measureSideKey(m)}`;
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
  const resolved = resolvedKeys(project);
  for (const w of (derived && derived.warnings) || []) {
    if (w.type === 'outlier' && w.measureId) outliers.add(w.measureId);
    // Drawn length differs from the measure by more than the tolerance (확인필요 level; a pair the loop decides
    // turns round once its value is confirmed: checkkeys.js residualCheckNow).
    if (w.type === 'residual' && w.measureId && residualCheckNow(w, resolved)) misfits.add(w.measureId);
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
      // Export mode only (renderPlan), so paper: the bundled output font.
      ctx.font = canvasFont(font.measure, hasValue && !m.computed ? 'bold' : 'normal', true);
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
        ctx.font = canvasFont(font.measure, 'bold', true);
        ctx.fillText(flag, x0 + mainW, c.y);
        ctx.textAlign = 'center';
      } else {
        ctx.fillText(text, c.x, c.y);
      }
      const note = m && (outliers.has(m.id) ? '다시 확인' : misfits.has(m.id) ? '안 맞음' : '');
      if (note) {
        ctx.font = canvasFont(Math.max(10, font.measure - 2), 'bold', true);
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
// Paper (final review 2026-10-28, small 화장실 / 현관 / 베란다 at 1:50–1:75): two texts keep PAPER_TEXT_GAP_MM
// apart, and two texts side by side on one line (a value right before a window label in the same blue
// read as '3450 ABS도어 900*2100') PAPER_LINE_GAP_MM along the line, about one character.
const PAPER_TEXT_GAP_MM = 0.8;
const PAPER_LINE_GAP_MM = 1.8;
// Paper: a finish layer at least this thick (paper mm) is a wall to the window / door labels (round 3: B3's
// '현관문 950*2100' touched the 주방's tiled side wall, 0.5 paper mm); a thinner one, a few mm the measured
// lengths leave beside a wall, is no more than the wall's face line (D6's 다용도실 door label at its wall end).
const PAPER_LABEL_FINISH_MM = 0.1;
// Paper, texts over lines (user 2026-10-31, the same rule as the full print, core/labels.js): a value, a room
// name with its H or a window / door label may lie over thin lines — a door's swing (arc and open leaf) and a
// fixture's outline — but never over a thick wall, another text, or a fixture's middle (core/labels.js
// fixtureCore: its box 2.5 paper mm in from the outline, where a number reads as the fixture's size) or its
// label. So the fixtures' middles and their labels' first spots are the soft obstacles of the values and the
// hard ones of the window / door labels (cores in layoutScreenText; until then the whole fixture boxes, and
// the doors' swings too, which are no obstacle now); a room's name keeps off the whole fixtures first, then
// off their middles (it.cores); the 'best' pass never puts a text's middle in a fixture's middle (it.notInside).
// Paper: what a text that finds no free spot pays for what it lies on (resolveText leastOverlap), per
// world mm² of overlap: another text (a fixture's label too), a black wall, the last free spot of a window /
// door or fixture label still to come, a fixture's middle, a fixture's outline. A number over a number is the
// worst.
const PAPER_COSTS = { text: 6, walls: 3, reserve: 2, soft: 2, outline: 0.5 };
// Paper per-side values: the passes over their spots (resolveText), each clear of fewer things: walls,
// fixtures' middles and the label spots; then over the least of a fixture's middle, never with its own
// middle there (best; never on its label, and never on a wall). Then the least overlap (PAPER_COSTS).
// (Round 4: every pass keeps off more than PAPER_CORE_MAX_MM2 of a fixture's middle (labels) — A1's '2275' turned
// along its wall inside the 욕조's box, 10 mm² of its middle — and the values keep off the line of a fixture's label
// across its box and in line with it past the box's ends (lineBand). With no such spot, after the value's last resorts,
// further spots and smaller sizes (it.later) and its room's repack, PAPER_VALUE_RELAXED: the same but over a fixture's
// label's line (loose), alone and with the room's values placed again, before the least overlap.)
const PAPER_VALUE_PASSES = [
  { walls: true, soft: true, reserve: true, labels: true },
  { walls: true, reserve: true, best: true, labels: true },
];
const PAPER_VALUE_RELAXED = [{ walls: true, reserve: true, best: true, loose: true, labels: true }];
// Paper: what a text may cover of a fixture's middle in its passes before the relaxed ones (paper mm²): a sliver.
const PAPER_CORE_MAX_MM2 = 1.5;
// Paper (user 2026-11-01, Q1): at 1:150, a per-side value with no free spot at the room heights' size
// (PAPER_STYLE.heightPt) may be smaller, these sizes in pt in turn, still inside its own room; (question 5, 1안) the same
// at a scale picked by hand from 1:75 that draws the plan smaller than [자동] does (o.paperText.small,
// printlayout.js paperSmallTexts). Every other print keeps the room heights' size as the smallest.
// (The sizes: PAPER_STYLE.smallValuePt, core/printlayout.js, with the other paper sizes.)
// Paper: a fixture's label not under this share of its size (PAPER_STYLE.fixturePt; coordinator 2026-11-01, 0.6.8's
// smallest was 4.93 pt): smaller only where nothing else fits (its size line left out first, then the name over its
// box's outline or just beside the box).
const PAPER_FIXTURE_MIN_SHARE = 0.5;
// Paper room names (with H): off the fixtures first (user 2026-10-31: the tiny 현관's name in the free space
// off the 신발장), then over a fixture's outline, not its middle, then over the least of a fixture, the name's
// and the H's middles off its middle (final review 2026-10-28: '화장실' and its H on the 변기 / 욕조 of a small
// bathroom); never on a label's last spot before the least-overlap choice.
// (The second pass adds only its repair: a value may then make room at a smaller size before the name lies
// on a fixture; see PAPER_NAME_PUSH_MIN.)
// (Round 4: every pass but the last also off a fixture's middle but for a sliver, labels; the last one, relaxed, with
// its room's values placed again over the spots of the name's own last pass, loose.)
const PAPER_NAME_PASSES = [
  { soft: true, reserve: true, labels: true },
  { soft: true, reserve: true, pushSmall: true, labels: true },
  { cores: true, reserve: true, labels: true },
  { reserve: true, best: true, labels: true },
  { reserve: true, best: true, relaxed: true, loose: true },
];
// Paper window / door labels: the order of their tries, [group, pass, what] over their groups (0 the
// attached spots, 1 the stacked spots beyond a value, 2 the misleading ones) and their passes ({ soft (the
// fixtures' whole boxes; their middles are hard), reserve }, { reserve }, {}): every attached spot first, off
// the fixtures (a single value moved along its wall, displace, or one or two texts moved, repair) and then
// over a fixture's outline; only then a
// stacked spot; then an attached spot that takes another label's last one; misleading spots last (final review
// round 2, 2026-10-31: in pass order a stacked spot of the first pass came before the attached spot of the
// second, and 'PVC단창 1200*1000' floated 17.5 paper mm from its window in the 주방 while the spot right at
// the window was free but for a door's swing; user 0.6.4 '바로 붙어 있어야 알아보잖아').
// Group 3: the attached spots at 70 % (shrunkSpots), after every try at full size and 85 %: those at the wall face (over a
// door's swing too) first, then (round 5) the same with the fixtures' labels yielding ('yield': the first spot of a fixture's
// label, grown by the gap between texts, no longer hard, while one of its spots stays free, reserve), and only then the
// spots beyond the door's swing, a swing's reach from the door: group 6 at full size and 85 %, group 5 at 70 % (round 5:
// group 0 holds the spots at the wall face only. C4 at 1:75: '목문 800*2000' at the bottom of the 세탁실, 12 mm from its
// door and 1.9 mm from the window, read as the window's label, while the spot right above its door was free but for the
// first spot of the '보일러' label, 6.16 pt across its whole box since round 4, which then takes another spot in its box;
// D4: '현관문 900*2100' 16.8 mm into the 복도 beyond its swing at 85 % while the spot right outside its door was free).
// (Group 3 holds the spots at 70 % of the full size, group 7 those at 70 % of the 85 % step, 5.2 pt: off the fixtures right
// after group 3, over a fixture's outline only after the spots beyond the swing at full size and 85 %. Round 5 check, D6 at
// 1:50: 'ABS도어 700*2000' went from 8.8 pt beyond its swing in its small 화장실1 to 5.2 pt over the 세면대's and 변기's
// outlines. C4's '목문 800*2000' still takes its 5.2 pt spot above its door, from group 7.)
// ('yieldRepair': with the fixtures' labels yielding, one or two texts in the way moved to other spots of theirs, as
// 'repair'; C4: the 욕실 door's label beyond its own swing, so that the 세탁실 door's label stays above its door.)
// Group 4 (o.paperText.small: 1:150 and a scale picked by hand smaller than [자동]'s; question 5, 1안): the attached
// spots smaller still (OPENING_TINY_SCALES in turn), after every other spot, also with a single value moved along its
// wall at its size (displace); never in the least overlap (fallback).
const PAPER_LABEL_STEPS = [
  [0, 0, 'try'], [0, 0, 'displace'], [0, 0, 'repair'], [0, 1, 'try'], [0, 1, 'repair'],
  [3, 0, 'try'], [3, 0, 'yield'], [7, 0, 'try'], [7, 0, 'yield'], [3, 1, 'try'], [3, 1, 'yield'], [3, 1, 'yieldRepair'],
  [6, 0, 'try'], [6, 1, 'try'], [7, 1, 'try'], [7, 1, 'yield'], [7, 1, 'yieldRepair'], [5, 0, 'try'], [5, 1, 'try'],
  [1, 0, 'try'], [1, 1, 'try'],
  [0, 2, 'try'], [0, 2, 'repair'], [3, 2, 'try'], [6, 2, 'try'], [7, 2, 'try'], [5, 2, 'try'], [1, 2, 'try'],
  [2, 0, 'try'], [2, 1, 'try'], [2, 2, 'try'],
  [4, 0, 'try'], [4, 0, 'displace'], [4, 1, 'try'], [4, 2, 'try'],
];
// A per-side value moved along its wall to make room for a window / door label (displaceValue): off the walls, the
// fixtures and (paper) the most of their middles.
const DISPLACE_PASS = { walls: true, soft: true, labels: true };
// (For a window / door label made smaller still, group 4: the value also keeps off the spots the labels still to come
// would take, reserve; question 5: D1's '10800' moved onto the spots of the two '목문 900*2000' after it.)
const DISPLACE_TINY_PASS = { ...DISPLACE_PASS, reserve: true };
// Screen, the side being typed (addValues activeGroups): each group of its spots off the fixtures, then over them,
// before the next group.
const ACTIVE_STEPS = [[0, 0, 'try'], [0, 1, 'try'], [1, 0, 'try'], [1, 1, 'try'], [2, 0, 'try'], [2, 1, 'try']];
// Paper per-side values keep this far from a wall's face (final review round 2: E4's '1800' was shifted
// along its side until its '1' touched the black outer wall and read as '800'); about 2.4 px at 300 dpi.
const PAPER_WALL_GAP_MM = 0.2;
// Paper (round 5): a per-side value whose middle is no further than this from its wall's centre line (paper mm) is beside
// its wall. Where a room's texts are placed again (repackRoom) or moved to make room for another (repair), the values are
// kept beside their walls first, and only then may they go further in (round 4 moved a crowded room's values up to three
// rows into the room and its name grew in their place: A1 화장실2's bottom '1575' in the middle of the room, D5 turned
// '1500' 19 mm from its wall; values farther than this went 40 → 54 / 42 → 48); at the end a value further than this
// goes back beside its wall where a spot there is free (improve). (A value in front of a fixture against its wall may
// stand further: its spots there are its own, not further in.)
const PAPER_NEAR_WALL_MM = 9;
// (Beside its wall also means not more than this (paper mm) nearer another wall of its room than its own.)
const PAPER_OTHER_WALL_MM = 3;
// Paper: a value written to make room for a room's name (repair) keeps at least this share of its size and
// a spot of its first pass (final review round 2: D3's '2970' went to 55 % inside the 다용도실 door's swing
// so that '다용도실' could take the middle at 95 %; values are the content, the name shrinks first).
const PAPER_NAME_PUSH_MIN = 0.84;

let textCache = null;
// Pinch / wheel zoom (review 2026-10-25: every zoom frame laid out every text again, 35–40 ms of JS a frame
// for 40 rooms on a PC, several times that on the tablet): while the scale keeps changing from one frame
// to the next (frames under ZOOM_SETTLE_MS apart), the last layout is drawn again — the same texts at
// their spots, at their fixed px size — until the scale is ZOOM_REUSE_RATIO away from the one it was laid
// out for. o.requestRelayout(ms) then has the editor draw once more when the zoom has stopped, which lays
// everything out for the scale it stopped at. A redraw at an unchanged scale always lays out afresh.
const ZOOM_SETTLE_MS = 160;
const ZOOM_REUSE_RATIO = 0.15;
let lastTextDraw = { scale: 0, at: -Infinity };
// How many times the editor's text layer was laid out (tests: a zoom does not lay out every frame).
export const textLayoutStats = { count: 0 };

function drawScreenText(ctx, view, project, derived, geo, font, o) {
  if (!derived || (!o.labels && !o.sideLabels)) return;
  const key = {
    project, derived, labels: !!o.labels, sideLabels: !!o.sideLabels,
    openingLabels: !!o.openingLabels, fixtureLabels: !!o.fixtureLabels, notRoomLabels: !!o.notRoomLabels,
    wppm: o.worldPerPaperMM, roomLabel: o.roomLabel, forceShow: o.forceShow,
    exclude: o.fixtureExclude || null, inner: FIXTURE_STYLE.innerLine,
    active: o.activeSide ? `${o.activeSide.roomId}|${o.activeSide.sideKey}` : '', font: JSON.stringify(font),
  };
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const zooming = view.scale !== lastTextDraw.scale && now - lastTextDraw.at < ZOOM_SETTLE_MS;
  lastTextDraw = { scale: view.scale, at: now };
  let layout = null;
  if (textCache && sameKeys(textCache.key, key)) {
    if (textCache.scale === view.scale && textCache.obstacles === o.textObstacles) {
      layout = textCache.layout;
    } else if (zooming && typeof o.requestRelayout === 'function' && textCache.scale > 0
      && Math.abs(view.scale / textCache.scale - 1) <= ZOOM_REUSE_RATIO) {
      layout = textCache.layout;
      o.requestRelayout(ZOOM_SETTLE_MS + 20);
    }
  }
  if (!layout) {
    layout = layoutScreenText(ctx, view, project, derived, geo, font, o);
    textCache = { key, layout, scale: view.scale, obstacles: o.textObstacles };
    textLayoutStats.count++;
  }
  drawTextLayout(ctx, view, layout, o);
}

// ctx.measureText of a text at px / weight (canvasFont), remembered: a layout of 40 rooms measures about
// 3,500 texts, the same ones at every zoom step. (The canvas transform does not change measureText.)
// paper: in the bundled output font (theme.js PAPER_FONT_STACK), as drawTextLayout then draws it, and measured
// every time, not remembered: an output is laid out once, and a paper text measured on its own canvas right
// before it is drawn is drawn the same way in every output. With the widths remembered from an earlier output
// (or preview), the texts of the next one came out up to half a pixel apart (the first file of a session
// differed from the later ones: round 4 part B check, 예시 세대 A 치수선 없이 PNG 421476 B, then 421232 B).
// (Round 5: paper widths from the font's own advances, paperfont.js paperTextWidth, the same on every device; the
// device measures only while the output font is not in use, or a character the font does not have.)
const textWidths = new Map();
function measureWidth(ctx, text, px, weight = 'normal', paper = false) {
  const font = canvasFont(px, weight, paper);
  if (paper) {
    ctx.font = font;
    const w = paperTextWidth(text, px, weight);
    return w != null ? w : ctx.measureText(text).width;
  }
  const k = `${font}|${text}`;
  let w = textWidths.get(k);
  if (w === undefined) {
    if (textWidths.size > 20000) textWidths.clear();
    ctx.font = font;
    w = ctx.measureText(text).width;
    textWidths.set(k, w);
  } else {
    ctx.font = font;
  }
  return w;
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
  // Widths do not change with the zoom (text px are fixed): kept across frames (measureWidth). Paper: in
  // the output font, as drawTextLayout draws them.
  const measure = (text, px, weight = 'normal') => measureWidth(ctx, text, px, weight, paper);
  const fixtures = fixtureObstacles(project);
  const columns = fixtures.filter((f) => f.column);
  const soft = fixtures.filter((f) => !f.column);
  // Paper: the fixtures' middles, which no text lies on (texts over lines, see PAPER_COSTS); the first spot of
  // each fixture's label in its box is added to them in addLabels (flagged text).
  const cores = paper ? soft.map((f) => ({ ...fixtureCore(f, o.paperText.gapWorldPerPaperMM), core: true })) : null;
  const fixSoft = paper ? cores : soft;
  // Paper: the line of each fixture's label across its box (addLabels), which a per-side value keeps off in its
  // first pass, and in the 'best' pass keeps its middle off: a number there reads with the label as the
  // fixture's size (round 3 finisher: with only the middles kept clear, a value moved along its wall took the
  // end of the 옷장 against it, on its label's line, before the free spot in front of it: A1 turned, '옷장 2400
  // 5100'; A6, '냉장고 900 4200'; A6 turned, '1275 신발장' in the 현관).
  // (Round 4: with its extent along the label's line, lineBand in resolveText, also past the box's ends.)
  const labelLines = paper ? [] : null;
  // Paper: a fixture's middle covered by no more than a sliver in the values' and names' passes (labels; world mm²).
  const coreMax = paper ? PAPER_CORE_MAX_MM2 * o.paperText.gapWorldPerPaperMM ** 2 : 0;
  // Paper: the rooms with a fixture in them (by its middle), where the relaxed passes differ from the others: only
  // there is a room's repack tried again with them (resolveText repackRoom loose).
  // Paper values with no free spot: the least overlap among their spots with the middle off every fixture's middle where
  // there are any (round 4: A1 turned three times, '2275' with its middle in the 욕조's, 13 mm², read as its length).
  const offCores = (list) => {
    const off = list.filter((c) => c.box && !cores.some((f) => {
      const x = (c.box.minX + c.box.maxX) / 2, y = (c.box.minY + c.box.maxY) / 2;
      return f.core && x > f.minX && x < f.maxX && y > f.minY && y < f.maxY;
    }));
    return off.length ? off : list;
  };
  let fixtureRoomIds = null;
  const fixtureRoom = (roomId) => {
    if (!fixtureRoomIds) fixtureRoomIds = new Set(soft.map((f) => roomAt({ x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2 })).filter(Boolean));
    return fixtureRoomIds.has(roomId);
  };
  // Paper room names: off the whole fixtures first, with their middles and labels (PAPER_NAME_PASSES).
  const nameSoft = paper ? soft.concat(cores) : soft;
  let wallBoxes = [];
  // Diagonal walls by their real outline (poly; their bounding box would cover the rooms beside them).
  try { wallBoxes = wallPolygons(project, derived).map((w) => (w.orient === 'd' ? { ...w.box, poly: w.points } : { ...w.box, edgeId: w.edgeId, orient: w.orient })); } catch (_) { wallBoxes = []; }
  // Paper: the finish layers on room faces are printed black as part of their walls (output.js
  // drawPaperWalls), so a room name keeps off them too (review 2026-10-25: the turned 예시 세대 A at 1:75 wrote
  // '화장실2' into the 화장실's tiled wall, which is off the bare wall but not off the print's black).
  let nameWalls = wallBoxes, labelWalls = wallBoxes;
  if (paper) {
    try {
      const fins = finishPolygons(project, derived);
      const asBox = (f) => {
        const b = boxOf(f.points);
        const axis = f.points.every((p) => [b.minX, b.maxX].some((x) => Math.abs(p.x - x) < 0.5) && [b.minY, b.maxY].some((y) => Math.abs(p.y - y) < 0.5));
        return axis ? b : { ...b, poly: f.points };
      };
      // A band's depth: its outer corner's distance from the wall face line (points 0 → 1).
      const depth = ([a, b, , d]) => Math.abs((b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x)) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
      nameWalls = wallBoxes.concat(fins.map(asBox));
      // Window / door labels (paper): off the finish layers printed thick enough to read as wall too (texts
      // over lines); their own wall's finish is in their face (core/labels.js openingLabelGeometry).
      labelWalls = wallBoxes.concat(fins.filter((f) => depth(f.points) >= PAPER_LABEL_FINISH_MM * o.paperText.gapWorldPerPaperMM).map(asBox));
    } catch (_) { nameWalls = labelWalls = wallBoxes; }
  }
  const extra = Array.isArray(o.textObstacles) ? o.textObstacles.filter(Boolean) : [];
  let nameZones = null;   // nameAvoidOf: the window / door labels' first spots and (screen) the door swings
  let roomList = null;     // roomAt: the rooms, smallest first
  let openingSpans = null; // openingSpansOf: edge id → its windows / doors along it
  let wallOpen = null;     // wallOpenings: wall box → its windows / doors as spans along it
  const items = [];
  let order = 0;
  // Paper: gaps in paper mm at the print scale (PAPER_TEXT_GAP_MM, PAPER_LINE_GAP_MM).
  const gwp = paper ? o.paperText.gapWorldPerPaperMM : 0;
  // Paper: may a value or a window / door label with no free spot get smaller than usual (PAPER_STYLE.smallValuePt,
  // OPENING_TINY_SCALES)? 1:150, and a scale picked by hand smaller than [자동]'s (drawPaperPlanText).
  const smallOk = paper && (o.paperText.small != null ? !!o.paperText.small : paperSmallTexts(gwp));
  const add = (it) => {
    it.order = order++;
    it.gap = paper ? PAPER_TEXT_GAP_MM * gwp : W(TEXT_GAP_PX);
    if (paper) it.lineGap = PAPER_LINE_GAP_MM * gwp;
    items.push(it);
  };
  // Paper: the spots each window / door and fixture label still to be written can take (addLabels), which
  // the values and names placed before them leave at least one of free where they can (resolveText).
  const reserves = [];
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
  return resolveText(items, reserves, paper);

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
      // base: the point a name moved by hand is measured from (the label point); start: where the name
      // starts out, the middle of the room's largest open part (core/labels.js roomNamePoint; user
      // 2026-10-25: '베란다1' sat against the end wall of its long strip, on paper and here).
      const base = roomBasePoint(r) || r.labelPoint;
      const key = `room:${r.roomId}`;
      const off = offsets[key];
      const start = off && named ? base : (roomNamePoint(r, derived) || base);
      let text = room.name;
      if (!named) text = notRoom ? '실 아님' : ((typeof o.roomLabel === 'function' && o.roomLabel(r.roomId)) || '이름 없음');
      // Paper: room names in the print's normal weight (draw-labels.js).
      const style = named
        ? (notRoom ? { px: LP.fixture, weight: 'normal', color: FIXTURE_TEXT } : { px: font.name, weight: paper ? 'normal' : 'bold', color: COLORS.roomName })
        : { px: Math.round(font.name * 0.8), weight: 'normal', color: COLORS.roomNameEmpty };
      const hasH = !notRoom && room.height != null && room.height !== '' && isFinite(Number(room.height));
      const hText = hasH ? `H: ${formatPlain(Number(room.height))}` : '';
      const scan = (axis) => scanExtent(r.face.points, start, axis) || scanExtent(r.face.points, { x: start.x + 0.37, y: start.y + 0.37 }, axis);
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
      const mk = (s, at) => roomCand(at, texts, style, s, rot, hText);
      let cands;
      if (off && named) {
        cands = [mk(scale, { x: base.x + (Number(off.dx) || 0) * wppm, y: base.y + (Number(off.dy) || 0) * wppm })];
      } else {
        const c0 = mk(scale, start);
        const bw = c0.box.maxX - c0.box.minX, bh = c0.box.maxY - c0.box.minY;
        // Keep the whole name inside the room (the screen text is large next to a small room).
        let spot = keepInside(r.face.points, start, bw, bh, W(4) + 80);
        if (fixtures.some((f) => boxesHit(boxAt(spot.x, spot.y, bw, bh), f))) {
          spot = findFreeSpot(r.face.points, bw, bh, spot, fixtures, { margin: W(4), step: Math.max(bh / 3, W(4)) });
        }
        // On every spot of one of this room's window / door labels over its opening, or (screen) on a door's
        // swing: the nearest spot of the same size that leaves one of them free, moved across the room's largest
        // open part first (a strip's name keeps the middle of its length; core/labels.js nameSpotClear, as
        // on paper). None: it stays (paper: the smaller sizes below). A wider gap from the label spots
        // first (a name right above a window label reads as one block with it). Inside the room's inner
        // faces: 4 px from them (paper: 0.8 mm, then 0.2 mm, as the print's names).
        const avoid = nameAvoidOf(r, W(TEXT_GAP_PX));
        const smaller = [];
        if (nameTakesLabelSpots(boxAt(spot.x, spot.y, bw, bh), avoid)) {
          let poly = null;
          try { poly = roomInnerPolygon(r, project, derived); } catch (_) { poly = null; }
          const keep = fixtures.concat(extra, avoid.obstacles);
          const gw = paper ? o.paperText.gapWorldPerPaperMM : 0;
          const wide = nameAvoidOf(r, paper ? LABEL_GAP_MM * gw : W(3 * TEXT_GAP_PX)).groups, near = avoid.groups;
          const ms = poly ? (paper ? [0.8 * gw, 0.2 * gw] : [W(4)]) : [W(4) + 80];
          // Then along, no further than a quarter of the open part from its middle and not closer to a
          // wall than the first margin (the name is not squeezed against an end wall again).
          const at = (moves, margins, w = bw, h = bh, sets = [wide, near], reach = 0.25) => nameSpotClear(poly || r.face.points, spot, w, h, keep, {
            part: roomOpenPart(r, derived), moves, alongReach: reach, tie: paper ? NAME_SPOT_TIE_PAPER_MM * gw : W(2),
            tries: sets.flatMap((groups) => margins.map((margin) => ({ groups, margin }))),
          });
          let clear = at(['across'], ms) || at(['along'], ms.slice(0, 1));
          // Paper (nothing is left out): smaller (85 %, 70 %) across, before the full size on the label's
          // spots (as the print's names, core/labels.js placeRoom).
          if (!clear && paper) {
            for (const s of [scale * 0.85, scale * 0.7]) {
              const cs = mk(s, spot);
              const c = at(['across'], ms, cs.box.maxX - cs.box.minX, cs.box.maxY - cs.box.minY, [near]);
              if (c) { smaller.push(mk(s, c)); break; }
            }
          }
          // Screen, still on a door's swing: off it first, along the room as far as it takes and then
          // anywhere in it, leaving a label spot free where it can, else not (checker 2026-10-25: a narrow
          // 다용도실's name on the swing of its door; on paper a name may lie over a swing since 2026-10-31).
          const sb = boxAt(spot.x, spot.y, bw, bh);
          if (!clear && !smaller.length && avoid.obstacles.reduce((s, sw) => s + polygonBoxArea(sw.points, sb), 0) > NAME_SWING_MIN_PAPER_MM2 * wppm * wppm) {
            clear = at(['along', 'grid'], ms, bw, bh, [near], Infinity) || at(['along', 'grid'], ms, bw, bh, [[]], Infinity);
          }
          if (clear) spot = clear;
        }
        cands = smaller.concat(mk(scale, spot));
        // Paper (values first): a spot of the same size a little off the middle (within 15 % of the open
        // part's width / height, leaving the label spots free) before a smaller name in the middle
        // (centred, '화장실1' touched the '1470' at the wall beside it and was written at 85 %).
        const part = paper ? roomOpenPart(r, derived) : null;
        if (part) {
          const dx = 0.15 * (part.x1 - part.x0), dy = 0.15 * (part.y1 - part.y0);
          cands.push(...paperNameSpots(r.face.points, spot, scale, mk, null, [scale])
            .filter((c) => Math.abs(c.x - spot.x) <= dx && Math.abs(c.y - spot.y) <= dy && !nameTakesLabelSpots(c.box, avoid)));
        }
        if (scale * 0.85 >= 0.6) cands.push(mk(scale * 0.85, spot));
        // A room with a diagonal side (a triangle, a cut corner): spots where the whole block lies
        // inside the room, off the slanted walls, at this size and smaller (request 2026-10-19).
        const slanted = (r.sides || []).some((sd) => sd.orient === 'd');
        if (slanted) {
          const inner = slantedNameCands(r, start, scale, mk);
          if (inner.length) cands = inner;
        }
        // Paper: nothing may be left out, so a crowded room tries other spots and smaller sizes
        // before a name would be written over a value.
        let innerPoly = null;
        if (slanted) { try { innerPoly = roomInnerPolygon(r, project, derived); } catch (_) { innerPoly = null; } }
        if (paper) {
          cands.push(...paperNameSpots(r.face.points, spot, scale, mk, innerPoly));
          // A one-line name that finds no free spot may still fit as two lines ('화장실' / '2'), before the
          // least-overlap fallback would put it onto a wall (review 2026-10-25: 예시 세대 A turned, 1:75).
          if (texts.length === 1 && named) {
            const wrapped = wrapName(text);
            if (wrapped.length > 1) {
              const mk2 = (s, at) => roomCand(at, wrapped, style, s, rot, hText);
              cands.push(...paperNameSpots(r.face.points, spot, scale, mk2, innerPoly));
            }
          }
        }
      }
      const id = `name:${r.roomId}`;
      const moved = !!(off && named);
      add({
        id, kind: 'name', key: named ? key : null, refId: r.roomId, base, cands,
        // Paper: a name placed by hand goes with the other texts placed by hand, before the values,
        // and its H right after it (review 0.5.0: the H came first, found no name and was lost).
        prio: named ? (paper && moved ? P.moved : P.name) : P.placeholder, sub: -(r.area || 0),
        // Paper: a name is never written onto a wall (the walls are hard; a name moved by hand stays put),
        // nor onto a fixture where any spot allows it, nor onto its middle (cores, notInside; PAPER_NAME_PASSES).
        mustShow: paper || o.forceShow === key, hard: paper && !moved ? columns.concat(extra, nameWalls) : columns.concat(extra),
        soft: nameSoft, cores: paper && !moved ? cores : null, notInside: paper && !moved ? cores : null,
        coreMax: paper && !moved ? coreMax : 0, fixtureRoom: paper && !moved && fixtureRoom(r.roomId),
        // Paper, no free spot: the least overlap among the spots off the walls (a name over a number
        // still reads; half of it in the black wall does not), and only when there is none, anywhere; of
        // those, the ones with the name's and the H's middles off the fixtures' middles where there are any
        // ('H: 2300' over an 옷장 reads as its height).
        fallback: paper && !moved ? (all) => {
          const off = all.filter((c) => c.box && !nameWalls.some((h) => obstacleHit(c.box, null, h)));
          // (The fixtures' middles; not their labels' first spots, round 4: in a tiny 현관 the name then went over a value.)
          const clear = off.filter((c) => ![c.nameBox, c.hBox].some((m) => m && cores.some((f) => {
            const x = (m.minX + m.maxX) / 2, y = (m.minY + m.maxY) / 2;
            return f.core && x > f.minX && x < f.maxX && y > f.minY && y < f.maxY;
          })));
          return clear.length ? clear : off;
        } : null,
        boxOf: paper ? (c) => c.box : (c) => c.nameBox,
        // Paper: off the spots the window / door and fixture labels still need (final review 2026-10-28:
        // '화장실1' and its H on the 욕조, whose label then went onto a value).
        passes: paper && !moved ? PAPER_NAME_PASSES : null, costs: paper ? PAPER_COSTS : null, repair: paper && !moved, relocatable: paper && !moved,
        // Paper: shrunk because the spots were taken when it came, it grows back where they are free at the
        // end (resolveText improve); with no spot off the fixtures and texts, its room's values make room
        // (resolveText repackRoom).
        improve: paper && !moved, repack: paper && !moved,
      });
      if (hText && !tiny) {
        add({
          // The H of a name placed by hand stays with it (before the values).
          id: `h:${r.roomId}`, kind: 'height', refId: r.roomId, prio: moved ? (paper ? P.moved + 0.05 : P.moved) : P.height, sub: 0, ignore: id,
          cands: (chosen) => (chosen.has(id) ? [chosen.get(id)] : []),
          mustShow: paper || o.forceShow === key, hard: columns.concat(extra), soft: fixSoft, boxOf: (c) => c.hBox,
        });
      }
    }
  }

  // What a room's name leaves free where it can, when the window / door labels are written: one spot at
  // least of each label written inside this room (core/labels.js openingLabelSpots, at this layout's
  // sizes, grown by `pad`), and on the screen the doors' swings (by their outline; on paper a name may lie
  // over a swing, PAPER_COSTS). → { obstacles, groups }
  function nameAvoidOf(r, pad) {
    if (!o.openingLabels || tiny) return { obstacles: [], groups: [] };
    if (!nameZones) {
      try {
        // (Screen: the label spots of the screen, beyond the doors' swings: core/labels.js placeLabels opts.screen.)
        const spots = openingLabelSpots(project, derived, {
          fonts: { opening: LP.opening }, worldPerUnit: 1 / k, worldPerPaperMM: paper ? o.paperText.gapWorldPerPaperMM : 60,
          measure: (text, size, weight) => measure(text, size, weight), screen: !paper,
        });
        nameZones = { spots, swings: paper ? [] : doorSwingShapes(project, derived) };
      } catch (err) {
        console.error('[render] label spots', err);
        nameZones = { spots: [], swings: [] };
      }
    }
    return { obstacles: nameZones.swings, groups: labelSpotGroups(nameZones.spots, r.roomId, pad) };
  }

  // The name block of a room centred at `at`: name line(s), then H (world mm).
  function roomCand(at, texts, style, s, rot, hText) {
    const px = style.px * s;
    const lineH = W(px * 1.2);
    const nameW = W(Math.max(...texts.map((t) => measure(t, px, style.weight))));
    const nameH = lineH * texts.length;
    // H: not under 80 % of its size (paper: 60 %, the smallest name blocks of a 1100 × 1675 현관 at 1:75,
    // where 'H: 2300' at 80 % was wider than the room left beside its 신발장).
    const hPx = font.height * Math.max(paper ? 0.6 : 0.8, s);
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

  // A room with a diagonal side: for each size (this, 0.85, 0.7 of it) the spot nearest `base` (where
  // the name starts out) where the name block lies inside the room, clear of its walls and the fixtures.
  // → [cand]
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
  function paperNameSpots(poly, spot, scale, mk, inner = null, sizes = null) {
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const out = [];
    for (const s of sizes || [scale, scale * 0.85, scale * 0.7, Math.min(scale * 0.7, 0.55)]) {
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
      // Nearest first; spots within NAME_SPOT_TIE_PAPER_MM of each other in distance are as near and keep
      // the grid's order (two spots mirrored about the middle: the solve's rounding chose between them,
      // and a value typed in another room moved the name from one to the other, checker 2026-10-25).
      const tie = NAME_SPOT_TIE_PAPER_MM * (paper ? o.paperText.gapWorldPerPaperMM : 60);
      const dist = new Map(spots.map((at, i) => [at, { d: Math.hypot(at.x - spot.x, at.y - spot.y), i }]));
      spots.sort((a, b) => {
        const p = dist.get(a), q = dist.get(b);
        return Math.abs(p.d - q.d) <= tie ? p.i - q.i : p.d - q.d;
      });
      if (s !== scale) out.push(mk(s, spot));
      for (const at of spots) out.push(mk(s, at));
    }
    return out;
  }

  // The room a point lies in: the smallest one whose outline holds it (a room standing inside another is
  // its own). → roomId | null
  function roomAt(p) {
    if (!roomList) roomList = roomsOf(derived).filter((r) => r.face && Array.isArray(r.face.points)).sort((a, b) => Math.abs(a.area || 0) - Math.abs(b.area || 0));
    const r = roomList.find((x) => pointInPolygon(p, x.face.points));
    return r ? r.roomId : null;
  }

  // Each side's measured value (or '?') inside the room, near the side.
  function addValues() {
    // The smallest size of a value: paper, the room heights' and fixture labels' (PAPER_STYLE.heightPt; user
    // 2026-10-31: '공간이 좁아서 벽 길이를 넣기 어려우면 다른 설비나 방높이 글씨크기처럼 글씨 크기를 줄여').
    const small = paper ? font.height / font.measure : 0.7;
    const measures = measureIndex(project, derived);
    const missing = missingTest(project, derived, measures);
    const outliers = new Set(), misfits = new Set();
    const resolved = resolvedKeys(project);
    for (const w of derived.warnings || []) {
      if (w.type === 'outlier' && w.measureId) outliers.add(w.measureId);
      if (w.type === 'residual' && w.measureId && residualCheckNow(w, resolved)) misfits.add(w.measureId);
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
        const active = !!(o.activeSide && o.activeSide.roomId === r.roomId && o.activeSide.sideKey === side.key);
        // Skip labels on sides too short to read at this zoom (paper: nothing is left out). Not the side
        // being typed: it is always shown, past its ends or on the wall's other face (final review round 2:
        // the 예시 세대 A 주방's 175 mm jog, 13 px at fit zoom, showed no value while [확인 ▶] stood on it).
        if (!paper && !active && fr.L * k < 18) continue;
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
        // Long sides: also a quarter of the way along (off a column standing at the middle). The side being
        // typed too, at any length, before the spot in front of a fixture against it (final review round 3: in
        // the E4 화장실 the bubble of the wall behind the 변기 went in front of it, half way across the room
        // beside the opposite wall's own value; in A1's 현관 past the end of the wall, outside the room).
        if (!active && fr.L * k > 120) cands.push(mk(1, fr.L / 4), mk(1, -fr.L / 4));
        if (active && !along) cands.push(mk(1, fr.L / 4), mk(1, -fr.L / 4), mk(0.85, fr.L / 4), mk(0.85, -fr.L / 4));
        // A sink or cupboard standing against this side: just in front of it (verifier 0.4.0: the
        // 예시 세대 A 주방 2800 was written on the 싱크대). Only while that stays nearer this side than the opposite
        // one (frontSpotOk; final review round 2: a 옷장 or a stair as deep as the room put the value beyond
        // the opposite wall, where it read as that wall's: A2 드레스룸 1875, D5 계단실 2600).
        const front = frontOfFixtures(fr, cands[0].box, soft);
        const frontOk = front > 0 ? frontSpotOk(r, fr) : null;
        const fronts = (s, shifts = [0]) => (front > 0 ? shifts.map((sh) => mk(s, sh, front)).filter(frontOk) : []);
        // Paper, at the smallest size: centred on the front of that fixture (over its outline, a thin line),
        // where neither the wall nor the front leaves room (a 1100 현관 with a 신발장 at 1:75). make(s, shift,
        // extra) → spot.
        const onFront = (make, sh, s = small) => {
          if (!(front > 0)) return [];
          const c0 = make(s, sh, 0), d0 = (c0.x - fr.A.x) * fr.n.x + (c0.y - fr.A.y) * fr.n.y;
          const extra = fr.inner + front - W(3) - d0;
          return extra > 0 ? [make(s, sh, extra)].filter(frontOk) : [];
        };
        cands.push(...fronts(1), ...fronts(0.85));
        // Paper (round 5): at its wall just past either end of a fixture standing against it whose label was moved by hand,
        // the gap between texts from the fixture's box, after the spots in front of it (E5 turned: '3800' over the left end
        // of the 싱크대's box, right under its label moved above the box, while the wall right of the box was free). (A
        // fixture's own label in its box keeps the spots in line with it, lineBand; round 5 tried these spots for every
        // fixture, and in small bathrooms a value then took the name's last spot off the fixtures: A1 turned's 화장실1.)
        // Screen (round 5): the same just past either end of every fixture standing against its wall, the gap between
        // texts from its box: a value whose every spot had its middle in a fixture's box waited for a closer zoom (round 4,
        // centreOff; E5's 주방 '3800' at its 싱크대 was left out of the tablet's fit views).
        if (!active && !along) {
          const g = paper ? gwp * PAPER_TEXT_GAP_MM : W(TEXT_GAP_PX), lim = (fr.L - fr.t) / 2;
          const mx = (fr.A.x + fr.B.x) / 2, my = (fr.A.y + fr.B.y) / 2;
          const band = cands[0].box;
          for (const s of paper ? [1, small] : [1, 0.85, small]) {
            const c1 = mk(s, 0), half = (Math.abs(fr.dir.x) * (c1.box.maxX - c1.box.minX) + Math.abs(fr.dir.y) * (c1.box.maxY - c1.box.minY)) / 2;
            for (const f of soft) {
              if (paper && !offsets[`fixture:${f.id}`]) continue;
              // (Against this wall: its box crosses the band of the value's spot at the wall, all along the side.)
              const along = [[f.minX, f.minY], [f.maxX, f.minY], [f.minX, f.maxY], [f.maxX, f.maxY]].map(([x, y]) => (x - mx) * fr.dir.x + (y - my) * fr.dir.y);
              const across = [[f.minX, f.minY], [f.maxX, f.maxY]].map(([x, y]) => (x - fr.A.x) * fr.n.x + (y - fr.A.y) * fr.n.y);
              const bandIn = [[band.minX, band.minY], [band.maxX, band.maxY]].map(([x, y]) => (x - fr.A.x) * fr.n.x + (y - fr.A.y) * fr.n.y);
              if (Math.max(...across) <= Math.min(...bandIn) || Math.min(...across) >= Math.max(...bandIn)) continue;
              const a0 = Math.min(...along), a1 = Math.max(...along);
              for (const sh of [a1 + g + half, a0 - g - half]) if (Math.abs(sh) + half <= lim) cands.push(mk(s, sh));
            }
          }
        }
        const tw0 = W(measure(v.text, font.measure));
        // The number's extent along its side: its width along a horizontal side (or turned along a diagonal
        // one), its height along a vertical one (it is written upright).
        const ext0 = along ? tw0 : Math.abs(fr.dir.x) * tw0 + Math.abs(fr.dir.y) * W(font.measure * 1.2);
        if (paper) {
          // Paper (nothing is left out): along the side, as long as the number stays on it (a diagonal side,
          // often the long side of a small triangle: finer steps too). The gap from the black walls is wallHit's
          // (it.wallGap, PAPER_WALL_GAP_MM, not along a window or door): taken off this limit as well, it left
          // values clear of every wall at 70 % (final review round 3: C3 욕실 1900 beside its window, 1.7 mm from
          // the wall; D5 turned 화장실 1500).
          const half = (fr.L - fr.t) / 2 - tw0 / 2;
          const steps = along ? [fr.L / 8, -fr.L / 8, fr.L / 4, -fr.L / 4, fr.L / 3, -fr.L / 3] : [fr.L / 4, -fr.L / 4, fr.L / 3, -fr.L / 3];
          for (const sh of steps) {
            if (Math.abs(sh) <= half) cands.push(mk(1, sh), mk(0.85, sh));
          }
        }
        // Last: smaller (a crowded small room), before the value is left out at this zoom. Paper: down to
        // the room heights' size (small), and always inside its own room (below): until 2026-10-31 a value
        // went to 70 % and 55 %, or just outside an outer wall at full size (final review 2026-10-28, a 1500 ×
        // 2275 화장실 at 1:75), where it read as a neighbour's value or the house's.
        cands.push(mk(small, 0));
        // (Paper, at that size: finer steps along the side and in front of a fixture too, so that the values
        // of a small room's opposite sides can pass each other: A6's 1275 × 1275 현관 at 1:60.)
        const fine = [fr.L / 8, -fr.L / 8, fr.L / 4, -fr.L / 4];
        if (paper) {
          for (const sh of fine) cands.push(mk(small, sh));
          cands.push(...fronts(small, [0, ...fine]));
          for (const sh of [0, ...fine]) cands.push(...onFront(mk, sh));
          // A side shorter than its number (a 120 step): just past either end, along the side (not
          // along a diagonal side: past its ends lie the sharp corners of the room). By the number's extent
          // along the side (ext0): an upright number beside a vertical side is as long along it as it is tall
          // (final review round 3: by its width, the 1200 right wall of D1's 베란다 at 1:150 had its value
          // written past the wall's end, under the bottom wall, where it read as that wall's piece; and 예시 세대 A's
          // 400 jog of the 주방 wrote its 400 in the 화장실1, as the 화장실1's).
          if (ext0 > fr.L - fr.t && !along) {
            const past = fr.L / 2 + ext0 / 2 + W(3);
            cands.push(mk(0.85, past), mk(0.85, -past), mk(small, past), mk(small, -past));
          }
          // In a room with a diagonal side (a shallow bay, a cut corner) an h / v side's value may be
          // turned along its side as well, which takes one text height across it, not its width
          // (fixer 2026-10-20, field: after a turn the 600 mm deep bay's base 1597 found no spot
          // inside and went over the bay's window, outside the room). Last, so plans without
          // diagonal walls (예시 세대 A) never get them.
          if (!along && (r.sides || []).some((sd) => sd.orient === 'd')) {
            for (const s of [1, 0.85, small]) cands.push(valueCandAlong(v, fr, s, 0), valueCandAlong(v, fr, s, fr.L / 4), valueCandAlong(v, fr, s, -fr.L / 4));
          }
        }
        // Paper: every spot inside its own room, its middle in no other room (user 2026-10-31; a spot past
        // the end of a short side can lie in the next room). A small room with a diagonal side too: until then
        // a 600 mm bay wrote its outer walls' values just outside them, beside them (fixer 2026-10-20).
        let vCands = cands;
        if (paper) {
          const own = cands.filter((c) => roomAt(c) === r.roomId);
          if (own.length) vCands = own;
        }
        // A value along a diagonal side never sits on a wall when any spot is clear of the walls
        // (its shifted spots run into the sharp corners of a triangle room).
        if (along) {
          const clear = vCands.filter((c) => !wallBoxes.some((wb) => obstacleHit(c.box, c.shape, wb)));
          if (clear.length) vCands = clear;
        }
        // Paper, a vertical side's last resort before its value lies on another text (resolveText lastResort):
        // turned along the side as a dimension is, which takes one text height across the room, not its
        // width; at the wall and in front of a fixture against it.
        const turned = (s, sh, extra) => valueCandAlong(v, fr, s, sh, extra);
        const turnedAt = (s) => [0, ...fine].flatMap((sh) => [turned(s, sh, 0), ...onFront(turned, sh, s)].concat(front > 0 ? [turned(s, sh, front)] : []));
        const ownRoom = (list) => list.filter((c) => roomAt(c) === r.roomId);
        const lastResort = paper && !along && Math.abs(fr.dir.y) > 0.9 ? ownRoom(turnedAt(small)) : null;
        // Paper, after those (round 4): the spots one, two, three text heights further into the room than the ones at
        // the wall (and in front of a fixture against it), while nearer this side than the opposite one, at the full size
        // and the smallest: a name moved by hand against the wall, or a room's values in a row, leave the spot at the
        // wall to the others (gap finder: E5's '1600' over the 화장실's name moved up to its wall, '화장실1600').
        // At 1:150 (and smallOk) then smaller, PAPER_STYLE.smallValuePt in turn: at the wall, in front of a
        // fixture and over its front, past a short side's ends, turned along a vertical side, one row further in.
        const later = [];
        if (paper && !active) {
          const near = frontSpotOk(r, fr, 0.5);
          const rowH = W(font.measure * 1.2) + gwp * PAPER_TEXT_GAP_MM;
          const shifts = [0, fr.L / 4, -fr.L / 4].filter((sh) => sh === 0 || Math.abs(sh) <= (fr.L - fr.t) / 2 - tw0 / 2);
          const deeper = (sizes, rows) => {
            const out = [];
            for (let j = 1; j <= rows; j++) {
              for (const s of sizes) {
                for (const sh of shifts) {
                  out.push(mk(s, sh, j * rowH * s));
                  if (front > 0) out.push(mk(s, sh, front + j * rowH * s));
                }
              }
            }
            return ownRoom(out).filter(near);
          };
          later.push(deeper([1, small], 3));
          if (smallOk) {
            for (const pt of PAPER_STYLE.smallValuePt) {
              const s2 = pt / font.measure;
              const list = [];
              for (const sh of [0, ...fine]) list.push(mk(s2, sh));
              list.push(...fronts(s2, [0, ...fine]));
              for (const sh of [0, ...fine]) list.push(...onFront(mk, sh, s2));
              if (!along) {
                const ext2 = Math.abs(fr.dir.x) * W(measure(v.text, font.measure * s2)) + Math.abs(fr.dir.y) * W(font.measure * s2 * 1.2);
                if (ext2 > fr.L - fr.t) {
                  const past = fr.L / 2 + ext2 / 2 + W(3);
                  list.push(mk(s2, past), mk(s2, -past));
                }
                if (Math.abs(fr.dir.y) > 0.9) list.push(...turnedAt(s2));
              }
              list.push(...deeper([s2], 2));
              later.push(ownRoom(list));
            }
          }
        }
        // Screen, the side being typed (always shown): a short side's value (a 300 mm strip at fit zoom)
        // also just past either end of the side and on the wall's other face, before it is written over
        // the wall (final review 2026-10-28: '300' over the orange wall and the 드레스룸 wall).
        // Its spots in three groups, each tried off the fixtures and then over them (the bubble has a background)
        // before the next (activeGroups, ACTIVE_STEPS): beside its own wall in its room, and in front of a fixture
        // against it while that stays nearer this side than the opposite one; then in front of a fixture beyond
        // the room's middle; then past the side's ends and on the wall's other face. Until round 4 every spot was
        // tried off the fixtures first: D5's stair along the whole 계단실 4500 wall put the bubble in front of the
        // stair, nearer the opposite wall (77 / 63 px), and a spot past an end of a side, outside the house, came
        // before the one beside its wall over a fixture (with valueCand's 1 px: C4's 방2 3450 at the landscape fit).
        let activeGroups = null;
        if (!paper && active) {
          const half = front > 0 ? frontSpotOk(r, fr, 0.5) : null;
          const deep = new Set(half ? vCands.filter((c) => c.extra > 0 && !half(c)) : []);
          const past = [];
          if (!along) {
            const at = fr.L / 2 + tw0 / 2 + W(4);
            past.push(mk(1, at), mk(1, -at), valueCand(v, fr, 1, 0, 0, true), mk(0.85, at), mk(0.85, -at));
          }
          activeGroups = [vCands.filter((c) => !deep.has(c)), vCands.filter((c) => deep.has(c)), past];
          vCands = activeGroups.flat();
        }
        add({
          id: `v:${r.roomId}|${side.key}`, kind: 'value', refId: r.roomId, v, cands: vCands,
          // A diagonal side's value first among the values (the long side of a triangle has the
          // fewest free spots).
          prio: active ? P.active : (hasValue ? P.value : P.unknown), sub: along ? -0.1 : 0,
          // Walls are avoided too where a spot allows it (a number on a black wall is lost); on the screen
          // a value that has no spot off the walls waits for a closer zoom like every text, the side being
          // typed takes the spot over the least wall (screen-value-on-wall, 2026-10-28). Paper: also off
          // the fixtures' middles and the label spots first (PAPER_VALUE_PASSES).
          mustShow: paper || active, hard: columns, soft: fixSoft, lines: labelLines, walls: wallBoxes,
          // Screen: the second pass over the fixtures, but never with the number's middle in a fixture's box, where it
          // reads as the fixture's size (round 4: the landscape fit 0.5 % larger since the hint line went, A1's
          // '1675' at 70 % inside the 신발장 box, whose own label was then left out): such a value waits for a closer
          // zoom, as every text that finds no spot. The side being typed may (its bubble has a background).
          passes: paper ? PAPER_VALUE_PASSES : [{ walls: true, soft: true }, { walls: true, centreOff: !active }],
          offBoxes: paper ? null : soft,
          costs: paper ? PAPER_COSTS : null, repair: paper,
          // Paper: a little off the walls' faces (PAPER_WALL_GAP_MM); in the pass over the fixtures never with
          // its middle in a fixture's middle (final review round 2: '2800' at 55 % in the 싱크대's box right
          // under '싱크대' read as the sink's length); shrunk or pushed onto a fixture because the spots were
          // taken when it came, it goes back to a better one that is free at the end (improve).
          wallGap: paper ? PAPER_WALL_GAP_MM * gwp : 0, notInside: paper ? cores : null, improve: paper && !active,
          wallOpen: paper ? wallOpenings() : null, lastResort, repack: paper && !active,
          // Paper (round 4): the further spots and (1:150) the smaller sizes after the last resorts; a fixture's middle
          // (but for a sliver) and its label's line kept clear until the relaxed pass; the least overlap over every spot.
          later: paper && !active ? later : null, relaxed: paper && !active ? PAPER_VALUE_RELAXED : null,
          coreMax: paper ? coreMax : 0, fixtureRoom: paper && fixtureRoom(r.roomId),
          // (Round 5: its wall's centre line, and how far from it is beside it: PAPER_NEAR_WALL_MM.)
          seg: paper && !active ? [fr.A, fr.B] : null, nearMax: paper ? PAPER_NEAR_WALL_MM * gwp : 0, fixBoxes: paper ? soft : null,
          segs: paper && !active ? (r.sides || []).map((sd) => [geo.nodes.get(sd.from), geo.nodes.get(sd.to)]).filter(([a, b]) => a && b) : null,
          fallback: paper && !active ? offCores(vCands.concat(...later)) : null,
          // Screen, the side being typed: its groups one after another (above).
          groupsOf: activeGroups ? () => activeGroups : null, steps: activeGroups ? ACTIVE_STEPS : null,
        });
      }
    }
    if (paper) addSpanTotals();
  }

  // Paper: each h / v wall's windows and doors as spans along it (Map wall box → [[lo, hi]] world mm on x for
  // a horizontal wall, y for a vertical one): there the wall is drawn white, not black, and a value may come
  // closer than PAPER_WALL_GAP_MM (예시 세대 A '베란다1 430' right beside a window).
  function wallOpenings() {
    if (!wallOpen) {
      wallOpen = new Map();
      for (const wb of wallBoxes) {
        if (!wb.edgeId || (wb.orient !== 'h' && wb.orient !== 'v')) continue;
        const spans = openingSpansOf({ edgeIds: [wb.edgeId] });
        if (spans.length) wallOpen.set(wb, spans.map((sp) => (wb.orient === 'h' ? [sp.point.x - sp.W / 2, sp.point.x + sp.W / 2] : [sp.point.y - sp.W / 2, sp.point.y + sp.W / 2])));
      }
    }
    return wallOpen;
  }

  // Windows and doors of a side's walls along it: [{ point, W }] (their centre, the drawn width).
  function openingSpansOf(side) {
    if (!openingSpans) {
      openingSpans = new Map();
      for (const op of project.openings || []) {
        let g = null;
        try { g = openingLabelGeometry(op, project, derived); } catch (_) { g = null; }
        if (!g || !g.anchor || !g.anchor.point) continue;
        const list = openingSpans.get(op.edge) || [];
        list.push({ point: g.anchor.point, W: g.anchor.width || 0 });
        openingSpans.set(op.edge, list);
      }
    }
    return (side.edgeIds || []).flatMap((id) => openingSpans.get(id) || []);
  }

  // → (cand) => true when a spot in front of the fixtures along side fr of room r stays in the room, nearer
  // this side than the opposite one: its centre no further from the side's centre line than 60 % (share) of the
  // room's depth there (the first other face of the room straight across, core: the room's face outline; a
  // 드레스룸 with a 옷장 along each side writes the side's value between them, in the middle).
  function frontSpotOk(r, fr, share = 0.6) {
    const pts = r.face && r.face.points;
    if (!Array.isArray(pts) || pts.length < 3) return () => true;
    const P = { x: (fr.A.x + fr.B.x) / 2, y: (fr.A.y + fr.B.y) / 2 };
    let depth = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = fr.n.x * ey - fr.n.y * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = a.x - P.x, wy = a.y - P.y;
      const t = (wx * ey - wy * ex) / den, u = (wx * fr.n.y - wy * fr.n.x) / den;
      if (t > 1 && u >= -1e-9 && u <= 1 + 1e-9) depth = Math.min(depth, t);
    }
    return (c) => {
      if (!c || !c.box) return false;
      const q = (c.x - fr.A.x) * fr.n.x + (c.y - fr.A.y) * fr.n.y;
      return q <= share * depth && pointInPolygon({ x: c.x, y: c.y }, pts);
    };
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
      // As the per-side values: no smaller than the room heights, inside its room (addValues).
      const small = font.height / font.measure;
      const mk = (s, shift, extra = band) => valueCand(v, fr, s, shift, extra);
      const cands = [mk(1, 0), mk(0.85, 0), mk(1, fr.L / 4), mk(1, -fr.L / 4), mk(1, 0, 2 * band), mk(small, 0), mk(small, fr.L / 4), mk(small, -fr.L / 4),
        // More spots before the least overlap (final review 2026-10-28: '전체 2275' on its 현관's '(1225)').
        mk(0.85, fr.L / 3), mk(0.85, -fr.L / 3), mk(0.85, 0, 2 * band), mk(small, 0, 2 * band), mk(small, fr.L / 3, 2 * band), mk(small, -fr.L / 3, 2 * band),
        mk(small, 0, 0), mk(small, fr.L / 4, 0), mk(small, -fr.L / 4, 0)];
      const own = cands.filter((c) => roomAt(c) === part.roomId);
      // (At 1:150 smaller too, as the per-side values: PAPER_STYLE.smallValuePt.)
      const later = smallOk
        ? PAPER_STYLE.smallValuePt.map((pt) => {
          const s2 = pt / font.measure;
          return [mk(s2, 0), mk(s2, fr.L / 4), mk(s2, -fr.L / 4), mk(s2, 0, 2 * band), mk(s2, 0, 0), mk(s2, fr.L / 4, 0), mk(s2, -fr.L / 4, 0)]
            .filter((c) => roomAt(c) === part.roomId);
        })
        : [];
      const list = own.length ? own : cands;
      add({
        id: `t:${sp.measureId}`, kind: 'value', refId: part.roomId, v, cands: list,
        prio: P.value, sub: 0.5, mustShow: true, hard: columns, soft: fixSoft, notInside: cores, walls: wallBoxes,
        passes: PAPER_VALUE_PASSES, costs: PAPER_COSTS, repair: true,
        later, relaxed: PAPER_VALUE_RELAXED, coreMax, fallback: offCores(list.concat(...later)),
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
    // far beyond the wall's outer face instead (the screen, the side being typed). The bubble of the side
    // being typed is 10 px wider than its text (below): beside a vertical wall it keeps 1 px from the face
    // (round 4: its box touched the wall face exactly, and the solve's rounding decided whether every spot of
    // it in its room was 'on the wall': C4's 방2 3450 went outside the house at one scale, not 0.25 % off it).
    const across = Math.abs(fr.n.x) * (tw / 2 + (v.active ? 1 : 0)) + Math.abs(fr.n.y) * (px * 0.6) + 5;
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
    return { x: c.x, y: c.y, px, tw, box, noteC, notePx, extra };
  }

  // A value written along a diagonal side: turned to the side (upright), its centre half its height
  // + 5 px inside the inner face (as valueCand for a horizontal side); the note goes further in.
  // Collisions use `shape` (the turned rectangles); overlap areas `parts` (small boxes along them).
  function valueCandAlong(v, fr, s, shift, extra = 0) {
    const px = font.measure * s;
    const tw = measure(v.text + v.flag, px, v.bold ? 'bold' : 'normal');
    const rot = uprightAngle(fr.dir);
    const w = W(tw + (v.active ? 10 : 0)), h = W(px * (v.active ? 1.5 : 1.2));
    const off = fr.inner + extra + W(px * 0.6 + 5);
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
    return { x: c.x, y: c.y, px, tw, box: boxOf(poly), shape, parts, rot, noteSign, noteC, notePx, extra };
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
      // The screen keeps its own window / door spots, beyond the doors' swings (core/labels.js opts.screen; user
      // 2026-11-01: the rules for texts over lines are the paper's).
      screen: !paper,
      extraDepth: o.sideLabels ? SIDE_VALUE_BAND_PX.map(W) : 0,
      fixtureBoxes: fixtures, obstacles: extra,
      // The plain boxes' inner outline (draw-fixtures.js): their labels keep inside it.
      fixtureInner: paper ? fixtureInnerLineMM({ worldPerPaperMM: o.paperText.gapWorldPerPaperMM }) : fixtureInnerLineMM({ pxPerMM: k }),
    });
    // Paper: the fixture labels first, so that the first spot of each joins the fixtures' middles (cores)
    // before the window / door labels take their obstacles (their own order among themselves is kept).
    const seq = paper ? labels.filter((l) => l.kind === 'fixture').concat(labels.filter((l) => l.kind !== 'fixture')) : labels;
    const fixItems = [];
    for (const l of seq) {
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
        if (opening) return distToSpot(l.base, c) <= (l.span || 0) / 2 + W(48);
        const own = fixtures.find((f) => f.id === l.refId);
        return !own || boxGap(own, c.box) <= W(24);
      };
      let cands = (l.cands || []).filter(near).map((c) => ({ ...c, rotDeg: c.rot }));
      if (!cands.length) continue;
      // Paper: a fixture's label stays in its box, smaller and moved along it where something is in the
      // way, never pushed out onto a value (final review 2026-10-28: the '변기' label written on the
      // 화장실's top value '900'). The spot just outside its front only when it is free.
      const ownBox = !opening ? fixtures.find((f) => f.id === l.refId) : null;
      let inBox = null, fixTiers = null;
      if (paper && !opening && !l.moved && ownBox && cands[0]) {
        const inside = (c) => c.box && c.box.minX >= ownBox.minX - 1 && c.box.maxX <= ownBox.maxX + 1 && c.box.minY >= ownBox.minY - 1 && c.box.maxY <= ownBox.maxY + 1;
        const c0 = cands[0];
        const scaled = (s, dx = 0, dy = 0) => {
          const w = c0.w * s, h = c0.h * s, x = c0.x + dx, y = c0.y + dy;
          return { ...c0, x, y, w, h, lines: c0.lines.map((ln) => ({ ...ln, size: ln.size * s })), box: boxAt(x, y, w, h, c0.rot) };
        };
        const more = [];
        const longX = ownBox.maxX - ownBox.minX >= ownBox.maxY - ownBox.minY;
        for (const s of [1, 0.8, 0.65]) {
          const b = scaled(s).box;
          const room = longX ? (ownBox.maxX - ownBox.minX) - (b.maxX - b.minX) : (ownBox.maxY - ownBox.minY) - (b.maxY - b.minY);
          for (const f of [0.25, -0.25, 0.45, -0.45]) {
            const d = room * f;
            if (Math.abs(d) > 1) more.push(longX ? scaled(s, d, 0) : scaled(s, 0, d));
          }
          if (s < 0.8) more.push(scaled(s));
        }
        more.push(scaled(0.5));
        inBox = cands.filter(inside).concat(more.filter(inside));
        // Not under PAPER_FIXTURE_MIN_SHARE of its size where anything else fits (round 4: 2.2–3.9 pt in a corner of
        // its box, about 1 mm tall on paper): its spots in the box at that size or larger; then its name alone (the size
        // line left out) in the box, centred over the box (running over its outline, a thin line) and just beside it
        // (its front first, in the same room, off the walls), from its size down to that one; then just beside its front
        // with its size (core/labels.js); the smaller spots in the box last. (Other fixtures' outlines are no obstacle,
        // their middles and labels are: fixItems.)
        const minPt = PAPER_FIXTURE_MIN_SHARE * LP.fixture;
        const big = (c) => (c.lines || []).every((ln) => ln.size >= minPt - 1e-6);
        const full = (c0.lines || []).map((ln) => ln.text).join(' ');
        const m = /^(.*\S)\s+(\d[\d*×x]*)$/.exec(full);
        const nameOnly = [];
        if (c0.lines && c0.lines.length) {
          const ln0 = c0.lines[0];
          // (A label without a size, '보일러': the label itself, centred over its box at those sizes.)
          const name = m ? m[1] : full;
          const turned = c0.rot === 90 || c0.rot === -90;
          const along = turned ? ownBox.maxY - ownBox.minY : ownBox.maxX - ownBox.minX;
          const across = turned ? ownBox.maxX - ownBox.minX : ownBox.maxY - ownBox.minY;
          const tw1 = W(measure(name, 10, ln0.weight || 'normal')) / 10;
          // As large as fits the box (95 %), at most the fixture labels' size.
          const fit = Math.min(LP.fixture, (0.95 * along) / tw1, (0.95 * across) / W(1.2));
          const sizes = [];
          for (const f of [1, 0.85, 0.7]) if (fit * f >= minPt - 1e-6 && fit * f <= LP.fixture + 1e-6) sizes.push(fit * f);
          if (!sizes.length || sizes[sizes.length - 1] > minPt + 1e-6) sizes.push(minPt);
          const at = (sz, x, y, rot) => {
            const lines = [{ ...ln0, text: name, size: sz }];
            const w = W(measure(name, sz, ln0.weight || 'normal')), h = W(sz * 1.2);
            return { ...c0, x, y, w, h, rot, lines, box: boxAt(x, y, w, h, rot), nameOnly: !!m };
          };
          const cx = (ownBox.minX + ownBox.maxX) / 2, cy = (ownBox.minY + ownBox.maxY) / 2;
          for (const sz of sizes) {
            nameOnly.push(at(sz, cx, cy, c0.rot));
            const room = along - W(measure(name, sz, ln0.weight || 'normal'));
            for (const f of [0.25, -0.25]) if (room * f > 1) nameOnly.push(turned ? at(sz, cx, cy + room * f, c0.rot) : at(sz, cx + room * f, cy, c0.rot));
          }
        }
        // Just beside the box's front (the side of core/labels.js's spot outside it), across, name alone.
        // (Then beside its other sides: C5's '보일러' hung over the 싱크대 has the 싱크대 in front of it.)
        const flat = cands.find((c) => !inside(c));
        const beside = [];
        if (flat && c0.lines && c0.lines.length) {
          const cx = (ownBox.minX + ownBox.maxX) / 2, cy = (ownBox.minY + ownBox.maxY) / 2;
          const dx = flat.x - cx, dy = flat.y - cy;
          const fx = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0, fy = fx ? 0 : Math.sign(dy);
          const sides = [[fx, fy], [-fx, -fy], [fy, fx], [-fy, -fx]].filter(([a, b]) => a || b);
          const text = m ? m[1] : full;
          const ln0 = c0.lines[0];
          const g = gwp * PAPER_TEXT_GAP_MM;
          for (const [sx, sy] of sides) {
            for (const sz of [LP.fixture, 0.85 * LP.fixture, 0.7 * LP.fixture, minPt]) {
              const w = W(measure(text, sz, ln0.weight || 'normal')), h = W(sz * 1.2);
              const x = sx ? (sx > 0 ? ownBox.maxX + g + w / 2 : ownBox.minX - g - w / 2) : cx;
              const y = sy ? (sy > 0 ? ownBox.maxY + g + h / 2 : ownBox.minY - g - h / 2) : cy;
              beside.push({ ...c0, x, y, w, h, rot: 0, lines: [{ ...ln0, text, size: sz }], box: boxAt(x, y, w, h, 0), nameOnly: !!m });
            }
          }
        }
        const offWalls = (c) => !labelWalls.some((h) => obstacleHit(c.box, null, h));
        const inBig = inBox.filter(big), inSmall = inBox.filter((c) => !big(c));
        const named = nameOnly.filter((c) => (inside(c) || offWalls(c)));
        inBox = inBig.concat(named.filter(inside));
        const home = roomAt({ x: (ownBox.minX + ownBox.maxX) / 2, y: (ownBox.minY + ownBox.maxY) / 2 });
        const outside = named.filter((c) => !inside(c)).concat(beside.filter((c) => offWalls(c) && roomAt(c) === home), cands.filter((c) => !inside(c) && offWalls(c)));
        // Its spots outside the box only off the walls (round 3 finisher: C4's '보일러', its box taken up to its
        // edge by the 세탁실 door's label, went just outside it onto the wall at full size; now it stays in its
        // box). A spot in the box over the wall a fixture is set into stays (신발장 in the wall).
        if (inBox.length || inSmall.length) {
          cands = inBox.concat(outside, inSmall);
          inBox = inBox.concat(inSmall);
        } else inBox = null;
        // The texts placed before it keep off its first spot, grown by the gap between texts, as off the fixture's
        // middle (texts over lines), and the values off its line across the box, and in line with it closer than the
        // line gap past the box's ends (lineBand; round 4: E5's '3800' on the bottom outline right below '싱크대 2400',
        // read as its continuation; A1's '1675' turned along its wall into the top end of the 신발장, above '신발장').
        // (Its first spot also where it crosses its box's outline, core/labels.js's spot for it: E5's '싱크대 2400'.)
        const first = inBox ? inBox[0] : cands[0] && cands[0].box ? cands[0] : null;
        if (first) {
          const b0 = first.box, g = gwp * PAPER_TEXT_GAP_MM;
          const t = { minX: b0.minX - g, minY: b0.minY - g, maxX: b0.maxX + g, maxY: b0.maxY + g, text: true, of: l.refId };
          cores.push(t);
          nameSoft.push(t);
          // The spots the texts before it leave one of free (reserves, below): in its box with all its lines at 80 %
          // of its size or more, else at PAPER_FIXTURE_MIN_SHARE or more, else any.
          const size0 = c0.lines && c0.lines[0] ? c0.lines[0].size : LP.fixture, n0 = (c0.lines || []).length;
          if (inBox) fixTiers = [inBox.filter((c) => big(c) && !c.nameOnly && (c.lines || []).length === n0 && c.lines[0].size >= 0.8 * size0 - 1e-6), inBox.filter(big), inBox];
          const h = b0.maxX - b0.minX >= b0.maxY - b0.minY;
          const ax0 = Math.min(ownBox.minX, b0.minX), ax1 = Math.max(ownBox.maxX, b0.maxX), ay0 = Math.min(ownBox.minY, b0.minY), ay1 = Math.max(ownBox.maxY, b0.maxY);
          labelLines.push(h
            ? { minX: ax0, maxX: ax1, minY: b0.minY, maxY: b0.maxY, line: { h, c0: b0.minY, c1: b0.maxY, a0: ax0, a1: ax1 } }
            : { minX: b0.minX, maxX: b0.maxX, minY: ay0, maxY: ay1, line: { h, c0: b0.minX, c1: b0.maxX, a0: ay0, a1: ay1 } });
        }
      }
      // (A fixture's label placed by hand: the values keep off its line too, lineBand; E5's '싱크대 2400', moved by hand
      // half over its box's edge, had '3800' right below it on the box's bottom outline.)
      if (paper && !opening && l.moved && ownBox && cands[0] && cands[0].box) {
        const b0 = cands[0].box, h = b0.maxX - b0.minX >= b0.maxY - b0.minY;
        const ax0 = Math.min(ownBox.minX, b0.minX), ax1 = Math.max(ownBox.maxX, b0.maxX), ay0 = Math.min(ownBox.minY, b0.minY), ay1 = Math.max(ownBox.maxY, b0.maxY);
        labelLines.push(h
          ? { minX: ax0, maxX: ax1, minY: b0.minY, maxY: b0.maxY, line: { h, c0: b0.minY, c1: b0.maxY, a0: ax0, a1: ax1 } }
          : { minX: b0.minX, maxX: b0.maxX, minY: ay0, maxY: ay1, line: { h, c0: b0.minX, c1: b0.maxX, a0: ay0, a1: ay1 } });
      }
      // Other fixtures (a sink, a stair) block these labels on screen: with no free spot near its
      // window / door the label waits for a closer zoom instead of being written over the fixture
      // (plan §2-7 / 0.4.0 (f), (j)). A label placed by hand stays where it was put.
      const others = opening ? soft : soft.filter((f) => f.id !== l.refId);
      // Paper, texts over lines (PAPER_COSTS): a window / door label may lie over a fixture's outline, never
      // over its middle or label. Screen: off the fixtures.
      // A fixture's label too (round 4): over another fixture's outline (C5's '보일러' hung over the 싱크대, 3 pt in the
      // strip of its box the 싱크대 leaves), never over its middle or label (its own left out: fixItems, after the loop).
      const fixHard = paper && opening ? cores : paper && !opening && !l.moved ? [] : others;
      // When every spot overlaps something (paper; the text being dragged), the least overlapping
      // ATTACHED one is taken, never one beyond the per-side values, and one that reads as another
      // opening's label (core/labels.js misleading) only when there is no other.
      const attached = opening ? cands.filter((c) => c.attached !== false) : null;
      const clean = attached ? attached.filter((c) => !c.misleading) : null;
      // Paper: the attached spots also at 70 %, their near edge where it was (shrinkLabel), after those at full
      // size and 85 % and before any stacked spot (final review round 2: in a small 현관 / 욕실 a door label with
      // no free attached spot went over the wall beside its door or onto a 옷장 across the wall).
      const small = paper && opening && !l.moved && clean ? shrunkSpots(clean, l, 0.7) : [];
      // (smallOk: then smaller still, OPENING_TINY_SCALES of the full size in turn, after every other spot: group 4.)
      const tiny = smallOk && opening && !l.moved && clean ? tinySpots(clean, l) : [];
      // (A spot of `small` at 70 % of the 85 % step, under 70 % of the full size: PAPER_LABEL_STEPS group 7.)
      const under70 = (c) => !!(c.lines && c.lines[0] && c.lines[0].size < 0.7 * LP.opening - 1e-6);
      // Paper: the spots this label can take, for the values and names placed before it to leave one of
      // free (resolveText): a window / door label's attached spots that do not read as another opening's,
      // a fixture's spots in its box; each off the walls and the other fixtures. With none such at full size and
      // 85 % (a door label longer than its small room's wall: A2's 'ABS도어 700*2000' in the 욕실, round 3), its
      // spots at 70 %; with none such either (a 600 door between a 보일러 and a wall), the ones it would take
      // anyway, over the least of them (its fallback).
      if (paper && !l.moved) {
        const hardOf = opening ? columns.concat(labelWalls, extra, fixHard) : columns.concat(extra, others);
        const own = (opening ? cands.filter((c) => c.attached !== false && !c.misleading) : (inBox || [])).filter((c) => c.box);
        const clear = (list) => list.filter((c) => !hardOf.some((h) => obstacleHit(c.box, c.shape || null, h)));
        let all = clear(own);
        if (!all.length) all = clear(small);
        if (!all.length && own.length) {
          const cost = (c) => hardOf.reduce((sum, h) => sum + shapeOverlap(c.box, c.parts || null, h), 0);
          const least = Math.min(...own.map(cost));
          all = own.filter((c) => cost(c) <= 1.5 * least + 1e-6);
        }
        // A fixture's label (round 4): its spots by size, the larger ones kept first (fixTiers; a value or a name took
        // every spot of '세탁기 600' with its size, or of '변기' at 80 % or more, and it was written 3–5 pt in a corner).
        let spots = [];
        for (const tier of !opening && fixTiers ? fixTiers : []) {
          if (spots.length) break;
          spots = clear(tier.filter((c) => c.box));
        }
        if (!spots.length) spots = all;
        // (A spot along a diagonal wall by its turned rectangle: the box around it would be taken by far more.)
        if (spots.length) reserves.push({ id: l.key, spots: spots.map((c) => (c.shape ? { ...c.box, shape: c.shape, parts: c.parts } : c.box)) });
      }
      // Screen: window / door labels keep off the other doors' swings where a spot allows it (l.avoid; on
      // paper a label may lie over a swing).
      const swings = !paper && opening && !l.moved && Array.isArray(l.avoid) ? l.avoid : [];
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
        hard: (opening && !l.moved ? columns.concat(labelWalls, extra) : columns.concat(extra)).concat(l.moved ? [] : fixHard),
        // Paper: a window / door label keeps off the fixtures' whole boxes in its first pass, over their outlines only
        // after every attached spot off them (PAPER_LABEL_STEPS; round 4: D5's '현관문 1000*2100' at 85 % inside the
        // 계단실 over the stair's treads, 15 mm from its door, while the spot right outside it was free).
        // (And off the thin finish layers, printed black with their walls, in that pass: C4 turned, 'ABS도어/700*2000'.)
        soft: (l.moved ? others.concat(opening ? wallBoxes : []) : (paper && opening ? others.concat(nameWalls.filter((w) => !labelWalls.includes(w))) : [])).concat(swings),
        // Paper, a window / door label with no free spot: the least overlap among its spots off the walls where it has
        // any (rule 3; round 4: D2 turned at 1:75, 'ABS도어 600*2000' at 5.24 pt on the 복도's bottom wall, 8.9 mm²,
        // which weighed less than a text).
        fallback: ((list) => (paper && opening && !l.moved && list
          ? (() => { const off = list.filter((c) => c.box && !labelWalls.some((h) => obstacleHit(c.box, c.shape || null, h))); return off.length ? off : list; })()
          : list))(clean && clean.length ? clean.concat(small) : attached && attached.length ? attached : inBox),
        // Paper: a window / door label leaves the other labels' last spots free too where it can.
        passes: paper && opening && !l.moved ? [{ soft: true, reserve: true }, { reserve: true }, {}] : null,
        costs: paper ? PAPER_COSTS : null, repair: paper && !l.moved, relocatable: paper && opening && !l.moved,
        // Tried in this order in each pass: the attached spots; the stacked spots (only beyond a
        // value, see pick); the spots that read as another opening's label. When no attached spot
        // is free because ONE per-side value takes it, that value moves along its wall instead
        // (resolveText displaceValue), before any stacked spot.
        groupsOf: opening && !l.moved
          ? (cs, chosen) => [
            cs.filter((c) => c.attached !== false && !c.misleading && !c.pastSwing),
            () => cs.filter((c) => c.attached === false).filter(stackOk(chosen)),
            () => cs.filter((c) => c.attached !== false && c.misleading),
            small.filter((c) => !c.pastSwing && !under70(c)),
            tiny,
            small.filter((c) => c.pastSwing),
            cs.filter((c) => c.attached !== false && !c.misleading && c.pastSwing),
            small.filter((c) => !c.pastSwing && under70(c)),
          ]
          : null,
        displace: opening && !l.moved,
        stillValid: opening ? (c, chosen) => !c.stack || valueBehind(c, l, valueBoxes(chosen)) : null,
        // Paper: every attached spot before a stacked one (PAPER_LABEL_STEPS); a stacked or misleading spot
        // taken because the attached ones were taken when it came goes back to one free at the end (improve).
        steps: paper && opening && !l.moved ? PAPER_LABEL_STEPS : null, improve: paper && opening && !l.moved, small,
      });
      if (paper && !opening && !l.moved) fixItems.push(items[items.length - 1]);
    }
    // (Paper fixture labels: the other fixtures' middles and labels' first spots, once every label has added its own.)
    for (const it of fixItems) it.hard = it.hard.concat(cores.filter((c) => c.id !== it.refId && c.of !== it.refId));
  }

  // Window / door label l's spots cs at scale s: each shrunk with its edge toward the wall kept where it was
  // (right at the wall face, or just beyond a door's swing) and its middle along the wall. Labels across
  // their wall only (rot 0 / ±90). → [cand], flagged small
  function shrunkSpots(cs, l, s) {
    if (!l.base || !l.dir) return [];
    const n = { x: -l.dir.y, y: l.dir.x };
    const out = [], seen = new Set();
    for (const c of cs) {
      if (!c.box || !(c.w > 0) || (c.rot && Math.abs(c.rot) !== 90)) continue;
      const off = (c.x - l.base.x) * n.x + (c.y - l.base.y) * n.y, sg = off >= 0 ? 1 : -1;
      const ext = Math.abs(n.x) * (c.box.maxX - c.box.minX) + Math.abs(n.y) * (c.box.maxY - c.box.minY);
      const d = Math.abs(off) - ext / 2 + (s * ext) / 2;
      // Beside the opening (past its end): its end toward the opening stays where it was too.
      let along = (c.x - l.base.x) * l.dir.x + (c.y - l.base.y) * l.dir.y;
      const aExt = Math.abs(l.dir.x) * (c.box.maxX - c.box.minX) + Math.abs(l.dir.y) * (c.box.maxY - c.box.minY), half = (l.span || 0) / 2;
      if (along - aExt / 2 >= half - 1e-6) along -= ((1 - s) * aExt) / 2;
      else if (along + aExt / 2 <= -half + 1e-6) along += ((1 - s) * aExt) / 2;
      const x = l.base.x + l.dir.x * along + n.x * sg * d, y = l.base.y + l.dir.y * along + n.y * sg * d;
      const box = boxAt(x, y, c.w * s, c.h * s, c.rot);
      const key = [box.minX, box.minY, box.maxX, box.maxY].map((v) => Math.round(v)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, x, y, w: c.w * s, h: c.h * s, lines: (c.lines || []).map((ln) => ({ ...ln, size: ln.size * s })), box, small: true });
    }
    return out;
  }

  // Window / door label l's attached spots cs at OPENING_TINY_SCALES of its full size in turn (shrunkSpots: each with its
  // edge toward the wall where it was), the larger first. → [cand], flagged small and tiny
  function tinySpots(cs, l) {
    const out = [], seen = new Set();
    for (const t of OPENING_TINY_SCALES) {
      for (const c of cs) {
        const s0 = c.lines && c.lines[0] && c.lines[0].size > 0 ? c.lines[0].size / LP.opening : 1;
        if (!(t < s0 - 1e-9)) continue;
        for (const q of shrunkSpots([c], l, t / s0)) {
          const key = [q.box.minX, q.box.minY, q.box.maxX, q.box.maxY].map((v) => Math.round(v)).join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ ...q, tiny: true });
        }
      }
    }
    return out;
  }

  // The boxes of the per-side values placed so far (items 'v:…', and span totals 't:…').
  function valueBoxes(chosen) {
    const out = [];
    for (const [id, v] of chosen) if (v && v.box && /^[vt]:/.test(id)) out.push(v.shape ? v.shape[0] : v.box);
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
      // (A text turned along a diagonal side or wall by its own corners.)
      for (const [x, y] of Array.isArray(b) ? b.map((q) => [q.x, q.y]) : [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
        const a = (x - P.x) * d.x + (y - P.y) * d.y, q = (x - P.x) * n.x + (y - P.y) * n.y;
        if (a < a0) a0 = a;
        if (a > a1) a1 = a;
        if (q < c0) c0 = q;
        if (q > c1) c1 = q;
      }
      return { a0, a1, c0, c1 };
    };
    // Under it along the wall by at least half the shorter of the two (final review round 2: a '3850' under
    // the end of a door label by 0.6 paper mm let it float 17 mm from its door over the 중정, nothing between).
    const L = proj(c.shape ? c.shape[0] : c.box), eps = W(2);
    for (const vb of vals) {
      const V = proj(vb);
      const under = Math.min(V.a1, L.a1) - Math.max(V.a0, L.a0);
      if (V.c0 >= c.stack.face - eps && V.c1 <= L.c0 + eps && under > 0.5 * Math.min(V.a1 - V.a0, L.a1 - L.a0)) return true;
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
// The same from a point to a label's spot, one written along a diagonal wall by its turned rectangle.
function distToSpot(p, c) {
  if (!c.shape) return distToBox(p, c.box);
  const a = (c.rot * Math.PI) / 180, dx = p.x - c.x, dy = p.y - c.y;
  const u = dx * Math.cos(a) + dy * Math.sin(a), v = dy * Math.cos(a) - dx * Math.sin(a);
  return Math.hypot(Math.max(Math.abs(u) - c.w / 2, 0), Math.max(Math.abs(v) - c.h / 2, 0));
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
// it.passes (optional): the passes in order, each { walls, soft, cores, reserve } = what that pass keeps
// off (it.walls: the walls, kept apart from it.soft so a pass can drop the fixtures and keep the walls;
// it.cores (paper names): the fixtures' middles alone; it.lines (paper values): the lines of the fixtures'
// labels across their boxes, kept off with soft, the text's middle off them in the 'best' pass (as
// notInside); reserve: the last free spot of a label still to come,
// see below; best: of the spots the pass allows, the one over the least of the fixtures, not the first).
// Without: off soft, then off neither. it.lineGap (paper): two texts side by side on one line keep this
// far apart along it. it.costs: the least-overlap weights (PAPER_COSTS). it.repair (paper): after each
// pass, a spot where only one or two movable texts are in the way, which move (repair).
// reserves (paper): [{ id: the label item's id, spots: [box] }], the spots each window / door and fixture
// label still to be placed can take; a text in a pass with `reserve` never takes the last of a label's
// spots that are still free (in no pass of the label itself).
// it.steps (paper window / door labels, PAPER_LABEL_STEPS): [group, pass, 'try' | 'displace' | 'repair'] in
// order, instead of every group in each pass. it.wallGap (paper values): kept from the walls (it.walls).
// it.notInside (paper values and names): boxes the 'best' pass never puts the text's middle in (the
// fixtures' middles). A pass with centreOff (screen values) never puts the text's middle in it.offBoxes (the
// fixtures' boxes).
// it.improve (paper; improve below): at the end, a text that came out shrunk or on something takes a
// better spot of its own that is free then. paperMode: run that last step.
// Round 4 (paper): a pass with `labels` keeps off more than it.coreMax of the fixtures' middles (it.notInside entries
// flagged core); the lines (it.lines) also by their extent along the label's line past the box's ends (lineBand); a
// pass with `loose` does not keep off the lines. it.later: lists of a value's further spots tried in its passes after
// its last resorts (the best pass taking the spot over the least of the fixtures); it.relaxed: its passes after its
// room's repack, then the repack again with them (repackRoom loose).
function resolveText(items, reserves = null, paperMode = false) {
  // What the best pass weighs: the fixtures (paper: their middles and labels).
  const fixtureCost = (it, c) => {
    const b = it.boxOf ? it.boxOf(c) : c.box, parts = it.boxOf ? null : (c.parts || null);
    return it.soft.reduce((sum, o) => sum + shapeOverlap(b, parts, o), 0);
  };
  items.sort((a, b) => a.prio - b.prio || a.sub - b.sub || a.order - b.order);
  const placed = [];
  const shown = [];
  const chosen = new Map();
  const itemOf = new Map();
  const spanOf = (list) => list.reduce((u, x) => unionBox(u, x), list[0]);
  const res = (reserves || []).filter((r) => r.spots.length).map((r) => ({ id: r.id, spots: r.spots, free: r.spots.slice(), bbox: spanOf(r.spots) }));
  const freeAgain = (gap) => {
    for (const r of res) if (!r.done) r.free = r.spots.filter((s) => !placed.some((p) => pairHit(s, s.shape || null, p.box, p.shape, gap)));
  };
  // The spots of the labels still to come that a text at b would take, when it takes the last free one
  // (except: a label being placed right now, whose spots no longer need keeping).
  const takenLast = (it, b, sh, except = null) => {
    let area = 0;
    for (const r of res) {
      if (r.id === it.id || r.id === except || !r.free.length || !boxesHit(b, r.bbox, it.gap)) continue;
      if (r.free.every((s) => pairHit(b, sh, s, s.shape || null, it.gap))) area += Math.min(...r.free.map((s) => shapeOverlap(b, null, s, s.parts || null))) + 1e-6;
    }
    return area;
  };
  // A text on a wall, or closer to it than it.wallGap where the wall is drawn black (not along a window or door
  // in it, it.wallOpen).
  const wallHit = (it, b, sh) => (it.walls || []).some((o) => obstacleHit(b, sh, o)
    || (it.wallGap > 0 && obstacleHit(b, sh, o, it.wallGap) && !nearOpening(b, o, it.wallGap, it.wallOpen)));
  // The 'best' pass of a paper value or name: its middle in a fixture's middle reads as the fixture's size (a
  // name and its H each by its own middle, spot c).
  // A text in line with a fixture's label (its extent across the label's line over a quarter of the smaller one's) and
  // along it over the box or closer than it.lineGap past its ends: it reads as part of the label (the fixture's size).
  const lineBand = (it, b) => Array.isArray(it.lines) && it.lines.some((o) => {
    const L = o.line;
    if (!L) return false;
    const c0 = L.h ? b.minY : b.minX, c1 = L.h ? b.maxY : b.maxX, a0 = L.h ? b.minX : b.minY, a1 = L.h ? b.maxX : b.maxY;
    const across = Math.min(c1, L.c1) - Math.max(c0, L.c0);
    if (!(across > 0.25 * Math.min(c1 - c0, L.c1 - L.c0))) return false;
    const g = it.lineGap || 0;
    return a1 > L.a0 - g && a0 < L.a1 + g;
  });
  const inside = (it, b, c, lines = true) => {
    if (lines && lineBand(it, b)) return true;
    const boxes = (Array.isArray(it.notInside) ? it.notInside : []).concat(lines && Array.isArray(it.lines) ? it.lines : []);
    if (!boxes.length) return false;
    return (c && c.nameBox ? [c.nameBox, c.hBox].filter(Boolean) : [b]).some((m) => {
      const x = (m.minX + m.maxX) / 2, y = (m.minY + m.maxY) / 2;
      return boxes.some((f) => x > f.minX && x < f.maxX && y > f.minY && y < f.maxY);
    });
  };
  // Is a text of item it at b (shape sh, parts; spot c) clear of what pass P keeps it off (not the other texts)?
  // Paper: all but the labels' last spots (reserve) does not change while the texts are placed, remembered per item, spot
  // and pass (round 4: a room's values placed again for every spot of its name, D1 at 1:150 three times slower).
  const memo = paperMode ? new Map() : null;
  // A pass with the fixtures' labels yielding (window / door labels, PAPER_LABEL_STEPS 'yield'), one per pass (the memo keys
  // on it); the labels placed so (improve weighs their spots, and the others, the same way).
  const yields = new Map(), yielded = new Set();
  const yieldOf = (P) => { let y = yields.get(P); if (!y) yields.set(P, (y = { ...P, yieldFix: true })); return y; };
  const yieldRepairs = new Map();
  const yieldRepairOf = (P) => { let y = yieldRepairs.get(P); if (!y) yieldRepairs.set(P, (y = { ...yieldOf(P), labelsOnly: true })); return y; };
  // Round 5: a per-side value's spot c beside its wall (PAPER_NEAR_WALL_MM), or one of its own spots (it.cands: at its wall,
  // in front of a fixture against it, past a short side's ends), not one further into the room (it.later); true for every
  // other text.
  const ownSpots = new Map();
  const ownOf = (u) => { let o = ownSpots.get(u); if (!o) ownSpots.set(u, (o = new Set(u.cands))); return o; };
  const segDist = ([A, B], x, y) => {
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2)) : 0;
    return Math.hypot(A.x + dx * t - x, A.y + dy * t - y);
  };
  const wallDist = (u, c) => {
    const b = c && (u.boxOf ? u.boxOf(c) : c.box);
    if (!u.seg || !b) return 0;
    return segDist(u.seg, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  };
  // (And not much nearer another wall of its room than its own, PAPER_OTHER_WALL_MM, where it would read as that wall's:
  // A5 turned, the 현관's bottom '1225' in front of the right end of the 신발장, right beside the right wall.)
  const ownNearest = (u, c) => {
    const b = c && (u.boxOf ? u.boxOf(c) : c.box);
    if (!u.seg || !b || !Array.isArray(u.segs)) return true;
    const x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2, d = segDist(u.seg, x, y) - u.nearMax / PAPER_NEAR_WALL_MM * PAPER_OTHER_WALL_MM;
    return u.segs.every((sg) => (sg[0] === u.seg[0] && sg[1] === u.seg[1]) || segDist(sg, x, y) >= d);
  };
  // (A further spot never with its middle in a fixture's box or on its outline, where it reads as the fixture's size
  // although clear of the fixture's middle and its label's line: A4's 현관 '1050' turned along its wall, centred on the
  // front of the 신발장.)
  const inFixture = (u, c) => {
    const b = c && (u.boxOf ? u.boxOf(c) : c.box);
    if (!b || !Array.isArray(u.fixBoxes)) return false;
    const x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2, e = 1;
    return u.fixBoxes.some((f) => x >= f.minX - e && x <= f.maxX + e && y >= f.minY - e && y <= f.maxY + e);
  };
  const nearOf = (u, c) => !u.seg || (((Array.isArray(u.cands) && ownOf(u).has(c)) || (wallDist(u, c) <= u.nearMax && !inFixture(u, c))) && ownNearest(u, c));
  const nearList = (u, list) => list.filter((c) => nearOf(u, c));
  const fixedOf = (it, b, sh, parts, P, c) => {
    if (!memo || !c) return fixedOk(it, b, sh, parts, P, c);
    let mi = memo.get(it);
    if (!mi) memo.set(it, (mi = new Map()));
    let mc = mi.get(c);
    if (!mc) mi.set(c, (mc = new Map()));
    let ok = mc.get(P);
    if (ok === undefined) mc.set(P, (ok = fixedOk(it, b, sh, parts, P, c)));
    return ok;
  };
  const obstaclesOk = (it, b, sh, parts, P, except = null, c = null) => {
    if (!fixedOf(it, b, sh, parts, P, c)) return false;
    if (P.reserve && res.length && takenLast(it, b, sh, except) > 0) return false;
    return true;
  };
  const fixedOk = (it, b, sh, parts, P, c) => {
    // (P.yieldFix, a window / door label's 'yield' step: not the first spots of the fixtures' labels, flagged text.)
    if (it.hard.some((h) => !(P.yieldFix && h.text) && obstacleHit(b, sh, h))) return false;
    if (P.walls && wallHit(it, b, sh)) return false;
    if (P.soft && it.soft.some((o) => obstacleHit(b, sh, o))) return false;
    if (P.soft && it.lines && (it.lines.some((o) => obstacleHit(b, sh, o)) || lineBand(it, b))) return false;
    if (P.cores && it.cores && it.cores.some((o) => obstacleHit(b, sh, o))) return false;
    // (Paper, round 4: more than a sliver of a fixture's middle, it.coreMax.)
    if (P.labels && it.coreMax > 0 && Array.isArray(it.notInside)) {
      let a = 0;
      for (const f of it.notInside) if (f.core && boxesHit(b, f)) a += shapeOverlap(b, parts, f);
      if (a > it.coreMax) return false;
    }
    if (P.best && inside(it, b, c, !P.loose)) return false;
    // (Screen values, round 4: never with the text's middle in a fixture's box, it.offBoxes.)
    if (P.centreOff && Array.isArray(it.offBoxes)) {
      const x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2;
      if (it.offBoxes.some((f) => x > f.minX && x < f.maxX && y > f.minY && y < f.maxY)) return false;
    }
    return true;
  };
  const textHit = (it, b, sh, d, q) => boxesHit(b, q.box, Math.max(it.gap || 0, it.lineGap || 0))
    && (pairHit(b, sh, q.box, q.shape, it.gap) || sameLine(b, d, q.box, q.dir, it.lineGap));
  // The texts that may make room (repair): per-side values (not the one being typed), window / door
  // labels not placed by hand (their attached spots that read as their own) and room names not placed by
  // hand (with their H); the passes they move in (never onto a wall, a fixture or a label's last spot).
  const movesOf = (vi) => {
    if (!vi || !Array.isArray(vi.cands)) return null;
    // (A value also to its further spots, it.later; round 4: A4's 보일러실 '1050' could not make room for the name.)
    if (vi.kind === 'value' && !(vi.v && vi.v.active)) return { cands: vi.cands.concat(...(vi.later || [])), passes: (vi.passes || []).filter((p) => p.walls && p.soft && p.reserve) };
    if (vi.kind === 'opening' && vi.relocatable) return { cands: vi.cands.filter((c) => c.attached !== false && !c.misleading), passes: [{ soft: true, reserve: true }, { reserve: true }] };
    if (vi.kind === 'name' && vi.relocatable) return { cands: vi.cands, passes: (vi.passes || []).filter((p) => p.soft && p.reserve && !p.pushSmall) };
    return null;
  };
  // A placed text as the unit that moves: an H moves with its room's name.
  const unitOf = (q) => {
    const vi = itemOf.get(q.id);
    if (vi && vi.kind === 'height' && vi.ignore) {
      const nq = placed.find((x) => x.id === vi.ignore);
      return nq ? unitOf(nq) : null;
    }
    const recs = [q];
    if (vi && vi.kind === 'name') { const hq = placed.find((x) => x.id === `h:${vi.refId}`); if (hq) recs.push(hq); }
    return { q, vi, recs };
  };
  const REPAIR_CANDS = 160;
  // A unit's other spots clear of everything but the texts that move with it (worked out once per repair).
  const altsOf = (u, cache) => {
    if (cache.has(u.q.id)) return cache.get(u.q.id);
    const { vi } = u, mv = movesOf(vi);
    const out = [];
    if (mv && mv.passes.length) {
      const cur = chosen.get(u.q.id);
      const vBox = vi.boxOf || ((x) => x.box);
      const rest = placed.filter((x) => !u.recs.includes(x));
      const seen = new Set();
      mv.passes.forEach((VP, pi) => {
        for (const vc of mv.cands) {
          const vb = vBox(vc);
          if (vc === cur || !vb || seen.has(vc)) continue;
          const vs = vi.boxOf ? null : (vc.shape || null), vd = textDir(vi, vc, vs);
          if (!obstaclesOk(vi, vb, vs, vi.boxOf ? null : (vc.parts || null), VP, null, vc)) continue;
          if (rest.some((x) => textHit(vi, vb, vs, vd, x))) continue;
          seen.add(vc);
          out.push({ vc, rec: { box: vb, shape: vs, dir: vd }, pi });
        }
      });
    }
    cache.set(u.q.id, out);
    return out;
  };
  const repair = (it, list, P, boxOf, shapeOf, partsOf, dirOf) => {
    let n = 0;
    const cache = new Map();
    for (const c of list || []) {
      if (n++ >= REPAIR_CANDS) break;
      const b = boxOf(c);
      if (!b) continue;
      const sh = shapeOf(c), d = dirOf(c);
      if (!obstaclesOk(it, b, sh, partsOf(c), P, null, c)) continue;
      const hit = placed.filter((q) => q.id !== it.ignore && textHit(it, b, sh, d, q));
      if (!hit.length) continue;
      const units = [];
      for (const q of hit) {
        const u = unitOf(q);
        if (!u) { units.length = 0; units.push(null); break; }
        if (!units.some((x) => x && x.q === u.q)) units.push(u);
      }
      if (!units.length || units.includes(null) || units.length > 2) continue;
      const moves = [];
      for (const u of units) {
        const { q, vi } = u;
        if (!movesOf(vi) || (P.labelsOnly && vi.kind !== 'opening')) break;
        const cur = chosen.get(q.id);
        // A room's name moves a value only to a spot of the value's first pass, at nearly its size
        // (PAPER_NAME_PUSH_MIN) but in its pass that allows smaller (pushSmall: before the name would lie on
        // a fixture).
        const px0 = it.kind === 'name' && vi.kind === 'value' && vi.cands[0] ? vi.cands[0].px : 0;
        let found = null;
        for (const a of altsOf(u, cache)) {
          if (px0 && (a.pi > 0 || (!P.pushSmall && !(a.vc.px >= PAPER_NAME_PUSH_MIN * px0)))) continue;
          const { box: vb, shape: vs, dir: vd } = a.rec;
          if (pairHit(vb, vs, b, sh, Math.max(it.gap, vi.gap)) || sameLine(vb, vd, b, d, vi.lineGap)) continue;
          // The other text moving (its old spot counted as taken above; its new one here).
          if (moves.some((m) => textHit(vi, vb, vs, vd, m.rec))) continue;
          found = { u, cur, vc: a.vc, rec: a.rec };
          break;
        }
        if (!found) break;
        moves.push(found);
      }
      if (moves.length !== units.length) continue;
      for (const m of moves) chosen.set(m.u.q.id, m.vc);
      // Every stacked label placed so far, and this spot itself (final review round 2, D6: a stacked spot
      // taken while the value it stood beyond was moved away, 20 mm out in the 거실 with nothing between),
      // still has a value between it and its wall.
      if (!shown.every((s) => typeof s.it.stillValid !== 'function' || s.it.stillValid(s.c, chosen))
        || (typeof it.stillValid === 'function' && !it.stillValid(c, chosen))) {
        for (const m of moves) chosen.set(m.u.q.id, m.cur);
        continue;
      }
      for (const m of moves) {
        const vc = m.vc;
        for (const rq of m.u.recs) {
          const ri = itemOf.get(rq.id);
          if (ri && ri.kind === 'height') {
            if (!vc.hBox) continue;
            Object.assign(rq, { box: vc.hBox, shape: null, parts: null, dir: 'h' });
            chosen.set(rq.id, vc);
          } else {
            Object.assign(rq, { box: m.rec.box, shape: m.rec.shape, parts: m.u.vi.boxOf ? null : (vc.parts || null), dir: m.rec.dir });
          }
          const sv = shown.find((x) => x.it.id === rq.id);
          if (sv) sv.c = vc;
        }
      }
      freeAgain(it.gap);
      return c;
    }
    return null;
  };
  // Paper (round 3, with every value inside its room and no smaller than the room heights), a small room whose
  // texts do not all find a free spot in their order (the values first, each at the first spot free then):
  // its values placed again together (it.repack), all at their smallest size, their last resorts after those
  // (repackRoom). A value with no free spot (A6's 1275 × 1275 현관 at 1:60: the 신발장 wall's value in front of
  // it, in the middle of the room, and the opposite wall's value over it) is placed with them; a room's name
  // with no spot off the fixtures and texts (the tiny 현관 of A4 turned, whose name lay on the 신발장; user
  // 2026-10-31: the name in the free space off the 신발장) takes one of the first free spots of each of its
  // sizes before them. Each value takes the first of its spots free in its earliest pass, the one with the fewest
  // free spots first; where one then finds none, the one before takes its next spot (REPACK_STEPS spots tried
  // at most), then the same at half the gap between texts (a 1100 × 1675 현관 with a 신발장 at 1:75: its values
  // 0.45 mm apart rather than one over another; two texts side by side on one line keep their whole line gap).
  // Kept only when every text of the room is then clear of every other. → it's spot | null
  const REPACK_STEPS = 600, REPACK_NAME_SPOTS = 12;
  // (loose: each value's relaxed passes after its own, it.relaxed; round 4.)
  const repackRoom = (it, loose = false) => {
    const mates = shown.filter((x) => x.it !== it && x.it.repack && x.it.kind === 'value' && x.it.refId === it.refId);
    const recs = mates.map((x) => placed.find((p) => p.id === x.it.id));
    if (recs.some((r) => !r)) return null;
    const values = mates.map((x) => x.it).concat(it.kind === 'value' ? [it] : []);
    if (!values.length) return null;
    const fullLists = new Map(values.map((u) => {
      const min = Math.min(...u.cands.map((c) => c.px || Infinity));
      return [u, u.cands.filter((c) => c.box && c.px <= min * 1.001).concat(u.lastResort || [], ...(u.later || []))];
    }));
    // (Round 5, a room's name off the fixtures (not loose): each value's spots beside its wall first, PAPER_NEAR_WALL_MM,
    // over every spot of the name; all of them only when that finds nothing. The name takes a smaller spot before a value
    // goes into the middle of the room: A1 화장실2's bottom '1575', 15 mm from its wall under '화장실2' at its full size.
    // Not loose: there the name may lie over a fixture, and the values kept beside their walls would put it there, A1
    // turned's 화장실1.)
    const nearLists = new Map(values.map((u) => [u, nearList(u, fullLists.get(u))]));
    const cut = it.kind === 'name' && !loose && values.some((u) => nearLists.get(u).length < fullLists.get(u).length);
    let lists = fullLists;
    const slots = recs.map((r) => [placed.indexOf(r), r]).sort((a, b) => a[0] - b[0]);
    for (let i = slots.length - 1; i >= 0; i--) placed.splice(slots[i][0], 1);
    freeAgain(it.gap);
    // A unit's spots free now (texts kept `f` × the gap apart, PAPER_LINE_GAP_MM along one line), in the order of
    // its passes, then its own order.
    const clear = (u, c, f = 1) => {
      const g = f === 1 ? u : { ...u, gap: u.gap * f };
      const b = u.boxOf ? u.boxOf(c) : c.box, sh = u.boxOf ? null : (c.shape || null);
      return !placed.some((q) => q.id !== u.ignore && textHit(g, b, sh, textDir(u, c, sh), q));
    };
    const options = (u, f) => {
      const out = [], seen = new Set();
      for (const P of loose && Array.isArray(u.relaxed) ? u.passes.concat(u.relaxed) : u.passes) {
        for (const c of lists.get(u)) {
          if (seen.has(c) || !obstaclesOk(u, c.box, c.shape || null, c.parts || null, P, null, c) || !clear(u, c, f)) continue;
          seen.add(c);
          out.push(c);
        }
      }
      return out;
    };
    const picks = new Map();
    let steps = 0;
    // Item u at spot c, taking the label spots under it (as the main loop does); → undo
    const take = (u, c) => {
      const rec = { id: u.id, box: u.boxOf ? u.boxOf(c) : c.box, shape: u.boxOf ? null : (c.shape || null), parts: null, dir: textDir(u, c, u.boxOf ? null : (c.shape || null)) };
      placed.push(rec);
      const was = res.map((r) => r.free);
      for (const r of res) if (!r.done && r.free.length) r.free = r.free.filter((sp) => !pairHit(sp, sp.shape || null, rec.box, rec.shape, u.gap));
      return () => {
        placed.pop();
        res.forEach((r, i) => { r.free = was[i]; });
      };
    };
    const fit = (order, k, f) => {
      if (k === order.length) return true;
      const u = order[k];
      for (const c of options(u, f)) {
        if (++steps > REPACK_STEPS) return false;
        const undo = take(u, c);
        picks.set(u, c);
        const ok = fit(order, k + 1, f);
        undo();
        if (ok) return true;
        picks.delete(u);
      }
      return false;
    };
    const fitAll = () => {
      const free0 = new Map(values.map((u) => [u, options(u, 1).length]));
      const order = values.slice().sort((a, b) => free0.get(a) - free0.get(b) || a.order - b.order);
      steps = 0;
      if (fit(order, 0, 1)) return true;
      steps = 0;
      return fit(order, 0, 0.5);
    };
    let pick = null;
    if (it.kind === 'name') {
      // The name first: the first REPACK_NAME_SPOTS spots of each of its sizes free off the fixtures' middles
      // and the texts.
      const sizeOf = (c) => (c.nameLines && c.nameLines[0] ? c.nameLines[0].px : 0);
      // (loose: the name's spots of its last pass, over a fixture's outline too; round 4, A1 turned: the tiny 현관's
      // name found no spot off the 신발장 with every value placed again, and lay over the '1100'.)
      const NP = loose ? it.passes[it.passes.length - 1] : it.passes[0];
      // (Round 5: every spot of the name with the values beside their walls, then, where that left spots out, with all.)
      for (const L of cut ? [nearLists, fullLists] : [fullLists]) {
        lists = L;
        const tried = new Map();
        for (const c of it.cands) {
          const px = sizeOf(c);
          if ((tried.get(px) || 0) >= REPACK_NAME_SPOTS || !c.box || !clear(it, c) || !obstaclesOk(it, c.box, null, null, NP, null, c)) continue;
          tried.set(px, (tried.get(px) || 0) + 1);
          const undo = take(it, c);
          const ok = fitAll();
          undo();
          if (ok) { pick = c; break; }
        }
        if (pick) break;
      }
    } else if (fitAll()) {
      pick = picks.get(it);
    }
    if (pick) {
      mates.forEach((x, i) => {
        const c = picks.get(x.it);
        Object.assign(recs[i], { box: c.box, shape: c.shape || null, parts: c.parts || null, dir: textDir(x.it, c, c.shape || null) });
        chosen.set(x.it.id, c);
        x.c = c;
      });
    }
    for (const [i, r] of slots) placed.splice(i, 0, r);
    freeAgain(it.gap);
    return pick;
  };
  for (const it of items) {
    const cands = typeof it.cands === 'function' ? it.cands(chosen) : it.cands;
    if (!cands || !cands.length) continue;
    const boxOf = it.boxOf || ((c) => c.box);
    const shapeOf = it.boxOf ? () => null : (c) => c.shape || null;
    const partsOf = it.boxOf ? () => null : (c) => c.parts || null;
    const dirOf = (c) => textDir(it, c, shapeOf(c));
    let pick = null;
    const ignore = it.ignore || null;
    // A group may be a function: its candidates are worked out when it is first reached.
    const groups = typeof it.groupsOf === 'function' ? it.groupsOf(cands, chosen) : [cands];
    const groupAt = (g) => (typeof groups[g] === 'function' ? (groups[g] = groups[g]()) : groups[g]);
    // Pass 0 keeps off the soft obstacles (fixtures), the last pass off nothing but the hard ones.
    const passes = Array.isArray(it.passes) && it.passes.length ? it.passes : [{ soft: true }, {}];
    // Is spot c free in pass P (the texts placed, then what P keeps it off)?
    const free = (c, P) => {
      const b = boxOf(c);
      if (!b) return false;
      const sh = shapeOf(c);
      const d = dirOf(c);
      if (placed.some((p) => p.id !== ignore && textHit(it, b, sh, d, p))) return false;
      return obstaclesOk(it, b, sh, partsOf(c), P, null, c);
    };
    // A per-side value that alone takes the label's spot moves along its wall (displaceValue): to a spot
    // clear of its walls and fixtures.
    const displace = (list, DP = DISPLACE_PASS) => displaceValue(it, list, placed, chosen, shown, itemOf, {
      textHit, dirOf, spotOk: (vi, vc) => obstaclesOk(vi, vc.box, vc.shape || null, vc.parts || null, DP),
    });
    if (Array.isArray(it.steps)) {
      // Paper window / door labels (PAPER_LABEL_STEPS).
      for (const [g, pi, what] of it.steps) {
        if (g >= groups.length || pi >= passes.length) continue;
        const P = passes[pi];
        if (what === 'try') {
          pick = groupAt(g).find((c) => free(c, P)) || null;
        } else if (what === 'yield') {
          const YP = yieldOf(P);
          pick = groupAt(g).find((c) => free(c, YP)) || null;
          if (pick) yielded.add(it.id);
        } else if (what === 'yieldRepair' && it.repair) {
          // (And one or two other window / door labels moved out of the way to other spots of theirs, as 'repair'.)
          pick = repair(it, groupAt(g), yieldRepairOf(P), boxOf, shapeOf, partsOf, dirOf);
          if (pick) yielded.add(it.id);
        } else if (what === 'displace' && it.displace) {
          pick = displace(groupAt(g), g === 4 ? DISPLACE_TINY_PASS : DISPLACE_PASS);
          if (pick) freeAgain(it.gap);
        } else if (what === 'repair' && it.repair) {
          pick = repair(it, groupAt(g), P, boxOf, shapeOf, partsOf, dirOf);
        }
        if (pick) break;
      }
    } else {
      let best = null;
      search: for (let pi = 0; pi < passes.length; pi++) {
        const P = passes[pi];
        best = null;
        // A paper room name with no spot off the fixtures and texts: its room's values placed again with it
        // (repackRoom) before it lies over a fixture's middle; (round 5) before it lies over a fixture's outline too, the
        // pass with cores (user 2026-10-31: the 현관's name in the free space off the 신발장; A5 turned, where the values
        // all fit at their full size by a hair, so that the name lay 6.8 pt over the 신발장's corner on the Galaxy Tab).
        // (The pass with cores only in a room with a fixture: elsewhere it allows nothing the passes before did not.)
        if ((P.best || (P.cores && it.fixtureRoom)) && it.kind === 'name' && it.repack && (!P.relaxed || it.fixtureRoom)) {
          pick = repackRoom(it, !!P.relaxed);
          if (pick) break search;
        }
        for (let g = 0; g < groups.length; g++) {
          // (A pushSmall pass keeps off what the pass before kept off: only its repair is new.)
          for (const c of P.pushSmall ? [] : groupAt(g)) {
            if (!free(c, P)) continue;
            if (P.best) {
              // Of the spots this pass allows, the one over the least of the fixtures: a name that has to lie
              // on a fixture covers a corner of it, not its middle (final review 2026-10-28).
              const cost = fixtureCost(it, c);
              if (!best || cost < best.cost - 1e-6) best = { c, cost };
              continue;
            }
            pick = c;
            break search;
          }
          if (pi === 0 && g === 0 && it.displace) {
            pick = displace(groupAt(0));
            if (pick) { freeAgain(it.gap); break search; }
          }
        }
        if (best) { pick = best.c; break search; }
        // Paper: no free spot in this pass: one where only one or two per-side values (or window / door
        // labels) are in the way, each of which moves to another spot of its own clear of everything and of
        // this text (final review 2026-10-28: the values of a 1100 × 1675 현관 at 1:75 took the middle of
        // each wall first, and its name went over one of them).
        if (it.repair) {
          for (let g = 0; g < groups.length && !pick; g++) pick = repair(it, groupAt(g), P, boxOf, shapeOf, partsOf, dirOf);
          if (pick) break search;
        }
      }
    }
    // Paper values with no free spot: a vertical side's last resorts (turned along it) in the passes, then (round 4)
    // its spots further into the room and, at 1:150, its smaller sizes (it.later), then the room's values placed again
    // together (repack), then all of them again in the relaxed passes (over a fixture's label's line), alone and (a room
    // with a fixture) placed again together, before the least overlap. In a 'best' pass the spot over the least of the
    // fixtures, not the first (round 4: A1's
    // '2275' turned along its wall inside the 욕조's box, 10 mm² of its middle).
    const pickIn = (list, P) => {
      if (!P.best) return list.find((c) => free(c, P)) || null;
      let best = null;
      for (const c of list) {
        if (!free(c, P)) continue;
        const cost = fixtureCost(it, c);
        if (!best || cost < best.cost - 1e-6) best = { c, cost };
      }
      return best ? best.c : null;
    };
    const later = [it.lastResort, ...(it.later || [])].filter((l) => Array.isArray(l) && l.length);
    for (const list of pick ? [] : later) {
      for (const P of passes) {
        pick = pickIn(list, P);
        if (pick) break;
      }
      if (pick) break;
    }
    if (!pick && it.repack) pick = repackRoom(it);
    if (!pick && Array.isArray(it.relaxed)) {
      for (const P of it.relaxed) {
        for (const list of [cands, ...later]) {
          pick = pickIn(list, P);
          if (pick) break;
        }
        if (pick) break;
      }
      if (!pick && it.repack && it.fixtureRoom) pick = repackRoom(it, true);
    }
    // Nothing free: the spot that overlaps least (columns count four times), not simply the first
    // (review 0.5.0: on paper, where everything is shown, crowded rooms piled texts on one spot).
    // it.fallback: the candidates this choice may take (window / door labels: the attached ones), or a
    // function of the candidates (paper room names: those clear of the walls, when there are any).
    if (!pick && it.mustShow) {
      const fb = typeof it.fallback === 'function' ? it.fallback(cands) : it.fallback;
      pick = leastOverlap(fb && fb.length ? fb : cands, boxOf, placed, it, partsOf, res.length ? (b, sh) => takenLast(it, b, sh) : null);
    }
    if (!pick) continue;
    chosen.set(it.id, pick);
    itemOf.set(it.id, it);
    const box = boxOf(pick), shape = shapeOf(pick);
    placed.push({ id: it.id, box, shape, parts: partsOf(pick), dir: dirOf(pick) });
    shown.push({ it, c: pick });
    for (const r of res) {
      if (r.id === it.id) { r.free = []; r.done = true; } else if (r.free.length) r.free = r.free.filter((s) => !pairHit(s, null, box, shape, it.gap));
    }
  }
  if (paperMode) improve();
  return shown;

  // Paper, at the end (final review round 2, 2026-10-31): a text that came out shrunk (a value under 80 % of
  // its size, a name under 80 % with its H at 60 %), on a fixture or another text, or (a window /
  // door label) stacked or misleading, because the spots were taken when it came (a label's last spot kept
  // free for a label that then took another one, a value moved by a later repair), takes a better spot of
  // its own that is free now: clear of every text, in an earlier pass (smaller only then), or in the same one
  // at least 10 % larger. The values first, then the window / door labels (attached spots only), then the
  // names with their H. Stacked labels keep a value between them and their wall (stillValid). (A2 turned:
  // '2800' at 55 % in the 싱크대's box while the door label it had kept a spot for went elsewhere.)
  function improve() {
    const bx = (it, c) => (it.boxOf ? it.boxOf(c) : c.box);
    const shp = (it, c) => (it.boxOf ? null : (c.shape || null));
    const prt = (it, c) => (it.boxOf ? null : (c.parts || null));
    const clearOf = (it, c, skip) => {
      const b = bx(it, c);
      if (!b) return false;
      const sh = shp(it, c), d = textDir(it, c, sh);
      return !placed.some((p) => !skip.includes(p) && p.id !== it.ignore && textHit(it, b, sh, d, p));
    };
    // The first of the item's passes the spot is clear in (every label is placed: no reserve); their
    // number when none.
    const tierOf = (it, c) => {
      const ps = it.passes || [];
      const b = bx(it, c);
      if (!b) return Infinity;
      for (let i = 0; i < ps.length; i++) if (fixedOf(it, b, shp(it, c), prt(it, c), yielded.has(it.id) ? yieldOf(ps[i]) : ps[i], c)) return i;
      return ps.length;
    };
    const valid = () => shown.every((s) => typeof s.it.stillValid !== 'function' || s.it.stillValid(s.c, chosen));
    const sizeOf = (it, c) => (it.kind === 'name' ? (c.nameLines && c.nameLines[0] ? c.nameLines[0].px : 0) : (c.px || 0));
    // Item s to spot c, its records (a name with its H) with it.
    const moveTo = (s, recs, c) => {
      const it = s.it;
      for (const rec of recs) {
        const ri = itemOf.get(rec.id);
        if (ri && ri.kind === 'height') {
          Object.assign(rec, { box: c.hBox, shape: null, parts: null, dir: 'h' });
          chosen.set(rec.id, c);
          const hs = shown.find((x) => x.it.id === rec.id);
          if (hs) hs.c = c;
        } else {
          Object.assign(rec, { box: bx(it, c), shape: shp(it, c), parts: prt(it, c), dir: textDir(it, c, shp(it, c)) });
        }
      }
      chosen.set(it.id, c);
      s.c = c;
    };
    for (const kind of ['value', 'opening', 'name']) {
      for (const s of shown) {
        const it = s.it;
        if (!it.improve || it.kind !== kind || !Array.isArray(it.cands)) continue;
        const rec = placed.find((p) => p.id === it.id);
        if (!rec) continue;
        const recs = [rec];
        if (kind === 'name') {
          const hr = placed.find((p) => p.id === `h:${it.refId}`);
          if (hr) recs.push(hr);
        }
        const cur = s.c;
        const over = !clearOf(it, cur, recs);
        const tc = over ? Infinity : tierOf(it, cur);
        let list;
        if (kind === 'opening') {
          // Only a stacked or misleading label, or one on another text or a wall (its least overlap): to an
          // attached spot of its own.
          // (Or at 70 %: to a full-size one.)
          if (!over && cur.attached !== false && !cur.misleading && !cur.small && tc < (it.passes || []).length) continue;
          list = it.cands.filter((c) => c.attached !== false && !c.misleading).concat(cur.small && !cur.tiny ? [] : (it.small || []));
          // (Round 5: from a spot at the wall face never to one beyond the door's swing, PAPER_LABEL_STEPS.)
          if (!cur.pastSwing) list = list.filter((c) => !c.pastSwing);
        } else {
          const full = Math.max(...it.cands.map((c) => sizeOf(it, c)));
          if (!over && tc === 0 && !(sizeOf(it, cur) < 0.8 * full)) continue;
          list = it.cands;
        }
        const px = sizeOf(it, cur);
        let best = null;
        for (const c of list) {
          if (c === cur || !bx(it, c)) continue;
          if (recs.length > 1 && !c.hBox) continue;
          const pc = sizeOf(it, c);
          const t = tierOf(it, c);
          if (t >= (it.passes || []).length) continue;
          // (Smaller only in an earlier pass, as the passes themselves take a smaller spot off a fixture
          // before a larger one on it: A6 '현관' off the 신발장 once a value moved out; or off another
          // text, written over by a later one in its fallback.)
          if (kind !== 'opening' && !over && !(t < tc) && !(pc >= px - 1e-9)) continue;
          if (kind !== 'opening' && !(t < tc || (t === tc && pc > 1.1 * px))) continue;
          // (In a pass over the fixtures, best, not over more of them: A2 turned at 1:50, '드레스룸' grew onto
          // the 옷장 from the corner of it its pass had chosen.)
          if (t === tc && (it.passes || [])[t] && it.passes[t].best && fixtureCost(it, c) > fixtureCost(it, cur) + 1e-6) continue;
          // The earliest pass; among those, the larger (values, names); then the order of the list.
          if (best && !(t < best.t || (t === best.t && kind !== 'opening' && pc > best.pc + 1e-9))) continue;
          if (!clearOf(it, c, recs)) continue;
          best = { c, t, pc };
          if (t === 0 && kind === 'opening') break;
        }
        if (!best && kind === 'opening' && it.repair && (over || cur.attached === false || cur.misleading || tc >= (it.passes || []).length)) {
          // No attached spot free even now: one where one or two texts move out of the way (repair), now
          // that every label is placed and none keeps a spot (A1: 'PVC단창 1200*1000' right above its window
          // in the 베란다2 once the '베란다2' name may move, instead of over the wall beside it).
          const at = placed.indexOf(rec);
          placed.splice(at, 1);
          let pick = null;
          for (const P of it.passes || []) {
            pick = repair(it, list, P, (c) => c.box, (c) => c.shape || null, (c) => c.parts || null, (c) => textDir(it, c, c.shape || null));
            if (pick) break;
          }
          placed.splice(at, 0, rec);
          if (pick) best = { c: pick, t: tierOf(it, pick), pc: sizeOf(it, pick) };
        }
        if (!best) continue;
        const keep = recs.map((r) => ({ r, box: r.box, shape: r.shape, parts: r.parts, dir: r.dir }));
        const hs = recs.length > 1 ? shown.find((x) => x.it.id === recs[1].id) : null;
        moveTo(s, recs, best.c);
        if (!valid()) {
          for (const k of keep) Object.assign(k.r, { box: k.box, shape: k.shape, parts: k.parts, dir: k.dir });
          chosen.set(it.id, cur);
          s.c = cur;
          if (hs) { hs.c = cur; chosen.set(hs.it.id, cur); }
        }
      }
    }
    // Round 5: a per-side value at one of its spots further into the room (it.later) further from its wall than
    // PAPER_NEAR_WALL_MM (a room's texts were placed again while the spots beside its wall were taken) takes a spot of its
    // own beside its wall that is free now, in a pass no later than its spot's: the earliest pass, then the larger, then the
    // nearer, not smaller. (Not from its spots in front of a fixture against its wall, which are its own: round 5 tried that too, and
    // values came out squeezed between fixtures, A5's '3650' beside the 냉장고.)
    for (const s of shown) {
      const it = s.it;
      if (it.kind !== 'value' || !it.improve || !it.seg || !Array.isArray(it.cands) || it.cands.includes(s.c) || nearOf(it, s.c)) continue;
      const rec = placed.find((p) => p.id === it.id);
      if (!rec) continue;
      const cur = s.c;
      const tc = clearOf(it, cur, [rec]) ? tierOf(it, cur) : Infinity;
      let best = null;
      for (const c of it.cands.concat(it.lastResort || [], ...(it.later || []))) {
        if (c === cur || !c.box || !nearOf(it, c)) continue;
        const t = tierOf(it, c);
        if (t >= (it.passes || []).length || t > tc) continue;
        const pc = c.px || 0, d = wallDist(it, c);
        // (Not smaller: E4's 현관 '1800' right beyond the door label at its wall reads as that wall's at its size.)
        if (pc < (cur.px || 0) - 1e-9) continue;
        if (best && !(t < best.t || (t === best.t && (pc > best.pc + 1e-9 || (Math.abs(pc - best.pc) <= 1e-9 && d < best.d - 1e-6))))) continue;
        if (!clearOf(it, c, [rec])) continue;
        best = { c, t, pc, d };
      }
      if (!best) continue;
      const keep = { box: rec.box, shape: rec.shape, parts: rec.parts, dir: rec.dir };
      moveTo(s, [rec], best.c);
      if (!valid()) {
        Object.assign(rec, keep);
        chosen.set(it.id, cur);
        s.c = cur;
      }
    }
  }
}

// Which way a placed text reads (sameLine): 'h' along x, 'v' turned a quarter, null turned along a
// diagonal side (shape).
function textDir(it, c, shape) {
  if (shape) return null;
  if (it.kind === 'height' || it.kind === 'value') return 'h';
  const r = it.kind === 'name' ? c.rot : (c.rotDeg != null ? c.rotDeg : c.rot);
  return Math.abs(Math.abs(Number(r) || 0) - 90) < 1 ? 'v' : 'h';
}

// Two texts written the same way side by side on one line (their extents across the line overlap by
// more than half the smaller one) closer than `gap` along it: they read as one text (paper, final review
// 2026-10-28: '3450' right before 'ABS도어 900*2100', 'ABS도어 700*2000목문 800*2000').
function sameLine(a, da, b, db, gap) {
  if (!(gap > 0) || !da || da !== db) return false;
  const h = da === 'h';
  const a0 = h ? a.minY : a.minX, a1 = h ? a.maxY : a.maxX, b0 = h ? b.minY : b.minX, b1 = h ? b.maxY : b.maxX;
  const across = Math.min(a1, b1) - Math.max(a0, b0);
  if (!(across > 0.5 * Math.min(a1 - a0, b1 - b0))) return false;
  const l0 = h ? a.minX : a.minY, l1 = h ? a.maxX : a.maxY, m0 = h ? b.minX : b.minY, m1 = h ? b.maxX : b.maxY;
  return l0 < m1 + gap && l1 > m0 - gap;
}

// A window / door label (it) none of whose own spots (cands, in order) is free: the first spot that is
// clear of everything but ONE per-side value already placed, when that value has another spot of its
// own (at least 85 % of its size, along its wall) clear of everything, the label's box included, and
// moving it leaves every stacked label placed before with a value between it and its wall
// (it.stillValid). The value is moved (placed / chosen / shown updated) and that label spot returned.
// (Checker 2026-10-24: in 치수선 없이 a wall's value sat at its middle, exactly where the label of a
// window in the middle of that wall belongs; the label then went beyond the value or onto it.)
// fx: resolveText's { textHit (the gap, and the line gap of two texts side by side on one line), dirOf
// (the label spot's direction), spotOk(vi, vc) (walls, with the value's gap, and fixtures) } (final review
// round 2: the moved '3175' ended 1.35 paper mm after 'PVC이중창 2400*1800' on its line, read as one text).
function displaceValue(it, cands, placed, chosen, shown, itemOf, fx) {
  for (const c of cands) {
    const b = c.box;
    if (!b || c.shape) continue;
    if (it.hard.some((h) => obstacleHit(b, null, h)) || it.soft.some((o) => obstacleHit(b, null, o))) continue;
    const d = fx.dirOf(c);
    const blockers = placed.filter((p) => p.id !== it.ignore && fx.textHit(it, b, null, d, p));
    if (blockers.length !== 1) continue;
    const p = blockers[0];
    const vi = itemOf.get(p.id);
    if (!vi || vi.kind !== 'value' || !Array.isArray(vi.cands) || (vi.v && vi.v.active)) continue;
    const cur = chosen.get(p.id);
    const maxPx = vi.cands[0] && vi.cands[0].px;
    const gap = Math.max(vi.gap || 0, it.gap || 0), lineGap = Math.max(vi.lineGap || 0, it.lineGap || 0);
    for (const vc of vi.cands) {
      if (vc === cur || !vc.box) continue;
      if (maxPx && vc.px < 0.84 * maxPx) continue;
      const vs = vc.shape || null, vd = textDir(vi, vc, vs);
      if (pairHit(vc.box, vs, b, null, gap) || sameLine(vc.box, vd, b, d, lineGap)) continue;
      if (placed.some((q) => q.id !== p.id && fx.textHit(vi, vc.box, vs, vd, q))) continue;
      if (!fx.spotOk(vi, vc)) continue;
      chosen.set(p.id, vc);
      if (!shown.every((s) => typeof s.it.stillValid !== 'function' || s.it.stillValid(s.c, chosen))) {
        chosen.set(p.id, cur);
        continue;
      }
      p.box = vc.box;
      p.shape = vs;
      p.parts = vc.parts || null;
      p.dir = vd;
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

// Text box b within gap of wall box o only along a window or door in it (open: Map wall box → spans along it,
// layoutScreenText wallOpenings): where the box comes near the wall, the wall is drawn white.
function nearOpening(b, o, gap, open) {
  const spans = open && open.get(o);
  if (!spans || o.poly) return false;
  const h = o.orient === 'h';
  const lo = Math.max(h ? b.minX : b.minY, h ? o.minX : o.minY) - gap, hi = Math.min(h ? b.maxX : b.maxY, h ? o.maxX : o.maxY) + gap;
  return spans.some(([a, z]) => lo >= a - 1e-6 && hi <= z + 1e-6);
}

// A text and an obstacle box (or a diagonal wall's outline, ob.poly), closer than pad.
function obstacleHit(b, shape, ob, pad = 0) {
  if (!boxesHit(b, ob, pad)) return false;
  if (!shape && !ob.poly) return true;
  const B = ob.poly || boxPoints(ob);
  return (shape || [boxPoints(b)]).some((x) => convexOverlap(x, B, pad));
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

// reserveCost(box, shape) (paper): the area of the last free label spots a text there would take.
function leastOverlap(cands, boxOf, placed, it, partsOf = () => null, reserveCost = null) {
  let best = cands[0], bestCost = Infinity;
  for (const c of cands) {
    const b = boxOf(c);
    if (!b) continue;
    const parts = partsOf(c);
    let cost = 0;
    if (it.costs) {
      // Paper (PAPER_COSTS): texts by their boxes grown by half the gap each (a text right against
      // another reads as one with it), the walls, the last spots of the labels still to come.
      const K = it.costs, half = (it.gap || 0) / 2;
      const grow = (x) => ({ minX: x.minX - half, minY: x.minY - half, maxX: x.maxX + half, maxY: x.maxY + half });
      const gb = grow(b);
      for (const p of placed) {
        if (p.id === it.ignore) continue;
        cost += K.text * (parts || p.parts ? shapeOverlap(b, parts, p.box, p.parts) : overlapArea(gb, grow(p.box)));
      }
      for (const h of it.hard) cost += 4 * shapeOverlap(b, parts, h);
      for (const w of it.walls || []) cost += K.walls * shapeOverlap(b, parts, w);
      for (const s of it.soft) cost += (s.text ? K.text : s.core ? K.soft : K.outline) * shapeOverlap(b, parts, s);
      if (reserveCost) cost += K.reserve * reserveCost(b, c.shape || null);
    } else {
      for (const p of placed) if (p.id !== it.ignore) cost += shapeOverlap(b, parts, p.box, p.parts);
      for (const h of it.hard) cost += 4 * shapeOverlap(b, parts, h);
      // Screen: the walls of a value (the side being typed, always shown) weigh as on paper (final review
      // round 2: D1 portrait, the 보일러실's '1200' bubble across the 다용도실 | 보일러실 wall).
      for (const w of it.walls || []) cost += PAPER_COSTS.walls * shapeOverlap(b, parts, w);
      for (const s of it.soft) cost += 0.25 * shapeOverlap(b, parts, s);
    }
    if (cost < bestCost - 1e-9) { bestCost = cost; best = c; }
  }
  return best;
}

// o.paperText (drawPaperPlanText): every text in the output font, as layoutScreenText measured it.
function drawTextLayout(ctx, view, shown, o) {
  const paper = !!o.paperText;
  const toPx = (p) => view.toScreen(p);
  const pxBox = (b) => {
    const p = toPx({ x: b.minX, y: b.minY }), q = toPx({ x: b.maxX, y: b.maxY });
    return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y };
  };
  // A text turned along a diagonal side or wall: the corners of its turned rectangle (px), besides its bounding box.
  const pxPoly = (c) => (c.shape ? { poly: c.shape[0].map(toPx) } : null);
  const roomBoxes = new Map();   // roomId → { item, c, boxes }
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const { it, c } of shown) {
    if (Array.isArray(o.textItems)) {
      const b = it.kind === 'name' ? c.nameBox : it.kind === 'height' ? c.hBox : c.box;
      o.textItems.push({ kind: it.kind, refId: it.refId, key: it.key || null, id: it.id, ...pxBox(b), ...(it.kind === 'name' || it.kind === 'height' ? null : pxPoly(c)) });
    }
    if (it.kind === 'name') {
      drawLines(ctx, toPx(c.nameC), c.rot, c.nameLines, false, paper);
      if (Array.isArray(o.nameBoxes)) o.nameBoxes.push({ roomId: it.refId, ...pxBox(c.nameBox) });
      if (it.key) roomBoxes.set(it.refId, { it, c, box: c.nameBox });
    } else if (it.kind === 'height') {
      drawLines(ctx, toPx(c.hC), 0, [c.hLine], false, paper);
      const rb = roomBoxes.get(it.refId);
      if (rb) rb.box = unionBox(rb.box, c.hBox);
    } else if (it.kind === 'value') {
      drawValue(ctx, toPx(c), it.v, c, paper);
    } else {
      drawLines(ctx, toPx(c), c.rotDeg || 0, c.lines.map((l) => ({ text: l.text, px: l.size, weight: l.weight, color: l.color })), it.halo, paper);
      if (Array.isArray(o.textBoxes)) {
        o.textBoxes.push({ key: it.key, kind: it.kind, refId: it.refId, ...pxBox(c.box), ...pxPoly(c), base: it.base, center: { x: c.x, y: c.y } });
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

// Lines centred at screen point p, turned by rot degrees (0, ±90, or along a diagonal wall). paper: in the output font.
function drawLines(ctx, p, rot, lines, halo, paper = false) {
  ctx.save();
  ctx.translate(p.x, p.y);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  const heights = lines.map((l) => l.px * 1.2);
  let y = -heights.reduce((s, h) => s + h, 0) / 2;
  lines.forEach((l, i) => {
    ctx.font = canvasFont(l.px, l.weight || 'normal', paper);
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

function drawValue(ctx, c, v, cand, paper = false) {
  if (cand.rot) {
    // Along a diagonal side: the same drawing in the text's own turned frame.
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(cand.rot);
    drawValue(ctx, { x: 0, y: 0 }, { ...v, noteSign: cand.noteSign }, { ...cand, rot: 0 }, paper);
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
  ctx.font = canvasFont(px, v.bold ? 'bold' : 'normal', paper);
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
    ctx.font = canvasFont(px, 'bold', paper);
    ctx.fillText(v.flag, x0 + mainW, c.y);
    ctx.textAlign = 'center';
  } else {
    ctx.fillText(v.text, c.x, c.y);
  }
  if (v.note && cand.noteC) {
    ctx.font = canvasFont(cand.notePx, 'bold', paper);
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
      // Smaller texts where no spot keeps the rules (printlayout.js paperSmallTexts; question 5, 1안).
      small: paperSmallTexts(opts.paper.scale, opts.layout || null),
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
