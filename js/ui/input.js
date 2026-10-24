// Pointer handling for the plan canvas: pen/finger policy, gestures, pan and zoom (dev/DESIGN.md §5).
//
// Policy
// - "Pen near": a pen pointer is down, or a pen event (hover pointermove with buttons == 0, over, down,
//   up, …, anywhere on the page) arrived within the last 800 ms (TIMING.penNear). Nothing else keeps it
//   on: the Galaxy Tab S9 FE (Chrome 144, field test 2026-10-22) sends NO pointerout / pointerleave when
//   the S Pen leaves hover range, so a "hovering until pointerout" flag stayed on for good and every
//   finger was taken for a palm (no tap, no pinch). A hovering pen streams hover moves, which keep it
//   near; 800 ms after the last one it is away. A pen pointerout that leaves the page (relatedTarget
//   null) ends it at once, except right after a lift (Chrome sends pointerup → pointerout → pointerover
//   while the pen is still hovering), where the 800 ms from the lift stay. A pen counted as down lets go
//   after PEN_DOWN_HOLD_MS without any pen event (a lost pointerup must not stick either).
// - The pen has priority. Touches that land while the pen is near are treated as palm contacts: they
//   never draw, tap, pan or pinch, and stay ignored until they lift (a palm often makes two contacts,
//   which must not become a pinch under the pen). Any pen event (a hover move too) also cancels a finger
//   gesture, pan or pinch in progress and marks the touches still down as palm. While a touch taken for
//   a palm is still down, new touches are palm too (a resting palm's next contact; a pinch tried right
//   after the pen whose first finger came within the 800 ms).
// - Pen away: one finger draws or taps per the current tool; two fingers pan and zoom (around their
//   midpoint, within the wheel's zoom limits). One finger of a pinch lifting and landing again pinches
//   on; of three fingers, the two still down pinch on.
// - S Pen side button (barrel: button 2 / buttons & 2) or eraser end (button 5 / buttons & 32): the
//   gesture is a rub of the 지우개 in any tool (g.erase = true; tools.js hands it to the EraserTool, the
//   current tool stays). Also when the button is pressed while the pen hovers (pointerdown without
//   contact: the rub starts when the tip touches) or right after the tip touched (the first moves of a
//   press carry the button). The tip leaving the screen while the button is still held ends the gesture.
// - Recovery from missed pointerup events: a new mouse/pen press, a mouse/pen move with no button down,
//   a primary touch (no other touch is really down), window blur and the page going to the background
//   all drop stale gesture state.
// - Mouse: the left button draws/taps, middle-drag or Space+drag pans, the wheel zooms around the cursor.
// - DOM buttons and the numpad are outside the canvas and always accept touch.
// - The canvas never shows a context menu (a long press, or the S Pen side button).
//
// The controller does not know about tools. It reports single-pointer "gestures" to the handlers:
//   onGestureStart(g) -> may return 'pan' to turn this gesture into a view pan instead
//   onGestureMove(g), onGestureEnd(g) (g.isTap tells a tap from a drag), onGestureCancel(g)
//   onViewChange() after any pan/zoom, onPenStatus(near) when the pen-near state changes.
// A gesture g = { id, pointerType, startTime, screen: [{x,y}], points: [{x,y}] (world mm),
//   shiftKey, held (paused >= 500 ms at the current end), isTap, maxMovePx, erase (S Pen side button) }.
import { TIMING } from './theme.js';

