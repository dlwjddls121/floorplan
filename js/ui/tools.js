// Tool state machine for the plan canvas (dev/DESIGN.md §5; plan §2-5, §2-6).
//   wall    (벽)       stroke -> store.addStroke(points, { allowDiagonal, snapMM }); a clearly slanted stroke is
//                      a diagonal wall by itself (allowDiagonal 'auto'; Shift still makes every slanted piece
//                      diagonal, not advertised; the old pause at the end no longer does, 2026-10-20)
//   select  (선택)     tap selects; drag a corner moves it; drag a text (room name with its H, a
//                      window/door or fixture label, a dimension number in 치수선 보기) moves the text
//                      (plan §2-7; one undo step; a long press on a moved text offers [위치 되돌리기];
//                      a fixture's label inside the fixture only once the fixture is selected);
//                      drag a window/door or a fixture moves it; drag elsewhere pans the view
//   room    (실 추가)  drag a rectangle -> ask 가로×세로 -> store.addRectRoom(...)
//   divider (구역 나누기) stroke -> store.addDivider(p, q, { snapMM }) (a dashed line, no wall)
//   window / door (창 / 문)  drag a ghost onto a wall, or tap a wall (openings-ui.js OpeningTool)
//   fixture (설비)     type chips + tap/drag to place (fixtures-ui.js FixtureTool, gets every gesture)
//   memo    (메모)     handwriting pen / eraser (memo-ui.js MemoTool, gets every gesture)
//   eraser  (지우개)   rub or tap what should go: a touched wall as its whole straight wall, each touched
//                      window / door / fixture / memo stroke / 구역 나누기 line; red preview while rubbing,
//                      one undo step (eraser-ui.js EraserTool, gets every gesture; no panels, no names)
// In every tool except 설비, 메모 and 지우개 a tap opens the panel of what is under it: a room NAME (the room
// panel with its name field open), a window/door, a fixture, a wall (length panel) or a room (room
// panel), in that order. A window/door counts only on its symbol in the wall band (OpeningTool
// .tapOnSymbol), so a tap just inside the room next to it still opens the wall's length panel (in the
// 창 / 문 tools, and for drags, the wider reach stays). The length panel gets the tap point: the ▶ goes
// to the room on the tapped side (panel.openEdge { at }). A fixture standing against a wall (a sink) does
// not hide that wall either: a tap on the wall band or within WALL_FACE_PX of its face opens the wall's
// length panel, deeper in the fixture's panel (which has [벽 길이 ▶] too). In 설비 and 메모 too, a TAP right on a room
// name opens its name field (the tool gets the gesture only once it moves past the tap distance, so
// drags and strokes that start on a name still place / write as usual).
// InputController reports gestures here; this module never touches pointer events itself.
import { HIT, formatMM } from './theme.js';
import { roundTo } from './panel.js';
import { OpeningTool } from './openings-ui.js';
import { FIXTURE_HINT } from './fixtures-ui.js';
import { MEMO_HINT } from './memo-ui.js';
import { ERASER_HINT } from './eraser-ui.js';
import { wallThickness, finishBeside } from '../core/dims.js';
import { normalizeFixture, fixtureBounds } from '../core/fixtures.js';
import { straightenStroke } from '../core/sketch.js';

export const TOOL_NAMES = ['wall', 'select', 'room', 'divider', 'window', 'door', 'fixture', 'memo', 'eraser'];

export const TOOL_HINTS = {
  wall: '벽: 손가락이나 S펜으로 벽을 그으세요. 비스듬히 그으면 사선 벽이 됩니다.',
  // Kept short (two lines at most on a tablet): the hint floats over the top of the plan.
  select: '선택: 벽·실·창·문·설비를 누르세요(실 이름을 누르면 이름을 바꿀 수 있습니다). 끌면 옮겨지고, 글자도 끌어 옮기며 길게 누르면 되돌립니다.',
  room: '실 추가: 직사각형을 끌어서 그리면 가로×세로를 물어봅니다.',
  divider: '구역 나누기: 벽은 없지만 천장고나 실 이름이 다른 곳(예: 거실·주방 사이)에 선을 그으세요. 점선으로 그려집니다.',
  window: '창: 벽 위로 끌어다 놓으세요. 벽 끝 가까이 놓으면 끝에 붙습니다. 놓은 창을 누르면 재질·종류·규격을 고릅니다.',
  door: '문: 벽 위로 끌어다 놓으세요. 실 안쪽으로 열리게 놓이고, [열림 방향]으로 바꿀 수 있습니다.',
  fixture: FIXTURE_HINT,
  memo: MEMO_HINT,
  eraser: ERASER_HINT,
};

