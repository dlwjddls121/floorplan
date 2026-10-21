// Handwritten memo layer (메모, plan §2-6): pen/finger strokes kept apart from the drawing.
//
//   project.memo = [{ id, points: [{ x, y }] (world mm), paperWidth: paper mm, width: mm, color }]
//   project.memoHidden = true            optional: [메모 숨기기] of this household (absent = shown)
//
// Line width: `paperWidth` is the printed width in paper mm (MEMO_PAPER_MM), the same whatever the
// zoom was while writing; the screen draws it as at 1:60 (WORLD_PER_PAPER_MM world mm per paper mm,
// the scale labelOffsets use too). `width` = paperWidth × 60 in world mm is kept for older apps and
// the eraser's reach. Older strokes without paperWidth are drawn with MEMO_PAPER_MM as well (their
// `width` depended on the zoom when they were written).
//
// Strokes are stored as smoothed polylines rounded to 0.1 mm, so files stay small. A single tap
// is stored as a one-point stroke and drawn as a dot. Pure functions + a DocStore mixin.
//
// The memo follows the plan (review 예시 세대 A #18): the team writes it while drawing, before any value, and
// the values then rescale the sketch (the first one alone by 0.54 – 0.99), which left notes in other
// rooms or outside the house. The strokes written close together one after another (a word, a number
// with its arrow) move as one group: the group's centre keeps its relative place in the follow box of
// the room it is in, else in the box of the plan's corners, and the group is scaled about that centre
// by the box's mean scale, so the writing keeps its shape and stays in proportion to the room.
// Each stroke keeps that as its placement anchor (review 예시 세대 A round 2; fixtures.js "placement anchors"):
//   stroke.pin = { roomId (null = the plan), u, v (the group centre in that box), w, h (the box's size
//                  when the anchor was taken: the writing's own size there) }
// taken at the first re-derive after the stroke was written, in the plan as it was then; a stroke
// written onto a word that has one shares it. Every re-derive (memoDeriveHook) then places the stroke
// from its anchor in the NEW plan, so where the memo ends depends only on the final plan, not on the
// order the values were typed in. When an edit changes the room itself (a wall drawn through it), the
// incremental follower (fixtures.js planFollower) moves the group once and the anchor is taken again.
// 도면 돌리기 turns the strokes and their anchors itself (core/rotate.js).
import { douglasPeucker, projectPointToSegment, dist } from './geom.js';
import { nextId } from './graph.js';
import { planFollower, anchorFrameAt, anchorBox, anchorStable } from './fixtures.js';

export const MEMO_COLOR = '#A3201B';          // dark red, like a red ballpoint pen
export const MEMO_MAX_POINTS = 2000;           // per stroke, after smoothing
export const MEMO_PAPER_MM = 0.4;              // printed line width (paper mm)
export const WORLD_PER_PAPER_MM = 60;          // screen convention: 1:60

const isNum = (v) => typeof v === 'number' && isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

// Printed width of a stroke in paper mm.
export function memoPaperWidth(stroke) {
  const w = stroke && stroke.paperWidth;
  return isNum(w) && w > 0 ? Math.min(5, w) : MEMO_PAPER_MM;
}

// Whether this household's memo is hidden on screen ([메모 숨기기], saved with the household).
export function isMemoHidden(project) {
  return !!(project && project.memoHidden === true);
}

// Raw pointer samples → smoothed polyline.
//   tolerance: mm. Samples closer than this are merged; Douglas-Peucker uses half of it. Pass about
//   one screen pixel in mm (1 / view.scale).
// Keeps the first and last point; two passes of Chaikin corner cutting round the corners.
export function smoothStroke(points, { tolerance = 5, chaikin = 2 } = {}) {
  const pts = (points || []).filter((p) => p && isNum(p.x) && isNum(p.y));
  if (!pts.length) return [];
  // 1. Drop jitter: samples closer than the tolerance to the last kept one.
  const kept = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(pts[i], kept[kept.length - 1]) >= tolerance) kept.push(pts[i]);
  }
  const last = pts[pts.length - 1];
  if (dist(last, kept[kept.length - 1]) > 0) kept.push(last);   // always end where the pen lifted
  if (kept.length < 3) return kept.map((p) => ({ x: round1(p.x), y: round1(p.y) }));
  // 2. Simplify, then 3. round the corners (Chaikin), keeping both ends.
  let line = douglasPeucker(kept, tolerance * 0.5);
  for (let k = 0; k < chaikin && line.length > 2; k++) {
    const out = [line[0]];
    for (let i = 0; i < line.length - 1; i++) {
      const p = line[i], q = line[i + 1];
      out.push({ x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y });
      out.push({ x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y });
    }
    out.push(line[line.length - 1]);
    line = out;
  }
  if (line.length > MEMO_MAX_POINTS) {
    const step = line.length / MEMO_MAX_POINTS;
    const thin = [];
    for (let i = 0; i < MEMO_MAX_POINTS - 1; i++) thin.push(line[Math.floor(i * step)]);
    thin.push(line[line.length - 1]);
    line = thin;
  }
  return line.map((p) => ({ x: round1(p.x), y: round1(p.y) }));
}

