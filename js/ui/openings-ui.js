// Window and door tools and the opening panel (plan §2-5, §1-3).
//
//   OpeningTool   gestures for the 창 / 문 tools (drag a ghost onto the nearest wall, release to place)
//                 and for dragging an existing opening along the walls (any tool).
//   OpeningPanel  bottom panel for one opening: material → type (windows) or door type (doors),
//                 size W × H (frequent + recent sizes, numpad), [열림 방향], [확인필요], [지우기].
//
// Both take the same kind of dependency object as the stage-A controllers (see each constructor).
// The panel shares the editor's single bottom panel host with PanelController; the integrator closes
// one before opening the other (ctx.onOpen is called when this panel opens).

import { el, Numpad } from './panel.js';
import { HIT, formatMM } from './theme.js';
import {
  MIN_WIDTH,
  OpeningPrefs, specFromPrefs, labelOf, displayName, nearestWall, snapAnchor, openingAt,
  placeOpening, nominalWidth, slidingLeaves, edgeFrame, facesBeside, defaultSwingSide,
} from '../core/openings.js';
// The chip lists and size buttons come from 설정 (device-wide, core/prefs.js); importing it also
// applies the label spacing rule of 설정 to every label.
import { openingLists, frequentSizes } from '../core/prefs.js';
import { drawOpeningGhost } from './draw-openings.js';
import { finishBeside } from '../core/dims.js';

const DRAG_SLOP_PX = 8;
const WALL_REACH_PX = 70;     // the ghost follows walls up to this far from the pointer
const TAP_REACH_PX = 24;      // a tap this close to a wall places an opening there
const DRAW_WIDTH_STEP = 300;  // [좁게] / [넓게] step for openings without a size (mm)
// An opening dropped this close (screen px) to a wall's end is put flush against it (C4: passed to
// the store as spec.anchorMM = px / zoom). The rule used to be 150 mm of gap left by the default
// drawn width (1200 / 900) on the unscaled sketch, so a window dropped in the middle of a short
// wall went to its corner (예시 세대 A 화장실1).
const ANCHOR_PX = 12;
// A tap in the other tools (벽, 선택, …) opens a window / door only on its symbol: the cut it makes in
// the wall band (finish included), + `across` px for the anti-aliased edge and `along` px past its
// ends. The 14 px reach of the 창 / 문 tools covered the whole tappable band of a wall where a window
// sits, so a wall with a window (예시 세대 A 거실 3600 with its 3550 window, 430 with a 1000 window) could not
// be opened by a tap at all (0 of 21 taps); a tap just inside the room now reaches the wall.
const SYMBOL_TAP_PX = { along: 4, across: 1 };

// ---- tool ------------------------------------------------------------------------------------------

export class OpeningTool {
  // ctx: { store(), view, command(fn, label) -> bool, toast(msg, opts), requestRender(),
  //        openPanel(openingId, { at }) (at = the world point tapped / dropped on),
  //        prefs (OpeningPrefs, optional) }
  constructor(ctx) {
    this.ctx = ctx;
    this.prefs = ctx.prefs || new OpeningPrefs();
    this.active = null;   // { mode: 'place' | 'move', kind, id, grab, moved }
    this.ghost = null;    // opening-like object drawn by drawOverlay()
  }

  get isActive() {
    return !!this.active;
  }

  // Start a gesture in the 창 ('window') or 문 ('door') tool. A press on an existing opening drags
  // that opening instead of placing a new one. → true (the gesture is ours)
  onGestureStart(g, kind) {
    if (this.tryStartDrag(g)) return true;
    this.active = { mode: 'place', kind: kind === 'door' ? 'door' : 'window', moved: false };
    this.ghost = null;
    return true;
  }

  // Select tool (or any tool): start dragging the opening under the pointer. → bool
  tryStartDrag(g) {
    const store = this.ctx.store();
    const p = g.points[0];
    const id = openingAt(store.project, store.derived, p, this._mm(HIT.edgePx));
    if (!id) return false;
    const o = store.openingById ? store.openingById(id) : (store.project.openings || []).find((x) => x.id === id);
    const pl = o && placeOpening(store.project, store.derived, o);
    if (!pl) return false;
    this.active = { mode: 'move', id, kind: o.kind, grab: { x: p.x - pl.center.x, y: p.y - pl.center.y }, moved: false };
    this.ghost = null;
    return true;
  }