const DRAG_SLOP_PX = 8;
// The tap distance of input.js (a tap is decided by movement only): a gesture that starts on a room
// name in 설비 / 메모 goes to that tool once it moves this far.
const TAP_SLOP_PX = { touch: 12, pen: 8, mouse: 5 };
// A press this long on a moved text (no movement) offers to put it back (선택).
const LONG_PRESS_MS = 600;
// Room name hit boxes: the text itself (+2 px), or a near miss (+10 px) where no wall is.
const NAME_PAD_PX = { exact: 2, near: 10 };
const TAP_LIKE_PX = 20;   // a rejected wall stroke that moved less than this is handled as a tap
// A finger's tap may slide: a short wall stroke with an end in the open needs this much from a finger (the
// engine keeps one from 0.75 × the 18 px snap for the pen; core/graph.js shortStroke).
const SHORT_TOUCH_PX = TAP_LIKE_PX;
// A tap this close past a wall's face (finish included) is a tap on that wall even where a fixture stands
// against it (at most a third of the fixture's depth, so the fixture itself stays tappable).
const WALL_FACE_PX = 6;
const MIN_RECT_MM = 300;
const AXIS_SNAP_DEG = 20;
// While a wall is drawn, the stroke so far is straightened again at most this often (ms) to show the
// diagonal colour and the '사선' pill when it would make a diagonal wall.
const DIAGONAL_PREVIEW_MS = 80;

export class ToolController {
  // ctx: { store(), view, panel, command(fn, label) -> bool, toast(msg, opts), requestRender(),
  //        onToolChange(name),
  //        openOpening(id, { at })  open the window/door panel (OpeningPanel.open; at = the tap point)
  //        openingPrefs             shared OpeningPrefs (the panel uses the same instance)
  //        fixtureTool, memoTool, eraserTool   FixtureTool / MemoTool / EraserTool (optional)
  //        tapExtra(world) -> bool  optional: a tap the editor handles first (e.g. a dimension in 보기)
  //        roomNameAt(world) -> roomId | null   optional: the room whose name text is under the point
  //        labelAt(screen) -> hit | null        optional (선택): the movable text under a screen point,
  //                                             { key, kind, moved, ... } (main.js)
  //        labelMove(hit, dx, dy) -> move | null   the label move for a drag by (dx, dy) screen px
  //        onLabelLongPress(hit)                a long press on a moved text ([위치 되돌리기]) }
  constructor(ctx) {
    this.ctx = ctx;
    this.tool = 'wall';
    this.overlay = null;   // passed to renderOverlay()
    this.active = null;    // per-gesture state
    // While a text is dragged: { key, move } (core/labels.js applyLabelMove); the editor draws the
    // plan as the move would leave it.
    this.labelPreview = null;
    this.openings = new OpeningTool({
      store: ctx.store,
      view: ctx.view,
      command: ctx.command,
      toast: ctx.toast,
      requestRender: ctx.requestRender,
      openPanel: (id, opts) => (ctx.openOpening ? ctx.openOpening(id, opts) : undefined),
      prefs: ctx.openingPrefs,
    });
    // [벽 길이 ▶] in the fixture panel opens this length panel (the editor gives the 설비 tool none).
    const fp = ctx.fixtureTool && ctx.fixtureTool.panel;
    if (fp && !fp.openEdge && ctx.panel && typeof ctx.panel.openEdge === 'function') {
      fp.openEdge = (edgeId, prefer) => ctx.panel.openEdge(edgeId, prefer);
    }
  }

  // The controller that takes every gesture in the current tool (설비, 메모, 지우개), or null.
  _delegate() {
    if (this.tool === 'fixture') return this.ctx.fixtureTool || null;
    if (this.tool === 'memo') return this.ctx.memoTool || null;
    if (this.tool === 'eraser') return this.ctx.eraserTool || null;
    return null;
  }

