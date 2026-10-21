// Project file export / import / share (dev/DESIGN.md §4, plan §3 and appendix B).
//
// Export: on a tablet/phone the file goes through the Web Share sheet (to Google Drive). Android Chrome
// refuses to share .json files (plan appendix B), and navigator.canShare() cannot tell us so in advance:
// Chrome's canShare() does not look at the file type at all (it says yes for .exe, .json, anything). The
// refusal only comes from share() itself, after the tap's user activation is used up, so a retry with
// .txt would fail too. Therefore tablets/phones always share the JSON content as a '.txt' file with
// type 'text/plain'; canShare() is only used to see whether file sharing exists at all. On a PC
// (Windows/macOS/ChromeOS) the file is downloaded as '.json' into the Downloads folder, as the plan
// describes.
// Import: the file picker has no type filter (Drive greys out files otherwise), and the content decides
// whether a file is ours — the extension does not matter.

import { FILE_FORMAT_VERSION, FILE_FORMAT_ID } from '../version.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

const MSG = {
  notOurs: '평면도 앱에서 내보낸 파일이 아닙니다. 다른 파일을 골라 주세요.',
  unreadable: '파일 내용을 읽을 수 없습니다. 내보낼 때 파일이 덜 저장되었거나 망가졌을 수 있습니다.',
  empty: '빈 파일입니다. 다른 파일을 골라 주세요.',
  tooBig: '파일이 너무 커서 열 수 없습니다. 평면도 앱에서 내보낸 파일인지 확인해 주세요.',
  tooNew: '이 파일은 더 새로운 버전의 앱에서 만든 것입니다. 앱을 업데이트한 뒤 다시 열어 주세요.',
  invalid: '파일 안의 도면 자료에 문제가 있어 열 수 없습니다.',
  noFile: '파일을 고르지 않았습니다.',
};

// ---------------------------------------------------------------------------------------------------------
// File names

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Characters that Windows, Android or Drive do not accept in file names, plus control characters.
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function safeNamePart(s) {
  const cleaned = String(s || '')
    .replace(BAD_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, ''); // no leading/trailing dots (hidden files, Windows quirks)
  return cleaned.slice(0, 40).trim();
}

// '<householdName or 세대>_<YYYY-MM-DD_HHmm>' + ext, using local time.
// e.g. projectFileName(p) → '홍길동_2026-10-17_0905.json'
export function projectFileName(project, ext = '.json', date = new Date()) {
  const info = (project && project.info) || {};
  const base = safeNamePart(info.householdName) || '세대';
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  const dotExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  return `${base}_${stamp}${dotExt}`;
}

// ---------------------------------------------------------------------------------------------------------
// Export

// True on Windows, macOS and ChromeOS desktops: those download the file instead of sharing it.
// Android tablets in Chrome's "desktop site" mode report a Linux UA, so they still count as non-desktop.
export function isDesktopPlatform(nav = typeof navigator !== 'undefined' ? navigator : {}) {
  const ua = nav.userAgent || '';
  const uaPlatform = (nav.userAgentData && nav.userAgentData.platform) || '';
  if (/Android/i.test(uaPlatform) || /Android/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return false;
  // iPadOS Safari pretends to be a Mac but has touch points.
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1) return false;
  if (/Windows|macOS|Chrome OS|ChromeOS/i.test(uaPlatform)) return true;
  if (/Windows NT|Macintosh|CrOS/i.test(ua)) return true;
  // Plain Linux: a touch device is most likely an Android tablet in desktop-site mode.
  return !((nav.maxTouchPoints || 0) > 1);
}

// Builds the file content and the two candidate files for an export. Pure apart from `new File`.
// → { text, exportedAt, project, jsonFile, txtFile }
export function buildExportFiles(project, now = new Date()) {
  const exportedAt = now.toISOString();
  const out = Object.assign({}, project, { exportedAt });
  // Two-space indentation keeps the file readable for the person who reads it for estimates (appendix A).
  const text = JSON.stringify(out, null, 2);
  const jsonFile = new File([text], projectFileName(out, '.json', now), { type: 'application/json', lastModified: now.getTime() });
  const txtFile = new File([text], projectFileName(out, '.txt', now), { type: 'text/plain', lastModified: now.getTime() });
  return { text, exportedAt, project: out, jsonFile, txtFile };
}

function canShareFile(nav, file) {
  try {
    return !!(nav && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] }));
  } catch (_) {
    return false;
  }
}

// Decides how to export. → 'share-json' | 'share-txt' | 'download'
// prefer: 'auto' (share .txt on tablets/phones, download on PCs) | 'share' (share .txt anywhere) |
//         'share-json' (share .json; only for a platform known to accept it) | 'download'.
// canShareJson / canShareTxt only say that file sharing exists (see the note at the top).
export function chooseExportMethod({ prefer = 'auto', desktop, canShareJson, canShareTxt }) {
  if (prefer === 'download') return 'download';
  if (prefer === 'auto' && desktop) return 'download';
  if (prefer === 'share-json' && canShareJson) return 'share-json';
  if (canShareTxt) return 'share-txt';
  return 'download';
}