  onGestureMove(g) {
    const a = this.active;
    if (!a) return;
    if (g.maxMovePx < DRAG_SLOP_PX && !a.moved) return;
    a.moved = true;
    const store = this.ctx.store();
    const last = g.points[g.points.length - 1];
    const at = a.mode === 'move' ? { x: last.x - a.grab.x, y: last.y - a.grab.y } : last;
    const nw = nearestWall(store.project, at, this._mm(WALL_REACH_PX));
    if (!nw) {
      this.ghost = null;
    } else {
      const base = a.mode === 'move' ? store.openingById(a.id) : this._newSpec(a.kind);
      const snap = snapAnchor(store.project, store.derived, nw.edgeId, nw.t, { ...base, anchorMM: this._anchorMM() });
      // _t: the dropped position itself; the store decides the anchor from it (C4). _at: the pointer
      // (its side of the wall is the side [벽 길이 ▶] opens).
      this.ghost = { ...base, edge: nw.edgeId, t: snap.t, anchor: snap.anchor, _side: nw.side, _t: nw.t, _at: last };
      if (base.kind === 'door' && a.mode === 'place') {
        // Same rule as addOpening, so the preview never flips on release (a door opens into a room).
        this.ghost.swing = { side: defaultSwingSide(store.derived, nw.edgeId, nw.side), hinge: 'start' };
      }
    }
    this.ctx.requestRender();
  }

  // → true when the gesture was ours (always, once started).
  onGestureEnd(g) {
    const a = this.active;
    this.active = null;
    const ghost = this.ghost;
    this.ghost = null;
    if (!a) return false;
    if (g.isTap || !a.moved) {
      if (a.mode === 'move') {
        this.ctx.openPanel(a.id, { at: g.points[0] });
      } else {
        this._placeAtTap(g.points[0], a.kind);
      }
      this.ctx.requestRender();
      return true;
    }
    const store = this.ctx.store();
    if (!ghost) {
      if (a.mode === 'place') this.ctx.toast('벽 가까이에 놓아 주세요.', { type: 'warn' });
      this.ctx.requestRender();
      return true;
    }
    if (a.mode === 'move') {
      this.ctx.command(() => store.moveOpening(a.id, ghost.edge, ghost._t, { side: ghost._side, anchorMM: this._anchorMM() }), a.kind === 'door' ? '문 옮기기' : '창 옮기기');
      this.ctx.openPanel(a.id, { at: ghost._at });
    } else {
      this._place(ghost.edge, ghost._t, a.kind, ghost._side, ghost._at);
    }
    this.ctx.requestRender();
    return true;
  }

  onGestureCancel() {
    this.active = null;
    this.ghost = null;
    this.ctx.requestRender();
  }

  cancel() {
    const had = !!(this.active || this.ghost);
    this.onGestureCancel();
    return had;
  }

  // A tap in the 창 / 문 tools: an opening within HIT.edgePx of its band opens its panel (a tap there
  // never places a second one on top). → bool (handled)
  tap(world) {
    const store = this.ctx.store();
    const id = openingAt(store.project, store.derived, world, this._mm(HIT.edgePx));
    if (!id) return false;
    this.ctx.openPanel(id, { at: world });
    return true;
  }

  // A tap in the other tools: only right on an opening's symbol (SYMBOL_TAP_PX) opens its panel, so a
  // tap inside the room next to it goes on to the wall. → bool (handled)
  tapOnSymbol(world) {
    const store = this.ctx.store();
    const id = openingOnBand(store.project, store.derived, world, this._mm(SYMBOL_TAP_PX.along), this._mm(SYMBOL_TAP_PX.across));
    if (!id) return false;
    this.ctx.openPanel(id, { at: world });
    return true;
  }

