// Joins the stage B/C/D packages that only know each other through hooks and registries:
//   - core/labels.js labelHooks   (texts and anchors of window/door and fixture labels on paper)
//   - ui/output.js paperDrawers   (openings, fixtures, 실 아님 spaces and the memo on paper)
//   - core/checks-full.js         (확인 완료 store commands; the exact span of each window/door)
//   - core/labels.js              (texts moved by hand: moveLabel / resetLabel store commands)
//   - core/rotate.js              (도면 돌리기 followers: 확인 완료 marks, moved texts at the new scale)
//   - DocStore.deriveHooks        (texts moved by hand follow the plan when values reshape it)
//   - DocStore.openHooks, io/fileio.js writeHooks (the file records the print scale of the texts moved by
//                                  hand and the version whose solve its corners are: core/model.js FILE_RECORDS)
// main.js calls wirePackages() once at start-up; test and sample pages that render paper output
// without the app shell call it too. It is safe to call more than once.
import { DocStore, savedWithRecord, fileRecordKey } from '../core/model.js';
import { writeHooks } from '../io/fileio.js';
import { installChecks, carryResolvedChecks, runChecks, notesForPrint } from '../core/checks-full.js';
import { scaleLabelOffsets, rotationOf } from '../core/rotate.js';
import { computePrintLayout, PAPER_STYLE, PT_MM } from '../core/printlayout.js';
import { convexOverlap, boxPoints } from '../core/dims.js';
import { labelOf, displayName, placeOpening, nominalWidth, slidingLeaves } from '../core/openings.js';
// A namespace import: fixtureGlyphBoxes (the sink basin, removed by the 2026-10-17 request) and
// fixtureWallCutouts (벽 속에 넣기) may or may not exist in the fixtures package; a missing named
// import would stop the whole app from loading.
import * as FX from '../core/fixtures.js';
import { labelHooks, installLabelCommands, followMovedLabels, turnMovedRoomLabels, placeLabels, fixtureObstacles } from '../core/labels.js';
import { drawOpenings, doorSwing } from './draw-openings.js';
import { drawFixtures, drawNotRoomSpaces } from './draw-fixtures.js';
import { drawMemo } from './memo-ui.js';
import { registerPaperDrawers, notesForChoices, DEFAULT_CHOICES, printsMemo } from './output.js';

// Where a window or door sits on its wall, for the checks (wider than its wall, overlapping): the
// measured (or drawn) width around the opening's centre, in mm from the wall's node a, and the clear
// length of the wall piece placeOpening fits it into (a wider opening is drawn clipped to that).
// widthSource says where that width comes from: 'width' (규격 typed), 'drawWidth' (drawn width chosen
// by the surveyor) or 'default' (the type's default drawn width, nobody chose it).
export function openingSpan(project, o, derived) {
  const pl = placeOpening(project, derived, o);
  if (!pl) return null;
  const w = nominalWidth(o);
  const positive = (v) => typeof v === 'number' && isFinite(v) && v > 0;
  const widthSource = positive(o.width) ? 'width' : positive(o.drawWidth) ? 'drawWidth' : 'default';
  return { edgeId: o.edge, start: pl.c - w / 2, end: pl.c + w / 2, available: pl.frame.hi - pl.frame.lo, widthSource };
}

// Label of a window or door in check messages and ※ notes: the printed label ('PVC단창 1200*1000'),
// or the type name when there is no size yet ('목문').
export function openingCheckLabel(o) {
  return labelOf(o) || displayName(o);
}

// Options for runChecks / store.checkItems. One object, so the per-snapshot cache is reused.
export const CHECK_OPTIONS = Object.freeze({ openingSpan, openingLabel: openingCheckLabel });

let wired = false;

