// 설비 tool and fixture panel (plan §2-5 "설비").
//
//   FixtureTool   — the canvas tool: a chip bar of types floats over the canvas; a tap places the
//                   chosen type (snapped to the nearest wall face), a drag places it where the drag
//                   ends; tapping an existing fixture opens its panel, dragging it moves it.
//   FixturePanel  — bottom panel for one fixture: 길이/깊이 (싱크대 / 옷장 / 신발장: 가로 first, the
//                   depth is the average unless typed) with the numpad, 종류 변경, 회전, 글자 숨기기,
//                   [벽 속에 넣기] (옷장 / 신발장 on a wall), a name box for 기타 (keyboard),
//                   확인필요, [벽 길이 ▶] (a fixture against a wall: that wall's length panel, with the
//                   ▶ in the fixture's room; panel.openEdge, set by tools.js as `openEdge`), 지우기.
//
// Dependencies follow the existing controllers (tools.js / panel.js):
//   ctx = { store(), view, command(fn, label) → bool, toast(msg, opts), requestRender(),
//           panelHost: the #panel element (shared with PanelController),
//           overlayHost: element over the canvas for the chip bar (e.g. #canvasWrap),
//           beforePanelOpen(): close the other bottom panel (PanelController.close),
//           onPanelChange(): selection / panel height changed (redraw) }
import { el, Numpad } from './panel.js';
import { formatMM, FONT_STACK } from './theme.js';
import {
  FIXTURE_TYPES, fixtureAt, fixtureLabel, fixtureTypeInfo, normalizeFixture, placeFixture,
  MIN_FIXTURE_MM, MAX_FIXTURE_MM, isColumn, extentKey, fixtureExtents, fixtureBounds, fixtureFlushSides,
  resizeFixtureBox, snapResizeSize, isStair, keepStairWay, fixtureRoomSide, fixtureFrame,
  isWidthOnly, canGoInWall, OTHER_TYPE,
} from '../core/fixtures.js';
import { drawFixtureGhost, FIXTURE_STYLE } from './draw-fixtures.js';

// Two lines at most on a landscape tablet (the 설비 chip bar sits right under the hint, main.js).
export const FIXTURE_HINT = '설비: 위에서 종류를 고르고 놓을 곳을 누르세요. 벽이나 모서리 가까이 놓으면 붙습니다. 놓은 설비를 끌면 옮겨지고, 누른 설비의 네모 점을 끌면 크기가 바뀝니다.';

const DRAG_SLOP_PX = 8;
const SNAP_PX = 28;        // wall snapping distance on screen
const HIT_PX = 8;          // extra tap tolerance around a fixture
const WALL_POINT_MM = 10;  // [벽 길이 ▶]: the room side is picked at this far past the wall's face

// Resize handles of the selected fixture (finger / S Pen): a visible 14 px square, a 44 px touch
// square around it. Each handle sits a little outside the fixture, so the body stays free for moving.
export const HANDLE = { size: 14, touch: 44, offset: 11, inside: 10 };

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Screen handles of a fixture: one per free edge and one per corner between two free edges.
// Sides flush against a wall (the back; a corner end) have none, so they cannot move. An in-wall
// fixture shows no handle inside the wall: its end handles sit on the part in the room.
//   → [{ sx, sy (-1 | 0 | 1: which world edges it moves), x, y (screen px) }]
export function fixtureHandles(project, derived, raw, view) {
  const f = normalizeFixture(raw);
  if (!f) return [];
  const b = fixtureBounds(f);
  const flush = fixtureFlushSides(project, derived, f);
  const free = { '-1x': !flush.left, '1x': !flush.right, '-1y': !flush.top, '1y': !flush.bottom };
  if (f.inWall) {
    // The back of an in-wall fixture is inside the wall: never a handle there (even when the
    // flush test could not find its room side).
    const { n } = fixtureFrame(f.rot);
    free[Math.abs(n.x) > 0.5 ? `${Math.sign(n.x)}x` : `${Math.sign(n.y)}y`] = false;
  }
  const p0 = view.toScreen({ x: b.minX, y: b.minY }), p1 = view.toScreen({ x: b.maxX, y: b.maxY });
  const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
  // In-wall fixture (벽 속에 넣기): part of the box lies inside the wall band. Nothing there can be
  // dragged (the back stays in the wall), so the end handles move to the middle of the part that
  // stands in the room, and go when nothing stands out (the front corners still change the length).
  let endX = cx, endY = cy, noEnds = false, endAxis = null;
  if (f.inWall && f.wall) {
    const rs = fixtureRoomSide(project, derived, f);
    if (rs) {
      endAxis = rs.key;   // the end handles move along the wall: sx for 'x', sy for 'y'
      const lo = rs.cross === 'x' ? b.minX : b.minY, hi = rs.cross === 'x' ? b.maxX : b.maxY;
      const inLo = rs.side > 0 ? Math.max(lo, rs.face) : lo;
      const inHi = rs.side > 0 ? hi : Math.min(hi, rs.face);
      const k = view.scale || 1;
      if ((inHi - inLo) * k < HANDLE.size) noEnds = true;
      const mid = (inLo + inHi) / 2;
      const s = view.toScreen(rs.cross === 'x' ? { x: mid, y: b.minY } : { x: b.minX, y: mid });
      if (rs.cross === 'x') endX = s.x; else endY = s.y;
    }
  }
  const o = HANDLE.offset;
  const out = [];
  for (const sx of [-1, 0, 1]) {
    for (const sy of [-1, 0, 1]) {
      if (!sx && !sy) continue;
      if (sx && !free[`${sx}x`]) continue;
      if (sy && !free[`${sy}y`]) continue;
      const isEnd = endAxis === 'x' ? (sx && !sy) : endAxis === 'y' ? (sy && !sx) : false;
      if (isEnd && noEnds) continue;
      const x = sx < 0 ? p0.x - o : sx > 0 ? p1.x + o : (isEnd ? endX : cx);
      const y = sy < 0 ? p0.y - o : sy > 0 ? p1.y + o : (isEnd ? endY : cy);
      out.push({ sx, sy, x, y });
    }
  }
  return out;
}