  // Draw the ghost (call after renderPlan / drawOpenings, with the same opts).
  drawOverlay(ctx2d, opts) {
    if (!this.ghost) return;
    const store = this.ctx.store();
    drawOpeningGhost(ctx2d, store.project, store.derived, this.ghost, opts);
  }

  // ---- internals ----

  _placeAtTap(world, kind) {
    if (this.tap(world)) return;
    const store = this.ctx.store();
    const nw = nearestWall(store.project, world, this._mm(TAP_REACH_PX) + 75);
    if (!nw) {
      this.ctx.toast(kind === 'door' ? '문을 놓을 벽을 누르거나, 벽 위로 끌어다 놓으세요.' : '창을 놓을 벽을 누르거나, 벽 위로 끌어다 놓으세요.');
      return;
    }
    this._place(nw.edgeId, nw.t, kind, nw.side, world);
  }

  // A new opening at fraction t of the wall where it was dropped (not snapped here): the store keeps
  // that position and decides the corner anchor from it with spec.anchorMM, again once the real width
  // is typed (C4, core/openings.js).
  _place(edgeId, t, kind, side, at = null) {
    const store = this.ctx.store();
    let id = null;
    const spec = { ...this._newSpec(kind), side, anchorMM: this._anchorMM() };
    const ok = this.ctx.command(() => { id = store.addOpening(edgeId, t, spec); }, kind === 'door' ? '문 놓기' : '창 놓기');
    if (ok && id) this.ctx.openPanel(id, { at });
  }

  _newSpec(kind) {
    return { ...specFromPrefs(this.prefs, kind), width: null, height: null };
  }

  _anchorMM() {
    return this._mm(ANCHOR_PX);
  }

  _mm(px) {
    return px / this.ctx.view.scale;
  }
}

// ---- panel -----------------------------------------------------------------------------------------

