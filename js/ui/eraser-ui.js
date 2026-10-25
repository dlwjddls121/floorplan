// 지우개 tool (user 2026-10-22: "원하는 벽, 창호, 문 등 지우개로 지우면 그 벽, 설비, 창호, 문 등 지우개에 닿는
// 곳만 지워지는 기능", "그냥 닿는 벽은 그 벽(일직선)은 다 없어지게 해줘", "딱 닿는것만 지워져야돼").
//
// Rub (or tap) what should go. While the pen / finger is down everything that will be erased is drawn red:
// a touched wall as its whole straight wall (with the windows / doors in it, which cannot stay without
// it), each touched window, door, fixture, memo stroke and 구역 나누기 line. When it lifts, exactly that is
// erased as ONE undo step (store.eraseItems) and a toast says what went. What one eraser position touches
// is decided by core/erase.js: what is under the eraser's centre (walls, windows / doors, fixtures, memo
// ink), thin lines close by on the floor, and a rub keeps to what it is rubbing while it wobbles a few px
// off it. Two fingers still pan / zoom and a palm under the S Pen is ignored (input.js cancels the
// gesture: nothing is erased). A merged-name question after the erase stays in its undo step (main.js).
// The S Pen side button (0.6.3): in EVERY tool a pen gesture with the button held comes here too (tools.js
// g.erase), with the same preview, toast and undo step; the current tool stays.
//
// ctx = { store(), view, command(fn, label, opts) → bool, toast(msg, opts), requestRender() }
import {
  eraserIndex, eraserSizes, eraserTouch, samplePath, erasePlan, addTouch, LINE_REACH_PX,
} from '../core/erase.js';
import { placeOpening, slidingLeaves } from '../core/openings.js';
import { normalizeFixture, fixturePolygon } from '../core/fixtures.js';
import { wallOutline, finishPolygons, finishBeside } from '../core/dims.js';
import { validMemo } from '../core/memo.js';
import { edgeThickness } from './render.js';
import { drawFixtures } from './draw-fixtures.js';
import { memoLinePx } from './memo-ui.js';
import { COLORS } from './theme.js';
import { waitingValuesText } from './panel.js';

export const ERASER_HINT = '지우개: 지울 것을 문지르세요. 닿은 벽은 한 줄 전체, 창·문·설비·메모·구역 나누기 선은 하나씩 지워집니다. 잘못 지우면 ↶.';

export const ERASE_STYLE = {
  wall: 'rgba(229, 57, 53, 0.88)',     // an erased wall's outline, filled
  item: 'rgba(229, 57, 53, 0.30)',     // the fill over a window / door / fixture
  line: '#E53935',                     // outlines, door arcs, 구역 나누기 lines, memo strokes
  ring: '#5F6670',                     // the eraser ring (as the 메모 eraser)
};

export class EraserTool {
  constructor(ctx) {
    this.ctx = ctx;
    // During a gesture: { index, project, touched: { …Ids: Set }, prev (the last position's touch), done,
    //                      last, plan, drawCache }
    this.active = null;
  }

  get isActive() { return !!this.active; }

  // What the gesture so far would erase (erasePlan), or null.
  get plan() { return this.active ? this.active.plan : null; }

  activate() {}

  deactivate() { this.cancel(); }

  cancel() {
    const had = !!this.active;
    this.active = null;
    if (had) this.ctx.requestRender();
    return had;
  }

  // ---- gestures --------------------------------------------------------------------------------

  onGestureStart(g) {
    const store = this.ctx.store();
    if (!store) return;
    let index = null;
    try {
      index = eraserIndex(store.project, store.derived);
    } catch (err) {
      console.error('[eraser] index failed', err);
    }
    this.active = {
      index, project: store.project,
      touched: { wallIds: new Set(), dividerIds: new Set(), openingIds: new Set(), fixtureIds: new Set(), memoIds: new Set() },
      prev: null, done: 0, last: null, plan: null, drawCache: {},
    };
    this._rub(g);
    this.ctx.requestRender();
  }

