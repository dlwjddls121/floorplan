// IndexedDB persistence for project documents (dev/DESIGN.md §4).
//
// Database 'floorplan-db':
//   projects  keyPath 'id'   the project document itself (dev/DESIGN.md §2)
//   trash     keyPath 'id'   { id (entry key), projectId, deletedAt (ISO), project }; id is the project id
//                            for the latest deletion, '<projectId>@<deletedAt>' for older ones
//   meta      keyPath 'key'  small app records, e.g. { key: 'persist', ... } (result of storage.persist())
//
// Error policy: every public function either resolves or rejects with a StorageError whose `message` is a
// short Korean sentence that the UI can show as-is in a toast. The original error is kept in `cause` and a
// machine-readable `code` is attached ('unsupported' | 'blocked' | 'quota' | 'too-new' | 'invalid' |
// 'failed'). Nothing here ever touches the in-memory document, so a failed save never loses work.

import { FILE_FORMAT_VERSION } from '../version.js';

// ---------------------------------------------------------------------------------------------------------
// Schema versioning. To change the schema: bump DB_VERSION and append one migration step. Each step runs
// inside the upgrade transaction and must only move the schema from version (index - 1) to (index).
// Never edit an old step: devices in the field may still be on any older version.
const DB_VERSION = 1;
const MIGRATIONS = [
  null, // index 0: no database
  // v1: initial schema.
  (db) => {
    const projects = db.createObjectStore('projects', { keyPath: 'id' });
    projects.createIndex('modifiedAt', 'modifiedAt');
    const trash = db.createObjectStore('trash', { keyPath: 'id' });
    trash.createIndex('deletedAt', 'deletedAt');
    db.createObjectStore('meta', { keyPath: 'key' });
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
// Re-ask the browser for persistent storage, in a browser tab, at most this often while it keeps saying no.
// Chrome decides silently (no prompt) and becomes more willing after the app is installed, so a later
// retry can succeed. The installed app (display-mode standalone) asks on every start while not persisted,
// and at once when the last request was made in a tab: the usual first visit is a Chrome tab, which is
// refused, and a 7-day wait left the household plans (on the device only) as best-effort storage for the
// first week after installing (review 2026-10-25). A tab still waits, because some browsers (Firefox)
// do show a prompt for persist().
const PERSIST_RETRY_MS = DAY_MS;

// 'standalone' (opened from the home-screen icon / installed app) or 'browser'.
function displayMode() {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) return 'standalone';
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return 'standalone';
  } catch (_) { /* unknown: a tab */ }
  return 'browser';
}
// navigator.storage calls are raced against this timeout: some environments (e.g. headless Chrome)
// never settle them, and opening the app must not hang on a nice-to-have.
const PERSIST_TIMEOUT_MS = 2000;

let dbName = 'floorplan-db';
let dbPromise = null;
// The open connection itself, once dbPromise has resolved (null while opening or after it closed): the
// pagehide write (saveProjectNow) must be issued synchronously, without awaiting anything.
let openDb = null;

// ---------------------------------------------------------------------------------------------------------
// Errors