// Distance from a point to a stroke's polyline (mm).
export function distanceToStroke(stroke, p) {
  const pts = (stroke && stroke.points) || [];
  if (!pts.length) return Infinity;
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = projectPointToSegment(p, pts[i], pts[i + 1]).dist;
    if (d < best) best = d;
  }
  return best;
}

// Topmost stroke within radiusMM of the point (counting the stroke's own half width). → id | null
export function memoStrokeAt(project, p, radiusMM) {
  const list = (project && project.memo) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (distanceToStroke(s, p) <= radiusMM + halfWidth(s)) return s.id;
  }
  return null;
}

// Half the stroke's width in world mm (as drawn on screen at 1:60).
function halfWidth(s) {
  return (memoPaperWidth(s) * WORLD_PER_PAPER_MM) / 2;
}

// Every stroke touched by the eraser path (a polyline in world mm) within radiusMM. → [id]
export function memoStrokesAlong(project, path, radiusMM) {
  const list = (project && project.memo) || [];
  const hit = [];
  const samples = densify(path || [], Math.max(1, radiusMM / 2));
  for (const s of list) {
    const w = halfWidth(s);
    if (samples.some((p) => distanceToStroke(s, p) <= radiusMM + w)) hit.push(s.id);
  }
  return hit;
}

function densify(path, step) {
  if (path.length < 2) return path.slice();
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const n = Math.ceil(dist(a, b) / step);
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return out;
}

// Valid strokes only (hand-edited files must never break drawing).
export function validMemo(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && Array.isArray(s.points) && s.points.length
    && s.points.every((p) => p && isNum(p.x) && isNum(p.y)));
}

// ---- following the plan ----------------------------------------------------------------------------

// Two strokes in a row belong to one group (one word, a number and its arrow) when the gap between
// their boxes is at most this share of the larger stroke, or MEMO_JOIN_MIN_MM (a dot after a word).
const MEMO_JOIN_SHARE = 0.6;
const MEMO_JOIN_MIN_MM = 60;   // 1 paper mm at 1:60
const MEMO_SCALE_RANGE = [0.25, 4];

