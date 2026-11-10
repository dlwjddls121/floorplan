// The bundled output font (ui/theme.js PAPER_FONT_FAMILY / PAPER_FONT_STACK; user 2026-11-01, option 1).
//
// Every output (paper / PDF / PNG / JPG of every 종류, turned or not, and the preview in the 출력 dialog)
// writes its texts in Noto Sans KR from app/fonts/, so the PC and the Galaxy Tab measure and draw the
// same texts the same way and put them in the same spots. The screen keeps its own fonts (FONT_STACK).
//
//   PAPER_FONT_FILE            the font file in app/fonts/: the ONE place its name is written (sw.js and
//                              dev/build_sw_list.ps1 take every font file in fonts/ by itself)
//   PAPER_FONT_TIMEOUT_MS      how long an output waits for the font before it is made with FONT_STACK
//   paperFontReady()           → true once the font is in document.fonts (canvas texts then use it)
//   paperFontState()           → 'idle' | 'loading' | 'ready' | 'failed'
//   paperFontEpoch()           → a number that changes when the font arrives (caches of measured widths)
//   loadPaperFont({ retry })   → Promise<boolean>: starts the load once and shares it; after a failure
//                                only with retry (an output asks again; a preview does not, at every tap)
//   ensurePaperFont(ms)        → Promise<boolean>: before an output (each export): true = loaded; false =
//                                it failed or took longer than ms, and the output uses FONT_STACK
//   onPaperFontReady(fn)       → unsubscribe; fn() once when the font arrives (a preview drawn before it
//                                is drawn again)
//   preloadPaperFont({ waitForWorker, delayMs })  the background load soon after the app has started
//   paperTextWidth(text, px, weight)  → the width of a paper text in this font (round 5, below) | null
//
// The font is added to document.fonts only once it has loaded, so a text is never drawn while it is
// half there: before that every paper text falls back to FONT_STACK (the family name is installed on
// no device). Bold comes from the variable font's wght axis (weight '100 900').

import { PAPER_FONT_FAMILY } from './theme.js';

// The font file under app/fonts/ (any name; .woff2 / .woff / .ttf / .otf). To use another file, put it in
// app/fonts/, change this name, delete the old file and run dev/build_sw_list.ps1.
// Since round 4 (user 2026-11-01): a woff2 subset of Noto Sans KR 2.004 (C:\Windows\Fonts\NotoSansKR-VF.ttf,
// 10.4 MB) made with fontTools.subset, 1.4 MB: all 11,172 Hangul syllables, the jamo, ASCII, Latin-1, Greek,
// punctuation, arrows, math, enclosed digits, box / geometric shapes, dingbats, CJK symbols, ㎡-type units and
// full-width forms, with the wght axis (100–900), every kept character as wide as in the full font. Hanja,
// kana etc. are left out: such a character typed by a user is drawn in the device's font, that character only.
export const PAPER_FONT_FILE = 'NotoSansKR-VF-subset.woff2';
export const PAPER_FONT_URL = new URL(`../../fonts/${PAPER_FONT_FILE}`, import.meta.url).href;

// An output waits this long at most (the 4 GB tablet reads the 1.4 MB file from the offline cache in well
// under a second; over mobile data on a first visit it can take longer: then the file is made with the
// device's fonts, and the next one with the bundled font once it is there).
export const PAPER_FONT_TIMEOUT_MS = 10000;
// The background load: this long after the app has started, when the page is idle.
const PRELOAD_DELAY_MS = 2000;
// First visit: the service worker downloads the font for the offline cache itself; the page waits until
// the worker controls it (then its request is served from that cache), at most this long.
const PRELOAD_WORKER_WAIT_MS = 60000;

const env = { url: PAPER_FONT_URL, FontFace: null, fonts: null };
let state = 'idle';
let loading = null;
let token = 0;          // the load in flight (a reset makes an older one count for nothing)
let added = null;       // { face, set }: the face this module put into the font set
let epoch = 0;
let preloadStarted = false;
const listeners = new Set();

function fontFaceClass() {
  if (env.FontFace) return env.FontFace;
  return typeof FontFace === 'function' ? FontFace : null;
}
function fontSet() {
  if (env.fonts) return env.fonts;
  return typeof document !== 'undefined' && document.fonts ? document.fonts : null;
}

