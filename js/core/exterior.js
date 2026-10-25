// 외벽 (exterior walls) — user 2026-10-25: "외벽을 따로 표시할 수 있으면 좋겠어. 어느 부분이 외벽인지. 그리고
// 그렇게 외벽 표시한것만 따로 볼수 있으면 좋겠어 치수선 껏다키는것처럼."
//
//   autoExteriorIds(project, derived)      → Set of wall ids the app takes for exterior walls by itself
//   exteriorIds(project, derived)          → Set: the same with every wall's own choice (edge.exterior) applied
//   exteriorInfo(project, derived, edgeId) → { auto, override: true | false | null, on } | null (no such wall,
//                                            or a 구역 나누기 선)
//   hasExteriorOverride(edge)              → bool: the wall carries its own choice
//   installExterior(DocStore)              adds store.setWallExterior(edgeId, value) and
//                                          store.toggleWallExterior(edgeId) (one undo step each)
//
// Automatic rule: a WALL (never a 구역 나누기 선) with a room on ONE side only, the other side lying outside
// every room: the house's outline. 실 아님 spaces (옷장, 보일러실 …) are rooms here, so the wall between a room
// and its 옷장 is not an exterior wall; a 베란다 is a room, so ITS outer walls are exterior and the wall between
// 거실 and 베란다 is not (the team marks it by hand where they count it as one). A room standing inside another
// room (an island 창고 in a 거실) has the outer room on the other side of its walls, so those are not exterior
// either. A wall with no room at all (a loose wall, a plan not closed yet) is not exterior.
//
// Each wall may carry its own choice: edge.exterior = true (외벽), false (not), absent (automatic). The length
// panel's [외벽] switch flips what is shown and keeps a choice only where it differs from the automatic one,
// so a wall set back to what the app would say follows the app again. The choice is an ordinary edge field:
// validateProject keeps it (walls only), a split wall gives it to both halves (graph.js copies the edge),
// a merge keeps the first piece's choice or else the second's (graph.js mergeThrough, as the thickness),
// [↻ 회전], ↶ / ↷ and the project file keep it.
//
// Display only (2026-10-25): the solver's assumed thicknesses (바깥벽 150 / 안쪽 벽 100), the sides of the
// dimension chains and the checks keep their own one-side rule and never read edge.exterior, so marking a
// wall changes no length, no chain and no 예시 세대 A result.

import { pointInPolygon } from './geom.js';

// Distance (world mm) beside a wall's centre line at which the side without a room is probed.
const PROBE_MM = 1;

const autoCache = new WeakMap(); // derived → { nodes, edges, set }

export function hasExteriorOverride(edge) {
  return !!edge && edge.kind !== 'divider' && typeof edge.exterior === 'boolean';
}

// The automatic rule (see the top). → Set of edge ids
export function autoExteriorIds(project, derived) {
  if (!project || !derived) return new Set();
  const hit = autoCache.get(derived);
  if (hit && hit.nodes === project.nodes && hit.kinds === kindKey(project)) return hit.set;
  const set = computeAuto(project, derived);
  autoCache.set(derived, { nodes: project.nodes, kinds: kindKey(project), set });
  return set;
}

// The walls as they are shown and printed as exterior walls: the automatic rule with each wall's own choice.
export function exteriorIds(project, derived) {
  const auto = autoExteriorIds(project, derived);
  let out = null;
  for (const e of (project && project.edges) || []) {
    if (!hasExteriorOverride(e)) continue;
    if (e.exterior === auto.has(e.id)) continue;
    out = out || new Set(auto);
    if (e.exterior) out.add(e.id); else out.delete(e.id);
  }
  return out || auto;
}

// → { auto, override, on } | null
export function exteriorInfo(project, derived, edgeId) {
  const e = ((project && project.edges) || []).find((x) => x.id === edgeId);
  if (!e || e.kind === 'divider') return null;
  const auto = autoExteriorIds(project, derived).has(e.id);
  const override = hasExteriorOverride(e) ? e.exterior : null;
  return { auto, override, on: override == null ? auto : override };
}

// Which walls are walls (a 구역 나누기 선 is never exterior): part of the cache key.
function kindKey(project) {
  let s = '';
  for (const e of project.edges || []) if (e.kind === 'divider') s += e.id + ',';
  return s;
}

function computeAuto(project, derived) {
  const nodes = new Map((project.nodes || []).map((n) => [n.id, n]));
  const edges = new Map((project.edges || []).map((e) => [e.id, e]));
  const faces = ((derived && derived.rooms) || []).map((dr) => dr && dr.face).filter((f) => f && Array.isArray(f.points) && f.points.length >= 3);
  // Which sides of each edge a room face lies on (faces run clockwise: a face lies on the RIGHT of the
  // edge when its walk goes a → b; graph.js edgeFaces).
  const sides = new Map(); // edgeId → { left, right }
  for (const f of faces) {
    for (let k = 0; k < (f.edgeIds || []).length; k++) {
      const e = edges.get(f.edgeIds[k]);
      if (!e) continue;
      const s = sides.get(e.id) || { left: false, right: false };
      if (f.nodeIds[k] === e.a) s.right = true; else s.left = true;
      sides.set(e.id, s);
    }
  }
  const out = new Set();
  for (const [id, s] of sides) {
    if (s.left === s.right) continue; // rooms on both sides (or a loose wall inside one room)
    const e = edges.get(id);
    if (!e || e.kind === 'divider') continue;
    const A = nodes.get(e.a), B = nodes.get(e.b);
    if (!A || !B) continue;
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    if (!(L > 1e-6)) continue;
    // The side without a room: just beside the middle of the wall. Inside another room's face (the walls
    // of a room standing inside a room), the wall is not part of the house's outline.
    const left = { x: (B.y - A.y) / L, y: -(B.x - A.x) / L };
    const k = s.left ? -1 : 1; // probe the empty side
    const P = { x: (A.x + B.x) / 2 + left.x * PROBE_MM * k, y: (A.y + B.y) / 2 + left.y * PROBE_MM * k };
    if (faces.some((f) => pointInPolygon(P, f.points))) continue;
    out.add(id);
  }
  return out;
}

// ---- store commands --------------------------------------------------------------------------------

export function installExterior(DocStore) {
  const proto = DocStore.prototype;

  // value: true (외벽), false (not an exterior wall) or null (automatic). One undo step; a 구역 나누기 선, an
  // unknown wall or no change → false. Nothing the geometry depends on changes, so nothing is re-derived.
  proto.setWallExterior = function setWallExterior(edgeId, value) {
    const v = value === true || value === false ? value : null;
    return this._commit('setWallExterior', (p) => {
      const i = (p.edges || []).findIndex((e) => e.id === edgeId);
      if (i < 0 || p.edges[i].kind === 'divider') return null;
      const cur = hasExteriorOverride(p.edges[i]) ? p.edges[i].exterior : null;
      if (cur === v) return null;
      const { exterior: _old, ...rest } = p.edges[i];
      const edges = p.edges.slice();
      edges[i] = v == null ? rest : { ...rest, exterior: v };
      return { ...p, edges };
    }, { rederive: false, detail: { edgeId } });
  };

  // The length panel's [외벽] switch: the wall shown the other way. A choice that equals the automatic
  // one is not kept (the wall is automatic again). → bool
  proto.toggleWallExterior = function toggleWallExterior(edgeId) {
    const info = exteriorInfo(this.project, this.derived, edgeId);
    if (!info) return false;
    const on = !info.on;
    return this.setWallExterior(edgeId, on === info.auto ? null : on);
  };
}
