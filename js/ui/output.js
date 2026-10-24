// [출력] — A4 output of the drawing (stage C; plan §7).
//
//   renderPaper(ctx, project, derived, layout, options)  draws EVERYTHING in paper mode
//   produceOutput(project, derived, choices, deps)        → Promise<{ blob, fileName, layout }> (300 dpi)
//   deliverFile(blob, fileName, { target })               → Promise<{ method: 'download'|'share'|'cancelled'|'ready'|'failed' }>
//   saveMode(nav) / saveButtons(mode, format)             which save buttons the dialog shows (PC / tablet)
//   outputFileName(project, { drawingOnly, format })      → '<세대명>_평면도_<YYYY-MM-DD>[_그림만].png|jpg|pdf'
//   class OutputDialog(host, ctx)                         the dialog (choices, live preview, save buttons)
//   paperDrawers / registerPaperDrawers({...})            draw functions of the other packages
//   installOutput(DocStore)                               store commands (= core/dims.js installDims)
//
// Registry. The walls, dividers, dimensions, labels, title and notes are drawn here. Openings, fixtures,
// 실 아님 spaces and the memo belong to other packages, which may not be wired in yet; their functions
// are looked up in `paperDrawers` (filled by the integrator) so that a missing one is skipped instead of
// breaking the output. All of them are called as fn(ctx, project, derived, opts) with
//   opts = { toPx, pxPerMM, paper: { pxPerPaperMM, scale }, layout, options }
// except openingCutouts(project, derived) → [{ points: [{x,y}] } | [{x,y}]] (world polygons cleared to
// white in the walls before drawOpenings). Those packages must not draw their own text labels when
// opts.paper is set (labels come from draw-labels.js, so '그림만' can leave them out).
// wallCutouts(project, derived) → polygons, like openingCutouts: the wall parts taken by fixtures put
// into a wall (벽 속에 넣기), cleared white in every kind of output (also 그림만).
//
// 종류 (choices): 전체 도면 (dimension chains + labels), 치수선 없이 (choices.noDims, user 2026-10-18:
// the plan as the editor shows it without 치수선 보기 — each side's measured value written inside the
// room, ui/render.js drawPaperPlanText), 그림만 (choices.drawingOnly: no text at all). All three use the
// same layout (scale and position), so they overlay exactly.
// [↻ 도면 회전] in the dialog turns the plan itself a quarter turn (ctx.rotate; core/rotate.js).
//
// Saving (user 2026-10-24: "저장은 갤러리에 할수도 있어야되고 구글드라이브에 할수도 있어야돼"). Until 0.6.3 [저장]
// on a tablet only opened the share sheet, so nothing was kept on the tablet and the Gallery never showed
// the picture. Now a tablet / phone has two buttons:
//   [갤러리에 저장] ([태블릿에 저장] for a PDF; primary): a download — Chrome on Android writes it to the
//     Download folder, which Samsung Gallery shows as its 'Download' album (PNG / JPG; a PDF is in 내 파일 →
//     다운로드). If a download cannot start, the share sheet opens instead.
//   [드라이브에 저장] + the hint '공유 창에서 「드라이브」를 고르세요': the share sheet (Android lists the last
//     used target first, so from the second time Drive is one tap). The sheet needs the tap's user
//     activation, which a slow 300 dpi page may outlast: then the made file is kept and a toast button
//     (or the same button again) opens the sheet at once. A share that fails otherwise downloads the file.
//   Without file sharing (no navigator.canShare with files) the Drive button is left out and the dialog
//   says how to upload the saved file from the Drive app.
// A PC has one [저장] (a download into the Downloads folder; a desktop share sheet does not reach Drive).

import { wallPolygons, finishPolygons, installDims, buildDimensions, SPLIT_COMPUTED_NOTE } from '../core/dims.js';
import { computePrintLayout, SCALES } from '../core/printlayout.js';
import { drawDimensions } from './draw-dims.js';
import { drawLabels, drawTitle, drawNotes } from './draw-labels.js';
import { drawPaperPlanText } from './render.js';
import { LINES } from './theme.js';
import { canvasToBlob, buildRasterPdf } from '../io/export.js';
import { downloadBlob, isDesktopPlatform } from '../io/fileio.js';
import { el } from './panel.js';

export const installOutput = installDims;

export const paperDrawers = {
  openingCutouts: null,     // (project, derived) → polygons
  drawNotRoomSpaces: null,  // draw-fixtures.js
  drawFixtures: null,       // draw-fixtures.js
  drawOpenings: null,       // draw-openings.js
  drawMemo: null,           // memo-ui.js or core/memo.js
  wallCutouts: null,        // (project, derived) → polygons (fixtures put into a wall)
};

export function registerPaperDrawers(fns = {}) {
  for (const k of Object.keys(paperDrawers)) if (typeof fns[k] === 'function') paperDrawers[k] = fns[k];
}