export function wirePackages() {
  if (wired) return;
  wired = true;
  // checks-full.js imports model.js, so its store commands are installed here, not in model.js.
  installChecks(DocStore);
  // Texts moved by hand (plan §2-7): store.moveLabel / resetLabel (one undo step each).
  installLabelCommands(DocStore);
  labelHooks.labelOf = (o) => labelOf(o);
  labelHooks.fixtureLabel = (f) => FX.fixtureLabel(FX.normalizeFixture(f));
  // The real position of an opening (anchored openings sit flush with a wall end, not at t), whether
  // it is a sliding door, and the swing of a hinged door as draw-openings.js draws it: its label sits
  // just beyond the arc on the side the door opens into, right at the wall face everywhere else
  // (core/labels.js, user 2026-10-24).
  labelHooks.openingAnchor = (o, project, derived) => {
    const pl = placeOpening(project, derived, o);
    if (!pl) return null;
    const isDoor = o.kind === 'door';
    const sliding = isDoor && slidingLeaves(o) > 0;
    return {
      point: pl.center, dir: pl.frame.dir, edgeId: o.edge, width: pl.w, isDoor, sliding,
      swing: isDoor && !sliding ? doorSwing(o, pl) : null,
    };
  };
  // Fixtures store their centre (x, y) and a rotation; the label box is their axis-aligned extent,
  // minus the symbols drawn inside (the sink basin), which the label keeps clear of.
  labelHooks.fixtureBox = (f) => {
    const n = FX.normalizeFixture(f);
    if (!n) return null;
    const b = FX.fixtureBounds(n);
    const avoid = typeof FX.fixtureGlyphBoxes === 'function' ? FX.fixtureGlyphBoxes(n) : [];
    return { center: { x: n.x, y: n.y }, w: b.maxX - b.minX, h: b.maxY - b.minY, avoid };
  };
  // drawOpenings erases its own wall gap (white), so no opening cutouts are registered. Fixtures put
  // into a wall (벽 속에 넣기) cut the wall band like an opening: output.js clears these polygons white
  // right after the walls (also in 그림만), and the fixture is drawn over them.
  registerPaperDrawers({ drawOpenings, drawFixtures, drawNotRoomSpaces, drawMemo, wallCutouts });
  // 도면 돌리기 (core/rotate.js), right after each turn of a state (the plan's, and lazily each snapshot
  // of the undo / redo history, turned about the same centre: `turn` is the rotationOf result used):
  //   - a 확인 완료 follows its item (keys hold directions and positions that a turn changes);
  //   - texts moved by hand keep their place on the plan: their offsets are paper mm at the automatic
  //     print scale, which a turn can change (a wide plan on A4 portrait may need 1:75 instead of 1:60);
  //   - a room name moved by hand stays at its turned world spot (old label point + offset × old scale,
  //     turned with the plan): its offset is written again from the room's NEW label point at the new
  //     scale (labels.js turnMovedRoomLabels). Turning the offset vector alone moved the name with the
  //     label point, which can jump about 1 m on an L-shaped room (예시 세대 A 거실 ended outside its room).
  if (Array.isArray(DocStore.rotateFollowers)) {
    DocStore.rotateFollowers.push((before, after) => carryResolvedChecks(before, after, CHECK_OPTIONS));
    DocStore.rotateFollowers.push((before, after, dir, turn) => turnedLabelOffsets(before, after, dir, turn));
  }
  // Values (or a dragged corner) reshape the plan: texts moved by hand keep their place on it.
  if (Array.isArray(DocStore.deriveHooks) && !DocStore.deriveHooks.includes(movedLabelsDeriveHook)) {
    DocStore.deriveHooks.push(movedLabelsDeriveHook);
  }
  // A household opened where its automatic print scale is not the one its file was saved at (another
  // version, another font): texts moved by hand keep their place on the plan (labelScale, below).
  if (Array.isArray(DocStore.openHooks) && !DocStore.openHooks.includes(movedLabelsOpenHook)) {
    DocStore.openHooks.push(movedLabelsOpenHook);
  }
  // Every write of a household open in the editor (a file, the copy on the device) carries those records.
  writeHooks.stamp = stampFile;
}

// ---- the file's records (core/model.js FILE_RECORDS) -------------------------------------------------
// Texts moved by hand keep their offsets in paper mm at the automatic print scale of the household
// (core/labels.js). That scale was not in the file: where another version (a new font, a fix of the print
// layout) or a changed shape gives the household another automatic scale, every moved text landed elsewhere,
// 94–188 mm on the 0.6.8.1 files whose scale is not the same now (r4b upgrade check, KNOWN moved-text-scale).
// So the file says the scale its offsets were written at (labelScale: { scale, key }), and an opening at
// another scale converts them (the same spots on the plan). key = the offsets it belongs to: 0.6.8.1 keeps
// the record unread and writes it back, and when texts were moved there (or followed a value there) the key
// no longer matches and the record is not used (the offsets are then read as before: at the automatic scale).
// A file without the record (0.6.8.1, older) opens as before.