export class StorageError extends Error {
  constructor(message, code = 'failed', cause = null) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

const MSG = {
  unsupported: '이 브라우저에서는 기기 안에 도면을 저장할 수 없습니다. 크롬으로 열어 주세요. (비공개 창에서는 저장되지 않을 수 있습니다.)',
  blocked: '평면도 앱이 다른 창(탭)에서도 열려 있어 저장소를 준비하지 못했습니다. 다른 창의 평면도 앱을 닫고 다시 열어 주세요.',
  quota: '기기 저장공간이 부족해 저장하지 못했습니다. 그린 내용은 화면에 그대로 있습니다. 먼저 [내보내기]로 파일을 저장한 뒤 기기 공간을 비워 주세요.',
  tooNew: '이 도면은 더 새로운 버전의 앱에서 만든 것입니다. 파일이 망가지지 않도록 저장하지 않았습니다. 앱을 업데이트해 주세요.',
  invalid: '도면 자료가 올바르지 않아 저장하지 못했습니다.',
  notFound: '휴지통에서 그 세대를 찾지 못했습니다.',
};

// Korean action names used in generic failure messages.
const ACTION = {
  open: '저장소 준비',
  save: '저장',
  load: '불러오기',
  list: '세대 목록 읽기',
  delete: '지우기',
  restore: '되살리기',
  purge: '휴지통 정리',
  meta: '설정 저장',
};

function toStorageError(err, action) {
  if (err instanceof StorageError) return err;
  const name = err && err.name;
  if (name === 'QuotaExceededError') return new StorageError(MSG.quota, 'quota', err);
  const what = ACTION[action] || '저장';
  const tail = action === 'save' ? ' 그린 내용은 화면에 그대로 있습니다.' : '';
  return new StorageError(`${what} 중 문제가 생겼습니다. 잠시 뒤 다시 해 보거나 앱을 다시 열어 주세요.${tail}`, 'failed', err);
}

// ---------------------------------------------------------------------------------------------------------
// Small promise helpers around the IndexedDB request/transaction API.

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new StorageError(MSG.unsupported, 'unsupported'));
      return;
    }
    let settled = false;
    let request;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (err) {
      reject(new StorageError(MSG.unsupported, 'unsupported', err));
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const from = event.oldVersion || 0;
      for (let v = from + 1; v <= DB_VERSION; v++) MIGRATIONS[v](db, request.transaction);
    };
    request.onblocked = () => {
      // Another tab holds an older version open and did not close it. Report it; if the open succeeds
      // later anyway we close that late connection (see onsuccess) and the next call opens again.
      if (!settled) {
        settled = true;
        reject(new StorageError(MSG.blocked, 'blocked'));
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // A newer app version (another tab, or after an update) wants to upgrade: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        if (openDb === db) openDb = null;
      };
      // The browser may close the connection on its own (e.g. storage cleared): reopen on next use.
      db.onclose = () => {
        dbPromise = null;
        if (openDb === db) openDb = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      const err = request.error;
      if (err && err.name === 'VersionError') {
        // The database on this device was created by a newer app version.
        reject(new StorageError('이 기기에는 더 새로운 버전의 앱이 저장한 자료가 있습니다. 앱을 업데이트해 주세요.', 'too-new', err));
      } else if (err && (err.name === 'InvalidStateError' || err.name === 'SecurityError' || err.name === 'UnknownError')) {
        reject(new StorageError(MSG.unsupported, 'unsupported', err));
      } else {
        reject(toStorageError(err, 'open'));
      }
    };
  });
}

function getDb() {
  if (!dbPromise) {
    const p = openDatabase().then((db) => {
      if (dbPromise === p) openDb = db;
      return db;
    }, (err) => {
      if (dbPromise === p) dbPromise = null; // allow a later retry
      throw err;
    });
    dbPromise = p;
  }
  return dbPromise;
}

// Run `work(stores, tx)` in one transaction and resolve with its return value after the transaction
// commits. Retries once if the connection was closed under us (InvalidStateError).
async function withStores(storeNames, mode, action, work) {
  for (let attempt = 0; ; attempt++) {
    let db;
    try {
      db = await getDb();
    } catch (err) {
      throw toStorageError(err, 'open');
    }
    try {
      const options = mode === 'readwrite' ? { durability: 'strict' } : undefined;
      const tx = db.transaction(storeNames, mode, options);
      const done = transactionDone(tx);
      const stores = {};
      for (const n of storeNames) stores[n] = tx.objectStore(n);
      let result;
      try {
        result = await work(stores, tx);
      } catch (err) {
        try { tx.abort(); } catch (_) { /* already finished */ }
        done.catch(() => {});
        throw err;
      }
      await done;
      return result;
    } catch (err) {
      if (attempt === 0 && err && err.name === 'InvalidStateError') {
        dbPromise = null;
        if (openDb === db) openDb = null;
        continue;
      }
      throw toStorageError(err, action);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

function timeOf(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function laterIso(a, b) {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === null) return tb === null ? null : b;
  if (tb === null) return a;
  return tb > ta ? b : a;
}

// Info fields as text, whatever a hand-edited file put there (numbers, objects, null).
function infoText(v) {
  if (typeof v === 'string') return v;
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v);
  return '';
}

function projectName(project) {
  const info = (project && project.info && typeof project.info === 'object') ? project.info : {};
  const name = infoText(info.householdName).trim() || infoText(info.projectName).trim() || infoText(info.title).trim();
  return name || '새 세대';
}

// dirty = modified after the last export (or never exported).
function isDirty(project) {
  const m = timeOf(project.modifiedAt);
  const e = timeOf(project.exportedAt);
  if (e === null) return true;
  if (m === null) return false;
  return m > e;
}

function summarize(project) {
  const info = (project.info && typeof project.info === 'object') ? project.info : {};
  return {
    id: project.id,
    name: projectName(project),
    modifiedAt: typeof project.modifiedAt === 'string' ? project.modifiedAt : null,
    exportedAt: typeof project.exportedAt === 'string' ? project.exportedAt : null,
    dirty: isDirty(project),
    // Extra fields for the list screen (search, subtitles). Not part of the minimal contract.
    createdAt: project.createdAt || null,
    householdName: infoText(info.householdName),
    address: infoText(info.address),
    surveyDate: infoText(info.surveyDate),
  };
}

// summarize() that never throws: one damaged record must not take the whole list down.
function trySummarize(project) {
  try {
    return project && typeof project === 'object' && typeof project.id === 'string' ? summarize(project) : null;
  } catch (err) {
    console.warn('[storage] skipped a record that cannot be listed', err);
    return null;
  }
}

function checkSavable(project) {
  if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id) {
    throw new StorageError(MSG.invalid, 'invalid');
  }
  if (typeof project.version === 'number' && project.version > FILE_FORMAT_VERSION) {
    throw new StorageError(MSG.tooNew, 'too-new');
  }
}

function newProjectId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = 'p_';
  for (const b of bytes) s += alphabet[b % 36];
  return s;
}

