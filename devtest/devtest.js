// Stage-0 device test page (plan §9 row 0, appendix B).
//
// The user opens this page on the Galaxy Tab in Chrome, taps through the tests and sends us the text
// produced by [결과 복사]. Everything the user did is remembered in localStorage (`mem`), because some
// tests need a reload (airplane mode). Live facts (feature detection) are recomputed on every load.
//
// Self-contained apart from ../js/io/export.js, so that it keeps working while the app is being built.

import { A4, mmToPx, canvasToBlob, buildRasterPdf } from '../js/io/export.js';

const DEVTEST_VERSION = '2'; // 2: section 9 (update)

// Same string as FONT_STACK in js/ui/theme.js (kept local so that this page does not depend on the UI package).
const FONT_STACK =
  '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", sans-serif';
const FONT_NAMES = ['Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Noto Sans CJK KR', 'NanumBarunGothic', 'Nanum Barun Gothic'];

// "Pen near" window used by the app's palm rejection (DESIGN.md §5).
const PEN_NEAR_MS = 800;

const STORE_KEY = 'floorplan-devtest-v1';
const IDB_NAME = 'floorplan-devtest'; // separate from the app's 'floorplan-db'
const KOREAN_CHECK = '한글 확인: 홍길동(○○구) 방1 2,800 · 거실 · 화장실1 ※';

const ICON = { ok: '✅', fail: '❌', warn: '⚠️', pending: '⏳' };

const TESTS = [
  { id: 'pen', section: 't-pen', title: '펜 감지' },
  { id: 'share', section: 't-share', title: '드라이브로 보내기' },
  { id: 'file', section: 't-file', title: '파일 불러오기' },
  { id: 'storage', section: 't-storage', title: '저장공간' },
  { id: 'install', section: 't-install', title: '설치·오프라인' },
  { id: 'print', section: 't-print', title: '출력' },
  { id: 'device', section: 't-device', title: '기기 정보' },
  { id: 'door', section: 't-door', title: '미서기문 그림' },
  { id: 'update', section: 't-update', title: '업데이트' },
];

const params = new URLSearchParams(location.search);
const SELFTEST = params.has('selftest'); // headless check: runs the non-interactive parts automatically

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------------------------
// Remembered state

function defaultMem() {
  return {
    pen: {
      hover: 0, draw: 0, downs: 0, touchTotal: 0, touchNear: 0, touchCancel: 0, maxTouches: 0,
      mouse: 0, sideButton: 0, eraser: 0, minP: null, maxP: null, tilt: false,
      maxContact: 0, maxContactNear: 0, seq: [],
    },
    share: { json: null, txt: null, driveJson: null, driveTxt: null },
    file: null,
    storage: null,
    install: { offlineOpened: null, standaloneOpened: null, installOutcome: null, homeIcon: null, wasInstalled: null },
    print: { pdf: null, png: null, error: null, limit: null, measSquare: null, measWall: null, korean: null },
    door: { choice: null, note: '' },
    update: { firstVersion: null, firstAt: null, laterVersion: null, laterAt: null, banner: null, kept: null },
    errors: [],
  };
}

function loadMem() {
  const mem = defaultMem();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const key of Object.keys(mem)) {
        if (!(key in saved)) continue;
        const def = mem[key];
        mem[key] = def && typeof def === 'object' && !Array.isArray(def) && saved[key] && typeof saved[key] === 'object'
          ? { ...def, ...saved[key] }
          : saved[key];
      }
    }
  } catch (err) {
    // Private window or blocked storage: start fresh, the page still works.
  }
  return mem;
}

const mem = loadMem();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch (err) { /* ignore */ }
  }, 300);
}

// Facts detected on this load (not remembered).
const live = {
  shareApi: typeof navigator.share === 'function',
  canShareApi: typeof navigator.canShare === 'function',
  canShareJson: null,
  canShareTxt: null,
  storageNow: null, // { persisted, quota, usage }
  idbPrevious: null,
  sw: null, // { supported, controlled, registered, scope, registerError }
  cached: null, // { found: [...], missing: [...] }
  installPromptSeen: false,
  fonts: [],
  device: [],
};

// ---------------------------------------------------------------------------------------------
// Result rendering

const results = {}; // id → { status, verdict, facts: [[label, value]] }

function setResult(id, status, verdict, facts = []) {
  results[id] = { status, verdict, facts };
  const test = TESTS.find((t) => t.id === id);
  const sec = document.getElementById(test.section);
  const box = $('.status', sec);
  box.dataset.status = status;
  box.innerHTML = `<span class="icon">${ICON[status]}</span>`;
  box.append(document.createTextNode(verdict));
  const list = $('.facts', sec);
  list.textContent = '';
  for (const [label, value] of facts) {
    const li = document.createElement('li');
    li.append(document.createTextNode(`${label}: `));
    const b = document.createElement('b');
    b.textContent = value;
    li.append(b);
    list.append(li);
  }
  renderOverview();
}

