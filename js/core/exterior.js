// 외벽 (exterior walls) — user 2026-10-25: "외벽을 따로 표시할 수 있으면 좋겠어. 어느 부분이 외벽인지. 그리고
// 그렇게 외벽 표시한것만 따로 볼수 있으면 좋겠어 치수선 껏다키는것처럼." Then, the same day: "자동으로 외벽 되는
// 기능은 없애줘. 우리가 원할때 원하는 벽만 외벽처리 할거야."
//
//   exteriorIds(project, derived)          → Set of the wall ids marked 외벽 (derived is not needed; kept so
//                                            the callers stay as they are)
//   exteriorInfo(project, derived, edgeId) → { on } | null (no such wall, or a 구역 나누기 선)
//   isExteriorWall(edge)                   → bool: a wall (never a 구역 나누기 선) marked 외벽
//   withExteriorMarksOnly(project)         → the project with edge.exterior kept only where it is true on a
//                                            wall (the same object when there is nothing to drop)
//   installExterior(DocStore)              adds store.setWallExterior(edgeId, on) and
//                                          store.toggleWallExterior(edgeId) (one undo step each)
//
// Marked by hand only: a wall is 외벽 only when the user set it with the length panel's [외벽]. Nothing is
// 외벽 by itself (0.6.7 also took every wall with a room on one side only for 외벽; removed at the user's
// request above). edge.exterior = true: 외벽; absent: not. A false (a 0.6.7 file or household where an
// automatic wall was switched off) means 'not' and is dropped (validateProject for files, the store for a
// household opened from this device), so a 0.6.7 household whose walls were only red by themselves opens
// with no 외벽. The mark is an ordinary edge field: a split wall gives it to both halves (graph.js copies
// the edge), a merge keeps it when either piece has it (graph.js mergeThrough / mergeNodeInto, as the
// thickness), [↻ 회전], ↶ / ↷ and the project file keep it.
//
// Display only: the solver's assumed thicknesses (바깥벽 150 / 안쪽 벽 100), the sides of the dimension
// chains and the checks keep their own one-side rule (a wall with a room on one side only) and never read
// edge.exterior, so marking a wall changes no length, no chain and no 예시 세대 A result.

export function isExteriorWall(edge) {
  return !!edge && edge.kind !== 'divider' && edge.exterior === true;
}

// The walls shown and printed as 외벽. → Set of edge ids
export function exteriorIds(project, _derived = null) {
  const out = new Set();
  for (const e of (project && project.edges) || []) if (isExteriorWall(e)) out.add(e.id);
  return out;
}

// → { on } | null
export function exteriorInfo(project, _derived, edgeId) {
  const e = ((project && project.edges) || []).find((x) => x.id === edgeId);
  if (!e || e.kind === 'divider') return null;
  return { on: isExteriorWall(e) };
}

// A mark that is not a plain true on a wall (false from 0.6.7, a divider, a value edited in by hand) is
// dropped. → project (the same object when every mark is kept)
export function withExteriorMarksOnly(project) {
  const edges = project && Array.isArray(project.edges) ? project.edges : null;
  if (!edges || !edges.some((e) => e && 'exterior' in e && !isExteriorWall(e))) return project;
  return {
    ...project,
    edges: edges.map((e) => {
      if (!e || !('exterior' in e) || isExteriorWall(e)) return e;
      const { exterior: _drop, ...rest } = e;
      return rest;
    }),
  };
}

// ---- store commands --------------------------------------------------------------------------------

export function installExterior(DocStore) {
  const proto = DocStore.prototype;

  // on: true marks the wall 외벽, anything else takes the mark away. One undo step; a 구역 나누기 선, an
  // unknown wall or no change → false. Nothing the geometry depends on changes, so nothing is re-derived.
  proto.setWallExterior = function setWallExterior(edgeId, on) {
    const want = on === true;
    return this._commit('setWallExterior', (p) => {
      const i = (p.edges || []).findIndex((e) => e.id === edgeId);
      if (i < 0 || p.edges[i].kind === 'divider') return null;
      const cur = p.edges[i];
      if (isExteriorWall(cur) === want) return null;
      const { exterior: _old, ...rest } = cur;
      const edges = p.edges.slice();
      edges[i] = want ? { ...rest, exterior: true } : rest;
      return { ...p, edges };
    }, { rederive: false, detail: { edgeId } });
  };

  // The length panel's [외벽] switch: on ↔ off for this wall piece. → bool
  proto.toggleWallExterior = function toggleWallExterior(edgeId) {
    const info = exteriorInfo(this.project, this.derived, edgeId);
    if (!info) return false;
    return this.setWallExterior(edgeId, !info.on);
  };
}