const TAP_SLOP_PX = { touch: 12, pen: 8, mouse: 5 };
// A tap is decided by movement only: field workers often press deliberately (and slowly), and a press
// held in place has no other meaning (the diagonal long-press needs a stroke first).
const HOLD_MOVE_PX = 4;        // movement smaller than this does not reset the long-press timer
const WHEEL_ZOOM = 0.0015;
// A pen counted as down (pointerdown seen, no pointerup yet) keeps "pen near" on while pen events keep
// coming; this long after the last one it no longer counts (its pointerup was lost).
export const PEN_DOWN_HOLD_MS = 5000;
const PEN_ERASE_BUTTONS = 2 | 32;   // barrel (side) button, eraser end
const PEN_DOC_EVENTS = ['pointerover', 'pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'pointerout'];

// The S Pen side button or the eraser end is pressed (pointerdown / pointermove / pointerup of a pen).
export function penEraseButtons(e) {
  return !!e && e.pointerType === 'pen' && (e.button === 2 || e.button === 5 || ((e.buttons | 0) & PEN_ERASE_BUTTONS) !== 0);
}

// The pen's tip (or eraser end) touches the screen: the tip / eraser bit, or a pressure (a hovering S Pen
// reports pressure 0, also with its side button held).
export function penContact(e) {
  return !!e && (((e.buttons | 0) & (1 | 32)) !== 0 || e.pressure > 0);
}

export class InputController {
  constructor(canvas, view, handlers) {
    this.canvas = canvas;
    this.view = view;
    this.h = handlers;
    this.touches = new Map();   // pointerId -> {x, y} for finger touches currently on the canvas
    this.palms = new Set();     // pointerIds of touches treated as palm (ignored until they lift)
    this.gesture = null;        // active single-pointer gesture
    this.pan = null;            // { id, last: {x, y} }
    this.pinch = null;          // { ids: [a, b], lastMid, lastDist }
    this.spaceHeld = false;
    this.lastPenTime = -Infinity;   // performance.now() of the last pen event on the page
    this.penDown = new Set();       // pen pointerIds between pointerdown and pointerup (page-wide)
    this._lastPenType = '';         // type of the last pen event (pointerout of the page excluded)
    this._armed = null;             // { id }: the S Pen side button pressed while hovering over the canvas
    this._penNearReported = false;
    this._penTimer = 0;
    this._holdTimer = 0;
    this._rect = null;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onCancel = this._onCancel.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onDocPen = this._onDocPen.bind(this);
    // No context menu on the plan: not on a long press, not for the S Pen side button (which rubs out).
    this._onContextMenu = (e) => e.preventDefault();
    this._onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); }; // stop middle-click autoscroll

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onCancel);
    canvas.addEventListener('lostpointercapture', this._onCancel);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this._onContextMenu);
    canvas.addEventListener('mousedown', this._onMouseDown);
    // Pen proximity is tracked on the whole document: a pen hovering over the panel is still "near".
    for (const type of PEN_DOC_EVENTS) document.addEventListener(type, this._onDocPen, true);
    // Pointer events can be lost when the window loses focus or the app goes to the background.
    this._onBlur = () => this.reset();
    this._onVisibility = () => { if (document.visibilityState === 'hidden') this.reset(); };
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onCancel);
    c.removeEventListener('lostpointercapture', this._onCancel);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onContextMenu);
    c.removeEventListener('mousedown', this._onMouseDown);
    for (const type of PEN_DOC_EVENTS) document.removeEventListener(type, this._onDocPen, true);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVisibility);
    clearTimeout(this._penTimer);
    clearTimeout(this._holdTimer);
  }

  // ---- pen proximity -------------------------------------------------------------------------

  get penNear() {
    return performance.now() < this.penNearUntil;
  }

  // When "pen near" runs out if no pen event comes (performance.now() time; -Infinity: not near).
  get penNearUntil() {
    return this.lastPenTime + (this.penDown.size ? PEN_DOWN_HOLD_MS : TIMING.penNear);
  }

  _onDocPen(e) {
    if (e.pointerType !== 'pen') return;
    const type = e.type;
    if (type === 'pointerout' && !e.relatedTarget) {
      // The pen left the page (or, where a tablet reports it, went out of hover range): fingers count
      // at once. Not right after a lift: Chrome sends pointerup → pointerout(null) → pointerover while
      // the pen is still hovering over the screen, and a palm landing then is still a palm.
      if (!this.penDown.size && this._lastPenType !== 'pointerup' && this._lastPenType !== 'pointercancel') {
        this.lastPenTime = -Infinity;
      }
      this._reportPen();
      return;
    }
    if (type === 'pointerdown') this.penDown.add(e.pointerId);
    else if (type === 'pointerup' || type === 'pointercancel') this.penDown.delete(e.pointerId);
    else if (type === 'pointermove' && e.buttons === 0) this.penDown.delete(e.pointerId); // hovering: nothing is down
    if (type !== 'pointerout') this._lastPenType = type;
    this.lastPenTime = performance.now();
    // Palm rejection also applies to a palm that touched down just before the pen came near: its
    // one-finger gesture AND a pinch of two palm contacts stop, and the touches still down are palm
    // (checker 2026-10-24: two contacts that landed with the pen away kept zooming under the hovering pen).
    if (type !== 'pointerout' && (this.touches.size || this.pinch || (this.gesture && this.gesture.pointerType === 'touch'))) {
      this._penTakesOver();
    }
    this._reportPen();
  }

  _reportPen() {
    const now = performance.now();
    const until = this.penNearUntil;
    const near = now < until;
    if (near !== this._penNearReported) {
      this._penNearReported = near;
      if (this.h.onPenStatus) this.h.onPenStatus(near);
    }
    clearTimeout(this._penTimer);
    // Re-check when the window runs out (a new pen event moves it on).
    if (near) this._penTimer = setTimeout(() => this._reportPen(), Math.max(20, until - now + 20));
  }

  // ---- keyboard state ------------------------------------------------------------------------

  setSpace(held) {
    this.spaceHeld = held;
    this.canvas.classList.toggle('space-pan', held);
  }

  get busy() {
    return !!(this.gesture || this.pan || this.pinch);
  }

  // Cancel whatever single-pointer gesture is in progress (Esc).
  cancel() {
    if (this.gesture) {
      this._cancelGesture();
      return true;
    }
    return false;
  }

  // ---- pointer events ------------------------------------------------------------------------

  _pos(e) {
    const r = this._rect || this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onDown(e) {
    this._rect = this.canvas.getBoundingClientRect();
    const pos = this._pos(e);
    const type = e.pointerType || 'mouse';
    e.preventDefault();

    if (type === 'touch') {
      // A primary touch means no other touch is really down: anything left over is stale
      // (a pointerup that never arrived).
      if (e.isPrimary) {
        this._dropTouchState();
        // A pen gesture (or side-button press) still open although the pen has been away for
        // PEN_DOWN_HOLD_MS lost its pointerup: it must not keep every finger "busy" (checker 2026-10-24).
        if (!this.penNear) {
          if (this.gesture && this.gesture.pointerType === 'pen') this._cancelGesture();
          this._armed = null;
        }
      }
      this._capture(e);
      // Palm rejection: ignored until it lifts. Also while a touch taken for a palm is still down (the
      // pen-near time may run out under a resting palm): a palm's next contact, or the second finger of
      // a pinch tried right after the pen whose first finger was a palm, must not draw on its own
      // (checker 2026-10-24). Once every touch is up, the next one is primary and counts again.
      if (this.penNear || this.palms.size) {
        this.palms.add(e.pointerId);
        return;
      }
      this.touches.set(e.pointerId, pos);
      if (this.touches.size >= 2) {
        // Two fingers: pinch/pan.
        if (this.gesture && this.gesture.pointerType === 'touch') this._cancelGesture();
        if (this.pan && this.touches.has(this.pan.id)) this._endPan();
        if (!this.pinch) this._startPinch();
        return;
      }
      if (this.gesture || this.pan || this.pinch) return; // busy
      this._startGesture(e, pos, type);
      return;
    }

    if (type === 'pen') {
      // The side button (barrel) or the eraser end rubs out in any tool; other buttons do nothing.
      const erase = penEraseButtons(e);
      if (!erase && e.button !== 0 && e.button !== -1) return;
      // The pen has priority over fingers: drop finger gestures, pans and pinches, and treat the
      // touches still down as palm.
      this._penTakesOver();
      // A pen gesture still open here lost its pointerup: drop it.
      if (this.gesture) this._cancelGesture();
      this._armed = null;
      this._capture(e);
      if (erase && !penContact(e)) {
        // The side button pressed while hovering: the rub starts when the tip touches (_onMove).
        this._armed = { id: e.pointerId };
        return;
      }
      this._startGesture(e, pos, type, erase);
      return;
    }

    // Mouse
    if (this.gesture && this.gesture.pointerType !== 'touch') this._cancelGesture(); // missed pointerup
    if (this.pan && this.pan.id === e.pointerId) this._endPan();
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      this._capture(e);
      this.pan = { id: e.pointerId, last: pos };
      this.canvas.classList.add('panning');
      return;
    }
    if (e.button === 0 && !this.gesture) {
      this._capture(e);
      this._startGesture(e, pos, type);
    }
  }

  // Pen pointerdown: finger gestures, pans and pinches stop; touches still down become palm contacts.
  _penTakesOver() {
    if (this.gesture && this.gesture.pointerType === 'touch') this._cancelGesture();
    if (this.pan && this.touches.has(this.pan.id)) this._endPan();
    this.pinch = null;
    for (const id of this.touches.keys()) this.palms.add(id);
    this.touches.clear();
  }

  // Forget every touch (stale or palm), the pinch and any touch gesture or pan.
  _dropTouchState() {
    if (this.gesture && this.gesture.pointerType === 'touch') this._cancelGesture();
    if (this.pan && this.touches.has(this.pan.id)) this._endPan();
    this.touches.clear();
    this.palms.clear();
    this.pinch = null;
  }

  _endPan() {
    this.pan = null;
    this.canvas.classList.remove('panning');
  }

  // Drop everything in progress (window blur, app to the background).
  reset() {
    if (this.gesture) this._cancelGesture();
    this._dropTouchState();
    if (this.pan) this._endPan();
    this._armed = null;
    // Pointer events may have been lost: a pen counted as down must not keep "pen near" on.
    this.penDown.clear();
    this._reportPen();
    this.setSpace(false);
  }

  _onMove(e) {
    const pos = this._pos(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, pos);
    }
    if (e.pointerType === 'pen' && this._penMove(e, pos)) return;
    if (this.pinch && this.pinch.ids.includes(e.pointerId)) {
      this._updatePinch();
      return;
    }
    if (this.pan && this.pan.id === e.pointerId) {
      this.view.panBy(pos.x - this.pan.last.x, pos.y - this.pan.last.y);
      this.pan.last = pos;
      this._viewChanged();
      return;
    }
    const g = this.gesture;
    if (g && g.id === e.pointerId && g.pointerType !== 'touch' && e.buttons === 0) {
      // No button is down any more: the pointerup was missed. Drop the stroke rather than finish it.
      this._cancelGesture();
      return;
    }
    if (g && g.id === e.pointerId) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const list = events && events.length ? events : [e];
      for (const ev of list) this._addPoint(g, this._pos(ev));
      g.shiftKey = e.shiftKey;
      if (this.h.onGestureMove) this.h.onGestureMove(g);
    }
  }

  // A pen move on the canvas, for the S Pen side button. → true when the move was handled here.
  _penMove(e, pos) {
    const id = e.pointerId;
    if (this._armed && this._armed.id === id) {
      if (e.buttons === 0) { this._armed = null; return true; }   // let go without touching (pointerup lost)
      if (!penContact(e)) return true;                             // still hovering with the button held
      // The tip touches: the rub starts here (or, if the button was let go in the same report, a stroke).
      this._armed = null;
      this._startGesture(e, pos, 'pen', penEraseButtons(e));
      return true;
    }
    const g = this.gesture;
    if (!g || g.id !== id || g.pointerType !== 'pen') return false;
    if (e.buttons !== 0 && !penContact(e)) {
      // The tip left the screen while the side button is still held (Chrome sends the pointerup only when
      // the button is let go): the gesture ends here, and a new touch with the button held rubs again.
      this._finishGesture(g);
      if (penEraseButtons(e)) this._armed = { id };
      return true;
    }
    if (!g.erase && penEraseButtons(e) && g.maxMovePx < TAP_SLOP_PX.pen) {
      // The side button pressed right after the tip touched (still a press, not a stroke): the press
      // becomes a rub from where it started. The move then adds its point to the rub.
      const start = g.screen[0];
      this._cancelGesture();
      this._startGesture({ pointerId: id, shiftKey: g.shiftKey }, start, 'pen', true);
    }
    return false;
  }

  _onUp(e) {
    this._release(e, false);
  }

  _onCancel(e) {
    // lostpointercapture also fires after a normal pointerup; _release ignores pointers already done.
    this._release(e, true);
  }

  _release(e, cancelled) {
    const id = e.pointerId;
    if (this.palms.delete(id)) return;
    if (this._armed && this._armed.id === id) { this._armed = null; return; }
    if (this.touches.has(id)) this.touches.delete(id);
    if (this.pinch && this.pinch.ids.includes(id)) {
      // A lone remaining finger is ignored until it lifts (or another one lands: a pinch again); with
      // three fingers down, the two still down pinch on.
      this.pinch = null;
      if (this.touches.size >= 2) this._startPinch();
      return;
    }
    if (this.pan && this.pan.id === id) {
      this.pan = null;
      this.canvas.classList.remove('panning');
      return;
    }
    const g = this.gesture;
    if (g && g.id === id) {
      if (cancelled) {
        this._cancelGesture();
        return;
      }
      this._addPoint(g, this._pos(e));
      this._finishGesture(g);
    }
  }

  _capture(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }

  // ---- gestures ------------------------------------------------------------------------------

  _startGesture(e, pos, type, erase = false) {
    const now = performance.now();
    const g = {
      id: e.pointerId,
      pointerType: type,
      startTime: now,
      lastMoveTime: now,
      holdAnchor: pos,
      screen: [pos],
      points: [this.view.toWorld(pos)],
      shiftKey: !!e.shiftKey,
      held: false,
      isTap: false,
      maxMovePx: 0,
      erase: !!erase,   // the S Pen side button / eraser end: a 지우개 rub in any tool
    };
    this.gesture = g;
    const result = this.h.onGestureStart ? this.h.onGestureStart(g) : undefined;
    if (result === 'pan') {
      // The tool wants this pointer to pan the view (e.g. select tool on empty space).
      this.gesture = null;
      this.pan = { id: g.id, last: pos };
      this.canvas.classList.add('panning');
      return;
    }
    this._armHold(g);
  }

  _addPoint(g, pos) {
    const last = g.screen[g.screen.length - 1];
    if (Math.hypot(pos.x - last.x, pos.y - last.y) < 1) return;
    g.screen.push(pos);
    g.points.push(this.view.toWorld(pos));
    const s0 = g.screen[0];
    g.maxMovePx = Math.max(g.maxMovePx, Math.hypot(pos.x - s0.x, pos.y - s0.y));
    if (Math.hypot(pos.x - g.holdAnchor.x, pos.y - g.holdAnchor.y) >= HOLD_MOVE_PX) {
      g.holdAnchor = pos;
      g.lastMoveTime = performance.now();
      if (g.held) g.held = false;
      this._armHold(g);
    }
  }

  _armHold(g) {
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(() => {
      if (this.gesture !== g) return;
      const slop = TAP_SLOP_PX[g.pointerType] || 8;
      if (g.maxMovePx < slop) return;   // still a press in place, not the end of a stroke
      g.held = true;
      if (this.h.onGestureMove) this.h.onGestureMove(g);
    }, TIMING.longPress);
  }

  _finishGesture(g) {
    clearTimeout(this._holdTimer);
    this.gesture = null;
    const now = performance.now();
    const slop = TAP_SLOP_PX[g.pointerType] || 8;
    g.isTap = g.maxMovePx < slop;
    if (!g.isTap && now - g.lastMoveTime >= TIMING.longPress) g.held = true;
    if (this.h.onGestureEnd) this.h.onGestureEnd(g);
  }

  _cancelGesture() {
    clearTimeout(this._holdTimer);
    const g = this.gesture;
    this.gesture = null;
    if (g && this.h.onGestureCancel) this.h.onGestureCancel(g);
  }

  // ---- pinch ---------------------------------------------------------------------------------

  _startPinch() {
    const ids = [...this.touches.keys()].slice(0, 2);
    const [a, b] = ids.map((id) => this.touches.get(id));
    this.pinch = {
      ids,
      lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      lastDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  _updatePinch() {
    const p = this.pinch;
    const a = this.touches.get(p.ids[0]);
    const b = this.touches.get(p.ids[1]);
    if (!a || !b) return;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.view.panBy(mid.x - p.lastMid.x, mid.y - p.lastMid.y);
    this.view.zoomAt(mid.x, mid.y, dist / p.lastDist);
    p.lastMid = mid;
    p.lastDist = dist;
    this._viewChanged();
  }

  // ---- wheel ---------------------------------------------------------------------------------

  _onWheel(e) {
    e.preventDefault();
    this._rect = this.canvas.getBoundingClientRect();
    const pos = this._pos(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;        // lines
    else if (e.deltaMode === 2) dy *= 400;  // pages
    const factor = Math.exp(-dy * WHEEL_ZOOM * (e.ctrlKey ? 4 : 1)); // ctrlKey = touchpad pinch
    this.view.zoomAt(pos.x, pos.y, factor);
    this._viewChanged();
  }

  _viewChanged() {
    if (this.h.onViewChange) this.h.onViewChange();
  }
}