async function readMeta(key) {
  return withStores(['meta'], 'readonly', 'meta', (s) => promisifyRequest(s.meta.get(key)));
}

async function writeMeta(record) {
  return withStores(['meta'], 'readwrite', 'meta', (s) => promisifyRequest(s.meta.put(record)));
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Ask for persistent storage on the first launch; while the browser keeps refusing, again on every start
// of the installed app and at most every PERSIST_RETRY_MS in a tab. The outcome is recorded in meta
// 'persist' (with the display mode of the last request) and reported by storageStatus().
async function requestPersistence() {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!sm || typeof sm.persist !== 'function') return { supported: false, persisted: false };
  let persisted = false;
  try {
    persisted = typeof sm.persisted === 'function' ? !!(await withTimeout(sm.persisted(), PERSIST_TIMEOUT_MS, false)) : false;
  } catch (_) { /* treat as not persisted */ }
  let record = null;
  try { record = await readMeta('persist'); } catch (_) { /* meta is best-effort */ }
  const now = Date.now();
  const last = record ? timeOf(record.lastRequestedAt) : null;
  const mode = displayMode();
  const shouldAsk = !persisted && (last === null || mode === 'standalone' || now - last >= PERSIST_RETRY_MS);
  if (shouldAsk) {
    let granted = false;
    try {
      granted = await withTimeout(sm.persist(), PERSIST_TIMEOUT_MS, false);
    } catch (_) { granted = false; }
    persisted = !!granted;
    const iso = new Date(now).toISOString();
    record = {
      key: 'persist',
      firstRequestedAt: (record && record.firstRequestedAt) || iso,
      lastRequestedAt: iso,
      granted: persisted,
      requestCount: ((record && record.requestCount) || 0) + 1,
      mode,
    };
  } else {
    record = Object.assign({ key: 'persist' }, record || {}, { granted: persisted });
  }
  try { await writeMeta(record); } catch (_) { /* best-effort */ }
  return { supported: true, persisted };
}

// ---------------------------------------------------------------------------------------------------------
// Public API

// Test hook: use a different database name (io.test.html uses its own DB so real data is never touched).
// Must be called before any other function.
export function configureStorage({ name } = {}) {
  if (name) {
    if (dbPromise) dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
    openDb = null;
    dbName = name;
  }
}

// Opens the database (creating or migrating it), asks once for persistent storage and records the answer,
// and removes trash older than 30 days. Resolves with { persisted, purged }.
export async function openStorage() {
  await getDb().catch((err) => { throw toStorageError(err, 'open'); });
  const persistence = await requestPersistence();
  let purged = 0;
  try { purged = await purgeTrash(30); } catch (err) { console.warn('[storage] trash purge failed', err); }
  return { persisted: persistence.persisted, purged };
}

// → [{ id, name, modifiedAt, exportedAt, dirty, createdAt, householdName, address, surveyDate }],
//   most recently modified first.
export async function listProjects() {
  const all = await withStores(['projects'], 'readonly', 'list', (s) => promisifyRequest(s.projects.getAll()));
  return all.map(trySummarize).filter(Boolean).sort((a, b) => (timeOf(b.modifiedAt) || 0) - (timeOf(a.modifiedAt) || 0));
}

// → the stored project, or null if there is none with that id.
export async function loadProject(id) {
  const p = await withStores(['projects'], 'readonly', 'load', (s) => promisifyRequest(s.projects.get(id)));
  return p || null;
}