// Preview width in css px by paper orientation (output.css has the narrow-screen sizes).
const PREVIEW_CSS = { portrait: 300, landscape: 380 };

export const BOTH_VALUES_NOTE = '괄호 안은 반대쪽 실에서 잰 값입니다.';
export const PDF_NOTE = '인쇄할 때 "실제 크기(100%)"로 인쇄해야 축척이 맞습니다.';

export const NO_DIMS_NOTE = '치수선 대신, 실마다 잰 안쪽 길이를 실 안의 벽 옆에 적습니다 (치수선 보기를 끈 화면과 같습니다).';

export const DEFAULT_CHOICES = Object.freeze({
  drawingOnly: false,      // 종류: false = 전체 도면, true = 그림만
  noDims: false,           // 종류 치수선 없이 (wins over drawingOnly)
  format: 'png',           // 'png' | 'jpg' | 'pdf'
  extensionLines: true,    // 치수 보조선
  includeTitle: true,      // 제목 포함 (only when a title exists)
  bothValues: false,       // 양쪽 값 모두 표시
  showMemo: false,         // 메모 포함
  scale: 'auto',           // 'auto' | 50 | 60 | 75 | 100 | 150
});

function callDrawer(name, ...args) {
  const fn = paperDrawers[name];
  if (typeof fn !== 'function') return undefined;
  try { return fn(...args); } catch (err) { console.error(`[output] ${name} failed`, err); return undefined; }
}

// ---- notes ---------------------------------------------------------------------------------------

// True when some two-faced dimension shows two different values (then 양쪽 값 adds a note).
export function hasDifferentPairs(project, derived, res = null) {
  const r = res || buildDimensions(project, derived, {});
  return r.dims.concat(r.aligned || []).some((d) => d.alt != null && Math.round(d.alt) !== Math.round(d.value));
}

// Notes printed for these choices, and the most any choice can print (reserved by the layout).
// baseNotes: from CHECKS (stage D). A computed '(1500)' part on a chain (a measured side cut by a
// 구역 나누기 선, DESIGN.md §7.7) adds SPLIT_COMPUTED_NOTE.
export function notesForChoices(project, derived, choices, baseNotes = []) {
  const base = (baseNotes || []).filter(Boolean);
  const res = buildDimensions(project, derived, {});
  const pairNote = hasDifferentPairs(project, derived, res);
  const has = base.includes(SPLIT_COMPUTED_NOTE);
  // The chains may leave a computed part out (a measured dimension covers the same stretch); 치수선
  // 없이 writes every computed part in brackets, so it needs the note whenever there is one.
  const splitChains = !!(res.notes && res.notes.splitComputed) && !has;
  const splitAll = ((derived && derived.computedMeasures) || []).length > 0 && !has;
  const splitNote = choices.noDims ? splitAll : splitChains;
  const lines = base.slice();
  if (splitNote) lines.push(SPLIT_COMPUTED_NOTE);
  // 치수선 없이 writes every room's own value, so 양쪽 값 does not apply there.
  if (pairNote && choices.bothValues && !choices.noDims) lines.push(BOTH_VALUES_NOTE);
  // The band is reserved for the most any kind can print, so every kind has the same layout.
  return { lines, maxLines: base.length + (splitChains || splitAll ? 1 : 0) + (pairNote ? 1 : 0) };
}

// ---- paper drawing -------------------------------------------------------------------------------