  setTool(name) {
    if (!TOOL_NAMES.includes(name)) return;
    this.cancel();
    const prev = this._delegate();
    this.tool = name;
    const next = this._delegate();
    if (prev && prev !== next && prev.deactivate) prev.deactivate();
    if (next && next.activate) next.activate();
    if (this.ctx.onToolChange) this.ctx.onToolChange(name);
    this.ctx.requestRender();
  }

  // Esc: drop the gesture or pending rectangle. Returns true if something was cancelled.
  cancel() {
    let done = false;
    this.labelPreview = null;
    if (this.active) {
      this.active = null;
      done = true;
    }
    if (this.overlay) {
      this.overlay = null;
      done = true;
    }
    if (this.openings.cancel()) done = true;
    if (this.ctx.fixtureTool && this.ctx.fixtureTool.cancel()) done = true;
    if (this.ctx.memoTool && this.ctx.memoTool.cancel()) done = true;
    if (this.ctx.eraserTool && this.ctx.eraserTool.cancel()) done = true;
    if (this.ctx.panel.mode === 'rect') {
      this.ctx.panel.close();
      done = true;
    }
    this.ctx.requestRender();
    return done;
  }

  snapMM() {
    return clamp(HIT.snapPx / this.ctx.view.scale, 30, 600);
  }

  // ---- gesture handlers (from InputController) ---------------------------------------------

  onGestureStart(g) {
    if (this.ctx.panel.mode === 'rect') {
      // A new gesture while the size panel is open abandons the drawn rectangle.
      this.ctx.panel.close();
      this.overlay = null;
    }
    const d = this._delegate();
    if (d) {
      // Right on a room name (and not on a resize handle): wait — a tap renames the room, a drag or
      // stroke goes to the tool as usual once it moves past the tap distance. The 지우개 takes every
      // gesture at once: a name is never erased, and a tap there erases what is under it (the preview
      // shows it from the first point).
      const onHandle = d.handleAt && g.screen && g.screen.length && d.handleAt(g.screen[0]);
      const nameRoom = onHandle || this.tool === 'eraser' ? null : this._roomNameAt(g.points[0], NAME_PAD_PX.exact);
      if (nameRoom) {
        this.active = { kind: 'delegate', to: d, nameRoom, pending: true };
        return undefined;
      }
      this.active = { kind: 'delegate', to: d };
      d.onGestureStart(g);
      return undefined;
    }
    const start = g.points[0];
    const fx = this.ctx.fixtureTool;
    // A resize handle of the selected fixture (shown while its panel is open, whatever the tool)
    // wins over everything else: it may lie on a corner or a wall.
    if (fx && fx.handleAt && g.screen && g.screen.length && fx.handleAt(g.screen[0])) {
      fx.onGestureStart(g);
      this.active = { kind: 'delegate', to: fx };
      return undefined;
    }
    if (this.tool === 'window' || this.tool === 'door') {
      this.openings.onGestureStart(g, this.tool);
      // A tap on a room name renames the room instead (decided when the gesture ends).
      this.active = { kind: 'opening', nameRoom: this._roomNameAt(start, NAME_PAD_PX.exact) };
    } else if (this.tool === 'select') {
      const node = this._nodeNear(start);
      const label = node ? null : this._labelAt(g.screen && g.screen[0]);
      if (node) {
        this.active = { kind: 'node', nodeId: node.id, dragging: false };
      } else if (label) {
        // A text (room name + H, window/door or fixture label, dimension number): a drag moves the
        // text only; a tap does what a tap does (a room name opens its name field).
        this.active = { kind: 'label', hit: label, dragging: false, move: null };
      } else if (this.openings.tryStartDrag(g)) {
        // Corner drags keep priority; then a window or door under the pointer is dragged (a TAP is
        // decided by _tap, where a window/door counts only on its wall band).
        this.active = { kind: 'opening', drag: true };
      } else if (fx && fx.hitTest(start)) {
        // A fixture is dragged like in the 설비 tool (a tap opens its panel).
        // A tap right on a room name drawn over the fixture still renames the room (as in the other
        // tools); a drag moves the fixture. A tap on the wall it stands against, or just past that wall's
        // face, is a tap on the wall (_tap).
        fx.onGestureStart(g);
        this.active = {
          kind: 'delegate', to: fx, nameRoom: this._roomNameAt(start, NAME_PAD_PX.exact),
          wallTap: !!this._wallFaceAt(start, fx.hitTest(start)),
        };
      } else {
        this.active = { kind: 'pan', nodeId: null, dragging: false };
      }
    } else if (this.tool === 'room') {
      this.active = { kind: 'rect' };
    } else {
      this.active = { kind: 'stroke' };
    }
    return undefined;
  }

