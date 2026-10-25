// App bootstrap and the editor screen controller (dev/DESIGN.md §1, §5).
// - registers the service worker (only off localhost, or with ?sw=1, so development reloads stay fresh)
// - opens IndexedDB storage, shows the household list
// - runs the editor: canvas (high-DPI), toolbar, top bar, bottom panel, keyboard shortcuts, autosave
// - [↻ 회전]: the plan turned a quarter turn (core/rotate.js; not an undo step), also from the [출력] dialog
// - [외벽 보기]: the exterior walls in red (core/exterior.js; remembered on this device like 치수선 보기)
import { APP_VERSION } from './version.js';
import { DocStore, createProject } from './core/model.js';
import { drawCheckMarkers, notesForPrint } from './core/checks.js';
import { OpeningPrefs, placeOpening } from './core/openings.js';
import { normalizeFixture, fixtureBounds } from './core/fixtures.js';
import { describeDim, buildDimensions, spansOverlap } from './core/dims.js';
import { applyLabelMove } from './core/labels.js';
import { computePrintLayout } from './core/printlayout.js';
import { wirePackages, CHECK_OPTIONS, wallCutouts } from './ui/wiring.js';
import * as storage from './io/storage.js';
import { exportProject } from './io/fileio.js';
import { registerServiceWorker, onUpdateAvailable } from './io/swclient.js';
import { View, projectBounds } from './ui/view.js';
import { InputController, installPalmGuard } from './ui/input.js';
import { renderPlan, renderOverlay } from './ui/render.js';
import { ToolController, TOOL_HINTS } from './ui/tools.js';
import { PanelController, Toaster, openDialog } from './ui/panel.js';
import { ListScreen } from './ui/list.js';
import { TIMING, ZOOM, COLORS } from './ui/theme.js';
import { OpeningPanel } from './ui/openings-ui.js';
import { drawOpenings } from './ui/draw-openings.js';
import { FixtureTool } from './ui/fixtures-ui.js';
import { drawFixtures, drawNotRoomSpaces } from './ui/draw-fixtures.js';
import { MemoTool, drawMemo } from './ui/memo-ui.js';
import { EraserTool } from './ui/eraser-ui.js';
import { openInfoForm, SURVEYOR_KEY } from './ui/info-form.js';
import { ChecksPanel, countForBadge } from './ui/checks-ui.js';
import { drawDimensions, layoutDimensions, dimDragTarget } from './ui/draw-dims.js';
import { OutputDialog, notesForChoices, DEFAULT_CHOICES, printsMemo } from './ui/output.js';
import { householdSettings } from './core/prefs.js';
import { exteriorIds } from './core/exterior.js';

const $ = (sel) => document.querySelector(sel);
const OPEN_KEY = 'floorplan.openProject';
const DIMS_VIEW_KEY = 'floorplan.dimsView';
const EXTERIOR_VIEW_KEY = 'floorplan.exteriorView';
// A value that changes the plan's size by more than this fraction zooms the view back (holdView).
// At 10 % the walls to tap next still moved up to 36 px on the 예시 세대 A (several values change the size
// by 5–9 %); at 2 % at most 15 px, inside the tap reach.
const HOLD_ZOOM_STEP = 0.02;

// Stage B/C/D packages: label hooks, paper drawers and the 확인 완료 store commands.
wirePackages();

const toaster = new Toaster($('#toasts'));
const toast = (msg, opts) => toaster.show(msg, opts);

let storageOk = false;
let editor = null;
let list = null;

// ---- small utilities ---------------------------------------------------------------------------

