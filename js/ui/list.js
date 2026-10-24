// Household list screen (세대 목록): new / open / search / rename / copy / delete (to trash),
// trash view with restore, import by file input or drag-and-drop (plan §2-1, §3, §4).
import { el, openDialog } from './panel.js';
import { createProject } from '../core/model.js';
import * as storage from '../io/storage.js';
import { readProjectFile, compareProjects, IMPORT_ACCEPT } from '../io/fileio.js';
import { openSettings } from './settings.js';

export class ListScreen {
  // ctx: { toast(msg, opts), openProject(project, { unsaved }?), newProject(), storageReady() -> bool,
  //        editorSettings() (optional) → { store(), command(fn, label), onChange() } | null:
  //          what the 설정 screen needs to offer [지금 연 세대에도 적용] when it is opened from the
  //          editor's [설정] button (#btnSettings, bound here so both entries open the same screen) }
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.items = [];
    this.query = '';
    this.showTrash = false;
    this._build();
    this._bindDrop();
    this._bindEditorSettings();
  }

  // 설정 (device-wide lists and defaults). fromEditor: opened from the editor's top bar.
  openSettings(fromEditor = false) {
    let extra = null;
    if (fromEditor && typeof this.ctx.editorSettings === 'function') {
      try { extra = this.ctx.editorSettings(); } catch (err) { console.error(err); extra = null; }
    }
    return openSettings({ toast: this.ctx.toast, ...(extra || {}) });
  }

  _bindEditorSettings() {
    const b = typeof document !== 'undefined' ? document.getElementById('btnSettings') : null;
    if (!b || b.dataset.wired) return;
    b.dataset.wired = 'list';
    b.addEventListener('click', () => this.openSettings(true));
  }

  // ---- layout -------------------------------------------------------------------------------

  _build() {
    // `accept` with the text types: without it Android Chrome offered only the camera / recorder / photos
    // (field test 2026-10-22); with it the document picker (files, Drive) opens. The content still
    // decides (readProjectFile), whatever the extension; drag-and-drop on a PC takes any file.
    this.fileInput = el('input', {
      type: 'file', class: 'visually-hidden', multiple: true, accept: IMPORT_ACCEPT, 'aria-hidden': 'true', tabindex: '-1',
    });
    this.fileInput.addEventListener('change', () => {
      const files = [...this.fileInput.files];
      this.fileInput.value = '';
      this.importFiles(files);
    });

    this.searchInput = el('input', {
      type: 'search', class: 'text-input list-search', placeholder: '세대 찾기 (이름·주소)', 'aria-label': '세대 찾기',
    });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim();
      this._renderItems();
    });

    this.trashButton = el('button', { type: 'button', class: 'btn', onclick: () => this.toggleTrash() }, '휴지통');
    this.listHost = el('div', { class: 'list-items', role: 'list' });
    this.statusLine = el('p', { class: 'list-status' }, '불러오는 중…');
    this.titleEl = el('h1', { class: 'list-title' }, '세대 목록');

    const header = el('header', { class: 'list-header' },
      el('div', { class: 'list-brand' },
        this.titleEl,
        el('p', { class: 'list-sub' }, '한국해비타트 서울지회 · 현장 실측 평면도')),
      el('div', { class: 'list-header-actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => this.fileInput.click() }, '불러오기'),
        this.trashButton,
        el('button', { type: 'button', class: 'btn list-settings', onclick: () => this.openSettings(false) }, '설정')));

    this.newButton = el('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: () => this.ctx.newProject() }, '+ 새 세대');
    this.toolbar = el('div', { class: 'list-toolbar' }, this.newButton, this.searchInput);

    this.dropHint = el('div', { class: 'drop-hint', hidden: true }, '여기에 파일을 놓으면 불러옵니다');

    // Stage-0 device test page (devtest/): reachable from the installed app too, which has no address bar.
    const footer = el('p', { class: 'list-status' },
      el('a', { href: './devtest/index.html' }, '기기 시험 페이지'),
      ' · 새 태블릿에서 처음 한 번 S펜·파일 보내기·출력이 되는지 확인합니다.');

    this.root.replaceChildren(header, this.toolbar, this.listHost, this.statusLine, footer, this.dropHint, this.fileInput);
  }

  // Files dragged from Explorer onto the app (a PC). The whole window takes them, not only the list
  // column: a file dropped beside it (the list is at most 1100 px wide) or on the editor made Chrome open
  // the file itself in place of the app (round-trip check 2026-10-24). On the editor a dropped file is not
  // imported (the household open there might be the one in the file); a toast says where to drop it.
  _bindDrop() {
    const doc = this.root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    const listShown = () => !this.root.hidden;
    doc.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!listShown()) return;
      depth++;
      this.dropHint.hidden = false;
    });
    doc.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    doc.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.dropHint.hidden = true;
    });
    doc.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.dropHint.hidden = true;
      if (!listShown()) {
        this.ctx.toast('파일은 세대 목록 화면에서 불러옵니다. [≡ 목록]을 누른 뒤 다시 끌어다 놓아 주세요.', { type: 'warn', ms: 5000 });
        return;
      }
      this.importFiles([...e.dataTransfer.files]);
    });
  }

  // ---- data ------------------------------------------------------------------------------------

  async refresh() {
    if (!this.ctx.storageReady()) {
      this.items = [];
      this._renderItems();
      this.statusLine.textContent = '이 기기에 저장할 수 없는 상태입니다. 그린 도면은 꼭 내보내기로 파일을 보관해 주세요.';
      return;
    }
    try {
      this.items = this.showTrash ? await storage.listTrash() : await storage.listProjects();
    } catch (err) {
      console.error(err);
      this.items = [];
      this.ctx.toast('목록을 읽지 못했습니다.', { type: 'error' });
    }
    this._renderItems();
    this._renderStatus();
  }

  async _renderStatus() {
    let text = '도면은 이 기기 안에 자동으로 저장됩니다. 백업은 [내보내기]로 만든 파일입니다.';
    try {
      const st = await storage.storageStatus();
      if (st && st.persisted === true) text += ' · 저장공간 유지: 켜짐';
      else if (st && st.persisted === false) text += ' · 저장공간 유지: 꺼짐 (내보내기를 자주 해 주세요)';
    } catch (_) { /* status is optional */ }
    this.statusLine.textContent = text;
  }

  toggleTrash() {
    this.showTrash = !this.showTrash;
    this.titleEl.textContent = this.showTrash ? '휴지통' : '세대 목록';
    this.trashButton.textContent = this.showTrash ? '◀ 목록으로' : '휴지통';
    this.toolbar.hidden = this.showTrash;
    this.refresh();
  }

  _filtered() {
    const q = this.query.toLowerCase();
    // Households: most recently modified first. Trash: most recently deleted first.
    const timeKey = this.showTrash ? (it) => it.deletedAt : (it) => it.modifiedAt;
    const list = [...this.items].sort((a, b) => String(timeKey(b) || '').localeCompare(String(timeKey(a) || '')));
    if (!q || this.showTrash) return list;
    return list.filter((it) => {
      const hay = [itemName(it), it.address, it.info && it.info.address].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  _renderItems() {
    const list = this._filtered();
    if (!list.length) {
      let msg;
      if (this.showTrash) msg = '휴지통이 비어 있습니다. 지운 세대는 30일 동안 여기에 보관됩니다.';
      else if (this.query) msg = '찾는 세대가 없습니다.';
      else msg = '아직 세대가 없습니다. [+ 새 세대]를 눌러 시작하세요. 받은 파일은 [불러오기]로 열거나 이 화면에 끌어다 놓으세요.';
      this.listHost.replaceChildren(el('p', { class: 'list-empty' }, msg));
      return;
    }
    this.listHost.replaceChildren(...list.map((it) => (this.showTrash ? this._trashRow(it) : this._row(it))));
  }

  _row(it) {
    const name = itemName(it);
    const open = el('button', { type: 'button', class: 'list-open', onclick: () => this.open(it.id) },
      el('span', { class: 'list-name' }, name),
      el('span', { class: 'list-meta' }, `${formatDate(it.modifiedAt)} 수정`),
      it.dirty ? el('span', { class: 'badge badge-warn' }, '마지막 내보내기 이후 수정됨') : null);
    return el('div', { class: 'list-row', role: 'listitem' },
      open,
      el('div', { class: 'list-actions' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => this.rename(it) }, '이름 바꾸기'),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => this.copy(it) }, '복사'),
        el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => this.remove(it) }, '지우기')));
  }

  _trashRow(it) {
    const name = itemName(it);
    return el('div', { class: 'list-row', role: 'listitem' },
      el('div', { class: 'list-open list-open-static' },
        el('span', { class: 'list-name' }, name),
        el('span', { class: 'list-meta' }, [
          it.deletedAt ? `${formatDate(it.deletedAt)} 지움` : '',
          it.daysLeft != null ? `${it.daysLeft}일 뒤 완전히 지워짐` : '',
        ].filter(Boolean).join(' · '))),
      el('div', { class: 'list-actions' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => this.restore(it) }, '되살리기')));
  }

  // ---- actions ---------------------------------------------------------------------------------

  async open(id) {
    try {
      const project = await storage.loadProject(id);
      if (!project) throw new Error('not found');
      this.ctx.openProject(project);
    } catch (err) {
      console.error(err);
      this.ctx.toast('세대를 열지 못했습니다.', { type: 'error' });
    }
  }

  async rename(it) {
    const res = await openDialog({
      title: '이름 바꾸기',
      fields: [{ name: 'name', label: '세대명', value: itemName(it) === '이름 없음' ? '' : itemName(it) }],
      buttons: [{ label: '취소', value: null }, { label: '바꾸기', value: 'ok', kind: 'primary' }],
    });
    if (res.button !== 'ok') return;
    const name = res.values.name.trim();
    if (!name) return;
    try {
      const p = await storage.loadProject(it.id);
      const next = { ...p, info: { ...p.info, householdName: name }, modifiedAt: new Date().toISOString() };
      await storage.saveProject(next);
      this.ctx.toast('이름을 바꿨습니다.', { type: 'ok' });
    } catch (err) {
      console.error(err);
      this.ctx.toast('이름을 바꾸지 못했습니다.', { type: 'error' });
    }
    this.refresh();
  }

  async copy(it) {
    try {
      const p = await storage.loadProject(it.id);
      const copy = makeCopy(p);
      await storage.saveProject(copy);
      this.ctx.toast(`사본을 만들었습니다: "${copy.info.householdName}"`, { type: 'ok' });
    } catch (err) {
      console.error(err);
      this.ctx.toast('복사하지 못했습니다.', { type: 'error' });
    }
    this.refresh();
  }

  async remove(it) {
    const res = await openDialog({
      title: '세대 지우기',
      message: `휴지통으로 옮길 세대: "${itemName(it)}"\n30일 안에는 휴지통에서 되살릴 수 있습니다.`,
      buttons: [{ label: '취소', value: null }, { label: '휴지통으로', value: 'ok', kind: 'danger' }],
    });
    if (res.button !== 'ok') return;
    try {
      await storage.deleteProject(it.id);
      this.ctx.toast('휴지통으로 옮겼습니다.', { type: 'ok' });
    } catch (err) {
      console.error(err);
      this.ctx.toast('지우지 못했습니다.', { type: 'error' });
    }
    this.refresh();
  }

  async restore(it) {
    try {
      await storage.restoreProject(it.id);
      this.ctx.toast('되살렸습니다.', { type: 'ok' });
    } catch (err) {
      console.error(err);
      this.ctx.toast('되살리지 못했습니다.', { type: 'error' });
    }
    this.refresh();
  }

  // Import one or more project files. Opens the household when exactly one file gave one (stored, or in
  // memory only when this device cannot store it). Several files: a toast counts the stored ones, and
  // another the ones this device could not store (before, those were counted as '불러왔습니다' too,
  // although they were neither stored nor opened; round-trip check 2026-10-24).
  async importFiles(files) {
    if (!files || !files.length) return;
    const stored = [], unsaved = [];
    let movedToTrash = 0;
    for (const file of files) {
      let res;
      try {
        res = await readProjectFile(file);
      } catch (err) {
        res = { ok: false, error: String(err && err.message || err) };
      }
      if (!res || !res.ok) {
        this.ctx.toast(`열 수 없는 파일: "${file.name}". ${res && res.error ? res.error : '평면도 파일이 아닙니다.'}`, { type: 'error' });
        continue;
      }
      const r = await this._storeImported(res.project);
      if (!r) continue;
      (r.stored ? stored : unsaved).push(r);
      if (r.trashed) movedToTrash++;
    }
    await this.refresh();
    const all = stored.concat(unsaved);
    if (all.length === 1) {
      const r = all[0];
      if (r.failed) this.ctx.toast('이 기기에 저장하지 못했습니다. 화면에서는 열어 둡니다.', { type: 'error' });
      else if (r.trashed) this.ctx.toast('바꾸기 전의 것은 휴지통에 30일 동안 보관됩니다.', { type: 'ok', ms: 4000 });
      this.ctx.openProject(r.project, r.failed ? { unsaved: true } : undefined);
      return;
    }
    if (stored.length) {
      const trash = movedToTrash ? ` 바꾸기 전의 것 ${movedToTrash}개는 휴지통에 30일 동안 보관됩니다.` : '';
      this.ctx.toast(`${stored.length}개 세대를 불러왔습니다.${trash}`, { type: 'ok' });
    }
    if (unsaved.length) {
      this.ctx.toast(`${unsaved.length}개 세대는 이 기기에 저장하지 못했습니다. 파일을 하나씩 불러오면 화면에서는 열어 둡니다.`, { type: 'error', ms: 6000 });
    }
  }

  // Same household already on this device -> ask (plan §3 "같은 세대 파일을 불러올 때").
  // → null (cancelled) | { project, stored: bool, failed: bool (a save that failed), trashed: bool }
  async _storeImported(project) {
    if (!this.ctx.storageReady()) return { project, stored: false, failed: false, trashed: false };   // in memory only
    let existing = null;
    try {
      existing = await storage.loadProject(project.id);
    } catch (_) {
      existing = null;
    }
    let toSave = project;
    let replace = false;
    if (existing) {
      const which = compareProjects(existing, project).message;
      const res = await openDialog({
        title: '같은 세대가 이미 있습니다',
        message: `"${itemName(existing)}"\n이 기기: ${formatDate(existing.modifiedAt)} 수정\n파일: ${formatDate(project.modifiedAt)} 수정\n${which}`,
        buttons: [
          { label: '취소', value: null },
          { label: '둘 다 보관', value: 'both' },
          { label: '파일로 바꾸기', value: 'replace', kind: 'primary' },
        ],
      });
      if (res.button === 'both') toSave = makeCopy(project);
      else if (res.button === 'replace') replace = true;
      else return null;
    }
    try {
      // [파일로 바꾸기]: the copy it replaces goes to the trash (storage.replaceProject).
      const r = replace ? await storage.replaceProject(toSave) : { trashed: false, record: await storage.saveProject(toSave) };
      return { project: toSave, stored: true, failed: false, trashed: !!r.trashed };
    } catch (err) {
      console.error(err);
      return { project: toSave, stored: false, failed: true, trashed: false };
    }
  }
}

// ---- helpers -----------------------------------------------------------------------------------

function itemName(it) {
  if (!it) return '이름 없음';
  const info = it.info || (it.project && it.project.info) || {};
  return it.name || info.householdName || info.projectName || '이름 없음';
}

// Copy of a project under a new id, named "<name> (사본)".
function makeCopy(project) {
  const fresh = createProject({});
  const now = new Date().toISOString();
  const base = (project.info && project.info.householdName) || '세대';
  return {
    ...project,
    id: fresh.id,
    createdAt: now,
    modifiedAt: now,
    exportedAt: null,
    info: { ...project.info, householdName: `${base} (사본)` },
  };
}

export function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = `${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`;
  return d.getFullYear() === now.getFullYear() ? day : `${d.getFullYear()}년 ${day}`;
}
