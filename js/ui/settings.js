// 설정 screen (plan §1-3 "목록은 설정에서 추가·수정할 수 있습니다", §1-3 띄어 쓰기, §2-1 조사자,
// §5 / §6 기준값). A full-screen page over the list or the editor; every change is saved at once on
// this device (core/prefs.js). Nothing here changes a household, except [지금 연 세대에도 적용].
//
//   openSettings({ store, command, toast, onChange, onClose }) → SettingsScreen (one at a time)
//     store()    the open household's DocStore, or null (from the list screen)
//     command    (fn, label) → bool, as in the editor (error handling, one undo step per command)
//     toast      (msg, opts)
//     onChange() called after every saved change (the editor redraws labels, refreshes panels)
//     onClose()  called when the screen closes
//
// The root carries the class 'dialog-backdrop', so the editor's keyboard shortcuts stay off while it
// is open (main.js ignores keys while a dialog is up).
import { el, openDialog } from './panel.js';
import {
  getPrefs, updatePrefs, resetPrefs, householdSettings, LIMITS, DEFAULT_HOUSEHOLD, cleanSize,
} from '../core/prefs.js';
import { windowName } from '../core/openings.js';

const LIST_SECTIONS = [
  { key: 'windowMaterials', title: '창 재질', what: '창 재질', example: '예: PVC, AL, 목재' },
  { key: 'windowTypes', title: '창 종류', what: '창 종류', example: '예: 단창, 이중창' },
  { key: 'doorTypes', title: '문 종류', what: '문 종류', example: '예: ABS도어, 목문' },
];

const NUMBER_FIELDS = [
  { key: 'extWall', label: '바깥벽 두께', range: LIMITS.wall, help: '두께를 재지 않은 바깥벽(한쪽에만 실이 있는 벽)은 이 두께로 그립니다. 벽마다 바꾸는 [외벽] 표시는 두께를 바꾸지 않습니다.' },
  { key: 'intWall', label: '안쪽 벽 두께', range: LIMITS.wall, help: '두께를 재지 않은 안쪽 벽(실과 실 사이)은 이 두께로 그립니다.' },
  { key: 'twoSideTolerance', label: '양쪽 값 차이', range: LIMITS.tolerance, help: '같은 벽을 양쪽 실에서 잰 값이 이만큼보다 더 다르면 \'확인필요\'로 알려 줍니다.' },
  { key: 'closureTolerance', label: '앞뒤 맞추기', range: LIMITS.tolerance, help: '잰 값끼리 서로 맞지 않아 앱이 벽 두께로 맞춘 양이, 또는 전체 치수와 구간 합계의 차이가 이만큼보다 크면 \'확인필요\'로 알려 줍니다.' },
];

let openScreen = null;

export function openSettings(opts = {}) {
  if (openScreen && openScreen.root.isConnected) return openScreen;
  openScreen = new SettingsScreen(opts);
  return openScreen;
}

export function isSettingsOpen() {
  return !!(openScreen && openScreen.root.isConnected);
}

// Label example with the current spacing rule ("PVC단창 1500*1200").
export function spacingExample(material, type, spacing) {
  return windowName(material, type, spacing);
}