export function paperFontReady() { return state === 'ready'; }
export function paperFontState() { return state; }
export function paperFontEpoch() { return epoch; }

export function loadPaperFont({ retry = false } = {}) {
  if (state === 'ready') return Promise.resolve(true);
  if (state === 'loading') return loading;
  if (state === 'failed' && !retry) return loading || Promise.resolve(false);
  const Face = fontFaceClass();
  const set = fontSet();
  if (!Face || !set || typeof set.add !== 'function') {
    state = 'failed';
    loading = Promise.resolve(false);
    return loading;
  }
  state = 'loading';
  const my = ++token;
  loading = (async () => {
    try {
      const face = new Face(PAPER_FONT_FAMILY, `url("${env.url}")`, { weight: '100 900', style: 'normal' });
      const loaded = (await face.load()) || face;
      if (my !== token) return false;   // reset meanwhile (tests)
      set.add(loaded);
      added = { face: loaded, set };
      state = 'ready';
      epoch++;
      for (const fn of [...listeners]) {
        listeners.delete(fn);
        try { fn(); } catch (err) { console.error('[paperfont] listener failed', err); }
      }
      return true;
    } catch (err) {
      if (my !== token) return false;
      console.warn('[paperfont] the output font could not be loaded; outputs use the device fonts', err);
      state = 'failed';
      return false;
    }
  })();
  return loading;
}