// Exports a project. Does not modify `project` and does not save anything: on success the result carries
// `project` (a copy with exportedAt set) and `exportedAt`; the caller saves it, e.g. with
// storage.markExported(project.id, result.exportedAt) or storage.saveProject(result.project).
// → { method: 'share' | 'download' | 'cancelled', fileName, fileType: 'json' | 'txt', exportedAt, project,
//     shareFailed }
//   method 'cancelled' means the user closed the share sheet; then exportedAt and project are null.
//   shareFailed = true when the share sheet could not open and the file was downloaded instead.
// Call it directly from a click handler: the share sheet needs the click's user activation.
export async function exportProject(project, { prefer = 'auto', now = new Date() } = {}) {
  const built = buildExportFiles(project, now);
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const method = chooseExportMethod({
    prefer,
    desktop: isDesktopPlatform(nav || {}),
    canShareJson: canShareFile(nav, built.jsonFile),
    canShareTxt: canShareFile(nav, built.txtFile),
  });

  let shareFailed = false;
  if (method !== 'download') {
    const file = method === 'share-json' ? built.jsonFile : built.txtFile;
    try {
      await nav.share({ files: [file], title: file.name });
      return { method: 'share', fileName: file.name, fileType: method === 'share-json' ? 'json' : 'txt', exportedAt: built.exportedAt, project: built.project, shareFailed: false };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { method: 'cancelled', fileName: file.name, fileType: null, exportedAt: null, project: null, shareFailed: false };
      }
      // NotAllowedError (lost user activation), DataError, ... → keep the file safe with a download;
      // the caller tells the user (shareFailed) so they can try [내보내기] again for Drive.
      console.warn('[fileio] share failed, downloading instead', err);
      shareFailed = true;
    }
  }
  downloadBlob(built.jsonFile, built.jsonFile.name);
  return { method: 'download', fileName: built.jsonFile.name, fileType: 'json', exportedAt: built.exportedAt, project: built.project, shareFailed };
}

// Saves a blob through a temporary <a download> link.
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

// ---------------------------------------------------------------------------------------------------------
// Import

// Lazily loads model.validateProject (ENGINE). Kept dynamic so that fileio stays usable (and testable)
// on its own; if the model cannot be loaded only the basic checks below apply.
let validatorPromise = null;
function getValidator() {
  if (!validatorPromise) {
    validatorPromise = import('../core/model.js')
      .then((m) => (typeof m.validateProject === 'function' ? m.validateProject : null))
      .catch((err) => {
        console.warn('[fileio] model.js not available, using basic file checks only', err);
        return null;
      });
  }
  return validatorPromise;
}

function fail(code, error, detail) {
  return { ok: false, project: null, error, code, detail: detail || null };
}

// Checks parsed JSON without the model. → null if fine, else a failure result.
export function basicCheck(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('not-ours', MSG.notOurs);
  if (obj.format !== FILE_FORMAT_ID) return fail('not-ours', MSG.notOurs);
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version)) return fail('invalid', MSG.invalid, 'version missing');
  if (obj.version > FILE_FORMAT_VERSION) return fail('too-new', MSG.tooNew, `file version ${obj.version} > ${FILE_FORMAT_VERSION}`);
  if (typeof obj.id !== 'string' || !obj.id) return fail('invalid', MSG.invalid, 'id missing');
  return null;
}

// Reads a picked or dropped file (.json, .txt or anything else — the content decides).
// → { ok: true, project, error: null, code: null, warnings: [] }
//   | { ok: false, project: null, error: '<Korean message>', code, detail }
//   code: 'no-file' | 'empty' | 'too-big' | 'unreadable' | 'not-ours' | 'too-new' | 'invalid'
export async function readProjectFile(file) {
  if (!file) return fail('no-file', MSG.noFile);
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) return fail('too-big', MSG.tooBig);
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return fail('unreadable', MSG.unreadable, String(err));
  }
  text = text.replace(/^﻿/, '').trim(); // editors may add a BOM
  if (!text) return fail('empty', MSG.empty);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    // Not JSON at all: most likely some other file. JSON-looking but broken: a damaged export.
    const looksLikeOurs = text.startsWith('{') && text.includes(FILE_FORMAT_ID);
    return looksLikeOurs ? fail('unreadable', MSG.unreadable, String(err)) : fail('not-ours', MSG.notOurs, String(err));
  }
  const basic = basicCheck(obj);
  if (basic) return basic;

  const validate = await getValidator();
  if (!validate) return { ok: true, project: obj, error: null, code: null, warnings: [] };
  let result;
  try {
    result = validate(obj);
  } catch (err) {
    return fail('invalid', MSG.invalid, String(err && err.stack ? err.stack : err));
  }
  if (!result || !result.ok) {
    const errors = (result && result.errors) || [];
    return fail('invalid', MSG.invalid, errors.map(String).join('; '));
  }
  return { ok: true, project: result.project || obj, error: null, code: null, warnings: (result.errors || []).map(String) };
}

// Opens the system file picker without a type filter (appendix B: Drive greys out filtered files).
// Must be called from a click handler. Resolves with the chosen File, or null if the user cancelled.
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file || null);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0]));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

// Compares the stored copy of a household with an imported file by their modifiedAt (plan §3:
// the comparison uses the time inside the file, not the file name).
// → { relation: 'same' | 'file-newer' | 'local-newer' | 'unknown', message }
export function compareProjects(local, incoming) {
  const tl = local && Date.parse(local.modifiedAt);
  const ti = incoming && Date.parse(incoming.modifiedAt);
  if (!Number.isFinite(tl) || !Number.isFinite(ti)) return { relation: 'unknown', message: '어느 쪽이 더 최신인지 알 수 없습니다.' };
  if (ti > tl) return { relation: 'file-newer', message: '파일이 더 최신입니다.' };
  if (tl > ti) return { relation: 'local-newer', message: '이 기기에 있는 것이 더 최신입니다.' };
  return { relation: 'same', message: '이 기기에 있는 것과 파일이 같은 시각에 수정되었습니다.' };
}
