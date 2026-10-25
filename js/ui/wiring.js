// Joins the stage B/C/D packages that only know each other through hooks and registries:
//   - core/labels.js labelHooks   (texts and anchors of window/door and fixture labels on paper)
//   - ui/output.js paperDrawers   (openings, fixtures, 실 아님 spaces and the memo on paper)
//   - core/checks-full.js         (확인 완료 store commands; the exact span of each window/door)
//   - core/labels.js              (texts moved by hand: moveLabel / resetLabel store commands)
//   - core/rotate.js              (도면 돌리기 followers: 확인 완료 marks, moved texts at the new scale)
//   - DocStore.deriveHooks        (texts moved by hand follow the plan when values reshape it)
// main.js calls wirePackages() once at start-up; test and sample pages that render paper output
// without the app shell call it too. It is safe to call more than once.
import { DocStore } from '../core/model.js';
import { installChecks, carryResolvedChecks, runChecks, notesForPrint } from '../core/checks-full.js';
import { scaleLabelOffsets, rotationOf } from '../core/rotate.js';
import { computePrintLayout } from '../core/printlayout.js';
import { labelOf, displayName, placeOpening, nominalWidth, slidingLeaves } from '../core/openings.js';
// A namespace import: fixtureGlyphBoxes (the sink basin, removed by the 2026-10-17 request) and
// fixtureWallCutouts (벽 속에 넣기) may or may not exist in the fixtures package; a missing named
// import would stop the whole app from loading.
import * as FX from '../core/fixtures.js';
import { labelHooks, installLabelCommands, followMovedLabels, turnMovedRoomLabels } from '../core/labels.js';
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
    DocStore.rotateFollowers.push((before, after, dir, turn) => {
      const keys = Object.keys(after.project.labelOffsets || {}).filter((k) => k !== 'title');
      if (!keys.length) return null;
      const s0 = autoPrintScale(before), s1 = autoPrintScale(after);
      if (!(s0 > 0 && s1 > 0)) return null;
      let p = s0 !== s1 ? scaleLabelOffsets(after.project, s0 / s1) : after.project;
      if (keys.some((k) => k.startsWith('room:'))) {
        const t = turn && typeof turn.point === 'function' ? turn : rotationOf(before.project, dir === -1 ? -1 : 1);
        if (t) p = turnMovedRoomLabels(before, { project: p, derived: after.derived }, s0, s1, t.point) || p;
      }
      return p !== after.project ? p : null;
    });
  }
  // Values (or a dragged corner) reshape the plan: texts moved by hand keep their place on it.
  if (Array.isArray(DocStore.deriveHooks) && !DocStore.deriveHooks.includes(movedLabelsDeriveHook)) {
    DocStore.deriveHooks.push(movedLabelsDeriveHook);
  }
}

// DocStore derive hook: texts moved by hand follow the plan (labels.js followMovedLabels; review 예시 세대 A
// #22). Only when some text was moved and some corner moved; a fresh re-derive (도면 돌리기) has its own
// follower above. The automatic print scale of both states is what the offsets are measured in.
export function movedLabelsDeriveHook(prevProject, nextProject, nextDerived, prevDerived = null) {
  if (!prevDerived || !nextProject || !nextDerived) return null;
  const keys = Object.keys(nextProject.labelOffsets || {});
  if (!keys.some((k) => k !== 'title' && !k.startsWith('dim:'))) return null;
  const follow = FX.planFollower(prevProject, prevDerived, nextProject, nextDerived);
  if (!follow) return null;
  const prev = { project: prevProject, derived: prevDerived }, next = { project: nextProject, derived: nextDerived };
  const s0 = autoPrintScale(prev), s1 = autoPrintScale(next);
  return followMovedLabels(prev, next, s0, s1, follow);
}

// The automatic print scale of a { project, derived } exactly as the editor and [출력] compute it (the
// notes band depends on the unresolved 확인필요 items). → number | 0
export function autoPrintScale(state) {
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
