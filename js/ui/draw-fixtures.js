// Drawing of fixtures (설비) and of "실 아님(설비)" spaces (plan §1-2 "설비"):
//   - a thin-line rectangle
//   - 싱크대, 옷장, 신발장 and 실 아님 spaces: the outline over a plain white fill (FIXTURE_FILL), no
//     diagonal, no colour and no sink basin (user feedback 2026-10-17: the diagonal made the text hard
//     to read; 2026-10-18: no gray, white); the label says what it is. The same in 그림만, minus the
//     text. FIXTURE_STYLE.innerLine (off): a second, inner outline, the alternative shown to the user.
//   - subtle glyphs for 변기, 세면대, 욕조
//   - an in-wall fixture (inWall) is drawn over its wall: its opaque box replaces the wall band there
//   - black labels of about 8.8 pt on paper ("싱크대 1950")
//
// Signature shared by every draw function of stage B:  draw<Thing>(ctx, project, derived, opts)
//   opts.toPx(worldPoint) → canvas point;  opts.pxPerMM: canvas px per world mm
//   opts.paper: { pxPerPaperMM } | null (null = screen)
//   opts.options: { drawingOnly, extensionLines, bothValues, showMemo, highlight }
//     highlight: { fixtureId } — the fixture selected in the fixture panel (screen only)
//     excludeId: fixture id left out (screen: the one whose size is being dragged)
// Paper sizes are in paper mm / pt and converted with paper.pxPerPaperMM; screen sizes are px.
import { FONT_STACK, COLORS, LINES } from './theme.js';
import {
  normalizeFixture, fixtureLabel, fixtureTypeInfo, localToWorld, fixturePolygon, fixtureFrame,
  isColumn, fixtureBounds, fixtureFlushSides, isStair, stairTreads, stairArrowLocal,
  hasGrayFill, FIXTURE_FILL, roomInnerPolygon,
} from '../core/fixtures.js';
import { pointInPolygon } from '../core/geom.js';

const PT_MM = 25.4 / 72;

export const FIXTURE_STYLE = {
  color: '#111111',          // outline and label (plan: label in black)
  fill: FIXTURE_FILL,        // 싱크대 / 옷장 / 신발장 / 실 아님 spaces
  glyphColor: '#3A3A3A',     // inner glyph lines, a little softer
  selected: '#D97706',       // same as COLORS.selectWall
  check: '#E8710A',          // 확인필요
  ghost: '#1A73E8',          // drag preview (same as COLORS.preview)
  paper: { line: 0.18, glyph: 0.13, labelPt: 8.8, innerGap: 0.8 },   // paper mm / pt
  screen: { line: 1.25, glyph: 0.9, labelPx: 12, innerGap: 3 },      // CSS px
  innerLine: false,          // 싱크대 / 옷장 / 신발장: also an inner outline innerGap inside (not used)
};

function sizes(opts) {
  const k = opts.paper && opts.paper.pxPerPaperMM;
  if (k) {
    return {
      line: FIXTURE_STYLE.paper.line * k,
      glyph: FIXTURE_STYLE.paper.glyph * k,
      font: FIXTURE_STYLE.paper.labelPt * PT_MM * k,
      innerGap: FIXTURE_STYLE.paper.innerGap * k,
      screen: false,
    };
  }
  return {
    line: FIXTURE_STYLE.screen.line, glyph: FIXTURE_STYLE.screen.glyph, font: FIXTURE_STYLE.screen.labelPx,
    innerGap: FIXTURE_STYLE.screen.innerGap, screen: true,
  };
}

const optionsOf = (opts) => (opts && opts.options) || {};

// Axis-aligned canvas rectangle of world points.
function pxRect(opts, pts) {
  const s = pts.map((p) => opts.toPx(p));
  const xs = s.map((p) => p.x), ys = s.map((p) => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

function roundRectPath(ctx, r, rad) {
  const k = Math.max(0, Math.min(rad, r.w / 2, r.h / 2));
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, k);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, k);
  ctx.closePath();
}

// Local rectangle (u0..u1 along the wall, v0..v1 from the back) → canvas rect.
function localRect(opts, f, u0, u1, v0, v1) {
  return pxRect(opts, [localToWorld(f, u0, v0), localToWorld(f, u1, v1)]);
}

// ---- label ---------------------------------------------------------------------------------------