// The handle under a screen point, or null. Inside the fixture a handle only counts close to its own
// edge (HANDLE.inside px, at most a quarter of the fixture), so a drag in the middle moves it.
export function handleAtScreen(handles, raw, view, pt) {
  if (!handles.length || !pt) return null;
  const f = normalizeFixture(raw);
  const b = fixtureBounds(f);
  const p0 = view.toScreen({ x: b.minX, y: b.minY }), p1 = view.toScreen({ x: b.maxX, y: b.maxY });
  const inBox = pt.x > p0.x && pt.x < p1.x && pt.y > p0.y && pt.y < p1.y;
  const half = HANDLE.touch / 2;
  let best = null, bestD = Infinity;
  for (const h of handles) {
    if (Math.abs(pt.x - h.x) > half || Math.abs(pt.y - h.y) > half) continue;
    if (inBox) {
      const deepX = Math.min((p1.x - p0.x) / 4, HANDLE.inside), deepY = Math.min((p1.y - p0.y) / 4, HANDLE.inside);
      const nearX = h.sx < 0 ? pt.x - p0.x <= deepX : h.sx > 0 ? p1.x - pt.x <= deepX : false;
      const nearY = h.sy < 0 ? pt.y - p0.y <= deepY : h.sy > 0 ? p1.y - pt.y <= deepY : false;
      if (!nearX && !nearY) continue;
    }
    const dd = Math.hypot(pt.x - h.x, pt.y - h.y);
    if (dd < bestD) { best = h; bestD = dd; }
  }
  return best;
}

// The world box of a fixture after dragging handle { sx, sy } to the world point `at`: the moved
// edges follow the pointer, the size snaps to 10 mm steps (at least 50 mm), the other edges stay.
export function draggedBox(box0, handle, at) {
  const b = { ...box0 };
  if (handle.sx > 0) b.maxX = b.minX + snapResizeSize(at.x - b.minX);
  else if (handle.sx < 0) b.minX = b.maxX - snapResizeSize(b.maxX - at.x);
  if (handle.sy > 0) b.maxY = b.minY + snapResizeSize(at.y - b.minY);
  else if (handle.sy < 0) b.minY = b.maxY - snapResizeSize(b.maxY - at.y);
  return b;
}

// '450 × 400': 가로 × 세로 of a column, 폭 × 길이 of a stair, 길이 × 깊이 of other fixtures.
export function sizeReadout(raw) {
  const f = normalizeFixture(raw);
  if (!f) return '';
  if (isStair(f)) return `${Math.round(f.d)} × ${Math.round(f.w)}`;
  if (isColumn(f)) {
    const { ex, ey } = fixtureExtents(f);
    return `${Math.round(ex)} × ${Math.round(ey)}`;
  }
  return `${Math.round(f.w)} × ${Math.round(f.d)}`;
}

// ---- tool ----------------------------------------------------------------------------------------

export class FixtureTool {
  constructor(ctx) {
    this.ctx = ctx;
    this.type = FIXTURE_TYPES[0].type;
    this.active = null;     // per-gesture state
    this.overlay = null;    // { fixture } drag preview
    this.panel = new FixturePanel(ctx);
    this.bar = null;
  }

  snapMM() {
    return clamp(SNAP_PX / this.ctx.view.scale, 50, 600);
  }

  // Show the type chips (call when the 설비 tool is chosen).
  activate() {
    if (!this.bar) this.bar = el('div', { class: 'fx-bar', role: 'toolbar', 'aria-label': '설비 종류' });
    this._renderBar();
    if (this.ctx.overlayHost && !this.bar.isConnected) this.ctx.overlayHost.append(this.bar);
    this.bar.hidden = false;
  }

  // Hide the chips (another tool was chosen). The fixture panel may stay open.
  deactivate() {
    this.cancel();
    if (this.bar) this.bar.hidden = true;
  }

  cancel() {
    const had = !!(this.active || this.overlay);
    this.active = null;
    this.overlay = null;
    if (had) this.ctx.requestRender();
    return had;
  }

  setType(type) {
    if (!FIXTURE_TYPES.some((t) => t.type === type)) return;
    this.type = type;
    this._renderBar();
  }

  _renderBar() {
    if (!this.bar) return;
    this.bar.replaceChildren(el('span', { class: 'fx-bar-label' }, '설비'),
      ...FIXTURE_TYPES.map((t) => el('button', {
        type: 'button',
        class: `chip fx-chip ${t.type === this.type ? 'chip-on' : ''}`,
        'aria-pressed': t.type === this.type ? 'true' : 'false',
        onclick: () => this.setType(t.type),
      }, t.type)));
  }

  // What the renderer highlights (pass as options.highlight).
  get highlight() {
    return this.panel.highlight;
  }

  // The fixture whose size is being dragged: the plan leaves it out (options.excludeId) and the
  // overlay draws it at its new size instead.
  get resizingId() {
    const a = this.active;
    return a && a.kind === 'resize' && this.overlay ? a.id : null;
  }