// Upsert. Resolves with the record as stored.
// exportedAt is never moved backwards: if the stored copy was exported later than the incoming snapshot
// knows (the export was recorded with markExported while the editor kept an older snapshot), the stored
// value is kept. This keeps the "마지막 내보내기 이후 수정됨" badge correct whatever the save order.
export async function saveProject(project) {
  checkSavable(project);
  return withStores(['projects'], 'readwrite', 'save', async (s) => {
    const existing = await promisifyRequest(s.projects.get(project.id));
    let record = project;
    if (existing) {
      const exportedAt = laterIso(existing.exportedAt, project.exportedAt);
      if (exportedAt !== (project.exportedAt || null)) record = Object.assign({}, project, { exportedAt });
    }
    await promisifyRequest(s.projects.put(record));
    return record;
  });
}

// The last-moment write when the page is going away (pagehide: a tab or window closed, review 2026-10-25).
// saveProject awaits the connection and reads the stored copy before it writes, and a closing page is gone
// before the write is even issued. This issues the put at once, in this call, on the connection that is
// already open, without that read, and commits it; the stored exportedAt is not merged (the caller's copy
// carries the latest export it knows). It may still not land if the page goes first; the caller keeps its
// normal save as well. → true when the write was issued, false when nothing was (no open connection, an
// invalid project, or the transaction could not start). Never throws.
export function saveProjectNow(project) {
  const db = openDb;
  if (!db) return false;
  try {
    checkSavable(project);
    const tx = db.transaction(['projects'], 'readwrite', { durability: 'strict' });
    tx.onerror = () => {};
    tx.onabort = () => {};
    tx.objectStore('projects').put(project);
    if (typeof tx.commit === 'function') tx.commit();
    return true;
  } catch (_) {
    return false;
  }
}

// Records a successful export of a stored project without rewriting the whole document.
// Resolves with the updated record, or null if the project is not stored.
export async function markExported(id, exportedAt = new Date().toISOString()) {
  return withStores(['projects'], 'readwrite', 'save', async (s) => {
    const existing = await promisifyRequest(s.projects.get(id));
    if (!existing) return null;
    const record = Object.assign({}, existing, { exportedAt: laterIso(existing.exportedAt, exportedAt) });
    await promisifyRequest(s.projects.put(record));
    return record;
  });
}

// Moves a project to the trash (kept 30 days). Resolves true if something was moved.
// Trash entries are keyed by the project id. If the same household is deleted again while an older copy
// is still in the trash (e.g. it was deleted, its Drive backup imported, and that deleted too), the
// older entry is kept under its own key '<id>@<deletedAt>', so no trashed copy is ever overwritten.
export async function deleteProject(id) {
  return withStores(['projects', 'trash'], 'readwrite', 'delete', async (s) => {
    const project = await promisifyRequest(s.projects.get(id));
    if (!project) return false;
    await putInTrash(s, project);
    await promisifyRequest(s.projects.delete(id));
    return true;
  });
}

// The trash part of deleteProject (inside its transaction): `project` becomes the trash entry keyed by its
// id; an older entry of the same household is kept under '<id>@<deletedAt>'.
async function putInTrash(s, project) {
  const id = project.id;
  const older = await promisifyRequest(s.trash.get(id));
  if (older) {
    let key = `${id}@${older.deletedAt || 'unknown'}`;
    for (let k = 2; await promisifyRequest(s.trash.get(key)); k++) key = `${id}@${older.deletedAt || 'unknown'}#${k}`;
    await promisifyRequest(s.trash.put(Object.assign({}, older, { id: key, projectId: id })));
  }
  await promisifyRequest(s.trash.put({ id, projectId: id, deletedAt: new Date().toISOString(), project }));
}

// [파일로 바꾸기] (세대 목록 [불러오기], the same household already on this device): the stored copy is
// replaced by the file's household, and the copy it replaces goes to the trash first (30 days, as with
// [지우기]), in one transaction. Households are never merged, and the file may be the OLDER one (the
// dialog says which is newer, but [파일로 바꾸기] is the button people usually press): before, the work
// done on this device since was gone for good (round-trip check 2026-10-24). Nothing goes to the trash
// when the stored copy was modified at the same moment as the file's (the same household). exportedAt as
// in saveProject. → { record (as stored), trashed: bool }
export async function replaceProject(project) {
  checkSavable(project);
  return withStores(['projects', 'trash'], 'readwrite', 'save', async (s) => {
    const existing = await promisifyRequest(s.projects.get(project.id));
    let record = project;
    let trashed = false;
    if (existing) {
      const exportedAt = laterIso(existing.exportedAt, project.exportedAt);
      if (exportedAt !== (project.exportedAt || null)) record = Object.assign({}, project, { exportedAt });
      if (timeOf(existing.modifiedAt) === null || timeOf(existing.modifiedAt) !== timeOf(project.modifiedAt)) {
        await putInTrash(s, existing);
        trashed = true;
      }
    }
    await promisifyRequest(s.projects.put(record));
    return { record, trashed };
  });
}