// The offsets that depend on the print scale (all but the title's: core/rotate.js scaleLabelOffsets). → keys
function scaledOffsetKeys(offsets) {
  return Object.keys(offsets || {}).filter((k) => k !== 'title' && offsets[k]);
}
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};
// The key of a household's offsets (labelScale.key). → 16 hex digits
export function offsetsKey(offsets) {
  return fileRecordKey(scaledOffsetKeys(offsets).sort().map((k) => `${JSON.stringify(k)}=${canonical(offsets[k])}`).join(';'));
}
// The labelScale record of a household whose offsets are written at print scale 1:`scale`.
export function labelScaleRecord(project, scale) {
  return { scale, key: offsetsKey(project && project.labelOffsets) };
}
// The scale a file says its offsets were written at, when the record belongs to them. → number | 0
export function fileLabelScale(project) {
  const r = project && project.labelScale;
  if (!r || typeof r !== 'object' || !(typeof r.scale === 'number' && isFinite(r.scale) && r.scale > 0)) return 0;
  if (!scaledOffsetKeys(project.labelOffsets).length || r.key !== offsetsKey(project.labelOffsets)) return 0;
  return r.scale;
}

// io/fileio.js writeHooks.stamp: the household as it is written. Only a household open in the editor gets the
// records (its derived snapshot is known: DocStore.derivedOf); any other copy (an import, a copy in the list)
// is written as it came, with the records it carries. labelScale is the scale the editor shows the moved texts
// at (main.js printScale: the automatic print scale of the household as it is now). opts.quick (the write as a
// page goes away, storage.saveProjectNow): labelScale only when that scale is known already; without it the
// copy opens as one written before round 5 would, and the normal save that follows writes it. → project
export function stampFile(project, opts = {}) {
  const derived = DocStore.derivedOf(project);
  if (!derived) return project;
  const out = { ...project, savedWith: savedWithRecord(project, derived) };
  delete out.labelScale;
  if (scaledOffsetKeys(project.labelOffsets).length) {
    const s = stampScale({ project, derived }, !!(opts && opts.quick));
    if (s > 0) out.labelScale = labelScaleRecord(project, s);
  }
  return out;
}
// autoPrintScale for stampFile, remembered per derived snapshot while nothing in the household but its times
// changed (an autosave after a turn of the 메모 숨기기 switch, an export after the autosave). → number | 0
const stampCache = new WeakMap();   // derived → { project, scale }
const TIMES = new Set(['modifiedAt', 'exportedAt']);
function sameBesideTimes(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a).filter((k) => !TIMES.has(k)), kb = Object.keys(b).filter((k) => !TIMES.has(k));
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}
function stampScale(state, knownOnly = false) {
  const hit = stampCache.get(state.derived);
  if (hit && sameBesideTimes(hit.project, state.project)) return hit.scale;
  if (knownOnly) return 0;
  const scale = autoPrintScale(state);
  stampCache.set(state.derived, { project: state.project, scale });
  return scale;
}

// DocStore.openHooks: a household opened as stored (no derive hooks ran) whose file says its moved texts were
// written at another print scale than the one it has here: the offsets are converted so that every text stays
// where it was on the plan (the scale taken again until it holds, as after a turn). → project | null
export function movedLabelsOpenHook(file, state) {
  const k = fileLabelScale(file);
  if (!k || !state || !state.project || !state.derived) return null;
  const s = cachedPrintScale(state);
  if (!(s > 0) || s === k) return null;
  const held = holdingScale(state.project, k, state.derived, (st) => (st.project === state.project ? s : autoPrintScale(st)));
  return held && held.project !== state.project ? held.project : null;
}

// The offsets of `at0` (written for print scale s0) at the scale the household prints at with them: tried at
// s0, then at the scale it printed at, until one holds; when none does (names dragged far off the plan: 1:75
// needs 1:100 and back), the one printing nearest to the scale it was written for (s0 on a tie).
// → { project (offsets written for `held`), held, printAt } | null
function holdingScale(at0, s0, derived, scaleOf = autoPrintScale) {
  const tried = new Map();   // scale written for → { q, a: the scale it prints at }
  let s = s0, held = null;
  for (let round = 0; round < 5; round++) {
    const q = s === s0 ? at0 : scaleLabelOffsets(at0, s0 / s);
    const a = scaleOf({ project: q, derived });
    if (!(a > 0)) break;
    tried.set(s, { q, a });
    if (a === s) { held = s; break; }
    if (tried.has(a)) break;   // 1:75 ↔ 1:100 and back: none holds
    s = a;
  }
  if (held == null) {
    let err = Infinity;
    for (const [sc, { a }] of tried) {
      const e = Math.abs(a / sc - 1);
      if (e < err - 1e-9 || (Math.abs(e - err) <= 1e-9 && sc === s0)) { err = e; held = sc; }
    }
  }
  if (held == null) return null;
  return { project: tried.get(held).q, held, printAt: tried.get(held).a };
}