function drawPaperWalls(ctx, project, derived, opts) {
  // Walls plus the finish layers on room faces (drawn as wall, so a ruler on the print matches the
  // dimension, which ends at the finished face).
  const polys = wallPolygons(project, derived).concat(finishPolygons(project, derived));
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  for (const w of polys) {
    const p0 = opts.toPx(w.points[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < w.points.length; i++) {
      const p = opts.toPx(w.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
  ctx.fill('nonzero');
  // Gaps for openings (white), so drawOpenings can draw the window / door frame into them, and for
  // fixtures put into a wall (drawFixtures draws their outline and fill over the gap).
  const cut = [].concat(callDrawer('openingCutouts', project, derived) || [], callDrawer('wallCutouts', project, derived) || []);
  if (Array.isArray(cut) && cut.length) {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (const c of cut) {
      const pts = Array.isArray(c) ? c : (c && c.points);
      if (!Array.isArray(pts) || pts.length < 3) continue;
      const p0 = opts.toPx(pts[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) { const p = opts.toPx(pts[i]); ctx.lineTo(p.x, p.y); }
      ctx.closePath();
    }
    ctx.fill('nonzero');
  }
  ctx.restore();
}

// Dash pattern of the 구역 나누기 선 on paper (paper mm): dash, gap.
export const DIVIDER_DASH_MM = [2.0, 1.2];

function drawPaperDividers(ctx, project, derived, opts) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  ctx.save();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = LINES.dividerExport * opts.paper.pxPerPaperMM;
  ctx.lineCap = 'butt';
  // 구역 나누기 선: dashed (점선), also in 그림만. Dashes in paper mm.
  ctx.setLineDash(DIVIDER_DASH_MM.map((v) => v * opts.paper.pxPerPaperMM));
  ctx.beginPath();
  for (const e of project.edges || []) {
    if (e.kind !== 'divider') continue;
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const p = opts.toPx(a), q = opts.toPx(b);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.restore();
}

// Draws the whole page. options: DEFAULT_CHOICES fields plus { notes: [string] } (already filtered).
// 그림만 (drawingOnly) draws exactly the same picture without any text, number or dimension line;
// 치수선 없이 (noDims) the same picture with the editor's texts instead of the dimension chains.
export function renderPaper(ctx, project, derived, layout, options = {}) {
  const o = { ...DEFAULT_CHOICES, notes: [], ...(options || {}) };
  if (o.noDims) o.drawingOnly = false;
  const u = layout.pxPerPaperMM;
  const opts = {
    toPx: layout.toPx,
    pxPerMM: u / layout.scale,
    paper: { pxPerPaperMM: u, scale: layout.scale },
    // Texts moved by hand: their offsets (paper mm) are converted at the AUTOMATIC scale, the one the
    // editor shows them with, so they land on the same spot of the plan at a scale picked by hand too.
    offsetScale: layout.autoScale || layout.scale,
    layout,
    options: {
      extensionLines: !!o.extensionLines, bothValues: !!o.bothValues, showMemo: !!o.showMemo,
      drawingOnly: !!o.drawingOnly, highlight: null, notes: o.notes, includeTitle: !!o.includeTitle,
    },
  };
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, layout.paperRect.w * u, layout.paperRect.h * u);
  if (project && derived) {
    drawPaperWalls(ctx, project, derived, opts);
    callDrawer('drawNotRoomSpaces', ctx, project, derived, opts);
    callDrawer('drawFixtures', ctx, project, derived, opts);
    callDrawer('drawOpenings', ctx, project, derived, opts);
    drawPaperDividers(ctx, project, derived, opts);
    if (o.noDims) {
      try { drawPaperPlanText(ctx, project, derived, opts); } catch (err) { console.error('[output] plan text failed', err); }
      if (o.includeTitle) drawTitle(ctx, project, derived, opts);
      drawNotes(ctx, project, derived, opts);
      if (o.showMemo) callDrawer('drawMemo', ctx, project, derived, opts);
    } else if (!o.drawingOnly) {
      const dimItems = drawDimensions(ctx, project, derived, opts) || [];
      // Window/door labels keep clear of the dimension numbers and lines (canvas px → world mm).
      const p0 = opts.toPx({ x: 0, y: 0 }), k = opts.pxPerMM;
      const toWorldBox = (b) => ({
        minX: (b.x - p0.x) / k, minY: (b.y - p0.y) / k, maxX: (b.x + b.w - p0.x) / k, maxY: (b.y + b.h - p0.y) / k,
      });
      // A diagonal side's turned number counts as the small boxes along it (its bounding box would
      // cover far more than the number); room names keep clear of those numbers too.
      const obstacles = dimItems.flatMap((it) => (it.aligned ? it.parts : [it.textBox, it.box]).filter(Boolean).map(toWorldBox));
      const nameObstacles = dimItems.filter((it) => it.aligned).flatMap((it) => it.parts.map(toWorldBox));
      drawLabels(ctx, project, derived, { ...opts, obstacles, nameObstacles });
      if (o.includeTitle) drawTitle(ctx, project, derived, opts);
      drawNotes(ctx, project, derived, opts);
      if (o.showMemo) callDrawer('drawMemo', ctx, project, derived, opts);
    }
  }
  ctx.restore();
}

// ---- files ---------------------------------------------------------------------------------------

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
function safeName(s) {
  return String(s || '').replace(BAD_NAME_CHARS, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 40).trim();
}

export function outputFileName(project, { drawingOnly = false, noDims = false, format = 'png', date = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const base = safeName(project && project.info && project.info.householdName) || '세대';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const ext = format === 'jpg' ? 'jpg' : format === 'pdf' ? 'pdf' : 'png';
  const kind = noDims ? '_치수선없음' : drawingOnly ? '_그림만' : '';
  return `${base}_평면도_${day}${kind}.${ext}`;
}

// True when the plan is clearly taller than wide (the team prefers it lying wide: [↻ 도면 회전]).
export function planIsTall(project, derived) {
  let b = null;
  try { b = buildDimensions(project, derived, {}).bounds; } catch (_) { b = null; }
  return !!b && (b.maxY - b.minY) > 1.15 * (b.maxX - b.minX);
}

async function encodeCanvas(canvas, format, paperRect) {
  if (format === 'pdf') {
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    return buildRasterPdf(jpeg, { pageWidthMM: paperRect.w, pageHeightMM: paperRect.h });
  }
  if (format === 'jpg') return canvasToBlob(canvas, 'image/jpeg', 0.92);
  return canvasToBlob(canvas, 'image/png');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Renders the page at `dpi` and encodes it. choices: DEFAULT_CHOICES fields.
// deps: { baseNotes: [string] (CHECKS), dpi = 300 }. → { blob, fileName, layout }
export async function produceOutput(project, derived, choices = {}, deps = {}) {
  const c = { ...DEFAULT_CHOICES, ...choices };
  if (c.noDims) c.drawingOnly = false;
  const hasTitle = !!String((project.info && project.info.title) || '').trim();
  const notes = notesForChoices(project, derived, c, deps.baseNotes);
  const layout = computePrintLayout(project, derived, { scale: c.scale, dpi: deps.dpi || 300, noteLines: notes.maxLines });
  const canvas = makeCanvas(layout.pixelSize.w, layout.pixelSize.h);
  const ctx = canvas.getContext('2d');
  renderPaper(ctx, project, derived, layout, { ...c, includeTitle: c.includeTitle && hasTitle, notes: notes.lines });
  let blob;
  try {
    blob = await encodeCanvas(canvas, c.format, layout.paperRect);
  } finally {
    canvas.width = canvas.height = 0; // free the 8.7 MP buffer right away (tablets)
  }
  return { blob, fileName: outputFileName(project, { drawingOnly: c.drawingOnly, noDims: c.noDims, format: c.format }), layout };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };

// ---- saving: on the tablet (Gallery / Download) or to Drive (the share sheet) --------------------------

export const SAVE_TEXT = Object.freeze({
  pc: '저장',
  gallery: '갤러리에 저장',          // PNG / JPG on a tablet / phone
  device: '태블릿에 저장',           // PDF on a tablet / phone (내 파일 → 다운로드)
  drive: '드라이브에 저장',
  driveHint: '공유 창에서 「드라이브」를 고르세요',
  busy: '만드는 중…',
  noShare: '이 기기에서는 드라이브로 바로 보낼 수 없습니다. 저장한 파일은 드라이브 앱에서 [+] → [업로드] → 다운로드 폴더에서 골라 올려 주세요.',
});

// Toasts after a save (r: the deliverFile result).
export const SAVE_MSG = Object.freeze({
  pc: (name) => `저장했습니다: ${name} (다운로드 폴더)`,
  gallery: (name) => `갤러리에 저장했습니다: ${name} (갤러리 앱 → Download 앨범)`,
  device: (name) => `태블릿에 저장했습니다: ${name} (내 파일 → 다운로드)`,
  drive: '공유 창으로 보냈습니다. 드라이브를 골랐다면 구글 드라이브에 저장됩니다.',
  driveReady: '파일이 준비됐습니다. [드라이브로 보내기]를 누르면 공유 창이 열립니다.',
  driveAction: '드라이브로 보내기',
  driveFellBack: (here) => `공유 창을 열지 못했습니다. ${here}. 드라이브에는 드라이브 앱의 [+] → [업로드]로 올려 주세요.`,
  deviceFellBack: '기기에 바로 저장할 수 없어 공유 창으로 보냈습니다. 고른 곳(내 파일, 드라이브 …)에 저장됩니다.',
  failed: '이 기기에서는 파일을 저장하지 못했습니다. [드라이브에 저장]으로 보내거나 PC에서 출력해 주세요.',
});

// True when this browser can share files (Web Share Level 2). Chrome's canShare ignores the file type.
function canShareFiles(nav, file) {
  try {
    const f = file || new File([''], 'share-test.png', { type: 'image/png' });
    return !!(nav && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [f] }));
  } catch (_) { return false; }
}

// The share sheet needs the tap's transient user activation (about 5 s in Chrome). Browsers without
// navigator.userActivation are assumed to still have it (share() then tells).
function activationActive(nav) {
  const ua = nav && nav.userActivation;
  return !ua || typeof ua.isActive !== 'boolean' ? true : ua.isActive;
}

function downloadSupported() {
  try { return typeof document === 'undefined' || 'download' in document.createElement('a'); } catch (_) { return true; }
}

// Which save buttons the dialog shows. → 'pc' | 'tablet' | 'tablet-noshare'
export function saveMode(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav || isDesktopPlatform(nav)) return 'pc';
  return canShareFiles(nav) ? 'tablet' : 'tablet-noshare';
}

// Button labels for a mode and format. → { primary, drive (null: no Drive button), note (null or text) }
export function saveButtons(mode, format) {
  if (mode === 'pc') return { primary: SAVE_TEXT.pc, drive: null, note: null };
  return {
    primary: format === 'pdf' ? SAVE_TEXT.device : SAVE_TEXT.gallery,
    drive: mode === 'tablet' ? SAVE_TEXT.drive : null,
    note: mode === 'tablet' ? null : SAVE_TEXT.noShare,
  };
}

// The toast for a deliverFile result. mode: saveMode(); format: 'png' | 'jpg' | 'pdf'.
// → { msg, type, action: 'drive' | null } or null (nothing to say: a cancelled share sheet)
export function saveToast(r, mode, format) {
  if (!r || r.method === 'cancelled') return null;
  const here = mode === 'pc' ? SAVE_MSG.pc(r.fileName)
    : format === 'pdf' ? SAVE_MSG.device(r.fileName) : SAVE_MSG.gallery(r.fileName);
  if (r.method === 'ready') return { msg: SAVE_MSG.driveReady, type: 'info', action: 'drive' };
  if (r.method === 'failed') return { msg: SAVE_MSG.failed, type: 'error', action: null };
  if (r.method === 'download') {
    return r.fallback ? { msg: SAVE_MSG.driveFellBack(here), type: 'warn', action: null } : { msg: here, type: 'ok', action: null };
  }
  // 'share'
  return r.fallback ? { msg: SAVE_MSG.deviceFellBack, type: 'warn', action: null } : { msg: SAVE_MSG.drive, type: 'ok', action: null };
}

// Delivers a made file.
//   target 'device': a download through a temporary <a download> in the document, its object URL revoked
//     a minute later, no new window — in a Chrome tab and in the installed app (standalone) alike. Chrome
//     on Android writes it to Download (the Gallery's 'Download' album for PNG / JPG); a PC to Downloads.
//     If it cannot start (no download attribute, an error), the share sheet opens instead (fallback).
//   target 'drive': the share sheet (Drive, KakaoTalk …). Without file sharing: a download (fallback).
//     'ready' when the tap's user activation ran out while the file was made (nothing was opened; a new
//     tap may call again with { retry: true }); a later failure other than a cancel downloads (fallback).
//   target 'auto': 'device' on a PC, 'drive' on a tablet / phone (the 0.6.3 behaviour).
// opts.nav / opts.download (tests): the navigator and the download function (false = could not start).
// Call it from the tap: nothing is awaited before share().
// → { method: 'download' | 'share' | 'cancelled' | 'ready' | 'failed', target, fileName, fallback, error }
export async function deliverFile(blob, fileName, opts = {}) {
  const nav = 'nav' in opts ? opts.nav : (typeof navigator !== 'undefined' ? navigator : null);
  const download = typeof opts.download === 'function' ? opts.download : downloadBlob;
  const retry = !!opts.retry;
  const target = opts.target === 'device' || opts.target === 'drive' ? opts.target
    : (!nav || isDesktopPlatform(nav) ? 'device' : 'drive');
  const ext = fileName.split('.').pop();
  const file = new File([blob], fileName, { type: blob.type || MIME[ext] || 'application/octet-stream' });
  const result = (method, extra = {}) => ({ method, target, fileName, fallback: false, error: null, ...extra });
  const tryDownload = () => {
    try {
      if (!downloadSupported()) return false;
      return download(blob, fileName) !== false;
    } catch (err) {
      console.warn('[output] download could not start', err);
      return false;
    }
  };
  const shareable = canShareFiles(nav, file);
  if (target === 'device') {
    if (tryDownload()) return result('download');
    if (!shareable || !activationActive(nav)) return result('failed');
    try {
      await nav.share({ files: [file], title: fileName });
      return result('share', { fallback: true });
    } catch (err) {
      if (err && err.name === 'AbortError') return result('cancelled', { fallback: true });
      console.warn('[output] share failed too', err);
      return result('failed', { error: String((err && err.name) || err) });
    }
  }
  // 'drive'
  if (!shareable) return tryDownload() ? result('download', { fallback: true }) : result('failed');
  if (!retry && !activationActive(nav)) return result('ready');
  try {
    await nav.share({ files: [file], title: fileName });
    return result('share');
  } catch (err) {
    const name = (err && err.name) || String(err);
    if (name === 'AbortError') return result('cancelled');
    // NotAllowedError: most likely the activation ran out just now; a new tap shares at once.
    if (name === 'NotAllowedError' && !retry) return result('ready', { error: name });
    console.warn('[output] share failed, downloading instead', err);
    return tryDownload() ? result('download', { fallback: true, error: name }) : result('failed', { error: name });
  }
}

// ---- dialog --------------------------------------------------------------------------------------

const PREFS_KEY = 'floorplan.output.choices';
function loadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch (_) { return {}; }
}
function savePrefs(c) {
  try {
    const { format, extensionLines, bothValues, showMemo } = c;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ format, extensionLines, bothValues, showMemo }));
  } catch (_) { /* private mode: not remembered */ }
}

