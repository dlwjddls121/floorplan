// 세대 정보 form (plan §2-1, 부록 A): 사업명, 세대명(대상자), 주소, 조사일, 조사자 and the free-text
// 도면 제목 (empty = no title on the output). Opened when the editor title in the top bar is tapped.
//
//   openInfoForm({ store, command, toast, storage }) → Promise<{ saved: bool, patch }>
//     store    the DocStore (reads project.info, calls store.setInfo(patch) through `command`)
//     command  (fn, label) → bool, as in the editor (error handling); default: call fn directly
//     storage  localStorage-like object for the per-device surveyor default (default localStorage)
// Only changed fields (trimmed) are sent to setInfo; nothing is sent when nothing changed.
import { el } from './panel.js';

// Same key main.js uses for new households (newProject reads it).
export const SURVEYOR_KEY = 'floorplan.surveyor';

export const INFO_FIELDS = Object.freeze([
  { name: 'householdName', label: '세대명 (대상자)', placeholder: '예: 홍길동' },
  { name: 'address', label: '주소', placeholder: '예: ○○구 ○○동' },
  { name: 'projectName', label: '사업명', placeholder: '예: 2026 주거환경개선' },
  { name: 'surveyDate', label: '조사일', type: 'date' },
  { name: 'surveyor', label: '조사자', placeholder: '이름' },
  { name: 'title', label: '도면 제목', placeholder: '비워 두면 제목 없이 출력됩니다' },
]);

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

export function rememberedSurveyor(storage = defaultStorage()) {
  try { return (storage && storage.getItem(SURVEYOR_KEY)) || ''; } catch (_) { return ''; }
}

export function rememberSurveyor(name, storage = defaultStorage()) {
  try {
    if (storage && name) storage.setItem(SURVEYOR_KEY, name);
  } catch (_) { /* storage may be blocked */ }
}

// Changed fields only, trimmed. values: { fieldName: string }. → patch (possibly empty)
export function buildInfoPatch(info, values) {
  const patch = {};
  for (const f of INFO_FIELDS) {
    if (!values || !(f.name in values)) continue;
    const v = String(values[f.name] == null ? '' : values[f.name]).trim();
    const cur = String((info && info[f.name]) || '').trim();
    if (v !== cur) patch[f.name] = v;
  }
  return patch;
}

// Suggested title from the household name and address: "홍길동 / ○○구 ○○동".
export function titleSuggestion(values) {
  return [values.householdName, values.address].map((s) => String(s || '').trim()).filter(Boolean).join(' / ');
}

export function openInfoForm({ store, command = (fn) => { fn(); return true; }, toast = null, storage = defaultStorage() } = {}) {
  return new Promise((resolve) => {
    const info = (store && store.project && store.project.info) || {};
    const inputs = {};
    const form = el('form', { class: 'dialog info-form', role: 'dialog', 'aria-modal': 'true', 'aria-label': '세대 정보' });
    form.append(el('h2', { class: 'dialog-title' }, '세대 정보'),
      el('p', { class: 'dialog-msg info-note' }, '모두 비워 두어도 됩니다. 나중에 PC에서 넣어도 됩니다.'));

    const remembered = rememberedSurveyor(storage);
    const grid = el('div', { class: 'info-grid' });
    for (const f of INFO_FIELDS) {
      let value = info[f.name] || '';
      let sub = null;
      if (f.name === 'surveyor' && !value && remembered) {
        value = remembered;
        sub = el('span', { class: 'info-sub' }, '이 기기에 기억된 조사자');
      }
      const input = el('input', {
        class: 'dialog-input info-input',
        type: f.type || 'text',
        name: f.name,
        value,
        placeholder: f.placeholder || '',
        autocomplete: 'off',
        enterkeyhint: 'done',
      });
      inputs[f.name] = input;
      const field = el('label', { class: `dialog-field info-field info-${f.name}` }, el('span', { class: 'info-label' }, f.label), input, sub);
      if (f.name === 'title') {
        field.append(el('span', { class: 'info-sub' }, '도면 위 가운데에 나옵니다. 밖으로 보낼 때는 출력 화면에서 뺄 수 있습니다.'));
        const fill = el('button', {
          type: 'button',
          class: 'btn btn-small info-fill',
          onclick: () => {
            const t = titleSuggestion(values());
            if (t) { inputs.title.value = t; inputs.title.focus(); }
            else if (toast) toast('먼저 세대명이나 주소를 넣어 주세요.');
          },
        }, '세대명·주소로 채우기');
        grid.append(field, el('div', { class: 'info-fill-row' }, fill));
      } else {
        grid.append(field);
      }
    }
    form.append(grid);

    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
    const finish = (saved) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      if (!saved) return resolve({ saved: false, patch: {} });
      const vals = values();
      const patch = buildInfoPatch(info, vals);
      const surveyor = String(vals.surveyor || '').trim();
      if (surveyor) rememberSurveyor(surveyor, storage);
      if (Object.keys(patch).length && store) command(() => store.setInfo(patch), '세대 정보');
      resolve({ saved: true, patch });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    form.append(el('div', { class: 'dialog-buttons' },
      el('button', { type: 'button', class: 'btn info-cancel', onclick: () => finish(false) }, '취소'),
      el('button', { type: 'submit', class: 'btn btn-primary info-save' }, '저장')));
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(true); });
    // A tap outside does not close the form (typed text must not be lost by accident).
    const backdrop = el('div', { class: 'dialog-backdrop info-backdrop' }, form);
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    // On a tablet the on-screen keyboard would cover half the form; focus only with a mouse.
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (!coarse) inputs.householdName.focus();
  });
}
