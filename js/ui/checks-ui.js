// The 검사 panel (plan §4 "[검사 N]", §6): opened from the top-bar button, it lists the results of
// core/checks-full.js grouped as 확인필요 first, then 참고. Each row has
//   [위치 보기]  shows the place: pans the plan there and opens the right bottom panel
//   [확인 완료]  "re-measured and it is right": the item is greyed and left out of the printed ※ notes
//   [되돌리기]   undoes a 확인 완료
//
//   const checks = new ChecksPanel(hostElement, deps)
//   deps: {
//     store()                    -> current DocStore (installChecks() must have run)
//     command(fn, label)         -> runs a store command with error handling (editor.command)
//     toast(msg, opts)           -> optional
//     requestRender()            -> redraw the canvas (the highlight changed)
//     roomLabel(roomId)          -> optional; the editor's room labels ("이름 없는 실 2")
//     focusWorld(points, center) -> bring world points into view
//     openEdge(edgeId, prefer)   -> optional; open the length panel (prefer = { roomId, sideKey })
//     openRoom(roomId)           -> optional; open the room panel
//     openOpening(openingId)     -> optional (stage B)
//     openFixture(fixtureId)     -> optional (stage B)
//     checkOptions()             -> optional; extra runChecks options (e.g. { openingSpan })
//     onClose()                  -> optional
//   }
//   checks.open() / close() / toggle() / refresh() / isOpen / items() / highlightKey
//
// The panel renders into `host` (the editor's #checksPopover) and shows/hides it.
import { el } from './panel.js';
import {
  runChecks, countForBadge as countUnresolvedChecks, locationOf, CATEGORY_LABELS, LEVEL_CHECK,
} from '../core/checks-full.js';

export { CATEGORY_LABELS };

// Number of unresolved 확인필요 items, for the [검사 N] button.
export function countForBadge(items) {
  return countUnresolvedChecks(items);
}

// Text of the top-bar button.
export function badgeText(items) {
  return `검사 ${countForBadge(items)}`;
}

const HIGHLIGHT_MS = 4000;
const INFO_OPEN_MAX = 6; // the 참고 list starts open when it is this short

export class ChecksPanel {
  constructor(host, deps = {}) {
    this.host = host;
    this.deps = deps;
    this._highlight = null;
    this._highlightTimer = 0;
    this._infoOpen = null; // null = automatic (open when short); true/false = the user's choice
    if (this.host) {
      this.host.hidden = true;
      this.host.classList.add('ck-host');
    }
  }

  get isOpen() {
    return !!this.host && !this.host.hidden;
  }

  // Key of the item last shown with [위치 보기] (the renderer draws a halo there), or null.
  get highlightKey() {
    return this._highlight;
  }

  // Current check items (empty without a store).
  items() {
    const store = this.deps.store && this.deps.store();
    if (!store) return [];
    const opts = { roomLabel: this.deps.roomLabel };
    if (typeof this.deps.checkOptions === 'function') Object.assign(opts, this.deps.checkOptions() || {});
    try {
      if (typeof store.checkItems === 'function') return store.checkItems(opts);
      return runChecks(store.project, store.derived, opts);
    } catch (err) {
      console.error('[checks-ui] checks failed', err);
      return [];
    }
  }

  open() {
    if (!this.host) return;
    this._render();
    this.host.hidden = false;
  }

