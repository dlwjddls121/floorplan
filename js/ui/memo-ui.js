// 메모 tool and memo drawing (plan §2-6): handwriting kept apart from the drawing.
//
//   MemoTool  — the canvas tool. Mode [펜] stores each stroke (smoothed); mode [지우개] deletes every
//               stroke the eraser touches (one undo step per eraser gesture). [메모 숨기기] hides the
//               memo on screen; it is saved with the household (project.memoHidden, not an undo
//               step). [모두 지우기] asks first.
//   drawMemo  — draws the strokes in a dark-red handwriting colour; on paper only when
//               options.showMemo is true, never in '그림만' (options.drawingOnly). The line width is a
//               fixed paper width (core/memo.js memoPaperWidth); the screen shows it as at 1:60.
//
// ctx = { store(), view, command(fn, label) → bool, toast(msg, opts), requestRender(),
//         overlayHost: element over the canvas for the mode bar (e.g. #canvasWrap) }
import { el, openDialog } from './panel.js';
import { MEMO_COLOR, MEMO_PAPER_MM, WORLD_PER_PAPER_MM, memoStrokesAlong, validMemo, memoPaperWidth, isMemoHidden } from '../core/memo.js';

export const MEMO_HINT = '메모: S펜이나 손가락으로 자유롭게 적으세요. 메모는 도면과 따로 저장되고, 출력할 때 넣을지 고릅니다.';

const ERASER_PX = 14;      // eraser radius on screen
const MIN_SCREEN_PX = 1.2;
const MIN_PAPER_MM = 0.18;

// Canvas px of a stroke's width: paper mm × px per paper mm on paper, as at 1:60 on screen.
export function memoLinePx(stroke, opts) {
  const pw = memoPaperWidth(stroke);
  if (opts && opts.paper) return Math.max(MIN_PAPER_MM * opts.paper.pxPerPaperMM, pw * opts.paper.pxPerPaperMM);
  const worldPerPaper = (opts && opts.worldPerPaperMM) || WORLD_PER_PAPER_MM;
  return Math.max(MIN_SCREEN_PX, pw * worldPerPaper * ((opts && opts.pxPerMM) || 0));
}

// ---- drawing -------------------------------------------------------------------------------------

function strokePath(ctx, pts, toPx) {
  const s = pts.map((p) => toPx(p));
  ctx.moveTo(s[0].x, s[0].y);
  if (s.length === 2) {
    ctx.lineTo(s[1].x, s[1].y);
    return;
  }
  // Quadratic curves through the midpoints: smooth on screen and on paper.
  for (let i = 1; i < s.length - 1; i++) {
    const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
    ctx.quadraticCurveTo(s[i].x, s[i].y, mx, my);
  }
  const last = s[s.length - 1];
  ctx.lineTo(last.x, last.y);
}