  // Open the panel for a fixture (also used by other tools when a tap hits a fixture).
  // opts.focusName: put the keyboard on a 기타's name box.
  openFixture(id, opts = {}) {
    this.panel.open(id, null, opts);
  }

  // Fixture under a world point, with a small screen tolerance. → fixture | null
  hitTest(world) {
    const store = this.ctx.store();
    return fixtureAt(store.project, world, HIT_PX / this.ctx.view.scale);
  }

  // The selected fixture (its panel is open), or null.
  _selected() {
    const id = this.panel.fixtureId;
    if (!id) return null;
    const store = this.ctx.store();
    return (store.project.fixtures || []).find((f) => f.id === id) || null;
  }

  // Resize handles of the selected fixture in screen px (see fixtureHandles). → [handle]
  handles() {
    const f = this._selected();
    if (!f) return [];
    const store = this.ctx.store();
    try { return fixtureHandles(store.project, store.derived, f, this.ctx.view); } catch (_) { return []; }
  }

  // The resize handle under a SCREEN point (canvas CSS px), or null. The 선택 tool asks this first.
  handleAt(screenPt) {
    const f = this._selected();
    if (!f) return null;
    return handleAtScreen(this.handles(), f, this.ctx.view, screenPt);
  }

  // ---- gestures (same interface as ToolController) ------------------------------------------

  onGestureStart(g) {
    const p = g.points[0];
    const handle = g.screen && g.screen.length ? this.handleAt(g.screen[0]) : null;
    if (handle) {
      // Grab offset: the pointer need not be exactly on the edge it moves.
      const f = normalizeFixture(this._selected());
      const box0 = fixtureBounds(f);
      const edge = { x: handle.sx > 0 ? box0.maxX : handle.sx < 0 ? box0.minX : p.x, y: handle.sy > 0 ? box0.maxY : handle.sy < 0 ? box0.minY : p.y };
      this.active = { kind: 'resize', id: f.id, handle, box0, offset: { x: edge.x - p.x, y: edge.y - p.y } };
      return;
    }
    const hit = this.hitTest(p);
    if (hit) {
      this.active = { kind: 'move', id: hit.id, offset: { x: hit.x - p.x, y: hit.y - p.y } };
    } else {
      this.active = { kind: 'place' };
    }
  }

  // The fixture as the current resize drag would leave it (the same rule as the command).
  _resized(a, g) {
    const store = this.ctx.store();
    const raw = (store.project.fixtures || []).find((x) => x.id === a.id);
    if (!raw) return null;
    const last = g.points[g.points.length - 1];
    const box = draggedBox(a.box0, a.handle, { x: last.x + a.offset.x, y: last.y + a.offset.y });
    return { box, fixture: resizeFixtureBox(store.project, store.derived, raw, box) };
  }

  onGestureMove(g) {
    const a = this.active;
    if (!a || g.maxMovePx < DRAG_SLOP_PX) return;
    const store = this.ctx.store();
    const last = g.points[g.points.length - 1];
    let f;
    if (a.kind === 'resize') {
      const r = this._resized(a, g);
      if (!r) return;
      this.overlay = { fixture: r.fixture, resize: true };
      this.ctx.requestRender();
      return;
    }
    if (a.kind === 'move') {
      const cur = normalizeFixture(store.project.fixtures.find((x) => x.id === a.id));
      if (!cur) return;
      const at = { x: last.x + a.offset.x, y: last.y + a.offset.y };
      // Same rule as the command (moveFixture): snapped, then kept inside its room side.
      f = keepStairWay(cur, placeFixture(store.project, store.derived, cur, at, this.snapMM()));
    } else {
      const info = fixtureTypeInfo(this.type);
      f = placeFixture(store.project, store.derived, normalizeFixture({ type: this.type, w: info.w, d: info.d, rot: 0 }),
        last, this.snapMM());
    }
    this.overlay = { fixture: f };
    this.ctx.requestRender();
  }

  onGestureEnd(g) {
    const a = this.active;
    this.active = null;
    this.overlay = null;
    if (!a) return;
    const store = this.ctx.store();
    const snapMM = this.snapMM();
    if (a.kind === 'resize') {
      // A tap on a handle does nothing; a drag is one command (one undo step).
      if (!g.isTap && g.maxMovePx >= DRAG_SLOP_PX) {
        const r = this._resized(a, g);
        if (r) this.ctx.command(() => store.setFixtureBox(a.id, r.box), '설비 크기');
        if (this.panel.isOpen) this.panel.refresh();
      }
    } else if (g.isTap || g.maxMovePx < DRAG_SLOP_PX) {
      if (a.kind === 'move') this.openFixture(a.id);
      else this._place(g.points[0], snapMM);
    } else if (a.kind === 'move') {
      const last = g.points[g.points.length - 1];
      this.ctx.command(() => store.moveFixture(a.id, last.x + a.offset.x, last.y + a.offset.y, { snapMM }), '설비 옮기기');
      if (this.panel.isOpen) this.panel.refresh();
    } else {
      this._place(g.points[g.points.length - 1], snapMM);
    }
    this.ctx.requestRender();
  }

  onGestureCancel() {
    this.cancel();
  }

  _place(at, snapMM) {
    const store = this.ctx.store();
    let id = null;
    const ok = this.ctx.command(() => { id = store.addFixture(this.type, at.x, at.y, { snapMM }); }, '설비 놓기');
    if (ok && id) this._diagonalHint(id, at, snapMM);
    // A new 기타 asks for its name first (the keyboard opens on its name box).
    if (ok && id) this.openFixture(id, { focusName: this.type === OTHER_TYPE });
  }