function strokeBox(s) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points || []) {
    if (!p || !isNum(p.x) || !isNum(p.y)) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// Strokes in writing order cut into groups of strokes written close together one after another.
// → [{ strokes: [index], box }]
export function memoGroups(list) {
  const groups = [];
  let cur = null, lastBox = null;
  (list || []).forEach((s, i) => {
    const b = s && Array.isArray(s.points) ? strokeBox(s) : null;
    if (!b) return;
    const size = (q) => Math.max(q.maxX - q.minX, q.maxY - q.minY);
    if (cur && lastBox) {
      const gap = Math.max(0, cur.box.minX - b.maxX, b.minX - cur.box.maxX, cur.box.minY - b.maxY, b.minY - cur.box.maxY);
      if (gap <= Math.max(MEMO_JOIN_MIN_MM, MEMO_JOIN_SHARE * Math.max(size(b), size(lastBox)))) {
        cur.strokes.push(i);
        cur.box = {
          minX: Math.min(cur.box.minX, b.minX), minY: Math.min(cur.box.minY, b.minY),
          maxX: Math.max(cur.box.maxX, b.maxX), maxY: Math.max(cur.box.maxY, b.maxY),
        };
        lastBox = b;
        return;
      }
    }
    cur = { strokes: [i], box: { ...b } };
    groups.push(cur);
    lastBox = b;
  });
  return groups;
}

const clampScale = (k) => Math.min(MEMO_SCALE_RANGE[1], Math.max(MEMO_SCALE_RANGE[0], isNum(k) && k > 0 ? k : 1));

// A stroke's anchor from a file or a record, checked. → pin | null
function cleanMemoPin(p) {
  if (!p || typeof p !== 'object') return null;
  if (!(p.roomId === null || (typeof p.roomId === 'string' && p.roomId))) return null;
  if (![p.u, p.v, p.w, p.h].every(isNum) || !(p.w > 1 && p.h > 1)) return null;
  return { roomId: p.roomId, u: p.u, v: p.v, w: p.w, h: p.h };
}

// The anchor of writing centred at c in this plan. → pin | null (nothing drawn)
function memoPinAt(project, derived, c) {
  const fr = anchorFrameAt(project, derived, c);
  if (!fr) return null;
  const bw = fr.box.maxX - fr.box.minX, bh = fr.box.maxY - fr.box.minY;
  if (!(bw > 1 && bh > 1)) return null;
  return { roomId: fr.roomId, u: (c.x - fr.box.minX) / bw, v: (c.y - fr.box.minY) / bh, w: bw, h: bh };
}

// Where an anchor puts its writing in a plan whose frame box is b (fixtures.js anchorBox): the centre
// and the scale (against the writing as it was when the anchor was taken). → { c, k } | null
function pinFrame(pin, b) {
  if (!b) return null;
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  if (!(bw > 1 && bh > 1)) return null;
  return { c: { x: b.minX + pin.u * bw, y: b.minY + pin.v * bh }, k: clampScale(Math.sqrt((bw * bh) / (pin.w * pin.h))) };
}

// The anchor of every stroke in this plan: its own; else that of the stroke before it in its group (a
// stroke added to a word), else of the first anchored one in the group; a group without any gets one at
// its centre. → [{ pin, fresh } | null] (fresh: not stored yet)
function memoPins(list, project, derived) {
  const res = new Array(list.length).fill(null);
  for (const g of memoGroups(list)) {
    let last = null;
    const pending = [];
    for (const i of g.strokes) {
      const own = cleanMemoPin(list[i] && list[i].pin);
      if (own) { res[i] = { pin: own, fresh: false }; last = own; continue; }
      if (last) { res[i] = { pin: last, fresh: true }; continue; }
      pending.push(i);
    }
    if (!pending.length) continue;
    const first = g.strokes.map((i) => res[i]).find((r) => r && !r.fresh);
    const pin = first ? first.pin
      : memoPinAt(project, derived, { x: (g.box.minX + g.box.maxX) / 2, y: (g.box.minY + g.box.maxY) / 2 });
    if (pin) for (const i of pending) res[i] = { pin, fresh: true };
  }
  return res;
}

// The memo moved with the plan from (prevProject, prevDerived) to (nextProject, nextDerived): see the
// header. → the memo list (the same array when nothing moved)
export function followMemo(memo, prevProject, prevDerived, nextProject, nextDerived) {
  const list = Array.isArray(memo) ? memo : [];
  if (!list.length) return memo;
  const follow = planFollower(prevProject, prevDerived, nextProject, nextDerived);
  if (!follow) return memo;
  const out = list.slice();
  let changed = false;
  const pins = memoPins(list, prevProject, prevDerived);
  // Each frame (room, or the plan) once: is it the same room, and its box before and after.
  const frames = new Map();
  const frameOf = (roomId) => {
    const k = roomId == null ? '' : roomId;
    if (!frames.has(k)) {
      const stable = anchorStable(roomId, prevProject, prevDerived, nextProject, nextDerived);
      frames.set(k, stable ? { b0: anchorBox(prevProject, prevDerived, roomId), b1: anchorBox(nextProject, nextDerived, roomId) } : null);
    }
    return frames.get(k);
  };
  const fallback = new Set();
  list.forEach((s, i) => {
    if (!s || !Array.isArray(s.points)) return;
    const pp = pins[i];
    const fr = pp ? frameOf(pp.pin.roomId) : null;
    if (fr) {
      // From the anchor: the stroke as it stood in the plan before (centre c0, scale k0) → the new plan.
      const f0 = pinFrame(pp.pin, fr.b0), f1 = pinFrame(pp.pin, fr.b1);
      if (f0 && f1) {
        const r = f1.k / f0.k;
        if (Math.abs(f1.c.x - f0.c.x) < 1e-6 && Math.abs(f1.c.y - f0.c.y) < 1e-6 && Math.abs(r - 1) < 1e-9) return;
        out[i] = { ...s, pin: pp.pin, points: s.points.map((p) => ({ ...p, x: round1(f1.c.x + (p.x - f0.c.x) * r), y: round1(f1.c.y + (p.y - f0.c.y) * r) })) };
        changed = true;
        return;
      }
    }
    fallback.add(i);
  });
  if (!fallback.size) return changed ? out : memo;
  // The edit changed the room (or the plan's corners), or there is no plan to anchor in: the group moves
  // once with the incremental follower, and its anchor no longer applies.
  for (const g of memoGroups(list.map((s, i) => (fallback.has(i) ? s : null)))) {
    const c = { x: (g.box.minX + g.box.maxX) / 2, y: (g.box.minY + g.box.maxY) / 2 };
    const m = follow.at(c);
    const c1 = m ? m.map(c) : c;
    const k = m ? clampScale(m.s) : 1;
    const still = Math.abs(c1.x - c.x) < 0.05 && Math.abs(c1.y - c.y) < 0.05 && Math.abs(k - 1) < 1e-6;
    for (const i of g.strokes) {
      const s = list[i];
      if (still && s.pin == null) continue;
      const next = still ? { ...s } : { ...s, points: s.points.map((p) => ({ ...p, x: round1(c1.x + (p.x - c.x) * k), y: round1(c1.y + (p.y - c.y) * k) })) };
      delete next.pin;
      out[i] = next;
      changed = true;
    }
  }
  return changed ? out : memo;
}

// DocStore derive hook (installMemo registers it): the memo follows every re-derive that moved the
// plan. A fresh re-derive (도면 돌리기, no prevDerived) has turned the strokes already.
export function memoDeriveHook(prevProject, nextProject, nextDerived, prevDerived = null) {
  if (!prevDerived || !nextProject || !(nextProject.memo || []).length) return nextProject;
  const memo = followMemo(nextProject.memo, prevProject, prevDerived, nextProject, nextDerived);
  return memo === nextProject.memo ? nextProject : { ...nextProject, memo };
}

// ---- store mixin ---------------------------------------------------------------------------------

// Adds addMemoStroke, deleteMemoStroke, clearMemo to DocStore.prototype (one undo step each, no
// re-derive: memos do not affect the plan). If DocStore.deriveHooks (an array) exists, memoDeriveHook
// is registered there (once), so the memo follows the plan.
export function installMemo(DocStore) {
  const proto = DocStore.prototype;
  if (Array.isArray(DocStore.deriveHooks) && !DocStore.deriveHooks.includes(memoDeriveHook)) {
    DocStore.deriveHooks.push(memoDeriveHook);
  }

  // points: world mm (raw samples, or already smoothed with opts.smooth = false).
  // opts: { paperWidth (paper mm, default MEMO_PAPER_MM), color, tolerance (mm, for smoothing),
  //         smooth = true } → stroke id | null. The width never depends on the zoom.
  proto.addMemoStroke = function addMemoStroke(points, opts = {}) {
    const pts = opts.smooth === false
      ? (points || []).filter((p) => p && isNum(p.x) && isNum(p.y)).map((p) => ({ x: round1(p.x), y: round1(p.y) }))
      : smoothStroke(points, { tolerance: opts.tolerance > 0 ? opts.tolerance : 5 });
    if (!pts.length) return null;
    const paperWidth = Math.round(memoPaperWidth({ paperWidth: opts.paperWidth }) * 100) / 100;
    const width = round1(paperWidth * WORLD_PER_PAPER_MM);
    const color = typeof opts.color === 'string' && opts.color ? opts.color : MEMO_COLOR;
    let id = null;
    const detail = { memoId: null };
    this._commit('addMemoStroke', (p) => {
      id = nextId('s', p.memo || []);
      detail.memoId = id;
      return { ...p, memo: [...(p.memo || []), { id, points: pts, paperWidth, width, color }] };
    }, { rederive: false, detail });
    return id;
  };

  // [메모 숨기기] / [메모 보이기] of this household. A view setting, so it is not an undo step and
  // undo / redo never flip it (every snapshot gets it); it is saved with the
  // household (the change notification starts the autosave) without counting as an edit
  // (modifiedAt unchanged). → true when it changed
  proto.setMemoHidden = function setMemoHidden(hidden) {
    const on = !!hidden;
    if (isMemoHidden(this.project) === on) return false;
    const patch = (state) => {
      if (!state || !state.project) return state;
      const project = { ...state.project };
      if (on) project.memoHidden = true; else delete project.memoHidden;
      return { ...state, project };
    };
    this._undo = this._undo.map(patch);
    this._redo = this._redo.map(patch);
    this._state = patch(this._state);
    this._notify({ type: 'memoHidden', hidden: on });
    return true;
  };

  // id or [ids] (an eraser gesture removes all touched strokes as one undo step). → bool
  proto.deleteMemoStroke = function deleteMemoStroke(ids) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    return this._commit('deleteMemoStroke', (p) => {
      const memo = (p.memo || []).filter((s) => !set.has(s.id));
      return memo.length === (p.memo || []).length ? null : { ...p, memo };
    }, { rederive: false, detail: { memoIds: [...set] } });
  };

  proto.clearMemo = function clearMemo() {
    return this._commit('clearMemo', (p) => ((p.memo || []).length ? { ...p, memo: [] } : null), { rederive: false });
  };
}
