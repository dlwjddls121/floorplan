// Bottom panels of the editor (dev/DESIGN.md §5, plan §2-4, §4):
//   - length panel + numpad for a tapped wall ("방1 쪽 [ 2,900 ] / 거실 쪽 [      ]")
//   - wall-thickness entry (the [두께] button)
//   - room panel (the current name with [이름 바꾸기] (on-screen keyboard), name presets with
//     auto-numbering, H with the numpad, [실 아님(설비)]); a tap on a room's name on the plan opens it
//     with the name field already open
//   - rectangle-size panel for the 실 추가 tool (가로 × 세로, [그대로])
// The file also hosts small DOM helpers shared by the UI: el(), Toaster and openDialog().
//
// PanelController keeps the editor selection (which wall / room / side is active), because the
// selection is exactly what the open panel is about. The editor reads `highlight` when drawing.
import { sidesForEdge } from '../core/rooms.js';
import { wallThickness } from '../core/openings.js';
import { ROOM_PRESETS, formatMM, TIMING } from './theme.js';

// ---- DOM helpers -------------------------------------------------------------------------------

// el('button', { class: 'x', onclick: fn, disabled: true }, 'text', childNode, ...)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export class Toaster {
  constructor(host) {
    this.host = host;
  }

  // type: 'info' | 'ok' | 'warn' | 'error'
  show(message, { type = 'info', ms = TIMING.toast, action = null } = {}) {
    const item = el('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
    if (action) {
      item.append(el('button', {
        class: 'toast-action',
        type: 'button',
        onclick: () => { action.run(); remove(); },
      }, action.label));
    }
    this.host.append(item);
    while (this.host.children.length > 3) this.host.firstElementChild.remove();
    let timer = 0;
    const remove = () => {
      clearTimeout(timer);
      item.classList.add('toast-out');
      setTimeout(() => item.remove(), 250);
    };
    if (ms > 0) timer = setTimeout(remove, type === 'error' ? ms * 2 : ms);
    item.addEventListener('click', (e) => { if (e.target === item) remove(); });
    return remove;
  }
}

// Modal dialog. Resolves { button: value | null (dismissed), values: { fieldName: string } }.
//   openDialog({ title, message, fields: [{ name, label, value, placeholder, type }],
//                buttons: [{ label, value, kind: 'primary' | 'danger' | '' }] })
export function openDialog({ title = '', message = '', fields = [], buttons = [{ label: '확인', value: 'ok', kind: 'primary' }] } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const form = el('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    if (title) form.append(el('h2', { class: 'dialog-title' }, title));
    if (message) {
      for (const line of String(message).split('\n')) form.append(el('p', { class: 'dialog-msg' }, line));
    }
    for (const f of fields) {
      const input = el('input', {
        class: 'dialog-input',
        type: f.type || 'text',
        name: f.name,
        value: f.value ?? '',
        placeholder: f.placeholder || '',
        autocomplete: 'off',
      });
      inputs[f.name] = input;
      form.append(el('label', { class: 'dialog-field' }, el('span', {}, f.label || ''), input));
    }
    const row = el('div', { class: 'dialog-buttons' });
    let defaultValue = null;
    for (const b of buttons) {
      if (b.kind === 'primary' && defaultValue == null) defaultValue = b.value;
      row.append(el('button', {
        type: 'button',
        class: `btn ${b.kind ? 'btn-' + b.kind : ''}`,
        onclick: () => finish(b.value),
      }, b.label));
    }
    form.append(row);
    const backdrop = el('div', { class: 'dialog-backdrop' }, form);
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve({ button: value, values: values() });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(defaultValue); });
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) finish(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    const first = Object.values(inputs)[0];
    if (first) { first.focus(); first.select(); }
    else row.lastElementChild && row.querySelector('.btn-primary')?.focus();
  });
}

// ---- numpad ------------------------------------------------------------------------------------

// Emits keys: '0'..'9', 'back', 'plus', 'clear', 'ok'.
export class Numpad {
  constructor(onKey) {
    this.onKey = onKey;
    const keys = [
      ['7', '7'], ['8', '8'], ['9', '9'], ['back', '⌫'],
      ['4', '4'], ['5', '5'], ['6', '6'], ['plus', '+'],
      ['1', '1'], ['2', '2'], ['3', '3'], ['clear', 'C'],
      ['0', '0'], ['ok', '확인 ▶'],
    ];
    this.buttons = {};
    this.element = el('div', { class: 'numpad', role: 'group', 'aria-label': '숫자패드' });
    for (const [key, label] of keys) {
      const b = el('button', {
        type: 'button',
        class: `key key-${key}`,
        dataset: { key },
        'aria-label': { back: '한 글자 지우기', plus: '더하기', clear: '모두 지우기', ok: '확인하고 다음' }[key] || label,
      }, label);
      // pointerdown keeps the canvas selection and gives an immediate response on touch.
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!b.disabled) this.onKey(key);
      });
      b.addEventListener('click', (e) => {
        // Keyboard activation (Enter/Space on a focused key) arrives as a click with detail 0.
        if (e.detail === 0 && !b.disabled) this.onKey(key);
      });
      this.buttons[key] = b;
      this.element.append(b);
    }
  }

  setPlusEnabled(on) {
    this.buttons.plus.disabled = !on;
  }

  setOkLabel(label) {
    this.buttons.ok.textContent = label;
  }
}

// ---- number entry buffer -----------------------------------------------------------------------

// Text being typed into the active field, e.g. "1600+1950".
class EntryBuffer {
  constructor() {
    this.reset('');
  }

  reset(initial = '') {
    this.text = initial;
    this.edited = false;
  }

  key(k, allowPlus) {
    if (/^[0-9]$/.test(k)) {
      const lastPart = this.text.split('+').pop();
      if (lastPart.length >= 6) return;
      if (k === '0' && lastPart === '') { /* allow leading zero to be ignored */ }
      this.text += k;
      this.edited = true;
    } else if (k === 'back') {
      this.text = this.text.slice(0, -1);
      this.edited = true;
    } else if (k === 'plus' && allowPlus) {
      // '+' on an empty field does nothing: a stray tap must not turn into "clear this value".
      if (this.text && !this.text.endsWith('+')) {
        this.text += '+';
        this.edited = true;
      }
    } else if (k === 'clear') {
      this.text = '';
      this.edited = true;
    }
  }

  // → { parts: [numbers], value } or null when empty / invalid.
  parse() {
    const parts = this.text.split('+').filter((s) => s !== '').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    if (!parts.length) return null;
    return { parts, value: parts.reduce((a, b) => a + b, 0) };
  }
}

// ---- panel controller ------------------------------------------------------------------------