  // Fixtures stand only against h / v walls. One dropped by a diagonal wall stays free-standing and
  // axis-aligned: say so, instead of leaving a box askew by the wall without a word (fixer 2026-10-20,
  // field: a 옷장 tapped 300 mm from the corner-to-corner wall).
  _diagonalHint(id, at, snapMM) {
    try {
      const store = this.ctx.store();
      const f = (store.project.fixtures || []).find((x) => x.id === id);
      if (!f || f.wall) return;
      const reach = snapMM + Math.max(Number(f.w) || 0, Number(f.d) || 0) / 2;
      const edgeId = store.edgeAt(at, reach);
      const e = edgeId && store.project.edges.find((x) => x.id === edgeId);
      if (e && e.orient === 'd' && e.kind !== 'divider') {
        this.ctx.toast('사선 벽에는 설비를 붙일 수 없어 따로 놓았습니다. 끌어서 자리를 맞춰 주세요.', { type: 'warn', ms: 4500 });
      }
    } catch (err) {
      console.error(err);
    }
  }

  // Drag preview, drawn after the plan (screen only), and the resize handles of the selected
  // fixture; while a handle is dragged, the new size next to it ('450 × 400'). opts: see draw-fixtures.js.
  drawOverlay(ctx, opts) {
    const ov = this.overlay;
    if (ov && ov.fixture && ov.resize) {
      drawResizePreview(ctx, ov.fixture, opts);
      const store = this.ctx.store();
      let hs = [];
      try { hs = fixtureHandles(store.project, store.derived, ov.fixture, this.ctx.view); } catch (_) { hs = []; }
      drawHandles(ctx, hs);
      let blocked = [];
      try { blocked = this.ctx.overlayRects ? this.ctx.overlayRects() || [] : []; } catch (_) { blocked = []; }
      drawReadout(ctx, ov.fixture, opts, this.ctx.view, blocked);
      return;
    }
    if (ov && ov.fixture) drawFixtureGhost(ctx, ov.fixture, opts);
    if (!ov || !ov.fixture) drawHandles(ctx, this.handles());
  }
}

// ---- handle drawing (screen only) -------------------------------------------------------------

function drawHandles(ctx, handles) {
  if (!handles.length) return;
  const s = HANDLE.size;
  ctx.save();
  ctx.lineWidth = 2;
  for (const h of handles) {
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = FIXTURE_STYLE.selected;
    ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
    ctx.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
  }
  ctx.restore();
}

// The fixture at its new size while a handle is dragged: a column solid (as it will be drawn),
// other fixtures as the usual dashed ghost.
function drawResizePreview(ctx, fixture, opts) {
  const f = normalizeFixture(fixture);
  if (!f) return;
  if (!isColumn(f)) {
    drawFixtureGhost(ctx, f, opts);
    return;
  }
  const b = fixtureBounds(f);
  const p0 = opts.toPx({ x: b.minX, y: b.minY }), p1 = opts.toPx({ x: b.maxX, y: b.maxY });
  ctx.save();
  ctx.fillStyle = '#111111';   // as drawn (COLORS.wall); the plan leaves the old size out meanwhile
  ctx.strokeStyle = FIXTURE_STYLE.selected;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  ctx.strokeRect(p0.x - 3, p0.y - 3, p1.x - p0.x + 6, p1.y - p0.y + 6);
  ctx.restore();
}

// Where the '450 × 400' pill (pw × ph px) goes next to the fixture's screen box p0..p1: above it,
// else below, right, left — the first spot inside the canvas that no floating element (hint, tool
// bar, view buttons, bottom panel: `blocked`, canvas px rects) covers; above when none is free.
// → { left, top }
export function readoutSpot(p0, p1, pw, ph, viewW, viewH, blocked = []) {
  const gap = HANDLE.offset + HANDLE.size + 4;
  const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
  const clampX = (x) => Math.max(4, Math.min(viewW - pw - 4, x));
  const clampY = (y) => Math.max(4, Math.min(viewH - ph - 4, y));
  const spots = [
    { left: clampX(cx - pw / 2), top: p0.y - gap - ph },
    { left: clampX(cx - pw / 2), top: p1.y + gap },
    { left: p1.x + gap, top: clampY(cy - ph / 2) },
    { left: p0.x - gap - pw, top: clampY(cy - ph / 2) },
  ];
  const free = (s) => s.left >= 4 && s.top >= 4 && s.left + pw <= viewW - 4 && s.top + ph <= viewH - 4
    && !blocked.some((r) => s.left < r.x + r.w && s.left + pw > r.x && s.top < r.y + r.h && s.top + ph > r.y);
  const pick = spots.find(free);
  if (pick) return pick;
  return { left: spots[0].left, top: clampY(spots[0].top) };
}

// '450 × 400' in a pill next to the fixture (see readoutSpot).
function drawReadout(ctx, fixture, opts, view, blocked) {
  const f = normalizeFixture(fixture);
  if (!f) return;
  const text = sizeReadout(f);
  const b = fixtureBounds(f);
  const p0 = opts.toPx({ x: b.minX, y: b.minY }), p1 = opts.toPx({ x: b.maxX, y: b.maxY });
  ctx.save();
  ctx.font = `bold 15px ${FONT_STACK}`;
  const tw = ctx.measureText(text).width;
  const pw = tw + 18, ph = 26;
  const { left, top } = readoutSpot(p0, p1, pw, ph, (view && view.width) || 1e9, (view && view.height) || 1e9, blocked || []);
  ctx.fillStyle = FIXTURE_STYLE.selected;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(left, top, pw, ph, ph / 2); else ctx.rect(left, top, pw, ph);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + pw / 2, top + ph / 2 + 0.5);
  ctx.restore();
}

