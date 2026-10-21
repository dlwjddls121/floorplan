// [↻ 회전] (도면 돌리기): the whole plan turned a quarter turn (user 2026-10-18: "그리고 보면 세로로 길게
// 나올 때가 많다. 다 그리고 나서 가로로 길게 돌리고 싶다").
//
//   rotateProject(project, dir = 1, opts) → the turned project | null (nothing drawn)
//     dir  1: clockwise on the screen (y points down): (x, y) → (cx − (y − cy), cy + (x − cx))
//     dir −1: counter-clockwise
//   rotationOf(project, dir = 1, { centre } = {}) → { point(p), vector(x, y), centre, project } | null
//     (the transform and the turn); centre: turn about this point instead of the project's own
//     turnCentre (the history is turned about the CURRENT plan's centre, see below). A project without
//     corners turns only about a given centre (null otherwise): a state from before the first wall
//     may hold a memo or fixtures already.
//   turnCentre(project) → { x, y } | null: the whole-mm middle of the corners' extent
//   scaleLabelOffsets(project, k) → project with every hand-moved offset but the title's times k
//   installRotate(DocStore)  adds store.rotatePlan(dir = 1) → bool and store.stepKey(derived)
//     DocStore.rotateFollowers: [(before, after, dir, turn) → project | null] run right after the turn of
//     a state (ui/wiring.js: 확인 완료 marks follow their items; moved texts keep their place on the plan
//     when the turn changes the automatic print scale). turn: the rotationOf result used.
//
// A turn is NOT an undo step (user 2026-10-21: "되돌리기, 다시실행 눌러도 회전되버려 오류야"): ↶ / ↷ never
// change the plan's orientation; four presses of [↻ 회전] give the original back. Every snapshot of the
// undo and redo history is turned with the plan instead (the same centre and direction, the same
// followers), so ↶ undoes the last real edit in the turned orientation and ↷ redoes it; the redo list is
// kept (a turn is not a new edit). The history is turned lazily: a snapshot keeps the turns still to
// apply (`turns: [{ dir, centre }]`), and undo / redo turn it when they reach it (model.js _settled), so
// a turn with 100 steps of history costs one re-derive. The document still changes (modifiedAt, save).
//
// The plan itself turns (not only the print), so the dimension numbers, room names and labels stay
// upright and everything downstream (the dimension chains, the A4 layout, the checks) simply follows.
// The centre is the middle of the corners' extent, so the plan stays where it was on the screen; the
// next turn keeps the same centre while the extent's middle is within 1 mm of it (a whole-mm centre
// moves by 1 mm when the extent is odd, and four turns then did not come back).
// What is turned: corner positions, each wall's sketch vector and h/v orientation, room seeds, the
// anchors of the measures (attached and kept), kept room outlines, fixtures (centre, rotation; the
// relative place `along` a wall flips where the wall's low end becomes its high end), memo strokes,
// texts moved by hand (their offsets; not the title's, which belongs to the page), dimension rows put on
// a side by hand (top → right → bottom → left), the axis of resolved 치수 폐합 checks (x ↔ y), and the
// placement anchors of free fixtures, memo strokes and moved room names (`pin`: a place (u, v) in a
// box, which turns with the box). ui/wiring.js then writes a moved room name's offset again from its
// turned world spot (labels.js turnMovedRoomLabels).
// What does not change: measures (they name corners), windows and doors (a place along their wall,
// and a turn keeps left and right), wall thicknesses, room names and heights.
// The store re-derives with the old room outlines turned with the plan (model.js _deriveMoved), so rooms
// are matched to their turned faces (and with the state's 'fold' warnings and wall thicknesses, so a
// value that pressed two walls together is still the fold it was, not an 'overlap'); the fixtures hook and the opening reconcile compare against the
// turned project, so nothing "follows" the old positions; and the solved plan is held where the turn put
// its corners (the solve's gauge would shift it by a few tenths of a mm).

const isNum = (v) => typeof v === 'number' && isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

const SIDE_CW = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };
const SIDE_CCW = { top: 'left', left: 'bottom', bottom: 'right', right: 'top' };

export function rotateProject(project, dir = 1, opts = {}) {
  const r = rotationOf(project, dir, opts);
  return r ? r.project : null;
}