  onGestureMove(g) {
    const a = this.active;
    if (!a) return;
    if (a.kind === 'delegate') {
      if (a.pending) {
        // Still a press on a room name: hand the gesture to the tool once it is a drag.
        if (g.maxMovePx < (TAP_SLOP_PX[g.pointerType] || 8)) return;
        a.pending = false;
        a.to.onGestureStart(g);
      }
      a.to.onGestureMove(g);
      return;
    }
    if (a.kind === 'opening') { this.openings.onGestureMove(g); return; }
    const moved = g.maxMovePx >= DRAG_SLOP_PX;
    if (a.kind === 'label') {
      if (moved && g.screen && g.screen.length) {
        a.dragging = true;
        const s0 = g.screen[0], s1 = g.screen[g.screen.length - 1];
        a.move = this.ctx.labelMove ? this.ctx.labelMove(a.hit, s1.x - s0.x, s1.y - s0.y) : null;
        this.labelPreview = a.move ? { key: a.hit.key, move: a.move } : null;
        this.ctx.requestRender();
      }
      return;
    }
    if (a.kind === 'stroke') {
      if (moved) this.overlay = { stroke: { points: g.points, held: this.tool === 'wall' && this._diagonalPreview(a, g) } };
    } else if (a.kind === 'rect') {
      if (moved) {
        const p = g.points[0], q = g.points[g.points.length - 1];
        const w = roundTo(Math.abs(q.x - p.x), 10), h = roundTo(Math.abs(q.y - p.y), 10);
        this.overlay = { rect: { a: p, b: q, label: `${formatMM(w)} × ${formatMM(h)}` } };
      }
    } else if (a.kind === 'pan') {
      const n = g.screen.length;
      if (n >= 2) {
        const s1 = g.screen[n - 1], s0 = a.lastScreen || g.screen[0];
        this.ctx.view.panBy(s1.x - s0.x, s1.y - s0.y);
        a.lastScreen = s1;
      }
    } else if (a.kind === 'node') {
      if (moved) {
        a.dragging = true;
        const at = g.points[g.points.length - 1];
        this.overlay = { ghost: { at, links: this._neighbours(a.nodeId) } };
      }
    }
    this.ctx.requestRender();
  }