export class PanelController {
  // ctx: {
  //   store()               -> current DocStore
  //   command(fn, label)    -> runs a store command with error handling; true on success, false on failure
  //   toast(msg, opts)
  //   onChange()            -> selection or panel changed (redraw, resize canvas)
  //   focusWorld(points)    -> make sure these world points are visible above the panel
  //   roomLabel(roomId)     -> display name for a room
  //   holdView(anchor, run) -> optional: run() (a command that re-solves the plan) while the view keeps
  //                            the world point anchor() on the same screen spot (main.js)
  // }
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.state = null;  // { mode: 'edge'|'thickness'|'room'|'rect', ... }
    this.round = null;  // [확인 ▶] round through one room: { roomId, startKey }
    this.buffer = new EntryBuffer();
    this.numpad = new Numpad((k) => this.onNumpad(k));
    this.host.hidden = true;
  }

  get isOpen() {
    return !!this.state;
  }

  get mode() {
    return this.state ? this.state.mode : null;
  }

  // What the renderer should highlight.
  get highlight() {
    const s = this.state;
    if (!s) return { selectedEdges: null, activeSide: null };
    if (s.mode === 'edge' || s.mode === 'thickness') {
      const f = s.fields && s.fields[s.active];
      return {
        selectedEdges: [s.edgeId],
        activeSide: s.mode === 'edge' && f ? { roomId: f.roomId, sideKey: f.sideKey } : null,
      };
    }
    return { selectedEdges: null, activeSide: null };
  }

  get selectedEdgeId() {
    const s = this.state;
    return s && (s.mode === 'edge' || s.mode === 'thickness') ? s.edgeId : null;
  }

  get selectedRoomId() {
    const s = this.state;
    return s && s.mode === 'room' ? s.roomId : null;
  }

  // ---- open / close ------------------------------------------------------------------------

  // Open the length panel for a wall. `prefer` selects the active field (▶):
  //   { roomId, sideKey }  that side ([확인 ▶] round, the 검사 list);
  //   { at, roomId? }      a tap at world point `at`: the room on the TAPPED side of the wall (see
  //                        _fieldAt); roomId (the room being measured) only counts for a tap right on
  //                        the wall band.
  // Without either: the first side of the tapped wall piece.
  openEdge(edgeId, prefer = null) {
    this._flushNameDraft();
    const store = this.ctx.store();
    const fields = this._buildFields(store, edgeId);
    let active = -1;
    if (prefer && prefer.at) {
      active = this._fieldAt(store, edgeId, fields, prefer.at, prefer.roomId || null);
    } else if (prefer && prefer.roomId) {
      active = fields.findIndex((f) => f.roomId === prefer.roomId && (!prefer.sideKey || f.sideKey === prefer.sideKey));
      if (active < 0) active = fields.findIndex((f) => f.roomId === prefer.roomId);
    }
    if (active < 0) active = firstPrimary(fields);
    this.state = { mode: 'edge', edgeId, fields, active };
    this.round = null;   // the [확인 ▶] round restarts from the next confirmed side
    this.buffer.reset('');
    this._render();
  }

  // opts.editName: open the name field right away (prefilled, selected, keyboard up).
  openRoom(roomId, { editName = false } = {}) {
    this._flushNameDraft();
    this.state ={ mode: 'room', roomId, customOpen: !!editName, focusCustom: !!editName };
    const room = this._room(roomId);
    this.buffer.reset('');
    if (!room) return this.close();
    this._render();
  }

  // [이름 바꾸기]: open (or close) the name field.
  _toggleNameField() {
    const s = this.state;
    if (!s || s.mode !== 'room') return;
    s.customOpen = !s.customOpen;
    s.focusCustom = s.customOpen;
    s.nameDraft = null;   // closing the field with [이름 바꾸기] is a 취소
    this._render();
  }

  // rect = { a, b } world corners as drawn; onConfirm(w, h, typed: { w, h }) creates the room
  // (typed tells which sizes were entered on the numpad, i.e. are real measurements).
  openRect(rect, onConfirm, onCancel) {
    this._flushNameDraft();
    const w = roundTo(Math.abs(rect.b.x - rect.a.x), 10);
    const h = roundTo(Math.abs(rect.b.y - rect.a.y), 10);
    this.state = { mode: 'rect', rect, drawn: { w, h }, values: [null, null], active: 0, onConfirm, onCancel };
    this.buffer.reset('');
    this._render();
  }

  // A room name typed but not applied yet is kept when the panel closes or moves on (the surveyor
  // typed it and tapped elsewhere instead of [적용]). An empty draft changes nothing.
  _flushNameDraft() {
    const s = this.state;
    if (!s || s.mode !== 'room' || !s.customOpen || s.nameDraft == null) return;
    const name = String(s.nameDraft).trim().slice(0, 40);
    s.nameDraft = null;
    const room = this._room(s.roomId);
    if (room && name && (room.name || '') !== name) {
      this._setRoomFields(s.roomId, { name }, '실 이름');
      this.ctx.toast(`실 이름을 '${name}'(으)로 바꿨습니다.`, { type: 'ok' });
    }
  }

  close() {
    this._flushNameDraft();
    const s = this.state;
    this.state = null;
    this.host.hidden = true;
    this.host.replaceChildren();
    if (s && s.mode === 'rect' && s.onCancel) s.onCancel();
    this.ctx.onChange();
  }

  // Called by the editor after every store change (undo, redo, commands from elsewhere).
  refresh() {
    const s = this.state;
    if (!s) return;
    const store = this.ctx.store();
    if (s.mode === 'edge' || s.mode === 'thickness') {
      if (!store.project.edges.some((e) => e.id === s.edgeId)) return this.close();
      const cur = s.fields[s.active];
      s.fields = this._buildFields(store, s.edgeId);
      const i = cur ? s.fields.findIndex((f) => f.roomId === cur.roomId && f.sideKey === cur.sideKey) : -1;
      s.active = i >= 0 ? i : firstPrimary(s.fields);
    } else if (s.mode === 'room') {
      if (!this._room(s.roomId)) return this.close();
    }
    this._render();
  }

  // ---- keyboard (PC) ----------------------------------------------------------------------

  // Returns true when the key was used.
  handleKey(e) {
    const s = this.state;
    if (!s) return false;
    if (s.mode === 'room' && s.customOpen) return false;
    const k = e.key;
    let key = null;
    if (/^[0-9]$/.test(k)) key = k;
    else if (k === 'Backspace') key = 'back';
    else if (k === '+' || (k === '=' && e.shiftKey)) key = 'plus';
    else if (k === 'Enter') key = 'ok';
    else if (k === 'Tab' && (s.mode === 'edge' || s.mode === 'rect')) {
      this._cycleField(e.shiftKey ? -1 : 1);
      return true;
    }
    if (!key) return false;
    if (key === 'plus' && this.numpad.buttons.plus.disabled) return true;
    this.onNumpad(key);
    return true;
  }

  // ---- numpad ----------------------------------------------------------------------------------

  onNumpad(key) {
    const s = this.state;
    if (!s) return;
    if (key === 'ok') {
      if (s.mode === 'edge') this._confirmLength();
      else if (s.mode === 'thickness') this._confirmThickness();
      else if (s.mode === 'room') this._confirmHeight();
      else if (s.mode === 'rect') this._confirmRect();
      return;
    }
    if (key === 'back' && !this.buffer.edited && !this.buffer.text) {
      // Start editing from the stored value, like a normal text field.
      const cur = this._currentValueText();
      if (cur) this.buffer.reset(cur);
    }
    this.buffer.key(key, s.mode === 'edge');
    this._render();
  }

  _currentValueText() {
    const s = this.state;
    const store = this.ctx.store();
    if (s.mode === 'edge') {
      const f = s.fields[s.active];
      const m = f && this._measure(store, f.roomId, f.sideKey);
      if (!m || m.value == null) return '';
      return (m.parts && m.parts.length > 1 ? m.parts : [m.value]).map((n) => String(Math.round(n))).join('+');
    }
    if (s.mode === 'thickness') {
      const edge = store.project.edges.find((e) => e.id === s.edgeId);
      return edge && edge.thickness != null ? String(edge.thickness) : '';
    }
    if (s.mode === 'room') {
      const room = this._room(s.roomId);
      return room && room.height != null ? String(room.height) : '';
    }
    if (s.mode === 'rect') {
      const v = s.values[s.active] ?? (s.active === 0 ? s.drawn.w : s.drawn.h);
      return v ? String(v) : '';
    }
    return '';
  }

  _cycleField(step) {
    const s = this.state;
    if (s.mode === 'edge' && s.fields.length) {
      s.active = (s.active + step + s.fields.length) % s.fields.length;
    } else if (s.mode === 'rect') {
      s.active = s.active ? 0 : 1;
    }
    this.buffer.reset('');
    this._render();
  }

  // ---- length entry --------------------------------------------------------------------------

  _confirmLength() {
    const s = this.state;
    const f = s.fields[s.active];
    if (!f) {
      this.ctx.toast('이 벽에는 아직 실이 없습니다. 벽으로 둘러싸면 실이 생깁니다.', { type: 'warn' });
      return;
    }
    const store = this.ctx.store();
    const parsed = this.buffer.parse();
    // The solve moves the walls (the first values even rescale the whole sketch): the measured side
    // stays where the surveyor is looking (#26).
    const anchor = () => sideMid(this.ctx.store(), f.roomId, f.sideKey);
    if (this.buffer.edited) {
      if (parsed) {
        if (parsed.value > 100000) {
          this.ctx.toast('값이 너무 큽니다. mm 단위로 넣어 주세요.', { type: 'warn' });
          return;
        }
        if (!this._hold(anchor, () => this.ctx.command(() => store.setMeasure(f.roomId, f.sideKey, parsed.value, parsed.parts), '길이 입력'))) return;
      } else {
        this._hold(anchor, () => this.ctx.command(() => store.setMeasure(f.roomId, f.sideKey, null, []), '길이 지우기'));
      }
    }
    this._advance(f.roomId, f.sideKey);
  }

  // Run a command that re-solves the plan while the view keeps anchor() (a world point, computed
  // before and after the command) on the same screen spot (ctx.holdView, main.js). → run()'s result
  _hold(anchor, run) {
    return this.ctx.holdView ? this.ctx.holdView(anchor, run) : run();
  }

  // Move on after [확인 ▶] (plan §2-4): the next side of the same room, clockwise, for one full round
  // starting from the side where the round began; then a neighbouring room that still has a side
  // without a value (then any such room). Sides that are already fixed by the measured opposite side
  // are visited too (their field says "맞은편 값으로 정해짐", so one more [확인 ▶] skips them, and a
  // worker who measures both opposite walls can enter both). Sides made only of dividers are skipped.
  _advance(roomId, sideKey) {
    const store = this.ctx.store();
    const needs = needsInputFn(store);
    if (!this.round || this.round.roomId !== roomId) this.round = { roomId, startKey: sideKey };
    const room = ((store.derived && store.derived.rooms) || []).find((r) => r.roomId === roomId);
    const sides = (room && room.sides) || [];
    let key = sideKey;
    for (let i = 0; i < sides.length; i++) {
      let next = null;
      try {
        next = store.nextSide(roomId, key);
      } catch (err) {
        console.error(err);
      }
      if (!next || next === this.round.startKey || next === sideKey) break; // round complete
      const side = sides.find((s) => s.key === next);
      if (side && !side.allDivider) {
        this._goToSide(roomId, next);
        return;
      }
      key = next;
    }
    const target = this._nextRoomTarget(store, roomId, needs);
    if (target) {
      this.ctx.toast(`${this.ctx.roomLabel(roomId)} 끝. 다음: ${this.ctx.roomLabel(target.roomId)}`, { type: 'ok' });
      this.round = { roomId: target.roomId, startKey: target.sideKey };
      this._goToSide(target.roomId, target.sideKey);
      return;
    }
    this.ctx.toast('길이를 넣어야 할 벽이 더 없습니다.', { type: 'ok' });
    let next = null;
    try { next = store.nextSide(roomId, sideKey); } catch (_) { next = null; }
    this.round = next ? { roomId, startKey: next } : null;
    if (next) this._goToSide(roomId, next);
    else this.refresh();
  }

  _goToSide(roomId, sideKey) {
    const store = this.ctx.store();
    const side = findSide(store.derived, roomId, sideKey);
    if (!side || !side.edgeIds || !side.edgeIds.length) {
      this.refresh();
      return;
    }
    const edgeId = side.edgeIds[Math.floor((side.edgeIds.length - 1) / 2)];
    const round = this.round;   // openEdge starts a new round (a tap by the user); this is not one
    this.openEdge(edgeId, { roomId, sideKey });
    this.round = round;
    const pts = sidePoints(store.project, side);
    if (pts.length) this.ctx.focusWorld(pts);
  }

  // A neighbouring room (sharing a wall) with a side that needs a value, else any such room.
  _nextRoomTarget(store, roomId, needs) {
    const derived = store.derived;
    const rooms = (derived && derived.rooms) || [];
    const firstOpen = (r) => {
      if (!r || !r.sides || (r.room && r.room.notRoom)) return null;
      const side = r.sides.find((sd) => needs(r.roomId, sd.key));
      return side ? { roomId: r.roomId, sideKey: side.key } : null;
    };
    const current = rooms.find((r) => r.roomId === roomId);
    const neighbours = [];
    if (current && current.sides) {
      for (const side of current.sides) {
        for (const eid of side.edgeIds || []) {
          for (const q of safeSidesForEdge(derived, eid)) {
            if (q.roomId !== roomId && !neighbours.includes(q.roomId)) neighbours.push(q.roomId);
          }
        }
      }
    }
    for (const id of neighbours) {
      const t = firstOpen(rooms.find((r) => r.roomId === id));
      if (t) return t;
    }
    for (const r of rooms) {
      if (r.roomId === roomId) continue;
      const t = firstOpen(r);
      if (t) return t;
    }
    return null;
  }

  _toggleCheck() {
    const s = this.state;
    const f = s.fields[s.active];
    const store = this.ctx.store();
    if (!f) {
      this.ctx.command(() => store.toggleWallCheck(s.edgeId), '확인필요');
      this.refresh();
      return;
    }
    const m = this._measure(store, f.roomId, f.sideKey);
    const on = !(m && m.check);
    this.ctx.command(() => store.setMeasureCheck(f.roomId, f.sideKey, on), '확인필요');
    this.ctx.toast(on ? '확인필요로 표시했습니다.' : '확인필요를 해제했습니다.', { type: on ? 'warn' : 'ok' });
    if (on && !(m && m.value != null) && !this.buffer.edited) {
      // The value is unknown: move on, like [확인 ▶].
      this._advance(f.roomId, f.sideKey);
    } else {
      this.refresh();
    }
  }

  deleteWall() {
    const s = this.state;
    const store = this.ctx.store();
    const edgeId = s.edgeId;
    this.state = null;
    this.ctx.command(() => store.deleteEdge(edgeId), '벽 지우기');
    this.close();
    // The wall's own values go with it (drawn again, it starts without values); the other walls' values
    // stay, and the ones whose side is open now come back when the wall is drawn again (DESIGN.md §7.7).
    const dropped = (store.lastDropped || []).length, waiting = (store.lastDetached || []).length;
    let msg = '지웠습니다.';
    if (dropped) msg += ` 이 벽의 길이 값 ${dropped}개도 지웠습니다.`;
    if (waiting) msg += ` 다른 벽의 길이 값 ${waiting}개는 그대로 두었다가, 벽을 다시 그려 방이 닫히면 다시 보입니다.`;
    this.ctx.toast(`${msg} ↶ 버튼으로 되돌릴 수 있습니다.`, {
      action: { label: '되돌리기', run: () => this.ctx.command(() => this.ctx.store().undo(), '되돌리기') },
    });
  }

  // ---- thickness entry ---------------------------------------------------------------------

  _openThickness() {
    const s = this.state;
    s.mode = 'thickness';
    this.buffer.reset('');
    this._render();
  }

  _backToLength() {
    const s = this.state;
    s.mode = 'edge';
    this.buffer.reset('');
    this.refresh();
  }

  _confirmThickness() {
    const s = this.state;
    const store = this.ctx.store();
    const parsed = this.buffer.parse();
    // A thickness moves the walls too: the wall stays where it is on screen.
    const anchor = () => edgeMid(this.ctx.store(), s.edgeId);
    if (this.buffer.edited) {
      if (parsed) {
        if (parsed.value < 10 || parsed.value > 1500) {
          this.ctx.toast('벽 두께는 10~1500mm 사이로 넣어 주세요.', { type: 'warn' });
          return;
        }
        this._hold(anchor, () => this.ctx.command(() => store.setWallThickness(s.edgeId, parsed.value), '벽 두께'));
        this.ctx.toast(`벽 두께 ${formatMM(parsed.value)}mm (실측)로 기록했습니다.`, { type: 'ok' });
      } else {
        this._hold(anchor, () => this.ctx.command(() => store.setWallThickness(s.edgeId, null), '벽 두께'));
      }
    }
    this._backToLength();
  }

  _resetThickness() {
    const s = this.state;
    const store = this.ctx.store();
    this._hold(() => edgeMid(this.ctx.store(), s.edgeId), () => this.ctx.command(() => store.setWallThickness(s.edgeId, null), '벽 두께'));
    this.ctx.toast('벽 두께를 자동(가정값)으로 되돌렸습니다.', { type: 'ok' });
    this._backToLength();
  }

  // ---- room panel ----------------------------------------------------------------------------

  _setRoomFields(roomId, patch, label = '실 정보') {
    const store = this.ctx.store();
    const room = this._room(roomId);
    if (!room) return;
    const next = { name: room.name || '', height: room.height ?? null, notRoom: !!room.notRoom, ...patch };
    this.ctx.command(() => store.setRoom(roomId, next), label);
  }

  // Several renames as one undo step (one ↶ undoes the whole chip tap).
  _renameRooms(pairs) {
    const store = this.ctx.store();
    // A name that does not change is no undo step.
    const cur = new Map(this._allRooms().map((r) => [r.id, r.name || '']));
    const updates = pairs.filter(([id, name]) => cur.get(id) !== name).map(([id, name]) => ({ id, patch: { name } }));
    if (updates.length) this.ctx.command(() => store.setRooms(updates), '실 이름');
    return updates.length > 0;
  }

  _choosePreset(base) {
    const s = this.state;
    s.customOpen = false;
    s.nameDraft = null;
    const rooms = this._allRooms();
    const pairs = presetNameUpdates(rooms, s.roomId, base);
    if (this._renameRooms(pairs)) {
      // Other rooms renamed with it (a numbered preset): say what they became.
      if (splitName(base).num != null) {
        const said = pairs.filter(([id]) => id !== s.roomId).map(([id, name]) => {
          const was = rooms.find((r) => r.id === id);
          return was && was.name !== name ? `'${was.name || '이름 없음'}'이던 다른 실은 '${name || '이름 없음'}'(으)로` : null;
        }).filter(Boolean);
        if (said.length) this.ctx.toast(`${said.join(', ')} 바꿨습니다.`, { type: 'ok' });
      }
    }
    this.refresh();
  }

  _chooseNumber(n) {
    const s = this.state;
    const room = this._room(s.roomId);
    if (!room) return;
    const { base } = splitName(room.name || '');
    if (!base) return;
    const target = `${base}${n}`;
    if (room.name === target) return;
    const other = this._allRooms().find((r) => r.id !== s.roomId && r.name === target);
    const pairs = other ? [[other.id, room.name], [s.roomId, target]] : [[s.roomId, target]];
    this._renameRooms(pairs);
    this.refresh();
  }

  _applyCustomName(text) {
    const s = this.state;
    s.customOpen = false;
    s.nameDraft = null;
    const name = String(text || '').trim().slice(0, 40);
    const room = this._room(s.roomId);
    if (room && (room.name || '') !== name) {
      this._setRoomFields(s.roomId, { name }, '실 이름');
      this.ctx.toast(name ? `실 이름을 '${name}'(으)로 바꿨습니다.` : '실 이름을 지웠습니다.', { type: 'ok' });
    }
    this.refresh();
  }

  _toggleNotRoom() {
    const s = this.state;
    const room = this._room(s.roomId);
    if (!room) return;
    this._setRoomFields(s.roomId, { notRoom: !room.notRoom }, '실 아님');
    this.refresh();
  }

  _confirmHeight() {
    const s = this.state;
    const parsed = this.buffer.parse();
    if (this.buffer.edited) {
      if (parsed) {
        if (parsed.value < 500 || parsed.value > 10000) {
          this.ctx.toast('천장고는 500~10000mm 사이로 넣어 주세요.', { type: 'warn' });
          return;
        }
        this._setRoomFields(s.roomId, { height: parsed.value }, '천장고');
        this.ctx.toast(`천장고 H ${formatMM(parsed.value)}mm로 넣었습니다.`, { type: 'ok' });
      } else {
        this._setRoomFields(s.roomId, { height: null }, '천장고');
      }
    }
    this.buffer.reset('');
    this.refresh();
  }

  // ---- rectangle size ------------------------------------------------------------------------

  _confirmRect() {
    const s = this.state;
    const parsed = this.buffer.parse();
    if (this.buffer.edited) s.values[s.active] = parsed ? parsed.value : null;
    this.buffer.reset('');
    if (s.active === 0) {
      s.active = 1;
      this._render();
      return;
    }
    this._finishRect(false);
  }

  // [만들기] and [그대로] both use the typed sizes; a side without a typed size keeps the drawn size.
  // ([그대로] also takes a number still being typed in the active field.)
  _finishRect(fromButton = false) {
    const s = this.state;
    if (fromButton && this.buffer.edited) {
      const parsed = this.buffer.parse();
      s.values[s.active] = parsed ? parsed.value : null;
      this.buffer.reset('');
    }
    const w = s.values[0] ?? s.drawn.w;
    const h = s.values[1] ?? s.drawn.h;
    if (!(w >= 300 && h >= 300)) {
      this.ctx.toast('가로·세로는 300mm 이상이어야 합니다.', { type: 'warn' });
      this._render();
      return;
    }
    const onConfirm = s.onConfirm;
    const typed = { w: s.values[0] != null, h: s.values[1] != null };
    this.state = null;
    this.host.hidden = true;
    this.host.replaceChildren();
    onConfirm(w, h, typed);
    this.ctx.onChange();
  }

  // ---- data helpers ------------------------------------------------------------------------

  _room(roomId) {
    const store = this.ctx.store();
    return (store.project.rooms || []).find((r) => r.id === roomId) || null;
  }

  // Rooms that currently exist as faces (fall back to all stored rooms).
  _allRooms() {
    const store = this.ctx.store();
    const derived = store.derived;
    if (derived && Array.isArray(derived.rooms) && derived.rooms.length) {
      return derived.rooms.map((r) => r.room).filter(Boolean);
    }
    return store.project.rooms || [];
  }

  // The typed measure of a side, else the value the engine computed for it from where a 구역 나누기 선
  // cuts a measured side (derived.computedMeasures, `computed: true`; typing a value replaces it).
  _measure(store, roomId, sideKey) {
    let flagOnly = null;
    for (const m of store.project.measures || []) {
      if (m.room === roomId && [m.from, m.to].sort().join('-') === sideKey) {
        if (m.value != null) return m;
        flagOnly = m;
      }
    }
    const computed = (store.derived && Array.isArray(store.derived.computedMeasures)) ? store.derived.computedMeasures : [];
    const c = computed.find((m) => m && m.room === roomId && m.value != null && [m.from, m.to].sort().join('-') === sideKey);
    if (c) return flagOnly ? { ...c, check: !!flagOnly.check } : c;
    return flagOnly;
  }

  // Fields for the length panel: every room side touching the tapped wall, plus the sides of other
  // rooms that share any wall of those sides (plan §2-4: "방2 쪽 [2600] / 반대쪽: 주방 [400] · 화장실1 [2160]").
  // Fields are grouped by which side of the wall the room is on: group 0 = above / left, and keep
  // that order on screen (the row reads like the plan). `primary` marks the sides that contain the
  // tapped wall piece itself; only those are chosen by a tap (_fieldAt, firstPrimary).
  _buildFields(store, edgeId) {
    const derived = store.derived;
    const edge = store.project.edges.find((e) => e.id === edgeId);
    if (!edge || !derived) return [];
    const nodes = new Map(store.project.nodes.map((n) => [n.id, n]));
    const a = nodes.get(edge.a), b = nodes.get(edge.b);
    const horizontal = a && b ? Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) : true;
    const fields = [];
    const seen = new Set();
    const add = ({ roomId, side }, primary) => {
      if (!side) return;
      const key = `${roomId}|${side.key}`;
      if (seen.has(key)) return;
      seen.add(key);
      const n = side.inwardNormal || { x: 0, y: 0 };
      // Room above a horizontal wall: its inward normal points up (y < 0) -> group 0.
      const group = horizontal ? (n.y < 0 ? 0 : 1) : (n.x < 0 ? 0 : 1);
      const pts = sidePoints(store.project, side);
      const pos = pts.length === 2 ? (horizontal ? (pts[0].x + pts[1].x) / 2 : (pts[0].y + pts[1].y) / 2) : 0;
      fields.push({ roomId, sideKey: side.key, side, group, pos, primary });
    };
    const primary = safeSidesForEdge(derived, edgeId);
    primary.forEach((x) => add(x, true));
    for (const p of primary) {
      for (const eid of p.side.edgeIds || []) {
        if (eid === edgeId) continue;
        safeSidesForEdge(derived, eid).forEach((x) => add(x, false));
      }
    }
    fields.sort((f, g) => f.group - g.group || f.pos - g.pos);
    return fields;
  }

  // The field a tap at world point `at` on wall `edgeId` activates (C5), or -1: the room on the
  // TAPPED side. Only the sides containing the tapped piece take part — a room that merely shares
  // the line further along (현관 above the tapped lower part of 거실's left wall) never gets the ▶,
  // and neither does the room measured before when it is not at this piece (예시 세대 A test: 8 of 22 taps
  // put the ▶ in another room, when the order was 'top / left first, else the previous room').
  // A tap beyond a room's wall face (its finish counts as wall) picks that room. A tap on the wall
  // band itself keeps `roomId` (the room being measured) when it is at this piece, else the side the
  // tap leans to.
  _fieldAt(store, edgeId, fields, at, roomId) {
    const edge = store.project.edges.find((e) => e.id === edgeId);
    const A = edge && store.project.nodes.find((n) => n.id === edge.a);
    if (!A || !at || !isFinite(at.x) || !isFinite(at.y)) return -1;
    let half = 0;
    try { half = wallThickness(store.project, store.derived, edge) / 2; } catch (_) { half = 0; }
    const finish = store.derived && store.derived.solve && store.derived.solve.finish;
    let lean = -1, leanD = -Infinity;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f.primary) continue;
      const n = f.side.inwardNormal || { x: 0, y: 0 };
      const d = (at.x - A.x) * n.x + (at.y - A.y) * n.y;
      const fin = finish && typeof finish.get === 'function' ? Math.max(0, finish.get(`${f.roomId}:${f.side.key}`) || 0) : 0;
      if (d > half + fin) return i;
      if (d > leanD) { leanD = d; lean = i; }
    }
    if (roomId) {
      const j = fields.findIndex((f) => f.primary && f.roomId === roomId);
      if (j >= 0) return j;
    }
    return lean;
  }

  // ---- rendering ------------------------------------------------------------------------------

  _render() {
    const s = this.state;
    if (!s) return;
    this.host.hidden = false;
    let body;
    if (s.mode === 'edge') body = this._renderEdge();
    else if (s.mode === 'thickness') body = this._renderThickness();
    else if (s.mode === 'room') body = this._renderRoom();
    else body = this._renderRect();
    this.host.replaceChildren(body);
    this.ctx.onChange();
  }

  _closeButton() {
    return el('button', { type: 'button', class: 'btn btn-ghost panel-close', 'aria-label': '닫기', onclick: () => this.close() }, '✕ 닫기');
  }

  _valueBox(text, { active = false, placeholder = '', sub = '', onclick = null, flag = '', computed = false } = {}) {
    return el('button', {
      type: 'button',
      class: `field ${active ? 'field-active' : ''} ${computed ? 'field-computed' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
      onclick,
    },
    el('span', { class: 'field-mark' }, active ? '▶' : ''),
    el('span', { class: `field-value ${text ? '' : 'field-empty'}` }, text || placeholder || ' '),
    flag ? el('span', { class: 'field-flag' }, flag) : null,
    sub ? el('span', { class: 'field-sub' }, sub) : null);
  }

  _bufferDisplay() {
    const t = this.buffer.text;
    if (!t) return '';
    const parsed = this.buffer.parse();
    if (t.includes('+') && parsed) return `${t.split('+').map((x) => x ? formatMM(+x) : '').join('+')} = ${formatMM(parsed.value)}`;
    return formatMM(+t);
  }

  _renderEdge() {
    const s = this.state;
    const store = this.ctx.store();
    const edge = store.project.edges.find((e) => e.id === s.edgeId);
    const isDivider = edge && edge.kind === 'divider';
    // A diagonal wall (2026-10-19): its own title and hint; it is measured like any side, along the
    // room's inner face from corner to corner.
    const diagonal = !!(edge && edge.orient === 'd');
    this.numpad.setPlusEnabled(true);
    this.numpad.setOkLabel('확인 ▶');

    const row = el('div', { class: 'field-row' });
    if (!s.fields.length) {
      row.append(el('p', { class: 'panel-note' }, '이 벽에 붙은 실이 아직 없습니다. 벽으로 공간을 둘러싸면 실이 생기고, 그때 길이를 넣을 수 있습니다.'));
    }
    const needs = needsInputFn(store);
    let lastGroup = null;
    s.fields.forEach((f, i) => {
      if (lastGroup !== null && f.group !== lastGroup) row.append(el('span', { class: 'field-sep' }, '/'));
      else if (lastGroup !== null) row.append(el('span', { class: 'field-dot' }, '·'));
      lastGroup = f.group;
      const active = i === s.active;
      const m = this._measure(store, f.roomId, f.sideKey);
      let text = '';
      let sub = '';
      if (active && this.buffer.edited) {
        text = this._bufferDisplay();
      } else if (m && m.value != null) {
        text = formatMM(m.value);
        if (m.parts && m.parts.length > 1) sub = m.parts.map(formatMM).join('+');
        // Computed from where a 구역 나누기 선 cuts a measured side: typing a value replaces it.
        // A real wall across a measured side (DESIGN.md §7.9): its assumed thickness is taken off.
        if (m.computed) {
          sub = m.byWall
            ? `벽 위치로 계산한 값${m.wallGap > 0 ? ` (벽 두께 ${formatMM(m.wallGap)} 뺌)` : ''} · 재면 바꾸세요`
            : '나눈 위치로 계산한 값 · 재면 바꾸세요';
        }
      }
      if (!text && !needs(f.roomId, f.sideKey)) {
        // Fixed without its own value: by the opposite side in an h / v room; next to a diagonal side
        // (a diagonal fixed by the walls around it, or a side a measured diagonal fixes) by the others.
        sub = f.side && f.side.allDivider ? '구역 나누기 선: 안 넣어도 됨'
          : roomHasDiagonal(store, f.roomId) ? '다른 벽 값으로 정해짐' : '맞은편 값으로 정해짐';
      } else if (!text && active) {
        const info = safeSideInfo(store, f.roomId, f.sideKey);
        if (info && info.currentInnerLength) sub = `그림 길이 약 ${formatMM(roundTo(info.currentInnerLength, 10))}`;
      }
      const outlier = m && isOutlier(store, m.id);
      const residual = m && residualOf(store, m.id);
      if (residual && !(active && this.buffer.edited)) {
        sub = `그림 ${formatMM(Math.round(residual.drawn))} (차이 ${formatMM(Math.round(residual.amount))})`;
      }
      const flag = [m && m.check ? '! 확인필요' : '', outlier ? '다시 확인' : '',
        residual && residual.check ? '다른 값과 안 맞음' : ''].filter(Boolean).join(' · ');
      row.append(el('div', { class: 'field-wrap' },
        el('span', { class: 'field-label' }, `${this.ctx.roomLabel(f.roomId)} 쪽`),
        this._valueBox(text, {
          active,
          placeholder: '',
          sub,
          flag,
          computed: !!(m && m.computed && m.value != null && !(active && this.buffer.edited)),
          onclick: () => {
            s.active = i;
            this.buffer.reset('');
            this._render();
          },
        })));
    });

    const f = s.fields[s.active];
    const m = f && this._measure(store, f.roomId, f.sideKey);
    const checkOn = f ? !!(m && m.check) : (store.project.wallChecks || []).some((w) => w.edge === s.edgeId);
    const actions = el('div', { class: 'panel-actions' },
      el('button', { type: 'button', class: `btn ${checkOn ? 'btn-on' : ''}`, 'aria-pressed': checkOn ? 'true' : 'false', onclick: () => this._toggleCheck() }, '확인필요'),
      isDivider ? null : el('button', { type: 'button', class: 'btn', onclick: () => this._openThickness() }, '두께'),
      el('button', { type: 'button', class: 'btn btn-danger', onclick: () => this.deleteWall() }, isDivider ? '선 지우기' : '벽 지우기'),
      this._closeButton());

    const hint = el('p', { class: 'panel-hint' }, diagonal
      ? '사선 벽도 실 안쪽 면을 따라 모서리에서 모서리까지 잰 길이(mm)를 넣고 [확인 ▶]을 누르면 같은 실의 다음 벽으로 넘어갑니다.'
      : '줄자로 잰 실 안쪽 길이(mm)를 넣고 [확인 ▶]을 누르면 같은 실의 다음 벽으로 넘어갑니다. 나눠 쟀으면 + 키를 쓰세요.');

    return el('div', { class: 'panel-inner' },
      el('div', { class: 'panel-main' },
        el('div', { class: 'panel-title' }, isDivider ? '구역 나누기 선 길이' : diagonal ? '사선 벽 길이' : '벽 길이'),
        row, actions, hint),
      this.numpad.element);
  }

  _renderThickness() {
    const s = this.state;
    const store = this.ctx.store();
    const edge = store.project.edges.find((e) => e.id === s.edgeId);
    this.numpad.setPlusEnabled(false);
    this.numpad.setOkLabel('확인');
    const solved = store.derived && store.derived.solve && store.derived.solve.thickness;
    const eff = solved && solved.get ? solved.get(s.edgeId) : null;
    const measured = edge && edge.thickness != null;
    const text = this.buffer.edited ? this._bufferDisplay() : (measured ? formatMM(edge.thickness) : '');
    const sub = measured ? '실측값' : `자동(가정값)${eff != null ? ` · 지금 약 ${formatMM(eff)}` : ''}`;
    return el('div', { class: 'panel-inner' },
      el('div', { class: 'panel-main' },
        el('div', { class: 'panel-title' }, '벽 두께'),
        el('div', { class: 'field-row' },
          el('div', { class: 'field-wrap' },
            el('span', { class: 'field-label' }, '두께 (mm)'),
            this._valueBox(text, { active: true, sub }))),
        el('div', { class: 'panel-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => this._resetThickness() }, '자동으로 되돌리기'),
          el('button', { type: 'button', class: 'btn', onclick: () => this._backToLength() }, '◀ 길이 입력으로'),
          this._closeButton()),
        el('p', { class: 'panel-hint' }, '두께를 잰 벽만 넣으세요. 넣지 않으면 바깥벽 150, 안쪽 벽 100으로 가정하고, 잰 길이에 맞게 자동으로 조정됩니다.')),
      this.numpad.element);
  }

  _renderRoom() {
    const s = this.state;
    const room = this._room(s.roomId);
    this.numpad.setPlusEnabled(false);
    this.numpad.setOkLabel('확인');
    const { base, num } = splitName(room.name || '');
    const presets = el('div', { class: 'chip-row' });
    for (const p of ROOM_PRESETS) {
      // '방1' lights up for exactly '방1'; '화장실' for '화장실', '화장실2', …
      const on = splitName(p).num != null ? room.name === p : base === p;
      presets.append(el('button', {
        type: 'button',
        class: `chip ${on ? 'chip-on' : ''}`,
        onclick: () => this._choosePreset(p),
      }, p));
    }
    // The current name, large, with [이름 바꾸기]: a text field with the on-screen keyboard (any name,
    // e.g. '안방'). A tap on the room's name on the plan opens this panel with the field already open.
    const nameRow = el('div', { class: 'room-name-row' },
      el('span', { class: 'room-name-label' }, '실 이름'),
      el('span', { class: `room-name-big ${room.name ? '' : 'room-name-empty'}` }, room.name || '이름 없음'),
      el('button', {
        type: 'button', class: `btn room-rename ${s.customOpen ? 'btn-on' : ''}`, 'aria-pressed': s.customOpen ? 'true' : 'false',
        onclick: () => this._toggleNameField(),
      }, '이름 바꾸기'));

    // 번호 chips for a preset kind ('방' of 방1…방3, '화장실', …): e.g. a fourth room becomes 방4.
    let numbers = null;
    if (base && ROOM_PRESETS.some((p) => p === base || splitName(p).base === base)) {
      const sameBase = this._allRooms().filter((r) => splitName(r.name || '').base === base).length;
      if (sameBase > 1 || num != null) {
        numbers = el('div', { class: 'chip-row chip-row-small' }, el('span', { class: 'chip-label' }, '번호'));
        const max = Math.max(4, sameBase + 1);
        for (let n = 1; n <= max; n++) {
          numbers.append(el('button', {
            type: 'button',
            class: `chip chip-small ${num === n ? 'chip-on' : ''}`,
            onclick: () => this._chooseNumber(n),
          }, String(n)));
        }
        // The room's own number above that range ('방12' from an older household): shown and lit.
        if (num != null && num > max) {
          numbers.append(el('button', { type: 'button', class: 'chip chip-small chip-on', onclick: () => this._chooseNumber(num) }, String(num)));
        }
      }
    }

    let custom = null;
    if (s.customOpen) {
      const input = el('input', {
        class: 'text-input room-name-input', type: 'text', value: room.name || '', placeholder: '실 이름 (예: 안방)',
        'aria-label': '실 이름', enterkeyhint: 'done', maxlength: 40, autocomplete: 'off',
      });
      // A name typed but not applied yet survives re-renders (a numpad tap for H) and is applied when
      // the panel closes ([✕ 닫기], a tap elsewhere); only [취소] / Esc throw it away.
      if (s.nameDraft != null) input.value = s.nameDraft;
      input.addEventListener('input', () => { s.nameDraft = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;   // Korean input: Enter ends the syllable first
        if (e.key === 'Enter') { e.preventDefault(); this._applyCustomName(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); s.customOpen = false; s.nameDraft = null; this._render(); }
      });
      custom = el('div', { class: 'custom-row' }, input,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this._applyCustomName(input.value) }, '적용'),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { s.customOpen = false; s.nameDraft = null; this._render(); } }, '취소'));
      // focusCustom: focus (and select the current name) only when the field opens, not on later
      // re-renders (a numpad tap for H must not bring up the tablet keyboard again).
      if (s.focusCustom) {
        s.focusCustom = false;
        setTimeout(() => {
          if (!input.isConnected) return;
          input.focus();
          input.select();
        }, 0);
      }
    }

    const hText = this.buffer.edited ? this._bufferDisplay() : (room.height != null ? formatMM(room.height) : '');
    const heightRow = el('div', { class: 'field-row' },
      el('div', { class: 'field-wrap' },
        el('span', { class: 'field-label' }, '천장고 H (mm)'),
        this._valueBox(hText, { active: true })));

    // The name (with H) was dragged somewhere by hand (선택): put it back where it goes by itself.
    const store = this.ctx.store();
    const labelKey = `room:${s.roomId}`;
    const moved = !!(store.project.labelOffsets && store.project.labelOffsets[labelKey]) && typeof store.resetLabel === 'function';
    const actions = el('div', { class: 'panel-actions' },
      el('button', {
        type: 'button', class: `btn ${room.notRoom ? 'btn-on' : ''}`, 'aria-pressed': room.notRoom ? 'true' : 'false',
        onclick: () => this._toggleNotRoom(),
      }, '실 아님(설비)'),
      moved ? el('button', {
        type: 'button', class: 'btn room-label-reset',
        onclick: () => {
          if (this.ctx.command(() => store.resetLabel(labelKey), '글자 위치 되돌리기')) this.ctx.toast('실 이름을 원래 자리로 되돌렸습니다.', { type: 'ok' });
        },
      }, '이름 위치 되돌리기') : null,
      this._closeButton());

    return el('div', { class: 'panel-inner' },
      el('div', { class: 'panel-main' },
        nameRow, custom, presets, numbers, heightRow, actions),
      this.numpad.element);
  }

  _renderRect() {
    const s = this.state;
    this.numpad.setPlusEnabled(false);
    this.numpad.setOkLabel(s.active === 0 ? '다음 ▶' : '만들기');
    const box = (i, label) => {
      const active = s.active === i;
      const drawnVal = i === 0 ? s.drawn.w : s.drawn.h;
      const v = s.values[i];
      const text = active && this.buffer.edited ? this._bufferDisplay() : (v != null ? formatMM(v) : '');
      return el('div', { class: 'field-wrap' },
        el('span', { class: 'field-label' }, label),
        this._valueBox(text, {
          active,
          placeholder: formatMM(drawnVal),
          sub: v == null ? '그린 크기' : '',
          onclick: () => { s.active = i; this.buffer.reset(''); this._render(); },
        }));
    };
    return el('div', { class: 'panel-inner' },
      el('div', { class: 'panel-main' },
        el('div', { class: 'panel-title' }, '실 추가 — 실 안쪽 크기'),
        el('div', { class: 'field-row' }, box(0, '가로'), el('span', { class: 'field-sep' }, '×'), box(1, '세로')),
        el('div', { class: 'panel-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this._finishRect(true) }, '그대로'),
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => this.close() }, '취소')),
        el('p', { class: 'panel-hint' }, '숫자를 넣지 않은 쪽은 그린 크기 그대로 만듭니다. 기존 벽 가까이 그리면 그 벽에 붙습니다.')),
      this.numpad.element);
  }
}

// ---- shared pure helpers -------------------------------------------------------------------------

export function roundTo(v, step) {
  return Math.round(v / step) * step;
}

export function findSide(derived, roomId, sideKey) {
  for (const r of (derived && derived.rooms) || []) {
    if (r.roomId === roomId) return (r.sides || []).find((s) => s.key === sideKey) || null;
  }
  return null;
}

export function sidePoints(project, side) {
  const a = project.nodes.find((n) => n.id === side.from);
  const b = project.nodes.find((n) => n.id === side.to);
  return a && b ? [a, b] : [];
}

// Index of the first field of the tapped wall piece itself (else 0): the default ▶.
function firstPrimary(fields) {
  const i = (fields || []).findIndex((f) => f.primary);
  return i >= 0 ? i : 0;
}

// Middle of a room side / of a wall in the current geometry, or null (view anchors, _hold).
function sideMid(store, roomId, sideKey) {
  const side = store && findSide(store.derived, roomId, sideKey);
  const pts = side ? sidePoints(store.project, side) : [];
  return pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : null;
}

// True when the room has a diagonal side (orient 'd').
function roomHasDiagonal(store, roomId) {
  const dr = ((store.derived && store.derived.rooms) || []).find((r) => r.roomId === roomId);
  return !!(dr && Array.isArray(dr.sides) && dr.sides.some((sd) => sd && sd.orient === 'd'));
}

function edgeMid(store, edgeId) {
  const e = store && store.project.edges.find((x) => x.id === edgeId);
  const a = e && store.project.nodes.find((n) => n.id === e.a);
  const b = e && store.project.nodes.find((n) => n.id === e.b);
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}

// → (roomId, sideKey) => true when that side still needs a measured value. Uses the engine's
// 'unmeasured' warnings (which know that a rectangle needs only two measures); falls back to
// "has no measure" when warnings are not available.
export function needsInputFn(store) {
  const derived = store.derived;
  const warnings = derived && derived.warnings;
  if (Array.isArray(warnings)) {
    const set = new Set(warnings.filter((w) => w.type === 'unmeasured').map((w) => `${w.roomId}|${w.sideKey}`));
    return (roomId, sideKey) => set.has(`${roomId}|${sideKey}`);
  }
  const measured = new Set((store.project.measures || [])
    .filter((m) => m.value != null)
    .map((m) => `${m.room}|${[m.from, m.to].sort().join('-')}`));
  return (roomId, sideKey) => !measured.has(`${roomId}|${sideKey}`);
}

function safeSidesForEdge(derived, edgeId) {
  try {
    return (sidesForEdge(derived, edgeId) || []).filter((x) => x && x.side);
  } catch (err) {
    console.error('sidesForEdge failed', err);
    return [];
  }
}

function safeSideInfo(store, roomId, sideKey) {
  try {
    return store.sideInfo(roomId, sideKey);
  } catch (_) {
    return null;
  }
}

function isOutlier(store, measureId) {
  const warnings = (store.derived && store.derived.warnings) || [];
  return warnings.some((w) => w.type === 'outlier' && w.measureId === measureId);
}

// The engine's 'residual' warning for a measure (drawn length differs from the value), or null.
function residualOf(store, measureId) {
  const warnings = (store.derived && store.derived.warnings) || [];
  return warnings.find((w) => w.type === 'residual' && w.measureId === measureId) || null;
}

// "방12" -> { base: '방', num: 12 }; "거실" -> { base: '거실', num: null }.
export function splitName(name) {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (m && m[1]) return { base: m[1], num: parseInt(m[2], 10) };
  return { base: name, num: null };
}

// Names to set when a preset is chosen for roomId (plan §2-3 auto-numbering):
// the first room of a kind gets the plain name ("거실"); when a second one appears, the plain one
// becomes "방1" and the new one "방2"; later ones take the smallest free number.
// → [[roomId, name], ...]
// A preset that already ends in a number ('방1') is the exact name. A room that has it now: when this
// room is of the same kind ('방2' → '방1') the two numbers swap (as the 번호 chips); otherwise the other
// room takes the next free number of the kind ('방4'), never this room's unrelated old name (review
// 0.5.0: it became '이름 없음' or '거실' without a word).
export function presetNameUpdates(rooms, roomId, base) {
  const others = rooms.filter((r) => r && r.id !== roomId);
  const target = splitName(base);
  if (target.num != null) {
    const self = rooms.find((r) => r && r.id === roomId);
    const selfName = (self && self.name) || '';
    if (selfName === base) return [];
    const holder = others.find((r) => r.name === base);
    const mine = splitName(selfName);
    if (holder && mine.base === target.base && mine.num != null) return [[holder.id, selfName], [roomId, base]];
    // Rooms that must move on: the holder of the name, and a plain '방' (0.4.x numbered a plain name
    // only when a second one appeared), so the plan never reads '방' next to '방1'.
    const movers = others.filter((r) => r === holder || r.name === target.base);
    if (!movers.length) return [[roomId, base]];
    const used = new Set([target.num]);
    for (const r of others) {
      if (movers.includes(r)) continue;
      const s = splitName(r.name || '');
      if (s.base === target.base && s.num != null) used.add(s.num);
    }
    const out = [];
    for (const r of movers) {
      let n = 1;
      while (used.has(n)) n++;
      used.add(n);
      out.push([r.id, `${target.base}${n}`]);
    }
    out.push([roomId, base]);
    return out;
  }
  const same = others.filter((r) => splitName(r.name || '').base === base || r.name === base);
  if (!same.length) return [[roomId, base]];
  const used = new Set();
  for (const r of same) {
    const { num } = splitName(r.name);
    if (r.name !== base && num != null) used.add(num);
  }
  const takeFree = () => {
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    return n;
  };
  const updates = [];
  for (const r of same) {
    if (r.name === base) updates.push([r.id, `${base}${takeFree()}`]);
  }
  updates.push([roomId, `${base}${takeFree()}`]);
  return updates;
}