export class OpeningPanel {
  // ctx: { store(), command(fn, label) -> bool, toast(msg, opts), onChange() (redraw / resize),
  //        onOpen() (optional: the editor closes PanelController), prefs (OpeningPrefs, optional),
  //        openEdge(edgeId, prefer) (optional: [벽 길이 ▶], PanelController.openEdge),
  //        holdView(anchor, run) (optional: keep the opening on its screen spot while a typed width
  //        re-solves the plan, main.js),
  //        view (optional: the editor's View; the corner reach ANCHOR_PX for the first real width) }
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.prefs = ctx.prefs || new OpeningPrefs();
    // { id, field: 'w'|'h'|null, part: 'outer'|'inner', customOpen, wallSide: 'left'|'right'|null }
    this.state = null;
    this.text = '';     // numpad buffer for the active size field
    this.edited = false;
    this.numpad = new Numpad((k) => this.onNumpad(k));
  }

  get isOpen() {
    return !!this.state;
  }

  get selectedId() {
    return this.state ? this.state.id : null;
  }

  // What the renderer should highlight: pass as options.highlight to drawOpenings.
  get highlight() {
    return this.state ? [this.state.id] : null;
  }

  // opts.at: the world point tapped / dropped on. Its side of the wall line is kept (not the point:
  // the walls move when values are typed) for [벽 길이 ▶].
  open(id, { at = null } = {}) {
    const o = this._opening(id);
    if (!o) return;
    if (this.ctx.onOpen) this.ctx.onOpen();
    this.state = { id, field: 'w', part: 'outer', customOpen: false, wallSide: this._sideOf(o, at) };
    this._resetBuffer();
    this._render();
  }

  // Which side of its wall line a world point lies on: 'left' | 'right' | null (on the line / none).
  _sideOf(o, at) {
    if (!o || !at || !isFinite(at.x) || !isFinite(at.y)) return null;
    const store = this.ctx.store();
    const fr = edgeFrame(store.project, store.derived, o.edge);
    if (!fr) return null;
    const d = (at.x - fr.A.x) * fr.left.x + (at.y - fr.A.y) * fr.left.y;
    return d > 0.5 ? 'left' : d < -0.5 ? 'right' : null;
  }

  // [벽 길이 ▶]: the length panel of this opening's wall, with the ▶ in the room on the side that was
  // tapped (a window covering a whole wall hid the wall's length behind its panel; 예시 세대 A 430 / 1000).
  // Tapped on the line itself (or opened from the 검사 list): a door's room, else the first room.
  _openWall() {
    const s = this.state;
    const o = s && this._opening(s.id);
    if (!o || !this.ctx.openEdge) return;
    const store = this.ctx.store();
    const pl = placeOpening(store.project, store.derived, o);
    let side = s.wallSide;
    if (!side && o.kind === 'door' && o.swing && !slidingLeaves(o)) side = o.swing.side === 'right' ? 'right' : 'left';
    let prefer = null;
    if (pl && side) {
      // A point just past the wall face on that side (panel.openEdge decides by the side of the line).
      const k = (side === 'left' ? 1 : -1) * (pl.frame.thick / 2 + 1);
      prefer = { at: { x: pl.center.x + pl.frame.left.x * k, y: pl.center.y + pl.frame.left.y * k } };
    }
    this.ctx.openEdge(o.edge, prefer);
  }

  // Run a command that may move walls (a typed width keeps its wall piece wide enough, C2) with the
  // opening held on its screen spot.
  _hold(run) {
    if (!this.ctx.holdView || !this.state) return run();
    const id = this.state.id;
    return this.ctx.holdView(() => {
      const store = this.ctx.store();
      const o = (store.project.openings || []).find((x) => x.id === id);
      const pl = o && placeOpening(store.project, store.derived, o);
      return pl ? pl.center : null;
    }, run);
  }

  close() {
    if (!this.state) return;
    this.state = null;
    this.host.hidden = true;
    this.host.replaceChildren();
    this.ctx.onChange();
  }

  // Forget the open opening without touching the host: PanelController has just taken the shared
  // bottom panel over (it already replaced the host's content).
  detach() {
    this.state = null;
    this._resetBuffer();
  }

  // After any store change (undo/redo included): close when the opening is gone, else redraw.
  refresh() {
    if (!this.state) return;
    if (!this._opening(this.state.id)) return this.close();
    this._render();
  }

  // PC keyboard: digits, Backspace, '+', Enter, Tab (W ↔ H), Delete (지우기). → true when used.
  handleKey(e) {
    if (!this.state || this.state.customOpen) return false;
    const k = e.key;
    let key = null;
    if (/^[0-9]$/.test(k)) key = k;
    else if (k === 'Backspace') key = 'back';
    else if (k === '+' || (k === '=' && e.shiftKey)) key = 'plus';
    else if (k === 'Enter') key = 'ok';
    else if (k === 'Tab') {
      this._setField(this.state.field === 'w' ? 'h' : 'w');
      return true;
    } else if (k === 'Delete') {
      this.deleteOpening();
      return true;
    }
    if (!key) return false;
    this.onNumpad(key);
    return true;
  }

  // ---- numpad ----

  onNumpad(key) {
    const s = this.state;
    if (!s) return;
    if (!s.field) s.field = 'w';
    if (key === 'ok') {
      this._confirmField();
      return;
    }
    if (key === 'back' && !this.edited && !this.text) {
      const o = this._opening(s.id);
      const cur = o && (s.field === 'w' ? o.width : o.height);
      if (cur) this.text = String(Math.round(cur));
    }
    if (/^[0-9]$/.test(key)) {
      const lastPart = this.text.split('+').pop();
      if (lastPart.length < 5) this.text += key;
    } else if (key === 'back') {
      this.text = this.text.slice(0, -1);
    } else if (key === 'plus') {
      // Widths measured in parts ("1600+1950") add up; '+' on an empty field does nothing.
      if (s.field === 'w' && this.text && !this.text.endsWith('+')) this.text += '+';
    } else if (key === 'clear') {
      this.text = '';
    }
    this.edited = true;
    this._render();
  }

  _parse() {
    const parts = this.text.split('+').filter(Boolean).map((x) => parseInt(x, 10)).filter((n) => n > 0);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }

  _confirmField() {
    const s = this.state;
    const store = this.ctx.store();
    const field = s.field;
    if (this.edited) {
      const v = this._parse();
      const [lo, hi] = field === 'w' ? [100, 20000] : [100, 5000];
      if (v != null && (v < lo || v > hi)) {
        this.ctx.toast(field === 'w' ? '창·문 폭은 100~20000mm 사이로 넣어 주세요.' : '창·문 높이는 100~5000mm 사이로 넣어 주세요.', { type: 'warn' });
        return;
      }
      const patch = field === 'w' ? { width: v } : { height: v };
      this._hold(() => this.ctx.command(() => store.updateOpening(s.id, patch, this._anchorOpts()), '창호 규격'));
    }
    this._resetBuffer();
    if (field === 'w') {
      s.field = 'h';
    } else {
      s.field = null;
      const o = this._opening(s.id);
      if (o && o.width && o.height) this.prefs.addRecentSize(o.kind, o.width, o.height);
    }
    this._render();
  }

  _setField(field) {
    this.state.field = field;
    this._resetBuffer();
    this._render();
  }

  _resetBuffer() {
    this.text = '';
    this.edited = false;
  }

  // ---- choices ----

  // opts.hold: the patch may move walls (a width): the opening stays on its screen spot.
  _update(patch, label, { hold = false } = {}) {
    const store = this.ctx.store();
    const run = () => this.ctx.command(() => store.updateOpening(this.state.id, patch, this._anchorOpts()), label);
    if (hold) this._hold(run);
    else run();
    this.refresh();
  }

  // The first real width decides the corner anchor again from where the opening was dropped (C4):
  // with the same on-screen reach as when it was placed.
  _anchorOpts() {
    const v = this.ctx.view;
    return v && v.scale > 0 ? { anchorMM: ANCHOR_PX / v.scale } : {};
  }

  _chooseMaterial(material) {
    const o = this._opening(this.state.id);
    if (o.combo) {
      const combo = { ...o.combo, [this.state.part]: { ...o.combo[this.state.part], material } };
      this._update({ combo }, '창 재질');
      return;
    }
    this.prefs.setLast('window', { material, type: o.type });
    this._update({ material }, '창 재질');
  }

  _chooseType(type) {
    const o = this._opening(this.state.id);
    if (o.combo) {
      const combo = { ...o.combo, [this.state.part]: { ...o.combo[this.state.part], type } };
      this._update({ combo }, '창 종류');
      return;
    }
    this.prefs.setLast('window', { material: o.material, type });
    this._update({ type }, '창 종류');
  }

  _toggleCombo() {
    const o = this._opening(this.state.id);
    if (o.combo) {
      // Back to a single window: keep the outer window's choice.
      this._update({ combo: null, material: o.combo.outer.material, type: o.combo.outer.type }, '조합창');
    } else {
      this.state.part = 'outer';
      this._update({ combo: { outer: { material: o.material, type: o.type }, inner: { material: null, type: null } } }, '조합창');
    }
  }

  _chooseDoorType(doorType) {
    this.prefs.setLast('door', { doorType });
    this.state.customOpen = false;
    this._update({ doorType }, '문 종류');
  }

  _chooseSize(w, h) {
    const o = this._opening(this.state.id);
    this.prefs.addRecentSize(o.kind, w, h);
    this._resetBuffer();
    this.state.field = null;
    this._update({ width: w, height: h }, '창호 규격', { hold: true });
  }

  _clearSize() {
    const o = this._opening(this.state.id);
    // Keep the drawn width so the symbol does not jump.
    const pl = placeOpening(this.ctx.store().project, this.ctx.store().derived, o);
    this._resetBuffer();
    this.state.field = 'w';
    this._update({ width: null, height: null, drawWidth: pl ? Math.round(pl.w) : o.drawWidth }, '규격 지우기', { hold: true });
  }

  _nudgeDrawWidth(step) {
    const o = this._opening(this.state.id);
    const next = Math.max(MIN_WIDTH, Math.round(nominalWidth(o) + step));
    this._update({ drawWidth: next }, '그림 폭');
  }

  _cycleSwing() {
    const store = this.ctx.store();
    this.ctx.command(() => store.cycleSwing(this.state.id), '열림 방향');
    this.refresh();
  }

  _toggleCheck() {
    const o = this._opening(this.state.id);
    const on = !o.check;
    this._update({ check: on }, '확인필요');
    this.ctx.toast(on ? '확인필요로 표시했습니다. ※ 주기에 적힙니다.' : '확인필요를 해제했습니다.', { type: on ? 'warn' : 'ok' });
  }

  deleteOpening() {
    const s = this.state;
    if (!s) return;
    const o = this._opening(s.id);
    const store = this.ctx.store();
    this.ctx.command(() => store.deleteOpening(s.id), o && o.kind === 'door' ? '문 지우기' : '창 지우기');
    this.close();
    this.ctx.toast('지웠습니다. ↶ 버튼으로 되돌릴 수 있습니다.', {
      action: { label: '되돌리기', run: () => this.ctx.command(() => this.ctx.store().undo(), '되돌리기') },
    });
  }

  // ---- data ----

  _opening(id) {
    const store = this.ctx.store();
    return store ? ((store.project.openings || []).find((o) => o.id === id) || null) : null;
  }

  // ---- rendering ----

  _render() {
    const s = this.state;
    if (!s) return;
    const o = this._opening(s.id);
    if (!o) return this.close();
    this.numpad.setPlusEnabled(s.field === 'w');
    this.numpad.setOkLabel(s.field === 'w' ? '다음 ▶' : '확인');
    const body = el('div', { class: 'panel-inner op-panel' },
      el('div', { class: 'panel-main' },
        this._renderTitle(o),
        o.kind === 'door' ? this._renderDoorChoices(o) : this._renderWindowChoices(o),
        this._renderSize(o),
        this._renderActions(o),
        el('p', { class: 'panel-hint' }, '규격은 몰라도 됩니다. 넣으면 라벨이 나오고, 안 넣으면 그림만 나옵니다.')),
      this.numpad.element);
    this.host.hidden = false;
    this.host.replaceChildren(body);
    this.ctx.onChange();
  }

  _renderTitle(o) {
    const label = labelOf(o);
    const kindText = o.kind === 'door' ? '문' : '창';
    return el('div', { class: 'op-title' },
      el('span', { class: 'panel-title' }, kindText),
      el('span', { class: `op-preview ${label ? '' : 'op-preview-empty'}` },
        label || `${displayName(o)} · 규격 없음 (그림만)`),
      o.check ? el('span', { class: 'field-flag' }, '! 확인필요') : null);
  }

  _chip(text, on, onclick, extra = '') {
    return el('button', {
      type: 'button', class: `chip op-chip ${on ? 'chip-on' : ''} ${extra}`, 'aria-pressed': on ? 'true' : 'false', onclick,
    }, text);
  }

  _row(label, ...children) {
    return el('div', { class: 'chip-row op-row' }, el('span', { class: 'op-row-label' }, label), ...children);
  }

  _renderWindowChoices(o) {
    const s = this.state;
    const cur = o.combo ? (o.combo[s.part] || {}) : { material: o.material, type: o.type };
    const rows = [];
    if (o.combo) {
      rows.push(this._row('조합창',
        this._chip('외창', s.part === 'outer', () => { s.part = 'outer'; this._render(); }),
        this._chip('내창', s.part === 'inner', () => { s.part = 'inner'; this._render(); })));
    }
    // A value chosen earlier but since removed from the list in 설정 still shows (selected).
    const lists = openingLists();
    const materials = withCurrent(lists.windowMaterials, cur.material);
    const types = withCurrent(lists.windowTypes, cur.type);
    rows.push(this._row('재질',
      ...materials.map((m) => this._chip(m, cur.material === m, () => this._chooseMaterial(m))),
      this._chip('모름', !cur.material, () => this._chooseMaterial(null))));
    rows.push(this._row('종류',
      ...types.map((t) => this._chip(t, cur.type === t, () => this._chooseType(cur.type === t ? null : t))),
      el('button', {
        type: 'button', class: `btn btn-small op-toggle ${o.combo ? 'btn-on' : ''}`, 'aria-pressed': o.combo ? 'true' : 'false',
        onclick: () => this._toggleCombo(),
      }, '조합창')));
    return el('div', { class: 'op-choices' }, ...rows);
  }

  _renderDoorChoices(o) {
    const s = this.state;
    const doorTypes = openingLists().doorTypes;
    const known = doorTypes.includes(o.doorType);
    const row = this._row('문 종류',
      ...doorTypes.map((t) => this._chip(t, o.doorType === t, () => this._chooseDoorType(o.doorType === t ? null : t))),
      this._chip(o.doorType && !known ? o.doorType : '직접 입력', s.customOpen || (o.doorType && !known), () => {
        s.customOpen = !s.customOpen;
        // Focus the text box only when the row opens. Re-renders (e.g. a numpad tap for the size)
        // must not pull focus back, or the tablet keyboard pops up over the panel.
        s.focusCustom = s.customOpen;
        this._render();
      }));
    let custom = null;
    if (s.customOpen) {
      const input = el('input', {
        class: 'text-input', type: 'text', value: o.doorType && !known ? o.doorType : '', placeholder: '문 종류', 'aria-label': '문 종류 직접 입력',
        enterkeyhint: 'done',
      });
      const apply = () => this._chooseDoorType(input.value.trim() || null);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); s.customOpen = false; this._render(); }
      });
      custom = el('div', { class: 'custom-row' }, input,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: apply }, '적용'));
      if (s.focusCustom) {
        s.focusCustom = false;
        setTimeout(() => input.focus(), 0);
      }
    }
    return el('div', { class: 'op-choices' }, row, custom);
  }

  _renderSize(o) {
    const s = this.state;
    const box = (field, label) => {
      const active = s.field === field;
      const stored = field === 'w' ? o.width : o.height;
      let text = stored ? formatMM(stored) : '';
      if (active && this.edited) {
        const v = this._parse();
        text = this.text.includes('+') && v ? `${this.text} = ${formatMM(v)}` : (this.text ? formatMM(+this.text) : '');
      }
      return el('div', { class: 'field-wrap' },
        el('span', { class: 'field-label' }, label),
        el('button', {
          type: 'button', class: `field op-field ${active ? 'field-active' : ''}`, 'aria-pressed': active ? 'true' : 'false',
          onclick: () => this._setField(field),
        },
        el('span', { class: 'field-mark' }, active ? '▶' : ''),
        el('span', { class: `field-value ${text ? '' : 'field-empty'}` }, text || ' ')));
    };
    const fieldRow = el('div', { class: 'field-row' }, box('w', '폭 W'), el('span', { class: 'field-sep' }, '×'), box('h', '높이 H'),
      (o.width || o.height) ? el('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => this._clearSize() }, '규격 지우기') : null);

    // Size buttons: recent first (직전 값), then the frequent ones.
    const seen = new Set();
    const sizes = [];
    for (const [w, h] of [...this.prefs.recentSizes(o.kind), ...frequentSizes(o.kind)]) {
      const key = `${w}*${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sizes.push([w, h]);
    }
    const recentCount = this.prefs.recentSizes(o.kind).length;
    const chips = sizes.slice(0, 10).map(([w, h], i) => el('button', {
      type: 'button',
      class: `chip chip-small op-size ${o.width === w && o.height === h ? 'chip-on' : ''} ${i < recentCount ? 'op-size-recent' : ''}`,
      onclick: () => this._chooseSize(w, h),
    }, h ? `${w}*${h}` : `${w}`));
    const sizeRow = this._row('규격', ...chips);

    let drawRow = null;
    if (!o.width) {
      const store = this.ctx.store();
      const pl = placeOpening(store.project, store.derived, o);
      drawRow = this._row('그림 폭',
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => this._nudgeDrawWidth(-DRAW_WIDTH_STEP) }, '− 좁게'),
        el('span', { class: 'op-drawwidth' }, pl ? `약 ${formatMM(Math.round(pl.w / 10) * 10)}` : ''),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => this._nudgeDrawWidth(DRAW_WIDTH_STEP) }, '넓게 +'));
    }
    return el('div', { class: 'op-size-block' }, fieldRow, sizeRow, drawRow);
  }

  _renderActions(o) {
    const swingText = o.kind === 'door' ? swingDescription(this.ctx.store(), o) : '';
    return el('div', { class: 'panel-actions' },
      o.kind === 'door' ? el('button', { type: 'button', class: 'btn', onclick: () => this._cycleSwing() }, '열림 방향') : null,
      swingText ? el('span', { class: 'op-swing' }, swingText) : null,
      el('button', { type: 'button', class: `btn ${o.check ? 'btn-on' : ''}`, 'aria-pressed': o.check ? 'true' : 'false', onclick: () => this._toggleCheck() }, '확인필요'),
      this.ctx.openEdge ? el('button', { type: 'button', class: 'btn op-wall-length', onclick: () => this._openWall() }, '벽 길이 ▶') : null,
      el('button', { type: 'button', class: 'btn btn-danger', onclick: () => this.deleteOpening() }, '지우기'),
      el('button', { type: 'button', class: 'btn btn-ghost panel-close', 'aria-label': '닫기', onclick: () => this.close() }, '✕ 닫기'));
  }
}

// Short Korean text for the current swing state (shown next to [열림 방향]), in the words of the
// answer key: "방1 쪽으로 열림 · 경첩 왼쪽", "앞 문짝: 오른쪽".
export function swingDescription(store, o) {
  const s = o.swing || { side: 'left', hinge: 'start' };
  const fr = edgeFrame(store.project, store.derived, o.edge);
  if (!fr) return '';
  const towardHinge = s.hinge === 'end' ? fr.dir : { x: -fr.dir.x, y: -fr.dir.y };
  const where = screenWord(towardHinge);
  if (slidingLeaves(o)) return `앞 문짝: ${where}`;
  const faces = facesBeside(store.derived, o.edge);
  const fi = s.side === 'left' ? faces.left : faces.right;
  let room = '바깥';
  if (fi != null) {
    const dr = ((store.derived && store.derived.rooms) || []).find((r) => r.faceIndex === fi);
    room = (dr && dr.room && dr.room.name) || '이름 없는 실';
  }
  return `${room} 쪽으로 열림 · 경첩 ${where}`;
}

// The opening whose symbol lies under a world point: inside the cut it makes across the wall band
// (half the thickness plus the finish on that side, as draw-openings cuts it) within acrossMM, and
// between its ends within alongMM. The nearest one wins. → id | null
function openingOnBand(project, derived, point, alongMM, acrossMM) {
  let best = null, bestD = Infinity;
  for (const o of (project && project.openings) || []) {
    const pl = placeOpening(project, derived, o);
    if (!pl) continue;
    const fr = pl.frame;
    const rx = point.x - fr.A.x, ry = point.y - fr.A.y;
    const along = rx * fr.dir.x + ry * fr.dir.y;
    const across = rx * fr.left.x + ry * fr.left.y;
    let fin = { left: 0, right: 0 };
    try { fin = finishBeside(project, derived, o.edge) || fin; } catch (_) { /* no finish */ }
    const half = (fr.thick > 0 ? fr.thick : 100) / 2 + Math.max(0, (across >= 0 ? fin.left : fin.right) || 0);
    const dAlong = Math.max(0, pl.s0 - along, along - pl.s1);
    const dAcross = Math.max(0, Math.abs(across) - half);
    if (dAlong > alongMM || dAcross > acrossMM) continue;
    if (dAlong + dAcross < bestD) { bestD = dAlong + dAcross; best = o.id; }
  }
  return best;
}

// The list, plus the current value at its end when the list no longer has it.
function withCurrent(list, value) {
  return value && !list.includes(value) ? [...list, value] : list;
}

// A direction on the screen in words: '왼쪽', '위쪽', … ; along a diagonal wall (both parts at least
// sin 22.5°) the two together, '오른쪽 위' (as checks-full.js names diagonal sides).
function screenWord(v) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y);
  if (ax >= 0.38 && ay >= 0.38) return `${v.x < 0 ? '왼쪽' : '오른쪽'} ${v.y < 0 ? '위' : '아래'}`;
  if (ax >= ay) return v.x < 0 ? '왼쪽' : '오른쪽';
  return v.y < 0 ? '위쪽' : '아래쪽';
}