  onGestureEnd(g) {
    const a = this.active;
    this.active = null;
    if (!a) return;
    if (a.kind === 'delegate') {
      if (g.isTap && a.nameRoom) {
        if (!a.pending && a.to.onGestureCancel) a.to.onGestureCancel(g);
        this.ctx.panel.openRoom(a.nameRoom, { editName: true });
        this.ctx.requestRender();
        return;
      }
      if (g.isTap && a.wallTap) {
        if (!a.pending && a.to.onGestureCancel) a.to.onGestureCancel(g);
        this._tap(g.points[0]);
        this.ctx.requestRender();
        return;
      }
      if (a.pending) a.to.onGestureStart(g);
      a.to.onGestureEnd(g);
      this.ctx.requestRender();
      return;
    }
    if (a.kind === 'label') {
      this.labelPreview = null;
      if (a.dragging && !g.isTap) {
        const move = a.move;
        const store = this.ctx.store();
        if (move && typeof store.moveLabel === 'function') {
          const ok = this.ctx.command(() => store.moveLabel(move), '글자 옮기기');
          if (ok && !this._labelHintShown) {
            this._labelHintShown = true;
            this.ctx.toast('글자를 옮겼습니다. 옮긴 글자를 길게 누르면 원래 자리로 되돌릴 수 있습니다.', { ms: 4000 });
          }
        }
        this.ctx.requestRender();
        return;
      }
      // A long press on a moved text: put it back?
      const held = g.startTime != null && performance.now() - g.startTime >= LONG_PRESS_MS;
      if (held && a.hit.moved && this.ctx.onLabelLongPress) {
        this.ctx.onLabelLongPress(a.hit);
        this.ctx.requestRender();
        return;
      }
      this.overlay = null;
      this._tap(g.points[0]);
      this.ctx.requestRender();
      return;
    }
    if (a.kind === 'opening') {
      if (g.isTap && a.nameRoom) {
        this.openings.onGestureCancel();
        this.ctx.panel.openRoom(a.nameRoom, { editName: true });
        this.ctx.requestRender();
        return;
      }
      if (g.isTap && a.drag) {
        // 선택: a tap near a window/door is a tap like in the other tools (inside the room → the wall).
        this.openings.onGestureCancel();
        this._tap(g.points[0]);
        this.ctx.requestRender();
        return;
      }
      // OpeningTool handles its own taps: on an opening → its panel; near a wall → place one there.
      this.openings.onGestureEnd(g);
      this.ctx.requestRender();
      return;
    }
    if (g.isTap) {
      this.overlay = null;
      this._tap(g.points[0]);
      this.ctx.requestRender();
      return;
    }
    if (a.kind === 'stroke') {
      this.overlay = null;
      if (this.tool === 'wall') this._finishWall(g);
      else this._finishDivider(g);
    } else if (a.kind === 'rect') {
      this._finishRect(g);
    } else if (a.kind === 'node') {
      this.overlay = null;
      if (a.dragging) {
        const at = g.points[g.points.length - 1];
        const store = this.ctx.store();
        let moved = true;
        // A loose wall end dropped on a wall or corner joins it (#12) within the same 18 px the pen snaps.
        this.ctx.command(() => { moved = store.moveNode(a.nodeId, at.x, at.y, { snapMM: this.snapMM() }); }, '모서리 옮기기');
        if (!moved && store.lastMoveProblem) {
          this.ctx.toast('그 자리로 옮기면 벽이 다른 벽과 겹치거나 없어집니다. 옮기지 않았습니다.', { type: 'warn' });
        }
      }
    }
    this.ctx.requestRender();
  }

  onGestureCancel(g) {
    const a = this.active;
    this.active = null;
    this.labelPreview = null;
    if (a && a.kind === 'delegate' && !a.pending && a.to.onGestureCancel) a.to.onGestureCancel(g);
    this.openings.onGestureCancel();
    if (this.ctx.panel.mode !== 'rect') this.overlay = null;
    this.ctx.requestRender();
  }

  // ---- actions --------------------------------------------------------------------------------

  _tap(world) {
    const store = this.ctx.store();
    const panel = this.ctx.panel;
    if (this.ctx.tapExtra && this.ctx.tapExtra(world)) return;
    // The room's name text: the room panel with the name field open (on-screen keyboard). Right on
    // the letters it wins over everything; a near miss counts only when no wall is under the finger
    // (zoomed far out, names cover the walls of small rooms).
    const named = this._roomNameAt(world, NAME_PAD_PX.exact);
    if (named) {
      panel.openRoom(named, { editName: true });
      return;
    }
    // A window or door, then a fixture: they sit on or against walls, so they win over the wall —
    // a window/door only right on its symbol in the wall band, never from inside the room; a fixture
    // except on the wall band and just past the wall's face (_wallFaceAt), where the wall wins.
    if (this.openings.tapOnSymbol(world)) return;
    const fx = this.ctx.fixtureTool;
    const hit = fx && fx.hitTest(world);
    if (hit && !this._wallFaceAt(world, hit)) {
      fx.openFixture(hit.id);
      return;
    }
    let edgeId = null;
    let roomId = null;
    try {
      edgeId = store.edgeAt(world, HIT.edgePx / this.ctx.view.scale + 75);
      if (!edgeId) roomId = store.roomAt(world);
    } catch (err) {
      console.error(err);
    }
    const nearName = edgeId ? null : this._roomNameAt(world, NAME_PAD_PX.near);
    if (nearName) {
      panel.openRoom(nearName, { editName: true });
    } else if (edgeId) {
      // The ▶ goes to the room on the tapped side of the wall; the room being measured is kept only
      // for a tap right on the wall band (panel._fieldAt).
      const cur = panel.highlight.activeSide;
      panel.openEdge(edgeId, { at: { x: world.x, y: world.y }, roomId: cur ? cur.roomId : null });
    } else if (roomId) {
      panel.openRoom(roomId);
    } else if (panel.isOpen) {
      panel.close();
    } else if (this.ctx.closePanels) {
      this.ctx.closePanels();
    }
  }