// ---- number entry --------------------------------------------------------------------------------

class SizeBuffer {
  constructor() { this.reset(''); }
  reset(text = '') { this.text = text; this.edited = false; }
  key(k) {
    if (/^[0-9]$/.test(k)) {
      if (this.text.length >= 5) return;
      this.text += k;
      this.edited = true;
    } else if (k === 'back') {
      this.text = this.text.slice(0, -1);
      this.edited = true;
    } else if (k === 'clear') {
      this.text = '';
      this.edited = true;
    }
  }
  value() {
    const n = parseInt(this.text, 10);
    return n > 0 ? n : null;
  }
}

// ---- panel ---------------------------------------------------------------------------------------

export class FixturePanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.panelHost;
    this.state = null;      // { id, active: 'w' | 'd' }
    this.root = null;       // our element inside the shared host
    this.buffer = new SizeBuffer();
    this.numpad = new Numpad((k) => this.onNumpad(k));
    this.numpad.setPlusEnabled(false);
    // [벽 길이 ▶]: (edgeId, prefer) → the length panel (PanelController.openEdge). ctx.openEdge, else set
    // by the tool controller; without it the button is not shown.
    this.openEdge = typeof ctx.openEdge === 'function' ? ctx.openEdge : null;
  }

  // Open only while our element is still in the shared host (PanelController may have replaced it).
  get isOpen() {
    return !!(this.state && this.root && this.host && this.host.contains(this.root) && !this.host.hidden);
  }

  get highlight() {
    return this.isOpen ? { fixtureId: this.state.id } : null;
  }

  get fixtureId() {
    return this.isOpen ? this.state.id : null;
  }

  _fixture() {
    const store = this.ctx.store();
    const raw = this.state && (store.project.fixtures || []).find((f) => f.id === this.state.id);
    return raw ? normalizeFixture(raw) : null;
  }

  // opts.focusName: a 기타 — the name box takes the focus (the tablet keyboard opens).
  open(id, field = null, opts = {}) {
    if (this.state && this.state.nameDraft != null && this.state.id !== id) this.close();
    // A size typed for the fixture shown so far (no [다음 ▶] / [확인]) goes into it first.
    this.flushDraft();
    if (this.ctx.beforePanelOpen) this.ctx.beforePanelOpen();
    this.state = { id, active: field || 'w', focusName: !!(opts && opts.focusName) };
    this.buffer.reset('');
    const f = this._fixture();
    if (!f) {
      this.state = null;
      return;
    }
    if (!field) this.state.active = this._order(f)[0];
    this._render();
  }

  // The two size fields in entry order (local keys 'w' / 'd'): 길이 then 깊이; for a column 가로
  // (world x) then 세로 (world y), whichever local key holds them at its rotation; for a stair 폭
  // (d, across the walking direction) then 길이 (w, along it).
  _order(f) {
    if (isStair(f)) return ['d', 'w'];
    return isColumn(f) ? [extentKey(f, 'x'), extentKey(f, 'y')] : ['w', 'd'];
  }

  // Field names in the order of _order. 싱크대 / 옷장 / 신발장 say 가로 (the width along the wall, the
  // one size that is usually measured).
  _names(f) {
    if (isStair(f)) return ['폭', '길이'];
    if (isColumn(f)) return ['가로', '세로'];
    return isWidthOnly(f) ? ['가로', '깊이'] : ['길이', '깊이'];
  }

  // A size typed on the numpad but not confirmed is put in when the panel closes or moves on (a tap
  // elsewhere, another tool, the other field, [벽 길이 ▶]), with a toast, as in the length panel (review
  // 2026-10-25: a typed 싱크대 1500 was lost when the tool changed). Only while this panel shows. → bool
  flushDraft() {
    const s = this.state;
    const buf = this.buffer;
    if (!s || !buf.edited) return false;
    const v = buf.value();
    buf.reset('');
    const f = this.isOpen ? this._fixture() : null;
    const store = this.ctx.store();
    if (v == null || !f || !store) return false;
    const name = this._names(f)[this._order(f).indexOf(s.active)] || '크기';
    const what = `${f.type === OTHER_TYPE && typeof f.label === 'string' && f.label.trim() ? f.label.trim() : f.type} ${name}`;
    if (v < MIN_FIXTURE_MM || v > MAX_FIXTURE_MM) {
      this.ctx.toast(`입력하던 값(${formatMM(v)})은 넣지 않았습니다. 설비 크기는 ${MIN_FIXTURE_MM}~${formatMM(MAX_FIXTURE_MM)}mm 사이로 넣어 주세요.`, { type: 'warn', ms: 4500 });
      return false;
    }
    if (f.measured[s.active] && Math.round(f[s.active]) === v) return false;
    const ok = this.ctx.command(() => store.updateFixture(s.id, { [s.active]: v }), `${isStair(f) ? '계단' : '설비'} ${name}`);
    if (ok) this.ctx.toast(`입력하던 값을 넣었습니다: ${what} ${formatMM(v)}mm (↶로 되돌릴 수 있습니다)`, { type: 'ok', ms: 4500 });
    return !!ok;
  }

  // opts.discard: Esc, or the fixture is gone — a size or name still being typed is thrown away.
  close({ discard = false } = {}) {
    const s = this.state;
    if (discard) {
      this.buffer.reset('');
      if (s) s.nameDraft = null;
    } else {
      this.flushDraft();
    }
    // A 기타 name typed but not applied yet is kept (typed, then a tap elsewhere instead of [적용]).
    if (s && s.nameDraft != null) {
      const draft = s.nameDraft;
      s.nameDraft = null;
      const f = this._fixture();
      if (f && f.type === OTHER_TYPE) this.setName(draft);
    }
    const mine = this.isOpen;
    this.state = null;
    if (mine) {
      this.host.hidden = true;
      this.host.replaceChildren();
    }
    this.root = null;
    if (this.ctx.onPanelChange) this.ctx.onPanelChange();
  }

  // Call after every store change (undo, redo, commands).
  refresh() {
    if (!this.isOpen) return;
    if (!this._fixture()) return this.close({ discard: true });
    this._render();
  }

  // PC keyboard. → true when the key was used.
  handleKey(e) {
    if (!this.isOpen) return false;
    const k = e.key;
    let key = null;
    if (/^[0-9]$/.test(k)) key = k;
    else if (k === 'Backspace') key = 'back';
    else if (k === 'Enter') key = 'ok';
    else if (k === 'Tab') {
      this._setField(this.state.active === 'w' ? 'd' : 'w');
      return true;
    } else if (k === 'Delete') {
      this.deleteFixture();
      return true;
    }
    if (!key) return false;
    this.onNumpad(key);
    return true;
  }

  onNumpad(key) {
    if (!this.isOpen) return;
    if (key === 'ok') return this._confirm();
    if (key === 'plus') return;
    if (key === 'back' && !this.buffer.edited && !this.buffer.text) {
      const f = this._fixture();
      const field = this.state.active;
      if (f && f.measured[field]) this.buffer.reset(String(Math.round(f[field])));
    }
    this.buffer.key(key);
    this._render();
  }

  _setField(field) {
    if (this.state.active !== field) this.flushDraft();
    this.state.active = field;
    this.buffer.reset('');
    this._render();
  }

  _confirm() {
    const s = this.state;
    const store = this.ctx.store();
    const f = this._fixture();
    if (!f) return this.close();
    if (this.buffer.edited) {
      const v = this.buffer.value();
      if (v != null && (v < MIN_FIXTURE_MM || v > MAX_FIXTURE_MM)) {
        this.ctx.toast(`설비 크기는 ${MIN_FIXTURE_MM}~${formatMM(MAX_FIXTURE_MM)}mm 사이로 넣어 주세요.`, { type: 'warn' });
        return;
      }
      // Empty = back to the default size (not measured).
      const label = `${isStair(f) ? '계단' : '설비'} ${this._names(f)[this._order(f).indexOf(s.active)] || '크기'}`;
      this.ctx.command(() => store.updateFixture(s.id, { [s.active]: v }), label);
    }
    this.buffer.reset('');
    const order = this._order(f);
    if (s.active === order[0]) {
      this._setField(order[1]);
      return;
    }
    const done = this._fixture();
    this.ctx.toast(done ? `${fixtureLabel(done) || done.type} — 넣었습니다.` : '넣었습니다.', { type: 'ok' });
    this.close();
  }

  rotate() {
    const store = this.ctx.store();
    const snapMM = clamp(28 / ((this.ctx.view && this.ctx.view.scale) || 0.06), 50, 600);
    this.ctx.command(() => store.rotateFixture(this.state.id, null, { snapMM }), '설비 회전');
    this.refresh();
  }

  // [방향 바꾸기] on a stair: the arrow (the way up) turns around. One undo step.
  flipStair() {
    const f = this._fixture();
    if (!f || !isStair(f)) return;
    const store = this.ctx.store();
    this.ctx.command(() => store.updateFixture(f.id, { stairDir: f.stairDir === -1 ? 1 : -1 }), '계단 방향');
    this.refresh();
  }

  toggleLabel() {
    const f = this._fixture();
    if (!f) return;
    const store = this.ctx.store();
    this.ctx.command(() => store.updateFixture(f.id, { label: f.label === '' ? null : '' }), '설비 글자');
    this.refresh();
  }

  // The name of a 기타 (typed with the keyboard): it becomes its text on the plan; empty = no text.
  // One undo step; nothing happens when the name did not change.
  setName(text) {
    const f = this._fixture();
    if (!f) return;
    const name = String(text == null ? '' : text).trim().slice(0, 30);
    const cur = typeof f.label === 'string' ? f.label.trim() : '';
    if (name !== cur) {
      const store = this.ctx.store();
      this.ctx.command(() => store.updateFixture(f.id, { label: name || null }), '설비 이름');
      this.ctx.toast(name ? `이름을 바꿨습니다: ${name}` : '이름을 지웠습니다. 도면에 글자가 없습니다.', { type: 'ok' });
    }
    this.refresh();
  }

  // [벽 속에 넣기] on a 신발장 / 옷장 against a wall: it moves back into the wall (the wall is cut
  // there), and back out. One undo step.
  toggleInWall() {
    const f = this._fixture();
    if (!f || !canGoInWall(f)) return;
    const store = this.ctx.store();
    const next = !f.inWall;
    this.ctx.command(() => store.updateFixture(f.id, { inWall: next }), next ? '벽 속에 넣기' : '벽 밖으로 빼기');
    this.ctx.toast(next ? '벽 속에 넣었습니다. 벽이 그만큼 비워집니다.' : '벽 밖으로 뺐습니다.', { type: 'ok' });
    this.refresh();
  }

  // The wall this fixture stands against, if it still exists. → edgeId | null
  _wallEdge(f) {
    if (!f || !f.wall) return null;
    const store = this.ctx.store();
    return (store.project.edges || []).some((e) => e.id === f.wall) ? f.wall : null;
  }

  // [벽 길이 ▶]: the length panel of the wall the fixture stands against, with the ▶ in the fixture's room
  // (a sink along a whole wall covers the strip where a tap opens that wall; 예시 세대 A 싱크대 on 방3 | 주방).
  openWall() {
    const f = this._fixture();
    const edgeId = this._wallEdge(f);
    if (!edgeId || typeof this.openEdge !== 'function') return;
    const store = this.ctx.store();
    // A point just past the wall's face on the fixture's side (panel.openEdge picks the room on that side).
    let at = { x: f.x, y: f.y };
    let roomId = null;
    try {
      const rs = fixtureRoomSide(store.project, store.derived, f);
      if (rs) {
        at = { ...at, [rs.cross]: rs.face + rs.side * WALL_POINT_MM };
        roomId = rs.roomId;
      }
    } catch (_) { /* the fixture's centre */ }
    const openEdge = this.openEdge;
    this.close();
    openEdge(edgeId, { at, roomId });
  }

  toggleCheck() {
    const f = this._fixture();
    if (!f) return;
    const store = this.ctx.store();
    this.ctx.command(() => store.updateFixture(f.id, { check: !f.check }), '확인필요');
    this.ctx.toast(!f.check ? '확인필요로 표시했습니다.' : '확인필요를 해제했습니다.', { type: !f.check ? 'warn' : 'ok' });
    this.refresh();
  }

  changeType(type) {
    const f = this._fixture();
    if (!f || f.type === type) return;
    const store = this.ctx.store();
    this.ctx.command(() => store.updateFixture(f.id, { type }), '설비 종류');
    // Turned into a 기타: ask for its name.
    if (type === OTHER_TYPE && this.state) {
      this.state.focusName = true;
      this.state.nameDraft = null;
    }
    this.refresh();
  }

  deleteFixture() {
    const id = this.state && this.state.id;
    if (!id) return;
    const store = this.ctx.store();
    this.buffer.reset('');
    this.ctx.command(() => store.deleteFixture(id), '설비 지우기');
    this.close({ discard: true });
    this.ctx.toast('지웠습니다. ↶ 버튼으로 되돌릴 수 있습니다.', {
      action: { label: '되돌리기', run: () => this.ctx.command(() => this.ctx.store().undo(), '되돌리기') },
    });
  }

  // ---- rendering ----------------------------------------------------------------------------

  _sizeBox(field, label) {
    const s = this.state;
    const f = this._fixture();
    const active = s.active === field;
    let text = '', sub = '';
    if (active && this.buffer.edited) {
      text = this.buffer.text ? formatMM(+this.buffer.text) : '';
      sub = this.buffer.text ? '' : '비우면 기본 크기';
    } else if (f.measured[field]) {
      text = formatMM(f[field]);
      sub = '잰 값';
    } else if (field === 'd' && isWidthOnly(f)) {
      // The depth of a 싱크대 / 옷장 / 신발장 is usually not measured: the average is drawn.
      sub = `평균 ${formatMM(f[field])} (안 재도 됨)`;
    } else {
      sub = `기본 ${formatMM(f[field])} (안 잼)`;
    }
    return el('div', { class: 'field-wrap' },
      el('span', { class: 'field-label' }, label),
      el('button', {
        type: 'button',
        class: `field ${active ? 'field-active' : ''}`,
        'aria-pressed': active ? 'true' : 'false',
        dataset: { field },
        onclick: () => this._setField(field),
      },
      el('span', { class: 'field-mark' }, active ? '▶' : ''),
      el('span', { class: `field-value ${text ? '' : 'field-empty'}` }, text || ' '),
      el('span', { class: 'field-sub' }, sub)));
  }

  _render() {
    const f = this._fixture();
    if (!f) return this.close();
    const column = isColumn(f);
    const stair = isStair(f);
    const order = this._order(f);
    // A column's fields follow its rotation (w / d swap on a vertical wall); keep the active one valid.
    if (!order.includes(this.state.active)) this.state.active = order[0];
    this.numpad.setOkLabel(this.state.active === order[0] ? '다음 ▶' : '확인');
    const types = el('div', { class: 'chip-row fx-types' },
      el('span', { class: 'chip-label' }, '종류'),
      ...FIXTURE_TYPES.map((t) => el('button', {
        type: 'button',
        class: `chip chip-small fx-type ${t.type === f.type ? 'chip-on' : ''}`,
        onclick: () => this.changeType(t.type),
      }, t.type)));
    const names = this._names(f);
    const sizes = el('div', { class: 'field-row' },
      this._sizeBox(order[0], names[0]), el('span', { class: 'field-sep' }, '×'), this._sizeBox(order[1], names[1]));
    const labelHidden = f.label === '';
    const other = f.type === OTHER_TYPE;
    const inWallOk = canGoInWall(f);
    const actions = el('div', { class: 'panel-actions' },
      stair ? el('button', { type: 'button', class: 'btn fx-stair-flip', onclick: () => this.flipStair() }, '방향 바꾸기') : null,
      // This fixture only. The plan's own [↻ 회전] stays on the canvas while this panel is open, so this
      // one says what it turns (a tablet shows no tooltip; checker 2026-10-21).
      el('button', { type: 'button', class: 'btn fx-rotate', title: column ? '기둥의 가로와 세로를 바꿉니다' : '이 설비만 90° 회전합니다', onclick: () => this.rotate() }, column ? '↻ 가로·세로 바꾸기' : '↻ 설비 회전'),
      inWallOk ? el('button', {
        type: 'button', class: `btn fx-in-wall ${f.inWall ? 'btn-on' : ''}`, 'aria-pressed': f.inWall ? 'true' : 'false',
        onclick: () => this.toggleInWall(),
      }, '벽 속에 넣기') : null,
      // A 기타's text is its name (an empty name = no text), so it has no [글자 숨기기].
      column || stair || other ? null : el('button', {
        type: 'button', class: `btn ${labelHidden ? 'btn-on' : ''}`, 'aria-pressed': labelHidden ? 'true' : 'false',
        onclick: () => this.toggleLabel(),
      }, labelHidden ? '글자 보이기' : '글자 숨기기'),
      el('button', {
        type: 'button', class: `btn ${f.check ? 'btn-on' : ''}`, 'aria-pressed': f.check ? 'true' : 'false',
        onclick: () => this.toggleCheck(),
      }, '확인필요'),
      this.openEdge && this._wallEdge(f)
        ? el('button', { type: 'button', class: 'btn fx-wall-length', onclick: () => this.openWall() }, '벽 길이 ▶') : null,
      el('button', { type: 'button', class: 'btn btn-danger', onclick: () => this.deleteFixture() }, '지우기'),
      el('button', { type: 'button', class: 'btn btn-ghost panel-close', 'aria-label': '닫기', onclick: () => this.close() }, '✕ 닫기'));
    const shown = fixtureLabel(f);
    const typed = typeof f.label === 'string' ? f.label.trim() : '';
    const title = el('div', { class: 'panel-title' },
      other && typed ? `설비: 기타 (${typed})` : `설비: ${f.type}`,
      el('span', { class: 'fx-label-preview' }, shown ? `도면 글자 "${shown}"` : '도면 글자 없음'),
      f.wall ? el('span', { class: 'fx-wall' }, f.inWall ? '벽 속에 들어감' : '벽에 붙음') : null);
    const nameRow = other ? this._nameRow(f) : null;
    let hintText;
    if (column) {
      hintText = '기둥의 가로·세로를 mm로 넣으세요 (기본 400 × 400). 네모 점을 끌어도 크기가 바뀝니다. 기둥은 검게 칠해지고 글자는 없습니다.';
    } else if (stair) {
      hintText = '계단의 폭과 길이(올라가는 방향)를 mm로 넣으세요 (기본 900 × 2400). 네모 점을 끌어도 크기가 바뀝니다. 화살표가 올라가는 쪽을 가리킵니다. 반대면 [방향 바꾸기]를 누르세요.';
    } else if (isWidthOnly(f)) {
      const info = fixtureTypeInfo(f.type);
      hintText = `잰 가로(벽 따라 길이)를 mm로 넣으세요. 깊이는 안 재도 됩니다: 평균 ${formatMM(info.d)}mm로 그리고, 쟀으면 넣어서 고칠 수 있습니다.`;
      if (inWallOk) hintText += ' 벽 속에 들어가 있으면 [벽 속에 넣기]를 누르세요.';
      else if (fixtureTypeInfo(f.type).storage) hintText += ' 벽에 붙이면 [벽 속에 넣기]도 쓸 수 있습니다.';
    } else if (other) {
      hintText = '기타 설비의 이름(예: 수납장)을 적고 [적용]을 누르세요. 이름이 도면 글자가 됩니다 (비우면 글자 없음). 잰 길이와 깊이는 아래 숫자판으로 넣으세요.';
    } else {
      hintText = '잰 길이(벽 따라)와 깊이를 mm로 넣으세요. 안 재면 기본 크기로 그리고 이름만 나옵니다. 설비를 끌면 옮겨지고, 네모 점을 끌면 크기가 바뀝니다 (끌어서 바꾼 크기는 잰 값이 아닙니다).';
    }
    const hint = el('p', { class: 'panel-hint' }, hintText);
    this.root = el('div', { class: 'panel-inner fx-panel' },
      el('div', { class: 'panel-main' }, title, types, nameRow, sizes, actions, hint),
      this.numpad.element);
    this.host.hidden = false;
    this.host.replaceChildren(this.root);
    if (this.ctx.onPanelChange) this.ctx.onPanelChange();
  }

  // The name box of a 기타: '이름 [수납장] [적용]' (keyboard). Enter applies, Esc leaves it unchanged.
  // The focus moves into it only when asked (a new 기타), never on a re-render (a numpad tap must not
  // pop the tablet keyboard up over the panel).
  _nameRow(f) {
    const s = this.state;
    const cur = typeof f.label === 'string' ? f.label : '';
    // A name typed but not applied yet survives re-renders of the panel (numpad taps).
    const input = el('input', {
      class: 'text-input fx-name-input', type: 'text', value: s.nameDraft != null ? s.nameDraft : cur,
      placeholder: '예: 수납장', 'aria-label': '기타 설비 이름', enterkeyhint: 'done', maxlength: '30',
    });
    const apply = () => { s.nameDraft = null; this.setName(input.value); };
    input.addEventListener('input', () => { s.nameDraft = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;   // Korean input: Enter ends the syllable first
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); s.nameDraft = null; input.value = cur; input.blur(); }
    });
    if (s.focusName) {
      s.focusName = false;
      setTimeout(() => { if (input.isConnected) { input.focus(); input.select(); } }, 0);
    }
    return el('div', { class: 'custom-row fx-name-row' },
      el('span', { class: 'chip-label' }, '이름'), input,
      el('button', { type: 'button', class: 'btn btn-primary fx-name-apply', onclick: apply }, '적용'));
  }
}