  onGestureMove(g) {
    if (!this.active) return;
    this._rub(g);
    this.ctx.requestRender();
  }

  onGestureEnd(g) {
    const a = this.active;
    if (!a) return;
    this._rub(g);
    this.active = null;
    const store = this.ctx.store();
    const plan = a.plan;
    // Nothing touched (or the plan changed under the pen, e.g. Ctrl+Z): no change, no undo step.
    if (!store || store.project !== a.project || !plan || plan.empty) {
      this.ctx.requestRender();
      return;
    }
    let ok = false;
    this.ctx.command(() => { ok = store.eraseItems(plan); }, '지우개', { report: false });
    if (ok) this.ctx.toast(eraseToastText(plan, store), { type: 'ok', ms: 5000 });
    this.ctx.requestRender();
  }

  onGestureCancel() {
    this.cancel();
  }

  // Test every new point of the gesture (every SAMPLE_PX px along the path) and update the plan.
  _rub(g) {
    const a = this.active;
    if (!a || !a.index || !g || !g.points) return;
    const sizes = eraserSizes(this.ctx.view.scale);
    let changed = !a.plan;
    for (; a.done < g.points.length; a.done++) {
      const q = g.points[a.done];
      for (const p of samplePath(a.last, q, sizes.step, a.last != null)) {
        const h = eraserTouch(a.index, p, sizes, a.prev);
        a.prev = h;
        const before = touchCount(a.touched);
        addTouch(a.touched, h);
        if (touchCount(a.touched) !== before) changed = true;
      }
      a.last = q;
    }
    if (changed) a.plan = erasePlan(a.project, a.touched);
  }

  // ---- drawing ---------------------------------------------------------------------------------

  // The red preview of what will be erased and the eraser ring (call last, over the plan).
  // opts: { toPx, pxPerMM } (screen)
  drawOverlay(ctx2d, opts) {
    const a = this.active;
    if (!a) return;
    const store = this.ctx.store();
    if (!store || store.project !== a.project) return;
    ctx2d.save();
    try {
      if (a.plan && !a.plan.empty) drawErasePreview(ctx2d, store.project, store.derived, a.plan, opts, a.drawCache);
    } catch (err) {
      console.error('[eraser] preview failed', err);
    }
    if (a.last) {
      // The ring shows the reach for thin lines (door arcs, 구역 나누기 lines); the dot is what touches
      // walls, windows / doors and fixtures.
      const c = opts.toPx(a.last);
      ctx2d.strokeStyle = ERASE_STYLE.ring;
      ctx2d.lineWidth = 1.5;
      ctx2d.setLineDash([4, 3]);
      ctx2d.beginPath();
      ctx2d.arc(c.x, c.y, LINE_REACH_PX, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.fillStyle = ERASE_STYLE.ring;
      ctx2d.beginPath();
      ctx2d.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
      ctx2d.fill();
    }
    ctx2d.restore();
  }
}

function touchCount(t) {
  return t.wallIds.size + t.dividerIds.size + t.openingIds.size + t.fixtureIds.size + t.memoIds.size;
}

// '벽 2줄, 창 1개를 지웠습니다. 잘못 지웠으면 ↶를 누르세요.' (after store.eraseItems(plan)); when values
// went with the walls (their own values, user 2026-10-25: no value waits for the wall to be drawn
// again), '… 길이 값 3개도 함께 지웠습니다. …'.
export function eraseToastText(plan, store) {
  const c = plan.counts || {};
  const parts = [];
  if (c.walls) parts.push(`벽 ${c.walls}줄`);
  if (c.dividers) parts.push(`구역 나누기 선 ${c.dividers}줄`);
  if (c.windows) parts.push(`창 ${c.windows}개`);
  if (c.doors) parts.push(`문 ${c.doors}개`);
  if (c.fixtures) parts.push(`설비 ${c.fixtures}개`);
  if (c.memo) parts.push('메모');
  if (!parts.length) parts.push('선택한 것');
  const last = parts[parts.length - 1];
  const particle = last.endsWith('줄') ? '을' : '를';
  let msg = `${parts.join(', ')}${particle} 지웠습니다.`;
  const dropped = ((store && store.lastDropped) || []).length;
  const waiting = ((store && store.lastDetached) || []).length;
  // Only 구역 나누기 lines erased: their values are a line's, not a wall's (review 2026-10-25).
  const what = !c.walls && c.dividers ? '선' : '벽';
  if (dropped) msg += ` 지운 ${what}의 길이 값 ${dropped}개도 지웠습니다.`;
  if (waiting) msg += ` ${waitingValuesText(waiting, what)}`;
  return `${msg} 잘못 지웠으면 ↶를 누르세요.`;
}

// The wall geometry the preview needs, once per gesture (the plan does not change while rubbing).
function previewGeometry(project, derived) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const items = [];
  const byNode = new Map();
  for (const e of project.edges || []) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const it = { edge: e, a, b, t: edgeThickness(e, derived) };
    items.push(it);
    for (const id of [e.a, e.b]) {
      if (!byNode.has(id)) byNode.set(id, []);
      byNode.get(id).push(it);
    }
  }
  let finishes = [];
  try { finishes = derived ? finishPolygons(project, derived) : []; } catch (_) { finishes = []; }
  return { items, byNode, finishes };
}