  _finishWall(g) {
    const store = this.ctx.store();
    // Slanted strokes become diagonal walls by themselves ('auto'); Shift (PC, not in the hint) makes every
    // piece off the 20° snap diagonal. The pen held still at the end no longer does (fixer 2026-10-20: a
    // careful drawer's pause before lifting the pen turned the rounded corner of an L into a diagonal).
    const allowDiagonal = g.shiftKey ? true : 'auto';
    let result = null;
    // A short stroke (far zoom: 예시 세대 A's 550 mm 베란다1 step is 16–26 px) is kept by the engine; from a finger,
    // whose tap may slide, one with an end in the open only from SHORT_TOUCH_PX.
    const opts = { allowDiagonal, snapMM: this.snapMM() };
    if (g.pointerType === 'touch') opts.shortMin = SHORT_TOUCH_PX / this.ctx.view.scale;
    const ok = this.ctx.command(() => {
      result = store.addStroke(g.points, opts);
    }, '벽 그리기');
    if (ok && (!result || !result.edgeIds || !result.edgeIds.length)) {
      // A short wobble on a wall is a press, not a stroke: treat it as a tap (opens the length panel).
      if (g.maxMovePx < TAP_LIKE_PX) {
        this._tap(g.points[0]);
        return;
      }
      this.ctx.toast('선이 너무 짧아서 벽을 만들지 않았습니다.', { type: 'warn' });
    }
    if (this.ctx.panel.mode === 'edge' || this.ctx.panel.mode === 'thickness') this.ctx.panel.close();
  }

  // Would the wall stroke so far make a diagonal wall? (renderOverlay shows the diagonal colour and the
  // '사선' pill.) Shift: yes. Else the points are straightened as addStroke will ('auto'), at most every
  // DIAGONAL_PREVIEW_MS; the answer is kept on the gesture state `a` in between.
  _diagonalPreview(a, g) {
    if (g.shiftKey) return true;
    const now = performance.now();
    if (a.diagonalAt != null && now - a.diagonalAt < DIAGONAL_PREVIEW_MS && g.points.length - a.diagonalN < 12) return !!a.diagonal;
    a.diagonalAt = now;
    a.diagonalN = g.points.length;
    try {
      const segs = straightenStroke(g.points, { cornerTolerance: this.snapMM() / 2, allowDiagonal: 'auto' });
      a.diagonal = segs.some((sg) => sg.orient === 'd');
    } catch (err) {
      console.error(err);
      a.diagonal = false;
    }
    return a.diagonal;
  }

