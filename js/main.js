// App bootstrap and the editor screen controller (dev/DESIGN.md §1, §5).
// - registers the service worker (only off localhost, or with ?sw=1, so development reloads stay fresh)
// - opens IndexedDB storage, shows the household list
// - runs the editor: canvas (high-DPI), toolbar, top bar, bottom panel, keyboard shortcuts, autosave
// - [↻ 회전]: the plan turned a quarter turn (core/rotate.js; not an undo step), also from the [출력] dialog
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
import { InputController } from './ui/input.js';
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
import { OutputDialog, notesForChoices, DEFAULT_CHOICES } from './ui/output.js';
import { householdSettings } from './core/prefs.js';

const $ = (sel) => document.querySelector(sel);
const OPEN_KEY = 'floorplan.openProject';
const DIMS_VIEW_KEY = 'floorplan.dimsView';
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

function safeGet(store, key) {
  try { return store.getItem(key); } catch (_) { return null; }
}
function safeSet(store, key, value) {
  try {
    if (value == null) store.removeItem(key);
    else store.setItem(key, value);
  } catch (_) { /* storage may be blocked */ }
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function defaultHouseholdName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `세대 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    this.renderQueued = false;
    this.lastDroppedSeen = null;
    this.lastFocusedEdge = null;
    this.roomLabels = new Map();
    this.roomLabelsFor = null;
    // One function object, so the per-snapshot check cache (store.checkItems) can be reused.
    this.roomLabelFn = (id) => this.roomLabel(id);
    // 치수선 보기: the dimension chains instead of the per-side values (remembered on this device).
    this.dimsView = safeGet(localStorage, DIMS_VIEW_KEY) === '1';
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

    this.input = new InputController(this.canvas, this.view, {
      onGestureStart: (g) => this.tools.onGestureStart(g),
      onGestureMove: (g) => this.tools.onGestureMove(g),
      onGestureEnd: (g) => this.tools.onGestureEnd(g),
      onGestureCancel: (g) => this.tools.onGestureCancel(g),
      onViewChange: () => this.requestRender(),
      onPenStatus: (near) => { $('#penChip').hidden = !near; },
    });

    this._bindChrome();
    this._bindKeyboard();
    this._bindResize();
    this._onToolChange(this.tools.tool);
  }

  get isOpen() {
    return !!this.store && !this.root.hidden;
  }

  // ---- open / close ----------------------------------------------------------------------------

  open(project) {
    this._detach();
    this.store = new DocStore(project);
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
    safeSet(sessionStorage, OPEN_KEY, project.id);
    this._updateTopBar();
    this._setSaveState(storageOk ? 'saved' : 'nostore');
    // Wait one frame so the canvas has its size before fitting the view.
    requestAnimationFrame(() => {
      this._resize();
      if (!this.input.busy) this.fitAll();
    });
  }

  // Flush autosave and leave the editor. Returns a promise that settles after the save.
  async close(showList = true) {
    this._detach();
    this.tools.cancel();
    this.closePanels();
    this.checks.close();
    this.output.close();
    safeSet(sessionStorage, OPEN_KEY, null);
    if (showList) {
      this.root.hidden = true;
      $('#list').hidden = false;
      document.title = '평면도';
      await this.saving;
      if (list) list.refresh();
    }
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
    clearTimeout(this.saveTimer);
    this._setSaveState(storageOk ? 'pending' : 'nostore');
    this.saveTimer = setTimeout(() => this.saveNow(), TIMING.autosave);
  }

  async flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      await this.saveNow();
    }
    await this.saving;
  }

  saveNow() {
    this.saveTimer = 0;
    if (!this.store || !storageOk) return Promise.resolve();
    const project = this.projectForSave();
    this.saving = this.saving.then(async () => {
      try {
        await storage.saveProject(project);
        this._setSaveState('saved');
      } catch (err) {
        console.error('save failed', err);
        this._setSaveState('error');
        const now = Date.now();
        if (now - this.lastSaveError > 15000) {
          this.lastSaveError = now;
          toast('이 기기에 저장하지 못했습니다. 그린 내용은 화면에 그대로 있습니다. [내보내기]로 파일을 보관해 주세요.', { type: 'error', ms: 6000 });
        }
      }
    });
    return this.saving;
  }

  _setSaveState(state) {
    const elState = $('#saveState');
    const text = { saved: '저장됨', pending: '저장 중…', error: '저장 안 됨', nostore: '기기 저장 꺼짐' }[state] || '';
    elState.textContent = text;
    elState.dataset.state = state;
  }

  // ---- top bar -------------------------------------------------------------------------------

  _bindChrome() {
    $('#btnBack').addEventListener('click', () => {
      // Go through history so the Android back button and [≡ 목록] behave the same.
      if (history.state && history.state.screen === 'editor') history.back();
      else this.close(true);
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
    $('#hint').textContent = TOOL_HINTS[name] || '';
    this.canvas.dataset.tool = name;
    // A window/door or fixture panel belongs to what was being placed; a new tool starts fresh.
    // (The length and room panels stay: they are opened by taps in every tool.)
    this.openingPanel.close();
    this.fixtureTool.panel.close();
    // The 설비 / 메모 tools float a bar over the top of the canvas: move the plan out from under it.
    if (name === 'fixture' || name === 'memo') this._clearTopBar();
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
  closePanels() {
    this.panel.close();
    this.openingPanel.close();
    this.fixtureTool.panel.close();
  }

  // ---- 치수선 보기 ------------------------------------------------------------------------------
  // Editing shows each side's measured value inside the room (stage A). 치수선 보기 shows the
  // dimension chains as they will be printed instead, and a tap on a number shows both values.

  setDimsView(on) {
    this.dimsView = !!on;
    safeSet(localStorage, DIMS_VIEW_KEY, this.dimsView ? '1' : null);
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
    const text = describeDim(this.store.project, hit.dim);
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
      scale = computePrintLayout(p, d, { scale: 'auto', dpi: 300, noteLines: notes.maxLines }).scale || scale;
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
  // (설비 type chips, 메모 pen bar).
  visibleArea() {
    const panel = $('#panel');
    const ph = panel.hidden ? 0 : panel.offsetHeight;
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
    this.view.setSize(w, h);
    this.dpr = dpr;
    // Setting the canvas size clears it; draw now so the frame being painted is not blank
    // (ResizeObserver callbacks run after this frame's animation callbacks).
    if (changed) this.draw();
    else this.requestRender();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.draw();
    });
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
        selectedEdges: hl.selectedEdges,
        activeSide: hl.activeSide,
        // Unnamed rooms show the same numbered label as the length panel ("이름 없는 실 2").
        roomLabel: this.roomLabelFn,
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
        else if (this.fixtureTool.panel.isOpen) this.fixtureTool.panel.close();
        else if (this.openingPanel.isOpen) this.openingPanel.close();
        else if (this.panel.isOpen) this.panel.close();
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
      householdName: defaultHouseholdName(),
      surveyor: safeGet(localStorage, SURVEYOR_KEY) || '',
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
    editor.open(project);
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
  onUpdateAvailable(({ apply }) => {
    $('#updateBanner').hidden = false;
    $('#btnApplyUpdate').onclick = () => {
      $('#btnApplyUpdate').disabled = true;
      apply({ beforeReload: () => (editor ? editor.flushSave() : undefined) });
    };
  });
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
    };
  }

  // Show the list right away; it fills in once storage is open.
  const lastId = safeGet(sessionStorage, OPEN_KEY);
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
  window.addEventListener('popstate', () => {
    // Android back button: leave the editor for the list.
    if (editor.isOpen) editor.close(true);
  });

  // Save immediately when the app goes to the background or closes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && editor.store) editor.flushSave();
  });
  window.addEventListener('pagehide', () => { if (editor.store) editor.flushSave(); });

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