export class SettingsScreen {
  constructor({ store = () => null, command = (fn) => { fn(); return true; }, toast = () => {}, onChange = () => {}, onClose = () => {} } = {}) {
    this.store = typeof store === 'function' ? store : () => store;
    this.command = command;
    this.toast = toast;
    this.onChange = onChange;
    this.onClose = onClose;
    this.body = el('div', { class: 'settings-body' });
    this.savedNote = el('p', { class: 'settings-saved', 'aria-live': 'polite' }, '바꾼 내용은 이 기기에 바로 저장됩니다.');
    const header = el('header', { class: 'settings-header' },
      el('button', { type: 'button', class: 'btn btn-big settings-back', onclick: () => this.close() }, '◀ 돌아가기'),
      el('h1', { class: 'settings-title' }, '설정'),
      el('button', { type: 'button', class: 'btn settings-reset', onclick: () => this.askReset() }, '기본값으로 되돌리기'));
    this.page = el('div', { class: 'settings-page', role: 'dialog', 'aria-modal': 'true', 'aria-label': '설정' },
      header, this.savedNote, this.body);
    this.root = el('div', { class: 'dialog-backdrop settings-backdrop' }, this.page);
    this.onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only when no dialog of its own (rename, reset) is on top.
      const tops = document.querySelectorAll('.dialog-backdrop');
      if (tops[tops.length - 1] !== this.root) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    };
    document.addEventListener('keydown', this.onKey, true);
    document.body.append(this.root);
    this.render();
  }

  get isOpen() {
    return this.root.isConnected;
  }

  close() {
    if (!this.root.isConnected) return;
    document.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    if (openScreen === this) openScreen = null;
    // The editor redraws on 'resize' too (labels follow a changed spacing rule even when the
    // caller passed no onChange).
    try { window.dispatchEvent(new Event('resize')); } catch (_) { /* old browsers */ }
    this.onClose();
  }

  // ---- saving ----------------------------------------------------------------------------------

  _save(patch, message = '') {
    const { saved } = updatePrefs(patch);
    this.savedNote.textContent = saved
      ? (message || '저장했습니다. 이 기기에서 계속 쓰입니다.')
      : '이 기기에 저장하지 못했습니다. 앱을 다시 열 때까지만 쓰입니다.';
    this.savedNote.classList.toggle('settings-saved-warn', !saved);
    try { this.onChange(); } catch (err) { console.error('[settings] onChange failed', err); }
    this.render();
  }

  async askReset() {
    const res = await openDialog({
      title: '기본값으로 되돌릴까요?',
      message: '창·문 목록, 자주 쓰는 규격, 띄어 쓰기, 새 세대 기본값, 조사자 이름을 처음 값으로 되돌립니다.\n이미 만든 세대는 바뀌지 않습니다.',
      buttons: [{ label: '취소', value: null }, { label: '되돌리기', value: 'ok', kind: 'danger' }],
    });
    if (res.button !== 'ok') return;
    const { saved } = resetPrefs();
    this.savedNote.textContent = saved ? '기본값으로 되돌렸습니다.' : '기본값으로 되돌렸지만 이 기기에 저장하지 못했습니다.';
    try { this.onChange(); } catch (err) { console.error('[settings] onChange failed', err); }
    this.render();
  }

  // ---- rendering -----------------------------------------------------------------------------

  render() {
    const p = getPrefs();
    this.body.replaceChildren(
      this._section('창·문 목록', '창·문을 넣을 때 고르는 버튼입니다. 버튼을 누르면 이름을 바꾸거나 지우거나 앞으로 옮길 수 있습니다.',
        ...LIST_SECTIONS.map((s) => this._listRow(s, p[s.key]))),
      this._section('자주 쓰는 규격', '창·문 규격을 빨리 넣는 버튼입니다(가로*세로, mm). 최근에 넣은 규격은 따로 앞에 나옵니다.',
        this._sizeRow('window', '창', p.sizes.window),
        this._sizeRow('door', '문', p.sizes.door)),
      this._spacingSection(p),
      this._householdSection(p),
      this._surveyorSection(p));
  }

  _section(title, note, ...children) {
    return el('section', { class: 'settings-section' },
      el('h2', { class: 'settings-h2' }, title),
      note ? el('p', { class: 'settings-note' }, note) : null,
      ...children);
  }

  _listRow(def, list) {
    const chips = list.map((name, i) => el('button', {
      type: 'button', class: 'chip settings-chip', dataset: { list: def.key, index: String(i) },
      onclick: () => this.editItem(def, i),
    }, name));
    const add = el('button', { type: 'button', class: 'btn settings-add', dataset: { list: def.key }, onclick: () => this.addItem(def) }, '+ 추가');
    return el('div', { class: 'settings-row' },
      el('span', { class: 'settings-label' }, def.title),
      el('div', { class: 'chip-row settings-chips' }, ...chips, add),
      list.length ? null : el('p', { class: 'settings-note' }, `${def.title} 버튼이 없습니다. [+ 추가]로 넣으세요.`));
  }

  async addItem(def) {
    const list = getPrefs()[def.key];
    if (list.length >= LIMITS.listItems) {
      this.toast(`${def.title}은(는) ${LIMITS.listItems}개까지 넣을 수 있습니다.`, { type: 'warn' });
      return;
    }
    const res = await openDialog({
      title: `${def.what} 추가`,
      fields: [{ name: 'name', label: `새 ${def.what} 이름 (${def.example})`, value: '' }],
      buttons: [{ label: '취소', value: null }, { label: '추가', value: 'ok', kind: 'primary' }],
    });
    if (res.button !== 'ok') return;
    const name = this._checkName(res.values.name, list, -1);
    if (!name) return;
    this._save((pp) => ({ ...pp, [def.key]: [...pp[def.key], name] }), `"${name}" 버튼을 넣었습니다.`);
  }

  async editItem(def, index) {
    const list = getPrefs()[def.key];
    const cur = list[index];
    if (cur == null) return;
    const buttons = [{ label: '지우기', value: 'delete', kind: 'danger' }];
    if (index > 0) buttons.push({ label: '◀ 앞으로', value: 'up' });
    buttons.push({ label: '취소', value: null }, { label: '이름 저장', value: 'ok', kind: 'primary' });
    const res = await openDialog({
      title: `${def.what} "${cur}"`,
      message: '이름을 고치거나, 지우거나, 앞으로 옮길 수 있습니다. 이미 그린 창·문은 바뀌지 않습니다.',
      fields: [{ name: 'name', label: '이름', value: cur }],
      buttons,
    });
    if (res.button === 'delete') {
      this._save((pp) => ({ ...pp, [def.key]: pp[def.key].filter((_, i) => i !== index) }), `"${cur}" 버튼을 지웠습니다.`);
    } else if (res.button === 'up') {
      this._save((pp) => {
        const l = pp[def.key].slice();
        [l[index - 1], l[index]] = [l[index], l[index - 1]];
        return { ...pp, [def.key]: l };
      }, `"${cur}" 버튼을 앞으로 옮겼습니다.`);
    } else if (res.button === 'ok') {
      const name = this._checkName(res.values.name, list, index);
      if (!name || name === cur) return;
      this._save((pp) => ({ ...pp, [def.key]: pp[def.key].map((x, i) => (i === index ? name : x)) }), `"${cur}"을(를) "${name}"(으)로 바꿨습니다.`);
    }
  }

  _checkName(raw, list, index) {
    const name = String(raw || '').trim();
    if (!name) {
      this.toast('이름이 비어 있습니다.', { type: 'warn' });
      return null;
    }
    if (name.length > LIMITS.itemChars) {
      this.toast(`이름은 ${LIMITS.itemChars}자까지 넣을 수 있습니다.`, { type: 'warn' });
      return null;
    }
    if (list.some((x, i) => x === name && i !== index)) {
      this.toast(`"${name}" 버튼이 이미 있습니다.`, { type: 'warn' });
      return null;
    }
    return name;
  }

  _sizeRow(kind, title, list) {
    const chips = list.map(([w, h], i) => el('button', {
      type: 'button', class: 'chip settings-chip settings-size', dataset: { kind, index: String(i) },
      onclick: () => this.editSize(kind, i),
    }, h ? `${w}*${h}` : `${w}`));
    const add = el('button', { type: 'button', class: 'btn settings-add', dataset: { kind }, onclick: () => this.addSize(kind) }, '+ 추가');
    return el('div', { class: 'settings-row' },
      el('span', { class: 'settings-label' }, `${title} 규격`),
      el('div', { class: 'chip-row settings-chips' }, ...chips, add));
  }

  _sizeFields(w = '', h = '') {
    return [
      { name: 'w', label: `가로(폭) mm (${LIMITS.width[0]}~${LIMITS.width[1]})`, value: w === '' ? '' : String(w), type: 'number' },
      { name: 'h', label: `세로(높이) mm (${LIMITS.height[0]}~${LIMITS.height[1]}, 몰라도 됨)`, value: h == null || h === '' ? '' : String(h), type: 'number' },
    ];
  }

  _readSize(values) {
    const s = cleanSize([values.w, values.h === '' ? null : values.h]);
    if (!s) this.toast(`가로는 ${LIMITS.width[0]}~${LIMITS.width[1]}mm, 세로는 ${LIMITS.height[0]}~${LIMITS.height[1]}mm로 넣어 주세요.`, { type: 'warn' });
    return s;
  }

  async addSize(kind) {
    const list = getPrefs().sizes[kind];
    if (list.length >= LIMITS.sizes) {
      this.toast(`규격 버튼은 ${LIMITS.sizes}개까지 넣을 수 있습니다.`, { type: 'warn' });
      return;
    }
    const res = await openDialog({
      title: kind === 'door' ? '문 규격 추가' : '창 규격 추가',
      fields: this._sizeFields(),
      buttons: [{ label: '취소', value: null }, { label: '추가', value: 'ok', kind: 'primary' }],
    });
    if (res.button !== 'ok') return;
    const s = this._readSize(res.values);
    if (!s) return;
    if (list.some((x) => x[0] === s[0] && x[1] === s[1])) {
      this.toast('같은 규격 버튼이 이미 있습니다.', { type: 'warn' });
      return;
    }
    this._save((pp) => ({ ...pp, sizes: { ...pp.sizes, [kind]: [...pp.sizes[kind], s] } }), '규격 버튼을 넣었습니다.');
  }

  async editSize(kind, index) {
    const list = getPrefs().sizes[kind];
    const cur = list[index];
    if (!cur) return;
    const buttons = [{ label: '지우기', value: 'delete', kind: 'danger' }];
    if (index > 0) buttons.push({ label: '◀ 앞으로', value: 'up' });
    buttons.push({ label: '취소', value: null }, { label: '저장', value: 'ok', kind: 'primary' });
    const res = await openDialog({
      title: `${kind === 'door' ? '문' : '창'} 규격 ${cur[1] ? `${cur[0]}*${cur[1]}` : cur[0]}`,
      fields: this._sizeFields(cur[0], cur[1]),
      buttons,
    });
    if (res.button === 'delete') {
      this._save((pp) => ({ ...pp, sizes: { ...pp.sizes, [kind]: pp.sizes[kind].filter((_, i) => i !== index) } }), '규격 버튼을 지웠습니다.');
    } else if (res.button === 'up') {
      this._save((pp) => {
        const l = pp.sizes[kind].slice();
        [l[index - 1], l[index]] = [l[index], l[index - 1]];
        return { ...pp, sizes: { ...pp.sizes, [kind]: l } };
      }, '규격 버튼을 앞으로 옮겼습니다.');
    } else if (res.button === 'ok') {
      const s = this._readSize(res.values);
      if (!s) return;
      this._save((pp) => ({ ...pp, sizes: { ...pp.sizes, [kind]: pp.sizes[kind].map((x, i) => (i === index ? s : x)) } }), '규격 버튼을 고쳤습니다.');
    }
  }

  _spacingSection(p) {
    const sp = p.labelSpacing;
    const pair = (label, key, offText, onText, material, type) => {
      const set = (on) => this._save((pp) => ({ ...pp, labelSpacing: { ...pp.labelSpacing, [key]: on } }), '띄어 쓰기를 바꿨습니다.');
      const opt = (on, text) => el('button', {
        type: 'button', class: `btn settings-toggle ${sp[key] === on ? 'btn-on' : ''}`,
        'aria-pressed': sp[key] === on ? 'true' : 'false', dataset: { spacing: key, value: on ? 'space' : 'join' },
        onclick: () => { if (sp[key] !== on) set(on); },
      }, text, el('span', { class: 'settings-example' }, spacingExample(material, type, { ...sp, [key]: on })));
      return el('div', { class: 'settings-row' },
        el('span', { class: 'settings-label' }, label),
        el('div', { class: 'settings-toggles' }, opt(false, offText), opt(true, onText)));
    };
    return this._section('창 라벨 띄어 쓰기', '창 라벨에서 재질과 종류 사이를 띄울지 고릅니다. 화면과 출력 도면에 함께 쓰입니다.',
      pair('영문 재질 (PVC, AL)', 'spaceLatin', '붙여 쓰기', '띄어 쓰기', 'PVC', '단창'),
      pair('한글 재질 (목재 등)', 'spaceKorean', '붙여 쓰기', '띄어 쓰기', '목재', '이중창'));
  }

  _householdSection(p) {
    const hh = p.household;
    const rows = NUMBER_FIELDS.map((f) => {
      const input = el('input', {
        class: 'text-input settings-number', type: 'text', inputmode: 'numeric', value: String(hh[f.key]),
        'aria-label': f.label, dataset: { setting: f.key }, enterkeyhint: 'done',
      });
      const apply = () => {
        const n = Number(String(input.value).replace(/[^0-9]/g, ''));
        const [lo, hi] = f.range;
        if (!input.value.trim() || !(n >= lo && n <= hi)) {
          this.toast(`${f.label}은(는) ${lo}~${hi}mm로 넣어 주세요.`, { type: 'warn' });
          input.value = String(getPrefs().household[f.key]);
          return;
        }
        if (n === getPrefs().household[f.key]) { input.value = String(n); return; }
        this._save((pp) => ({ ...pp, household: { ...pp.household, [f.key]: Math.round(n) } }), `${f.label}: ${Math.round(n)}mm로 바꿨습니다 (새 세대부터).`);
      };
      input.addEventListener('change', apply);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      return el('div', { class: 'settings-row settings-num-row' },
        el('label', { class: 'settings-label' }, f.label),
        el('div', { class: 'settings-num' }, input, el('span', { class: 'settings-unit' }, 'mm'),
          hh[f.key] !== DEFAULT_HOUSEHOLD[f.key] ? el('span', { class: 'settings-default' }, `처음 값 ${DEFAULT_HOUSEHOLD[f.key]}`) : null),
        el('p', { class: 'settings-note settings-help' }, f.help));
    });
    const store = this.store();
    let current = null;
    if (store && store.project) {
      const s = { ...DEFAULT_HOUSEHOLD, ...(store.project.settings || {}) };
      const info = store.project.info || {};
      const name = String(info.householdName || '').trim() || '이 세대';
      const want = householdSettings(p);
      const same = NUMBER_FIELDS.every((f) => s[f.key] === want[f.key]);
      current = el('div', { class: 'settings-current' },
        el('p', { class: 'settings-current-text' },
          `지금 연 세대 "${name}": 바깥벽 ${s.extWall} · 안쪽 벽 ${s.intWall} · 양쪽 값 차이 ${s.twoSideTolerance} · 앞뒤 맞추기 ${s.closureTolerance} (mm)`),
        same
          ? el('p', { class: 'settings-note' }, '위의 값과 같습니다.')
          : el('button', { type: 'button', class: 'btn btn-primary settings-apply', onclick: () => this.applyToOpen() }, '지금 연 세대에도 적용'));
    }
    return this._section('새 세대 기본값', '새로 만드는 세대에 들어가는 값입니다. 이미 만든 세대는 그대로이고, 지금 연 세대는 아래 버튼으로 바꿀 수 있습니다.',
      ...rows, current);
  }

  applyToOpen() {
    const store = this.store();
    if (!store || typeof store.setSettings !== 'function') return false;
    const want = householdSettings();
    const ok = this.command(() => store.setSettings(want), '세대 기본값 적용');
    if (ok) {
      this.toast('지금 연 세대에 적용했습니다. ↶ 버튼으로 되돌릴 수 있습니다.', { type: 'ok' });
      try { this.onChange(); } catch (err) { console.error('[settings] onChange failed', err); }
    }
    this.render();
    return ok;
  }

  _surveyorSection(p) {
    const input = el('input', {
      class: 'text-input settings-surveyor', type: 'text', value: p.surveyor, placeholder: '이름', 'aria-label': '조사자 이름',
      maxlength: String(LIMITS.surveyorChars), enterkeyhint: 'done', autocomplete: 'off',
    });
    const apply = () => {
      const v = input.value.trim();
      if (v === getPrefs().surveyor) return;
      this._save({ surveyor: v }, v ? `조사자 이름을 "${v}"(으)로 저장했습니다.` : '조사자 이름을 지웠습니다.');
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    return this._section('조사자', '새 세대를 만들면 세대 정보의 조사자 칸에 이 이름이 들어갑니다.',
      el('div', { class: 'settings-row' }, el('label', { class: 'settings-label' }, '기본 조사자 이름'), input));
  }
}
