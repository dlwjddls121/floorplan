// Visual constants shared by the UI and the renderer (dev/DESIGN.md §0, §5).
// Keep every colour, size and preset list here so that the look can be tuned in one place.

// Font stack used in CSS and in canvas `ctx.font`: each device's own plain Korean gothic (user
// 2026-10-18 "기본 글꼴로, 너무 고전적인 느낌 말고"; the tablets have no NanumBarunGothic). PC: 맑은 고딕
// (Latin letters too; this PC has no Roboto, so its outputs did not change). Galaxy Tab: Roboto (on every
// Android) for the Latin letters and digits, then the system Korean font for Hangul. Without Roboto in
// the list the Galaxy Tab S9 FE drew the Latin letters ('(A4 · 300dpi)', 'mm', 'NotAllowedError') in a
// serif face (field test 2026-10-22, 0.6.3). No font files are bundled. Copies: css/app.css --font,
// devtest/devtest.css --font, devtest/devtest.js FONT_STACK (tests/pen-input.html checks them).
export const FONT_STACK =
  '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", Roboto, "Noto Sans KR", "Noto Sans CJK KR", sans-serif';

// Colours (dark-on-light theme).
export const COLORS = {
  canvasBg: '#FFFFFF',
  gridMinor: '#F0F1F3',
  gridMajor: '#E2E4E8',
  originMark: '#C9CDD3',
  wall: '#111111',
  divider: '#111111',
  roomName: '#111111',
  roomNameEmpty: '#9AA0A6',
  notRoomFill: 'rgba(120, 120, 120, 0.10)',
  height: '#0070C0',            // "H: 2280" (plan §1-2, blue)
  measure: '#0070C0',           // measured values (plan §1-2 dimension text colour)
  unmeasured: '#9AA0A6',        // gray "?" and dashed inner line
  check: '#E8710A',             // orange "!" (확인필요)
  outlier: '#D93025',           // "다시 확인"
  selectWall: '#D97706',        // selected wall fill
  activeSide: '#F59E0B',        // active side line (same hue as the active panel field)
  activeSideBg: '#FEF3C7',
  ink: '#37474F',               // live stroke preview
  inkDiagonal: '#E8710A',       // live stroke once the long-press (diagonal) mode is on
  preview: '#1A73E8',           // rectangle preview, drag ghost
};

// Line widths in CSS pixels (screen mode).
export const LINES = {
  divider: 1.5,
  dividerExport: 0.35,          // mm on paper (stage C)
  unmeasuredDash: [6, 5],
  activeSide: 4,
  ink: 2.5,
  preview: 1.5,
};

// Screen-mode text sizes in CSS pixels.
export const TEXT_PX = {
  name: 15,
  height: 12,
  measure: 13,
};

// Hit-test tolerances in CSS pixels.
export const HIT = {
  edgePx: 14,                   // tap distance to a wall (added to half the wall thickness)
  nodePx: 18,                   // drag distance to a corner (select tool)
  snapPx: 18,                   // drawing snap distance, converted to mm by the current zoom
};

// Default wall thickness when the solver gave none (mm).
export const DEFAULT_WALL = { ext: 150, int: 100 };

// Room name presets (plan §2-3), the most used first in the team's order (user 2026-10-18). A preset
// ending in a number ('방1') is set exactly as it is; the others are numbered when a second room of the
// kind appears ('화장실' → '화장실1', '화장실2'). Any other name: [이름 바꾸기] in the panel.
export const ROOM_PRESETS = [
  '거실', '주방', '방1', '방2', '방3', '거실&주방', '화장실', '베란다', '현관', '보일러실',
  '다용도실', '발코니', '복도', '창고',
];

// Camera limits (CSS px per mm).
export const ZOOM = {
  min: 0.005,
  max: 2,
  initial: 0.06,
};

// Timing (ms).
export const TIMING = {
  autosave: 600,
  penNear: 800,
  longPress: 500,
  toast: 2600,
};

// Canvas font string for a given pixel size and weight.
export function canvasFont(px, weight = 'normal') {
  return `${weight} ${px}px ${FONT_STACK}`;
}

// Number formatting used in panels ("2,900") and on the plan ("2900", like the paper drawings).
export function formatMM(value) {
  if (value == null || !isFinite(value)) return '';
  return Math.round(value).toLocaleString('en-US');
}
export function formatPlain(value) {
  if (value == null || !isFinite(value)) return '';
  return String(Math.round(value));
}