// Everything in `plan` (erasePlan) drawn red over the plan (screen). cache: an object kept for the
// gesture (the wall geometry is computed into it once).
export function drawErasePreview(ctx, project, derived, plan, opts, cache = {}) {
  const ids = new Set(plan.edgeIds || []);
  const toPx = opts.toPx;
  const pxPerMM = opts.pxPerMM || 1;
  const path = (pts) => {
    const s0 = toPx(pts[0]);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const s = toPx(pts[i]);
      ctx.lineTo(s.x, s.y);
    }
    ctx.closePath();
  };
  // Walls: the same outlines as the walls on screen (render.js), and their finish layers.
  if (!cache.geo || cache.project !== project) {
    cache.geo = previewGeometry(project, derived);
    cache.project = project;
  }
  const { items, byNode, finishes } = cache.geo;
  const erased = items.filter((it) => it.edge.kind !== 'divider' && ids.has(it.edge.id));
  ctx.fillStyle = ERASE_STYLE.wall;
  ctx.beginPath();
  for (const it of erased) {
    const poly = wallOutline(it, byNode);
    if (poly) path(poly);
  }
  for (const f of finishes) if (f.edgeIds.length && f.edgeIds.every((id) => ids.has(id))) path(f.points);
  ctx.fill('nonzero');
  // At a corner or T the ink is shared: inside each erased wall's outline, the walls that stay are painted
  // black again as they will be drawn without the erased ones (a T's bar stays whole, an L's corner square
  // goes with the wall that leaves it).
  const keptByNode = new Map();
  for (const [id, list] of byNode) keptByNode.set(id, list.filter((it) => !ids.has(it.edge.id)));
  for (const it of erased) {
    const poly = wallOutline(it, byNode);
    const kept = new Set([...(keptByNode.get(it.edge.a) || []), ...(keptByNode.get(it.edge.b) || [])]);
    if (!poly || !kept.size) continue;
    ctx.save();
    ctx.beginPath();
    path(poly);
    ctx.clip();
    ctx.fillStyle = COLORS.wall;
    ctx.beginPath();
    for (const k of kept) {
      if (k.edge.kind === 'divider') continue;
      const kp = wallOutline(k, keptByNode);
      if (kp) path(kp);
    }
    ctx.fill('nonzero');
    ctx.restore();
  }
  // A fixture standing IN an erased wall (벽 속에 넣기) is not erased: it stays where it is, free-standing,
  // so it is drawn again over the red wall as it will be drawn then.
  const keptFix = new Set(plan.fixtureIds || []);
  const inWall = (project.fixtures || []).filter((f) => f && f.inWall && ids.has(f.wall) && !keptFix.has(f.id));
  if (inWall.length) {
    drawFixtures(ctx, { ...project, fixtures: inWall.map((f) => ({ ...f, wall: null })) }, derived, { ...opts, options: { drawingOnly: true } });
  }
  // 구역 나누기 lines.
  ctx.strokeStyle = ERASE_STYLE.line;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const it of items) {
    if (it.edge.kind !== 'divider' || !ids.has(it.edge.id)) continue;
    const a = toPx(it.a), b = toPx(it.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  // Windows / doors: their cut in the wall band, a door's leaf and swing arc.
  const pad = 2 / pxPerMM;
  const openIds = new Set(plan.openingIds || []);
  for (const o of project.openings || []) {
    if (!openIds.has(o.id)) continue;
    const pl = placeOpening(project, derived, o);
    if (!pl) continue;
    const fr = pl.frame;
    const thick = fr.thick > 0 ? fr.thick : 100;
    let fin = { left: 0, right: 0 };
    try { fin = finishBeside(project, derived, o.edge) || fin; } catch (_) { /* none */ }
    const P = (s, q) => ({ x: fr.A.x + fr.dir.x * s + fr.left.x * q, y: fr.A.y + fr.dir.y * s + fr.left.y * q });
    const up = thick / 2 + fin.left + pad, down = -(thick / 2 + fin.right + pad);
    ctx.beginPath();
    path([P(pl.s0 - pad, up), P(pl.s1 + pad, up), P(pl.s1 + pad, down), P(pl.s0 - pad, down)]);
    ctx.fillStyle = ERASE_STYLE.item;
    ctx.fill();
    ctx.strokeStyle = ERASE_STYLE.line;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    if (o.kind === 'door' && !slidingLeaves(o)) {
      const sw = o.swing || { side: 'left', hinge: 'start' };
      const sgn = sw.side === 'right' ? -1 : 1;
      const sh = sw.hinge === 'end' ? pl.s1 : pl.s0;
      const so = sw.hinge === 'end' ? pl.s0 : pl.s1;
      const hb = thick / 4;
      const r = Math.abs(so - sh);
      const towards = so > sh ? 1 : -1;
      const H = P(sh, sgn * hb);
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const ang = (Math.PI / 2) * (i / 24);
        const ax = Math.cos(ang) * r * towards, ay = Math.sin(ang) * r * sgn;
        const s = toPx({ x: H.x + fr.dir.x * ax + fr.left.x * ay, y: H.y + fr.dir.y * ax + fr.left.y * ay });
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
      const h0 = toPx(H), h1 = toPx(P(sh, sgn * (hb + r)));
      ctx.moveTo(h0.x, h0.y);
      ctx.lineTo(h1.x, h1.y);
      ctx.stroke();
    }
  }
  // Fixtures.
  const fixIds = new Set(plan.fixtureIds || []);
  for (const raw of project.fixtures || []) {
    if (!raw || !fixIds.has(raw.id)) continue;
    const f = normalizeFixture(raw);
    if (!f) continue;
    ctx.beginPath();
    path(fixturePolygon(f));
    ctx.fillStyle = ERASE_STYLE.item;
    ctx.fill();
    ctx.strokeStyle = ERASE_STYLE.line;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  // Memo strokes: drawn again in red, a little wider.
  const memoIds = new Set(plan.memoIds || []);
  if (memoIds.size) {
    ctx.strokeStyle = ERASE_STYLE.line;
    ctx.fillStyle = ERASE_STYLE.line;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of validMemo(project.memo)) {
      if (!memoIds.has(s.id)) continue;
      const w = Math.max(3, memoLinePx(s, { pxPerMM, worldPerPaperMM: 60 }) + 1.5);
      const pts = s.points.map((p) => toPx(p));
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = w;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }
}