  _finishDivider(g) {
    const store = this.ctx.store();
    const p = g.points[0];
    let q = g.points[g.points.length - 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    if (Math.hypot(dx, dy) * this.ctx.view.scale < 20) {
      this.ctx.toast('선이 너무 짧습니다.', { type: 'warn' });
      return;
    }
    // Snap to horizontal/vertical when close (the engine may snap too; doing it here is harmless).
    const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    if (ang < AXIS_SNAP_DEG || ang > 180 - AXIS_SNAP_DEG) q = { x: q.x, y: p.y };
    else if (Math.abs(ang - 90) < AXIS_SNAP_DEG) q = { x: p.x, y: q.y };
    this.ctx.command(() => {
      store.addDivider(p, q, { snapMM: this.snapMM() });
    }, '구역 나누기');
    if (this.ctx.panel.mode === 'edge') this.ctx.panel.close();
  }

  _finishRect(g) {
    const p = g.points[0], q = g.points[g.points.length - 1];
    const w = Math.abs(q.x - p.x), h = Math.abs(q.y - p.y);
    if (w < MIN_RECT_MM || h < MIN_RECT_MM) {
      this.overlay = null;
      this.ctx.toast('너무 작습니다. 조금 더 크게 끌어 주세요.', { type: 'warn' });
      return;
    }
    const rect = { a: p, b: q };
    this.ctx.panel.openRect(rect, (rw, rh, typed = {}) => {
      this.overlay = null;
      // Keep the corner where the drag started; grow in the drag direction.
      const x = q.x >= p.x ? p.x : p.x - rw;
      const y = q.y >= p.y ? p.y : p.y - rh;
      const store = this.ctx.store();
      let result = null;
      // Sizes typed on the numpad are real inner measurements: the engine stores them (exactly as
      // typed) in the same undo step as the walls.
      const measure = { w: !!typed.w, h: !!typed.h };
      const ok = this.ctx.command(() => {
        result = store.addRectRoom(x, y, rw, rh, { snapMM: this.snapMM(), measure });
      }, '실 추가');
      this.ctx.requestRender();
      if (ok && result && result.roomId) this.ctx.panel.openRoom(result.roomId);
    }, () => {
      this.overlay = null;
      this.ctx.requestRender();
    });
  }

  // ---- hit helpers ----------------------------------------------------------------------------

  // The movable text under a screen point (ctx.labelAt), or null.
  _labelAt(screenPt) {
    if (!screenPt || typeof this.ctx.labelAt !== 'function') return null;
    try {
      return this.ctx.labelAt(screenPt) || null;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  _roomNameAt(world, padPx) {
    if (!world || typeof this.ctx.roomNameAt !== 'function') return null;
    try {
      return this.ctx.roomNameAt(world, padPx) || null;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  // The wall under a tap on its band or within WALL_FACE_PX past its face (the finish of that side
  // included), on either side, between the wall's ends; null elsewhere. `fixture` (the one under the tap):
  // the strip is at most a third of its depth across the wall, and an in-wall one (벽 속에 넣기) keeps its
  // own box. A sink standing against the 예시 세대 A 방3 | 주방 wall took 12–16 of 21 taps meant for that wall's
  // length (a blind 2800 went into the sink's 가로). → edgeId | null
  _wallFaceAt(world, fixture = null) {
    const store = this.ctx.store();
    const k = this.ctx.view.scale;
    if (!world || !(k > 0)) return null;
    let edgeId = null;
    try {
      edgeId = store.edgeAt(world, HIT.edgePx / k + 75);
    } catch (err) {
      console.error(err);
      return null;
    }
    const { project, derived } = store;
    const e = edgeId && project.edges.find((x) => x.id === edgeId);
    const A = e && project.nodes.find((n) => n.id === e.a), B = e && project.nodes.find((n) => n.id === e.b);
    if (!A || !B) return null;
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    if (!(L > 0)) return null;
    const along = ((world.x - A.x) * dx + (world.y - A.y) * dy) / L;
    if (along < 0 || along > L) return null;
    // > 0: the left of a → b, as dims.finishBeside counts it.
    const across = ((world.x - A.x) * dy - (world.y - A.y) * dx) / L;
    let fin = { left: 0, right: 0 };
    try { fin = finishBeside(project, derived, edgeId) || fin; } catch (_) { /* no finish */ }
    const face = wallThickness(e, project, derived) / 2 + Math.max(0, (across >= 0 ? fin.left : fin.right) || 0);
    let strip = WALL_FACE_PX / k;
    const f = fixture ? normalizeFixture(fixture) : null;
    if (f) {
      const b = fixtureBounds(f);
      const h = Math.abs(dx) >= Math.abs(dy);
      strip = Math.min(strip, (h ? b.maxY - b.minY : b.maxX - b.minX) / 3);
      if (f.inWall && world.x >= b.minX && world.x <= b.maxX && world.y >= b.minY && world.y <= b.maxY) return null;
    }
    return Math.abs(across) <= face + strip ? edgeId : null;
  }

  _nodeNear(world) {
    const store = this.ctx.store();
    const max = HIT.nodePx / this.ctx.view.scale;
    let best = null, bestD = max;
    for (const n of store.project.nodes || []) {
      const d = Math.hypot(n.x - world.x, n.y - world.y);
      if (d <= bestD) { best = n; bestD = d; }
    }
    return best;
  }

  _neighbours(nodeId) {
    const store = this.ctx.store();
    const nodes = new Map(store.project.nodes.map((n) => [n.id, n]));
    const out = [];
    for (const e of store.project.edges || []) {
      if (e.a === nodeId && nodes.get(e.b)) out.push(nodes.get(e.b));
      else if (e.b === nodeId && nodes.get(e.a)) out.push(nodes.get(e.a));
    }
    return out;
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