function drawStroke(ctx, stroke, opts) {
  const pts = stroke.points;
  const w = memoLinePx(stroke, opts);
  ctx.strokeStyle = stroke.color || MEMO_COLOR;
  ctx.fillStyle = stroke.color || MEMO_COLOR;
  if (pts.length === 1) {
    const c = opts.toPx(pts[0]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  strokePath(ctx, pts, opts.toPx);
  ctx.stroke();
}

// opts: { toPx, pxPerMM, paper, options: { showMemo, drawingOnly, memoExclude: Set<id> (screen) } }
// Screen: drawn unless options.showMemo === false. Paper: drawn only when options.showMemo === true.
export function drawMemo(ctx, project, derived, opts) {
  const o = (opts && opts.options) || {};
  const paper = opts && opts.paper;
  if (o.drawingOnly) return;
  if (paper ? o.showMemo !== true : o.showMemo === false) return;
  const list = validMemo(project && project.memo);
  if (!list.length) return;
  const exclude = !paper && o.memoExclude instanceof Set ? o.memoExclude : null;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of list) {
    if (exclude && exclude.has(s.id)) continue;
    drawStroke(ctx, s, opts);
  }
  ctx.restore();
}

// ---- tool ----------------------------------------------------------------------------------------

export class MemoTool {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'pen';          // 'pen' | 'eraser'
    this._visible = true;       // fallback when the store has no setMemoHidden (older store)
    this.live = null;           // world points of the stroke being written
    this.erasing = null;        // { path: [world], ids: Set } during an eraser gesture
    this.bar = null;
  }

  // Screen visibility of the open household's memo (saved with it: project.memoHidden).
  get visible() {
    const store = this.ctx.store && this.ctx.store();
    if (store && typeof store.setMemoHidden === 'function') return !isMemoHidden(store.project);
    return this._visible;
  }

  // Merge into the draw options of drawMemo on screen.
  screenOptions() {
    return { showMemo: this.visible, memoExclude: this.erasing ? this.erasing.ids : null };
  }

  activate() {
    if (!this.bar) this.bar = el('div', { class: 'memo-bar', role: 'toolbar', 'aria-label': '메모' });
    this._renderBar();
    if (this.ctx.overlayHost && !this.bar.isConnected) this.ctx.overlayHost.append(this.bar);
    this.bar.hidden = false;
  }

  deactivate() {
    this.cancel();
    if (this.bar) this.bar.hidden = true;
  }

  cancel() {
    const had = !!(this.live || this.erasing);
    this.live = null;
    this.erasing = null;
    if (had) this.ctx.requestRender();
    return had;
  }

  setMode(mode) {
    if (mode !== 'pen' && mode !== 'eraser') return;
    this.mode = mode;
    this._renderBar();
  }

  setVisible(on) {
    const store = this.ctx.store && this.ctx.store();
    if (store && typeof store.setMemoHidden === 'function') store.setMemoHidden(!on);
    else this._visible = !!on;
    this._renderBar();
    this.ctx.requestRender();
  }

  async clearAll() {
    const store = this.ctx.store();
    if (!((store.project.memo || []).length)) {
      this.ctx.toast('지울 메모가 없습니다.');
      return false;
    }
    const res = await openDialog({
      title: '메모를 모두 지울까요?',
      message: '이 세대의 손글씨 메모를 모두 지웁니다. ↶ 버튼으로 되돌릴 수 있습니다.',
      buttons: [{ label: '취소', value: null }, { label: '모두 지우기', value: 'ok', kind: 'danger' }],
    });
    if (res.button !== 'ok') return false;
    this.ctx.command(() => this.ctx.store().clearMemo(), '메모 모두 지우기');
    this.ctx.requestRender();
    return true;
  }

  _renderBar() {
    if (!this.bar) return;
    const b = (label, on, onclick, extra = '') => el('button', {
      type: 'button', class: `btn btn-small ${on ? 'btn-on' : ''} ${extra}`, 'aria-pressed': on ? 'true' : 'false', onclick,
    }, label);
    this.bar.replaceChildren(
      el('span', { class: 'memo-bar-label' }, '메모'),
      b('✎ 펜', this.mode === 'pen', () => this.setMode('pen')),
      b('지우개', this.mode === 'eraser', () => this.setMode('eraser')),
      b(this.visible ? '메모 숨기기' : '메모 보이기', !this.visible, () => this.setVisible(!this.visible)),
      el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => this.clearAll() }, '모두 지우기'));
  }

  // ---- gestures --------------------------------------------------------------------------------

  onGestureStart(g) {
    const p = g.points[0];
    if (this.mode === 'eraser') {
      // Never erase strokes the user cannot see: while the memo is hidden the eraser does nothing.
      if (!this.visible) {
        this.ctx.toast('메모가 숨겨져 있습니다. [메모 보이기]를 누른 뒤 지우세요.');
        return;
      }
      this.erasing = { path: [p], ids: new Set() };
      this._eraseAlong([p]);
    } else {
      if (!this.visible) {
        this.setVisible(true);
        this.ctx.toast('메모를 다시 보이게 했습니다.');
      }
      this.live = [p];
    }
    this.ctx.requestRender();
  }

  onGestureMove(g) {
    const last = g.points[g.points.length - 1];
    if (this.erasing) {
      const path = this.erasing.path;
      const prev = path[path.length - 1];
      path.push(last);
      this._eraseAlong([prev, last]);
    } else if (this.live) {
      this.live = g.points.slice();
    }
    this.ctx.requestRender();
  }

  onGestureEnd(g) {
    const store = this.ctx.store();
    const scale = this.ctx.view.scale;
    if (this.erasing) {
      const ids = [...this.erasing.ids];
      this.erasing = null;
      if (ids.length) this.ctx.command(() => store.deleteMemoStroke(ids), '메모 지우기');
    } else if (this.live) {
      const points = g.isTap ? [g.points[0]] : g.points.slice();
      this.live = null;
      // The zoom only sets how finely the stroke is kept (about one screen pixel), never its width.
      this.ctx.command(() => store.addMemoStroke(points, { paperWidth: MEMO_PAPER_MM, tolerance: 0.8 / scale }), '메모');
    }
    this.ctx.requestRender();
  }

  onGestureCancel() {
    this.cancel();
  }

  _eraseAlong(path) {
    const store = this.ctx.store();
    const r = ERASER_PX / this.ctx.view.scale;
    for (const id of memoStrokesAlong(store.project, path, r)) this.erasing.ids.add(id);
  }

  // Live stroke / eraser ring, drawn after the plan (screen only).
  drawOverlay(ctx, opts) {
    if (this.live && this.live.length) {
      drawStroke(ctx, { points: this.live, paperWidth: MEMO_PAPER_MM, color: MEMO_COLOR }, opts);
    }
    if (this.erasing && this.erasing.path.length) {
      const c = opts.toPx(this.erasing.path[this.erasing.path.length - 1]);
      ctx.save();
      ctx.strokeStyle = '#5F6670';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, ERASER_PX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