export class OutputDialog {
  // host: element the dialog is appended to (default document.body)
  // ctx: {
  //   store()                       -> current DocStore
  //   toast(msg, { type, ms, action: { label, run } }) -> short message (Toaster.show)
  //   notesFor(project, derived)    -> [string] ※ notes from CHECKS (optional, stage D)
  //   onSaved({ method, fileName, target }) -> optional, after a file was shared or downloaded
  //   rotate()                      -> optional: [↻ 도면 회전] turns the plan a quarter turn
  //                                    clockwise (one undo step); the preview follows
  // }
  constructor(host, ctx) {
    this.host = host || document.body;
    this.ctx = ctx || {};
    this.root = null;
    this.choices = null;
    this.busy = false;
    this._onKey = (e) => { if (e.key === 'Escape' && !this.busy) { e.preventDefault(); e.stopPropagation(); this.close(); } };
  }

  get isOpen() { return !!this.root; }

  _source() {
    const s = this.ctx.store && this.ctx.store();
    return s ? { project: s.project, derived: s.derived } : { project: null, derived: null };
  }

  _baseNotes(project, derived) {
    try { return (this.ctx.notesFor && this.ctx.notesFor(project, derived)) || []; } catch (err) {
      console.error('[output] notesFor failed', err);
      return [];
    }
  }