export async function ensurePaperFont(timeoutMs = PAPER_FONT_TIMEOUT_MS) {
  if (state === 'ready') return true;
  const p = loadPaperFont({ retry: true });
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

// Round 5 (the manager's real tablet, 11-08): the same font measured by ctx.measureText came out about 1 px at 300 dpi
// (0.1–0.8 % of a text's width) apart on the Galaxy Tab and the PC, and where a spot was a near tie (A5 turned,
// 치수선 없이: the 현관's name 6.8 pt over the 신발장 on the tablet, 12.3 pt off it on the PC) the two devices wrote the same
// household differently. The outputs' layouts therefore never ask the device for a text's width: it is the sum of the
// font's own advance widths (hmtx of NotoSansKR-VF-subset.woff2, SHA-256 60604f8e…, instanced by fontTools at wght
// 400 and 700, per 1000 units of the font size), the same on every device. (The drawing itself is the device's; a
// text measured so differs from the drawn one by the font's kerning: none for the Korean texts and digits, up to about
// 0.3 % where Latin pairs are kerned ('PV', 'AB': 'PVC이중창 600*650', 'ABS도어 700*2000'), the box that much wider.)
// PAPER_FONT_ADVANCES: per weight, runs of code points (hex, 'a-b') with their advance (units per em 1000). After
// changing PAPER_FONT_FILE, make them again from the new file (fontTools: varLib.instancer at wght 400 / 700, hmtx).
export const PAPER_FONT_ADVANCES = {
  400: [
    '20:224 21:323 22:474 23-24:555 25:921 26:680 27:278 28-29:338 2a:467 2b:555 2c:278 2d:347 2e:278 2f:392',
    '30-39:555 3a-3b:278 3c-3e:555 3f:474 40:946 41:608 42:657 43:638 44:688 45:589 46:552 47:689 48:728 49:293',
    '4a:535 4b:646 4c:543 4d:812 4e:723 4f:742 50:633 51:742 52:635 53:596 54:599 55:721 56:575 57:878 58:573',
    '59:531 5a:603 5b:338 5c:392 5d:338 5e:555 5f:559 60:606 61:563 62:618 63:510 64:620 65:554 66:325 67:564',
    '68:607 69-6a:275 6b:552 6c:284 6d:926 6e:610 6f:606 70-71:620 72:388 73:468 74:377 75:607 76:521 77:802 78:498',
    '79:521 7a:475 7b:338 7c:270 7d:338 7e:555 a0:224 a1:323 a2-a5:555 a6:270 a7:1000 a8:606 a9:832 aa:386 ab:479',
    'ac:555 ad:347 ae:473 af:606 b0:370 b1:1000 b2-b3:411 b4:606 b5:628 b6:1000 b7:561 b8:606 b9:411 ba:407 bb:479',
    'bc:873 bd:903 be:889 bf:474 c0-c5:608 c6:918 c7:638 c8-cb:589 cc-cf:293 d0:712 d1:723 d2-d6:742 d7:1000 d8:742',
    'd9-dc:721 dd:531 de:652 df:643 e0-e5:563 e6:877 e7:510 e8-eb:554 ec-ef:275 f0:608 f1:610 f2-f6:606 f7:1000',
    'f8:606 f9-fc:607 fd:521 fe:620 ff:521 391:608 392:657 393:557 394:656 395:589 396:603 397:728 398:742 399:293',
    '39a:646 39b:575 39c:812 39d:723 39e:595 39f:742 3a0:721 3a1:633 3a3:601 3a4:599 3a5:531 3a6:803 3a7:573',
    '3a8:780 3a9:758 3b1:625 3b2:631 3b3:540 3b4:594 3b5:501 3b6:473 3b7:604 3b8:583 3b9:292 3ba:551 3bb:552',
    '3bc:628 3bd:528 3be:481 3bf:597 3c0:654 3c1:613 3c2:483 3c3:609 3c4:514 3c5:569 3c6:760 3c7:536 3c8:769',
    '3c9:782 1100-11ff:920 2002:500 2003:1000 2010:1000 2011:347 2012-2013:536 2014:894 2015-2016:1000',
    '2018-201a:278 201c-201e:474 2020-2021:1000 2022:340 2025-2027:1000 2030:1000 2032:278 2033:474 2035:1000',
    '2039-203a:302 203b:1000 203c:613 2042:1000 2047:910 2048-2049:758 2051:1000 2074:411 20a9:555 20ab-20ac:555',
    '2100:1000 2103:1000 2105:1000 2109-210a:1000 210f:1000 2113:457 2116:997 2121:1000 2122:711 2126-2127:1000',
    '212b:1000 212e:894 2135:1000 213b:1000 2160-216b:1000 2170-217b:1000 2190-2199:1000 21b8-21b9:1000',
    '21c4-21c6:1000 21cb-21cc:1000 21d0:1000 21d2:1000 21d4:1000 21e6-21e9:1000 21f5:1000 2200:1000 2202-2203:1000',
    '2205-220b:1000 220f:1000 2211:1000 2212:555 2213:1000 2215:1000 221a:1000 221d-2220:1000 2223:1000',
    '2225-222e:1000 2234-2237:1000 223d:1000 2243:1000 2245:1000 2248:1000 224c:1000 2260-2262:1000 2264-2267:1000',
    '226a-226b:1000 226e-226f:1000 2272-2273:1000 2276-2277:1000 2282-2287:1000 228a-228b:1000 2295-2299:1000',
    '22a0:1000 22a5:1000 22bf:1000 22da-22db:1000 22ef:1000 2305-2307:1000 2312:1000 2318:1000 2329-232a:1000',
    '23b0-23b1:1000 23be-23cc:1000 23ce:1000 23da-23db:1000 2460-25ab:1000 25b1-25b3:1000 25b6-25b7:1000',
    '25bc-25bd:1000 25c0-25c1:1000 25c6-25c7:1000 25c9-25cc:1000 25ce-25d3:1000 25e2-25e6:1000 25ef:1000',
    '2600-2603:1000 2605-2606:1000 2609:1000 260e-260f:1000 2616-2617:1000 261c-261f:1000 262f:1000 2640-2642:1000',
    '2660-266f:1000 2672-267d:1000 26a0:1000 26bd-26be:1000 2702:1000 2713:683 271a:1000 273d:1000 273f-2740:1000',
    '2756:1000 2776-2793:1000 27a1:1000 3000-3029:1000 302a-302d:0 302e-302f:250 3030-303f:1000 3131-318e:920',
    '3200-321e:1000 3220-332b:1000 332d-33ff:1000 ac00-d7a3:920 ff01-ff60:1000 ff61-ff9f:500 ffa0-ffbe:920',
    'ffc2-ffc7:920 ffca-ffcf:920 ffd2-ffd7:920 ffda-ffdc:920 ffe0-ffe6:1000 ffe8-ffee:500',
  ].join(' '),
  700: [
    '20:227 21:370 22:574 23-24:590 25:963 26:740 27:325 28-29:378 2a:507 2b:590 2c:325 2d:370 2e:325 2f:387',
    '30-39:590 3a-3b:325 3c-3e:590 3f:514 40:1007 41:641 42:681 43:656 44:714 45:615 46:585 47:717 48:757 49:330',
    '4a:568 4b:686 4c:578 4d:853 4e:749 4f:770 50:667 51:770 52:682 53:624 54:625 55:748 56:619 57:915 58:627',
    '59:580 5a:613 5b:378 5c:387 5d:378 5e:590 5f:567 60:626 61:591 62:644 63:527 64:644 65:581 66:372 67:597',
    '68:640 69:304 6a:306 6b:604 6c:315 6d:964 6e:641 6f:626 70-71:644 72:437 73:495 74:421 75:637 76:576 77:863',
    '78:562 79:574 7a:511 7b:378 7c:296 7d:378 7e:590 a0:227 a1:370 a2-a5:590 a6:296 a7:1000 a8:626 a9:849 aa:403',
    'ab:529 ac:590 ad:370 ae:513 af:626 b0:404 b1:1000 b2-b3:424 b4:626 b5:664 b6:1000 b7:592 b8:626 b9:424 ba:420',
    'bb:529 bc:909 bd:948 be:921 bf:514 c0-c5:641 c6:951 c7:656 c8-cb:615 cc-cf:330 d0:742 d1:749 d2-d6:770 d7:1000',
    'd8:770 d9-dc:748 dd:580 de:690 df:700 e0-e5:591 e6:891 e7:527 e8-eb:581 ec-ef:304 f0:630 f1:641 f2-f6:626',
    'f7:1000 f8:626 f9-fc:637 fd:574 fe:644 ff:574 391:641 392:681 393:584 394:710 395:615 396:613 397:757 398:770',
    '399:330 39a:686 39b:619 39c:853 39d:749 39e:636 39f:770 3a0:747 3a1:667 3a3:619 3a4:625 3a5:580 3a6:850',
    '3a7:627 3a8:836 3a9:797 3b1:663 3b2:670 3b3:589 3b4:616 3b5:528 3b6:515 3b7:631 3b8:615 3b9:329 3ba:604',
    '3bb:608 3bc:664 3bd:577 3be:521 3bf:621 3c0:705 3c1:639 3c2:502 3c3:642 3c4:548 3c5:596 3c6:819 3c7:583',
    '3c8-3c9:833 1100-11ff:920 2002:500 2003:1000 2010:1000 2011:370 2012-2013:544 2014:908 2015-2016:1000',
    '2018-201a:325 201c-201e:574 2020-2021:1000 2022:378 2025-2027:1000 2030:1000 2032:325 2033:574 2035:1000',
    '2039-203a:324 203b:1000 203c:677 2042:1000 2047:973 2048-2049:830 2051:1000 2074:424 20a9:590 20ab-20ac:590',
    '2100:1000 2103:1000 2105:1000 2109-210a:1000 210f:1000 2113:514 2116:1074 2121:1000 2122:760 2126-2127:1000',
    '212b:1000 212e:908 2135:1000 213b:1000 2160-216b:1000 2170-217b:1000 2190-2199:1000 21b8-21b9:1000',
    '21c4-21c6:1000 21cb-21cc:1000 21d0:1000 21d2:1000 21d4:1000 21e6-21e9:1000 21f5:1000 2200:1000 2202-2203:1000',
    '2205-220b:1000 220f:1000 2211:1000 2212:590 2213:1000 2215:1000 221a:1000 221d-2220:1000 2223:1000',
    '2225-222e:1000 2234-2237:1000 223d:1000 2243:1000 2245:1000 2248:1000 224c:1000 2260-2262:1000 2264-2267:1000',
    '226a-226b:1000 226e-226f:1000 2272-2273:1000 2276-2277:1000 2282-2287:1000 228a-228b:1000 2295-2299:1000',
    '22a0:1000 22a5:1000 22bf:1000 22da-22db:1000 22ef:1000 2305-2307:1000 2312:1000 2318:1000 2329-232a:1000',
    '23b0-23b1:1000 23be-23cc:1000 23ce:1000 23da-23db:1000 2460-25ab:1000 25b1-25b3:1000 25b6-25b7:1000',
    '25bc-25bd:1000 25c0-25c1:1000 25c6-25c7:1000 25c9-25cc:1000 25ce-25d3:1000 25e2-25e6:1000 25ef:1000',
    '2600-2603:1000 2605-2606:1000 2609:1000 260e-260f:1000 2616-2617:1000 261c-261f:1000 262f:1000 2640-2642:1000',
    '2660-266f:1000 2672-267d:1000 26a0:1000 26bd-26be:1000 2702:1000 2713:723 271a:1000 273d:1000 273f-2740:1000',
    '2756:1000 2776-2793:1000 27a1:1000 3000-3029:1000 302a-302d:0 302e-302f:250 3030-303f:1000 3131-318e:920',
    '3200-321e:1000 3220-332b:1000 332d-33ff:1000 ac00-d7a3:920 ff01-ff60:1000 ff61-ff9f:500 ffa0-ffbe:920',
    'ffc2-ffc7:920 ffca-ffcf:920 ffd2-ffd7:920 ffda-ffdc:920 ffe0-ffe6:1000 ffe8-ffee:500',
  ].join(' '),

};
const ADVANCE_RUNS = {};
function advanceRuns(weight) {
  if (!ADVANCE_RUNS[weight]) {
    const starts = [], ends = [], advs = [];
    for (const tok of String(PAPER_FONT_ADVANCES[weight] || '').split(' ')) {
      const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?:(\d+)$/.exec(tok);
      if (!m) continue;
      starts.push(parseInt(m[1], 16));
      ends.push(parseInt(m[2] || m[1], 16));
      advs.push(Number(m[3]));
    }
    ADVANCE_RUNS[weight] = { starts, ends, advs };
  }
  return ADVANCE_RUNS[weight];
}
// The advance of code point cp (units per 1000 em) at weight 400 / 700; null when the font has no such character.
export function paperAdvance(cp, weight = 400) {
  const r = advanceRuns(weight);
  let lo = 0, hi = r.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r.starts[mid]) hi = mid - 1;
    else if (cp > r.ends[mid]) lo = mid + 1;
    else return r.advs[mid];
  }
  return null;
}
// The width of `text` written in the output font at `px` (CSS px, or pt under a scaled context: the unit of px) and
// weight ('normal' / 'bold', or 400 / 700): the sum of its characters' advances. null while the font is not in use
// (an output made with the device's fonts measures with them) or when a character is not in the font (it is drawn in
// a device font: that text is measured by the device).
// (paperWidthStats.count: the texts measured so, for the tests: a preview shown again measures none.)
export const paperWidthStats = { count: 0 };
export function paperTextWidth(text, px, weight = 'normal') {
  if (state !== 'ready' || !(px > 0)) return null;
  paperWidthStats.count++;
  const w = weight === 'bold' || weight === 700 || weight === '700' ? 700 : weight === 'normal' || weight === 400 || weight === '400' ? 400 : 0;
  if (!w) return null;
  let sum = 0;
  for (const ch of String(text)) {
    const a = paperAdvance(ch.codePointAt(0), w);
    if (a == null) return null;
    sum += a;
  }
  return (sum * px) / 1000;
}

