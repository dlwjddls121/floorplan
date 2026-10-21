// Device-wide settings (설정, plan §1-3 "목록은 설정에서 추가·수정할 수 있습니다", §1-3 띄어 쓰기,
// §2-1 조사자, §5 / §6 기준값). They live in this device's localStorage, never in a household file:
//
//   {
//     v: 1,
//     windowMaterials: ['PVC', 'AL', '목재', '내목외AL'],   // 창 재질 chips (plus '모름' in the panel)
//     windowTypes: ['단창', '이중창', '미닫이창', '고정창'],  // 창 종류 chips
//     doorTypes: ['ABS도어', '목문', ...],                   // 문 종류 chips (plus '직접 입력')
//     sizes: { window: [[w, h|null], ...], door: [...] },   // 자주 쓰는 규격 buttons (mm)
//     labelSpacing: { spaceLatin: false, spaceKorean: true }, // "PVC단창" / "목재 이중창"
//     household: { extWall, intWall, twoSideTolerance, closureTolerance },   // defaults for NEW households
//   }
//   The default surveyor name (조사자) is kept under its own older key SURVEYOR_KEY, which
//   ui/info-form.js and main.js already read and write; loadPrefs / savePrefs include it as `surveyor`.
//
// The per-household values (project.settings: wall thicknesses and tolerances) are copied from
// `household` when a household is created (householdSettings()); [지금 연 세대에도 적용] in the settings
// screen applies them to an open one with store.setSettings (one undo step).
//
// Every storage access is guarded: a blocked or full storage only means the defaults are used and
// nothing is remembered. The module keeps one current copy (getPrefs) and applies the label spacing
// to core/openings.js as soon as it is loaded, so every label (screen, panels, paper) follows it.
import {
  WINDOW_MATERIALS, WINDOW_TYPES, DOOR_TYPES, FREQUENT_SIZES, setLabelSpacing,
} from './openings.js';

export const PREFS_KEY = 'floorplan.prefs.v1';
// Must stay equal to ui/info-form.js SURVEYOR_KEY (core cannot import ui; a test checks it).
export const SURVEYOR_KEY = 'floorplan.surveyor';

export const LIMITS = Object.freeze({
  listItems: 20,          // chips per list
  itemChars: 20,          // characters per chip
  sizes: 12,              // size buttons per kind
  width: [100, 20000],    // mm, as the opening panel accepts
  height: [100, 5000],
  wall: [30, 600],        // assumed wall thickness, mm
  tolerance: [10, 3000],  // mm
  surveyorChars: 30,
});

export const DEFAULT_HOUSEHOLD = Object.freeze({ extWall: 150, intWall: 100, twoSideTolerance: 300, closureTolerance: 300 });

const freezeDeep = (o) => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) freezeDeep(v);
    Object.freeze(o);
  }
  return o;
};

export const DEFAULT_PREFS = freezeDeep({
  v: 1,
  windowMaterials: [...WINDOW_MATERIALS],
  windowTypes: [...WINDOW_TYPES],
  doorTypes: [...DOOR_TYPES],
  sizes: { window: FREQUENT_SIZES.window.map((s) => s.slice()), door: FREQUENT_SIZES.door.map((s) => s.slice()) },
  labelSpacing: { spaceLatin: false, spaceKorean: true },
  household: { ...DEFAULT_HOUSEHOLD },
  surveyor: '',
});

const isNum = (v) => typeof v === 'number' && isFinite(v);

function toNum(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return isNum(n) ? n : null;
}

function inRange(v, [lo, hi]) {
  const n = toNum(v);
  return n != null && n >= lo && n <= hi ? Math.round(n) : null;
}

// A list of chip names: trimmed text, no duplicates, no empty names, at most LIMITS entries.
export function cleanList(list, fallback) {
  if (!Array.isArray(list)) return fallback.slice();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().slice(0, LIMITS.itemChars);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= LIMITS.listItems) break;
  }
  return out;
}

// One size: [w, h] or [w, null] in whole mm. → clean pair | null
export function cleanSize(s) {
  if (!Array.isArray(s)) return null;
  const w = inRange(s[0], LIMITS.width);
  if (w == null) return null;
  if (s[1] == null || s[1] === '') return [w, null];
  const h = inRange(s[1], LIMITS.height);
  return h == null ? null : [w, h];
}