// The rotate follower for texts moved by hand (see above). → the after project with its offsets, or null
// The new print scale is taken with the moved names already at their turned world spots: the offsets
// rotate.js turned are measured from the OLD label point, and in a strip the engine's label point can lie
// metres from where it was (복도 13.9 m), so a name read that way can land far off the plan. Taken from
// that project, the scale came out 1:150 instead of 1:60 and every offset was written at it (×0.4): after
// four turns the names moved by hand were 60–385 mm from their spots (final review 2026-10-28, D3 / D4).
// So: the names first, written at the old scale; then the scale of that project; offsets converted to it
// (the same spots on the plan) and the scale taken again until it holds.
// Final review round 2 (2026-10-31):
//   - A scale may never hold: names dragged 40–70 paper mm off the plan widen the print at 1:75 so that it
//     needs 1:100, and written for 1:100 they fit 1:75 again (A1). Then the scale whose print comes
//     nearest to it is kept, and the scale the offsets were written for is remembered (turnMemo), so the
//     next turn takes their spots at that scale: after four turns every offset is as it was (DESIGN §7.15),
//     where before it drifted 3.6–17.5 paper mm.
//   - Two texts moved by hand that overlap after the turn (a window label turned from across its wall to
//     along it, under a name: E5 거실) are pushed apart (pushMovedApart); the pushed offsets are not where
//     the texts are meant to be, so the next turn starts from the ones before the push (turnMemo), and four
//     turns still give the offsets back. (Memory only: the file keeps the offsets as printed.)
const turnMemo = new WeakMap();   // labelOffsets object → { s: the scale they were written for, intended: { key: offset } }
export function turnedLabelOffsets(before, after, dir = 1, turn = null) {
  const keys = Object.keys((after && after.project && after.project.labelOffsets) || {}).filter((k) => k !== 'title');
  if (!keys.length) return null;
  const memo = before && before.project && before.project.labelOffsets ? turnMemo.get(before.project.labelOffsets) : null;
  const s0 = memo && memo.s > 0 ? memo.s : autoPrintScale(before);
  if (!(s0 > 0)) return null;
  const t = turn && typeof turn.point === 'function' ? turn : rotationOf(before.project, dir === -1 ? -1 : 1);
  let p = after.project;
  // Texts pushed apart after the last turn: turned from where they were meant to be.
  if (memo && memo.intended && t && typeof t.vector === 'function') {
    const offs = { ...(p.labelOffsets || {}) };
    let changed = false;
    for (const [k, v] of Object.entries(memo.intended)) {
      if (!offs[k] || !v) continue;
      const w = t.vector(Number(v.dx) || 0, Number(v.dy) || 0);
      offs[k] = { ...offs[k], dx: Math.round(w.x * 100) / 100, dy: Math.round(w.y * 100) / 100 };
      changed = true;
    }
    if (changed) p = { ...p, labelOffsets: offs };
  }
  if (keys.some((k) => k.startsWith('room:')) && t) {
    p = turnMovedRoomLabels(before, { project: p, derived: after.derived }, s0, s0, t.point) || p;
  }
  // p holds every offset at s0. The scale it prints at, then the offsets at that scale, until it holds.
  const h = holdingScale(p, s0, after.derived);
  if (!h) return p !== after.project ? p : null;
  const held = h.held, printAt = h.printAt;
  p = h.project;
  const pushed = pushMovedApart(p, after.derived, printAt);
  if (pushed) p = pushed.project;
  if (p.labelOffsets && (held !== printAt || pushed)) turnMemo.set(p.labelOffsets, { s: held, intended: pushed ? pushed.intended : null });
  return p !== after.project ? p : null;
}

