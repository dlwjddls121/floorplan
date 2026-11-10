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
//   The Galaxy Tab S9 FE's Chrome never reports the S Pen's side button (device test v3, 2026-10-29: no
//   button 2 / buttons 32 in any pen event, no rub; once a context menu, and pen moves with buttons 1 and
//   pressure 0, which a light tip also gives): nothing tells a rub with it from drawing there, so the app
//   no longer mentions it on screen; this stays for pens and tablets that report it.
// - Recovery from missed pointerup events: a new mouse/pen press, a mouse/pen move with no button down,
//   a primary touch (no other touch is really down), window blur and the page going to the background
//   all drop stale gesture state.
// - Mouse: the left button draws/taps, middle-drag or Space+drag pans, the wheel zooms around the cursor.
// - DOM buttons and the numpad are outside the canvas and accept touch, except on the bottom panel while
//   the pen is in use (installPalmGuard below: the pen hand rests on the numpad, bottom right).
// - The canvas never shows a context menu (a long press, or the S Pen side button).
// - The kind of the last input on the page (lastInputKind: 'mouse' | 'pen' | 'touch' | 'key', from every
//   pointerdown and every real key, anywhere on the page): after a pen or a finger a text field never takes
//   the focus by itself (fieldFocusOk). On the Galaxy Tab (simulation 2026-11-01) a pen tap on a room's name
//   focused the name field by itself: Samsung's S Pen handwriting bar (☺ ⌫ ⌨ 완료) came up over the name
//   buttons (a finger: the on-screen keyboard), and the next pen tap there was written into the field as 'ㅣ'.
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

// A text field may take the focus by itself (the app focusing it) after this kind of input: a mouse or a
// keyboard (a PC: typing there is real keys). After a pen or a finger it waits for a tap on the field itself,
// which brings the on-screen keyboard or the S Pen handwriting bar by the surveyor's own choice.
export function fieldFocusOk(kind) {
  return kind !== 'pen' && kind !== 'touch';
}

// A text field taking the focus within this long after the S Pen was over it (hovering) is the surveyor writing in
// it: Samsung's S Pen to text writes straight into a field the pen hovers over, and the browser may focus it
// without a pointerdown reaching the page (panel.js room name, fixtures-ui.js 기타 name).
export const PEN_OVER_FIELD_MS = 1500;

// The last pointerdown anywhere on the page (InputController keeps it): { seq, target }; seq orders it among the pen's
// visits over a text field (penOverMark), whatever the clock says.
let order = 0;
let lastDown = { seq: 0, target: null };

// The S Pen over a text field now (its pointerover / pointermove there): → { at: performance.now(), seq }.
export function penOverMark() {
  return { at: performance.now(), seq: ++order };
}

// The field takes the focus now as the S Pen writing straight into it: the pen was over it (over: its last
// penOverMark()) within PEN_OVER_FIELD_MS, and pressed nothing else on the page since (round 4 part B check: the
// name buttons and the numpad lie right under the name field, so a pen passing over the field on its way there left
// the field 'written into' for 1.5 s, and a focus the browser gave it then, with a stray 'ㅣ', was put in by
// [✕ 닫기]).
export function penWroteInto(field, over, now = performance.now()) {
  if (!over || !(over.at > 0) || now - over.at >= PEN_OVER_FIELD_MS) return false;
  const d = lastDown;
  const onField = !!d.target && !!field && (d.target === field || (typeof field.contains === 'function' && field.contains(d.target)));
  return !(d.seq > over.seq && !onField);
}