// name: 'localStorage' | 'sessionStorage'. Read inside the try: with the site's data blocked, merely
// reading window.localStorage throws SecurityError (review 2026-10-25: the app did not start at all).
function safeGet(name, key) {
  try {
    const store = window[name];
    return store ? store.getItem(key) : null;
  } catch (_) { return null; }
}
function safeSet(name, key, value) {
  try {
    const store = window[name];
    if (!store) return;
    if (value == null) store.removeItem(key);
    else store.setItem(key, value);
  } catch (_) { /* storage may be blocked */ }
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// 'taken': names already in the list; a second household made in the same minute gets ' (2)' (review
// 2026-10-25: two were both '세대 10-25 06:59', in the list and in the delete dialog).
function defaultHouseholdName(d = new Date(), taken = []) {
  const p = (n) => String(n).padStart(2, '0');
  const base = `세대 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

// ---- editor ------------------------------------------------------------------------------------

class Editor {
  constructor() {
    this.root = $('#editor');
    this.canvas = $('#plan');
    this.wrap = $('#canvasWrap');
    this.ctx2d = this.canvas.getContext('2d');
    this.view = new View();
    this.store = null;
    this.unsubscribe = null;
    this.exportedAt = null;
    this.saveTimer = 0;
    this.saving = Promise.resolve();
    this.lastSaveError = 0;
    // Changes since the household was opened, and the one the last good save (or, without device storage,
    // the last export) carried: different = something is only on the screen (_hasUnsaved).
    this.changeSeq = 0;
    this.keptSeq = 0;
    this.savesInFlight = 0;
    // modifiedAt of the copy this window opened or last saved: another window's newer save is not
    // overwritten without asking (_checkConflict).
    this.baseModifiedAt = null;
    this._conflict = null;
    this.renderQueued = false;
    this.lastDroppedSeen = null;
    this.lastFocusedEdge = null;
    this.roomLabels = new Map();
    this.roomLabelsFor = null;
    // One function object, so the per-snapshot check cache (store.checkItems) can be reused.
    this.roomLabelFn = (id) => this.roomLabel(id);
    this.requestTextRelayoutFn = (ms) => this._requestTextRelayout(ms);
    // 치수선 보기: the dimension chains instead of the per-side values (remembered on this device).
    this.dimsView = safeGet('localStorage', DIMS_VIEW_KEY) === '1';
    // 외벽 보기: the exterior walls in red (remembered on this device; off until turned on).
    this.exteriorView = safeGet('localStorage', EXTERIOR_VIEW_KEY) === '1';
    this.dimBoxes = [];
    // Screen boxes of the room names of the last frame (a tap on a name opens its name field).
    this.nameBoxes = [];
    // Screen boxes of the movable texts of the last frame (선택: drag a name, label or number), and of
    // every text the text layer drew (tests: nothing overlaps).
    this.textBoxes = [];
    this.textItems = [];
    this._printScale = null;    // { project, derived, scale } (see printScale)
    this._dimRowCache = null;   // { project, map } (see _dimRowOk)
    this._dimObstacles = null;  // { project, derived, scale, boxes } (치수선 보기)

    const command = (fn, label, opts) => this.command(fn, label, opts);
    const requestRender = () => this.requestRender();
    const panelHost = $('#panel');

    // The bottom panel host is shared by three controllers: PanelController (lengths, rooms,
    // rectangles), OpeningPanel (창·문) and FixturePanel (설비). Whichever opens closes the others.
    const holdView = (anchor, run) => this.holdView(anchor, run);
    this.panel = new PanelController(panelHost, {
      store: () => this.store,
      command,
      toast,
      onChange: () => this._onPanelChange(),
      focusWorld: (pts) => this.focusWorld(pts),
      roomLabel: this.roomLabelFn,
      holdView,
      // The [외벽] switch of the length panel shows its result: it turns 외벽 보기 on.
      exteriorView: () => this.exteriorView,
      showExterior: () => { if (!this.exteriorView) this.setExteriorView(true, { quiet: true }); },
      // A size still being typed in the window/door or fixture panel is put in before this panel takes
      // the shared host (a tap on a wall with a window width typed, review 2026-10-25).
      beforeOpen: () => {
        if (this.openingPanel) this.openingPanel.flushDraft();
        if (this.fixtureTool) this.fixtureTool.panel.flushDraft();
      },
    });

    this.openingPrefs = new OpeningPrefs();
    this.openingPanel = new OpeningPanel(panelHost, {
      store: () => this.store,
      command,
      toast,
      onChange: () => this._onPanelChange(),
      onOpen: () => { this.panel.close(); this.fixtureTool.panel.close(); },
      prefs: this.openingPrefs,
      // [벽 길이 ▶]: the length panel takes the shared host over (_onPanelChange detaches this one).
      openEdge: (edgeId, prefer) => this.panel.openEdge(edgeId, prefer),
      holdView,
      view: this.view,
      // [열림 방향] names an unnamed room as the plan does ('이름 없는 실 2').
      roomLabel: this.roomLabelFn,
    });

    this.fixtureTool = new FixtureTool({
      store: () => this.store,
      view: this.view,
      command,
      toast,
      requestRender,
      panelHost,
      overlayHost: this.wrap,
      beforePanelOpen: () => { this.panel.close(); this.openingPanel.close(); },
      onPanelChange: () => this._onPanelChange(),
      overlayRects: () => this.overlayRects(),
    });

    this.memoTool = new MemoTool({
      store: () => this.store,
      view: this.view,
      command,
      toast,
      requestRender,
      overlayHost: this.wrap,
      // [메모 지우개] has its own hint.
      onModeChange: () => { if (this.tools && this.tools.tool === 'memo') this._setHint(this.memoTool.hint); },
    });

    // 지우개: rub what should go (red preview, one undo step, its own toast).
    this.eraserTool = new EraserTool({
      store: () => this.store,
      view: this.view,
      command,
      toast,
      requestRender,
    });

    this.checks = new ChecksPanel($('#checksPopover'), {
      store: () => this.store,
      command,
      toast,
      requestRender,
      roomLabel: this.roomLabelFn,
      focusWorld: (pts, center) => this.focusWorld(pts, center),
      openEdge: (edgeId, prefer) => this.panel.openEdge(edgeId, prefer),
      openRoom: (roomId) => this.panel.openRoom(roomId),
      openOpening: (id) => this.openingPanel.open(id),
      openFixture: (id) => this.fixtureTool.openFixture(id),
      checkOptions: () => CHECK_OPTIONS,
    });

    this.output = new OutputDialog(document.body, {
      store: () => this.store,
      toast,
      // ※ notes of the unresolved 확인필요 items (the dialog adds the 양쪽 값 note itself).
      notesFor: () => notesForPrint(this.checkItems(), { drawingOnly: false, bothValues: false }),
      // [↻ 도면 회전] in the dialog: the same command as the editor's [↻ 회전].
      rotate: () => this.rotatePlan({ quiet: true }),
    });

    this.tools = new ToolController({
      store: () => this.store,
      view: this.view,
      panel: this.panel,
      command,
      toast,
      requestRender,
      onToolChange: (name) => this._onToolChange(name),
      openOpening: (id, opts) => this.openingPanel.open(id, opts),
      openingPrefs: this.openingPrefs,
      fixtureTool: this.fixtureTool,
      memoTool: this.memoTool,
      eraserTool: this.eraserTool,
      tapExtra: (world) => this._tapDimension(world),
      roomNameAt: (world, padPx) => this.roomNameAt(world, padPx),
      closePanels: () => this.closePanels(),
      labelAt: (screen) => this.labelAt(screen),
      labelMove: (hit, dx, dy) => this.labelMove(hit, dx, dy),
      onLabelLongPress: (hit) => this._askResetLabel(hit),
    });

    // The canvas takes no focus (InputController prevents the default of every pointerdown), so the
    // last button clicked kept it and Enter pressed it again — e.g. [↻ 회전] turned the plan a second
    // time (review 0.5.0). Work on the plan leaves the buttons.
    this.canvas.addEventListener('pointerdown', () => {
      const a = document.activeElement;
      if (a && a.tagName === 'BUTTON' && this.root.contains(a)) a.blur();
    }, true);
    // The same right after a pointer click on a top-bar, toolbar or canvas button ([↻ 회전], [치수선 보기],
    // [외벽 보기], [전체 보기] …): Enter before touching the plan turned the plan again (review 2026-10-25).
    // A keyboard click (detail 0) keeps the focus, so Tab / Enter still work.
    this.root.addEventListener('click', (e) => {
      if (e.detail === 0) return;
      const b = e.target && e.target.closest && e.target.closest('button');
      if (b && b.closest('.topbar, #toolbar, .view-btns') && document.activeElement === b) b.blur();
    });

    this.input = new InputController(this.canvas, this.view, {
      onGestureStart: (g) => this.tools.onGestureStart(g),
      onGestureMove: (g) => this.tools.onGestureMove(g),
      onGestureEnd: (g) => this.tools.onGestureEnd(g),
      onGestureCancel: (g) => this.tools.onGestureCancel(g),
      onViewChange: () => this.requestRender(),
      // body.pen-near: a toast's own button lets a pen tap through to the plan under it (app.css .toast-action).
      onPenStatus: (near) => { $('#penChip').hidden = !near; document.body.classList.toggle('pen-near', !!near); },
    });
    // A palm on the numpad while the S Pen is in use types nothing (input.js installPalmGuard).
    installPalmGuard(panelHost, this.input);

    this._bindChrome();
    this._bindKeyboard();
    this._bindResize();
    this._onToolChange(this.tools.tool);
  }

  get isOpen() {
    return !!this.store && !this.root.hidden;
  }

  // ---- open / close ----------------------------------------------------------------------------

  // opts.unsaved: not stored on this device yet (an import whose save failed); opts.keepView: the view
  // stays (a newer copy saved by another window, opened in its place).
  open(project, { unsaved = false, keepView = false } = {}) {
    const view = keepView ? { scale: this.view.scale, ox: this.view.ox, oy: this.view.oy } : null;
    // Panels still open belong to the household shown so far: closed without putting anything into the
    // new one.
    this.panel.close({ discard: true });
    this.openingPanel.close({ discard: true });
    this.fixtureTool.panel.close({ discard: true });
    this._detach();
    this.store = new DocStore(project);
    this.changeSeq = 0;
    this.keptSeq = 0;
    this._conflict = null;
    this._staleBy = null;
    this._leaving = false;
    this.baseModifiedAt = unsaved ? null : (project.modifiedAt || null);
    // Quarter turns since the household was opened (the toast says how many more give it back).
    this.turnCount = 0;
    this.exportedAt = project.exportedAt || null;
    this.lastDroppedSeen = this.store.lastDropped || null;
    this.prevProject = this.store.project;
    this.unsubscribe = this.store.subscribe((_store, change) => this._onStoreChange(change));
    this.root.hidden = false;
    $('#list').hidden = true;
    this.closePanels();
    this.checks.close();
    this.tools.setTool('wall');
    this._updateDimsButton();
    this._updateExteriorButton();
    safeSet('sessionStorage', OPEN_KEY, project.id);
    this._updateTopBar();
    this._setSaveState(storageOk ? 'saved' : 'nostore');
    if (view) {
      Object.assign(this.view, view);
      this.requestRender();
      return;
    }
    // Wait one frame so the canvas has its size before fitting the view.
    requestAnimationFrame(() => {
      this._resize();
      if (!this.input.busy) this.fitAll();
    });
  }

  // Flush autosave and leave the editor. Resolves after the save: true when the editor closed, false when
  // the user stayed (the last change is not stored on this device and they chose [내보내기] or nothing;
  // opts.force skips that question). Numbers and names still being typed are put in first.
  // opts.onLeave: called once leaving is decided, before the list shows (the Android back's history entry).
  async close(showList = true, { force = false, onLeave = null } = {}) {
    this._closeDialogs();
    this.tools.cancel();
    this.closePanels();
    this.checks.close();
    this.output.close();
    if (!force && !(await this.confirmLeave())) return false;
    if (typeof onLeave === 'function') {
      try { onLeave(); } catch (err) { console.error(err); }
    }
    this._detach();
    safeSet('sessionStorage', OPEN_KEY, null);
    if (showList) {
      this.root.hidden = true;
      $('#list').hidden = false;
      document.title = '평면도';
      this._placeToasts();
      await this.saving;
      if (list) list.refresh();
    }
    return true;
  }

  // Every dialog over the editor (세대 정보, 설정, a question, 출력) closes as with Esc. → number closed
  _closeDialogs() {
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const all = document.querySelectorAll('.dialog-backdrop');
      const before = all.length;
      if (!before) break;
      // On the dialog itself (not on document, where the editor's own Esc would close a panel too).
      all[before - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const after = document.querySelectorAll('.dialog-backdrop').length;
      if (after >= before) break;   // one that does not close by Esc (a save in progress)
      n += before - after;
    }
    return n;
  }

  // The Android back button inside the editor closes what is open first — a dialog (as Esc), the 검사 list,
  // a gesture or ghost, a bottom panel (what was typed is kept) — and leaves the editor only when nothing
  // is open (review 2026-10-25: the editor closed behind an open 세대 정보 form, whose [저장] then went
  // nowhere). → true when something was closed (the editor stays)
  backInside() {
    if (document.querySelector('.dialog-backdrop')) {
      this._closeDialogs();
      return true;
    }
    if (this.checks.isOpen) { this.checks.close(); return true; }
    if (this.input.cancel()) return true;
    if (this.tools.cancel()) return true;
    if (this.panel.isOpen || this.openingPanel.isOpen || this.fixtureTool.panel.isOpen) {
      this.closePanels();
      return true;
    }
    return false;
  }

  // Something is only on the screen: the last change could not be stored on this device (storage full, a
  // conflict with another window), or there is no device storage and it was not exported since.
  _hasUnsaved() {
    return !!this.store && this.changeSeq !== this.keptSeq;
  }

  // Before leaving the editor (or reloading for an update): the last save is retried once; when it still
  // fails, the user is asked (DESIGN.md §5: never lose the in-memory document; review 2026-10-25: [≡ 목록]
  // after a failed save dropped the last room for good). → true when leaving may go on
  async confirmLeave() {
    if (!this.store) return true;
    const before = this.store;
    await this.flushSave();
    if (this._conflict && this.store === before) {
      await this._askConflict(before, this.projectForSave(), this._conflict.stored, true);
      await this.saving;
      if (this.store !== before) return true;   // the other window's copy is open now
      if (this._conflict) return false;          // not answered: stay
    }
    if (!this._hasUnsaved()) return true;
    if (storageOk && !this._conflict) {
      await this.saveNow();
      if (!this._hasUnsaved()) return true;
    }
    const store = this.store;
    const res = await openDialog({
      title: '이 기기에 저장되지 않은 내용이 있습니다',
      message: storageOk
        ? '마지막으로 바꾼 내용을 이 기기에 저장하지 못했습니다 (저장공간 부족 등).\n지금 나가면 그 내용은 없어집니다. 먼저 [내보내기]로 파일을 보관해 주세요.'
        : '이 브라우저에서는 기기 안에 도면을 저장할 수 없습니다.\n지금 나가면 그린 내용이 없어집니다. 먼저 [내보내기]로 파일을 보관해 주세요.',
      buttons: [{ label: '그래도 나가기', value: 'leave', kind: 'danger' }, { label: '내보내기', value: 'export', kind: 'primary' }],
    });
    if (this.store !== store) return true;
    if (res.button === 'leave') {
      this._leaving = true;
      return true;
    }
    if (res.button === 'export') await this.exportFile();
    return false;
  }

  // Synchronously drop the current document; a pending autosave is started first (saveNow takes
  // its snapshot immediately), so nothing typed is lost.
  _detach() {
    if (!this.store) return;
    if (this.saveTimer) this.saveNow();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.store = null;
    this.exportedAt = null;
  }

  // ---- commands and store changes --------------------------------------------------------------

  // Run a store command; never let an engine error lose the document or break the UI.
  // opts.report = false: the caller says itself what happened to the values (the 지우개's toast), so the
  // general "길이 값 …" toast is not shown.
  command(fn, label = '작업', { report = true } = {}) {
    if (!this.store) return false;
    try {
      fn();
    } catch (err) {
      console.error(`${label} failed`, err);
      toast(`작업을 하지 못했습니다 (${label}). 다시 해 보세요.`, { type: 'error' });
      this.requestRender();
      return false;
    }
    this._reportDropped(report);
    return true;
  }

  _reportDropped(show = true) {
    const dropped = this.store && this.store.lastDropped;
    const detached = this.store && this.store.lastDetached;
    if (!show) {
      // already reported by the caller
    } else if (dropped && dropped !== this.lastDroppedSeen && dropped.length) {
      toast(`없어진 벽의 길이 값 ${dropped.length}개가 지워졌습니다. 다시 넣어 주세요.`, { type: 'warn', ms: 4000 });
    } else if (detached && detached.length && detached !== this.lastDetachedSeen) {
      // Values whose side is gone for now (DESIGN.md §7.7): kept, they attach again when it is drawn.
      toast(`길이 값 ${detached.length}개는 그대로 두었습니다. 벽을 다시 그리면 다시 붙습니다.`, { type: 'ok', ms: 4000 });
    }
    this.lastDetachedSeen = detached || null;
    this.lastDroppedSeen = dropped || null;
  }

  _onStoreChange(change) {
    const prev = this.prevProject;
    this.prevProject = this.store.project;
    this.roomLabelsFor = null;
    this.panel.refresh();
    this.openingPanel.refresh();
    this.fixtureTool.panel.refresh();
    this._updateTopBar();
    this.scheduleSave();
    this.requestRender();
    const merged = change && change.roomChanges && change.roomChanges.merged;
    if (merged && merged.length && change.type !== 'undo' && change.type !== 'redo') {
      this._askMergedNames(merged, prev, change.type);
    }
  }

  // Two rooms became one (a wall was removed): keep the name the user picks (plan §5-7).
  // After the 지우개 (type 'eraseItems') the name goes into the erase's undo step while nothing else
  // happened in between (store.setRoomAfterErase), so one ↶ still gives the plan back.
  async _askMergedNames(merged, prev, type = null) {
    const store = this.store;
    const afterErase = type === 'eraseItems' && typeof store.setRoomAfterErase === 'function';
    const rename = (kept, patch) => (afterErase ? store.setRoomAfterErase(kept, patch) : store.setRoom(kept, patch));
    // Not inside the erase's own notification: the erase finishes first (its undo step, the values it left
    // waiting for the toast), then the name is folded into that step.
    if (afterErase) await Promise.resolve();
    if (this.store !== store) return;
    for (const { kept, removed } of merged) {
      const gone = prev && (prev.rooms || []).find((r) => r.id === removed);
      const room = (store.project.rooms || []).find((r) => r.id === kept);
      if (!gone || !room || !gone.name || gone.name === room.name) continue;
      const height = room.height != null ? room.height : gone.height;
      if (!room.name) {
        this.command(() => rename(kept, { name: gone.name, height }), '실 이름');
        continue;
      }
      const res = await openDialog({
        title: '두 실이 하나로 합쳐졌습니다',
        message: '합쳐진 실의 이름을 골라 주세요.',
        buttons: [{ label: gone.name, value: 'gone' }, { label: room.name, value: 'kept', kind: 'primary' }],
      });
      if (this.store !== store) return;
      if (res.button === 'gone') this.command(() => rename(kept, { name: gone.name, height }), '실 이름');
    }
  }

  // ---- autosave --------------------------------------------------------------------------------

  projectForSave() {
    const p = this.store.project;
    const exportedAt = laterIso(p.exportedAt, this.exportedAt);
    return exportedAt === p.exportedAt ? p : { ...p, exportedAt };
  }

  scheduleSave() {
    if (!this.store) return;
    this.changeSeq++;
    clearTimeout(this.saveTimer);
    this._setSaveState(storageOk ? (this._conflict ? 'conflict' : 'pending') : 'nostore');
    this.saveTimer = setTimeout(() => this.saveNow(), TIMING.autosave);
  }

  // pagehide (a tab or window closing): the normal save awaits the connection and reads the stored copy
  // before it writes, and a closing page is gone before the write is issued (review 2026-10-25: a value
  // typed and the window closed at once was lost). When a change waits for the autosave and nothing is
  // being written, it is written at once on the open connection (storage.saveProjectNow). Not while a
  // save runs (its older copy could land after) or another window's save is known (that asks first).
  // The normal save follows as always, for a page that stays (back / forward cache).
  // Also called from beforeunload (a PC tab or window closing, an Android tab navigating), which comes
  // BEFORE pagehide: the flush there started the slow save and cleared the timer, so the fast write never
  // ran (recheck 2026-10-25: 1 of 2 rooms stored after the frame navigated away).
  saveAtPageHide() {
    if (storageOk && this.store && this.saveTimer && !this.savesInFlight && !this._conflict && !this._staleBy) {
      const project = this.projectForSave();
      const wrote = storage.saveProjectNow(project);
      if (wrote) this._noteOwnWrite(project);
      this.pageHideWrites = (this.pageHideWrites || 0) + (wrote ? 1 : 0);
    }
    return this.flushSave();
  }

  async flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      await this.saveNow();
    }
    await this.saving;
  }

  saveNow({ overwrite = false } = {}) {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.store || !storageOk) return Promise.resolve();
    // Another window saved this household after this one opened it: nothing is written until the user
    // has chosen (_askConflict).
    if (this._conflict && !overwrite) {
      this._askConflict(this.store, this.projectForSave(), this._conflict.stored, true);
      return this.saving;
    }
    const store = this.store;
    const project = this.projectForSave();
    const seq = this.changeSeq;
    const queuedBase = this.baseModifiedAt;
    this.savesInFlight++;
    this.saving = this.saving.then(async () => {
      try {
        // The base is read when this save runs, not when it was queued: saves run one after another, and
        // the one before this may have just written this window's own newer copy (recheck 2026-10-25: a
        // change made while the autosave was being written, then [≡ 목록] at once, was taken for another
        // window's save, and [다른 창의 것 열기] dropped the last change). A copy this window wrote itself
        // (ownWrites) is never another window's either.
        const base = overwrite ? null : (this.store === store ? this.baseModifiedAt : queuedBase);
        if (base) {
          let stored = null;
          try { stored = await storage.loadProject(project.id); } catch (_) { stored = null; }
          if (stored && stored.modifiedAt && stored.modifiedAt !== base && stored.modifiedAt !== project.modifiedAt
            && !this._wroteItself(project.id, stored.modifiedAt)) {
            this._onConflict(store, project, stored);
            return;
          }
        }
        await storage.saveProject(project);
        this._noteOwnWrite(project);
        if (this.store === store) {
          this.baseModifiedAt = project.modifiedAt || this.baseModifiedAt;
          if (seq > this.keptSeq) this.keptSeq = seq;
          // '저장됨' only when no newer change waits (review 2026-10-25: it showed while one did).
          if (!this.saveTimer && this.keptSeq === this.changeSeq && !this._conflict) this._setSaveState('saved');
        }
        announceSaved(project);
      } catch (err) {
        console.error('save failed', err);
        if (this.store === store) this._setSaveState('error');
        const now = Date.now();
        if (now - this.lastSaveError > 15000) {
          this.lastSaveError = now;
          toast('이 기기에 저장하지 못했습니다. 그린 내용은 화면에 그대로 있습니다. [내보내기]로 파일을 보관해 주세요.', { type: 'error', ms: 6000 });
        }
      } finally {
        this.savesInFlight--;
      }
    });
    return this.saving;
  }

  // ---- the same household in two windows (the installed app and a Chrome tab, two PC tabs) ----------

  // The modifiedAt values this window has written itself, per household (the last few): a stored copy that
  // carries one of them is this window's own save, never another window's.
  _noteOwnWrite(project) {
    if (!project || !project.id || !project.modifiedAt) return;
    if (!this._ownWrites) this._ownWrites = new Map();
    const list = this._ownWrites.get(project.id) || [];
    if (!list.includes(project.modifiedAt)) list.push(project.modifiedAt);
    if (list.length > 20) list.splice(0, list.length - 20);
    this._ownWrites.set(project.id, list);
  }

  _wroteItself(id, modifiedAt) {
    const list = this._ownWrites && this._ownWrites.get(id);
    return !!(list && modifiedAt && list.includes(modifiedAt));
  }

  // The stored copy is newer than the one this window started from: stop the autosave and ask.
  _onConflict(store, project, stored) {
    if (this.store !== store) {
      // This window has left that household already: ask about its last change anyway.
      this._askConflict(store, project, stored, false);
      return;
    }
    this._conflict = { stored };
    this._setSaveState('conflict');
    this._askConflict(store, project, stored, true);
  }

  // → a promise that settles when the user has chosen (one question at a time).
  _askConflict(store, project, stored, current) {
    if (this._conflictAsking) return this._conflictAsking;
    const name = (project.info && project.info.householdName) || '이 세대';
    const run = async () => {
      const res = await openDialog({
        title: '이 세대가 다른 창에서 바뀌었습니다',
        message: `'${name}'을(를) 다른 창(설치한 앱이나 다른 탭)에서 이 창보다 나중에 저장했습니다.
이 창의 것으로 저장하면 다른 창에서 바꾼 내용은 없어집니다.`,
        buttons: [{ label: '이 창의 것으로 저장', value: 'mine' }, { label: '다른 창의 것 열기', value: 'theirs', kind: 'primary' }],
      });
      if (res.button === 'mine') {
        if (current && this.store === store) {
          this._conflict = null;
          await this.saveNow({ overwrite: true });
        } else {
          try {
            await storage.saveProject(project);
            announceSaved(project);
            if (list && !$('#list').hidden) list.refresh();
          } catch (err) {
            console.error('save failed', err);
            toast('저장하지 못했습니다.', { type: 'error' });
          }
        }
        return;
      }
      if (res.button === 'theirs' && current && this.store === store) {
        await this.reopenStored(stored.id, '다른 창에서 저장한 것을 열었습니다.');
      }
      // Dismissed: the autosave stays stopped; the next change (or leaving) asks again.
    };
    this._conflictAsking = run().catch((err) => console.error(err)).finally(() => { this._conflictAsking = null; });
    return this._conflictAsking;
  }

  // Opens the stored copy of the open household in its place (the view stays). → bool
  async reopenStored(id, message = '') {
    let p = null;
    try { p = await storage.loadProject(id); } catch (err) { console.error(err); }
    if (!p || !this.store || this.store.project.id !== id) return false;
    this.open(p, { keepView: true });
    if (message) toast(message, { type: 'ok' });
    return true;
  }

  // Another window saved a household (BroadcastChannel 'floorplan', announceSaved). The open copy here is
  // then older: opened again in its place when nothing here is unsaved, else the conflict question.
  onOtherSaved(msg) {
    if (!msg || !this.store || this.store.project.id !== msg.id) return;
    if (msg.modifiedAt && msg.modifiedAt === this.baseModifiedAt) return;
    this._staleBy = msg.modifiedAt || true;
    if (document.visibilityState !== 'hidden') this.catchUp();
  }

  // (When this window is seen again.) A newer copy saved elsewhere replaces an unchanged one here; with
  // changes here, the next save asks (_checkConflict in saveNow).
  async catchUp() {
    if (!this._staleBy || !this.store) return;
    // Not in the middle of something (a gesture, a dialog, an open panel): try again a little later.
    if (this.input.busy || document.querySelector('.dialog-backdrop')
      || this.panel.isOpen || this.openingPanel.isOpen || this.fixtureTool.panel.isOpen) {
      clearTimeout(this._catchUpTimer);
      this._catchUpTimer = setTimeout(() => this.catchUp(), 1500);
      return;
    }
    this._staleBy = null;
    if (this._conflict || this.saveTimer || this.savesInFlight) return;   // that save checks and asks
    if (this._hasUnsaved()) { this.saveNow(); return; }
    await this.reopenStored(this.store.project.id, '다른 창에서 바뀐 내용을 불러왔습니다.');
  }

  _setSaveState(state) {
    const elState = $('#saveState');
    const text = { saved: '저장됨', pending: '저장 중…', error: '저장 안 됨', nostore: '기기 저장 꺼짐', conflict: '저장 멈춤 (다른 창)' }[state] || '';
    elState.textContent = text;
    elState.dataset.state = state;
  }

  // ---- top bar -------------------------------------------------------------------------------

  _bindChrome() {
    $('#btnBack').addEventListener('click', () => {
      // Go through history so the Android back button and [≡ 목록] end the same way (backButton: the
      // popstate handler leaves at once instead of closing a panel first).
      if (history.state && history.state.screen === 'editor') {
        this.backButton = true;
        history.back();
      } else {
        this.close(true);
      }
    });
    $('#btnUndo').addEventListener('click', () => this.undo());
    $('#btnRedo').addEventListener('click', () => this.redo());
    $('#btnExport').addEventListener('click', () => this.exportFile());
    $('#btnRotate').addEventListener('click', () => this.rotatePlan());
    $('#btnChecks').addEventListener('click', () => this.checks.toggle());
    $('#btnOutput').addEventListener('click', () => this.openOutput());
    $('#btnTitle').addEventListener('click', () => this.editInfo());
    $('#btnFit').addEventListener('click', () => this.fitAll());
    $('#btnDims').addEventListener('click', () => this.setDimsView(!this.dimsView));
    $('#btnExterior').addEventListener('click', () => this.setExteriorView(!this.exteriorView));
    for (const b of document.querySelectorAll('#toolbar [data-tool]')) {
      b.addEventListener('click', () => this.tools.setTool(b.dataset.tool));
    }
    for (const b of document.querySelectorAll('[data-soon]')) {
      b.addEventListener('click', () => toast(`${b.dataset.soon}: 준비 중인 기능입니다. 다음 단계에서 추가됩니다.`));
    }
    document.addEventListener('pointerdown', (e) => {
      const pop = $('#checksPopover');
      if (!pop.hidden && !pop.contains(e.target) && e.target !== $('#btnChecks') && !$('#btnChecks').contains(e.target)) {
        this.checks.close();
      }
    });
  }

  _onToolChange(name) {
    for (const b of document.querySelectorAll('#toolbar [data-tool]')) {
      const on = b.dataset.tool === name;
      b.classList.toggle('tool-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this._setHint(name === 'memo' ? this.memoTool.hint : (TOOL_HINTS[name] || ''));
    this.canvas.dataset.tool = name;
    // A window/door or fixture panel belongs to what was being placed; a new tool starts fresh.
    // (The length and room panels stay: they are opened by taps in every tool.)
    this.openingPanel.close();
    this.fixtureTool.panel.close();
    // The 설비 / 메모 tools float a bar over the top of the canvas: move the plan out from under it.
    if (name === 'fixture' || name === 'memo') this._clearTopBar();
  }

  // The tool hint (top left of the plan), with the 설비 / 메모 bar placed right under it.
  _setHint(text) {
    $('#hint').textContent = text || '';
    this._placeToolBars();
  }

  // The floating 설비 / 메모 bar goes right under the tool hint, whatever its height (review 2026-10-25: the
  // bar was fixed at 66 px and covered the hint's last lines, in portrait most of it).
  _placeToolBars() {
    const hint = $('#hint');
    const shown = hint && hint.textContent.trim() && !hint.hidden;
    const top = shown ? Math.round(hint.offsetTop + hint.offsetHeight + 6) : 8;
    for (const bar of this.wrap.querySelectorAll('.fx-bar, .memo-bar')) bar.style.top = `${Math.max(8, top)}px`;
    this._placeToasts();
  }

  // The toasts go under whatever floats over the top of the plan: the canvas buttons, the tool hint and a
  // shown 설비 / 메모 bar (recheck 2026-10-25: a toast hid the 설비 chips for 2.6 s, its [되돌리기] lay over
  // '계단' / '기타' and took their taps, and in portrait it covered the hint). Off the editor: the CSS place.
  _placeToasts() {
    const host = $('#toasts');
    if (!host) return;
    if (!this.isOpen) { host.style.top = ''; return; }
    let bottom = 0;
    for (const el of this.wrap.querySelectorAll('.view-btns, #hint, .fx-bar, .memo-bar')) {
      if (el.hidden || !el.offsetHeight || (el.id === 'hint' && !el.textContent.trim())) continue;
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    }
    host.style.top = bottom > 0 ? `${Math.round(bottom + 8)}px` : '';
  }

  // Pan the plan down just enough that no part of it hides under the floating tool bar (and fit the
  // view when the plan is taller than the space left).
  _clearTopBar() {
    const b = this.store && projectBounds(this.store.project);
    if (!b) return;
    const area = this.visibleArea();
    if (!area.y) return;
    const top = this.view.toScreen({ x: b.minX, y: b.minY }).y;
    const bottom = this.view.toScreen({ x: b.maxX, y: b.maxY }).y;
    const margin = 24;
    if (top >= area.y + margin) return;
    if (bottom - top > area.h - 2 * margin) { this.fitAll(); return; }
    this.view.panBy(0, area.y + margin - top);
    this.requestRender();
  }

  // Close every bottom panel (length/room, window/door, fixture).
  // Each panel puts in what was typed in it (as a tap elsewhere does). The window / door and fixture panels
  // first: they share the host with the length panel and only put a draft in while it shows them.
  closePanels() {
    this.openingPanel.close();
    this.fixtureTool.panel.close();
    this.panel.close();
  }

  // ---- 치수선 보기 ------------------------------------------------------------------------------
  // Editing shows each side's measured value inside the room (stage A). 치수선 보기 shows the
  // dimension chains as they will be printed instead, and a tap on a number shows both values.

  setDimsView(on) {
    this.dimsView = !!on;
    safeSet('localStorage', DIMS_VIEW_KEY, this.dimsView ? '1' : null);
    this._updateDimsButton();
    this.fitAll();
    toast(this.dimsView ? '치수선 보기: 출력될 치수 줄을 보여 줍니다. 숫자를 누르면 양쪽 값이 나옵니다.' : '실마다 잰 값을 보여 줍니다.');
  }

  _updateDimsButton() {
    const b = $('#btnDims');
    b.classList.toggle('btn-on', this.dimsView);
    b.setAttribute('aria-pressed', this.dimsView ? 'true' : 'false');
    b.textContent = this.dimsView ? '치수선 보기 ✓' : '치수선 보기';
  }

  // ---- 외벽 보기 ---------------------------------------------------------------------------------
  // The exterior walls (core/exterior.js: the house's outline by itself, each wall as set with the length
  // panel's [외벽]) in red, as [출력] 종류 '외벽 표시' prints them. opts.quiet: no toast (the panel says it).

  setExteriorView(on, { quiet = false } = {}) {
    this.exteriorView = !!on;
    safeSet('localStorage', EXTERIOR_VIEW_KEY, this.exteriorView ? '1' : null);
    this._updateExteriorButton();
    this.requestRender();
    if (quiet) return;
    if (!this.exteriorView) { toast('외벽 보기를 껐습니다.'); return; }
    let n = 0;
    try { n = this.store ? exteriorIds(this.store.project, this.store.derived).size : 0; } catch (_) { n = 0; }
    toast(n
      ? '외벽 보기: 외벽을 빨간색으로 보여 줍니다. 잘못 칠해진 벽이나 빠진 벽은 눌러서 [외벽]으로 고치세요.'
      : '외벽 보기: 아직 외벽이 없습니다. 벽으로 둘러싸인 실이 생기면 바깥쪽 벽이 빨간색으로 보입니다.', { ms: 4000 });
  }

  _updateExteriorButton() {
    const b = $('#btnExterior');
    b.classList.toggle('btn-on', this.exteriorView);
    b.setAttribute('aria-pressed', this.exteriorView ? 'true' : 'false');
    b.textContent = this.exteriorView ? '외벽 보기 ✓' : '외벽 보기';
  }

  // The walls drawn red now: none while the view is off, and none while the 지우개 shows in red what a rub
  // will erase (red would mean both). → Set | null
  _exteriorShown(project, derived) {
    if (!this.exteriorView || !project || !derived) return null;
    const plan = this.eraserTool && this.eraserTool.plan;
    if (plan && !plan.empty) return null;
    try { return exteriorIds(project, derived); } catch (err) { console.error('exterior failed', err); return null; }
  }

  // A tap on a dimension number in 치수선 보기: "주방 쪽 2800 / 방3 쪽 2700". → bool (handled)
  _tapDimension(world) {
    if (!this.dimsView || !this.store || !this.dimBoxes.length) return false;
    const s = this.view.toScreen(world);
    const pad = 6;
    const hit = this.dimBoxes.find((h) => {
      const b = h.textBox || h.box;
      return b && s.x >= b.x - pad && s.x <= b.x + b.w + pad && s.y >= b.y - pad && s.y <= b.y + b.h + pad;
    });
    if (!hit) return false;
    // Unnamed rooms as the plan numbers them ('이름 없는 실 2 쪽 2700'), so two of them differ.
    const p = this.store.project;
    const named = { ...p, rooms: (p.rooms || []).map((r) => (r && !r.name ? { ...r, name: this.roomLabel(r.id) } : r)) };
    const text = describeDim(named, hit.dim);
    if (text) toast(text, { ms: 4000 });
    return true;
  }

  openOutput() {
    if (!this.store) return;
    this.checks.close();
    this.tools.cancel();
    this.output.open();
  }

  _updateTopBar() {
    if (!this.store) return;
    const p = this.store.project;
    const name = (p.info && p.info.householdName) || '새 세대';
    $('#btnTitle').textContent = name;
    document.title = `${name} - 평면도`;
    $('#btnUndo').disabled = !safeCall(() => this.store.canUndo(), false);
    $('#btnRedo').disabled = !safeCall(() => this.store.canRedo(), false);
    $('#btnRotate').disabled = !(p.nodes && p.nodes.length);
    // [검사 N]: N = unresolved 확인필요 items (참고 items are listed in the panel but not counted).
    const n = countForBadge(this.checkItems());
    const btn = $('#btnChecks');
    btn.textContent = `검사 ${n}`;
    btn.classList.toggle('has-warnings', n > 0);
    this.checks.refresh();
  }

  undo() {
    if (!this.store || !safeCall(() => this.store.canUndo(), false)) return;
    const run = () => this.command(() => this.store.undo(), '되돌리기');
    // Undoing a value the view was held for (holdView) holds the same point, so the plan comes back
    // where and as large as it was before the value (not at the zoom that kept the new plan's size).
    // The records are kept per step (_viewKey), so they hold after a 회전 too.
    const held = this._heldAfter && this.store.derived && this._heldAfter.get(this._viewKey(this.store.derived));
    if (held) this._holdView(held.anchor, run, () => this._viewKey(this.store.derived) === held.before);
    else run();
  }

  redo() {
    if (!this.store || !safeCall(() => this.store.canRedo(), false)) return;
    const run = () => this.command(() => this.store.redo(), '다시 실행');
    const held = this._heldBefore && this.store.derived && this._heldBefore.get(this._viewKey(this.store.derived));
    if (held) this._holdView(held.anchor, run, () => this._viewKey(this.store.derived) === held.after);
    else run();
  }

  // The key of a step's derived data for the view records: the same before and after a 회전, which
  // turns the plan and every snapshot of its history (store.stepKey, core/rotate.js).
  _viewKey(derived) {
    const s = this.store;
    return s && typeof s.stepKey === 'function' ? s.stepKey(derived) : derived;
  }

  // ---- 도면 회전 ------------------------------------------------------------------------------
  // [↻ 회전] (and [↻ 도면 회전] in the 출력 dialog): the whole plan turns a quarter turn clockwise
  // (core/rotate.js). Not an undo step (user 2026-10-21): ↶ / ↷ never change the orientation; four
  // presses give the original back. The view fits the turned plan.
  // opts.quiet: no toast (the dialog shows the result in its preview). → bool (turned)
  rotatePlan({ quiet = false } = {}) {
    if (!this.store) return false;
    const store = this.store;
    if (!(store.project.nodes && store.project.nodes.length)) {
      toast('회전할 도면이 없습니다. 벽을 먼저 그려 주세요.', { type: 'warn' });
      return false;
    }
    this.tools.cancel();
    this.closePanels();
    let turned = false;
    this.command(() => { turned = store.rotatePlan(1); }, '도면 회전');
    if (!turned) return false;
    this.turnCount = ((this.turnCount || 0) + 1) % 4;
    this.fitAll();
    if (!quiet) toast(rotateToastText(this.turnCount), { type: 'ok', ms: 3500 });
    return true;
  }

  async exportFile() {
    if (!this.store) return;
    await this.flushSave();
    // fileio does not modify the project; it returns the export time, which we keep and save.
    try {
      const res = await exportProject(this.projectForSave());
      if (!res || res.method === 'cancelled') {
        toast('보내기를 취소했습니다.');
        return;
      }
      this.exportedAt = laterIso(this.exportedAt, res.exportedAt || new Date().toISOString());
      // Without device storage the exported file is the kept copy (leaving no longer asks).
      if (!storageOk) this.keptSeq = this.changeSeq;
      await this.saveNow();
      if (list) list.refresh();
      const name = res.fileName || '';
      if (res.method === 'share') toast(`보냈습니다. ${name}`, { type: 'ok' });
      else if (res.shareFailed) {
        toast(`공유 창을 열지 못해서 다운로드 폴더에 저장했습니다. ${name} · 드라이브로 보내려면 [내보내기]를 한 번 더 눌러 주세요.`, { type: 'warn', ms: 7000 });
      } else toast(`다운로드 폴더에 저장했습니다. ${name}`, { type: 'ok', ms: 4000 });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        toast('보내기를 취소했습니다.');
        return;
      }
      console.error('export failed', err);
      toast('내보내지 못했습니다. 다시 해 보세요.', { type: 'error' });
    }
  }

  // 설정 changed something (lists, sizes, the label spacing rule, or the open household's values):
  // the window/door panel shows the new chips, and every label is laid out again.
  settingsChanged() {
    this._printScale = null;
    this._dimObstacles = null;
    this._dimRowCache = null;
    try { this.openingPanel.refresh(); } catch (err) { console.error('panel refresh failed', err); }
    this._updateTopBar();
    this.requestRender();
  }

  // [세대명] in the top bar: the household information form (세대 정보 + 도면 제목).
  async editInfo() {
    if (!this.store) return;
    this.checks.close();
    await openInfoForm({ store: this.store, command: (fn, l) => this.command(fn, l), toast });
  }

  // ---- checks (검사 N) -----------------------------------------------------------------------

  // Every check item of the current snapshot (cached by the store per snapshot).
  checkItems() {
    if (!this.store || typeof this.store.checkItems !== 'function') return [];
    try {
      const items = this.store.checkItems({ roomLabel: this.roomLabelFn, ...CHECK_OPTIONS });
      return Array.isArray(items) ? items : [];
    } catch (err) {
      console.error('checks failed', err);
      return [];
    }
  }

  // Kept for older callers and tests: the same list as the 검사 panel.
  warnings() {
    return this.checkItems();
  }

  // ---- room labels ---------------------------------------------------------------------------

  roomLabel(roomId) {
    if (!this.store) return '';
    const derived = this.store.derived;
    if (this.roomLabelsFor !== derived) {
      this.roomLabels = new Map();
      let unnamed = 0;
      for (const r of (derived && derived.rooms) || []) {
        const name = r.room && r.room.name;
        this.roomLabels.set(r.roomId, name || `이름 없는 실 ${++unnamed}`);
      }
      this.roomLabelsFor = derived;
    }
    return this.roomLabels.get(roomId) || '실';
  }

  // The room whose name text (as drawn in the last frame) is under a world point, or null.
  roomNameAt(world, pad = 8) {
    if (!this.nameBoxes.length) return null;
    const s = this.view.toScreen(world);
    const hit = this.nameBoxes.find((b) => s.x >= b.x - pad && s.x <= b.x + b.w + pad && s.y >= b.y - pad && s.y <= b.y + b.h + pad);
    return hit ? hit.roomId : null;
  }

  // ---- moving texts by hand (plan §2-7) -------------------------------------------------------
  // In 선택, a drag on a room name (with its H), a window/door or fixture label, or (치수선 보기) a
  // dimension number moves that text. Offsets are PAPER mm (core/labels.js), converted with the
  // household's automatic print scale, so the screen shows a moved text where the print puts it.

  // The print scale [출력] chooses by itself for this household (1:50 … 1:150). Only needed once a
  // text has been moved (or is being moved); computed once per change of the document.
  printScale(force = false) {
    if (!this.store) return 60;
    const p = this.store.project, d = this.store.derived;
    const c = this._printScale;
    if (c && c.project === p && c.derived === d) return c.scale;
    const moved = Object.keys(p.labelOffsets || {}).length > 0;
    // Nothing moved: 1:60, unless this very document was just measured (the first drag of a text,
    // whose preview must use the scale the drag was computed with). Never another household's scale.
    if (!moved && !force) return c && c.project === p ? c.scale : 60;
    let scale = c ? c.scale : 60;
    try {
      const base = notesForPrint(this.checkItems(), { drawingOnly: false, bothValues: false });
      const notes = notesForChoices(p, d, DEFAULT_CHOICES, base);
      scale = computePrintLayout(p, d, { scale: 'auto', dpi: 300, noteLines: notes.maxLines, memo: printsMemo(DEFAULT_CHOICES) }).scale || scale;
    } catch (err) {
      console.error('print scale failed', err);
    }
    this._printScale = { project: p, derived: d, scale };
    return scale;
  }

  // The movable text under a screen point, from the last frame. → hit | null
  //   { type: 'label', key, kind, refId, base, center (world), moved }
  //   { type: 'dim', key: 'dim:<key>', item (draw-dims layout item), moved }
  labelAt(s) {
    if (!this.store || !s) return null;
    const pad = 4;
    const inBox = (b) => b && s.x >= b.x - pad && s.x <= b.x + b.w + pad && s.y >= b.y - pad && s.y <= b.y + b.h + pad;
    if (this.dimsView) {
      const it = this.dimBoxes.find((d) => d.drag && inBox(d.textBox));
      if (it) return { type: 'dim', key: `dim:${it.dim.key}`, item: it, moved: !!it.moved };
    }
    const offsets = this.store.project.labelOffsets || {};
    const project = this.store.project;
    // A fixture's label drawn inside the fixture: a drag there still moves the fixture, unless the
    // fixture is selected (its panel open) — then the drag moves its label.
    const insideItsFixture = (t) => {
      if (t.kind !== 'fixture' || this.fixtureTool.panel.fixtureId === t.refId) return false;
      const f = normalizeFixture((project.fixtures || []).find((x) => x.id === t.refId));
      if (!f) return false;
      const b = fixtureBounds(f);
      return t.center.x >= b.minX && t.center.x <= b.maxX && t.center.y >= b.minY && t.center.y <= b.maxY;
    };
    // The text drawn last is on top.
    for (let i = this.textBoxes.length - 1; i >= 0; i--) {
      const t = this.textBoxes[i];
      if (inBox(t) && t.key && t.base && t.center && !insideItsFixture(t)) {
        return { type: 'label', key: t.key, kind: t.kind, refId: t.refId, base: t.base, center: t.center, moved: !!offsets[t.key] };
      }
    }
    return null;
  }

  // The move a drag by (dx, dy) screen px makes (core/labels.js applyLabelMove), or null.
  labelMove(hit, dx, dy) {
    if (!this.store || !hit) return null;
    if (hit.type === 'dim') {
      const t = dimDragTarget(hit.item, dx, dy);
      const move = { key: hit.key };
      if (t.offset !== undefined) move.offset = t.offset;
      const row = this._dimRowFor(hit.item, t);
      if (row != null) move.dimRow = { measureId: hit.item.dim.key, row };
      return move.offset !== undefined || move.dimRow ? move : null;
    }
    const wppm = this.printScale(true);
    const k = this.view.scale;
    const at = { x: hit.center.x + dx / k, y: hit.center.y + dy / k };
    return { key: hit.key, offset: { dx: (at.x - hit.base.x) / wppm, dy: (at.y - hit.base.y) / wppm } };
  }

  // The row a dragged dimension snaps to: the nearest row of its side where it overlaps no other
  // dimension (one past the outermost row is allowed). null = it stays in its row.
  _dimRowFor(item, target) {
    const cur = item.row;
    const rows = [];
    for (let r = 0; r <= item.drag.rows; r++) rows.push(r);
    rows.sort((a, b) => Math.abs(a - target.rowFloat) - Math.abs(b - target.rowFloat));
    for (const r of rows) {
      if (r === cur) return null;
      if (this._dimRowOk(item, r)) return r;
    }
    return null;
  }

  _dimRowOk(item, r) {
    const project = this.store.project;
    if (!this._dimRowCache || this._dimRowCache.project !== project) this._dimRowCache = { project, map: new Map() };
    const key = `${item.dim.key}|${r}`;
    const map = this._dimRowCache.map;
    if (map.has(key)) return map.get(key);
    let ok = false;
    try {
      const p = applyLabelMove(project, { dimRow: { measureId: item.dim.key, row: r } });
      if (p) {
        const res = buildDimensions(p, this.store.derived, {});
        const chain = res.chains.find((c) => c.side === item.side);
        const row = chain && chain.rows[r];
        const me = row && row.find((d) => d.key === item.dim.key);
        ok = !!me && row.every((d) => d === me || !spansOverlap(d, me));
      }
    } catch (err) {
      console.error('dimension row check failed', err);
    }
    map.set(key, ok);
    return ok;
  }

  // 치수선 보기: the dimension numbers and lines as world boxes, which the labels keep clear of (the
  // same rule as on paper). Pan-independent, so it is computed once per document and zoom.
  _dimTextObstacles(ctx, project, derived, opts) {
    const scale = this.view.scale;
    const c = this._dimObstacles;
    if (c && c.project === project && c.derived === derived && c.scale === scale && c.wppm === opts.worldPerPaperMM) return c.boxes;
    let boxes = [];
    try {
      const p0 = this.view.toScreen({ x: 0, y: 0 });
      // A diagonal side's turned number counts as the small boxes along it (as on paper, output.js):
      // its bounding box would cover much more of the rooms beside it.
      boxes = layoutDimensions(ctx, project, derived, opts)
        .flatMap((it) => (it.aligned && Array.isArray(it.parts) ? it.parts : [it.textBox, it.box])).filter(Boolean)
        .map((b) => ({ minX: (b.x - p0.x) / scale, minY: (b.y - p0.y) / scale, maxX: (b.x + b.w - p0.x) / scale, maxY: (b.y + b.h - p0.y) / scale }));
    } catch (err) {
      console.error('dimension layout failed', err);
    }
    this._dimObstacles = { project, derived, scale, wppm: opts.worldPerPaperMM, boxes };
    return boxes;
  }

  // A long press on a moved text: [위치 되돌리기].
  async _askResetLabel(hit) {
    if (!this.store || !hit) return;
    const store = this.store;
    const res = await openDialog({
      title: '글자 위치',
      message: hit.type === 'dim' ? '옮긴 치수 숫자를 원래 자리(원래 줄)로 되돌릴까요?' : '옮긴 글자를 원래 자리로 되돌릴까요?',
      buttons: [{ label: '취소', value: null }, { label: '위치 되돌리기', value: 'reset', kind: 'primary' }],
    });
    if (res.button !== 'reset' || this.store !== store) return;
    const measureId = hit.type === 'dim' ? hit.item.dim.key : null;
    if (this.command(() => store.resetLabel(hit.key, measureId), '글자 위치 되돌리기')) toast('글자를 원래 자리로 되돌렸습니다.', { type: 'ok' });
  }

  // ---- view ----------------------------------------------------------------------------------

  // The part of the canvas not covered by the bottom panel or by a tool bar floating over its top
  // (설비 type chips, 메모 pen bar). opts.panel = false: as if the bottom panel were closed.
  visibleArea({ panel: withPanel = true } = {}) {
    const panel = $('#panel');
    const ph = !withPanel || panel.hidden ? 0 : panel.offsetHeight;
    let top = 0;
    const wrapTop = this.wrap.getBoundingClientRect().top;
    // The tool hint (top left) counts too, so a fitted plan starts below it (0.4.0: the plan's top
    // wall and its values were drawn under a long hint).
    for (const bar of this.wrap.querySelectorAll('#hint, .fx-bar, .memo-bar')) {
      if (bar.hidden || !bar.offsetHeight || (bar.id === 'hint' && !bar.textContent.trim())) continue;
      top = Math.max(top, bar.getBoundingClientRect().bottom - wrapTop);
    }
    top = Math.max(0, Math.min(top, this.view.height / 2));
    return { x: 0, y: top, w: this.view.width, h: Math.max(80, this.view.height - ph - top) };
  }

  // Canvas-px rectangles of the elements floating over the canvas (hint, tool bars, view buttons,
  // S펜 chip, bottom panel): the fixture size readout keeps clear of them. → [{ x, y, w, h }]
  overlayRects() {
    const wrapRect = $('#plan').getBoundingClientRect();   // canvas CSS px
    const out = [];
    for (const el of this.wrap.querySelectorAll('#hint, #penChip, .view-btns, .fx-bar, .memo-bar, #panel')) {
      if (el.hidden || !el.offsetHeight || (el.id === 'hint' && !el.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      out.push({ x: r.left - wrapRect.left, y: r.top - wrapRect.top, w: r.width, h: r.height });
    }
    return out;
  }

  fitAll() {
    this._resize();   // make sure the view knows the current canvas size
    const b = this.store && projectBounds(this.store.project);
    if (b) {
      // 치수선 보기 needs room around the plan for up to three dimension rows.
      this.view.fitBounds(b, this.visibleArea(), this.dimsView ? 120 : 56);
    } else {
      this.view.scale = ZOOM.initial;
      this.view.centerOn({ x: 0, y: 0 }, this.visibleArea());
    }
    this.requestRender();
  }

  // Pan the least amount so that the world points are visible above the panel.
  // opts.fit: when they do not fit at this zoom, zoom out until they do (centred); never zooms in.
  focusWorld(points, center = false, opts = {}) {
    if (!points || !points.length) return;
    const area = this.visibleArea();
    const margin = 60;
    if (opts.fit) {
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      const wb = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      const pad = Math.min(margin, area.w / 6, area.h / 6);
      const fitScale = Math.min((area.w - 2 * pad) / Math.max(1, wb.maxX - wb.minX), (area.h - 2 * pad) / Math.max(1, wb.maxY - wb.minY));
      if (fitScale < this.view.scale) {
        this.view.scale = Math.max(ZOOM.min, fitScale);
        this.view.centerOn({ x: (wb.minX + wb.maxX) / 2, y: (wb.minY + wb.maxY) / 2 }, area);
        this.requestRender();
        return;
      }
    }
    const s = points.map((p) => this.view.toScreen(p));
    const minX = Math.min(...s.map((p) => p.x)), maxX = Math.max(...s.map((p) => p.x));
    const minY = Math.min(...s.map((p) => p.y)), maxY = Math.max(...s.map((p) => p.y));
    let dx = 0, dy = 0;
    if (center || maxX - minX > area.w - 2 * margin || maxY - minY > area.h - 2 * margin) {
      dx = area.x + area.w / 2 - (minX + maxX) / 2;
      dy = area.y + area.h / 2 - (minY + maxY) / 2;
    } else {
      if (minX < area.x + margin) dx = area.x + margin - minX;
      else if (maxX > area.x + area.w - margin) dx = area.x + area.w - margin - maxX;
      if (minY < area.y + margin) dy = area.y + margin - minY;
      else if (maxY > area.y + area.h - margin) dy = area.y + area.h - margin - maxY;
    }
    if (dx || dy) {
      this.view.panBy(dx, dy);
      this.requestRender();
    }
  }

  // Keep the plan still while a typed value re-solves it (#26, #7). run() is the command (a length,
  // a wall thickness, a window width); anchor() names a world point in the CURRENT geometry (the
  // measured side's middle), called before and after it. The view pans so that point stays on the
  // same screen spot — the walls moved up to 4.5 m on the first value and the next wall to tap went
  // under the numpad. When the plan as a whole grows or shrinks by more than HOLD_ZOOM_STEP (the
  // first value replaces the sketch's own scale: ×0.5…×2; later ones still change it by a few %),
  // the view also zooms the other way about that spot, so the plan keeps its size on screen. The
  // view is never fitted again here: the surveyor's zoom and place stay. ↶ / ↷ of the command hold the
  // same point (undo / redo keep each snapshot's derived object, so the two snapshots are recorded).
  // → run()'s result
  holdView(anchor, run) {
    const store = this.store;
    const before = store && store.derived;
    const result = this._holdView(anchor, run);
    const after = this.store === store && store && store.derived;
    if (before && after && after !== before) {
      if (!this._heldAfter) { this._heldAfter = new WeakMap(); this._heldBefore = new WeakMap(); }
      const kb = this._viewKey(before), ka = this._viewKey(after);
      this._heldAfter.set(ka, { anchor, before: kb });
      this._heldBefore.set(kb, { anchor, after: ka });
    }
    return result;
  }

  // holdView without the record; applies() (optional) says after run() whether to move the view
  // (a redo may replay another command than the held one).
  _holdView(anchor, run, applies = null) {
    const store = this.store;
    const p0 = store ? safeCall(anchor, null) : null;
    const s0 = p0 ? this.view.toScreen(p0) : null;
    const d0 = store ? planDiagonal(store.project) : 0;
    const result = run();
    if (!s0 || !this.store || this.store !== store || (applies && !applies())) return result;
    const p1 = safeCall(anchor, null);
    if (!p1 || !isFinite(p1.x) || !isFinite(p1.y)) return result;
    const s1 = this.view.toScreen(p1);
    this.view.panBy(s0.x - s1.x, s0.y - s1.y);
    const d1 = planDiagonal(store.project);
    if (d0 > 0 && d1 > 0 && Math.abs(d1 / d0 - 1) > HOLD_ZOOM_STEP) this.view.zoomAt(s0.x, s0.y, d0 / d1);
    this.requestRender();
    return result;
  }

  // World points of an opening ('o:<id>') or a fixture ('f:<id>'), for focusWorld.
  _itemPoints(key) {
    const p = this.store.project, d = this.store.derived;
    const id = key.slice(2);
    if (key.startsWith('o:')) {
      const o = (p.openings || []).find((x) => x.id === id);
      const pl = o && placeOpening(p, d, o);
      if (!pl) return [];
      const fr = pl.frame;
      return [pl.s0, pl.s1].map((s) => ({ x: fr.A.x + fr.dir.x * s, y: fr.A.y + fr.dir.y * s }));
    }
    const f = normalizeFixture((p.fixtures || []).find((x) => x.id === id));
    if (!f) return [];
    const b = fixtureBounds(f);
    return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }];
  }

  _onPanelChange() {
    // PanelController has just taken the shared bottom panel over: forget the window/door panel
    // without touching the DOM (FixturePanel notices this by itself).
    if (this.panel.isOpen && this.openingPanel.isOpen) this.openingPanel.detach();
    const edgeId = this.panel.selectedEdgeId;
    if (edgeId && edgeId !== this.lastFocusedEdge && this.store) {
      const e = this.store.project.edges.find((x) => x.id === edgeId);
      const nodes = e ? this.store.project.nodes.filter((n) => n.id === e.a || n.id === e.b) : [];
      // Wait for the panel layout so its height is known.
      requestAnimationFrame(() => this.focusWorld(nodes));
    }
    this.lastFocusedEdge = edgeId;
    // The room panel (a tap in a room or on its name): the whole room in view above the panel.
    const roomId = this.panel.selectedRoomId;
    if (roomId && roomId !== this.lastFocusedRoom && this.store) {
      const dr = ((this.store.derived && this.store.derived.rooms) || []).find((r) => r.roomId === roomId);
      const pts = dr && dr.face && Array.isArray(dr.face.points) ? dr.face.points : [];
      if (pts.length) requestAnimationFrame(() => this.focusWorld(pts, false, { fit: true }));
    }
    this.lastFocusedRoom = roomId;
    // The window/door or fixture being edited stays visible above the panel.
    const itemKey = this.openingPanel.isOpen ? `o:${this.openingPanel.selectedId}`
      : this.fixtureTool.panel.isOpen ? `f:${this.fixtureTool.panel.fixtureId}` : null;
    if (itemKey && itemKey !== this.lastFocusedItem && this.store) {
      const pts = this._itemPoints(itemKey);
      if (pts.length) requestAnimationFrame(() => this.focusWorld(pts));
    }
    this.lastFocusedItem = itemKey;
    this.requestRender();
  }

  // ---- canvas --------------------------------------------------------------------------------

  _bindResize() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.wrap);
    window.addEventListener('resize', () => this._resize());
    const watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', () => { this._resize(); watchDpr(); }, { once: true });
    };
    watchDpr();
  }

  _resize() {
    const r = this.wrap.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    const changed = this.canvas.width !== pw || this.canvas.height !== ph;
    if (changed) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // The canvas got wider or narrower (the tablet turned between landscape and portrait, a PC window
    // resized): the plan stays in view (review 2026-10-25: 26–40 % of it was off-screen until [전체 보기]).
    // A height-only change (the on-screen keyboard) leaves the view as it is.
    const oldW = this.view.width, oldH = this.view.height;
    const keep = this.store && !this.root.hidden && oldW > 1 && oldH > 1 && Math.abs(w - oldW) >= 2
      ? this._viewBeforeResize(oldW, oldH) : null;
    this.view.setSize(w, h);
    if (keep) this._viewAfterResize(keep);
    this._placeToolBars();
    this.dpr = dpr;
    // Setting the canvas size clears it; draw now so the frame being painted is not blank
    // (ResizeObserver callbacks run after this frame's animation callbacks).
    if (changed) this.draw();
    else this.requestRender();
  }

  // Before the view takes a new width: the world point at the middle of the free area, and whether the
  // whole plan was in view. (The panel and hint have their new sizes already; the view the old ones.)
  // "In view" and the fit below count the canvas without the bottom panel (recheck 2026-10-25: turned with
  // the length panel open, the plan was fitted into the strip above the panel, at half size in landscape,
  // and stayed that small after the panel closed); the middle kept is the middle of what is seen.
  _viewBeforeResize(oldW, oldH) {
    const b = projectBounds(this.store.project);
    if (!b) return null;
    const area = this.visibleArea();
    const top = area.y, bottom = Math.max(top + 40, oldH - (oldH - area.y - area.h));
    const whole = this.visibleArea({ panel: false });
    const wholeBottom = Math.max(whole.y + 40, whole.y + whole.h);
    const p0 = this.view.toScreen({ x: b.minX, y: b.minY }), p1 = this.view.toScreen({ x: b.maxX, y: b.maxY });
    const allIn = p0.x >= -1 && p1.x <= oldW + 1 && p0.y >= whole.y - 1 && p1.y <= wholeBottom + 1;
    const mid = this.view.toWorld({ x: oldW / 2, y: (top + bottom) / 2 });
    return { mid, allIn };
  }

  // The same world point in the middle again; a plan that was wholly in view and no longer fits is fitted.
  _viewAfterResize(keep) {
    this.view.centerOn(keep.mid, this.visibleArea());
    if (keep.allIn) {
      const area = this.visibleArea({ panel: false });
      const b = projectBounds(this.store.project);
      const p0 = this.view.toScreen({ x: b.minX, y: b.minY }), p1 = this.view.toScreen({ x: b.maxX, y: b.maxY });
      const fits = p0.x >= area.x && p1.x <= area.x + area.w && p0.y >= area.y && p1.y <= area.y + area.h;
      if (!fits) {
        this.view.fitBounds(b, area, this.dimsView ? 120 : 56);
        // With a panel open, what was in the middle of the free area stays there (the wall being typed).
        const panel = $('#panel');
        if (panel && !panel.hidden) this.view.centerOn(keep.mid, this.visibleArea());
      }
    }
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.draw();
    });
  }

  // While a pinch / wheel zoom runs, the text layer draws its last layout again (render.js
  // drawScreenText); this draws once more when the zoom has stopped, which lays the texts out anew.
  _requestTextRelayout(ms) {
    clearTimeout(this._relayoutTimer);
    this._relayoutTimer = setTimeout(() => {
      this._relayoutTimer = 0;
      if (this.store) this.requestRender();
    }, ms);
  }

  draw() {
    const ctx = this.ctx2d;
    const dpr = this.dpr || window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.store) {
      ctx.clearRect(0, 0, this.view.width, this.view.height);
      return;
    }
    const hl = this.panel.highlight;
    const derived = this.store.derived;
    // While a text is dragged, the plan is drawn as the move will leave it (same data as the command).
    const preview = this.tools.labelPreview;
    const project = (preview && applyLabelMove(this.store.project, preview.move)) || this.store.project;
    const source = project === this.store.project ? this.store : { project, derived };
    const wppm = this.printScale();
    // Shared options of the stage B/C/D draw functions in screen mode (see draw-openings.js).
    const base = { toPx: (p) => this.view.toScreen(p), pxPerMM: this.view.scale, paper: null, worldPerPaperMM: wppm };
    const openingOpts = {
      ...base,
      background: COLORS.canvasBg,
      // In 치수선 보기 there are no per-side values inside the rooms, so labels sit at the wall.
      sideValues: !this.dimsView,
      options: { highlight: this.openingPanel.highlight },
    };
    const fixtureOpts = { ...base, options: { highlight: this.fixtureTool.highlight, excludeId: this.fixtureTool.resizingId } };
    // The fixtures layer draws the shapes only: every text is written by the text layer of renderPlan
    // (one placement with level of detail; render.js).
    const fixtureLayerOpts = { ...fixtureOpts, options: { ...fixtureOpts.options, drawingOnly: true } };
    // Memo lines: their fixed paper width as at 1:60 (core/memo.js), not the print scale of moved texts.
    const memoOpts = { ...base, worldPerPaperMM: 60, options: this.memoTool.screenOptions() };
    const dimOpts = { ...base, options: { extensionLines: true } };
    const items = this.checkItems();
    this.dimBoxes = [];
    this.nameBoxes = [];
    this.textBoxes = [];
    this.textItems = [];
    try {
      renderPlan(ctx, source, this.view, {
        mode: 'screen',
        nameBoxes: this.nameBoxes,
        textBoxes: this.textBoxes,
        textItems: this.textItems,
        // Window/door, fixture and 실 아님 labels come from the same text layer as the names and the
        // per-side values, so nothing overlaps (crowded rooms leave the less important texts out).
        openingLabels: true,
        fixtureLabels: true,
        notRoomLabels: true,
        fixtureExclude: this.fixtureTool.resizingId,
        worldPerPaperMM: wppm,
        textObstacles: this.dimsView ? this._dimTextObstacles(ctx, project, derived, dimOpts) : null,
        forceShow: preview ? preview.key : null,
        // Fixtures put into a wall (벽 속에 넣기) cut the wall band; drawFixtures draws over the gap.
        wallCutouts,
        // 외벽 보기: the exterior walls in red.
        exterior: this._exteriorShown(project, derived),
        selectedEdges: hl.selectedEdges,
        activeSide: hl.activeSide,
        // Unnamed rooms show the same numbered label as the length panel ("이름 없는 실 2").
        roomLabel: this.roomLabelFn,
        // A pinch / wheel zoom reuses the text layout; the texts are laid out again once it stops.
        requestRelayout: this.requestTextRelayoutFn,
        // Editing: each side's measured value inside the room. 치수선 보기: the printed chains.
        sideLabels: !this.dimsView,
        afterWalls: (c) => {
          // Openings first (they cut the wall), then fixtures and 실 아님 spaces on top.
          drawOpenings(c, project, derived, openingOpts);
          // Named 실 아님 spaces (예시 세대 A 옷장): the gray fill here, the name in the text layer.
          drawNotRoomSpaces(c, project, derived, fixtureLayerOpts);
          drawFixtures(c, project, derived, fixtureLayerOpts);
        },
        afterLabels: (c) => {
          if (this.dimsView) this.dimBoxes = drawDimensions(c, project, derived, dimOpts) || [];
          drawMemo(c, project, derived, memoOpts);
        },
      });
    } catch (err) {
      console.error('render failed', err);
    }
    try {
      drawCheckMarkers(ctx, project, derived, { ...base, items, options: { highlight: this.checks.highlightKey } });
    } catch (err) {
      console.error('check markers failed', err);
    }
    renderOverlay(ctx, this.view, this.tools.overlay);
    try {
      this.tools.openings.drawOverlay(ctx, openingOpts);
      this.fixtureTool.drawOverlay(ctx, fixtureOpts);
      this.memoTool.drawOverlay(ctx, memoOpts);
      // 지우개: what the rub so far will erase, in red, over everything.
      this.eraserTool.drawOverlay(ctx, base);
    } catch (err) {
      console.error('tool overlay failed', err);
    }
  }

  // ---- keyboard ------------------------------------------------------------------------------

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (document.querySelector('.dialog-backdrop')) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.checks.isOpen) this.checks.close();
        else if (this.input.cancel()) { /* gesture cancelled */ }
        else if (this.tools.cancel()) { /* rectangle or ghost cancelled */ }
        // Esc throws away a number or name still being typed (a tap elsewhere puts it in).
        else if (this.fixtureTool.panel.isOpen) this.fixtureTool.panel.close({ discard: true });
        else if (this.openingPanel.isOpen) this.openingPanel.close({ discard: true });
        else if (this.panel.isOpen) this.panel.close({ discard: true });
        return;
      }
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); return; }
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) this.input.setSpace(true);
        return;
      }
      // The window/door and fixture panels take digits, Backspace, Enter, Tab and Delete (지우기).
      if (!e.altKey && this.fixtureTool.panel.isOpen) {
        if (this.fixtureTool.panel.handleKey(e)) e.preventDefault();
        return;
      }
      if (!e.altKey && this.openingPanel.isOpen) {
        if (this.openingPanel.handleKey(e)) e.preventDefault();
        return;
      }
      if (e.key === 'Delete') {
        const edgeId = this.panel.selectedEdgeId;
        if (edgeId) {
          e.preventDefault();
          this.panel.deleteWall();
        }
        return;
      }
      if (e.altKey) return;
      if (this.panel.handleKey(e)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.input.setSpace(false);
    });
    window.addEventListener('blur', () => this.input.setSpace(false));
  }
}

function safeCall(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// The toast after a 회전: what happened and how many more presses give the first orientation back
// (turns: quarter turns since the household was opened, 0–3).
function rotateToastText(turns) {
  const left = (4 - (((turns % 4) + 4) % 4)) % 4;
  if (!left) return '도면을 오른쪽으로 90° 회전했습니다. 처음 방향으로 돌아왔습니다.';
  return `도면을 오른쪽으로 90° 회전했습니다. 원래대로 하려면 [↻ 회전]을 ${['', '한', '두', '세'][left]} 번 더 누르세요.`;
}

// Diagonal (mm) of the corners' extent, 0 without corners (Editor.holdView).
function planDiagonal(project) {
  const b = projectBounds(project);
  return b ? Math.hypot(b.maxX - b.minX, b.maxY - b.minY) : 0;
}

// ---- app actions -------------------------------------------------------------------------------

function newProject() {
  let project;
  try {
    project = createProject({
      householdName: defaultHouseholdName(new Date(), list ? list.names() : []),
      surveyor: safeGet('localStorage', SURVEYOR_KEY) || '',
    });
    // 설정 → 새 세대 기본값 (wall thicknesses and tolerances of this device, core/prefs.js).
    project.settings = { ...project.settings, ...householdSettings() };
  } catch (err) {
    console.error(err);
    toast('새 세대를 만들지 못했습니다.', { type: 'error' });
    return;
  }
  openProject(project);
  if (storageOk) editor.saveNow();
}

// opts.unsaved: the household is not stored on this device (an import whose save failed): the autosave tries
// again at once, so the top bar says '저장 안 됨' instead of '저장됨' while it is only on the screen.
function openProject(project, opts = {}) {
  try {
    editor.open(project, { unsaved: !!(opts && opts.unsaved) });
    if (opts && opts.unsaved && storageOk) editor.scheduleSave();
    history.pushState({ screen: 'editor' }, '');
  } catch (err) {
    console.error(err);
    toast('세대를 열지 못했습니다. 파일이 손상되었을 수 있습니다.', { type: 'error' });
    editor.close(true);
  }
}

// ---- service worker ----------------------------------------------------------------------------

// Registered only off localhost, or with ?sw=1, so that development reloads always get fresh files.
// The update flow itself (wait, [지금 적용], SKIP_WAITING, reload) lives in io/swclient.js.
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  const forced = new URLSearchParams(location.search).get('sw') === '1';
  if (local && !forced) return;
  registerServiceWorker('./sw.js');
  onUpdateAvailable(({ apply }) => showUpdateBanner(apply));
}

// "새 버전이 있습니다 [지금 적용] [나중에]": a strip at the top that moves the screen down instead of
// covering ↶ / ↷ (review 2026-10-25). [나중에] hides it for this visit; the new version is used the next
// time the app is opened. [지금 적용] asks first when something is not stored (Editor.confirmLeave).
let updateLater = false;
function showUpdateBanner(apply) {
  if (updateLater) return;
  const banner = $('#updateBanner');
  banner.hidden = false;
  document.body.classList.add('has-update');
  window.dispatchEvent(new Event('resize'));
  const btn = $('#btnApplyUpdate');
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    // A number or name still being typed goes in first, as on a tap elsewhere or Android back (recheck
    // 2026-10-25: the reload dropped 1234 typed in the length panel without a word); then the save.
    if (editor && editor.isOpen) {
      editor.tools.cancel();
      editor.closePanels();
    }
    if (editor && editor.isOpen && !(await editor.confirmLeave())) { btn.disabled = false; return; }
    apply({ beforeReload: () => (editor ? editor.flushSave() : undefined) });
  };
  $('#btnUpdateLater').onclick = () => {
    updateLater = true;
    banner.hidden = true;
    document.body.classList.remove('has-update');
    window.dispatchEvent(new Event('resize'));
    toast('새 버전은 다음에 앱을 열 때 적용됩니다.');
  };
}

// ---- other windows -------------------------------------------------------------------------------
// The installed app and a Chrome tab (or two PC tabs) share the device storage: a save here is announced
// so another window with the same household open catches up (Editor.onOtherSaved) and its list refreshes.
let channel = null;
function announceSaved(project) {
  try {
    if (channel) channel.postMessage({ type: 'saved', id: project.id, modifiedAt: project.modifiedAt || null });
  } catch (_) { /* closed */ }
}
function listenToOtherWindows() {
  if (typeof BroadcastChannel !== 'function') return;
  try { channel = new BroadcastChannel('floorplan-saves'); } catch (_) { channel = null; return; }
  channel.onmessage = (e) => {
    const msg = e && e.data;
    if (!msg || msg.type !== 'saved') return;
    if (editor && editor.isOpen) editor.onOtherSaved(msg);
    else if (list && !$('#list').hidden && storageOk) list.refresh();
  };
}

// ---- startup -----------------------------------------------------------------------------------

async function start() {
  $('#appVersion').textContent = `v${APP_VERSION}`;
  editor = new Editor();
  list = new ListScreen($('#list'), {
    toast,
    openProject,
    newProject,
    storageReady: () => storageOk,
    // The editor's [설정] (#btnSettings, bound by ListScreen): with the open household, so the
    // screen can offer [지금 연 세대에도 적용]; the panels and labels follow a changed list or rule.
    editorSettings: () => (editor && editor.isOpen ? {
      store: () => editor.store,
      command: (fn, l) => editor.command(fn, l),
      onChange: () => editor.settingsChanged(),
    } : null),
  });
  // Debug hook for developers and automated UI checks: open the app with ?debug=1.
  // With ?debug=1&testdb=<name> the app uses a separate IndexedDB database, so automated checks
  // (tests/ui-smoke.html) never touch the real household list.
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') {
    const testDb = params.get('testdb');
    if (testDb && /^[\w-]{1,40}$/.test(testDb)) storage.configureStorage({ name: `floorplan-db-${testDb}` });
    window.__floorplan = {
      editor, list, toast,
      get store() { return editor.store; },
      storageReady: () => storageOk,
      // The update strip as onUpdateAvailable shows it (tests: no service worker on localhost).
      showUpdateBanner: (apply) => showUpdateBanner(apply),
    };
  }

  listenToOtherWindows();

  // Show the list right away; it fills in once storage is open.
  const lastId = safeGet('sessionStorage', OPEN_KEY);
  if (!lastId) $('#list').hidden = false;
  try {
    await storage.openStorage();
    storageOk = true;
    if (editor.store) editor.scheduleSave();   // a household opened before storage was ready
  } catch (err) {
    console.error('storage unavailable', err);
    storageOk = false;
    toast('이 기기에 저장할 수 없습니다. 그린 도면은 [내보내기]로 꼭 보관해 주세요.', { type: 'error', ms: 8000 });
  }
  // (openStorage also purges trash older than 30 days.)

  history.replaceState({ screen: 'list' }, '');
  // The leave a back started, while it waits (the last save, a question): { done } — done once it left
  // and went back over the entry it put back.
  let backLeave = null;
  window.addEventListener('popstate', async () => {
    // Android back button: close what is open in the editor first; leave the editor for the list when
    // nothing is ([≡ 목록] leaves at once). Staying (something closed, or the user kept an unsaved
    // household) puts the editor's history entry back, so the next back works the same.
    const fromButton = editor.backButton;
    editor.backButton = false;
    if (backLeave) {
      if (backLeave.done) { backLeave = null; return; }   // the entry put back, gone back over after leaving
      // A second back while leaving waits on a question ('이 기기에 저장되지 않은 내용이 있습니다', another
      // window's save): it closes that question, as backInside does for other dialogs, and the editor's
      // entry is put back again (recheck 2026-10-25: it went past the app's first entry and closed the
      // installed app, with the drawing that could not be stored).
      if (editor.isOpen) {
        editor.backInside();
        history.pushState({ screen: 'editor' }, '');
      }
      return;
    }
    if (!editor.isOpen) return;
    if (!fromButton && editor.backInside()) { history.pushState({ screen: 'editor' }, ''); return; }
    // Leaving may ask first (Editor.confirmLeave): the editor's entry stays meanwhile, and is gone back over
    // once leaving is decided, before the list shows.
    history.pushState({ screen: 'editor' }, '');
    const leave = { done: false };
    backLeave = leave;
    const onLeave = () => {
      if (history.state && history.state.screen === 'editor') {
        leave.done = true;
        history.back();
      }
    };
    try {
      await editor.close(true, { onLeave });
    } finally {
      if (backLeave === leave && !leave.done) backLeave = null;
    }
  });

  // Save immediately when the app goes to the background or closes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && editor.store) editor.flushSave();
    if (document.visibilityState === 'visible' && editor.store) editor.catchUp();
  });
  window.addEventListener('pagehide', () => { if (editor.store) editor.saveAtPageHide(); });
  // A PC tab closed within the autosave delay (or while the write runs, or after a failed save): Chrome asks
  // "사이트에서 나가시겠습니까?" and the save finishes meanwhile (review 2026-10-25: a value typed and
  // Enter, then the window closed at once, was lost). Not after the user chose to leave anyway.
  window.addEventListener('beforeunload', (e) => {
    if (!editor || !editor.store || editor._leaving) return;
    if (editor.saveTimer || editor.savesInFlight || editor._hasUnsaved()) {
      // The fast write first when a change waits (it is all a closing page can still issue), then the save.
      editor.saveAtPageHide();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Reopen the household that was open in this tab (e.g. Android reloaded a background tab).
  if (storageOk && lastId) {
    try {
      const p = await storage.loadProject(lastId);
      if (p) {
        openProject(p);
        list.refresh();
        return;
      }
    } catch (_) { /* fall through to the list */ }
  }
  $('#list').hidden = false;
  await list.refresh();
}

setupServiceWorker();
start().catch((err) => {
  console.error('start failed', err);
  toast('앱을 시작하지 못했습니다. 새로고침해 주세요.', { type: 'error', ms: 0 });
});