export function onPaperFontReady(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// waitForWorker: the page registered the service worker and is not controlled by it yet (a first visit).
export function preloadPaperFont({ waitForWorker = false, delayMs = PRELOAD_DELAY_MS } = {}) {
  if (preloadStarted) return;
  preloadStarted = true;
  const go = () => { if (state === 'idle') loadPaperFont(); };
  const whenIdle = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 3000 });
    else go();
  };
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (waitForWorker && sw && !sw.controller) {
    let done = false;
    const once = () => { if (done) return; done = true; clearTimeout(t); setTimeout(whenIdle, delayMs); };
    const t = setTimeout(once, PRELOAD_WORKER_WAIT_MS);
    sw.addEventListener('controllerchange', once, { once: true });
  } else {
    setTimeout(whenIdle, delayMs);
  }
}

// Tests: start again from 'idle', optionally with another font URL, FontFace class or font set (a URL that
// fails, a FontFace that rejects). The face loaded before is taken out of its font set again (so the
// outputs really fall back), and a load still in flight from before counts for nothing.
export function resetPaperFontForTest({ url = PAPER_FONT_URL, FontFace: Face = null, fonts = null } = {}) {
  if (added) {
    try { added.set.delete(added.face); } catch (_) { /* not there */ }
    added = null;
  }
  env.url = url;
  env.FontFace = Face;
  env.fonts = fonts;
  state = 'idle';
  loading = null;
  token++;
  epoch++;
  preloadStarted = false;
  listeners.clear();
}