export function cleanSizes(list, fallback) {
  if (!Array.isArray(list)) return fallback.map((s) => s.slice());
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = cleanSize(raw);
    if (!s) continue;
    const key = `${s[0]}*${s[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= LIMITS.sizes) break;
  }
  return out;
}

// Any object → complete, valid prefs (missing or broken parts take the defaults).
export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const D = DEFAULT_PREFS;
  const sizes = r.sizes && typeof r.sizes === 'object' ? r.sizes : {};
  const ls = r.labelSpacing && typeof r.labelSpacing === 'object' ? r.labelSpacing : {};
  const hh = r.household && typeof r.household === 'object' ? r.household : {};
  const pick = (key, range) => {
    const v = inRange(hh[key], range);
    return v == null ? D.household[key] : v;
  };
  return {
    v: 1,
    windowMaterials: cleanList(r.windowMaterials, D.windowMaterials),
    windowTypes: cleanList(r.windowTypes, D.windowTypes),
    doorTypes: cleanList(r.doorTypes, D.doorTypes),
    sizes: { window: cleanSizes(sizes.window, D.sizes.window), door: cleanSizes(sizes.door, D.sizes.door) },
    labelSpacing: {
      spaceLatin: typeof ls.spaceLatin === 'boolean' ? ls.spaceLatin : D.labelSpacing.spaceLatin,
      spaceKorean: typeof ls.spaceKorean === 'boolean' ? ls.spaceKorean : D.labelSpacing.spaceKorean,
    },
    household: {
      extWall: pick('extWall', LIMITS.wall),
      intWall: pick('intWall', LIMITS.wall),
      twoSideTolerance: pick('twoSideTolerance', LIMITS.tolerance),
      closureTolerance: pick('closureTolerance', LIMITS.tolerance),
    },
    surveyor: typeof r.surveyor === 'string' ? r.surveyor.trim().slice(0, LIMITS.surveyorChars) : '',
  };
}

// A fresh, mutable copy of the defaults.
export function defaultPrefs() {
  return normalizePrefs(JSON.parse(JSON.stringify(DEFAULT_PREFS)));
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_) {
    return null;
  }
}

function readItem(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch (_) { return null; }
}

function writeItem(storage, key, value) {
  try {
    if (!storage) return false;
    if (value == null || value === '') storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

// → prefs (defaults where nothing or something unreadable is stored)
export function loadPrefs(storage = defaultStorage()) {
  let parsed = null;
  try {
    const raw = readItem(storage, PREFS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch (_) {
    parsed = null;
  }
  const prefs = normalizePrefs(parsed);
  prefs.surveyor = normalizePrefs({ surveyor: readItem(storage, SURVEYOR_KEY) || '' }).surveyor;
  return prefs;
}

// → true when stored (false: storage blocked or full; the prefs still apply until the app reloads)
export function savePrefs(prefs, storage = defaultStorage()) {
  const p = normalizePrefs(prefs);
  const { surveyor, ...rest } = p;
  const a = writeItem(storage, PREFS_KEY, JSON.stringify(rest));
  const b = writeItem(storage, SURVEYOR_KEY, surveyor);
  return a && b;
}

// ---- the current prefs of this app instance -----------------------------------------------------

let storageRef = defaultStorage();
let current = null;
const listeners = new Set();

// Tests: use another storage object (any { getItem, setItem, removeItem }, or null) and reload.
export function configurePrefsStorage(storage) {
  storageRef = storage;
  current = null;
  applyPrefs(getPrefs());
}

export function getPrefs() {
  if (!current) current = loadPrefs(storageRef);
  return current;
}

// Replace the prefs (normalized), store them, apply them and tell the listeners.
// → { prefs, saved } (saved false: kept for this session only)
export function setPrefs(next) {
  current = normalizePrefs(next);
  const saved = savePrefs(current, storageRef);
  applyPrefs(current);
  for (const fn of [...listeners]) {
    try { fn(current); } catch (err) { console.error('[prefs] listener failed', err); }
  }
  return { prefs: current, saved };
}

// Change one part: updatePrefs((p) => ({ ...p, windowTypes: [...] })) or updatePrefs({ surveyor: '김' }).
export function updatePrefs(patch) {
  const base = JSON.parse(JSON.stringify(getPrefs()));
  const next = typeof patch === 'function' ? patch(base) : { ...base, ...patch };
  return setPrefs(next);
}

// [기본값으로 되돌리기]: everything back to the defaults (the surveyor name too).
export function resetPrefs() {
  return setPrefs(defaultPrefs());
}

export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Pushes what other modules read without importing this one: the label spacing of openings.js.
export function applyPrefs(prefs) {
  const p = prefs || getPrefs();
  setLabelSpacing(p.labelSpacing);
}

// ---- helpers for the app -----------------------------------------------------------------------

// project.settings for a NEW household (main.js newProject: createProject(...) then
// project.settings = { ...project.settings, ...householdSettings() }).
export function householdSettings(prefs = getPrefs()) {
  return { ...normalizePrefs(prefs).household };
}

// The chip lists of the window / door panel. kind: 'window' | 'door'.
export function openingLists(prefs = getPrefs()) {
  return {
    windowMaterials: prefs.windowMaterials.slice(),
    windowTypes: prefs.windowTypes.slice(),
    doorTypes: prefs.doorTypes.slice(),
  };
}

export function frequentSizes(kind, prefs = getPrefs()) {
  return (prefs.sizes[kind === 'door' ? 'door' : 'window'] || []).map((s) => s.slice());
}

// Applied once when this module is first loaded (the app imports it through the panels).
applyPrefs(getPrefs());