// ---- clicks on the bottom panel that a tap elsewhere left behind --------------------------------------------
// A tap on the plan opens a bottom panel right away (the room panel for a tap in a room, at the press or the lift);
// the browser then gives that tap's click to whatever lies under the finger by now: a name chip of the room panel
// that has just opened there, which renamed the room ('보일러실': a finger tap low in E1's unnamed 화장실; 0.6.8 and
// round 4 part B, CDP check). On the panel a pointer's click counts only when its press was on the panel too. A
// script or keyboard click (detail 0: el.click(), Enter / Space, the palm guard's own) is left alone. → remove()
export function installGhostClickGuard(host) {
  if (!host) return () => {};
  const doc = host.ownerDocument || document;
  let downInside = false;
  const onDown = (e) => { downInside = !!e.target && host.contains(e.target); };
  const onClick = (e) => {
    if (e.detail === 0 || downInside) return;
    e.stopPropagation();
    e.preventDefault();
  };
  doc.addEventListener('pointerdown', onDown, true);
  host.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('pointerdown', onDown, true);
    host.removeEventListener('click', onClick, true);
  };
}

// A key event of a real key (a PC keyboard, Tab included), not an on-screen keyboard's or an IME's
// (Android keyboards report most keys as keyCode 229 'Unidentified', a Korean IME 'Process').
function realKey(e) {
  return !!e && e.keyCode !== 229 && e.key !== 'Unidentified' && e.key !== 'Process' && !e.isComposing;
}

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
    this.penDowns = 0;              // pen pointerdowns so far (installPalmGuard: did the tip come down meanwhile)
    this.penDown = new Set();       // pen pointerIds between pointerdown and pointerup (page-wide)
    this._lastPenType = '';         // type of the last pen event (pointerout of the page excluded)
    this._armed = null;             // { id }: the S Pen side button pressed while hovering over the canvas
    // 'mouse' | 'pen' | 'touch' | 'key': the last pointerdown or real key anywhere on the page (fieldFocusOk).
    this.lastInputKind = 'mouse';
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
    // The kind of the last input (capture: seen before any handler, also on the canvas, which prevents defaults).
    this._onDocInput = (e) => {
      if (e.type === 'keydown') { if (realKey(e)) this.lastInputKind = 'key'; return; }
      this.lastInputKind = e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse';
      lastDown = { seq: ++order, target: e.target };
    };
    document.addEventListener('pointerdown', this._onDocInput, true);
    document.addEventListener('keydown', this._onDocInput, true);
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
    document.removeEventListener('pointerdown', this._onDocInput, true);
    document.removeEventListener('keydown', this._onDocInput, true);
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

  // "Pen near" with a longer window: a pen event within the last `ms` (at least TIMING.penNear), or a pen
  // counted as down. Ended at once like penNear (a pen pointerout leaving the page, not right after a lift).
  penWithin(ms) {
    const until = this.lastPenTime + (this.penDown.size ? PEN_DOWN_HOLD_MS : Math.max(ms, TIMING.penNear));
    return performance.now() < until;
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
    if (type === 'pointerdown') { this.penDown.add(e.pointerId); this.penDowns++; }
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

  // A pen pointer is down (its tip, or a side-button press, anywhere on the page) and still fresh.
  get penIsDown() {
    return this.penDown.size > 0 && this.penNear;
  }
}

