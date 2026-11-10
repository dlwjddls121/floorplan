// Keys of check items that other modules need to recognise without running the checks.
// (checks-full.js imports model.js, which imports dims.js, so dims.js cannot import checks-full.js.)

// '2700' for 2700.4; '' for a non-number.
export function plainMM(v) {
  return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '';
}

// Key of the 양쪽 값 차이 item for two measures of the same side from both rooms.
//   measures: [{ id, value }] (two entries). Includes the values, so a 확인 완료 stops applying as soon
//   as one value is changed.
export function twoSideKey(measures) {
  return `twoSide:${measures.map((m) => `${m.id}=${plainMM(m.value)}`).sort().join('|')}`;
}

// Keys resolved with [확인 완료] in a project. → Set<string>
export function resolvedKeys(project) {
  return new Set(((project && project.checks) || []).filter((c) => c && typeof c.key === 'string').map((c) => c.key));
}

// Keys written before 0.5.1 that still stand for a key of today. 'openingWide' and 'fixtureLong' keys
// ended in the wall length the solve gave (openingWide:o16:900:574), so a [확인 완료] came undone as soon
// as any value elsewhere moved that wall by a millimetre. Today they end in the wall itself
// (openingWide:o16:900:e12, fixtureLong:f3:1800:n4-n9); a mark saved with the old key keeps applying to
// the same opening / fixture and size whatever the wall length was. → RegExp of the old keys | null
const LEGACY_LENGTH_KEY = /^(openingWide|fixtureLong):([^:]+):(\d+):([^:]*[^\d:][^:]*)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function legacyKeyPattern(key) {
  const m = typeof key === 'string' ? LEGACY_LENGTH_KEY.exec(key) : null;
  return m ? new RegExp(`^${m[1]}:${escapeRe(m[2])}:${m[3]}:\\d+$`) : null;
}

// The 'id=value' pairs of a 안 맞는 값 key ('loop:m2=3450,m4=3875'), or of the h / v values of a
// '확인한 사선 벽과 안 맞습니다' key with the diagonal's own part ('residualWith:m15=400,m17=2990|m16=2330':
// pairs m15=400, m17=2990; rest 'm16=2330'). → { kind, pairs: [string], rest } | null
function subsetPairs(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('loop:')) return { kind: 'loop', pairs: key.slice(5).split(',').filter(Boolean), rest: '' };
  if (key.startsWith('residualWith:')) {
    const body = key.slice('residualWith:'.length);
    const bar = body.lastIndexOf('|');
    if (bar < 0) return null;
    return { kind: 'residualWith', pairs: body.slice(0, bar).split(',').filter(Boolean), rest: body.slice(bar + 1) };
  }
  return null;
}

// Whether `key` is resolved in the set from resolvedKeys(), by itself or by an older key of the same item.
// A 안 맞는 값 key is also resolved by a confirmed one that named all its values with these values (round 2,
// 2026-10-31: confirmed while typing, 'loop:m2=3450,m4=3875' came back as 'loop:m4=3875' with the next
// value, the same value asked about again); a '확인한 사선 벽과 안 맞습니다' key likewise, by a confirmed one
// about the same diagonal with the same value that named all its values (round 4, 2026-11-01: typed in the
// field's order, each new value took one more name off the list and the same correct values were asked
// about three times).
export function isKeyResolved(resolved, key) {
  if (!resolved || !key) return false;
  if (resolved.has(key)) return true;
  const sub = subsetPairs(key);
  if (sub) {
    for (const k of resolved) {
      const had = subsetPairs(k);
      if (had && had.kind === sub.kind && had.rest === sub.rest && sub.pairs.every((p) => had.pairs.includes(p))) return true;
    }
    return false;
  }
  const old = legacyKeyPattern(key);
  if (!old) return false;
  for (const k of resolved) if (old.test(k)) return true;
  return false;
}

// Whether a residual warning (model.js computeWarnings) is '안 맞음' / 확인필요 now, with the household's [확인 완료]
// marks (resolvedKeys). A value its loop names alone (w.loopKey: that loop's item) and the surveyor confirmed there is
// not asked about again in its own 안 맞는 값 item (round 4 part B check: after [확인 완료] on '거실 위쪽 벽 5325: … 안
// 맞습니다' the next 확인필요 named 5325 again; 250 of 504 such confirmations in a sweep of single typos). Of a pair of
// facing values the loop decides (opposite.byLoop), the named one (opposite.side 'named') is then right, so the other
// one, facing it, does not fit (opposite.against). Derive does not run again on a [확인 완료], so the screen marks, the
// length panel and the checks read it here.
export function residualCheckNow(w, resolved) {
  if (!w) return false;
  const o = w.opposite;
  if (o && o.byLoop && typeof o.loopKey === 'string' && resolved && isKeyResolved(resolved, o.loopKey)) {
    return o.side === 'named' ? false : !!o.against;
  }
  if (typeof w.loopKey === 'string' && resolved && isKeyResolved(resolved, w.loopKey)) return false;
  // Round 5 (2026-11-08): a value a loop calls alone is '안 맞음', the values that miss only because of it are not
  // (model.js computeWarnings `loopCall`); once an item that asks about a called value is confirmed, `after`.
  const c = w.loopCall;
  if (c && Array.isArray(c.keys) && resolved && c.keys.some((k) => isKeyResolved(resolved, k))) return !!c.after;
  return !!w.check;
}