// Window / door and fixture labels moved by hand that overlap another text moved by hand at print scale
// `scale` (core/labels.js placeLabels, as printlayout.js counts them; a label along a diagonal wall by the pieces of
// its turned rectangle): each moved off the other along the axis that needs the least, plus the paper text gap.
// → { project, intended: { key: offset before } } | null
export const MOVED_APART_GAP_MM = 0.8;
export function pushMovedApart(project, derived, scale) {
  if (!project || !derived || !(scale > 0)) return null;
  // Only a window / door or fixture label moves, and only off another text moved by hand: with none of them,
  // or a single text moved by hand, there is nothing to push (final review round 3: a full paper placement of
  // every label at the print scale on every turn, 0.3–2.4 s for a household printed at 1:150).
  const offs0 = project.labelOffsets || {};
  const keys = Object.keys(offs0).filter((k) => offs0[k] && /^(room|opening|fixture):/.test(k));
  if (keys.length < 2 || !keys.some((k) => !k.startsWith('room:'))) return null;
  let p = project;
  const intended = {};
  for (let round = 0; round < 3; round++) {
    let moved = [];
    try { moved = movedLabelBoxes(p, derived, scale); } catch (_) { return null; }
    const gap = MOVED_APART_GAP_MM * scale;
    let shift = null;
    for (let i = 0; i < moved.length && !shift; i++) {
      for (let j = i + 1; j < moved.length && !shift; j++) {
        const a = moved[i], b = moved[j];
        // A text along a diagonal wall: only when the turned rectangles themselves overlap; the amount from the pieces of
        // the two that do (those must all come apart).
        if ((a.shape || b.shape) && !convexOverlap(a.shape ? a.shape[0] : boxPoints(a.box), b.shape ? b.shape[0] : boxPoints(b.box))) continue;
        let ox = 0, oy = 0;
        for (const p of a.parts || [a.box]) {
          for (const q of b.parts || [b.box]) {
            const px = Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX) + gap, py = Math.min(p.maxY, q.maxY) - Math.max(p.minY, q.minY) + gap;
            if (px > gap && py > gap) { ox = Math.max(ox, px); oy = Math.max(oy, py); }
          }
        }
        if (!(ox > gap && oy > gap)) continue;
        // The one that is not a room's name moves (the later one when neither is).
        const m = a.kind === 'room' && b.kind !== 'room' ? b : a.kind !== 'room' && b.kind === 'room' ? a : b;
        const o = m === a ? b : a;
        if (m.kind === 'room') continue;
        const cx = (m.box.minX + m.box.maxX) / 2 - (o.box.minX + o.box.maxX) / 2;
        const cy = (m.box.minY + m.box.maxY) / 2 - (o.box.minY + o.box.maxY) / 2;
        shift = ox <= oy ? { key: m.key, dx: (cx >= 0 ? 1 : -1) * ox, dy: 0 } : { key: m.key, dx: 0, dy: (cy >= 0 ? 1 : -1) * oy };
      }
    }
    if (!shift) break;
    const offs = { ...(p.labelOffsets || {}) };
    const v = offs[shift.key] || { dx: 0, dy: 0 };
    if (!(shift.key in intended)) intended[shift.key] = v;
    offs[shift.key] = { ...v, dx: Math.round(((Number(v.dx) || 0) + shift.dx / scale) * 100) / 100, dy: Math.round(((Number(v.dy) || 0) + shift.dy / scale) * 100) / 100 };
    p = { ...p, labelOffsets: offs };
  }
  return Object.keys(intended).length ? { project: p, intended } : null;
}

// The texts moved by hand as core/labels.js placeLabels writes them at print scale `scale` (paper fonts,
// offsets at that scale), without placing the others: a moved text's box does not depend on them (a name at
// its label point + offset at its fitted size; a window / door label at its opening + offset with its first
// spot's size and turn; a fixture label at its box's centre + offset at its size in its box, the other
// fixtures still counted). → [label] (moved, with box and key)
export function movedLabelBoxes(project, derived, scale) {
  const offs = (project && project.labelOffsets) || {};
  const opts = {
    fonts: { name: PAPER_STYLE.namePt, height: PAPER_STYLE.heightPt, opening: PAPER_STYLE.openingPt, fixture: PAPER_STYLE.fixturePt },
    worldPerUnit: PT_MM * scale, worldPerPaperMM: scale, offsetWorldPerPaperMM: scale,
  };
  const rooms = (derived.rooms || []).filter((r) => r && offs[`room:${r.roomId}`]);
  const openings = (project.openings || []).filter((o) => o && offs[`opening:${o.id}`]);
  const fixtures = (project.fixtures || []).filter((f) => f && offs[`fixture:${f.id}`]);
  const out = [];
  if (rooms.length) out.push(...placeLabels(project, { ...derived, rooms }, { ...opts, include: { rooms: true, openings: false, fixtures: false } }));
  if (openings.length || fixtures.length) {
    out.push(...placeLabels({ ...project, openings, fixtures }, derived, {
      ...opts, fixtureBoxes: fixtureObstacles(project), include: { rooms: false, openings: openings.length > 0, fixtures: fixtures.length > 0 },
    }));
  }
  return out.filter((l) => l.moved && l.box && l.key);
}