function renderOverview() {
  const ul = $('#overview');
  ul.textContent = '';
  TESTS.forEach((t, i) => {
    const r = results[t.id];
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${t.section}`;
    a.textContent = `${r ? ICON[r.status] : ICON.pending} ${i + 1}. ${t.title}`;
    li.append(a);
    ul.append(li);
  });
}

function yesNo(v) {
  if (v === true) return '예';
  if (v === false) return '아니요';
  return '모름';
}

function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '모름';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function errText(err) {
  if (!err) return '알 수 없는 오류';
  return `${err.name || 'Error'}: ${err.message || String(err)}`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Page errors are shown in the footer and included in the copied summary (helps remote debugging).
function recordError(text) {
  mem.errors.push(`${fmtTime(new Date().toISOString())} ${text}`.slice(0, 300));
  if (mem.errors.length > 10) mem.errors.splice(0, mem.errors.length - 10);
  save();
  const f = $('#footer');
  if (f) f.textContent = `페이지 오류가 있었어요: ${text}`;
}
window.addEventListener('error', (e) => recordError(`${e.message} (${e.filename || ''}:${e.lineno || ''})`));
window.addEventListener('unhandledrejection', (e) => recordError(`처리 안 된 오류: ${errText(e.reason)}`));

// ---------------------------------------------------------------------------------------------
// 1. Pen detection

const pen = {
  lastPenTime: 0,
  hovering: false,
  activeTouches: new Set(),
  nearTouches: new Set(), // touch pointers that started while the pen was near
  lastPoint: new Map(),
  liveEvent: null,
  dirty: true,
  ink: null,
  inkCtx: null,
  overlay: null,
  overlayCtx: null,
};

function penIsNear(now = performance.now()) {
  return pen.hovering || now - pen.lastPenTime < PEN_NEAR_MS;
}

function setupPen() {
  pen.ink = $('#penInk');
  pen.overlay = $('#penOverlay');
  pen.inkCtx = pen.ink.getContext('2d');
  pen.overlayCtx = pen.overlay.getContext('2d');
  sizePad();
  window.addEventListener('resize', sizePad);

  const types = ['pointerenter', 'pointerleave', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
  for (const t of types) pen.ink.addEventListener(t, onPadPointer);
  pen.ink.addEventListener('contextmenu', (e) => e.preventDefault());

  $('#penClear').addEventListener('click', () => {
    pen.inkCtx.clearRect(0, 0, pen.ink.width, pen.ink.height);
  });
  $('#penReset').addEventListener('click', () => {
    mem.pen = defaultMem().pen;
    save();
    updatePen();
  });

  // Live readout; also lets the "pen near" indicator decay without new events.
  setInterval(() => { pen.dirty = true; }, 200);
  const tick = () => {
    if (pen.dirty) { renderPenLive(); pen.dirty = false; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  updatePen();
}

function sizePad() {
  const rect = pen.ink.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  for (const c of [pen.ink, pen.overlay]) {
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function pushSeq(label) {
  const seq = mem.pen.seq;
  const last = seq[seq.length - 1];
  if (last && last.l === label) last.n++;
  else seq.push({ l: label, n: 1 });
  if (seq.length > 40) seq.splice(0, seq.length - 40);
}

function seqText() {
  const seq = mem.pen.seq;
  if (!seq.length) return '아직 없음';
  return seq.map((s) => (s.n > 1 ? `${s.l}×${s.n}` : s.l)).join(' → ');
}

function onPadPointer(e) {
  const now = performance.now();
  const p = mem.pen;
  const kind = e.pointerType; // 'pen' | 'touch' | 'mouse' | ''
  const who = kind === 'pen' ? '펜' : kind === 'touch' ? '손' : kind === 'mouse' ? '마우스' : (kind || '?');
  let short = e.type.replace('pointer', '');
  const rect = pen.ink.getBoundingClientRect();
  const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const contact = Math.max(e.width || 0, e.height || 0);

  if (e.type === 'pointerdown' || (e.type === 'pointermove' && e.buttons)) e.preventDefault();

  if (kind === 'pen') {
    pen.lastPenTime = now;
    if (e.type === 'pointerenter') pen.hovering = true;
    if (e.type === 'pointerleave' || e.type === 'pointercancel') pen.hovering = false;
    if (e.type === 'pointermove') {
      if (e.buttons === 0) {
        p.hover++;
        short = 'move(떠있음)';
        pen.hovering = true;
        drawHoverCursor(pt);
      } else {
        p.draw++;
        short = 'move(그리기)';
        drawInk(e.pointerId, pt, '#111', 1 + 4 * (e.pressure || 0.5));
      }
    }
    if (e.type === 'pointerdown') {
      p.downs++;
      if (e.button === 2 || (e.buttons & 2)) p.sideButton++;
      if (e.button === 5 || (e.buttons & 32)) p.eraser++;
      pen.lastPoint.set(e.pointerId, pt);
      clearOverlay();
    }
    if (e.buttons && e.pressure > 0) {
      p.minP = p.minP == null ? e.pressure : Math.min(p.minP, e.pressure);
      p.maxP = p.maxP == null ? e.pressure : Math.max(p.maxP, e.pressure);
    }
    if (e.tiltX || e.tiltY) p.tilt = true;
    if (e.type === 'pointerup' || e.type === 'pointercancel') pen.lastPoint.delete(e.pointerId);
    if (e.type === 'pointerleave') clearOverlay();
  } else if (kind === 'touch') {
    if (e.type === 'pointerdown') {
      p.touchTotal++;
      pen.activeTouches.add(e.pointerId);
      p.maxTouches = Math.max(p.maxTouches, pen.activeTouches.size);
      p.maxContact = Math.max(p.maxContact, Math.round(contact));
      if (penIsNear(now)) {
        p.touchNear++;
        p.maxContactNear = Math.max(p.maxContactNear, Math.round(contact));
        pen.nearTouches.add(e.pointerId);
        short = 'down(펜 가까이)';
      }
      pen.lastPoint.set(e.pointerId, pt);
    }
    if (e.type === 'pointermove' && pen.activeTouches.has(e.pointerId)) {
      const color = pen.nearTouches.has(e.pointerId) ? '#d32f2f' : '#1f5fa8';
      drawInk(e.pointerId, pt, color, 3);
    }
    if (e.type === 'pointercancel') p.touchCancel++;
    if (e.type === 'pointerup' || e.type === 'pointercancel') {
      pen.activeTouches.delete(e.pointerId);
      pen.nearTouches.delete(e.pointerId);
      pen.lastPoint.delete(e.pointerId);
    }
  } else if (kind === 'mouse') {
    if (e.type === 'pointerdown') {
      p.mouse++;
      pen.lastPoint.set(e.pointerId, pt);
    }
    if (e.type === 'pointermove' && e.buttons) drawInk(e.pointerId, pt, '#111', 2);
    if (e.type === 'pointerup') pen.lastPoint.delete(e.pointerId);
  }

  // Touch and mouse moves are not logged (too many); pen moves are compressed.
  if (kind === 'pen' || e.type !== 'pointermove') pushSeq(`${who} ${short}`);

  pen.liveEvent = {
    type: e.type.replace('pointer', ''),
    kind: kind || '(없음)',
    pressure: e.pressure,
    buttons: e.buttons,
    tilt: `${e.tiltX || 0} / ${e.tiltY || 0}`,
    size: `${Math.round(e.width || 0)}×${Math.round(e.height || 0)}`,
  };
  pen.dirty = true;
  scheduleUpdatePen();
  save();
}

function drawInk(id, pt, color, width) {
  const prev = pen.lastPoint.get(id);
  const ctx = pen.inkCtx;
  if (prev) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  }
  pen.lastPoint.set(id, pt);
}

function drawHoverCursor(pt) {
  const ctx = pen.overlayCtx;
  clearOverlay();
  ctx.strokeStyle = '#2e7d32';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#2e7d32';
  ctx.font = `14px ${FONT_STACK}`;
  ctx.fillText('떠 있음', pt.x + 16, pt.y - 10);
}

function clearOverlay() {
  pen.overlayCtx.clearRect(0, 0, pen.overlay.width, pen.overlay.height);
}

function renderPenLive() {
  const ev = pen.liveEvent;
  const p = mem.pen;
  const near = penIsNear();
  const cells = [
    ['마지막 신호', ev ? ev.type : '-'],
    ['종류(pointerType)', ev ? ev.kind : '-'],
    ['누르는 힘(pressure)', ev && ev.pressure != null ? ev.pressure.toFixed(2) : '-'],
    ['버튼(buttons)', ev ? String(ev.buttons) : '-'],
    ['기울기 X / Y', ev ? ev.tilt : '-'],
    ['접촉 크기(px)', ev ? ev.size : '-'],
    ['펜 떠 있음', pen.hovering ? '예' : '아니요', pen.hovering],
    ['펜 가까이(0.8초)', near ? '예' : '아니요', near],
    ['떠 있음 신호 수', String(p.hover), p.hover > 0],
    ['펜으로 그린 신호 수', String(p.draw)],
    ['펜이 닿은 횟수', String(p.downs)],
    ['펜 가까이일 때 손 터치', String(p.touchNear)],
    ['손 터치 전체', String(p.touchTotal)],
    ['동시에 닿은 손가락(최대)', String(p.maxTouches)],
  ];
  const box = $('#penLive');
  box.textContent = '';
  for (const [label, value, on] of cells) {
    const d = document.createElement('div');
    if (on) d.className = 'on';
    d.append(document.createTextNode(label));
    const b = document.createElement('b');
    b.textContent = value;
    d.append(b);
    box.append(d);
  }
  $('#penSeq').textContent = seqText();
}

let penUpdateTimer = 0;
function scheduleUpdatePen() {
  if (penUpdateTimer) return;
  penUpdateTimer = setTimeout(() => { penUpdateTimer = 0; updatePen(); }, 250);
}

function updatePen() {
  const p = mem.pen;
  const facts = [
    ['펜 떠 있음 신호(펜이 닿지 않고 움직일 때)', `${p.hover}회`],
    ['펜으로 그린 신호', `${p.draw}회`],
    ['펜이 닿은 횟수', `${p.downs}회`],
    ['펜 누르는 힘 범위', p.maxP == null ? '없음' : `${p.minP.toFixed(2)} ~ ${p.maxP.toFixed(2)}`],
    ['펜 기울기 정보', p.tilt ? '있음' : '없음'],
    ['펜 옆 버튼 누른 채 닿음', `${p.sideButton}회`],
    ['손 터치 전체', `${p.touchTotal}회`],
    ['펜이 가까이 있을 때 손 터치', `${p.touchNear}회`],
    ['크롬이 스스로 취소한 손 터치', `${p.touchCancel}회`],
    ['동시에 닿은 손가락(최대)', `${p.maxTouches}개`],
    ['손 접촉 크기 최대(펜 가까이일 때)', `${p.maxContact}px (${p.maxContactNear}px)`],
    ['마우스 클릭', `${p.mouse}회`],
    ['신호 순서', seqText()],
  ];

  let status = 'pending';
  let verdict = '아직 시험하지 않았어요. 위 순서대로 흰 칸에서 해 보세요.';
  if (p.hover > 0) {
    status = 'ok';
    verdict = `S펜이 화면에 닿기 전에도 크롬이 알아채요(떠 있음 신호 ${p.hover}회). ` +
      "계획대로 'S펜이 가까이 있으면 손 터치는 무시'하는 방식으로 만들 수 있어요.";
    if (p.touchTotal === 0) verdict += ' (손바닥 시험 3번과 두 손가락 시험 4번도 해 주세요.)';
  } else if (p.downs >= 2) {
    status = 'fail';
    verdict = 'S펜이 화면에 닿아 있을 때만 알 수 있고, 가까이 있는 것은 알 수 없어요. ' +
      "대책: 'S펜을 쓴 직후 잠깐(약 0.8초)은 손 터치 무시' 방식으로 만듭니다.";
  } else if (p.downs === 1) {
    status = 'warn';
    verdict = 'S펜 신호가 한 번 들어왔어요. 몇 번 더 그었다 뗐다 해 주세요.';
  } else if (p.touchTotal > 0) {
    status = 'warn';
    verdict = '손가락 신호만 들어왔어요. S펜으로 그려 보세요. S펜으로 그렸는데도 이 표시가 남으면, 크롬이 S펜을 손가락으로 알아보는 것입니다.';
  } else if (p.mouse > 0) {
    status = 'warn';
    verdict = '마우스 신호만 들어왔어요(PC). 이 시험은 갤럭시 탭에서 S펜으로 해 주세요.';
  }
  if (status !== 'pending' && p.maxTouches >= 2) facts.push(['두 손가락 동시 인식', '됨']);
  setResult('pen', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 2. Share to Drive

function makeTestFiles() {
  const payload = {
    format: 'habitat-floorplan-devtest',
    version: 1,
    createdAt: new Date().toISOString(),
    check: KOREAN_CHECK,
    numbers: [2800, 1600, 1950],
    note: '평면도 앱 기기 시험 파일입니다. 지워도 됩니다.',
  };
  const text = JSON.stringify(payload, null, 2);
  const base = `평면도시험_${fileStamp()}`;
  return {
    json: new File([text], `${base}.json`, { type: 'application/json' }),
    txt: new File([text], `${base}.txt`, { type: 'text/plain' }),
  };
}

function safeCanShare(data) {
  if (!live.canShareApi) return null;
  try { return navigator.canShare(data); } catch (err) { return false; }
}

function setupShare() {
  const files = makeTestFiles();
  live.canShareJson = safeCanShare({ files: [files.json] });
  live.canShareTxt = safeCanShare({ files: [files.txt] });

  $('#shareJson').addEventListener('click', () => shareTestFile('json'));
  $('#shareTxt').addEventListener('click', () => shareTestFile('txt'));
  $('#downloadJson').addEventListener('click', () => {
    const f = makeTestFiles().json;
    downloadBlob(f, f.name);
    $('#shareMsg').textContent = `내려받기를 시작했어요: ${f.name}`;
  });
  for (const btn of $$('[data-confirm]')) {
    btn.addEventListener('click', () => {
      const [fmt, answer] = btn.dataset.confirm.split('-');
      mem.share[fmt === 'json' ? 'driveJson' : 'driveTxt'] = answer === 'yes';
      save();
      updateShare();
    });
  }
  updateShare();
}

function shareTestFile(fmt) {
  const file = makeTestFiles()[fmt];
  const msg = $('#shareMsg');
  if (!live.shareApi) {
    mem.share[fmt] = 'no-api';
    save();
    msg.textContent = '이 브라우저에는 공유 기능이 없어요. (PC라면 정상입니다)';
    updateShare();
    return;
  }
  // navigator.share must be called directly inside the tap handler (no await before it).
  let promise;
  try {
    promise = navigator.share({ files: [file], title: file.name });
  } catch (err) {
    promise = Promise.reject(err);
  }
  msg.textContent = '공유 창에서 “드라이브”를 고르세요…';
  promise.then(
    () => {
      mem.share[fmt] = 'shared';
      msg.textContent = `공유 창에서 앱을 골랐어요(${file.name}). 드라이브에 파일이 생겼는지 확인하고 아래 버튼을 눌러 주세요.`;
      $('#shareConfirm').hidden = false;
    },
    (err) => {
      if (err && err.name === 'AbortError') {
        mem.share[fmt] = 'cancelled';
        msg.textContent = '공유를 취소했어요. 다시 눌러 “드라이브”를 골라 주세요. (드라이브가 목록에 없었다면 그것도 알려 주세요)';
      } else {
        mem.share[fmt] = `error ${errText(err)}`;
        msg.textContent = `.${fmt} 파일은 공유 창으로 보낼 수 없었어요 (${err && err.name}).`;
      }
    }
  ).finally(() => { save(); updateShare(); });
}

function shareOutcomeText(o) {
  if (o == null) return '아직 안 함';
  if (o === 'shared') return '공유 창에서 앱을 고름';
  if (o === 'cancelled') return '취소함';
  if (o === 'no-api') return '공유 기능 없음';
  return `실패 (${o.replace(/^error /, '')})`;
}

function updateShare() {
  const s = mem.share;
  if (s.json === 'shared' || s.txt === 'shared') $('#shareConfirm').hidden = false;
  const facts = [
    ['공유 기능(navigator.share)', live.shareApi ? '있음' : '없음'],
    // Chrome's canShare() does not check the file type, so these only say that file sharing exists.
    ['.json 파일 공유 가능(canShare, 참고용: 파일 종류는 확인 안 함)', yesNo(live.canShareJson)],
    ['.txt 파일 공유 가능(canShare, 참고용: 파일 종류는 확인 안 함)', yesNo(live.canShareTxt)],
    ['.json 보내기', shareOutcomeText(s.json)],
    ['.txt 보내기', shareOutcomeText(s.txt)],
    ['.json 드라이브에 생김', yesNo(s.driveJson)],
    ['.txt 드라이브에 생김', yesNo(s.driveTxt)],
  ];
  const failed = (o) => o && (o === 'no-api' || o.startsWith('error'));
  let status = 'pending';
  let verdict = '아직 시험하지 않았어요. 위 버튼을 하나씩 눌러 드라이브에 저장해 보세요.';
  if (s.driveJson === true) {
    status = 'ok';
    verdict = '.json 파일도 드라이브로 보낼 수 있어요. (앱은 지금 탭에서 .txt로 보냅니다. 내용은 같고, .json이 된다면 나중에 바꿀 수 있어요.)';
  } else if (s.driveTxt === true) {
    status = 'ok';
    verdict = '.txt 파일로는 드라이브로 보낼 수 있어요. ' +
      (s.driveJson === false || failed(s.json) ? '.json은 안 돼서 ' : '') + '앱은 .txt로 보냅니다(내용은 같음).';
    if (s.json == null) {
      status = 'warn';
      verdict += ' .json도 한 번 시험해 주세요.';
    }
  } else if (failed(s.json) && failed(s.txt)) {
    status = 'fail';
    verdict = '공유 창으로 파일을 보낼 수 없어요. 대책: 파일을 내려받은 뒤 드라이브 앱에서 올리는 방식으로 합니다.';
  } else if (s.driveJson === false && s.driveTxt === false) {
    status = 'fail';
    verdict = '공유 창은 열렸지만 드라이브에 파일이 생기지 않았어요. 대책: 내려받은 뒤 드라이브 앱에서 올리는 방식으로 합니다.';
  } else if (s.json || s.txt) {
    status = 'warn';
    verdict = '시험 중이에요. 두 버튼을 모두 눌러 보고, 드라이브에 파일이 생겼는지 아래 버튼으로 알려 주세요.';
  } else if (!live.shareApi) {
    status = 'warn';
    verdict = '이 브라우저에는 공유 기능이 없어요. 갤럭시 탭 크롬에서 해 주세요. (PC에서는 내려받기를 씁니다)';
  }
  setResult('share', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 3. File import

function setupFile() {
  const input = $('#fileInput');
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
  const sec = $('#t-file');
  sec.addEventListener('dragover', (e) => { e.preventDefault(); });
  sec.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  updateFile();
}

async function handleFile(file) {
  const r = {
    name: file.name,
    size: file.size,
    type: file.type || '',
    modified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    at: new Date().toISOString(),
    read: null,
    json: null,
    kind: null,
    korean: null,
    preview: '',
  };
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('파일이 너무 커요(20MB 넘음)');
    const text = await file.text();
    r.read = 'ok';
    r.preview = text.slice(0, 120);
    try {
      const obj = JSON.parse(text);
      r.json = 'ok';
      if (obj && obj.format === 'habitat-floorplan-devtest') {
        r.kind = 'devtest';
        r.korean = obj.check === KOREAN_CHECK;
      } else if (obj && obj.format === 'habitat-floorplan') {
        r.kind = 'project';
      } else {
        r.kind = 'other-json';
      }
    } catch (err) {
      r.json = `fail ${err.message}`;
    }
  } catch (err) {
    r.read = `fail ${errText(err)}`;
  }
  mem.file = r;
  save();
  updateFile();
}

function updateFile() {
  const r = mem.file;
  if (!r) {
    setResult('file', 'pending', '아직 시험하지 않았어요. [파일 고르기]를 눌러 2번에서 드라이브에 저장한 파일을 골라 주세요.', []);
    return;
  }
  const facts = [
    ['파일 이름', r.name],
    ['크기', fmtBytes(r.size)],
    ['형식(type)', r.type || '(비어 있음)'],
    ['파일 수정 시각', fmtTime(r.modified) || '모름'],
    ['읽기', r.read === 'ok' ? '됨' : r.read],
    ['JSON 읽기', r.json === 'ok' ? '됨' : r.json || '-'],
  ];
  if (r.kind === 'devtest') facts.push(['한글 그대로인지', r.korean ? '예' : '아니요 (글자가 바뀜)']);
  let status;
  let verdict;
  if (r.read !== 'ok') {
    status = 'fail';
    verdict = '파일을 골랐지만 내용을 읽지 못했어요. 인터넷이 되는 곳에서 다시 해 보세요.';
  } else if (r.kind === 'devtest' && r.korean) {
    status = 'ok';
    verdict = '2번에서 보낸 시험 파일을 그대로 불러왔어요. 한글도 깨지지 않았어요.';
  } else if (r.kind === 'devtest') {
    status = 'fail';
    verdict = '시험 파일을 불러왔지만 한글 글자가 바뀌었어요.';
  } else if (r.kind === 'project') {
    status = 'ok';
    verdict = '평면도 프로젝트 파일을 불러왔어요.';
  } else if (r.json === 'ok') {
    status = 'warn';
    verdict = '파일은 열렸어요(JSON 형식). 하지만 시험 파일이 아니에요. 2번에서 드라이브에 저장한 파일을 골라 주세요.';
  } else {
    status = 'warn';
    verdict = '파일은 열렸어요. 하지만 JSON 형식이 아니에요(다른 파일을 고르셨다면 정상). 2번에서 드라이브에 저장한 파일을 골라 주세요.';
  }
  setResult('file', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 4. Storage

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB 없음')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function idbRequest(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    let value;
    req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function readStorageNow() {
  const out = { persisted: null, quota: null, usage: null };
  try {
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.quota = est.quota;
      out.usage = est.usage;
    }
  } catch (err) { /* ignore: reported as unknown */ }
  return out;
}

async function storageOnLoad() {
  live.storageNow = await readStorageNow();
  try {
    const db = await idbOpen();
    live.idbPrevious = await idbRequest(db, 'readonly', (s) => s.get('first'));
    db.close();
  } catch (err) {
    live.idbPrevious = null;
  }
  updateStorage();
}

async function runStorageTest() {
  const r = { at: new Date().toISOString(), persistApi: !!(navigator.storage && navigator.storage.persist), persistResult: null, idb: null };
  try {
    if (r.persistApi) r.persistResult = await navigator.storage.persist();
  } catch (err) {
    r.persistResult = `오류 ${errText(err)}`;
  }
  try {
    const db = await idbOpen();
    // A record with Korean text and 256 KB of binary data, written and read back.
    const bytes = new Uint8Array(256 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    const record = { id: 'roundtrip', text: KOREAN_CHECK, bytes, at: r.at };
    await idbRequest(db, 'readwrite', (s) => s.put(record));
    const back = await idbRequest(db, 'readonly', (s) => s.get('roundtrip'));
    let same = back && back.text === KOREAN_CHECK && back.bytes && back.bytes.length === bytes.length;
    if (same) for (let i = 0; i < bytes.length; i += 997) if (back.bytes[i] !== bytes[i]) { same = false; break; }
    const first = await idbRequest(db, 'readonly', (s) => s.get('first'));
    if (!first) await idbRequest(db, 'readwrite', (s) => s.put({ id: 'first', at: r.at }));
    db.close();
    r.idb = same ? 'ok' : 'mismatch';
  } catch (err) {
    r.idb = `오류 ${errText(err)}`;
  }
  mem.storage = r;
  save();
  live.storageNow = await readStorageNow();
  updateStorage();
}

function setupStorage() {
  $('#storageBtn').addEventListener('click', () => {
    $('#storageBtn').disabled = true;
    runStorageTest().finally(() => { $('#storageBtn').disabled = false; });
  });
  updateStorage();
  storageOnLoad();
}

function updateStorage() {
  const r = mem.storage;
  const now = live.storageNow || {};
  const facts = [
    ['저장공간 유지(지금)', now.persisted == null ? '모름' : now.persisted ? '허락됨' : '허락 안 됨'],
    ['사용량 / 쓸 수 있는 양', `${fmtBytes(now.usage)} / ${fmtBytes(now.quota)}`],
  ];
  if (live.idbPrevious && live.idbPrevious.at) facts.push(['처음 저장한 기록(남아 있음)', fmtTime(live.idbPrevious.at)]);
  if (!r) {
    setResult('storage', 'pending', '아직 시험하지 않았어요. [저장공간 시험하기]를 눌러 주세요.', facts);
    return;
  }
  facts.unshift(
    ['시험한 시각', fmtTime(r.at)],
    ['저장공간 유지 요청 결과', r.persistResult === true ? '허락됨' : r.persistResult === false ? '거절됨' : r.persistApi ? String(r.persistResult) : '기능 없음'],
    ['기기 안 저장·읽기(IndexedDB)', r.idb === 'ok' ? '됨' : r.idb === 'mismatch' ? '읽은 내용이 달라요' : r.idb]
  );
  let status;
  let verdict;
  const persisted = r.persistResult === true || now.persisted === true;
  if (r.idb !== 'ok') {
    status = 'fail';
    verdict = '기기 안에 저장하거나 읽지 못했어요. 크롬 설정에서 사이트 데이터가 막혀 있는지 확인이 필요해요.';
  } else if (persisted) {
    status = 'ok';
    verdict = "기기 안 저장이 잘 되고, 크롬이 '저장공간 유지'도 허락했어요.";
  } else {
    status = 'warn';
    verdict = "기기 안 저장은 잘 돼요. 다만 크롬이 '저장공간 유지'를 아직 허락하지 않았어요. " +
      '홈 화면에 설치(5번)한 뒤 다시 눌러 보세요. 끝까지 안 되면 백업 안내를 더 눈에 띄게 만들겠습니다.';
  }
  setResult('storage', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 5. Install / offline

let deferredInstall = null;

function displayMode() {
  for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
    if (window.matchMedia && window.matchMedia(`(display-mode: ${m})`).matches) return m;
  }
  return 'browser';
}

function setupInstall() {
  const now = new Date().toISOString();
  if (navigator.onLine === false) mem.install.offlineOpened = now;
  if (displayMode() !== 'browser') mem.install.standaloneOpened = now;
  save();

  window.addEventListener('beforeinstallprompt', (e) => {
    // No preventDefault(): Chrome may show its own install bar as well, which is fine here.
    // The saved event lets our big button open the same install dialog.
    deferredInstall = e;
    live.installPromptSeen = true;
    $('#installBtn').hidden = false;
    updateInstall();
  });
  window.addEventListener('appinstalled', () => {
    mem.install.installOutcome = 'installed';
    save();
    updateInstall();
  });
  window.addEventListener('online', updateInstall);
  window.addEventListener('offline', updateInstall);
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    const ev = deferredInstall;
    deferredInstall = null;
    $('#installBtn').hidden = true;
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      mem.install.installOutcome = choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch (err) {
      mem.install.installOutcome = `오류 ${errText(err)}`;
      window.alert('설치 창을 열지 못했어요. 크롬 오른쪽 위 ⋮ 메뉴 → “홈 화면에 추가”를 눌러 주세요.');
    }
    save();
    updateInstall();
  });
  $('#installRecheck').addEventListener('click', () => checkOffline());
  for (const btn of $$('[data-home]')) {
    btn.addEventListener('click', () => {
      mem.install.homeIcon = btn.dataset.home === 'yes';
      save();
      updateInstall();
    });
  }
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then((apps) => {
      if (apps && apps.length) { mem.install.wasInstalled = true; save(); updateInstall(); }
    }).catch(() => {});
  }
  updateInstall();
  checkOffline();
  // The service worker may finish caching a few seconds after the first visit.
  setTimeout(checkOffline, 4000);
}

function isDevHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

// Asks the controlling service worker for its cache version (sw.js answers GET_VERSION). → string | null
function swVersion(timeoutMs = 1000) {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctrl || typeof MessageChannel !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve((e.data && e.data.version) || null);
    };
    try { ctrl.postMessage({ type: 'GET_VERSION' }, [channel.port2]); } catch (err) { clearTimeout(timer); resolve(null); }
  });
}

async function checkOffline() {
  const sw = { supported: 'serviceWorker' in navigator, controlled: false, registered: false, scope: '', registerError: null, skippedDev: false, version: null };
  if (sw.supported && window.isSecureContext) {
    try {
      let reg = await navigator.serviceWorker.getRegistration('../');
      // The app registers its service worker from js/main.js. Register the same script here too, so that
      // the offline test works when this page is opened first. Like main.js, skip it on a development
      // host unless ?sw=1 is given, so that edited files always load fresh.
      if (!reg && isDevHost() && params.get('sw') !== '1') {
        sw.skippedDev = true;
      } else if (!reg) {
        try {
          reg = await navigator.serviceWorker.register('../sw.js', { scope: '../', updateViaCache: 'none' });
        } catch (err) {
          sw.registerError = errText(err);
        }
      }
      if (reg) { sw.registered = true; sw.scope = reg.scope; }
      sw.controlled = !!navigator.serviceWorker.controller;
      sw.version = await swVersion();
    } catch (err) {
      sw.registerError = errText(err);
    }
  }
  live.sw = sw;

  const cached = { found: [], missing: [], api: 'caches' in window };
  if (cached.api) {
    const files = [['./index.html', './'], ['./devtest.js'], ['./devtest.css'], ['../js/io/export.js']];
    for (const variants of files) {
      let hit = false;
      for (const v of variants) {
        try {
          if (await caches.match(new URL(v, location.href).href, { ignoreSearch: true })) { hit = true; break; }
        } catch (err) { /* ignore */ }
      }
      // Show paths relative to the app root, e.g. 'devtest/index.html', 'js/io/export.js'.
      const appRoot = new URL('../', location.href).href;
      (hit ? cached.found : cached.missing).push(new URL(variants[0], location.href).href.slice(appRoot.length));
    }
  }
  live.cached = cached;
  updateInstall();
}

function updateInstall() {
  const m = mem.install;
  const sw = live.sw;
  const cached = live.cached;
  const facts = [
    ['주소', location.origin + location.pathname],
    ['https(보안 주소)', window.isSecureContext ? '예' : '아니요'],
    ['지금 인터넷', navigator.onLine ? '연결됨' : '끊김'],
    ['지금 화면 방식', displayMode() === 'browser' ? '크롬 탭' : `앱 화면(${displayMode()})`],
    ['서비스워커(오프라인 기능)', !sw ? '확인 중' : !sw.supported ? '지원 안 함' : sw.registered ? (sw.controlled ? '작동 중' : '등록됨(새로고침하면 작동)') : sw.skippedDev ? '개발용 주소라서 등록 안 함(?sw=1로 시험)' : `없음${sw.registerError ? ` (${sw.registerError})` : ''}`],
    ['오프라인 저장본 버전', (sw && sw.version) || '-'],
    ['오프라인용 저장', !cached ? '확인 중' : !cached.api ? '기능 없음' : `${cached.found.length}/${cached.found.length + cached.missing.length} 파일${cached.missing.length ? ` (빠짐: ${cached.missing.join(', ')})` : ''}`],
    ['설치 버튼(beforeinstallprompt)', live.installPromptSeen ? '나옴' : '아직 안 나옴'],
    ['설치 결과', m.installOutcome == null ? '-' : m.installOutcome === 'accepted' || m.installOutcome === 'installed' ? '설치함' : m.installOutcome === 'dismissed' ? '취소함' : m.installOutcome],
    ['앱 화면으로 열린 적', m.standaloneOpened ? fmtTime(m.standaloneOpened) : '없음'],
    ['인터넷 없이 열린 적', m.offlineOpened ? fmtTime(m.offlineOpened) : '없음'],
    ['홈 화면 아이콘이 비행기 모드에서 열림', yesNo(m.homeIcon)],
  ];
  const ready = sw && sw.controlled && cached && cached.api && cached.missing.length === 0;
  let status;
  let verdict;
  if (!window.isSecureContext) {
    status = 'fail';
    verdict = '이 주소는 https가 아니라서 설치·오프라인 기능이 안 돼요. 정식 주소(https://…)로 열어 주세요.';
  } else if (m.offlineOpened && m.homeIcon === false) {
    status = 'warn';
    verdict = `이 페이지는 인터넷 없이 열렸지만(${fmtTime(m.offlineOpened)}), 홈 화면 아이콘은 안 열렸다고 하셨어요. 확인이 필요해요.`;
  } else if (m.offlineOpened) {
    status = 'ok';
    verdict = `인터넷 없이(비행기 모드) 이 페이지가 열렸어요 (${fmtTime(m.offlineOpened)}).` +
      (m.homeIcon === true ? ' 홈 화면 아이콘도 열렸어요.' : ' 홈 화면 아이콘도 열리는지 알려 주세요.');
  } else if (m.homeIcon === true) {
    status = 'ok';
    verdict = '홈 화면 아이콘이 비행기 모드에서 열렸어요. 이 페이지도 비행기 모드에서 새로고침해 보세요.';
  } else if (ready) {
    status = 'warn';
    verdict = '오프라인 준비가 끝났어요. 이제 홈 화면에 추가하고, 비행기 모드에서 이 페이지를 다시 열어 보세요.';
  } else if (sw && sw.registered && !sw.controlled) {
    status = 'warn';
    verdict = '오프라인 기능을 준비했어요. 인터넷이 되는 상태에서 이 페이지를 한 번 새로고침(⟳)한 뒤 [다시 확인]을 눌러 주세요.';
  } else if (sw && sw.skippedDev) {
    status = 'warn';
    verdict = '개발용 주소(PC)라서 오프라인 기능을 켜지 않았어요. 탭에서는 정식 주소(https)로 열어 주세요.';
  } else if (sw && !sw.registered) {
    status = 'warn';
    verdict = '아직 오프라인 기능이 없어요(앱 파일이 다 올라가지 않았을 수 있음). 잠시 뒤 [다시 확인]을 눌러 주세요.';
  } else {
    status = 'pending';
    verdict = '확인 중이에요…';
  }
  setResult('install', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 6. Print test (A4 PDF and PNG at 300 dpi)

const PRINT_DPI = 300;
const print = { pdfBlob: null, pngBlob: null, pdfName: '', pngName: '', busy: false };

function canvasWorks(w, h) {
  const c = document.createElement('canvas');
  try {
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(w - 2, h - 2, 2, 2);
    const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
    return d[0] === 255 && d[3] === 255;
  } catch (err) {
    return false;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

// When A4 at 300 dpi does not fit, find the largest resolution that does (reported to us).
function findCanvasLimit() {
  for (const dpi of [250, 200, 150, 120, 100, 72]) {
    const w = mmToPx(A4.w, dpi);
    const h = mmToPx(A4.h, dpi);
    if (canvasWorks(w, h)) return { dpi, w, h };
  }
  return null;
}

function usedFont() {
  return live.fonts[0] || '기본 글꼴(sans-serif)';
}

/** Draws the print test sheet. ctx is scaled so that 1 unit = 1 mm. */
function drawPrintSheet(ctx) {
  const font = (sizeMM, bold = false) => `${bold ? 'bold ' : ''}${sizeMM}px ${FONT_STACK}`;
  const pt = (p) => (p * 25.4) / 72; // points → mm
  const DIM_LINE = '#4472C4';
  const DIM_TEXT = '#0070C0';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, A4.w, A4.h);
  ctx.textBaseline = 'alphabetic';

  // Margin frame (10 mm) — also measurable: 190 × 277 mm.
  ctx.strokeStyle = '#9a9a9a';
  ctx.lineWidth = 0.2;
  ctx.strokeRect(10, 10, 190, 277);

  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.font = font(6.5, true);
  ctx.fillText('평면도 앱 인쇄 시험 (A4 · 300dpi)', 105, 24);

  ctx.textAlign = 'left';
  ctx.font = font(3.6);
  ctx.fillText("① 인쇄할 때 크기를 ‘실제 크기’(배율 100%)로 고르세요. ‘페이지에 맞춤’은 끄세요.", 18, 33);
  ctx.fillText('② 아래 사각형의 한 변을 자로 재 보세요. 100mm(99~101mm)이면 맞습니다.', 18, 39);
  ctx.fillText('③ 1:60 축척 예의 벽 길이를 재 보세요. 50mm(49.5~50.5mm)이면 맞습니다.', 18, 45);

  // 100 mm square with millimetre ticks along the top and left edges.
  const x0 = 55;
  const y0 = 56;
  const S = 100;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 0.3;
  ctx.strokeRect(x0, y0, S, S);
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  for (let i = 0; i <= S; i++) {
    const len = i % 10 === 0 ? 5 : i % 5 === 0 ? 3 : 1.5;
    ctx.moveTo(x0 + i, y0); ctx.lineTo(x0 + i, y0 + len); // top edge, ticks inward
    ctx.moveTo(x0, y0 + i); ctx.lineTo(x0 + len, y0 + i); // left edge
    ctx.moveTo(x0 + i, y0 + S); ctx.lineTo(x0 + i, y0 + S - len); // bottom edge
    ctx.moveTo(x0 + S, y0 + i); ctx.lineTo(x0 + S - len, y0 + i); // right edge
  }
  ctx.stroke();
  ctx.font = font(2.6);
  ctx.textAlign = 'center';
  for (let i = 10; i < S; i += 10) {
    ctx.fillText(String(i), x0 + i, y0 + 8.5);
  }
  ctx.textAlign = 'left';
  // Left labels start at 20 so that they do not collide with the top "10" in the corner.
  for (let i = 20; i < S; i += 10) {
    ctx.fillText(String(i), x0 + 6.5, y0 + i + 0.9);
  }
  ctx.textAlign = 'center';
  ctx.font = font(6, true);
  ctx.fillText('100 mm × 100 mm', x0 + S / 2, y0 + S / 2 + 1);
  ctx.font = font(3.6);
  ctx.fillText('한 변이 100mm인 정사각형 (작은 눈금 = 1mm)', x0 + S / 2, y0 + S / 2 + 8);

  // 1:60 example: a 3000 mm wall (150 mm thick) is 50 mm long and 2.5 mm thick on paper.
  const wx0 = 80;
  const wx1 = 130;
  const wy = 190;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000';
  ctx.font = font(pt(12.3));
  ctx.fillText('1:60 축척 예 — 3,000mm 벽 = 종이 위 50mm', 105, 172);
  ctx.fillStyle = '#000';
  ctx.fillRect(wx0, wy, wx1 - wx0, 150 / 60);
  // Dimension line with arrowheads and extension lines.
  const dy = 183;
  ctx.strokeStyle = DIM_LINE;
  ctx.fillStyle = DIM_LINE;
  ctx.lineWidth = pt(0.44);
  ctx.beginPath();
  ctx.moveTo(wx0, dy); ctx.lineTo(wx1, dy);
  ctx.moveTo(wx0, wy - 1); ctx.lineTo(wx0, dy - 2);
  ctx.moveTo(wx1, wy - 1); ctx.lineTo(wx1, dy - 2);
  ctx.stroke();
  const arrow = (x, dir) => {
    ctx.beginPath();
    ctx.moveTo(x, dy);
    ctx.lineTo(x + dir * 1.8, dy - 0.6);
    ctx.lineTo(x + dir * 1.8, dy + 0.6);
    ctx.closePath();
    ctx.fill();
  };
  arrow(wx0, 1);
  arrow(wx1, -1);
  ctx.fillStyle = DIM_TEXT;
  ctx.font = font(pt(15.8));
  ctx.fillText('3000', 105, dy - 1.5);
  ctx.fillStyle = '#555';
  ctx.font = font(3);
  ctx.fillText('벽 두께 150mm = 2.5mm', 105, wy + 7);

  // Korean text at the plan's sizes (§1-2).
  ctx.textAlign = 'left';
  let y = 212;
  ctx.fillStyle = '#000';
  ctx.font = font(pt(15.8));
  ctx.fillText('한글 글꼴 시험 15.8pt: 가나다라마바사 아자차카타파하', 18, y);
  y += 9;
  ctx.font = font(pt(12.3));
  ctx.fillText('실명 12.3pt: 방1 · 거실 · 주방 · 화장실1 · 베란다2 · 다용도실 · 보일러실', 18, y);
  y += 8;
  ctx.fillStyle = DIM_TEXT;
  ctx.font = font(pt(8.8));
  ctx.fillText('라벨 8.8pt: H: 2280   PVC단창 3550*1950   AL단창 2520*1050   ABS도어 800*2000   목문 800*2000', 18, y);
  y += 8;
  ctx.fillStyle = '#000';
  ctx.font = font(pt(12.3));
  ctx.fillText('숫자: 0123456789   2,800   1600+1950=3550   ※ 확인필요', 18, y);

  // Vertical dimension text: left column reads bottom→top, right column top→bottom (§1-2).
  ctx.fillStyle = DIM_TEXT;
  ctx.font = font(pt(15.8));
  ctx.save();
  ctx.translate(30, 118);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('2800 (왼쪽 세로)', 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(180, 118);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('2600 (오른쪽 세로)', 0, 0);
  ctx.restore();

  ctx.fillStyle = '#666';
  ctx.font = font(2.6);
  ctx.textAlign = 'left';
  ctx.fillText(`글꼴: ${usedFont()} · 만든 시각: ${fmtTime(new Date().toISOString())} · 시험 페이지 v${DEVTEST_VERSION}`, 14, 280);
  ctx.textAlign = 'right';
  ctx.fillText('회색 테두리 = 종이 끝에서 10mm (190 × 277mm)', 196, 284);
}

/** Creates the A4 canvas at 300 dpi and draws the sheet. Throws a coded error when it does not fit. */
function makePrintCanvas() {
  const w = mmToPx(A4.w, PRINT_DPI);
  const h = mmToPx(A4.h, PRINT_DPI);
  if (!canvasWorks(w, h)) {
    const limit = findCanvasLimit();
    mem.print.limit = limit;
    const e = new Error(`canvas ${w}x${h} not available`);
    e.code = 'CANVAS_TOO_BIG';
    throw e;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const k = PRINT_DPI / 25.4;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawPrintSheet(ctx);
  return c;
}

function printErrorText(err) {
  if (err && err.code === 'CANVAS_TOO_BIG') {
    const l = mem.print.limit;
    return 'A4 300dpi 그림을 만들 수 없어요(기기 메모리 한계). ' +
      (l ? `이 기기에서 만들 수 있는 가장 큰 크기: ${l.w}×${l.h}px (약 ${l.dpi}dpi).` : '더 작은 크기도 안 돼요.');
  }
  if (err && err.code === 'CANVAS_TO_BLOB_FAILED') return '그림을 파일로 바꾸지 못했어요(메모리 부족 가능). ' + err.message;
  return `만들지 못했어요: ${errText(err)}`;
}

async function makePdf() {
  if (print.busy) return;
  print.busy = true;
  const msg = $('#printMsg');
  msg.textContent = 'PDF를 만드는 중이에요… (몇 초 걸려요)';
  const t0 = performance.now();
  let canvas = null;
  try {
    canvas = makePrintCanvas();
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const pdf = await buildRasterPdf(jpeg, { pageWidthMM: A4.w, pageHeightMM: A4.h });
    print.pdfBlob = pdf;
    print.pdfName = `평면도_인쇄시험_${fileStamp()}.pdf`;
    mem.print.pdf = { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), bytes: pdf.size, w: canvas.width, h: canvas.height, font: usedFont() };
    mem.print.error = null;
    $('#pdfShare').disabled = false;
    $('#pdfDownload').disabled = false;
    msg.textContent = `PDF를 만들었어요 (${fmtBytes(pdf.size)}). [PDF 보내기] 또는 [PDF 내려받기]를 누르세요.`;
  } catch (err) {
    mem.print.error = printErrorText(err);
    msg.textContent = mem.print.error;
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    print.busy = false;
    save();
    updatePrint();
  }
}

async function makePng() {
  if (print.busy) return;
  print.busy = true;
  const msg = $('#printMsg');
  msg.textContent = 'PNG를 만드는 중이에요… (몇 초 걸려요)';
  const t0 = performance.now();
  let canvas = null;
  try {
    canvas = makePrintCanvas();
    const png = await canvasToBlob(canvas, 'image/png');
    print.pngBlob = png;
    print.pngName = `평면도_인쇄시험_${fileStamp()}.png`;
    mem.print.png = { at: new Date().toISOString(), ms: Math.round(performance.now() - t0), bytes: png.size, w: canvas.width, h: canvas.height };
    mem.print.error = null;
    $('#pngShare').disabled = false;
    $('#pngDownload').disabled = false;
    const prev = $('#printPreview');
    prev.textContent = '';
    const img = document.createElement('img');
    img.alt = '시험 PNG 미리보기';
    img.src = URL.createObjectURL(png);
    prev.append(img);
    msg.textContent = `PNG를 만들었어요 (${canvas.width}×${canvas.height}px, ${fmtBytes(png.size)}).`;
  } catch (err) {
    mem.print.error = printErrorText(err);
    msg.textContent = mem.print.error;
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    print.busy = false;
    save();
    updatePrint();
  }
}

function shareOrDownload(blob, name, type) {
  const file = new File([blob], name, { type });
  const msg = $('#printMsg');
  if (live.shareApi && safeCanShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).then(
      () => { msg.textContent = '공유 창에서 앱을 골랐어요.'; },
      (err) => {
        if (err && err.name === 'AbortError') msg.textContent = '공유를 취소했어요.';
        else { msg.textContent = `공유가 안 돼서 내려받기로 바꿨어요 (${err && err.name}).`; downloadBlob(blob, name); }
      }
    );
  } else {
    downloadBlob(blob, name);
    msg.textContent = `공유가 안 되는 기기라서 내려받기를 시작했어요: ${name}`;
  }
}

function setupPrint() {
  $('#pdfMake').addEventListener('click', makePdf);
  $('#pngMake').addEventListener('click', makePng);
  $('#pdfShare').addEventListener('click', () => print.pdfBlob && shareOrDownload(print.pdfBlob, print.pdfName, 'application/pdf'));
  $('#pdfDownload').addEventListener('click', () => print.pdfBlob && downloadBlob(print.pdfBlob, print.pdfName));
  $('#pngShare').addEventListener('click', () => print.pngBlob && shareOrDownload(print.pngBlob, print.pngName, 'image/png'));
  $('#pngDownload').addEventListener('click', () => print.pngBlob && downloadBlob(print.pngBlob, print.pngName));
  const sq = $('#measSquare');
  const wall = $('#measWall');
  if (mem.print.measSquare != null) sq.value = mem.print.measSquare;
  if (mem.print.measWall != null) wall.value = mem.print.measWall;
  const onMeas = () => {
    const a = parseFloat(sq.value);
    const b = parseFloat(wall.value);
    mem.print.measSquare = isFinite(a) ? a : null;
    mem.print.measWall = isFinite(b) ? b : null;
    save();
    updatePrint();
  };
  sq.addEventListener('input', onMeas);
  wall.addEventListener('input', onMeas);
  for (const btn of $$('[data-korean]')) {
    btn.addEventListener('click', () => {
      mem.print.korean = btn.dataset.korean === 'yes';
      save();
      updatePrint();
    });
  }
  updatePrint();
}

function updatePrint() {
  const p = mem.print;
  const facts = [];
  if (p.pdf) facts.push(['PDF', `${p.pdf.w}×${p.pdf.h}px, ${fmtBytes(p.pdf.bytes)}, ${(p.pdf.ms / 1000).toFixed(1)}초 (${fmtTime(p.pdf.at)})`]);
  if (p.png) facts.push(['PNG', `${p.png.w}×${p.png.h}px, ${fmtBytes(p.png.bytes)}, ${(p.png.ms / 1000).toFixed(1)}초`]);
  facts.push(['그림 글꼴', p.pdf ? p.pdf.font : usedFont()]);
  if (p.error) facts.push(['오류', p.error]);
  if (p.limit) facts.push(['만들 수 있는 가장 큰 크기', `${p.limit.w}×${p.limit.h}px (약 ${p.limit.dpi}dpi)`]);
  const errSq = p.measSquare != null ? ((p.measSquare - 100) / 100) * 100 : null;
  const errWall = p.measWall != null ? ((p.measWall - 50) / 50) * 100 : null;
  if (errSq != null) facts.push(['잰 사각형 한 변', `${p.measSquare}mm (오차 ${errSq.toFixed(1)}%)`]);
  if (errWall != null) facts.push(['잰 3,000mm 벽(1:60)', `${p.measWall}mm (오차 ${errWall.toFixed(1)}%)`]);
  facts.push(['한글 인쇄 상태', p.korean === true ? '잘 나옴' : p.korean === false ? '깨짐' : '모름']);

  const within = (e) => e != null && Math.abs(e) <= 1.0001;
  let status;
  let verdict;
  if (p.error && !p.pdf && !p.png) {
    status = 'fail';
    verdict = p.error + ' 대책: 출력 해상도를 낮춥니다.';
  } else if ((errSq != null && !within(errSq)) || (errWall != null && !within(errWall))) {
    status = 'fail';
    verdict = "인쇄한 크기가 1%보다 더 달라요. 인쇄할 때 ‘실제 크기(100%)’를 골랐는지 확인하고 다시 인쇄해 주세요.";
  } else if (p.korean === false) {
    status = 'fail';
    verdict = '한글 글자가 깨졌다고 하셨어요. 어떤 모양인지 사진으로 보내 주세요.';
  } else if (within(errSq) && within(errWall)) {
    status = 'ok';
    verdict = '인쇄한 크기가 정확해요(오차 1% 안).' + (p.korean === true ? ' 한글도 잘 나왔어요.' : ' 한글이 잘 나왔는지도 알려 주세요.');
  } else if (p.pdf || p.png) {
    status = 'warn';
    verdict = '시험 파일을 만들었어요. 인쇄해서 자로 잰 값을 아래 칸에 적어 주세요.';
  } else {
    status = 'pending';
    verdict = '아직 시험하지 않았어요. [시험 PDF 만들기]를 눌러 주세요.';
  }
  setResult('print', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// 7. Device info

function detectFonts() {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return [];
  const sample = '한글 가나다 평면도 Habitat mmWWii 0123456789';
  const widthOf = (f) => { ctx.font = `40px ${f}`; return ctx.measureText(sample).width; };
  const bases = ['monospace', 'serif', 'sans-serif'];
  const baseW = bases.map(widthOf);
  return FONT_NAMES.filter((n) => bases.some((b, i) => Math.abs(widthOf(`"${n}", ${b}`) - baseW[i]) > 0.5));
}

function mq(q) {
  return !!(window.matchMedia && window.matchMedia(q).matches);
}

async function setupDevice() {
  live.fonts = detectFonts();
  const dpr = window.devicePixelRatio || 1;
  const pointer = [mq('(pointer: fine)') && 'fine', mq('(pointer: coarse)') && 'coarse'].filter(Boolean).join(', ') || '없음';
  const anyPointer = [mq('(any-pointer: fine)') && 'fine', mq('(any-pointer: coarse)') && 'coarse'].filter(Boolean).join(', ') || '없음';
  const hover = [mq('(hover: hover)') && 'hover', mq('(any-hover: hover)') && 'any-hover'].filter(Boolean).join(', ') || '없음';
  const facts = [
    ['브라우저(UA)', navigator.userAgent],
    ['화면 크기(CSS px)', `${screen.width}×${screen.height}`],
    ['화면 실제 픽셀', `${Math.round(screen.width * dpr)}×${Math.round(screen.height * dpr)}`],
    ['창 크기', `${window.innerWidth}×${window.innerHeight}`],
    ['devicePixelRatio', String(dpr)],
    ['화면 방향', (screen.orientation && screen.orientation.type) || '모름'],
    ['maxTouchPoints', String(navigator.maxTouchPoints)],
    ['pointer', pointer],
    ['any-pointer', anyPointer],
    ['hover', hover],
    ['메모리(대략)', navigator.deviceMemory ? `${navigator.deviceMemory} GB` : '모름'],
    ['CPU 코어', navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : '모름'],
    ['언어', navigator.language || '모름'],
    ['쓸 수 있는 한글 글꼴', live.fonts.length ? live.fonts.join(', ') : '목록의 글꼴 없음(기본 글꼴 사용)'],
  ];
  live.device = facts;
  setResult('device', 'ok', '기기 정보를 모았어요.', facts);
  // Extra detail (model name) where Chrome offers it.
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      const brands = (v.fullVersionList || navigator.userAgentData.brands || [])
        .filter((b) => !/Not.?A.?Brand/i.test(b.brand))
        .map((b) => `${b.brand} ${b.version}`).join(', ');
      facts.splice(1, 0,
        ['기기 모델', v.model || '모름'],
        ['운영체제', `${v.platform || ''} ${v.platformVersion || ''}`.trim() || '모름'],
        ['크롬 버전', brands || '모름']);
      setResult('device', 'ok', '기기 정보를 모았어요.', facts);
    }
  } catch (err) { /* optional */ }
}

// ---------------------------------------------------------------------------------------------
// 8. Sliding door drawing (plan §1-3: proposed shape, confirmed in stage 0)

function drawDoors() {
  const c = $('#doorCanvas');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const panelW = c.width / 3;
  // px per mm: the widest opening (1800 mm) must leave a wall stub on both sides inside its panel.
  const s = (panelW - 40 - 140) / 1800;
  const wallT = 150 * s;
  const wallY = 400; // wall centre line; door leaves swing upwards, labels sit below the wall

  function wallWithOpening(cx, openingMM) {
    const half = (openingMM * s) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - panelW / 2 + 20, wallY - wallT / 2, panelW / 2 - 20 - half, wallT);
    ctx.fillRect(cx + half, wallY - wallT / 2, panelW / 2 - 20 - half, wallT);
    // Frame: grey band across the opening with small squares at both ends (same as the window frame).
    ctx.fillStyle = '#bdbdbd';
    ctx.fillRect(cx - half, wallY - 4, 2 * half, 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - half, wallY - 7, 14, 14);
    ctx.fillRect(cx + half - 14, wallY - 7, 14, 14);
    return half;
  }

  function leaf(x0, x1, y, t) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.fillRect(x0, y - t / 2, x1 - x0, t);
    ctx.strokeRect(x0, y - t / 2, x1 - x0, t);
  }

  function label(cx, text, sub) {
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.font = `bold 34px ${FONT_STACK}`;
    ctx.fillText(text, cx, 480);
    ctx.fillStyle = '#0070C0';
    ctx.font = `26px ${FONT_STACK}`;
    ctx.fillText(sub, cx, 518);
  }

  // Panel 1: swing door (reference).
  let cx = panelW / 2;
  label(cx, '여닫이문 (참고)', 'ABS도어 800*2000');
  let half = wallWithOpening(cx, 800);
  const hinge = { x: cx - half, y: wallY - wallT / 2 };
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(hinge.x, hinge.y);
  ctx.lineTo(hinge.x, hinge.y - 2 * half);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(hinge.x, hinge.y, 2 * half, -Math.PI / 2, 0);
  ctx.stroke();

  // Panel 2: 2-leaf sliding door, leaves on two tracks overlapping in the middle.
  cx = panelW * 1.5;
  label(cx, '미서기문 (제안)', '미서기문 1600*2100');
  half = wallWithOpening(cx, 1600);
  const overlap = 60 * s;
  const leafT = 40 * s;
  leaf(cx - half, cx + overlap, wallY - leafT * 0.55, leafT);
  leaf(cx - overlap, cx + half, wallY + leafT * 0.55, leafT);

  // Panel 3: 3-leaf linked door, three tracks.
  cx = panelW * 2.5;
  label(cx, '3연동 도어 (제안)', '3연동 도어 1800*2100');
  half = wallWithOpening(cx, 1800);
  const third = (2 * half) / 3;
  const t3 = 34 * s;
  leaf(cx - half, cx - half + third + overlap, wallY - t3 * 1.1, t3);
  leaf(cx - half + third - overlap, cx - half + 2 * third + overlap, wallY, t3);
  leaf(cx - half + 2 * third - overlap, cx + half, wallY + t3 * 1.1, t3);

  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  ctx.font = `24px ${FONT_STACK}`;
  ctx.fillText('위에서 내려다본 모양 · 검정 = 벽 · 회색 띠 = 문틀 · 흰 사각형 = 문짝', c.width / 2, c.height - 22);
}

function setupDoor() {
  drawDoors();
  for (const btn of $$('[data-door]')) {
    btn.addEventListener('click', () => {
      mem.door.choice = btn.dataset.door;
      save();
      updateDoor();
    });
  }
  const note = $('#doorNote');
  note.value = mem.door.note || '';
  note.addEventListener('input', () => {
    mem.door.note = note.value.slice(0, 500);
    save();
    updateDoor();
  });
  updateDoor();
}

function updateDoor() {
  const d = mem.door;
  for (const btn of $$('[data-door]')) btn.classList.toggle('chosen', btn.dataset.door === d.choice);
  const facts = [];
  if (d.note) facts.push(['적어 주신 내용', d.note]);
  if (d.choice === 'ok') setResult('door', 'ok', '이 모양이 좋다고 하셨어요. 이대로 그립니다.', facts);
  else if (d.choice === 'change') setResult('door', 'warn', '다르게 그려 달라고 하셨어요. 바꾸고 싶은 점을 아래 칸에 적어 주세요.', facts);
  else setResult('door', 'pending', '아직 고르지 않았어요. 그림을 보고 아래 버튼을 눌러 주세요.', facts);
}

// ---------------------------------------------------------------------------------------------
// 9. Update (plan appendix B "업데이트": the '새 버전' banner and [지금 적용] on the installed app)

async function recordUpdateVersion(which) {
  const v = await swVersion();
  const now = new Date().toISOString();
  if (which === 'first') {
    mem.update.firstVersion = v;
    mem.update.firstAt = now;
    mem.update.laterVersion = null;
    mem.update.laterAt = null;
  } else {
    mem.update.laterVersion = v;
    mem.update.laterAt = now;
  }
  save();
  updateUpdate();
}

function setupUpdate() {
  $('#updateRecord').addEventListener('click', () => recordUpdateVersion('first'));
  $('#updateRecheck').addEventListener('click', () => recordUpdateVersion('later'));
  for (const btn of $$('[data-update-banner]')) {
    btn.addEventListener('click', () => { mem.update.banner = btn.dataset.updateBanner === 'yes'; save(); updateUpdate(); });
  }
  for (const btn of $$('[data-update-kept]')) {
    btn.addEventListener('click', () => { mem.update.kept = btn.dataset.updateKept === 'yes'; save(); updateUpdate(); });
  }
  updateUpdate();
}

function updateUpdate() {
  const u = mem.update;
  for (const btn of $$('[data-update-banner]')) btn.classList.toggle('chosen', u.banner === (btn.dataset.updateBanner === 'yes'));
  for (const btn of $$('[data-update-kept]')) btn.classList.toggle('chosen', u.kept === (btn.dataset.updateKept === 'yes'));
  const changed = u.firstVersion && u.laterVersion ? u.firstVersion !== u.laterVersion : null;
  const facts = [
    ['처음 기록한 버전', u.firstVersion ? `${u.firstVersion} (${fmtTime(u.firstAt)})` : (u.firstAt ? '알 수 없음(오프라인 기능이 아직 없음)' : '-')],
    ['다시 확인한 버전', u.laterVersion ? `${u.laterVersion} (${fmtTime(u.laterAt)})` : (u.laterAt ? '알 수 없음' : '-')],
    ['버전이 바뀜', yesNo(changed)],
    ['새 버전 안내가 뜸', yesNo(u.banner)],
    ['[지금 적용] 뒤 도면 그대로', yesNo(u.kept)],
  ];
  let status = 'pending';
  let verdict = '아직 시험하지 않았어요. 위 순서대로 해 주세요.';
  if (u.banner === false || u.kept === false) {
    status = 'fail';
    verdict = u.kept === false
      ? '업데이트 뒤 도면이 없어졌다고 하셨어요. 바로 개발자에게 알려 주세요.'
      : '새 버전 안내가 뜨지 않았다고 하셨어요. 앱을 완전히 닫았다가 다시 열어 보고, 그래도 안 되면 알려 주세요.';
  } else if (u.banner === true && u.kept === true && changed === true) {
    status = 'ok';
    verdict = `업데이트가 잘 돼요. 버전 ${u.firstVersion} → ${u.laterVersion}, 도면도 그대로 있어요.`;
  } else if (u.banner === true && u.kept === true && changed === false) {
    status = 'warn';
    verdict = '안내는 떴지만 버전 번호가 그대로예요. 앱에서 [지금 적용]을 누른 뒤 이 페이지를 새로고침하고 [버전 다시 확인]을 눌러 주세요.';
  } else if (u.firstAt || u.banner != null || u.kept != null) {
    status = 'warn';
    verdict = '시험 중이에요. 나머지 순서를 해 주세요.';
  }
  setResult('update', status, verdict, facts);
}

// ---------------------------------------------------------------------------------------------
// Summary, copy, share, reset

function buildSummary() {
  const lines = [];
  lines.push('[평면도 앱 0단계 기기 시험 결과]');
  lines.push(`보낸 시각: ${fmtTime(new Date().toISOString())} · 시험 페이지 v${DEVTEST_VERSION}`);
  lines.push(`주소: ${location.origin}${location.pathname}`);
  lines.push('');
  TESTS.forEach((t, i) => {
    const r = results[t.id];
    if (!r) return;
    lines.push(`${i + 1}. ${t.title} ${ICON[r.status]} ${r.verdict}`);
    for (const [label, value] of r.facts) lines.push(`   - ${label}: ${value}`);
    lines.push('');
  });
  if (mem.errors.length) {
    lines.push('페이지 오류:');
    for (const e of mem.errors) lines.push(`   - ${e}`);
  }
  return lines.join('\n');
}

function showFallback(text) {
  const box = $('#copyFallbackBox');
  const ta = $('#copyFallback');
  ta.value = text;
  box.hidden = false;
  ta.focus();
  ta.select();
}

async function copyResults() {
  const text = buildSummary();
  const msg = $('#copyMsg');
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    msg.textContent = '복사됐어요! 카톡이나 메일의 입력 칸을 길게 눌러 [붙여넣기] 해 주세요.';
    $('#copyFallbackBox').hidden = true;
    return;
  } catch (err) {
    // Fall through to the older copy command, then to manual selection.
  }
  showFallback(text);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  msg.textContent = ok
    ? '복사됐어요! 카톡이나 메일의 입력 칸을 길게 눌러 [붙여넣기] 해 주세요.'
    : '자동 복사가 안 돼요. 아래 글을 길게 눌러 전체 선택 → 복사해 주세요.';
}

function shareResults() {
  const text = buildSummary();
  if (live.shareApi) {
    navigator.share({ title: '평면도 앱 기기 시험 결과', text }).catch((err) => {
      if (!err || err.name !== 'AbortError') copyResults();
    });
  } else {
    copyResults();
  }
}

function setupTop() {
  $('#copyBtn').addEventListener('click', copyResults);
  $('#shareResultBtn').addEventListener('click', shareResults);
  $('#resetBtn').addEventListener('click', () => {
    if (!window.confirm('지금까지의 시험 결과를 모두 지우고 처음부터 다시 할까요?')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
    location.reload();
  });
}

// ---------------------------------------------------------------------------------------------
// Headless self-test (?selftest): runs the parts that need no tapping and writes JSON to #selftest.

async function runSelfTest() {
  // Headless Chrome with --virtual-time-budget skips idle time, while canvas encoding and blob reads
  // finish on other threads in real time. Burn a little CPU on each tick so they can complete.
  let running = true;
  (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 5));
      let x = 0;
      for (let i = 0; i < 3e6; i++) x += i;
      if (x < 0) console.log(x);
    }
  })();
  const out = {};
  try {
    await runStorageTest();
    out.storage = mem.storage;
    await makePdf();
    out.pdf = mem.print.pdf;
    await makePng();
    out.png = mem.print.png;
    out.printError = mem.print.error;
    out.summaryLines = buildSummary().split('\n').length;
    out.statuses = Object.fromEntries(TESTS.map((t) => [t.id, results[t.id] && results[t.id].status]));
    if (params.has('dump') && print.pdfBlob) {
      const bytes = new Uint8Array(await print.pdfBlob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      out.pdfBase64 = btoa(s);
    }
  } catch (err) {
    out.error = errText(err);
  }
  running = false;
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.textContent = JSON.stringify(out);
  document.body.append(pre);
}

// ---------------------------------------------------------------------------------------------

function init() {
  renderOverview();
  setupTop();
  setupDevice(); // first: the print test uses the detected font list
  setupPen();
  setupShare();
  setupFile();
  setupStorage();
  setupInstall();
  setupPrint();
  setupDoor();
  setupUpdate();
  if (SELFTEST) runSelfTest();
}

init();