  close() {
    if (!this.host || this.host.hidden) return;
    this.host.hidden = true;
    if (this.deps.onClose) this.deps.onClose();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  // Call after every store change; re-renders only while open.
  refresh() {
    if (this.isOpen) this._render();
  }

  // ---- actions ---------------------------------------------------------------------------------

  resolve(item) {
    const store = this.deps.store && this.deps.store();
    if (!store || !item) return;
    this._run(() => store.resolveCheck(item.key), '확인 완료');
  }

  unresolve(item) {
    const store = this.deps.store && this.deps.store();
    if (!store || !item) return;
    this._run(() => store.unresolveCheck(item.key), '되돌리기');
  }

  locate(item) {
    const store = this.deps.store && this.deps.store();
    if (!store || !item) return;
    const loc = locationOf(store.project, store.derived, item);
    this.close();
    const d = this.deps;
    try {
      if (loc.openingId && d.openOpening) d.openOpening(loc.openingId);
      else if (loc.fixtureId && d.openFixture) d.openFixture(loc.fixtureId);
      else if (loc.edgeId && d.openEdge) d.openEdge(loc.edgeId, loc.prefer);
      else if (loc.roomId && d.openRoom) d.openRoom(loc.roomId);
    } catch (err) {
      console.error('[checks-ui] open panel failed', err);
    }
    if (loc.points.length && d.focusWorld) d.focusWorld(loc.points, true);
    this._setHighlight(item.key);
  }

  _run(fn, label) {
    if (this.deps.command) this.deps.command(fn, label);
    else fn();
    this.refresh();
  }

  _setHighlight(key) {
    clearTimeout(this._highlightTimer);
    this._highlight = key;
    if (this.deps.requestRender) this.deps.requestRender();
    if (key) {
      this._highlightTimer = setTimeout(() => {
        this._highlight = null;
        if (this.deps.requestRender) this.deps.requestRender();
      }, HIGHLIGHT_MS);
    }
  }

  // ---- rendering -------------------------------------------------------------------------------

  _render() {
    const items = this.items();
    const scroll = this.host.scrollTop;
    const checks = items.filter((it) => it.level === LEVEL_CHECK);
    const infos = items.filter((it) => it.level !== LEVEL_CHECK);
    const open = countForBadge(items);
    const byResolved = (list) => list.filter((it) => !it.resolved).concat(list.filter((it) => it.resolved));

    const head = el('div', { class: 'ck-head' },
      el('h2', { class: 'ck-title' }, '검사'),
      el('span', { class: 'ck-summary' }, open ? `확인필요 ${open}개` : '확인필요 없음'),
      el('button', { type: 'button', class: 'btn ck-close', 'aria-label': '검사 닫기', onclick: () => this.close() }, '닫기'));

    const parts = [head];
    if (!items.length) {
      parts.push(el('p', { class: 'ck-empty' }, '확인할 것이 없습니다.'));
    }
    if (checks.length) {
      parts.push(el('section', { class: 'ck-group ck-group-check', 'aria-label': '확인필요' },
        el('h3', { class: 'ck-group-title' }, `확인필요 ${open}`),
        el('p', { class: 'ck-hint' }, '다시 재서 맞으면 [확인 완료]를 누르세요. 확인 완료한 항목은 출력 도면의 ※ 주기에서 빠집니다.'),
        byResolved(checks).map((it) => this._row(it))));
    } else if (items.length) {
      parts.push(el('p', { class: 'ck-empty ck-ok' }, '확인필요 항목이 없습니다.'));
    }
    if (infos.length) {
      const startOpen = this._infoOpen == null ? infos.length <= INFO_OPEN_MAX || !checks.length : this._infoOpen;
      const details = el('details', { class: 'ck-group ck-group-info', open: startOpen },
        el('summary', { class: 'ck-group-title' }, `참고 ${infos.length}`),
        el('p', { class: 'ck-hint' }, '참고 항목은 출력 도면에 적지 않습니다. 길이를 넣지 않은 벽이 있으면 "치수 미입력 벽은 축척이 맞지 않습니다" 한 줄만 적습니다.'),
        byResolved(infos).map((it) => this._row(it)));
      details.addEventListener('toggle', () => { this._infoOpen = details.open; });
      parts.push(details);
    }
    this.host.replaceChildren(el('div', { class: 'ck-panel' }, parts));
    this.host.scrollTop = scroll;
  }

  _row(it) {
    const store = this.deps.store && this.deps.store();
    const loc = store ? locationOf(store.project, store.derived, it) : { points: [] };
    const canLocate = loc.points.length > 0 || !!(loc.edgeId || loc.roomId || loc.openingId || loc.fixtureId);
    const status = it.resolved
      ? el('span', { class: 'ck-status ck-status-done' }, '확인 완료 · 출력에 적지 않음')
      : it.level === LEVEL_CHECK && it.note
        ? el('span', { class: 'ck-status' }, '출력 도면 ※ 주기에 적힘')
        : null;
    return el('div', {
      class: `ck-row ck-level-${it.level}${it.resolved ? ' ck-resolved' : ''}`,
      dataset: { key: it.key, category: it.category },
    },
    el('div', { class: 'ck-text' },
      el('span', { class: `ck-chip ck-chip-${it.level}` }, CATEGORY_LABELS[it.category] || '검사'),
      el('span', { class: 'ck-message' }, it.message),
      status),
    el('div', { class: 'ck-actions' },
      el('button', {
        type: 'button', class: 'btn ck-btn ck-locate', disabled: !canLocate, onclick: () => this.locate(it),
      }, '위치 보기'),
      it.resolved
        ? el('button', { type: 'button', class: 'btn ck-btn ck-undo', onclick: () => this.unresolve(it) }, '되돌리기')
        : el('button', { type: 'button', class: 'btn ck-btn ck-resolve', onclick: () => this.resolve(it) }, '확인 완료')));
  }
}
