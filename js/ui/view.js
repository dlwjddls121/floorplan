// Camera: world (mm, y down) <-> screen (CSS px, y down).
//   screen = world * scale + offset
// The renderer only relies on { scale, ox, oy, toScreen(), toWorld() }, so stage C can pass a plain
// View configured for paper (scale = px per mm on the page) to renderPlan().
import { ZOOM } from './theme.js';

export class View {
  constructor({ scale = ZOOM.initial, ox = 0, oy = 0, width = 0, height = 0 } = {}) {
    this.scale = scale;   // CSS px per mm
    this.ox = ox;         // screen x of world x = 0
    this.oy = oy;         // screen y of world y = 0
    this.width = width;   // viewport size in CSS px (kept by the owner)
    this.height = height;
  }

  toScreen(p) {
    return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy };
  }

  toWorld(s) {
    return { x: (s.x - this.ox) / this.scale, y: (s.y - this.oy) / this.scale };
  }

  // Convert a length in screen pixels to millimetres at the current zoom.
  pxToMM(px) {
    return px / this.scale;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  panBy(dx, dy) {
    this.ox += dx;
    this.oy += dy;
  }

  // Zoom by `factor` keeping the screen point (sx, sy) fixed.
  zoomAt(sx, sy, factor) {
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, this.scale * factor));
    const k = next / this.scale;
    this.ox = sx - (sx - this.ox) * k;
    this.oy = sy - (sy - this.oy) * k;
    this.scale = next;
  }

  // Visible world rectangle { minX, minY, maxX, maxY }.
  visibleWorld() {
    const a = this.toWorld({ x: 0, y: 0 });
    const b = this.toWorld({ x: this.width, y: this.height });
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  // Fit a world bounding box into the viewport area { x, y, w, h } (CSS px), with padding in px.
  fitBounds(bounds, area = { x: 0, y: 0, w: this.width, h: this.height }, padding = 48) {
    const bw = Math.max(bounds.maxX - bounds.minX, 1000);
    const bh = Math.max(bounds.maxY - bounds.minY, 1000);
    const aw = Math.max(area.w - 2 * padding, 50);
    const ah = Math.max(area.h - 2 * padding, 50);
    const s = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min(aw / bw, ah / bh)));
    this.scale = s;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.ox = area.x + area.w / 2 - cx * s;
    this.oy = area.y + area.h / 2 - cy * s;
  }

  // Centre the world point in the viewport area without changing the zoom.
  centerOn(p, area = { x: 0, y: 0, w: this.width, h: this.height }) {
    this.ox = area.x + area.w / 2 - p.x * this.scale;
    this.oy = area.y + area.h / 2 - p.y * this.scale;
  }

  // True when the world point is inside the screen area (with a margin in px).
  isVisible(p, area = { x: 0, y: 0, w: this.width, h: this.height }, margin = 40) {
    const s = this.toScreen(p);
    return s.x >= area.x + margin && s.x <= area.x + area.w - margin &&
      s.y >= area.y + margin && s.y <= area.y + area.h - margin;
  }

  toJSON() {
    return { scale: this.scale, ox: this.ox, oy: this.oy };
  }
}

// World bounding box of a project's nodes, or null when there are none.
export function projectBounds(project) {
  const nodes = (project && project.nodes) || [];
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return { minX, minY, maxX, maxY };
}