// DocStore derive hook: texts moved by hand follow the plan (labels.js followMovedLabels; review 예시 세대 A
// #22). Only when some text was moved and some corner moved; a fresh re-derive (도면 돌리기) has its own
// follower above. The automatic print scale of both states is what the offsets are measured in (each
// state's scale worked out once: the state before a value is the one after the value typed before; final
// review round 2, two print layouts per value once a text had been moved by hand).
// A household opened in another shape than stored (core/model.js deriveOpened: the hooks against the plan as
// stored) whose file says the scale its offsets were written at (labelScale) takes that scale for the stored
// plan: only the opened plan's scale is worked out (round 4 open-shifted-household-slow: A2 opened with a
// corner 60 mm off took 200–260 ms, most of it the print layout of the stored plan, 1:100 with its ※ lines;
// now 21–31 ms, node on the PC). That scale is also the right one: the offsets were written at it, where the
// stored plan of another version, worked out here, may print at another (A2 above: 1:100, the texts then
// went a third farther from their places). Only a file being opened has the record: an open document never
// keeps it.
export function movedLabelsDeriveHook(prevProject, nextProject, nextDerived, prevDerived = null) {
  if (!prevDerived || !nextProject || !nextDerived) return null;
  const keys = Object.keys(nextProject.labelOffsets || {});
  if (!keys.some((k) => k !== 'title' && !k.startsWith('dim:'))) return null;
  const follow = FX.planFollower(prevProject, prevDerived, nextProject, nextDerived);
  if (!follow) return null;
  const prev = { project: prevProject, derived: prevDerived }, next = { project: nextProject, derived: nextDerived };
  const s0 = fileLabelScale(prevProject) || cachedPrintScale(prev), s1 = cachedPrintScale(next);
  const out = followMovedLabels(prev, next, s0, s1, follow);
  // Its offsets are written for s1 (the texts at their spots at that scale): the next value starts from it.
  if (out && out !== nextProject && s1 > 0) scaleCache.set(nextDerived, { project: out, scale: s1 });
  return out;
}

// autoPrintScale of a state, remembered per derived snapshot and its project (both are replaced, never
// changed in place, by every edit; the project the hook above returns is remembered at the scale its offsets
// were written for). → number | 0
const scaleCache = new WeakMap();   // derived → { project, scale }
export const printScaleStats = { computed: 0 };
export function cachedPrintScale(state) {
  const d = state && state.derived;
  if (!d || typeof d !== 'object') return autoPrintScale(state);
  const hit = scaleCache.get(d);
  if (hit && hit.project === state.project) return hit.scale;
  const scale = autoPrintScale(state);
  scaleCache.set(d, { project: state.project, scale });
  return scale;
}

// The automatic print scale of a { project, derived } exactly as the editor and [출력] compute it (the
// notes band depends on the unresolved 확인필요 items). → number | 0
export function autoPrintScale(state) {
  printScaleStats.computed++;
  try {
    const items = runChecks(state.project, state.derived, CHECK_OPTIONS);
    const base = notesForPrint(items, { drawingOnly: false, bothValues: false });
    const notes = notesForChoices(state.project, state.derived, DEFAULT_CHOICES, base);
    // As [출력] prints by default (메모 포함 off: the memo takes no room, output.js printsMemo).
    return computePrintLayout(state.project, state.derived, { scale: 'auto', dpi: 300, noteLines: notes.maxLines, memo: printsMemo(DEFAULT_CHOICES) }).scale || 0;
  } catch (err) {
    console.error('[wiring] print scale failed', err);
    return 0;
  }
}

// World polygons of the wall parts taken by fixtures put into a wall (fixtures.js fixtureWallCutouts,
// which returns a Map edgeId → [{ from, to, fixtureId, points }]; an array is accepted as well).
// → [{ points: [{x, y}] }]
export function wallCutouts(project, derived) {
  if (typeof FX.fixtureWallCutouts !== 'function') return [];
  try {
    const out = FX.fixtureWallCutouts(project, derived);
    if (out instanceof Map) return [...out.values()].flat().filter((c) => c && Array.isArray(c.points));
    return Array.isArray(out) ? out : [];
  } catch (err) {
    console.error('[wiring] fixtureWallCutouts failed', err);
    return [];
  }
}