// The middle of the corners' extent (unrounded). → { x, y } | null
function extentMiddle(project) {
  if (!project || !Array.isArray(project.nodes) || !project.nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of project.nodes) {
    if (!isNum(n.x) || !isNum(n.y)) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  return isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

// A whole-mm centre keeps whole-mm corners whole.
export function turnCentre(project) {
  const m = extentMiddle(project);
  return m ? { x: Math.round(m.x), y: Math.round(m.y) } : null;
}

// The centre of the next turn: the last turn's centre while the extent's middle is still within 1 mm of
// it (a turn about a whole-mm centre keeps the middle within 0.5 mm of it on each axis, so a run of
// turns keeps one centre and four of them are exactly the original), else turnCentre. → { x, y } | null
function steadyCentre(project, last) {
  const m = extentMiddle(project);
  if (!m) return null;
  if (last && isNum(last.x) && isNum(last.y) && Math.abs(m.x - last.x) <= 1 && Math.abs(m.y - last.y) <= 1) return { x: last.x, y: last.y };
  return { x: Math.round(m.x), y: Math.round(m.y) };
}

export function rotationOf(project, dir = 1, opts = {}) {
  if (!project || !Array.isArray(project.nodes)) return null;
  const s = dir === -1 ? -1 : 1;
  const given = opts && opts.centre;
  // Without corners only about a given centre: a state of the history from before the first wall can
  // hold a memo or fixtures already (the memo and 설비 tools work on an empty plan), which turn with the
  // plan about its centre like everything else (checker 2026-10-21: ↶ back to that state put the memo
  // at its unturned place, ↷ then moved it back).
  const c = given && isNum(given.x) && isNum(given.y) ? given : turnCentre(project);
  if (!c) return null;
  const cx = c.x, cy = c.y;
  // Vectors (directions, normals, offsets) and points.
  const vec = (x, y) => (s === 1 ? { x: -y, y: x } : { x: y, y: -x });
  const pt = (p) => {
    const v = vec(p.x - cx, p.y - cy);
    return { x: r2(cx + v.x), y: r2(cy + v.y) };
  };
  const ptObj = (p) => (p && isNum(p.x) && isNum(p.y) ? { ...p, ...pt(p) } : p);
  const anchor = (at) => {
    if (!at || !isNum(at.ax) || !isNum(at.bx) || !isNum(at.nx)) return at;
    const a = pt({ x: at.ax, y: at.ay }), b = pt({ x: at.bx, y: at.by }), n = vec(at.nx, at.ny);
    return { ...at, ax: a.x, ay: a.y, bx: b.x, by: b.y, nx: r2(n.x), ny: r2(n.y) };
  };

  const edgesById = new Map((project.edges || []).map((e) => [e.id, e]));
  const out = { ...project };
  out.nodes = project.nodes.map(ptObj);
  out.edges = (project.edges || []).map((e) => {
    const next = { ...e };
    if (e.orient === 'h') next.orient = 'v';
    else if (e.orient === 'v') next.orient = 'h';
    if (e.sketch && isNum(e.sketch.dx) && isNum(e.sketch.dy)) {
      const v = vec(e.sketch.dx, e.sketch.dy);
      next.sketch = { dx: v.x, dy: v.y };
    }
    return next;
  });
  out.rooms = (project.rooms || []).map((r) => (r && r.seed ? { ...r, seed: pt(r.seed) } : r));
  out.measures = (project.measures || []).map((m) => (m && m.at ? { ...m, at: anchor(m.at) } : m));
  out.detachedMeasures = (project.detachedMeasures || []).map((m) => (m && m.at ? { ...m, at: anchor(m.at) } : m));
  out.detachedRooms = (project.detachedRooms || []).map((r) => (r && Array.isArray(r.polygon) ? { ...r, polygon: r.polygon.map(ptObj) } : r));
  out.fixtures = (project.fixtures || []).map((f) => {
    if (!f || !isNum(f.x) || !isNum(f.y)) return f;
    const c = pt(f);
    const rot = ((Math.round((isNum(f.rot) ? f.rot : 0) / 90) * 90 + s * 90) % 360 + 360) % 360;
    const next = { ...f, x: c.x, y: c.y, rot };
    // `along` counts from the wall's low end (smaller x or y). Clockwise, a vertical wall's low end
    // (top) becomes the high end (right) of the horizontal wall it turns into; counter-clockwise, a
    // horizontal wall's low end (left) becomes the high end (bottom).
    const e = f.wall ? edgesById.get(f.wall) : null;
    if (e && isNum(f.along) && ((s === 1 && e.orient === 'v') || (s === -1 && e.orient === 'h'))) {
      next.along = Math.min(1, Math.max(0, 1 - f.along));
    }
    // The placement anchor of a free fixture (fixtures.js `pin`) turns with it: its place in the turned
    // box, the sides it stood against, and the position / plan size it belongs to (turned exactly like
    // the fixture, so an anchor that belonged to it still does).
    if (f.pin && typeof f.pin === 'object') {
      const p = f.pin;
      if ([p.u, p.v, p.x, p.y, p.ex, p.ey].every(isNum)) {
        const flip = (k) => (k === 'lo' ? 'hi' : k === 'hi' ? 'lo' : k);
        const pc = pt(p);
        next.pin = s === 1
          ? { ...p, u: 1 - p.v, v: p.u, kx: flip(p.ky), ky: p.kx, x: pc.x, y: pc.y, ex: p.ey, ey: p.ex }
          : { ...p, u: p.v, v: 1 - p.u, kx: p.ky, ky: flip(p.kx), x: pc.x, y: pc.y, ex: p.ey, ey: p.ex };
      } else {
        delete next.pin;
      }
    }
    return next;
  });
  // Memo strokes and their anchors (memo.js `pin`: the place of their word in a box, which turns).
  out.memo = (project.memo || []).map((st) => {
    if (!st || !Array.isArray(st.points)) return st;
    const next = { ...st, points: st.points.map(ptObj) };
    if (st.pin && typeof st.pin === 'object') {
      const p = st.pin;
      if ([p.u, p.v, p.w, p.h].every(isNum)) next.pin = { ...p, ...turnUv(p.u, p.v, s), w: p.h, h: p.w };
      else delete next.pin;
    }
    return next;
  });
  const offsets = {};
  for (const [k, v] of Object.entries(project.labelOffsets || {})) {
    if (!v || k === 'title') { offsets[k] = v; continue; }
    const w = vec(Number(v.dx) || 0, Number(v.dy) || 0);
    offsets[k] = { ...v, dx: r2(w.x), dy: r2(w.y) };
    // A moved room name's anchor (labels.js): its spot in the turned room box, for the turned offset.
    const p = v.pin;
    if (p && typeof p === 'object') {
      if ([p.u, p.v].every(isNum) && p.dx === Number(v.dx) && p.dy === Number(v.dy)) {
        offsets[k].pin = { ...turnUv(p.u, p.v, s), dx: offsets[k].dx, dy: offsets[k].dy };
      } else {
        delete offsets[k].pin;
      }
    }
  }
  out.labelOffsets = offsets;
  const sides = s === 1 ? SIDE_CW : SIDE_CCW;
  out.dimOverrides = (project.dimOverrides || []).map((o) => (o && sides[o.side] ? { ...o, side: sides[o.side] } : o));
  out.checks = (project.checks || []).map((c) => {
    if (!c || typeof c.key !== 'string') return c;
    const m = /^closure:(x|y):/.exec(c.key);
    return m ? { ...c, key: `closure:${m[1] === 'x' ? 'y' : 'x'}:${c.key.slice(m[0].length)}` } : c;
  });
  // Recordings of the removed 현장 원본 feature (0.3.0–0.4.1) would no longer match the plan.
  delete out.fieldSketch;
  delete out.fieldOriginal;
  return { point: pt, vector: vec, centre: { x: cx, y: cy }, project: out };
}

// A relative place (u, v) in a box turned a quarter turn with the plan (y down): clockwise the new x
// runs against the old y, counter-clockwise the new y against the old x.
function turnUv(u, v, s) {
  return s === 1 ? { u: 1 - v, v: u } : { u: v, v: 1 - u };
}

export function scaleLabelOffsets(project, k) {
  if (!project || !(k > 0) || Math.abs(k - 1) < 1e-9) return project;
  const offsets = {};
  let changed = false;
  for (const [key, v] of Object.entries(project.labelOffsets || {})) {
    if (!v || key === 'title') { offsets[key] = v; continue; }
    offsets[key] = { ...v, dx: r2((Number(v.dx) || 0) * k), dy: r2((Number(v.dy) || 0) * k) };
    // An anchor that belonged to the offset belongs to the rescaled one (same spot on the plan).
    const p = v.pin;
    if (p && typeof p === 'object') {
      if (p.dx === Number(v.dx) && p.dy === Number(v.dy)) offsets[key].pin = { ...p, dx: offsets[key].dx, dy: offsets[key].dy };
      else delete offsets[key].pin;
    }
    changed = true;
  }
  return changed ? { ...project, labelOffsets: offsets } : project;
}

export function installRotate(DocStore) {
  if (!Array.isArray(DocStore.rotateFollowers)) DocStore.rotateFollowers = [];
  const proto = DocStore.prototype;

  // A state ({ project, derived }) turned about `centre`: re-derived with its old room outlines turned
  // (rooms keep their faces, a room inside another one too), then the followers.
  // → { state: { project, derived }, dropped, detached } | null
  proto._turnedState = function _turnedState(state, d, centre) {
    const turn = rotationOf(state && state.project, d, { centre });
    if (!turn) return null;
    const prevRooms = ((state.derived && state.derived.rooms) || []).filter((r) => r && r.face && Array.isArray(r.face.points));
    const prevSolve = state.derived && state.derived.solve;
    const movedPrev = {
      rooms: prevRooms.map((r) => ({ roomId: r.roomId, face: { points: r.face.points.map(turn.point), nodeIds: (r.face.nodeIds || []).slice() } })),
      // The state's 'fold' warnings and wall thicknesses (model.js foldsOf): a value that pressed two
      // walls into each other stays named after the turn (they name values and walls, which a turn
      // keeps). Without them the fold became an 'overlap' (벽이 겹침) item and a 확인 완료 on it was
      // lost (checker 2026-10-21).
      warnings: ((state.derived && state.derived.warnings) || []).filter((w) => w && w.type === 'fold'),
      solve: prevSolve && prevSolve.thickness instanceof Map ? { thickness: prevSolve.thickness } : undefined,
    };
    const r = this._deriveMoved(turn.project, movedPrev, state.project);
    const before = { project: state.project, derived: state.derived };
    let p = r.project;
    for (const fn of DocStore.rotateFollowers) {
      try {
        const q = fn(before, { project: p, derived: r.derived }, d, turn);
        if (q && q !== p) p = q;
      } catch (err) {
        console.error('[rotate] follower failed', err);
      }
    }
    return { state: { project: p, derived: r.derived }, dropped: r.dropped, detached: r.detached };
  };

  // A snapshot of the history with the turns it still owes (model.js _settled calls this when undo or
  // redo reaches it). → { project, derived }
  proto._applyTurns = function _applyTurns(snapshot) {
    let st = { project: snapshot.project, derived: snapshot.derived };
    for (const t of netTurns(snapshot.turns)) {
      try {
        const r = this._turnedState(st, t.dir, t.centre);
        if (r) st = r.state;
      } catch (err) {
        console.error('[rotate] history turn failed', err);
      }
    }
    if (st.derived !== snapshot.derived) stepKeys(this).set(st.derived, this.stepKey(snapshot.derived));
    return st;
  };

  // The same key for the derived data of one step before and after any turns (main.js keeps view
  // records per step: holdView). → object | null
  proto.stepKey = function stepKey(derived) {
    if (!derived || typeof derived !== 'object') return null;
    const keys = stepKeys(this);
    let k = keys.get(derived);
    if (!k) { k = {}; keys.set(derived, k); }
    return k;
  };

  // → true when the plan turned (false: nothing drawn yet). Not an undo step: the history turns with it.
  proto.rotatePlan = function rotatePlan(dir = 1) {
    const d = dir === -1 ? -1 : 1;
    const centre = steadyCentre(this.project, this._turnCentre);
    if (!centre) return false;
    const res = this._turnedState(this._state, d, centre);
    if (!res) return false;
    const step = { dir: d, centre };
    const owe = (s) => (s && s.project ? { ...s, turns: [...(s.turns || []), step] } : s);
    this._undo = this._undo.map(owe);
    this._redo = this._redo.map(owe);
    this._turnCentre = centre;
    stepKeys(this).set(res.state.derived, this.stepKey(this.derived));
    this._replaceState('rotatePlan', res.state, { dropped: res.dropped, detached: res.detached, detail: { dir: d, centre } });
    return true;
  };
}

// Turns owed by a snapshot, shortened: turns in a row about one centre add up (a quarter turn back
// cancels one forward, four are none, three are one back), so a snapshot owing the four presses that
// brought the plan back is restored as it is. → [{ dir, centre }]
function netTurns(turns) {
  const runs = [];
  for (const t of turns || []) {
    if (!t || !t.centre) continue;
    const last = runs[runs.length - 1];
    if (last && last.centre.x === t.centre.x && last.centre.y === t.centre.y) last.n += t.dir === -1 ? -1 : 1;
    else runs.push({ centre: t.centre, n: t.dir === -1 ? -1 : 1 });
  }
  const out = [];
  for (const r of runs) {
    const k = ((r.n % 4) + 4) % 4;
    if (k === 3) out.push({ dir: -1, centre: r.centre });
    else for (let i = 0; i < k; i++) out.push({ dir: 1, centre: r.centre });
  }
  return out;
}

const STEP_KEYS = new WeakMap(); // store → WeakMap derived → step key
function stepKeys(store) {
  let m = STEP_KEYS.get(store);
  if (!m) { m = new WeakMap(); STEP_KEYS.set(store, m); }
  return m;
}