// → [{ id (trash entry key, pass it to restoreProject), projectId, name, deletedAt, modifiedAt, daysLeft }],
//   most recently deleted first.
export async function listTrash() {
  const all = await withStores(['trash'], 'readonly', 'list', (s) => promisifyRequest(s.trash.getAll()));
  const now = Date.now();
  const rows = [];
  for (const r of all) {
    try {
      const deleted = timeOf(r.deletedAt) || now;
      rows.push({
        id: r.id,
        projectId: r.projectId || (r.project && r.project.id) || r.id,
        name: projectName(r.project),
        deletedAt: r.deletedAt,
        modifiedAt: (r.project && typeof r.project.modifiedAt === 'string' && r.project.modifiedAt) || null,
        daysLeft: Math.max(0, Math.ceil((deleted + 30 * DAY_MS - now) / DAY_MS)),
      });
    } catch (err) {
      console.warn('[storage] skipped a trash record that cannot be listed', err);
    }
  }
  return rows.sort((a, b) => (timeOf(b.deletedAt) || 0) - (timeOf(a.deletedAt) || 0));
}

// Moves a project back from the trash. `id` is the trash entry key from listTrash() (for the latest
// deletion of a household it equals the project id). If a project with the same id exists meanwhile
// (e.g. the file was imported again), the restored one gets a new id and " (복원)" is appended to its
// household name. Resolves with the restored project.
export async function restoreProject(id) {
  return withStores(['projects', 'trash'], 'readwrite', 'restore', async (s) => {
    const entry = await promisifyRequest(s.trash.get(id));
    if (!entry) throw new StorageError(MSG.notFound, 'not-found');
    let project = entry.project;
    const projectId = (project && project.id) || entry.projectId || id;
    const clash = await promisifyRequest(s.projects.get(projectId));
    if (clash) {
      const info = Object.assign({}, project.info || {});
      info.householdName = `${projectName(project)} (복원)`;
      project = Object.assign({}, project, { id: newProjectId(), info });
    }
    await promisifyRequest(s.projects.put(project));
    await promisifyRequest(s.trash.delete(id));
    return project;
  });
}

// Permanently removes trash entries deleted more than `olderThanDays` days before `now`.
// Resolves with the number of removed entries. (`now` is a parameter for tests.)
export async function purgeTrash(olderThanDays = 30, now = Date.now()) {
  const cutoff = now - olderThanDays * DAY_MS;
  return withStores(['trash'], 'readwrite', 'purge', async (s) => {
    const all = await promisifyRequest(s.trash.getAll());
    let removed = 0;
    for (const r of all) {
      const t = timeOf(r.deletedAt);
      if (t === null || t < cutoff) {
        await promisifyRequest(s.trash.delete(r.id));
        removed++;
      }
    }
    return removed;
  });
}

// → { supported, persisted, quota, usage, persistRequestedAt, persistRequestCount }
//   quota/usage are bytes (null if unknown). Never rejects.
export async function storageStatus() {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : null;
  const status = {
    supported: typeof indexedDB !== 'undefined' && !!indexedDB,
    persisted: false,
    quota: null,
    usage: null,
    persistRequestedAt: null,
    persistRequestCount: 0,
  };
  if (sm) {
    try { if (sm.persisted) status.persisted = !!(await withTimeout(sm.persisted(), PERSIST_TIMEOUT_MS, false)); } catch (_) { /* unknown */ }
    try {
      if (sm.estimate) {
        const est = (await withTimeout(sm.estimate(), PERSIST_TIMEOUT_MS, null)) || {};
        status.quota = typeof est.quota === 'number' ? est.quota : null;
        status.usage = typeof est.usage === 'number' ? est.usage : null;
      }
    } catch (_) { /* unknown */ }
  }
  try {
    const rec = await readMeta('persist');
    if (rec) {
      status.persistRequestedAt = rec.lastRequestedAt || null;
      status.persistRequestCount = rec.requestCount || 0;
    }
  } catch (_) { /* storage unavailable: leave defaults */ }
  return status;
}