  open() {
    if (this.root) return;
    const { project } = this._source();
    if (!project) return;
    this.hasTitle = !!String((project.info && project.info.title) || '').trim();
    this.choices = {
      ...DEFAULT_CHOICES, ...loadPrefs(), drawingOnly: false, noDims: false, kind: 'full', scale: 'auto', includeTitle: this.hasTitle,
    };
    this._build();
    document.addEventListener('keydown', this._onKey, true);
    this.refresh();
  }

  close() {
    if (!this.root) return;
    document.removeEventListener('keydown', this._onKey, true);
    this.root.remove();
    this.root = null;
    this._made = null;
  }

  _segmented(label, name, options) {
    const row = el('div', { class: 'out-seg', role: 'group', 'aria-label': label });
    for (const [value, text] of options) {
      row.append(el('button', {
        type: 'button', class: 'btn out-seg-btn', dataset: { name, value: String(value) },
        onclick: () => {
          this.choices[name] = value;
          // 종류: one of 전체 도면 / 치수선 없이 / 그림만.
          if (name === 'kind') {
            this.choices.drawingOnly = value === 'drawing';
            this.choices.noDims = value === 'nodims';
          }
          this.refresh();
        },
      }, text));
    }
    return el('div', { class: 'out-group' }, el('div', { class: 'out-label' }, label), row);
  }