// ---- palm guard for the bottom panel (numpad and buttons) --------------------------------------------
// A right hand writing with the S Pen rests its palm at the bottom right, where the numpad is (review
// 2026-10-25: a palm typed '5' while the pen hovered, and pressed [확인 ▶] while the pen tip was on the plan,
// storing a 5 mm wall). The numpad keys act on pointerdown, so on the panel:
//   - while a pen pointer is down, a touch does nothing (not even its click);
//   - while the pen is only near (hovering, or within PANEL_PEN_NEAR_MS of a pen event), a touch is held back
//     and counts as a tap when it lifts, unless it was a palm: a contact larger than PALM_CONTACT_PX (its
//     reported width / height), one that moved past the touch slop, or one during which the pen tip came
//     down. A finger-sized contact (its size reported, as Android does) acts however slowly it is pressed
//     (recheck 2026-10-25: a deliberate 0.9 s press did nothing, and a 50 px palm contact typed '5'), up to
//     PANEL_PRESS_MS (a hand resting there); a contact of unknown size only within PANEL_TAP_MS. A numpad key
//     then acts when the finger lifts (shown pressed meanwhile: .key-held), another button gets its click
//     as usual. A resting palm never acts;
//   - held-back taps act in the order they would with the pen away, where a numpad key acts on its press and
//     another button on its click: a tap that lifts while an earlier key press is still held waits for it
//     (round 4: two rolling finger taps on '5' and '6' typed '65' when '6' lifted first, and [확인 ▶] lifted
//     before '4' stored the value without the 4). An earlier press holds the others up only while it may still
//     be a quick tap (tapMs: a press resting longer does not), and not once it is taken for a palm. A button's
//     waiting click is given again afterwards (a script click, like a keyboard's);
//   - pen away: touches act at once, as before (but after an earlier press still held back). Text fields are
//     left alone (a finger may focus them).
// The pen itself, the mouse and the keyboard are never held back.
// "Pen near" here lasts PANEL_PEN_NEAR_MS after the last pen event, longer than on the plan (TIMING.penNear):
// on the Galaxy Tab S9 FE a pen held still above the screen sends nothing for up to 2.4 s (device test v3,
// 2026-10-29; palm contacts there were at most 17 px, so their size never tells), and a palm landing on the
// numpad then typed at once. A finger loses nothing by it (its tap still acts, on the lift), unlike on the
// plan, where a touch taken for a palm is dropped. A pen leaving the page still ends it at once (penWithin).
export const PANEL_TAP_MS = 700;
export const PANEL_PRESS_MS = 3000;
export const PALM_CONTACT_PX = 40;
export const PANEL_PEN_NEAR_MS = 3000;

