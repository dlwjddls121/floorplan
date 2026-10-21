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

// Whether `key` is resolved in the set from resolvedKeys(), by itself or by an older key of the same item.
export function isKeyResolved(resolved, key) {
  if (!resolved || !key) return false;
  if (resolved.has(key)) return true;
  const old = legacyKeyPattern(key);
  if (!old) return false;
  for (const k of resolved) if (old.test(k)) return true;
  return false;
}