  _check(name, text) {
    const input = el('input', { type: 'checkbox', class: 'out-check-input', dataset: { name } });
    input.addEventListener('change', () => { this.choices[name] = input.checked; this.refresh(); });
    return el('label', { class: 'out-check', dataset: { name } }, input, el('span', {}, text));
  }

  _build() {
    const preview = el('canvas', { class: 'out-preview-canvas', 'aria-label': '출력 미리보기' });
    this.previewCanvas = preview;
    this.scaleSelect = el('select', { class: 'out-select', 'aria-label': '축척' });
    this.scaleSelect.addEventListener('change', () => {
      const v = this.scaleSelect.value;
      this.choices.scale = v === 'auto' ? 'auto' : Number(v);
      this.refresh();
    });
    this.scaleInfo = el('div', { class: 'out-scale-info' });
    this.pdfNote = el('p', { class: 'out-note' }, PDF_NOTE);
    this.kindNote = el('p', { class: 'out-kind-note' }, NO_DIMS_NOTE);
    this.warn = el('p', { class: 'out-warn', role: 'status' });
    // [↻ 도면 회전]: the plan itself turns (the editor too); not an undo step, four presses give it back.
    this.rotateHint = el('span', { class: 'out-rotate-hint' });
    this.rotateBtn = typeof this.ctx.rotate === 'function'
      ? el('button', {
        type: 'button', class: 'btn out-rotate-btn', title: '누를 때마다 도면이 오른쪽으로 90° 회전합니다 (네 번 누르면 원래대로)',
        onclick: () => { if (!this.busy && this.ctx.rotate()) this.refresh(); },
      }, '↻ 도면 회전')
      : null;
    const rotateRow = this.rotateBtn
      ? el('div', { class: 'out-group out-rotate' },
        el('div', { class: 'out-label' }, '방향'),
        el('div', { class: 'out-rotate-row' }, this.rotateBtn, this.rotateHint))
      : null;
    // Save buttons (see the top): PC [저장]; tablet [갤러리에 저장] / [태블릿에 저장] (PDF) + [드라이브에 저장].
    this.saveMode = saveMode();
    const labels = saveButtons(this.saveMode, this.choices.format);
    this.saveBtn = el('button', {
      type: 'button', class: 'btn btn-primary out-save out-save-device', dataset: { target: 'device' },
      onclick: () => this.save('device'),
    }, labels.primary);
    this.driveBtn = null;
    let drive = null;
    if (labels.drive) {
      const hintId = `outDriveHint${++OutputDialog._ids}`;
      this.driveBtn = el('button', {
        type: 'button', class: 'btn out-save out-save-drive', dataset: { target: 'drive' }, 'aria-describedby': hintId,
        onclick: () => this.save('drive'),
      }, labels.drive);
      // The hint wraps after '공유 창에서' only (not inside '「드라이브」를').
      const cut = SAVE_TEXT.driveHint.indexOf('「');
      drive = el('div', { class: 'out-drive' }, this.driveBtn, el('span', { class: 'out-drive-hint', id: hintId },
        SAVE_TEXT.driveHint.slice(0, cut), el('span', { class: 'out-nowrap' }, SAVE_TEXT.driveHint.slice(cut))));
    }
    const saveNote = labels.note ? el('p', { class: 'out-save-note' }, labels.note) : null;
    const checks = el('div', { class: 'out-group' },
      el('div', { class: 'out-label' }, '선택'),
      el('div', { class: 'out-checks' },
        this._check('extensionLines', '치수 보조선'),
        this.hasTitle ? this._check('includeTitle', '제목 포함') : null,
        this._check('bothValues', '양쪽 값 모두 표시'),
        this._check('showMemo', '메모 포함')));
    const dialog = el('div', { class: 'dialog out-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '출력' },
      el('h2', { class: 'dialog-title' }, '출력'),
      el('div', { class: 'out-body' },
        el('div', { class: 'out-preview' }, preview, this.scaleInfo),
        el('div', { class: 'out-options' },
          this._segmented('종류', 'kind', [['full', '전체 도면'], ['nodims', '치수선 없이'], ['drawing', '그림만']]),
          this.kindNote,
          this._segmented('형식', 'format', [['png', 'PNG'], ['jpg', 'JPG'], ['pdf', 'PDF']]),
          checks,
          el('div', { class: 'out-group' }, el('div', { class: 'out-label' }, '축척'), this.scaleSelect),
          rotateRow,
          this.pdfNote,
          this.warn)),
      el('div', { class: `dialog-buttons out-buttons out-mode-${this.saveMode}` },
        saveNote,
        el('button', { type: 'button', class: 'btn out-close', onclick: () => this.close() }, '닫기'),
        drive,
        this.saveBtn));
    this.root = el('div', { class: 'dialog-backdrop out-backdrop' }, dialog);
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root && !this.busy) this.close(); });
    this.host.append(this.root);
  }

  // Layout for the current choices (the same one [저장] uses, at another dpi).
  _layout(project, derived, dpi) {
    const notes = notesForChoices(project, derived, this.choices, this._baseNotes(project, derived));
    const layout = computePrintLayout(project, derived, { scale: this.choices.scale, dpi, noteLines: notes.maxLines });
    return { layout, notes };
  }

  refresh() {
    if (!this.root) return;
    const { project, derived } = this._source();
    if (!project) return;
    const c = this.choices;
    c.kind = c.noDims ? 'nodims' : c.drawingOnly ? 'drawing' : 'full';
    for (const b of this.root.querySelectorAll('.out-seg-btn')) {
      const on = String(c[b.dataset.name]) === b.dataset.value;
      b.classList.toggle('out-seg-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const input of this.root.querySelectorAll('.out-check-input')) {
      input.checked = !!c[input.dataset.name];
      // 그림만 has no text at all, so the text options do not apply; 치수선 없이 has no dimension
      // lines (보조선) and writes each room's own value (양쪽 값).
      const name = input.dataset.name;
      const off = c.drawingOnly || (c.noDims && (name === 'extensionLines' || name === 'bothValues'));
      input.disabled = off;
      input.closest('.out-check').classList.toggle('out-check-off', off);
    }
    this.kindNote.hidden = !c.noDims;
    // Nothing drawn yet: nothing to turn (as the editor's [↻ 회전]).
    if (this.rotateBtn) this.rotateBtn.disabled = !(project.nodes && project.nodes.length);
    if (this.rotateHint) {
      this.rotateHint.textContent = planIsTall(project, derived) ? '도면이 세로로 깁니다. 누르면 가로로 눕힙니다.' : '';
    }
    // Preview: a portrait page 300 css px wide, a landscape one 380 (the paper's orientation follows
    // the plan, printlayout.js), sharp on high-dpi screens.
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const previewFor = (lay) => {
      const land = lay.orientation === 'landscape';
      const cssW = land ? PREVIEW_CSS.landscape : PREVIEW_CSS.portrait;
      return { land, cssW, cssH: (cssW * lay.paperRect.h) / lay.paperRect.w, dpi: (cssW * dpr * 25.4) / lay.paperRect.w };
    };
    this.scaleSelect.disabled = false;
    let { layout, notes } = this._layout(project, derived, (PREVIEW_CSS.portrait * dpr * 25.4) / 210);
    const pv = previewFor(layout);
    if (pv.land) ({ layout, notes } = this._layout(project, derived, pv.dpi));
    // Scale list with the automatic choice spelled out.
    const sel = this.scaleSelect;
    sel.textContent = '';
    sel.append(el('option', { value: 'auto' }, `자동 (1:${layout.autoScale})`));
    for (const s of SCALES) sel.append(el('option', { value: String(s) }, `1:${s}`));
    sel.value = c.scale === 'auto' ? 'auto' : String(c.scale);
    this.scaleInfo.textContent = `A4 ${layout.orientation === 'landscape' ? '가로' : '세로'} · 축척 1:${layout.scale}`;
    this.pdfNote.hidden = c.format !== 'pdf';
    // [갤러리에 저장] reads [태블릿에 저장] for a PDF (it goes to 내 파일 → 다운로드, not to the Gallery).
    if (!this.busy) this.saveBtn.textContent = saveButtons(this.saveMode, c.format).primary;
    let warn = '';
    if (layout.empty) warn = '그린 벽이 없습니다. 벽을 그린 뒤에 출력하세요.';
    else if (layout.overflow) warn = `1:${layout.scale}로는 도면이 A4에 다 들어가지 않습니다. 잘리는 부분이 있을 수 있습니다.`;
    else if (layout.warning) warn = '1:100으로도 A4에 들어가지 않아 1:150으로 출력합니다.';
    this.warn.textContent = warn;
    this.warn.hidden = !warn;
    const canvas = this.previewCanvas;
    canvas.width = layout.pixelSize.w;
    canvas.height = layout.pixelSize.h;
    canvas.style.width = `${pv.cssW}px`;
    canvas.style.height = `${pv.cssH}px`;
    canvas.classList.toggle('out-landscape', pv.land);
    const g = canvas.getContext('2d');
    try {
      renderPaper(g, project, derived, layout, { ...c, includeTitle: c.includeTitle && this.hasTitle, notes: notes.lines });
    } catch (err) {
      console.error('[output] preview failed', err);
    }
    this.lastLayout = layout;
  }

  // The file for the current choices (or `override`), without delivering it. → { blob, fileName, layout }
  async produce(override = {}) {
    const { project, derived } = this._source();
    if (!project) throw new Error('no project');
    const c = { ...this.choices, ...override };
    return produceOutput(project, derived, { ...c, includeTitle: c.includeTitle && this.hasTitle }, {
      baseNotes: this._baseNotes(project, derived),
    });
  }

  // The file for the current choices, made once: [드라이브에 저장] after [갤러리에 저장] (or again after
  // 'ready') delivers the same file at once, inside the new tap's user activation.
  async _madeFile() {
    const { project, derived } = this._source();
    const c = this.choices;
    const key = JSON.stringify([c.drawingOnly, c.noDims, c.format, c.extensionLines, c.includeTitle && this.hasTitle,
      c.bothValues, c.showMemo, c.scale, this._baseNotes(project, derived)]);
    const m = this._made;
    if (m && m.project === project && m.derived === derived && m.key === key) return m.out;
    const out = await this.produce();
    this._made = { project, derived, key, out };
    return out;
  }

  // target: 'device' ([갤러리에 저장] / [태블릿에 저장] / PC [저장]) | 'drive' ([드라이브에 저장]).
  async save(target = 'device') {
    if (this.busy || !this.root) return;
    const { project } = this._source();
    if (!project) return;
    const tgt = target === 'drive' && this.driveBtn ? 'drive' : 'device';
    const btn = tgt === 'drive' ? this.driveBtn : this.saveBtn;
    const label = btn.textContent;
    const buttons = [this.saveBtn, this.driveBtn].filter(Boolean);
    this.busy = true;
    for (const b of buttons) b.disabled = true;
    btn.textContent = SAVE_TEXT.busy;
    savePrefs(this.choices);
    const format = this.choices.format;
    try {
      const out = await this._madeFile();
      const r = await deliverFile(out.blob, out.fileName, { target: tgt });
      this._report(r, out, format);
    } catch (err) {
      console.error('[output] save failed', err);
      this._toast('출력 파일을 만들지 못했습니다. 잠시 후 다시 해 보세요.', 'error');
    } finally {
      this.busy = false;
      for (const b of buttons) b.disabled = false;
      btn.textContent = label;
      if (this.root) this.saveBtn.textContent = saveButtons(this.saveMode, this.choices.format).primary;
    }
  }

  // Toast for a deliverFile result; 'ready' offers [드라이브로 보내기], which shares the made file at once.
  _report(r, out, format) {
    const t = saveToast(r, this.saveMode, format);
    if (t) {
      const action = t.action === 'drive' ? {
        label: SAVE_MSG.driveAction,
        run: () => { deliverFile(out.blob, out.fileName, { target: 'drive', retry: true }).then((r2) => this._report(r2, out, format)); },
      } : null;
      this._toast(t.msg, t.type, action ? { action, ms: 15000 } : { ms: t.type === 'ok' ? 4500 : 7000 });
    }
    if ((r.method === 'download' || r.method === 'share') && this.ctx.onSaved) this.ctx.onSaved(r);
  }

  _toast(msg, type, extra = {}) {
    if (typeof this.ctx.toast === 'function') this.ctx.toast(msg, { type, ...extra });
  }
}

OutputDialog._ids = 0;