// Text centred at canvas point c; turned to read bottom→top when it does not fit across but fits
// (better) along a tall box { w, h } (canvas px). When it fits neither way and `outside` is given
// ({ x, y } unit direction in canvas space, e.g. the fixture's front), the label goes just outside
// the box in that direction instead of covering the small fixture.
// halo: a thin white outline around the letters (where lines or symbols cross the text); a box with
// the plain gray fill does not need it.
function drawLabel(ctx, text, c, box, fontPx, color, outside = null, withHalo = true) {
  if (!text) return;
  ctx.font = `normal ${fontPx}px ${FONT_STACK}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const pad = fontPx * 0.8;
  const fitsAcross = tw + pad <= box.w && fontPx * 1.1 <= box.h;
  const fitsAlong = tw + pad <= box.h && fontPx * 1.1 <= box.w;
  let vertical = !fitsAcross && box.h > box.w;
  let halo = withHalo;
  if (!fitsAcross && !fitsAlong && outside) {
    vertical = false;
    halo = false;   // outside the box a halo could cut into a room name nearby
    const ext = Math.abs(outside.x) * (box.w / 2 + tw / 2) + Math.abs(outside.y) * (box.h / 2 + fontPx * 0.6) + fontPx * 0.3;
    c = { x: box.x + box.w / 2 + outside.x * ext, y: box.y + box.h / 2 + outside.y * ext };
  }
  ctx.save();
  ctx.translate(c.x, c.y);
  if (vertical) ctx.rotate(-Math.PI / 2);
  // A thin white halo keeps the text readable where it crosses a glyph.
  if (halo) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(2, fontPx * 0.28);
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();
  // The text's box in canvas units (for taps on a name).
  const th = fontPx * 1.2;
  return vertical ? { x: c.x - th / 2, y: c.y - tw / 2, w: th, h: tw } : { x: c.x - tw / 2, y: c.y - th / 2, w: tw, h: th };
}

// ---- glyphs --------------------------------------------------------------------------------------

function drawGlyph(ctx, f, opts, sz) {
  const glyph = fixtureTypeInfo(f.type).glyph;
  if (!glyph) return;
  const hw = f.w / 2, d = f.d;
  ctx.strokeStyle = FIXTURE_STYLE.glyphColor;
  ctx.lineWidth = sz.glyph;
  ctx.beginPath();
  if (glyph === 'toilet') {
    // Tank at the back, oval bowl in front.
    const tank = localRect(opts, f, -hw * 0.92, hw * 0.92, d * 0.03, d * 0.27);
    roundRectPath(ctx, tank, Math.min(tank.w, tank.h) * 0.15);
    const bowl = localRect(opts, f, -hw * 0.78, hw * 0.78, d * 0.3, d * 0.96);
    ctx.moveTo(bowl.x + bowl.w, bowl.y + bowl.h / 2);
    ctx.ellipse(bowl.x + bowl.w / 2, bowl.y + bowl.h / 2, bowl.w / 2, bowl.h / 2, 0, 0, Math.PI * 2);
  } else if (glyph === 'basin') {
    const r = localRect(opts, f, -hw * 0.78, hw * 0.78, d * 0.2, d * 0.88);
    roundRectPath(ctx, r, Math.min(r.w, r.h) * 0.35);
  } else if (glyph === 'bath') {
    const m = Math.min(70, d * 0.12);
    const r = localRect(opts, f, -hw + m, hw - m, m, d - m);
    roundRectPath(ctx, r, Math.min(r.w, r.h) * 0.3);
  }
  ctx.stroke();
}

// ---- fixtures ------------------------------------------------------------------------------------

function polygonPath(ctx, opts, pts) {
  const s0 = opts.toPx(pts[0]);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < pts.length; i++) {
    const s = opts.toPx(pts[i]);
    ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
}

// A column (기둥): filled solid black like the walls, no outline, no label, in 그림만 too. Sides flush
// against a wall face are drawn a little into the wall (at most 2 canvas px, 20 mm), so the wall and
// the column meet without an anti-aliased seam (both are black, so the overlap does not show).
function drawColumn(ctx, f, opts, sz, o, project, derived) {
  const b = fixtureBounds(f);
  let flush = { left: false, right: false, top: false, bottom: false };
  try { flush = fixtureFlushSides(project, derived, f); } catch (_) { /* draw it plain */ }
  // A divider (구역 나누기 선) has no thickness: a side flush with one is not drawn past its line.
  flush = { ...flush };
  for (const side of dividerSides(project, b)) flush[side] = false;
  const k = opts.pxPerMM > 0 ? opts.pxPerMM : 1;
  const ext = Math.min(2 / k, 20);
  const r = pxRect(opts, [
    { x: b.minX - (flush.left ? ext : 0), y: b.minY - (flush.top ? ext : 0) },
    { x: b.maxX + (flush.right ? ext : 0), y: b.maxY + (flush.bottom ? ext : 0) },
  ]);
  ctx.fillStyle = sz.screen ? COLORS.wall : '#000000';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (sz.screen) drawScreenMarks(ctx, f, pxRect(opts, fixturePolygon(f)), o);
}

// A stair (계단): a thin outline, tread lines across its 폭 (stairTreads: evenly spaced, about one
// per 250 mm of 길이) and one thin arrow along its centre line from the start end to the far end,
// with a filled head, pointing UP (stairDir). No fill (on screen the side values stay readable), no
// label, and the same in 그림만 (it is drawing, not text). Line widths as the other fixture outlines.
//   color: line colour (the ghost passes its blue); marks: draw the selection / 확인필요 marks.
function drawStair(ctx, f, opts, sz, o, color = FIXTURE_STYLE.color, marks = true) {
  const poly = fixturePolygon(f);
  const box = pxRect(opts, poly);
  if (sz.screen && box.w < 3 && box.h < 3) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = sz.line;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  polygonPath(ctx, opts, poly);
  for (const u of stairTreads(f).positions) {
    const a = opts.toPx(localToWorld(f, u, 0)), b = opts.toPx(localToWorld(f, u, f.d));
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  // The arrow: its head is about 2.4 × 1.6 paper mm (14 × 9 px on screen), never more than a third
  // of the 폭 wide or a quarter of the 길이 long.
  const ar = stairArrowLocal(f);
  const k = opts.pxPerMM > 0 ? opts.pxPerMM : 1;                // canvas px per world mm
  const unit = opts.paper && opts.paper.pxPerPaperMM ? opts.paper.pxPerPaperMM / k : 1 / k; // world mm per paper mm | per px
  let headL = (sz.screen ? 14 : 2.4) * unit, headW = (sz.screen ? 9 : 1.6) * unit;
  const fit = Math.min(1, (f.w * 0.25) / headL, (f.d * 0.34) / headW);
  headL *= fit;
  headW *= fit;
  const tip = opts.toPx(localToWorld(f, ar.to, ar.v));
  const base = opts.toPx(localToWorld(f, ar.to - ar.dir * headL, ar.v));
  const start = opts.toPx(localToWorld(f, ar.from, ar.v));
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  const l = opts.toPx(localToWorld(f, ar.to - ar.dir * headL, ar.v - headW / 2));
  const r = opts.toPx(localToWorld(f, ar.to - ar.dir * headL, ar.v + headW / 2));
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(l.x, l.y);
  ctx.lineTo(r.x, r.y);
  ctx.closePath();
  ctx.fill();
  if (sz.screen && marks) drawScreenMarks(ctx, f, box, o);
}

// Sides of the box b that lie on a divider line running alongside them. → ['left' | 'right' | 'top' | 'bottom']
function dividerSides(project, b) {
  const out = [];
  const nodes = new Map(((project && project.nodes) || []).map((n) => [n.id, n]));
  for (const e of (project && project.edges) || []) {
    if (e.kind !== 'divider') continue;
    const A = nodes.get(e.a), B = nodes.get(e.b);
    if (!A || !B) continue;
    if (Math.abs(A.x - B.x) < 0.5) {
      const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y);
      if (Math.min(hi, b.maxY) - Math.max(lo, b.minY) <= 0.5) continue;
      if (Math.abs(A.x - b.minX) < 0.5) out.push('left');
      if (Math.abs(A.x - b.maxX) < 0.5) out.push('right');
    } else if (Math.abs(A.y - B.y) < 0.5) {
      const lo = Math.min(A.x, B.x), hi = Math.max(A.x, B.x);
      if (Math.min(hi, b.maxX) - Math.max(lo, b.minX) <= 0.5) continue;
      if (Math.abs(A.y - b.minY) < 0.5) out.push('top');
      if (Math.abs(A.y - b.maxY) < 0.5) out.push('bottom');
    }
  }
  return out;
}

// Selection frame and the orange 확인필요 dot (screen only).
function drawScreenMarks(ctx, f, box, o) {
  const hl = o.highlight;
  if (hl && hl.fixtureId === f.id) {
    ctx.strokeStyle = FIXTURE_STYLE.selected;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
    ctx.stroke();
  }
  if (f.check) {
    ctx.fillStyle = FIXTURE_STYLE.check;
    ctx.beginPath();
    ctx.arc(box.x + box.w, box.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 11px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', box.x + box.w, box.y + 0.5);
  }
}

function drawOneFixture(ctx, f, opts, sz, o) {
  const poly = fixturePolygon(f);
  const box = pxRect(opts, poly);
  if (sz.screen && box.w < 3 && box.h < 3) return;
  // 싱크대 / 옷장 / 신발장: a plain white fill under the outline. The fixture layer comes before the
  // per-side values and the room names (render.js), so the fill hides none of them. It is opaque, so
  // an in-wall fixture (inWall) replaces the wall band it stands in.
  const gray = hasGrayFill(f);
  if (gray) {
    ctx.fillStyle = FIXTURE_STYLE.fill;
    ctx.beginPath();
    polygonPath(ctx, opts, poly);
    ctx.fill();
  }
  drawGlyph(ctx, f, opts, sz);
  ctx.strokeStyle = FIXTURE_STYLE.color;
  ctx.lineWidth = sz.line;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  polygonPath(ctx, opts, poly);
  if (gray && FIXTURE_STYLE.innerLine) {
    const g = Math.min(sz.innerGap, box.w / 4, box.h / 4);
    if (g > sz.line) ctx.rect(box.x + g, box.y + g, box.w - 2 * g, box.h - 2 * g);
  }
  ctx.stroke();
  // On paper every text label comes from draw-labels.js (one placement with collision avoidance and
  // hand-moved offsets; '그림만' leaves it out), so only the screen writes fixture labels here.
  if (!o.drawingOnly && !opts.paper) {
    const c = opts.toPx({ x: f.x, y: f.y });
    const { n } = fixtureFrame(f.rot);
    drawLabel(ctx, fixtureLabel(f), c, box, sz.font, FIXTURE_STYLE.color, { x: -n.x, y: -n.y }, !gray);
  }
  if (sz.screen) drawScreenMarks(ctx, f, box, o);
}

export function drawFixtures(ctx, project, derived, opts) {
  const list = (project && project.fixtures) || [];
  if (!list.length) return;
  const sz = sizes(opts);
  const o = optionsOf(opts);
  ctx.save();
  for (const raw of list) {
    const f = normalizeFixture(raw);
    if (!f || (o.excludeId && f.id === o.excludeId)) continue;
    try {
      if (isColumn(f)) drawColumn(ctx, f, opts, sz, o, project, derived);
      else if (isStair(f)) drawStair(ctx, f, opts, sz, o);
      else drawOneFixture(ctx, f, opts, sz, o);
    } catch (err) {
      console.error('fixture draw failed', f.id, err);
    }
  }
  ctx.restore();
}

// Drag preview of a fixture being placed or moved (screen only): a dashed blue outline.
//   fixture: a (possibly partial) fixture at its preview position.
export function drawFixtureGhost(ctx, fixture, opts) {
  const f = normalizeFixture(fixture);
  if (!f) return;
  const poly = fixturePolygon(f);
  ctx.save();
  ctx.fillStyle = 'rgba(26, 115, 232, 0.08)';
  ctx.strokeStyle = FIXTURE_STYLE.ghost;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  polygonPath(ctx, opts, poly);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  if (isStair(f)) {
    // A stair shows its treads and arrow (how it will be drawn), no text.
    drawStair(ctx, f, opts, sizes(opts), {}, FIXTURE_STYLE.ghost, false);
    ctx.restore();
    return;
  }
  const box = pxRect(opts, poly);
  drawLabel(ctx, f.type, opts.toPx({ x: f.x, y: f.y }), box, 12, FIXTURE_STYLE.ghost);
  ctx.restore();
}

// ---- "실 아님(설비)" spaces --------------------------------------------------------------------------

// A notRoom room (e.g. the 예시 세대 A 옷장, a space split off by a divider) is drawn like a 옷장 fixture:
// its outline already comes from the walls/dividers; its inside (the room's inner outline: wall faces
// plus finishes, so the walls are not painted over) gets the same plain white fill, and its name a
// fixture-style label. No diagonal (user feedback 2026-10-17), no colour (2026-10-18).
// On screen the dividers are drawn before this layer (render.js), so the fill stays half a divider
// line clear of every side that is a divider; on paper the dividers come after it.
// NOTE for render.js: the plain room label of these rooms should be skipped (see integration spec).
export function drawNotRoomSpaces(ctx, project, derived, opts) {
  const rooms = (derived && Array.isArray(derived.rooms)) ? derived.rooms : [];
  const sz = sizes(opts);
  const o = optionsOf(opts);
  const edges = new Map(((project && project.edges) || []).map((e) => [e.id, e]));
  const k = opts.pxPerMM > 0 ? opts.pxPerMM : 1;
  const dividerClear = sz.screen ? (LINES.divider / 2 + 0.5) / k : 0;   // world mm
  ctx.save();
  for (const r of rooms) {
    if (!r || !r.room || !r.room.notRoom || !r.face || !r.face.points || r.face.points.length < 3) continue;
    const pts = r.face.points;
    const box = pxRect(opts, pts);
    if (sz.screen && box.w < 3 && box.h < 3) continue;
    let inner = null;
    try { inner = roomInnerPolygon(r, project, derived); } catch (_) { inner = null; }
    if (inner && inner.length >= 3) {
      const isDivider = (side) => side && side.edgeIds && side.edgeIds.length
        && side.edgeIds.every((id) => edges.get(id) && edges.get(id).kind === 'divider');
      const offsets = (r.sides || []).map((s) => (isDivider(s) ? dividerClear : 0));
      const fillPts = offsets.some((v) => v > 0) ? insetPolygon(inner, r.sides, offsets) : inner;
      ctx.fillStyle = FIXTURE_STYLE.fill;
      ctx.beginPath();
      polygonPath(ctx, opts, fillPts);
      ctx.fill();
    }
    const name = (r.room.name || '').trim();
    if (!o.drawingOnly && !opts.paper && name) {   // paper: draw-labels.js writes the name
      // The middle of the box when it lies inside the room (a tall closet reads best there), else
      // the engine's label point.
      const mid = {
        x: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2,
        y: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2,
      };
      const at = pointInPolygon(mid, pts) ? mid : (r.labelPoint || mid);
      const tb = drawLabel(ctx, name, opts.toPx(at), box, sz.font, FIXTURE_STYLE.color, null, false);
      // opts.nameBoxes (screen): a tap on this name opens the room panel with its name field, like
      // a room name (main.js roomNameAt).
      if (tb && Array.isArray(opts.nameBoxes)) opts.nameBoxes.push({ roomId: r.roomId, ...tb });
    }
  }
  ctx.restore();
}

// The inner outline (vertex i = start of side i) with side i moved into the room by offsets[i] mm
// along its inward normal. Each vertex solves the two moved lines that meet there; parallel
// neighbours just move by the larger offset. → [{ x, y }]
function insetPolygon(pts, sides, offsets) {
  const n = pts.length;
  if (!sides || sides.length !== n) return pts;
  return pts.map((p, i) => {
    const j = (i - 1 + n) % n;
    const a = sides[j].inwardNormal, b = sides[i].inwardNormal;
    const da = offsets[j] || 0, db = offsets[i] || 0;
    if (!da && !db) return p;
    const det = a.x * b.y - a.y * b.x;
    if (Math.abs(det) < 1e-6) {
      const m = Math.max(da, db);
      return { x: p.x + b.x * m, y: p.y + b.y * m };
    }
    // Solve a·v = da, b·v = db.
    const vx = (da * b.y - db * a.y) / det;
    const vy = (a.x * db - b.x * da) / det;
    return { x: p.x + vx, y: p.y + vy };
  });
}

// Draw options for the screen from a View (view.js): the integrator can pass this to every stage-B
// draw function. → { toPx, pxPerMM, paper: null, options }
export function screenDrawOpts(view, options = {}) {
  return { toPx: (p) => view.toScreen(p), pxPerMM: view.scale, paper: null, options };
}