export function installPalmGuard(host, input, { tapMs = PANEL_TAP_MS, pressMs = PANEL_PRESS_MS, palmPx = PALM_CONTACT_PX, nearMs = PANEL_PEN_NEAR_MS } = {}) {
  if (!host || !input) return () => {};
  const held = new Map();    // pointerId → { t0, seq, pd, x, y, target, key, palm, sized }
  let swallow = [];          // { x, y, until }: the click a held-back touch would still produce
  let seq = 0;               // touches held back so far: their press order
  let queue = [];            // taps that lifted while an earlier key press was still held: { rank, run }, by rank
  let timer = 0;
  const isField = (t) => !!(t && t.closest && t.closest('input, textarea, select'));
  const block = (x, y) => { swallow.push({ x, y, until: performance.now() + 1000 }); };
  // The contact's size in css px (Chrome reports 1 × 1 when the device does not tell).
  const contact = (e) => Math.max(Number(e.width) || 0, Number(e.height) || 0);
  const show = (h, on) => { if (h.key) h.key.classList.toggle('key-held', on && !h.palm); };
  const penNear = () => (typeof input.penWithin === 'function' ? input.penWithin(nearMs) : input.penNear);
  // Held key presses that act before a tap of this rank (a key's rank: its press; another button's: its lift,
  // after every press so far): pressed before it, still able to be a tap (not taken for a palm, the pen tip not
  // down since), and down for less than tapMs (a press resting longer is a palm or a slow press: it no longer
  // holds the others up).
  const earlier = (rank, now) => [...held.values()].filter((o) => o.key && !o.palm && o.seq < rank && now - o.t0 < tapMs
    && (input.penDowns || 0) === o.pd);
  // Act the waiting taps whose earlier presses are done, in order; check again when the next one runs out.
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    const now = performance.now();
    while (queue.length && !earlier(queue[0].rank, now).length) queue.shift().run();
    if (!queue.length) return;
    const until = Math.min(...earlier(queue[0].rank, now).map((o) => o.t0 + tapMs));
    timer = setTimeout(flush, Math.max(10, until - now + 5));
  };
  const act = (rank, run) => {
    queue.push({ rank, run });
    queue.sort((a, b) => a.rank - b.rank);
    flush();
  };
  const onDown = (e) => {
    if (e.pointerType !== 'touch' || isField(e.target)) return;
    // Pen away: at once, unless an earlier press held back may still act (this one then comes after it).
    if (!penNear() && !queue.length && !earlier(Infinity, performance.now()).length) return;
    e.stopPropagation();
    e.preventDefault();
    const size = contact(e);
    const key = e.target && e.target.closest ? e.target.closest('.key') : null;
    const h = { t0: performance.now(), seq: ++seq, pd: input.penDowns || 0, x: e.clientX, y: e.clientY, target: e.target,
      key: key && host.contains(key) ? key : null, palm: input.penIsDown || size > palmPx, sized: size > 1.5 };
    held.set(e.pointerId, h);
    show(h, true);
  };
  const onMove = (e) => {
    const h = held.get(e.pointerId);
    if (!h) return;
    e.stopPropagation();
    if (!h.palm && (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= TAP_SLOP_PX.touch || contact(e) > palmPx || input.penIsDown)) {
      h.palm = true;
      show(h, false);
      flush();   // a palm holds no tap up
    }
  };
  const onUp = (e) => {
    const h = held.get(e.pointerId);
    if (!h) return;
    held.delete(e.pointerId);
    show(h, false);
    e.stopPropagation();
    const now = performance.now();
    const dt = now - h.t0;
    const penCame = (input.penDowns || 0) !== h.pd;   // the pen tip came down while this touch was held
    const tap = !h.palm && !penCame && !input.penIsDown && dt <= (h.sized ? pressMs : tapMs);
    const key = h.key;
    if (tap && key) {
      // A finger tap while the pen hovers: the numpad key acts now, or after the keys pressed before it (a
      // script click: detail 0, which the Numpad takes like a keyboard activation); the touch's own click is
      // swallowed.
      block(h.x, h.y);
      act(h.seq, () => { if (!key.disabled && key.isConnected) key.click(); });
    } else if (tap && (queue.length || earlier(seq + 0.5, now).length)) {
      // Another button (a value field, [✕ 닫기] …) while an earlier key press waits: its click comes after it, on
      // what is under the finger then (each key draws the panel anew), as its own click would with the pen away.
      block(h.x, h.y);
      const x = e.clientX, y = e.clientY;
      act(seq + 0.5, () => {
        const el = (host.ownerDocument || document).elementFromPoint(x, y);
        if (el && host.contains(el) && typeof el.click === 'function') el.click();
      });
    } else {
      // Another button's tap gets its own click as usual; a palm's is swallowed.
      if (!tap) block(h.x, h.y);
      flush();
    }
  };
  const onCancel = (e) => {
    const h = held.get(e.pointerId);
    if (!h) return;
    held.delete(e.pointerId);
    show(h, false);
    block(h.x, h.y);
    flush();
  };
  const onClick = (e) => {
    if (e.detail === 0) return;   // a script or keyboard click (el.click(), Enter / Space)
    const now = performance.now();
    swallow = swallow.filter((s) => s.until > now);
    const i = swallow.findIndex((s) => Math.hypot(e.clientX - s.x, e.clientY - s.y) <= 40);
    if (i < 0) return;
    swallow.splice(i, 1);
    e.stopPropagation();
    e.preventDefault();
  };
  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);
  host.addEventListener('pointercancel', onCancel, true);
  host.addEventListener('click', onClick, true);
  return () => {
    clearTimeout(timer);
    queue = [];
    host.removeEventListener('pointerdown', onDown, true);
    host.removeEventListener('pointermove', onMove, true);
    host.removeEventListener('pointerup', onUp, true);
    host.removeEventListener('pointercancel', onCancel, true);
    host.removeEventListener('click', onClick, true);
  };
}
